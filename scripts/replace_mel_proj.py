# -*- coding: utf-8 -*-
"""替换 SiFiGAN ONNX 模型中的 mel_proj 权重，并设置 feat_mean=0, feat_scale=1。

替换内容：
  1. onnx::MatMul_1586 (128, 43) ← 训练得到的 mel_proj 权重（转置）
     - PyTorch nn.Linear(128, 43).weight shape = (43, 128) = (out, in)
     - ONNX MatMul 权重 shape = (128, 43) = (in, out)
     - 替换时：W_onnx = W_pytorch.T
  2. feat_mean (43,) ← 全 0（mel_proj 已输出归一化特征）
  3. feat_scale (43,) ← 全 1（跳过归一化，generator 直接接收归一化输入）

备份原模型到 *_backup.onnx。
"""
import os
import sys
import shutil
import numpy as np
import onnx
from onnx import numpy_helper, helper

ONNX_PATH = r"D:\Document\electron\SXSEditor\onnx_models\sifigan_vocoder_dml.onnx"
WEIGHT_PATH = r"D:\Document\electron\SXSEditor\scripts\mel_proj_train_output\mel_proj_weight.npy"
BACKUP_PATH = r"D:\Document\electron\SXSEditor\onnx_models\sifigan_vocoder_dml_backup.onnx"
OUTPUT_PATH = ONNX_PATH  # 原地替换（已备份）


def main():
    if not os.path.exists(WEIGHT_PATH):
        print(f"[ERROR] Weight file not found: {WEIGHT_PATH}")
        print("        Run train_mel_proj.py first.")
        sys.exit(1)

    # 加载训练好的权重
    W_pytorch = np.load(WEIGHT_PATH)  # (43, 128)
    print(f"[1] Loaded mel_proj weight: shape={W_pytorch.shape}, "
          f"range=[{W_pytorch.min():.4f}, {W_pytorch.max():.4f}]")

    # 转置为 ONNX MatMul 格式 (128, 43) = (in, out)
    W_onnx = W_pytorch.T.astype(np.float32)
    print(f"    Transposed for ONNX: shape={W_onnx.shape}")

    # 加载 ONNX 模型
    print(f"\n[2] Loading ONNX: {ONNX_PATH}")
    model = onnx.load(ONNX_PATH)

    # 备份
    if not os.path.exists(BACKUP_PATH):
        print(f"    Backup original to: {BACKUP_PATH}")
        shutil.copy2(ONNX_PATH, BACKUP_PATH)
    else:
        print(f"    Backup already exists: {BACKUP_PATH}")

    # 替换 initializer
    replaced = {}
    for init in model.graph.initializer:
        if init.name == "onnx::MatMul_1586":
            # 验证 shape
            assert list(init.dims) == [128, 43], f"Unexpected mel_proj shape: {list(init.dims)}"
            new_arr = numpy_helper.from_array(W_onnx, name=init.name)
            init.CopyFrom(new_arr)
            replaced[init.name] = "mel_proj weight"
        elif init.name == "feat_mean":
            assert list(init.dims) == [43], f"Unexpected feat_mean shape: {list(init.dims)}"
            new_arr = numpy_helper.from_array(np.zeros(43, dtype=np.float32), name=init.name)
            init.CopyFrom(new_arr)
            replaced[init.name] = "feat_mean (zeros)"
        elif init.name == "feat_scale":
            assert list(init.dims) == [43], f"Unexpected feat_scale shape: {list(init.dims)}"
            new_arr = numpy_helper.from_array(np.ones(43, dtype=np.float32), name=init.name)
            init.CopyFrom(new_arr)
            replaced[init.name] = "feat_scale (ones)"

    print(f"\n[3] Replaced initializers:")
    for name, desc in replaced.items():
        print(f"    {name}: {desc}")

    if len(replaced) != 3:
        print(f"\n[ERROR] Expected 3 replacements, got {len(replaced)}")
        sys.exit(1)

    # 验证模型完整性
    print(f"\n[4] Validating ONNX model...")
    try:
        onnx.checker.check_model(model)
        print(f"    ONNX check passed")
    except Exception as e:
        print(f"    [WARN] ONNX check failed: {e}")

    # 保存
    print(f"\n[5] Saving to: {OUTPUT_PATH}")
    onnx.save(model, OUTPUT_PATH)

    # 验证保存后的模型
    print(f"\n[6] Verifying saved model...")
    model2 = onnx.load(OUTPUT_PATH)
    for init in model2.graph.initializer:
        if init.name in ("onnx::MatMul_1586", "feat_mean", "feat_scale"):
            arr = numpy_helper.to_array(init)
            print(f"    {init.name}: shape={list(init.dims)}, "
                  f"range=[{arr.min():.4f}, {arr.max():.4f}], mean={arr.mean():.4f}")

    print(f"\n[7] Done!")
    print(f"    Original backup: {BACKUP_PATH}")
    print(f"    Updated model: {OUTPUT_PATH}")
    print(f"    Next: run diagnose_sifigan.js to verify audio quality")


if __name__ == "__main__":
    main()
