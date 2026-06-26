# -*- coding: utf-8 -*-
"""SiFiGAN vocoder ONNX 导出脚本。

将 SiFiGAN (Source-Filter HiFi-GAN, ICASSP 2023) 预训练模型导出为 ONNX 格式，
作为 SVS 管线的可选替代 vocoder。

SiFiGAN 官方仓库: https://github.com/chomeyama/SiFiGAN

模型结构要点:
  - SiFiGANGenerator.forward(x, c, d) 接收三个输入:
      x: 正弦激励信号 (B, 1, T_audio)
      c: 声学特征 (B, in_channels=43, T_frames)  [mcep(40) + bap(3)]
      d: 4 个 pitch-dependent 密集因子列表 [(B, 1, T_layer)]
  - 采样率 24000Hz, hop_size=120, frame_period=5ms
  - upsample_scales=(5,4,3,2), 累积乘积 [5,20,60,120]

本脚本提供 SiFiGANVocoderWrapper，将 SVS 管线的 (mel, f0) 接口适配到
SiFiGAN Generator 的 (in_signal, c, dfs) 接口。

参考:
  - export_step2_vocoder.py: 现有 vocoder 导出风格
  - export_shared.py: 共享工具函数
"""

import os
import sys
import argparse
import time
import types

# ============================================================
# 1. 检查 SiFiGAN 源码仓库
# ============================================================
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SIFIGAN_DIR_DEFAULT = os.path.join(SCRIPT_DIR, "third_party", "SiFiGAN")


def check_sifigan_repo(sifigan_dir):
    """检查 SiFiGAN 源码是否存在，不存在则给出提示并退出。"""
    init_path = os.path.join(sifigan_dir, "sifigan", "__init__.py")
    if not os.path.isfile(init_path):
        print(f"[ERROR] 未找到 SiFiGAN 源码: {sifigan_dir}")
        print(f"请先克隆仓库:")
        print(f"  git clone https://github.com/chomeyama/SiFiGAN {sifigan_dir}")
        sys.exit(1)


# ============================================================
# 2. omegaconf 兼容补丁 (与 export_shared.py 风格一致)
# ============================================================

class _DictConfig(dict):
    """轻量级 omegaconf.DictConfig 替代，支持属性访问。"""

    def __getattr__(self, name):
        try:
            val = self[name]
            return _DictConfig(val) if isinstance(val, dict) else val
        except KeyError:
            raise AttributeError(name)

    def __setattr__(self, name, value):
        self[name] = value

    def __contains__(self, key):
        return key in self


def patch_omegaconf():
    """如果 omegaconf 未安装，注入轻量替代模块。"""
    try:
        import omegaconf  # noqa: F401
    except ImportError:
        mod = types.ModuleType("omegaconf")
        mod.DictConfig = _DictConfig
        sys.modules["omegaconf"] = mod


# ============================================================
# 3. SiFiGAN 配置常量
#    来源: sifigan/bin/config/generator/sifigan.yaml
#         sifigan/bin/config/data/libritts-r-clean+nus-48e.yaml
#         sifigan/bin/config/train/sifigan_1000k.yaml
#         sifigan/bin/config/anasyn.yaml
# ============================================================

# --- 模型超参数 (generator/sifigan.yaml) ---
SIFIGAN_GENERATOR_CONFIG = {
    "in_channels": 43,               # mcep(40) + bap(3)
    "out_channels": 1,
    "channels": 512,
    "kernel_size": 7,
    "upsample_scales": (5, 4, 3, 2),
    "upsample_kernel_sizes": (10, 8, 6, 4),
    "source_network_params": {
        "resblock_kernel_size": 3,
        "resblock_dilations": [(1,), (1, 2), (1, 2, 4), (1, 2, 4, 8)],
        "use_additional_convs": True,
    },
    "filter_network_params": {
        "resblock_kernel_sizes": (3, 5, 7),
        "resblock_dilations": [(1, 3, 5), (1, 3, 5), (1, 3, 5)],
        "use_additional_convs": False,
    },
    "share_upsamples": False,
    "share_downsamples": False,
    "bias": True,
    "nonlinear_activation": "LeakyReLU",
    "nonlinear_activation_params": {"negative_slope": 0.1},
    "use_weight_norm": True,
}

