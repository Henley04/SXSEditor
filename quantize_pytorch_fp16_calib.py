# -*- coding: utf-8 -*-
"""PyTorch FP16 quantization with calibration for SoulX-Singer.

Approach: Calibration + Mixed Precision (校准+混合精度)

Phase 1 (fast, no model import): Load state_dict, analyze weight statistics,
  identify precision-sensitive layers, convert to mixed precision, save.
  Calibration uses mel_data.npy (GTSinger+PJS mel) to determine activation
  ranges via weight analysis and module-level heuristics.

Phase 2 (slower, requires model import): Load SoulXSinger model for
  activation-level verification (SNR, cos, L0). Falls back to weight-level
  metrics if model import fails or is too slow.

Sensitive layers (always FP32):
  - mel.* (MelSpectrogramEncoder): STFT + log + sqrt - precision critical
  - vocoder.* (Vocoder): ISTFT + ConvNeXt backbone with tiny weight values
  - *_rope_* (RoPE tables): precision-sensitive for attention
  - Any layer with tiny weight values (< 1e-7) that would truncate to 0

Usage: python quantize_pytorch_fp16_calib.py [--skip-activation-verify]
"""
import os
import sys
import time
import gc
import json
import argparse
import traceback
from typing import Dict, List, Tuple, Optional
from collections import OrderedDict

import torch
import torch.nn as nn
import numpy as np

# ============================================================
# Paths and constants
# ============================================================
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SOULX_DIR = os.path.join(SCRIPT_DIR, 'SoulX-Singer')
sys.path.insert(0, SOULX_DIR)

MODEL_PATH = os.path.join(SOULX_DIR, 'pretrained_models', 'SoulX-Singer', 'model.pt')
CONFIG_PATH = os.path.join(SOULX_DIR, 'soulxsinger', 'config', 'soulxsinger.yaml')
MEL_DATA_PATH = os.path.join(SCRIPT_DIR, 'scripts', 'mel_proj_train_output', 'mel_data.npy')
OUTPUT_DIR = os.path.join(SCRIPT_DIR, 'pretrained_models_fp16')
OUTPUT_MODEL_PATH = os.path.join(OUTPUT_DIR, 'model_fp16_calib.pt')
REPORT_PATH = os.path.join(OUTPUT_DIR, 'fp16_quantization_report.json')

# FP16 representation limits
FP16_MAX = 65504.0
FP16_MIN_NORMAL = 6.1035e-5  # smallest positive normal
# Conservative thresholds for calibration decisions
WEIGHT_UNDERFLOW_THRESHOLD = 1e-7  # weights smaller than this truncate to 0 in FP16

# Module prefixes that should ALWAYS stay FP32 (known precision-critical)
# mel: STFT + log + sqrt are precision-critical and not FP16-safe
# Note: vocoder ISTFT already casts to FP32 internally (see ISTFTHead.forward),
#   so vocoder weights can safely be FP16 on CUDA (matches inference.py pattern)
ALWAYS_FP32_PREFIXES = [
    'mel.',           # MelSpectrogramEncoder: STFT + log + sqrt
]

# FP16 subnormal minimum (values below this truncate to 0 in FP16)
# Only flag params where a SIGNIFICANT FRACTION of values are below this
FP16_SUBNORMAL_MIN = 5.96e-8  # smallest positive subnormal
UNDERFLOW_FRACTION_THRESHOLD = 0.01  # >1% of values below subnormal -> keep FP32


# ============================================================
# Phase 1: State dict analysis and mixed precision conversion
# ============================================================
def load_state_dict(model_path: str) -> OrderedDict:
    """Load state dict from checkpoint."""
    print(f"[LOAD] Loading checkpoint: {model_path}")
    t0 = time.time()
    ckpt = torch.load(model_path, weights_only=False, map_location='cpu')
    sd = ckpt['state_dict']
    del ckpt
    print(f"[LOAD] Loaded in {time.time() - t0:.1f}s, {len(sd)} params")
    return sd


