# -*- coding: utf-8 -*-
"""
Shared utilities for ONNX export pipeline (FP32 opset 20 main path + INT8/FP16 utilities).
Contains: compatibility patches, model wrappers, ONNX post-processing (STFT replacement,
ConvTranspose decomposition, onnxsim), FP32 opset 20 export helper, FP16/INT8 quantization.
"""

import os
import sys
import gc
import types
import time
import numpy as np

# ============================================================
# Compatibility patches
# ============================================================

class DictConfig(dict):
    def __getattr__(self, n):
        try: return DictConfig(self[n]) if isinstance(self[n], dict) else self[n]
        except KeyError: raise AttributeError(n)
    def __setattr__(self, n, v): self[n] = v
    def __contains__(self, k): return k in self

omegaconf = types.ModuleType('omegaconf')
omegaconf.DictConfig = DictConfig
sys.modules['omegaconf'] = omegaconf

class Config:
    def __init__(self, d):
        for k, v in d.items():
            setattr(self, k, Config(v) if isinstance(v, dict) else v)
    def __getattr__(self, n):
        if n.startswith('_'): raise AttributeError(n)
        try: return self.__dict__[n]
        except KeyError: raise AttributeError(f'no {n!r}')
    def __getitem__(self, k): return self.__dict__[k]
    def get(self, k, d=None): return self.__dict__.get(k, d)
    def __contains__(self, k): return k in self.__dict__
    def keys(self): return [k for k in self.__dict__ if not k.startswith('_')]
    def __iter__(self): return iter(self.keys())
    def items(self): return [(k, self.__dict__[k]) for k in self.keys()]

# Patch LlamaConfig for positional args
import transformers
from transformers import LlamaConfig as LC
from transformers.models.llama.modeling_llama import LlamaRotaryEmbedding
_orig_lc = LC.__init__
def _pi(self, *a, **kw):
    if a and not kw:
        for i, n in enumerate(['vocab_size','hidden_size','num_hidden_layers','num_attention_heads','intermediate_size']):
            if i < len(a): kw[n] = a[i]
    _orig_lc(self, **kw)
LC.__init__ = _pi

import torch
import torch.nn as nn
import yaml
import onnx
from onnx import helper, numpy_helper, TensorProto, shape_inference

try:
    import onnxsim
    HAS_ONNXSIM = True
except ImportError:
    HAS_ONNXSIM = False

try:
    import sympy
    HAS_SYMPY = True
except ImportError:
    HAS_SYMPY = False

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SOULX_DIR = os.path.join(SCRIPT_DIR, 'SoulX-Singer')
sys.path.insert(0, SOULX_DIR)

from soulxsinger.models.soulxsinger import SoulXSinger
from soulxsinger.models.modules.llama import DiffLlama, LlamaNARDecoderLayer

# Patch LlamaNARDecoderLayer.forward
def _pnar(self, hidden_states, cond_embedding, attention_mask=None, position_ids=None,
          past_key_value=None, output_attentions=False, use_cache=False,
          position_embeddings=None, **kwargs):
    residual = hidden_states
    hidden_states = self.input_layernorm(hidden_states, cond_embedding=cond_embedding)
    attn_out = self.self_attn(hidden_states=hidden_states, position_embeddings=position_embeddings,
                              attention_mask=attention_mask, past_key_values=past_key_value)
    if isinstance(attn_out, tuple):
        hidden_states = attn_out[0]
    else:
        hidden_states = attn_out
    hidden_states = residual + hidden_states
    residual = hidden_states
    hidden_states = self.post_attention_layernorm(hidden_states, cond_embedding=cond_embedding)
    hidden_states = self.mlp(hidden_states)
    hidden_states = residual + hidden_states
    return (hidden_states,)
LlamaNARDecoderLayer.forward = _pnar

_orig_dli = DiffLlama.__init__
def _pdli(self, *a, **kw):
    _orig_dli(self, *a, **kw)
    layer_cfg = self.layers[0].self_attn.config
    self.rotary_emb = LlamaRotaryEmbedding(config=layer_cfg)
DiffLlama.__init__ = _pdli

def _pdl(self, x, diffusion_step, cond, x_mask, **kw):
    B, T, _ = x.shape
    cond_embedding = self.cond_mlp(cond)
    x = self.mel_mlp(x)
    diffusion_step = self.diff_step_embedding(diffusion_step).to(x.device)
    diffusion_step = self.diff_step_mlp(diffusion_step)
    x = x + cond_embedding
    attention_mask = self._prepare_decoder_attention_mask(x_mask, (B, T), x, 0)
    hidden_states = x
    position_ids = torch.arange(T, dtype=torch.long, device=x.device).unsqueeze(0).expand(B, -1)
    position_embeddings = self.rotary_emb(hidden_states, position_ids=position_ids)
    for decoder_layer in self.layers:
        layer_outputs = decoder_layer(hidden_states, attention_mask=attention_mask,
                                      position_embeddings=position_embeddings,
                                      cond_embedding=diffusion_step)
        hidden_states = layer_outputs[0]
    hidden_states = self.norm(hidden_states, cond_embedding=diffusion_step)
    hidden_states = self.mel_out_mlp(hidden_states)
    return hidden_states
DiffLlama.forward = _pdl

print("[PATCHES] Applied transformers 5.x compatibility patches")

# ============================================================
# Sub-model wrappers
# ============================================================

class DiffStepWrapper(nn.Module):
    def __init__(self, cfm_decoder):
        super().__init__()
        self.cond_emb = cfm_decoder.model.cond_emb
        self.diff_estimator = cfm_decoder.model.diff_estimator
    def forward(self, xt_input, t, cond, xt_mask):
        cond_emb = self.cond_emb(cond)
        return self.diff_estimator(xt_input, t, cond_emb, xt_mask)

class VocoderBackboneWrapper(nn.Module):
    def __init__(self, vocoder):
        super().__init__()
        self.backbone = vocoder.model.backbone
        self.head_out = vocoder.model.head.out
    def forward(self, mel):
        return self.head_out(self.backbone(mel.transpose(1, 2)))


