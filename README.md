<div align="center">

  <img src="docs/images/icon.png" alt="SXSEditor" width="80" height="80" style="border-radius:16px"/>

  # SXSEditor

  **AI-Powered Singing Voice Synthesis Workstation**

  [![Version](https://img.shields.io/badge/version-1.0.0-blue?style=flat-square)](https://github.com/Henley04/SXSEditor/releases)
  [![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
  [![Platform](https://img.shields.io/badge/platform-Windows%20|%20macOS%20|%20Linux-lightgrey?style=flat-square)]()
  [![SVS Languages](https://img.shields.io/badge/SVS-EN%20|%20ZH-orange?style=flat-square)]()

  <br>

  **[English](#english) · [中文](#中文) · [日本語](#日本語)**

</div>

---

<a id="english"></a>

## English

SXSEditor is an open-source desktop singing voice synthesis (SVS) workstation. It combines a visual piano-roll editor with a neural SVS pipeline based on the SoulX-Singer acoustic model, running entirely through ONNX Runtime for efficient inference on GPU (DirectML) and CPU.

> **SVS Language Support**: Currently supports **English** and **Chinese (Mandarin)** singing voice synthesis. Japanese and other languages are under development.

---

### For Users

#### Download

Download the latest pre-built installer for **Windows**:

[⬇ Download SXSEditor v1.0.0 for Windows](https://share.weiyun.com/2pgoQsmL)

> For **macOS** and **Linux**, see the [Developer Guide](#for-developers) to build from source.

#### Quick Start

1. **Launch** SXSEditor after installation.
2. **Set project BPM** and time signature in the toolbar.
3. **Add a singer** → click **+** in the singer panel → create a new singer or open an existing `.sxssinger` file.
4. **Add a fragment** → click **+** on a singer row.
5. **Double-click** a fragment to open the **Fragment Editor** with piano roll.
6. **Add notes** with lyrics, draw pitch curves, then **save**.
7. **Press ▶ Play** to synthesize and listen.
8. **Export** your project as WAV.

#### Features

| Feature | Description |
|---------|-------------|
| 🎹 Multi-track Timeline | Arrange fragments with drag-and-drop |
| 🎼 Piano Roll Editor | Edit notes, lyrics, pitch curves & envelopes |
| 🧠 Neural SVS | SoulX-Singer model via ONNX Runtime |
| 🎤 Singer Management | Custom singers with reference audio & F0 |
| 📊 Audio Preprocessing | RMVPE / Basic Pitch F0 extraction |
| ▶️ Real-time Playback | Synthesize & play directly in editor |
| 📦 WAV Export | Mix & export to standard WAV (24kHz) |
| ⚡ GPU Acceleration | DirectML (NVIDIA / AMD / Intel) |

#### SVS Language Support

| Language | Status | Notes |
|----------|--------|-------|
| 🇬🇧 English | ✅ Supported | Full phoneme coverage |
| 🇨🇳 Chinese (Mandarin) | ✅ Supported | Pinyin-based lyrics input |
| 🇯🇵 Japanese | 🔄 In Development | Coming in future releases |
| 🇰🇷 Korean | 📋 Planned | Under evaluation |
| Others | 📋 Planned | Community contributions welcome |

Lyrics input for Chinese supports both **Pinyin** (e.g. `ni hao`) and **Chinese characters** (e.g. `你好`). The system automatically converts characters to phonemes for synthesis.

#### FAQ

**Q: What models do I need?**  
A: You need to place the SoulX-Singer ONNX models in the `onnx_models/` directory. See [ONNX Models](#onnx-models) section for details.

**Q: Can I use my own voice?**  
A: Yes! Use the Singer Creator to create a custom singer from a reference WAV audio file. The model will learn the vocal characteristics.

**Q: Does it work without a GPU?**  
A: Yes. ONNX Runtime will fall back to CPU automatically if no compatible GPU is detected.

**Q: How do I report a bug?**  
A: Open an issue on [GitHub Issues](https://github.com/Henley04/SXSEditor/issues).

---

### For Developers

#### Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- **Windows** (primary target; macOS/Linux supported via Electron Forge makers)
- **ONNX models**: Download the SoulX-Singer ONNX models into `onnx_models/`
- **Git**

#### Build from Source

```bash
git clone https://github.com/Henley04/SXSEditor.git
cd SXSEditor
npm install
```

If you encounter native module build issues:

```bash
npx electron-rebuild
```

#### Run in Development Mode

```bash
npm start
```

#### Package & Distribute

```bash
npm run package     # Package for current platform
npm run make        # Create distributables (.exe, .zip, .deb)
```

#### ONNX Models

The application requires SoulX-Singer ONNX model files in `onnx_models/`.

**Required SVS Models (`onnx_models/`)**

| Model | Purpose |
|-------|---------|
| `note_text_encoder.onnx` | Phoneme ID embedding |
| `note_pitch_encoder.onnx` | Note pitch embedding |
| `note_type_encoder.onnx` | Note type embedding |
| `f0_encoder.onnx` | Quantized F0 embedding |
| `preflow.onnx` | ConvNeXtV2 pre-processing |
| `cond_emb.onnx` | Condition embedding projection |
| `diff_step_dml.onnx` | Single diffusion step (DiffLlama) |
| `vocoder.onnx` | Vocos vocoder (mel → waveform) |
| `mel_transform.onnx` | Mel-spectrogram extraction |

See [onnx_models/README.md](onnx_models/README.md) for detailed specifications and usage.

#### Tech Stack

| Category | Technology |
|----------|-----------|
| Frontend | Vanilla JavaScript, HTML5 Canvas, Wavesurfer.js |
| Desktop Framework | Electron + Electron Forge |
| Build Tool | Webpack |
| Inference Engine | ONNX Runtime Node |
| Neural Models | SoulX-Singer (Diffusion-based SVS) |
| Pitch Detection | RMVPE ONNX, Basic Pitch (TensorFlow.js) |
| Testing | Mocha + Chai + Sinon + NYC |

#### Project Structure

```
SXSEditor/
├── assets/                  # Application icons and images
├── docs/                    # Documentation & website
│   ├── index.html           # Official website
│   ├── wiki/                # Wiki pages
│   └── ...
├── example/                 # Example prompt/target data
├── onnx_models/             # ONNX model files
│   ├── svc/                 # SVC-specific models
│   └── README.md
├── src/
│   ├── audio/               # WAV encoder and audio utilities
│   ├── editor/              # Track manager, piano roll, envelope editor
│   ├── inference/           # ONNX inference pipelines
│   ├── main.js              # Electron main process
│   ├── preload.js           # Preload script for secure IPC
│   ├── renderer.js          # Main renderer process (UI logic)
│   └── ...html              # Window layouts
├── test/                    # Automated test suite (160+ tests)
├── forge.config.js          # Electron Forge configuration
├── webpack.*.config.js      # Webpack configurations
└── package.json
```

#### Testing

```bash
npm test                 # Run full test suite
npm run test:coverage    # With code coverage
npm run test:watch       # Watch mode
```

The test suite includes **160+ test cases** covering WAV encoding, track management, SVS pipeline logic, pitch detection, and integration tests.

#### Audio Configuration

| Parameter | Value |
|-----------|-------|
| Sample Rate | 24000 Hz |
| Hop Size | 480 (20 ms) |
| FFT Size | 1920 |
| Window Size | 1920 |
| Mel Bins | 128 |
| F0 Range | C1 ~ B6 (32.7 Hz ~ 1975.5 Hz) |

#### Contributing

Contributions are welcome! Please ensure tests pass before submitting pull requests:

```bash
npm test
```

For major changes, open an [issue](https://github.com/Henley04/SXSEditor/issues) first to discuss what you would like to change.

---

### License

This project is licensed under the [MIT License](LICENSE).

### Acknowledgements

- **SoulX-Singer** — The underlying acoustic model and SVS/SVC pipeline
- **ONNX Runtime** — High-performance cross-platform inference engine
- **Electron Forge** — Application packaging and build tooling
- **Wavesurfer.js** — Audio waveform visualization

---

<div align="center">

---

<a id="中文"></a>

## 中文

**SXSEditor** — 一款开源的 AI 歌声合成（SVS）桌面工作台。基于 **ONNX Runtime** 和 **Electron** 构建，采用 **SoulX-Singer** 声学模型进行神经网络歌声合成，支持 GPU（DirectML）和 CPU 推理。

> **SVS 语言支持**：目前支持 **中文（普通话）** 和 **英语** 歌声合成。日语等其他语言正在开发中。

---

### 用户指南

#### 下载

[⬇ 下载 SXSEditor v1.0.0 for Windows](https://share.weiyun.com/2pgoQsmL)

> macOS 和 Linux 用户请参考[开发者指南](#开发者指南)从源码构建。

#### 快速开始

1. 安装后启动 SXSEditor
2. 在工具栏设置 BPM 和拍号
3. 添加歌手 → 点击歌手面板的 **+** → 创建新歌手或打开 `.sxssinger` 文件
4. 添加片段 → 点击歌手行的 **+**
5. **双击**片段打开钢琴卷帘编辑器
6. 添加音符和歌词，绘制音高曲线，保存
7. 按 **▶ 播放** 合成并试听
8. 导出为 WAV 文件

#### 功能特性

| 功能 | 说明 |
|------|------|
| 🎹 多轨时间线 | 拖拽排列歌曲片段 |
| 🎼 钢琴卷帘编辑器 | 编辑音符、歌词、音高曲线 |
| 🧠 神经歌声合成 | SoulX-Singer 模型 + ONNX Runtime |
| 🎤 歌手管理 | 自定义歌手，支持参考音频 |
| 📊 音频预处理 | RMVPE / Basic Pitch F0 提取 |
| ▶️ 实时播放 | 直接合成播放 |
| 📦 WAV 导出 | 混音导出为标准 WAV |
| ⚡ GPU 加速 | DirectML（NVIDIA / AMD / Intel） |

#### SVS 语言支持

| 语言 | 状态 | 说明 |
|------|------|------|
| 🇬🇧 英语 | ✅ 已支持 | 完整音素覆盖 |
| 🇨🇳 中文（普通话） | ✅ 已支持 | 支持拼音和汉字输入 |
| 🇯🇵 日语 | 🔄 开发中 | 将在后续版本支持 |
| 🇰🇷 韩语 | 📋 规划中 | 评估中 |
| 其他 | 📋 规划中 | 欢迎社区贡献 |

中文歌词输入支持**拼音**（如 `ni hao`）和**汉字**（如 `你好`），系统自动转换为音素进行合成。

---

### 开发者指南

#### 环境要求

- Node.js >= 18
- npm >= 9
- Windows（主要目标平台；macOS/Linux 通过 Electron Forge 支持）
- 将 SoulX-Singer ONNX 模型放入 `onnx_models/` 目录

#### 从源码构建

```bash
git clone https://github.com/Henley04/SXSEditor.git
cd SXSEditor
npm install
```

如遇原生模块构建问题：

```bash
npx electron-rebuild
```

#### 运行开发模式

```bash
npm start
```

#### 打包分发

```bash
npm run package     # 打包当前平台
npm run make        # 生成安装包 (.exe, .zip, .deb)
```

#### 运行测试

```bash
npm test                 # 运行全部测试
npm run test:coverage    # 带覆盖率报告
npm run test:watch       # 监视模式
```

测试套件包含 **160+ 个测试用例**，覆盖 WAV 编码、轨道管理、SVS 流水线、音高检测等。

#### 技术栈

| 类别 | 技术 |
|------|------|
| 前端 | Vanilla JavaScript, HTML5 Canvas, Wavesurfer.js |
| 桌面框架 | Electron + Electron Forge |
| 构建工具 | Webpack |
| 推理引擎 | ONNX Runtime Node |
| 声学模型 | SoulX-Singer（扩散模型 SVS） |
| 音高检测 | RMVPE ONNX, Basic Pitch (TensorFlow.js) |
| 测试 | Mocha + Chai + Sinon + NYC |

---

### 许可证

本项目基于 [MIT License](LICENSE) 开源。

### 致谢

- **SoulX-Singer** — 底层的声学模型与 SVS/SVC 流水线
- **ONNX Runtime** — 高性能跨平台推理引擎
- **Electron Forge** — 应用打包与构建工具链
- **Wavesurfer.js** — 音频波形可视化库

---

<a id="日本語"></a>

## 日本語

**SXSEditor** — オープンソースのデスクトップ歌声合成（SVS）ワークステーションです。**ONNX Runtime** と **Electron** をベースに、**SoulX-Singer** 音響モデルを使用したニューラル歌声合成を実現し、GPU（DirectML）と CPU の両方で効率的な推論をサポートします。

> **SVS 言語サポート**：現在は **中国語（普通話）** と **英語** の歌声合成をサポートしています。日本語などの他の言語は現在開発中です。

---

### ユーザー向け

#### ダウンロード

[⬇ SXSEditor v1.0.0 for Windows をダウンロード](https://share.weiyun.com/2pgoQsmL)

> macOS および Linux ユーザーは、[開発者向けガイド](#開発者向け)を参照してソースからビルドしてください。

#### クイックスタート

1. インストール後、SXSEditor を起動
2. ツールバーで BPM と拍子記号を設定
3. 歌手を追加 → 歌手パネルの **+** をクリック → 新規作成または `.sxssinger` ファイルを開く
4. フラグメントを追加 → 歌手行の **+** をクリック
5. フラグメントを**ダブルクリック**してピアノロールエディターを開く
6. 音符と歌詞を追加、ピッチカーブを描画、保存
7. **▶ 再生**を押して合成・試聴
8. WAV ファイルとしてエクスポート

#### SVS 言語サポート

| 言語 | ステータス | 備考 |
|------|-----------|------|
| 🇬🇧 英語 | ✅ 対応済み | 完全な音素カバレッジ |
| 🇨🇳 中国語（普通話） | ✅ 対応済み | ピンイン・漢字入力対応 |
| 🇯🇵 日本語 | 🔄 開発中 | 将来のリリースで対応予定 |
| 🇰🇷 韓国語 | 📋 計画中 | 評価中 |
| その他 | 📋 計画中 | コミュニティの貢献を歓迎 |

---

### 開発者向け

#### 前提条件

- Node.js >= 18
- npm >= 9
- Windows（主ターゲットプラットフォーム）
- SoulX-Singer ONNX モデルを `onnx_models/` に配置

#### ソースからビルド

```bash
git clone https://github.com/Henley04/SXSEditor.git
cd SXSEditor
npm install
```

ネイティブモジュールの問題が発生した場合：

```bash
npx electron-rebuild
```

#### 開発モードで実行

```bash
npm start
```

#### テスト

```bash
npm test                 # 全テスト実行
npm run test:coverage    # カバレッジ付き
```

---

### ライセンス

このプロジェクトは [MIT License](LICENSE) の下で公開されています。

---

<div align="center">

**SXSEditor** — Made with ❤️ and AI

[GitHub](https://github.com/Henley04/SXSEditor) · [Website](https://henley04.github.io/SXSEditor) · [Issues](https://github.com/Henley04/SXSEditor/issues)

</div>