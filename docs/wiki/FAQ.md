# Frequently Asked Questions

## General

### What is SXSEditor?

SXSEditor is an open-source desktop application for singing voice synthesis (SVS). You create MIDI notes with lyrics on a piano-roll editor, and the application synthesizes singing voice audio using the SoulX-Singer neural model running on ONNX Runtime.

### Is SXSEditor free?

Yes. SXSEditor is open-source under the MIT License.

### What platforms are supported?

- **Windows**: Primary target with pre-built installers. Windows 10/11 64-bit required.
- **macOS / Linux**: Can be built from source using Electron Forge. See the [Developer Guide](Developer-Guide).

### What languages can it sing?

| Language | Status |
|----------|--------|
| Chinese (Mandarin) | Supported — Chinese characters with optional tone digit (1–5) |
| English | Supported — English words, auto-converted to phonemes |
| Japanese | In development |

---

## Models

### What models do I need?

SXSEditor requires 9 ONNX model files for the SVS synthesis pipeline, plus optional models for pitch detection and MIDI extraction. On first launch, the Model Download window opens automatically to download them.

### How much disk space do models need?

Approximately 1–3 GB depending on the precision level:
- FP32: Largest (~3 GB)
- FP16: Medium (~1.5 GB)
- INT8: Smallest (~1 GB)

Multiple precisions can coexist — each has its own subdirectory.

### Which model precision should I choose?

| Your hardware | Recommended precision |
|---------------|----------------------|
| Discrete GPU, 4GB+ VRAM | FP32 (recommended, highest quality) |
| Discrete GPU, 8GB+ VRAM | FP32 (highest quality) |
| Integrated GPU / low VRAM | FP16 or INT8 |
| NPU hardware | INT8-NPU |

If unsure, start with **FP32** for the best quality. You can switch later without re-downloading.

### Can I use custom models?

No. SXSEditor is designed specifically for the SoulX-Singer model architecture. Custom model support is not available.

---

## Singer Creation

### What audio format do I need for the reference audio?

- **Format**: WAV (`.wav`) only
- **Duration**: 30 seconds maximum
- **Content**: **Pure vocals only** — no background music, instruments, reverb, or effects
- **Quality**: Clean recording with minimal noise, 44100 Hz sample rate recommended

### Why must the reference audio be pure vocals?

The SVS model learns voice characteristics from the reference audio. Any non-vocal content (music, noise, effects) is treated as part of the voice and will cause artifacts in the synthesized output. Use audio isolation tools (e.g., vocal removers) if needed to extract clean vocals from mixed recordings.

### Do I need to fill in lyrics during preprocessing?

**Yes.** The preprocessing step extracts MIDI notes and F0 pitch from the audio, but it does **not** detect lyrics. You must manually type the lyrics for each note in the preprocessing MIDI editor. This is mandatory — without lyrics, the synthesis cannot generate proper phonemes.

### Can I skip preprocessing?

No. Preprocessing is required to create a singer. It extracts the F0 curve and MIDI note data that the SVS model uses to understand the singer's voice.

### My WAV file is longer than 30 seconds. What do I do?

A trim dialog opens automatically. Use it to select a 30-second segment of the audio:
- Drag the selection to choose the position.
- Drag the edges to adjust start/end.
- Enter exact values in the input fields.
- Click **Preview Clip** to listen to the selection.
- Click **Confirm Trim** to apply.

### What makes a good reference audio?

- Clear, dry vocal recording
- No background noise
- No reverb or echo
- Varied pitch range (the model learns from what it hears)
- Good articulation
- 10–30 seconds of continuous singing

### What is the Singer Market?

The Singer Market is a built-in feature that lets you browse and download community-created singers without leaving the app. Instead of creating a singer from your own reference audio, you can pick from a library of pre-made voice profiles shared by other users.

Open it by clicking the **+** button in the singer panel and choosing **Open Singer Market**. Downloaded singers are loaded into your project immediately and ready to use.

---

## Fragment Editing

### How do I add notes?

In the Fragment Editor, click on the piano roll grid to create a note. Drag while clicking to set the note length. Notes snap to the beat grid.

### How do I add lyrics to notes?

Double-click a note to open an inline text editor. Type the lyric and press Enter. You can also edit lyrics in the Inspector panel on the right side.