# --- 数据超参数 (data/libritts-r-clean+nus-48e.yaml + anasyn.yaml) ---
SAMPLE_RATE = 24000
HOP_SIZE = 120                         # = sample_rate * frame_period(5ms) * 0.001
UPSAMPLE_SCALES = (5, 4, 3, 2)
DENSE_FACTORS = [0.5, 1, 4, 8]        # 每个上采样层的密集因子
SINE_AMP = 0.1
NOISE_AMP = 0.003                      # 注意: ONNX 导出时跳过随机噪声
AUX_FEATS = ["mcep", "bap"]            # 辅助特征顺序 (与训练一致)
MEL_DIM = 128                          # SVS 管线 mel 频谱维度

# 累积上采样倍数: [5, 20, 60, 120]
_CUMPROD = []
_acc = 1
for _us in UPSAMPLE_SCALES:
    _acc *= _us
    _CUMPROD.append(_acc)
CUMPROD_SCALES = tuple(_acc)  # noqa: F841
CUMPROD_SCALES = tuple(_CUMPROD)


def load_sifigan_generator(sifigan_dir, checkpoint_path):
    """加载 SiFiGAN Generator 模型。

    Args:
        sifigan_dir: SiFiGAN 仓库根目录 (已加入 sys.path)
        checkpoint_path: .pkl 检查点文件路径

    Returns:
        SiFiGANGenerator 实例 (已加载权重, 已移除 weight_norm, eval 模式)
    """
    import torch
    from sifigan.models.generator import SiFiGANGenerator

    # 用配置参数直接构造模型 (避免 Hydra 依赖)
    model = SiFiGANGenerator(**SIFIGAN_GENERATOR_CONFIG)

    # 加载检查点
    state_dict = torch.load(checkpoint_path, map_location="cpu", weights_only=False)
    model.load_state_dict(state_dict["model"]["generator"])

    # 移除 weight norm (推理时不需要)
    model.remove_weight_norm()
    model.eval()

    return model


def load_stats(stats_path):
    """加载 joblib 统计文件，提取 mcep + bap 的均值和方差。

    统计文件结构: {"mcep": StandardScaler, "bap": StandardScaler, ...}
    每个 StandardScaler 有 .mean_ 和 .scale_ 属性。

    Returns:
        (mean, scale) 两个 (in_channels,) 的 float32 ndarray
    """
    import numpy as np
    from joblib import load

    scaler = load(stats_path)

    means = []
    scales = []
    for feat in AUX_FEATS:
        if feat not in scaler:
            raise KeyError(f"统计文件中缺少特征 '{feat}'，可用: {list(scaler.keys())}")
        s = scaler[feat]
        means.append(np.asarray(s.mean_, dtype=np.float32))
        scales.append(np.asarray(s.scale_, dtype=np.float32))

    mean = np.concatenate(means)
    scale = np.concatenate(scales)

    expected_dim = SIFIGAN_GENERATOR_CONFIG["in_channels"]
    if mean.shape[0] != expected_dim:
        print(f"[WARN] 特征维度 {mean.shape[0]} != in_channels {expected_dim}")
        print(f"       特征组成: {AUX_FEATS}")
        print(f"       各维度: {[np.asarray(scaler[f].mean_).shape[0] for f in AUX_FEATS]}")

    return mean, scale


# ============================================================
# 4. SiFiGANVocoderWrapper
# ============================================================

