# -*- coding: utf-8 -*-
"""End-to-end precision verification: PyTorch model.infer() vs ONNX pipeline.

Compares the full SVS pipeline output (audio waveform) between:
1. PyTorch SoulXSinger — manual sub-step calls matching model.infer() flow
2. Python reproduction of the JS ONNX pipeline — 8 ONNX models chained via CPU EP

Both paths use identical inputs (prompt audio + target metadata) and the same
random noise seed (42) for the flow-matching diffusion loop.

Key alignments with diffusion.js / flow_matching.py:
- t = (step + 0.5) / totalSteps  (NOT i/n or (i+1)/n)
- uncond branch: target-only sequence (xt, cond, mask all target-only, no prompt)
- CFG rescale: Bessel-corrected std (N-1 denominator) + single epsilon in denominator
- rescale mix: rescale_cfg * rescaled + (1 - rescale_cfg) * cfg_pred
- Euler integration: xt += flow_pred * h,  h = 1.0 / totalSteps

Architecture note:
  diff_step_dml.onnx was exported via DiffStepWrapper which does NOT include
  cond_emb (commit 66d040d). The pipeline runs cond_emb.onnx separately in
  preprocessing.js to convert cond_code (512-dim) → cond_embedding (1024-dim),
  then feeds cond_embedding directly to diff_step. This matches the current
  production pipeline architecture.

  For the uncond branch, the JS pipeline uses zeros[1024] directly (not
  cond_emb(zeros[512]) = bias[1024]). This is the post-66d040d behavior.

Dynamic shape models (re-exported via acee2f5):
  - mel_transform:     audio [1, 24000]      -> mel [1, 50, 128]  (static, Cooley-Tukey DFT requires fixed N)
  - note_*_encoder:    ids   [1, seq_len]    -> emb [1, seq_len, 512]  (dynamic)
  - f0_encoder:        ids   [1, seq_len]    -> emb [1, seq_len, 512]  (dynamic)
  - preflow:           feat  [1, seq_len, 512] -> feat [1, seq_len, 512]  (dynamic)
  - cond_emb:          code  [1, seq_len, 512] -> emb [1, seq_len, 1024]  (dynamic)
  - diff_step_dml:     xt [1, seq_len, 128], t [1], cond [1, seq_len, 1024], mask [1, seq_len]  (dynamic)
  - vocoder_dml:       mel  [1, num_frames, 128] -> waveform [1, audio_len]  (dynamic)

  Test case sizing: prompt 50 mel frames (1s audio) + target 200 mel frames (4s)
  = 250 total cond frames. No padding needed — models accept any seq_len.

Usage:
    python scripts/verify_e2e_precision.py
    python scripts/verify_e2e_precision.py --verbose
    python scripts/verify_e2e_precision.py --output scripts/e2e_precision_report.json
"""

import os
import sys
import json
import time
import argparse
import numpy as np
import torch
import onnxruntime as ort

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
SOULX_DIR = os.path.join(PROJECT_DIR, 'SoulX-Singer')
sys.path.insert(0, PROJECT_DIR)
sys.path.insert(0, SOULX_DIR)

from export_shared import (
    load_config, load_model, clear_memory,
    DiffStepWrapper, VocosFullWrapper,
)

# ============================================================
# Constants (aligned with src/inference/pipeline/constants.js)
# ============================================================
SAMPLE_RATE = 24000
HOP_SIZE = 480
MEL_DIM = 128
EMBED_DIM = 512
COND_DIM = 1024  # cond_emb output dim (for reference; diff_step takes 512-dim)
F0_BIN = 361
F0_MIN = 32.7031956625

# Dynamic shape models (no fixed limits except mel_transform)
MEL_TRANSFORM_AUDIO_SAMPLES = 24000  # mel_transform (1 second, static due to Cooley-Tukey DFT)

# Diffusion defaults
DEFAULT_N_STEPS = 32
DEFAULT_CFG = 1.0
DEFAULT_RESCALE_CFG = 1.0
SEED = 42

# Thresholds (e2e is more relaxed than module-level)
COS_MIN = 0.95
SNR_MIN_DB = 20.0


# ============================================================
# Metrics (same as verify_module_precision.py)
# ============================================================

def compute_metrics(pt_out, onnx_out):
    """Compute MSE, RMSE, COS, SNR between PyTorch and ONNX outputs."""
    pt = pt_out.astype(np.float64)
    on = onnx_out.astype(np.float64)
    if pt.shape != on.shape:
        min_len = min(pt.size, on.size)
        pt = pt.reshape(-1)[:min_len]
        on = on.reshape(-1)[:min_len]
    diff = pt - on
    mse = float(np.mean(diff ** 2))
    rmse = float(np.sqrt(mse))
    cos = float(np.dot(pt.flatten(), on.flatten()) /
                (np.linalg.norm(pt) * np.linalg.norm(on) + 1e-12))
    signal_power = float(np.mean(pt ** 2))
    noise_power = mse
    snr_db = float(10 * np.log10(signal_power / (noise_power + 1e-12)))
    return {'mse': mse, 'rmse': rmse, 'cos': cos, 'snr_db': snr_db}


# ============================================================
# ONNX session helpers
# ============================================================

