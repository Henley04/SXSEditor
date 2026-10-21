const path = require('node:path');
const { requireSampleRate } = require('./shared/pitchF0Utils');
// P1：只加载实际用到的 tfjs 子包，替代 meta 包 `@tensorflow/tfjs`（142 MB，
// 其中 dist 几乎全是 sourcemap），并顺带省掉运行时用不到的 layers(31 MB)、
// data(4 MB)、backend-webgl(23 MB，Node 主进程无 WebGL)。
// 基本面 tf API（tensor1d/concat1d/zeros/expandDims/slice/signal/setBackend…）
// 全部来自 tfjs-core；tfjs-converter 提供 GraphModel 权重加载。
//
// 注意 loadGraphModel 必须从 tfjs-converter **单独解构**，不能指望
// require('@tensorflow/tfjs-converter') 之后它会挂到 tf 命名空间上——
// 实测 tf.loadGraphModel 仍是 undefined，meta 包那句 `const tf = require('@tensorflow/tfjs')`
// 之所以能拿到它，是因为 meta 包自己做了 re-export。一旦换成子包就必须显式解构，
// 否则 BASIC-PITCH 会在加载模型那一步直接抛 "tf.loadGraphModel is not a function"。
const tf = require('@tensorflow/tfjs-core');
const { loadGraphModel } = require('@tensorflow/tfjs-converter');
require('@tensorflow/tfjs-backend-cpu');
require('@tensorflow/tfjs-backend-wasm');
const { resampleAudio } = require('../utils/resampleAudio');

let _noteIdCounter = 0;

const BASIC_PITCH_SAMPLE_RATE = 22050;
const CONTOUR_BINS_PER_SEMITONE = 1;
const ANNOTATIONS_FPS = Math.floor(BASIC_PITCH_SAMPLE_RATE / 256);
const AUDIO_WINDOW_LENGTH_SECONDS = 2;
const FFT_HOP = 256;
const AUDIO_N_SAMPLES = BASIC_PITCH_SAMPLE_RATE * AUDIO_WINDOW_LENGTH_SECONDS - FFT_HOP;
const N_OVERLAPPING_FRAMES = 30;
const N_OVERLAP_OVER_2 = Math.floor(N_OVERLAPPING_FRAMES / 2);
const OVERLAP_LENGTH_FRAMES = N_OVERLAPPING_FRAMES * FFT_HOP;
const HOP_SIZE = AUDIO_N_SAMPLES - OVERLAP_LENGTH_FRAMES;

const MIDI_OFFSET = 21;
const MAX_FREQ_IDX = 87;
const N_FREQ_BINS_CONTOURS = 88 * CONTOUR_BINS_PER_SEMITONE;

function gaussian(M, std) {
  const result = [];
  for (let n = 0; n < M; n++) {
    result.push(Math.exp((-1 * (n - (M - 1) / 2) ** 2) / (2 * std ** 2)));
  }
  return result;
}

function argMax(arr) {
  if (arr.length === 0) return null;
  let maxIndex = -1;
  for (let i = 0; i < arr.length; i++) {
    if (maxIndex === -1 || arr[i] > arr[maxIndex]) {
      maxIndex = i;
    }
  }
  return maxIndex;
}

function argMaxAxis1(arr) {
  return arr.map(row => argMax(row));
}

function whereGreaterThanAxis1(arr2d, threshold) {
  const outputX = [];
  const outputY = [];
  for (let i = 0; i < arr2d.length; i++) {
    for (let j = 0; j < arr2d[i].length; j++) {
      if (arr2d[i][j] > threshold) {
        outputX.push(i);
        outputY.push(j);
      }
    }
  }
  return [outputX, outputY];
}

function meanStdDev(array) {
  let sum = 0;
  let sumSquared = 0;
  let count = 0;
  for (const row of array) {
    for (const value of row) {
      sum += value;
      sumSquared += value * value;
      count++;
    }
  }
  const mean = sum / count;
  if (count <= 1) return [sum, 0];
  const std = Math.sqrt((1 / (count - 1)) * (sumSquared - (sum * sum) / count));
  return [mean, std];
}

