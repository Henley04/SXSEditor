# SXSEditor 自动化测试套件

## 概述

本项目包含全面的自动化测试套件，共 **1019 个测试用例**，覆盖所有核心模块。测试分为单元测试、集成测试和属性/鲁棒性测试三层，旨在通过多维度覆盖全面保障应用质量。

## 测试结构

```
test/
├── setup.js                      # 测试环境配置（Babel transpilation）
├── test-helpers.js               # 通用测试辅助函数和 mock
│
├── 单元测试
│   ├── wavEncoder.test.js            # WAV 编码器
│   ├── trackManager.test.js          # 轨道管理
│   ├── nativeSvsPipeline.test.js     # SVS Pipeline 纯逻辑
│   ├── rmvpePitchDetector.test.js    # RMVPE 音高检测器
│   ├── basicPitch.test.js            # Basic Pitch 工具函数
│   ├── preprocessing.test.js         # 前处理（音符编码、F0）
│   ├── postprocessingDSP.test.js     # 后处理 DSP（FFT、ISTFT、Mel）
│   ├── audioSegmentation.test.js     # 音频分段（长音频）
│   ├── textProcessing.test.js        # 文本处理（G2P）
│   ├── durationStats.test.js         # 时长统计与回退链
│   ├── vocoderChunked.test.js        # 分块 vocoder 推理
│   ├── float16Utils.test.js          # Float16 ↔ Float32 转换
│   ├── mergePhoneme.test.js          # SP 音符合并
│   ├── colorUtils.test.js            # 主题颜色工具
│   ├── themeManager.test.js          # 主题管理器
│   ├── themeStorage.test.js          # 主题存储
│   ├── themeTokens.test.js           # 主题 token
│   ├── themeValidator.test.js        # 主题校验
│   ├── historyManager.test.js        # 撤销/重做历史
│   ├── ipcChannels.test.js           # IPC 通道
│   ├── security.test.js              # 安全相关
│   ├── midiParser.test.js            # MIDI 解析
│   ├── modelPaths.test.js            # 模型路径
│   ├── languageDetection.test.js     # 语言检测
│   ├── audioFormatUtils.test.js      # 音频格式工具
│   ├── audioOutputManager.test.js    # 音频输出管理
│   ├── batchProcessing.test.js       # 批量处理
│   ├── resampleAudio.test.js         # 音频重采样
│   └── utilsMisc.test.js             # 杂项工具
│
├── 集成测试
│   ├── pipelineIntegration.test.js       # 跨模块数据流
│   └── crossModuleIntegration.test.js    # 30 个跨模块深度集成测试
│
└── 属性/鲁棒性测试
    └── robustness.test.js            # 62 个 fuzz/边界/属性测试
```

## 运行测试

### 基本测试

```bash
npm test
```

### 远程 CI 精简测试

```bash
npm run test:ci
```

远程 CI 使用精简测试套件，跳过以下不适用于 CI 环境的测试：

- `onnxModelLoading.test.js` — ONNX 模型加载与推理（需要本地 ONNX 模型文件和 DML EP）
- `releaseNotesFetcher.test.js` — 网络功能（release notes 抓取模块）

本地开发时仍应运行 `npm test` 执行完整测试套件。

### 带代码覆盖率

```bash
npm run test:coverage
```

生成 HTML 覆盖率报告在 `coverage/` 目录中。

### 监视模式（自动重新运行）

```bash
npm run test:watch
```

### 仅运行特定测试文件

```bash
npx mocha --require ./test/setup.js "test/robustness.test.js" --timeout 30000
```

## 测试覆盖范围

### 单元测试

覆盖所有核心模块的纯逻辑：
- **WAV 编码器**: 文件头格式、采样率、位深度、声道、空输入和大文件
- **轨道管理**: 歌手/分片 CRUD、活动分片、颜色分配
- **SVS Pipeline**: MIDI→频率、包络插值、F0 量化、帧序列、音符嵌入
- **RMVPE 音高检测**: 重采样、索引↔F0、F0→MIDI、音符分组
- **Basic Pitch**: MIDI/Hz 转换、高斯函数、argMax、统计计算
- **前处理**: 音符编码、F0 构建、phoneme 序列、mel2token、slur 分类
- **后处理 DSP**: Radix-2 FFT/IFFT、ISTFT 重建、Mel 滤波器组、Hz↔Mel
- **音频分段**: 长音频分段、overlap、cache key、终止保证
- **文本处理**: 中/日/英 G2P、音素查表、音调覆盖
- **时长统计**: n-gram 回退链、缓存
- **Vocoder 分块**: 串行推理、chunk overlap
- **Float16 转换**: IEEE 754 半精度往返、subnormal、overflow
- **主题系统**: colorUtils、themeManager、storage、tokens、validator
- **撤销/重做**: 命令栈、maxSize、clear
- **其他**: IPC、安全、MIDI 解析、模型路径、语言检测、批量处理

### 集成测试 (30+ tests)

#### pipelineIntegration.test.js
- F0 量化端到端流程
- 音频重采样管道
- F0 到音符转换管道
- WAV 编码往返测试
- 音符嵌入帧重复
- 歌手-分片生命周期管理
- 跨模块采样率一致性

