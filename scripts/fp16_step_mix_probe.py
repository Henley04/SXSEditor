# -*- coding: utf-8 -*-
"""探测「前 N 步 FP16 + 后 M 步 FP32」的采样级混合精度收益。

逐算子保 FP32 不划算（每次 island 两侧各多一次 fp16 舍入，实测反而更差），
所以换个维度：整个网络按步切精度。这里量化不同切分点对最终 mel 的影响。

用法：
  python scripts/fp16_step_mix_probe.py --steps 32 --fp32-tail 4 8 16
"""
import argparse
import json
import os
import sys

import numpy as np
import onnxruntime as ort

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, SCRIPT_DIR)
from verify_e2e_dml_precision import create_dml_session, diffusion_loop  # noqa: E402

FP32 = os.path.join(PROJECT_DIR, "onnx_models")
FP16 = os.path.join(FP32, "fp16")
CALIB = os.path.join(PROJECT_DIR, "calibrate", "data", "fp16_calib")


def log(m):
    print(m, flush=True)


def snr(ref, cand):
    ref = np.asarray(ref, dtype=np.float64).reshape(-1)
    cand = np.asarray(cand, dtype=np.float64).reshape(-1)
    n = min(ref.size, cand.size)
    return float(10 * np.log10((np.sum(ref[:n] ** 2) + 1e-20) / (np.sum((ref[:n] - cand[:n]) ** 2) + 1e-20)))


def mixed_loop(sess16, sess32, prompt_mel, target_len, cond, n_steps, fp32_tail, cfg=3.0, rescale=0.75):
    mel_dim = 128
    prompt_len = prompt_mel.shape[1]
    total_len = prompt_len + target_len
    np.random.seed(42)
    xt = np.random.randn(1, target_len, mel_dim).astype(np.float32)
    cond_mask = np.ones((1, total_len), dtype=np.float32)
    uncond_cond = np.zeros((1, target_len, 1024), dtype=np.float32)
    uncond_mask = np.ones((1, target_len), dtype=np.float32)
    xt_input = np.zeros((1, total_len, mel_dim), dtype=np.float32)
    xt_input[0, :prompt_len] = prompt_mel[0]
    dt = 1.0 / n_steps
    split = n_steps - fp32_tail

    for step in range(n_steps):
        sess = sess16 if step < split else sess32
        is16 = step < split
        t_val = (step + 0.5) / n_steps
        t_arr = np.array([t_val], dtype=np.float32)
        xt_input[0, prompt_len:] = xt[0]

        def run(feeds):
            if is16:
                feeds = {k: v.astype(np.float16) for k, v in feeds.items()}
            return sess.run(None, feeds)[0].astype(np.float32)

        flow_cond = run({"xt_input": xt_input, "t": t_arr, "cond": cond, "xt_mask": cond_mask})
        xt_uncond = np.zeros((1, target_len, mel_dim), dtype=np.float32)
        xt_uncond[0] = xt[0]
        flow_uncond = run({"xt_input": xt_uncond, "t": t_arr,
                           "cond": uncond_cond, "xt_mask": uncond_mask})

        fc = flow_cond[0, prompt_len:]
        fu = flow_uncond[0, :target_len]
        flow_cfg = fc + cfg * (fc - fu)
        rescale_f = float(np.std(fc) + 1e-8) / float(np.std(flow_cfg) + 1e-8)
        flow = rescale * (flow_cfg * rescale_f) + (1 - rescale) * flow_cfg
        xt = xt + flow * dt
    return xt[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=32)
    ap.add_argument("--fp32-tail", type=int, nargs="*", default=[4, 8, 16])
    ap.add_argument("--target-len", type=int, default=200)
    ap.add_argument("--prompt-len", type=int, default=30)
    ap.add_argument("--cfg", type=float, default=3.0)
    args = ap.parse_args()

    cond_npz = np.load(os.path.join(CALIB, "cond_emb.npz"))
    voc_npz = np.load(os.path.join(CALIB, "vocoder_dml.npz"))
    total = args.prompt_len + args.target_len
    cond = cond_npz["sample0_output"][:, :total].astype(np.float32)
    prompt = voc_npz["sample0_input_mel"][:, : args.prompt_len].astype(np.float32)

    s32 = create_dml_session(os.path.join(FP32, "diff_step_dml.onnx"))
    s16 = create_dml_session(os.path.join(FP16, "diff_step_dml.onnx"))

    ref = diffusion_loop(s32, False, prompt, args.target_len, cond, n_steps=args.steps, cfg_strength=args.cfg)
    full16 = diffusion_loop(s16, True, prompt, args.target_len, cond, n_steps=args.steps, cfg_strength=args.cfg)
    log(f"全 FP32 vs 全 FP16: {snr(ref, full16):.2f} dB")

    out = {"full_fp16": snr(ref, full16), "steps": args.steps, "tails": {}}
    for tail in args.fp32_tail:
        mel = mixed_loop(s16, s32, prompt, args.target_len, cond, args.steps, tail, cfg=args.cfg)
        s = snr(ref, mel)
        out["tails"][str(tail)] = s
        log(f"前 {args.steps - tail} 步 FP16 + 后 {tail} 步 FP32: {s:.2f} dB")
    path = os.path.join(SCRIPT_DIR, "fp16_step_mix_report.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=2)
    log(f"写入 {path}")


if __name__ == "__main__":
    main()