function globalMax(array) {
  let max = 0;
  for (const row of array) {
    for (const v of row) {
      if (v > max) max = v;
    }
  }
  return max;
}

function min3dForAxis0(array) {
  const minArray = array[0].map(v => v.slice());
  for (let x = 1; x < array.length; ++x) {
    for (let y = 0; y < array[0].length; ++y) {
      for (let z = 0; z < array[0][0].length; ++z) {
        minArray[y][z] = Math.min(minArray[y][z], array[x][y][z]);
      }
    }
  }
  return minArray;
}

function max3dForAxis0(array) {
  const maxArray = array[0].map(v => v.slice());
  for (let x = 1; x < array.length; ++x) {
    for (let y = 0; y < array[0].length; ++y) {
      for (let z = 0; z < array[0][0].length; ++z) {
        maxArray[y][z] = Math.max(maxArray[y][z], array[x][y][z]);
      }
    }
  }
  return maxArray;
}

function argRelMax(array, order = 1) {
  const result = [];
  for (let col = 0; col < array[0].length; ++col) {
    for (let row = 0; row < array.length; ++row) {
      let isRelMax = true;
      for (
        let comparisonRow = Math.max(0, row - order);
        isRelMax && comparisonRow <= Math.min(array.length - 1, row + order);
        ++comparisonRow
      ) {
        if (comparisonRow !== row) {
          isRelMax = isRelMax && array[row][col] > array[comparisonRow][col];
        }
      }
      if (isRelMax) {
        result.push([row, col]);
      }
    }
  }
  return result;
}

function constrainFrequency(onsets, frames, maxFreq, minFreq) {
  if (maxFreq) {
    const maxFreqIdx = hzToMidi(maxFreq) - MIDI_OFFSET;
    for (let i = 0; i < onsets.length; i++) {
      onsets[i].fill(0, maxFreqIdx);
    }
    for (let i = 0; i < frames.length; i++) {
      frames[i].fill(0, maxFreqIdx);
    }
  }
  if (minFreq) {
    const minFreqIdx = hzToMidi(minFreq) - MIDI_OFFSET;
    for (let i = 0; i < onsets.length; i++) {
      onsets[i].fill(0, 0, minFreqIdx);
    }
    for (let i = 0; i < frames.length; i++) {
      frames[i].fill(0, 0, minFreqIdx);
    }
  }
}

function getInferredOnsets(onsets, frames, nDiff = 2) {
  const diffs = [];
  for (let n = 1; n <= nDiff; n++) {
    const zeroRows = Array(n).fill(null).map(() => Array(frames[0].length).fill(0));
    const framesAppended = zeroRows.concat(frames);
    const nPlus = framesAppended.slice(n);
    const minusN = framesAppended.slice(0, -n);
    const diff = nPlus.map((row, r) => row.map((v, c) => v - minusN[r][c]));
    diffs.push(diff);
  }
  let frameDiff = min3dForAxis0(diffs);
  frameDiff = frameDiff.map(row => row.map(v => Math.max(v, 0)));
  frameDiff = frameDiff.map((row, r) => (r < nDiff ? row.fill(0) : row));
  const onsetMax = globalMax(onsets);
  const frameDiffMax = globalMax(frameDiff);
  frameDiff = frameDiff.map(row => row.map(v => (onsetMax * v) / frameDiffMax));
  return max3dForAxis0([onsets, frameDiff]);
}

