# SXSEditor Tools — Quantization / Export / Optimization Scripts

All commands are PowerShell one-liners, run from the project root `d:\Document\electron\SXSEditor`.

---

## 1. FP8 Quantization (Weight-only, float8_e4m3fn)

**Script:** `quantize_fp8.py`
Converts FP16 ONNX models to FP8 (weight-only) via QDQ node insertion on MatMul/Gemm weights.
No calibration data needed — pure weight quantization.

**Output:** `onnx_models/fp8/`

```powershell
# Quantize all models
python quantize_fp8.py

# Quantize specific models
python quantize_fp8.py --models vocoder_dml,diff_step_dml

# Quantize and verify accuracy (cosine similarity vs FP16)
python quantize_fp8.py --verify

# Skip preprocess models
python quantize_fp8.py --skip-preprocess
```

---

## 2. W8A8 INT8 Quantization v2 (Recommended)

**Script:** `quantize_w8a8_v2.py`
Full pipeline with pre-processing + pipeline-based real calibration.
Exports both INT8 (ORT CPU) and NPU-optimized (WebNN) versions.

**Requires:** SoulX-Singer PyTorch model at `SoulX-Singer/pretrained_models/SoulX-Singer/model.pt`

**Output:**
- INT8 (ORT CPU): `onnx_models/int8/`
- NPU (WebNN): `onnx_models/int8/optimized_npu/`

```powershell
# Quantize all models with default model path
python quantize_w8a8_v2.py

# Quantize with custom model path
python quantize_w8a8_v2.py --model-path "D:\Document\electron\SXSEditor\SoulX-Singer\pretrained_models\SoulX-Singer\model.pt"

# Quantize specific models only
python quantize_w8a8_v2.py --models diff_step,vocoder,preflow
```

---

## 3. W8A8 NPU Export Pipeline

**Script:** `export_w8a8_npu.py`
W8A8 PTQ pipeline: load PyTorch → export FP32 ONNX → calibrate → quantize → NPU optimize.

```powershell
python export_w8a8_npu.py
```

---

## 4. W8A8 Accuracy Verification

**Script:** `verify_w8a8_accuracy.py`
Verify W8A8 INT8 vs FP32 ONNX model accuracy (MSE, cosine similarity, max diff).

```powershell
python verify_w8a8_accuracy.py
```

---

## 5. Compare FP32 vs W8A8 Accuracy

**Script:** `compare_w8a8_fp32.py`
Compares FP32 models from `onnx_models/` with W8A8 models from `onnx_models/int8/optimized_npu/`.

```powershell
python compare_w8a8_fp32.py
```

---

## 6. Full INT8 Export Pipeline (4 Isolated Processes)

**Script:** `export_int8_pipeline.py`
Runs each step in a separate process for complete memory isolation.

```powershell
# Full pipeline with default paths
python export_int8_pipeline.py

# With custom model path and output directory
python export_int8_pipeline.py --model-path "D:\Document\electron\SXSEditor\SoulX-Singer\pretrained_models\SoulX-Singer\model.pt" --output-dir "D:\Document\electron\SXSEditor\onnx_models\int8\from_pytorch"
```

### Step 1: Export diff_step FP32 ONNX
**Script:** `export_step1_diffstep.py`
```powershell
python export_step1_diffstep.py --model-path "D:\Document\electron\SXSEditor\SoulX-Singer\pretrained_models\SoulX-Singer\model.pt" --output-dir "D:\Document\electron\SXSEditor\onnx_models\int8\from_pytorch"
```

### Step 2: Export vocoder FP32 ONNX
**Script:** `export_step2_vocoder.py`
```powershell
python export_step2_vocoder.py --model-path "D:\Document\electron\SXSEditor\SoulX-Singer\pretrained_models\SoulX-Singer\model.pt" --output-dir "D:\Document\electron\SXSEditor\onnx_models\int8\from_pytorch"
```

