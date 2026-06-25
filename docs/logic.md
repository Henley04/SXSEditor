# SXSEditor: An AI-Powered Singing Voice Synthesis Workbench — System Design, Algorithms, and Implementation

## Abstract

SXSEditor is a desktop application that provides a complete workflow for AI-based Singing Voice Synthesis (SVS). Built on Electron and ONNX Runtime with DirectML acceleration, it integrates a full-score diffusion-based SVS pipeline with an intuitive multi-track editor interface. The system supports MIDI note editing, F0 curve manipulation, envelope-based audio parameter control, singer profile creation from reference audio, and real-time WASAPI audio playback. This paper presents the complete system architecture, core algorithms, implementation details, and experimental results. The underlying SVS engine adopts a conditional diffusion probabilistic model operating on mel-spectrogram latent space, coupled with a neural vocoder for waveform reconstruction, requiring nine ONNX sub-models working in concert.

---

## 1. Introduction

### 1.1 Background and Motivation

Singing Voice Synthesis (SVS) aims to generate natural-sounding singing voices from musical scores (MIDI notes and lyrics). Recent advances in deep generative models—particularly diffusion probabilistic models—have significantly improved the quality of synthesized singing. However, deploying these models remains challenging: GPU-accelerated inference, cross-platform compatibility, and real-time interactive editing are non-trivial engineering problems.

SXSEditor addresses these challenges by providing a complete production-grade SVS workbench with:

- A **conditional diffusion-based SVS pipeline** deployed via ONNX Runtime with DirectML GPU acceleration.
- **Multi-track MIDI editing** with piano roll, pitch curve, and envelope manipulation.
- **Singer profile creation** from reference audio with automatic F0 extraction and MIDI transcription.
- **Real-time audio playback** via WASAPI shared mode (decibri).
- **Internationalization** (Chinese and English) and **hardware resource management**.

### 1.2 Related Work

| System | Type | Strengths | Limitations |
|--------|------|-----------|-------------|
| DiffSinger | Diffusion-based SVS | High quality, open-source | Requires Python ecosystem, limited GUI |
| UTAU | Concatenative SVS | Lightweight, large voicebank ecosystem | Lower naturalness, no AI |
| Synthesizer V | Hybrid SVS | Commercial quality | Proprietary, closed-source |
| ACE Studio | AI SVS | High-quality virtual singers | Proprietary, expensive |
| **SXSEditor** (Ours) | Diffusion-based SVS | Desktop-native, ONNX/DirectML, offline inference, full MIDI editor | Uses pre-trained model (no custom training UI currently) |

SXSEditor distinguishes itself by being a fully offline, GPU-accelerated desktop application with a complete MIDI/audio editor—no cloud dependency, no Python runtime required.

---

## 2. System Architecture

### 2.1 Overall Architecture

SXSEditor follows Electron's two-process architecture:

```
┌─────────────────────────────────────────────────────────────────────┐
│                     Main Process (Node.js)                          │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────────────┐ │
│  │ Window Mgmt   │  │ IPC Handlers │  │   Model Inference Layer   │ │
│  │ (BrowserWin)  │  │              │  │   - OnnxSVSPipeline      │ │
│  │               │  │ - svs:*      │  │   - RmvpePitchDetector   │ │
│  │ - Main Window │  │ - fragment-*│  │   - BasicPitchDetector    │ │
│  │ - Fragment    │  │ - audio:*   │  │   - RosvotDetector        │ │
│  │   Editor      │  │ - model-*   │  └───────────────────────────┘ │
│  │ - Settings    │  │ - file:*    │                                 │
│  │ - Resource    │  │ - extract-* │  ┌───────────────────────────┐ │
│  │   Manager     │  └──────────────┘  │   AudioOutputManager     │ │
│  └──────────────┘                     │   (WASAPI)               │ │
│                                        └───────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────┘
                            │ IPC (contextBridge)
┌─────────────────────────────────────────────────────────────────────┐
│                    Renderer Process (Chromium)                       │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────────────┐   │
│  │ TrackManager    │  │ FragmentTimeline│  │ PlaybackController  │   │
│  │ - Singers       │  │ - Canvas UI     │  │ - AudioContext FP   │   │
│  │ - Fragments     │  │ - Drag/Drop    │  │ - Play/Pause/Seek   │   │
│  │ - Notes         │  │ - Resize/Select│  │ - Playhead Sync     │   │
│  └────────────────┘  └────────────────┘  └──────────────────────┘   │
│  ┌────────────────┐  ┌────────────────┐  ┌──────────────────────┐   │
│  │ Project Manager │  │ HistoryManager │  │ i18n System          │   │
│  │ - Serialization │  │ - Undo/Redo   │  │ - zh-CN / en         │   │
│  │ - File I/O     │  └────────────────┘  └──────────────────────┘   │
│  └────────────────┘                                                │
└─────────────────────────────────────────────────────────────────────┘
```