function outputToNotesPoly(
  frames,
  onsets,
  onsetThresh = 0.5,
  frameThresh = 0.3,
  minNoteLen = 5,
  inferOnsets = true,
  maxFreq = null,
  minFreq = null,
  melodiaTrick = true,
  energyTolerance = 11,
) {
  let inferredFrameThresh = frameThresh;
  if (inferredFrameThresh === null) {
    const [mean, std] = meanStdDev(frames);
    inferredFrameThresh = mean + std;
  }
  const nFrames = frames.length;
  constrainFrequency(onsets, frames, maxFreq, minFreq);
  let inferredOnsets = onsets;
  if (inferOnsets) {
    inferredOnsets = getInferredOnsets(onsets, frames);
  }
  const peakThresholdMatrix = inferredOnsets.map(o => o.map(() => 0));
  argRelMax(inferredOnsets).forEach(([row, col]) => {
    peakThresholdMatrix[row][col] = inferredOnsets[row][col];
  });
  const [noteStarts, freqIdxs] = whereGreaterThanAxis1(peakThresholdMatrix, onsetThresh);
  noteStarts.reverse();
  freqIdxs.reverse();
  const remainingEnergy = frames.map(frame => frame.slice());
  const noteEvents = [];
  for (let idx = 0; idx < noteStarts.length; idx++) {
    const noteStartIdx = noteStarts[idx];
    const freqIdx = freqIdxs[idx];
    if (noteStartIdx >= nFrames - 1) continue;
    let i = noteStartIdx + 1;
    let k = 0;
    while (i < nFrames - 1 && k < energyTolerance) {
      if (remainingEnergy[i][freqIdx] < inferredFrameThresh) {
        k += 1;
      } else {
        k = 0;
      }
      i += 1;
    }
    i -= k;
    if (i - noteStartIdx <= minNoteLen) continue;
    for (let j = noteStartIdx; j < i; ++j) {
      remainingEnergy[j][freqIdx] = 0;
      if (freqIdx < MAX_FREQ_IDX) remainingEnergy[j][freqIdx + 1] = 0;
      if (freqIdx > 0) remainingEnergy[j][freqIdx - 1] = 0;
    }
    let frameSum = 0;
    for (let j = noteStartIdx; j < i; j++) {
      frameSum += frames[j][freqIdx];
    }
    const amplitude = frameSum / (i - noteStartIdx);
    noteEvents.push({
      startFrame: noteStartIdx,
      durationFrames: i - noteStartIdx,
      pitchMidi: freqIdx + MIDI_OFFSET,
      amplitude: amplitude,
    });
  }
  if (melodiaTrick === true && nFrames > 0 && remainingEnergy[0].length > 0) {
    // B5: Flatten remainingEnergy to 1D Float32Array + per-column max tracking.
    // Reduces each iteration from O(R*C) [globalMax + inline double for-loop]
    // to O(C + affectedCols*R) for max-finding. Note extraction logic
    // (threshold check, region growing, amplitude) is unchanged.
    //
    // Tie-breaking: original scanned row-major with `>` (first max in row-major
    // order). Per-column max scans column-major, so ties prefer smaller column
    // index then smaller row. Exact ties are impossible with float NN outputs.
    const numCols = remainingEnergy[0].length;
    const flatEnergy = new Float32Array(nFrames * numCols);
    const colMaxRow = new Int32Array(numCols);
    const colMaxValue = new Float32Array(numCols);
    for (let c = 0; c < numCols; c++) {
      colMaxValue[c] = -1;
      colMaxRow[c] = 0;
    }
    for (let r = 0; r < nFrames; r++) {
      const rowOffset = r * numCols;
      const row = remainingEnergy[r];
      for (let c = 0; c < numCols; c++) {
        const v = row[c];
        flatEnergy[rowOffset + c] = v;
        if (v > colMaxValue[c]) {
          colMaxValue[c] = v;
          colMaxRow[c] = r;
        }
      }
    }

    while (true) {
      // Find global max via per-column max (O(C) instead of O(R*C))
      let maxVal = -1;
      let iMid = 0;
      let freqIdx = 0;
      for (let c = 0; c < numCols; c++) {
        if (colMaxValue[c] > maxVal) {
          maxVal = colMaxValue[c];
          iMid = colMaxRow[c];
          freqIdx = c;
        }
      }
      if (maxVal <= inferredFrameThresh) break;

      flatEnergy[iMid * numCols + freqIdx] = 0;
      let i = iMid + 1;
      let k = 0;
      while (i < nFrames - 1 && k < energyTolerance) {
        if (flatEnergy[i * numCols + freqIdx] < inferredFrameThresh) {
          k += 1;
        } else {
          k = 0;
        }
        flatEnergy[i * numCols + freqIdx] = 0;
        if (freqIdx < MAX_FREQ_IDX) flatEnergy[i * numCols + freqIdx + 1] = 0;
        if (freqIdx > 0) flatEnergy[i * numCols + freqIdx - 1] = 0;
        i += 1;
      }
      const iEnd = i - 1 - k;
      const fwdZeroEnd = i - 1;
      i = iMid - 1;
      k = 0;
      while (i > 0 && k < energyTolerance) {
        if (flatEnergy[i * numCols + freqIdx] < inferredFrameThresh) {
          k += 1;
        } else {
          k = 0;
        }
        flatEnergy[i * numCols + freqIdx] = 0;
        if (freqIdx < MAX_FREQ_IDX) flatEnergy[i * numCols + freqIdx + 1] = 0;
        if (freqIdx > 0) flatEnergy[i * numCols + freqIdx - 1] = 0;
        i -= 1;
      }
      const iStart = i + 1 + k;
      const bwdZeroStart = i + 1;

      // Update colMax for affected columns (freqIdx-1, freqIdx, freqIdx+1).
      // Only rescan if the previous max row was in the zeroed range.
      const zeroStart = Math.min(iMid, bwdZeroStart);
      const zeroEnd = Math.max(iMid, fwdZeroEnd);
      for (let dc = -1; dc <= 1; dc++) {
        const c = freqIdx + dc;
        if (c < 0 || c >= numCols) continue;
        if (colMaxRow[c] >= zeroStart && colMaxRow[c] <= zeroEnd) {
          let newMax = -1;
          let newRow = 0;
          for (let r = 0; r < nFrames; r++) {
            const v = flatEnergy[r * numCols + c];
            if (v > newMax) {
              newMax = v;
              newRow = r;
            }
          }
          colMaxValue[c] = newMax;
          colMaxRow[c] = newRow;
        }
      }

      if (iStart < 0 || iEnd >= nFrames) continue;
      let frameSum = 0;
      for (let j = iStart; j < iEnd; j++) {
        frameSum += frames[j][freqIdx];
      }
      const amplitude = frameSum / (iEnd - iStart);
      if (iEnd - iStart <= minNoteLen) continue;
      noteEvents.push({
        startFrame: iStart,
        durationFrames: iEnd - iStart,
        pitchMidi: freqIdx + MIDI_OFFSET,
        amplitude: amplitude,
      });
    }
  }
  return noteEvents;
}