def create_onnx_session(onnx_path):
    """Create a CPU EP ONNX session for deterministic comparison."""
    sess_options = ort.SessionOptions()
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    return ort.InferenceSession(onnx_path, sess_options=sess_options,
                                providers=['CPUExecutionProvider'])


def get_input_name(session, index=0):
    return session.get_inputs()[index].name


# ============================================================
# F0 quantization (aligned with soulxsinger.py f0_to_coarse)
# ============================================================

def f0_to_coarse(f0_hz, f0_shift=0):
    """Convert F0 Hz values to discrete bins (0=unvoiced, 1..360=voiced).

    Matches SoulXSinger.f0_to_coarse and JS preprocessing.js quantizeF0.
    f0_shift is in 20-cent bin units (semitone * 5).
    """
    f0 = np.asarray(f0_hz, dtype=np.float64)
    uv = f0 <= 0
    f0_safe = np.maximum(f0, F0_MIN)
    f0_cents = 1200.0 * np.log2(f0_safe / F0_MIN)
    coarse = np.rint(f0_cents / 20.0).astype(np.int64) + 1
    coarse = np.clip(coarse, 1, F0_BIN - 1)
    coarse[uv] = 0
    if f0_shift != 0:
        voiced = coarse > 0
        if np.any(voiced):
            shifted = coarse[voiced] + f0_shift
            coarse[voiced] = np.clip(shifted, 1, F0_BIN - 1)
    return coarse.astype(np.int64)


# ============================================================
# Data loading and preprocessing (using PyTorch DataProcessor)
# ============================================================

def load_example_meta(json_path):
    """Load example metadata JSON (single-item list format)."""
    with open(json_path, 'r', encoding='utf-8') as f:
        meta = json.load(f)
    if isinstance(meta, list):
        meta = meta[0]
    return meta


def load_prompt_audio(audio_path, target_samples=MEL_TRANSFORM_AUDIO_SAMPLES):
    """Load audio file and truncate/pad to target_samples (24000 for 1s)."""
    import librosa
    audio, sr = librosa.load(audio_path, sr=SAMPLE_RATE, mono=True)
    if len(audio) < target_samples:
        audio = np.pad(audio, (0, target_samples - len(audio)))
    audio = audio[:target_samples].astype(np.float32)
    return audio  # shape: (target_samples,)


def prepare_test_data(args, verbose=False):
    """Load and preprocess example data, truncating to fit ONNX static shapes.

    Returns dict with keys:
      pt_wav, pt_mel2note, pt_f0, pt_note_text, pt_note_pitch, pt_note_type,
      gt_mel2note, gt_f0, gt_note_text, gt_note_pitch, gt_note_type,
      pt_mel_frames, gt_mel_frames, pt_token_count, gt_token_count
    """
    from soulxsinger.utils.data_processor import DataProcessor

    prompt_meta = load_example_meta(os.path.join(SOULX_DIR, 'example', 'audio', 'zh_prompt.json'))
    target_meta = load_example_meta(os.path.join(SOULX_DIR, 'example', 'audio', 'zh_target.json'))

    # Use CPU for DataProcessor (no CUDA needed for preprocessing).
    # Pass absolute phoneset_path because DataProcessor default is a relative
    # path that only works when cwd is SoulX-Singer/.
    phoneset_path = os.path.join(SOULX_DIR, 'soulxsinger', 'utils', 'phoneme', 'phone_set.json')
    processor = DataProcessor(hop_size=HOP_SIZE, sample_rate=SAMPLE_RATE,
                              phoneset_path=phoneset_path, device='cpu')

    # Process prompt and target metadata
    pt_item = processor.process(prompt_meta)
    gt_item = processor.process(target_meta)

    # Load prompt audio (truncate to 1 second for mel_transform static shape)
    prompt_audio_path = os.path.join(SOULX_DIR, 'example', 'audio', 'zh_prompt.mp3')
    pt_wav = load_prompt_audio(prompt_audio_path, MEL_TRANSFORM_AUDIO_SAMPLES)

    # Truncate mel2note and f0 to test target size
    # Prompt: 50 mel frames (1 second), Target: 200 mel frames (4 seconds)
    pt_mel_frames = MEL_TRANSFORM_AUDIO_SAMPLES // HOP_SIZE  # 50
    gt_mel_frames = 200  # 4 seconds at 50Hz

    pt_mel2note = pt_item['mel2note'][0]  # [T_pt]
    gt_mel2note = gt_item['mel2note'][0]  # [T_gt]
    pt_f0 = pt_item['f0'][0] if pt_item['f0'] is not None else torch.zeros(pt_mel2note.shape[0])
    gt_f0 = gt_item['f0'][0] if gt_item['f0'] is not None else torch.zeros(gt_mel2note.shape[0])

    # Truncate (or pad if shorter)
    def truncate_or_pad(arr, target_len, pad_value=0):
        if isinstance(arr, torch.Tensor):
            arr = arr.numpy()
        if len(arr) >= target_len:
            return arr[:target_len].copy()
        result = np.full(target_len, pad_value, dtype=arr.dtype if hasattr(arr, 'dtype') else np.float32)
        result[:len(arr)] = arr
        return result

    pt_mel2note_np = truncate_or_pad(pt_mel2note, pt_mel_frames, pad_value=0).astype(np.int64)
    gt_mel2note_np = truncate_or_pad(gt_mel2note, gt_mel_frames, pad_value=0).astype(np.int64)
    pt_f0_np = truncate_or_pad(pt_f0, pt_mel_frames, pad_value=0.0).astype(np.float32)
    gt_f0_np = truncate_or_pad(gt_f0, gt_mel_frames, pad_value=0.0).astype(np.float32)

    # Token sequences — dynamic shape models accept any seq_len, no truncation needed.
    pt_note_text = pt_item['phoneme'][0].numpy().astype(np.int64)
    pt_note_pitch = pt_item['note_pitch'][0].numpy().astype(np.int64)
    pt_note_type = pt_item['note_type'][0].numpy().astype(np.int64)
    gt_note_text = gt_item['phoneme'][0].numpy().astype(np.int64)
    gt_note_pitch = gt_item['note_pitch'][0].numpy().astype(np.int64)
    gt_note_type = gt_item['note_type'][0].numpy().astype(np.int64)

    pt_token_count = len(pt_note_text)
    gt_token_count = len(gt_note_text)
    total_token_count = pt_token_count + gt_token_count

    if verbose:
        print(f"  Prompt: {pt_token_count} tokens, {pt_mel_frames} mel frames, "
              f"audio {len(pt_wav)} samples")
        print(f"  Target: {gt_token_count} tokens, {gt_mel_frames} mel frames")
        print(f"  Total tokens: {total_token_count}")
        print(f"  pt_mel2note range: [{pt_mel2note_np.min()}, {pt_mel2note_np.max()}]")
        print(f"  gt_mel2note range: [{gt_mel2note_np.min()}, {gt_mel2note_np.max()}]")
        print(f"  pt_f0 range: [{pt_f0_np.min():.1f}, {pt_f0_np.max():.1f}]")
        print(f"  gt_f0 range: [{gt_f0_np.min():.1f}, {gt_f0_np.max():.1f}]")

    return {
        'pt_wav': pt_wav,
        'pt_mel2note': pt_mel2note_np,
        'pt_f0': pt_f0_np,
        'pt_note_text': pt_note_text,
        'pt_note_pitch': pt_note_pitch,
        'pt_note_type': pt_note_type,
        'gt_mel2note': gt_mel2note_np,
        'gt_f0': gt_f0_np,
        'gt_note_text': gt_note_text,
        'gt_note_pitch': gt_note_pitch,
        'gt_note_type': gt_note_type,
        'pt_mel_frames': pt_mel_frames,
        'gt_mel_frames': gt_mel_frames,
        'pt_token_count': pt_token_count,
        'gt_token_count': gt_token_count,
    }


