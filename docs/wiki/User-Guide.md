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

Download the latest installer from the [download page](https://share.weiyun.com/2pgoQsmL) and run the setup executable.

### macOS / Linux

SXSEditor supports macOS and Linux via Electron Forge. Please build from source — see the [Developer Guide](Developer-Guide).

---

## Creating a Project

1. Launch SXSEditor.
2. Set your project **BPM** and **time signature** in the toolbar.
3. Add a singer by clicking the **+** button in the singer panel.
4. Choose to **create a new singer** or **open an existing** `.sxssinger` file.

---

## Managing Singers

### Creating a Singer

1. Open the **Singer Creator** window.
2. Enter a singer name and choose a color.
3. Load a reference audio file (WAV) — this is the voice the model will mimic.
4. Optionally add an avatar image.
5. Run **Audio Preprocessing** to extract F0 and note data from the reference audio.
6. Save the singer as a `.sxssinger` file.

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

- **Add notes**: Click on the piano roll grid to create notes
- **Edit note properties**: Adjust pitch, duration, and timing
- **Input lyrics**: Enter lyrics for each note
  - **Chinese**: Supports both Pinyin (e.g., `ni hao`) and Chinese characters (e.g., `你好`)
  - **English**: Standard English lyrics
- **Draw pitch curves**: Use the pitch envelope editor for expressive control
- **Adjust envelopes**: Fine-tune volume and other parameters

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
- GPU acceleration will be used automatically if available

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

Device settings take effect after restarting the pipeline.