/**
 * Convert a 2D tensor to an array of Float32Array rows (subarray views into
 * a single flat TypedArray returned by dataSync()).
 *
 * This replaces tensor.arraySync() which builds nested JS arrays (slow, many
 * small allocations). dataSync() returns a flat Float32Array in a single
 * bulk transfer; subarray views provide O(1) row access with zero copying.
 *
 * The returned rows are VIEWS into the underlying buffer — modifications to a
 * row mutate the buffer. Callers that need a copy should use row.slice().
 */
function tensorTo2DRows(tensor, numCols) {
  const flatData = tensor.dataSync();
  const numRows = Math.floor(flatData.length / numCols);
  const rows = new Array(numRows);
  for (let r = 0; r < numRows; r++) {
    rows[r] = flatData.subarray(r * numCols, (r + 1) * numCols);
  }
  return rows;
}

function midiToHz(midi) {
  return 440.0 * 2.0 ** ((midi - 69.0) / 12.0);
}

function hzToMidi(hz) {
  return 12 * (Math.log2(hz) - Math.log2(440.0)) + 69;
}

const ANNOT_N_FRAMES = ANNOTATIONS_FPS * AUDIO_WINDOW_LENGTH_SECONDS;
const WINDOW_OFFSET =
  (FFT_HOP / BASIC_PITCH_SAMPLE_RATE) * (ANNOT_N_FRAMES - AUDIO_N_SAMPLES / FFT_HOP) +
  0.0018;