### Step 3: Post-process FP32 ONNX (STFT replacement, onnxsim)
**Script:** `export_step3_postprocess.py`
```powershell
python export_step3_postprocess.py --output-dir "D:\Document\electron\SXSEditor\onnx_models\int8\from_pytorch"
```

### Step 4: Quantize to INT8 (QDQ format)
**Script:** `export_step4_quantize.py`
```powershell
python export_step4_quantize.py --output-dir "D:\Document\electron\SXSEditor\onnx_models\int8\from_pytorch"
```

---

## 7. INT8 ONNX Export (Single Script)

**Script:** `export_int8_onnx.py`
Export diff_step and vocoder sub-models to ONNX, then quantize to INT8 (single process).

```powershell
python export_int8_onnx.py --model-path "D:\Document\electron\SXSEditor\SoulX-Singer\pretrained_models\SoulX-Singer\model.pt" --output-dir "D:\Document\electron\SXSEditor\onnx_models\int8"
```

---

## 8. NPU INT8 Optimization

**Script:** `optimize_npu_int8.py`
Optimize INT8 models for WebNN NPU deployment.
Replaces unsupported ops (STFT, ReduceL2, Range, etc.), fixes DQL scale rank, and validates NPU compatibility.

```powershell
python optimize_npu_int8.py
```

---

## 9. NPU FP16 Optimization

**Script:** `optimize_npu.py`
Convert FP32 ONNX models to FP16 for WebNN NPU inference.
FP16 uses standard operators (MatMul, Conv, Gemm) which are all NPU-compatible.

**Output:** `onnx_models/fp16/optimized_npu/`

```powershell
python optimize_npu.py
```

---

## 10. ONNX Optimization (Olive-based)

**Script:** `optimize_onnx.py`
Uses Olive + onnxruntime to optimize all ONNX models.
Produces both INT8 (dynamic quantization) and FP16 versions.

**Output:**
- INT8: `onnx_models/int8/`
- FP16: `onnx_models/fp16/`

```powershell
python optimize_onnx.py
```

---

## 11. Vocoder DML Optimization

**Script:** `optimize_vocoder_dml.py`
Optimizes vocoder model for DirectML compatibility.
Decomposes ConvTranspose(stride=480) into DML-compatible ops (Reshape + Pad + Conv1D + Slice).

**Output:** `onnx_models/vocoder_dml.onnx`

```powershell
python optimize_vocoder_dml.py
```

---

## 12. Shared Utilities (Library — Not Run Directly)

**Script:** `export_shared.py`
Shared utilities for export/quantization pipelines: model loading, wrappers, post-processing, quantization helpers.
Not meant to be run directly.

---

## 13. Japanese (JP) Singer Voice Fine-tuning (LoRA)

Located in `SoulX-Singer/train/lora_jp/`. Run from `SoulX-Singer/` directory.
Fine-tunes preflow + embedding layer to add Japanese phoneme support for singing voice synthesis.

**Output:** `SoulX-Singer/outputs/lora_jp/`

### 13.1 Full Pipeline (8 steps, recommended)
**Script:** `train/lora_jp/run_pipeline.py`
Runs all 8 steps sequentially: phoneme mapping → init embeddings → 3-phase training → 3 validations → final synthesis check.

```powershell
# Full pipeline (run from SoulX-Singer directory)
cd D:\Document\electron\SXSEditor\SoulX-Singer ; python train/lora_jp/run_pipeline.py
```

### 13.2 Dataset Preparation
**Script:** `train/lora_jp/prepare_dataset.py`
Converts PJS Corpus (lab + wav + MIDI) to training metadata JSON format.

```powershell
cd D:\Document\electron\SXSEditor\SoulX-Singer ; python train/lora_jp/prepare_dataset.py --corpus_dir "pretrained_models/SoulX-Singer/assets/LoRA-JP/PJS_corpus_ver1.1" --output_dir "train/lora_jp/dataset" --sample_rate 24000
```