class SiFiGANVocoderWrapper(torch.nn.Module):
    """SiFiGAN Generator 包装器。

    将 SVS 管线的 (mel, f0) 接口适配到 SiFiGAN Generator 的 (in_signal, c, dfs) 接口。

    forward(mel, f0) -> waveform
      mel: (B, T, 128)  float32 - SVS 管线产出的 mel 频谱
      f0:  (B, T, 1)    float32 - F0 曲线 (建议使用连续 F0, 即 cf0)
      waveform: (B, 1, T_audio) float32 - 24kHz 音频

    内部处理流程:
      1. mel -> 线性投影到 in_channels(43) 维
      2. 应用统计文件归一化 (mcep + bap 的 StandardScaler)
      3. 由 f0 生成正弦激励信号 (SignalGenerator.sinusoid)
      4. 由 f0 计算 pitch-dependent 密集因子 (dilated_factor)
      5. 调用 SiFiGANGenerator.forward(in_signal, c, dfs)
    """

    def __init__(self, generator, feat_mean, feat_scale):
        super().__init__()
        self.generator = generator

        in_channels = SIFIGAN_GENERATOR_CONFIG["in_channels"]

        # mel(128) -> c(43) 线性投影
        # 注意: 这是占位投影，实际使用时可能需要微调以获得最佳音质
        # 因为 SVS 的 mel 频谱与 SiFiGAN 训练时的 mcep+bap 特征空间不同
        self.mel_proj = torch.nn.Linear(MEL_DIM, in_channels, bias=False)
        torch.nn.init.normal_(self.mel_proj.weight, mean=0.0, std=0.02)

        # 归一化统计 (buffer)
        self.register_buffer("feat_mean", torch.from_numpy(feat_mean).float())
        self.register_buffer("feat_scale", torch.from_numpy(feat_scale).float())

    def _generate_sine_signal(self, f0):
        """由 F0 生成正弦激励信号 (ONNX 兼容，不含随机噪声)。

        复现 SignalGenerator.sinusoid 的核心逻辑:
          1. 将 F0 从帧分辨率插值到音频分辨率 (T * hop_size)
          2. 计算相位: radious = (f0_interp / sample_rate) % 1
          3. sine = vuv * sin(cumsum(radious) * 2*pi) * sine_amp

        注意: 原始代码会添加随机噪声 (noise_amp=0.003)，但为了 ONNX 导出的
        确定性和可重复性，此处跳过噪声。noise_amp=0.003 非常小，影响可忽略。

        Args:
            f0: (B, 1, T_frames) 连续 F0

        Returns:
            sine: (B, 1, T_audio) 正弦激励信号
        """
        B, _, T = f0.shape
        T_audio = T * HOP_SIZE

        # V/UV 标记: f0 > 0 表示浊音段
        vuv = (f0 > 0).to(torch.float32)
        # 插值到音频分辨率 (mode='nearest' 与原始代码默认一致)
        vuv = torch.nn.functional.interpolate(vuv, size=T_audio, mode="nearest")

        # 插值 F0 到音频分辨率
        f0_interp = torch.nn.functional.interpolate(
            f0.to(torch.float32), size=T_audio, mode="nearest"
        )

        # 计算相位增量 (归一化到 [0, 1) 一个周期内)
        radious = (f0_interp / SAMPLE_RATE) % 1.0

        # 累积相位 -> 正弦波
        phase = torch.cumsum(radious, dim=2) * (2.0 * 3.141592653589793)
        sine = vuv * torch.sin(phase) * SINE_AMP

        # 随机噪声跳过 (ONNX 确定性要求)
        return sine

    def _compute_dense_factors(self, f0):
        """计算 pitch-dependent 密集因子 (ONNX 兼容)。

        复现 dilated_factor + np.repeat 的逻辑:
          df = sample_rate / dense_factor / f0  (f0=0 时 df=1)
          df_repeated = repeat_interleave(df, cumprod_scale, dim=-1)

        Args:
            f0: (B, 1, T_frames) 连续 F0

        Returns:
            list of 4 tensors, 每个形状 (B, 1, T * cumprod_scale)
        """
        dfs = []
        for df_val, repeat_times in zip(DENSE_FACTORS, CUMPROD_SCALES):
            # 替换 f0=0 的位置 (避免除零), 使 df=1
            default_f0 = float(SAMPLE_RATE / df_val)
            safe_f0 = torch.where(
                f0 > 0,
                f0,
                torch.full_like(f0, default_f0),
            )
            # dilated_factor = fs / dense_factor / f0
            df = SAMPLE_RATE / df_val / safe_f0  # (B, 1, T)

            # 每帧的 df 值重复 cumprod_scale 次
            df_repeated = torch.repeat_interleave(df, repeat_times, dim=2)
            dfs.append(df_repeated)

        return dfs

    def forward(self, mel, f0):
        """前向传播。

        Args:
            mel: (B, T, 128) float32 - mel 频谱
            f0:  (B, T, 1)   float32 - F0 曲线 (建议连续 F0)

        Returns:
            waveform: (B, 1, T_audio) float32 - 24kHz 音频波形
        """
        # 1. mel -> 特征投影
        c = self.mel_proj(mel)  # (B, T, 43)

        # 2. 统计归一化 (StandardScaler: (x - mean) / scale)
        c = (c - self.feat_mean) / self.feat_scale

        # 3. 转置为 (B, in_channels, T) 供 Generator 使用
        c = c.transpose(1, 2)  # (B, 43, T)

        # 4. 准备 f0: (B, T, 1) -> (B, 1, T)
        f0 = f0.transpose(1, 2)  # (B, 1, T)

        # 5. 生成正弦激励信号
        in_signal = self._generate_sine_signal(f0)  # (B, 1, T_audio)

        # 6. 计算密集因子
        dfs = self._compute_dense_factors(f0)  # list of (B, 1, T_layer)

        # 7. 调用 SiFiGAN Generator
        outs = self.generator(in_signal, c, dfs)
        waveform = outs[0]  # (B, 1, T_audio)

        return waveform


