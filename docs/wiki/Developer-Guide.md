# Developer Guide

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Build from Source](#build-from-source)
3. [Project Structure](#project-structure)
4. [Tech Stack](#tech-stack)
5. [ONNX Models](#onnx-models)
6. [Testing](#testing)
7. [Packaging & Distribution](#packaging--distribution)
8. [Adding a New Theme](#adding-a-new-theme) / [添加新主题](#添加新主题)
9. [Contributing](#contributing)

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
│   ├── preprocess/          # RMVPE & ROSVOT models
│   ├── basic_pitch_model/   # Basic Pitch model (TF.js)
│   └── README.md
├── src/
│   ├── audio/               # WAV encoder and audio utilities
│   ├── editor/              # Track manager, piano roll, envelope editor
│   ├── inference/           # ONNX inference pipelines
│   │   ├── pipeline/        # Main SVS pipeline (index.js, preprocessing.js, diffusion.js, postprocessing.js, textProcessing.js)
│   │   ├── webnn/           # WebNN NPU inference pipeline
│   │   ├── rmvpePitchDetector.js   # RMVPE-based F0 detection
│   │   ├── basicPitch.js           # Basic Pitch F0 detection
│   │   ├── midiParser.js           # MIDI parsing utilities
│   │   ├── phone_set.json          # Phoneme vocabulary (2820 entries)
│   │   └── en_g2p_dict.json        # English grapheme-to-phoneme dictionary (126k words)
│   ├── main.js              # Electron main process
│   ├── preload.js           # Preload script for secure IPC
│   ├── renderer.js          # Main renderer process (UI logic)
│   ├── index.html / .css    # Main window
│   ├── fragmentEditor.*     # Fragment editor window
│   ├── singerCreator.*      # Singer creation window
│   ├── audioPreprocess.*    # Audio preprocessing window
│   └── settings.*           # Settings window
├── test/                    # Automated test suite (470+ tests)
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
| Inference Engine | ONNX Runtime Node (GPU/CPU) + ONNX Runtime Web (NPU/WebNN) |
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
| `vocoder_dml.onnx` | Vocos vocoder (mel → waveform, DML optimized) |
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

The test suite includes **470+ test cases** covering:

- WAV encoding/decoding
- Track management
- SVS pipeline logic
- Pitch detection (RMVPE)
- MIDI parsing
- Model path consistency
- Theme system
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

## Adding a New Theme / 添加新主题

SXSEditor's UI is fully driven by a three-layer **Design Token** system (`global → alias → component`) and a JSON-based **Theme Pack** format. Adding a new theme is as simple as writing a single `.theme.json` file.

### Theme Pack JSON Format

```json
{
  "id":          "my-cool-theme",   // required, kebab-case, unique
  "name":        "My Cool Theme",   // required, human-readable label
  "version":     "1.0.0",           // required, semver
  "author":      "Your Name",       // optional
  "isDark":      true,              // required, true for dark themes
  "description": "...",             // optional
  "tags":        ["dark", "blue"],  // optional, free-form
  "extends":     "dark-aurora",     // optional, parent theme id
  "tokens": {                       // required, key = full token name
    "--color-blue-500": "#5b8def",
    "--bg-app":          "#14141f",
    "--button-primary-bg": "var(--color-blue-500)"
  }
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `id` | ✓ | kebab-case, must not start or end with `-`, must be unique |
| `name` | ✓ | Display name in the dropdown |
| `version` | ✓ | semver; missing → defaults to `1.0.0` |
| `isDark` | ✓ | Used for icons / auto dark-mode hints |
| `tokens` | ✓ | Object: token name → CSS value |
| `extends` | – | Parent theme id. Inheritance depth is capped at **3 levels** and cyclic `extends` is rejected by `themeValidator`. |
| `author`, `description`, `tags` | – | Free-form metadata |

### Token Naming Convention

Tokens follow `--{layer}-{group}-{key}` (e.g. `--color-blue-500`, `--bg-app`, `--button-primary-bg`).

- **Layer prefix**: `--color-*` (palette) / `--bg-*` `--fg-*` `--border-*` (alias) / `--button-*` `--input-*` `--panel-*` `--tooltip-*` `--selection-*` (component)
- **Group**: `blue` / `gray` / `ink` / `red` / `green` / `amber` / `purple` for colors; `space-0` … `space-8`, `radius-sm` … `radius-full`, `font-xs` … `font-2xl`, `motion-fast` … `motion-slow`
- **Key**: ordinal (`50` … `900`), state (`hover` / `pressed` / `focus`), or semantic (`app` / `panel` / `elevated` / `input`)

The full token list is documented in `src/themes/tokenCatalog.js`. Alias tokens reference global tokens via `var(--color-...)`; component tokens reference alias tokens.

### Supported Value Formats

| Token type | Accepted formats |
|------------|-----------------|
| **Color** | `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgba(r, g, b, a)`, `hsla(h, s%, l%, a)`, `transparent`, `currentColor` |
| **Size** (spacing, radius, font) | `<number><unit>` where unit ∈ `px` / `rem` / `em` / `%` / `vh` / `vw`. Bare numbers (e.g. `0`) are also accepted for unitless values. |
| **Motion** (duration) | `<number><unit>` where unit ∈ `s` / `ms` |
| **Shadow** | Any valid CSS `box-shadow` value as a string |
| **String** (e.g. font-family) | Plain string |

### Minimal Example

```json
{
  "id": "midnight-rose",
  "name": "Midnight Rose",
  "version": "1.0.0",
  "isDark": true,
  "extends": "dark-aurora",
  "tokens": {
    "--accent":           "#f43f5e",
    "--accent-hover":     "#fb7185",
    "--button-primary-bg":"var(--color-red-500)"
  }
}
```

This theme inherits every token from `dark-aurora` and only overrides the accent palette.

### Testing the Theme

1. Drop the file into `<userData>/themes/<theme-id>.theme.json`. The `<userData>` path is:
   - **Windows**: `%APPDATA%\sxseditor\`
   - **macOS**: `~/Library/Application Support/sxseditor/`
   - **Linux**: `~/.config/sxseditor/`
2. Restart the application — the new theme appears under the **User** group in the Settings dropdown.
3. Select it to apply. Hot-swap back to `dark-aurora` to compare.

For rapid iteration, copy the file into the user themes folder and use the in-app **Edit current theme** dialog (changes are saved per window without restart).

### Registering a Built-in Theme

To ship a theme as a built-in (read-only, bundled in `app.asar`):

1. Create the JSON file under `src/themes/builtins/<id>.theme.json` (mirroring the four existing files).
2. Register it in `src/themes/builtins/index.js`:
   ```js
   import midnightRose from './midnight-rose.theme.json';
   export const BUILTIN_THEMES = [darkAurora, lightPaper, midnightAmber, midnightRose];
   ```
3. Run `npm test` — the new theme is automatically exercised by `test/themeTokens.test.js` (which asserts that every built-in covers the required token set).
4. Run `npm run package:lite` to confirm the file is included in the package.

> Built-in themes are read-only and cannot be deleted from the Settings UI. The `deleteTheme` IPC method explicitly refuses to remove them.

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