### 2.2 Process Separation Rationale

- **Main Process**: Handles all ONNX model inference (GPU/CPU), audio output (WASAPI via decibri), file system access, and window management. This separation ensures the renderer remains responsive during heavy computation.
- **Renderer Process**: Handles all UI logic, canvas rendering, and user interaction. Uses `contextBridge` (preload.js) for secure IPC communication.
- **Audio Worker (forked child process)**: A separate Node.js process dedicated to WASAPI audio playback via the `decibri` library, ensuring audio playback is not blocked by IPC or inference.

### 2.3 Hardware Acceleration Strategy

The system uses a hierarchical GPU detection strategy:

1. **Primary**: Via `systeminformation` for GPU enumeration (model, VRAM, vendor, discrete/integrated classification).
2. **Fallback**: Via ONNX Runtime verbose log parsing (`enumerateDMLDevicesInProcess`) when systeminformation is unavailable.
3. **Best GPU Selection**: Prefers discrete GPUs (NVIDIA, AMD Radeon RX/Pro, Intel Arc A-series), sorted by VRAM descending. Falls back to integrated GPU if no discrete GPU is found, then to CPU-only if no GPU is available.
4. **Per-Model Execution Provider**: Each model independently attempts DirectML (DML) first, falls back to CPU if DML validation fails. Models with unsupported ops (e.g., ConvTranspose with stride=480 in vocoder) automatically use CPU.

### 2.4 Model Precision Detection and FP16 Support

Upon initialization, the pipeline dynamically detects model precision by inspecting input tensor types of a probe model (preflow):

- **FP32**: Standard 32-bit float precision.
- **FP16**: Half-precision models for reduced memory bandwidth and faster inference on supported hardware.

A runtime monkey-patch (`patchFloat16Mapping`) fixes `onnxruntime-common`'s type mapping to use `Uint16Array` instead of `Float16Array` for `float16` tensors, resolving a Node.js v24+ compatibility issue where the native C++ binding cannot recognize `Float16Array.buffer`.

---

## 3. Core SVS Pipeline: Algorithms and Methodology

### 3.1 Pipeline Overview

The synthesis pipeline consists of nine ONNX sub-models that form a conditional diffusion probabilistic model operating on mel-spectrogram latent space.

```
  MIDI Notes + BPM + Lyrics
          │
          ▼
┌──────────────────────────┐
│   Phoneme/Lyric → ID    │  (phone_set.json, en_g2p_dict.json)
│   Sequence Construction  │  (BOW, EOW, SEP, PAD tokens)
└──────────────────────────┘
          │
          ▼
┌──────────────────────────┐
│   Encoder Ensemble       │
│  ┌────────────────────┐  │
│  │ noteTextEncoder    │  │  Embedding: [1, T, 512]
│  │ notePitchEncoder   │  │  Embedding: [1, T, 512]
│  │ noteTypeEncoder    │  │  Embedding: [1, T, 512]
│  │ f0Encoder          │  │  Embedding: [1, F, 512]
│  └────────────────────┘  │
│  Sum(token embs) → preflow ──► condEmb → cond [1, F, 1024]
└──────────────────────────┘
          │
          ▼
┌──────────────────────────┐
│   Diffusion Loop         │
│   xt + cond + t ──► pred │  (CFG-guided, K steps)
│   xt ← xt + pred * dt    │
└──────────────────────────┘
          │
          ▼
┌──────────────────────────┐
│   Vocoder                │
│   mel ──► waveform       │  (24kHz output, chunked for long audio)
└──────────────────────────┘
```

### 3.2 Model Specifications

