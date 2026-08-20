# -*- coding: utf-8 -*-
"""
True W8A8 INT8 quantization kernels (Q-DiT style, ported to SoulX-Singer).

Key design (NOT fake quantization):
  - Weights are stored as REAL int8 tensors (int8 dtype) + fp32 scales.
  - Activations are quantized to int8 per-token dynamically at runtime.
  - The matmul is computed in INT32 (int8 * int8 -> int32 accumulate), then
    dequantized once by multiplying the combined scale. No fp32 weight
    reconstruction is ever stored or used inside the quantized path.
  - This matches what hardware INT8 tensor-core / ORT QLinearMatMul does,
    and the exported ONNX uses MatMulInteger (QOperator), so deployment can
    keep everything in int8 without dequantizing weights.

Supports:
  - Linear (per-channel or per-group symmetric int8)
  - Conv1d (per-output-channel int8)
"""

import os
import torch
import torch.nn as nn
import torch.nn.functional as F

# Activation quantization clip ratio (scale = clip_ratio * amax / 127).
# Tuning this down reduces error from outlier-dominated per-tensor scales;
# set via env SXS_ACT_CLIP for experiments (0,1].
ACT_CLIP = float(os.environ.get('SXS_ACT_CLIP', '1.0'))


# ============================================================
# Integer GEMM helpers (ONNX-traceable -> MatMulInteger / ConvInteger)
# ============================================================

class Int8MatMul(torch.autograd.Function):
    """int8 x @ int8 w^T computed in int32.

    During ONNX export the `symbolic` method emits a real MatMulInteger node,
    so weights stay int8 in the exported graph (QOperator format, no weight
    dequantization) and ORT/tensor-core runs the integer MAC.
    """

    @staticmethod
    def forward(ctx, x_int8, w_int8_t):
        # exact integer multiply-accumulate in int32
        return torch.matmul(x_int8.to(torch.int32), w_int8_t.to(torch.int32))

    @staticmethod
    def symbolic(g, x_int8, w_int8_t):
        # MatMulInteger(x_int8, w_int8_t) with zero points defaulting to 0
        return g.op('MatMulInteger', x_int8, w_int8_t)


def int8_gemm(x_int8, w_int8_t):
    """int8 x @ int8 w^T computed in int32.

    x_int8: [*, K] int8
    w_int8_t: [K, N] int8 (weight transposed to K x N)
    Returns: [*, N] int32
    """
    return Int8MatMul.apply(x_int8, w_int8_t)


def int8_conv1d(x_int8, w_int8, stride, padding, dilation, groups):
    """int8 1D convolution computed in int32 (ONNX ConvInteger on export)."""
    def _symbolic(g, x, w):
        return g.op(
            'ConvInteger', x, w,
            strides_i=[stride],
            pads_i=[padding, padding],
            dilations_i=[dilation],
            group_i=groups,
        )

    def _forward(ctx, x, w):
        return F.conv1d(
            x.to(torch.int32), w.to(torch.int32), None,
            stride, padding, dilation, groups,
        )

    Fn = type('Int8Conv1dFn', (torch.autograd.Function,), {
        'forward': staticmethod(_forward),
        'symbolic': staticmethod(_symbolic),
    })
    return Fn.apply(x_int8, w_int8)


def quantize_activation_per_token(x, clip_ratio=1.0):
    """Dynamic per-token symmetric int8 quantization.

    Args:
        x: [..., K] float tensor
    Returns:
        x_int8: [..., K] int8
        scale: [..., 1] float (per token)
    """
    orig_shape = x.shape
    x2 = x.reshape(-1, x.shape[-1])
    amax = x2.abs().amax(dim=-1, keepdim=True).clamp(min=1e-8)
    if clip_ratio < 1.0:
        amax = amax * clip_ratio
    scale = amax / 127.0
    x_int = torch.clamp(torch.round(x2 / scale), -128, 127).to(torch.int8)
    return x_int.reshape(orig_shape), scale.reshape(*orig_shape[:-1], 1)