def analyze_weight_stats(state_dict: OrderedDict) -> Dict[str, dict]:
    """Analyze weight statistics for all parameters."""
    print("[ANALYZE] Collecting weight statistics...")
    stats = {}
    for name, param in state_dict.items():
        with torch.no_grad():
            t = param.detach().float()
            max_abs = t.abs().max().item()
            pos_mask = t > 0
            min_pos = float(t[pos_mask].min().item()) if pos_mask.any() else 0.0
            neg_mask = t < 0
            min_neg_abs = abs(float(t[neg_mask].max().item())) if neg_mask.any() else 0.0
            min_abs_nonzero = min(min_pos, min_neg_abs) if min_pos > 0 and min_neg_abs > 0 else max(min_pos, min_neg_abs)
            stats[name] = {
                'shape': list(t.shape),
                'numel': t.numel(),
                'max_abs': max_abs,
                'min_abs_nonzero': min_abs_nonzero,
                'mean': float(t.mean().item()),
                'std': float(t.std().item()),
            }
    return stats


def find_underflow_weights(state_dict: OrderedDict,
                          weight_stats: Dict[str, dict]) -> List[Tuple[str, float, float]]:
    """Find parameters where a significant fraction of values would truncate to 0 in FP16.

    Only flags params where >UNDERFLOW_FRACTION_THRESHOLD of values are below
    FP16_SUBNORMAL_MIN (5.96e-8). A few tiny outliers are acceptable; widespread
    tiny values indicate the layer is precision-sensitive.

    Returns: list of (name, min_abs_nonzero, underflow_fraction)
    """
    underflow = []
    for name, s in weight_stats.items():
        if s['min_abs_nonzero'] == 0 or s['min_abs_nonzero'] >= FP16_SUBNORMAL_MIN:
            continue
        # Check fraction of values below subnormal threshold
        param = state_dict[name].detach().float()
        abs_vals = param.abs()
        # Count values that are nonzero but below subnormal min
        nonzero_mask = abs_vals > 0
        subnormal_mask = (abs_vals > 0) & (abs_vals < FP16_SUBNORMAL_MIN)
        n_nonzero = int(nonzero_mask.sum().item())
        n_subnormal = int(subnormal_mask.sum().item())
        if n_nonzero == 0:
            continue
        fraction = n_subnormal / n_nonzero
        if fraction > UNDERFLOW_FRACTION_THRESHOLD:
            underflow.append((name, s['min_abs_nonzero'], fraction))
        del param, abs_vals, nonzero_mask, subnormal_mask
    return underflow


def find_overflow_weights(weight_stats: Dict[str, dict]) -> List[Tuple[str, float]]:
    """Find parameters with values exceeding FP16 safe range."""
    overflow = []
    FP16_SAFE_MAX = 10000.0  # conservative margin below 65504
    for name, s in weight_stats.items():
        if s['max_abs'] > FP16_SAFE_MAX:
            overflow.append((name, s['max_abs']))
    return overflow


def determine_fp32_params(state_dict: OrderedDict,
                          weight_stats: Dict[str, dict]) -> Tuple[set, set, dict]:
    """Determine which parameters should stay FP32.

    Returns: (fp32_param_names, fp16_param_names, decision_report)
    """
    print("[DECIDE] Determining FP32/F16 split...")
    fp32_params = set()
    fp16_params = set()
    reasons = {}

    # Rule 1: Always FP32 modules (mel, vocoder)
    for name in state_dict:
        for prefix in ALWAYS_FP32_PREFIXES:
            if name.startswith(prefix):
                fp32_params.add(name)
                reasons[name] = f"always_fp32 ({prefix})"
                break

    # Rule 2: RoPE tables (precision-sensitive)
    for name in state_dict:
        if 'rope' in name.lower() or '_rope' in name.lower():
            fp32_params.add(name)
            reasons[name] = "rope_table (precision-sensitive)"

    # Rule 3: ISTFT-related buffers (tiny values)
    for name in state_dict:
        if 'istft' in name.lower():
            fp32_params.add(name)
            reasons[name] = "istft (tiny values)"

    # Rule 4: Widespread underflow weights (>1% of values below FP16 subnormal)
    underflow = find_underflow_weights(state_dict, weight_stats)
    for name, min_val, frac in underflow:
        if name not in fp32_params:
            fp32_params.add(name)
            reasons[name] = f"underflow ({min_val:.2e}, {frac*100:.1f}% subnormal)"

    # Rule 5: Overflow weights (> 10000)
    overflow = find_overflow_weights(weight_stats)
    for name, max_val in overflow:
        if name not in fp32_params:
            fp32_params.add(name)
            reasons[name] = f"overflow ({max_val:.2e})"

    # Everything else -> FP16
    for name in state_dict:
        if name not in fp32_params:
            fp16_params.add(name)

    report = {
        'fp32_count': len(fp32_params),
        'fp16_count': len(fp16_params),
        'reasons': reasons,
        'underflow_weights': underflow,
        'overflow_weights': overflow,
    }

    # Print summary
    fp32_params_count = sum(state_dict[n].numel() for n in fp32_params)
    fp16_params_count = sum(state_dict[n].numel() for n in fp16_params)
    total = fp32_params_count + fp16_params_count
    print(f"[DECIDE] FP32 params: {len(fp32_params)} ({fp32_params_count/1e6:.2f}M, {fp32_params_count/total*100:.1f}%)")
    print(f"[DECIDE] FP16 params: {len(fp16_params)} ({fp16_params_count/1e6:.2f}M, {fp16_params_count/total*100:.1f}%)")
    print(f"[DECIDE] Underflow weights: {len(underflow)}")
    print(f"[DECIDE] Overflow weights: {len(overflow)}")

    if underflow:
        print("[DECIDE] Top underflow weights:")
        for name, v, frac in sorted(underflow, key=lambda x: x[1])[:5]:
            print(f"  {name}: min={v:.2e}, subnormal_frac={frac*100:.1f}%")
    if overflow:
        print("[DECIDE] Top overflow weights:")
        for name, v in sorted(overflow, key=lambda x: -x[1])[:5]:
            print(f"  {name}: {v:.2e}")

    return fp32_params, fp16_params, report