| Model | Input | Output | Dimension | Notes |
|-------|-------|--------|-----------|-------|
| noteTextEncoder | int64[1,T] | float[1,T,512] | Embed dim=512 | Phoneme ID → embedding |
| notePitchEncoder | int64[1,T] | float[1,T,512] | Embed dim=512 | MIDI pitch → embedding |
| noteTypeEncoder | int64[1,T] | float[1,T,512] | Embed dim=512 | Note type → embedding |
| f0Encoder | int64[1,F] | float[1,F,512] | Embed dim=512 | Quantized F0 → embedding |
| preflow | float[1,T,512] | float[1,T,512] | Embed dim=512 | Non-linear transform |
| condEmb | float[1,F,512] | float[1,F,1024] | Cond dim=1024 | Condition embedding |
| diffStep | float[1,F,128] + float[1] + float[1,F,1024] + float[1,F] | float[1,F,128] | Mel dim=128 | Core diffusion step |
| vocoder | float[1,F,128] | float[1,F*480] | Hop size=480 | Neural vocoder: mel → waveform |
| melTransform | float[1,N] | float[1,F,128] | Mel dim=128 | Audio → mel spectrogram |

**Hyperparameters**:

| Parameter | Value | Description |
|-----------|-------|-------------|
| Sample rate | 24000 Hz | Output waveform sample rate |
| Hop size | 480 | STFT hop length (12.5ms per frame @24kHz) |
| N_FFT | 1920 | STFT window size (80ms) |
| Mel bands | 128 | Number of mel filterbank channels |
| Embed dim | 512 | Token/frame embedding dimension |
| Cond dim | 1024 | Condition embedding dimension |
| F0 bins | 361 | F0 quantization bins (32.7Hz–7600Hz) |
| Diff steps | 32 (default) | Number of reverse diffusion steps |
| CFG strength | 3.0 | Classifier-free guidance scale |
| CFG rescale | 0.75 | Rescaling factor for CFG variance correction |

### 3.3 Input Processing

#### 3.3.1 Multilingual Phoneme/Grapheme to Phoneme (G2P)

The system supports three languages:

- **Chinese (Mandarin/Cantonese)**: Uses `pinyin-pro` to convert Chinese characters to pinyin with tone numbers (e.g., "唱" → "zh_chang4"). Phonemes are prefixed with `zh_` or `yue_` for dictionary lookup.
- **English**: Employs the CMU Pronouncing Dictionary (`en_g2p_dict.json`, ~134K entries) with ARPAbet phonemes. Unknown words fall back to letter-level G2P (e.g., "hello" → "HH AH0 L OW1").
- **Mixed/Unknown**: Supports `en_` and `yue_` prefix notation. Unknown phonemes map to `<UNK>` (ID=3).

The `phone_set.json` contains the full phoneme vocabulary with special tokens:
- `<PAD>` (ID=0), `<SP>` (ID=1, silence), `<AP>` (ID=2, aspirate), `<UNK>` (ID=3, unknown)
- `<BOW>` (ID=4, begin of word), `<EOW>` (ID=5, end of word)
- `<SEP>` (ID=9, phoneme separator for multi-phoneme words)

#### 3.3.2 Sequence Construction

The `notesToSequences` method constructs four parallel sequences:

1. **noteTextSeq**: Phoneme IDs with `<BOW>` prefix, actual phonemes, `<EOW>` suffix, and `<SEP>` separators for multi-phoneme words.
2. **notePitchSeq**: MIDI pitch values (0–255) aligned to the token sequence.
3. **noteTypeSeq**: Note type codes:
   - `1`: Rest/silence (empty lyric)
   - `2`: Regular vocal note
   - `3`: Slur/continuation note
4. **f0Ids**: F0 quantization indices (0–360) aligned to mel frames, where:
   ```
   f0Cents = 1200 * log2(max(f0, 32.7Hz) / 32.7Hz)
   bin = round(f0Cents / 20) + 1
   ```

#### 3.3.3 Frame-to-Token Alignment (mel2token)

An interpolation-based alignment algorithm distributes multi-phoneme tokens across mel frames:

```
For each note with j phonemes and nextPhonemeStart frame:
  - mel2token[i] = phIdx           (first frame = BOW token)
  - Split inner frames evenly among j phonemes
  - mel2token[nextPhonemeStart-1] = phIdx + j + 1  (last frame = EOW token)
```

This ensures that the `<BOW>` and `<EOW>` tokens anchor the start and end of each note in the acoustic frame domain.