def quantize_activation_per_tensor(x, clip_ratio=1.0):
    """Dynamic per-tensor symmetric int8 quantization (single scale).

    This is required for convolutions: the output at position L accumulates
    input positions L..L+k-1, so a per-position scale cannot be dequantized
    with a single post-multiply. A per-tensor scale (constant over positions
    AND channels) makes the int32 accumulation -> single scale dequant exact.
    This matches hardware ConvInteger / ORT QLinearConv semantics.
    """
    amax = x.abs().amax().clamp(min=1e-8)
    if clip_ratio < 1.0:
        amax = amax * clip_ratio
    scale = amax / 127.0
    x_int = torch.clamp(torch.round(x / scale), -128, 127).to(torch.int8)
    return x_int, scale


def quantize_weight_symmetric(w, group_size=0):
    """Symmetric int8 weight quantization.

    Args:
        w: [N, K] float weight
        group_size: 0 -> per-channel; >0 -> per-group along K
    Returns:
        w_int8: [N, K] int8
        scale: [N, 1] or [N, num_groups] float
    """
    N, K = w.shape
    if group_size <= 0:
        scale = w.abs().amax(dim=-1, keepdim=True).clamp(min=1e-8) / 127.0
        w_int = torch.clamp(torch.round(w / scale), -128, 127).to(torch.int8)
        return w_int, scale
    else:
        assert K % group_size == 0
        num_groups = K // group_size
        wg = w.reshape(N, num_groups, group_size)
        scale = wg.abs().amax(dim=-1, keepdim=True).clamp(min=1e-8) / 127.0  # [N, G, 1]
        w_int = torch.clamp(torch.round(wg / scale), -128, 127).to(torch.int8)
        return w_int.reshape(N, K), scale.reshape(N, num_groups)


# ============================================================
# W8A8 Linear
# ============================================================

class W8A8Linear(nn.Module):
    """True int8 linear: stores int8 weight + fp32 scale. No dequant on weights.

    Optional AWQ support: `awq_scale` is a per-input-channel fp32 scaling vector
    (equivalent transform W' = W/s, X' = X*s). It protects salient channels and
    is applied to the input before activation quantization.
    """

    def __init__(self, weight, bias=None, group_size=0, awq_scale=None):
        super().__init__()
        assert weight.dim() == 2
        self.group_size = group_size
        self.out_features, self.in_features = weight.shape
        w = weight.detach().float()
        # AWQ equivalent transform: W' = W / s, X' = X * s. The weight MUST be
        # divided by s before int8 quantization, otherwise the input scaling at
        # runtime has no matching weight scaling (inconsistent transform).
        if awq_scale is not None:
            assert awq_scale.numel() == self.in_features
            s = awq_scale.detach().float().reshape(1, -1)  # [1, K] -> divide along input channels
            w = w / s
            self.register_buffer('awq_scale', awq_scale.detach().float().reshape(1, -1))
        else:
            self.awq_scale = None
        w_int8, scale = quantize_weight_symmetric(w, group_size)
        self.register_buffer('weight_int8', w_int8)   # [N, K] int8
        self.register_buffer('scale', scale)           # [N, 1] or [N, G] fp32
        if bias is not None:
            self.register_buffer('bias', bias.detach().float())
        else:
            self.bias = None

    def forward(self, x):
        # x: [*, K] float
        if self.awq_scale is not None:
            x = x * self.awq_scale
        if self.group_size <= 0:
            x_int8, x_scale = quantize_activation_per_token(x, ACT_CLIP)   # int8 activations
            # int32 accumulation
            y_int32 = int8_gemm(x_int8, self.weight_int8.t())    # [*, N] int32
            y = y_int32.float()
            y = y * (x_scale * self.scale.t())                   # [*, N]
        else:
            # per-group: quantize activations per group, int32 gemm per group, sum
            K = self.in_features
            gs = self.group_size
            G = K // gs
            xg = x.reshape(*x.shape[:-1], G, gs)
            x_amax = xg.abs().amax(dim=-1, keepdim=True).clamp(min=1e-8)
            x_scale = (x_amax * ACT_CLIP) / 127.0                              # [*, G, 1]
            x_int = torch.clamp(torch.round(xg / x_scale), -128, 127).to(torch.int8)
            # weight int8 stored as [N, K], scale [N, G]
            wg = self.weight_int8.reshape(self.out_features, G, gs)
            # [*, G, gs] x [G, gs, N] -> [*, G, N] int32  (matmul over gs dim)
            w_for_matmul = wg.transpose(0, 1).transpose(-2, -1).to(torch.int32)  # [G, gs, N]
            y = torch.einsum('...gk,gkn->...gn', x_int.to(torch.int32), w_for_matmul)
            # y: [*, G, N] int32
            # combined scale [*, G, N] = x_scale[*, G, 1] * w_scale[G, N]
            combined = x_scale * self.scale.t().unsqueeze(0).unsqueeze(0)        # [*, G, N]
            y = (y.float() * combined).sum(dim=-2)                               # [*, N]
        if self.bias is not None:
            y = y + self.bias
        return y

    def extra_repr(self):
        awq = f', awq={self.awq_scale is not None}' if self.awq_scale is not None else ''
        return f'in={self.in_features}, out={self.out_features}, group={self.group_size}, int8=True{awq}'


