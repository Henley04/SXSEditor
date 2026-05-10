# Developer Guide

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Build from Source](#build-from-source)
3. [Project Structure](#project-structure)
4. [Tech Stack](#tech-stack)
5. [ONNX Models](#onnx-models)
6. [Testing](#testing)
7. [Packaging & Distribution](#packaging--distribution)
8. [Contributing](#contributing)

---

## Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- **Windows** (primary target; macOS/Linux supported via Electron Forge makers)
- **ONNX models**: Download the SoulX-Singer ONNX models into `onnx_models/`
- **Git**

---

## Build from Source

```bash
git clone https://github.com/Henley04/SXSEditor.git
cd SXSEditor
npm install
```

If you encounter native module build issues:

```bash
npx electron-rebuild
```

### Run in Development Mode

```bash
npm start
```

This starts the application with hot reload via webpack.

---

## Project Structure

```
SXSEditor/
├── assets/                  # Application icons and images
├── docs/                    # Documentation & official website
│   ├── index.html           # Official website (GitHub Pages)
│   ├── css/                 # Website styles
│   ├── js/                  # Website scripts
│   └── wiki/                # Wiki content
├── example/                 # Example prompt/target data
├── onnx_models/             # ONNX model files
│   ├── svc/                 # SVC-specific models
│   └── README.md
├── src/
│   ├── audio/               # WAV encoder and audio utilities
│   ├── editor/              # Track manager, piano roll, envelope editor
│   ├── inference/           # ONNX inference pipelines
│   │   ├── nativeSvsPipeline.js    # Main SVS pipeline
│   │   ├── rmvpePitchDetector.js   # RMVPE-based F0 detection
│   │   ├── basicPitch.js           # Basic Pitch F0 detection
│   │   ├── midiParser.js           # MIDI parsing utilities
│   │   └── en_g2p_dict.json        # English grapheme-to-phoneme dictionary
│   ├── main.js              # Electron main process
│   ├── preload.js           # Preload script for secure IPC
│   ├── renderer.js          # Main renderer process (UI logic)
│   ├── index.html / .css    # Main window
│   ├── fragmentEditor.*     # Fragment editor window
│   ├── singerCreator.*      # Singer creation window
│   ├── audioPreprocess.*    # Audio preprocessing window
│   └── settings.*           # Settings window
├── test/                    # Automated test suite (160+ tests)
├── forge.config.js          # Electron Forge configuration
├── webpack.*.config.js      # Webpack configurations
└── package.json
```

---

## Tech Stack

| Category | Technology |
|----------|-----------|
| Frontend | Vanilla JavaScript, HTML5 Canvas, Wavesurfer.js |
| Desktop Framework | Electron + Electron Forge |
| Build Tool | Webpack (@electron-forge/plugin-webpack) |
| Inference Engine | ONNX Runtime Node (`onnxruntime-node`) |
| Neural Models | SoulX-Singer (Diffusion-based SVS) |
| Pitch Detection | RMVPE ONNX, Basic Pitch (TensorFlow.js) |
| Testing | Mocha + Chai + Sinon + NYC |

---

## ONNX Models

### Required SVS Models (`onnx_models/`)

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

### SVC Models (`onnx_models/svc/`)

Additional models for Singing Voice Conversion tasks.

### Audio Configuration

| Parameter | Value |
|-----------|-------|
| Sample Rate | 24000 Hz |
| Hop Size | 480 (20 ms) |
| FFT Size | 1920 |
| Window Size | 1920 |
| Mel Bins | 128 |
| F0 Range | C1 ~ B6 (32.7 Hz ~ 1975.5 Hz) |

---

## Testing

```bash
npm test                 # Run full test suite
npm run test:coverage    # With code coverage report
npm run test:watch       # Watch mode
```

The test suite includes **160+ test cases** covering:

- WAV encoding/decoding
- Track management
- SVS pipeline logic
- Pitch detection (RMVPE)
- MIDI parsing
- Integration tests

---

## Packaging & Distribution

```bash
npm run package     # Package for current platform
npm run make        # Create distributables (.exe, .zip, .deb)
```

The packaging uses Electron Forge with makers configured for:
- Windows: Squirrel installer (.exe)
- macOS: DMG (.dmg)
- Linux: DEB (.deb) and RPM (.rpm)

---

## Contributing

Contributions are welcome! Here's how to get started:

1. **Fork** the repository
2. **Create a feature branch** (`git checkout -b feature/amazing-feature`)
3. **Make your changes**
4. **Run tests** to ensure nothing is broken (`npm test`)
5. **Commit** with a descriptive message referencing the issue number
6. **Push** to your fork
7. **Open a Pull Request**

For major changes, open an [issue](https://github.com/Henley04/SXSEditor/issues) first to discuss what you would like to change.

### Code Style

- JavaScript: Vanilla JS with modern ES features
- Follow existing patterns and conventions in the codebase
- Maintain test coverage for new functionality