<div align="center">

  <img src="docs/images/icon.png" alt="SXSEditor" width="80" height="80" style="border-radius:16px"/>

  # SXSEditor

  AI Singing Voice Synthesis Workstation

  [![Version](https://img.shields.io/badge/version-1.0.0-blue?style=flat-square)](https://github.com/Henley04/SXSEditor/releases)
  [![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
  [![Platform](https://img.shields.io/badge/platform-Windows%20|%20macOS%20|%20Linux-lightgrey?style=flat-square)]()
  [![SVS Languages](https://img.shields.io/badge/SVS-EN%20|%20ZH-orange?style=flat-square)]()

  **[English](#english) · [中文](#中文) · [日本語](#日本語)**

</div>

---

<a id="english"></a>

## English

SXSEditor is an open-source desktop application for singing voice synthesis. It uses the SoulX-Singer neural model running on ONNX Runtime with DirectML GPU, WebNN NPU, and CPU support.

Supported singing languages: **English** and **Chinese (Mandarin)**. Japanese is in development.

### Download

**Windows** (models auto-downloaded on first launch):

- [GitHub Releases](https://github.com/Henley04/SXSEditor/releases)
- [GitCode Mirror (China)](https://gitcode.com/qq_50331623/SXSEditor/releases)

macOS / Linux: build from source (see below).

### Quick Start

1. Install and launch SXSEditor.
2. On first launch, select model precision and download models.
3. Click **+** in the singer panel → **Open Singer Creator**.
4. Enter singer name, upload a **pure vocal** WAV file (max 30s).
5. Click **Start Audio Preprocessing** → extract F0 and MIDI → **edit lyrics for each note** → save.
6. Click **Create & Save** to save the `.sxssinger` file.
7. Click **+** on the singer row to add a fragment. Double-click to open the editor.
8. Add notes, type lyrics, optionally draw pitch curves. Save.
9. Press **▶ Play** to synthesize and listen. Use **📤 Export** to save as WAV.

See the [Wiki](docs/wiki/Home.md) for full documentation.

### Features

| Feature | Description |
|---------|-------------|
| Piano Roll Editor | Notes, lyrics, pitch curves, volume/pan envelopes, phoneme editing |
| Neural SVS | SoulX-Singer diffusion model via ONNX Runtime |
| Singer Creator | Custom voices from reference WAV audio |
| Audio Preprocessing | RMVPE F0 extraction, Basic Pitch MIDI extraction |
| Audio to MIDI | Convert audio files to MIDI notes |
| MIDI Import | Import standard MIDI files |
| Multi-track Timeline | Drag-anddrop fragment arrangement |
| WASAPI Audio | Shared and exclusive mode output |
| GPU Acceleration | DirectML (NVIDIA/AMD/Intel), NPU (WebNN) |
| Model Auto-Download | Chunked parallel download from ModelScope |
| Model Precision | FP32, FP16, FP8, INT8, INT8-NPU |
| Themes | Hot-swappable design token system |
| Undo/Redo | 200-step edit history |
| WAV Export | 24kHz output |

### Build from Source

```bash
git clone https://github.com/Henley04/SXSEditor.git
cd SXSEditor
npm install
npm start
```

```bash
npm test                  # Run tests (470+)
npm run package           # Package
npm run make              # Create distributables
```

Requires Node.js >= 18, npm >= 9.

### Tech Stack

Electron + Webpack, ONNX Runtime Node (DirectML) + ONNX Runtime Web (WebNN), Vanilla JS + HTML5 Canvas, Mocha + Chai + Sinon.

### License

[MIT](LICENSE)

---

<div align="center">

---

<a id="中文"></a>

## 中文

SXSEditor 是一个开源的桌面歌声合成应用。基于 SoulX-Singer 神经网络模型，通过 ONNX Runtime 运行，支持 DirectML GPU、WebNN NPU 和 CPU 推理。

支持的合成语言：**中文（普通话）** 和 **英语**。日语正在开发中。

### 下载

**Windows**（首次启动自动下载模型）：

- [GitHub Releases](https://github.com/Henley04/SXSEditor/releases)
- [GitCode 镜像（中国大陆加速）](https://gitcode.com/qq_50331623/SXSEditor/releases)

macOS / Linux 用户请从源码构建。

### 快速开始

1. 安装并启动 SXSEditor。
2. 首次启动时选择模型精度并下载模型。
3. 点击歌手面板的 **+** → **打开歌手创建器**。
4. 输入歌手名称，上传**纯人声** WAV 文件（最长 30 秒）。
5. 点击**开始音频预处理** → 提取 F0 和 MIDI → **为每个音符填写歌词** → 保存。
6. 点击**创建并保存**，生成 `.sxssinger` 文件。
7. 在歌手行点击 **+** 添加分片，双击打开编辑器。
8. 添加音符、输入歌词、可选绘制音高曲线。保存。
9. 按 **▶ 播放**合成试听。用 **📤 导出**保存为 WAV。

完整文档见 [Wiki](docs/wiki/Home.md)。

### 功能

| 功能 | 说明 |
|------|------|
| 钢琴卷帘编辑器 | 音符、歌词、音高曲线、音量/声像包络、音素编辑 |
| 神经歌声合成 | SoulX-Singer 扩散模型 + ONNX Runtime |
| 歌手创建器 | 从参考 WAV 音频创建自定义声音 |
| 音频预处理 | RMVPE F0 提取、Basic Pitch MIDI 提取 |
| 音频转 MIDI | 从音频文件提取 MIDI 音符 |
| MIDI 导入 | 导入标准 MIDI 文件 |
| 多轨时间线 | 拖拽排列分片 |
| WASAPI 音频 | 共享和独占模式输出 |
| GPU 加速 | DirectML（NVIDIA/AMD/Intel）、NPU（WebNN） |
| 模型自动下载 | 从 ModelScope 分片并行下载 |
| 模型精度 | FP32、FP16、FP8、INT8、INT8-NPU |
| 主题系统 | 热切换设计令牌系统 |
| 撤销/重做 | 200 步编辑历史 |
| WAV 导出 | 24kHz 输出 |

### 从源码构建

```bash
git clone https://github.com/Henley04/SXSEditor.git
cd SXSEditor
npm install
npm start
```

```bash
npm test                  # 运行测试（470+）
npm run package           # 打包
npm run make              # 生成安装包
```

需要 Node.js >= 18，npm >= 9。

### 技术栈

Electron + Webpack，ONNX Runtime Node（DirectML）+ ONNX Runtime Web（WebNN），Vanilla JS + HTML5 Canvas，Mocha + Chai + Sinon。

### 许可证

[MIT](LICENSE)

---

<a id="日本語"></a>

## 日本語

SXSEditor は歌声合成のためのオープンソースデスクトップアプリケーションです。SoulX-Singer ニューラルモデルを ONNX Runtime 上で動作させ、DirectML GPU、WebNN NPU、CPU をサポートします。

対応言語：**中国語（普通話）** と **英語**。日本語は開発中です。

### ダウンロード

**Windows**（初回起動時にモデルを自動ダウンロード）：

- [GitHub Releases](https://github.com/Henley04/SXSEditor/releases)
- [GitCode ミラー（中国）](https://gitcode.com/qq_50331623/SXSEditor/releases)

macOS / Linux：ソースからビルドしてください。

### クイックスタート

1. SXSEditor をインストールして起動。
2. 初回起動時にモデル精度を選択しダウンロード。
3. 歌手パネルの **+** → **歌手作成を開く**。
4. 歌手名を入力、**ボーカルのみ**の WAV ファイルをアップロード（最大30秒）。
5. **音声前処理を開始** → F0 と MIDI を抽出 → **各音符に歌詞を入力** → 保存。
6. **作成して保存**で `.sxssinger` ファイルを生成。
7. 歌手行の **+** でフラグメントを追加、ダブルクリックでエディターを開く。
8. 音符を追加、歌詞を入力、必要に応じてピッチカーブを描画。保存。
9. **▶ 再生**で合成・試聴。**📤 エクスポート**で WAV 保存。

詳細は [Wiki](docs/wiki/Home.md) を参照。

### 機能

| 機能 | 説明 |
|------|------|
| ピアノロールエディター | 音符・歌詞・ピッチカーブ・音量/パンエンベロープ・音素編集 |
| ニューラル SVS | SoulX-Singer 拡散モデル + ONNX Runtime |
| 歌手作成 | 参照 WAV 音声からカスタムボイス作成 |
| 音声前処理 | RMVPE F0 抽出、Basic Pitch MIDI 抽出 |
| オーディオ→MIDI | 音声ファイルから MIDI ノート抽出 |
| MIDI インポート | 標準 MIDI ファイルのインポート |
| マルチトラックタイムライン | ドラッグ＆ドロップでフラグメント配置 |
| WASAPI オーディオ | 共有/排他モード出力 |
| GPU アクセラレーション | DirectML（NVIDIA/AMD/Intel）、NPU（WebNN） |
| モデル自動ダウンロード | ModelScope からチャンク並列ダウンロード |
| モデル精度 | FP32、FP16、FP8、INT8、INT8-NPU |
| テーマ | ホットスワップ対応デザイントークンシステム |
| アンドゥ/リドゥ | 200 ステップの編集履歴 |
| WAV エクスポート | 24kHz 出力 |

### ソースからビルド

```bash
git clone https://github.com/Henley04/SXSEditor.git
cd SXSEditor
npm install
npm start
```

```bash
npm test                  # テスト実行（470+）
npm run package           # パッケージング
npm run make              # 配布物作成
```

Node.js >= 18、npm >= 9 が必要です。

### 技術スタック

Electron + Webpack、ONNX Runtime Node（DirectML）+ ONNX Runtime Web（WebNN）、Vanilla JS + HTML5 Canvas、Mocha + Chai + Sinon。

### ライセンス

[MIT](LICENSE)

<div align="center">

**SXSEditor**

[GitHub](https://github.com/Henley04/SXSEditor) · [Issues](https://github.com/Henley04/SXSEditor/issues)

</div>
