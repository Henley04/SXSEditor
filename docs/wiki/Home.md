# SXSEditor Wiki

> **SXSEditor** — AI-Powered Singing Voice Synthesis Workstation

## What is SXSEditor?

SXSEditor is an open-source desktop application that synthesizes singing voice from MIDI notes and lyrics. It combines a visual piano-roll editor with the **SoulX-Singer** neural acoustic model, running through ONNX Runtime with GPU (DirectML), NPU (WebNN), and CPU acceleration.

You write notes on a piano roll, type lyrics, and SXSEditor generates a singing voice audio file.

### Supported Languages

| Language | Status | Lyric Input |
|----------|--------|-------------|
| Chinese (Mandarin) | Supported | Chinese characters or Pinyin |
| English | Supported | English words (auto-converted to phonemes) |
| Japanese | In Development | — |

---

## Quick Navigation

| Page | Description |
|------|-------------|
| **[Quick Start Guide](Quick-Start)** | Step-by-step walkthrough from first launch to your first synthesized song |
| **[User Guide](User-Guide)** | Complete documentation of all features |
| **[FAQ](FAQ)** | Frequently asked questions and troubleshooting |
| **[Developer Guide](Developer-Guide)** | Build from source, architecture, testing, contributing |

---

## System Requirements

| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| OS | Windows 10 64-bit | Windows 11 |
| RAM | 8 GB | 16 GB |
| GPU | None (CPU fallback) | Discrete GPU with 4GB+ VRAM (NVIDIA/AMD/Intel) |
| Storage | 2 GB app + 2 GB models | SSD with 10+ GB free |
| CPU | Any modern multi-core | Recent Intel/AMD with 6+ cores |

---

## Download

**Windows installer** (models downloaded automatically on first launch):

- [GitHub Release (latest installer)](https://github.com/Henley04/SXSEditor/releases/latest/download/sxsinstaller_x64_no_models.exe)
- [GitCode Mirror (China, latest installer)](https://gitcode.com/qq_50331623/SXSEditor/releases/latest/download/sxsinstaller_x64_no_models.exe)

macOS and Linux: build from source — see the [Developer Guide](Developer-Guide).

---

## Getting Started

New to SXSEditor? Follow the **[Quick Start Guide](Quick-Start)** for a step-by-step walkthrough covering:
1. Installing and launching
2. Downloading models (first launch)
3. Creating a singer with reference audio
4. Audio preprocessing (F0 extraction, MIDI notes, lyrics)
5. Adding and editing fragments
6. Synthesizing and listening
7. Exporting to WAV

---

## Resources

- [GitHub Repository](https://github.com/Henley04/SXSEditor)
- [Issue Tracker](https://github.com/Henley04/SXSEditor/issues)
- [Official Website](https://henley04.github.io/SXSEditor)