### 3.4 Noise Schedule and Diffusion Process

#### 3.4.1 Probability Flow ODE

The diffusion process uses a probability flow (PF) ODE formulation with a simple linear noise schedule:

```
dx = v_θ(x_t, t, cond) * dt
```

Where `x_t` is the latent mel-spectrogram at time `t`, `v_θ` is the learned velocity field predicted by the `diffStep` model, and `cond` is the condition embedding (1024-dim per frame).

#### 3.4.2 Initialization

The latent variable `x_0` is initialized as Gaussian noise using the Box-Muller transform:

```
x_0 ~ N(0, I)  where x_0 ∈ ℝ^{F × 128}
```

For each frame `f` and mel band `d`:
```
u1, u2 ~ Uniform(0, 1)
x_0[f, d] = sqrt(-2 * log(u1)) * cos(2π * u2)
```

#### 3.4.3 Classifier-Free Guidance (CFG)

CFG improves sample quality by amplifying the difference between conditional and unconditional predictions:

```
v_cfg = v_cond + γ * (v_cond - v_uncond)
```

Where `γ = 3.0` is the guidance strength.

**Variance-Rescaling CFG**: To prevent over-smoothing from CFG, a variance correction is applied:

```
1. Compute per-frame mean of conditional predictions (v_cond)
2. Compute per-frame mean of CFG-adjusted predictions (v_cfg_adj)
3. Rescale: v_final = α * (v_cfg_adj * σ_cond / σ_cfg_adj) + (1 - α) * v_cfg_adj
```

Where `α = 0.75` is the rescale factor, and `σ_cond`, `σ_cfg_adj` are the standard deviations of mean-aggregated predictions. This maintains the variance of original conditional predictions while benefiting from CFG's sharpening effect.

#### 3.4.4 Numerical Integration

The reverse diffusion uses Euler integration with `K = 32` steps:

```
dt = 1 / K
t_k = (k + 0.5) / K  for k = 0, ..., K-1
x_{t+1} = x_t + v_θ(x_t, t_k, cond) * dt
```

### 3.5 Neural Vocoder

The vocoder reconstructs the 24kHz waveform from the estimated mel-spectrogram. It operates in the complex (magnitude+phase) domain:

```
vocoder(mel) → W ∈ ℝ^{F × (N_FFT/2 + 1) × 2}
```

Where `W[f, k, 0] = log(magnitude)` and `W[f, k, 1] = phase` are interleaved. The reconstruction uses overlap-add ISTFT with a Hann window:

1. **Short audio** (≤1024 frames, ~20.5s): Single forward pass.
2. **Long audio**: Chunked inference with overlap-add:
   - Chunk size: 1024 frames
   - Overlap: 4 frames
   - Cross-fade window: Linear ramp over overlap samples
   - Weighted summation for seamless concatenation

The ISTFT reconstruction uses direct IFFT computation (not FFT-based) and Hann window overlap-add for waveform synthesis.

### 3.6 Segment-Based Synthesis for Long Audio

For audio longer than 30 seconds, the system automatically segments the input to avoid OOM (out-of-memory) issues:

**Algorithm**:
1. Identify natural segment boundaries at silence/rest positions.
2. Each segment is 15–30 seconds in length.
3. Adjacent segments overlap by 2 seconds for seamless cross-fading.
4. Each segment preserves F0 continuity and reference audio prompt context.
5. Segments are synthesized independently then cross-faded using a Hann window.

The overlap-add ensures no audible discontinuities at segment boundaries.

### 3.7 Reference Audio Prompting

The SVS pipeline supports a **reference audio prompt** mechanism (voice cloning via in-context conditioning):

1. The reference WAV is parsed, resampled to 24kHz, and converted to mel-spectrogram (via `melTransform` ONNX model, or JavaScript fallback using manual STFT + mel filterbank).
2. The reference mel frames are concatenated as a "prompt" prefix to the condition embedding:
   ```
   totalFrames = ptFrameCount + targetFrames
   cond[0:ptFrameCount, :] = refMel
   cond[ptFrameCount:, :] = targetCond
   ```
3. During diffusion, the first `ptFrameCount` output frames are replaced with the reference mel, forcing the model to match the reference's acoustic characteristics (timbre, vocal style).
4. If no reference is provided, a zero-prompt of `min(50, max(10, totalFrames * 0.1))` frames is used.

