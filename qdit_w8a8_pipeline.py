# -*- coding: utf-8 -*-
"""
QDiT W8A8 Quantization Pipeline for SoulX-Singer.

Phase 1: QDiT GPTQ weight optimization for DiffLlama (W8A8)
Phase 2: AWQ weight scaling for Vocos Vocoder (W8A32)
Phase 3: Export GPTQ/AWQ-optimized models to FP32 ONNX
Phase 4: ORT static quantization with QDQ format (true INT8)
Phase 5: Save quantized PyTorch weights (.pt)

Memory management: RTX 5060 8GB VRAM — process one layer at a time, clear cache between layers.

Usage:
  python qdit_w8a8_pipeline.py [--phase 1|2|3|4|5|all] [--model-path PATH]
"""

import os
import sys
import gc
import time
import json
import math
import argparse
import traceback

# Skip RoPE precomputation patches from export_shared.py — we handle RoPE natively
# during calibration (the patched _pdl has device issues when buffers aren't on GPU yet).
os.environ["SKIP_ROPE_PRECOMPUTE"] = "1"

import numpy as np
import torch
import torch.nn as nn

# Force UTF-8
os.environ["PYTHONIOENCODING"] = "utf-8"
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SOULX_DIR = os.path.join(SCRIPT_DIR, "SoulX-Singer")
sys.path.insert(0, SOULX_DIR)
sys.path.insert(0, SCRIPT_DIR)

from export_shared import (
    load_config,
    load_model,
    clear_memory,
    DiffStepWrapper,
    VocosFullWrapper,
    export_fp32_opset20,
)

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
# Static shapes for export (match SXSEditor int8)
SEQ_LEN = 2048
VOCODER_SEQ_LEN = 500
EMBED_DIM = 512
MEL_DIM = 128
COND_DIM = 1024
HIDDEN_SIZE = 1024
INTERMEDIATE_SIZE = 4096
NUM_LAYERS = 22
NUM_HEADS = 16
HEAD_DIM = HIDDEN_SIZE // NUM_HEADS  # 64

# Quantization config
W_BITS = 8
A_BITS = 8
W_BITS_VOC = 8  # Vocoder weight bits (W8A32)
A_BITS_VOC = 32  # Vocoder activation bits (W8A32)

# Output directories
OUTPUT_DIR = os.path.join(SCRIPT_DIR, "onnx_models", "qdit_w8a8")
PT_OUTPUT_DIR = os.path.join(SCRIPT_DIR, "onnx_models", "qdit_w8a8", "pt")
ONNX_FP32_DIR = os.path.join(OUTPUT_DIR, "fp32_gptq")
ONNX_INT8_DIR = os.path.join(OUTPUT_DIR, "int8")

# Calibration data directory
CALIB_DIR = os.path.join(SCRIPT_DIR, "calibrate", "data")


# ============================================================
# Phase 1: QDiT GPTQ Weight Quantization for DiffLlama
# ============================================================


