# User Guide

Complete documentation of all SXSEditor features.

## Table of Contents

1. [Main Window](#main-window)
2. [Singer Management](#singer-management)
3. [Singer Creator](#singer-creator)
4. [Audio Preprocessing](#audio-preprocessing)
5. [Fragment Timeline](#fragment-timeline)
6. [Fragment Editor (Piano Roll)](#fragment-editor-piano-roll)
7. [MIDI Editing](#midi-editing)
8. [Lyrics and Phonemes](#lyrics-and-phonemes)
9. [Pitch Curves](#pitch-curves)
10. [Volume and Pan Envelopes](#volume-and-pan-envelopes)
11. [Synthesis and Playback](#synthesis-and-playback)
12. [Export](#export)
13. [Audio to MIDI](#audio-to-midi)
14. [MIDI Import](#midi-import)
15. [Settings](#settings)
16. [Model Download](#model-download)
17. [Resource Manager](#resource-manager)
18. [Themes](#themes)
19. [Project Files](#project-files)
20. [Keyboard Shortcuts](#keyboard-shortcuts)
21. [Uninstall](#uninstall)

---

## Main Window

The main window is the central hub. It contains:

### Toolbar (Top)

| Control | Description |
|---------|-------------|
| ▶ Play / ⏸ Pause / ⏹ Stop | Playback controls for the entire project |
| Time Display | Shows current playback position (mm:ss:ms) |
| BPM | Beats per minute (1–999). Default: 120 |
| Time Signature | Numerator / Denominator (e.g., 4/4) |
| Auto Shift | When enabled, notes in newly created fragments auto-align to beat boundaries |
| 📂 Load | Open an existing `.sxsproj` or `.sxs` project file |
| 📤 Export | Synthesize and export the entire project as WAV |
| 🎵 Audio to MIDI | Convert an audio file to MIDI notes (see [Audio to MIDI](#audio-to-midi)) |
| Version Display | Shows the current app version |

> **Saving the project file** is done via the **File menu** (Ctrl+S / Ctrl+Shift+S), not a toolbar button. See [Save Logic](#save-logic) for the complete save behavior.

### Singer Panel (Left)

Lists all singers in the project. Each singer row shows:
- Singer name and color/avatar
- A **+** button to add fragments to this singer
- A context menu (right-click) for singer operations

### Fragment Timeline (Right)

A canvas-based timeline showing all fragments arranged by time. Each fragment is a colored rectangle representing a segment of music.

- **Double-click** a fragment to open the Fragment Editor.
- **Drag** a fragment to move it in time or across singers.
- **Drag edges** to resize a fragment.
- The playhead shows the current playback position.

---

## Singer Management

### Adding a Singer

Click the **+** button in the singer panel header. A dialog offers:

- **Open Singer Creator**: Create a new singer from scratch.
- **Open Existing Singer File**: Load a `.sxssinger` file from disk.

### Singer Status Indicators

- Normal: Singer loaded and ready.
- ⚠ Singer file not found: The `.sxssinger` file was moved or deleted. Use **Relocate** to point to the new location.

### Deleting a Singer

Right-click a singer and select **Delete Singer**. This removes the singer and all its fragments from the project.

### Singer File Validation

When loading a `.sxssinger` file, SXSEditor validates:
- File format and version compatibility
- Required fields (name, reference audio)
- Data integrity (MIDI notes, F0 data)

Validation errors are shown in a report dialog. Warnings indicate non-critical issues (e.g., missing optional fields, version mismatch).

---

## Singer Creator

The Singer Creator is a dedicated window for creating new singers. It has three sections:

### Basic Info

- **Singer Name**: Required. Used for display and file naming.
- **Avatar**: Choose between:
  - **Color**: A solid color used as the singer's identifier on the timeline.
  - **Image**: Upload a picture file (any common image format).

### Reference Audio (WAV)

Upload a WAV file that serves as the voice reference for the SVS model.

**Requirements**:
- **Format**: `.wav` only
- **Duration**: Maximum 30 seconds. If exceeded, a trim dialog opens.
- **Content**: **Pure vocals only.** This is the most important requirement.
  - No background music
  - No instrumental accompaniment
  - No reverb, echo, or other audio effects
  - No multiple voices
  - Clean, dry vocal recording only
- **Sample Rate**: 44100 Hz recommended (other rates are accepted)
- **Quality**: Minimal background noise, clear articulation

**Why pure vocals matter**: The model learns voice characteristics from this audio. Any non-vocal content (music, noise, effects) will be learned as part of the voice and will appear as artifacts in synthesized output.

After uploading:
- A waveform visualization appears.
- **Preview** button plays the audio.
- **Clear** button removes the audio and lets you upload a different file.

### WAV Trim Dialog

If the WAV file exceeds 30 seconds:
- A waveform with a selection overlay appears.
- **Drag** the selection to choose which 30-second segment to use.
- **Drag edges** of the selection to adjust start/end.
- Enter exact values in the **Start Position** and **Clip Length** fields.
- **Preview Clip** plays the selected segment.
- **Confirm Trim** applies the trim.
- **Cancel** discards the file entirely.

### Singer Preview

The right panel shows a live preview of how the singer will appear:
- Avatar (color or image)
- Singer name
- WAV status badge (✓ when audio is loaded)
- Preprocess status badge (✓ when preprocessing is complete)

### Audio Preprocessing

Click **Start Audio Preprocessing** to open the preprocessing window. This step extracts musical data from the reference audio. See [Audio Preprocessing](#audio-preprocessing).

### Creating and Saving

Click **Create & Save** (✓):
- Requires a WAV file to be loaded.
- If preprocessing was completed, the preprocessed data is included.
- Saves as a `.sxssinger` file (JSON format with base64-encoded audio).

---

## Audio Preprocessing

The Audio Preprocessing window extracts MIDI notes and F0 (fundamental frequency) data from the reference audio. This data is used by the SVS model to understand the singer's vocal characteristics.

### Window Layout

- **Top**: WAV waveform display with playback controls.
- **Middle**: MIDI editor canvas showing extracted notes.
- **Bottom**: F0 fundamental frequency curve (read-only).

### Step 1: Extract F0

Click **RMVPE Extract F0**:
- Uses the RMVPE neural model to detect pitch from the audio.
- The F0 curve appears in the bottom panel.
- This is a read-only visualization of the detected pitch contour.

### Step 2: Extract MIDI Notes

Click **Extract MIDI**:
- Uses Basic Pitch (recommended) to detect note boundaries and pitches.
- Extracted notes appear on the MIDI canvas.
- Note count is displayed.

Alternatively, click **Import MIDI** to load notes from an existing `.mid` or `.midi` file. This replaces any notes currently on the canvas. Standard MIDI files (format 0/1/2, including SMPTE and multi-track) are supported; drum tracks (channel 10) are filtered out automatically.

### Step 3: Edit MIDI Notes

**This step is mandatory.** Auto-extracted MIDI is approximate. You must verify and correct it:

1. **Check each note's pitch**: Does the detected MIDI pitch match the actual sung note?
2. **Check note boundaries**: Do note starts and ends align with the actual singing?
3. **Check note count**: Are all sung notes detected? Are there false detections?

Edit operations:
- **Move notes**: Drag up/down (pitch) or left/right (timing).
- **Resize notes**: Drag the right edge.
- **Add notes**: Click on empty space.
- **Delete notes**: Select and press `Delete`.
- **Edit lyrics**: Double-click a note. **You must type the lyrics yourself** — they are not auto-detected.

### Step 4: Fill in Lyrics

**Every note must have a lyric.** The preprocessing does not detect lyrics from audio. You must manually type them:

- For **Chinese singing**: Enter Chinese characters (e.g., `我`, `你`, `好`). You may append a digit `1`–`5` after a character to force a specific tone (e.g., `你2 好3`). Pinyin is **not** accepted.
- For **English singing**: Enter the English word being sung (e.g., `hello`, `love`).
- For notes with no sung content (rests, breaths): Leave the lyric empty or use a space.

### Step 5: Save

Click **Save** (💾):
- Requires at least F0 or MIDI data to be extracted.
- Saves all preprocessed data back to the Singer Creator window.
- The Singer Creator preview updates to show "Preprocess ✓".

### Important Notes

- The F0 curve is **read-only** — you cannot edit it directly.
- MIDI note editing affects only the note data, not the F0 curve.
- If you are unhappy with the extraction results, you can re-extract (this overwrites previous results).
- The preprocessing window communicates with the Singer Creator via IPC — data is sent back when you save.

---

## Fragment Timeline

The fragment timeline in the main window shows all fragments arranged across singers and time.

### Creating Fragments

Click the **+** button on a singer row to add a new fragment. The fragment is created at the current scroll position.

### Moving Fragments

- **Drag** a fragment to move it horizontally (time) or vertically (to a different singer).
- When Auto Shift is enabled, fragments snap to beat boundaries.

### Resizing Fragments

- Drag the **left or right edge** of a fragment to change its start time or duration.
- Fragment boundaries are shown as beat positions.

### Opening the Fragment Editor

**Double-click** a fragment to open it in the Fragment Editor.

### Fragment Properties

Each fragment stores:
- Start time (in beats)
- Duration (in beats)
- Assigned singer ID
- MIDI notes with lyrics
- Pitch curve (optional)
- Volume and pan envelopes

---

## Fragment Editor (Piano Roll)

The Fragment Editor is a dedicated window with a full-featured piano-roll editor. It opens when you double-click a fragment.

### Auto-Sync to Main Window

**Edits in the Fragment Editor are automatically synced to the main window — there is no Save button.** After any edit (MIDI notes, lyrics, pitch curve, envelopes, phoneme parameters), a 500ms debounced auto-save fires, which:

1. Sends the updated fragment data to the main process via IPC (`saveFragmentData`).
2. The main process forwards the data to the main window (`fragmentDataSaved` event).
3. The main window updates the corresponding fragment in `trackManager.fragments`, refreshes the timeline (`refreshAll`), and auto-saves the project file (if a `.sxsproj` path is already set).

**Ctrl+S** in the Fragment Editor cancels the debounce timer and pushes the update immediately (force-sync). This is optional — the auto-save already handles sync.

### Window Layout

- **Toolbar** (top): Play, Export, Import MIDI, mode switching, close.
- **Piano keys** (left): Vertical pitch reference.
- **Piano roll** (center): The main editing canvas.
- **Inspector** (right): Shows properties of the selected note or singer info.
- **Parameter panel** (bottom): VOL, PAN, Phoneme, and (future) Timbre lanes.
- **Status bar** (bottom): Shows pipeline status, sample rate, hop size, and auto-sync indicator.

### Toolbar Controls

| Control | Description |
|---------|-------------|
| ▶ Play | Synthesize and play this fragment |
| ⏸ Stop | Stop playback |
| 💿 Export | Export this fragment as WAV |
| 🎵 Import MIDI | Import a standard MIDI file |
| Auto Shift | Auto-align notes to beat grid |
| MIDI button (1) | Switch to MIDI editing mode |
| Pitch button (2) | Switch to pitch curve editing mode |
| ⌨ (F1) | Show keyboard shortcuts overlay |
| ✖ Close | Close the fragment editor (auto-syncs before closing) |

### Inspector Panel

The right-side inspector shows:

- **Singer info**: Name, avatar, and description of the assigned singer.
- **Note properties** (when a note is selected):
  - Pitch (MIDI note name and frequency)
  - Start position (in beats)
  - Duration (in beats)
  - Lyric (editable text field)
- **Phoneme info**: Auto-generated phoneme breakdown for the selected note.

### Parameter Panel

The bottom panel has tabs for different parameter lanes:

- **VOL**: Volume envelope curve.
- **PAN**: Stereo pan envelope curve.
- **Phoneme**: Phoneme-level editing (duration ratios, per-phoneme volume, lock).
- **Timbre**: (Coming soon) Timbre expression controls.

---

## MIDI Editing

### Adding Notes

- **Click** on empty space in the piano roll to create a note.
- **Drag** while clicking to set the initial note length.
- Notes snap to the beat grid based on the current zoom level.

### Selecting Notes

- **Click** a note to select it (deselects others).
- **Ctrl+click** to toggle a note's selection state.
- **Shift+click** to add a note to the current selection.
- **Middle-click drag** to box-select notes within a rectangle.
- **Shift+middle-click drag** to append a box selection.
- **Ctrl+A** to select all notes.
- **Escape** to deselect all.

### Moving Notes

- **Drag** a selected note to move it.
- **Arrow keys** (↑↓): Move selected notes by one semitone.
- **Arrow keys** (←→): Move selected notes by one time unit.
- **Shift+↑↓**: Move by one octave (12 semitones).
- **Shift+←→**: Move by one beat.

### Resizing Notes

- Drag the **right edge** of a note to change its duration.

### Deleting Notes

- Select notes and press **Delete**.

### Duplicating Notes

- Select notes and press **Ctrl+D**. Duplicates are placed after the originals.

### Editing Lyrics

- **Double-click** a note to edit its lyric inline.
- Type the lyric and press **Enter** to confirm, or **Escape** to cancel.
- You can also edit lyrics in the Inspector panel's lyric field.

---

## Lyrics and Phonemes

### Lyric Input Rules

- **Chinese**: Enter Chinese characters (e.g., `你好世界`). You may append a digit `1`–`5` after a character to force a specific tone (e.g., `你2 好3`), where 1–4 are the four tones and 5 is the neutral tone (轻声). The system uses `pinyin-pro` to convert characters to Pinyin (with the forced tone if a digit is present), then to `zh_*` phonemes. Pinyin text (e.g., `ni hao`) is **not** accepted as Chinese — ASCII input is routed to the English G2P path.
- **English**: Enter standard English words (e.g., `hello`, `love`). The system uses a built-in CMU pronunciation dictionary (126,000 words) to convert to phonemes. Unknown words fall back to letter-by-letter phoneme estimation.
- **Special tokens**: Empty lyrics are treated as `<SP>` (short pause/silence).

### Phoneme Editing

Switch to Phoneme mode (press `5` or click the Phoneme tab):

- **View phonemes**: Each note is automatically split into its constituent phonemes.
- **Adjust boundaries**: Drag the boundary between two phonemes to change their relative duration. The total note duration stays the same.
- **Adjust volume**: Click a phoneme and drag up/down to change its relative volume.
- **Lock phonemes**: Right-click a phoneme to toggle lock (marked with "L"). Locked phonemes are not affected by auto-adjustment when you edit lyrics.

### Slur Notes

A **slur** (continuation) note is a note that continues the previous note's sound without re-attacking. To create a slur:
- Add a note with an empty lyric (or a dash `-`). It will be treated as a continuation of the previous note.

### Kanji / Kana Auto-Grouping

When a fragment already contains Japanese kana (hiragana or katakana) in any note's lyric, every single-character kanji note in the same fragment is **automatically treated as Japanese** and split into an ordered group of kana notes. This avoids the ambiguity of using the same CJK ideographs for both Chinese and Japanese within one fragment.

- **Visual bracket** — a horizontal bracket is drawn above the group with the original kanji displayed in the middle, so you can always see which kana belong to which kanji.
- **Strict ordering** — the converted kana keep their dictionary order. You cannot insert other MIDI notes inside a group's time span.
- **Movement** — kana notes can be moved in pitch and time, but they cannot be deleted individually.
- **Whole-group deletion** — deleting any kana in a group removes the entire group (all kana in that kanji).
- **Right-click toggle** — right-click the bracket, the kanji label, or any kana inside the group to open the *Kanji Settings* menu. Choose **Set as Chinese** to merge the whole group back into a single kanji note (length = total group span, pitch = right-clicked note's pitch); choose **Set as Japanese** to split it again.
- **Manual override persists** — once you manually set a kanji to Chinese, it will not be auto-split again even if the fragment still contains kana.

---

## Pitch Curves

Pitch curves add vibrato, pitch slides, and other expressive effects on top of the base MIDI pitch.

### Switching to Pitch Mode

Press `2` or click the **Pitch** button in the toolbar. The pitch curve editing tools appear.

### Anchor Points

- **Click** to add an anchor point on the pitch curve.
- **Drag** an anchor to move it (changes both time and pitch offset).
- **Right-click** an anchor to delete it.
- **Select** anchors with box-select (middle-click drag).
- **Delete** selected anchors with the Delete key.
- **Arrow keys** move selected anchors.

### Brush Mode

- **Shift+drag** to draw freehand pitch curves.
- The **Smoothing** slider (0–100) controls how much brush strokes are smoothed. Higher = smoother curves.

### Reset

Click **↺ Reset** to clear all pitch curve modifications and return to the auto-generated curve based on MIDI notes.

### Pitch Curve Data

The pitch curve consists of:
- **Anchor points**: Fixed points with time and pitch offset values.
- **Brush segments**: Freehand-drawn segments (stored as sequences of points).

The final pitch is: MIDI note pitch + pitch curve offset.

---

## Volume and Pan Envelopes

### Volume (VOL)

Press `3` or click the **VOL** tab:
- The volume envelope controls loudness over time.
- Default: constant volume of 1.0 (100%).
- Click to add control points. Drag to adjust.
- Range: 0.0 (silent) to 1.0 (full volume).

### Pan (PAN)

Press `4` or click the **PAN** tab:
- The pan envelope controls stereo position.
- Default: centered (0.0).
- Range: -1.0 (full left) to 1.0 (full right).

### Envelope Editing

- **Click** on the envelope area to add a control point.
- **Drag** a point to move it.
- **Right-click** a point to delete it.
- Points are connected by smooth curves.

---

## Synthesis and Playback

### How Synthesis Works

When you press Play, SXSEditor:

1. **Prepares input**: Collects MIDI notes, lyrics, pitch curve, and singer data.
2. **Processes text**: Converts lyrics to phoneme sequences using language-specific processing.
3. **Encodes**: Runs 5 encoder models (text, pitch, note type, F0, condition embedding).
4. **Runs diffusion**: Iteratively denoises a mel spectrogram using the diffusion model.
5. **Vocalizes**: Converts the mel spectrogram to a waveform using the vocoder.
6. **Plays audio**: Outputs the waveform through the audio system.

### Preview vs Export Quality

| Parameter | Preview | Export |
|-----------|---------|--------|
| Diffusion Steps | 16 (default) | 32 (default) |
| CFG Strength | 3.0 | 3.0 |
| CFG Rescale | 0.75 | 0.75 |
| Sampler | Euler (default) | Euler (default) |

Preview uses fewer steps for faster response. Export uses more steps for higher quality. Both are configurable in Settings. The Sampler (diffusion ODE solver) is also configurable per path — see [Diffusion Sampler](#diffusion-sampler).

### Playback Controls

- **▶ Play**: Start synthesis and playback. On first play, the SVS pipeline initializes (loads models into GPU).
- **⏸ Pause**: Pause playback. Resume from the paused position.
- **⏹ Stop**: Stop playback and reset to the beginning.

### Fragment-Level Playback

In the Fragment Editor, **▶ Play** synthesizes and plays only the current fragment. This is useful for quick previews while editing.

---

## Export

### Exporting a Fragment

In the Fragment Editor, click **💿 Export**:
1. The **Export dialog** opens, pre-filled with the export-quality parameters from Settings. You can override them for this export only: **Sampler**, Diffusion Steps, CFG Strength, CFG Rescale, Auto Shift, plus advanced options (the global Settings values are not changed).
2. After confirming, the fragment is synthesized using the chosen parameters.
3. A file save dialog appears.
4. Choose a location and filename.
5. The WAV file is saved (24kHz, 16-bit PCM).

### Exporting the Entire Project

In the main window, click **📤 Export**:
1. The **Export dialog** opens (same options as single-fragment export: Sampler, Diffusion Steps, CFG, Auto Shift, advanced).
2. All fragments are synthesized sequentially using the chosen parameters.
3. Fragments are mixed together according to their timeline positions.
4. A file save dialog appears.
5. The mixed WAV file is saved.

### Export Progress

During export, a progress indicator shows:
- Current fragment being processed.
- Overall progress percentage.
- Status messages (preparing, synthesizing, encoding WAV, saving).

---

## Audio to MIDI

Convert an existing audio file into MIDI notes on a new track.

### Starting Audio to MIDI

Click **🎵 Audio to MIDI** in the main toolbar. A dialog offers:

- **Extract Pitch (RMVPE)**: Extracts MIDI notes AND an F0 pitch curve. The pitch curve is applied to the fragment.
- **MIDI Only**: Extracts only MIDI notes without a pitch curve.

### Supported Audio Formats

WAV, MP3, FLAC, OGG, AAC, M4A.

### Extraction Process

1. Select an audio file.
2. The system decodes the audio.
3. Based on your Settings, either **Basic Pitch** or **RMVPE** is used for extraction:
   - **Basic Pitch** (recommended): Neural network-based, stable results.
   - **RMVPE**: Converts F0 pitch curve to notes. Experimental, results may vary.
4. A new singer track and fragment are created with the extracted notes.
5. If you chose "Extract Pitch", the F0 curve is also applied as a pitch curve.

### After Extraction

- The new track has no singer file assigned. You must select a `.sxssinger` file for it before synthesis.
- Review and edit the extracted notes — auto-extraction is approximate.

---

## MIDI Import

Import a standard MIDI file into the Fragment Editor.

### Importing

1. Open a fragment in the Fragment Editor.
2. Click **🎵 Import MIDI** in the toolbar.
3. Select a `.mid` or `.midi` file.
4. The MIDI file's notes are loaded into the fragment, replacing existing notes.

### MIDI File Handling

- Standard MIDI files (format 0, 1, 2) are supported, including SMPTE time division.
- Multi-track MIDI files: all non-drum tracks are merged onto a single timeline. Drum tracks (MIDI channel 10) are automatically filtered out.
- Lyrics from MIDI (meta event 0x05) are preserved if present.
- Note timing is converted to the project's BPM.

---

## Settings

Open Settings from the menu bar: **SXSEditor > Settings**.

### General

#### Language
- **Chinese (简体)** / **English**
- Requires app restart to take effect.

#### Theme
- Select from built-in and user themes.
- Changes apply immediately to all windows (hot-swap, no restart needed).
- See [Themes](#themes) for details.

### Inference

#### Inference Hardware

Configure which hardware devices are used for neural network inference.

**Device Modes**:
- **Smart Mode** (recommended): Automatically selects the best device and assigns models optimally. Prefers discrete GPU; falls back to integrated GPU or CPU.
- **Manual Mode**: Specify a single device for all models.
- **Advanced Mode**: Assign different devices to different model groups (SVS Diffusion, SVS Encoder, SVS Auxiliary, RMVPE).

**Available devices**:
- Discrete GPU (NVIDIA, AMD, Intel) via DirectML
- Integrated GPU via DirectML
- NPU via WebNN
- CPU (fallback)

**WebNN/NPU Status**: The settings page shows whether WebNN and NPU are available on your system.

#### Preview Inference Parameters

Used when playing back in the editor (fast preview):

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| Diffusion Steps | 16 | 4–64 | Fewer steps = faster, lower quality |
| CFG Strength | 3.0 | 0–10 | Higher = more aligned with conditions. 0 = skip unconditional prediction (2x speed) |
| CFG Rescale | 0.75 | 0–1 | Mitigates over-guidance artifacts |
| Sampler | Euler | Euler / Heun / Extrapolated Euler / STORK-2 | Diffusion sampling solver. See [Diffusion Sampler](#diffusion-sampler) below. |

#### Export Inference Parameters

Used when exporting WAV files (high quality):

| Parameter | Default | Range | Description |
|-----------|---------|-------|-------------|
| Diffusion Steps | 32 | 4–64 | More steps = higher quality |
| CFG Strength | 3.0 | 0–10 | Same as preview |
| CFG Rescale | 0.75 | 0–1 | Same as preview |
| Sampler | Euler | Euler / Heun / Extrapolated Euler / STORK-2 | Diffusion sampling solver. The export dialog also lets you override this per export. |

#### Diffusion Sampler

The diffusion model iteratively denoises a mel spectrogram by integrating the flow-matching velocity-field ODE. The **sampler** is the ODE solver that decides how each denoising step combines model evaluations (NFE = number of function evaluations) into the state update. Four samplers are available, selectable independently for preview and export:

| Sampler | NFE / step | Description |
|---------|------------|-------------|
| **Euler** (default) | 1 | First-order explicit Euler, midpoint time evaluation. The original baseline; fastest and most predictable. |
| **Heun** | 2 | Second-order improved Euler (trapezoidal rule). Higher accuracy, roughly 2× inference time. Falls back to Euler on the final step to avoid evaluating `t > 1`. |
| **Extrapolated Euler** | 1 | Velocity-extrapolation heuristic inspired by STORK (ICLR 2026). Reuses the previous step's velocity for linear extrapolation. Not the full stabilized RK formulation; benefit is heuristic and strongest when the velocity field changes smoothly. Falls back to Euler when extrapolation is unsafe (amplitude / sign-flip / NaN guards). |
| **STORK-2** | 1 | Paper-faithful Stabilized Taylor Orthogonal Runge-Kutta (Tan et al., ICLR 2026, arXiv:2505.24210). Runge-Kutta-Gegenbauer 2nd-order recurrence with 8 sub-stages and Taylor-expansion virtual NFE. Designed for stiff ODEs with an extended stability region (~2s² = 128×). Tradeoff: higher per-step algebraic cost than Euler. |

> **Note**: Extrapolated Euler and STORK-2 carry cross-step velocity state. In **chunked preview inference** (long fragments split into chunks), this state resets at every chunk boundary, reducing their benefit — for chunked previews, Euler or Heun is usually the safer choice. The sampler setting is stored in `previewSampler` / `exportSampler`; the legacy value `stork` is silently mapped to `extrap` for backward compatibility.

#### NPU Inference Settings

Only relevant when using NPU (WebNN) for inference:

| Parameter | Default | Description |
|-----------|---------|-------------|
| Diffusion Batch Size | 4 | Batch size for diffusion model. batch=4 processes 2 segments simultaneously. |
| Vocoder Batch Size | 4 | Batch size for vocoder. batch=4 processes 4 audio chunks simultaneously. |

These settings only affect the NPU path. DirectML and CPU paths are unaffected.

### Audio

#### Output Mode
- **Shared Mode** (WASAPI Shared): Standard Windows audio. Other apps can play audio simultaneously.
- **Exclusive Mode** (WASAPI Exclusive): Direct hardware access. Lower latency (1–3ms), bit-perfect output, but blocks other apps from using the audio device.

#### Output Device
- **System Default** or a specific audio device.
- Exclusive mode only supports WASAPI devices.

#### Sample Rate
Options: 22050, 24000 (native), 44100, 48000, 96000, 192000 Hz.
- In exclusive mode, the device must support the selected rate or it falls back to shared mode.

#### Bit Depth
Options: 32-bit Float (recommended), 32-bit Integer, 24-bit Integer, 16-bit Integer.
- Only applies in exclusive mode.

#### Buffer Size
Options: 64 to 4096 samples.
- Smaller = lower latency but higher CPU load and risk of audio glitches.
- Recommended: 256 or below in exclusive mode.

#### Master Volume
Slider from 0% to 100%.

### Audio: MIDI Extraction Tool

- **Basic Pitch** (recommended): Neural network-based MIDI extraction.
- **RMVPE (experimental)**: F0-to-notes conversion. May produce suboptimal results.

### Model

#### Model Precision

Select which precision of ONNX models to use:
- FP16, FP32, INT8, INT8-NPU
- Different precisions are stored independently and coexist.
- Switching does not require re-downloading — each precision has its own subdirectory.
- See the precision info box in Settings for detailed descriptions.

#### Model Status

A list shows the status of each model group:
- ✅ Ready: All files present.
- ❌ N files missing: Some model files are not downloaded.

#### Open Model Download

Opens the model download window to download or update model files for the selected precision.

---

## Model Download

The Model Download window handles downloading ONNX model files from ModelScope.

### When It Appears

- Automatically on first launch if models are missing.
- Manually from Settings > Model > **Open Model Download**.
- When switching to a precision whose models haven't been downloaded yet.

> **Note**: The model download directory defaults to a location that does not require admin privileges. You can change it using the **Change** button.

### Features

- **Precision selection**: Choose which precision to download.
- **Download directory**: Default is the app's model directory. Click **Change** to select a different location.
- **Parallel download**: Up to 16 concurrent chunked connections per file.
- **Progress tracking**: Per-file and overall progress bars.
- **Speed display**: Current download speed.
- **Resume support**: Re-running the download skips completed files.

### Model Groups

| Group | Required | Description |
|-------|----------|-------------|
| SVS Synthesis Pipeline | Yes | Core models for singing synthesis (9 models) |
| RMVPE Pitch Detection | No | F0 extraction for audio preprocessing |
| Basic Pitch MIDI Extraction | No | MIDI note extraction from audio |
| RosVot MIDI Recognition | No | (Currently disabled) Advanced MIDI extraction |
| SVS Japanese Models | No | Japanese-specific encoder and preflow models |

---

## Resource Manager

Open from the menu bar: **Settings > Resource Manager**.

### GPU Info

Shows detected GPU devices:
- Device name and type (Discrete/Integrated)
- VRAM usage (used/total)

### Model Management

Lists all loaded models with options to:
- **Load All**: Load all model groups into GPU memory.
- **Unload All**: Unload all models, freeing VRAM.
- **Load/Unload** individual model groups.

Models are automatically loaded when needed for synthesis. Unloading frees VRAM for other applications.

### Summary

Shows:
- Number of loaded models.
- Estimated VRAM usage.

---

## Themes

SXSEditor has a layered design token system with hot-swappable themes.

### Built-in Themes

| ID | Name | Description |
|----|------|-------------|
| `dark-aurora` | Aurora Dark | Default dark theme with blue-purple accents |
| `light-paper` | Paper Light | Light theme with white background |
| `midnight-amber` | Midnight Amber | Dark theme with warm amber accents |
| `acg` | ACG | Anime/game-inspired color scheme |

### Switching Themes

1. Open **Settings**.
2. Go to the **Theme** section.
3. Select a theme from the dropdown.
4. The change applies immediately to all open windows.

### Editing Themes

Click **Edit Current Theme** to open the visual theme editor:
- Tokens are organized in layers: Global, Alias, Component, Custom.
- Color tokens have HEX/RGB/HSL pickers.
- The editor has its own 20-step undo/redo stack (Ctrl+Z/Ctrl+Y).

### Importing/Exporting Themes

- **Import Theme**: Load a `.theme.json` file.
- **Export Theme**: Save the current theme to a `.theme.json` file.
- **Save As**: Create a new user theme from the current edits.

### User Theme Storage

User themes are stored in:
- Windows: `%APPDATA%\sxseditor\themes\<theme-id>.theme.json`

---

## Project Files

### Save Logic

SXSEditor has three independent save flows. Understanding them avoids confusion about what gets saved and when.

#### 1. Fragment Editor → Main Window (auto-sync, no button)

Every edit in a Fragment Editor window (MIDI notes, lyrics, pitch curve, VOL/PAN envelopes, phoneme parameters) triggers a **500ms debounced auto-save** that pushes the updated fragment data to the main window:

- **Trigger**: Any edit (note move/add/delete, lyric change, pitch anchor edit, envelope edit, phoneme adjustment, MIDI import).
- **Mechanism**: `scheduleAutoSave()` → 500ms debounce → `saveFragmentData()` → IPC `saveFragmentData` → main process → `fragmentDataSaved` event → main window updates `trackManager.fragments` and calls `refreshAll()` + `autoSaveProject()`.
- **No Save button**: The Fragment Editor toolbar does not have a Save button. Sync is fully automatic.
- **Ctrl+S** (optional): Cancels the debounce and pushes immediately (force-sync). Useful if you want to see the change on the timeline instantly without waiting 500ms.
- **Close button**: Auto-syncs before closing the window.

> **Note**: When you load a new `.sxsproj` file, all open Fragment Editor windows are closed automatically. This prevents stale windows from holding references to fragment IDs that no longer exist in the new project (which would cause edits to be silently dropped).

#### 2. Main Window → `.sxsproj` file (project file save)

- **Auto-save**: After each fragment sync (flow #1 above), the main window auto-saves to `state.currentProjectFilePath` if a path is already set (i.e., you have saved or loaded a project at least once). This is silent — no dialog.
- **Manual save** (File → Save / `Ctrl+S`): If a project path exists, writes silently to the same path. If no path exists yet, falls back to Save As.
- **Save As** (File → Save As / `Ctrl+Shift+S`): Opens a dialog with the **embed singer files** option:
  - **Embed**: Singer reference audio and preprocessed data are included in the project file. Makes the project self-contained but larger.
  - **Don't embed**: The project references external `.sxssinger` files by path. Smaller file, but requires singer files to be accessible.
- **Unsaved changes on close**: When closing the main window with unsaved changes, a dialog offers **Save & Exit**, **Don't Save**, or **Cancel**.

#### 3. Singer Creator → `.sxssinger` file (singer file save)

- **Save** (File → Save / `Ctrl+S`): Saves the singer to the existing `.sxssinger` path. If no path exists, falls back to Save As.
- **Save As** (File → Save As / `Ctrl+Shift+S`): Opens a dialog to choose a new `.sxssinger` location.
- **Create & Save** (✓ button): Creates a new singer file. Requires a WAV file to be loaded.
- **Audio Preprocessing → Singer Creator**: The preprocessing window's Save button sends extracted F0/MIDI data back to the Singer Creator via IPC (does not write a file directly).

### Loading Projects

Click **📂 Load** in the toolbar:
- Opens `.sxsproj` or `.sxs` files.
- All open Fragment Editor windows are closed before loading (see flow #1 note above).
- Fragments are normalized via `trackManager.addFragment()` to ensure all fields (`envelopes`, `pitchCurve`, etc.) are present.
- If singer files are embedded, they are loaded directly.
- If not embedded, SXSEditor attempts to load singer files from their stored paths. If files are missing, a warning appears with a **Relocate** option.

### Unsaved Changes

When closing the main window with unsaved changes, a dialog offers:
- **Save & Exit**: Save and close.
- **Don't Save**: Discard changes and close.
- **Cancel**: Stay in the app.

---

## Keyboard Shortcuts

Press **F1** in the Fragment Editor to see the full shortcuts overlay.

> Shortcuts below apply to the **Fragment Editor** window unless noted. Main window shortcuts are accessed via the File menu (Ctrl+S = Save project, Ctrl+Shift+S = Save As).

### General (Fragment Editor)

| Shortcut | Action |
|----------|--------|
| `Ctrl+Z` | Undo |
| `Ctrl+Y` | Redo |
| `Ctrl+S` | Force-sync fragment to main window (cancel 500ms debounce; auto-sync already handles this) |
| `Space` | Play / Stop |
| `1` | Switch to MIDI mode |
| `2` | Switch to Pitch mode |
| `3` | Switch to VOL mode (expands parameter panel) |
| `4` | Switch to PAN mode (expands parameter panel) |
| `5` | Switch to Phoneme mode (expands parameter panel) |
| `F1` | Show shortcuts help |

### Selection

| Shortcut | Action |
|----------|--------|
| Middle-click drag | Box select notes/anchors |
| Shift+Middle-click | Append box select |
| Ctrl+Click | Toggle selection |
| Shift+Click | Append to selection |
| `Ctrl+A` | Select all |
| `Escape` | Deselect all |

### MIDI Editing

| Shortcut | Action |
|----------|--------|
| `↑` `↓` | Move selected notes (semitone) |
| `←` `→` | Move selected notes (time unit) |
| `Shift+↑` `Shift+↓` | Move selected notes (octave) |
| `Shift+←` `Shift+→` | Move selected notes (beat) |
| `Delete` | Delete selected notes |
| `Ctrl+D` | Duplicate selected notes |
| Double-click | Edit note lyric |
| Right-click kanji / kana group | Open Kanji Settings menu (toggle Chinese / Japanese) |

### Pitch Editing

| Shortcut | Action |
|----------|--------|
| Click | Add anchor point |
| Drag anchor | Move anchor point |
| Shift+Drag | Brush mode (freehand draw) |
| Right-click | Delete anchor point |
| `Delete` | Delete selected anchors |
| `↑` `↓` `←` `→` | Move selected anchors |

### Phoneme Editing

| Shortcut | Action |
|----------|--------|
| Click phoneme + drag | Adjust phoneme volume (up/down) |
| Drag boundary | Adjust adjacent phoneme duration ratio |
| Right-click phoneme | Toggle lock (L marker) |
| `5` | Switch to phoneme mode |

### View

| Shortcut | Action |
|----------|--------|
| `Ctrl+scroll` | Horizontal zoom |
| `Shift+scroll` | Horizontal scroll |
| `Scroll` | Vertical scroll |

---

## Uninstall

The default uninstaller only removes the application itself — **downloaded models and user settings are left on disk** and must be cleaned up manually if you no longer need them. ONNX model files can total several GB, so check the model location before uninstalling.

### Step 1: Check your model download location

Before uninstalling, open SXSEditor and confirm where models are stored:

1. Open **Settings > Model** and click **Open Model Download** (or open the Model Download window from the menu).
2. The **Download directory** line shows the current model directory. Write it down or copy it.
3. If you previously clicked **Change** to redirect downloads to a custom folder, that folder is the one you must clean up — not the default location below.

### Step 2: Identify the default model location

If you never changed the download directory, models live in one of the following locations depending on how the app was installed:

| Type | Path | Removed by uninstaller? |
|------|------|-------------------------|
| Bundled models (full installer) | `<install_dir>\resources\app.asar.unpacked\onnx_models\` | Yes |
| Downloaded models (default) | `%APPDATA%\sxseditor\onnx_models\` | **No** — must delete manually |
| Custom directory | The folder you selected via **Change** | **No** — must delete manually |

On a typical Windows install, `%APPDATA%` expands to `C:\Users\<your-username>\AppData\Roaming`. You can paste `%APPDATA%\sxseditor\onnx_models` directly into the File Explorer address bar to jump there.

> **Note**: Downloaded models include subdirectories per precision: `fp16/`, `int8/`, `int8/optimized_npu/`, and a `JP/` subfolder for Japanese models. Each precision is independent, so you can delete one without affecting others.

### Step 3: Delete models to free space

If you no longer need the models, delete the entire model directory identified in Step 1 or Step 2:

- **Default location**: delete the `%APPDATA%\sxseditor\onnx_models\` folder.
- **Custom location**: delete the folder you selected via **Change**.
- **Partial cleanup**: to keep settings but remove only models, delete just the `onnx_models` subfolder and leave the rest of `%APPDATA%\sxseditor\` intact.

> **Tip**: Reinstalling later? Leave the `onnx_models` folder in place — SXSEditor will detect the existing files and skip re-downloading them.

### Step 4: Remove leftover user data (optional)

After uninstalling the app, the following user data remains in `%APPDATA%\sxseditor\`. Delete this folder if you want a fully clean removal:

| File / Folder | Purpose |
|---------------|---------|
| `settings.json` | App settings (audio, inference, theme, etc.) |
| `sxseditor-locale.json` | Language preference |
| `themes\` | User-created or imported themes |
| `onnx_models\` | Downloaded models (see Step 3) |

Leftover installer files in `%TEMP%\sxseditor-update\` are pruned automatically 7 days after they were downloaded, so no manual cleanup is required there.

### Step 5: Run the uninstaller

After backing up or deleting the data above, run the uninstaller:

1. Open **Settings > Apps > Installed apps** (Windows 11) or **Control Panel > Programs and Features** (Windows 10).
2. Find **SXSEditor** and click **Uninstall**.
3. Follow the InnoSetup wizard to complete removal.

> **Note**: The uninstaller removes the application files (including bundled models in `app.asar.unpacked\onnx_models\`) but does **not** delete `%APPDATA%\sxseditor\`. That folder must be removed manually as described in Steps 3 and 4.