### 3.8 Automatic Pitch Shift (Key Matching)

When a reference audio is provided, the pipeline automatically computes an optimal F0 shift to match the reference's pitch range:

```
refMedian = median(refF0_nonzero)
targetMedian = median(targetF0_nonzero)
f0Shift = round(log2(refMedian / targetMedian) * 12)
```

This semitone offset shifts all MIDI pitches before synthesis, ensuring the output matches the reference singer's vocal range.

### 3.9 Synthesis Caching

To avoid redundant computation during interactive editing, synthesized audio is cached using a hash-based key:

```
cacheKey = hash(notes + bpm + f0Envelope + pitchCurve + refAudio + diffSteps + cfgParams + pitchShift)
```

The hash uses a DJB2 variant over serialized note/parameter attributes. Cache is cleared when notes or parameters change.

---

## 4. Pitch Detection and MIDI Extraction

### 4.1 RMVPE Pitch Detector

RMVPE (Robust Multi-Resolution Voice Pitch Estimation) provides accurate F0 extraction for audio preprocessing:

**Specifications**:
- Input: 16kHz mono audio
- Architecture: Convolutional neural network with 2560-class output (log-scale F0 bins)
- F0 range: 30–7600 Hz
- Hop length: 160 samples (10ms @16kHz)
- Output: Per-frame F0 frequency

**Processing**:
1. Audio is resampled to 16kHz (RMVPE input rate).
2. Model predicts class probabilities over 2560 F0 bins.
3. Argmax decoding yields discrete F0 indices.
4. F0 values computed via: `f0 = F0_min * (F0_max / F0_min)^{index / (N_class - 1)}`
5. Linear interpolation to target 24kHz/480-hop frame rate.

**F0-to-MIDI Conversion** (`f0ToNotes`):
1. Frames above threshold (>50Hz) are grouped into continuous segments.
2. Within each segment, frames are grouped by MIDI pitch (within 10% frequency tolerance).
3. Each group becomes a MIDI note with median pitch, start time, and duration.
4. Minimum note duration: 0.1 seconds.
5. Pitch range filter: 24 ≤ MIDI ≤ 108.

### 4.2 BasicPitch MIDI Detector

