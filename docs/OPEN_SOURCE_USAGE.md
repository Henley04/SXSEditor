# Open Source Software Usage Notice

This document provides a comprehensive notice of the open source software and third-party components used in the **SXSEditor** project, including their licenses, usage context, and attribution.

---

## Table of Contents

1. [Runtime Dependencies](#runtime-dependencies)
2. [Development Dependencies](#development-dependencies)
3. [Neural Network Models](#neural-network-models)
4. [Audio & Signal Processing Libraries](#audio--signal-processing-libraries)
5. [Build & Packaging Tools](#build--packaging-tools)
6. [Testing Framework](#testing-framework)
7. [License Texts](#license-texts)
8. [Trademarks](#trademarks)

---

## Runtime Dependencies

### `@tensorflow/tfjs`
- **Version**: `^4.22.0`
- **License**: Apache-2.0
- **Usage**: Used by the Basic Pitch module for pitch detection inference.
- **Repository**: https://github.com/tensorflow/tfjs

### `electron-squirrel-startup`
- **Version**: `^1.0.1`
- **License**: MIT
- **Usage**: Handles Squirrel.Windows startup events for Electron auto-updates.
- **Repository**: https://github.com/mongodb-js/electron-squirrel-startup

### `onnxruntime-node`
- **Version**: `^1.24.3`
- **License**: MIT
- **Usage**: Core inference engine for executing ONNX models (SVS pipeline, RMVPE, vocoder, etc.).
- **Repository**: https://github.com/Microsoft/onnxruntime

### `pinyin-pro`
- **Version**: `^3.28.1`
- **License**: MIT
- **Usage**: Chinese text-to-pinyin conversion for lyric phonemization in the SVS pipeline.
- **Repository**: https://github.com/zh-lx/pinyin-pro

### `wavesurfer.js`
- **Version**: `^7.12.6`
- **License**: BSD-3-Clause
- **Usage**: Audio waveform visualization in the audio preprocessing UI.
- **Repository**: https://github.com/katspaugh/wavesurfer.js

---

## Development Dependencies

### `@babel/core`, `@babel/preset-env`, `@babel/register`
- **Version**: `^7.29.0`, `^7.29.2`, `^7.28.6`
- **License**: MIT
- **Usage**: Babel transpilation for ES6+ code during testing and bundling.
- **Repository**: https://github.com/babel/babel

### `@electron-forge/cli` and plugins
- **Versions**: `^7.11.1`
- **License**: MIT
- **Usage**: Electron application build, package, and distribution automation.
- **Components**:
  - `@electron-forge/cli`
  - `@electron-forge/maker-deb`
  - `@electron-forge/maker-rpm`
  - `@electron-forge/maker-squirrel`
  - `@electron-forge/maker-zip`
  - `@electron-forge/plugin-auto-unpack-natives`
  - `@electron-forge/plugin-fuses`
  - `@electron-forge/plugin-webpack`
- **Repository**: https://github.com/electron/forge

### `@electron/fuses`
- **Version**: `^1.8.0`
- **License**: MIT
- **Usage**: Electron fuse configuration for security hardening at package time.
- **Repository**: https://github.com/electron/fuses

### `@electron/rebuild`
- **Version**: `^4.0.4`
- **License**: MIT
- **Usage**: Rebuilds native Node.js modules against the current Electron version.
- **Repository**: https://github.com/electron/rebuild

### `@playwright/test`
- **Version**: `^1.59.1`
- **License**: Apache-2.0
- **Usage**: End-to-end testing framework (included for future UI automation tests).
- **Repository**: https://github.com/microsoft/playwright

### `@vercel/webpack-asset-relocator-loader`
- **Version**: `^1.7.3`
- **License**: MIT
- **Usage**: Webpack loader for relocating native asset dependencies.
- **Repository**: https://github.com/vercel/webpack-asset-relocator-loader

### `babel-loader`
- **Version**: `^10.1.1`
- **License**: MIT
- **Usage**: Webpack loader for Babel transpilation.
- **Repository**: https://github.com/babel/babel-loader

### `chai`
- **Version**: `^6.2.2`
- **License**: MIT
- **Usage**: Assertion library for the Mocha test suite.
- **Repository**: https://github.com/chaijs/chai

### `copy-webpack-plugin`
- **Version**: `^14.0.0`
- **License**: MIT
- **Usage**: Copies static files into the Webpack output directory.
- **Repository**: https://github.com/webpack-contrib/copy-webpack-plugin

### `css-loader`
- **Version**: `^6.11.0`
- **License**: MIT
- **Usage**: Webpack loader for CSS files.
- **Repository**: https://github.com/webpack-contrib/css-loader

### `electron`
- **Version**: `^41.3.0`
- **License**: MIT
- **Usage**: Electron framework for building the desktop application.
- **Repository**: https://github.com/electron/electron

### `electron-rebuild`
- **Version**: `^3.2.9`
- **License**: MIT
- **Usage**: Alternative native module rebuild tool for Electron.
- **Repository**: https://github.com/electron/rebuild

### `jsdom`
- **Version**: `^29.0.2`
- **License**: MIT
- **Usage**: Browser environment simulation for frontend unit tests.
- **Repository**: https://github.com/jsdom/jsdom

### `mocha`
- **Version**: `^11.7.5`
- **License**: MIT
- **Usage**: Test framework for running unit and integration tests.
- **Repository**: https://github.com/mochajs/mocha

### `node-loader`
- **Version**: `^2.1.0`
- **License**: MIT
- **Usage**: Webpack loader for `.node` native addon files.
- **Repository**: https://github.com/webpack-contrib/node-loader

### `nyc`
- **Version**: `^18.0.0`
- **License**: ISC
- **Usage**: Code coverage tool for JavaScript tests.
- **Repository**: https://github.com/istanbuljs/nyc

### `sinon`
- **Version**: `^21.1.2`
- **License**: BSD-3-Clause
- **Usage**: Mocking, stubbing, and spying library for unit tests.
- **Repository**: https://github.com/sinonjs/sinon

### `style-loader`
- **Version**: `^3.3.4`
- **License**: MIT
- **Usage**: Webpack loader that injects CSS into the DOM.
- **Repository**: https://github.com/webpack-contrib/style-loader

### `webpack-cli`
- **Version**: `^7.0.2`
- **License**: MIT
- **Usage**: Command-line interface for Webpack.
- **Repository**: https://github.com/webpack/webpack-cli

---

## Neural Network Models

### SoulX-Singer
- **License**: Subject to the original model license (check upstream repository)
- **Usage**: Core singing voice synthesis (SVS) and singing voice conversion (SVC) acoustic model.
- **Description**: A diffusion-based neural singing voice model using Flow Matching (Conditional Flow Matching) with a DiffLlama decoder and Vocos vocoder.
- **Components used**:
  - Encoder embeddings (phoneme, pitch, type, F0)
  - ConvNeXtV2 pre-flow
  - DiffLlama CFM decoder
  - Vocos vocoder (with ISTFT head)
  - Mel-spectrogram transform
- **Note**: The ONNX exported models are derived from the SoulX-Singer PyTorch checkpoint. Users must comply with the original model license when distributing or using the model weights.

### RMVPE (Robust Model for Vocal Pitch Estimation)
- **License**: Subject to the original model license
- **Usage**: F0 extraction from vocal audio for preprocessing and analysis.
- **Description**: A deep learning-based pitch estimator converted to ONNX format for runtime inference.

### Basic Pitch (by Spotify)
- **License**: Apache-2.0
- **Usage**: Alternative lightweight pitch detection and note transcription.
- **Repository**: https://github.com/spotify/basic-pitch

### Whisper (OpenAI)
- **License**: MIT
- **Usage**: Content encoding for SVC mode (reference audio feature extraction).
- **Repository**: https://github.com/openai/whisper
- **Note**: The Whisper encoder is used as a preprocessing step and is not exported to ONNX in this project.

---

## Audio & Signal Processing Libraries

### Web Audio API
- **Source**: Built into Chromium/Electron
- **Usage**: Real-time audio playback, AudioBufferSourceNode, and AudioContext management.

### Standard WAV Encoding
- **Source**: Custom implementation in `src/audio/wavEncoder.js`
- **License**: MIT (project license)
- **Usage**: Encoding synthesized float32 PCM audio into standard RIFF/WAV files.

---

## Build & Packaging Tools

### Electron Forge
- **License**: MIT
- **Usage**: Complete build and packaging pipeline for Electron apps.
- **Makers configured**:
  - Squirrel.Windows (`.exe` installer)
  - ZIP (macOS)
  - DEB (Linux Debian/Ubuntu)
  - RPM (Linux Fedora/RHEL)

### Webpack
- **License**: MIT
- **Usage**: Module bundling for main and renderer processes, with separate configurations for each.

---

## Testing Framework

| Component | License | Purpose |
|-----------|---------|---------|
| Mocha | MIT | Test runner |
| Chai | MIT | Assertions |
| Sinon | BSD-3-Clause | Mocks and stubs |
| JSDOM | MIT | Browser simulation |
| NYC | ISC | Code coverage |
| Playwright | Apache-2.0 | E2E testing (future) |

---

## License Texts

### MIT License

```
MIT License

Copyright (c) <year> <copyright holders>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Apache License 2.0

```
Apache License
Version 2.0, January 2004
http://www.apache.org/licenses/

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

### BSD 3-Clause License

```
BSD 3-Clause License

Copyright (c) <year>, <copyright holder>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

### ISC License

```
ISC License

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
```

---

## Trademarks

- **Electron** is a trademark of GitHub, Inc.
- **TensorFlow** is a trademark of Google LLC.
- **ONNX** is a trademark of the Linux Foundation.
- **OpenAI** and **Whisper** are trademarks of OpenAI, Inc.
- **Spotify** and **Basic Pitch** are trademarks of Spotify AB.
- All other trademarks are the property of their respective owners.

---

## Disclaimer

This project is provided as-is without any warranty. The authors and contributors are not responsible for any damages or legal issues arising from the use of this software or the included neural network models. Users are responsible for complying with the licenses of all third-party components and models.

---

*This notice was generated for SXSEditor version 1.0.0.*