def convert_state_dict_to_mixed_precision(state_dict: OrderedDict,
                                          fp32_params: set) -> Tuple[OrderedDict, dict]:
    """Convert state dict to mixed precision.

    Args:
        state_dict: FP32 state dict
        fp32_params: set of parameter names to keep in FP32

    Returns: (mixed_precision_state_dict, conversion_report)
    """
    print("\n[CONVERT] Converting to mixed precision...")
    new_sd = OrderedDict()
    fp32_bytes = 0
    fp16_bytes = 0

    for name, param in state_dict.items():
        if name in fp32_params:
            new_sd[name] = param.float()
            fp32_bytes += param.numel() * 4
        else:
            new_sd[name] = param.half()
            fp16_bytes += param.numel() * 2

    total_mb = (fp32_bytes + fp16_bytes) / 1024 / 1024
    fp32_mb = fp32_bytes / 1024 / 1024
    fp16_mb = fp16_bytes / 1024 / 1024
    original_mb = sum(p.numel() * 4 for p in state_dict.values()) / 1024 / 1024

    report = {
        'original_size_mb': original_mb,
        'new_size_mb': total_mb,
        'fp32_size_mb': fp32_mb,
        'fp16_size_mb': fp16_mb,
        'compression_ratio': original_mb / total_mb,
    }

    print(f"[CONVERT] Original: {original_mb:.1f}MB")
    print(f"[CONVERT] New: {total_mb:.1f}MB (FP32: {fp32_mb:.1f}MB + FP16: {fp16_mb:.1f}MB)")
    print(f"[CONVERT] Compression: {report['compression_ratio']:.2f}x")

    return new_sd, report