class GPTQQuantizer:
    """GPTQ quantizer for a single Linear layer.

    Implements the GPTQ algorithm from the Q-DiT repo, adapted for
    LlamaNARDecoderLayer's q_proj/k_proj/v_proj/o_proj/gate_proj/up_proj/down_proj.

    The algorithm:
    1. Collect input activations X over calibration samples
    2. Compute Hessian H = X^T * X
    3. Find optimal quantization parameters (scale, zero_point)
    4. Quantize weights column by column, using H^{-1} to compensate
       for the error introduced by quantizing each column
    """

    def __init__(
        self,
        layer,
        w_bits=8,
        sym=True,
        perchannel=True,
        mse=False,
        norm=2.4,
        grid=100,
        maxshrink=0.8,
        clip_ratio=1.0,
        groupsize=-1,
    ):
        self.layer = layer
        self.dev = next(layer.parameters()).device
        self.w_bits = w_bits
        self.sym = sym
        self.perchannel = perchannel
        self.mse = mse
        self.norm = norm
        self.grid = grid
        self.maxshrink = maxshrink
        self.clip_ratio = clip_ratio
        self.groupsize = groupsize

        W = layer.weight.data.clone()
        if isinstance(layer, nn.Conv2d):
            W = W.flatten(1)
        self.rows = W.shape[0]
        self.columns = W.shape[1]
        self.H = torch.zeros((self.columns, self.columns), device=self.dev)
        self.nsamples = 0
        self.n_nonout = W.shape[1]
        del W

        # Quantization parameters
        self.maxq = torch.tensor(2**w_bits - 1)
        self.scale = torch.zeros(1, device=self.dev)
        self.zero = torch.zeros(1, device=self.dev)

    def find_params(self, x, weight=False):
        """Find optimal quantization scale and zero-point for weight tensor x."""
        dev = x.device
        self.maxq = self.maxq.to(dev)
        shape = x.shape

        if self.perchannel:
            if weight:
                x = x.flatten(1)
        else:
            x = x.flatten().unsqueeze(0)

        tmp = torch.zeros(x.shape[0], device=dev)
        xmin = torch.minimum(x.min(1)[0], tmp)
        xmax = torch.maximum(x.max(1)[0], tmp)

        if self.sym:
            xmax = torch.maximum(torch.abs(xmin), xmax)
            tmp = xmin < 0
            if torch.any(tmp):
                xmin[tmp] = -xmax[tmp]

        tmp = (xmin == 0) & (xmax == 0)
        xmin[tmp] = -1
        xmax[tmp] = +1

        self.scale = (xmax - xmin) * self.clip_ratio / self.maxq
        if self.sym:
            self.zero = torch.full_like(self.scale, (self.maxq + 1) / 2)
        else:
            self.zero = torch.round(-xmin / self.scale)

        if self.mse:
            best = torch.full([x.shape[0]], float("inf"), device=dev)
            for i in range(int(self.maxshrink * self.grid)):
                p = 1 - i / self.grid
                xmin1 = p * xmin
                xmax1 = p * xmax
                scale1 = (xmax1 - xmin1) / self.maxq
                zero1 = torch.round(-xmin1 / scale1) if not self.sym else self.zero
                q = self._quantize_gptq(x, scale1.unsqueeze(1), zero1.unsqueeze(1))
                q -= x
                q.abs_()
                q.pow_(self.norm)
                err = torch.sum(q, 1)
                tmp = err < best
                if torch.any(tmp):
                    best[tmp] = err[tmp]
                    self.scale[tmp] = scale1[tmp]
                    self.zero[tmp] = zero1[tmp]

        if weight:
            shape = [-1] + [1] * (len(shape) - 1)
            self.scale = self.scale.reshape(shape)
            self.zero = self.zero.reshape(shape)

    def _quantize_gptq(self, x, scale, zero, maxq=None):
        """Quantize-dequantize: round to INT8 and back to FP32."""
        if maxq is None:
            maxq = self.maxq
        if maxq < 0:
            return (x > scale / 2).float() * scale + (x < zero / 2).float() * zero
        # Uniform affine mapping
        q = torch.clamp(torch.round(x / scale) + zero, 0, maxq)
        q = scale * (q - zero)
        return q

    def add_batch(self, inp, out):
        """Accumulate Hessian from input batch."""
        if len(inp.shape) == 2:
            inp = inp.unsqueeze(0)
        tmp = inp.shape[0]
        if isinstance(self.layer, nn.Linear):
            if len(inp.shape) == 3:
                inp = inp.reshape((-1, inp.shape[-1]))
            inp = inp.t()

        self.H *= self.nsamples / (self.nsamples + tmp)
        self.nsamples += tmp
        inp = math.sqrt(2 / self.nsamples) * inp.float()
        self.H += inp.matmul(inp.t())

    def fasterquant(self, blocksize=128, percdamp=0.01):
        """Run GPTQ: quantize weights column by column with Hessian-based error compensation."""
        W = self.layer.weight.data.clone().float()
        if isinstance(self.layer, nn.Conv2d):
            W = W.flatten(1)

        if not (self.scale.numel() > 1 or (self.scale != 0).all()):
            self.find_params(W[:, : self.n_nonout], weight=True)

        H = self.H
        del self.H
        self.H = None

        dead = torch.diag(H) == 0
        H[dead, dead] = 1
        W[:, dead] = 0

        damp = percdamp * torch.mean(torch.diag(H))
        diag = torch.arange(self.columns, device=self.dev)
        H[diag, diag] += damp

        # Stable H^{-1/2} computation: L = chol(H), then Hinv = L^{-T} (upper triangular)
        L = torch.linalg.cholesky(H)
        del H
        I_mat = torch.eye(self.columns, device=self.dev)
        L_inv = torch.linalg.solve_triangular(L, I_mat, upper=False)
        del L, I_mat
        Hinv = L_inv.t().contiguous()  # Upper-triangular chol(H^{-1})
        del L_inv

        Losses = torch.zeros_like(W)
        Q = torch.zeros_like(W)

        for i1 in range(0, self.n_nonout, blocksize):
            i2 = min(i1 + blocksize, self.n_nonout)
            count = i2 - i1

            W1 = W[:, i1:i2].clone()
            Q1 = torch.zeros_like(W1)
            Err1 = torch.zeros_like(W1)
            Losses1 = torch.zeros_like(W1)
            Hinv1 = Hinv[i1:i2, i1:i2]

            for i in range(count):
                w = W1[:, i]
                d = Hinv1[i, i]

                if self.groupsize > 0:
                    if (i1 + i) % self.groupsize == 0:
                        self.find_params(
                            W[
                                :,
                                (i1 + i) : min(
                                    (i1 + i + self.groupsize), self.n_nonout
                                ),
                            ],
                            weight=True,
                        )

                q = self._quantize_gptq(
                    w.unsqueeze(1), self.scale, self.zero, self.maxq
                ).flatten()
                Q1[:, i] = q
                Losses1[:, i] = (w - q) ** 2 / d**2

                err1 = (w - q) / d
                W1[:, i:] -= err1.unsqueeze(1).matmul(Hinv1[i, i:].unsqueeze(0))
                Err1[:, i] = err1

            Q[:, i1:i2] = Q1
            Losses[:, i1:i2] = Losses1 / 2

            W[:, i2:] -= Err1.matmul(Hinv[i1:i2, i2:])
            del W1, Q1, Err1, Losses1, Hinv1

        Q = Q.reshape(self.layer.weight.shape).to(self.layer.weight.data.dtype)
        self.layer.weight.data = Q.reshape(self.layer.weight.shape).to(
            self.layer.weight.data.dtype
        )

        total_loss = torch.sum(Losses).item()
        del Hinv, Losses, W, Q
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

        return total_loss

    def free(self):
        self.H = None
        if torch.cuda.is_available():
            torch.cuda.empty_cache()


