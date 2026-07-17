<div align="center">

  <img src="docs/images/icon.png" alt="SXSEditor" width="80" height="80" style="border-radius:16px"/>

  # SXSEditor

  AI Singing Voice Synthesis Workstation

  [![Version](https://img.shields.io/badge/version-1.0.0-blue?style=flat-square)](https://github.com/Henley04/SXSEditor/releases)
  [![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
  [![Platform](https://img.shields.io/badge/platform-Windows%20|%20macOS%20|%20Linux-lightgrey?style=flat-square)]()
  [![SVS Languages](https://img.shields.io/badge/SVS-EN%20|%20ZH%20|%20JP-orange?style=flat-square)]()

  **[Website](https://henley04.github.io/SXSEditor/) · [User Docs](https://henley04.github.io/SXSEditor/user/quick-start.html) · [Developer Docs](https://henley04.github.io/SXSEditor/dev/build.html)**

  **[English](#english) · [中文](#中文) · [日本語](#日本語)**

</div>

---

<a id="english"></a>

## English

SXSEditor is an open-source desktop application for singing voice synthesis. It uses the SoulX-Singer neural model running on ONNX Runtime with DirectML GPU, WebNN NPU/GPU, and CPU support.

Supported singing languages: **English**, **Chinese (Mandarin)**, and **Japanese**.

Smart model download: automatically detects whether the remote ModelScope repo stores weights as split `onnx + data` or a single `onnx` file, and downloads external data alongside when present. The remote file list is fetched recursively so required files in subdirectories (`preprocess/`, `basic_pitch_model/`) are included.

MIDI import: standards-compliant MIDI file parsing (format 0/1/2, SMPTE time division, multi-track) via `@tonejs/midi`. Drum tracks (channel 10) are filtered out automatically. The main window's "Import MIDI" button supports multi-track files — each non-drum track creates an independent singer track. The Fragment Editor and Audio Preprocessing window import by merging all non-drum tracks onto a single timeline. Lyric events (meta type 0x05) are extracted directly from the raw MIDI byte stream — including track-level lyrics that `@tonejs/midi` drops — so VOCALOID-exported MIDI files (where lyrics sit on the melody track, often a few ticks ahead of each note-on) import with their original lyrics instead of falling back to `la`. When the MIDI file carries project-level metadata (tempo / BPM, time signature), the main window shows a dialog after import with two checkboxes (both checked by default) letting the user choose whether to sync BPM and/or time signature into the current project; fields not present in the file are not offered.

Fragment Editor draggable playhead: click or drag the playhead (or the header timeline) to set a custom playback start position — playback begins from that offset instead of always from zero. Dragging during playback seeks to the new position without re-synthesizing. A client-side signature cache reuses the previously synthesized audio whenever notes and inference options are unchanged, so different start positions play instantly.

Expanded Japanese kanji dictionary: covers all 2136 Jōyō kanji (the official list of common-use kanji in Japan) plus 465 additional high-frequency kanji, totaling 2601 entries. The dictionary is auto-generated from KANJIDIC2 (EDRDG) via `scripts/generate_jp_kanji_dict.py`, with hand-curated overrides merged in for the most common characters. At runtime it is loaded from `jpKanjiDict.json` (with a ~50-entry built-in fallback if the JSON is unavailable), so Japanese-mode G2P no longer falls back to `pau` for the vast majority of common kanji.

- [Website](https://henley04.github.io/SXSEditor/)
- [User Docs](https://henley04.github.io/SXSEditor/user/quick-start.html)
- [Developer Docs](https://henley04.github.io/SXSEditor/dev/build.html)
- [Application Updates](https://henley04.github.io/SXSEditor/user/app-updates.html)
- [Model Updates](https://henley04.github.io/SXSEditor/user/model-updates.html)
- [Help & FAQ](https://henley04.github.io/SXSEditor/user/faq.html)
- [Uninstall](https://henley04.github.io/SXSEditor/user/uninstall.html)

### License

[MIT](LICENSE)

---

<a id="中文"></a>

## 中文

SXSEditor 是一个开源的桌面歌声合成应用。基于 SoulX-Singer 神经网络模型，通过 ONNX Runtime 运行，支持 DirectML GPU、WebNN NPU/GPU 和 CPU 推理。

支持的合成语言：**中文（普通话）**、**英语** 和 **日语**。

智能模型下载：自动检测远程 ModelScope 仓库的权重是分开存储（onnx + data）还是单 onnx 文件，当检测到 data 时连带下载。远程文件列表递归获取，确保子目录（`preprocess/`、`basic_pitch_model/`）下的必需文件被纳入下载。

MIDI 导入：基于 `@tonejs/midi` 的标准 MIDI 文件解析（支持格式 0/1/2、SMPTE 时间格式、多轨）。鼓轨（channel 10）自动过滤。主页面"导入MIDI"按钮支持多轨文件——每个非鼓轨道创建一个独立歌手轨道；分片编辑器与音频预处理窗口的导入将所有非鼓轨道合并为单时间线。歌词事件（meta type 0x05）直接从原始 MIDI 字节流提取，包括 `@tonejs/midi` 丢弃的轨道级歌词——因此 VOCALOID 导出的 MIDI 文件（歌词位于旋律轨道上，通常比 note-on 提前数 tick）能保留原始歌词导入，而非全部回退为 `la`。当 MIDI 文件包含项目级元数据（tempo / BPM、拍号）时，主页面导入后会弹出一个含两个复选框的对话框（默认勾选），让用户选择是否同步 BPM 和/或拍号到当前项目；文件中不存在的字段不会出现在选项里。

分片编辑器可拖动播放进度条：点击或拖拽播放头（或顶部时间轴）可设置自定义播放起始位置，播放将从该位置开始而非从头开始。播放中拖拽进度条会跳转到新位置且不重新合成。客户端签名缓存会在 notes 与推理选项未变化时直接复用已合成的音频，因此不同起始位置均可秒播。

日语汉字词典扩展：覆盖全部 2136 个日本常用汉字（Jōyō kanji，日本官方常用汉字表）以及 465 个高频汉字，共 2601 条。词典由 `scripts/generate_jp_kanji_dict.py` 脚本从 KANJIDIC2（EDRDG）自动生成，并合并了最常用汉字的人工校对条目。运行时从 `jpKanjiDict.json` 加载（若 JSON 不可用则回退到约 50 条的内置词典），日语模式 G2P 不再为绝大多数常用汉字回退到 `pau`。

ORT 高级设置：设置界面新增"ORT 高级设置"区域，暴露 ONNX Runtime session 选项（enableMemPattern、enableCpuMemArena、graphOptimizationLevel、executionMode、intra/interOpNumThreads、logSeverityLevel）。默认值遵循项目经验：DML 路径下 enableMemPattern 默认关闭（防止 DirectML 过度预分配 GPU 内存池）；CPU/WASM 路径默认开启。高级选项（如强制在 DML 启用 memPattern、verbose 日志）默认折叠并标记为"高风险"。

- [官网](https://henley04.github.io/SXSEditor/)
- [用户文档](https://henley04.github.io/SXSEditor/user/quick-start.html)
- [开发者文档](https://henley04.github.io/SXSEditor/dev/build.html)
- [应用更新](https://henley04.github.io/SXSEditor/user/app-updates.html)
- [模型更新](https://henley04.github.io/SXSEditor/user/model-updates.html)
- [帮助与常见问题](https://henley04.github.io/SXSEditor/user/faq.html)
- [卸载](https://henley04.github.io/SXSEditor/user/uninstall.html)

### 许可证

[MIT](LICENSE)

---

<a id="日本語"></a>

## 日本語

SXSEditor は歌声合成のためのオープンソースデスクトップアプリケーションです。SoulX-Singer ニューラルモデルを ONNX Runtime 上で動作させ、DirectML GPU、WebNN NPU/GPU、CPU をサポートします。

対応言語：**中国語（普通話）**、**英語**、**日本語**。

スマートモデルダウンロード：リモート ModelScope リポジトリの重みが分割保存（onnx + data）か単体 onnx かを自動検出し、data が存在する場合は一緒にダウンロードします。リモートファイルリストは再帰的に取得され、サブディレクトリ（`preprocess/`、`basic_pitch_model/`）内の必須ファイルも確実にダウンロード対象に含めます。

MIDI インポート：`@tonejs/midi` による標準 MIDI ファイル解析（フォーマット 0/1/2、SMPTE タイムディビジョン、マルチトラック対応）。ドラムトラック（channel 10）は自動フィルタリングされます。メインウィンドウの「MIDIインポート」ボタンはマルチトラックファイルに対応——ドラム以外の各トラックが独立した歌手トラックとして作成されます。フラグメントエディタとオーディオ前処理ウィンドウのインポートはドラム以外の全トラックを単一タイムラインにマージします。

フラグメントエディタのドラッグ可能再生ヘッド：再生ヘッド（または上部タイムライン）をクリックまたはドラッグしてカスタム再生開始位置を設定できます。再生は先頭からではなくそのオフセットから開始します。再生中のドラッグは再合成なしで新しい位置にシークします。クライアント側の署名キャッシュは、ノートと推論オプションが変更されていない場合に以前に合成されたオーディオを再利用するため、異なる開始位置でも瞬時に再生できます。

日本語漢字辞書の拡充：日本の常用漢字 2136 字（日本の公式常用漢字リスト）すべてと、その他の高頻度漢字 465 字を合わせた計 2601 エントリを収録。辞書は `scripts/generate_jp_kanji_dict.py` により KANJIDIC2（EDRDG）から自動生成され、よく使われる漢字については手動校正のエントリをマージしています。実行時に `jpKanjiDict.json` から読み込まれます（JSON が利用できない場合は約 50 エントリの内蔵辞書にフォールバック）。これにより、日本語モードの G2P は绝大多数の常用漢字について `pau` にフォールバックしなくなりました。

- [ウェブサイト](https://henley04.github.io/SXSEditor/)
- [ユーザードキュメント](https://henley04.github.io/SXSEditor/user/quick-start.html)
- [開発者ドキュメント](https://henley04.github.io/SXSEditor/dev/build.html)
- [アプリケーション更新](https://henley04.github.io/SXSEditor/user/app-updates.html)
- [モデル更新](https://henley04.github.io/SXSEditor/user/model-updates.html)
- [ヘルプ & FAQ](https://henley04.github.io/SXSEditor/user/faq.html)
- [アンインストール](https://henley04.github.io/SXSEditor/user/uninstall.html)

### ライセンス

[MIT](LICENSE)

<div align="center">

**SXSEditor**

[GitHub](https://github.com/Henley04/SXSEditor) · [Issues](https://github.com/Henley04/SXSEditor/issues)

</div>