function modelFrameToTime(frame) {
  return (frame * FFT_HOP) / BASIC_PITCH_SAMPLE_RATE -
    WINDOW_OFFSET * Math.floor(frame / ANNOT_N_FRAMES);
}

function noteFramesToTime(notes) {
  return notes.map(note => ({
    pitchMidi: note.pitchMidi,
    amplitude: note.amplitude,
    pitchBends: note.pitchBends,
    startTimeSeconds: modelFrameToTime(note.startFrame),
    durationSeconds:
      modelFrameToTime(note.startFrame + note.durationFrames) -
      modelFrameToTime(note.startFrame),
  }));
}

function midiPitchToContourBin(pitchMidi) {
  return 12.0 * CONTOUR_BINS_PER_SEMITONE *
    Math.log2(midiToHz(pitchMidi) / 27.5);
}

function addPitchBendsToNoteEvents(contours, notes, nBinsTolerance = 25) {
  const windowLength = nBinsTolerance * 2 + 1;
  const freqGaussian = gaussian(windowLength, 5);
  return notes.map(note => {
    const freqIdx = Math.floor(Math.round(midiPitchToContourBin(note.pitchMidi)));
    const freqStartIdx = Math.max(freqIdx - nBinsTolerance, 0);
    const freqEndIdx = Math.min(N_FREQ_BINS_CONTOURS, freqIdx + nBinsTolerance + 1);
    const freqGuassianSubMatrix = freqGaussian.slice(
      Math.max(0, nBinsTolerance - freqIdx),
      windowLength - Math.max(0, freqIdx - (N_FREQ_BINS_CONTOURS - nBinsTolerance - 1)),
    );
    const pitchBendSubmatrix = contours
      .slice(note.startFrame, note.startFrame + note.durationFrames)
      .map(d =>
        d
          .slice(freqStartIdx, freqEndIdx)
          .map((v, col) => v * freqGuassianSubMatrix[col]),
      );
    const pbShift = nBinsTolerance - Math.max(0, nBinsTolerance - freqIdx);
    const bends = argMaxAxis1(pitchBendSubmatrix).map(v => v - pbShift);
    return {
      ...note,
      pitchBends: bends,
    };
  });
}

class BasicPitchDetector {
  constructor(modelDir) {
    this.modelDir = modelDir;
    this.model = null;
    this.initialized = false;
    this._server = null;
    this._serverPort = null;
  }