def collect_diff_step_calibration(model, num_samples=16, seq_len=512):
    """Collect calibration inputs for DiffLlama Linear layers.

    Manually runs the DiffLlama forward, capturing input to each Linear layer.
    This avoids dependency on patched forward methods and ensures all layers
    get calibration data.
    """
    print(f"  Collecting {num_samples} calibration samples (seq_len={seq_len})...")

    diff = model.cfm_decoder.model.diff_estimator
    diff = diff.to(DEVICE).eval()

    # Storage: {layer_name: [input_tensor]}
    captured = {}

    def capture(name, x):
        """Capture input tensor for a Linear layer."""
        if name not in captured:
            captured[name] = []
        # Flatten to [N, in_features]
        x_flat = x.reshape(-1, x.shape[-1]).detach().cpu()
        captured[name].append(x_flat)

    # Collect all Linear layer names
    linear_names = set()
    for name, module in diff.named_modules():
        if isinstance(module, nn.Linear):
            linear_names.add(name)
    print(f"  Found {len(linear_names)} Linear layers in DiffLlama")

    for i in range(num_samples):
        # Realistic inputs
        x_mel = (
            torch.randn(1, seq_len, MEL_DIM, device=DEVICE, dtype=torch.float32) * 0.5
        )
        t = torch.rand(1, device=DEVICE, dtype=torch.float32)
        cond = (
            torch.randn(1, seq_len, COND_DIM, device=DEVICE, dtype=torch.float32) * 0.3
        )
        x_mask = torch.ones(1, seq_len, device=DEVICE, dtype=torch.float32)

        with torch.no_grad():
            try:
                # --- Manual forward through DiffLlama ---
                # cond_mlp: Sequential(Linear, SiLU, Linear)
                capture("cond_mlp.0", cond)
                cond_emb = diff.cond_mlp[0](cond)
                cond_emb = torch.nn.functional.silu(cond_emb)
                capture("cond_mlp.2", cond_emb)
                cond_emb = diff.cond_mlp[2](cond_emb)

                # mel_mlp: Sequential(Linear, SiLU, Linear)
                capture("mel_mlp.0", x_mel)
                x_emb = diff.mel_mlp[0](x_mel)
                x_emb = torch.nn.functional.silu(x_emb)
                capture("mel_mlp.2", x_emb)
                x_emb = diff.mel_mlp[2](x_emb)

                # diff_step_embedding + mlp
                t_emb = diff.diff_step_embedding(t).to(x_emb.device)
                capture("diff_step_mlp.0", t_emb)
                t_emb = diff.diff_step_mlp[0](t_emb)
                t_emb = torch.nn.functional.silu(t_emb)
                capture("diff_step_mlp.2", t_emb)
                t_emb = diff.diff_step_mlp[2](t_emb)

                # Combine
                h = x_emb + cond_emb  # [1, T, 1024]

                # Attention mask
                attn_mask = diff._prepare_decoder_attention_mask(
                    x_mask, (1, seq_len), h, 0
                )

                # RoPE
                position_ids = torch.arange(
                    0, seq_len, dtype=torch.long, device=DEVICE
                ).unsqueeze(0)
                position_embeddings = None
                if hasattr(diff, "rotary_emb") and diff.rotary_emb is not None:
                    position_embeddings = diff.rotary_emb(h, position_ids)

                # Decoder layers
                for idx, layer in enumerate(diff.layers):
                    ln_name = f"layers.{idx}"

                    # input_layernorm (LlamaAdaptiveRMSNorm with to_weight Linear)
                    capture(f"{ln_name}.input_layernorm.to_weight", h)
                    h_norm = layer.input_layernorm(h, cond_embedding=t_emb)

                    # Self attention: q_proj, k_proj, v_proj
                    capture(f"{ln_name}.self_attn.q_proj", h_norm)
                    q = layer.self_attn.q_proj(h_norm)

                    capture(f"{ln_name}.self_attn.k_proj", h_norm)
                    k = layer.self_attn.k_proj(h_norm)

                    capture(f"{ln_name}.self_attn.v_proj", h_norm)
                    v = layer.self_attn.v_proj(h_norm)

                    # Apply RoPE if available
                    if position_embeddings is not None:
                        cos, sin = position_embeddings
                        # Reshape q, k for RoPE
                        # q: [B, T, num_heads*head_dim] → [B, num_heads, T, head_dim]
                        B, T, D = q.shape
                        q = q.view(B, T, NUM_HEADS, HEAD_DIM).transpose(1, 2)
                        k = k.view(B, T, NUM_HEADS, HEAD_DIM).transpose(1, 2)
                        v = v.view(B, T, NUM_HEADS, HEAD_DIM).transpose(1, 2)

                        # Apply RoPE (half rotation)
                        q_rot = q.clone()
                        k_rot = k.clone()
                        # cos/sin: [B, T, head_dim] → need [B, 1, T, head_dim]
                        cos_t = cos[:, :T, :].unsqueeze(1).to(q.dtype)
                        sin_t = sin[:, :T, :].unsqueeze(1).to(q.dtype)
                        q_rot[..., : HEAD_DIM // 2] = (
                            q[..., : HEAD_DIM // 2] * cos_t[..., : HEAD_DIM // 2]
                            - q[..., HEAD_DIM // 2 :] * sin_t[..., : HEAD_DIM // 2]
                        )
                        q_rot[..., HEAD_DIM // 2 :] = (
                            q[..., : HEAD_DIM // 2] * sin_t[..., : HEAD_DIM // 2]
                            + q[..., HEAD_DIM // 2 :] * cos_t[..., HEAD_DIM // 2 :]
                        )
                        k_rot[..., : HEAD_DIM // 2] = (
                            k[..., : HEAD_DIM // 2] * cos_t[..., : HEAD_DIM // 2]
                            - k[..., HEAD_DIM // 2 :] * sin_t[..., : HEAD_DIM // 2]
                        )
                        k_rot[..., HEAD_DIM // 2 :] = (
                            k[..., : HEAD_DIM // 2] * sin_t[..., : HEAD_DIM // 2]
                            + k[..., HEAD_DIM // 2 :] * cos_t[..., HEAD_DIM // 2 :]
                        )

                        # Attention
                        attn_weights = torch.matmul(
                            q_rot, k_rot.transpose(-2, -1)
                        ) / math.sqrt(HEAD_DIM)
                        if attn_mask is not None:
                            attn_weights = attn_weights + attn_mask
                        attn_weights = torch.nn.functional.softmax(
                            attn_weights, dim=-1, dtype=torch.float32
                        ).to(q.dtype)
                        attn_output = torch.matmul(attn_weights, v)

                        # Reshape back
                        attn_output = attn_output.transpose(1, 2).reshape(B, T, D)
                    else:
                        # No RoPE — simple attention
                        B, T, D = q.shape
                        q_a = q.view(B, T, NUM_HEADS, HEAD_DIM).transpose(1, 2)
                        k_a = k.view(B, T, NUM_HEADS, HEAD_DIM).transpose(1, 2)
                        v_a = v.view(B, T, NUM_HEADS, HEAD_DIM).transpose(1, 2)
                        attn_weights = torch.matmul(
                            q_a, k_a.transpose(-2, -1)
                        ) / math.sqrt(HEAD_DIM)
                        if attn_mask is not None:
                            attn_weights = attn_weights + attn_mask
                        attn_weights = torch.nn.functional.softmax(
                            attn_weights, dim=-1, dtype=torch.float32
                        ).to(q.dtype)
                        attn_output = torch.matmul(attn_weights, v_a)
                        attn_output = attn_output.transpose(1, 2).reshape(B, T, D)

                    # o_proj
                    capture(f"{ln_name}.self_attn.o_proj", attn_output)
                    attn_out = layer.self_attn.o_proj(attn_output)

                    # Residual
                    h = h + attn_out

                    # post_attention_layernorm
                    capture(f"{ln_name}.post_attention_layernorm.to_weight", h)
                    h_norm2 = layer.post_attention_layernorm(h, cond_embedding=t_emb)

                    # MLP: gate_proj, up_proj, down_proj
                    capture(f"{ln_name}.mlp.gate_proj", h_norm2)
                    gate = layer.mlp.gate_proj(h_norm2)
                    gate = torch.nn.functional.silu(gate)

                    capture(f"{ln_name}.mlp.up_proj", h_norm2)
                    up = layer.mlp.up_proj(h_norm2)

                    mlp_hidden = gate * up

                    capture(f"{ln_name}.mlp.down_proj", mlp_hidden)
                    mlp_out = layer.mlp.down_proj(mlp_hidden)

                    # Residual
                    h = h + mlp_out

                # Final norm
                capture("norm.to_weight", h)
                h = diff.norm(h, cond_embedding=t_emb)

                # mel_out_mlp
                capture("mel_out_mlp.0", h)
                h_out = diff.mel_out_mlp[0](h)
                h_out = torch.nn.functional.silu(h_out)
                capture("mel_out_mlp.2", h_out)
                h_out = diff.mel_out_mlp[2](h_out)

            except Exception as e:
                if i == 0:
                    print(f"  [WARN] Manual forward failed for sample {i}: {e}")
                    traceback.print_exc()

        if (i + 1) % 8 == 0:
            print(f"    Collected {i + 1}/{num_samples} samples")

    # Concatenate captured inputs (limit total tokens per layer)
    max_tokens = 2048
    result = {}
    for name, tensors in captured.items():
        all_x = torch.cat(tensors, dim=0)
        if all_x.shape[0] > max_tokens:
            idx = torch.randperm(all_x.shape[0])[:max_tokens]
            all_x = all_x[idx]
        result[name] = all_x.cpu()  # Store on CPU to save VRAM

    total_mem = sum(x.numel() * x.element_size() for x in result.values())
    print(
        f"  Calibration data collected: {len(result)}/{len(linear_names)} layers, ~{total_mem / 1e6:.1f}MB"
    )

    # Move diff back to CPU
    diff = diff.cpu()
    clear_memory()

    # Return both captured data and the linear layer dict
    linear_layers = {}
    for name, module in model.cfm_decoder.model.diff_estimator.named_modules():
        if isinstance(module, nn.Linear):
            linear_layers[name] = module

    return result, linear_layers


def run_qdit_gptq(model, captured_inputs=None, linear_layers=None):
    """Run QDiT GPTQ on all Linear layers in DiffLlama.

    For each Linear layer:
    1. Move layer to GPU
    2. Feed calibration data through GPTQ
    3. Quantize weights with Hessian-based error compensation
    4. Move layer back to CPU
    """
    print("\n" + "=" * 60)
    print("Phase 1: QDiT GPTQ Weight Optimization for DiffLlama")
    print("=" * 60)

    diff_estimator = model.cfm_decoder.model.diff_estimator

    # Move entire model to CPU to free VRAM for GPTQ operations
    diff_estimator.cpu()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    print("  Model moved to CPU, VRAM freed for GPTQ")

    # Collect calibration data if not provided
    if captured_inputs is None or linear_layers is None:
        captured_inputs, linear_layers = collect_diff_step_calibration(model)
        # Move model back to CPU after calibration
        diff_estimator.cpu()
        clear_memory()

    # Quantize each Linear layer
    total_loss = 0.0
    quantized_count = 0
    failed_layers = []

    for name, layer in linear_layers.items():
        print(f"\n  [{quantized_count + 1}/{len(linear_layers)}] GPTQ: {name}")
        print(f"    Weight shape: {layer.weight.shape}")

        try:
            # Move layer to GPU
            layer.to(DEVICE)
            W_orig = layer.weight.data.clone()

            # Create GPTQ quantizer
            gptq = GPTQQuantizer(
                layer,
                w_bits=W_BITS,
                sym=True,
                perchannel=True,
                mse=False,
                clip_ratio=1.0,
                groupsize=-1,
            )

            # Feed calibration data
            if name in captured_inputs:
                calib_x = captured_inputs[name].to(DEVICE)
                with torch.no_grad():
                    out = layer(calib_x)
                gptq.add_batch(
                    calib_x.unsqueeze(0) if calib_x.dim() == 2 else calib_x, out
                )
                del calib_x, out
            else:
                print(f"    [WARN] No calibration data for {name}, skipping GPTQ")
                layer.cpu()
                continue

            # Run GPTQ quantization
            loss = gptq.fasterquant(blocksize=128, percdamp=0.01)
            total_loss += loss
            quantized_count += 1

            # Compute weight change
            W_quant = layer.weight.data
            weight_diff = (W_orig - W_quant).abs().mean().item()
            weight_max = W_orig.abs().max().item()
            print(
                f"    GPTQ loss: {loss:.6f}, weight diff: {weight_diff:.6f} (max: {weight_max:.4f})"
            )

            gptq.free()
            del W_orig

        except Exception as e:
            print(f"    [ERROR] GPTQ failed for {name}: {e}")
            traceback.print_exc()
            failed_layers.append(name)

        # Move layer back to CPU
        layer.cpu()
        clear_memory()

    print(
        f"\n  GPTQ completed: {quantized_count}/{len(linear_layers)} layers quantized"
    )
    if failed_layers:
        print(f"  Failed layers ({len(failed_layers)}): {failed_layers[:10]}...")
    print(f"  Total GPTQ loss: {total_loss:.6f}")

    return model


# ============================================================
# Phase 2: AWQ Weight Scaling for Vocos Vocoder
# ============================================================


def collect_vocoder_calibration(model, num_samples=32, seq_len=VOCODER_SEQ_LEN):
    """Collect calibration data for Vocoder Conv1d and Linear layers."""
    print(
        f"  Collecting {num_samples} vocoder calibration samples (seq_len={seq_len})..."
    )

    vocoder = model.vocoder
    vocoder = vocoder.to(DEVICE).eval()

    captured_inputs = {}
    hooks = []
    target_layers = {}

    def make_hook(name):
        def hook_fn(module, inp, out):
            if name not in captured_inputs:
                captured_inputs[name] = []
            x = inp[0].detach().cpu()
            if x.numel() > 0:
                captured_inputs[name].append(x)

        return hook_fn

    # Collect Conv1d and Linear layers in Vocoder
    for name, module in vocoder.named_modules():
        if isinstance(module, (nn.Conv1d, nn.Linear)):
            target_layers[name] = module
            h = module.register_forward_hook(make_hook(name))
            hooks.append(h)

    print(f"  Found {len(target_layers)} Conv1d/Linear layers in Vocoder")

    # Generate realistic mel inputs
    for i in range(num_samples):
        # Realistic mel spectrogram: log-mel with mean=-4.92, var=8.14
        mel = torch.randn(1, seq_len, MEL_DIM, device=DEVICE) * math.sqrt(8.14) + (
            -4.92
        )
        mel = mel.clamp(-20, 5)

        with torch.no_grad():
            try:
                _ = vocoder(mel)
            except Exception as e:
                if i == 0:
                    print(f"  [WARN] Vocoder forward failed: {e}")

        if (i + 1) % 8 == 0:
            print(f"    Collected {i + 1}/{num_samples} samples")

    for h in hooks:
        h.remove()

    # Process captured data
    max_tokens = 2048
    for name in captured_inputs:
        tensors = captured_inputs[name]
        all_x = torch.cat([t.reshape(-1, t.shape[-1]) for t in tensors], dim=0)
        if all_x.shape[0] > max_tokens:
            idx = torch.randperm(all_x.shape[0])[:max_tokens]
            all_x = all_x[idx]
        captured_inputs[name] = all_x

    vocoder = vocoder.cpu()
    clear_memory()

    return captured_inputs, target_layers


def run_awq_vocoder(model, captured_inputs=None, target_layers=None):
    """Apply AWQ (Activation-aware Weight Quantization) to Vocoder.

    AWQ identifies salient weight channels based on activation magnitudes
    and scales them to minimize quantization error.

    For W8A32: only weights are quantized to INT8, activations stay FP32.
    The AWQ scaling is folded into the weight tensor before export.
    """
    print("\n" + "=" * 60)
    print("Phase 2: AWQ Weight Scaling for Vocos Vocoder (W8A32)")
    print("=" * 60)

    vocoder = model.vocoder

    if captured_inputs is None or target_layers is None:
        captured_inputs, target_layers = collect_vocoder_calibration(model)

    # AWQ: for each layer, compute activation-aware scaling
    awq_alpha = 0.5  # Balance between activation and weight importance
    awq_n_grid = 20  # Grid search for optimal scale
    awq_max_ratio = 2.0  # Maximum scale ratio

    processed_count = 0

    for name, layer in target_layers.items():
        print(f"\n  [{processed_count + 1}/{len(target_layers)}] AWQ: {name}")
        print(f"    Weight shape: {layer.weight.shape}")

        if name not in captured_inputs:
            print(f"    [SKIP] No calibration data for {name}")
            continue

        # Get calibration activations
        x_calib = captured_inputs[name].to(DEVICE)
        W = layer.weight.data.to(DEVICE)

        # Compute per-input-channel activation magnitude
        # x_calib: [N, in_features]
        x_mag = x_calib.abs().mean(dim=0)  # [in_features]
        x_mag = x_mag.clamp(min=1e-8)

        # Compute per-input-channel weight magnitude
        # W: [out_features, in_features] for Linear
        # W: [out_channels, in_channels/groups, kernel_size] for Conv1d
        if isinstance(layer, nn.Conv1d):
            # Reshape: [out_channels, in_channels_per_group * kernel_size]
            W_flat = W.reshape(W.shape[0], -1)
        else:
            W_flat = W  # [out_features, in_features]

        w_mag = W_flat.abs().mean(dim=0)  # [in_features]
        w_mag = w_mag.clamp(min=1e-8)

        # Compute AWQ scale: s = (x_mag^alpha * w_mag^(1-alpha))
        # This identifies channels where activation*weight is large (salient)
        score = (x_mag**awq_alpha) * (w_mag ** (1 - awq_alpha))

        # Find optimal scale ratio via grid search
        # Scale: s = ratio^score_normalized
        # We want to amplify salient channels and shrink non-salient ones
        best_ratio = 1.0
        best_loss = float("inf")

        # Get reference output (FP32)
        with torch.no_grad():
            if isinstance(layer, nn.Conv1d):
                # Conv1d expects [B, C, L]
                x_ref = x_calib[: min(64, x_calib.shape[0]), :].t().unsqueeze(0)
                if x_ref.shape[1] < W.shape[1]:
                    # Pad to match in_channels
                    x_ref = x_ref[:, : W.shape[1], :]
                ref_out = layer(x_ref)
            else:
                x_ref = x_calib[: min(256, x_calib.shape[0]), :]
                if x_ref.shape[1] != W.shape[1]:
                    # Skip if dimension mismatch
                    continue
                ref_out = layer(x_ref)

        for ratio_idx in range(awq_n_grid):
            ratio = 1.0 + (ratio_idx / awq_n_grid - 0.5) * awq_max_ratio
            ratio = max(0.5, min(2.0, ratio))

            # Apply scale: amplify salient channels
            scale = torch.ones_like(score)
            # Normalize score to [0, 1]
            score_norm = score / score.max()
            scale = 1.0 + (ratio - 1.0) * score_norm

            # Scale weights and inverse-scale activations
            W_scaled = W_flat * scale.unsqueeze(0)  # [out, in]

            # Quantize-dequantize scaled weights
            w_max = W_scaled.abs().amax(dim=0, keepdim=True).clamp(min=1e-8)
            q_max = 2 ** (W_BITS_VOC - 1) - 1
            W_q = torch.clamp(torch.round(W_scaled * q_max / w_max), -q_max, q_max)
            W_dq = W_q * w_max / q_max

            # Inverse scale (fold back)
            W_final = W_dq / scale.unsqueeze(0)

            # Compute output with quantized weights
            with torch.no_grad():
                if isinstance(layer, nn.Conv1d):
                    W_orig_shape = W_final.reshape(W.shape)
                    # Create a temporary conv with quantized weights
                    tmp_conv = nn.Conv1d(
                        W.shape[1],
                        W.shape[0],
                        layer.kernel_size,
                        stride=layer.stride,
                        padding=layer.padding,
                        dilation=layer.dilation,
                        groups=layer.groups,
                        bias=layer.bias is not None,
                    ).to(DEVICE)
                    tmp_conv.weight.data = W_orig_shape
                    if layer.bias is not None:
                        tmp_conv.bias.data = layer.bias.data
                    quant_out = tmp_conv(x_ref)
                    del tmp_conv
                else:
                    quant_out = torch.nn.functional.linear(x_ref, W_final, layer.bias)

                # MSE loss
                loss = ((ref_out - quant_out) ** 2).mean().item()

            if loss < best_loss:
                best_loss = loss
                best_ratio = ratio
                best_W = W_final.clone()

            del W_scaled, W_q, W_dq, W_final

        # Apply best scaling
        scale = torch.ones_like(score)
        score_norm = score / score.max()
        scale = 1.0 + (best_ratio - 1.0) * score_norm

        if isinstance(layer, nn.Conv1d):
            W_scaled = W * scale.reshape(
                1, W.shape[1] if layer.groups == 1 else W.shape[1], 1
            )
            # For grouped conv, scale per group
            if layer.groups > 1:
                scale = scale.reshape(layer.groups, -1).mean(dim=1)
                scale = scale.repeat_interleave(W.shape[0] // layer.groups)
                W_scaled = W * scale.reshape(-1, 1, 1)
        else:
            W_scaled = W * scale.unsqueeze(0)

        # Quantize-dequantize (simulating INT8 quantization)
        w_max = W_scaled.abs().amax(dim=-1, keepdim=True).clamp(min=1e-8)
        q_max = 2 ** (W_BITS_VOC - 1) - 1
        W_q = torch.clamp(torch.round(W_scaled * q_max / w_max), -q_max, q_max)
        W_dq = W_q * w_max / q_max

        # Inverse scale
        if isinstance(layer, nn.Conv1d):
            W_final = (
                W_dq / scale.reshape(-1, 1, 1)
                if layer.groups > 1
                else W_dq / scale.reshape(1, -1, 1)
            )
        else:
            W_final = W_dq / scale.unsqueeze(0)

        layer.weight.data = W_final.reshape(W.shape).cpu()
        processed_count += 1

        print(f"    Best ratio: {best_ratio:.4f}, loss: {best_loss:.8f}")

        del x_calib, W, W_scaled, W_q, W_dq, W_final, scale, score
        clear_memory()

    print(f"\n  AWQ completed: {processed_count}/{len(target_layers)} layers processed")
    return model


# ============================================================
# Phase 3: Export to ONNX (FP32, GPTQ/AWQ-optimized)
# ============================================================


def export_diffstep_onnx(model, output_dir):
    """Export GPTQ-optimized DiffStep to ONNX with QDIT input signature.

    Input signature: x / diffusion_step / cond / x_mask(bool)
    This matches the QDIT signature expected by SXSEditor.
    """
    print("\n" + "=" * 60)
    print("Phase 3a: Export DiffStep to ONNX (GPTQ-optimized)")
    print("=" * 60)

    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, "diffstep.onnx")

    # Create wrapper with QDIT signature
    wrapper = DiffStepWrapper(model.cfm_decoder).to(DEVICE).eval()

    # Create dummy inputs with QDIT signature
    seq_len = 256  # Small for export, dynamic shapes supported
    dummy_inputs = {
        "x": torch.randn(1, seq_len, MEL_DIM, device=DEVICE),
        "diffusion_step": torch.tensor([0.5], device=DEVICE),
        "cond": torch.randn(1, seq_len, COND_DIM, device=DEVICE),
        "x_mask": torch.ones(1, seq_len, device=DEVICE, dtype=torch.bool),
    }

    # Use the patched DiffLlama.forward (from export_shared.py)
    # The _pdl forward expects: x, diffusion_step, cond, x_mask
    # But DiffStepWrapper calls diff_estimator(xt_input, t, cond, xt_mask)
    # We need to rename inputs for QDIT signature

    # Export with QDIT input names
    input_names = ["x", "diffusion_step", "cond", "x_mask"]
    output_names = ["flow_pred"]
    args_tuple = tuple(dummy_inputs.values())

    # Dynamic shapes
    dynamic_shapes = {
        "x": {0: "batch", 1: "seq_len"},
        "cond": {0: "batch", 1: "seq_len"},
        "x_mask": {0: "batch", 1: "seq_len"},
    }

    print(f"  Exporting to {output_path}...")

    # Use torch.onnx.export with dynamo=True
    tmp_path = output_path + ".raw.onnx"
    with torch.no_grad():
        torch.onnx.export(
            wrapper,
            args_tuple,
            tmp_path,
            input_names=input_names,
            output_names=output_names,
            opset_version=20,
            dynamo=True,
            dynamic_shapes=dynamic_shapes,
        )

    # Apply DML post-processing from export_shared.py
    from export_shared import postprocess_onnx

    model_onnx = postprocess_onnx(
        tmp_path,
        output_path,
        fix_mixed_precision=False,
        decompose_conv_transpose=False,
        dynamic_input_shape=True,
        skip_stft_replace=True,  # No STFT in diff_step
        skip_dml_fixes=False,
    )

    if os.path.exists(tmp_path):
        os.remove(tmp_path)
    if os.path.exists(tmp_path + ".data"):
        os.remove(tmp_path + ".data")

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    data_path = output_path + ".data"
    data_mb = (
        os.path.getsize(data_path) / (1024 * 1024) if os.path.exists(data_path) else 0
    )
    print(f"  Exported: {output_path} ({size_mb:.1f}MB + {data_mb:.1f}MB data)")

    wrapper = wrapper.cpu()
    del dummy_inputs, args_tuple
    clear_memory()

    return output_path


def export_vocoder_onnx(model, output_dir):
    """Export AWQ-optimized Vocoder to ONNX."""
    print("\n" + "=" * 60)
    print("Phase 3b: Export Vocoder to ONNX (AWQ-optimized)")
    print("=" * 60)

    os.makedirs(output_dir, exist_ok=True)
    output_path = os.path.join(output_dir, "vocoder_dml.onnx")

    wrapper = VocosFullWrapper(model.vocoder).to(DEVICE).eval()

    seq_len = VOCODER_SEQ_LEN
    dummy_inputs = {
        "mel": torch.randn(1, seq_len, MEL_DIM, device=DEVICE),
    }

    input_names = ["mel"]
    output_names = ["audio"]
    args_tuple = tuple(dummy_inputs.values())

    dynamic_shapes = {
        "mel": {0: "batch", 1: "seq_len"},
    }

    print(f"  Exporting to {output_path}...")

    tmp_path = output_path + ".raw.onnx"
    with torch.no_grad():
        torch.onnx.export(
            wrapper,
            args_tuple,
            tmp_path,
            input_names=input_names,
            output_names=output_names,
            opset_version=20,
            dynamo=True,
            dynamic_shapes=dynamic_shapes,
        )

    from export_shared import postprocess_onnx

    model_onnx = postprocess_onnx(
        tmp_path,
        output_path,
        fix_mixed_precision=False,
        decompose_conv_transpose=True,
        dynamic_input_shape=True,
        skip_stft_replace=False,  # Vocoder has ISTFT
        skip_dml_fixes=False,
    )

    if os.path.exists(tmp_path):
        os.remove(tmp_path)
    if os.path.exists(tmp_path + ".data"):
        os.remove(tmp_path + ".data")

    size_mb = os.path.getsize(output_path) / (1024 * 1024)
    data_path = output_path + ".data"
    data_mb = (
        os.path.getsize(data_path) / (1024 * 1024) if os.path.exists(data_path) else 0
    )
    print(f"  Exported: {output_path} ({size_mb:.1f}MB + {data_mb:.1f}MB data)")

    wrapper = wrapper.cpu()
    del dummy_inputs, args_tuple
    clear_memory()

    return output_path


# ============================================================
# Phase 4: ORT Static Quantization (QDQ format, true INT8)
# ============================================================


def quantize_onnx_qdq(
    fp32_path,
    int8_path,
    calibration_feeds,
    model_name,
    per_channel=True,
    w_bits=8,
    a_bits=8,
    weight_only=False,
):
    """Apply ORT quantization producing true INT8 ONNX.

    For W8A8 (weight_only=False): static QDQ quantization — INT8 weights + INT8 activations.
    DML EP fuses Q→MatMul→DQ for INT8 Tensor Core acceleration.

    For W8A32 (weight_only=True): dynamic quantization — INT8 weights + FP32 activations.
    Uses quantize_dynamic which inserts DequantizeLinear nodes for weights only.
    True INT8 weight tensors stored in the ONNX, activations remain FP32.
    """
    import onnx
    import onnxruntime as ort
    from onnxruntime.quantization import (
        QuantType,
        CalibrationDataReader,
    )

    print(f"\n  Quantizing: {os.path.basename(fp32_path)}")
    print(f"    Mode: {'W8A32 (weight-only)' if weight_only else 'W8A8 (full INT8)'}")

    if weight_only:
        # W8A32: Use dynamic quantization (weight-only, no activation calibration needed)
        from onnxruntime.quantization import quantize_dynamic

        print(
            f"    Running ORT dynamic quantization (weight-only, per_channel={per_channel})..."
        )
        try:
            quantize_dynamic(
                model_input=fp32_path,
                model_output=int8_path,
                op_types_to_quantize=["MatMul", "Gemm", "Conv"],
                weight_type=QuantType.QInt8,
                per_channel=per_channel,
                reduce_range=False,
            )
        except Exception as e:
            print(f"    [ERROR] Dynamic quantization failed: {e}")
            traceback.print_exc()
            return None
    else:
        # W8A8: Static QDQ quantization (both weights and activations)
        from onnxruntime.quantization import (
            quantize,
            QuantFormat,
            StaticQuantConfig,
        )
        from onnxruntime.quantization.preprocess import (
            quant_pre_process as quant_preprocess,
        )

        # Step 1: Pre-process (symbolic shape inference + optimization)
        preproc_path = fp32_path.replace(".onnx", "_preproc.onnx")
        print(f"    Pre-processing...")
        try:
            quant_preprocess(
                input_model=fp32_path,
                output_model_path=preproc_path,
                skip_onnx_shape=False,
                skip_symbolic_shape=False,
                skip_optimization=False,
            )
        except Exception as e:
            print(f"    [WARN] Pre-processing failed ({e}), using original")
            preproc_path = fp32_path

        # Step 2: Create calibration data reader
        class CalibReader(CalibrationDataReader):
            def __init__(self, data_list):
                self.data = data_list
                self.idx = 0

            def get_next(self):
                if self.idx >= len(self.data):
                    return None
                result = self.data[self.idx]
                self.idx += 1
                return result

        reader = CalibReader(calibration_feeds)

        # Step 3: Configure quantization
        activation_type = QuantType.QUInt8  # Asymmetric for better accuracy
        weight_type = QuantType.QInt8
        op_types = ["MatMul", "Gemm", "Conv"]
        extra_opts = {
            "ActivationSymmetric": False,
            "WeightSymmetric": True,
            "QuantizeBias": False,
            "AddQDQPairToWeight": True,
        }

        config = StaticQuantConfig(
            calibration_data_reader=reader,
            quant_format=QuantFormat.QDQ,
            per_channel=per_channel,
            reduce_range=False,
            activation_type=activation_type,
            weight_type=weight_type,
            op_types_to_quantize=op_types,
            extra_options=extra_opts,
        )

        # Step 4: Run quantization
        print(
            f"    Running ORT static quantization (QDQ, per_channel={per_channel})..."
        )
        try:
            quantize(
                model_input=preproc_path,
                model_output=int8_path,
                quant_config=config,
            )
        except Exception as e:
            print(f"    [ERROR] Quantization failed: {e}")
            traceback.print_exc()
            return None

        # Cleanup preproc
        if preproc_path != fp32_path and os.path.exists(preproc_path):
            os.remove(preproc_path)
            data_file = preproc_path + ".data"
            if os.path.exists(data_file):
                os.remove(data_file)

    # Step 5: Verify quantization result
    qmodel = onnx.load(int8_path, load_external_data=False)
    ops = {}
    for n in qmodel.graph.node:
        ops[n.op_type] = ops.get(n.op_type, 0) + 1

    ql = ops.get("QuantizeLinear", 0)
    dql = ops.get("DequantizeLinear", 0)

    size_mb = os.path.getsize(int8_path) / (1024 * 1024)
    data_path = int8_path + ".data"
    data_mb = (
        os.path.getsize(data_path) / (1024 * 1024) if os.path.exists(data_path) else 0
    )

    print(
        f"    INT8 ONNX: {os.path.basename(int8_path)} ({size_mb:.1f}MB + {data_mb:.1f}MB data)"
    )
    print(f"    QDQ nodes: {ql} QuantizeLinear + {dql} DequantizeLinear")

    # Check for true INT8 weight tensors
    int8_weights = 0
    for init in qmodel.graph.initializer:
        if init.data_type == 3:  # INT8
            int8_weights += 1

    print(f"    INT8 weight tensors: {int8_weights}")

    del qmodel
    gc.collect()

    return int8_path


def generate_diffstep_calibration_feeds(num_samples=32, seq_len=512):
    """Generate calibration feeds for diff_step ONNX quantization."""
    feeds = []
    for i in range(num_samples):
        feed = {
            "x": np.random.randn(1, seq_len, MEL_DIM).astype(np.float32) * 0.5,
            "diffusion_step": np.array([i / num_samples], dtype=np.float32),
            "cond": np.random.randn(1, seq_len, COND_DIM).astype(np.float32) * 0.3,
            "x_mask": np.ones((1, seq_len), dtype=bool),
        }
        feeds.append(feed)
    return feeds


def generate_vocoder_calibration_feeds(num_samples=32, seq_len=VOCODER_SEQ_LEN):
    """Generate calibration feeds for vocoder ONNX quantization."""
    feeds = []
    for i in range(num_samples):
        # Realistic mel: log-mel distribution
        mel = np.random.randn(1, seq_len, MEL_DIM).astype(np.float32) * math.sqrt(
            8.14
        ) + (-4.92)
        mel = np.clip(mel, -20, 5)
        feed = {"mel": mel}
        feeds.append(feed)
    return feeds


def run_ort_quantization():
    """Run ORT static quantization on the GPTQ/AWQ-optimized ONNX models."""
    print("\n" + "=" * 60)
    print("Phase 4: ORT Static Quantization (QDQ INT8)")
    print("=" * 60)

    os.makedirs(ONNX_INT8_DIR, exist_ok=True)

    results = {}

    # Quantize diff_step: W8A8 (full INT8)
    diffstep_fp32 = os.path.join(ONNX_FP32_DIR, "diffstep.onnx")
    diffstep_int8 = os.path.join(ONNX_INT8_DIR, "diffstep.onnx")
    if os.path.exists(diffstep_fp32):
        print(f"\n  DiffStep W8A8 quantization...")
        calib_feeds = generate_diffstep_calibration_feeds(num_samples=32, seq_len=512)
        result = quantize_onnx_qdq(
            diffstep_fp32,
            diffstep_int8,
            calib_feeds,
            "diff_step",
            per_channel=True,
            w_bits=8,
            a_bits=8,
            weight_only=False,
        )
        results["diff_step"] = result
        del calib_feeds
        gc.collect()
    else:
        print(f"\n  [SKIP] DiffStep FP32 not found: {diffstep_fp32}")

    # Quantize vocoder: W8A32 (weight-only)
    vocoder_fp32 = os.path.join(ONNX_FP32_DIR, "vocoder_dml.onnx")
    vocoder_int8 = os.path.join(ONNX_INT8_DIR, "vocoder_dml.onnx")
    if os.path.exists(vocoder_fp32):
        print(f"\n  Vocoder W8A32 quantization...")
        calib_feeds = generate_vocoder_calibration_feeds(
            num_samples=32, seq_len=VOCODER_SEQ_LEN
        )
        result = quantize_onnx_qdq(
            vocoder_fp32,
            vocoder_int8,
            calib_feeds,
            "vocoder",
            per_channel=True,
            w_bits=8,
            a_bits=32,
            weight_only=True,
        )
        results["vocoder"] = result
        del calib_feeds
        gc.collect()
    else:
        print(f"\n  [SKIP] Vocoder FP32 not found: {vocoder_fp32}")

    return results


# ============================================================
# Phase 5: Save Quantized PyTorch Weights
# ============================================================


def save_quantized_pt(model, output_dir):
    """Save the GPTQ+AWQ quantized PyTorch model."""
    print("\n" + "=" * 60)
    print("Phase 5: Save Quantized PyTorch Weights (.pt)")
    print("=" * 60)

    os.makedirs(output_dir, exist_ok=True)

    # Save the entire model state dict
    state_dict = model.state_dict()

    # Save diff_estimator (GPTQ-quantized) separately
    diff_estimator_sd = model.cfm_decoder.model.diff_estimator.state_dict()
    diff_path = os.path.join(output_dir, "diff_estimator_qdit_w8a8.pt")
    torch.save(
        {
            "state_dict": diff_estimator_sd,
            "quant_config": {
                "method": "QDiT-GPTQ",
                "w_bits": W_BITS,
                "a_bits": A_BITS,
                "symmetric": True,
                "per_channel": True,
                "blocksize": 128,
                "percdamp": 0.01,
            },
        },
        diff_path,
    )
    print(f"  Saved: {diff_path} ({os.path.getsize(diff_path) / 1e6:.1f}MB)")

    # Save vocoder (AWQ-quantized) separately
    vocoder_sd = model.vocoder.state_dict()
    voc_path = os.path.join(output_dir, "vocoder_awq_w8a32.pt")
    torch.save(
        {
            "state_dict": vocoder_sd,
            "quant_config": {
                "method": "AWQ",
                "w_bits": W_BITS_VOC,
                "a_bits": A_BITS_VOC,
                "alpha": 0.5,
                "per_channel": True,
            },
        },
        voc_path,
    )
    print(f"  Saved: {voc_path} ({os.path.getsize(voc_path) / 1e6:.1f}MB)")

    # Save full model
    full_path = os.path.join(output_dir, "soulx_singer_qdit_w8a8.pt")
    torch.save(
        {
            "state_dict": state_dict,
            "quant_config": {
                "diff_step": {
                    "method": "QDiT-GPTQ",
                    "w_bits": W_BITS,
                    "a_bits": A_BITS,
                },
                "vocoder": {
                    "method": "AWQ",
                    "w_bits": W_BITS_VOC,
                    "a_bits": A_BITS_VOC,
                },
            },
        },
        full_path,
    )
    print(f"  Saved: {full_path} ({os.path.getsize(full_path) / 1e6:.1f}MB)")


# ============================================================
# Main
# ============================================================


def main():
    parser = argparse.ArgumentParser(description="QDiT W8A8 Quantization Pipeline")
    parser.add_argument(
        "--phase",
        default="all",
        help="Phase to run: 1(gptq), 2(awq), 3(export), 4(ort_quant), 5(save_pt), all",
    )
    parser.add_argument(
        "--model-path", default=None, help="Path to SoulX-Singer model.pt"
    )
    args = parser.parse_args()

    phase = args.phase.lower()

    print("=" * 60)
    print("QDiT W8A8 Quantization Pipeline for SoulX-Singer")
    print(f"Device: {DEVICE}")
    print(f"Output: {OUTPUT_DIR}")
    if DEVICE == "cuda":
        print(f"GPU: {torch.cuda.get_device_name(0)}")
        print(f"VRAM: {torch.cuda.get_device_properties(0).total_memory / 1e9:.1f}GB")
    print("=" * 60)

    # Create output directories
    for d in [OUTPUT_DIR, PT_OUTPUT_DIR, ONNX_FP32_DIR, ONNX_INT8_DIR]:
        os.makedirs(d, exist_ok=True)

    # Load config and model
    config = load_config()
    model_path = args.model_path or os.path.join(
        SOULX_DIR, "pretrained_models", "SoulX-Singer", "model.pt"
    )

    print(f"\nLoading model: {model_path}")
    model = load_model(config, model_path)
    model.eval()
    print(f"  Model loaded successfully")

    # Run requested phases
    if phase in ("1", "gptq", "all"):
        # Phase 1: QDiT GPTQ
        captured, layers = collect_diff_step_calibration(model)
        model = run_qdit_gptq(model, captured, layers)
        del captured, layers
        clear_memory()

    if phase in ("2", "awq", "all"):
        # Phase 2: AWQ Vocoder
        captured, layers = collect_vocoder_calibration(model)
        model = run_awq_vocoder(model, captured, layers)
        del captured, layers
        clear_memory()

    if phase in ("3", "export", "all"):
        # Phase 3: Export to ONNX
        export_diffstep_onnx(model, ONNX_FP32_DIR)
        clear_memory()
        export_vocoder_onnx(model, ONNX_FP32_DIR)
        clear_memory()

    if phase in ("4", "ort_quant", "all"):
        # Phase 4: ORT quantization
        run_ort_quantization()

    if phase in ("5", "save_pt", "all"):
        # Phase 5: Save PT
        save_quantized_pt(model, PT_OUTPUT_DIR)

    # Cleanup
    del model
    clear_memory()

    print("\n" + "=" * 60)
    print("Pipeline complete!")
    print(f"  ONNX FP32 (GPTQ/AWQ-optimized): {ONNX_FP32_DIR}")
    print(f"  ONNX INT8 (QDQ):                {ONNX_INT8_DIR}")
    print(f"  PyTorch weights:                 {PT_OUTPUT_DIR}")
    print("=" * 60)


if __name__ == "__main__":
    main()