# ============================================================
# W8A8 Conv1d
# ============================================================

class W8A8Conv1d(nn.Module):
    """True int8 1D convolution (per-output-channel symmetric weights).

    Optional AWQ support: `awq_scale` is a per-input-channel fp32 scaling vector.
    """

    def __init__(self, weight, bias=None, stride=1, padding=0, dilation=1, groups=1,
                 awq_scale=None):
        super().__init__()
        w = weight.detach().float()
        # [out, in/groups, k]
        # AWQ equivalent transform: W'[o,c,k] = W[o,c,k] / s[c], X'[b,c,l] = X[b,c,l]*s[c].
        # The weight MUST be divided by s before int8 quantization (same rule as Linear).
        if awq_scale is not None:
            assert awq_scale.numel() == w.shape[1] * groups
            s = awq_scale.detach().float().reshape(1, -1, 1)
            w = w / s
        scale = w.abs().amax(dim=(1, 2), keepdim=True).clamp(min=1e-8) / 127.0
        w_int8 = torch.clamp(torch.round(w / scale), -128, 127).to(torch.int8)
        self.register_buffer('weight_int8', w_int8)
        self.register_buffer('scale', scale.reshape(-1))  # [out]
        if bias is not None:
            self.register_buffer('bias', bias.detach().float())
        else:
            self.bias = None
        self.out_channels = w.shape[0]
        self.in_channels = w.shape[1] * groups
        self.kernel_size = w.shape[2]
        self.stride = stride
        self.padding = padding
        self.dilation = dilation
        self.groups = groups
        if awq_scale is not None:
            assert awq_scale.numel() == self.in_channels
            self.register_buffer('awq_scale', awq_scale.detach().float().reshape(1, -1, 1))
        else:
            self.awq_scale = None

    def forward(self, x):
        # x: [B, C, L]
        if self.awq_scale is not None:
            x = x * self.awq_scale
        # Per-tensor activation scale (constant over positions+channels) so the
        # int32 conv accumulation can be dequantized with a single post-multiply.
        # Per-position scaling is mathematically invalid for kernel>1 (output L
        # mixes input positions with different scales) and would destroy quality.
        x_int8, x_scale = quantize_activation_per_tensor(x, ACT_CLIP)
        # int32 convolution accumulation
        y_int32 = int8_conv1d(
            x_int8, self.weight_int8,
            self.stride, self.padding, self.dilation, self.groups,
        )  # [B, out, L]
        y = y_int32.float()
        # per-output scale: [1, out, 1]; x_scale is a scalar
        y = y * (self.scale.reshape(1, -1, 1) * x_scale)
        if self.bias is not None:
            y = y + self.bias.reshape(1, -1, 1)
        return y


# ============================================================
# Module replacement (Q-DiT style quantization of a torch model)
# ============================================================

LINEAR_REPLACEMENT = {}
CONV_REPLACEMENT = {}


def _replace_module(module, name='', group_size=0, quant_conv=True):
    """Recursively replace nn.Linear / nn.Conv1d with W8A8 versions."""
    for child_name, child in list(module.named_children()):
        if isinstance(child, nn.Linear):
            setattr(module, child_name, W8A8Linear(
                child.weight.data, child.bias.data if child.bias is not None else None,
                group_size=group_size))
        elif isinstance(child, nn.Conv1d) and quant_conv:
            setattr(module, child_name, W8A8Conv1d(
                child.weight.data,
                child.bias.data if child.bias is not None else None,
                child.stride[0], child.padding[0], child.dilation[0], child.groups))
        else:
            _replace_module(child, name + '.' + child_name, group_size, quant_conv)
    return module