class VocosFullWrapper(nn.Module):
    """Full Vocos wrapper: backbone + ISTFTHead with MatMul-based IDFT and manual overlap-add.

    Outputs waveform [B, T*hop] instead of raw spec [B, T, n_fft+2].

    Uses MatMul for inverse DFT (avoids DFT nodes unsupported by DML) and
    a manual Pad+Add overlap-add (avoids Col2Im unsupported by DML).

    The overlap-add exploits win = num_overlap * hop (here 1920 = 4 * 480):
    ifft [B, win, T] is reshaped to [B, hop, num_overlap, T], each overlap
    level j is shifted by j frames along T, then all levels are summed.
    This unrolls to num_overlap-1 Add + num_overlap Pad nodes (constant,
    known at trace time), all DML-compatible.

    Buffer names include 'istft' so quantize_weights_to_fp16 skips them
    (IDFT basis matrices need FP32 precision for numerical stability).
    """

    def __init__(self, vocoder):
        super().__init__()
        self.backbone = vocoder.model.backbone
        self.head_out = vocoder.model.head.out  # Linear(dim, n_fft+2)

        istft = vocoder.model.head.istft
        self.hop_length = istft.hop_length
        self.win_length = istft.win_length
        self.n_fft = istft.n_fft
        self.pad = (istft.win_length - istft.hop_length) // 2
        self.num_overlap = istft.win_length // istft.hop_length
        assert istft.win_length % istft.hop_length == 0, \
            "win_length must be a multiple of hop_length for manual overlap-add"

        # Window buffer (Hann window, win_length samples)
        self.register_buffer('istft_window', istft.window.clone())

        # Precompute inverse DFT basis matrices for irfft(spec, n_fft, norm="backward").
        # For one-sided spectrum of length num_freq = n_fft//2+1, the irfft formula is:
        #   x[n] = (1/n_fft) * sum_{k=0}^{num_freq-1} w[k] * Re(spec[k] * exp(2*pi*i*k*n/n_fft))
        # where w[0]=1, w[num_freq-1]=1, w[1..num_freq-2]=2 (one-sided weighting).
        n_fft = istft.n_fft
        num_freq = n_fft // 2 + 1
        n = torch.arange(n_fft, dtype=torch.float32)
        k = torch.arange(num_freq, dtype=torch.float32).unsqueeze(1)  # [num_freq, 1]
        weights = torch.ones(num_freq, dtype=torch.float32)
        weights[1:-1] = 2.0
        cos_basis = weights.unsqueeze(1) * torch.cos(2 * np.pi * k * n.unsqueeze(0) / n_fft) / n_fft
        sin_basis = weights.unsqueeze(1) * torch.sin(2 * np.pi * k * n.unsqueeze(0) / n_fft) / n_fft
        self.register_buffer('istft_cos_basis', cos_basis)  # [num_freq, n_fft]
        self.register_buffer('istft_sin_basis', sin_basis)

    def _overlap_add(self, frames):
        """Manual overlap-add: frames [B, win, T] → output [B, T*hop].

        Replaces torch.nn.functional.fold (which exports as Col2Im, unsupported
        by DML). Exploits win = num_overlap * hop to decompose into Pad + Add.

        frames[b, j*hop+h, t] contributes to output[b, (t+j)*hop + h].
        """
        B, win, T = frames.shape
        hop = self.hop_length
        num_ov = self.num_overlap

        # Reshape [B, win, T] → [B, hop, num_overlap, T]
        # frames[b, j*hop+h, t] → reshaped[b, h, j, t]
        reshaped = frames.reshape(B, hop, num_ov, T)

        # Shift each overlap level j by j frames along T, then sum.
        # Level j: pad T with (j, num_ov-1-j) → [B, hop, T+num_ov-1]
        accum = torch.nn.functional.pad(reshaped[:, :, 0, :], (0, num_ov - 1))
        for j in range(1, num_ov):
            padded = torch.nn.functional.pad(reshaped[:, :, j, :], (j, num_ov - 1 - j))
            accum = accum + padded
        # accum: [B, hop, T + num_overlap - 1], position f = t+j

        # Transpose [B, hop, T+num_ov-1] → [B, T+num_ov-1, hop] → reshape [B, out_len]
        # so that out[b, f*hop + h] = accum[b, h, f]
        accum = accum.transpose(1, 2)
        out = accum.reshape(B, -1)  # [B, (T+num_ov-1)*hop]

        # Trim edges: [B, T*hop]
        out = out[:, self.pad:-self.pad]
        return out

    def forward(self, mel):
        # mel: [B, T, 128] → backbone expects [B, input_channels, T]
        x = self.backbone(mel.transpose(1, 2))  # [B, T, dim]
        x = self.head_out(x)  # [B, T, n_fft+2]
        x = x.transpose(1, 2)  # [B, n_fft+2, T]
        mag, p = x.chunk(2, dim=1)  # [B, num_freq, T] each
        mag = torch.exp(mag)
        mag = torch.clip(mag, max=1e2)
        S_real = mag * torch.cos(p)  # [B, num_freq, T]
        S_imag = mag * torch.sin(p)  # [B, num_freq, T]

        # IDFT via MatMul: ifft[n] = sum_k (cos_basis[k,n]*S_real[k] - sin_basis[k,n]*S_imag[k])
        # cos_basis: [num_freq, n_fft], S_real: [B, num_freq, T]
        # matmul(cos_basis.t(), S_real) broadcasts to [B, n_fft, T]
        ifft = torch.matmul(self.istft_cos_basis.t(), S_real) - \
               torch.matmul(self.istft_sin_basis.t(), S_imag)  # [B, n_fft, T]

        # Windowing
        ifft = ifft * self.istft_window.unsqueeze(1)  # [B, n_fft, T] * [n_fft, 1]

        # Overlap-add via manual Pad+Add (DML-compatible, no Col2Im)
        y = self._overlap_add(ifft)  # [B, T*hop]

        # Window envelope: overlap-add of window^2 (independent of input data)
        T = ifft.shape[2]
        window_sq = self.istft_window.square()  # [win]
        # Expand to [1, win, T] for overlap-add
        wsq_expanded = window_sq.unsqueeze(0).unsqueeze(-1).expand(1, -1, T)  # [1, win, T]
        window_envelope = self._overlap_add(wsq_expanded)  # [1, T*hop]

        y = y / window_envelope.clamp(min=1e-11)
        return y  # [B, T*hop]

# ============================================================
# Constants
# ============================================================

DEFAULT_OUTPUT_DIR = os.path.join(SCRIPT_DIR, 'onnx_models', 'int8', 'from_pytorch')
FP32_OUTPUT_DIR = os.path.join(SCRIPT_DIR, 'onnx_models')

# ============================================================
# Model loading
# ============================================================

def load_config():
    config_path = os.path.join(SOULX_DIR, 'soulxsinger', 'config', 'soulxsinger.yaml')
    with open(config_path) as f:
        return Config(yaml.safe_load(f))

def load_model(config, model_path):
    """Load SoulX-Singer model. Caller must del when done."""
    model = SoulXSinger(config).cpu()
    ckpt = torch.load(model_path, weights_only=False, map_location='cpu')
    model.load_state_dict(ckpt['state_dict'])
    del ckpt
    model.eval()
    return model

def clear_memory():
    """Force garbage collection and clear torch caches."""
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    gc.collect()

# ============================================================
# ONNX post-processing (STFT replacement, etc.)
# ============================================================

UNSUPPORTED_OPS = {'DynamicQuantizeLinear', 'MatMulInteger', 'ConvInteger', 'STFT'}

def find_initializer(graph, name):
    for init in graph.initializer:
        if init.name == name:
            return init
    return None

