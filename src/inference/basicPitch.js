const path = require('node:path');
const tf = require('@tensorflow/tfjs');
const { resampleAudio } = require('../utils/resampleAudio');

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
const F0_MIN = 30;
const F0_MAX = 7600;

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
  if (melodiaTrick === true) {
    while (globalMax(remainingEnergy) > inferredFrameThresh) {
      let maxVal = -1;
      let iMid = 0;
      let freqIdx = 0;
      for (let r = 0; r < remainingEnergy.length; r++) {
        for (let c = 0; c < remainingEnergy[r].length; c++) {
          if (remainingEnergy[r][c] > maxVal) {
            maxVal = remainingEnergy[r][c];
            iMid = r;
            freqIdx = c;
          }
        }
      }
      remainingEnergy[iMid][freqIdx] = 0;
      let i = iMid + 1;
      let k = 0;
      while (i < nFrames - 1 && k < energyTolerance) {
        if (remainingEnergy[i][freqIdx] < inferredFrameThresh) {
          k += 1;
        } else {
          k = 0;
        }
        remainingEnergy[i][freqIdx] = 0;
        if (freqIdx < MAX_FREQ_IDX) remainingEnergy[i][freqIdx + 1] = 0;
        if (freqIdx > 0) remainingEnergy[i][freqIdx - 1] = 0;
        i += 1;
      }
      const iEnd = i - 1 - k;
      i = iMid - 1;
      k = 0;
      while (i > 0 && k < energyTolerance) {
        if (remainingEnergy[i][freqIdx] < inferredFrameThresh) {
          k += 1;
        } else {
          k = 0;
        }
        remainingEnergy[i][freqIdx] = 0;
        if (freqIdx < MAX_FREQ_IDX) remainingEnergy[i][freqIdx + 1] = 0;
        if (freqIdx > 0) remainingEnergy[i][freqIdx - 1] = 0;
        i -= 1;
      }
      const iStart = i + 1 + k;
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

    const modelPath = path.join(this.modelDir, 'basic_pitch_model');
    console.log('[BasicPitchDetector] 尝试加载模型:', modelPath);

    const fs = require('fs');
    const modelJsonPath = path.join(modelPath, 'model.json');
    if (!fs.existsSync(modelJsonPath)) {
      const errMsg = `[BasicPitchDetector] 模型文件不存在: ${modelJsonPath}`;
      console.error(errMsg);
      const err = new Error(errMsg);
      err.code = 'MODEL_NOT_FOUND';
      err.modelPath = modelJsonPath;
      throw err;
    }

    try {
      const baseUrl = await this._startLocalServer();
      this.model = await tf.loadGraphModel(`${baseUrl}/model.json`);
      this.initialized = true;
      console.log('[BasicPitchDetector] 模型加载成功');
      return true;
    } catch (err) {
      console.error('[BasicPitchDetector] 模型加载失败:', err.message);
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

  async extractF0AndNotes(audioData, sampleRate = 44100, bpm = 120) {
    if (!this.initialized) {
      await this.init();
    }

    const resampledAudio = sampleRate !== BASIC_PITCH_SAMPLE_RATE
      ? resampleAudio(audioData, sampleRate, BASIC_PITCH_SAMPLE_RATE)
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

    for (let i = 0; i < batchSize; ++i) {
      console.log(`[BasicPitchDetector] 处理帧: ${i + 1}/${batchSize}`);

      const singleBatch = tf.slice(reshapedInput, [i, 0, 0], [1, -1, -1]);
      const model = await this.model;
      const results = model.execute(singleBatch, ['Identity_1', 'Identity_2', 'Identity']);

      let unwrappedResultingFrames = this.unwrapOutput(results[0]);
      let unwrappedResultingOnsets = this.unwrapOutput(results[1]);
      let unwrappedResultingContours = this.unwrapOutput(results[2]);

      const calculatedFramesTmp = unwrappedResultingFrames.shape[0];

      if (calculatedFrames >= nOutputFramesOriginal) {
        singleBatch.dispose();
        results.forEach(t => t.dispose());
        unwrappedResultingFrames.dispose();
        unwrappedResultingOnsets.dispose();
        unwrappedResultingContours.dispose();
        continue;
      }

      if (calculatedFramesTmp + calculatedFrames >= nOutputFramesOriginal) {
        const framesToOutput = nOutputFramesOriginal - calculatedFrames;
        const slicedFrames = unwrappedResultingFrames.slice([0, 0], [framesToOutput, -1]);
        const slicedOnsets = unwrappedResultingOnsets.slice([0, 0], [framesToOutput, -1]);
        const slicedContours = unwrappedResultingContours.slice([0, 0], [framesToOutput, -1]);

        allFrames.push(slicedFrames.arraySync());
        allOnsets.push(slicedOnsets.arraySync());
        allContours.push(slicedContours.arraySync());

        slicedFrames.dispose();
        slicedOnsets.dispose();
        slicedContours.dispose();
      } else {
        allFrames.push(unwrappedResultingFrames.arraySync());
        allOnsets.push(unwrappedResultingOnsets.arraySync());
        allContours.push(unwrappedResultingContours.arraySync());
      }

      calculatedFrames += calculatedFramesTmp;

      singleBatch.dispose();
      results.forEach(t => t.dispose());
      unwrappedResultingFrames.dispose();
      unwrappedResultingOnsets.dispose();
      unwrappedResultingContours.dispose();
    }

    reshapedInput.dispose();
    wavSamples.dispose();

    const frames = allFrames.flat();
    const onsets = allOnsets.flat();
    const contours = allContours.flat();

    const noteArray = outputToNotesPoly(frames, onsets, CONTOUR_BINS_PER_SEMITONE);
    const timeNoteArray = noteFramesToTime(noteArray);
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
          id: Date.now() + Math.random(),
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