# ============================================================
# 5. ONNX 导出
# ============================================================

def export_onnx(wrapper, output_path, seq_len=50):
    """导出 ONNX 模型。

    Args:
        wrapper: SiFiGANVocoderWrapper 实例
        output_path: 输出 ONNX 文件路径
        seq_len: 探针输入的帧数
    """
    import torch
    import onnx

    print(f"\n{'='*60}")
    print(f"ONNX 导出 (dynamo=True, opset=18)")
    print(f"{'='*60}")

    # 构造探针输入
    mel = torch.randn(1, seq_len, MEL_DIM, dtype=torch.float32) * 0.1
    f0 = torch.rand(1, seq_len, 1, dtype=torch.float32) * 200 + 100  # 100-300 Hz

    print(f"  输入: mel={tuple(mel.shape)}, f0={tuple(f0.shape)}")
    print(f"  参数量: {sum(p.numel() for p in wrapper.parameters()) / 1e6:.1f}M")

    # 先导出到临时文件
    temp_path = output_path + ".tmp"

    with torch.no_grad():
        torch.onnx.export(
            wrapper,
            (mel, f0),
            temp_path,
            input_names=["mel", "f0"],
            output_names=["waveform"],
            dynamic_axes={
                "mel": {1: "seq_len"},
                "f0": {1: "seq_len"},
                "waveform": {1: "num_samples"},
            },
            opset_version=18,
            dynamo=True,
        )

    # 加载并重新保存为 external_data 格式 (处理 >2GB 模型)
    print(f"  重新打包为 external_data 格式...")
    model = onnx.load(temp_path)
    old_data = output_path + ".data"
    if os.path.exists(old_data):
        os.remove(old_data)

    onnx.save_model(
        model,
        output_path,
        save_as_external_data=True,
        all_tensors_to_one_file=True,
        location=os.path.basename(output_path) + ".data",
        size_threshold=1024,
    )

    # 清理临时文件
    if os.path.exists(temp_path):
        os.remove(temp_path)

    # 文件大小
    size_mb = os.path.getsize(output_path) / 1024 / 1024
    data_path = output_path + ".data"
    data_mb = os.path.getsize(data_path) / 1024 / 1024 if os.path.exists(data_path) else 0
    print(f"  保存: {output_path}")
    print(f"  大小: {size_mb:.1f}MB (graph) + {data_mb:.1f}MB (data)")

    # 打印算子统计
    ops = {}
    for node in model.graph.node:
        ops[node.op_type] = ops.get(node.op_type, 0) + 1
    print(f"  节点总数: {sum(ops.values())}")
    for op, cnt in sorted(ops.items(), key=lambda x: -x[1])[:10]:
        print(f"    {op}: {cnt}")

    return output_path


