<div align="center">

  <img src="docs/images/icon.png" alt="SXSEditor" width="80" height="80" style="border-radius:16px"/>

  # SXSEditor

  AI Singing Voice Synthesis Workstation

  [![Version](https://img.shields.io/badge/version-2.0.2-blue?style=flat-square)](https://github.com/Henley04/SXSEditor/releases)
  [![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
  [![Platform](https://img.shields.io/badge/platform-Windows%20(primary)%20%C2%B7%20macOS%2FLinux%20(source%20build%2C%20CPU%2Donly%2C%20unverified)-lightgrey?style=flat-square)]()
  [![SVS Languages](https://img.shields.io/badge/SVS-EN%20|%20ZH%20|%20JP-orange?style=flat-square)]()

  **[Website](https://henley04.github.io/SXSEditor/) · [User Docs](https://henley04.github.io/SXSEditor/user/quick-start.html) · [Developer Docs](https://henley04.github.io/SXSEditor/dev/build.html)**

  **[English](#english) · [中文](#中文) · [日本語](#日本語)**

</div>

---

<a id="english"></a>

## English

SXSEditor is an open-source desktop application for singing voice synthesis. It uses the SoulX-Singer neural model running on ONNX Runtime with DirectML GPU, WebNN NPU/GPU, and CPU support. On Windows 11 24H2+, an experimental **Windows ML acceleration** option (Settings → ORT advanced) can additionally accelerate the main models (diff_step / vocoder / preflow) via plugin execution providers — NVIDIA RTX → TensorRT-RTX, Intel/AMD → OpenVINO/MIGraphX, Snapdragon NPU → QNN — with automatic fallback to DirectML/CPU.

Supported singing languages: **English**, **Chinese (Mandarin)**, and **Japanese**.

**Platform support**: Windows is the primary platform (installer + DirectML/WebNN acceleration). macOS/Linux are **source-build only** — CPU inference, no DirectML/Windows ML, and **not covered by CI or released binaries**. See the [Developer Docs](https://henley04.github.io/SXSEditor/dev/build.html).

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

SXSEditor 是一个开源的桌面歌声合成应用。基于 SoulX-Singer 神经网络模型，通过 ONNX Runtime 运行，支持 DirectML GPU、WebNN NPU/GPU 和 CPU 推理。在 Windows 11 24H2+ 上，可在设置中开启实验性的 **Windows ML 加速**，通过插件执行提供者加速主模型（diff_step / vocoder / preflow）：NVIDIA RTX → TensorRT-RTX，Intel/AMD → OpenVINO/MIGraphX，高通 NPU → QNN；失败自动回落 DirectML/CPU。

支持的合成语言：**中文（普通话）**、**英语** 和 **日语**。

**平台支持**：Windows 是主要平台（提供安装包与 DirectML/WebNN 加速）。macOS/Linux **需从源码构建**，仅支持 CPU 推理，不含 DirectML/Windows ML 加速，且**无 CI 覆盖、无官方二进制**。详见[开发者文档](https://henley04.github.io/SXSEditor/dev/build.html)。

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

**対応プラットフォーム**：Windows がメイン環境です（インストーラーと DirectML/WebNN アクセラレーションを提供）。macOS/Linux は**ソースビルドのみ**で、CPU 推論に限られ、DirectML/Windows ML は利用できません。**CI による検証は未実施で、公式バイナリもありません。** 詳細は[開発者ドキュメント](https://henley04.github.io/SXSEditor/dev/build.html)。

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
