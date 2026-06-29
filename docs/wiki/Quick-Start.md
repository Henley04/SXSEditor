# Quick Start Guide

This guide walks you through the complete workflow: from installing SXSEditor to synthesizing your first singing voice. Follow each step in order.

---

## Step 1: Install and Launch

1. Download the Windows installer from [GitHub Release (latest)](https://github.com/Henley04/SXSEditor/releases/latest/download/sxsinstaller_x64_no_models.exe) or [GitCode Mirror (China)](https://gitcode.com/qq_50331623/SXSEditor/releases/latest/download/sxsinstaller_x64_no_models.exe).
2. Run the installer. Administrator privileges are required for installation.
3. Launch SXSEditor from the Start Menu or desktop shortcut.

---

## Step 2: Download Models (First Launch)

On first launch, SXSEditor detects that inference model files are missing and opens the **Model Download** window automatically.

### Choosing Model Precision

You must select a **model precision** before downloading. This determines the balance between audio quality, VRAM usage, and inference speed.

| Precision | Best For | Quality | VRAM Usage |
|-----------|----------|---------|------------|
| **FP16** (recommended) | Discrete GPU users (4GB+ VRAM) | Best | High |
| **FP32** | High-end discrete GPU (8GB+ VRAM) | Highest | Very High |
| **FP8** | GPUs with FP8 hardware support | Near-FP16 | Medium |
| **INT8** | Integrated GPU or low VRAM (<2GB) | Slight loss | Low |
| **INT8-NPU** | NPU hardware users | Slight loss | Low |

**If you are unsure, choose FP16.** Different precisions can coexist — you can switch later in Settings without re-downloading.

### Starting the Download

1. Select your desired precision.
2. (Optional) Click **Change** to choose a different download directory. The default location does not require admin privileges.
3. Click **Start Download**.
4. Wait for all files to download. The window shows per-file progress and overall progress.
5. When all files show "Complete", click **Close**.

The main window will appear after the download completes.

> **Tip**: The download uses chunked parallel transfer (up to 16 concurrent connections) for speed. If a download fails, click **Start Download** again to retry — completed files are skipped.

---

## Step 3: Create a Singer

A **singer** is a voice profile. It contains a reference audio clip and the preprocessed data extracted from that audio. The SVS model uses the singer's voice characteristics to synthesize new singing.

### Opening the Singer Creator

1. In the main window, click the **+** button in the singer panel (left side).
2. A dialog appears with two options:
   - **Open Singer Creator** — create a new singer
   - **Open Existing Singer File** — load a `.sxssinger` file
3. Click **Open Singer Creator**.

### Filling in Basic Info

1. **Singer Name**: Enter a name for your singer (e.g., "MyVoice").
2. **Avatar**: Choose one of:
   - **Color** (default): Pick a color. This color appears on the singer's timeline track.
   - **Image**: Click **Select Image** to upload a picture file.

### Uploading Reference Audio

The reference audio is the most important part. It tells the model what voice to imitate.

1. Click the upload area (or drag a WAV file onto it).
2. Select a **WAV** file. Requirements:
   - **Format**: `.wav` only
   - **Duration**: 30 seconds maximum. If your file exceeds 30 seconds, a trim dialog opens automatically — drag the selection to choose a 30-second clip, then click **Confirm Trim**.
   - **Content**: **Pure vocals only.** No background music, no instruments, no reverb effects. The model learns from whatever is in this audio — if there is background music, the synthesized voice will contain artifacts.
   - **Quality**: Clean recording, minimal noise. 44100 Hz sample rate recommended.
3. After uploading, a waveform preview appears. Click **Preview** to listen.

### Audio Preprocessing

Preprocessing extracts the musical information (pitch, notes, timing) from your reference audio. This step is **required** — without it, the singer cannot be used for synthesis.

1. Click **Start Audio Preprocessing**.
2. A new window opens showing:
   - **WAV Waveform** (top): The reference audio waveform.
   - **MIDI Editor** (middle): Extracted MIDI notes that you must verify and edit.
   - **F0 Curve** (bottom): The extracted pitch curve (read-only).

#### Extracting F0 (Pitch)

1. Click **RMVPE Extract F0**.
2. Wait for extraction to complete. This uses the RMVPE neural model to detect the fundamental frequency curve from the audio.

#### Extracting MIDI Notes

1. Click **Extract MIDI** (Basic Pitch is the recommended tool).
2. Wait for extraction. Notes appear on the MIDI editor canvas.

#### Editing MIDI Notes and Lyrics

**This is critical.** The extracted MIDI notes are automatically detected — they are often imprecise. You **must** verify and edit them:

1. **Check note boundaries**: Make sure each note's start, end, and pitch match the actual singing in the audio. Drag note edges to resize, drag notes to reposition.
2. **Fill in lyrics**: Each note needs a lyric. **You must type the lyrics yourself** — the system does not auto-detect lyrics from audio.
   - For **Chinese**: Enter Chinese characters (e.g., `你好`) or Pinyin (e.g., `ni hao`).
   - For **English**: Enter the English word (e.g., `hello`). The system converts it to phonemes automatically.
   - Double-click a note to edit its lyric inline.
3. **Verify note count**: Check that the number of notes matches the actual singing.

#### Saving Preprocessed Data

1. After editing, click **Save** (💾).
2. The preprocessing window closes and returns to the Singer Creator.
3. The preview panel now shows both "WAV ✓" and "Preprocess ✓" badges.

### Creating the Singer File

1. Click **Create & Save** (✓).
2. Choose a save location. The singer is saved as a `.sxssinger` file.
3. A success message confirms the singer was created.

The singer now appears in the main window's singer panel.

---

## Step 4: Add a Fragment

A **fragment** is a segment of music assigned to a singer. It contains MIDI notes, lyrics, and optional pitch curves.

1. In the main window, find your singer in the left panel.
2. Click the **+** button on the singer's row.
3. A new fragment appears on the timeline (right side).
4. Drag the fragment to reposition it on the timeline. Drag its edges to resize.

---

## Step 5: Edit the Fragment (Piano Roll)

Double-click a fragment to open the **Fragment Editor** — a full piano-roll editor.

### Adding Notes

1. Click on the piano roll grid to create a note. Drag to set the note length.
2. Each note must have a **lyric**:
   - **Chinese**: Type Chinese characters or Pinyin.
   - **English**: Type English words.
   - Double-click a note to edit its lyric.

### Editing Notes

- **Move**: Drag a note up/down (pitch) or left/right (timing).
- **Resize**: Drag the right edge of a note.
- **Delete**: Select notes and press `Delete`.
- **Select multiple**: Middle-click drag to box-select. `Shift+click` to add to selection. `Ctrl+click` to toggle selection.
- **Duplicate**: Select notes and press `Ctrl+D`.
- **Arrow keys**: Move selected notes by semitone (↑↓) or time unit (←→). Hold `Shift` for octave/beat movement.

### Pitch Curves (Optional)

Switch to **Pitch** mode (press `2` or click the Pitch button):

- **Click** to add anchor points.
- **Drag** anchor points to adjust pitch bend.
- **Right-click** an anchor to delete it.
- **Shift+drag** to use brush mode for freehand drawing.
- **Reset** to clear all pitch modifications and return to the MIDI-based auto curve.

A smoothing slider controls how much the brush strokes are smoothed.

### Volume and Pan Envelopes

Press `3` for **VOL** mode or `4` for **PAN** mode:

- Click to add control points on the envelope curve.
- Drag points to adjust values.
- Right-click to delete points.

### Phoneme Editing

Press `5` or click the **Phoneme** tab:

- View the auto-generated phoneme breakdown for each note.
- Drag phoneme boundaries to adjust duration ratios between adjacent phonemes.
- Click a phoneme and drag up/down to adjust its volume.
- Right-click a phoneme to toggle lock (prevents auto-adjustment).

### Saving and Closing

- Press `Ctrl+S` or click **Save** (💾).
- Click **Close** (✖) to return to the main window.

---

## Step 6: Synthesize and Listen

Back in the main window:

1. Press **▶ Play** in the toolbar.
2. The first synthesis takes longer as the SVS pipeline initializes (loads all 9 ONNX models into GPU memory).
3. Subsequent plays are faster — the pipeline stays loaded.
4. Use **⏸ Pause** and **⏹ Stop** to control playback.

> **Tip**: You can also press **▶ Play** inside the Fragment Editor to preview just that fragment. This uses the "Preview Inference Parameters" from Settings (fewer diffusion steps = faster but lower quality).

---

## Step 7: Export

1. Click **📤 Export** in the main window toolbar.
2. The entire project is synthesized at export quality (using "Export Inference Parameters" from Settings — more diffusion steps = higher quality).
3. Choose a save location for the WAV file.
4. The exported file is 24kHz 16-bit PCM WAV.

---

## Step 8: Save Your Project

- Click **💾 Save** or press `Ctrl+S`.
- Choose a save location. The project is saved as `.sxsproj`.
- **Optional**: Check "Embed singer files into project file" to make the project self-contained (larger file size but no external singer file dependencies).

---

## What's Next?

- **[User Guide](User-Guide)** — Detailed documentation of every feature
- **[FAQ](FAQ)** — Common questions and troubleshooting
- **Settings** — Adjust inference hardware, audio output, themes, and more
