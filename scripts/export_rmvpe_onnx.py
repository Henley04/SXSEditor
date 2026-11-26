"""导出修复版 RMVPE ONNX（端到端：波形 -> 360 维 salience）。

背景
----
仓库里原来那份 `preprocess/rmvpe_model.onnx` 有两个致命问题：

1. 输入被固定成 240000 采样（15 s），换长度直接报错；
2. 输出形状是 (1, 1504, 360)，而 `rmvpePitchDetector.js` 按 `(T帧, 2560类)`
   读取 —— `base = t * 2560` 很快越过 541440 个元素，`Float32Array` 越界
   返回 `undefined`，`undefined > -Infinity` 恒假，argmax 永远停在 0，
   于是整条 F0 曲线锁死在 `LUT[0] = 30 Hz`。

本脚本用官方 rmvpe.pt 权重重新导出，输出与 RVC `RMVPE.infer_from_audio`
完全等价（STFT/128-mel/DeepUnet/BiGRU/360-bin salience），只把
"解码 + 清音判定" 留给 JS（`RmvpePitchDetector.decodeSalience`）：
图里不出现 ArgMax/GatherElements，DirectML EP 覆盖更好。

用法
----
    # 需要 rmvpe.pt（https://huggingface.co/lj1995/VoiceConversionWebUI）
    python scripts/export_rmvpe_onnx.py --ckpt rmvpe.pt --out rmvpe_model.onnx
    python scripts/export_rmvpe_onnx.py --ckpt rmvpe.pt --out rmvpe_model_int8.onnx --precision int8

    # 自检：与官方解码对比
    python scripts/export_rmvpe_onnx.py --ckpt rmvpe.pt --out /tmp/m.onnx --verify
"""
import argparse

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F


# ============================ 网络结构（同 RVC infer/rmvpe.py） ============================

class BiGRU(nn.Module):
    def __init__(self, input_features, hidden_features, num_layers):
        super().__init__()
        self.gru = nn.GRU(input_features, hidden_features, num_layers=num_layers,
                          batch_first=True, bidirectional=True)

    def forward(self, x):
        return self.gru(x)[0]


class ConvBlockRes(nn.Module):
    def __init__(self, in_channels, out_channels, momentum=0.01):
        super().__init__()
        self.conv = nn.Sequential(
            nn.Conv2d(in_channels, out_channels, (3, 3), (1, 1), (1, 1), bias=False),
            nn.BatchNorm2d(out_channels, momentum=momentum),
            nn.ReLU(),
            nn.Conv2d(out_channels, out_channels, (3, 3), (1, 1), (1, 1), bias=False),
            nn.BatchNorm2d(out_channels, momentum=momentum),
            nn.ReLU(),
        )
        if in_channels != out_channels:
            self.shortcut = nn.Conv2d(in_channels, out_channels, (1, 1))

    def forward(self, x):
        if not hasattr(self, "shortcut"):
            return self.conv(x) + x
        return self.conv(x) + self.shortcut(x)


class ResEncoderBlock(nn.Module):
    def __init__(self, in_channels, out_channels, kernel_size, n_blocks=1, momentum=0.01):
        super().__init__()
        self.conv = nn.ModuleList([ConvBlockRes(in_channels, out_channels, momentum)])
        for _ in range(n_blocks - 1):
            self.conv.append(ConvBlockRes(out_channels, out_channels, momentum))
        self.kernel_size = kernel_size
        if kernel_size is not None:
            self.pool = nn.AvgPool2d(kernel_size=kernel_size)

    def forward(self, x):
        for conv in self.conv:
            x = conv(x)
        return (x, self.pool(x)) if self.kernel_size is not None else x


class Encoder(nn.Module):
    def __init__(self, in_channels, in_size, n_encoders, kernel_size, n_blocks,
                 out_channels=16, momentum=0.01):
        super().__init__()
        self.bn = nn.BatchNorm2d(in_channels, momentum=momentum)
        self.layers = nn.ModuleList()
        for _ in range(n_encoders):
            self.layers.append(ResEncoderBlock(in_channels, out_channels, kernel_size,
                                               n_blocks, momentum=momentum))
            in_channels = out_channels
            out_channels *= 2
            in_size //= 2
        self.out_channel = out_channels

    def forward(self, x):
        concat_tensors = []
        x = self.bn(x)
        for layer in self.layers:
            t, x = layer(x)
            concat_tensors.append(t)
        return x, concat_tensors


