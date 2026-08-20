# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SXSEditor is an Electron desktop application for AI-powered singing voice synthesis (SVS). It combines a visual piano-roll editor with a neural SVS pipeline based on the SoulX-Singer acoustic model, running through ONNX Runtime with DirectML GPU acceleration.

- **Languages supported**: Chinese (Mandarin) and English singing synthesis
- **Audio**: 24kHz model rate (48kHz default playback/export), 480 hop size, 128 mel bins
- **Tech stack**: Electron + Electron Forge, Webpack, ONNX Runtime Node, Vanilla JS + HTML5 Canvas

## Common Commands

```bash
npm start                     # Run in development mode
npm test                      # Run full test suite (Mocha + Chai + Sinon, 1500+ tests)
npm run test:watch            # Watch mode for tests
npm run test:coverage         # Tests with NYC coverage
npm run package               # Package for current platform
npm run package:lite          # Package without ONNX models (for testing)
npm run make                  # Create distributables (.exe, .zip, .deb)
npx electron-rebuild          # Rebuild native modules if needed
```

Run a single test file:
```bash
npx mocha --require ./test/setup.js "test/trackManager.test.js" --timeout 30000
```

## Architecture

### Process Model (Electron)

The app uses `contextIsolation: true` and `sandbox: true`. All IPC goes through `preload.js` which exposes `window.electronAPI` to renderer processes. The main process (`src/main.js`) owns all ONNX model instances and audio output managers.

**Windows** (each has its own entry point registered in `forge.config.js`):
- **Main window** (`renderer.js`) — multi-track timeline, project management
- **Fragment editor** (`fragmentEditor.js`) — piano-roll editor for individual fragments
- **Singer creator** (`singerCreator.js`) — create custom singers from reference audio
- **Singer market** (`singerMarket.js`) — browse, download, and share community-created singers
- **Audio preprocess** (`audioPreprocess.js`) — F0 extraction and MIDI extraction from audio
- **Settings** (`settings.js`) — device selection, diffusion parameters, audio config
- **Model download** (`modelDownload.js`) — download missing ONNX models from ModelScope
- **Resource manager** (`resourceManager.js`) — GPU/VRAM monitoring, model load/unload

### Inference Pipeline (`src/inference/`)

`nativeSvsPipeline.js` is the core SVS pipeline. It loads 9 ONNX models (text encoder, pitch encoder, type encoder, F0 encoder, preflow, cond embedding, diffusion step, vocoder, mel transform) and runs diffusion-based synthesis. Key constants: `SAMPLE_RATE=24000`, `HOP_SIZE=480`, `EMBED_DIM=512`, `COND_DIM=1024`.

Other inference modules:
- `rmvpePitchDetector.js` — RMVPE-based F0 extraction (ONNX)
- `fcpeDetector.js` — FCPE pitch detector (ONNX), default MIDI extraction tool
- `basicPitch.js` — Basic Pitch note detection (TensorFlow.js)
- `rosvotDetector.js` — ROSVOT voice onset detection (ONNX)
- `midiParser.js` — Standard MIDI file parsing

### Editor (`src/editor/`)

- `trackManager.js` — Multi-track timeline with fragment arrangement
- `pianoRoll.js` — Canvas-based piano roll (notes, lyrics, pitch curves, envelopes)
- `envelopeEditor.js` — Volume/pan/F0 parameter curve editing (with destroy() cleanup)
- `historyManager.js` — Undo/redo (up to 200 steps)

### Audio (`src/audio/`)

- `audioOutputManager.js` — WASAPI audio output via decibri (optional native module)
- `wavEncoder.js` — WAV file encoding (default 48kHz, selectable 24/44.1/48/96 kHz)
- `lrcExport.js` — LRC lyrics file export module
- GPU info via `systeminformation` (replaced `@oxmc/node-gpuinfo`)
- `wavEncoder.js` — WAV file encoding (24kHz)
- `audioWorker.js` — Audio processing worker thread

### Model System

- `modelRegistry.js` — Declarative model group definitions (SVS pipeline, RMVPE, Basic Pitch, ROSVOT)
- `modelManager.js` — Model file checking, download from ModelScope with chunked parallel transfer
- Models are stored in `onnx_models/` (git-ignored), auto-downloaded on first launch

### i18n (`src/i18n/`)

- `index.js` — i18n system with locale loading
- `zh-CN.js`, `en.js` — Translation files
- Default locale is `zh-CN`; stored in `sxseditor-locale.json` in userData

## Key Technical Details

- **Float16 patch**: `nativeSvsPipeline.js` patches onnxruntime-common's type mapping to use `Uint16Array` for float16 tensors (Node.js v24+ compatibility)
- **IPC binary transfer**: Audio data uses `Float32Array` binary transfer for low latency
- **Path security**: Main process validates file paths against allowed directories (`userData`, `documents`, `desktop`, `home`, `temp`) plus dialog-authorized paths
- **Singer file format**: `.sxssinger` files are JSON with base64-encoded WAV audio, F0 data, MIDI notes, and optional avatar
- **SingerCreator WAV limit**: WAV files over 30 seconds trigger a trim dialog (max 30s clip)

## Trae Rules (from .trae/rules/readme.md)

- Every commit must have a corresponding issue number
- Always git backup before making changes
- Test destructive changes after making them
- Use `npm run package:lite` for packaging tests
- Update README.md when adding new features
- `onnx_models/` is git-ignored — check with PowerShell if needed
- Commit messages must be in English

## Testing

Tests use Mocha + Chai + Sinon with JSDOM for DOM simulation. The `test/setup.js` file configures JSDOM, mocks `HTMLCanvasElement.getContext`, and provides automatic sinon sandbox cleanup. Tests cover: WAV encoding, track management, SVS pipeline logic, pitch detection, MIDI parsing, phoneme merging, and integration tests.
