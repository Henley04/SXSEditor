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
│   │   │   ├── samplers/      # Pluggable diffusion ODE solvers
│   │   │   │   ├── index.js   # Registry + factory (resolveSamplerName, createSampler)
│   │   │   │   ├── euler.js   # Euler (1st-order, default baseline)
│   │   │   │   ├── heun.js    # Heun (2nd-order trapezoidal)
│   │   │   │   ├── extrap.js  # Extrapolated Euler (STORK-inspired heuristic)
│   │   │   │   └── stork2.js  # STORK-2 (paper-faithful, RKC 2nd-order)
│   │   │   └── utils.js
│   │   ├── webnn/             # WebNN NPU pipeline
│   │   ├── rmvpePitchDetector.js  # RMVPE F0 extraction
│   │   ├── fcpeDetector.js    # FCPE pitch detector (ONNX, default MIDI extraction)
│   │   ├── basicPitch.js      # Basic Pitch MIDI extraction
│   │   ├── rosvotDetector.js  # RosVot voice onset detection
│   │   ├── midiParser.js      # Standard MIDI file parsing
│   │   ├── phone_set.json     # Phoneme vocabulary (2820 entries)
│   │   └── en_g2p_dict.json   # English G2P dictionary (126k words)
│   ├── audio/                 # Audio subsystem
│   │   ├── audioOutputManager.js  # WASAPI output via decibri
│   │   ├── wavEncoder.js      # WAV file encoding (default 48kHz, selectable 24/44.1/48/96 kHz)
│   │   ├── lrcExport.js       # LRC lyrics file export module
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
│   ├── singerMarket.html / .css / .js
│   ├── audioPreprocess.html / .css / .js
│   ├── settings.html / .css / .js
│   ├── modelDownload.html / .css / .js
│   ├── resourceManager.html / .css / .js
│   ├── modelManager.js        # Model download/verification
│   ├── modelRegistry.js       # Model group definitions
│   ├── singerCreator.js       # Singer creator renderer
│   ├── singerMarket.js        # Singer market renderer
│   ├── audioPreprocess.js     # Audio preprocess renderer
│   ├── settings.js            # Settings renderer
│   ├── modelDownload.js       # Model download renderer
│   └── alertDialog.js         # Custom alert dialog
├── test/                      # Test suite (~1500 tests, 61 files)
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
- **Singer market** (`singerMarket.js`) — Browse, download, and share community-created singers
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
5. **Audio Segmentation**: Long audio is split into segments for processing. Silence detection uses a unified 1.5s threshold (previously a multi-tier 20s/8s/20s scheme).

Key constants: `SAMPLE_RATE=24000`, `HOP_SIZE=480`, `EMBED_DIM=512`, `COND_DIM=1024`.

### Diffusion Samplers

