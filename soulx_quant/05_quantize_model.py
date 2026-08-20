# -*- coding: utf-8 -*-
"""
Quantize SoulX-Singer to a true INT8 model.

  - diff_step  : Q-DiT style W8A8 (per-channel int8 weights, dynamic per-token
                 int8 activations, int32 MAC). NOT fake quantization: weights
                 are stored as real int8 tensors + fp32 scales.
  - vocoder    : W8A32 (int8 weights + fp32 activations). The Vocos vocoder is
                 very sensitive to activation quantization (W8A8 per-tensor
                 destroyed output, cos~0.0), so activations stay fp32 while
                 weights are real int8 (4x weight memory saving, high precision).
  - cond_emb / preflow / small models: W8A8 per-channel.

Outputs:
  - INT8 PT model:  /workspace/onnx_models/int8/pt/soulxsinger_w8a8.pt
  - A report JSON with per-submodel parameter stats & memory savings.
"""
import os
import sys
import gc
import json
import time
import glob

os.environ['PYTHONIOENCODING'] = 'utf-8'
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, '/workspace')
sys.path.insert(0, '/workspace/SoulX-Singer')

import torch
import numpy as np

from export_shared import load_config  # noqa: E402
from soulxsinger.models.soulxsinger import SoulXSinger  # noqa: E402
from soulx_quant.w8a8_modules import (  # noqa: E402
    quantize_model_qdit, quantize_model_w8a32,
    W8A8Linear, W8A8Conv1d, W8A32Linear, W8A32Conv1d,
)

MODEL_PATH = '/workspace/models_raw/model.pt'
EVAL_DIR = '/workspace/eval_data/gmo-svs'
OUT_DIR = '/workspace/onnx_models/int8/pt'
OUT_PT = os.path.join(OUT_DIR, 'soulxsinger_w8a8.pt')
REPORT = os.path.join(OUT_DIR, 'quantize_report.json')


def log(msg):
    print(msg, flush=True)


def load_model_mmap(config, model_path):
    model = SoulXSinger(config).cpu()
    ckpt = torch.load(model_path, weights_only=False, map_location='cpu', mmap=True)
    model.load_state_dict(ckpt['state_dict'])
    del ckpt
    gc.collect()
    model.eval()
    return model


def load_eval_mels(model, n=6, max_frames=4000, target='source'):
    """Extract real mel inputs from eval dataset wavs for calibration/verification."""
    wavs = sorted(glob.glob(os.path.join(EVAL_DIR, 'audio', target, '*.wav')))
    mels = []
    for p in wavs[:n]:
        try:
            import soundfile as sf
            audio, sr = sf.read(p, dtype='float32', always_2d=True)
            audio = audio[:, 0]
            if sr != 24000:
                import torchaudio.functional as AF
                audio = AF.resample(torch.from_numpy(audio), sr, 24000).numpy()
            t = torch.from_numpy(audio).unsqueeze(0)  # [1, N]
            with torch.no_grad():
                mel = model.mel(t)  # [1, T, 128]
            mel = mel[:, :max_frames, :]
            mels.append(mel)
            log(f'  mel {os.path.basename(p)}: {tuple(mel.shape)}')
        except Exception as e:
            log(f'  [WARN] {os.path.basename(p)}: {e}')
        del audio, t
        gc.collect()
    return mels


def count_params(module):
    return sum(p.numel() for p in module.parameters()) + \
        sum(b.numel() for b in module.buffers() if b.dtype == torch.int8)


