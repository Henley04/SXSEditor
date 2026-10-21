# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SXSEditor is an Electron desktop application for AI-powered singing voice synthesis (SVS). It combines a visual piano-roll editor with a neural SVS pipeline based on the SoulX-Singer acoustic model, running through ONNX Runtime with DirectML GPU acceleration.

- **Languages supported**: Chinese (Mandarin), English, and Japanese singing synthesis (Japanese requires the optional JP model pack: `note_text_encoder`, `preflow`, `cond_emb`, `diff_step_dml`)
- **Audio**: 24kHz model rate (48kHz default playback/export), 480 hop size, 128 mel bins
- **Tech stack**: Electron + Electron Forge, Webpack, ONNX Runtime Node, Vanilla JS + HTML5 Canvas

## Common Commands

```bash
npm start                     # Run in development mode
npm test                      # Run full test suite (Mocha + Chai + Sinon, ~1840 tests across 86 files)
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

Test counts drift as the suite grows — run `node scripts/count-tests.js` to refresh them. CI uses `npm run test:ci`, which runs the same suite but ignores `test/onnxModelLoading.test.js` (it needs real ONNX models and is excluded from CI: ~1825 cases).

## Architecture

### Process Model (Electron)

The app uses `contextIsolation: true` and `sandbox: true`. All IPC goes through `preload.js` which exposes `window.electronAPI` to renderer processes. The main process (`src/main.js`) owns all ONNX model instances and audio output managers.

**Windows** (9 entry points registered in `forge.config.js`, plus a splash window that has no JS entry — 10 windows in total):
- **Main window** (`src/renderer/index.js`) — multi-track timeline, project management
- **Fragment editor** (`src/fragmentEditor/index.js`) — piano-roll editor for individual fragments
- **Singer creator** (`src/singerCreator.js`) — create custom singers from reference audio
- **Singer market** (`src/singerMarket.js`) — browse, download, and share community-created singers
- **Audio preprocess** (`src/audioPreprocess/index.js`) — F0 extraction and MIDI extraction from audio
- **Settings** (`src/settings.js`) — device selection, diffusion parameters, audio config
- **Model download** (`src/modelDownload.js`) — download missing ONNX models from ModelScope
- **Resource manager** (`src/resourceManager.js`) — GPU/VRAM monitoring, model load/unload
- **Update notification** (`src/updateNotification.js`) — in-app update prompt window

Plus the splash window (no JS entry point — it is created from `src/main/splashManager.js`)

### Inference Pipeline (`src/inference/`)

`pipeline/index.js` (the `OnnxSVSPipeline` class) is the core SVS pipeline. It loads 9 ONNX models (note text encoder, note pitch encoder, note type encoder, F0 encoder, preflow, cond embedding, diffusion step, vocoder, mel transform) and runs diffusion-based synthesis. Key constants live in `pipeline/constants.js` and `shared/constants.js`: `SAMPLE_RATE=24000`, `HOP_SIZE=480`, `EMBED_DIM=512`, `COND_DIM=1024`, `MEL_DIM=128`, `VOCODER_CHUNK_FRAMES=1024`, `VOCODER_OVERLAP_FRAMES=32`.

Other inference modules:
- `rmvpePitchDetector.js` — RMVPE-based F0 extraction (ONNX)
- `fcpePitchDetector.js` — FCPE pitch detector (ONNX), default MIDI extraction tool
- `basicPitch.js` — Basic Pitch note detection (TensorFlow.js)
- `rosvotDetector.js` — ROSVOT voice onset detection (ONNX)
- `midiParser.js` — Standard MIDI file parsing

### Editor (`src/editor/`)

- `trackManager.js` — Multi-track timeline with fragment arrangement
- (the piano-roll canvas lives in the renderers: `src/fragmentEditor/` for the editor, `src/audioPreprocess/pianoRoll.js` for preprocessing)
- (envelope editing lives in the renderer: `src/renderer/` and `src/fragmentEditor/`)
- `historyManager.js` — Undo/redo (up to 200 steps)

### Audio (`src/audio/`)

- `audioOutputManager.js` — WASAPI audio output via decibri (optional native module)
- `wavEncoder.js` — WAV file encoding (default 48kHz, selectable 24/44.1/48/96 kHz)
- `audioWorker.js` — Audio processing worker thread
- `lrcExport.js` — LRC lyrics file export; note it lives in the renderer, at `src/renderer/lrcExport.js`

### Model System

- `modelRegistry.js` — Declarative model group definitions (SVS pipeline, RMVPE, Basic Pitch, ROSVOT)
- `modelManager.js` — Model file checking, download from ModelScope with chunked parallel transfer
- GPU info via `systeminformation` (replaced `@oxmc/node-gpuinfo`), `src/main/gpuInfo.js`
- Models are stored in `onnx_models/` (git-ignored), auto-downloaded on first launch

### i18n (`src/i18n/`)

- `index.js` — i18n system with locale loading
- `zh-CN.js`, `en.js` — Translation files
- Default locale is `en` (`src/main/locale.js`); it falls back to `zh-CN` only when the system language is Chinese. The choice is stored in `sxseditor-locale.json` in userData

### Debug / Automation Entry Points

- **Update notification window** — `updateNotification.html` / `updateNotification.js`, the 9th `entryPoints` entry (`update_notification_window`)
- **Headless CLI** — `src/main/cli.js`, invoked as `npx electron . --cli <command>` (or `SXSEditor.exe --cli <command>` when packaged; `npm run cli`). 11 commands: `help`, `version`, `info`, `gpu`, `winml`, `models`, `settings`, `init-pipeline`, `synth`, `synth-project`, `qdrift-conds`
- **MCP bridge** — `src/main/mcpBridge.js` starts a localhost HTTP automation server (127.0.0.1 + Bearer token written to `mcp-endpoint.json`) that forwards requests to the renderer over IPC (`MCP_AUTOMATION_REQUEST` / `MCP_AUTOMATION_RESPONSE`, long-task timeout 10 min). `scripts/sxseditor-mcp.js` is the stdio MCP gateway (`npm run mcp`) that routes JSON-RPC from stdin/stdout to that bridge; the app must already be running

## Key Technical Details

- **Float16 patch**: `pipeline/float16Patch.js` patches onnxruntime-common's type mapping to use `Uint16Array` for float16 tensors (Node.js v24+ compatibility)
- **IPC binary transfer**: Audio data uses `Float32Array` binary transfer for low latency
- **Path security**: Main process validates file paths against three allowed directories (`userData`, `documents`, `desktop`) plus dialog-authorized paths. `home` and `temp` were deliberately removed from the allow-list (`src/main/security.js`) — do not re-add them
- **Singer file format**: `.sxssinger` files are JSON with base64-encoded WAV audio, F0 data, MIDI notes, and optional avatar
- **SingerCreator WAV limit**: WAV files over 30 seconds trigger a trim dialog (max 30s clip)

## Trae Rules (from .trae/rules/readme.md)

- Every commit must have a corresponding commit message
- Always git backup before making changes
- Test destructive changes after making them
- Use `npm run package:lite` for packaging tests
- `onnx_models/` is git-ignored — check with PowerShell if needed
- Commit messages must be in English

## Testing

Tests use Mocha + Chai + Sinon with JSDOM for DOM simulation. The `test/setup.js` file configures JSDOM, mocks `HTMLCanvasElement.getContext`, and provides automatic sinon sandbox cleanup. Tests cover: WAV encoding, track management, SVS pipeline logic, pitch detection, MIDI parsing, phoneme merging, and integration tests.