class Intermediate(nn.Module):
    def __init__(self, in_channels, out_channels, n_inters, n_blocks, momentum=0.01):
        super().__init__()
        self.layers = nn.ModuleList([ResEncoderBlock(in_channels, out_channels, None,
                                                     n_blocks, momentum)])
        for _ in range(n_inters - 1):
            self.layers.append(ResEncoderBlock(out_channels, out_channels, None,
                                               n_blocks, momentum))

    def forward(self, x):
        for layer in self.layers:
            x = layer(x)
        return x


class ResDecoderBlock(nn.Module):
    def __init__(self, in_channels, out_channels, stride, n_blocks=1, momentum=0.01):
        super().__init__()
        out_padding = (0, 1) if stride == (1, 2) else (1, 1)
        self.conv1 = nn.Sequential(
            nn.ConvTranspose2d(in_channels, out_channels, (3, 3), stride=stride,
                               padding=(1, 1), output_padding=out_padding, bias=False),
            nn.BatchNorm2d(out_channels, momentum=momentum),
            nn.ReLU(),
        )
        self.conv2 = nn.ModuleList([ConvBlockRes(out_channels * 2, out_channels, momentum)])
        for _ in range(n_blocks - 1):
            self.conv2.append(ConvBlockRes(out_channels, out_channels, momentum))

    def forward(self, x, concat_tensor):
        x = self.conv1(x)
        x = torch.cat((x, concat_tensor), dim=1)
        for conv2 in self.conv2:
            x = conv2(x)
        return x


class Decoder(nn.Module):
    def __init__(self, in_channels, n_decoders, stride, n_blocks, momentum=0.01):
        super().__init__()
        self.layers = nn.ModuleList()
        for _ in range(n_decoders):
            out_channels = in_channels // 2
            self.layers.append(ResDecoderBlock(in_channels, out_channels, stride,
                                               n_blocks, momentum))
            in_channels = out_channels

    def forward(self, x, concat_tensors):
        for i, layer in enumerate(self.layers):
            x = layer(x, concat_tensors[-1 - i])
        return x


class DeepUnet(nn.Module):
    def __init__(self, kernel_size, n_blocks, en_de_layers=5, inter_layers=4,
                 in_channels=1, en_out_channels=16):
        super().__init__()
        self.encoder = Encoder(in_channels, 128, en_de_layers, kernel_size, n_blocks,
                               en_out_channels)
        self.intermediate = Intermediate(self.encoder.out_channel // 2,
                                         self.encoder.out_channel, inter_layers, n_blocks)
        self.decoder = Decoder(self.encoder.out_channel, en_de_layers, kernel_size, n_blocks)

    def forward(self, x):
        x, concat_tensors = self.encoder(x)
        x = self.intermediate(x)
        return self.decoder(x, concat_tensors)


class E2E(nn.Module):
    def __init__(self, n_blocks, n_gru, kernel_size, en_de_layers=5, inter_layers=4,
                 in_channels=1, en_out_channels=16):
        super().__init__()
        self.unet = DeepUnet(kernel_size, n_blocks, en_de_layers, inter_layers,
                             in_channels, en_out_channels)
        self.cnn = nn.Conv2d(en_out_channels, 3, (3, 3), padding=(1, 1))
        self.fc = nn.Sequential(
            BiGRU(3 * 128, 256, n_gru) if n_gru else nn.Identity(),
            nn.Linear(512 if n_gru else 3 * 128, 360),
            nn.Dropout(0.25),
            nn.Sigmoid(),
        )

    def forward(self, mel):
        mel = mel.transpose(-1, -2).unsqueeze(1)          # (B, 1, T, 128)
        x = self.cnn(self.unet(mel)).transpose(1, 2).flatten(-2)
        return self.fc(x)                                  # (B, T, 360)


# ============================ 端到端包装 ============================

