# -*- coding: utf-8 -*-
"""Q-DiT W8A8 adapter for SoulX-Singer DiffLlama (self-contained port).

Ports Q-DiT's GPTQ engine (Hessian-based error compensation) to SoulX's
DiffLlama architecture without requiring the full Q-DiT dependency chain
(qdit.qBlock -> models.models -> timm).

Core algorithms (Quantizer_GPTQ, quantize_gptq) are inlined from Q-DiT source
(https://github.com/Juanerx/Q-DiT) and adapted for nn.Linear layers in DiffLlama.

Produces:
  - GPTQ-optimized FP32 weights (for ONNX export → ORT INT8 QDQ)
  - Real INT8 packed tensors (qweight, scale) for PT deployment
  - Activation scales from timestep-conditioned calibration

No fake_quantize / pseudo-quantization. INT8 tensors are real packed int8.
"""

import gc
import math
from pathlib import Path

import torch
import torch.nn as nn


# ============================================================
# Ported from Q-DiT gptq.py: quantize_gptq + Quantizer_GPTQ
# Source: https://github.com/Juanerx/Q-DiT/blob/main/qdit/gptq.py
# ============================================================


def quantize_gptq(x, scale, zero, maxq, channel_group=1, quant_type="int"):
    """GPTQ quantize function (from qdit.gptq).

    x: [num_groups, group_size] or [C, 1]
    Returns dequantized tensor (fake-quant for error compensation).
    """
    if maxq < 0:
        return (x > scale / 2).float() * scale + (x < zero / 2).float() * zero
    shape = x.shape
    if channel_group > 1:
        x = x.reshape((int(x.shape[0] / channel_group), -1))
    if quant_type == "int":
        q = torch.clamp(torch.round(x / scale) + zero, 0, maxq)
        q = scale * (q - zero)
    else:
        raise ValueError(f"Unsupported quant_type: {quant_type}")
    return q.reshape(shape)


