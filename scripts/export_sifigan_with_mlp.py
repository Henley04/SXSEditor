# -*- coding: utf-8 -*-
"""用训练好的 MLP mel_proj 重新导出 SiFiGAN ONNX 模型。

复用 export_sifigan_vocoder.py 的 SiFiGAN Generator 加载逻辑，
但用 MelProjMLP (128->256->256->43) 替换原线性 mel_proj。

关键改动:
  1. mel_proj = MelProjMLP(128, 256, 256, 43) 加载训练权重
  2. feat_mean = 0, feat_scale = 1 (MLP 已输出归一化特征)
  3. forward 中跳过 (c - mean) / scale 步骤

输出:
  d:\Document\electron\SXSEditor\onnx_models\sifigan_vocoder_dml_mlp.onnx
  d:\Document\electron\SXSEditor\onnx_models\sifigan_vocoder_dml_mlp.onnx.data
"""
import os
import sys
import time
import argparse
import torch
import torch.nn as nn
import numpy as np

# 添加项目根目录到 sys.path (复用 export_sifigan_vocoder.py 的工具)
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, PROJECT_DIR)

# 导入训练脚本中的 MelProjMLP
sys.path.insert(0, SCRIPT_DIR)
from train_mel_proj_mlp import MelProjMLP, SVS_NUM_MELS, TOTAL_DIM, HIDDEN_DIM, DROPOUT

# 导入 export_sifigan_vocoder.py 的工具
from export_sifigan_vocoder import (
    SIFIGAN_GENERATOR_CONFIG,
    SAMPLE_RATE,
    HOP_SIZE,
    UPSAMPLE_SCALES,
    DENSE_FACTORS,
    SINE_AMP,
    CUMPROD_SCALES,
    MEL_DIM,
    SIFIGAN_DIR_DEFAULT,
    check_sifigan_repo,
    patch_omegaconf,
    load_sifigan_generator,
    export_onnx,
    validate_onnx,
)

# 训练好的 MLP 权重路径
MLP_WEIGHT_PATH = os.path.join(
    PROJECT_DIR, "scripts", "mel_proj_train_output", "mel_proj_mlp.pt"
)
# 输出 ONNX 路径
OUTPUT_ONNX = os.path.join(PROJECT_DIR, "onnx_models", "sifigan_vocoder_dml_mlp.onnx")


class SiFiGANMLPWrapper(torch.nn.Module):
    """SiFiGAN Generator 包装器，用 MLP 替换线性 mel_proj。

    与原 SiFiGANVocoderWrapper 的差异:
      1. mel_proj = MelProjMLP(128->256->256->43) 加载训练权重
      2. feat_mean = 0, feat_scale = 1 (MLP 直接输出归一化特征)
      3. forward 中跳过 (c - mean) / scale 步骤
    """

    def __init__(self, generator, mlp_state_dict, mlp_config):
        super().__init__()
        self.generator = generator

        # 用训练好的 MLP 替换线性 mel_proj
        self.mel_proj = MelProjMLP(
            in_dim=mlp_config["in_dim"],
            hidden_dim=mlp_config["hidden_dim"],
            out_dim=mlp_config["out_dim"],
            dropout=mlp_config["dropout"],
        )
        # 加载训练权重，并移除 Dropout (推理时不需要)
        self.mel_proj.load_state_dict(mlp_state_dict)
        self.mel_proj.eval()
        # 推理时关闭 dropout
        for m in self.mel_proj.modules():
            if isinstance(m, nn.Dropout):
                m.p = 0.0

        # feat_mean=0, feat_scale=1 (MLP 已输出归一化特征)
        in_channels = SIFIGAN_GENERATOR_CONFIG["in_channels"]
        self.register_buffer("feat_mean", torch.zeros(in_channels))
        self.register_buffer("feat_scale", torch.ones(in_channels))

    def _generate_sine_signal(self, f0):
        """由 F0 生成正弦激励信号 (与原版一致)。"""
        B, _, T = f0.shape
        T_audio = T * HOP_SIZE

        vuv = (f0 > 0).to(torch.float32)
        vuv = torch.nn.functional.interpolate(vuv, size=T_audio, mode="nearest")

        f0_interp = torch.nn.functional.interpolate(
            f0.to(torch.float32), size=T_audio, mode="nearest"
        )

        radious = (f0_interp / SAMPLE_RATE) % 1.0
        phase = torch.cumsum(radious, dim=2) * (2.0 * 3.141592653589793)
        sine = vuv * torch.sin(phase) * SINE_AMP

        return sine

    def _compute_dense_factors(self, f0):
        """计算 pitch-dependent 密集因子 (与原版一致)。"""
        dfs = []
        for df_val, repeat_times in zip(DENSE_FACTORS, CUMPROD_SCALES):
            default_f0 = float(SAMPLE_RATE / df_val)
            safe_f0 = torch.where(
                f0 > 0,
                f0,
                torch.full_like(f0, default_f0),
            )
            df = SAMPLE_RATE / df_val / safe_f0
            df_repeated = torch.repeat_interleave(df, repeat_times, dim=2)
            dfs.append(df_repeated)
        return dfs

    def forward(self, mel, f0):
        """前向传播。

        Args:
            mel: (B, T, 128) float32 - mel 频谱
            f0:  (B, T, 1)   float32 - F0 曲线

        Returns:
            waveform: (B, 1, T_audio) float32 - 24kHz 音频
        """
        # 1. mel -> MLP 投影 (直接输出归一化特征，无需再 (x-mean)/scale)
        c = self.mel_proj(mel)  # (B, T, 43)

        # 2. 转置为 (B, in_channels, T)
        c = c.transpose(1, 2)  # (B, 43, T)

        # 3. 准备 f0: (B, T, 1) -> (B, 1, T)
        f0 = f0.transpose(1, 2)

        # 4. 生成正弦激励信号
        in_signal = self._generate_sine_signal(f0)

        # 5. 计算密集因子
        dfs = self._compute_dense_factors(f0)

        # 6. 调用 SiFiGAN Generator
        outs = self.generator(in_signal, c, dfs)
        waveform = outs[0]

        return waveform


