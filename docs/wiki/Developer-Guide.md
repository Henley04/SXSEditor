# Developer Guide

Build from source, understand the architecture, run tests, and contribute.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Build from Source](#build-from-source)
3. [Project Structure](#project-structure)
4. [Architecture](#architecture)
5. [Tech Stack](#tech-stack)
6. [ONNX Models](#onnx-models)
7. [Testing](#testing)
8. [Packaging & Distribution](#packaging--distribution)
9. [Adding a New Theme](#adding-a-new-theme)
10. [Contributing](#contributing)

---

## Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- **Windows** (primary target; macOS/Linux supported via Electron Forge makers)
- **Git**
- ONNX models are downloaded automatically on first launch, or can be placed manually in `onnx_models/`

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

### Run Tests

```bash
npm test                 # Full test suite
npm run test:coverage    # With NYC coverage report
npm run test:watch       # Watch mode
```

### Run a Single Test File

```bash
npx mocha --require ./test/setup.js "test/trackManager.test.js" --timeout 30000
```

---

## Project Structure

```
SXSEditor/
├── assets/                    # Application icons and images
├── docs/                      # Documentation & official website
│   ├── index.html             # Official website (GitHub Pages)
│   ├── wiki/                  # Wiki content
│   └── images/                # Screenshots
├── onnx_models/               # ONNX model files (git-ignored)
│   ├── preprocess/            # RMVPE & ROSVOT models
│   └── basic_pitch_model/     # Basic Pitch model (TF.js)
├── src/
│   ├── main.js                # Electron main process entry point
│   ├── preload.js             # Preload script (contextBridge API)
│   ├── main/                  # Main process modules
│   │   ├── windowManager.js   # Window creation and management
│   │   ├── modelDownload.js   # Model download logic
│   │   ├── settingsIpc.js     # Settings IPC handlers
│   │   ├── svsIpc.js          # SVS pipeline IPC
│   │   ├── pitchMidiIpc.js    # Pitch/MIDI extraction IPC
│   │   ├── singerIpc.js       # Singer file operations
│   │   ├── audioIpc.js        # Audio output IPC
│   │   ├── dialogIpc.js       # File dialog IPC
│   │   ├── resourceManagerIpc.js
│   │   ├── webnnIpc.js        # WebNN/NPU IPC
│   │   ├── themeIpc.js        # Theme IPC
│   │   ├── security.js        # Path security validation
│   │   ├── settings.js        # Settings persistence
│   │   ├── gpuInfo.js         # GPU detection
│   │   ├── modelDir.js        # Model directory resolution
│   │   └── locale.js          # Main process i18n
│   ├── renderer/              # Main window renderer
│   │   ├── index.js           # Entry point
│   │   ├── state.js           # State management (TrackManager, History)
│   │   ├── eventHandlers.js   # UI event handlers
│   │   ├── ipcHandlers.js     # IPC message handlers
│   │   ├── uiControls.js      # UI utility functions
│   │   ├── timelineRenderer.js # Fragment timeline canvas rendering
│   │   ├── audioPlayback.js   # Main window audio playback
│   │   ├── projectManager.js  # Project save/load
│   │   ├── trackOperations.js # Track/singer operations
│   │   ├── fragmentOperations.js # Fragment operations
│   │   └── f0Utils.js         # F0 data conversion utilities
│   ├── fragmentEditor/        # Fragment editor renderer
│   │   ├── index.js           # Entry point
│   │   ├── state.js           # Editor state management
│   │   ├── canvasRenderer.js  # Piano roll canvas rendering
│   │   ├── eventHandlers.js   # Mouse/keyboard handlers
│   │   ├── ipcHandlers.js     # IPC message handlers
│   │   ├── uiControls.js      # UI setup and controls
│   │   ├── audioPlayback.js   # Fragment playback
│   │   ├── pipeline.js        # SVS pipeline initialization
│   │   ├── projectIO.js       # Fragment save/load
│   │   ├── playback.js        # Playback control
│   │   └── constants.js       # Editor constants
│   ├── editor/                # Shared editor modules
│   │   ├── trackManager.js    # Multi-track timeline management
│   │   ├── pianoRoll.js       # Piano roll rendering engine
│   │   ├── envelopeEditor.js  # Envelope curve editor
│   │   └── historyManager.js  # Undo/redo (200 steps)
│   ├── inference/             # Neural inference pipelines
│   │   ├── pipeline/          # Main SVS pipeline
│   │   │   ├── index.js       # OnnxSVSPipeline class
│   │   │   ├── preprocessing.js
│   │   │   ├── textProcessing.js
│   │   │   ├── diffusion.js
│   │   │   ├── postprocessing.js
│   │   │   ├── audioSegmentation.js
│   │   │   ├── modelLoader.js
│   │   │   ├── constants.js
│   │   │   ├── float16Patch.js
│   │   │   └── utils.js
│   │   ├── webnn/             # WebNN NPU pipeline
│   │   ├── rmvpePitchDetector.js  # RMVPE F0 extraction
│   │   ├── basicPitch.js      # Basic Pitch MIDI extraction
│   │   ├── rosvotDetector.js  # RosVot voice onset detection
│   │   ├── midiParser.js      # Standard MIDI file parsing
│   │   ├── phone_set.json     # Phoneme vocabulary (2820 entries)
│   │   └── en_g2p_dict.json   # English G2P dictionary (126k words)
│   ├── audio/                 # Audio subsystem
│   │   ├── audioOutputManager.js  # WASAPI output via decibri
│   │   ├── wavEncoder.js      # WAV file encoding
│   │   └── audioWorker.js     # Audio processing worker
│   ├── themes/                # Theme system
│   │   ├── builtins/          # Built-in theme JSON files
│   │   ├── themeBootstrap.js  # Early theme injection (before paint)
│   │   ├── themeInit.js       # Theme initialization
│   │   ├── themeStorage.js    # Theme persistence
│   │   ├── tokenCatalog.js    # Full token catalog
│   │   └── canvasTheme.js     # Canvas-specific theme tokens
│   ├── i18n/                  # Internationalization
│   │   ├── index.js           # i18n system
│   │   ├── zh-CN.js           # Chinese translations
│   │   └── en.js              # English translations
│   ├── utils/                 # Shared utilities
│   ├── common.css             # Shared CSS
│   ├── index.html / .css      # Main window
│   ├── fragmentEditor.html / .css  # Fragment editor
│   ├── singerCreator.html / .css / .js
│   ├── audioPreprocess.html / .css / .js
│   ├── settings.html / .css / .js
│   ├── modelDownload.html / .css / .js
│   ├── resourceManager.html / .css / .js
│   ├── modelManager.js        # Model download/verification
│   ├── modelRegistry.js       # Model group definitions
│   ├── singerCreator.js       # Singer creator renderer
│   ├── audioPreprocess.js     # Audio preprocess renderer
│   ├── settings.js            # Settings renderer
│   ├── modelDownload.js       # Model download renderer
│   └── alertDialog.js         # Custom alert dialog
├── test/                      # Test suite (470+ tests)
│   ├── setup.js               # JSDOM setup, mocks, sandbox cleanup
│   └── *.test.js              # Test files
├── forge.config.js            # Electron Forge config
├── webpack.*.config.js        # Webpack configs
└── package.json
```

---

## Architecture

### Process Model

SXSEditor uses Electron with `contextIsolation: true` and `sandbox: true`. All IPC goes through `preload.js` which exposes `window.electronAPI` to renderer processes.

**Windows** (each has its own entry point registered in `forge.config.js`):
- **Main window** (`renderer.js`) — Multi-track timeline, project management
- **Fragment editor** (`fragmentEditor.js`) — Piano-roll editor for individual fragments
- **Singer creator** (`singerCreator.js`) — Create custom singers from reference audio
- **Audio preprocess** (`audioPreprocess.js`) — F0 extraction and MIDI extraction from audio
- **Settings** (`settings.js`) — Device selection, inference parameters, audio config
- **Model download** (`modelDownload.js`) — Download missing ONNX models from ModelScope
- **Resource manager** (`resourceManager.js`) — GPU/VRAM monitoring, model load/unload

### IPC Pattern

All IPC uses `ipcMain.handle` / `ipcRenderer.invoke` (request-response) or `ipcMain.on` / `ipcRenderer.send` (fire-and-forget). The preload script exposes a clean `window.electronAPI` object.

Binary audio data uses `Float32Array` transfer for low latency.

### Security

- `contextIsolation: true` and `sandbox: true` on all windows
- Path validation in the main process restricts file access to allowed directories (userData, documents, desktop, home, temp) plus dialog-authorized paths
- No `nodeIntegration` in renderer processes

### SVS Pipeline

`src/inference/pipeline/index.js` contains the `OnnxSVSPipeline` class. It loads 9 ONNX models and runs diffusion-based synthesis:

1. **Text Processing**: Lyrics → phoneme sequences (with language-specific G2P)
2. **Encoding**: 5 encoder models produce embeddings (text, pitch, note type, F0, condition)
3. **Diffusion**: Iterative denoising to produce mel spectrogram
4. **Vocoding**: Mel spectrogram → audio waveform
5. **Audio Segmentation**: Long audio is split into segments for processing

Key constants: `SAMPLE_RATE=24000`, `HOP_SIZE=480`, `EMBED_DIM=512`, `COND_DIM=1024`.

### Phoneme Duration Statistics (Data-Driven)

`build_en_phoneme_duration_stats.py` (project root) generates a data-driven ARPAbet phoneme duration table from MFA-aligned LJSpeech, replacing the previous vowel-priority heuristic in `preprocessing.js`.

**Pipeline**: MFA TextGrid (phoneme-level alignment) + librispeech-lexicon.txt (CMU dict with stress 0/1/2) + LJSpeech metadata.csv → JSON statistics with unigram / bigram / trigram / by_stress / by_position / trigram_full buckets.

**Data sources** (run script without args to see download URLs):
- LJSpeech TextGrid alignment: `preprocessed_data/LJSpeech/TextGrid/` (from ming024/FastSpeech2)
- LJSpeech metadata: `raw_data/LJSpeech/metadata.csv`
- Lexicon: `lexicon/librispeech-lexicon.txt`
- Optional: `pip install praatio` for more robust TextGrid parsing (falls back to built-in regex)

**Output**: `src/inference/en_phoneme_durations.json`

**Usage**:
```bash
python build_en_phoneme_duration_stats.py
python build_en_phoneme_duration_stats.py --min-samples 10  # filter low-frequency keys
```

**Application policy** (planned, not yet integrated in `preprocessing.js`):
1. User `phonemeAdjustments` (manual) wins always
2. Default: trigram_full lookup → fall back to trigram → bigram → unigram
3. Extremely short notes (`innerFrames < phonemeCount`): keep vowel-priority to prevent phoneme swallowing

### Float16 Patch

`float16Patch.js` patches onnxruntime-common's type mapping to use `Uint16Array` for float16 tensors (Node.js v24+ compatibility).

---

## Tech Stack

| Category | Technology |
|----------|-----------|
| Frontend | Vanilla JavaScript, HTML5 Canvas |
| Desktop Framework | Electron + Electron Forge |
| Build Tool | Webpack (@electron-forge/plugin-webpack) |
| Inference Engine | ONNX Runtime Node (GPU/CPU via DirectML) + ONNX Runtime Web (NPU via WebNN) |
| Neural Models | SoulX-Singer (Diffusion-based SVS) |
| Pitch Detection | RMVPE ONNX, Basic Pitch (TensorFlow.js) |
| Audio Output | decibri (WASAPI shared) |
| Chinese Lyrics | pinyin-pro (character → pinyin conversion) |
| Testing | Mocha + Chai + Sinon + JSDOM + NYC |
| GPU Detection | systeminformation |

---

## ONNX Models

### Model Precision Variants

Models are stored in precision-specific subdirectories under `onnx_models/`:
- `onnx_models/fp16/` — Half precision
- `onnx_models/fp32/` — Full precision
- `onnx_models/fp8/` — 8-bit float
- `onnx_models/int8/` — INT8 quantized
- `onnx_models/int8/optimized_npu/` — INT8 NPU-optimized dynamic dimensions

### Required SVS Models

| Model | Purpose |
|-------|---------|
| `note_text_encoder.onnx` + `.data` | Phoneme text embedding |
| `note_pitch_encoder.onnx` + `.data` | Note pitch embedding |
| `note_type_encoder.onnx` + `.data` | Note type embedding (rest/vocal/slur) |
| `f0_encoder.onnx` + `.data` | Quantized F0 embedding |
| `preflow.onnx` + `.data` | ConvNeXtV2 pre-processing |
| `cond_emb.onnx` + `.data` | Condition embedding projection |
| `diff_step_dml.onnx` | Single diffusion step (DirectML optimized) |
| `vocoder_dml.onnx` | Vocos vocoder (DirectML optimized) |
| `mel_transform.onnx` + `.data` | Mel-spectrogram extraction |

### Optional Models

| Model | Purpose |
|-------|---------|
| `preprocess/rmvpe_model.onnx` | RMVPE pitch detection |
| `basic_pitch_model/model.json` + `.bin` | Basic Pitch MIDI extraction (TensorFlow.js) |
| `preprocess/rosvot_model.onnx` | RosVot voice onset detection (currently disabled) |

### Japanese Models

Located in `onnx_models/ja/<precision>/`:
- `note_text_encoder.onnx` — Extended Japanese phoneme encoder (3033 phonemes)
- `preflow.onnx` — Japanese fine-tuned preflow

---

## Testing

```bash
npm test                 # Run all tests
npm run test:coverage    # With NYC coverage
npm run test:watch       # Watch mode
```

The test suite includes **470+ test cases** covering:
- WAV encoding/decoding
- Track management (add, remove, move, resize fragments)
- SVS pipeline logic (text processing, phoneme merging, note type detection)
- Pitch detection (RMVPE)
- MIDI parsing
- Model path consistency
- Theme system (token validation, theme loading)
- Integration tests

Tests use JSDOM for DOM simulation. `test/setup.js` configures JSDOM, mocks `HTMLCanvasElement.getContext`, and provides automatic sinon sandbox cleanup.

---

## Packaging & Distribution

```bash
npm run package         # Package for current platform
npm run package:lite    # Package without ONNX models (for testing)
npm run make            # Create distributables (.exe, .zip, .deb)
```

The packaging uses Electron Forge with makers configured for:
- **Windows**: Squirrel installer (.exe)
- **macOS**: DMG (.dmg)
- **Linux**: DEB (.deb) and RPM (.rpm)

---

## Adding a New Theme

SXSEditor's UI is fully driven by a three-layer **Design Token** system (`global → alias → component`) and a JSON-based **Theme Pack** format.

### Theme Pack JSON Format

```json
{
  "id":          "my-cool-theme",
  "name":        "My Cool Theme",
  "version":     "1.0.0",
  "author":      "Your Name",
  "isDark":      true,
  "description": "A cool dark theme",
  "tags":        ["dark", "blue"],
  "extends":     "dark-aurora",
  "tokens": {
    "--color-blue-500": "#5b8def",
    "--bg-app":         "#14141f",
    "--button-primary-bg": "var(--color-blue-500)"
  }
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `id` | Yes | kebab-case, unique, no leading/trailing hyphens |
| `name` | Yes | Display name in the dropdown |
| `version` | Yes | semver |
| `isDark` | Yes | Used for icon/auto dark-mode hints |
| `tokens` | Yes | Token name → CSS value |
| `extends` | No | Parent theme id (inheritance depth capped at 3) |

### Testing a Custom Theme

1. Place the file in `<userData>/themes/<theme-id>.theme.json`:
   - Windows: `%APPDATA%\sxseditor\themes\`
2. Restart the app — the theme appears under **User** in Settings.
3. Select it to apply.

### Registering a Built-in Theme

1. Create the JSON file under `src/themes/builtins/<id>.theme.json`.
2. Register it in `src/themes/builtins/index.js`:
   ```js
   import myTheme from './my-theme.theme.json';
   export const BUILTIN_THEMES = [darkAurora, lightPaper, midnightAmber, acg, myTheme];
   ```
3. Run `npm test` — the new theme is automatically tested.
4. Run `npm run package:lite` to verify it's included.

---

## Contributing

1. **Fork** the repository
2. **Create a feature branch** (`git checkout -b feature/amazing-feature`)
3. **Make your changes**
4. **Run tests** (`npm test`)
5. **Commit** with a descriptive message referencing the issue number
6. **Push** to your fork
7. **Open a Pull Request**

For major changes, open an [issue](https://github.com/Henley04/SXSEditor/issues) first.

### Code Style

- Vanilla JavaScript with modern ES features
- Follow existing patterns in the codebase
- Maintain test coverage for new functionality
- Commit messages must be in English