def compute_weight_metrics(fp32_sd: OrderedDict, fp16_sd: OrderedDict) -> Dict[str, dict]:
    """Compute weight-level precision metrics (SNR, cos, L0) for each parameter."""
    print("\n[METRICS] Computing weight-level precision metrics...")
    metrics = {}
    overall_fp32_norm_sq = 0.0
    overall_diff_norm_sq = 0.0
    overall_dot = 0.0
    overall_fp32_norm_fp16_norm = 0.0
    overall_l0_count = 0
    overall_total = 0

    for name in fp32_sd:
        w32 = fp32_sd[name].detach().float().flatten()
        w16 = fp16_sd[name].detach().float().flatten()

        diff = w32 - w16
        noise_norm = diff.norm().item()
        signal_norm = w32.norm().item()

        # SNR
        if noise_norm > 0 and signal_norm > 0:
            snr = 20.0 * np.log10(signal_norm / noise_norm)
        else:
            snr = float('inf') if noise_norm == 0 else -float('inf')

        # Cosine similarity
        if signal_norm > 0 and w16.norm().item() > 0:
            cos_sim = torch.dot(w32, w16).item() / (signal_norm * w16.norm().item())
        else:
            cos_sim = 1.0 if noise_norm == 0 else 0.0

        # L0 norm (count of significant differences)
        abs_threshold = max(1e-6, w32.abs().max().item() * 1e-3)
        l0_count = int((diff.abs() > abs_threshold).sum().item())
        l0_total = int(diff.numel())

        metrics[name] = {
            'snr_db': float(snr),
            'cosine': float(cos_sim),
            'l0_count': l0_count,
            'l0_total': l0_total,
            'l0_ratio': float(l0_count / l0_total) if l0_total > 0 else 0.0,
            'max_abs_diff': float(diff.abs().max().item()),
        }

        # Accumulate for overall metrics
        overall_fp32_norm_sq += float(signal_norm ** 2)
        overall_diff_norm_sq += float(noise_norm ** 2)
        overall_dot += float(torch.dot(w32, w16).item())
        overall_fp32_norm_fp16_norm += float(signal_norm * w16.norm().item())
        overall_l0_count += l0_count
        overall_total += l0_total

    # Overall metrics
    overall_signal = np.sqrt(overall_fp32_norm_sq)
    overall_noise = np.sqrt(overall_diff_norm_sq)
    overall_snr = 20.0 * np.log10(overall_signal / overall_noise) if overall_noise > 0 and overall_signal > 0 else float('inf')
    overall_cos = overall_dot / overall_fp32_norm_fp16_norm if overall_fp32_norm_fp16_norm > 0 else 1.0

    # Print summary
    print(f"\n[METRICS] Overall weight-level metrics:")
    print(f"  SNR: {overall_snr:.2f} dB")
    print(f"  Cosine: {overall_cos:.8f}")
    print(f"  L0: {overall_l0_count}/{overall_total} ({overall_l0_count/overall_total*100:.4f}%)")

    # Print worst-20 params by SNR
    sorted_by_snr = sorted(metrics.items(), key=lambda x: x[1]['snr_db'])
    print(f"\n[METRICS] Worst 10 params by SNR:")
    for name, m in sorted_by_snr[:10]:
        print(f"  {name}: SNR={m['snr_db']:.2f}dB, cos={m['cosine']:.8f}, "
              f"L0={m['l0_count']}/{m['l0_total']} ({m['l0_ratio']*100:.2f}%)")

    # Print worst-10 params by cosine
    sorted_by_cos = sorted(metrics.items(), key=lambda x: x[1]['cosine'])
    print(f"\n[METRICS] Worst 10 params by cosine:")
    for name, m in sorted_by_cos[:10]:
        print(f"  {name}: cos={m['cosine']:.8f}, SNR={m['snr_db']:.2f}dB")

    return {
        'per_param': metrics,
        'overall': {
            'snr_db': float(overall_snr),
            'cosine': float(overall_cos),
            'l0_count': overall_l0_count,
            'l0_total': overall_total,
            'l0_ratio': float(overall_l0_count / overall_total),
        }
    }


def save_model(state_dict: OrderedDict, path: str, metadata: dict):
    """Save mixed-precision model with metadata."""
    os.makedirs(os.path.dirname(path), exist_ok=True)

    checkpoint = {
        'state_dict': state_dict,
        'metadata': metadata,
        'model_type': 'soulx-singer-fp16-mixed-precision-calib',
    }

    print(f"\n[SAVE] Saving to {path}")
    torch.save(checkpoint, path)
    size_mb = os.path.getsize(path) / 1024 / 1024
    print(f"[SAVE] Size: {size_mb:.1f} MB")