  _startLocalServer() {
    return new Promise((resolve, reject) => {
      const http = require('http');
      const fs = require('fs');
      const modelPath = path.join(this.modelDir, 'basic_pitch_model');

      const contentTypeMap = {
        '.json': 'application/json',
        '.bin': 'application/octet-stream',
      };

      const server = http.createServer((req, res) => {
        const filePath = path.resolve(modelPath, req.url.replace(/^\//, ''));
        // 防止路径遍历攻击
        if (!filePath.startsWith(path.resolve(modelPath) + path.sep) && filePath !== path.resolve(modelPath)) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        if (!fs.existsSync(filePath)) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        const ext = path.extname(filePath);
        const contentType = contentTypeMap[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(filePath).pipe(res);
      });

      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        this._serverPort = address.port;
        resolve(`http://127.0.0.1:${address.port}`);
      });

      server.on('error', reject);
      this._server = server;
    });
  }

  async init() {
    if (this.initialized) return true;

    // 设置 WASM 后端以加速推理
    try {
      await tf.setBackend('wasm');
      await tf.ready();
      console.log('[BasicPitchDetector] TF.js backend set to WASM');
    } catch (e) {
      console.warn('[BasicPitchDetector] WASM backend init failed, falling back to CPU backend:', e.message);
      await tf.setBackend('cpu');
      await tf.ready();
    }

    const modelPath = path.join(this.modelDir, 'basic_pitch_model');
    console.log('[BasicPitchDetector] attempting to load model:', modelPath);

    const fs = require('fs');
    const modelJsonPath = path.join(modelPath, 'model.json');
    if (!fs.existsSync(modelJsonPath)) {
      const errMsg = `[BasicPitchDetector] model file does not exist: ${modelJsonPath}`;
      console.error(errMsg);
      const err = new Error(errMsg);
      err.code = 'MODEL_NOT_FOUND';
      err.modelPath = modelJsonPath;
      throw err;
    }

    const baseUrl = await this._startLocalServer();
    try {
      this.model = await loadGraphModel(`${baseUrl}/model.json`);
      this.initialized = true;
      console.log('[BasicPitchDetector] model loaded successfully');
      return true;
    } catch (err) {
      console.error('[BasicPitchDetector] model load failed:', err.message);
      if (this._server) { this._server.close(); this._server = null; this._serverPort = null; }
      err.modelPath = modelJsonPath;
      throw err;
    }
  }

  dispose() {
    if (this._server) {
      this._server.close();
      this._server = null;
      this._serverPort = null;
    }
    if (this.model) {
      this.model.dispose();
      this.model = null;
    }
    this.initialized = false;
  }

  // 注意：extractF0AndNotes 用的是模块级 resampleAudio（utils/resampleAudio 的
  // Kaiser 版，见文件顶部 require）。这个方法只被 test/basicPitch.test.js 覆盖，
  // 生产路径不再调用；保留是为了不破坏既有单测。
  resampleAudio(audioData, fromSampleRate, toSampleRate) {
    const ratio = fromSampleRate / toSampleRate;
    const newLength = Math.floor(audioData.length / ratio);
    const resampled = new Float32Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const srcIndex = i * ratio;
      const srcIndexInt = Math.floor(srcIndex);
      const frac = srcIndex - srcIndexInt;

      if (srcIndexInt + 1 < audioData.length) {
        resampled[i] = audioData[srcIndexInt] * (1 - frac) + audioData[srcIndexInt + 1] * frac;
      } else {
        resampled[i] = audioData[srcIndexInt] || 0;
      }
    }

    return resampled;
  }