### 13.3 Embedding Initialization
**Script:** `train/lora_jp/init_embeddings.py`
Extends the embedding table with Japanese phonemes, initialized from Chinese+English phoneme mapping with L2 normalization and std calibration.

```powershell
cd D:\Document\electron\SXSEditor\SoulX-Singer ; python train/lora_jp/init_embeddings.py --model_path "pretrained_models/SoulX-Singer/model.pt" --mapping "train/lora_jp/jp_phoneme_mapping.json" --phoneset "train/lora_jp/jp_phone_set.json" --output "outputs/lora_jp/init_embed.pt" --target_std 0.9
```

### 13.4 Staged Training (3 Phases)
**Script:** `train/lora_jp/train_staged.py`

Three-phase training strategy:
- **Phase 1 (Warmup)**: Freeze embedding, train preflow + LayerNorm (15 epochs)
- **Phase 2 (Embed FT)**: Unfreeze embedding with lower LR (up to 40 epochs)
- **Phase 3 (Joint)**: Full fine-tuning (up to 80 epochs)

```powershell
# Phase 1 — Warmup (frozen embedding)
cd D:\Document\electron\SXSEditor\SoulX-Singer ; python train/lora_jp/train_staged.py --phase 1 --model_path "pretrained_models/SoulX-Singer/model.pt" --config "soulxsinger/config/soulxsinger.yaml" --phoneset_path "train/lora_jp/jp_phone_set.json" --dataset_metadata "train/lora_jp/dataset/metadata.json" --dataset_wav_dir "train/lora_jp/dataset/wavs" --output_dir "outputs/lora_jp" --init_embed "outputs/lora_jp/init_embed.pt" --batch_size 2 --lr 5e-5 --device cuda

# Phase 2 — Embedding fine-tuning
cd D:\Document\electron\SXSEditor\SoulX-Singer ; python train/lora_jp/train_staged.py --phase 2 --model_path "pretrained_models/SoulX-Singer/model.pt" --config "soulxsinger/config/soulxsinger.yaml" --phoneset_path "train/lora_jp/jp_phone_set.json" --dataset_metadata "train/lora_jp/dataset/metadata.json" --dataset_wav_dir "train/lora_jp/dataset/wavs" --output_dir "outputs/lora_jp" --resume "outputs/lora_jp/stage1/best.pt" --batch_size 2 --lr 5e-5 --device cuda

# Phase 3 — Joint fine-tuning
cd D:\Document\electron\SXSEditor\SoulX-Singer ; python train/lora_jp/train_staged.py --phase 3 --model_path "pretrained_models/SoulX-Singer/model.pt" --config "soulxsinger/config/soulxsinger.yaml" --phoneset_path "train/lora_jp/jp_phone_set.json" --dataset_metadata "train/lora_jp/dataset/metadata.json" --dataset_wav_dir "train/lora_jp/dataset/wavs" --output_dir "outputs/lora_jp" --resume "outputs/lora_jp/stage2/best.pt" --batch_size 2 --lr 5e-5 --device cuda
```

### 13.5 Validation & Auto-Rollback
**Script:** `train/lora_jp/validate_and_rollback.py`
Validates checkpoint quality using 3 metrics: embedding std, avg frames per phoneme, and validation loss.
Triggers automatic rollback if danger thresholds are crossed. Optionally synthesizes test sentences.

```powershell
# Validate phase 1 checkpoint
cd D:\Document\electron\SXSEditor\SoulX-Singer ; python train/lora_jp/validate_and_rollback.py --checkpoint "outputs/lora_jp/stage1/best.pt" --model_path "pretrained_models/SoulX-Singer/model.pt" --config "soulxsinger/config/soulxsinger.yaml" --phoneset_path "train/lora_jp/jp_phone_set.json" --dataset_metadata "train/lora_jp/dataset/metadata.json" --dataset_wav_dir "train/lora_jp/dataset/wavs" --output_dir "outputs/lora_jp" --device cuda

# Final validation with synthesis check
cd D:\Document\electron\SXSEditor\SoulX-Singer ; python train/lora_jp/validate_and_rollback.py --checkpoint "outputs/lora_jp/stage3/best.pt" --model_path "pretrained_models/SoulX-Singer/model.pt" --config "soulxsinger/config/soulxsinger.yaml" --phoneset_path "train/lora_jp/jp_phone_set.json" --dataset_metadata "train/lora_jp/dataset/metadata.json" --dataset_wav_dir "train/lora_jp/dataset/wavs" --output_dir "outputs/lora_jp" --device cuda --synthesize
```

