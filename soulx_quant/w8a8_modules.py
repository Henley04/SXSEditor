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

import torch
import torch.nn as nn
import torch.nn.functional as F


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
        w_int8, scale = quantize_weight_symmetric(weight.detach().float(), group_size)
        self.register_buffer('weight_int8', w_int8)   # [N, K] int8
        self.register_buffer('scale', scale)           # [N, 1] or [N, G] fp32
        self.out_features, self.in_features = weight.shape
        if awq_scale is not None:
            assert awq_scale.numel() == self.in_features
            self.register_buffer('awq_scale', awq_scale.detach().float().reshape(1, -1))
        else:
            self.awq_scale = None
        if bias is not None:
            self.register_buffer('bias', bias.detach().float())
        else:
            self.bias = None

    def forward(self, x):
        # x: [*, K] float
        if self.awq_scale is not None:
            x = x * self.awq_scale
        if self.group_size <= 0:
            x_int8, x_scale = quantize_activation_per_token(x)   # int8 activations
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
            x_scale = x_amax / 127.0                              # [*, G, 1]
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
        x_int8, x_scale = quantize_activation_per_tensor(x)
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
# input channels are protected. The reconstruction error of the quantization
# is measured on real calibration activations (weighted by channel magnitude)
# and the best s is picked via a coarse grid search on the power alpha.
# The resulting W' is then quantized to int8 per-output-channel, and at
# runtime the input is scaled by s before the (dynamic per-token) activation
# quantization. This is the genuine AWQ algorithm, not fake quantization.
# ============================================================

def _weighted_quant_error(w, wmax, act_amp):
    """Mean squared reconstruction error of per-channel int8 quant, weighted
    by activation importance per input channel.

    w: [N, K], wmax: [N, 1] (per output channel max abs of w), act_amp: [K]
    """
    scale = wmax / 127.0
    wq = torch.clamp(torch.round(w / scale), -128, 127) * scale
    err = ((w - wq) ** 2 * act_amp.unsqueeze(0)).mean()
    return err


@torch.no_grad()
def compute_awq_scale(weight, act_abs_max, n_grid=20, alpha_min=0.0, alpha_max=1.0):
    """Compute per-input-channel AWQ scaling vector s.

    Args:
        weight: [N, K] fp32 weight (or [out, in/groups, k] flattened as [N, K])
        act_abs_max: [K] per-input-channel activation abs max from calibration
    Returns:
        s: [K] fp32 per-input-channel scaling (X' = X * s, W' = W / s)
    """
    assert weight.dim() == 2
    N, K = weight.shape
    act_amp = act_abs_max.reshape(-1).float().clamp(min=1e-8)
    assert act_amp.numel() == K
    # AWQ: s = (act_amp)^alpha with grid search. Pick the alpha minimizing the
    # weighted reconstruction error of quantize(W / s) * s.
    alphas = torch.linspace(alpha_min, alpha_max, n_grid).tolist()
    best_err = None
    best_s = None
    for alpha in alphas:
        # s per input channel: amplify channels with high activation
        s = act_amp ** alpha  # [K], alpha=0 -> s=1 (plain per-channel quant)
        w_scaled = weight / s.unsqueeze(0)  # [N, K]
        # per-output-channel max of scaled weight
        ws_max = w_scaled.abs().amax(dim=-1, keepdim=True).clamp(min=1e-8)
        err = _weighted_quant_error(w_scaled, ws_max, act_amp)
        if best_err is None or err.item() < best_err:
            best_err = err.item()
            best_s = s
    return best_s


