# -*- coding: utf-8 -*-
"""
Quantize SoulX-Singer to a true W8A8 INT8 model.

  - diff_step  : Q-DiT style W8A8 (per-channel int8 weights, dynamic per-token
                 int8 activations, int32 MAC). NOT fake quantization: weights
                 are stored as real int8 tensors + fp32 scales.
  - vocoder    : AWQ (activation-aware weight quantization) W8A8, using real
                 calibration mels from SoulX-Singer-Eval-Dataset.
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
    quantize_model_qdit, replace_linear_awq, collect_activation_stats,
    W8A8Linear, W8A8Conv1d,
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
    log('Building calibration mels from eval dataset...')
    calib_mels = load_eval_mels(model, n=6, target='source')
    log(f'  {len(calib_mels)} calibration mels')

    # ---------- 3. AWQ calibration: collect vocoder activation stats ----------
    log('Collecting vocoder activation statistics (AWQ calibration)...')
    vocoder = model.vocoder
    module_names = set()
    for name, m in vocoder.named_modules():
        if isinstance(m, (torch.nn.Linear, torch.nn.Conv1d)):
            module_names.add(name)
    # run full vocoder (backbone + head) on calibration mels -> [B, C, L]
    calib_feats = [mel.transpose(1, 2) for mel in calib_mels]
    act_stats = collect_activation_stats(vocoder, calib_feats, module_names)
    log(f'  collected stats for {len(act_stats)} modules')
    del calib_feats
    gc.collect()

    # ---------- 4. Q-DiT quantize diff_step + cond_emb ----------
    log('Q-DiT W8A8 quantizing diff_step...')
    diff_est = model.cfm_decoder.model.diff_estimator
    quantize_model_qdit(diff_est, group_size=0, quant_conv=False)
    # cond_emb: Linear(512 -> 1024)
    cond_emb = model.cfm_decoder.model.cond_emb
    quantize_model_qdit(cond_emb, group_size=0, quant_conv=False)
    gc.collect()
    log('  diff_step + cond_emb quantized')

    # ---------- 5. AWQ quantize vocoder ----------
    log('AWQ W8A8 quantizing vocoder...')
    replace_linear_awq(vocoder, act_stats)
    del act_stats
    gc.collect()
    log('  vocoder quantized (AWQ)')

    # ---------- 6. W8A8 quantize preflow (small model) ----------
    log('W8A8 quantizing preflow...')
    quantize_model_qdit(model.preflow, group_size=0, quant_conv=True)
    gc.collect()
    log('  preflow quantized')

    # ---------- 7. verify int8 storage ----------
    n_int8 = sum(1 for b in model.buffers() if b.dtype == torch.int8)
    n_lin = sum(1 for m in model.modules() if isinstance(m, W8A8Linear))
    n_conv = sum(1 for m in model.modules() if isinstance(m, W8A8Conv1d))
    log(f'  int8 buffers: {n_int8}, W8A8Linear: {n_lin}, W8A8Conv1d: {n_conv}')

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
        'method': 'W8A8',
        'diff_step': 'Q-DiT (per-channel int8 weights, dynamic per-token int8 activations)',
        'vocoder': 'AWQ (activation-aware per-channel int8)',
        'small_models': 'W8A8 per-channel',
        'weights_dtype': 'int8',
        'compute': 'int32 MAC (int8 x int8 -> int32)',
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