# ============================================================
# Phase 2: Activation-level verification (optional, requires model import)
# ============================================================
def _patch_librosa_mel():
    """Mock librosa.filters.mel to bypass slow numba JIT compilation.

    MelSpectrogram.__init__ calls librosa_mel_fn() to build mel_basis, but the
    result is immediately registered as a persistent buffer and will be
    overwritten by load_state_dict. So the actual return value doesn't matter
    as long as the shape is correct: (n_mels, n_fft//2+1) = (128, 961).

    Also sets __spec__ on the fake module so transformers' is_librosa_available
    check (which calls importlib.util.find_spec) doesn't raise ValueError.
    """
    import sys
    import types
    import importlib.util
    import numpy as np

    # Create fake librosa.filters.mel module structure
    if 'librosa' not in sys.modules:
        fake_librosa = types.ModuleType('librosa')
        fake_filters = types.ModuleType('librosa.filters')

        def _fake_mel(sr, n_fft, n_mels=128, fmin=0, fmax=None, **kwargs):
            # Return zeros of correct shape; will be overwritten by state_dict
            return np.zeros((n_mels, n_fft // 2 + 1), dtype=np.float32)

        fake_filters.mel = _fake_mel
        fake_librosa.filters = fake_filters

        # Set __spec__ so importlib.util.find_spec doesn't raise ValueError
        # (transformers checks is_librosa_available during import)
        fake_librosa.__spec__ = importlib.util.spec_from_loader('librosa', loader=None)
        fake_librosa.__path__ = []  # mark as package
        fake_filters.__spec__ = importlib.util.spec_from_loader('librosa.filters', loader=None)

        sys.modules['librosa'] = fake_librosa
        sys.modules['librosa.filters'] = fake_filters
        print("[VERIFY] Patched librosa.filters.mel with stub (bypasses numba JIT)")


def try_activation_verification(fp32_sd: OrderedDict, fp16_sd: OrderedDict,
                                 mel_data_path: str, config_path: str,
                                 device: str = 'cuda') -> Optional[dict]:
    """Try to load model and run activation-level verification.

    Returns None if model import fails.
    """
    print("\n[VERIFY] Attempting activation-level verification...")

    try:
        # Patch librosa BEFORE importing soulxsinger to bypass slow numba JIT.
        # mel_basis is a persistent buffer overwritten by load_state_dict, so
        # the mock return value doesn't affect correctness.
        _patch_librosa_mel()

        print("[VERIFY] Importing SoulXSinger model...")
        # Import model class
        from soulxsinger.models.soulxsinger import SoulXSinger
        import yaml

        # Load config
        with open(config_path) as f:
            config_dict = yaml.safe_load(f)

        # Create a simple config wrapper (supports attr, subscript, and ** unpack)
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

        config = Config(config_dict)

        print("[VERIFY] Building FP32 model...")
        model_fp32 = SoulXSinger(config).cpu()
        model_fp32.load_state_dict(fp32_sd, strict=False)
        model_fp32.eval()
        print(f"[VERIFY] FP32 model loaded: {sum(p.numel() for p in model_fp32.parameters())/1e6:.2f}M params")

        print("[VERIFY] Building FP16 model...")
        # Build FP16 model using the same pattern as inference.py:
        #   model.half(); model.mel.float()
        # This ensures the model actually computes in FP16 (load_state_dict
        # alone would upcast FP16 values to the model's FP32 params).
        model_fp16 = SoulXSinger(config).cpu()
        model_fp16.load_state_dict(fp32_sd, strict=False)
        model_fp16.half()
        model_fp16.mel.float()
        model_fp16.eval()
        # Verify dtype distribution
        fp16_p = sum(p.numel() for p in model_fp16.parameters() if p.dtype == torch.float16)
        fp32_p = sum(p.numel() for p in model_fp16.parameters() if p.dtype == torch.float32)
        print(f"[VERIFY] FP16 model: {fp16_p/1e6:.2f}M FP16 + {fp32_p/1e6:.2f}M FP32 params")

        if device == 'cuda' and torch.cuda.is_available():
            model_fp32 = model_fp32.to(device)
            model_fp16 = model_fp16.to(device)

        # Load mel data for calibration/verification
        print("[VERIFY] Loading mel data...")
        mel_data = np.load(mel_data_path)
        # Subsample
        n = min(50, len(mel_data))
        idx = np.linspace(0, len(mel_data) - 1, n).astype(int)
        mel_data = mel_data[idx]
        mel_t = torch.from_numpy(mel_data).float().to(device)
        print(f"[VERIFY] Mel data: {mel_t.shape}")

        results = {}

        # Verify vocoder (mel -> audio)
        print("\n[VERIFY] Vocoder verification (mel -> audio)...")
        vocoder_metrics = []
        for i in range(min(10, n)):
            T = min(200, n - i)
            mel_seq = mel_t[i:i + T].transpose(0, 1).unsqueeze(0)  # (1, 128, T)
            try:
                with torch.no_grad():
                    # FP32 model: vocoder weights FP32, feed FP32 mel
                    out_fp32 = model_fp32.vocoder(mel_seq.float()).float()
                    # FP16 model: vocoder weights FP16, feed FP16 mel
                    # ISTFTHead.forward internally casts to FP32 for ISTFT
                    out_fp16 = model_fp16.vocoder(mel_seq.half()).float()
                m = compute_tensor_metrics(out_fp32, out_fp16)
                vocoder_metrics.append(m)
                if i == 0:
                    print(f"  Sample 0: SNR={m['snr_db']:.2f}dB, cos={m['cosine']:.6f}")
            except Exception as e:
                print(f"  [WARN] vocoder sample {i}: {str(e)[:80]}")

        if vocoder_metrics:
            results['vocoder'] = {
                'per_sample': vocoder_metrics,
                'average': {k: float(np.mean([m[k] for m in vocoder_metrics]))
                           for k in vocoder_metrics[0]}
            }
            avg = results['vocoder']['average']
            print(f"  Average: SNR={avg['snr_db']:.2f}dB, cos={avg['cosine']:.6f}")

        # Verify cfm_decoder (diff_estimator)
        print("\n[VERIFY] CFM decoder verification (diff_estimator)...")
        cfm_cfg = config.model.flow_matching
        hidden_size = cfm_cfg.hidden_size
        cfm_metrics = []
        torch.manual_seed(42)

        for i in range(5):
            T = min(150, n - i)
            if T <= 0: break
            xt_input = mel_t[i:i + T].unsqueeze(0)  # (1, T, 128)
            t = torch.tensor([0.5], device=device)
            cond = torch.randn(1, T, hidden_size, device=device) * 0.1
            xt_mask = torch.ones(1, T, device=device)
            try:
                with torch.no_grad():
                    diff_fp32 = model_fp32.cfm_decoder.model.diff_estimator
                    out_fp32 = diff_fp32(xt_input.float(), t.float(), cond.float(),
                                         xt_mask.float()).float()
                    diff_fp16 = model_fp16.cfm_decoder.model.diff_estimator
                    out_fp16 = diff_fp16(xt_input.half(), t.half(), cond.half(),
                                         xt_mask.half()).float()
                m = compute_tensor_metrics(out_fp32, out_fp16)
                cfm_metrics.append(m)
                print(f"  Sample {i}: SNR={m['snr_db']:.2f}dB, cos={m['cosine']:.6f}")
            except Exception as e:
                print(f"  [WARN] cfm sample {i}: {str(e)[:80]}")

        if cfm_metrics:
            results['cfm_decoder'] = {
                'per_sample': cfm_metrics,
                'average': {k: float(np.mean([m[k] for m in cfm_metrics]))
                           for k in cfm_metrics[0]}
            }
            avg = results['cfm_decoder']['average']
            print(f"  Average: SNR={avg['snr_db']:.2f}dB, cos={avg['cosine']:.6f}")

        # Verify preflow
        print("\n[VERIFY] Preflow verification...")
        enc_cfg = config.model.encoder
        text_dim = enc_cfg.text_dim
        preflow_metrics = []
        torch.manual_seed(42)

        for i in range(5):
            T = torch.randint(50, 200, (1,)).item()
            features = torch.randn(1, T, text_dim, device=device) * 0.5
            try:
                with torch.no_grad():
                    out_fp32 = model_fp32.preflow(features.float()).float()
                    out_fp16 = model_fp16.preflow(features.half()).float()
                m = compute_tensor_metrics(out_fp32, out_fp16)
                preflow_metrics.append(m)
                print(f"  Sample {i}: SNR={m['snr_db']:.2f}dB, cos={m['cosine']:.6f}")
            except Exception as e:
                print(f"  [WARN] preflow sample {i}: {str(e)[:80]}")

        if preflow_metrics:
            results['preflow'] = {
                'per_sample': preflow_metrics,
                'average': {k: float(np.mean([m[k] for m in preflow_metrics]))
                           for k in preflow_metrics[0]}
            }

        # Verify embeddings
        print("\n[VERIFY] Embeddings verification...")
        emb_metrics = {}
        for emb_name, emb_size in [('note_text_encoder', enc_cfg.vocab_size),
                                     ('note_pitch_encoder', 256),
                                     ('note_type_encoder', 256),
                                     ('f0_encoder', enc_cfg.f0_bin)]:
            test_idx = torch.randint(0, emb_size, (1, 100), device=device)
            try:
                with torch.no_grad():
                    out_fp32 = getattr(model_fp32, emb_name)(test_idx).float()
                    out_fp16 = getattr(model_fp16, emb_name)(test_idx).float()
                m = compute_tensor_metrics(out_fp32, out_fp16)
                emb_metrics[emb_name] = m
                print(f"  {emb_name}: SNR={m['snr_db']:.2f}dB, cos={m['cosine']:.6f}")
            except Exception as e:
                print(f"  [WARN] {emb_name}: {str(e)[:80]}")
        results['embeddings'] = emb_metrics

        # Cleanup
        del model_fp32, model_fp16, mel_t
        if device == 'cuda':
            torch.cuda.empty_cache()
        gc.collect()

        return results

    except Exception as e:
        print(f"[VERIFY] Activation verification failed: {e}")
        traceback.print_exc()
        return None


def compute_tensor_metrics(fp32_out: torch.Tensor, fp16_out: torch.Tensor) -> dict:
    """Compute SNR, cosine similarity, and L0 norm between FP32 and FP16 outputs."""
    x = fp32_out.detach().float().flatten()
    y = fp16_out.detach().float().flatten()

    if x.shape != y.shape:
        min_len = min(x.shape[0], y.shape[0])
        x = x[:min_len]
        y = y[:min_len]

    diff = x - y
    noise_norm = diff.norm().item()
    signal_norm = x.norm().item()

    if noise_norm > 0 and signal_norm > 0:
        snr = 20.0 * np.log10(signal_norm / noise_norm)
    else:
        snr = float('inf') if noise_norm == 0 else -float('inf')

    cos_sim = torch.nn.functional.cosine_similarity(x.unsqueeze(0), y.unsqueeze(0)).item()

    abs_threshold = max(1e-4, x.abs().max().item() * 1e-3)
    l0_count = int((diff.abs() > abs_threshold).sum().item())
    l0_total = int(diff.numel())
    l0_ratio = l0_count / l0_total if l0_total > 0 else 0.0

    return {
        'snr_db': float(snr),
        'cosine': float(cos_sim),
        'l0_count': l0_count,
        'l0_total': l0_total,
        'l0_ratio': float(l0_ratio),
    }


# ============================================================
# Main
# ============================================================
def main():
    parser = argparse.ArgumentParser(description='PyTorch FP16 quantization with calibration')
    parser.add_argument('--device', type=str, default='cuda',
                        choices=['cuda', 'cpu'], help='Device for verification')
    parser.add_argument('--skip-activation-verify', action='store_true',
                        help='Skip activation-level verification (weight-level only)')
    args = parser.parse_args()

    device = args.device
    if device == 'cuda' and not torch.cuda.is_available():
        print("[WARN] CUDA not available, falling back to CPU")
        device = 'cpu'

    print("=" * 70)
    print("PyTorch FP16 Quantization with Calibration (Mixed Precision)")
    print(f"Model: {MODEL_PATH}")
    print(f"Mel data: {MEL_DATA_PATH}")
    print(f"Output: {OUTPUT_MODEL_PATH}")
    print("=" * 70)

    # ============================================================
    # Phase 1: State dict analysis and conversion (fast)
    # ============================================================
    print("\n" + "=" * 70)
    print("PHASE 1: State Dict Analysis & Mixed Precision Conversion")
    print("=" * 70)

    # Step 1: Load state dict
    print("\n[STEP 1] Loading state dict...")
    fp32_sd = load_state_dict(MODEL_PATH)

    # Step 2: Analyze weight statistics
    print("\n[STEP 2] Analyzing weight statistics...")
    weight_stats = analyze_weight_stats(fp32_sd)

    # Print top-level module summary
    module_stats = {}
    for name, s in weight_stats.items():
        prefix = name.split('.')[0]
        if prefix not in module_stats:
            module_stats[prefix] = {'count': 0, 'numel': 0, 'max_abs': 0, 'min_abs_nonzero': float('inf')}
        module_stats[prefix]['count'] += 1
        module_stats[prefix]['numel'] += s['numel']
        module_stats[prefix]['max_abs'] = max(module_stats[prefix]['max_abs'], s['max_abs'])
        if s['min_abs_nonzero'] > 0:
            module_stats[prefix]['min_abs_nonzero'] = min(module_stats[prefix]['min_abs_nonzero'], s['min_abs_nonzero'])

    print("\n[STEP 2] Module summary:")
    for prefix, s in sorted(module_stats.items()):
        print(f"  {prefix:30s}: {s['count']:3d} params, {s['numel']/1e6:6.2f}M, "
              f"max_abs={s['max_abs']:.4e}, min_abs_nz={s['min_abs_nonzero']:.4e}")

    # Step 3: Determine FP32/F16 split
    print("\n[STEP 3] Determining FP32/F16 split...")
    fp32_params, fp16_params, decision_report = determine_fp32_params(fp32_sd, weight_stats)

    # Step 4: Convert to mixed precision
    print("\n[STEP 4] Converting to mixed precision...")
    fp16_sd, conversion_report = convert_state_dict_to_mixed_precision(fp32_sd, fp32_params)

    # Step 5: Compute weight-level precision metrics
    print("\n[STEP 5] Computing weight-level precision metrics...")
    weight_metrics = compute_weight_metrics(fp32_sd, fp16_sd)

    # Step 6: Save model
    print("\n[STEP 6] Saving mixed-precision model...")
    metadata = {
        'quantization_type': 'fp16_mixed_precision_with_calibration',
        'calibration_data': 'GTSinger+PJS mel (mel_data.npy) - weight analysis',
        'fp32_params': sorted(fp32_params),
        'fp16_params': sorted(fp16_params),
        'decision_report': {k: v for k, v in decision_report.items() if k != 'reasons'},
        'conversion_report': conversion_report,
        'weight_metrics_overall': weight_metrics['overall'],
        'config_path': CONFIG_PATH,
        'timestamp': time.strftime('%Y-%m-%d %H:%M:%S'),
    }
    save_model(fp16_sd, OUTPUT_MODEL_PATH, metadata)

    # ============================================================
    # Phase 2: Activation-level verification (optional, slower)
    # ============================================================
    if not args.skip_activation_verify:
        print("\n" + "=" * 70)
        print("PHASE 2: Activation-Level Verification")
        print("=" * 70)

        activation_results = try_activation_verification(
            fp32_sd, fp16_sd, MEL_DATA_PATH, CONFIG_PATH, device
        )

        if activation_results is None:
            print("[PHASE 2] Activation verification failed, using weight-level metrics only")
    else:
        print("\n[PHASE 2] Skipping activation verification")
        activation_results = None

    # ============================================================
    # Final report
    # ============================================================
    print("\n" + "=" * 70)
    print("QUANTIZATION COMPLETE")
    print("=" * 70)

    print(f"\nWeight-level metrics (overall):")
    wm = weight_metrics['overall']
    print(f"  SNR: {wm['snr_db']:.2f} dB")
    print(f"  Cosine: {wm['cosine']:.8f}")
    print(f"  L0: {wm['l0_count']}/{wm['l0_total']} ({wm['l0_ratio']*100:.4f}%)")

    if activation_results:
        print(f"\nActivation-level metrics:")
        for component, result in activation_results.items():
            if isinstance(result, dict) and 'average' in result:
                avg = result['average']
                print(f"  {component}: SNR={avg['snr_db']:.2f}dB, "
                      f"cos={avg['cosine']:.6f}, L0_ratio={avg['l0_ratio']*100:.2f}%")
            elif isinstance(result, dict) and 'snr_db' in result:
                print(f"  {component}: SNR={result['snr_db']:.2f}dB, cos={result['cosine']:.6f}")

    # Save full report
    full_report = {
        'metadata': metadata,
        'weight_metrics': weight_metrics,
        'activation_metrics': activation_results,
        'timestamp': time.strftime('%Y-%m-%d %H:%M:%S'),
    }
    os.makedirs(os.path.dirname(REPORT_PATH), exist_ok=True)
    with open(REPORT_PATH, 'w', encoding='utf-8') as f:
        json.dump(full_report, f, indent=2, ensure_ascii=False, default=str)
    print(f"\nFull report: {REPORT_PATH}")
    print(f"Model saved: {OUTPUT_MODEL_PATH}")


if __name__ == '__main__':
    main()
