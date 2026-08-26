#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CUDA PyTorch INT8 calibration + fake-quant precision probe for DiffLlama diff_step.

Goal (per user guidance: do the calibration on the ORIGINAL PyTorch model with
CUDA/flash-attn, then export a QDQ ONNX):
  1. Load diff_step on CUDA and run the real 2048-frame calibration samples.
  2. Register forward hooks to measure per-Linear ACTIVATION absmax (and 99.999
     percentile) so activation scales are derived from REAL distribution.
  3. Compute per-channel symmetric INT8 weight scales for every Linear.
  4. Run an end-to-end FAKE W8A8 pass (quant activations+weights, dequant, matmul)
     and report cos_sim / SNR vs the FP32 reference. This isolates whether the
     INT8 quantization itself (not ORT/DML quirks) can reach cos>=0.9.
  5. Save the measured scales to a .npz so ORT StaticQuantConfig can inject them
     via TensorQuantOverrides, bypassing ORT's OOM-prone internal calibrator.

Run with the CUDA torch env (unsloth_studio), NOT the CPU soulxsinger env.
"""
import os
import sys

sys.path.insert(0, r"d:\Document\electron\SXSEditor")
sys.path.insert(0, r"d:\Document\electron\SXSEditor\SoulX-Singer")
os.environ.setdefault("SKIP_ROPE_PRECOMPUTE", "1")

import argparse
import numpy as np
import torch
import torch.nn as nn

# --- transformers 5.x neutralization: force an attention impl when config leaves it None ---
try:
    from transformers.models.llama import modeling_llama as _ML
    _gm = _ML.ALL_ATTENTION_FUNCTIONS._global_mapping
    _eager = _gm.get("eager") or _gm.get("sdpa") or next(iter(_gm.values()))
    _gm.setdefault(None, _eager)
    print(f"[attn] None-key -> {getattr(_eager, '__name__', _eager)}")
except Exception as e:  # noqa: BLE001
    print(f"[attn] patch skipped: {e}")

CALIB_NPZ = r"d:\Document\electron\SXSEditor\calibrate\data\fp16_calib\diff_step_dml.npz"
MODEL_PATH = r"d:\Document\electron\SXSEditor\SoulX-Singer\pretrained_models\SoulX-Singer\model.pt"
OUT_SCALES = r"d:\Document\electron\SXSEditor\calibrate\data\fp16_calib\diff_step_int8_scales.npz"
PERCENTILE = 99.999


def find_linear_layers(module, name=""):
    res = {}
    for n, c in module.named_children():
        full = f"{name}.{n}" if name else n
        if isinstance(c, nn.Linear):
            res[full] = c
        else:
            res.update(find_linear_layers(c, full))
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", type=int, default=8)
    ap.add_argument("--out", default=OUT_SCALES)
    ap.add_argument("--no-fake-quant", action="store_true", help="skip the W8A8 probe")
    args = ap.parse_args()

    torch.backends.cuda.matmul.allow_tf32 = True
    torch.backends.cudnn.allow_tf32 = True

    from export_shared import load_config, load_model

    print("loading model ...")
    m = load_model(load_config(), MODEL_PATH)
    ds = m.cfm_decoder.model.diff_estimator
    # Re-prefix Linear names to match ONNX initializer names (diff_estimator.*)
    lines = {f"diff_estimator.{k}": v for k, v in find_linear_layers(ds).items()}
    print(f"  found {len(lines)} nn.Linear layers")
    for ln, l in lines.items():
        pass
    ds_cuda = ds.to("cuda").eval()

    # load calibration samples
    data = np.load(CALIB_NPZ, allow_pickle=True)
    n = min(args.samples, 8)
    samples = []
    for i in range(n):
        samples.append(
            (
                torch.from_numpy(data[f"sample{i}_input_xt_input"]).to("cuda"),
                torch.from_numpy(data[f"sample{i}_input_t"]).to("cuda"),
                torch.from_numpy(data[f"sample{i}_input_cond"]).to("cuda"),
                torch.from_numpy(data[f"sample{i}_input_xt_mask"]).to("cuda"),
            )
        )

    # weight scales (per-channel symmetric int8) for all Linears
    print("computing weight scales ...")
    w_scales = {}
    for ln, l in lines.items():
        W = l.weight.detach().float().to("cuda")
        wmax = W.abs().amax(dim=1).clamp_min(1e-8)  # per output channel
        w_scales[ln] = wmax / 127.0

    # Activate hooks to gather activation absmax
    act_absmax = {}
    hooks = []

    def make_hook(ln):
        def hf(mod, inp, out):
            x = inp[0].detach().float()
            if x.ndim > 1:
                am = x.reshape(-1, x.shape[-1]).abs().amax(dim=0).cpu().float()
            else:
                am = x.abs().cpu().float()
            act_absmax.setdefault(ln, []).append(am)

        return hf

    for ln, l in lines.items():
        hooks.append(l.register_forward_hook(make_hook(ln)))

    print(f"running {n} FP32 calibration forwards on CUDA ...")
    with torch.inference_mode():
        for si, (x, t, cond, mask) in enumerate(samples):
            ds_cuda(x, t, cond, mask)
            print(f"  sample {si + 1}/{n} done", flush=True)
    for h in hooks:
        h.remove()

    # activation scales: absmax over samples, per-channel-of-last-dim, /127
    print("computing activation scales ...")
    act_scales = {}
    for ln in lines:
        if ln not in act_absmax or not act_absmax[ln]:
            continue
        stack = torch.stack(act_absmax[ln], dim=0)  # [n, d]
        amax = stack.max(dim=0).values
        act_scales[ln] = (amax / 127.0).clamp_min(1e-8).cpu().numpy()

    np.savez(
        args.out,
        **{
            "w_scale_" + ln.replace(".", "_"): w_scales[ln].cpu().numpy()
            for ln in lines
        },
        **{
            "a_scale_" + ln.replace(".", "_"): act_scales[ln]
            for ln in act_scales
        },
    )
    print(f"scales saved -> {args.out} (weights={len(w_scales)}, activations={len(act_scales)})")

    if args.no_fake_quant:
        return

    # --- end-to-end fake W8A8 precision probe on CUDA ---
    print("\nend-to-end fake W8A8 probe ...")

    bnmap = {}
    for ln, l in lines.items():
        bnmap[id(l)] = (ln, l)

    def q_forward(self, x):
        ln, _ = bnmap[id(self)]
        W = self.weight
        wscale = w_scales[ln].to(W.device)
        wqs = (W / wscale[:, None]).round().clamp(-127, 127)
        Wqt = (wqs * wscale[:, None]).to(W.dtype)

        # activation quant (per last-dim, symmetric int8)
        if ln in act_scales:
            ascale = torch.from_numpy(act_scales[ln]).to(x.device).float()
            xs = x.float()
            xq = (xs / ascale).round().clamp(-127, 127)
            xt = (xq * ascale).to(x.dtype)
        else:
            xt = x

        bias = self.bias
        return nn.functional.linear(xt, Wqt, bias)

    # save original forwards
    orig_forward = {}
    for l in lines.values():
        orig_forward[id(l)] = l.forward
        l.forward = q_forward.__get__(l, type(l))

    ref_out_list = []
    try:
        with torch.inference_mode():
            # reference outputs computed on the SAME model before swap are gone;
            # instead compare fake-quant model vs a fully-FP32 run.
            # FP32 reference: temporarily disable quant forwards
            for l in lines.values():
                l.forward = orig_forward[id(l)]
            with torch.inference_mode():
                refs = [
                    ds_cuda(x, t, cond, mask).detach().float().cpu()
                    for (x, t, cond, mask) in samples
                ]
            # re-enable quant forwards
            for l in lines.values():
                l.forward = q_forward.__get__(l, type(l))
            with torch.inference_mode():
                qouts = [
                    ds_cuda(x, t, cond, mask).detach().float().cpu()
                    for (x, t, cond, mask) in samples
                ]
    finally:
        for l in lines.values():
            l.forward = orig_forward[id(l)]

    def cos(a, b):
        a = a.reshape(-1).numpy().astype(np.float32)
        b = b.reshape(-1).numpy().astype(np.float32)
        nb = min(a.size, b.size)
        a, b = a[:nb], b[:nb]
        return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-12))

    def snr(a, b):
        a = a.numpy().astype(np.float32).ravel()
        b = b.numpy().astype(np.float32).ravel()
        nb = min(a.size, b.size)
        a, b = a[:nb], b[:nb]
        nz = float(np.mean((a - b) ** 2))
        return 10 * np.log10(float(np.mean(a ** 2)) / nz) if nz > 1e-12 else 99.0

    print("\n(fake W8A8 on CUDA, per-channel weights, per-last-dim activations, absmax 99.999)")
    print("  samp | cos_sim | SNR(dB)")
    for i, (r, q) in enumerate(zip(refs, qouts)):
        print(f"  {i:4d} | {cos(r, q):.5f} | {snr(r, q):6.2f}")

    avg_cos = np.mean([cos(r, q) for r, q in zip(refs, qouts)])
    avg_snr = np.mean([snr(r, q) for r, q in zip(refs, qouts)])
    print(f"  AVG  | {avg_cos:.5f} | {avg_snr:6.2f}")


if __name__ == "__main__":
    main()