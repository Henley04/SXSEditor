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

- [GitHub Release (latest installer)](https://github.com/Henley04/SXSEditor/releases/latest/download/sxsinstaller_x64_no_models.exe)
- [GitCode Mirror (China, latest installer)](https://gitcode.com/qq_50331623/SXSEditor/releases/latest/download/sxsinstaller_x64_no_models.exe)

macOS / Linux: build from source (see below).

### Quick Start

1. Install and launch SXSEditor.
2. On first launch, select model precision and download models.
3. Click **+** in the singer panel → **Open Singer Creator**.
4. Enter singer name, upload a **pure vocal** WAV file (max 30s).
5. Click **Start Audio Preprocessing** → extract F0 and MIDI → **edit lyrics for each note** → save.
6. Use the **File → Save** menu (or `Ctrl+S`) to save the `.sxssinger` file. The first save prompts for a location; subsequent saves write to the same file silently. Use **File → Save As...** (`Ctrl+Shift+S`) to save to a new location.
7. Click **+** on the singer row to add a fragment. Double-click to open the editor.
8. Add notes, type lyrics, optionally draw pitch curves. Save.
9. Press **Play** to synthesize and listen. Use **Export** to save as WAV.

See the [Wiki](docs/wiki/Home.md) for full documentation.

### Features

| Feature | Description |
|---------|-------------|
| Piano Roll Editor | Notes, lyrics, pitch curves, volume/pan envelopes, phoneme editing |
| Neural SVS | SoulX-Singer diffusion model via ONNX Runtime |
| Singer Creator | Custom voices from reference WAV audio |
| Audio Preprocessing | RMVPE F0 extraction, Basic Pitch MIDI extraction |
| SVS Pipeline | CFG rescale, DML/WebNN path parity, LRU synth cache, parallel encoders + chunked vocoder |
| Optional SiFiGAN Vocoder | SiFiGAN (ICASSP 2023) as an alternative DirectML vocoder with auto-fallback to default |
| Minimal Vocoder Swap | Switching vocoder (default ↔ SiFiGAN) reloads only the vocoder session; main models stay loaded |
| SiFiGAN Precision Switch | SiFiGAN precision (FP32/FP16) selectable independently in settings; FP16 marked as low quality (cos≈0.95), defaults to FP32; missing variant auto-falls-back to the other |
| Audio to MIDI | Convert audio files to MIDI notes |
| MIDI Import | Import standard MIDI files |
| Multi-track Timeline | Drag-anddrop fragment arrangement |
| WASAPI Audio | Shared and exclusive mode output |
| GPU Acceleration | DirectML (NVIDIA/AMD/Intel), NPU (WebNN) |
| One-shot Hardware Detection | GPU/NPU/DML enumeration runs once after app startup; results cached and reused at runtime (no re-probing during synthesis) |
| Smart Vocoder Chunk Sizing | Vocoder chunk size auto-allocated from available VRAM (after subtracting resident model weights by precision: FP32≈2.9GB, FP16≈1.4GB, INT8≈0.96GB); tiers: <0.5GB→256, <1.5GB→512, <3GB→768, <5GB→1008, ≥5GB→1280; manual override available in settings |
| Model Auto-Download | Chunked parallel download from ModelScope |
| Model Precision | FP32, FP16, INT8, INT8-NPU |
| Themes | Hot-swappable design token system |
| SVG Icons | Flat, theme-aware inline SVG icon system (currentColor) |
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
npm test                  # Run tests (1000+)
npm run lint              # Run ESLint (Flat Config)
npm run package           # Package
npm run make              # Create distributables
```

Requires Node.js >= 18, npm >= 9.

### CLI Debug Mode

A lightweight CLI for agent debugging — verify functionality and print logs without launching the GUI.

```bash
npm run cli -- help              # Show all commands
npm run cli -- version           # Print build info
npm run cli -- info              # Print app/runtime/path info
npm run cli -- gpu               # Detect GPU / DirectML devices
npm run cli -- models            # List ONNX models, mark missing required
npm run cli -- settings          # Dump current settings.json
npm run cli -- init-pipeline     # Initialize SVS pipeline (verifies models load)
npm run cli -- synth             # Run a minimal synthesis, print audio stats
npm run cli -- synth --steps 4 --out out.wav   # Synthesize and write WAV
```

Exit codes: 0 = success, 1 = runtime error, 2 = bad args.

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

- [GitHub Release (latest installer)](https://github.com/Henley04/SXSEditor/releases/latest/download/sxsinstaller_x64_no_models.exe)
- [GitCode 镜像（中国大陆加速）](https://gitcode.com/qq_50331623/SXSEditor/releases)

macOS / Linux 用户请从源码构建。

### 快速开始

1. 安装并启动 SXSEditor。
2. 首次启动时选择模型精度并下载模型。
3. 点击歌手面板的 **+** → **打开歌手创建器**。
4. 输入歌手名称，上传**纯人声** WAV 文件（最长 30 秒）。
5. 点击**开始音频预处理** → 提取 F0 和 MIDI → **为每个音符填写歌词** → 保存。
6. 通过 **文件 → 保存** 菜单（或 `Ctrl+S`）保存 `.sxssinger` 文件。首次保存会询问保存位置，之后再次保存会直接写入原文件。需要换位置保存时用 **文件 → 另存为...**（`Ctrl+Shift+S`）。
7. 在歌手行点击 **+** 添加分片，双击打开编辑器。
8. 添加音符、输入歌词、可选绘制音高曲线。保存。
9. 按 **播放**合成试听。用 **导出**保存为 WAV。

完整文档见 [Wiki](docs/wiki/Home.md)。

### 功能

| 功能 | 说明 |
|------|------|
| 钢琴卷帘编辑器 | 音符、歌词、音高曲线、音量/声像包络、音素编辑 |
| 神经歌声合成 | SoulX-Singer 扩散模型 + ONNX Runtime |
| 歌手创建器 | 从参考 WAV 音频创建自定义声音 |
| 音频预处理 | RMVPE F0 提取、Basic Pitch MIDI 提取 |
| SVS 推理管线 | CFG rescale、DML/WebNN 路径一致性、LRU 合成缓存、编码器并行 + Vocoder 分块批量化 |
| 可选 SiFiGAN Vocoder | SiFiGAN (ICASSP 2023) 作为可选 DirectML Vocoder，自动回退到默认 Vocoder |
| Vocoder 最小化切换 | 切换 Vocoder（默认 ↔ SiFiGAN）仅重载 vocoder session，主模型保持已加载状态 |
| SiFiGAN 精度切换 | SiFiGAN 精度（FP32/FP16）可在设置中单独选择；FP16 标注为低质量（cos≈0.95），默认 FP32；所选变体缺失时自动回退到另一变体 |
| 音频转 MIDI | 从音频文件提取 MIDI 音符 |
| MIDI 导入 | 导入标准 MIDI 文件 |
| 多轨时间线 | 拖拽排列分片 |
| WASAPI 音频 | 共享和独占模式输出 |
| GPU 加速 | DirectML（NVIDIA/AMD/Intel）、NPU（WebNN） |
| 一次性硬件探测 | 应用启动后仅执行一次 GPU/NPU/DML 设备枚举，结果缓存复用，运行时不再重复探测（避免与推理并发提交命令流） |
| Vocoder 分片智能分配 | 依据可用显存（VRAM 减去按精度估算的常驻权重：FP32≈2.9GB、FP16≈1.4GB、INT8≈0.96GB）自动分档（&lt;0.5GB→256, &lt;1.5GB→512, &lt;3GB→768, &lt;5GB→1008, ≥5GB→1280）；可在设置中切换为手动设置 |
| 模型自动下载 | 从 ModelScope 分片并行下载 |
| 模型精度 | FP32、FP16、INT8、INT8-NPU |
| 主题系统 | 热切换设计令牌系统 |
| SVG 图标 | 扁平化、主题感知的内联 SVG 图标系统 (currentColor) |
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
npm test                  # 运行测试（1000+）
npm run lint              # 运行 ESLint（Flat Config）
npm run package           # 打包
npm run make              # 生成安装包
```

需要 Node.js >= 18，npm >= 9。

### CLI 调试模式

为 agent 调试提供的轻量 CLI —— 不启动 GUI，仅验证功能并输出日志。

```bash
npm run cli -- help              # 显示所有命令
npm run cli -- version           # 输出构建信息
npm run cli -- info              # 输出应用/运行时/路径信息
npm run cli -- gpu               # 检测 GPU / DirectML 设备
npm run cli -- models            # 列出 ONNX 模型，标记缺失的必需模型
npm run cli -- settings          # 输出当前 settings.json
npm run cli -- init-pipeline     # 初始化 SVS 管线（验证全部模型可加载）
npm run cli -- synth             # 运行最小合成，输出音频统计
npm run cli -- synth --steps 4 --out out.wav   # 合成并写入 WAV
```

退出码：0 = 成功，1 = 运行时错误，2 = 参数错误。

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

- [GitHub Release (latest installer)](https://github.com/Henley04/SXSEditor/releases/latest/download/sxsinstaller_x64_no_models.exe)
- [GitCode ミラー（中国、最新インストーラー）](https://gitcode.com/qq_50331623/SXSEditor/releases/latest/download/sxsinstaller_x64_no_models.exe)

macOS / Linux：ソースからビルドしてください。

### クイックスタート

1. SXSEditor をインストールして起動。
2. 初回起動時にモデル精度を選択しダウンロード。
3. 歌手パネルの **+** → **歌手作成を開く**。
4. 歌手名を入力、**ボーカルのみ**の WAV ファイルをアップロード（最大30秒）。
5. **音声前処理を開始** → F0 と MIDI を抽出 → **各音符に歌詞を入力** → 保存。
6. **ファイル → 保存**メニュー（または `Ctrl+S`）で `.sxssinger` ファイルを保存。初回は保存先を尋ね、以降は同じファイルに直接上書き保存されます。別の場所に保存する場合は **ファイル → 名前を付けて保存...**（`Ctrl+Shift+S`）。
7. 歌手行の **+** でフラグメントを追加、ダブルクリックでエディターを開く。
8. 音符を追加、歌詞を入力、必要に応じてピッチカーブを描画。保存。
9. **再生**で合成・試聴。**エクスポート**で WAV 保存。

詳細は [Wiki](docs/wiki/Home.md) を参照。

### 機能

| 機能 | 説明 |
|------|------|
| ピアノロールエディター | 音符・歌詞・ピッチカーブ・音量/パンエンベロープ・音素編集 |
| ニューラル SVS | SoulX-Singer 拡散モデル + ONNX Runtime |
| 歌手作成 | 参照 WAV 音声からカスタムボイス作成 |
| 音声前処理 | RMVPE F0 抽出、Basic Pitch MIDI 抽出 |
| SVS 推論パイプライン | CFG rescale、DML/WebNN パリティ、LRU 合成キャッシュ、エンコーダ並列 + Vocoder チャンクバッチ |
| オプション SiFiGAN Vocoder | SiFiGAN (ICASSP 2023) をオプション DirectML Vocoder として提供、デフォルト Vocoder へ自動フォールバック |
| Vocoder 最小切替 | Vocoder 切替（デフォルト ↔ SiFiGAN）は vocoder session のみ再読み込み、メインモデルはロード済みのまま維持 |
| SiFiGAN 精度切替 | SiFiGAN 精度（FP32/FP16）を設定で個別選択可能；FP16 は低品質（cos≈0.95）と明記、デフォルト FP32；選択変体が欠落時はもう一方へ自動フォールバック |
| オーディオ→MIDI | 音声ファイルから MIDI ノート抽出 |
| MIDI インポート | 標準 MIDI ファイルのインポート |
| マルチトラックタイムライン | ドラッグ＆ドロップでフラグメント配置 |
| WASAPI オーディオ | 共有/排他モード出力 |
| GPU アクセラレーション | DirectML（NVIDIA/AMD/Intel）、NPU（WebNN） |
| 1 回限りのハードウェア検出 | アプリ起動後に GPU/NPU/DML デバイス列挙を 1 回だけ実行し、結果をキャッシュして実行時に再利用（合成中の再検出を回避） |
| Vocoder チャンクサイズ自動割当 | VRAM から精度別の常駐重み（FP32≈2.9GB、FP16≈1.4GB、INT8≈0.96GB）を差し引いた利用可能显存に基づき Vocoder チャンクサイズを自動選択（&lt;0.5GB→256, &lt;1.5GB→512, &lt;3GB→768, &lt;5GB→1008, ≥5GB→1280）；設定で手動指定にも切替可能 |
| モデル自動ダウンロード | ModelScope からチャンク並列ダウンロード |
| モデル精度 | FP32、FP16、INT8、INT8-NPU |
| テーマ | ホットスワップ対応デザイントークンシステム |
| SVG アイコン | フラット設計、テーマ連動インライン SVG アイコンシステム (currentColor) |
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
npm test                  # テスト実行（1000+）
npm run lint              # ESLint 実行（Flat Config）
npm run package           # パッケージング
npm run make              # 配布物作成
```

Node.js >= 18、npm >= 9 が必要です。

### CLI デバッグモード

agent デバッグ用の軽量 CLI —— GUI を起動せずに機能検証とログ出力を行います。

```bash
npm run cli -- help              # 全コマンド表示
npm run cli -- version           # ビルド情報出力
npm run cli -- info              # アプリ/ランタイム/パス情報
npm run cli -- gpu               # GPU / DirectML デバイス検出
npm run cli -- models            # ONNX モデル一覧、必須モデルの欠落確認
npm run cli -- settings          # settings.json ダンプ
npm run cli -- init-pipeline     # SVS パイプライン初期化（モデル読込検証）
npm run cli -- synth             # 最小合成を実行し音声統計を出力
npm run cli -- synth --steps 4 --out out.wav   # 合成して WAV 書き出し
```

終了コード：0 = 成功、1 = ランタイムエラー、2 = 引数エラー。

### 技術スタック

Electron + Webpack、ONNX Runtime Node（DirectML）+ ONNX Runtime Web（WebNN）、Vanilla JS + HTML5 Canvas、Mocha + Chai + Sinon。

### ライセンス

[MIT](LICENSE)

<div align="center">

**SXSEditor**

[GitHub](https://github.com/Henley04/SXSEditor) · [Issues](https://github.com/Henley04/SXSEditor/issues)

</div>