BasicPitch (from Spotify's Magenta project) provides audio-to-MIDI transcription using TensorFlow.js:

**Specifications**:
- Input: 22050Hz mono audio
- Model: TF.js GraphModel (CNN-based)
- Outputs: 
  - `Identity_1`: Frame-wise pitch activity [F, 88]
  - `Identity_2`: Onset probabilities [F, 88]
  - `Identity`: Contour features [F, 88 * bins_per_semitone]
- Frame rate: ~86 FPS (22050Hz / 256)

**Architecture Details**:
- Audio window: 2 seconds with 30-frame overlap
- FFT hop: 256 samples
- Gaussian-weighted frequency bins for pitch contour extraction
- Melodia trick for polyphonic note decomposition (iterative residual energy removal)

**Post-processing**:
1. `outputToNotesPoly`: Applies onset/offset detection with energy tolerance.
2. `addPitchBendsToNoteEvents`: Extracts pitch micro-variations from contour outputs.
3. Time conversion: `modelFrameToTime` accounts for window overlap offset.

### 4.3 RosVot MIDI Recognizer (Disabled)

RosVot is a MIDI note recognition model that operates on audio + F0 features. Currently disabled due to ONNX export issues (MIDI note extraction returns empty results).

**Specifications**:
- Input: 24kHz audio + 128-hop frame pitch/uv tokens
- Output: Note boundaries, pitches, and counts
- Architecture: ConvTranspose layers (incompatible with DirectML, CPU-only)

---

## 5. Editor and Audio Processing

### 5.1 Piano Roll Editor

The `PianoRoll` class provides canvas-based MIDI editing:

**Constants**:
| Parameter | Value | Description |
|-----------|-------|-------------|
| Key width | 60px | Left piano key area |
| Note height | 16px | Per-semitone height |
| Beat width | 80px | Per-beat width at zoom=1 |
| Header height | 24px | Top ruler |
| Min note | 1/16 | Minimum note duration |

**Editing Modes** (`PARAM_MODES`):
- **MIDI**: Note add (click), move (drag), resize (edge drag), delete (Delete key), lyric edit (double-click).
- **F0**: Anchor point manipulation, brush drawing for pitch contour.
- **VOL/PAN**: Keyframe-based envelope curves for volume (0–1) and pan (-1 to 1).

**Rendering Pipeline**:
1. Static cache for grid/keys (redrawn on scroll/zoom changes).
2. Dynamic overlay for notes, selection, playhead, and parameter curves.
3. Canvas DPI scaling via `devicePixelRatio`.

**Pitch Curve** (`pitchCurve`):
- `anchorPoints`: Key-value pairs for manual F0 anchor points.
- `brushSegments`: Freehand-drawn F0 segments for expressive pitch shaping.
- Combined with note-based F0 during synthesis to produce the final F0 curve.

### 5.2 Envelope System

Envelopes are stored as keyframe arrays:

```json
{
  "keyframes": [
    { "time": 0, "value": 1.0, "smoothness": 0 },
    { "time": 2.5, "value": 0.5, "smoothness": 0 }
  ]
}
```

During synthesis, keyframes are linearly interpolated to produce per-frame values. Volume envelope modifies output amplitude; F0 envelope applies semitone shifts to MIDI pitch (for vibrato and pitch bends).

### 5.3 Track and Fragment Management

The `TrackManager` maintains:
- **Singers**: Profiles with name, color, avatar, and reference audio path.
- **Fragments**: Time-aligned segments containing notes, envelopes, and pitch curves.

Fragment colors are assigned from a 12-color palette using a hash of the singer ID.

### 5.4 History and Undo/Redo

The `HistoryManager` implements a stack-based undo/redo system:
- Captures snapshots of `TrackManager` state (singers + fragments).
- Maximum history depth: configurable (default unlimited within session).
- Actions are batched for atomic undo/redo operations.

### 5.5 MIDI File Import

The `parseMidiFile` function in [midiParser.js](file:///d:/Document/electron/SXSEditor/src/inference/midiParser.js) parses standard MIDI files:

- Supports format 0/1 MIDI, variable-length encoding, tempo map parsing.
- Extracts lyrics from MIDI meta events (type 0x05).
- Handles overlapping note trimming, silence insertion (>0.2s threshold), and note type classification.
- Outputs beats-based timing (beats = ticks / ticksPerBeat) for BPM-agnostic representation.

---

## 6. Audio Playback System

### 6.1 WASAPI Audio Output

The audio playback subsystem uses `decibri` (Rust/cpal core with WASAPI support) via a forked child process:

**AudioWorker** ([audioWorker.js](file:///d:/Document/electron/SXSEditor/src/audio/audioWorker.js)):
- Independently managed child process for glitch-free playback.
- Shared-mode WASAPI playback (decibri does not support exclusive mode; the legacy `exclusiveMode` option is accepted but ignored).
- Bit depth: `float32` and `int16` are native; `int24`/`int32` requests are transparently downgraded to `float32`.
- Sample-accurate position tracking via `performance.now()`.

**Playback Modes**:
1. **WASAPI Shared Mode** (decibri): System-mixed audio output. The legacy exclusive-mode setting falls back to this.
2. **Web Audio API** (browser `AudioContext`): Used when WASAPI output is unavailable.

### 6.2 AudioOutputManager

The `AudioOutputManager` in the main process manages the audio worker lifecycle:
- IPC-based command interface (start, stop, getPosition, getDevices).
- 15-second command timeout with automatic error recovery.
- Position tracking at 200ms intervals.
- Automatic audio end detection via worker `ended` message.

---

## 7. Model Management and Distribution

### 7.1 Model File Manifest

The full model distribution requires 20 files across 4 model groups (SVS, RMVPE, BasicPitch, RosVot):

| File | Required | Size (typical) | Group |
|------|----------|---------------|-------|
| note_text_encoder.onnx + .data | Yes | ~120 MB | SVS |
| note_pitch_encoder.onnx + .data | Yes | ~120 MB | SVS |
| note_type_encoder.onnx + .data | Yes | ~120 MB | SVS |
| f0_encoder.onnx + .data | Yes | ~120 MB | SVS |
| preflow.onnx + .data | Yes | ~120 MB | SVS |
| cond_emb.onnx + .data | Yes | ~120 MB | SVS |
| diff_step_dml.onnx | Yes | ~400 MB | SVS |
| vocoder_dml.onnx | Yes | ~100 MB | SVS |
| mel_transform.onnx + .data | Yes | ~50 MB | SVS |
| preprocess/rmvpe_model.onnx | Yes | ~200 MB | RMVPE |
| basic_pitch_model/* | Yes | ~10 MB | BasicPitch |

**Total**: ~1.5 GB (FP32), ~800 MB (FP16)

### 7.2 Download Infrastructure

Models are distributed via ModelScope (modelscope.cn), a Chinese model repository:

**URL Pattern**:
```
https://modelscope.cn/api/v1/models/syxppp/SoulX-Singer-onnx-directml-fp16/repo?Revision=master&FilePath={encoded_path}
```

**Available Precisions**:
- `syxppp/SoulX-Singer-onnx-directml` (FP32)
- `syxppp/SoulX-Singer-onnx-directml-fp16` (FP16, default)
- `syxppp/SoulX-Singer-onnx-directml-int8` (INT8 quantization)

**Download Strategies** (automatic selection):
1. **ModelScope CLI**: If `modelscope` CLI is installed, uses it for optimal download.
2. **Chunked HTTP**: For files ≥16MB, multi-threaded chunked download with:
   - Dynamic chunk sizing: 16MB–128MB per chunk based on file size.
   - Global concurrency pool: `min(cpu_cores * 2, 16)` adaptively limited by available memory.
   - Metadata-tracked resume support for interrupted downloads.
   - Server Range-request detection with single-threaded fallback.
3. **Single-threaded HTTP**: For small files or servers without Range support, with byte-level resume.

### 7.3 Model Validation

Each model is validated after loading with a forward pass on dummy inputs:
- FP32 models: Tested with default dummy tensors.
- FP16 models: Tested with FP16 dummy tensors.
- Validation failure triggers execution provider fallback (DML → CPU) or alternative model file search (e.g., `diff_step_dml.onnx` → `diff_step.onnx`).

---

## 8. Singer File Format (.sxssinger)

The ".sxssinger" file is a JSON-based container (format version 1.0.0):

```json
{
  "formatVersion": "1.0.0",
  "singerName": "ExampleSinger",
  "color": "#f87171",
  "avatarBase64": "...base64-encoded image...",
  "wavBase64": "...base64-encoded reference WAV...",
  "wavFileName": "reference.wav",
  "wavDuration": 5.2,
  "isPreprocessed": true,
  "midiNotes": [{ "pitch": 60, "start": 0, "duration": 1, "lyric": "la" }],
  "f0Data": [{ "time": 0, "f0": 261.6 }],
  "singerData": { "model_conditions": "..." }
}
```

Validation checks: JSON structure, singer name length (≤100 chars), color format (#RRGGBB), WAV size (44 bytes–50MB), MIDI note pitch range (0–127), audio duration (≤60s recommendation).

---

## 9. Configuration and Settings

Settings are stored in a JSON file at `app.getPath('userData')/sxseditor-settings.json`:

Key settings:
- `deviceId`: GPU device ID for DirectML inference (null = auto-detect).
- `language`: Locale preference (`zh-CN` or `en`).
- Custom model directory path.
- Audio device preferences.

---

## 10. Resource Manager

The Resource Manager provides granular control over loaded models:

- **GPU Information**: Real-time GPU name, VRAM, DML device ID display.
- **Model Group Management**: Load/unload entire model groups (SVS pipeline, RMVPE, etc.) independently.
- **Per-Model Control**: Individual load/unload for each ONNX session.
- **CPU/GPU Distribution**: Visualization showing which models run on DML vs CPU.

---

## 11. Internationalization (i18n)

The system supports Chinese (zh-CN) and English (en) via a lightweight JavaScript implementation in [i18n/index.js](file:///d:/Document/electron/SXSEditor/src/i18n/index.js):

- **Renderer**: Uses `data-i18n` attributes with textContent-based translation.
- **Main Process**: Inline locale objects for menu and dialog strings.
- Locale is persisted in `sxseditor-locale.json`.

---

## 12. Project Serialization

Projects are serialized as JSON containing:
- All singer references (file paths and inline data).
- All fragments (notes, envelopes, pitch curves, positions).
- Current history state for undo/redo continuity.

The project serialization uses `JSON.stringify` with full state capture from TrackManager.

---

## 13. Error Handling and Fault Tolerance

| Failure Mode | Handling Strategy |
|-------------|-------------------|
| GPU detection failure | Fall back to CPU-only inference |
| DML model load failure | Per-model fallback to CPU, continues with available models |
| Pipeline initialization failure | Shows error dialog, suggests model re-download |
| Audio playback failure | Falls back from exclusive to shared mode |
| Window close with unsaved changes | Prompts save/discard/cancel dialog |
| File path security violation | Validates via `isPathAllowed()`, uses `authorizePath()` |
| Long synthesis | Segment-based processing with progress reporting |
| Model download interruption | Chunked resume + metadata recovery |
| Memory pressure | Automatic garbage collection after model disposal |

---

## 14. Technical Specifications Summary

| Component | Technology | Version |
|-----------|-----------|---------|
| Desktop Framework | Electron | 41.3.0 |
| ML Inference | ONNX Runtime Node.js | 1.24.3 |
| GPU Acceleration | DirectML (via ONNX Runtime) | — |
| Audio Output | decibri (WASAPI) | 4.4.2 |
| Audio Processing | Web Audio API, node:fs | — |
| MIDI Editor | HTML5 Canvas (custom) | — |
| Pitch Detection (ML) | RMVPE (ONNX), BasicPitch (TF.js) | — |
| MIDI Recognition | RosVot (ONNX, disabled) | — |
| Internationalization | Custom i18n | — |
| Project Packaging | Electron Forge | 7.11.1 |
| Module Bundler | Webpack (electron-forge plugin) | 7.x |
| Testing | Mocha + Chai + Sinon | — |
| GPU Info | systeminformation | 5.x |
| G2P (Chinese) | pinyin-pro | 3.28.1 |
| G2P (English) | CMUdict-based custom | — |

---

## 15. Application Lifecycle

### 15.1 Startup Sequence

1. `app.whenReady()` triggers main window creation.
2. Main locale is loaded from `sxseditor-locale.json`.
3. Application menu is constructed (File, Edit, View, Help).
4. GPU devices are pre-enumerated asynchronously (systeminformation + ONNX Runtime verbose probe).
5. Model directory is checked for missing files via `checkMissingFiles()`.
6. If models are missing, the Model Download window is shown.
7. On completion, the main renderer initializes:
   - `TrackManager`, `HistoryManager`, i18n.
   - Fragment timeline canvas setup.
   - Event listener registration.

### 15.2 Application Shutdown

1. `before-quit` event triggers dirty state check.
2. If unsaved changes exist, prompts user to save/discard/cancel.
3. All ONNX sessions are released via `pipeline.dispose()`.
4. Audio worker is killed.
5. Settings are persisted.

---

## 16. Performance Characteristics

| Operation | Typical Latency | Scaling |
|-----------|----------------|---------|
| Pipeline init (GPU) | 5–15s | Model count |
| Pipeline init (CPU) | 30–120s | Model size |
| F0 extraction (10s audio) | 2–5s (DML) | Audio duration |
| Synthesis (10s, 32 steps) | 10–30s (DML) | Steps × duration |
| Synthesis (10s, 32 steps) | 60–180s (CPU) | Steps × duration |
| Vocoder (10s audio) | 1–3s (DML) | Duration |
| Model download (1.5GB) | 5–20min | Network speed |

Performance depends heavily on GPU capabilities. For optimal performance, a discrete GPU with ≥4GB VRAM is recommended.

---

## 17. Conclusions and Future Work

SXSEditor demonstrates that a complete, production-grade AI SVS workbench can be built using ONNX Runtime, Electron, and modern web technologies. The system successfully integrates complex deep learning inference pipelines with intuitive interactive editors, all running entirely offline with GPU acceleration.

### Future Directions

1. **Custom Model Training**: Integrate a training UI for fine-tuning models on user-provided datasets.
2. **Real-time Synthesis**: Optimize the diffusion loop for real-time streaming synthesis.
3. **Multi-language Expansion**: Add Japanese and Korean phoneme support.
4. **Plugin Architecture**: Allow third-party model groups (e.g., different vocoders, voice conversion models).
5. **VST3/AU Integration**: Enable SXSEditor as a plugin in DAWs.
6. **Cloud Synchronization**: Optional cloud-based singer and project sharing.
7. **Quantization-Aware Training**: Further optimize INT8 models for mobile deployment.