`src/inference/pipeline/samplers/` is a pluggable ODE-solver abstraction for the flow-matching diffusion loop. The model outputs a velocity field `flow_pred = v(x, t)`; sampling solves `dx/dt = v(x, t)` with `t` going 0 → 1 (equivalent to the paper's reverse integration). The solver only decides *when* to call `diffStep` and *how* to combine predictions into the `xt` delta — CFG / Rescale / tensor lifecycle stay with the caller, so both the ORT/DML path (`pipeline/diffusion.js`) and the WebNN/NPU path (`webnn/diffusion.js`) share one algorithm.

**Unified interface** — every solver implements:

```js
async step({ evalDiffStep, combine, step, totalSteps, xtData, buffers }) → { nfe }
//   evalDiffStep(t, xtOverride?) → Promise<{condPred, uncondPred}>
//   combine(condPred, uncondPred) → Float32Array  // writes buffers.vBuf, returns it
//   buffers: { vBuf, deltaBuf, v1Buf, xPredBuf }  // caller-allocated, reused across steps
//   delta is written into buffers.deltaBuf; the caller accumulates it onto xt.data
```

| Solver | File | NFE / step | Algorithm |
|--------|------|------------|-----------|
| `euler` (default) | `euler.js` | 1 | First-order explicit, midpoint time `t = (step + 0.5) / totalSteps`. Equivalent to the pre-refactor loop. |
| `heun` | `heun.js` | 2 | RK2 trapezoidal: predict `x_pred = x + v1·dt`, then correct `delta = 0.5·(v1 + v2)·dt`. Final step degrades to Euler to avoid `t > 1`. |
| `extrap` | `extrap.js` | 1 | Velocity-extrapolation heuristic inspired by STORK (ICLR 2026). `v2 = v1 + γ·(v1 − v_prev)` with γ=0.5; `delta = 0.5·dt·(v1 + v2)`. First step and unsafe extrapolation fall back to Euler. Stability guards: velocity-jump ratio > 2, `\|v2\|/\|v1\| > 3`, sign-flip with growing amplitude, NaN/Inf. |
| `stork2` | `stork2.js` | 1 | Paper-faithful STORK-2 (Tan et al., ICLR 2026, arXiv:2505.24210). Runge-Kutta-Gegenbauer 2nd-order recurrence with `s=8` sub-stages and Taylor-expansion virtual NFE. First step bootstraps as Euler. `b(j)` coefficients via closed-form RKG formula. Designed for stiff ODEs (stability region ~2s² = 128×). |

**Registry & factory** — `samplers/index.js` exports `SOLVERS` (id → `{label, labelKey, descKey, create()}`), `DEFAULT_SOLVER='euler'`, `resolveSamplerName()` (validates + normalizes), and `createSampler()`. `LEGACY_ALIASES = { stork: 'extrap' }` keeps old user settings working. The dropdown options in `src/renderer/exportDialog.js` and the settings UI must stay aligned with `SOLVERS`.

**Plumbing** — `runDiffusionLoop` / `runDiffusionLoopChunked` take a `samplerName` arg (default `'euler'`). The batch path (`runBatchDiffusionLoop`) keeps the `batch=4` optimization for Euler and falls back to sequential single-segment calls for non-Euler samplers. Both paths track `totalNFE` (number of function evaluations) in logs. `synthesize(notes, bpm, { sampler, ... })` threads the value through; settings keys are `previewSampler` / `exportSampler`.

> **Chunked inference caveat**: `extrap` and `stork2` keep cross-step velocity state (`_vPrev` / `_velPreds`). A fresh sampler instance is created per `runDiffusionLoop` call, so each vocoder chunk starts from Euler-equivalent behavior at its first step. For chunked previews this resets their advantage at every chunk boundary — prefer `euler` or `heun` there. `reset()` is provided for callers that reuse a sampler instance across runs.

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

**Application policy** (integrated in `preprocessing.js` via `durationStats.js`):
1. User `phonemeAdjustments` (manual) wins always
2. Default for English long notes: `trigram_full` lookup → fall back to `trigram` → `bigram` → `unigram`
3. Extremely short notes (`innerFrames < phonemeCount`): keep vowel-priority to prevent phoneme swallowing
4. Non-English or stats-table-not-loaded: linear interpolation (unchanged behavior)

**Integration files**:
- `src/inference/pipeline/durationStats.js` — lazy loader + lookup fallback chain
- `src/inference/pipeline/preprocessing.js` — `_allocateByStats()` replaces default linear allocation for English

**Lazy loading**: stats JSON (4.1MB) is loaded async in `Preprocessing` constructor, does not block startup. If load fails, silently falls back to linear allocation.

**Cross-note context**: prev/next phonemes span adjacent notes via `_getBoundaryPhone()`, giving trigram context across word boundaries.

### Float16 Patch

`float16Patch.js` patches onnxruntime-common's type mapping to use `Uint16Array` for float16 tensors (Node.js v24+ compatibility).

### FCPE Pitch Detector

`src/inference/fcpeDetector.js` is an ONNX-based pitch detector that has replaced Basic Pitch as the recommended MIDI extraction tool. It features a configurable post-processing pipeline for note onset/offset detection and pitch quantization.

The FCPE model is registered in `modelRegistry.js` alongside RMVPE and Basic Pitch. When selected in Settings > Audio > MIDI Extraction Tool, it is used by both the Audio Preprocessing window and the Audio to MIDI feature.

### QDIT int8 diff_step Model Support

The INT8 quantized `diff_step` model uses a new ONNX signature (QDIT int8 format) that differs from the legacy signature. The model loader (`pipeline/modelLoader.js`) auto-detects which signature the loaded model uses:

- **QDIT int8**: New signature with separate quantization/dequantization nodes. Used by newer INT8 model exports.
- **Legacy**: Original signature. Used by FP16/FP32 models and older INT8 exports.

Detection is based on input/output tensor names and graph structure. The diffusion loop (`pipeline/diffusion.js`) adapts its tensor feeding accordingly. No user configuration is required — the switch is automatic.

### Dynamic Thresholding

Per-frame percentile clipping (arXiv:2507.08965) applied during diffusion sampling. After each diffusion step, mel bins that exceed the configured percentile threshold (default 0.999, range 0.9–0.999) are clipped to the threshold value. This suppresses outlier activations that cause artifacts, without sacrificing overall spectral detail.

The thresholding is applied in `pipeline/diffusion.js` after the CFG combine step, before accumulating the delta onto `xt`. It can be toggled and configured independently for preview and export paths.

### CFG Schedule

The CFG (Classifier-Free Guidance) strength can now vary across diffusion steps instead of remaining constant. Four schedule modes are available:

| Mode | Behavior |
|------|----------|
| `constant` | CFG strength is the same for all steps (legacy behavior). |
| `linear` | CFG strength ramps linearly from an initial value to the target. |
| `cosine` | CFG strength follows a cosine schedule for smooth transitions. |
| `custom` | User-defined keyframe schedule. |

The schedule is evaluated per-step in `pipeline/diffusion.js` and adjusts the effective CFG strength passed to the combine function. Settings keys: `previewCfgSchedule` / `exportCfgSchedule`.

### WSOLA Crossfade & Audio Post-processing

Several audio post-processing improvements have been added to the synthesis output path:

- **WSOLA crossfade**: At vocoder chunk boundaries (where long audio is split for processing), WSOLA (Waveform Similarity Overlap-Add) replaces the previous Hann overlap-add method. This produces smoother transitions by matching waveform similarity at crossfade points, reducing audible clicks and discontinuities.
- **EBU R128 loudness normalization**: The final mix is normalized to −14 LUFS with a true-peak limiter at −1 dBTP, ensuring consistent loudness across projects and compliance with streaming platform standards.
- **2× oversampling anti-aliasing**: A full oversampling pipeline is applied during resampling from the model's native 24 kHz to the output sample rate (default 48 kHz). This reduces aliasing artifacts and improves high-frequency fidelity.

### Cooperative Synthesis Cancellation

Synthesis cancellation has been refactored from `worker.terminate()` (which forcefully kills the worker thread) to a cooperative `AbortController`-based approach. The pipeline checks for abort signals between diffusion steps and encoder calls, allowing it to shut down cleanly:

- Resources (ONNX sessions, tensor buffers) are released properly.
- The worker thread stays alive, avoiding the overhead of re-creating it on the next synthesis.
- Partial results are discarded gracefully.

The `AbortController` is created per synthesis call and its signal is threaded through `synthesize()` → `runDiffusionLoop()` → `evalDiffStep()`. Aborting sets a flag that is checked at each loop iteration.

### Segment-Level Synthesis Cache

A segment-level LRU cache (32 entries, up to 300 MB) stores completed synthesis results keyed by a hash of the input parameters (notes, lyrics, pitch curve, singer data, diffusion settings). When a segment with unchanged inputs is requested again, the cached audio is returned instantly.

The cache lives in the main process and is shared across all synthesis calls (preview and export). Editing any parameter that affects the output invalidates the relevant cache entries. The LRU eviction policy ensures memory usage stays bounded.

### Viewport-Sized Timeline Canvas

The main window timeline canvas has been refactored from a single backing store sized to the full project length to a viewport-sized backing store with scroll transform. This fixes the Chromium canvas size limit (~32,767 pixels) that caused rendering failures on long MIDI projects.

The canvas now renders only the visible portion of the timeline, translating the rendering context based on the scroll position. This allows projects of unlimited length without hitting canvas dimension limits.

### App Size Optimization

The packaged application size has been reduced by approximately 527 MB (32%) through:

- **ort-web deduplication**: Removed duplicate ONNX Runtime Web bundles that were included multiple times.
- **Source map pruning**: Stripped source maps from production builds.
- **Locale pruning**: Removed unused locale files from bundled dependencies.

---

## Tech Stack

| Category | Technology |
|----------|-----------|
| Frontend | Vanilla JavaScript, HTML5 Canvas |
| Desktop Framework | Electron + Electron Forge |
| Build Tool | Webpack (@electron-forge/plugin-webpack) |
| Inference Engine | ONNX Runtime Node (GPU/CPU via DirectML) + ONNX Runtime Web (NPU via WebNN) |
| Neural Models | SoulX-Singer (Diffusion-based SVS) |
| Pitch Detection | RMVPE ONNX, FCPE ONNX, Basic Pitch (TensorFlow.js) |
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
- `onnx_models/int8/` — INT8 quantized
- `onnx_models/int8/optimized_npu/` — INT8 NPU-optimized with fixed static dimensions

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
| `preprocess/fcpe_model.onnx` | FCPE pitch detector (ONNX, default MIDI extraction) |
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

The test suite includes **~1500 test cases across 61 test files** covering:
- WAV encoding/decoding
- Track management (add, remove, move, resize fragments)
- SVS pipeline logic (text processing, phoneme merging, note type detection)
- Diffusion samplers (Euler equivalence, Heun trapezoidal + last-step fallback, Extrap stability guards, STORK-2 RKC recurrence, registry/factory behavior)
- Pitch detection (RMVPE, FCPE)
- MIDI parsing
- Model path consistency
- Theme system (token validation, theme loading)
- LRC lyrics export
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