# ============================================================
# PyTorch reference path (manual sub-step calls)
# ============================================================

def run_pytorch_reference(model, data, n_steps, cfg, rescale_cfg, verbose=False):
    """Run PyTorch SVS pipeline manually (matching model.infer flow).

    Returns generated audio as numpy [1, N_samples].
    """
    pt_wav = torch.from_numpy(data['pt_wav']).unsqueeze(0).float()  # [1, 24000]
    pt_mel2note = torch.from_numpy(data['pt_mel2note']).unsqueeze(0)  # [1, 50]
    gt_mel2note = torch.from_numpy(data['gt_mel2note']).unsqueeze(0)  # [1, 200]
    pt_f0 = torch.from_numpy(data['pt_f0']).unsqueeze(0).float()  # [1, 50]
    gt_f0 = torch.from_numpy(data['gt_f0']).unsqueeze(0).float()  # [1, 200]
    pt_note_text = torch.from_numpy(data['pt_note_text']).unsqueeze(0)  # [1, T_pt]
    gt_note_text = torch.from_numpy(data['gt_note_text']).unsqueeze(0)
    pt_note_pitch = torch.from_numpy(data['pt_note_pitch']).unsqueeze(0)
    gt_note_pitch = torch.from_numpy(data['gt_note_pitch']).unsqueeze(0)
    pt_note_type = torch.from_numpy(data['pt_note_type']).unsqueeze(0)
    gt_note_type = torch.from_numpy(data['gt_note_type']).unsqueeze(0)

    len_prompt = pt_note_pitch.shape[1]  # token count
    len_prompt_mel = pt_f0.shape[1]      # mel frames (50)

    # f0_shift = 0 (no auto_shift)
    f0_shift = 0

    with torch.no_grad():
        # 1. Prompt mel extraction
        pt_mel = model.mel(pt_wav.float())  # [1, 50, 128]
        if verbose:
            print(f"  [PT] pt_mel shape: {pt_mel.shape}, mean={pt_mel.mean():.4f}")

        # 2. Sequence concatenation (prompt + target)
        note_pitch = torch.cat([pt_note_pitch, gt_note_pitch], 1)
        note_text = torch.cat([pt_note_text, gt_note_text], 1)
        note_type = torch.cat([pt_note_type, gt_note_type], 1)
        mel2note = torch.cat([pt_mel2note, gt_mel2note + len_prompt], 1)
        # Clamp mel2note to valid token range (safety, matches JS pipeline)
        total_tokens = note_pitch.shape[1]
        mel2note = torch.clamp(mel2note, 0, total_tokens - 1)

        # 3. F0 quantization
        f0_course_pt = model.f0_to_coarse(pt_f0)
        f0_course_gt = model.f0_to_coarse(gt_f0, f0_shift=f0_shift * 5)
        f0_course = torch.cat([f0_course_pt, f0_course_gt], 1)

        # 4. note_pitch shift (f0_shift=0, so no-op)
        if f0_shift != 0:
            note_pitch[note_pitch > 0] = note_pitch[note_pitch > 0] + f0_shift
            note_pitch = torch.clamp(note_pitch, 0, 255)

        # 5. Encoder forward
        features = (model.note_pitch_encoder(note_pitch) +
                    model.note_type_encoder(note_type) +
                    model.note_text_encoder(note_text))
        features = model.preflow(features)
        features = model.expand_states(features, mel2note)
        features = features + model.f0_encoder(f0_course)

        if verbose:
            print(f"  [PT] features shape: {features.shape}, mean={features.mean():.4f}")

        # 6. Split prompt/target conditions
        pt_decoder_inp = features[:, :len_prompt_mel, :]
        gt_decoder_inp = features[:, len_prompt_mel:, :]

        # 7. Flow-matching diffusion loop (manual, matching ONNX/JS pipeline exactly)
        # CRITICAL ALIGNMENT: The ONNX diff_step_dml.onnx was exported via
        # DiffStepWrapper which applies cond_emb INTERNALLY. For the uncond
        # branch, the ONNX/JS pipeline passes zeros[1,T,512] as cond_code,
        # which cond_emb transforms to its bias (NOT zeros[1,T,1024]).
        # PyTorch's official reverse_diffusion uses zeros[1,T,1024] for uncond,
        # creating a mismatch. To make a fair comparison, we replicate the
        # ONNX/JS behavior here: pass zeros[1,T,512] through cond_emb for uncond.
        diffusion_cond_code = torch.cat([pt_decoder_inp, gt_decoder_inp], dim=1)  # [1, 250, 512]
        diffusion_prompt = pt_mel  # [1, 50, 128]

        prompt_len = diffusion_prompt.shape[1]  # 50
        target_len = gt_decoder_inp.shape[1]    # 200
        cond_emb_module = model.cfm_decoder.model.cond_emb
        diff_estimator = model.cfm_decoder.model.diff_estimator

        # Apply cond_emb to cond_code (same as DiffStepWrapper.forward in old architecture,
        # but now cond_emb is separate in the pipeline: preprocessing.js → cond_emb.onnx)
        cond_emb_full = cond_emb_module(diffusion_cond_code)  # [1, total_mel, 1024]

        # uncond cond: zeros[1, target_len, 1024] directly (matching JS pipeline post-66d040d).
        # The JS pipeline uses zeros[1024] for uncond, NOT cond_emb(zeros[512]) = bias[1024].
        uncond_cond_emb = torch.zeros(1, target_len, COND_DIM,
                                       dtype=diffusion_cond_code.dtype)

        # Masks (all ones)
        xt_mask = torch.ones(1, prompt_len + target_len)  # [1, 250]
        x_mask = torch.ones(1, target_len)                # [1, 200]

        # Set seed for z (matching ONNX path)
        torch.manual_seed(SEED)
        z = torch.randn(1, target_len, MEL_DIM, dtype=diffusion_cond_code.dtype)
        xt = z

        h = 1.0 / n_steps
        for i in range(n_steps):
            t_val = (i + 0.5) * h
            t = t_val * torch.ones(1, dtype=diffusion_cond_code.dtype)

            # Conditional branch: xt_input = cat([prompt, xt])
            xt_input = torch.cat([diffusion_prompt, xt], dim=1)  # [1, 250, 128]
            flow_pred = diff_estimator(xt_input, t, cond_emb_full, xt_mask)
            flow_pred = flow_pred[:, prompt_len:, :]  # [1, 200, 128]

            # CFG branch (matching ONNX/JS: uncond uses cond_emb(zeros))
            if cfg > 0:
                uncond_flow_pred = diff_estimator(
                    xt, t, uncond_cond_emb, x_mask)

                # Bessel-corrected std (PyTorch .std() default ddof=1)
                pos_std = flow_pred.std()
                flow_pred_cfg = flow_pred + cfg * (flow_pred - uncond_flow_pred)
                cfg_std = flow_pred_cfg.std()

                # Rescale with single epsilon (matching JS diffusion.js)
                rescale = pos_std / (cfg_std + 1e-8)
                rescaled = flow_pred_cfg * rescale
                flow_pred = (rescale_cfg * rescaled +
                             (1.0 - rescale_cfg) * flow_pred_cfg)

            xt = xt + flow_pred * h

            if verbose and (i % 8 == 7 or i == n_steps - 1):
                print(f"  [PT] step {i+1}/{n_steps}: "
                      f"xt mean={xt.mean():.4f}, std={xt.std():.4f}")

        generated_mel = xt  # [1, 200, 128]
        if verbose:
            print(f"  [PT] generated_mel shape: {generated_mel.shape}, "
                  f"mean={generated_mel.mean():.4f}")

        # 8. Vocoder (use VocosFullWrapper for fair comparison with ONNX)
        vocoder_wrapper = VocosFullWrapper(model.vocoder).eval()
        generated_audio = vocoder_wrapper(generated_mel)  # [1, T*hop]
        if verbose:
            print(f"  [PT] generated_audio shape: {generated_audio.shape}, "
                  f"mean={generated_audio.mean():.6f}, "
                  f"max_abs={generated_audio.abs().max():.6f}")

    return generated_audio.numpy()