# ============================================================
# 6. 精度验证
# ============================================================

def validate_onnx(wrapper, onnx_path, seq_len=50, tolerance=1e-4):
    """验证 ONNX 模型与 PyTorch 参考输出的精度。

    Args:
        wrapper: SiFiGANVocoderWrapper 实例 (PyTorch 参考)
        onnx_path: ONNX 模型路径
        seq_len: 探针输入帧数
        tolerance: L1 最大误差容忍值

    Returns:
        True 如果误差在容忍范围内
    """
    import numpy as np
    import torch
    import onnxruntime as ort

    print(f"\n{'='*60}")
    print(f"精度验证 (PyTorch vs ONNX Runtime CPU)")
    print(f"{'='*60}")

    # 固定随机种子以保证可重复
    torch.manual_seed(42)
    np.random.seed(42)

    # 构造探针输入
    mel = torch.randn(1, seq_len, MEL_DIM, dtype=torch.float32) * 0.1
    f0 = torch.rand(1, seq_len, 1, dtype=torch.float32) * 200 + 100  # 100-300 Hz

    print(f"  输入: mel={tuple(mel.shape)}, f0={tuple(f0.shape)}")

    # PyTorch 参考输出
    wrapper.eval()
    with torch.no_grad():
        pt_out = wrapper(mel, f0)
    pt_out = pt_out.cpu().numpy()
    print(f"  PyTorch 输出: shape={pt_out.shape}, range=[{pt_out.min():.6f}, {pt_out.max():.6f}]")

    # ONNX Runtime 输出
    sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    ort_out = sess.run(
        None,
        {"mel": mel.numpy(), "f0": f0.numpy()},
    )[0]
    print(f"  ONNX 输出:   shape={ort_out.shape}, range=[{ort_out.min():.6f}, {ort_out.max():.6f}]")

    # 误差对比
    if pt_out.shape != ort_out.shape:
        print(f"  [FAIL] 输出形状不匹配: {pt_out.shape} vs {ort_out.shape}")
        return False

    abs_diff = np.abs(pt_out - ort_out)
    max_diff = abs_diff.max()
    mean_diff = abs_diff.mean()

    print(f"  L1 最大误差:   {max_diff:.8f}")
    print(f"  L1 平均误差:   {mean_diff:.8f}")
    print(f"  容忍阈值:      {tolerance:.8f}")

    if max_diff < tolerance:
        print(f"  [PASS] 精度验证通过 (误差 < {tolerance})")
        return True
    else:
        print(f"  [FAIL] 精度验证失败 (误差 >= {tolerance})")
        # 打印差异最大的位置
        flat_diff = abs_diff.flatten()
        top_indices = np.argsort(flat_diff)[-5:][::-1]
        print(f"  差异最大的 5 个位置:")
        for idx in top_indices:
            pt_val = pt_out.flatten()[idx]
            ort_val = ort_out.flatten()[idx]
            print(f"    [{idx}]: PT={pt_val:.8f}, ONNX={ort_val:.8f}, diff={abs(pt_val-ort_val):.8f}")
        return False