  async extractF0AndNotes(audioData, sampleRate, bpm = 120) {
    if (!this.initialized) {
      await this.init();
    }
    // 2.3: 与 FCPE/RMVPE 一样移除 `= 44100` 兜底，漏传采样率直接报错。
    const sr = requireSampleRate(sampleRate, 'BasicPitchDetector.extractF0AndNotes');

    const resampledAudio = sr !== BASIC_PITCH_SAMPLE_RATE
      ? resampleAudio(audioData, sr, BASIC_PITCH_SAMPLE_RATE)
      : audioData;

    const wavSamples = tf.concat1d([
      tf.zeros([Math.floor(OVERLAP_LENGTH_FRAMES / 2)], 'float32'),
      tf.tensor1d(resampledAudio, 'float32'),
    ]);

    const reshapedInput = tf.expandDims(
      tf.signal.frame(wavSamples, AUDIO_N_SAMPLES, HOP_SIZE, true, 0),
      -1
    );

    const audioOriginalLength = resampledAudio.length;
    const nOutputFramesOriginal = Math.floor(audioOriginalLength * (ANNOTATIONS_FPS / BASIC_PITCH_SAMPLE_RATE));

    const allFrames = [];
    const allOnsets = [];
    const allContours = [];
    let calculatedFrames = 0;

    const batchSize = reshapedInput.shape[0];

    // P7: 逐窗 execute(batch=1) 的固定开销（每次 run 的调度/拷贝）远大于单窗
    // 计算量，日志也是每窗一行。这里按 WINDOW_BATCH_SIZE 累积窗口后一次 execute
    // ——模型输入的 batch 维是可变的（原来就是从整段里 slice 出 [1,...]），
    // unwrapOutput 的 reshape 对 batch>1 同样成立，输出再按窗切回。
    // 内存上限：8 窗输入(~1.4MB float32)+输出(~1.4MB)，不会随音频时长增长。
    const WINDOW_BATCH_SIZE = 8;

    try {
      for (let startWindow = 0; startWindow < batchSize; startWindow += WINDOW_BATCH_SIZE) {
        if (calculatedFrames >= nOutputFramesOriginal) break;
        const nWindows = Math.min(WINDOW_BATCH_SIZE, batchSize - startWindow);
        console.log(`[BasicPitchDetector] processing frames: ${startWindow + 1}-${startWindow + nWindows}/${batchSize}`);

        const batchInput = tf.slice(reshapedInput, [startWindow, 0, 0], [nWindows, -1, -1]);
        const model = await this.model;
        const results = model.execute(batchInput, ['Identity_1', 'Identity_2', 'Identity']);

        let unwrappedResultingFrames = null;
        let unwrappedResultingOnsets = null;
        let unwrappedResultingContours = null;
        try {
          unwrappedResultingFrames = this.unwrapOutput(results[0]);
          unwrappedResultingOnsets = this.unwrapOutput(results[1]);
          unwrappedResultingContours = this.unwrapOutput(results[2]);

          const frameRows = tensorTo2DRows(unwrappedResultingFrames, N_FREQ_BINS_CONTOURS);
          const onsetRows = tensorTo2DRows(unwrappedResultingOnsets, N_FREQ_BINS_CONTOURS);
          const contourRows = tensorTo2DRows(unwrappedResultingContours, N_FREQ_BINS_CONTOURS);

          // 每窗在各自 rows 里占的行数（batch 内各窗相同）。注意 contour 的列宽
          // 与 frames/onsets 不同（模型输出 264 列，而 tensorTo2DRows 统一按
          // N_FREQ_BINS_CONTOURS=88 切），所以它每窗占的行数是 frames 的整数倍，
          // 必须分别换算，不能共用一个 rowsPerWindow。
          const frameRowsPerWindow = Math.floor(frameRows.length / nWindows);
          const onsetRowsPerWindow = Math.floor(onsetRows.length / nWindows);
          const contourRowsPerWindow = Math.floor(contourRows.length / nWindows);
          const contourRowsPerFrameRow = frameRowsPerWindow > 0
            ? Math.round(contourRowsPerWindow / frameRowsPerWindow)
            : 1;

          for (let w = 0; w < nWindows; w++) {
            if (calculatedFrames >= nOutputFramesOriginal) break;
            // 末窗按目标总帧数截断（与原逐窗 slice 行为一致）
            const framesToOutput = Math.min(frameRowsPerWindow, nOutputFramesOriginal - calculatedFrames);
            allFrames.push(frameRows.slice(
              w * frameRowsPerWindow, w * frameRowsPerWindow + framesToOutput,
            ));
            allOnsets.push(onsetRows.slice(
              w * onsetRowsPerWindow, w * onsetRowsPerWindow + framesToOutput,
            ));
            const contourFrom = w * contourRowsPerWindow;
            allContours.push(contourRows.slice(
              contourFrom, contourFrom + framesToOutput * contourRowsPerFrameRow,
            ));
            calculatedFrames += framesToOutput;
          }
        } finally {
          batchInput.dispose();
          results.forEach(t => t.dispose());
          if (unwrappedResultingFrames) unwrappedResultingFrames.dispose();
          if (unwrappedResultingOnsets) unwrappedResultingOnsets.dispose();
          if (unwrappedResultingContours) unwrappedResultingContours.dispose();
        }
      }
    } finally {
      reshapedInput.dispose();
      wavSamples.dispose();
    }

    const frames = allFrames.flat();
    const onsets = allOnsets.flat();
    const contours = allContours.flat();

    // C6: 第 3 个参数是 onsetThresh（默认 0.5），不是 CONTOUR_BINS_PER_SEMITONE。
    // 之前误把常量 1 传进去：onsets 经 sigmoid 后恒 <1，onset 分支永不触发，
    // 只剩下 melodiaTrick 补的音符。
    const noteArray = outputToNotesPoly(frames, onsets, 0.5);
    const timeNoteArray = noteFramesToTime(noteArray);
    // 注：contours 的实际列数是 264（模型 signature [B,T,264] = 88 半音 × 3 sub-bin），
    // 而历史代码用 N_FREQ_BINS_CONTOURS=88 切列，导致每帧被切成 3 行、行号与帧号
    // 存在 3 倍错位。此处沿用历史的窄容差（CONTOUR_BINS_PER_SEMITONE=1），把错位
    // 的影响压到最小；若改用默认 25 会放大错位、产生可闻的 pitch bend 偏差。
    // 彻底修复需按 264 列切分并把该常量改为 3（独立 DSP 变更，需真实音频对比）。
    const noteEventsTime = addPitchBendsToNoteEvents(contours, timeNoteArray, CONTOUR_BINS_PER_SEMITONE);

    const adjustedNotes = noteEventsTime.map(note => ({
      startTimeSeconds: note.startTimeSeconds,
      durationSeconds: note.durationSeconds,
      pitch_midi: note.pitchMidi,
      amplitude: note.amplitude,
      pitchBends: note.pitchBends,
    }));

    const f0Array = this.notesToF0Array(adjustedNotes);
    const midiNotes = this.notesToMidiNotes(adjustedNotes, bpm);

    return {
      f0Array,
      notes: midiNotes,
    };
  }

