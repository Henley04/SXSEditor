"""
Convert FCPE DDSP_200k.pt to ONNX format.

Exports the full inference pipeline: raw audio (16kHz) -> F0 in Hz.

Key design decisions:
- STFT: replaced torch.stft (complex types, unsupported by ONNX) with
  equivalent conv1d using pre-computed DFT cosine/sine filter banks.
- Mel extraction: reimplemented without data-dependent debug checks.
- Frame alignment: always pad 1 last frame (diff is always 1).
- Decoding: local_argmax with post-F0 masking (avoids float("-INF")).
"""

import torch
import torch.nn as nn
import torch.nn.functional as F
import torchfcpe
import numpy as np
import os

MODEL_PATH = r"D:\Document\electron\SXSEditor\onnx_models\preprocess\DDSP_200k.pt"
OUTPUT_PATH = r"D:\Document\electron\SXSEditor\onnx_models\preprocess\fcpe_model.onnx"
SR = 16000
N_FFT = 1024
WIN_SIZE = 1024
HOP_SIZE = 160
PAD_LEFT = (WIN_SIZE - HOP_SIZE) // 2  # 432
PAD_RIGHT = (WIN_SIZE - HOP_SIZE + 1) // 2  # 432
N_MELS = 128
N_CLASS = 360
THRESHOLD = 0.006


