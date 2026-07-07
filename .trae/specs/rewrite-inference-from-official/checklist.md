# Checklist

## Phase 1: 清理验证（保留 SiFiGAN/INT8/NPU）
- [ ] 所有 `*.bak` 和 `*.bak.data` 文件已删除（14 个）
- [ ] `sifigan_vocoder_dml_backup.onnx` 及 `_linear_backup` 变体已删除
- [ ] `onnx_models/fp16_w16a16_backup/` 目录已删除
- [ ] `onnx_models/fp16/JP/_fp32_backup/` 目录已删除
- [ ] `onnx_models/int8/optimized_npu_backup/` 目录已删除
- [ ] `onnx_models/svc/` 目录已删除
- [ ] `calibrate/upgrade_opset.py` 和 `calibrate/replace_with_opset20.py` 已删除
- [ ] **保留验证**：`onnx_models/fp16/` 目录仍存在（W16A32 保留）
- [ ] **保留验证**：`onnx_models/int8/` 目录仍存在（INT8 保留）
- [ ] **保留验证**：SiFiGAN 模型和脚本仍存在
- [ ] **保留验证**：INT8/NPU/W16A32 相关 Python 脚本仍存在
- [ ] Git 提交记录显示清理已完成

## Phase 2: FP32 ONNX 导出验证
- [ ] `export_shared.py` 已更新（直接 opset 20 导出，保留 FP16/量化工具函数）
- [ ] `export_step1_diffstep.py` 导出 diff_step_dml.onnx（opset 20, FP32）
- [ ] `export_step2_vocoder.py` 导出 vocoder_dml.onnx（opset 20, FP32, ConvTranspose 已分解）
- [ ] `export_step3_postprocess.py` 导出其他 7 个模型（opset 20, FP32）
- [ ] JP 模型导出脚本生成 4 个 JP 专属 ONNX 到 `onnx_models/JP/`
- [ ] `export_pipeline.py` 编排脚本可一键执行全部导出
- [ ] `calibrate/check_opset.py` 验证 `onnx_models/` 根目录下所有 ONNX opset = 20
- [ ] 所有 FP32 ONNX 在 DML EP 上可加载、可推理（无 unsupported op）
- [ ] **保留验证**：`onnx_models/fp16/`、`onnx_models/int8/` 子目录内容未被覆盖

## Phase 3: 精度验证
- [ ] `scripts/verify_module_precision.py` 已编写并可运行
- [ ] 9 个核心 FP32 模型模块级精度达标：COS ≥ 0.99、SNR ≥ 30dB
- [ ] `scripts/precision_report.json` 已生成且结果达标
- [ ] `scripts/verify_e2e_precision.py` 已编写并可运行
- [ ] 端到端精度达标：COS ≥ 0.95、SNR ≥ 20dB
- [ ] `scripts/e2e_precision_report.json` 已生成且结果达标

## Phase 4: JS 推理管线验证（default 路径对齐官方，保留可选路径）
- [ ] `diffusion.js` 严格对齐 `flow_matching.py` reverse_diffusion：
  - t 调度为 `(i + 0.5) * h`
  - uncond 分支使用 target-only 序列（xt/cond/mask 均 target-only）
  - CFG rescale 使用 Bessel 校正（N-1 分母）+ 单 epsilon
  - rescale 混合公式 `rescale_cfg * rescaled + (1 - rescale_cfg) * cfg`
  - Euler 积分 `xt = xt + flow_pred * h`
- [ ] `preprocessing.js` 对齐 `DataProcessor.preprocess`：
  - mel2note 帧分配公式 `inner = next_start - i - 2`，`p_start = i+1 + floor(p*inner/j)`
  - 英文 en_ 拆分 + SEP，日文 jp_ 拆分无 SEP
  - BOW/EOW 包裹每个 note
  - f0_shift 三处同步（f0Hz/f0Ids/notePitchSeq）
- [ ] `index.js` default 路径对齐 `SoulXSinger.infer` 编排：
  - auto_shift 计算（score: median 差；melody: log2 × 12）
  - f0_shift 应用：`f0_to_coarse(gt_f0, f0_shift*5)`、`note_pitch += f0_shift`
  - 序列拼接（prompt + target，mel2note 偏移 len_prompt）
  - encoder → diffusion → vocoder 流程正确
- [ ] `postprocessing.js` default vocoder 路径对齐官方调用
- [ ] **保留验证**：`constants.js` 未被修改（SiFiGAN/INT8 常量保留）
- [ ] **保留验证**：`modelLoader.js` 未被修改（FP16/INT8/NPU 加载保留）
- [ ] **保留验证**：`svsIpc.js` 未被修改（SiFiGAN/精度切换 IPC 保留）
- [ ] **保留验证**：`diffusion.js` 中 FP16/static shapes 分支保留
- [ ] **保留验证**：`preprocessing.js` 中 SiFiGAN 4× 上采样分支保留
- [ ] **保留验证**：`postprocessing.js` 中 SiFiGAN 分支保留
- [ ] **保留验证**：`index.js` 中 `swapVocoder`、`swapSifiganPrecision`、INT8/NPU 路径保留

## Phase 5: 集成与兼容性验证
- [ ] 现有 `.sxssinger` 文件可正常加载（singerName、wavBase64、midiNotes、f0Data 完整）
- [ ] 现有 `.sxsproj` 文件可正常加载（bpm、timeSignature、singers、fragments 完整）
- [ ] JP/base 语言模型切换正常工作
- [ ] 多 segment 长音频合成正常（crossfade、per-segment f0Shift）
- [ ] 单 note context padding 正常
- [ ] synth cache 正常工作
- [ ] runLock 互斥正常（无 887A0006 错误）
- [ ] JS default 路径产出 vs PyTorch 官方产出对比达标（COS ≥ 0.95、SNR ≥ 20dB）
- [ ] SiFiGAN vocoder 切换后合成正常
- [ ] INT8 精度切换后合成正常
- [ ] INT8-NPU 路径正常（如环境支持）
- [ ] `npm run package:lite` 打包成功
- [ ] 打包后应用可正常加载模型、合成音频
- [ ] `app.asar.unpacked/onnx_models/` 包含全部 9 个 FP32 模型 + JP/ + fp16/ + int8/ + SiFiGAN 文件

## Phase 6: 文档与提交
- [ ] `tools.md` 已更新（新增 export_pipeline.py，保留 SiFiGAN/INT8/NPU 脚本说明）
- [ ] `onnx_models/README.md` 已更新（FP32 opset 20 为默认主路径，保留 FP16/INT8/SiFiGAN 说明）
- [ ] Git 提交记录完整
- [ ] 已推送到远程 GitHub 仓库