def main():
    parser = argparse.ArgumentParser(
        description="用 MLP mel_proj 重新导出 SiFiGAN ONNX"
    )
    parser.add_argument(
        "--checkpoint",
        default=r"D:\download\model+stats\sifigan_libritts-r-clean+nus-48e_checkpoint-1000000steps.pkl",
        help="SiFiGAN 检查点文件路径",
    )
    parser.add_argument(
        "--sifigan-dir",
        default=SIFIGAN_DIR_DEFAULT,
        help="SiFiGAN 源码仓库目录",
    )
    parser.add_argument(
        "--mlp-weight",
        default=MLP_WEIGHT_PATH,
        help="训练好的 MLP 权重路径 (.pt)",
    )
    parser.add_argument(
        "--out",
        default=OUTPUT_ONNX,
        help="输出 ONNX 文件路径",
    )
    parser.add_argument(
        "--seq-len",
        type=int,
        default=50,
        help="导出和验证用的探针帧数",
    )
    parser.add_argument(
        "--skip-validation",
        action="store_true",
        help="跳过精度验证",
    )
    args = parser.parse_args()

    # 1. 检查 SiFiGAN 源码
    check_sifigan_repo(args.sifigan_dir)

    # 2. 注入 omegaconf 补丁
    patch_omegaconf()

    # 3. 添加 SiFiGAN 到 sys.path
    sys.path.insert(0, args.sifigan_dir)

    # 内存清理工具
    try:
        from export_shared import clear_memory
    except ImportError:
        def clear_memory():
            import gc
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            gc.collect()

    print("=" * 60)
    print("SiFiGAN Vocoder ONNX export (MLP mel_proj)")
    print("=" * 60)
    print(f"  Checkpoint:     {args.checkpoint}")
    print(f"  MLP weight:     {args.mlp_weight}")
    print(f"  SiFiGAN source: {args.sifigan_dir}")
    print(f"  Output:         {args.out}")

    t0 = time.time()

    # 4. 加载 MLP 权重
    print("\n[1/4] Loading MLP weight...")
    if not os.path.isfile(args.mlp_weight):
        print(f"[ERROR] MLP weight not found: {args.mlp_weight}")
        print("        Please run train_mel_proj_mlp.py --full first")
        sys.exit(1)
    ckpt = torch.load(args.mlp_weight, map_location="cpu", weights_only=False)
    mlp_state_dict = ckpt["state_dict"]
    mlp_config = ckpt["config"]
    best_loss = ckpt.get("best_loss", float("nan"))
    print(f"  MLP config: {mlp_config}")
    print(f"  Best train loss: {best_loss:.6f}")
    n_mlp_params = sum(p.numel() for p in mlp_state_dict.values())
    print(f"  MLP parameters: {n_mlp_params} ({n_mlp_params/1e3:.1f}K)")

    # 5. 加载 SiFiGAN Generator
    print("\n[2/4] Loading SiFiGAN Generator...")
    generator = load_sifigan_generator(args.sifigan_dir, args.checkpoint)
    param_count = sum(p.numel() for p in generator.parameters()) / 1e6
    print(f"  Generator parameters: {param_count:.1f}M")

    # 6. 构建 MLP Wrapper
    print("\n[3/4] Building SiFiGANMLPWrapper...")
    wrapper = SiFiGANMLPWrapper(generator, mlp_state_dict, mlp_config).eval()
    total_params = sum(p.numel() for p in wrapper.parameters()) / 1e6
    print(f"  Wrapper total parameters: {total_params:.1f}M")
    print(f"  mel_proj: MLP ({mlp_config['in_dim']}->{mlp_config['hidden_dim']}"
          f"->{mlp_config['hidden_dim']}->{mlp_config['out_dim']})")
    print(f"  feat_mean: zeros (MLP outputs normalized features)")
    print(f"  feat_scale: ones")

    # 7. ONNX 导出
    print("\n[4/4] ONNX export...")
    output_path = export_onnx(wrapper, args.out, seq_len=args.seq_len)

    # 8. 精度验证
    if not args.skip_validation:
        passed = validate_onnx(wrapper, output_path, seq_len=args.seq_len)
        if not passed:
            print("\n[ERROR] Accuracy verification failed")
            sys.exit(1)
    else:
        print("\n[SKIP] Accuracy verification skipped")

    # 9. 释放内存
    del wrapper, generator
    clear_memory()

    elapsed = time.time() - t0
    print(f"\n{'='*60}")
    print(f"Export complete! Elapsed {elapsed:.1f}s")
    print(f"  ONNX model:       {output_path}")
    print(f"  External data:    {output_path}.data")
    print(f"{'='*60}")
    print(f"\nNext step: replace sifigan_vocoder_dml.onnx with the MLP version")
    print(f"  Copy {os.path.basename(output_path)} -> sifigan_vocoder_dml.onnx")
    print(f"  (or update SIFIGAN_MODEL_FILES in src/inference/pipeline/constants.js)")


if __name__ == "__main__":
    main()