def _build_cooley_tukey_stft(stft_node, graph, conv_input, signal_is_3d,
                              hop_size, window, n_fft, onesided, eps_value,
                              final_output_name):
    """Build Cooley-Tukey MatMul DFT for STFT replacement (N=1920=64×30).

    Decomposes N=1920 DFT into 64×30 two-step MatMul for higher precision.
    Accumulated error: sqrt(64)+sqrt(30)≈13.5ε vs sqrt(1920)≈43.8ε for direct
    Conv1D DFT. 3.2x improvement, sufficient to escape log() sensitivity region
    that caused mel_transform SNR=49.86dB (vs 119dB for other models).

    Algorithm (real-input DFT via Cooley-Tukey):
      N = N1 × N2 = 64 × 30
      Index map: n = N2*n1 + n2 (n1∈[0,64), n2∈[0,30))
                 k = k1 + N1*k2 (k1∈[0,64), k2∈[0,30))
      X[k1+N1*k2] = Σ_{n2} W_{N2}^(k2*n2) * W_N^(k1*n2) * [Σ_{n1} x[N2*n1+n2] * W_{N1}^(k1*n1)]

    Steps:
      1. Gather sliding window matrix [B, T_frames, N] + Mul window
      2. Reshape → [B, T, 64, 30], Transpose → [B, T, 30, 64] (n2, n1)
      3. DFT64: MatMul with cos/sin basis → G_real, G_imag [B, T, 30, 64] (n2, k1)
      4. Twiddle: G' = G * (cos - i*sin)(2π*k1*n2/N)
      5. Transpose → [B, T, 64, 30] (k1, n2)
      6. DFT30: MatMul with cos/sin basis → X_real, X_imag [B, T, 64, 30] (k1, k2)
      7. |X|^2, Reshape → [B, T, 1920], Slice onesided → [B, T, 961]
      8. Transpose → [B, 961, T], Add(eps), Sqrt

    Returns (new_nodes, new_initializers) or None if not applicable.
    """
    N1, N2 = 64, 30
    if N1 * N2 != n_fft:
        return None

    num_freq = n_fft // 2 + 1 if onesided else n_fft

    # Get static input shape for index precomputation
    input_shape = None
    for vi in list(graph.value_info) + list(graph.input):
        if vi.name == conv_input:
            dims = [d.dim_value for d in vi.type.tensor_type.shape.dim]
            if dims and all(d > 0 for d in dims):
                input_shape = dims
            break
    if input_shape is None:
        return None  # Dynamic shape, can't precompute gather indices

    T_padded = input_shape[-1]
    T_frames = (T_padded - n_fft) // hop_size + 1
    if T_frames <= 0:
        return None

    prefix = stft_node.name
    new_nodes = []
    new_initializers = []

    # ============================================================
    # Step 1: Sliding window matrix via Gather + Mul window
    # ============================================================
    # Gather indices [T_frames, n_fft]: indices[t, n] = t*hop + n
    t_range = np.arange(T_frames, dtype=np.int64) * hop_size
    n_range = np.arange(n_fft, dtype=np.int64)
    gather_indices = t_range.reshape(-1, 1) + n_range.reshape(1, -1)
    indices_name = f"{prefix}_gather_indices"
    new_initializers.append(numpy_helper.from_array(gather_indices, name=indices_name))

    # Ensure input is 3D [B, 1, T_padded]
    if signal_is_3d:
        gather_input = conv_input
    else:
        unsq_name = f"{prefix}_3d"
        ax_name = f"{prefix}_ax"
        new_nodes.append(helper.make_node('Unsqueeze', [conv_input, ax_name],
                                           [unsq_name], name=f"{prefix}_unsq"))
        new_initializers.append(numpy_helper.from_array(np.array([1], dtype=np.int64),
                                                         name=ax_name))
        gather_input = unsq_name

    # Gather(axis=2): [B, 1, T_padded] → [B, 1, T_frames, n_fft]
    frames_name = f"{prefix}_frames"
    new_nodes.append(helper.make_node('Gather', [gather_input, indices_name],
                                       [frames_name], name=f"{prefix}_gather", axis=2))

    # Squeeze axis=1: → [B, T_frames, n_fft]
    squeezed_name = f"{prefix}_squeezed"
    sq_ax_name = f"{prefix}_sq_ax"
    new_nodes.append(helper.make_node('Squeeze', [frames_name, sq_ax_name],
                                       [squeezed_name], name=f"{prefix}_squeeze"))
    new_initializers.append(numpy_helper.from_array(np.array([1], dtype=np.int64),
                                                     name=sq_ax_name))

    # Mul window (broadcast along n_fft dim)
    window_name = f"{prefix}_window"
    new_initializers.append(numpy_helper.from_array(window.astype(np.float32), name=window_name))
    windowed_name = f"{prefix}_windowed"
    new_nodes.append(helper.make_node('Mul', [squeezed_name, window_name],
                                       [windowed_name], name=f"{prefix}_win_mul"))

    # ============================================================
    # Step 2: Reshape [B, T, 1920] → [B, T, 64, 30] + Transpose → [B, T, 30, 64]
    # ============================================================
    # Build shape [B, T, 64, 30] dynamically (first 2 dims from input, last 2 fixed)
    shape_name = f"{prefix}_shape"
    new_nodes.append(helper.make_node('Shape', [windowed_name], [shape_name],
                                       name=f"{prefix}_shape_node"))
    # Slice first 2 elements of shape (Shape is 1D [B, T, N], take [0:2] → [B, T])
    bt_starts = f"{prefix}_bt_starts"
    bt_ends = f"{prefix}_bt_ends"
    bt_axes = f"{prefix}_bt_axes"
    new_initializers.append(numpy_helper.from_array(np.array([0], dtype=np.int64), name=bt_starts))
    new_initializers.append(numpy_helper.from_array(np.array([2], dtype=np.int64), name=bt_ends))
    new_initializers.append(numpy_helper.from_array(np.array([0], dtype=np.int64), name=bt_axes))
    bt_shape_name = f"{prefix}_bt_shape"
    new_nodes.append(helper.make_node('Slice', [shape_name, bt_starts, bt_ends, bt_axes],
                                       [bt_shape_name], name=f"{prefix}_bt_slice"))
    # Concat with [N1, N2]
    n1_n2_name = f"{prefix}_n1_n2"
    new_initializers.append(numpy_helper.from_array(np.array([N1, N2], dtype=np.int64), name=n1_n2_name))
    reshape_shape_name = f"{prefix}_reshape_shape"
    new_nodes.append(helper.make_node('Concat', [bt_shape_name, n1_n2_name],
                                       [reshape_shape_name], name=f"{prefix}_shape_concat", axis=0))
    reshaped_name = f"{prefix}_reshaped"
    new_nodes.append(helper.make_node('Reshape', [windowed_name, reshape_shape_name],
                                       [reshaped_name], name=f"{prefix}_reshape"))

    # Transpose [B, T, 64, 30] → [B, T, 30, 64] (n2, n1)
    transposed_name = f"{prefix}_transposed"
    new_nodes.append(helper.make_node('Transpose', [reshaped_name], [transposed_name],
                                       name=f"{prefix}_transpose", perm=[0, 1, 3, 2]))

    # ============================================================
    # Step 3: DFT64 along n1 (MatMul)
    # G_real[n2, k1] = Σ_{n1} x[n2, n1] * cos(2π*k1*n1/64)
    # G_imag[n2, k1] = Σ_{n1} x[n2, n1] * (-sin(2π*k1*n1/64))
    # MatMul(x_T[n2,n1], basis_T[n1,k1]) → [n2, k1]
    # ============================================================
    n1_arr = np.arange(N1, dtype=np.float32)
    k1_arr = np.arange(N1, dtype=np.float32).reshape(-1, 1)
    dft64_real = np.cos(2 * np.pi * k1_arr * n1_arr / N1).astype(np.float32)  # [k1, n1]
    dft64_imag = (-np.sin(2 * np.pi * k1_arr * n1_arr / N1)).astype(np.float32)  # [k1, n1]
    # Transpose to [n1, k1] for MatMul
    dft64_real_T = dft64_real.T.copy()
    dft64_imag_T = dft64_imag.T.copy()

    dft64_real_name = f"{prefix}_dft64_real_T"
    dft64_imag_name = f"{prefix}_dft64_imag_T"
    new_initializers.append(numpy_helper.from_array(dft64_real_T, name=dft64_real_name))
    new_initializers.append(numpy_helper.from_array(dft64_imag_T, name=dft64_imag_name))

    g_real_name = f"{prefix}_g_real"
    g_imag_name = f"{prefix}_g_imag"
    new_nodes.append(helper.make_node('MatMul', [transposed_name, dft64_real_name],
                                       [g_real_name], name=f"{prefix}_dft64_real"))
    new_nodes.append(helper.make_node('MatMul', [transposed_name, dft64_imag_name],
                                       [g_imag_name], name=f"{prefix}_dft64_imag"))

    # ============================================================
    # Step 4: Twiddle multiplication
    # G'[n2, k1] = G[n2, k1] * W_N^(k1*n2), W_N = exp(-2πi/N)
    # W_real = cos(2π*k1*n2/N), W_imag = -sin(2π*k1*n2/N)
    # G'_real = G_real*Tw_real - G_imag*Tw_imag
    # G'_imag = G_real*Tw_imag + G_imag*Tw_real
    # ============================================================
    n2_arr = np.arange(N2, dtype=np.float32).reshape(-1, 1)  # [n2, 1]
    k1_arr2 = np.arange(N1, dtype=np.float32).reshape(1, -1)  # [1, k1]
    twiddle_real = np.cos(2 * np.pi * k1_arr2 * n2_arr / n_fft).astype(np.float32)  # [n2, k1]
    twiddle_imag = (-np.sin(2 * np.pi * k1_arr2 * n2_arr / n_fft)).astype(np.float32)  # [n2, k1]

    twiddle_real_name = f"{prefix}_twiddle_real"
    twiddle_imag_name = f"{prefix}_twiddle_imag"
    new_initializers.append(numpy_helper.from_array(twiddle_real, name=twiddle_real_name))
    new_initializers.append(numpy_helper.from_array(twiddle_imag, name=twiddle_imag_name))

    temp1 = f"{prefix}_t1"; temp2 = f"{prefix}_t2"
    temp3 = f"{prefix}_t3"; temp4 = f"{prefix}_t4"
    gp_real = f"{prefix}_gp_real"; gp_imag = f"{prefix}_gp_imag"

    new_nodes.append(helper.make_node('Mul', [g_real_name, twiddle_real_name],
                                       [temp1], name=f"{prefix}_tw_r1"))
    new_nodes.append(helper.make_node('Mul', [g_imag_name, twiddle_imag_name],
                                       [temp2], name=f"{prefix}_tw_r2"))
    new_nodes.append(helper.make_node('Sub', [temp1, temp2],
                                       [gp_real], name=f"{prefix}_tw_rsub"))
    new_nodes.append(helper.make_node('Mul', [g_real_name, twiddle_imag_name],
                                       [temp3], name=f"{prefix}_tw_i1"))
    new_nodes.append(helper.make_node('Mul', [g_imag_name, twiddle_real_name],
                                       [temp4], name=f"{prefix}_tw_i2"))
    new_nodes.append(helper.make_node('Add', [temp3, temp4],
                                       [gp_imag], name=f"{prefix}_tw_iadd"))

    # ============================================================
    # Step 5: Transpose G' [B, T, 30, 64] → [B, T, 64, 30] (k1, n2)
    # ============================================================
    gp_real_T = f"{prefix}_gp_real_T"
    gp_imag_T = f"{prefix}_gp_imag_T"
    new_nodes.append(helper.make_node('Transpose', [gp_real], [gp_real_T],
                                       name=f"{prefix}_gp_T_r", perm=[0, 1, 3, 2]))
    new_nodes.append(helper.make_node('Transpose', [gp_imag], [gp_imag_T],
                                       name=f"{prefix}_gp_T_i", perm=[0, 1, 3, 2]))

    # ============================================================
    # Step 6: DFT30 along n2 (MatMul)
    # X_real[k1, k2] = Σ_{n2} G'_real[k1,n2]*cos(2π*k2*n2/30) + G'_imag[k1,n2]*sin(2π*k2*n2/30)
    # X_imag[k1, k2] = -Σ_{n2} G'_real[k1,n2]*sin(2π*k2*n2/30) + G'_imag[k1,n2]*cos(2π*k2*n2/30)
    # ============================================================
    n2_arr2 = np.arange(N2, dtype=np.float32)
    k2_arr = np.arange(N2, dtype=np.float32).reshape(-1, 1)
    dft30_cos = np.cos(2 * np.pi * k2_arr * n2_arr2 / N2).astype(np.float32)  # [k2, n2]
    dft30_sin = np.sin(2 * np.pi * k2_arr * n2_arr2 / N2).astype(np.float32)  # [k2, n2]
    # Transpose to [n2, k2] for MatMul
    dft30_cos_T = dft30_cos.T.copy()
    dft30_sin_T = dft30_sin.T.copy()

    dft30_cos_name = f"{prefix}_dft30_cos_T"
    dft30_sin_name = f"{prefix}_dft30_sin_T"
    new_initializers.append(numpy_helper.from_array(dft30_cos_T, name=dft30_cos_name))
    new_initializers.append(numpy_helper.from_array(dft30_sin_T, name=dft30_sin_name))

    # X_real = MatMul(G'_real, cos_T) + MatMul(G'_imag, sin_T)
    x_real_p1 = f"{prefix}_x_r1"; x_real_p2 = f"{prefix}_x_r2"
    x_real_name = f"{prefix}_x_real"
    new_nodes.append(helper.make_node('MatMul', [gp_real_T, dft30_cos_name],
                                       [x_real_p1], name=f"{prefix}_dft30_r1"))
    new_nodes.append(helper.make_node('MatMul', [gp_imag_T, dft30_sin_name],
                                       [x_real_p2], name=f"{prefix}_dft30_r2"))
    new_nodes.append(helper.make_node('Add', [x_real_p1, x_real_p2],
                                       [x_real_name], name=f"{prefix}_x_radd"))

    # X_imag = -MatMul(G'_real, sin_T) + MatMul(G'_imag, cos_T)
    x_imag_p1 = f"{prefix}_x_i1"; x_imag_p2 = f"{prefix}_x_i2"
    x_imag_name = f"{prefix}_x_imag"
    new_nodes.append(helper.make_node('MatMul', [gp_real_T, dft30_sin_name],
                                       [x_imag_p1], name=f"{prefix}_dft30_i1"))
    new_nodes.append(helper.make_node('MatMul', [gp_imag_T, dft30_cos_name],
                                       [x_imag_p2], name=f"{prefix}_dft30_i2"))
    new_nodes.append(helper.make_node('Sub', [x_imag_p2, x_imag_p1],
                                       [x_imag_name], name=f"{prefix}_x_isub"))

    # ============================================================
    # Step 7: |X|^2 = X_real^2 + X_imag^2
    # ============================================================
    x_real_sq = f"{prefix}_x_rsq"; x_imag_sq = f"{prefix}_x_isq"
    mag_sq_name = f"{prefix}_mag_sq"
    new_nodes.append(helper.make_node('Mul', [x_real_name, x_real_name],
                                       [x_real_sq], name=f"{prefix}_x_rsq"))
    new_nodes.append(helper.make_node('Mul', [x_imag_name, x_imag_name],
                                       [x_imag_sq], name=f"{prefix}_x_isq"))
    new_nodes.append(helper.make_node('Add', [x_real_sq, x_imag_sq],
                                       [mag_sq_name], name=f"{prefix}_mag_sq_add"))

    # ============================================================
    # Step 8: Transpose [B, T, 64, 30] → [B, T, 30, 64] (k2, k1),
    #          then Reshape → [B, T, 1920] (k = k2*N1 + k1 = k1 + 64*k2),
    #          then Onesided slice → [B, T, 961]
    # ============================================================
    # Output index: k = k1 + N1*k2. Row-major reshape of [k2, k1] gives k = k2*N1 + k1 ✓
    mag_sq_transposed = f"{prefix}_mag_sq_k2k1"
    new_nodes.append(helper.make_node('Transpose', [mag_sq_name], [mag_sq_transposed],
                                       name=f"{prefix}_mag_sq_k2k1_transpose", perm=[0, 1, 3, 2]))
    n_fft_const = f"{prefix}_n_fft_const"
    new_initializers.append(numpy_helper.from_array(np.array([n_fft], dtype=np.int64), name=n_fft_const))
    flat_shape = f"{prefix}_flat_shape"
    new_nodes.append(helper.make_node('Concat', [bt_shape_name, n_fft_const],
                                       [flat_shape], name=f"{prefix}_flat_concat", axis=0))
    mag_sq_flat = f"{prefix}_mag_sq_flat"
    new_nodes.append(helper.make_node('Reshape', [mag_sq_transposed, flat_shape],
                                       [mag_sq_flat], name=f"{prefix}_mag_sq_reshape"))

    if onesided:
        # Slice [0:num_freq] along axis=2
        sl_starts = f"{prefix}_sl_starts"; sl_ends = f"{prefix}_sl_ends"
        sl_axes = f"{prefix}_sl_axes"; sl_steps = f"{prefix}_sl_steps"
        new_initializers.append(numpy_helper.from_array(np.array([0], dtype=np.int64), name=sl_starts))
        new_initializers.append(numpy_helper.from_array(np.array([num_freq], dtype=np.int64), name=sl_ends))
        new_initializers.append(numpy_helper.from_array(np.array([2], dtype=np.int64), name=sl_axes))
        new_initializers.append(numpy_helper.from_array(np.array([1], dtype=np.int64), name=sl_steps))
        mag_sq_os = f"{prefix}_mag_sq_os"
        new_nodes.append(helper.make_node('Slice',
                                           [mag_sq_flat, sl_starts, sl_ends, sl_axes, sl_steps],
                                           [mag_sq_os], name=f"{prefix}_os_slice"))
    else:
        mag_sq_os = mag_sq_flat

    # ============================================================
    # Step 9: Transpose [B, T, num_freq] → [B, num_freq, T] + Add(eps) + Sqrt
    # ============================================================
    mag_sq_t = f"{prefix}_mag_sq_t"
    new_nodes.append(helper.make_node('Transpose', [mag_sq_os], [mag_sq_t],
                                       name=f"{prefix}_mag_sq_transpose", perm=[0, 2, 1]))

    if eps_value is None or eps_value == 0.0:
        eps_value = 1e-9
    eps_name = f"{prefix}_eps"
    new_initializers.append(numpy_helper.from_array(
        np.array([eps_value], dtype=np.float32), name=eps_name))
    mag_sq_eps = f"{prefix}_mag_sq_eps"
    new_nodes.append(helper.make_node('Add', [mag_sq_t, eps_name], [mag_sq_eps],
                                       name=f"{prefix}_eps_add"))
    new_nodes.append(helper.make_node('Sqrt', [mag_sq_eps], [final_output_name],
                                       name=f"{prefix}_sqrt"))

    return new_nodes, new_initializers