# ============================================================
# 7. 主函数
# ============================================================

def main():
    parser = argparse.ArgumentParser(
        description="SiFiGAN vocoder ONNX 导出脚本"
    )
    parser.add_argument(
        "--checkpoint",
        default=r"D:\download\model+stats\sifigan_libritts-r-clean+nus-48e_checkpoint-1000000steps.pkl",
        help="SiFiGAN 检查点文件路径 (.pkl)",
    )
    parser.add_argument(
        "--stats",
        default=r"D:\download\model+stats\libritts_r_clean+nus-48e_train_no_dev.joblib",
        help="特征归一化统计文件路径 (.joblib)",
    )
    parser.add_argument(
        "--sifigan-dir",
        default=SIFIGAN_DIR_DEFAULT,
        help="SiFiGAN 源码仓库目录 (包含 sifigan/ 包)",
    )
    parser.add_argument(
        "--out",
        default="sifigan_vocoder.onnx",
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

    # 延迟导入 torch (避免在检查阶段就需要)
    global torch
    import torch
    import numpy as np

    # 复用项目的 clear_memory
    sys.path.insert(0, SCRIPT_DIR)
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
    print("SiFiGAN Vocoder ONNX 导出")
    print("=" * 60)
    print(f"  检查点: {args.checkpoint}")
    print(f"  统计文件: {args.stats}")
    print(f"  SiFiGAN 源码: {args.sifigan_dir}")
    print(f"  输出: {args.out}")

    t0 = time.time()

    # 4. 加载统计文件
    print("\n[1/4] 加载统计文件...")
    feat_mean, feat_scale = load_stats(args.stats)
    print(f"  特征维度: {feat_mean.shape[0]} (mcep + bap)")
    print(f"  均值范围: [{feat_mean.min():.4f}, {feat_mean.max():.4f}]")
    print(f"  尺度范围: [{feat_scale.min():.4f}, {feat_scale.max():.4f}]")

    # 5. 加载 SiFiGAN Generator
    print("\n[2/4] 加载 SiFiGAN Generator...")
    generator = load_sifigan_generator(args.sifigan_dir, args.checkpoint)
    param_count = sum(p.numel() for p in generator.parameters()) / 1e6
    print(f"  Generator 参数量: {param_count:.1f}M")

    # 6. 构建 Wrapper
    print("\n[3/4] 构建 SiFiGANVocoderWrapper...")
    wrapper = SiFiGANVocoderWrapper(generator, feat_mean, feat_scale).eval()
    total_params = sum(p.numel() for p in wrapper.parameters()) / 1e6
    print(f"  Wrapper 总参数量: {total_params:.1f}M")

    # 7. ONNX 导出
    print("\n[4/4] ONNX 导出...")
    output_path = export_onnx(wrapper, args.out, seq_len=args.seq_len)

    # 8. 释放 PyTorch 模型内存
    del wrapper, generator
    clear_memory()

    # 9. 精度验证
    if not args.skip_validation:
        print("\n[验证] 重新加载 Wrapper 进行精度对比...")
        # 重新加载用于验证
        generator = load_sifigan_generator(args.sifigan_dir, args.checkpoint)
        wrapper = SiFiGANVocoderWrapper(generator, feat_mean, feat_scale).eval()

        passed = validate_onnx(wrapper, output_path, seq_len=args.seq_len)

        del wrapper, generator
        clear_memory()

        if not passed:
            print("\n[ERROR] 精度验证未通过，请检查导出过程")
            sys.exit(1)
    else:
        print("\n[跳过] 精度验证已跳过")

    elapsed = time.time() - t0
    print(f"\n{'='*60}")
    print(f"导出完成! 耗时 {elapsed:.1f}s")
    print(f"  ONNX 模型: {output_path}")
    print(f"  外部数据: {output_path}.data")
    print(f"{'='*60}")


if __name__ == "__main__":
    main()