For Chinese singing, enter Chinese characters (e.g., `你好`). You may append a digit `1`–`5` after a character to force a specific tone (e.g., `你2 好3`), where 1–4 are the four tones and 5 is the neutral tone (轻声). Pinyin text (e.g., `ni hao`) is **not** accepted as Chinese — ASCII input is routed to the English G2P path. For English singing, enter English words (e.g., `hello`).

### What is a slur note?

A slur (continuation) note extends the previous note's sound without re-attacking. Create one by adding a note with an empty lyric or a dash `-`. The note continues the phoneme of the previous note.

### How do I draw pitch curves?

Switch to Pitch mode (press `2`):
- Click to add anchor points.
- Drag anchors to move them.
- Right-click to delete anchors.
- Shift+drag for freehand brush drawing.
- Use the Smoothing slider to control brush smoothness.

### How do I undo/redo?

Press `Ctrl+Z` to undo and `Ctrl+Y` to redo. The editor supports up to 200 undo steps.

---

## Synthesis

### Synthesis is very slow

- **First synthesis is always slower** — the pipeline must load 9 ONNX models into GPU memory. Subsequent syntheses are faster.
- **Use a discrete GPU** if available. CPU inference is significantly slower.
- **Reduce diffusion steps** in Settings > Preview Inference Parameters. Default is 16; try 8 for faster preview.
- **Set CFG Strength to 0** to skip unconditional prediction, roughly doubling speed.
- **Update GPU drivers** to the latest version.

### The synthesized voice sounds wrong or has artifacts

- **Check the reference audio**: Ensure it contains pure vocals with no background music or effects.
- **Check lyrics**: Make sure every note has the correct lyric. Missing or wrong lyrics cause phoneme errors.
- **Check MIDI notes**: Verify that note pitches and timing match the intended melody.
- **Check model precision**: If using INT8 or FP16, try FP32 for higher quality.
- **Increase diffusion steps**: More steps = better quality (try 32 or 48 for export).

### What hardware do I need?

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | Any modern multi-core | Recent Intel/AMD 6+ cores |
| RAM | 8 GB | 16 GB |
| GPU | None (CPU fallback) | Discrete GPU with 4GB+ VRAM |
| Storage | 3 GB (app + models) | SSD with 10+ GB free |

A discrete GPU is strongly recommended for reasonable synthesis speed.

### Does it work without a GPU?

Yes. ONNX Runtime falls back to CPU automatically. However, synthesis will be significantly slower — a discrete GPU is recommended.

### Which GPUs are supported?

DirectML supports NVIDIA, AMD, and Intel GPUs (both discrete and integrated). NPU support is available via WebNN on compatible hardware.

---

## Audio

### What audio output modes are available?

- **Shared Mode** (WASAPI Shared): Standard Windows audio. Other apps can play audio simultaneously. Default mode.
- **Exclusive Mode** (WASAPI Exclusive): Direct hardware access with lower latency (1–3ms). Blocks other apps from using the audio device. Falls back to shared mode if the device doesn't support the selected settings.

### What is the output sample rate?

