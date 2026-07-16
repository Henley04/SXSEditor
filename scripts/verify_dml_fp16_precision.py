# -*- coding: utf-8 -*-
"""用 DML Execution Provider 验证 FP16 diffStep 和 vocoder 的真实精度。

关键：onnxruntime CPU EP 对 FP16 输入会自动 promote 到 FP32 计算，
所以 CPU 上的 FP16 测试不能反映 DML 后端的真实 FP16 精度。
必须用 DML EP 才能测到生产环境的真实精度。

用法：
    python scripts/verify_dml_fp16_precision.py
"""
import os
import sys
import time
import numpy as np
import torch

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, PROJECT_DIR)


def create_dml_session(model_path):
    """创建 DML EP session（FP16 模型在 DML 上会真正用 FP16 计算）。"""
    import onnxruntime as ort

    sess_options = ort.SessionOptions()
    sess_options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL

    session = ort.InferenceSession(
        model_path,
        sess_options=sess_options,
        providers=['DmlExecutionProvider', 'CPUExecutionProvider'],
    )
    return session


def main():
    print("=" * 60)
    print("DML EP 真实 FP16 精度验证（diffStep + vocoder）")
    print("=" * 60)

    # 1. 加载 PyTorch 模型
    print("\n[1] Loading SoulX-Singer PyTorch model...")
    t0 = time.time()
    from export_shared import load_config, load_model, clear_memory

    config = load_config()
    model_path = os.path.join(PROJECT_DIR, 'SoulX-Singer', 'pretrained_models', 'SoulX-Singer', 'model.pt')
    model = load_model(config, model_path)
    model.eval()
    diff_estimator = model.cfm_decoder.model.diff_estimator
    vocos_pt = model.vocoder.model
    print(f"    Loaded in {time.time()-t0:.1f}s")

    # 2. 创建 DML sessions
    print("\n[2] Creating DML sessions...")
    import onnxruntime as ort

    fp32_diff = create_dml_session(os.path.join(PROJECT_DIR, 'onnx_models', 'diff_step_dml.onnx'))
    fp16_diff = create_dml_session(os.path.join(PROJECT_DIR, 'onnx_models', 'fp16', 'diff_step_dml.onnx'))
    fp32_voc = create_dml_session(os.path.join(PROJECT_DIR, 'onnx_models', 'vocoder_dml.onnx'))
    fp16_voc = create_dml_session(os.path.join(PROJECT_DIR, 'onnx_models', 'fp16', 'vocoder_dml.onnx'))
    print("    All DML sessions created")

    # 3. diffStep 单步精度测试
    print("\n[3] diffStep single-step precision (DML EP)...")
    seq_len = 200
    torch.manual_seed(42)
    np.random.seed(42)

    xt_input = torch.randn(1, seq_len, 128)
    t = torch.tensor([0.5])
    cond = torch.randn(1, seq_len, 1024)
    xt_mask = torch.ones(1, seq_len)

    # PyTorch 参考
    with torch.no_grad():
        flow_pt = diff_estimator(xt_input, t, cond, xt_mask)
    flow_pt_np = flow_pt.numpy().astype(np.float32)

    # FP32 DML
    feeds32 = {
        'xt_input': xt_input.numpy().astype(np.float32),
        't': t.numpy().astype(np.float32),
        'cond': cond.numpy().astype(np.float32),
        'xt_mask': xt_mask.numpy().astype(np.float32),
    }
    flow_fp32 = fp32_diff.run(['flow_pred'], feeds32)[0].astype(np.float32)

    # FP16 DML
    feeds16 = {
        'xt_input': xt_input.numpy().astype(np.float16),
        't': t.numpy().astype(np.float16),
        'cond': cond.numpy().astype(np.float16),
        'xt_mask': xt_mask.numpy().astype(np.float16),
    }
    flow_fp16 = fp16_diff.run(['flow_pred'], feeds16)[0].astype(np.float32)

    def stats(name, ref, cand):
        ref = ref.reshape(-1)
        cand = cand.reshape(-1)
        n = min(len(ref), len(cand))
        ref, cand = ref[:n], cand[:n]
        diff = ref - cand
        l1 = float(np.mean(np.abs(diff)))
        cos = float(np.sum(ref * cand) / (np.linalg.norm(ref) * np.linalg.norm(cand) + 1e-8))
        mse = float(np.mean(diff ** 2))
        print(f"  [{name}] L1={l1:.6f}, MSE={mse:.8f}, Cosine={cos:.6f}")

    stats("PyTorch vs FP32 DML", flow_pt_np, flow_fp32)
    stats("PyTorch vs FP16 DML", flow_pt_np, flow_fp16)
    stats("FP32 DML vs FP16 DML", flow_fp32, flow_fp16)

    # 4. vocoder 精度测试
    print("\n[4] vocoder precision (DML EP)...")
    voc_seq_len = 100
    mel_pt = torch.randn(1, voc_seq_len, 128) * 2.85 + (-4.92)
    mel_np = mel_pt.numpy().astype(np.float32)

    # PyTorch 参考
    with torch.no_grad():
        audio_pt = vocos_pt(mel_pt.transpose(1, 2))
        if audio_pt.dim() == 3:
            audio_pt = audio_pt.squeeze(1)
    audio_pt_np = audio_pt.numpy().astype(np.float32).reshape(-1)

    # FP32 DML
    audio_fp32 = fp32_voc.run(['waveform'], {'mel': mel_np})[0].astype(np.float32).reshape(-1)

    # FP16 DML
    audio_fp16 = fp16_voc.run(['waveform'], {'mel': mel_np.astype(np.float16)})[0].astype(np.float32).reshape(-1)

    n = min(len(audio_pt_np), len(audio_fp32), len(audio_fp16))
    audio_pt_np = audio_pt_np[:n]
    audio_fp32 = audio_fp32[:n]
    audio_fp16 = audio_fp16[:n]

    stats("Vocoder: PyTorch vs FP32 DML", audio_pt_np, audio_fp32)
    stats("Vocoder: PyTorch vs FP16 DML", audio_pt_np, audio_fp16)
    stats("Vocoder: FP32 DML vs FP16 DML", audio_fp32, audio_fp16)

    # 5. 详细分析 FP16 vs FP32 的差异分布
    print("\n[5] Detailed diffStep FP16 vs FP32 analysis (DML EP)...")
    diff = (flow_fp32 - flow_fp16).reshape(-1)
    print(f"  diff mean={diff.mean():.6f}, std={diff.std():.6f}")
    print(f"  diff abs mean={np.abs(diff).mean():.6f}, max={np.abs(diff).max():.6f}")
    print(f"  diff p50={np.percentile(np.abs(diff), 50):.6f}, p99={np.percentile(np.abs(diff), 99):.6f}")
    # 找出差异最大的位置
    abs_diff = np.abs(diff).reshape(-1)
    top_k = 10
    top_idx = np.argsort(abs_diff)[-top_k:][::-1]
    print(f"  Top {top_k} 最大差异位置：")
    for idx in top_idx:
        frame = idx // 128
        dim = idx % 128
        print(f"    frame={frame}, dim={dim}: FP32={flow_fp32.reshape(-1)[idx]:.6f}, "
              f"FP16={flow_fp16.reshape(-1)[idx]:.6f}, diff={diff.reshape(-1)[idx]:.6f}")

    # 6. 多 timestep 测试
    print("\n[6] Multi-timestep diffStep FP16 vs FP32 (DML EP)...")
    for t_val in [0.1, 0.3, 0.5, 0.7, 0.9]:
        feeds32['t'] = np.array([t_val], dtype=np.float32)
        feeds16['t'] = np.array([t_val], dtype=np.float16)
        f32 = fp32_diff.run(['flow_pred'], feeds32)[0].astype(np.float32)
        f16 = fp16_diff.run(['flow_pred'], feeds16)[0].astype(np.float32)
        d = f32 - f16
        l1 = float(np.mean(np.abs(d)))
        cos = float(np.sum(f32 * f16) / (np.linalg.norm(f32) * np.linalg.norm(f16) + 1e-8))
        print(f"  t={t_val}: FP32vsFP16 L1={l1:.6f}, Cosine={cos:.6f}")

    # 清理
    del model, fp32_diff, fp16_diff, fp32_voc, fp16_voc
    clear_memory()
    print("\nDone.")


if __name__ == '__main__':
    main()