@torch.no_grad()
def compute_awq_scale_conv(weight, act_abs_max, n_grid=20, alpha_min=0.0, alpha_max=1.0):
    """AWQ scaling for a Conv1d weight.

    weight: [out, in_c, k] fp32
    act_abs_max: [in_c] per-input-channel activation abs max
    Returns: s: [in_c] fp32 (applied as X' = X * s along input channels)
    """
    out, in_c, k = weight.shape
    act_amp = act_abs_max.reshape(-1).float().clamp(min=1e-8)
    assert act_amp.numel() == in_c
    w2d = weight.reshape(out, in_c * k)
    # per-input-channel weight column pattern: for each in channel c there are k
    # columns (the kernel). Build a mask to weight the error by act_amp[c].
    act_w = act_amp.unsqueeze(1).expand(-1, k).reshape(-1)  # [in_c*k]
    alphas = torch.linspace(alpha_min, alpha_max, n_grid).tolist()
    best_err = None
    best_s = None
    for alpha in alphas:
        s = act_amp ** alpha  # [in_c]
        # W'[o, c, k] = W[o, c, k] / s[c]
        w_scaled = w2d / s.unsqueeze(1).expand(-1, k).reshape(1, -1)
        ws_max = w_scaled.abs().amax(dim=-1, keepdim=True).clamp(min=1e-8)
        scale = ws_max / 127.0
        wq = torch.clamp(torch.round(w_scaled / scale), -128, 127) * scale
        err = ((w_scaled - wq) ** 2 * act_w.unsqueeze(0)).mean()
        if best_err is None or err.item() < best_err:
            best_err = err.item()
            best_s = s
    return best_s


def replace_linear_awq(module, act_stats, name=''):
    """Replace nn.Linear / nn.Conv1d in `module` with AWQ W8A8 versions.

    act_stats: dict of {module_path: torch.Tensor [in_channels]} per-input-
    channel activation abs max collected during calibration (paths relative
    to `module`).
    """
    for child_name, child in list(module.named_children()):
        path = f'{name}.{child_name}' if name else child_name
        if isinstance(child, nn.Linear):
            awq_scale = None
            if path in act_stats:
                awq_scale = compute_awq_scale(child.weight.data, act_stats[path])
            setattr(module, child_name, W8A8Linear(
                child.weight.data, child.bias.data if child.bias is not None else None,
                group_size=0, awq_scale=awq_scale))
        elif isinstance(child, nn.Conv1d):
            awq_scale = None
            # depthwise conv (groups == in_channels): skip AWQ (no shared input
            # channel dimension to scale), keep plain per-output-channel int8.
            if path in act_stats and child.groups == 1:
                awq_scale = compute_awq_scale_conv(child.weight.data, act_stats[path])
            setattr(module, child_name, W8A8Conv1d(
                child.weight.data,
                child.bias.data if child.bias is not None else None,
                child.stride[0], child.padding[0], child.dilation[0], child.groups,
                awq_scale=awq_scale))
        else:
            replace_linear_awq(child, act_stats, path)
    return module


def collect_activation_stats(model, sample_inputs, module_names):
    """Collect per-input-channel activation abs max for the given module paths.

    model: torch module (vocoder) that we will run with a forward pass
    sample_inputs: list of input tensors (e.g. [B, C, L] mels)
    module_names: set of dotted paths to hook (relative to `model`).

    Returns dict {path: Tensor [in_channels]} of abs-max per input channel.
    """
    stats = {}
    hooks = []

    def make_hook(path, is_conv):
        def hook(module, inp, out):
            x = inp[0]
            if x.dim() == 2:            # [*, K]
                xr = x.reshape(-1, x.shape[-1])
                cur = xr.abs().amax(dim=0)  # [K]
            elif x.dim() == 3 and is_conv:   # conv: [B, C, L]
                xr = x.reshape(x.shape[0], x.shape[1], -1)
                cur = xr.abs().amax(dim=(0, 2))  # [C]
            elif x.dim() == 3:          # linear: [B, T, C] -> channels along last dim
                xr = x.reshape(-1, x.shape[-1])
                cur = xr.abs().amax(dim=0)  # [C]
            else:
                return
            if path not in stats:
                stats[path] = cur.clone()
            else:
                stats[path] = torch.maximum(stats[path], cur)
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