Synthesis runs at 24kHz internally (the SVS model's native rate). The default output sample rate is **48 kHz** (changed from 24 kHz in earlier versions), with 2× oversampling anti-aliasing for improved quality. Output sample rate is configurable in Settings (22050 to 192000 Hz). In exclusive mode, the device must support the selected rate.

### What format is the exported WAV?

48 kHz, 16-bit PCM WAV by default. Export sample rate is selectable: 24/44.1/48/96 kHz. The SVS model runs at 24 kHz internally and the output is resampled with 2× oversampling anti-aliasing.

---

## Audio to MIDI

### What is Audio to MIDI?

A feature that converts an existing audio file into MIDI notes. It extracts note pitches and timing, creating a new track with the detected notes.

### Which extraction tool should I use?

- **FCPE** (recommended): ONNX-based, fast and accurate. Features a configurable post-processing pipeline for note onset/offset detection and pitch quantization.
- **Basic Pitch**: Neural network-based (TensorFlow.js), stable results for most scenarios.
- **RMVPE**: Converts F0 pitch curve to notes. Experimental, results may be suboptimal.

Change this in Settings > Audio > MIDI Extraction Tool.

### Can I extract a pitch curve too?

Yes. When using Audio to MIDI, choose "Extract Pitch (RMVPE)" to also extract an F0 pitch curve that is applied to the fragment.

---

## New Features

### Can I add background music to my project?

Yes. You can add **accompaniment tracks** alongside vocal fragments. Import WAV, MP3, FLAC, OGG, M4A, or AAC files as accompaniment clips on the timeline. Each accompaniment track has its own volume control, and clips can be dragged to reposition them. Accompaniment audio is mixed with synthesized vocals during both playback and export.

### Can I export lyrics?

Yes. Use **File > Export LRC** to export the project's lyrics as a timed `.lrc` file. Each lyric line includes a timestamp tag corresponding to when it is sung in the project. The LRC file can be used alongside the exported WAV for karaoke-style lyric display in compatible music players.

### What are diffusion samplers and which should I use?

The diffusion model iteratively denoises a mel spectrogram by solving an ODE. The **sampler** is the numerical solver that determines how each step combines model evaluations. Four samplers are available:

| Sampler | Speed | Quality | Notes |
|---------|-------|---------|-------|
| **Euler** (default) | Fastest | Baseline | Most predictable; best for chunked previews |
| **Heun** | 2× slower | Higher accuracy | Second-order trapezoidal rule |
| **Extrapolated Euler** | Same as Euler | Heuristic improvement | Reuses previous step's velocity; benefit is strongest with smooth velocity fields |
| **STORK-2** | Same as Euler | Designed for stiff ODEs | Paper-faithful (ICLR 2026); higher per-step algebraic cost |

For most users, **Euler** is the best choice for preview (fast) and **Heun** or **STORK-2** for export (higher quality). Samplers can be configured independently for preview and export in Settings.

### What is Dynamic Thresholding?

Dynamic Thresholding is a per-frame percentile clipping technique (arXiv:2507.08965) that suppresses outlier mel bins during diffusion sampling, reducing artifacts without sacrificing detail. The percentile is adjustable (0.9–0.999); higher values preserve more detail, lower values are more aggressive at suppressing artifacts.

### Why was the default sample rate changed to 48 kHz?

The SVS model runs at 24 kHz internally. Previously, the output was also 24 kHz, which limited high-frequency fidelity. The default is now 48 kHz with 2× oversampling anti-aliasing, which significantly improves output quality. The export sample rate is selectable (24/44.1/48/96 kHz) if you need a different rate.

---

## Projects

### What file formats are used?

| File | Extension | Description |
|------|-----------|-------------|
| Project | `.sxsproj` | Contains all singers, fragments, and project settings |
| Singer | `.sxssinger` | Contains singer metadata, reference audio, and preprocessed data |

### Should I embed singer files in the project?

- **Embed**: Makes the project self-contained. Good for sharing or archiving. Increases file size.
- **Don't embed**: Smaller file. Requires `.sxssinger` files to be accessible at their stored paths.

### My singer file is missing when I open a project

If you didn't embed singer files and the `.sxssinger` file was moved or deleted:
1. The singer row shows "⚠ Singer file not found".
2. Click **Relocate** to browse for the file at its new location.

---

## Troubleshooting

### The app crashes on startup

1. Ensure all model files are in the `onnx_models/` directory.
2. Check that your GPU drivers are up to date.
3. Try deleting the settings file at `%APPDATA%\sxseditor\settings.json` to reset to defaults.
4. Open an issue on [GitHub Issues](https://github.com/Henley04/SXSEditor/issues) with error logs.

### Model download fails

- Check your internet connection.
- The download uses chunked parallel transfer — if it fails, retry by clicking **Start Download** again. Completed files are skipped.
- Try changing the download directory.
- If behind a proxy, ensure the proxy settings allow connections to ModelScope.

### Audio playback has glitches or dropouts

- Increase the buffer size in Settings > Audio > Buffer Size.
- If using exclusive mode, try switching to shared mode.
- Close other audio-intensive applications.
- Check that your audio device drivers are up to date.

### How do I report a bug?

Open an issue on [GitHub Issues](https://github.com/Henley04/SXSEditor/issues) with:
- A clear description of the problem
- Steps to reproduce
- Your system configuration (OS, GPU, RAM)
- Screenshots or error messages if applicable
