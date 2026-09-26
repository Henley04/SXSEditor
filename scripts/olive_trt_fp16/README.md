# Olive TRT FP16 — TRTRTX/GPU 高精度量化管线

隔离新路径，不覆盖现有模型；复制到 `fp16/` 即可直跑 WinML。

## 路径
- FP32 中间产物（隔离）：`onnx_models/trt_fp16_fp32/`（`export_pipeline.py --output-dir`），不覆写 `onnx_models/` 根
- TRT FP16 最终：`onnx_models/trt_fp16/`（含 `trt_fp16/JP/`），文件名与 `fp16/` 完全一致
- 兼容：`xcopy trt_fp16\*.onnx fp16\ /Y` 或 `enable_trt_all.ps1`

## 步骤
1) 校准：
```bash
python scripts/olive_trt_fp16/calibrate_trt.py --eval-dir eval_data/Soul-AILab/SoulX-Singer-Eval-Dataset --out calibrate/data/trt_fp16 --num-samples 50 --provider dml
# 产 calibrate/data/trt_fp16/{diff_step_dml, vocoder_dml, ...}.npz + calib_data.npz
```
2) 导出 + Olive 优化（TRTRTX/GPU）：
```bash
python scripts/olive_trt_fp16/export_trt_fp16_dynamo.py --phase all --calib calibrate/data/trt_fp16/calib_data.npz --fp32-base-dir onnx_models/trt_fp16_fp32 --output-dir onnx_models/trt_fp16
# Phase export: 复用 export_pipeline 4步到 trt_fp16_fp32
# Phase optimize: Olive GPU+TRTRTX -> Float16 (block_list 敏感 Mel/RoPE/ISTFT, keep_io_types=True) + Peephole
```
3) 基准对比：
```bash
node scripts/olive_trt_fp16/bench_trt_vs_dml.js --runs 3 --seq 512
# 输出 bench_report.json 与控制台 p50/p95，对比 DML FP32 vs DML FP16 vs TRT FP16
# 精度：同目录 compare 脚本 SNR/cos/L1（FP32 ONNX 为真值）
```
4) 启用：
```powershell
powershell -ExecutionPolicy Bypass -File scripts\olive_trt_fp16\enable_trt_all.ps1
$env:SXS_WINML_ALL_TRTRTX="1"; npm start  # 全部非 preprocess 走 TRTRTX
```

## 量化策略
- `OpBlockList` 保留 `Softmax/LayerNorm/ReduceMean/Pow/Sqrt/Reciprocal/Exp/Cos/Sin/Erf/Sigmoid/Tanh/Div/Clip` 为 FP32（窗口归一化精度）
- `keep_io_types=True` 保证 TRT `float` I/O 正确 Cast，避免全零/电流声
- 校准集 `ModelScope:Soul-AILab/SoulX-Singer-Eval-Dataset` 真实 `mel (128×T, mean -4.92 std 2.85)` 50条，`Olive` 与 `quantize_pytorch_fp16_calib.py` 双轨 SNR/cos 验证
- Auto-Opt: `AcceleratorSpec(GPU, NvTensorRTRTX)`，`passes: Preprocess → Peephole → Float16 (+MixedPrecision diff_step 可选)`

## 报告
见 `docs/TRT_FP16_REPORT.md` 模板，填入 SNR/dB、cosine、L0% 与 ms/RTF/frames/s。

## 不覆写保证
- `export_trt_fp16_dynamo.py` 的 `--fp32-base-dir` 默认为 `trt_fp16_fp32`，若已存在则跳过覆写（删目录才重导）
- `phase_optimize` 仅在 `trt_fp16/` 内原地优化，不触 `onnx_models/*.onnx` 或 `fp16/` 
- 复制为显式 `xcopy`/`enable_trt_all.ps1`，可随时还原 `fp16` 备份
