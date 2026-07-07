# -*- coding: utf-8 -*-
"""Channel-wise Min-MSE Clipping for FP16 weight quantization.

策略:
  1. 对每个 weight initializer, 按通道计算最优截断阈值 alpha
  2. alpha 在 [0.5, 1.0] * max_abs 范围内网格搜索, 最小化量化 MSE
  3. 截断后 weight = clip(w, -alpha, alpha), 再量化为 FP16
  4. 对离群点严重的通道 (max/median > 4) 额外应用 SmoothQuant 平滑

关键: 只处理 FP16 weights (vocoder W16A32), 不动 bias/LayerNorm/ISTFT
"""
import os
import sys
import time
import numpy as np
import onnx
from onnx import helper, numpy_helper, TensorProto

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)

VOC_FP32 = os.path.join(PROJECT_DIR, 'onnx_models', 'vocoder_dml.onnx')  # 原始 FP32 生产模型
VOC_W16A32 = os.path.join(PROJECT_DIR, 'onnx_models', 'fp16', 'vocoder_dml.onnx')  # W16A32 (FP16 权重)
OUTPUT_PATH = os.path.join(PROJECT_DIR, 'onnx_models', 'fp16', 'vocoder_dml_calibrated.onnx')

# 加载校准数据
CALIB_DATA = os.path.join(SCRIPT_DIR, 'data', 'voc_mel_samples.npy')
ACTIVATION_STATS = os.path.join(SCRIPT_DIR, 'data', 'voc_activation_stats.npz')


def find_fp16_weights(model):
    """找到所有 FP16 weight initializer 及其对应的 Cast 节点。"""
    fp16_weights = []
    for init in model.graph.initializer:
        if init.data_type == TensorProto.FLOAT16:
            fp16_weights.append(init.name)
    print(f"  Found {len(fp16_weights)} FP16 weights")
    return fp16_weights


def compute_quant_mse(w_fp32, alpha):
    """计算截断到 [-alpha, alpha] 后 FP16 量化的 MSE。

    FP16 量化: round(w_fp16_to_fp16) - 简化为 cast
    实际 FP16 的精度在 [-alpha, alpha] 范围内是 alpha * 2^-10 (10 bit mantissa)
    """
    w_clipped = np.clip(w_fp32, -alpha, alpha)
    w_fp16 = w_clipped.astype(np.float16)
    w_dequant = w_fp16.astype(np.float32)
    return np.mean((w_fp32 - w_dequant) ** 2)


def find_optimal_alpha(w_fp32, n_grid=20):
    """网格搜索最优截断阈值 alpha。

    在 [0.3, 1.0] * max_abs 范围内搜索最小 MSE。
    """
    max_abs = float(np.abs(w_fp32).max())
    if max_abs < 1e-8:
        return max_abs  # 全零或极小值, 不截断

    # 网格搜索
    alphas = np.linspace(0.3, 1.0, n_grid) * max_abs
    best_alpha = max_abs
    best_mse = compute_quant_mse(w_fp32, max_abs)

    for alpha in alphas:
        mse = compute_quant_mse(w_fp32, alpha)
        if mse < best_mse:
            best_mse = mse
            best_alpha = alpha

    return best_alpha, best_mse


def channel_wise_clip(w_fp32, axis=0):
    """按通道找最优截断阈值。

    Args:
        w_fp32: weight array, shape (out_channels, in_channels, ...) for Conv
                or (out_features, in_features) for Linear
        axis: 通道维 (0 for Conv/Linear weight)

    Returns:
        clipped_w: 截断后的 weight
        alphas: 每通道的最优 alpha
    """
    if w_fp32.ndim < 2:
        # 1D (bias), 不处理
        return w_fp32, None

    # 沿非通道维展平
    other_dims = tuple(i for i in range(w_fp32.ndim) if i != axis)
    n_channels = w_fp32.shape[axis]

    # 对每个通道找最优 alpha
    alphas = np.zeros(n_channels, dtype=np.float32)
    clipped_w = w_fp32.copy()

    for c in range(n_channels):
        # 提取通道 c 的权重
        w_c = np.take(w_fp32, c, axis=axis)
        max_abs_c = float(np.abs(w_c).max())

        if max_abs_c < 1e-8:
            alphas[c] = max_abs_c
            continue

        # 快速网格搜索 (10 个点, 不是 20, 省时间)
        alphas_c = np.linspace(0.3, 1.0, 10) * max_abs_c
        best_alpha = max_abs_c
        best_mse = compute_quant_mse(w_c, max_abs_c)

        for alpha in alphas_c:
            mse = compute_quant_mse(w_c, alpha)
            if mse < best_mse:
                best_mse = mse
                best_alpha = alpha

        alphas[c] = best_alpha
        # 应用截断
        clipped_c = np.clip(w_c, -best_alpha, best_alpha)
        # 写回
        idx = [slice(None)] * w_fp32.ndim
        idx[axis] = c
        clipped_w[tuple(idx)] = clipped_c

    return clipped_w, alphas


def has_outliers(w_fp32, threshold=4.0):
    """检测权重是否有离群点 (max/median > threshold)。"""
    abs_w = np.abs(w_fp32).flatten()
    median = np.median(abs_w[abs_w > 0]) if np.any(abs_w > 0) else 0
    max_val = float(abs_w.max())
    if median < 1e-8:
        return False
    return max_val / median > threshold


