"""
Q-Drift 后端探测：同一条件下比较 CPU EP 与 DmlExecutionProvider 的 Δv 量级与速度。

为什么要探测：应用实际跑在 DirectML 上，而 ModelScope 包里的校准是在 CPU EP 上做的。
若两者 FP16 舍入误差量级不同，就必须用 DML 重新校准——否则校正的是"错误的误差"。

用法:
  py qdrift/scripts/probe_ep.py --steps 3 --cond nat_000
"""
import os, sys, time, gc, argparse
import numpy as np
import torch
import onnxruntime as ort

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

N_STEPS = 32
H = 1.0 / N_STEPS
CFG = 3.0
RESCALE_CFG = 0.7          # ★ 应用 constants.js: CFG_RESCALE = 0.7
MEL_DIM = 128


def sigma_of(i):
    return (i + 0.5) * H


def make_onnx_diff(path, dtype, ep):
    so = ort.SessionOptions()
    so.intra_op_num_threads = 0
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_EXTENDED
    so.enable_mem_pattern = False
    so.enable_cpu_mem_arena = False
    so.log_severity_level = 2
    sess = ort.InferenceSession(path, sess_options=so, providers=[ep])
    npdt = np.float16 if dtype == "fp16" else np.float32

    def _call(x, t, cond, mask):
        feed = {
            "xt_input": x.detach().cpu().numpy().astype(npdt),
            "t": t.detach().cpu().numpy().astype(npdt),
            "cond": cond.detach().cpu().numpy().astype(npdt),
            "xt_mask": mask.detach().cpu().numpy().astype(npdt),
        }
        out = sess.run(["flow_pred"], feed)[0]
        return torch.from_numpy(out.astype(np.float32))
    return _call


def cfg_velocity(diff_call, xt, prompt, cond, prompt_len, target_len, t):
    """与 src/inference/pipeline/diffusion.js 的 combine() 数学等价。
    v = rescale_cfg * (cfgVal * (posStd / cfgAdjStd)) + (1 - rescale_cfg) * cfgVal
    """
    B = xt.shape[0]
    xt_input = torch.cat([prompt, xt], dim=1)
    prompt_mask = torch.ones(B, prompt.shape[1])
    x_mask = torch.ones(B, target_len)
    xt_mask = torch.cat([prompt_mask, x_mask], dim=1)

    flow_pred = diff_call(xt_input, t, cond, xt_mask)[:, prompt_len:, :]
    uncond_cond = torch.zeros_like(cond)[:, :xt.shape[1], :]
    uncond = diff_call(xt, t, uncond_cond, x_mask)

    pos_std = flow_pred.std()
    flow_cfg = flow_pred + CFG * (flow_pred - uncond)
    rescale = flow_cfg * pos_std / flow_cfg.std()
    return RESCALE_CFG * rescale + (1 - RESCALE_CFG) * flow_cfg


def probe(ep, cond_path, n_steps, seed=1234):
    print(f"\n=== EP = {ep} ===", flush=True)
    t0 = time.time()
    fp32 = make_onnx_diff(os.path.join(ROOT, "onnx_models/diff_step_dml.onnx"), "fp32", ep)
    fp16 = make_onnx_diff(os.path.join(ROOT, "onnx_models/fp16/diff_step_dml.onnx"), "fp16", ep)
    print(f"  sessions loaded in {time.time()-t0:.1f}s", flush=True)

    d = torch.load(cond_path, weights_only=False)
    prompt = d["prompt"]
    cond = d["cond"]
    pl, tl = d["prompt_len"], d["target_len"]
    print(f"  prompt={tuple(prompt.shape)} cond={tuple(cond.shape)} pl={pl} tl={tl} "
          f"({tl*0.02:.2f}s)", flush=True)

    g = torch.Generator().manual_seed(seed)
    xt = torch.randn(1, tl, MEL_DIM, generator=g)

    out = []
    with torch.no_grad():
        for i in range(n_steps):
            t = sigma_of(i) * torch.ones(1, dtype=torch.float32)
            ts = time.time()
            v32 = cfg_velocity(fp32, xt, prompt, cond, pl, tl, t)
            v16 = cfg_velocity(fp16, xt, prompt, cond, pl, tl, t)
            dt = time.time() - ts
            dv = (v16 - v32).numpy()[0]
            rms = float(np.sqrt((dv ** 2).mean()))
            rel = rms / float(np.sqrt((v32.numpy()[0] ** 2).mean()))
            out.append((i, rms, rel, dt))
            print(f"  step {i:2d}  |dv|rms={rms:.3e}  rel={rel:.3e}  "
                  f"|v32|rms={float(np.sqrt((v32.numpy()[0]**2).mean())):.3e}  "
                  f"{dt:.2f}s/cfg-step", flush=True)
            xt = xt + H * v32
            del v32, v16, dv
            gc.collect()
    del fp32, fp16
    gc.collect()
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cond", default=os.path.join(ROOT, "qdrift/conds_long/nat_000.pt"))
    ap.add_argument("--steps", type=int, default=3)
    ap.add_argument("--ep", default="dml,cpu", help="逗号分隔，按序探测")
    args = ap.parse_args()

    res = {}
    for ep in [e.strip() for e in args.ep.split(",") if e.strip()]:
        ep_name = "DmlExecutionProvider" if ep.lower() == "dml" else "CPUExecutionProvider"
        try:
            res[ep] = probe(ep_name, args.cond, args.steps)
        except Exception as e:
            print(f"  !! {ep_name} failed: {type(e).__name__}: {e}", flush=True)
            gc.collect()

    print("\n=== 汇总（|dv|rms 相对量级）===", flush=True)
    for ep, rows in res.items():
        print(f"  {ep:>4}: " + "  ".join(f"s{i}={r:.2e}" for i, r, _, _ in rows)
              + f"  | 总耗时 " + f"{sum(x[3] for x in rows):.1f}s/{len(rows)}步", flush=True)
    if "cpu" in res and "dml" in res:
        c = np.array([r[1] for r in res["cpu"]])
        dml = np.array([r[1] for r in res["dml"]])
        ratio = dml / np.maximum(c, 1e-30)
        print(f"  DML/CPU 比值: " + "  ".join(f"{x:.2f}x" for x in ratio), flush=True)


if __name__ == "__main__":
    main()
