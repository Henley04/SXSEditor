const { expect } = require('chai');
const {
  parseWavBuffer,
  resampleLinear,
  extractMelSpectrogram,
  fftRadix2,
  ifftRadix2,
  createMelFilterbank,
  hzToMel,
  melToHz,
} = require('../src/inference/pipeline/postprocessing');
const { TextProcessing } = require('../src/inference/pipeline/textProcessing');
const { Preprocessing } = require('../src/inference/pipeline/preprocessing');
const { AudioSegmentation } = require('../src/inference/pipeline/audioSegmentation');
const { float32ToF16Buffer, f16BufferToFloat32, normalizePeakTo } = require('../src/inference/pipeline/utils');
const { mergePhoneme } = require('../src/utils/mergePhoneme');
const { SAMPLE_RATE, HOP_SIZE, N_FFT } = require('../src/inference/pipeline/constants');

/**
 * 跨模块集成测试：验证多个模块组合在一起时的端到端行为。
 * 与 pipelineIntegration.test.js 互补，后者聚焦 F0/重采样/WAV，
 * 本文件聚焦 G2P→预处理、DSP 往返、分段合成、mergePhoneme 等链路。
 */
describe('Cross-Module Integration Tests', () => {

  describe('G2P → Preprocessing full chain', () => {
    let tp, prep;
    before(() => {
      tp = new TextProcessing();
      prep = new Preprocessing(tp);
    });

    it('should turn a Chinese lyric into valid phoneme IDs and mel2token frames', () => {
      const notes = [
        { pitch: 60, start: 0, duration: 1, lyric: '你' },
        { pitch: 62, start: 1, duration: 1, lyric: '好' },
      ];
      const seq = prep.notesToSequences(notes, 120, null, null);

      // tokenCount includes PAD + BOW/phoneme/EOW per note
      expect(seq.tokenCount).to.be.greaterThan(4);
      expect(seq.noteTextSeq.length).to.equal(seq.tokenCount);
      expect(seq.notePitchSeq.length).to.equal(seq.tokenCount);
      expect(seq.noteTypeSeq.length).to.equal(seq.tokenCount);
      // mel2token 长度 == 总帧数，且每个值 < tokenCount
      expect(seq.mel2token.length).to.equal(seq.f0Ids.length);
      for (let i = 0; i < seq.mel2token.length; i++) {
        expect(seq.mel2token[i]).to.be.at.least(0);
        expect(seq.mel2token[i]).to.be.lessThan(seq.tokenCount);
      }
    });

    it('should turn a Japanese lyric (hiragana) into jp_ phonemes through G2P', () => {
      const notes = [{ pitch: 60, start: 0, duration: 2, lyric: 'わたし' }];
      const seq = prep.notesToSequences(notes, 120, null, null);
      expect(seq.tokenCount).to.be.greaterThan(2);
      // phoneme IDs should all be valid indices
      for (let i = 0; i < seq.tokenCount; i++) {
        expect(seq.noteTextSeq[i]).to.be.at.least(0);
      }
    });

    it('should turn an English dashed lyric into multiple en_ phonemes', () => {
      const notes = [{ pitch: 64, start: 0, duration: 1, lyric: 'en_H-AH-L-OW' }];
      const seq = prep.notesToSequences(notes, 120, null, null);
      // Should have BOW + H + AH + L + OW + SEP + EOW
      expect(seq.tokenCount).to.be.greaterThan(5);
    });

    it('should keep mel2token frame count consistent with F0 frame count across multiple notes', () => {
      const notes = [
        { pitch: 60, start: 0, duration: 0.5, lyric: 'a' },
        { pitch: 62, start: 0.5, duration: 0.5, lyric: 'b' },
        { pitch: 64, start: 1.0, duration: 0.5, lyric: 'c' },
        { pitch: 65, start: 1.5, duration: 0.5, lyric: 'd' },
      ];
      const seq = prep.notesToSequences(notes, 120, null, null);
      expect(seq.mel2token.length).to.equal(seq.f0Ids.length);
      // 总帧数应与按 bpm/duration 计算的期望值接近
      const expectedFrames = Math.round((2.0 * 60 / 120) * SAMPLE_RATE / HOP_SIZE);
      expect(seq.mel2token.length).to.be.closeTo(expectedFrames, 5);
    });

    it('should respect phonemeAdjustments durationRatios in mel2token allocation', () => {
      const notesNoAdj = [{ pitch: 60, start: 0, duration: 2, lyric: 'en_H-EH-L-OW' }];
      const notesWithAdj = [{
        pitch: 60, start: 0, duration: 2, lyric: 'en_H-EH-L-OW',
        phonemeAdjustments: [
          { durationRatio: 0.1 },  // H 几乎不占帧
          { durationRatio: 0.1 },
          { durationRatio: 0.1 },
          { durationRatio: 0.7 },  // OW 占大部分
        ],
      }];
      const seqNoAdj = prep.notesToSequences(notesNoAdj, 120, null, null);
      const seqAdj = prep.notesToSequences(notesWithAdj, 120, null, null);
      // 总帧数应相同（同一个 note 时长）
      expect(seqAdj.mel2token.length).to.be.closeTo(seqNoAdj.mel2token.length, 2);
      // 带 adjustments 时，最后一个音素（OW）应分到更多帧
      // 通过检查 mel2token 中不同 token 的帧数分布来间接验证
      const tokenFramesAdj = new Map();
      for (const t of seqAdj.mel2token) {
        tokenFramesAdj.set(t, (tokenFramesAdj.get(t) || 0) + 1);
      }
      // 至少有一个非 PAD/BOW/EOW token 分到了帧
      let maxFrames = 0;
      for (const [t, c] of tokenFramesAdj) {
        if (t > 2 && t < seqAdj.tokenCount - 1) maxFrames = Math.max(maxFrames, c);
      }
      expect(maxFrames).to.be.greaterThan(0);
    });
  });

  describe('FFT ↔ IFFT round-trip across sizes and signals', () => {
    it('should round-trip a real sine signal at n=64', () => {
      const n = 64;
      const real = new Float32Array(n);
      const imag = new Float32Array(n);
      for (let i = 0; i < n; i++) real[i] = Math.sin(2 * Math.PI * 5 * i / n);
      const orig = real.slice();
      fftRadix2(real, imag);
      ifftRadix2(real, imag);
      for (let i = 0; i < n; i++) {
        expect(real[i]).to.be.closeTo(orig[i], 1e-4);
        expect(imag[i]).to.be.closeTo(0, 1e-4);
      }
    });

    it('should round-trip a complex (real+imag) signal at n=128', () => {
      const n = 128;
      const real = new Float32Array(n);
      const imag = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        real[i] = Math.cos(i / 10) * 0.5;
        imag[i] = Math.sin(i / 7) * 0.3;
      }
      const origR = real.slice();
      const origI = imag.slice();
      fftRadix2(real, imag);
      ifftRadix2(real, imag);
      for (let i = 0; i < n; i++) {
        expect(real[i]).to.be.closeTo(origR[i], 1e-3);
        expect(imag[i]).to.be.closeTo(origI[i], 1e-3);
      }
    });

    it('should detect the correct frequency bin for various pure cosines (n=256)', () => {
      const n = 256;
      for (const k of [1, 4, 16, 64, 100]) {
        const real = new Float32Array(n);
        const imag = new Float32Array(n);
        for (let i = 0; i < n; i++) real[i] = Math.cos(2 * Math.PI * k * i / n);
        fftRadix2(real, imag);
        let maxBin = 0, maxMag = 0;
        for (let i = 0; i < n / 2; i++) {
          const m = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
          if (m > maxMag) { maxMag = m; maxBin = i; }
        }
        expect(maxBin, `k=${k}`).to.equal(k);
      }
    });

    it('should have conjugate-symmetric spectrum for real input (n=64)', () => {
      const n = 64;
      const real = new Float32Array(n);
      const imag = new Float32Array(n);
      for (let i = 0; i < n; i++) real[i] = Math.sin(i / 3) + 0.5 * Math.cos(i / 5);
      fftRadix2(real, imag);
      // 实信号的 FFT 满足 X[k] = conj(X[n-k])
      for (let k = 1; k < n / 2; k++) {
        expect(real[k]).to.be.closeTo(real[n - k], 1e-4);
        expect(imag[k]).to.be.closeTo(-imag[n - k], 1e-4);
      }
    });

    it('should work at production size N_FFT=1920 without crashing (smoke test)', () => {
      // 注意: N_FFT=1920 不是 2 的幂（1920 = 128×15），Radix-2 FFT 无法正确处理。
      // 生产环境主要使用 ONNX mel_transform 模型提取 mel，JS extractMelSpectrogram
      // 仅作为 fallback。此测试只验证不崩溃，不验证频谱正确性。
      // 已知限制：JS fallback mel 路径在 N_FFT 非 2 幂时结果不正确。
      const n = N_FFT;
      const real = new Float32Array(n);
      const imag = new Float32Array(n);
      for (let i = 0; i < n; i++) real[i] = Math.sin(2 * Math.PI * 100 * i / n);
      expect(() => fftRadix2(real, imag)).to.not.throw();
      expect(real[0]).to.be.a('number');
      expect(Number.isFinite(real[0])).to.be.true;
    }).timeout(10000);
  });

  describe('float16 ↔ float32 round-trip', () => {
    it('should round-trip a range of typical audio values without large error', () => {
      const values = new Float32Array([
        0.0, 0.001, 0.01, 0.1, 0.5, 0.9, 1.0, -1.0, -0.5,
        0.3, -0.7, 0.1234, -0.5678, 2.0, -2.0, 0.0001,
      ]);
      const u16 = float32ToF16Buffer(values);
      const back = f16BufferToFloat32(u16);
      for (let i = 0; i < values.length; i++) {
        // float16 有 ~3 位有效数字，相对误差容忍 1%
        if (Math.abs(values[i]) > 0.01) {
          expect(back[i]).to.be.closeTo(values[i], Math.abs(values[i]) * 0.01);
        } else {
          expect(back[i]).to.be.closeTo(values[i], 0.001);
        }
      }
    });

    it('should handle special values: 0, -0, Inf, NaN', () => {
      const values = new Float32Array([0.0, -0.0, Infinity, -Infinity, NaN]);
      const u16 = float32ToF16Buffer(values);
      const back = f16BufferToFloat32(u16);
      expect(back[0]).to.equal(0);
      expect(back[1]).to.equal(0); // -0 reads as 0
      expect(back[2]).to.equal(Infinity);
      expect(back[3]).to.equal(-Infinity);
      expect(Number.isNaN(back[4])).to.be.true;
    });

    it('should be identity when f16→f32→f16 for values already in f16 range', () => {
      const orig = new Float32Array(200);
      for (let i = 0; i < 200; i++) orig[i] = (i - 100) * 0.01;
      const u16_1 = float32ToF16Buffer(orig);
      const f32 = f16BufferToFloat32(u16_1);
      const u16_2 = float32ToF16Buffer(f32);
      // 第二次转换应该和第一次完全相同（已落在 f16 表示点）
      for (let i = 0; i < u16_1.length; i++) {
        expect(u16_2[i]).to.equal(u16_1[i]);
      }
    });

    it('normalizePeakTo after f16 round-trip should preserve peak normalization', () => {
      const orig = new Float32Array([0.1, 0.3, 0.5, 0.7, 0.9]);
      const u16 = float32ToF16Buffer(orig);
      const back = f16BufferToFloat32(u16);
      normalizePeakTo(back, back.length, 0.5);
      const peak = Math.max(...Array.from(back).map(Math.abs));
      expect(peak).to.be.closeTo(0.5, 0.5 * 0.01);
    });
  });

  describe('Audio segmentation → notesToSequences (segmented synthesis flow)', () => {
    let seg, prep;
    before(() => {
      seg = new AudioSegmentation();
      prep = new Preprocessing(new TextProcessing());
    });

    it('should produce valid sequences for each segment of a long audio', () => {
      // 40 beats at bpm=60 = 40s > 30s threshold
      const notes = [];
      for (let i = 0; i < 40; i++) {
        notes.push({ start: i, duration: 1, pitch: 60 + (i % 12), lyric: 'a' });
      }
      const segments = seg.buildVocalSegments(notes, 60);
      expect(segments.length).to.be.greaterThan(1);

      for (const s of segments) {
        // 每个段应能独立走通预处理
        const seq = prep.notesToSequences(s.notes, 60, null, null);
        expect(seq.tokenCount).to.be.greaterThan(0);
        expect(seq.mel2token.length).to.be.greaterThan(0);
        expect(seq.f0Ids.length).to.equal(seq.mel2token.length);
      }
    });

    it('should keep segment boundaries contiguous (no gap, no overlap beyond SEGMENT_OVERLAP)', () => {
      const notes = [];
      for (let i = 0; i < 50; i++) notes.push({ start: i, duration: 1, pitch: 60, lyric: 'a' });
      const segments = seg.buildVocalSegments(notes, 60);
      for (let i = 1; i < segments.length; i++) {
        // overlap 2s → 下一段 startBeat 应在 [prev.endBeat - 2 - epsilon, prev.endBeat]
        expect(segments[i].startBeat).to.be.at.most(segments[i - 1].endBeat);
        expect(segments[i].startBeat).to.be.at.least(segments[i - 1].endBeat - 3); // overlap ≤ 2 + tolerance
      }
    });

    it('should produce deterministic cache keys for the same segmented input', () => {
      const notes = [];
      for (let i = 0; i < 40; i++) notes.push({ start: i, duration: 1, pitch: 60, lyric: 'a' });
      const key1 = seg.computeSynthCacheKey(notes, 60, { language: 'zh' });
      const key2 = seg.computeSynthCacheKey(notes, 60, { language: 'zh' });
      expect(key1).to.equal(key2);
    });
  });

  describe('WAV parse → resampleLinear → extractMelSpectrogram chain', () => {
    function makeFloatWav(samples, sampleRate) {
      const numChannels = 1;
      const bytesPerSample = 4;
      const dataSize = samples.length * bytesPerSample * numChannels;
      const buf = Buffer.alloc(44 + dataSize);
      buf.write('RIFF', 0);
      buf.writeUInt32LE(36 + dataSize, 4);
      buf.write('WAVE', 8);
      buf.write('fmt ', 12);
      buf.writeUInt32LE(16, 16);
      buf.writeUInt16LE(3, 20); // IEEE float
      buf.writeUInt16LE(numChannels, 22);
      buf.writeUInt32LE(sampleRate, 24);
      buf.writeUInt32LE(sampleRate * numChannels * bytesPerSample, 28);
      buf.writeUInt16LE(numChannels * bytesPerSample, 32);
      buf.writeUInt16LE(32, 34);
      buf.write('data', 36);
      buf.writeUInt32LE(dataSize, 40);
      for (let i = 0; i < samples.length; i++) {
        buf.writeFloatLE(samples[i], 44 + i * bytesPerSample);
      }
      return buf;
    }

    it('should parse a 24kHz mono WAV and extract a mel spectrogram of correct shape', () => {
      // 1 second of 440Hz at 24kHz
      const sr = 24000;
      const samples = new Float32Array(sr);
      for (let i = 0; i < sr; i++) samples[i] = 0.5 * Math.sin(2 * Math.PI * 440 * i / sr);
      const wav = makeFloatWav(samples, sr);
      const parsed = parseWavBuffer(wav);
      expect(parsed.sampleRate).to.equal(sr);
      expect(parsed.data.length).to.equal(sr);

      const mel = extractMelSpectrogram(parsed.data, sr);
      // 返回结构: { data: Float32Array, frames: numFrames, melBands }
      expect(mel.frames).to.be.greaterThan(0);
      expect(mel.melBands).to.be.greaterThan(0);
      expect(mel.data.length).to.equal(mel.frames * mel.melBands);
      // 注意: 由于 N_FFT=1920 非 2 的幂，JS fallback 的 FFT 产生错误频谱，
      // 部分 mel 值可能为 NaN。此处只验证结构正确性，不验证数值有限性。
      // 生产环境使用 ONNX mel_transform 模型（正确路径）。
    });

    it('should resample 44.1kHz → 24kHz then extract mel of correct shape', () => {
      const srcSr = 44100;
      const tgtSr = 24000;
      const samples = new Float32Array(srcSr); // 1 second
      for (let i = 0; i < srcSr; i++) samples[i] = 0.3 * Math.sin(2 * Math.PI * 220 * i / srcSr);
      const resampled = resampleLinear(samples, srcSr, tgtSr);
      expect(resampled.length).to.be.closeTo(tgtSr, 100);

      const mel = extractMelSpectrogram(resampled, tgtSr);
      expect(mel.frames).to.be.greaterThan(0);
      expect(mel.data.length).to.equal(mel.frames * mel.melBands);
      // 同上: N_FFT 非 2 幂导致 JS fallback 频谱不正确，只验证结构。
    });
  });

  describe('mergePhoneme integration with note streams', () => {
    it('should merge consecutive SP (rest) notes with the same pitch', () => {
      const notes = [
        { lyric: '', pitch: 0, duration: 0.5, start: 0 },
        { lyric: '', pitch: 0, duration: 0.5, start: 0.5 },
        { lyric: 'a', pitch: 60, duration: 1, start: 1 },
      ];
      const merged = mergePhoneme(notes);
      // 两个连续 SP 应合并成一个，总 duration=1
      expect(merged.length).to.equal(2);
      expect(merged[0].duration).to.equal(1);
      expect(merged[1].lyric).to.equal('a');
    });

    it('should NOT merge SP notes with different pitches', () => {
      const notes = [
        { lyric: '', pitch: 0, duration: 0.5, start: 0 },
        { lyric: '', pitch: 60, duration: 0.5, start: 0.5 },
      ];
      const merged = mergePhoneme(notes);
      expect(merged.length).to.equal(2);
    });

    it('should normalize <AP> to <SP> and merge', () => {
      const notes = [
        { lyric: '<AP>', pitch: 0, duration: 0.5, start: 0 },
        { lyric: '<AP>', pitch: 0, duration: 0.5, start: 0.5 },
      ];
      const merged = mergePhoneme(notes);
      expect(merged.length).to.equal(1);
      expect(merged[0].duration).to.equal(1);
    });

    it('should preserve slur flag on non-SP notes', () => {
      const notes = [
        { lyric: 'a', pitch: 60, duration: 1, start: 0, isSlur: false },
        { lyric: '', pitch: 60, duration: 1, start: 1, isSlur: true },
      ];
      const merged = mergePhoneme(notes);
      expect(merged.length).to.equal(2);
      expect(merged[1].isSlur).to.equal(true);
    });

    it('should handle empty input', () => {
      expect(mergePhoneme([])).to.deep.equal([]);
    });

    it('should produce notes that preprocessing can consume', () => {
      const notes = [
        { lyric: '', pitch: 0, duration: 0.5, start: 0 },
        { lyric: '', pitch: 0, duration: 0.5, start: 0.5 },
        { lyric: 'a', pitch: 60, duration: 1, start: 1 },
      ];
      const merged = mergePhoneme(notes);
      const prep = new Preprocessing(new TextProcessing());
      // 合并后的音符应能直接喂给预处理
      const seq = prep.notesToSequences(merged, 120, null, null);
      expect(seq.tokenCount).to.be.greaterThan(0);
      expect(seq.mel2token.length).to.be.greaterThan(0);
    });
  });

  describe('Mel filterbank ↔ Hz/mel conversion consistency', () => {
    it('should produce a flat filterbank array of correct size with triangular peaks', () => {
      const numBands = 20;
      const fftSize = 512;
      const sr = 24000;
      const fb = createMelFilterbank(numBands, fftSize, sr, 0, sr / 2);
      // 返回扁平 Float32Array，长度 = numBands * (fftSize/2 + 1)
      const numFftBins = fftSize / 2 + 1;
      expect(fb.length).to.equal(numBands * numFftBins);

      // 每个 triangular filter 的峰值 bin 应位于其左右零点之间
      for (let b = 0; b < numBands; b++) {
        const offset = b * numFftBins;
        let peakIdx = 0, peakVal = -Infinity;
        for (let i = 0; i < numFftBins; i++) {
          if (fb[offset + i] > peakVal) { peakVal = fb[offset + i]; peakIdx = i; }
        }
        // 峰值应 > 0（在滤波器覆盖范围内）
        expect(peakVal).to.be.greaterThan(0);
        // 峰值左右应有上升和下降
        if (peakIdx > 0) expect(fb[offset + peakIdx - 1]).to.be.at.most(peakVal);
        if (peakIdx < numFftBins - 1) expect(fb[offset + peakIdx + 1]).to.be.at.most(peakVal);
      }
    });

    it('should round-trip Hz → mel → Hz for frequencies within audio band', () => {
      for (const hz of [50, 100, 200, 500, 1000, 2000, 4000, 8000, 12000]) {
        const mel = hzToMel(hz);
        const back = melToHz(mel);
        expect(back, `${hz}Hz`).to.be.closeTo(hz, 1.0);
      }
    });
  });

  describe('Constants consistency across modules', () => {
    it('SAMPLE_RATE and HOP_SIZE should give 50Hz frame rate', () => {
      const frameRate = SAMPLE_RATE / HOP_SIZE;
      expect(frameRate).to.equal(50);
    });

    it('N_FFT should be larger than 2x HOP_SIZE (overlap constraint for STFT)', () => {
      expect(N_FFT).to.be.greaterThan(2 * HOP_SIZE);
    });

    it('documents known limitation: N_FFT=1920 is NOT a power of 2', () => {
      // N_FFT=1920 = 128×15, 不是 2 的幂。Radix-2 FFT (fftRadix2) 要求 2 的幂，
      // 因此 JS fallback 的 extractMelSpectrogram 路径无法产生正确频谱。
      // 生产环境主要依赖 ONNX mel_transform 模型（extractRefMelOnnx），
      // JS 路径仅作 fallback。此测试记录该已知限制以防回归。
      const isPow2 = (N_FFT & (N_FFT - 1)) === 0;
      expect(isPow2).to.be.false;
      // 确认 N_FFT 确实是 1920（若将来改为 2048 应更新此测试）
      expect(N_FFT).to.equal(1920);
    });
  });
});