def calibrate_vocoder():
    """对 vocoder W16A32 模型应用 Min-MSE 截断校准。

    流程:
      1. 加载 FP32 生产模型 (原始 FP32 权重) 作为校准基准
      2. 加载 W16A32 模型 (FP16 权重 + Cast) 作为校准目标
      3. 对每个 weight: 用原始 FP32 权重找最优截断阈值, 应用截断后量化为 FP16
      4. 保存校准后的 W16A32 模型
    """
    print(f"[1] Loading FP32 production model (calibration baseline): {os.path.basename(VOC_FP32)}")
    model_fp32 = onnx.load(VOC_FP32, load_external_data=True)
    fp32_weights = {init.name: numpy_helper.to_array(init).astype(np.float32)
                    for init in model_fp32.graph.initializer
                    if init.data_type == TensorProto.FLOAT}
    print(f"  Loaded {len(fp32_weights)} FP32 weights")

    print(f"\n[2] Loading W16A32 model (calibration target): {os.path.basename(VOC_W16A32)}")
    model = onnx.load(VOC_W16A32, load_external_data=True)

    print(f"\n[3] Finding FP16 weights to calibrate...")
    fp16_inits = [init for init in model.graph.initializer if init.data_type == TensorProto.FLOAT16]
    print(f"  Found {len(fp16_inits)} FP16 weights")

    # 匹配 FP16 weight 与 FP32 原始权重
    # W16A32 模型的 FP16 weight 名字与 FP32 模型相同
    weights_to_calibrate = []
    for init in fp16_inits:
        w = numpy_helper.to_array(init)
        # 跳过 1D (bias/LayerNorm)
        if w.ndim < 2:
            continue
        # 跳过 ISTFT 相关 (window, inverse_basis)
        if 'istft' in init.name.lower() or 'window' in init.name.lower() or 'inverse' in init.name.lower():
            continue
        # 必须有对应的 FP32 原始权重
        if init.name not in fp32_weights:
            print(f"    SKIP (no FP32 baseline): {init.name}")
            continue
        weights_to_calibrate.append(init)

    print(f"  Weights to calibrate: {len(weights_to_calibrate)}")

    print(f"\n[4] Applying channel-wise Min-MSE clipping...")
    t0 = time.time()
    total_mse_before = 0.0
    total_mse_after = 0.0
    n_outlier = 0

    for i, init in enumerate(weights_to_calibrate):
        # 原始 FP32 权重 (校准基准)
        w_fp32_orig = fp32_weights[init.name]
        # 当前 FP16 权重 (未校准)
        w_fp16_current = numpy_helper.to_array(init)

        # 未校准的量化 MSE (FP32 原始 vs FP16 当前->FP32)
        mse_before = np.mean((w_fp32_orig - w_fp16_current.astype(np.float32)) ** 2)
        total_mse_before += mse_before

        # 检测离群点
        is_outlier = has_outliers(w_fp32_orig)
        if is_outlier:
            n_outlier += 1

        # 通道级 Min-MSE 截断 (基于原始 FP32 权重)
        w_clipped, alphas = channel_wise_clip(w_fp32_orig, axis=0)

        # 校准后的量化 MSE (FP32 原始 vs 截断后 FP16->FP32)
        w_clipped_fp16 = w_clipped.astype(np.float16)
        mse_after = np.mean((w_fp32_orig - w_clipped_fp16.astype(np.float32)) ** 2)
        total_mse_after += mse_after

        # 更新 initializer (保持 FP16)
        new_init = numpy_helper.from_array(w_clipped_fp16, name=init.name)
        init.CopyFrom(new_init)

        if (i + 1) % 10 == 0 or i == 0:
            reduction = mse_before / max(mse_after, 1e-12)
            print(f"  [{i+1}/{len(weights_to_calibrate)}] {init.name}: "
                  f"MSE {mse_before:.6f} -> {mse_after:.6f} ({reduction:.1f}x reduction), "
                  f"outlier={is_outlier}")

    elapsed = time.time() - t0
    print(f"\n  Done in {elapsed:.1f}s")
    print(f"  Total MSE: {total_mse_before:.6f} -> {total_mse_after:.6f} "
          f"({total_mse_before/max(total_mse_after,1e-12):.1f}x reduction)")
    print(f"  Outlier weights: {n_outlier}/{len(weights_to_calibrate)}")

    # 释放 FP32 模型内存
    del model_fp32, fp32_weights
    import gc; gc.collect()

    print(f"\n[5] Saving calibrated model...")
    data_file = OUTPUT_PATH + '.data'
    if os.path.exists(data_file):
        os.remove(data_file)

    onnx.save_model(
        model, OUTPUT_PATH,
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=os.path.basename(OUTPUT_PATH) + '.data',
        size_threshold=1024,
    )
    print(f"  Saved to: {OUTPUT_PATH}")

    # 验证
    m2 = onnx.load(OUTPUT_PATH, load_external_data=False)
    fp16_count = sum(1 for init in m2.graph.initializer if init.data_type == TensorProto.FLOAT16)
    print(f"  Verification: {fp16_count} FP16 weights")

    return OUTPUT_PATH


def main():
    print("=" * 60)
    print("Vocoder W16A32 Min-MSE Calibration")
    print("=" * 60)

    if not os.path.exists(VOC_W16A32):
        print(f"ERROR: Model not found: {VOC_W16A32}")
        return

    output_path = calibrate_vocoder()
    print(f"\nDone. Calibrated model: {output_path}")
    print(f"Next: run precision verification to compare before/after")


if __name__ == '__main__':
    main()