# ============================================================
# ONNX pipeline reproduction (matching JS pipeline)
# ============================================================

def run_onnx_pipeline(sessions, data, n_steps, cfg, rescale_cfg, verbose=False):
    """Run ONNX SVS pipeline reproducing the JS pipeline in Python.

    Uses 9 ONNX models (cond_emb.onnx is called separately before diff_step_dml.onnx).
    Returns generated audio as numpy [1, N_samples].
    """
    pt_wav = data['pt_wav']  # [24000]
    pt_mel_frames = data['pt_mel_frames']  # 50
    gt_mel_frames = data['gt_mel_frames']  # 200
    total_mel_frames = pt_mel_frames + gt_mel_frames  # 250
    pt_token_count = data['pt_token_count']
    gt_token_count = data['gt_token_count']
    total_token_count = pt_token_count + gt_token_count

    # ---- 1. mel_transform: prompt audio -> prompt mel ----
    audio_input = pt_wav.reshape(1, -1).astype(np.float32)  # [1, 24000]
    mel_sess = sessions['mel_transform']
    mel_input_name = get_input_name(mel_sess)
    pt_mel = mel_sess.run(None, {mel_input_name: audio_input})[0]  # [1, 50, 128]
    if verbose:
        print(f"  [ONNX] pt_mel shape: {pt_mel.shape}, mean={pt_mel.mean():.4f}")

    # ---- 2. Note encoders (text, pitch, type) ----
    # Concatenate prompt + target token sequences (dynamic shape, no padding)
    note_text_seq = np.concatenate([data['pt_note_text'], data['gt_note_text']])
    note_pitch_seq = np.concatenate([data['pt_note_pitch'], data['gt_note_pitch']])
    note_type_seq = np.concatenate([data['pt_note_type'], data['gt_note_type']])

    # Run 4 encoders with actual seq_len (dynamic shape)
    text_sess = sessions['note_text_encoder']
    pitch_sess = sessions['note_pitch_encoder']
    type_sess = sessions['note_type_encoder']
    f0_sess = sessions['f0_encoder']

    text_input_name = get_input_name(text_sess)
    pitch_input_name = get_input_name(pitch_sess)
    type_input_name = get_input_name(type_sess)
    f0_input_name = get_input_name(f0_sess)

    text_emb = text_sess.run(None, {text_input_name: note_text_seq.reshape(1, -1)})[0]
    pitch_emb = pitch_sess.run(None, {pitch_input_name: note_pitch_seq.reshape(1, -1)})[0]
    type_emb = type_sess.run(None, {type_input_name: note_type_seq.reshape(1, -1)})[0]

    token_emb = text_emb + pitch_emb + type_emb  # [1, total_tokens, 512]
    if verbose:
        print(f"  [ONNX] token_emb shape: {token_emb.shape}")

    # ---- 3. Preflow ----
    preflow_sess = sessions['preflow']
    preflow_input_name = get_input_name(preflow_sess)
    preflow_out = preflow_sess.run(None, {preflow_input_name: token_emb.astype(np.float32)})[0]

    # ---- 4. expand_states (gather using mel2note) ----
    combined_mel2note = np.concatenate([
        data['pt_mel2note'],
        data['gt_mel2note'] + pt_token_count
    ])  # [total_mel_frames]
    # Clamp to valid token indices
    max_token_idx = preflow_out.shape[1] - 1
    combined_mel2note = np.clip(combined_mel2note, 0, max_token_idx)

    expanded = preflow_out[0, combined_mel2note, :]  # [total_mel_frames, 512]
    expanded = expanded[np.newaxis, :, :]  # [1, total_mel_frames, 512]

    # ---- 5. F0 quantization and f0_encoder ----
    pt_f0_ids = f0_to_coarse(data['pt_f0'], f0_shift=0)  # [pt_mel_frames]
    gt_f0_ids = f0_to_coarse(data['gt_f0'], f0_shift=0)  # [gt_mel_frames]
    combined_f0_ids = np.concatenate([pt_f0_ids, gt_f0_ids])  # [total_mel_frames]

    # Dynamic shape: pass actual total_mel_frames directly (no chunking needed)
    f0_emb = f0_sess.run(None, {f0_input_name: combined_f0_ids.reshape(1, -1)})[0]
    # [1, total_mel_frames, 512]

    # ---- 6. Combine: features = expanded + f0_emb ----
    cond_code = expanded + f0_emb  # [1, total_mel_frames, 512]
    if verbose:
        print(f"  [ONNX] cond_code shape: {cond_code.shape}, "
              f"mean={cond_code.mean():.4f}")

    # ---- 7. cond_emb: cond_code (512) -> cond_embedding (1024) ----
    cond_emb_sess = sessions['cond_emb']
    cond_emb_input_name = get_input_name(cond_emb_sess)
    cond_embedding = cond_emb_sess.run(None, {cond_emb_input_name: cond_code.astype(np.float32)})[0]
    # [1, total_mel_frames, 1024]
    if verbose:
        print(f"  [ONNX] cond_embedding shape: {cond_embedding.shape}, "
              f"mean={cond_embedding.mean():.4f}")

    # ---- 8. Flow-matching diffusion loop ----
    diff_sess = sessions['diff_step']

    # Generate noise z with same seed as PyTorch
    torch.manual_seed(SEED)
    z = torch.randn(1, gt_mel_frames, MEL_DIM).numpy().astype(np.float32)  # [1, 200, 128]
    xt = z.copy()  # [1, 200, 128] target-only

    # cond for conditional branch: [1, total_mel_frames, 1024]
    cond_mask = np.ones((1, total_mel_frames), dtype=np.float32)

    # uncond: target-only zeros [1, target_len, 1024] (matching JS pipeline post-66d040d)
    uncond_cond = np.zeros((1, gt_mel_frames, COND_DIM), dtype=np.float32)
    uncond_mask = np.ones((1, gt_mel_frames), dtype=np.float32)

    h = 1.0 / n_steps

    for step in range(n_steps):
        t_val = (step + 0.5) / n_steps
        t_arr = np.array([t_val], dtype=np.float32)

        # Conditional branch: xt_input = cat([prompt, xt], dim=1)
        xt_input = np.concatenate([pt_mel, xt], axis=1)  # [1, total_mel_frames, 128]

        cond_pred = diff_sess.run(None, {
            'xt_input': xt_input.astype(np.float32),
            't': t_arr,
            'cond': cond_embedding.astype(np.float32),
            'xt_mask': cond_mask.astype(np.float32),
        })[0]  # [1, total_mel_frames, 128]
        flow_pred = cond_pred[0, pt_mel_frames:pt_mel_frames + gt_mel_frames, :]  # [200, 128]
        flow_pred = flow_pred[np.newaxis, :, :]  # [1, 200, 128]

        # CFG branch
        if cfg > 0:
            uncond_pred = diff_sess.run(None, {
                'xt_input': xt.astype(np.float32),
                't': t_arr,
                'cond': uncond_cond.astype(np.float32),
                'xt_mask': uncond_mask.astype(np.float32),
            })[0]  # [1, target_len, 128]
            uncond_flow_pred = uncond_pred[0, :gt_mel_frames, :]  # [200, 128]
            uncond_flow_pred = uncond_flow_pred[np.newaxis, :, :]  # [1, 200, 128]

            flow_pred_cfg = flow_pred + cfg * (flow_pred - uncond_flow_pred)

            # Bessel-corrected std (N-1 denominator), single epsilon in denominator
            pos_std = np.std(flow_pred, ddof=1)
            cfg_std = np.std(flow_pred_cfg, ddof=1)
            rescale = pos_std / (cfg_std + 1e-8)

            rescaled = flow_pred_cfg * rescale
            flow_pred = rescale_cfg * rescaled + (1.0 - rescale_cfg) * flow_pred_cfg

        # Euler integration
        xt = xt + flow_pred * h

        if verbose and (step % 8 == 7 or step == n_steps - 1):
            print(f"  [ONNX] step {step+1}/{n_steps}: "
                  f"xt mean={xt.mean():.4f}, std={xt.std():.4f}")

    generated_mel = xt  # [1, 200, 128]
    if verbose:
        print(f"  [ONNX] generated_mel shape: {generated_mel.shape}, "
              f"mean={generated_mel.mean():.4f}")

    # ---- 9. Vocoder (dynamic shape) ----
    vocoder_sess = sessions['vocoder']
    vocoder_input_name = get_input_name(vocoder_sess)
    audio_out = vocoder_sess.run(None, {vocoder_input_name: generated_mel.astype(np.float32)})[0]

    # Trim to actual mel frames * HOP_SIZE
    expected_samples = gt_mel_frames * HOP_SIZE
    audio_trimmed = audio_out[:, :expected_samples]
    if verbose:
        print(f"  [ONNX] generated_audio shape: {audio_trimmed.shape}, "
              f"mean={audio_trimmed.mean():.6f}, "
              f"max_abs={np.abs(audio_trimmed).max():.6f}")

    return audio_trimmed


