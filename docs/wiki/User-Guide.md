# User Guide

## Table of Contents

1. [Installation](#installation)
2. [Creating a Project](#creating-a-project)
3. [Managing Singers](#managing-singers)
4. [Editing Fragments](#editing-fragments)
5. [Synthesis & Playback](#synthesis--playback)
6. [Exporting](#exporting)
7. [Settings](#settings)

---

## Installation

### Windows

Download the latest installer from the [releases page](https://github.com/Henley04/SXSEditor/releases/download/EA/sxsinstaller_x64_no_models.exe) and run the setup executable.

### macOS / Linux

SXSEditor does not supports macOS and Linux currently. However, it's possible to build for macOS and Linux. Please build from source — see the [Developer Guide](Developer-Guide).

---

## Creating a Project

1. Launch SXSEditor.
2. Set your project **BPM** and **time signature** in the toolbar(optional).
3. Add a singer by clicking the **+** button in the singer panel.
4. Choose to **create a new singer** or **open an existing** `.sxssinger` file.

---

## Managing Singers

### Creating a Singer

1. Open the **Singer Creator** window.
2. Enter a singer name and choose a color.
3. Load a reference audio file (WAV)(vocal only) — this is the voice the model will mimic.
4. Optionally add an avatar image.
5. Run **Audio Preprocessing** to extract F0 and note data from the reference audio.
6. Edit the midi notes' lyrics to your wav, and check if midi matches the wav.
7. Save the singer as a `.sxssinger` file.

### Singer File Format (`.sxssinger`)

Singer files contain:
- Singer metadata (name, color, avatar)
- Reference audio features (F0, mel-spectrogram)
- Preprocessing configuration

---

## Editing Fragments

### Adding a Fragment

1. Click the **+** button on a singer row to add a new fragment.
2. Double-click a fragment to open the **Fragment Editor**.

### Piano Roll Editor

In the fragment editor you can:

- **Add notes**: Click on the piano roll grid to create notes. Drag to control the length.
- **Edit note properties**: Adjust pitch, duration, and timing
- **Input lyrics**: Double click to enter lyrics for each note
  - **Chinese**: Supports Chinese characters  only(e.g., `你好`), pinyin is not supported. All Alphabet will be recognized as EN.
  - **English**: Standard English lyrics to phonemeon via cmudict.
- **Draw pitch curves**: Use the pitch envelope editor for expressive control(experimental)
- **Adjust envelopes**: Fine-tune volume and other parameters
- **Adjust phonemeon**: keyboard input '5' or click phonemeon button to open phonemeon editor on bottom.

### Saving

Save the fragment to return to the main timeline.

---

## Synthesis & Playback

1. Press the **▶ Play** button to synthesize and play the entire project.
2. The editor will automatically initialize the SVS pipeline and generate audio.
3. Use **⏸ Pause** and **⏹ Stop** to control playback.

### Tips

- First-time synthesis may take a moment as the model loads
- Subsequent playbacks will be faster
- GPU acceleration will be used automatically if available(a good enough GPU is strongly recommended)

---

## Exporting

1. Click the **📤 Export** button.
2. The project will be synthesized and mixed.
3. Choose a location to save the final **WAV** file.

**Audio Specifications**:
- Sample Rate: 24000 Hz
- Format: WAV (16-bit PCM)

---

## Settings

Open **Settings** from the menu to configure:

| Setting | Description |
|---------|-------------|
| Inference Device | Select a specific DirectML GPU or use automatic selection |

-Device settings take effect after restarting the pipeline.
-Languages of Ui for choose:Simplified Chinses/English.
-Parameter of inference: balance the generate speed and audio quality.
-Model precision: accelerate inference greatly through lower quality. INT8 is better for CPU/NPU(**still in development**). FP is better for GPU.