def replace_stft(model):
    graph = model.graph
    nodes_to_remove = set()
    new_nodes = []
    new_initializers = []
    replaced = 0
    ct_used = 0

    for stft_node in list(graph.node):
        if stft_node.op_type != 'STFT':
            continue

        def get_constant_value(graph, name):
            init = find_initializer(graph, name)
            if init is not None:
                return numpy_helper.to_array(init)
            for node in graph.node:
                if node.op_type == 'Constant' and name in node.output:
                    for attr in node.attribute:
                        if attr.name == 'value':
                            return numpy_helper.to_array(attr.t)
            return None

        frame_step_val = get_constant_value(graph, stft_node.input[1])
        window_val = get_constant_value(graph, stft_node.input[2])
        if frame_step_val is None or window_val is None:
            continue

        hop_size = int(frame_step_val.item())
        window = window_val.astype(np.float32)
        n_fft = len(window)
        onesided = any(a.name == 'onesided' and a.i == 1 for a in stft_node.attribute)
        num_freq = n_fft // 2 + 1 if onesided else n_fft

        conv_input = stft_node.input[0]
        signal_is_3d = any(
            vi.name == conv_input and len([d.dim_value for d in vi.type.tensor_type.shape.dim]) == 3
            for vi in graph.value_info
        )

        stft_output = stft_node.output[0]
        trans_node = next((n2 for n2 in graph.node if n2.op_type == 'Transpose' and stft_output in n2.input), None)
        if not trans_node:
            continue
        pow_node = next((n2 for n2 in graph.node if n2.op_type == 'Pow' and trans_node.output[0] in n2.input), None)
        if not pow_node:
            continue
        reduce_node = next((n2 for n2 in graph.node if n2.op_type == 'ReduceSum' and pow_node.output[0] in n2.input), None)
        if not reduce_node:
            continue

        current = reduce_node.output[0]
        add_node = None
        for n2 in graph.node:
            if n2.op_type == 'Add' and current in n2.input:
                add_node = n2
                current = n2.output[0]
                break
        sqrt_node = next((n2 for n2 in graph.node if n2.op_type == 'Sqrt' and current in n2.input), None)
        if not sqrt_node:
            continue

        # Extract epsilon from original Add node (e.g., +1e-9 in sqrt(mag_sq + 1e-9)).
        eps_value = None
        if add_node is not None:
            other_input = add_node.input[1] if add_node.input[0] == reduce_node.output[0] else add_node.input[0]
            eps_init = find_initializer(graph, other_input)
            if eps_init is not None:
                arr = numpy_helper.to_array(eps_init)
                if arr.size == 1:
                    eps_value = float(arr.item())
            if eps_value is None:
                for n2 in graph.node:
                    if n2.op_type == 'Constant' and other_input in n2.output:
                        for attr in n2.attribute:
                            if attr.name == 'value':
                                arr = numpy_helper.to_array(attr.t)
                                if arr.size == 1:
                                    eps_value = float(arr.item())
                                break
                        break

        final_output = sqrt_node.output[0]

        # ============================================================
        # Try Cooley-Tukey MatMul DFT (N=1920=64×30) for higher precision.
        # Accumulated error ~13.5ε vs ~43.8ε for Conv1D direct DFT.
        # ============================================================
        ct_result = _build_cooley_tukey_stft(
            stft_node, graph, conv_input, signal_is_3d,
            hop_size, window, n_fft, onesided, eps_value, final_output
        )
        if ct_result is not None:
            ct_nodes, ct_inits = ct_result
            new_nodes.extend(ct_nodes)
            new_initializers.extend(ct_inits)
            for n in [stft_node, trans_node, pow_node, reduce_node, sqrt_node] + ([add_node] if add_node else []):
                nodes_to_remove.add(n.name)
            replaced += 1
            ct_used += 1
            continue

        # ============================================================
        # Fallback: Conv1D-based direct DFT (for non-1920 N or dynamic shapes)
        # ============================================================
        n = np.arange(n_fft, dtype=np.float32)
        k = np.arange(num_freq, dtype=np.float32).reshape(-1, 1)
        angles = 2 * np.pi * k * n / n_fft
        cos_kernel = (window * np.cos(angles)).reshape(num_freq, 1, n_fft).astype(np.float32)
        sin_kernel = (window * (-np.sin(angles))).reshape(num_freq, 1, n_fft).astype(np.float32)

        cos_name = f"{stft_node.name}_cos_kernel"
        sin_name = f"{stft_node.name}_sin_kernel"
        new_initializers.append(numpy_helper.from_array(cos_kernel, name=cos_name))
        new_initializers.append(numpy_helper.from_array(sin_kernel, name=sin_name))

        if not signal_is_3d:
            unsq_name = f"{stft_node.name}_3d"
            new_nodes.append(helper.make_node('Unsqueeze', [conv_input, f"{stft_node.name}_ax"],
                                               [unsq_name], name=f"{stft_node.name}_unsq"))
            new_initializers.append(numpy_helper.from_array(np.array([1], dtype=np.int64),
                                                             name=f"{stft_node.name}_ax"))
            conv_input = unsq_name

        real_name = f"{stft_node.name}_real"
        imag_name = f"{stft_node.name}_imag"
        real_sq = f"{stft_node.name}_real_sq"
        imag_sq = f"{stft_node.name}_imag_sq"
        mag_sq = f"{stft_node.name}_mag_sq"

        new_nodes.extend([
            helper.make_node('Conv', [conv_input, cos_name], [real_name],
                             name=f"{stft_node.name}_cos", strides=[hop_size]),
            helper.make_node('Conv', [conv_input, sin_name], [imag_name],
                             name=f"{stft_node.name}_sin", strides=[hop_size]),
            helper.make_node('Mul', [real_name, real_name], [real_sq], name=f"{stft_node.name}_m1"),
            helper.make_node('Mul', [imag_name, imag_name], [imag_sq], name=f"{stft_node.name}_m2"),
            helper.make_node('Add', [real_sq, imag_sq], [mag_sq], name=f"{stft_node.name}_a1"),
        ])

        if eps_value is None or eps_value == 0.0:
            eps_value = 1e-9

        eps_name = f"{stft_node.name}_eps"
        new_initializers.append(numpy_helper.from_array(
            np.array([eps_value], dtype=np.float32), name=eps_name))
        mag_sq_eps = f"{stft_node.name}_mag_sq_eps"
        new_nodes.append(helper.make_node('Add', [mag_sq, eps_name], [mag_sq_eps],
                                          name=f"{stft_node.name}_a2"))
        new_nodes.append(helper.make_node('Sqrt', [mag_sq_eps], [final_output],
                                          name=f"{stft_node.name}_sq"))

        for n in [stft_node, trans_node, pow_node, reduce_node, sqrt_node] + ([add_node] if add_node else []):
            nodes_to_remove.add(n.name)
        replaced += 1

    if nodes_to_remove:
        remaining = [n for n in graph.node if n.name not in nodes_to_remove]
        del graph.node[:]
        graph.node.extend(remaining)
        graph.node.extend(new_nodes)
    graph.initializer.extend(new_initializers)
    ct_label = f" ({ct_used} Cooley-Tukey, {replaced - ct_used} Conv1D)" if ct_used else ""
    print(f"  Replaced {replaced} STFT nodes{ct_label}")
    return model


