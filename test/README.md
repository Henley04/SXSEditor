# SXSEditor 自动化测试套件

## 概述

本项目包含全面的自动化测试套件，共 **160 个测试用例**，覆盖所有核心模块。

## 测试结构

```
test/
├── setup.js                      # 测试环境配置（Babel transpilation）
├── test-helpers.js               # 通用测试辅助函数和 mock
├── wavEncoder.test.js            # WAV 编码器单元测试（15 个测试）
├── trackManager.test.js          # 轨道管理单元测试（28 个测试）
├── nativeSvsPipeline.test.js     # SVS Pipeline 纯逻辑测试（39 个测试）
├── rmvpePitchDetector.test.js    # RMVPE 音高检测器纯逻辑测试（26 个测试）
├── basicPitch.test.js            # Basic Pitch 工具函数测试（24 个测试）
├── pipelineIntegration.test.js   # 集成测试（18 个测试）
└── run-tests.js                  # 测试运行脚本
```

## 运行测试

### 基本测试

```bash
npm test
```

### 带代码覆盖率

```bash
npm run test:coverage
```

生成 HTML 覆盖率报告在 `coverage/` 目录中。

### 监视模式（自动重新运行）

```bash
npm run test:watch
```

## 测试覆盖范围

### 单元测试

#### wavEncoder.js (15 tests)
- WAV 文件头格式验证（RIFF, WAVE, fmt, data）
- 音频格式编码（IEEE float 32-bit）
- 采样率、位深度、声道数设置
- 数据块大小计算
- 音频数据正确性
- 边界情况（空输入、大文件、静音）

#### trackManager.js (28 tests)
- 歌手创建/删除/更新/查询
- 分片创建/删除/更新/查询
- 活动分片管理
- 颜色分配和重用
- 边界情况和错误处理

#### nativeSvsPipeline.js (39 tests)
- MIDI 到频率转换
- 包络插值
- F0 量化
- F0 帧序列构建
- 音符到序列转换
- 音符嵌入重复到帧
- 随机噪声生成
- 资源释放

#### rmvpePitchDetector.js (26 tests)
- 音频重采样
- 索引到 F0 转换
- F0 到 MIDI 转换
- F0 到音符转换
- 音符分组
- 边界情况处理

#### basicPitch.js (24 tests)
- MIDI/Hz 转换工具函数
- 高斯函数生成
- argMax 和数组操作
- 阈值查找
- 统计计算（均值、标准差）
- 音频重采样
- 音符到 F0 数组转换

### 集成测试 (18 tests)

#### Audio Processing Pipeline
- F0 量化端到端流程
- 音频重采样管道
- F0 到音符转换管道
- WAV 编码往返测试
- 音符嵌入帧重复

#### Track and Fragment Pipeline
- 歌手-分片生命周期管理
- 多歌手和多分片处理
- 分片删除和活动切换

#### Constants Consistency
- 跨模块采样率一致性验证

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
- 数据流管道
- 状态管理
- 配置一致性

### 注意事项
- ONNX 模型加载和推理测试需要在完整的 Electron 环境中运行
- 当前测试套件专注于纯逻辑和算法正确性
- UI 测试需要额外的 Electron 测试框架（如 Spectron）

## 添加新测试

1. 在 `test/` 目录中创建 `*.test.js` 文件
2. 使用 Mocha 的 `describe` 和 `it` 语法
3. 使用 Chai 的 `expect` 进行断言
4. 确保测试可以独立运行，不依赖顺序

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

可以将测试集成到 CI 流程中：

```yaml
# GitHub Actions 示例
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v2
      - uses: actions/setup-node@v2
        with:
          node-version: '18'
      - run: npm ci
      - run: npm test
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