class Quantizer_GPTQ:
    """GPTQ weight quantizer (ported from qdit.gptq.Quantizer_GPTQ).

    Finds optimal scale/zero for symmetric or asymmetric INT quantization,
    optionally with MSE-based grid search for clip ratio.
    """

    def __init__(self, shape=1):
        self.maxq = torch.tensor(0)
        self.scale = torch.zeros(shape)
        self.zero = torch.zeros(shape)
        self.perchannel = False
        self.channel_group = 1
        self.sym = True
        self.mse = False
        self.norm = 2.4
        self.grid = 100
        self.maxshrink = 0.8
        self.clip_ratio = 1.0
        self.quant_type = "int"

    def configure(
        self,
        bits,
        perchannel=False,
        channel_group=1,
        sym=True,
        mse=False,
        norm=2.4,
        grid=100,
        maxshrink=0.8,
        clip_ratio=1.0,
        trits=False,
        quant_type="int",
    ):
        if quant_type == "int":
            self.maxq = torch.tensor(2**bits - 1)
        else:
            self.maxq = torch.tensor(2 * 12.0, dtype=torch.float32)

        self.perchannel = perchannel
        self.channel_group = channel_group
        self.sym = sym
        self.mse = mse
        self.norm = norm
        self.grid = grid
        self.maxshrink = maxshrink
        self.clip_ratio = clip_ratio
        self.quant_type = quant_type
        if trits:
            self.maxq = torch.tensor(-1)

    def find_params(self, x, weight=False):
        dev = x.device
        self.maxq = self.maxq.to(dev)

        shape = x.shape
        if self.perchannel:
            if weight:
                x = x.flatten(1)
                if self.channel_group > 1:
                    x = x.reshape(int(shape[0] / self.channel_group), -1)
            else:
                if len(shape) == 4:
                    x = x.permute([1, 0, 2, 3]).flatten(1)
                if len(shape) == 3:
                    x = x.reshape(-1, shape[-1]).t()
                if len(shape) == 2:
                    x = x.t()
        else:
            x = x.flatten().unsqueeze(0)

        tmp = torch.zeros(x.shape[0], device=dev)
        xmin = torch.minimum(x.min(1)[0], tmp)
        xmax = torch.maximum(x.max(1)[0], tmp)

        if self.sym:
            xmax = torch.maximum(torch.abs(xmin), xmax)
            tmp = xmin < 0
            if torch.any(tmp):
                xmin[tmp] = -xmax[tmp]

        tmp = (xmin == 0) & (xmax == 0)
        xmin[tmp] = -1
        xmax[tmp] = 1

        if self.maxq < 0:
            self.scale = xmax
            self.zero = xmin
        else:
            self.scale = (xmax - xmin) * self.clip_ratio / self.maxq
            if self.sym:
                self.zero = torch.full_like(self.scale, (self.maxq + 1) / 2)
            else:
                self.zero = torch.round(-xmin / self.scale)

        if self.mse:
            best = torch.full([x.shape[0]], float("inf"), device=dev)
            for i in range(int(self.maxshrink * self.grid)):
                p = 1 - i / self.grid
                xmin1 = p * xmin
                xmax1 = p * xmax
                scale1 = (xmax1 - xmin1) / self.maxq
                zero1 = torch.round(-xmin1 / scale1) if not self.sym else self.zero
                q = quantize_gptq(x, scale1.unsqueeze(1), zero1.unsqueeze(1), self.maxq)
                q -= x
                q.abs_()
                q.pow_(self.norm)
                err = torch.sum(q, 1)
                tmp = err < best
                if torch.any(tmp):
                    best[tmp] = err[tmp]
                    self.scale[tmp] = scale1[tmp]
                    self.zero[tmp] = zero1[tmp]

        if not self.perchannel:
            if weight:
                tmp = shape[0]
            else:
                tmp = shape[1] if len(shape) != 3 else shape[2]
            self.scale = self.scale.repeat(tmp)
            self.zero = self.zero.repeat(tmp)

        if weight:
            shape = [-1] + [1] * (len(shape) - 1)
            self.scale = self.scale.reshape(shape)
            self.zero = self.zero.reshape(shape)
            return
        if len(shape) == 4:
            self.scale = self.scale.reshape((1, -1, 1, 1))
            self.zero = self.zero.reshape((1, -1, 1, 1))
        if len(shape) == 3:
            self.scale = self.scale.reshape((1, 1, -1))
            self.zero = self.zero.reshape((1, 1, -1))
        if len(shape) == 2:
            self.scale = self.scale.unsqueeze(0)
            self.zero = self.zero.unsqueeze(0)

    def quantize(self, x):
        if self.ready():
            return quantize_gptq(
                x, self.scale, self.zero, self.maxq, self.channel_group, self.quant_type
            )
        return x

    def enabled(self):
        return self.maxq > 0

    def ready(self):
        return torch.all(self.scale != 0)


# ============================================================
# Ported from Q-DiT gptq.py: GPTQ class
# ============================================================