class FcpeFullWrapper(nn.Module):
    """Wraps the entire FCPE inference pipeline for ONNX export.

    Input:  audio (B, n_samples, 1) at 16kHz
    Output: f0 in Hz (B, n_frames, 1). Unvoiced frames are 0.
    """

    def __init__(self, infer_model):
        super().__init__()
        # Core model sub-modules
        self.input_stack = infer_model.model.input_stack
        self.net = infer_model.model.net
        self.norm = infer_model.model.norm
        self.output_proj = infer_model.model.output_proj

        # Mel filterbank (extracted from MelModule)
        mel_module = infer_model.wav2mel.mel_extractor
        self.register_buffer("mel_basis", mel_module.mel_basis.clone())  # (128, 513)

        # Pre-compute STFT filter bank via conv1d (avoids complex types)
        # STFT[k, t] = sum_n x[t*hop+n] * w[n] * exp(-j*2*pi*k*n/N)
        #   real = sum_n x[...] * w[n] * cos(2*pi*k*n/N)
        #   imag = -sum_n x[...] * w[n] * sin(2*pi*k*n/N)
        n_idx = torch.arange(WIN_SIZE).float()
        k_idx = torch.arange(N_FFT // 2 + 1).float().unsqueeze(1)  # (513, 1)
        window = torch.hann_window(WIN_SIZE)
        cos_fb = torch.cos(2 * torch.pi * k_idx * n_idx / N_FFT) * window  # (513, 1024)
        sin_fb = (
            -torch.sin(2 * torch.pi * k_idx * n_idx / N_FFT) * window
        )  # (513, 1024)
        self.register_buffer("stft_cos", cos_fb.unsqueeze(1))  # (513, 1, 1024)
        self.register_buffer("stft_sin", sin_fb.unsqueeze(1))  # (513, 1, 1024)

        # Decoding constants
        self.register_buffer(
            "cent_table", infer_model.model.cent_table.clone()
        )  # (360,)
        self.register_buffer("local_offsets", torch.arange(0, 9) - 4)  # [-4..4]

    def forward(self, wav):
        # wav: (B, n_samples, 1)
        B = wav.shape[0]

        # === Mel extraction ===
        y = wav.squeeze(-1)  # (B, n_samples)
        y = F.pad(y.unsqueeze(1), (PAD_LEFT, PAD_RIGHT), mode="reflect").squeeze(1)

        # STFT via conv1d (real arithmetic, ONNX-safe)
        y_in = y.unsqueeze(1)  # (B, 1, n_padded)
        real = F.conv1d(y_in, self.stft_cos, stride=HOP_SIZE)  # (B, 513, T)
        imag = F.conv1d(y_in, self.stft_sin, stride=HOP_SIZE)  # (B, 513, T)
        spec_mag = torch.sqrt(real**2 + imag**2 + 1e-9)  # (B, 513, T)

        # Mel filterbank + log compression
        mel = torch.matmul(self.mel_basis, spec_mag)  # (B, 128, T)
        mel = torch.log(torch.clamp(mel, min=1e-5))
        mel = mel.transpose(1, 2)  # (B, T, 128)

        # Frame alignment: stft gives T, expected T+1, pad last frame
        mel = torch.cat([mel, mel[:, -1:, :]], dim=1)  # (B, T+1, 128)

        # === Core model (CFNaiveMelPE.forward) ===
        x = self.input_stack(mel.transpose(1, 2)).transpose(1, 2)  # (B, T+1, 512)
        x = self.net(x)
        x = self.norm(x)
        x = self.output_proj(x)
        latent = torch.sigmoid(x)  # (B, T+1, 360)

        # === Local argmax decode ===
        max_val, max_idx = torch.max(latent, dim=-1, keepdim=True)  # (B, T+1, 1)

        T_f = latent.shape[1]
        local_idx = (self.local_offsets + max_idx).clamp(0, N_CLASS - 1)  # (B, T+1, 9)

        ct_exp = self.cent_table.unsqueeze(0).unsqueeze(0).expand(B, T_f, N_CLASS)
        ci_local = torch.gather(ct_exp, -1, local_idx)  # (B, T+1, 9)
        y_local = torch.gather(latent, -1, local_idx)  # (B, T+1, 9)

        cents = torch.sum(ci_local * y_local, dim=-1, keepdim=True) / (
            torch.sum(y_local, dim=-1, keepdim=True) + 1e-9
        )  # (B, T+1, 1)

        # Convert cents to F0, then mask unvoiced
        f0 = 10.0 * torch.pow(2.0, cents / 1200.0)
        voiced = (max_val > THRESHOLD).to(f0.dtype)
        f0 = f0 * voiced  # (B, T+1, 1)

        return f0


def main():
    print(f"[1/6] Loading model from: {MODEL_PATH}")
    model = torchfcpe.spawn_infer_model_from_pt(MODEL_PATH, device="cpu")
    model.eval()

    wrapper = FcpeFullWrapper(model)
    wrapper.eval()

    # === Verify conv1d STFT matches torch.stft ===
    print("[2/6] Verifying conv1d STFT vs torch.stft...")
    dummy = torch.randn(1, SR) * 0.1
    y_pad = F.pad(dummy.unsqueeze(0), (PAD_LEFT, PAD_RIGHT), mode="reflect").squeeze(0)
    # torch.stft reference
    spec_ref = torch.stft(
        y_pad,
        N_FFT,
        HOP_SIZE,
        WIN_SIZE,
        torch.hann_window(WIN_SIZE),
        center=False,
        return_complex=True,
    )
    mag_ref = torch.sqrt(spec_ref.real**2 + spec_ref.imag**2 + 1e-9)
    # conv1d STFT
    y_in = y_pad.unsqueeze(0)  # (1, 1, n_padded) for conv1d
    real = F.conv1d(y_in, wrapper.stft_cos, stride=HOP_SIZE)
    imag = F.conv1d(y_in, wrapper.stft_sin, stride=HOP_SIZE)
    mag_conv = torch.sqrt(real**2 + imag**2 + 1e-9)
    stft_diff = (mag_conv - mag_ref).abs().max().item()
    print(f"  Max diff (conv1d vs stft): {stft_diff:.8f}")
    if stft_diff < 1e-4:
        print("  [OK] conv1d STFT matches torch.stft")
    else:
        print("  [WARN] conv1d STFT differs from torch.stft!")

    # === Verify full wrapper vs original model ===
    print("[3/6] Verifying wrapper vs original model...")
    dummy_wav = torch.randn(1, SR, 1) * 0.1
    with torch.no_grad():
        wrapper_f0 = wrapper(dummy_wav)
        orig_f0 = model.forward(
            dummy_wav, sr=SR, decoder_mode="local_argmax", threshold=THRESHOLD
        )
    max_diff = (wrapper_f0 - orig_f0).abs().max().item()
    print(f"  Wrapper shape: {wrapper_f0.shape}, Original shape: {orig_f0.shape}")
    print(f"  Max diff (wrapper vs original): {max_diff:.6f}")
    if max_diff > 1e-3:
        print("  [WARN] Significant difference!")
        print(f"  Wrapper: {wrapper_f0.flatten()[:10]}")
        print(f"  Original: {orig_f0.flatten()[:10]}")
    else:
        print("  [OK] Wrapper matches original within tolerance")

    # === Export to ONNX ===
    print("[4/6] Exporting to ONNX...")
    dummy_export = torch.zeros(1, SR, 1)
    torch.onnx.export(
        wrapper,
        (dummy_export,),
        OUTPUT_PATH,
        input_names=["audio"],
        output_names=["f0"],
        dynamic_axes={
            "audio": {1: "n_samples"},
            "f0": {1: "n_frames"},
        },
        opset_version=18,
        do_constant_folding=True,
        dynamo=False,
    )
    print(f"  ONNX saved to: {OUTPUT_PATH}")

    # === Verify ONNX model ===
    print("[5/6] Verifying ONNX model...")
    import onnxruntime as ort

    session = ort.InferenceSession(OUTPUT_PATH, providers=["CPUExecutionProvider"])
    input_meta = session.get_inputs()[0]
    output_meta = session.get_outputs()[0]
    print(
        f"  Input:  name={input_meta.name}, shape={input_meta.shape}, type={input_meta.type}"
    )
    print(
        f"  Output: name={output_meta.name}, shape={output_meta.shape}, type={output_meta.type}"
    )

    # Test with 440Hz sine
    t = np.linspace(0, 2, SR * 2, endpoint=False).astype(np.float32)
    sine = (0.5 * np.sin(2 * np.pi * 440 * t)).reshape(1, -1, 1)
    onnx_f0 = session.run(None, {"audio": sine})[0]
    with torch.no_grad():
        pt_f0 = wrapper(torch.from_numpy(sine)).numpy()
    diff = np.max(np.abs(onnx_f0 - pt_f0))
    voiced = onnx_f0[onnx_f0 > 10]
    print(f"  ONNX F0 shape: {onnx_f0.shape}")
    print(f"  Max diff (ONNX vs PyTorch): {diff:.6f}")
    if len(voiced) > 0:
        print(f"  Voiced frames: {len(voiced)}, mean F0: {np.mean(voiced):.1f} Hz")
    if diff < 1e-2:
        print("  [OK] ONNX matches PyTorch within tolerance")
    else:
        print("  [WARN] ONNX differs from PyTorch!")

    print(f"[6/6] Done! Size: {os.path.getsize(OUTPUT_PATH) / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    main()
