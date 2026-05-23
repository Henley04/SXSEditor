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

[⬇ Download SXSEditor v1.0.0 for Windows](https://github.com/Henley04/SXSEditor/releases/download/EA/sxsinstaller_x64_no_models.exe)

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
| 🎹 Multi-track Timeline | Arrange fragments with drag-and-drop, cross-track movement, rounded corners & MIDI visualization |
| 🼼 Piano Roll Editor | Edit notes, lyrics, pitch curves & envelopes, fragment boundary indicator |
| 🧠 Neural SVS | SoulX-Singer model via ONNX Runtime |
| 🎤 Singer Management | Custom singers with reference audio & F0 |
| 📊 Audio Preprocessing | RMVPE / Basic Pitch F0 extraction |
| 🎵 Audio to MIDI | Convert audio files to MIDI + pitch curve (RosVot / Basic Pitch selectable) |
| 🎵 MIDI Import | Import standard MIDI files with lyrics |
| ⚙️ Advanced Settings | Diffusion steps, CFG rescale, device selection, MIDI extraction tool |
| 🔄 Undo / Redo | Full edit history (up to 200 steps) |
| 💾 Save on Exit | Prompt to save unsaved changes before closing |
| ⌨️ Ctrl+S Shortcut | Quick save project with keyboard shortcut |
| 📥 Model Auto-Download | Download missing ONNX models from ModelScope |
| 🔀 Chunked Multi-threaded Download | Parallel chunked download for large files (up to 16 concurrent connections, dynamic chunk sizing based on file size) |
| ▶️ Real-time Playback | Synthesize & play directly in editor |
| 🔊 WASAPI Exclusive Mode | Low-latency audio output via naudiodon |
| 📦 WAV Export | Mix & export to standard WAV (24kHz) |
| ⚡ GPU Acceleration | DirectML (NVIDIA / AMD / Intel) |
| 📊 Resource Manager | Monitor GPU/VRAM usage, load/unload individual models |
| 🚀 Optimized IPC | Float32Array binary transfer for low-latency audio pipeline |
| 🖥️ HiDPI Support | High-resolution canvas rendering for Retina/HiDPI displays |
| 🌐 Multilingual Website | Official website supports Chinese / English / Japanese with auto-detection |

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

**SVS Models (`onnx_models/`)**

| Model | Purpose |
|-------|---------|
| `note_text_encoder.onnx` | Phoneme ID embedding |
| `note_pitch_encoder.onnx` | Note pitch embedding |
| `note_type_encoder.onnx` | Note type embedding |
| `f0_encoder.onnx` | Quantized F0 embedding |
| `preflow.onnx` | ConvNeXtV2 pre-processing |
| `cond_emb.onnx` | Condition embedding projection |
| `diff_step_dml.onnx` | Single diffusion step (DiffLlama) |
| `vocoder_dml.onnx` | Vocos vocoder (mel → waveform, DML optimized) |
| `mel_transform.onnx` | Mel-spectrogram extraction |

**Preprocessing Models (`onnx_models/preprocess/`)**

| Model | Purpose |
|-------|---------|
| `rmvpe_model.onnx` | RMVPE pitch detection |
| `rmvpe_mel.onnx` | Mel-spectrogram for RMVPE |
| `rosvot_model.onnx` | ROSVOT voice onset detection |

**Basic Pitch Model (`onnx_models/basic_pitch_model/`)**

| Model | Purpose |
|-------|---------|
| `model.json` + `group1-shard1of1.bin` | Basic Pitch note detection (TensorFlow.js) |

> Models can be automatically downloaded from ModelScope via the built-in model manager on first launch.

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
| Audio Output | naudiodon (WASAPI shared/exclusive mode) |
| Chinese Lyrics | pinyin-pro (character → pinyin conversion) |
| Testing | Mocha + Chai + Sinon + NYC |

#### Project Structure

```
SXSEditor/
├── assets/                  # Application icons and images
├── docs/                    # Documentation & website
│   ├── index.html           # Official website (i18n: zh/en/jp)
│   ├── features.html        # Features page
│   ├── download.html        # Download page
│   ├── about.html           # About page
│   ├── js/i18n.js           # Internationalization system
│   ├── wiki/                # Wiki pages
│   └── ...
├── example/                 # Example prompt/target data
├── onnx_models/             # ONNX model files
│   ├── preprocess/          # RMVPE & ROSVOT models
│   ├── basic_pitch_model/   # Basic Pitch model (TF.js)
│   └── README.md
├── src/
│   ├── audio/               # WAV encoder, audio output manager, audio worker
│   ├── editor/              # Track manager, piano roll, envelope editor, history manager
│   ├── inference/           # ONNX inference pipelines, RMVPE, MIDI parser
│   ├── main.js              # Electron main process
│   ├── preload.js           # Preload script for secure IPC
│   ├── renderer.js          # Main renderer process (UI logic)
│   ├── modelManager.js      # Model download & verification (ModelScope)
│   ├── modelRegistry.js     # Extensible model group definitions
│   ├── modelDownload.js     # Model download progress window
│   ├── settings.js          # Settings window (device, diffusion, audio)
│   ├── singerCreator.js     # Singer creation window
│   ├── audioPreprocess.js   # Audio preprocessing window (F0, MIDI)
│   ├── fragmentEditor.js    # Fragment piano-roll editor
│   ├── resourceManager.js   # Resource manager window (GPU/VRAM, model load/unload)
│   └── ...html/.css         # Window layouts and styles
├── test/                    # Automated test suite (225+ tests)
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

The test suite includes **225+ test cases** covering WAV encoding, track management, SVS pipeline logic, pitch detection, MIDI parsing, and integration tests.

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

[⬇ 下载 SXSEditor v1.0.0 for Windows](https://github.com/Henley04/SXSEditor/releases/download/EA/sxsinstaller_x64_no_models.exe)

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
| 🎹 多轨时间线 | 拖拽排列歌曲片段，支持跨轨道移动，圆角UI与MIDI可视化 |
| 🎼 钢琴卷帘编辑器 | 编辑音符、歌词、音高曲线，分片边界指示器 |
| 🧠 神经歌声合成 | SoulX-Singer 模型 + ONNX Runtime |
| 🎤 歌手管理 | 自定义歌手，支持参考音频 |
| 📊 音频预处理 | RMVPE / Basic Pitch F0 提取 |
| 🎵 音频转MIDI | 从音频文件提取MIDI音符和音高曲线（RosVot / Basic Pitch 可选） |
| 🎵 MIDI 导入 | 导入标准 MIDI 文件及歌词 |
| ⚙️ 高级设置 | 扩散步数、CFG 重缩放、设备选择、MIDI 提取工具 |
| 🔄 撤销 / 重做 | 完整编辑历史（最多 200 步） |
| 💾 退出保存提示 | 关闭窗口时提示保存未保存的更改 |
| ⌨️ Ctrl+S 快捷键 | 键盘快捷键快速保存项目 |
| 📥 模型自动下载 | 从 ModelScope 自动下载缺失模型 |
| 🔀 分片多线程下载 | 大文件分片并行下载，智能并发配置（最大16连接），根据文件大小动态调整分片 |
| ▶️ 实时播放 | 直接合成播放 |
| 🔊 WASAPI 独占模式 | 通过 naudiodon 实现低延迟音频输出 |
| 📦 WAV 导出 | 混音导出为标准 WAV |
| ⚡ GPU 加速 | DirectML（NVIDIA / AMD / Intel） |
| 📊 资源管理器 | 监控 GPU/显存占用，单独加载/卸载模型 |
| 🚀 优化 IPC 传输 | Float32Array 二进制传输，低延迟音频管线 |
| 🖥️ HiDPI 支持 | 高分辨率 Canvas 渲染，适配 Retina/HiDPI 显示器 |
| 🌐 官网多语言 | 官方网站支持中文/英文/日文，自动检测浏览器语言 |

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

测试套件包含 **225+ 个测试用例**，覆盖 WAV 编码、轨道管理、SVS 流水线、音高检测、MIDI 解析等。

#### 技术栈

| 类别 | 技术 |
|------|------|
| 前端 | Vanilla JavaScript, HTML5 Canvas, Wavesurfer.js |
| 桌面框架 | Electron + Electron Forge |
| 构建工具 | Webpack |
| 推理引擎 | ONNX Runtime Node |
| 声学模型 | SoulX-Singer（扩散模型 SVS） |
| 音高检测 | RMVPE ONNX, Basic Pitch (TensorFlow.js) |
| 音频输出 | naudiodon（WASAPI 共享/独占模式） |
| 中文歌词 | pinyin-pro（汉字转拼音） |
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

[⬇ SXSEditor v1.0.0 for Windows をダウンロード](https://github.com/Henley04/SXSEditor/releases/download/EA/sxsinstaller_x64_no_models.exe)

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

#### 機能一覧

| 機能 | 説明 |
|------|------|
| 🎹 マルチトラックタイムライン | ドラッグ＆ドロップでフラグメントを配置、トラック間移動対応、角丸UIとMIDI可視化 |
| 🎼 ピアノロールエディター | 音符・歌詞・ピッチカーブの編集、フラグメント境界インジケーター |
| 🧠 ニューラル SVS | SoulX-Singer モデル + ONNX Runtime |
| 🎤 歌手管理 | カスタム歌手、参照音声対応 |
| 📊 音声前処理 | RMVPE / Basic Pitch F0 抽出 |
| 🎵 オーディオ→MIDI | オーディオファイルからMIDIノートとピッチカーブを抽出 |
| 🎵 MIDI インポート | 標準 MIDI ファイルと歌詞のインポート |
| ⚙️ 詳細設定 | 拡散ステップ数、CFG リスケール、デバイス選択 |
| 🔄 アンドゥ / リドゥ | 編集履歴（最大 200 ステップ） |
| 💾 終了時保存確認 | ウィンドウを閉じる際に未保存の変更を保存するか確認 |
| ⌨️ Ctrl+S ショートカット | キーボードショートカットでプロジェクトを素早く保存 |
| 📥 モデル自動ダウンロード | ModelScope から不足モデルを自動取得 |
| 🔀 チャンク分割マルチスレッドダウンロード | 大容量ファイルの並列チャンクダウンロード（最大16同時接続） |
| ▶️ リアルタイム再生 | エディター内で直接合成・再生 |
| 🔊 WASAPI 排他モード | naudiodon による低レイテンシオーディオ出力 |
| 📦 WAV エクスポート | 標準 WAV へのミックスダウン |
| ⚡ GPU アクセラレーション | DirectML（NVIDIA / AMD / Intel） |
| 📊 リソースマネージャー | GPU/VRAM使用量の監視、モデルの個別ロード/アンロード |
| 🚀 最適化 IPC 転送 | Float32Array バイナリ転送による低レイテンシオーディオパイプライン |
| 🖥️ HiDPI サポート | 高解像度 Canvas レンダリング、Retina/HiDPI ディスプレイ対応 |
| 🌐 多言語ウェブサイト | 公式サイトが中国語/英語/日本語に対応、ブラウザ言語を自動検出 |

---

### 開発者向け

#### 前提条件

- Node.js >= 18
- npm >= 9
- Windows（主ターゲットプラットフォーム）
- ONNX モデルは初回起動時に ModelScope から自動ダウンロード可能

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

テストスイートには **225 以上のテストケース** が含まれています。

#### 技術スタック

| カテゴリ | 技術 |
|----------|------|
| フロントエンド | Vanilla JavaScript, HTML5 Canvas, Wavesurfer.js |
| デスクトップフレームワーク | Electron + Electron Forge |
| ビルドツール | Webpack |
| 推論エンジン | ONNX Runtime Node |
| 音響モデル | SoulX-Singer（拡散モデル SVS） |
| ピッチ検出 | RMVPE ONNX, Basic Pitch (TensorFlow.js) |
| オーディオ出力 | naudiodon（WASAPI 共有/排他モード） |
| 中国語歌詞 | pinyin-pro（漢字→ピンイン変換） |
| テスト | Mocha + Chai + Sinon + NYC |

---

### ライセンス

このプロジェクトは [MIT License](LICENSE) の下で公開されています。

---

<div align="center">

**SXSEditor** — Made with ❤️ and AI

[GitHub](https://github.com/Henley04/SXSEditor) · [Website](https://henley04.github.io/SXSEditor) · [Issues](https://github.com/Henley04/SXSEditor/issues)

</div>