def main():
    t0 = time.time()
    os.makedirs(OUT_DIR, exist_ok=True)
    report = {}

    # ---------- 1. load FP32 model ----------
    log('Loading FP32 model (mmap)...')
    config = load_config()
    model = load_model_mmap(config, MODEL_PATH)
    report['fp32_params_M'] = round(sum(p.numel() for p in model.parameters()) / 1e6, 2)
    fp32_weight_bytes = sum(p.numel() * 4 for p in model.parameters())
    report['fp32_weight_bytes'] = int(fp32_weight_bytes)
    log(f'  FP32 total params: {report["fp32_params_M"]}M, weights {fp32_weight_bytes/1e9:.2f} GB')

    # ---------- 2. build real calibration mels from eval dataset ----------
    # (used for reference outputs in the later evaluation stage)
    log('Building reference mels from eval dataset...')
    calib_mels = load_eval_mels(model, n=6, target='source')
    log(f'  {len(calib_mels)} reference mels')
    del calib_mels
    gc.collect()

    # ---------- 3. Q-DiT quantize diff_step + cond_emb ----------
    log('Q-DiT W8A8 quantizing diff_step...')
    diff_est = model.cfm_decoder.model.diff_estimator
    quantize_model_qdit(diff_est, group_size=0, quant_conv=False)
    # cond_emb: Linear(512 -> 1024). NOTE: it is a BARE nn.Linear, so the
    # recursive _replace_module cannot reach it (recursion only replaces
    # children). Replace it directly with W8A8Linear.
    import torch.nn as _nn
    ce = model.cfm_decoder.model.cond_emb
    assert isinstance(ce, _nn.Linear), f'cond_emb expected Linear, got {type(ce).__name__}'
    model.cfm_decoder.model.cond_emb = W8A8Linear(
        ce.weight.data, ce.bias.data if ce.bias is not None else None, group_size=0)
    gc.collect()
    log('  diff_step + cond_emb quantized')

    # ---------- 4. W8A32 quantize vocoder ----------
    # The Vocos vocoder is extremely sensitive to activation quantization; W8A8
    # per-tensor activation quantization collapsed the output (cos~0). Fall back
    # to W8A32 (real int8 weights + fp32 activations): same 4x weight memory
    # saving, high precision (weights-only test: wav cos=0.997).
    log('W8A32 quantizing vocoder (int8 weights, fp32 activations)...')
    quantize_model_w8a32(model.vocoder, group_size=0)
    gc.collect()
    log('  vocoder quantized (W8A32)')

    # ---------- 5. W8A8 quantize preflow (small model) ----------
    log('W8A8 quantizing preflow...')
    quantize_model_qdit(model.preflow, group_size=0, quant_conv=True)
    gc.collect()
    log('  preflow quantized')

    # ---------- 6. verify int8 storage ----------
    n_int8 = sum(1 for b in model.buffers() if b.dtype == torch.int8)
    n_lin = sum(1 for m in model.modules() if isinstance(m, W8A8Linear))
    n_conv = sum(1 for m in model.modules() if isinstance(m, W8A8Conv1d))
    n_lin32 = sum(1 for m in model.modules() if isinstance(m, W8A32Linear))
    n_conv32 = sum(1 for m in model.modules() if isinstance(m, W8A32Conv1d))
    log(f'  int8 buffers: {n_int8}, W8A8Linear: {n_lin}, W8A8Conv1d: {n_conv}, '
        f'W8A32Linear: {n_lin32}, W8A32Conv1d: {n_conv32}')

    # int8 param size vs fp32 (fp32 captured before quantization)
    int8_bytes = sum(b.numel() * 1 for b in model.buffers() if b.dtype == torch.int8)
    scale_bytes = sum(b.numel() * 4 for b in model.buffers() if b.dtype == torch.float32)
    report['int8_weight_bytes'] = int(int8_bytes)
    report['scale_bytes'] = int(scale_bytes)
    report['saved_pct'] = round(100 * (1 - (int8_bytes + scale_bytes) / fp32_weight_bytes), 2)
    log(f'  fp32 weights: {fp32_weight_bytes/1e9:.2f} GB -> int8 weights: {int8_bytes/1e9:.2f} GB '
        f'(+ {scale_bytes/1e9:.2f} GB scales), saved {report["saved_pct"]}%')

    # ---------- 7b. strip export_shared.Config refs from the module graph ----------
    # FlowMatchingTransformer stores cfg (an export_shared.Config from load_config()).
    # If kept, torch.load would import export_shared (re-applying its RoPE/forward
    # patches, written for an older transformers) and break inference. Replace with
    # plain dicts so the saved checkpoint loads cleanly with the original llama.py
    # forwards (which are compatible with the installed transformers).
    def _to_plain(v):
        if isinstance(v, dict):
            return {k: _to_plain(x) for k, x in v.items()}
        if hasattr(v, '__dict__') and type(v).__module__ == 'export_shared':
            return {k: _to_plain(x) for k, x in v.__dict__.items()}
        return v

    fm = getattr(model, 'cfm_decoder', None)
    if fm is not None and hasattr(fm, 'model') and hasattr(fm.model, 'cfg'):
        fm.model.cfg = _to_plain(fm.model.cfg)
        log('  stripped export_shared.Config from model.cfm_decoder.model.cfg')

    # ---------- 8. save INT8 PT model ----------
    log('Saving INT8 PT model...')
    quant_cfg = {
        'method': 'W8A8 + W8A32',
        'diff_step': 'Q-DiT W8A8 (per-channel int8 weights, dynamic per-token int8 activations, int32 MAC)',
        'vocoder': 'W8A32 (int8 weights + fp32 activations) - activation quant too lossy for Vocos',
        'small_models': 'W8A8 per-channel',
        'weights_dtype': 'int8',
        'compute': 'int32 MAC for W8A8 parts; fp32 matmul with int8 weights for W8A32 vocoder',
        'dequantize_weights': False,
    }
    torch.save({
        'state_dict': model.state_dict(),
        'quant_config': quant_cfg,
        'config': 'soulxsinger.yaml',
    }, OUT_PT)
    sz = os.path.getsize(OUT_PT) / 1e9
    log(f'  saved: {OUT_PT} ({sz:.2f} GB)')

    # Also save the full quantized module object (preserves AWQ scales and
    # W8A8 module structure exactly; load with torch.load for direct INT8 use).
    OUT_PT_MODEL = OUT_PT.replace('.pt', '_full.pt')
    torch.save(model, OUT_PT_MODEL)
    log(f'  saved full module: {OUT_PT_MODEL} ({os.path.getsize(OUT_PT_MODEL)/1e9:.2f} GB)')

    report['quant_config'] = quant_cfg
    report['pt_size_GB'] = round(sz, 3)
    report['elapsed_s'] = round(time.time() - t0, 1)
    with open(REPORT, 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    log('  report: %s' % REPORT)
    log('DONE')


if __name__ == '__main__':
    main()
