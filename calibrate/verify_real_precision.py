# -*- coding: utf-8 -*-
"""Verify W16A32 vs FP32 precision on REAL mel data (from example audio).

目的:
  1. 用 example 音频提取真实 mel
  2. 对比 W16A32 vs FP32 vocoder 的输出差异
  3. 如果差异大 → Cast 没生效, DML EP 在用 FP16 计算
  4. 如果差异小 → W16A32 工作正常, 无需校准
"""
import os
import sys
import numpy as np
import torch
import onnxruntime as ort

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, PROJECT_DIR)
sys.path.insert(0, os.path.join(PROJECT_DIR, 'SoulX-Singer'))

from export_shared import load_config, load_model, clear_memory

VOC_FP32 = os.path.join(PROJECT_DIR, 'onnx_models', 'vocoder_dml.onnx')
VOC_W16A32 = os.path.join(PROJECT_DIR, 'onnx_models', 'fp16', 'vocoder_dml.onnx')
EXAMPLE_DIR = os.path.join(PROJECT_DIR, 'SoulX-Singer', 'example', 'audio')


def extract_real_mels(n=5, seq_len=200):
    """从 example 音频提取真实 mel。"""
    config = load_config()
    model_path = os.path.join(PROJECT_DIR, 'SoulX-Singer', 'pretrained_models', 'SoulX-Singer', 'model.pt')
    model = load_model(config, model_path)
    model.eval()

    mels = []
    import soundfile as sf
    for f in sorted(os.listdir(EXAMPLE_DIR)):
        if not f.endswith('.mp3'):
            continue
        if len(mels) >= n:
            break
        wav_path = os.path.join(EXAMPLE_DIR, f)
        try:
            wav, sr = sf.read(wav_path)
            if sr == 48000:
                wav = wav[::2]
                sr = 24000
            if sr != 24000:
                continue
            if len(wav.shape) > 1:
                wav = wav.mean(axis=1)
            wav_t = torch.from_numpy(wav.astype(np.float32)).unsqueeze(0)
            with torch.no_grad():
                mel = model.mel(wav_t)  # (1, 128, T) or (1, T, 128)
            mel = mel.squeeze(0).cpu().float().numpy()
            if mel.shape[0] == 128:
                mel = mel.T  # (T, 128)
            # 取前 seq_len 帧
            if mel.shape[0] >= seq_len:
                mels.append(mel[:seq_len])
                print(f"  {f}: mel shape={mel.shape}, took first {seq_len} frames")
        except Exception as e:
            print(f"  {f}: SKIP - {e}")

    del model
    clear_memory()
    return mels


def run_vocoder(model_path, mel_np, use_fp16_input=False):
    """运行 vocoder, 返回音频输出。"""
    sess_options = ort.SessionOptions()
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    sess = ort.InferenceSession(
        model_path, sess_options=sess_options,
        providers=['DmlExecutionProvider', 'CPUExecutionProvider']
    )

    # 检查模型输入类型
    input_dtype = sess.get_inputs()[0].type
    if 'float16' in str(input_dtype) or use_fp16_input:
        mel = mel_np.astype(np.float16)
    else:
        mel = mel_np.astype(np.float32)

    # vocoder 输入是 (1, T, 128) -> 需要 (1, 128, T)? 检查
    # VocoderBackboneWrapper.forward(mel) 期望 (B, T, 128), 内部 transpose
    mel_input = mel.reshape(1, *mel.shape)  # (1, T, 128)
    output = sess.run(None, {'mel': mel_input})[0]
    del sess
    return output.astype(np.float32)


def main():
    print("=" * 60)
    print("Real Mel Precision Verification (W16A32 vs FP32)")
    print("=" * 60)

    print("\n[1] Extracting real mel from example audio...")
    mels = extract_real_mels(n=5, seq_len=200)
    if not mels:
        print("ERROR: No mel extracted")
        return
    print(f"  Extracted {len(mels)} mel samples, shape={mels[0].shape}")
    print(f"  mel stats: mean={np.mean(mels):.4f}, std={np.std(mels):.4f}, "
          f"min={np.min(mels):.4f}, max={np.max(mels):.4f}")

    print("\n[2] Running FP32 vocoder...")
    fp32_outputs = []
    for i, mel in enumerate(mels):
        out = run_vocoder(VOC_FP32, mel, use_fp16_input=False)
        fp32_outputs.append(out)
        print(f"  [{i+1}] output shape={out.shape}, mean={out.mean():.6f}, std={out.std():.6f}")

    print("\n[3] Running W16A32 vocoder (FP16 input)...")
    w16a32_outputs = []
    for i, mel in enumerate(mels):
        out = run_vocoder(VOC_W16A32, mel, use_fp16_input=True)
        w16a32_outputs.append(out)
        print(f"  [{i+1}] output shape={out.shape}, mean={out.mean():.6f}, std={out.std():.6f}")

    print("\n[4] Comparison:")
    for i in range(len(mels)):
        ref = fp32_outputs[i].flatten()
        cand = w16a32_outputs[i].flatten()
        n = min(len(ref), len(cand))
        ref, cand = ref[:n], cand[:n]
        diff = ref - cand
        mse = float(np.mean(diff ** 2))
        l1 = float(np.mean(np.abs(diff)))
        ref_e = float(np.sum(ref ** 2)) + 1e-12
        err_e = float(np.sum(diff ** 2)) + 1e-12
        snr = 10 * np.log10(ref_e / err_e)
        cos = float(np.sum(ref * cand) / (np.linalg.norm(ref) * np.linalg.norm(cand) + 1e-8))
        print(f"  [{i+1}] SNR={snr:.2f} dB, Cosine={cos:.6f}, MSE={mse:.8f}, L1={l1:.6f}")

    # 分析高频段差异 (清擦音集中在高频)
    print("\n[5] High-frequency analysis (last 25% of spectrum):")
    for i in range(min(2, len(mels))):
        ref = fp32_outputs[i].flatten()
        cand = w16a32_outputs[i].flatten()
        n = min(len(ref), len(cand))
        ref, cand = ref[:n], cand[:n]
        # 简单的高频分析: 取后半部分样本
        h_start = n // 2
        ref_h = ref[h_start:]
        cand_h = cand[h_start:]
        diff_h = ref_h - cand_h
        mse_h = float(np.mean(diff_h ** 2))
        l1_h = float(np.mean(np.abs(diff_h)))
        ref_e_h = float(np.sum(ref_h ** 2)) + 1e-12
        err_e_h = float(np.sum(diff_h ** 2)) + 1e-12
        snr_h = 10 * np.log10(ref_e_h / err_e_h)
        cos_h = float(np.sum(ref_h * cand_h) / (np.linalg.norm(ref_h) * np.linalg.norm(cand_h) + 1e-8))
        print(f"  [{i+1}] High-freq: SNR={snr_h:.2f} dB, Cosine={cos_h:.6f}, MSE={mse_h:.8f}")


if __name__ == '__main__':
    main()