class GPTQ:
    """GPTQ engine (ported from qdit.gptq.GPTQ).

    Accumulates Hessian from calibration inputs, then runs fasterquant
    to produce GPTQ-optimized (error-compensated) quantized weights.
    """

    def __init__(self, layer):
        self.layer = layer
        self.dev = self.layer.weight.device
        W = layer.weight.data.clone()

        if isinstance(self.layer, nn.Conv2d):
            W = W.flatten(1)

        self.rows = W.shape[0]
        self.columns = W.shape[1]
        self.H = torch.zeros((self.columns, self.columns), device=self.dev)
        self.nsamples = 0
        self.n_nonout = W.shape[1]
        self.quantizer = None
        del W

    def add_batch(self, inp, out=None):
        if len(inp.shape) == 2:
            inp = inp.unsqueeze(0)
        tmp = inp.shape[0]
        if isinstance(self.layer, nn.Linear):
            if len(inp.shape) == 3:
                inp = inp.reshape(-1, inp.shape[-1])
            inp = inp.t()
        elif isinstance(self.layer, nn.Conv2d):
            unfold = nn.Unfold(
                self.layer.kernel_size,
                dilation=self.layer.dilation,
                padding=self.layer.padding,
                stride=self.layer.stride,
            )
            inp = unfold(inp)
            inp = inp.permute([1, 0, 2])
            inp = inp.flatten(1)

        self.H *= self.nsamples / (self.nsamples + tmp)
        self.nsamples += tmp
        inp = math.sqrt(2 / self.nsamples) * inp.float()
        self.H += inp.matmul(inp.t())

    def fasterquant(self, blocksize=128, percdamp=0.01, groupsize=-1, actorder=False):
        W = self.layer.weight.data.clone()
        if isinstance(self.layer, nn.Conv2d):
            W = W.flatten(1)
        W = W.float()

        if not self.quantizer.ready():
            self.quantizer.find_params(W[:, : self.n_nonout], weight=True)

        H = self.H.clone()
        del self.H

        dead = torch.diag(H) == 0
        H[dead, dead] = 1
        W[:, dead] = 0

        Losses = torch.zeros_like(W)
        Q = torch.zeros_like(W)

        damp = percdamp * torch.mean(torch.diag(H))
        diag = torch.arange(self.columns, device=self.dev)
        H[diag, diag] += damp

        H = torch.linalg.cholesky(H)
        H = torch.cholesky_inverse(H)
        H = torch.linalg.cholesky(H, upper=True)
        Hinv = H

        for i1 in range(0, self.n_nonout, blocksize):
            i2 = min(i1 + blocksize, self.n_nonout)
            count = i2 - i1

            W1 = W[:, i1:i2].clone()
            Q1 = torch.zeros_like(W1)
            Err1 = torch.zeros_like(W1)
            Losses1 = torch.zeros_like(W1)
            Hinv1 = Hinv[i1:i2, i1:i2]

            for i in range(count):
                w = W1[:, i]
                d = Hinv1[i, i]

                if groupsize > 0:
                    if (i1 + i) % groupsize == 0:
                        self.quantizer.find_params(
                            W[:, (i1 + i) : min((i1 + i + groupsize), self.n_nonout)],
                            weight=True,
                        )

                q = quantize_gptq(
                    w.unsqueeze(1),
                    self.quantizer.scale,
                    self.quantizer.zero,
                    self.quantizer.maxq,
                    self.quantizer.channel_group,
                    self.quantizer.quant_type,
                ).flatten()
                Q1[:, i] = q
                Losses1[:, i] = (w - q) ** 2 / d**2

                err1 = (w - q) / d
                W1[:, i:] -= err1.unsqueeze(1).matmul(Hinv1[i, i:].unsqueeze(0))
                Err1[:, i] = err1

            Q[:, i1:i2] = Q1
            Losses[:, i1:i2] = Losses1 / 2
            W[:, i2:] -= Err1.matmul(Hinv[i1:i2, i2:])

        torch.cuda.synchronize()
        Q = Q.reshape(self.layer.weight.shape).to(self.layer.weight.data.dtype)
        self.layer.weight.data = Q.reshape(self.layer.weight.shape).to(
            self.layer.weight.data.dtype
        )
        del H, Losses, W

    def free(self):
        self.H = None
        torch.cuda.empty_cache()
        gc.collect()


# ============================================================
# Helper functions
# ============================================================


def _find_linear_layers(module, name=""):
    """Recursively find all nn.Linear layers."""
    res = {}
    for name1, child in module.named_children():
        full = f"{name}.{name1}" if name else name1
        if isinstance(child, nn.Linear) and type(child) == nn.Linear:
            res[full] = child
        else:
            res.update(_find_linear_layers(child, full))
    return res


# ============================================================
# Main quantization functions
# ============================================================


