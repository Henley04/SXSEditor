<div align="center">

  <img src="docs/images/icon.png" alt="SXSEditor" width="80" height="80" style="border-radius:16px"/>

  # SXSEditor

  AI Singing Voice Synthesis Workstation

  [![Version](https://img.shields.io/badge/version-3.0.0-blue?style=flat-square)](https://github.com/Henley04/SXSEditor/releases)
  [![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
  [![Platform](https://img.shields.io/badge/platform-Windows%20(primary)%20%C2%B7%20macOS%2FLinux%20(source%20build%2C%20CPU%2Donly%2C%20unverified)-lightgrey?style=flat-square)]()
  [![SVS Languages](https://img.shields.io/badge/SVS-EN%20|%20ZH%20|%20JP-orange?style=flat-square)]()

  **[Website](https://henley04.github.io/SXSEditor/) · [User Docs](https://henley04.github.io/SXSEditor/user/quick-start.html) · [Developer Docs](https://henley04.github.io/SXSEditor/dev/build.html) · [Reddit](https://www.reddit.com/r/SXSEditor/s/7WK9Nnf7fw)**

  **[English](#english) · [中文](#中文) · [日本語](#日本語)**

</div>

---

<a id="english"></a>

## English

SXSEditor is an open-source desktop application for singing voice synthesis. It uses the SoulX-Singer neural model running on ONNX Runtime with DirectML GPU and CPU support. The native backend selector offers **Auto / Windows ML / DirectML / CPU (all models)**. Auto prioritizes Windows ML on Windows 11 24H2+ — NVIDIA RTX → TensorRT-RTX, Intel/AMD → OpenVINO/MIGraphX, Snapdragon NPU → QNN — and falls back to DirectML. The older WebNN path belongs to the deprecated `ortweb` inference system.

Supported singing languages: **English**, **Chinese (Mandarin)**, and **Japanese**.

**Platform support**: Windows is the primary platform (installer + DirectML/WebNN acceleration). macOS/Linux are **source-build only** — CPU inference, no DirectML/Windows ML, and **not covered by CI or released binaries**. See the [Developer Docs](https://henley04.github.io/SXSEditor/dev/build.html).

**Windows runtime requirement**: ONNX Runtime and the native inference bridge are MSVC-built and depend on the **Microsoft Visual C++ Redistributable 2015-2022 (x64)** (`vcruntime140.dll`, `vcruntime140_1.dll`, `msvcp140.dll`). The installer installs it automatically; on a stripped-down/older system where native modules fail with "binding not found", install it manually from [aka.ms/vc14/vc_redist.x64.exe](https://aka.ms/vc14/vc_redist.x64.exe) and restart. Help → Environment Check shows the detected VC++ runtime status.

- [Website](https://henley04.github.io/SXSEditor/)
- [User Docs](https://henley04.github.io/SXSEditor/user/quick-start.html)
- [Developer Docs](https://henley04.github.io/SXSEditor/dev/build.html)
- [Application Updates](https://henley04.github.io/SXSEditor/user/app-updates.html)
- [Model Updates](https://henley04.github.io/SXSEditor/user/model-updates.html)
- [Help & FAQ](https://henley04.github.io/SXSEditor/user/faq.html)
- [Uninstall](https://henley04.github.io/SXSEditor/user/uninstall.html)
- [API Standard (remote inference / third-party services)](https://henley04.github.io/SXSEditor/api-standard.html)
- [Reddit Community](https://www.reddit.com/r/SXSEditor/s/7WK9Nnf7fw) — questions, presets, and show-and-tell

**MCP / AI assistants**: the stdio MCP server ships with the packaged application (`<install>/resources/mcp/sxseditor-mcp.js`; in a source tree use `npm run mcp`). Open **Help → MCP Connection…** for a copyable setup prompt with configuration blocks for Claude Code, WorkBuddy, OpenCode and Codex, plus the companion skill. Start SXSEditor before connecting. See [MCP usage](https://henley04.github.io/SXSEditor/user/plugins.html) and the [MCP reference](https://henley04.github.io/SXSEditor/MCP.html).

### License

[MIT](LICENSE)

---

<a id="中文"></a>

## 中文

SXSEditor 是一个开源的桌面歌声合成应用。基于 SoulX-Singer 神经网络模型，通过 ONNX Runtime 运行，支持 DirectML GPU 与 CPU 推理。本机后端选择器提供 **自动 / Windows ML / DirectML / CPU（全部模型）**。自动模式在 Windows 11 24H2+ 上优先使用 Windows ML：NVIDIA RTX → TensorRT-RTX，Intel/AMD → OpenVINO/MIGraphX，高通 NPU → QNN；失败回退 DirectML。旧 WebNN 路径属于已弃用的 `ortweb` 推理系统。

支持的合成语言：**中文（普通话）**、**英语** 和 **日语**。

**平台支持**：Windows 是主要平台（提供安装包与 DirectML/WebNN 加速）。macOS/Linux **需从源码构建**，仅支持 CPU 推理，不含 DirectML/Windows ML 加速，且**无 CI 覆盖、无官方二进制**。详见[开发者文档](https://henley04.github.io/SXSEditor/dev/build.html)。

**Windows 运行库依赖**：ONNX Runtime 与原生推理桥接模块均由 MSVC 编译，依赖 **Microsoft Visual C++ Redistributable 2015-2022 (x64)**（`vcruntime140.dll`、`vcruntime140_1.dll`、`msvcp140.dll`）。安装包会自动安装；若在精简/老旧系统上遇到原生模块加载失败、提示 "binding 未找到"，请手动安装该运行库（[aka.ms/vc14/vc_redist.x64.exe](https://aka.ms/vc14/vc_redist.x64.exe)）后重启。「帮助 → 环境检测」会显示检测到的 VC++ 运行库状态。

- [官网](https://henley04.github.io/SXSEditor/)
- [用户文档](https://henley04.github.io/SXSEditor/user/quick-start.html)
- [开发者文档](https://henley04.github.io/SXSEditor/dev/build.html)
- [应用更新](https://henley04.github.io/SXSEditor/user/app-updates.html)
- [模型更新](https://henley04.github.io/SXSEditor/user/model-updates.html)
- [帮助与常见问题](https://henley04.github.io/SXSEditor/user/faq.html)
- [卸载](https://henley04.github.io/SXSEditor/user/uninstall.html)
- [API 标准（远程推理 / 第三方服务接入）](https://henley04.github.io/SXSEditor/api-standard.html)
- [Reddit 社区](https://www.reddit.com/r/SXSEditor/s/7WK9Nnf7fw)——提问、预设分享与作品交流

**MCP 与 AI 助手**：stdio MCP 服务器随安装包分发（`<安装目录>/resources/mcp/sxseditor-mcp.js`；源码树可用 `npm run mcp`）。打开**帮助 → MCP 连接…** 可复制一段安装说明，内含 Claude Code、WorkBuddy、OpenCode、Codex 四端各自的配置片段与配套 skill。连接前请先启动 SXSEditor。详见 [MCP 用法](https://henley04.github.io/SXSEditor/user/plugins.html) 与 [MCP 方法参考](https://henley04.github.io/SXSEditor/MCP.html)。

### 许可证

[MIT](LICENSE)

---

<a id="日本語"></a>

## 日本語

SXSEditor は歌声合成のためのオープンソースデスクトップアプリケーションです。SoulX-Singer ニューラルモデルを ONNX Runtime 上で動作させ、DirectML GPU と CPU をサポートします。ネイティブバックエンドは **自動 / Windows ML / DirectML / CPU（全モデル）** から選択できます。旧 WebNN 経路は非推奨の `ortweb` 推論システムに属します。

対応言語：**中国語（普通話）**、**英語**、**日本語**。

**対応プラットフォーム**：Windows がメイン環境です（インストーラーと DirectML/WebNN アクセラレーションを提供）。macOS/Linux は**ソースビルドのみ**で、CPU 推論に限られ、DirectML/Windows ML は利用できません。**CI による検証は未実施で、公式バイナリもありません。** 詳細は[開発者ドキュメント](https://henley04.github.io/SXSEditor/dev/build.html)。

- [ウェブサイト](https://henley04.github.io/SXSEditor/)
- [ユーザードキュメント](https://henley04.github.io/SXSEditor/user/quick-start.html)
- [開発者ドキュメント](https://henley04.github.io/SXSEditor/dev/build.html)
- [アプリケーション更新](https://henley04.github.io/SXSEditor/user/app-updates.html)
- [モデル更新](https://henley04.github.io/SXSEditor/user/model-updates.html)
- [ヘルプ & FAQ](https://henley04.github.io/SXSEditor/user/faq.html)
- [アンインストール](https://henley04.github.io/SXSEditor/user/uninstall.html)
- [API 標準（リモート推論 / サードパーティ連携）](https://henley04.github.io/SXSEditor/api-standard.html)
- [Reddit コミュニティ](https://www.reddit.com/r/SXSEditor/s/7WK9Nnf7fw)——質問・プリセット共有・作品紹介

### ライセンス

[MIT](LICENSE)

<div align="center">

**SXSEditor**

[GitHub](https://github.com/Henley04/SXSEditor) · [Issues](https://github.com/Henley04/SXSEditor/issues)

</div>