# ============================================================
# Main
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description='End-to-end precision verification: PyTorch vs ONNX pipeline')
    parser.add_argument('--output', default=os.path.join(SCRIPT_DIR, 'e2e_precision_report.json'),
                        help='Output JSON report path')
    parser.add_argument('--model-path',
                        default=os.path.join(SOULX_DIR, 'pretrained_models', 'SoulX-Singer', 'model.pt'),
                        help='Path to SoulX-Singer model.pt')
    parser.add_argument('--onnx-dir', default=os.path.join(PROJECT_DIR, 'onnx_models'),
                        help='Directory containing FP32 ONNX models')
    parser.add_argument('--n-steps', type=int, default=DEFAULT_N_STEPS,
                        help='Number of diffusion steps (default: 32)')
    parser.add_argument('--cfg', type=float, default=DEFAULT_CFG,
                        help='CFG strength (default: 1.0)')
    parser.add_argument('--rescale-cfg', type=float, default=DEFAULT_RESCALE_CFG,
                        help='CFG rescale factor (default: 1.0)')
    parser.add_argument('--verbose', action='store_true',
                        help='Print detailed diagnostics')
    args = parser.parse_args()

    np.random.seed(SEED)
    torch.manual_seed(SEED)

    print("=" * 70)
    print("End-to-end precision verification: PyTorch vs ONNX pipeline")
    print("=" * 70)
    print(f"ONNX dir:    {args.onnx_dir}")
    print(f"Model:       {args.model_path}")
    print(f"n_steps:     {args.n_steps}")
    print(f"cfg:         {args.cfg}")
    print(f"rescale_cfg: {args.rescale_cfg}")
    print(f"seed:        {SEED}")
    print(f"Thresholds:  COS >= {COS_MIN}, SNR >= {SNR_MIN_DB} dB")
    print()

    if not os.path.exists(args.model_path):
        print(f"[ERROR] Model not found: {args.model_path}")
        sys.exit(2)
    if not os.path.isdir(args.onnx_dir):
        print(f"[ERROR] ONNX dir not found: {args.onnx_dir}")
        sys.exit(2)

    # ---- Step 1: Load and preprocess test data ----
    print("[1/4] Loading and preprocessing test data...")
    t0 = time.time()
    try:
        data = prepare_test_data(args, verbose=args.verbose)
    except Exception as e:
        print(f"[ERROR] Data preparation failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(2)
    print(f"      Data ready in {time.time()-t0:.1f}s")

    # ---- Step 2: Load PyTorch model ----
    print("\n[2/4] Loading SoulX-Singer PyTorch model...")
    t0 = time.time()
    config = load_config()
    model = load_model(config, args.model_path)
    model.eval()
    print(f"      Loaded in {time.time()-t0:.1f}s")

    # ---- Step 3: Load ONNX sessions ----
    print("\n[3/4] Loading ONNX sessions...")
    t0 = time.time()
    onnx_files = {
        'mel_transform': 'mel_transform.onnx',
        'note_text_encoder': 'note_text_encoder.onnx',
        'note_pitch_encoder': 'note_pitch_encoder.onnx',
        'note_type_encoder': 'note_type_encoder.onnx',
        'f0_encoder': 'f0_encoder.onnx',
        'preflow': 'preflow.onnx',
        'cond_emb': 'cond_emb.onnx',
        'diff_step': 'diff_step_dml.onnx',
        'vocoder': 'vocoder_dml.onnx',
    }
    sessions = {}
    for name, fname in onnx_files.items():
        path = os.path.join(args.onnx_dir, fname)
        if not os.path.exists(path):
            print(f"  [ERROR] ONNX not found: {path}")
            sys.exit(2)
        sessions[name] = create_onnx_session(path)
        if args.verbose:
            inp = sessions[name].get_inputs()
            out = sessions[name].get_outputs()
            print(f"  {name}: in={[f'{i.name}{i.shape}' for i in inp]}, "
                  f"out={[f'{o.name}{o.shape}' for o in out]}")
    print(f"      {len(sessions)} sessions loaded in {time.time()-t0:.1f}s")
    print(f"      Note: cond_emb.onnx is called separately before diff_step_dml.onnx "
          f"(post-66d040d architecture)")

    # ---- Step 4: Run both pipelines and compare ----
    print("\n[4/4] Running pipelines...")
    print("-" * 70)

    # PyTorch reference
    print("\n  >>> PyTorch reference (model sub-steps)")
    t0 = time.time()
    try:
        pt_audio = run_pytorch_reference(
            model, data, args.n_steps, args.cfg, args.rescale_cfg,
            verbose=args.verbose)
    except Exception as e:
        print(f"  [ERROR] PyTorch reference failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(2)
    pt_time = time.time() - t0
    print(f"  PyTorch done in {pt_time:.1f}s, output shape: {pt_audio.shape}")

    clear_memory()

    # ONNX pipeline
    print("\n  >>> ONNX pipeline (8 models chained)")
    t0 = time.time()
    try:
        onnx_audio = run_onnx_pipeline(
            sessions, data, args.n_steps, args.cfg, args.rescale_cfg,
            verbose=args.verbose)
    except Exception as e:
        print(f"  [ERROR] ONNX pipeline failed: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(2)
    onnx_time = time.time() - t0
    print(f"  ONNX done in {onnx_time:.1f}s, output shape: {onnx_audio.shape}")

    # ---- Comparison ----
    print("\n" + "=" * 70)
    print("Comparison")
    print("=" * 70)

    m = compute_metrics(pt_audio, onnx_audio)
    passed = (m['cos'] >= COS_MIN) and (m['snr_db'] >= SNR_MIN_DB)

    print(f"  PT   shape: {list(pt_audio.shape)}, "
          f"mean={pt_audio.mean():.6f}, std={pt_audio.std():.6f}, "
          f"max_abs={np.abs(pt_audio).max():.6f}")
    print(f"  ONNX shape: {list(onnx_audio.shape)}, "
          f"mean={onnx_audio.mean():.6f}, std={onnx_audio.std():.6f}, "
          f"max_abs={np.abs(onnx_audio).max():.6f}")
    print()
    print(f"  MSE:  {m['mse']:.6e}")
    print(f"  RMSE: {m['rmse']:.6e}")
    print(f"  COS:  {m['cos']:.6f}  (threshold: {COS_MIN})")
    print(f"  SNR:  {m['snr_db']:.2f} dB  (threshold: {SNR_MIN_DB} dB)")
    print(f"\n  Status: {'PASS' if passed else 'FAIL'}")

    # ---- Per-stage diagnostics (if verbose) ----
    stage_results = {}
    if args.verbose:
        # Compare intermediate mel (diffusion output)
        # Re-run PyTorch to capture intermediate mel
        print("\n  [VERBOSE] Re-running PyTorch to capture intermediate mel...")
        torch.manual_seed(SEED)
        pt_wav = torch.from_numpy(data['pt_wav']).unsqueeze(0).float()
        pt_mel2note = torch.from_numpy(data['pt_mel2note']).unsqueeze(0)
        gt_mel2note = torch.from_numpy(data['gt_mel2note']).unsqueeze(0)
        pt_f0 = torch.from_numpy(data['pt_f0']).unsqueeze(0).float()
        gt_f0 = torch.from_numpy(data['gt_f0']).unsqueeze(0).float()
        pt_note_text = torch.from_numpy(data['pt_note_text']).unsqueeze(0)
        gt_note_text = torch.from_numpy(data['gt_note_text']).unsqueeze(0)
        pt_note_pitch = torch.from_numpy(data['pt_note_pitch']).unsqueeze(0)
        gt_note_pitch = torch.from_numpy(data['gt_note_pitch']).unsqueeze(0)
        pt_note_type = torch.from_numpy(data['pt_note_type']).unsqueeze(0)
        gt_note_type = torch.from_numpy(data['gt_note_type']).unsqueeze(0)
        len_prompt = pt_note_pitch.shape[1]
        len_prompt_mel = pt_f0.shape[1]

        with torch.no_grad():
            pt_mel_pt = model.mel(pt_wav.float())
            # Compare pt_mel: PyTorch vs ONNX mel_transform
            mel_onnx = sessions['mel_transform'].run(
                None, {get_input_name(sessions['mel_transform']): pt_wav.numpy()})[0]
            mel_metrics = compute_metrics(pt_mel_pt.numpy(), mel_onnx)
            stage_results['mel_transform'] = mel_metrics
            print(f"  [VERBOSE] mel_transform: COS={mel_metrics['cos']:.6f}, "
                  f"SNR={mel_metrics['snr_db']:.2f}dB")

    # ---- Save report ----
    report = {
        'timestamp': time.strftime('%Y-%m-%d %H:%M:%S'),
        'model_path': args.model_path,
        'onnx_dir': args.onnx_dir,
        'parameters': {
            'n_steps': args.n_steps,
            'cfg': args.cfg,
            'rescale_cfg': args.rescale_cfg,
            'seed': SEED,
        },
        'test_data': {
            'pt_mel_frames': data['pt_mel_frames'],
            'gt_mel_frames': data['gt_mel_frames'],
            'pt_token_count': data['pt_token_count'],
            'gt_token_count': data['gt_token_count'],
        },
        'onnx_models_used': list(onnx_files.keys()),
        'onnx_models_not_used_separately': [],
        'pytorch_output': {
            'shape': list(pt_audio.shape),
            'mean': float(pt_audio.mean()),
            'std': float(pt_audio.std()),
            'max_abs': float(np.abs(pt_audio).max()),
            'time_seconds': pt_time,
        },
        'onnx_output': {
            'shape': list(onnx_audio.shape),
            'mean': float(onnx_audio.mean()),
            'std': float(onnx_audio.std()),
            'max_abs': float(np.abs(onnx_audio).max()),
            'time_seconds': onnx_time,
        },
        'metrics': m,
        'thresholds': {'cos_min': COS_MIN, 'snr_min_db': SNR_MIN_DB},
        'passed': passed,
        'stage_results': stage_results,
        'notes': [
            'cond_emb.onnx is called separately before diff_step_dml.onnx '
            '(post-66d040d architecture). Input cond is 1024-dim cond_embedding.',
            'Flow-matching loop aligned with diffusion.js: t=(step+0.5)/n, '
            'uncond target-only, Bessel-corrected std (N-1), single epsilon.',
            'PyTorch vocoder uses VocosFullWrapper (same as ONNX export) for '
            'fair comparison — eliminates ISTFT implementation differences.',
            'Dynamic shape models: prompt 50 mel frames (1s audio) + target 200 mel '
            'frames (4s) = 250 total cond frames. No padding needed.',
            'Uncond branch uses zeros[1024] directly (matching JS pipeline post-66d040d), '
            'NOT cond_emb(zeros[512]) = bias[1024].',
        ],
    }

    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    print(f"\nReport saved: {args.output}")
    print(f"Status: {'PASS' if passed else 'FAIL'}")

    if not passed:
        sys.exit(1)


if __name__ == '__main__':
    main()