def quantize_diff_step_w8a8(diff_step, calibration, qdit_root=None, wbits=8, abits=8):
    """Apply Q-DiT GPTQ W8A8 quantization to DiffLlama.

    Steps:
    1. Find all nn.Linear layers in DiffLlama
    2. Collect calibration inputs per layer (forward hooks)
    3. Run GPTQ: accumulate Hessian, fasterquant for error compensation
    4. Extract real INT8 weight tensors (qweight, scale) as buffers
    5. Store activation scales for W8A8

    The model's forward() uses GPTQ-optimized FP32 weights (for ONNX export).
    INT8 tensors stored as buffers for PT deployment.
    """
    device = "cuda" if torch.cuda.is_available() else "cpu"
    diff_step = diff_step.to(device).eval()

    layers = _find_linear_layers(diff_step)
    print(f"  [QDiT] Found {len(layers)} Linear layers in DiffLlama")

    layer_names = list(layers.keys())
    n_layers = len(layer_names)

    # Phase 1: Collect calibration inputs (for Hessian + activation scales)
    # Store raw inputs per layer (limited by memory)
    layer_inputs = {name: [] for name in layer_names}
    act_stats = {name: [] for name in layer_names}
    hooks = []

    MAX_CALIB_PER_LAYER = 16  # Limit stored inputs to manage memory

    for name, layer in layers.items():

        def make_hook(nm):
            def hook_fn(mod, inp, out):
                if inp and inp[0] is not None:
                    x = inp[0].detach()
                    if len(layer_inputs[nm]) < MAX_CALIB_PER_LAYER:
                        # Store input for GPTQ Hessian
                        layer_inputs[nm].append(x.cpu())
                    # Activation absmax for scale
                    act_stats[nm].append(
                        x.float().abs().amax(dim=tuple(range(x.ndim - 1))).cpu()
                    )

            return hook_fn

        hooks.append(layer.register_forward_hook(make_hook(name)))

    # Run calibration
    calib_list = list(calibration)
    n_calib = len(calib_list)
    print(f"  [QDiT] Running calibration with {n_calib} samples...")

    with torch.inference_mode():
        for i, batch in enumerate(calib_list):
            batch = {
                k: (v.to(device, non_blocking=True) if torch.is_tensor(v) else v)
                for k, v in batch.items()
            }
            try:
                diff_step(**batch)
            except Exception as e:
                print(f"  [QDiT] WARNING: calibration sample {i} failed: {e}")
            if (i + 1) % 16 == 0:
                print(f"    calibration {i + 1}/{n_calib}")
                if torch.cuda.is_available():
                    torch.cuda.empty_cache()

    for h in hooks:
        h.remove()

    # Phase 2: GPTQ per-layer (sequential to manage memory)
    total_int8_params = 0
    total_params = 0

    for idx, name in enumerate(layer_names):
        layer = layers[name]
        W = layer.weight.data
        total_params += W.numel()

        # Skip very small layers
        if W.numel() < 4096:
            continue

        # Create GPTQ quantizer (symmetric INT8, MSE-based)
        quantizer = Quantizer_GPTQ(shape=W.shape[0])
        quantizer.configure(
            bits=wbits,
            perchannel=True,
            channel_group=1,
            sym=True,
            mse=True,
            norm=2.4,
            grid=100,
            maxshrink=0.8,
            clip_ratio=1.0,
            quant_type="int",
        )

        # Find quantization parameters
        quantizer.find_params(W, weight=True)

        # Run GPTQ with Hessian if we have calibration inputs
        if layer_inputs[name]:
            gptq = GPTQ(layer)
            for inp in layer_inputs[name]:
                inp_dev = inp.to(device)
                gptq.add_batch(inp_dev)
                del inp_dev

            # Set quantizer on GPTQ object and run fasterquant
            gptq.quantizer = quantizer
            try:
                gptq.fasterquant(blocksize=128, percdamp=0.01, groupsize=-1)
                print(f"  [QDiT] [{idx + 1}/{n_layers}] {name}: GPTQ done")
            except Exception as e:
                print(
                    f"  [QDiT] [{idx + 1}/{n_layers}] {name}: GPTQ failed ({e}), using MSE only"
                )
                # Fallback: just apply quantize-dequantize
                W_dequant = quantizer.quantize(W)
                layer.weight.data = W_dequant.to(layer.weight.dtype)
            gptq.free()
            del gptq
        else:
            # No calibration data for this layer, just quantize-dequantize
            W_dequant = quantizer.quantize(W)
            layer.weight.data = W_dequant.to(layer.weight.dtype)

        # Extract real INT8 values for PT storage
        with torch.no_grad():
            W_current = layer.weight.data
            scale = quantizer.scale
            zero = quantizer.zero
            maxq = quantizer.maxq

            if W_current.dim() > 2:
                W_flat = W_current.flatten(1)
            else:
                W_flat = W_current

            # Symmetric INT8: q = clamp(round(W/scale) + zero - zero_center, ...)
            # For symmetric: zero = (maxq+1)/2, so q = round(W/scale + (maxq+1)/2) - (maxq+1)/2
            # Simplified: q = round(W/scale), clamp to [-127, 127] (for 8-bit symmetric)
            qweight = (
                torch.round(W_flat / scale.clamp(min=1e-8))
                .clamp(-127, 127)
                .to(torch.int8)
            )
            int8_params = qweight.numel()
            total_int8_params += int8_params

            layer.register_buffer("qweight", qweight.contiguous(), persistent=True)
            layer.register_buffer(
                "weight_scale", scale.squeeze().contiguous(), persistent=True
            )
            if zero is not None:
                layer.register_buffer(
                    "weight_zero", zero.squeeze().contiguous(), persistent=True
                )

        # Activation scale (99.9th percentile / 127)
        if act_stats[name]:
            a = torch.cat(act_stats[name], dim=0)
            act_scale = (torch.quantile(a.float(), 0.999) / 127).clamp_min(1e-8)
            layer.register_buffer("act_scale", act_scale, persistent=True)
        else:
            layer.register_buffer("act_scale", torch.ones(1), persistent=True)

        # Cleanup
        del quantizer, layer_inputs[name], act_stats[name]
        if (idx + 1) % 10 == 0 or idx == n_layers - 1:
            print(
                f"  [QDiT] [{idx + 1}/{n_layers}] {name}: W{wbits}A{abits} "
                f"({int8_params / 1e6:.1f}M INT8 params)"
            )
            if torch.cuda.is_available():
                torch.cuda.empty_cache()

    print(f"\n  [QDiT] GPTQ W{wbits}A{abits} complete:")
    print(f"    Total params: {total_params / 1e6:.1f}M")
    print(
        f"    INT8 params:  {total_int8_params / 1e6:.1f}M ({100 * total_int8_params / max(total_params, 1):.1f}%)"
    )

    # Verify INT8 tensors
    sd = diff_step.state_dict()
    int8_count = sum(
        1 for k in sd if k.endswith("qweight") and sd[k].dtype == torch.int8
    )
    if int8_count == 0:
        raise RuntimeError("QDiT: no INT8 tensors produced - quantization failed")
    print(f"    INT8 weight tensors: {int8_count}")

    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    return diff_step