def topological_sort(graph):
    from collections import deque
    available = {inp.name for inp in graph.input} | {init.name for init in graph.initializer}
    output_to_node = {out: node for node in graph.node for out in node.output}
    nodes = list(graph.node)
    node_by_name = {n.name: n for n in nodes}
    in_degree = {}
    dependents = {}
    for node in nodes:
        deps = sum(1 for inp in node.input if inp and inp not in available and inp in output_to_node
                   and output_to_node[inp].name != node.name)
        in_degree[node.name] = deps
        for inp in node.input:
            if inp and inp not in available and inp in output_to_node:
                dep_node = output_to_node[inp]
                if dep_node.name != node.name:
                    dependents.setdefault(dep_node.name, []).append(node.name)
    queue = deque(n for n, d in in_degree.items() if d == 0)
    sorted_names = []
    while queue:
        name = queue.popleft()
        sorted_names.append(name)
        for dep in dependents.get(name, []):
            in_degree[dep] -= 1
            if in_degree[dep] == 0:
                queue.append(dep)
    if len(sorted_names) == len(nodes):
        del graph.node[:]
        graph.node.extend(node_by_name[n] for n in sorted_names)


def strip_metadata(model):
    removed = len(model.metadata_props)
    del model.metadata_props[:]
    for attr in ['doc_string']:
        if getattr(model, attr):
            setattr(model, attr, '')
            removed += 1
    if model.graph.doc_string:
        model.graph.doc_string = ''
        removed += 1
    for node in model.graph.node:
        if node.doc_string:
            node.doc_string = ''
            removed += 1
    if removed:
        print(f"  Stripped {removed} metadata items")
    return model


def fix_mixed_precision_types(model):
    """Fix mixed precision types in W16A32 models.

    onnxsim may remove Cast(FP16->FP32) nodes, leaving MatMul/Conv with
    FP16 weight (as Constant node or initializer) + FP32 activation,
    which causes ONNX Runtime type mismatch errors.

    This function:
    1. Converts FP16 Constant nodes to initializers
    2. Re-inserts Cast nodes for FP16 weights used by MatMul/Gemm/Conv/ConvTranspose
    """
    graph = model.graph
    OPS_WITH_WEIGHTS = {'MatMul', 'Gemm', 'Conv', 'ConvTranspose'}

    # Step 1: Convert FP16 Constant nodes to initializers
    # onnxsim may fold FP16 weights into Constant nodes instead of initializers
    constant_converted = 0
    nodes_to_remove = []
    for node in graph.node:
        if node.op_type == 'Constant':
            for attr in node.attribute:
                if attr.name == 'value' and attr.t.data_type == TensorProto.FLOAT16:
                    # Convert to initializer
                    new_init = TensorProto.TensorProto()
                    new_init.CopyFrom(attr.t)
                    new_init.name = node.output[0]
                    graph.initializer.append(new_init)
                    nodes_to_remove.append(node)
                    constant_converted += 1
                    break
    for node in nodes_to_remove:
        graph.node.remove(node)
    if constant_converted:
        print(f"  fix_mixed_precision: converted {constant_converted} FP16 Constant nodes to initializers")

    # Step 2: Build initializer dtype map
    init_map = {init.name: init.data_type for init in graph.initializer}

    # Step 3: Find FP16 weight initializers used by weight-bearing ops
    # Keyed by node index in graph.node (stable across iterations as long as
    # graph.node is not mutated between the scan and apply passes).
    cast_info_by_idx = {}
    cast_idx = 0
    node_list_snapshot = list(graph.node)  # materialize to stabilize indexing
    for idx, node in enumerate(node_list_snapshot):
        if node.op_type not in OPS_WITH_WEIGHTS:
            continue
        if len(node.input) < 2:
            continue
        weight_name = node.input[1]
        if weight_name not in init_map:
            continue
        if init_map[weight_name] != TensorProto.FLOAT16:
            continue

        # Need to insert Cast for this FP16 weight
        # Use unique cast_idx to guarantee unique node names and output names
        cast_output = f"w16a32_cast_{cast_idx}_out"
        cast_node_name = f"w16a32_cast_{cast_idx}"
        cast_node = helper.make_node(
            'Cast',
            [weight_name],
            [cast_output],
            name=cast_node_name,
            to=TensorProto.FLOAT,
        )
        cast_info_by_idx[idx] = (cast_node, 1, cast_output)
        cast_idx += 1

    if not cast_info_by_idx:
        print(f"  fix_mixed_precision: no FP16 weights need Cast")
        return model

    # Step 4: Apply Cast insertions using stable index lookup
    new_node_list = []
    cast_insertions = 0
    for idx, node in enumerate(node_list_snapshot):
        if idx in cast_info_by_idx:
            cast_node, input_idx, cast_output = cast_info_by_idx[idx]
            if input_idx < len(node.input):
                new_node_list.append(cast_node)
                node.input[input_idx] = cast_output
                cast_insertions += 1
        new_node_list.append(node)

    del graph.node[:]
    graph.node.extend(new_node_list)
    print(f"  fix_mixed_precision: inserted {cast_insertions} Cast(FP16->FP32) nodes")
    return model