  unwrapOutput(result) {
    let rawOutput = result;
    rawOutput = result.slice([0, N_OVERLAP_OVER_2, 0], [-1, result.shape[1] - 2 * N_OVERLAP_OVER_2, -1]);
    const outputShape = rawOutput.shape;
    return rawOutput.reshape([outputShape[0] * outputShape[1], outputShape[2]]);
  }

  notesToF0Array(notes) {
    const f0Array = [];
    const frameDuration = 1 / ANNOTATIONS_FPS;

    if (notes.length === 0) return f0Array;

    let lastTime = 0;
    for (const note of notes) {
      const startTime = note.startTimeSeconds;
      const duration = note.durationSeconds;
      const f0 = midiToHz(note.pitch_midi);

      while (lastTime < startTime) {
        f0Array.push({ time: lastTime, f0: 0 });
        lastTime += frameDuration;
      }

      const endTime = startTime + duration;
      while (lastTime < endTime) {
        f0Array.push({ time: lastTime, f0: f0 });
        lastTime += frameDuration;
      }
    }

    return f0Array;
  }

  notesToMidiNotes(notes, bpm) {
    const midiNotes = [];
    const beatDuration = 60 / bpm;

    for (const note of notes) {
      const start = note.startTimeSeconds / beatDuration;
      const duration = note.durationSeconds / beatDuration;
      const pitch = note.pitch_midi;

      if (pitch >= 24 && pitch <= 108) {
        midiNotes.push({
          id: ++_noteIdCounter,
          pitch,
          start,
          duration,
          lyric: 'la',
        });
      }
    }

    return midiNotes;
  }
}

module.exports = {
  BasicPitchDetector,
  BASIC_PITCH_SAMPLE_RATE,
  midiToHz,
  hzToMidi,
  gaussian,
  argMax,
  argMaxAxis1,
  whereGreaterThanAxis1,
  meanStdDev,
  globalMax,
};