N_FFT, HOP, WIN, N_MEL, SR = 1024, 160, 1024, 128, 16000
CENTS_OFFSET = 1997.3794084376191


def _stft_basis(n_fft=1024, win_length=1024, window="hann"):
    """RVC STFT.transform 的基矩阵，形状 (1026, 1024)，前 513 实部后 513 虚部。"""
    from librosa.util import pad_center
    from scipy.signal import get_window

    fourier = np.fft.fft(np.eye(n_fft))
    cutoff = n_fft // 2 + 1
    basis = np.vstack([np.real(fourier[:cutoff, :]), np.imag(fourier[:cutoff, :])])
    w = pad_center(get_window(window, win_length, fftbins=True), size=n_fft)
    return torch.from_numpy(basis * w).float()


class RmvpeOnnx(nn.Module):
    def __init__(self, net):
        super().__init__()
        from librosa.filters import mel

        self.net = net
        self.register_buffer("mel_basis",
                             torch.from_numpy(mel(sr=SR, n_fft=N_FFT, n_mels=N_MEL,
                                                  fmin=30, fmax=8000, htk=True)).float())
        self.register_buffer("stft_basis", _stft_basis().unsqueeze(1))

    def forward(self, audio):
        # conv1d 分帧等价于 torch.stft(center=True)，且只用到 Pad/Conv/Slice，
        # 比 STFT 算子在各家 EP 上都好使。
        x = F.pad(audio.unsqueeze(1), (N_FFT // 2, N_FFT // 2), mode="reflect")
        frames = F.conv1d(x, self.stft_basis, stride=HOP)          # (B, 1026, T)
        real, imag = torch.split(frames, N_FFT // 2 + 1, dim=1)
        mag = torch.sqrt(real * real + imag * imag)                # (B, 513, T)
        log_mel = torch.log(torch.clamp(torch.matmul(self.mel_basis, mag), min=1e-5))
        return self.net(log_mel)                                    # (B, T, 360)


# ============================ 可选 int8（weight-only） ============================

def quantize_weight_only(src, dst):
    """per-channel int8 权重 + DequantizeLinear，图形态与原版 ModelScope 模型一致。"""
    import onnx
    from onnx import helper, numpy_helper

    model = onnx.load(src)
    graph = model.graph
    init_map = {i.name: i for i in graph.initializer}
    new_inits, new_nodes, replaced = [], [], 0

    for node in graph.node:
        if node.op_type not in ("Conv", "ConvTranspose", "MatMul", "Gemm") \
                or "/net/" not in node.name or len(node.input) < 2:
            new_nodes.append(node)
            continue
        wname = node.input[1]
        if wname not in init_map:
            new_nodes.append(node)
            continue
        arr = numpy_helper.to_array(init_map[wname])
        if arr.ndim < 2 or arr.dtype != np.float32:
            new_nodes.append(node)
            continue

        axis = 1 if node.op_type == "ConvTranspose" else 0
        moved = np.moveaxis(arr, axis, 0)                          # (C, *rest)
        shape = moved.shape
        flat = moved.reshape(shape[0], -1)
        scale = np.abs(flat).max(axis=1).astype(np.float32) / 127.0
        scale = np.where(scale == 0, np.float32(1e-8), scale)
        q = np.clip(np.round(flat / scale[:, None]), -127, 127).astype(np.int8)
        q = np.moveaxis(q.reshape(shape), 0, axis)

        q_name, s_name, dq_name = wname + "_q", wname + "_s", wname + "_dq"
        new_inits.append(numpy_helper.from_array(q, q_name))
        new_inits.append(numpy_helper.from_array(scale, s_name))
        new_nodes.append(helper.make_node("DequantizeLinear", [q_name, s_name], [dq_name],
                                          axis=axis, name=wname + "_dequant"))
        node.input[1] = dq_name
        new_nodes.append(node)
        replaced += 1

    dropped = {n[:-3] for n in (i.name for i in new_inits) if n.endswith("_dq")}
    used = {n for node in new_nodes for n in node.input}
    keep = [i for i in graph.initializer if i.name not in dropped and i.name in used]
    del graph.initializer[:]
    graph.initializer.extend(keep + new_inits)
    del graph.node[:]
    graph.node.extend(new_nodes)
    onnx.checker.check_model(model, full_check=False)
    onnx.save(model, dst)
    print(f"quantized {replaced} weight tensors -> {dst}")


# ============================ 自检 ============================

def verify(onnx_path, ckpt, frames=96):
    import onnxruntime as ort

    torch.manual_seed(0)
    audio = (0.2 * torch.sin(2 * torch.pi * 261.63 * torch.arange(32000) / SR)).numpy()
    tf = 1 + len(audio) // HOP
    aligned = ((tf + 31) // 32) * 32
    padded = np.zeros((aligned - 1) * HOP, dtype=np.float32)
    padded[:len(audio)] = audio

    sess = ort.InferenceSession(onnx_path, providers=["CPUExecutionProvider"])
    out_name = sess.get_outputs()[0].name
    sal = sess.run(None, {"audio": padded[None, :]})[0][0][:tf]

    net = E2E(4, 1, (2, 2))
    net.load_state_dict(torch.load(ckpt, map_location="cpu", weights_only=True))
    net.eval()
    ref = RmvpeOnnx(net).eval()

    # 参考：官方 decode 路径（torch.stft + 9 点加权）
    a = torch.from_numpy(padded).float().unsqueeze(0)
    spec = torch.stft(a, N_FFT, HOP, WIN, window=torch.hann_window(WIN),
                      center=True, return_complex=True)
    mel = torch.log(torch.clamp(torch.matmul(ref.mel_basis, spec.abs()), min=1e-5))
    with torch.no_grad():
        sal_ref = net(mel)[0].numpy()[:tf]

    def decode(s):
        f0 = np.zeros(s.shape[0], dtype=np.float32)
        cents_map = 20 * np.arange(360) + CENTS_OFFSET
        for t, row in enumerate(s):
            c = int(row.argmax())
            if row[c] <= 0.03:
                continue
            lo, hi = max(0, c - 4), min(359, c + 4)
            w = row[lo:hi + 1]
            f0[t] = 10 * 2 ** ((w * cents_map[lo:hi + 1]).sum() / w.sum() / 1200)
        return f0

    f_onnx, f_ref = decode(sal), decode(sal_ref)
    m = (f_onnx > 0) & (f_ref > 0)
    err = np.median(np.abs(1200 * np.log2(f_onnx[m] / f_ref[m]))) if m.any() else float("nan")
    print(f"salience max|diff| = {np.abs(sal - sal_ref).max():.6f}")
    print(f"f0 median |cents| vs reference = {err:.2f}  (voiced {int(m.sum())}/{tf})")
    print(f"f0 range {f_onnx.min():.1f} .. {f_onnx.max():.1f} Hz")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ckpt", required=True, help="rmvpe.pt")
    ap.add_argument("--out", required=True)
    ap.add_argument("--frames", type=int, default=96, help="trace 用帧数（32 的倍数）")
    ap.add_argument("--precision", choices=["fp32", "int8"], default="fp32")
    ap.add_argument("--verify", action="store_true")
    args = ap.parse_args()

    net = E2E(4, 1, (2, 2))
    net.load_state_dict(torch.load(args.ckpt, map_location="cpu", weights_only=True))
    net.eval()
    model = RmvpeOnnx(net).eval()

    n = (args.frames - 1) * HOP
    dummy = torch.randn(1, n) * 0.1
    torch.onnx.export(
        model, (dummy,), args.out,
        input_names=["audio"], output_names=["salience"],
        opset_version=17, dynamo=False, do_constant_folding=True,
        dynamic_axes={"audio": {0: "batch", 1: "n_samples"},
                      "salience": {0: "batch", 1: "time", 2: "n_class"}},
    )
    print(f"exported {args.out}")

    if args.precision == "int8":
        tmp = args.out + ".fp32.onnx"
        import shutil
        shutil.move(args.out, tmp)
        quantize_weight_only(tmp, args.out)

    if args.verify:
        verify(args.out, args.ckpt, args.frames)


if __name__ == "__main__":
    main()