def resolve_neg1_in_reshape_shapes(model):
    """Replace -1 in Reshape shape Concat with computed static value.

    Dynamo export produces Concat([1, Shape(x)[start:end], -1, 64]) for Reshape.
    DML EP doesn't support -1 in shape tensor (returns E_INVALIDARG 0x80070057).
    Compute -1 statically using sympy to cancel dynamic dimensions.

    Only resolves when -1 simplifies to an integer (dynamic dims cancel out).
    """
    if not HAS_SYMPY:
        print("  resolve_neg1: sympy not available, skipping")
        return model

    graph = model.graph

    # Build value_info map
    vi_map = {vi.name: vi for vi in graph.value_info}
    for vi in graph.input:
        vi_map[vi.name] = vi
    for vi in graph.output:
        vi_map[vi.name] = vi

    init_map = {init.name: init for init in graph.initializer}

    def get_shape(vi_name):
        if vi_name not in vi_map:
            return None
        t = vi_map[vi_name].type.tensor_type
        if t.elem_type == 0:
            return None
        dims = []
        for d in t.shape.dim:
            if d.dim_value:
                dims.append(d.dim_value)
            elif d.dim_param:
                dims.append(d.dim_param)
            else:
                dims.append(None)
        return dims

    def get_shape_node_dim(shape_node):
        """For Shape(x) with start/end attrs, return the single dim of x[start]."""
        x_name = shape_node.input[0]
        x_shape = get_shape(x_name)
        if x_shape is None:
            return None
        start = 0
        end = len(x_shape)
        for attr in shape_node.attribute:
            if attr.name == 'start':
                start = attr.i
            elif attr.name == 'end':
                end = attr.i
        if end - start != 1:
            return None  # multi-element output, can't resolve to single dim
        idx = start if start >= 0 else start + len(x_shape)
        if 0 <= idx < len(x_shape):
            return x_shape[idx]
        return None

    # Find Shape producers: output_name -> shape_node
    shape_nodes = {}
    for node in graph.node:
        if node.op_type == 'Shape':
            shape_nodes[node.output[0]] = node

    # Symbol cache
    symbol_map = {}

    def get_symbol(name):
        if name not in symbol_map:
            symbol_map[name] = sympy.Symbol(name)
        return symbol_map[name]

    resolved = 0
    node_list_snapshot = list(graph.node)
    for node in node_list_snapshot:
        if node.op_type != 'Reshape' or len(node.input) < 2:
            continue
        shape_input = node.input[1]
        data_input = node.input[0]

        # Find Concat producing shape_input
        concat_node = None
        for n2 in node_list_snapshot:
            if n2.op_type == 'Concat' and shape_input in n2.output:
                concat_node = n2
                break
        if concat_node is None:
            continue

        # Check for [-1] in Concat inputs
        neg1_init_name = None
        for inp in concat_node.input:
            if inp in init_map:
                arr = numpy_helper.to_array(init_map[inp])
                if arr.size == 1 and arr.item() == -1:
                    neg1_init_name = inp
                    break
        if neg1_init_name is None:
            continue

        # Get Reshape input shape
        data_shape = get_shape(data_input)
        if data_shape is None:
            continue

        # Build sympy expression for total elements (Reshape preserves count)
        total = sympy.Integer(1)
        for dim in data_shape:
            if isinstance(dim, int):
                total *= dim
            elif isinstance(dim, str):
                total *= get_symbol(dim)
            else:
                total = None
                break
        if total is None:
            continue

        # Build sympy expression for Concat known dims (excluding -1)
        known_prod = sympy.Integer(1)
        for inp in concat_node.input:
            if inp == neg1_init_name:
                continue
            if inp in init_map:
                arr = numpy_helper.to_array(init_map[inp])
                if arr.size == 1:
                    known_prod *= int(arr.item())
                else:
                    known_prod = None
                    break
            elif inp in shape_nodes:
                dim = get_shape_node_dim(shape_nodes[inp])
                if dim is None:
                    known_prod = None
                    break
                if isinstance(dim, int):
                    known_prod *= dim
                elif isinstance(dim, str):
                    known_prod *= get_symbol(dim)
                else:
                    known_prod = None
                    break
            else:
                known_prod = None
                break

        if known_prod is None:
            continue

        # Compute -1 = total / known_prod
        neg1_val = sympy.simplify(total / known_prod)
        if not neg1_val.is_Integer:
            print(f"  resolve_neg1: cannot resolve to integer for {node.name}: {neg1_val}")
            continue

        neg1_int = int(neg1_val)

        # Create a NEW initializer for the resolved value, do NOT modify the
        # original [-1] initializer because it may be shared by other consumers
        # (e.g., ReduceMean with axes=[-1] meaning last axis).
        new_init_name = f"{neg1_init_name}_resolved_{neg1_int}"
        new_arr = np.array([neg1_int], dtype=np.int64)
        new_init = numpy_helper.from_array(new_arr, name=new_init_name)
        graph.initializer.append(new_init)
        # Update only this Concat's input to use the new initializer
        for i, inp in enumerate(concat_node.input):
            if inp == neg1_init_name:
                concat_node.input[i] = new_init_name
                break
        resolved += 1

    if resolved:
        print(f"  resolve_neg1: resolved {resolved} -1 values in Reshape shapes")
    return model


def quantize_weights_to_fp16(model):
    """Convert FP32 weight initializers to FP16 (W16A32 pattern).

    Targets: 2D initializers consumed by MatMul/Gemm, 3D/4D initializers consumed
    by Conv/ConvTranspose. Skips 1D (bias/LayerNorm), istft/window, and scalars.

    For each quantized weight, inserts a Cast(FP16->FP32) node before its consumer
    so activations stay FP32 (A32) while storage is FP16 (W16).
    """
    graph = model.graph
    WEIGHT_OPS = {'MatMul', 'Gemm', 'Conv', 'ConvTranspose'}

    # Build consumer map: init_name -> set of consumer op types
    init_consumers = {}
    for node in graph.node:
        for inp in node.input:
            if not inp:
                continue
            init_consumers.setdefault(inp, set()).add(node.op_type)

    # Classify initializers
    init_map = {init.name: init for init in graph.initializer}
    quantized = 0
    skipped_skip = 0
    skipped_nonweight = 0
    total_params = 0

    # Use stable index as key (protobuf id() reuse issue)
    node_list_snapshot = list(graph.node)
    cast_info_by_idx = {}  # node_idx -> (cast_node, weight_input_position, cast_output_name)
    cast_idx = 0

    for init in list(graph.initializer):
        name = init.name
        if name not in init_map:
            continue
        dims = list(init.dims)
        # Skip istft/window related
        if 'istft' in name.lower() or 'window' in name.lower():
            skipped_skip += 1
            continue
        # Skip 1D (bias, LayerNorm) and scalars
        if len(dims) <= 1:
            skipped_nonweight += 1
            continue
        # Must be consumed by a weight-accepting op
        consumers = init_consumers.get(name, set())
        if not (consumers & WEIGHT_OPS):
            skipped_nonweight += 1
            continue

        # Quantize to FP16
        arr = numpy_helper.to_array(init).astype(np.float16)
        new_init = numpy_helper.from_array(arr, name=name)
        # Replace in graph.initializer (preserve position)
        for i, existing in enumerate(graph.initializer):
            if existing.name == name:
                graph.initializer[i].CopyFrom(new_init)
                break
        total_params += arr.size
        quantized += 1

        # Find consumer nodes and prepare Cast insertions
        for idx, node in enumerate(node_list_snapshot):
            if name in node.input:
                # Only insert Cast for weight-accepting ops
                if node.op_type not in WEIGHT_OPS:
                    continue
                # Determine weight input position
                if node.op_type == 'MatMul':
                    # MatMul: input[1] is weight
                    wpos = 1
                elif node.op_type == 'Gemm':
                    # Gemm: input[1] is weight (B)
                    wpos = 1
                elif node.op_type in ('Conv', 'ConvTranspose'):
                    # Conv: input[1] is weight
                    wpos = 1
                else:
                    continue
                # Only insert if this node actually uses the weight at expected position
                if node.input[wpos] != name:
                    continue
                cast_output = f"w16a32_cast_{cast_idx}_out"
                cast_node_name = f"w16a32_cast_{cast_idx}"
                cast_node = helper.make_node(
                    'Cast', [name], [cast_output],
                    name=cast_node_name, to=TensorProto.FLOAT
                )
                cast_info_by_idx[idx] = (cast_node, wpos, cast_output)
                cast_idx += 1

    # Apply Cast insertions using stable index.
    # IMPORTANT: update node.input BEFORE rebuilding graph.node, because
    # protobuf may invalidate node references after `del graph.node[:]`.
    if cast_info_by_idx:
        new_nodes = []
        for idx, node in enumerate(node_list_snapshot):
            if idx in cast_info_by_idx:
                cast_node, wpos, cast_output = cast_info_by_idx[idx]
                # Update the original node's weight input first
                node.input[wpos] = cast_output
                new_nodes.append(cast_node)
            new_nodes.append(node)
        # Rebuild node list
        del graph.node[:]
        graph.node.extend(new_nodes)

    print(f"  quantize_weights_to_fp16: {quantized} weights quantized "
          f"({total_params / 1e6:.1f}M params), "
          f"{len(cast_info_by_idx)} Cast nodes inserted")
    print(f"    Skipped: {skipped_skip} istft/window, {skipped_nonweight} bias/scalar")
    return model