def quantize_model_qdit(model, group_size=0, quant_conv=True):
    """Replace all Linear/Conv1d modules with true W8A8 versions.

    This is the Q-DiT style layer replacement: every projection (q/k/v/o,
    gate/up/down, embeddings, convs) gets int8 weights + dynamic int8
    activation quantization.
    """
    return _replace_module(model, '', group_size=group_size, quant_conv=quant_conv)


# ============================================================
# AWQ (Activation-aware Weight Quantization) support
#
# Per the AWQ paper: instead of quantizing W directly, apply an equivalent
# transform W' = W / s, X' = X * s, where s is chosen so the most salient
# input channels are protected. s is picked by a grid search over the power
# alpha (s = act_amp**alpha) that minimizes the REAL output error
# ||X @ W^T - X @ (s * quant(W/s))^T||^2 measured on calibration activations
# (this is exactly the llm-awq objective, not a weight-space heuristic).
# The resulting W' is then quantized to int8 per-output-channel, and at
# runtime the input is scaled by s before the (dynamic) activation
# quantization. Weights stay int8 - genuine AWQ, not fake quantization.
# ============================================================

@torch.no_grad()
def compute_awq_scale(weight, act_sample, n_grid=20, alpha_min=0.0, alpha_max=1.0):
    """llm-awq style per-input-channel scale for an nn.Linear.

    Args:
        weight: [N, K] fp32 weight
        act_sample: [T, K] fp32 calibration activation rows
    Returns:
        s: [K] fp32 per-input-channel scaling (X' = X * s, W' = W / s)
    """
    w = weight.detach().float()
    N, K = w.shape
    x = act_sample.detach().float().reshape(-1, K)
    if x.shape[0] > 8192:
        x = x[:8192]
    act_amp = x.abs().amax(dim=0).clamp(min=1e-8)  # [K]
    y_ref = x @ w.t()  # [T, N]
    alphas = torch.linspace(alpha_min, alpha_max, n_grid).tolist()
    best_err = None
    best_s = None
    for alpha in alphas:
        s = act_amp ** alpha  # [K]; alpha=0 -> s=1 (plain per-channel quant)
        w_scaled = w / s.unsqueeze(0)                      # W' = W / s
        ws_max = w_scaled.abs().amax(dim=-1, keepdim=True).clamp(min=1e-8)
        w_quant = torch.clamp(torch.round(w_scaled / (ws_max / 127.0)), -128, 127)
        w_eff = s.unsqueeze(0) * (w_quant * (ws_max / 127.0))  # effective W: s * quant(W/s)
        err = ((x @ w_eff.t() - y_ref) ** 2).mean().item()
        if best_err is None or err < best_err:
            best_err = err
            best_s = s
    return best_s


@torch.no_grad()
def compute_awq_scale_conv(weight, act_sample, stride=1, padding=0, dilation=1,
                           groups=1, n_grid=24, alpha_min=-1.0, alpha_max=1.0):
    """llm-awq style per-input-channel scale for a Conv1d, measured on the REAL
    runtime objective (including dynamic per-tensor activation quantization).

    The search picks s[c] minimizing
        || conv(quant_act(x*s), quant_w(w/s)) - conv(x, w) ||^2
    where quant_act is the exact dynamic per-tensor int8 quantization used by
    W8A8Conv1d and quant_w is per-output-channel int8. Because activations are
    quantized per-tensor (constant scale over all channels), scaling each input
    channel by s[c] equalizes their ranges so the per-tensor scale is not
    dominated by outliers -> uniform quantization SNR.

    Args:
        weight: [out, in, k] fp32
        act_sample: [B, C, L] or [C, L] fp32 calibration activation
    Returns:
        s: [in] fp32 per-input-channel scaling (X' = X * s, W' = W / s)
    """
    w = weight.detach().float()
    out, in_c, k = w.shape
    x = act_sample.detach().float()
    if x.dim() == 2:
        x = x.unsqueeze(0)  # [1, C, L]
    x = x[:, :in_c * groups, :]
    if x.shape[-1] > 2048:
        x = x[..., :2048]
    act_amp = x.abs().amax(dim=(0, 2)).clamp(min=1e-8)  # [in_c]
    y_ref = F.conv1d(x, w, None, stride, padding, dilation, groups)
    alphas = torch.linspace(alpha_min, alpha_max, n_grid).tolist()
    best_err = None
    best_s = None
    for alpha in alphas:
        s = act_amp ** alpha  # [in_c]; alpha<0 equalizes activation channel ranges
        # activation quantization exactly as W8A8Conv1d.forward does
        xs = x * s.reshape(1, -1, 1)
        xs_scale = xs.abs().amax().clamp(min=1e-8) / 127.0
        xq = torch.clamp(torch.round(xs / xs_scale), -128, 127)
        # weight quantization exactly as W8A8Conv1d does
        w_scaled = w / s.reshape(1, -1, 1)                  # W' = W / s
        ws_max = w_scaled.abs().amax(dim=(1, 2), keepdim=True).clamp(min=1e-8)
        wq = torch.clamp(torch.round(w_scaled / (ws_max / 127.0)), -128, 127)
        y_quant = F.conv1d(xq, wq, None, stride, padding, dilation, groups).float() \
            * (xs_scale * (ws_max / 127.0))
        err = ((y_quant - y_ref) ** 2).mean().item()
        if best_err is None or err < best_err:
            best_err = err
            best_s = s
    return best_s


