# SXSEditor

A desktop singing voice synthesis (SVS) and editing application powered by ONNX Runtime and Electron.

## Overview

SXSEditor is an open-source singing voice synthesis workstation that lets you create, edit, and synthesize vocal tracks. It combines a visual piano-roll editor with a neural SVS pipeline based on the SoulX-Singer acoustic model, running entirely through ONNX Runtime for efficient inference on both GPU (DirectML) and CPU.

## Features

- **Visual Track & Fragment Editor**: Arrange singing fragments on a multi-track timeline with drag-and-drop resizing and positioning.
- **Piano-Roll Note Editing**: Edit notes, lyrics, pitch curves, and envelopes inside each fragment.
- **Neural Singing Voice Synthesis (SVS)**: Generate singing from note sequences and lyrics using the SoulX-Singer ONNX model.
- **Singer Management**: Create and manage singers with custom reference audio, avatars, colors, and preprocessed F0 data.
- **Audio Preprocessing**: Built-in F0 extraction (RMVPE / Basic Pitch) and audio analysis for singer creation.
- **Real-time Playback**: Synthesize and play back your project directly in the editor.
- **WAV Export**: Mix and export your project to standard WAV files.
- **GPU Acceleration**: Supports DirectML for NVIDIA/AMD/Intel discrete GPUs with automatic device selection.
- **Cross-platform**: Built with Electron, ready for Windows, macOS, and Linux packaging.

## Tech Stack

- **Frontend**: Vanilla JavaScript, HTML5 Canvas, Wavesurfer.js
- **Desktop Framework**: Electron + Electron Forge
- **Build Tool**: Webpack (via @electron-forge/plugin-webpack)
- **Inference Engine**: ONNX Runtime Node (`onnxruntime-node`)
- **Neural Models**: SoulX-Singer ONNX models (Diffusion-based SVS)
- **Pitch Detection**: RMVPE ONNX, Basic Pitch (TensorFlow.js)
- **Testing**: Mocha + Chai + Sinon + NYC

## Prerequisites

- **Node.js** >= 18
- **npm** >= 9
- **Windows** (primary target; macOS/Linux supported via Electron Forge makers)
- **ONNX models**: Download or export the SoulX-Singer ONNX models into `onnx_models/`

## Installation

Clone the repository and install dependencies:

```bash
git clone <repository-url>
cd SXSEditor
npm install
```

If you encounter native module build issues, rebuild for Electron:

```bash
npx electron-rebuild
```

## Running in Development

Start the application in development mode with hot reload:

```bash
npm start
```

## Building & Packaging

Package the application for the current platform:

```bash
npm run package
```

Create distributables (e.g., `.exe`, `.zip`, `.deb`):

```bash
npm run make
```

## ONNX Models

The application requires the SoulX-Singer ONNX model files placed in the `onnx_models/` directory.

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

Additional models for Singing Voice Conversion tasks are placed in the `svc/` subdirectory.

See [onnx_models/README.md](onnx_models/README.md) for detailed input/output specifications and usage examples.

## Project Structure

```
SXSEditor/
├── assets/                  # Application icons and images
├── docs/                    # Design documents and references
├── example/                 # Example prompt/target data
├── onnx_models/             # ONNX model files
│   ├── svc/                 # SVC-specific models
│   └── README.md
├── src/
│   ├── audio/               # WAV encoder and audio utilities
│   ├── editor/              # Track manager, piano roll, envelope editor
│   ├── inference/           # ONNX inference pipelines (SVS, RMVPE, Basic Pitch)
│   ├── main.js              # Electron main process
│   ├── preload.js           # Preload script for secure IPC
│   ├── renderer.js          # Main renderer process (UI logic)
│   ├── index.html           # Main window layout
│   ├── fragmentEditor.html  # Fragment editor window
│   ├── singerCreator.html   # Singer creation window
│   ├── audioPreprocess.html # Audio preprocessing window
│   └── settings.html        # Settings window
├── test/                    # Automated test suite (Mocha/Chai)
├── forge.config.js          # Electron Forge configuration
├── webpack.*.config.js      # Webpack configurations
└── package.json
```

## Testing

Run the full test suite:

```bash
npm test
```

Run with code coverage:

```bash
npm run test:coverage
```

Run in watch mode:

```bash
npm run test:watch
```

The test suite includes **160 test cases** covering WAV encoding, track management, SVS pipeline logic, pitch detection, and integration tests.

## Usage Guide

### Creating a Project

1. Launch SXSEditor.
2. Set your project **BPM** and **time signature** in the toolbar.
3. Add a singer by clicking the **+** button in the singer panel.
4. Choose to **create a new singer** or **open an existing `.sxssinger` file**.

### Creating a Singer

1. Open the **Singer Creator** window.
2. Enter a singer name and choose a color.
3. Load a reference audio file (WAV) — this is the voice the model will mimic.
4. Optionally add an avatar image.
5. Run **Audio Preprocessing** to extract F0 and note data from the reference audio.
6. Save the singer as a `.sxssinger` file.

### Editing Fragments

1. Click the **+** button on a singer row to add a new fragment.
2. Double-click a fragment to open the **Fragment Editor**.
3. In the fragment editor:
   - Add notes in the piano roll.
   - Enter lyrics for each note.
   - Draw pitch curves and envelopes.
4. Save the fragment to return to the main timeline.

### Synthesis & Playback

1. Press the **▶ Play** button to synthesize and play the entire project.
2. The editor will automatically initialize the SVS pipeline and generate audio.
3. Use **⏸ Pause** and **⏹ Stop** to control playback.

### Exporting

1. Click the **📤 Export** button.
2. The project will be synthesized and mixed.
3. Choose a location to save the final **WAV** file.

### Settings

Open **Settings** from the menu to configure:

- **Inference Device**: Select a specific DirectML GPU or use automatic selection.
- Device settings take effect after restarting the pipeline.

## Audio Configuration

| Parameter | Value |
|-----------|-------|
| Sample Rate | 24000 Hz |
| Hop Size | 480 (20 ms) |
| FFT Size | 1920 |
| Window Size | 1920 |
| Mel Bins | 128 |
| F0 Range | C1 ~ B6 (32.7 Hz ~ 1975.5 Hz) |

## License

This project is licensed under the [MIT License](LICENSE).

## Acknowledgements

- **SoulX-Singer**: The underlying acoustic model and SVS/SVC pipeline.
- **ONNX Runtime**: For high-performance cross-platform inference.
- **Electron Forge**: For application packaging and build tooling.
- **Wavesurfer.js**: For audio waveform visualization.

## Contributing

Contributions are welcome! Please ensure tests pass before submitting pull requests:

```bash
npm test
```

For major changes, open an issue first to discuss what you would like to change.

## Support

If you encounter issues or have questions, please open an issue on the repository.