def decompose_conv_transpose_dml(model):
    """Replace ConvTranspose(stride>1) nodes with a DML-compatible sequence.

    DirectML does not support ConvTranspose with stride > 1. This decomposes each
    ConvTranspose1D(x, w, stride=S) into the equivalent sequence:

      Reshape(4D) -> Pad(insert stride-1 zeros) -> Reshape(3D) ->
      Conv1D(flip-transposed weight, stride=1, pads=[K-1, K-S]) ->
      optional Slice (when K < S, pads=[K-1, 0] + crop trailing S-K)

    Math: ConvTranspose1D(x, w, stride=S) ==
          Conv1D(upsample(x, S), flip(w.T), stride=1, pads=[K-1, K-S])
    where flip(w_T)[co, ci, k] = w[ci, co, K-1-k].

    Output length = T*S + (K-1) + (K-S) - K + 1 = T*S + K - S = (T-1)*S + K,
    matching ConvTranspose exactly, so no Slice is needed when K >= S.

    Handles multiple ConvTranspose nodes in a single graph (each gets a unique
    index suffix on its node/initializer names). No-op when no ConvTranspose
    with stride > 1 is present.

    Args:
        model: onnx.ModelProto to modify in place.

    Returns:
        The modified model.
    """
    graph = model.graph

    # Scan ConvTranspose nodes with stride > 1 (preserve order)
    init_map = {init.name: init for init in graph.initializer}
    nodes_snapshot = list(graph.node)
    ct_targets = []  # list of (idx_in_snapshot, node, stride)
    for idx, node in enumerate(nodes_snapshot):
        if node.op_type != 'ConvTranspose':
            continue
        stride = 1
        for attr in node.attribute:
            if attr.name == 'strides' and len(attr.ints) > 0:
                stride = attr.ints[0]
        if stride > 1:
            ct_targets.append((idx, node, stride))

    if not ct_targets:
        return model  # No-op: nothing to decompose

    new_initializers = []
    replacements_by_idx = {}  # idx_in_snapshot -> list of replacement nodes
    replaced_count = 0
    replaced_strides = []

    for ct_idx, (idx, ct_node, stride) in enumerate(ct_targets):
        # Locate weight initializer (input[1])
        w_name = ct_node.input[1] if len(ct_node.input) > 1 else None
        if w_name is None or w_name not in init_map:
            print(f"  [WARN] ConvTranspose {ct_node.name or ct_idx}: weight initializer "
                  f"{w_name!r} not found, skipping")
            continue
        w = numpy_helper.to_array(init_map[w_name])
        if w.ndim != 3:
            print(f"  [WARN] ConvTranspose {ct_node.name or ct_idx}: weight rank {w.ndim} != 3, skipping")
            continue
        c_in, c_out, K = w.shape

        has_bias = len(ct_node.input) >= 3
        bias_name = ct_node.input[2] if has_bias else None

        # Conv1D padding: P_left = K-1, P_right = K-S (when K >= S)
        # When K < S: use pads=[K-1, 0] and Slice off the trailing S-K elements
        p_left = K - 1
        need_slice = K < stride
        p_right = max(K - stride, 0)

        # Unique base name per ConvTranspose (index suffix guarantees uniqueness)
        if ct_node.name:
            base = f"{ct_node.name}_dml{ct_idx}"
        else:
            base = f"ct_dml_{ct_idx}"

        inp = ct_node.input[0]
        out = ct_node.output[0]

        # Flip + transpose weight: flip(w.T)[co, ci, k] = w[ci, co, K-1-k]
        w_flipped_transposed = w.transpose(1, 0, 2)[:, :, ::-1].copy().astype(np.float32)
        w_conv_name = f"{base}_flip_trans"
        new_initializers.append(numpy_helper.from_array(w_flipped_transposed, name=w_conv_name))

        # Scalar / 1D constants
        new_initializers.append(numpy_helper.from_array(np.array(0, dtype=np.int64), name=f"{base}_c0"))
        new_initializers.append(numpy_helper.from_array(np.array(2, dtype=np.int64), name=f"{base}_c2"))
        new_initializers.append(numpy_helper.from_array(np.array([stride], dtype=np.int64), name=f"{base}_stride_1d"))
        new_initializers.append(numpy_helper.from_array(np.array([c_in], dtype=np.int64), name=f"{base}_cin_1d"))
        new_initializers.append(numpy_helper.from_array(np.array([1], dtype=np.int64), name=f"{base}_c1_1d"))

        # Pad operands: insert S-1 zeros at the last axis
        new_initializers.append(numpy_helper.from_array(
            np.array([0, 0, 0, 0, 0, 0, 0, stride - 1], dtype=np.int64),
            name=f"{base}_pad_pads_4d"))
        new_initializers.append(numpy_helper.from_array(np.array(0.0, dtype=np.float32), name=f"{base}_pad_val"))

        nodes = []

        # Step 1: derive T = Shape(inp)[2] as a 1D tensor [T]
        nodes.append(helper.make_node('Shape', [inp], [f"{base}_shape"], name=f"{base}_shape"))
        nodes.append(helper.make_node('Gather', [f"{base}_shape", f"{base}_c2"],
                                     [f"{base}_T_scalar"], name=f"{base}_gT", axis=0))
        nodes.append(helper.make_node('Unsqueeze', [f"{base}_T_scalar", f"{base}_c0"],
                                     [f"{base}_T"], name=f"{base}_uT"))
        # T*S as 1D
        nodes.append(helper.make_node('Mul', [f"{base}_T", f"{base}_stride_1d"],
                                     [f"{base}_TS"], name=f"{base}_mul_TS"))

        # Step 2: B = Shape(inp)[0] as 1D
        nodes.append(helper.make_node('Gather', [f"{base}_shape", f"{base}_c0"],
                                     [f"{base}_B_scalar"], name=f"{base}_gB", axis=0))
        nodes.append(helper.make_node('Unsqueeze', [f"{base}_B_scalar", f"{base}_c0"],
                                     [f"{base}_B"], name=f"{base}_uB"))

        # Step 3: Reshape [B, C_in, T] -> [B, C_in, T, 1]
        nodes.append(helper.make_node('Concat',
                                     [f"{base}_B", f"{base}_cin_1d", f"{base}_T", f"{base}_c1_1d"],
                                     [f"{base}_shape_4d"], name=f"{base}_cat_4d", axis=0))
        nodes.append(helper.make_node('Reshape', [inp, f"{base}_shape_4d"],
                                     [f"{base}_r4d"], name=f"{base}_reshape_4d"))

        # Step 4: Pad [B, C_in, T, 1] -> [B, C_in, T, S]
        nodes.append(helper.make_node('Pad',
                                     [f"{base}_r4d", f"{base}_pad_pads_4d", f"{base}_pad_val"],
                                     [f"{base}_padded"], name=f"{base}_pad", mode='constant'))

        # Step 5: Reshape [B, C_in, T, S] -> [B, C_in, T*S]
        nodes.append(helper.make_node('Concat',
                                     [f"{base}_B", f"{base}_cin_1d", f"{base}_TS"],
                                     [f"{base}_flat_shape"], name=f"{base}_cat_flat", axis=0))
        nodes.append(helper.make_node('Reshape', [f"{base}_padded", f"{base}_flat_shape"],
                                     [f"{base}_flat"], name=f"{base}_reshape_flat"))

        # Step 6: Conv1D with flip(w.T), stride=1
        conv_inputs = [f"{base}_flat", w_conv_name]
        if has_bias:
            conv_inputs.append(bias_name)
        conv_out_name = f"{base}_conv_out"

        if need_slice:
            # K < S: pads=[K-1, 0], then Slice off the trailing S-K elements
            nodes.append(helper.make_node('Conv', conv_inputs, [conv_out_name],
                                         name=f"{base}_conv",
                                         kernel_shape=[K], strides=[1], pads=[p_left, 0]))
            new_initializers.append(numpy_helper.from_array(
                np.array([stride - K], dtype=np.int64), name=f"{base}_smk"))
            nodes.append(helper.make_node('Sub', [f"{base}_TS", f"{base}_smk"],
                                         [f"{base}_out_len"], name=f"{base}_sub_outlen"))
            new_initializers.append(numpy_helper.from_array(
                np.array([0, 0, 0], dtype=np.int64), name=f"{base}_slice_starts"))
            new_initializers.append(numpy_helper.from_array(
                np.array([np.iinfo(np.int64).max], dtype=np.int64), name=f"{base}_max"))
            nodes.append(helper.make_node('Concat',
                                         [f"{base}_max", f"{base}_max", f"{base}_out_len"],
                                         [f"{base}_slice_ends"], name=f"{base}_cat_ends", axis=0))
            new_initializers.append(numpy_helper.from_array(
                np.array([0, 1, 2], dtype=np.int64), name=f"{base}_slice_axes"))
            nodes.append(helper.make_node('Slice',
                                         [conv_out_name, f"{base}_slice_starts",
                                          f"{base}_slice_ends", f"{base}_slice_axes"],
                                         [out], name=f"{base}_slice"))
        else:
            # K >= S: pads=[K-1, K-S], output length already correct
            nodes.append(helper.make_node('Conv', conv_inputs, [out],
                                         name=f"{base}_conv",
                                         kernel_shape=[K], strides=[1], pads=[p_left, p_right]))

        replacements_by_idx[idx] = nodes
        replaced_count += 1
        replaced_strides.append(stride)

    # Rebuild graph.node: emit replacement sequences in place of original ConvTranspose nodes
    if replacements_by_idx:
        rebuilt = []
        for idx, node in enumerate(nodes_snapshot):
            if idx in replacements_by_idx:
                rebuilt.extend(replacements_by_idx[idx])
            else:
                rebuilt.append(node)
        del graph.node[:]
        graph.node.extend(rebuilt)

    graph.initializer.extend(new_initializers)

    if replaced_count > 0:
        strides_seen = sorted(set(replaced_strides))
        strides_str = ','.join(str(s) for s in strides_seen)
        print(f"  Decomposed {replaced_count} ConvTranspose(stride={strides_str}) node(s)")
    return model