def quantize_vocoder_w8a32(vocoder, calibration=None, wbits=8):
    """Apply AWQ-style W8A32 quantization to Vocos vocoder.

    Weight-only INT8: weights are INT8, activations stay FP32.
    Uses AWQ salience scaling to reduce quantization error for important channels.
    """
    device = "cuda" if torch.cuda.is_available() else "cpu"
    vocoder = vocoder.to(device).eval()

    layers = _find_linear_layers(vocoder)
    print(f"\n  [AWQ] Found {len(layers)} Linear layers in Vocos vocoder")

    # Compute AWQ scales from calibration
    awq_scales = {}
    if calibration:
        print(f"  [AWQ] Computing activation-aware weight scales...")
        calib_list = (
            list(calibration) if not isinstance(calibration, list) else calibration
        )

        hooks = []
        act_stats = {name: [] for name in layers}

        for name, layer in layers.items():

            def make_hook(nm):
                def hook_fn(mod, inp, out):
                    if inp and inp[0] is not None:
                        x = inp[0].detach().float()
                        act_stats[nm].append(
                            x.abs().mean(dim=tuple(range(x.ndim - 1))).cpu()
                        )

                return hook_fn

            hooks.append(layer.register_forward_hook(make_hook(name)))

        with torch.inference_mode():
            for batch in calib_list:
                if isinstance(batch, dict):
                    mel = batch.get("mel")
                    if mel is not None:
                        try:
                            vocoder(mel.to(device))
                        except Exception:
                            pass

        for h in hooks:
            h.remove()

        alpha = 0.5
        for name, layer in layers.items():
            if not act_stats[name]:
                continue
            act_mean = torch.cat(act_stats[name], dim=0).mean()
            w_absmean = layer.weight.data.abs().mean().clamp(min=1e-8)
            s = (act_mean.clamp(min=1e-8) / w_absmean).pow(alpha)
            s = s / s.pow(2).mean().pow(0.5).clamp(min=1e-8)
            awq_scales[name] = s.to(device)

    # Apply AWQ scaling + INT8 quantization
    total_int8 = 0
    total_params = 0

    for idx, (name, layer) in enumerate(layers.items()):
        W = layer.weight.data
        total_params += W.numel()
        if W.numel() < 4096:
            continue

        # AWQ scale
        if name in awq_scales:
            s = awq_scales[name]
            W_scaled = W * s.unsqueeze(1) if W.dim() == 2 else W
        else:
            W_scaled = W

        # Per-channel symmetric INT8
        w_max = W_scaled.abs().amax(dim=-1, keepdim=True).clamp(min=1e-8)
        scale = w_max / 127.0
        qweight = torch.round(W_scaled / scale).clamp(-127, 127).to(torch.int8)
        W_dequant = qweight * scale

        # Reverse AWQ scaling
        if name in awq_scales:
            s = awq_scales[name]
            W_dequant = W_dequant / s.unsqueeze(1) if W.dim() == 2 else W_dequant

        layer.weight.data = W_dequant.to(layer.weight.dtype).contiguous()
        layer.register_buffer("qweight", qweight.contiguous(), persistent=True)
        layer.register_buffer(
            "weight_scale", scale.squeeze().contiguous(), persistent=True
        )
        total_int8 += qweight.numel()

        if (idx + 1) % 5 == 0 or idx == len(layers) - 1:
            print(f"  [AWQ] [{idx + 1}/{len(layers)}] {name}: W{wbits}A32 quantized")

    # Also quantize Conv1d layers
    for name, child in vocoder.named_modules():
        if isinstance(child, nn.Conv1d) and child.weight.numel() > 4096:
            W = child.weight.data
            total_params += W.numel()
            w_max = W.abs().amax(dim=(1, 2), keepdim=True).clamp(min=1e-8)
            scale = w_max / 127.0
            qweight = torch.round(W / scale).clamp(-127, 127).to(torch.int8)
            W_dequant = qweight * scale
            child.weight.data = W_dequant.to(child.weight.dtype).contiguous()
            child.register_buffer("qweight", qweight.contiguous(), persistent=True)
            child.register_buffer(
                "weight_scale", scale.squeeze().contiguous(), persistent=True
            )
            total_int8 += qweight.numel()

    print(f"\n  [AWQ] Vocos W{wbits}A32 complete:")
    print(f"    Total params: {total_params / 1e6:.1f}M")
    print(
        f"    INT8 params:  {total_int8 / 1e6:.1f}M ({100 * total_int8 / max(total_params, 1):.1f}%)"
    )

    sd = vocoder.state_dict()
    int8_count = sum(
        1 for k in sd if k.endswith("qweight") and sd[k].dtype == torch.int8
    )
    if int8_count == 0:
        raise RuntimeError("AWQ: no INT8 tensors produced - quantization failed")
    print(f"    INT8 weight tensors: {int8_count}")

    vocoder.cpu()
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()

    return vocoder