### 13.6 ONNX Export (for SXSEditor)
**Script:** `train/lora_jp/export_onnx.py`
Exports fine-tuned preflow + JP embedding as ONNX files compatible with SXSEditor inference pipeline.
Generates `note_text_encoder.onnx` (extended embedding) and `preflow.onnx` (fine-tuned preflow).

```powershell
cd D:\Document\electron\SXSEditor\SoulX-Singer ; python train/lora_jp/export_onnx.py --checkpoint "outputs/lora_jp/stage3/best.pt" --base_model "pretrained_models/SoulX-Singer/model.pt" --output_dir "onnx_models/fp16/JP"
```

### 13.7 LoRA Training (Legacy single-phase)
**Script:** `train/lora_jp/train_lora.py`
Older single-phase fine-tuning script (preflow + JP embedding). Use `train_staged.py` for better results.

```powershell
cd D:\Document\electron\SXSEditor\SoulX-Singer ; python train/lora_jp/train_lora.py --model_path "pretrained_models/SoulX-Singer/model.pt" --config "soulxsinger/config/soulxsinger.yaml" --output_dir "outputs/lora_jp" --epochs 50 --batch_size 4 --use_amp
```

### 13.8 Phoneme Mapping Generation
**Script:** `train/lora_jp/phoneme_mapping.py`
Generates Japanese-to-source phoneme mapping JSON used for embedding initialization.

```powershell
cd D:\Document\electron\SXSEditor\SoulX-Singer ; python train/lora_jp/phoneme_mapping.py
```

### 13.9 PyTorch Inference Verification
**Script:** `train/lora_jp/infer_lora.py`
Runs PyTorch inference with fine-tuned model to verify Japanese singing voice synthesis quality.

```powershell
cd D:\Document\electron\SXSEditor\SoulX-Singer ; python train/lora_jp/infer_lora.py
```

---

## Key Paths Reference

| Path | Description |
|------|-------------|
| `d:\Document\electron\SXSEditor\` | Project root |
| `d:\Document\electron\SXSEditor\onnx_models\` | Base ONNX models directory |
| `d:\Document\electron\SXSEditor\onnx_models\fp16\` | FP16 models |
| `d:\Document\electron\SXSEditor\onnx_models\fp16\JP\` | Japanese fine-tuned FP16 models |
| `d:\Document\electron\SXSEditor\onnx_models\fp8\` | FP8 models (output of quantize_fp8.py) |
| `d:\Document\electron\SXSEditor\onnx_models\int8\` | INT8 models (ORT CPU compatible) |
| `d:\Document\electron\SXSEditor\onnx_models\int8\optimized_npu\` | NPU-optimized INT8 models |
| `d:\Document\electron\SXSEditor\SoulX-Singer\` | SoulX-Singer sub-project root |
| `d:\Document\electron\SXSEditor\SoulX-Singer\pretrained_models\SoulX-Singer\model.pt` | PyTorch source model |
| `d:\Document\electron\SXSEditor\SoulX-Singer\train\lora_jp\` | Japanese LoRA fine-tuning scripts |
| `d:\Document\electron\SXSEditor\SoulX-Singer\train\lora_jp\dataset\wavs\` | Training dataset WAV files |
| `d:\Document\electron\SXSEditor\SoulX-Singer\outputs\lora_jp\` | Training output checkpoints |