def replace_linear_awq(module, act_stats, name=''):
    """Replace nn.Linear / nn.Conv1d in `module` with AWQ W8A8 versions.

    act_stats: dict of {module_path: calibration activation sample}
        - Linear path -> [T, K] tensor
        - Conv1d path  -> [B, C, L] or [C, L] tensor
      (paths relative to `module`; produced by collect_activation_stats)
    Consumed entries are popped to free memory as quantization proceeds.
    """
    for child_name, child in list(module.named_children()):
        path = f'{name}.{child_name}' if name else child_name
        if isinstance(child, nn.Linear):
            awq_scale = None
            if path in act_stats:
                awq_scale = compute_awq_scale(child.weight.data, act_stats.pop(path))
            setattr(module, child_name, W8A8Linear(
                child.weight.data, child.bias.data if child.bias is not None else None,
                group_size=0, awq_scale=awq_scale))
        elif isinstance(child, nn.Conv1d):
            awq_scale = None
            # depthwise conv (groups == in_channels): skip AWQ (no shared input
            # channel dimension to scale), keep plain per-output-channel int8.
            if path in act_stats and child.groups == 1:
                awq_scale = compute_awq_scale_conv(
                    child.weight.data, act_stats.pop(path),
                    child.stride[0], child.padding[0], child.dilation[0], child.groups,
                )
            else:
                act_stats.pop(path, None)
            setattr(module, child_name, W8A8Conv1d(
                child.weight.data,
                child.bias.data if child.bias is not None else None,
                child.stride[0], child.padding[0], child.dilation[0], child.groups,
                awq_scale=awq_scale))
        else:
            replace_linear_awq(child, act_stats, path)
    return module


def collect_activation_stats(model, sample_inputs, module_names, max_rows=512):
    """Collect one calibration activation sample per module path.

    model: torch module (vocoder) that we will run with a forward pass
    sample_inputs: list of input tensors (e.g. [B, C, L] mels)
    module_names: set of dotted paths to hook (relative to `model`).

    Returns dict {path: Tensor}:
        - Linear path -> [T, K] activation rows (rows capped at max_rows)
        - Conv1d path -> [C, L'] activation (channels x capped length)
    """
    stats = {}
    hooks = []

    def make_hook(path, is_conv):
        def hook(module, inp, out):
            x = inp[0].detach().float()
            if is_conv:                      # [B, C, L]
                cur = x[0, :, :max_rows]     # [C, L']
            elif x.dim() == 3:               # [B, T, K]
                cur = x.reshape(-1, x.shape[-1])[:max_rows]
            elif x.dim() == 2:               # [T, K]
                cur = x.reshape(-1, x.shape[-1])[:max_rows]
            else:
                return
            if path not in stats:
                stats[path] = cur.clone()
            else:
                if is_conv:
                    stats[path] = torch.cat([stats[path], cur], dim=1)[:, :max_rows]
                else:
                    stats[path] = torch.cat([stats[path], cur], dim=0)[:max_rows]
        return hook

    for name, module in model.named_modules():
        if name in module_names:
            is_conv = isinstance(module, nn.Conv1d)
            hooks.append(module.register_forward_hook(make_hook(name, is_conv)))

    model.eval()
    with torch.no_grad():
        for inp in sample_inputs:
            try:
                model(inp)
            except Exception:
                pass
    for h in hooks:
        h.remove()
    return stats