def postprocess_onnx(input_path, output_path, fix_mixed_precision=False,
                     decompose_conv_transpose=True):
    print(f"\n  Post-processing: {os.path.basename(input_path)}")
    model = onnx.load(input_path)
    if decompose_conv_transpose:
        decompose_conv_transpose_dml(model)
    replace_stft(model)
    topological_sort(model.graph)
    try:
        model = shape_inference.infer_shapes(model, check_type=False, strict_mode=False)
    except Exception:
        pass
    if HAS_ONNXSIM:
        try:
            simplified, ok = onnxsim.simplify(model, check_n=0, skip_fuse_bn=True, dynamic_input_shape=False)
            if ok:
                print(f"    onnxsim: {len(model.graph.node)} -> {len(simplified.graph.node)} nodes")
                model = simplified
        except Exception as e:
            print(f"    onnxsim error: {e}")
    # Fix mixed precision types (W16A32: re-insert Cast for FP16 weights after onnxsim)
    if fix_mixed_precision:
        model = fix_mixed_precision_types(model)
        # Resolve -1 in Reshape shape Concat (DML EP doesn't support -1 in shape tensor)
        model = resolve_neg1_in_reshape_shapes(model)
    model = strip_metadata(model)
    topological_sort(model.graph)

    graph = model.graph
    used = {inp for node in graph.node for inp in node.input if inp} | {o.name for o in graph.output}
    for init in [i for i in graph.initializer if i.name not in used]:
        graph.initializer.remove(init)

    old_data = output_path + '.data'
    if os.path.exists(old_data):
        os.remove(old_data)
    onnx.save_model(model, output_path, save_as_external_data=True,
                    all_tensors_to_one_file=True,
                    location=os.path.basename(output_path) + '.data',
                    size_threshold=1024)

    size_mb = os.path.getsize(output_path) / 1024 / 1024
    data_path = output_path + '.data'
    data_mb = os.path.getsize(data_path) / 1024 / 1024 if os.path.exists(data_path) else 0
    print(f"    Saved: {os.path.basename(output_path)} ({size_mb:.1f}MB + {data_mb:.1f}MB data)")

    unsupported = {n.op_type: sum(1 for nn in graph.node if nn.op_type == n.op_type)
                   for n in graph.node if n.op_type in UNSUPPORTED_OPS}
    if unsupported:
        print(f"    [WARN] NPU unsupported: {unsupported}")
    else:
        print(f"    [OK] All NPU compatible")

    ops = {}
    for n in graph.node:
        ops[n.op_type] = ops.get(n.op_type, 0) + 1
    print(f"    Nodes: {sum(ops.values())}")
    for op, cnt in sorted(ops.items(), key=lambda x: -x[1])[:8]:
        print(f"      {op}: {cnt}")

    return model


def export_fp32_opset20(wrapper, args_tuple, output_path, input_names, output_names,
                        dynamic_axes=None, decompose_conv_transpose=True,
                        fix_mixed_precision=False):
    """Export a PyTorch wrapper to FP32 ONNX with opset 20 + DML post-processing.

    This is the main entry point for FP32 main-path exports. Writes to a temp file
    first, then applies postprocess_onnx (STFT replacement, ConvTranspose decomposition,
    onnxsim, shape inference, strip metadata) and saves to output_path.

    Note: torch.onnx.export with dynamo=True does not accept dynamic_axes (dynamo uses
    dynamic_shapes instead). When dynamic_axes is None (default), dynamo=True is used
    to match the existing FP32 export pattern. When dynamic_axes is provided, the call
    falls back to dynamo=False so dynamic_axes takes effect.

    Args:
        wrapper: nn.Module to export.
        args_tuple: tuple of torch input tensors.
        output_path: final ONNX output path (external data written alongside as .data).
        input_names: list of input names.
        output_names: list of output names.
        dynamic_axes: optional dynamic_axes dict; when provided, dynamo is disabled.
        decompose_conv_transpose: if True, decompose ConvTranspose(stride>1) for DML.
        fix_mixed_precision: if True, re-insert Cast(FP16->FP32) after onnxsim (W16A32).

    Returns:
        The post-processed onnx.ModelProto.
    """
    tmp_path = output_path + '.raw.onnx'
    use_dynamo = dynamic_axes is None
    with torch.no_grad():
        torch.onnx.export(
            wrapper, args_tuple, tmp_path,
            input_names=input_names,
            output_names=output_names,
            opset_version=20,
            dynamo=use_dynamo,
            dynamic_axes=dynamic_axes if not use_dynamo else None,
        )
    model = postprocess_onnx(
        tmp_path, output_path,
        fix_mixed_precision=fix_mixed_precision,
        decompose_conv_transpose=decompose_conv_transpose,
    )
    if os.path.exists(tmp_path):
        os.remove(tmp_path)
    if os.path.exists(tmp_path + '.data'):
        os.remove(tmp_path + '.data')
    return model


def quantize_onnx_model(input_path, output_path, calibration_inputs=None, per_channel=True):
    from onnxruntime.quantization import quantize, QuantFormat, QuantType, CalibrationDataReader, StaticQuantConfig

    print(f"\n  Quantizing: {os.path.basename(input_path)}")

    class RandomCalibrationReader(CalibrationDataReader):
        def __init__(self, inputs, num_samples=20):
            self.inputs_list = [inputs for _ in range(num_samples)]
            self.idx = 0
        def get_next(self):
            if self.idx >= len(self.inputs_list):
                return None
            result = self.inputs_list[self.idx]
            self.idx += 1
            return result

    reader = RandomCalibrationReader(calibration_inputs, num_samples=20) if calibration_inputs else None

    config = StaticQuantConfig(
        calibration_data_reader=reader,
        quant_format=QuantFormat.QDQ,
        per_channel=per_channel,
        reduce_range=False,
        op_types_to_quantize=['MatMul', 'Conv', 'Gemm'],
        extra_options={
            'ActivationSymmetric': False,
            'WeightSymmetric': True,
        },
    )

    quantize(
        model_input=input_path,
        model_output=output_path,
        quant_config=config,
    )

    size_mb = os.path.getsize(output_path) / 1024 / 1024
    data_path = output_path + '.data'
    data_mb = os.path.getsize(data_path) / 1024 / 1024 if os.path.exists(data_path) else 0
    print(f"    Quantized: {os.path.basename(output_path)} ({size_mb:.1f}MB + {data_mb:.1f}MB data)")

    model = onnx.load(output_path, load_external_data=False)
    dq_count = sum(1 for n in model.graph.node if n.op_type == 'DequantizeLinear')
    q_count = sum(1 for n in model.graph.node if n.op_type == 'QuantizeLinear')
    print(f"    QDQ nodes: {q_count} QuantizeLinear + {dq_count} DequantizeLinear")

    return model