#### crossModuleIntegration.test.js
- **G2P→Preprocessing 全链路**: 中/日/英歌词完整转换、多音符、phonemeAdjustments
- **FFT↔IFFT 往返**: 正弦、复信号、多余弦叠加、共轭对称、生产尺寸 smoke test
- **Float16↔Float32 往返**: 音频值、特殊值、identity、normalizePeakTo
- **音频分段→notesToSequences**: 长音频、段边界、cache key
- **WAV 解析→重采样→Mel 提取链**: 结构验证（N_FFT=1920 已知限制）
- **mergePhoneme 集成**: SP 合并、AP→SP 规范化、slur 保留
- **Mel 滤波器组**: flat 数组结构、三角峰、Hz↔Mel 往返
- **常量一致性**: 50Hz 帧率、N_FFT>2×HOP_SIZE、N_FFT=1920 限制

### 属性/鲁棒性测试 (62 tests)

`robustness.test.js` 使用确定性 PRNG 进行 fuzz 测试，探测不变量和崩溃点：

- **G2P 鲁棒性**: 空/null/控制字符、10k 字符歌词、混合脚本、100 次 ASCII fuzz、50 次 CJK fuzz
- **前处理鲁棒性**: 空音符、pitch 0/127、1ms 时长、零时长、bpm=1000、500 音符压力、20 次随机音符 fuzz
- **音频分段鲁棒性**: null/缺失字段、1000 拍终止保证、全休止长音频、单 1000 时长音符、cache key fuzz、hash 确定性 fuzz
- **FFT 鲁棒性**: 全零、脉冲（平坦谱）、线性性质、size=2 最小、4 种尺寸随机往返
- **Float16 鲁棒性**: 空、单元素、subnormal、max/min (65504)、overflow→Inf、1000 次随机 fuzz、normalizePeakTo 边界
- **colorUtils 鲁棒性**: null/非 hex/截断 hex、200 次 hex fuzz、boolean 保证
- **HistoryManager 鲁棒性**: 空栈、maxSize=1/0、null 命令、10000 push 压力、100 次随机 undo/redo fuzz
- **工具函数鲁棒性**: smoothstep API、formatBytes 边界、midiToNoteName 全范围、isCJK 非字符串、Hz↔Mel 负数、resampleLinear 空/单/identity
- **WAV 解析鲁棒性**: 截断 RIFF、无 data chunk、空 buffer、ArrayBuffer 输入

## 通过测试发现并修复的真实 Bug

本次大规模测试套件发现了 5 个生产代码中的真实缺陷：

1. **`colorUtils.parseHex`**: 无效 hex 字符 → NaN 传播（已修复，返回 0.5 fallback）
2. **`audioSegmentation.buildVocalSegments`**: 长音频（>30s）末段无限循环 → OOM（已修复，添加 `reachedEnd` 标志）
3. **`fftRadix2/ifftRadix2`**: DIF 蝶形 `(t-u)*w` 配 DIT 位反转 → 非 DC 信号频谱错误（已修复为标准 DIT 蝶形）
4. **`preprocessing noteType`**: slur 音符（空歌词）误分类为休止符 type 1（已修复，isSlur 检查优先于空歌词检查）
5. **`isCJK`**: null/undefined 输入抛 TypeError（已修复，非字符串返回 false）

## 已知限制

- **N_FFT=1920 不是 2 的幂**（1920 = 128×15）：JS fallback `extractMelSpectrogram` 对非 2 幂尺寸产生错误结果。生产路径使用 ONNX `mel_transform` 模型，不依赖 JS FFT。单元测试中仅验证结构，不验证数值正确性。
- **ONNX 模型推理测试** 需要在完整 Electron 环境中运行，当前测试套件专注于纯逻辑和算法正确性。
- **UI 测试** 需要额外的 Electron 测试框架（如 Spectron）。

## 技术栈

- **Mocha**: 测试框架
- **Chai**: 断言库（expect 风格）
- **Sinon**: Mock 和 stub（用于 Electron API）
- **JSDOM**: 浏览器环境模拟（用于前端代码测试）
- **NYC**: 代码覆盖率工具
- **Babel**: ES6+ 代码转译

## 测试策略

### 纯逻辑测试
不依赖 ONNX 模型或 GPU 的测试，可以快速运行：
- 数学转换函数
- 数据结构和算法
- 边界情况处理

### 集成测试
测试模块间的协作：
- 数据流管道（G2P→前处理→后处理）
- 状态管理（轨道→分片→活动）
- 配置一致性（采样率、FFT 尺寸）

### 属性/鲁棒性测试
用随机和边界输入探测不变量：
- 确定性 PRNG（可复现）
- 不变量验证（如 FFT 线性、float16 往返误差、mel2token 范围）
- 终止保证（如长音频分段不 OOM）
- 类型鲁棒性（null/undefined/非字符串输入不崩溃）

## 添加新测试

1. 在 `test/` 目录中创建 `*.test.js` 文件
2. 使用 Mocha 的 `describe` 和 `it` 语法
3. 使用 Chai 的 `expect` 进行断言
4. 确保测试可以独立运行，不依赖顺序
5. 鲁棒性测试使用 `makeRng(seed)` 保证可复现

示例：

```javascript
const { expect } = require('chai');

describe('MyModule', () => {
  it('should do something', () => {
    const result = myFunction();
    expect(result).to.equal(expectedValue);
  });
});
```

## CI/CD 集成

GitHub Actions CI 使用 `npm run test:ci` 运行精简测试套件（跳过网络功能和模型推理/加载测试）：

```yaml
# GitHub Actions 示例（实际配置见 .github/workflows/ci.yml）
name: CI
on: [push, pull_request]
jobs:
  test:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run test:ci
```

## 测试覆盖率目标

- **行覆盖率**: > 80%
- **分支覆盖率**: > 70%
- **函数覆盖率**: > 85%

查看覆盖率报告：

```bash
npm run test:coverage
# 打开 coverage/index.html 查看详细报告
```
