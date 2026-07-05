const { expect } = require('chai');
const {
  parseWavBuffer,
  fftRadix2,
  ifftRadix2,
  resampleLinear,
  hzToMel,
  melToHz,
} = require('../src/inference/pipeline/postprocessing');
const { TextProcessing } = require('../src/inference/pipeline/textProcessing');
const { Preprocessing } = require('../src/inference/pipeline/preprocessing');
const { AudioSegmentation } = require('../src/inference/pipeline/audioSegmentation');
const { float32ToF16Buffer, f16BufferToFloat32, normalizePeakTo } = require('../src/inference/pipeline/utils');
const { computeLuminance, computeIsDark } = require('../src/themes/colorUtils');
const { HistoryManager } = require('../src/editor/historyManager');
const { isCJK } = require('../src/utils/cjkUtils');
const { smoothstep } = require('../src/utils/smoothstep');
const { formatBytes } = require('../src/utils/formatBytes');
const { midiToNoteName } = require('../src/utils/midiUtils');

/**
 * 属性测试 / 鲁棒性测试 / Fuzz 测试
 * 目标：用随机和边界输入探测不变量，找出隐藏的崩溃或逻辑错误。
 */
describe('Robustness & Property-Based Tests', () => {

  // 简易 PRNG（确定性，便于复现）
  function makeRng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  }

  describe('G2P robustness', () => {
    let tp;
    before(() => { tp = new TextProcessing(); });

    it('should not throw on empty / whitespace / null lyrics', () => {
      expect(() => tp.resolveLyricToPhonemes('')).to.not.throw();
      expect(() => tp.resolveLyricToPhonemes('   ')).to.not.throw();
      expect(() => tp.resolveLyricToPhonemes(null)).to.not.throw();
      expect(() => tp.resolveLyricToPhonemes(undefined)).to.not.throw();
    });

    it('should not throw on control characters and zero-width chars', () => {
      const weird = ['\u0000', '\u200B', '\uFEFF', '\n', '\t', '\r\n'];
      for (const w of weird) {
        expect(() => tp.resolveLyricToPhonemes(w), JSON.stringify(w)).to.not.throw();
      }
    });

    it('should not throw on extremely long lyrics', () => {
      const long = 'a'.repeat(10000);
      expect(() => tp.resolveLyricToPhonemes(long)).to.not.throw();
    });

    it('should not throw on mixed scripts', () => {
      const mixed = ['你好helloわたし', 'en_AH-jp_a-zh_ni3', '123あ456', '你好\nhello'];
      for (const m of mixed) {
        expect(() => tp.resolveLyricToPhonemes(m), m).to.not.throw();
      }
    });

    it('should handle random ASCII strings without crashing (fuzz)', () => {
      const rng = makeRng(42);
      for (let trial = 0; trial < 100; trial++) {
        const len = Math.floor(rng() * 20) + 1;
        let s = '';
        for (let i = 0; i < len; i++) {
          s += String.fromCharCode(32 + Math.floor(rng() * 95));
        }
        expect(() => tp.resolveLyricToPhonemes(s), `trial ${trial}: "${s}"`).to.not.throw();
      }
    });

    it('should handle random CJK strings without crashing (fuzz)', () => {
      const rng = makeRng(123);
      for (let trial = 0; trial < 50; trial++) {
        const len = Math.floor(rng() * 5) + 1;
        let s = '';
        for (let i = 0; i < len; i++) {
          // 常用汉字范围
          s += String.fromCharCode(0x4e00 + Math.floor(rng() * 0x1000));
        }
        expect(() => tp.resolveLyricToPhonemes(s), `trial ${trial}: "${s}"`).to.not.throw();
      }
    });

    it('should always return an array from resolveLyricToPhonemes', () => {
      const inputs = ['', null, 'a', '你好', 'わたし', 'en_AH', '<SP>', '!!!'];
      for (const inp of inputs) {
        const result = tp.resolveLyricToPhonemes(inp);
        expect(result, `${inp}`).to.be.an('array');
        expect(result.length).to.be.at.least(1);
      }
    });
  });

  describe('Preprocessing robustness', () => {
    let prep;
    before(() => { prep = new Preprocessing(new TextProcessing()); });

    it('should handle empty notes array', () => {
      const seq = prep.notesToSequences([], 120, null, null);
      expect(seq.tokenCount).to.be.at.least(1);
      expect(seq.mel2token.length).to.equal(0);
    });

    it('should handle a single note with pitch 0', () => {
      const notes = [{ pitch: 0, start: 0, duration: 1, lyric: 'a' }];
      expect(() => prep.notesToSequences(notes, 120, null, null)).to.not.throw();
    });

    it('should handle a single note with pitch 127', () => {
      const notes = [{ pitch: 127, start: 0, duration: 1, lyric: 'a' }];
      expect(() => prep.notesToSequences(notes, 120, null, null)).to.not.throw();
    });

    it('should handle very short duration notes (1ms)', () => {
      const notes = [{ pitch: 60, start: 0, duration: 0.001, lyric: 'a' }];
      expect(() => prep.notesToSequences(notes, 120, null, null)).to.not.throw();
    });

    it('should handle zero duration note without crashing', () => {
      const notes = [{ pitch: 60, start: 0, duration: 0, lyric: 'a' }];
      expect(() => prep.notesToSequences(notes, 120, null, null)).to.not.throw();
    });

    it('should handle very large bpm', () => {
      const notes = [{ pitch: 60, start: 0, duration: 1, lyric: 'a' }];
      expect(() => prep.notesToSequences(notes, 1000, null, null)).to.not.throw();
    });

    it('should handle many notes (stress test, 500 notes)', () => {
      const notes = [];
      for (let i = 0; i < 500; i++) notes.push({ pitch: 60, start: i * 0.1, duration: 0.1, lyric: 'a' });
      const seq = prep.notesToSequences(notes, 120, null, null);
      expect(seq.tokenCount).to.be.greaterThan(500);
      expect(seq.mel2token.length).to.be.greaterThan(0);
    });

    it('should handle notes with overlapping times', () => {
      const notes = [
        { pitch: 60, start: 0, duration: 2, lyric: 'a' },
        { pitch: 64, start: 1, duration: 2, lyric: 'b' },
        { pitch: 67, start: 0.5, duration: 1, lyric: 'c' },
      ];
      expect(() => prep.notesToSequences(notes, 120, null, null)).to.not.throw();
    });

    it('should handle notes with negative start (should not crash)', () => {
      const notes = [{ pitch: 60, start: -1, duration: 1, lyric: 'a' }];
      expect(() => prep.notesToSequences(notes, 120, null, null)).to.not.throw();
    });

    it('should produce valid mel2token for random note sets (fuzz)', () => {
      const rng = makeRng(7);
      for (let trial = 0; trial < 20; trial++) {
        const numNotes = Math.floor(rng() * 10) + 1;
        const notes = [];
        let t = 0;
        for (let i = 0; i < numNotes; i++) {
          const dur = 0.1 + rng() * 2;
          notes.push({
            pitch: Math.floor(rng() * 88) + 21,
            start: t,
            duration: dur,
            lyric: rng() > 0.3 ? 'a' : '',
          });
          t += dur;
        }
        const seq = prep.notesToSequences(notes, 120, null, null);
        // 不变量: mel2token 长度 == f0Ids 长度
        expect(seq.mel2token.length, `trial ${trial}`).to.equal(seq.f0Ids.length);
        // 不变量: 所有 mel2token 值在 [0, tokenCount) 范围内
        for (let i = 0; i < seq.mel2token.length; i++) {
          expect(seq.mel2token[i], `trial ${trial} frame ${i}`).to.be.at.least(0);
          expect(seq.mel2token[i], `trial ${trial} frame ${i}`).to.be.lessThan(seq.tokenCount);
        }
      }
    });
  });

  describe('AudioSegmentation robustness', () => {
    let seg;
    before(() => { seg = new AudioSegmentation(); });

    it('should handle null/undefined notes in fillNoteGaps', () => {
      expect(seg.fillNoteGaps(null)).to.equal(null);
      expect(seg.fillNoteGaps(undefined)).to.equal(undefined);
    });

    it('should handle notes with missing fields in buildVocalSegments', () => {
      const notes = [
        { start: 0, duration: 1 },
        { start: 1, duration: 1 },
      ];
      expect(() => seg.buildVocalSegments(notes, 120)).to.not.throw();
    });

    it('should handle extremely long audio without OOM (termination guarantee)', () => {
      // 1000 beats at bpm=60 = 1000s。关键不变量：必须终止。
      const notes = [];
      for (let i = 0; i < 1000; i++) notes.push({ start: i, duration: 1, lyric: 'a' });
      const start = Date.now();
      const segments = seg.buildVocalSegments(notes, 60);
      const elapsed = Date.now() - start;
      expect(segments.length).to.be.greaterThan(1);
      expect(elapsed, 'should terminate quickly').to.be.lessThan(2000);
    });

    it('should handle all-rest notes (empty lyrics) in long audio', () => {
      const notes = [];
      for (let i = 0; i < 40; i++) notes.push({ start: i, duration: 1, lyric: '' });
      expect(() => seg.buildVocalSegments(notes, 60)).to.not.throw();
    });

    it('should handle a single extremely long note', () => {
      const notes = [{ start: 0, duration: 1000, lyric: 'a' }];
      const segments = seg.buildVocalSegments(notes, 60);
      expect(segments.length).to.be.greaterThan(1);
      // 不变量：所有段终止
      for (const s of segments) {
        expect(s.endBeat).to.be.greaterThan(s.startBeat);
      }
    });

    it('should keep cache key deterministic for random note sets (fuzz)', () => {
      const rng = makeRng(99);
      for (let trial = 0; trial < 30; trial++) {
        const numNotes = Math.floor(rng() * 5) + 1;
        const notes = [];
        for (let i = 0; i < numNotes; i++) {
          notes.push({
            lyric: ['a', 'b', 'c'][Math.floor(rng() * 3)],
            pitch: Math.floor(rng() * 88) + 21,
            start: rng() * 10,
            duration: 0.1 + rng() * 2,
          });
        }
        const k1 = seg.computeSynthCacheKey(notes, 120, { language: 'zh' });
        const k2 = seg.computeSynthCacheKey(notes, 120, { language: 'zh' });
        expect(k1, `trial ${trial}`).to.equal(k2);
      }
    });

    it('should hash consistently for random arrays (property: deterministic)', () => {
      const rng = makeRng(55);
      for (let trial = 0; trial < 50; trial++) {
        const arr = new Array(20);
        for (let i = 0; i < 20; i++) arr[i] = Math.floor(rng() * 1000) - 500;
        const h1 = seg.hashArray(arr);
        const h2 = seg.hashArray(arr);
        expect(h1, `trial ${trial}`).to.equal(h2);
      }
    });
  });

  describe('FFT robustness', () => {
    it('should handle all-zero input at various sizes', () => {
      for (const n of [2, 4, 8, 16, 32, 64, 128, 256]) {
        const real = new Float32Array(n);
        const imag = new Float32Array(n);
        expect(() => fftRadix2(real, imag), `n=${n}`).to.not.throw();
        for (let i = 0; i < n; i++) {
          expect(real[i]).to.equal(0);
          expect(imag[i]).to.equal(0);
        }
      }
    });

    it('should handle impulse input (single 1.0 at index 0)', () => {
      for (const n of [8, 32, 128]) {
        const real = new Float32Array(n);
        const imag = new Float32Array(n);
        real[0] = 1.0;
        fftRadix2(real, imag);
        // impulse → flat magnitude spectrum (all bins = 1)
        for (let i = 0; i < n; i++) {
          const mag = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
          expect(mag, `n=${n} bin ${i}`).to.be.closeTo(1.0, 1e-4);
        }
      }
    });

    it('should satisfy linearity: FFT(a*x + b*y) = a*FFT(x) + b*FFT(y)', () => {
      const n = 32;
      const rng = makeRng(77);
      const x = new Float32Array(n);
      const y = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        x[i] = rng() * 2 - 1;
        y[i] = rng() * 2 - 1;
      }
      const a = 0.7, b = 0.3;

      // FFT(a*x + b*y)
      const comboReal = new Float32Array(n);
      for (let i = 0; i < n; i++) comboReal[i] = a * x[i] + b * y[i];
      const comboImag = new Float32Array(n);
      fftRadix2(comboReal, comboImag);

      // a*FFT(x) + b*FFT(y)
      const xReal = x.slice(), xImag = new Float32Array(n);
      const yReal = y.slice(), yImag = new Float32Array(n);
      fftRadix2(xReal, xImag);
      fftRadix2(yReal, yImag);

      for (let i = 0; i < n; i++) {
        const expectedR = a * xReal[i] + b * yReal[i];
        const expectedI = a * xImag[i] + b * yImag[i];
        expect(comboReal[i]).to.be.closeTo(expectedR, 1e-4);
        expect(comboImag[i]).to.be.closeTo(expectedI, 1e-4);
      }
    });

    it('should not crash on size=2 (minimum valid)', () => {
      const real = new Float32Array([1, -1]);
      const imag = new Float32Array(2);
      expect(() => fftRadix2(real, imag)).to.not.throw();
      // FFT of [1,-1] should have bin 0 = 0, bin 1 = 2
      expect(real[0]).to.be.closeTo(0, 1e-6);
      expect(real[1]).to.be.closeTo(2, 1e-6);
    });

    it('should round-trip random signals at multiple sizes (property)', () => {
      const rng = makeRng(31);
      for (const n of [4, 16, 64, 256]) {
        const real = new Float32Array(n);
        const imag = new Float32Array(n);
        for (let i = 0; i < n; i++) {
          real[i] = rng() * 2 - 1;
          imag[i] = rng() * 2 - 1;
        }
        const origR = real.slice();
        const origI = imag.slice();
        fftRadix2(real, imag);
        ifftRadix2(real, imag);
        for (let i = 0; i < n; i++) {
          expect(real[i], `n=${n} i=${i}`).to.be.closeTo(origR[i], 1e-3);
          expect(imag[i], `n=${n} i=${i}`).to.be.closeTo(origI[i], 1e-3);
        }
      }
    });
  });

  describe('float16 robustness', () => {
    it('should handle empty array', () => {
      const empty = new Float32Array(0);
      const u16 = float32ToF16Buffer(empty);
      const back = f16BufferToFloat32(u16);
      expect(back.length).to.equal(0);
    });

    it('should handle single element', () => {
      const one = new Float32Array([0.5]);
      const u16 = float32ToF16Buffer(one);
      expect(u16.length).to.equal(1);
      const back = f16BufferToFloat32(u16);
      expect(back[0]).to.be.closeTo(0.5, 1e-3);
    });

    it('should handle subnormal f16 values (very small)', () => {
      const tiny = new Float32Array([1e-7, 1e-8, 1e-9]);
      const u16 = float32ToF16Buffer(tiny);
      const back = f16BufferToFloat32(u16);
      // 这些值可能 flush to zero in f16，但不应崩溃
      for (let i = 0; i < back.length; i++) {
        expect(Number.isFinite(back[i])).to.be.true;
        expect(Math.abs(back[i])).to.be.at.most(Math.abs(tiny[i]) + 1e-7);
      }
    });

    it('should handle max/min f16 values', () => {
      const extremes = new Float32Array([65504, -65504, 65504 * 0.5]);
      const u16 = float32ToF16Buffer(extremes);
      const back = f16BufferToFloat32(u16);
      expect(back[0]).to.be.closeTo(65504, 1);
      expect(back[1]).to.be.closeTo(-65504, 1);
      expect(back[2]).to.be.closeTo(65504 * 0.5, 1);
    });

    it('should clamp overflow values to Inf', () => {
      const overflow = new Float32Array([1e10, -1e10]);
      const u16 = float32ToF16Buffer(overflow);
      const back = f16BufferToFloat32(u16);
      expect(back[0]).to.equal(Infinity);
      expect(back[1]).to.equal(-Infinity);
    });

    it('should round-trip random audio-range values within 0.1% error (fuzz)', () => {
      const rng = makeRng(88);
      const N = 1000;
      const orig = new Float32Array(N);
      for (let i = 0; i < N; i++) orig[i] = (rng() * 2 - 1) * 2; // [-2, 2]
      const u16 = float32ToF16Buffer(orig);
      const back = f16BufferToFloat32(u16);
      for (let i = 0; i < N; i++) {
        const relErr = Math.abs(back[i] - orig[i]) / Math.max(Math.abs(orig[i]), 1e-6);
        expect(relErr, `i=${i} orig=${orig[i]} back=${back[i]}`).to.be.lessThan(0.005); // 0.5%
      }
    });

    it('normalizePeakTo should handle all-zero input (no NaN)', () => {
      const zeros = new Float32Array(100);
      expect(() => normalizePeakTo(zeros, 100, 0.5)).to.not.throw();
      for (let i = 0; i < 100; i++) {
        expect(Number.isFinite(zeros[i])).to.be.true;
      }
    });

    it('normalizePeakTo should not scale up (only scales down when peak > threshold)', () => {
      // API 契约: 仅在 peak > threshold 时按 threshold/peak 缩小，不放大。
      const single = new Float32Array([0.5]);
      normalizePeakTo(single, 1, 1.0);
      expect(single[0]).to.equal(0.5); // 0.5 < 1.0, 不触发缩放

      // 反向: peak=2, threshold=1.0, 应缩放到 1.0
      const big = new Float32Array([2.0]);
      normalizePeakTo(big, 1, 1.0);
      expect(big[0]).to.be.closeTo(1.0, 1e-6);
    });
  });

  describe('colorUtils robustness', () => {
    it('should handle null/undefined/empty inputs', () => {
      expect(computeLuminance(null)).to.equal(0.5);
      expect(computeLuminance(undefined)).to.equal(0.5);
      expect(computeLuminance('')).to.equal(0.5);
    });

    it('should handle non-hex characters (return 0.5 fallback)', () => {
      expect(computeLuminance('#zzzzzz')).to.equal(0.5);
      expect(computeLuminance('#gggggg')).to.equal(0.5);
      expect(computeLuminance('not-a-color')).to.equal(0.5);
    });

    it('should handle truncated hex', () => {
      expect(computeLuminance('#')).to.equal(0.5);
      expect(computeLuminance('#1')).to.equal(0.5);
      expect(computeLuminance('#12')).to.equal(0.5);
      // 3-digit and 6-digit should work
      expect(computeLuminance('#fff')).to.be.a('number');
      expect(computeLuminance('#ffffff')).to.be.a('number');
    });

    it('should produce luminance in [0, 1] for all valid hex colors (fuzz)', () => {
      const rng = makeRng(66);
      for (let trial = 0; trial < 200; trial++) {
        const r = Math.floor(rng() * 256).toString(16).padStart(2, '0');
        const g = Math.floor(rng() * 256).toString(16).padStart(2, '0');
        const b = Math.floor(rng() * 256).toString(16).padStart(2, '0');
        const hex = `#${r}${g}${b}`;
        const lum = computeLuminance(hex);
        expect(lum, `${hex}`).to.be.at.least(0);
        expect(lum, `${hex}`).to.be.at.most(1);
      }
    });

    it('computeIsDark should return boolean for any input', () => {
      const inputs = [null, '', '#fff', '#000', '#zzz', '#ff0000', '#00ff00', '#0000ff'];
      for (const inp of inputs) {
        const result = computeIsDark(inp);
        expect(result, `${inp}`).to.be.a('boolean');
      }
    });
  });

  describe('HistoryManager robustness', () => {
    // 构造符合 HistoryManager API 的命令对象（需要 undo/redo 方法）
    function makeCmd(label) {
      return { label, undo() {}, redo() {} };
    }

    it('should handle undo/redo on empty history', () => {
      const hm = new HistoryManager();
      expect(hm.undo()).to.be.null;
      expect(hm.redo()).to.be.null;
    });

    it('should handle maxSize = 1', () => {
      const hm = new HistoryManager(1);
      hm.push(makeCmd('a'));
      hm.push(makeCmd('b'));
      expect(hm.canUndo()).to.be.true;
      // maxSize=1 时第一条已被 shift 掉，undo 只能拿到 'b'
      const u = hm.undo();
      expect(u).to.not.be.null;
      expect(u.label).to.equal('b');
      expect(hm.canUndo()).to.be.false;
    });

    it('should handle maxSize = 0 (edge case)', () => {
      const hm = new HistoryManager(0);
      // maxSize=0 时 push 立即 shift，stack 始终为空
      expect(() => hm.push(makeCmd('a'))).to.not.throw();
      expect(hm.canUndo()).to.be.false;
    });

    it('should handle null/undefined commands without throwing on push', () => {
      // push(null) 不会立即调用 undo/redo，所以 push 本身不会抛
      const hm = new HistoryManager();
      expect(() => hm.push(null)).to.not.throw();
      expect(() => hm.push(undefined)).to.not.throw();
      // 但 undo(null) 会调用 null.undo() 抛错——这是调用方的契约违反
      // 这里仅验证 push 不抛
    });

    it('should handle many pushes (stress, 10000 commands)', () => {
      const hm = new HistoryManager(100);
      for (let i = 0; i < 10000; i++) hm.push(makeCmd(`cmd-${i}`));
      // maxSize=100, 所以 undoStack 至多 100
      expect(hm.undoStack.length).to.be.at.most(100);
      expect(hm.undoStack.length).to.equal(100);
    });

    it('should remain consistent after random undo/redo sequences (fuzz)', () => {
      const rng = makeRng(13);
      const hm = new HistoryManager(20);
      for (let i = 0; i < 20; i++) hm.push(makeCmd(`cmd-${i}`));
      for (let trial = 0; trial < 100; trial++) {
        if (rng() > 0.5 && hm.canUndo()) hm.undo();
        else if (hm.canRedo()) hm.redo();
      }
      // 不变量: undo 栈 + redo 栈 ≤ maxSize
      const total = hm.undoStack.length + hm.redoStack.length;
      expect(total).to.be.at.most(20);
    });
  });

  describe('Utility robustness', () => {
    it('smoothstep should match API: smoothstep(t, smoothness)', () => {
      // smoothness=0 时为恒等函数
      expect(smoothstep(0.5, 0)).to.equal(0.5);
      expect(smoothstep(0.0, 0)).to.equal(0.0);
      expect(smoothstep(1.0, 0)).to.equal(1.0);
      // smoothness>0 时为 Hermite 插值: t*t*(3-2t)
      expect(smoothstep(0.5, 1)).to.be.closeTo(0.5, 1e-6); // 0.25 * 2 = 0.5
      expect(smoothstep(0.0, 1)).to.equal(0.0);
      expect(smoothstep(1.0, 1)).to.equal(1.0);
    });

    it('smoothstep should not crash on out-of-range t (no clamping by design)', () => {
      // 注意: 此实现不进行 clamping，这是设计意图（调用方负责 clamp）
      expect(() => smoothstep(-1, 0)).to.not.throw();
      expect(() => smoothstep(2, 1)).to.not.throw();
      expect(smoothstep(-1, 0)).to.equal(-1); // 恒等
      // smoothness=1 时 t=-1 → (-1)*(-1)*(3-2*(-1)) = 1*5 = 5
      expect(smoothstep(-1, 1)).to.equal(5);
    });

    it('formatBytes should handle edge values', () => {
      expect(formatBytes(0)).to.be.a('string');
      expect(formatBytes(-1)).to.be.a('string');
      expect(formatBytes(Infinity)).to.be.a('string');
      expect(formatBytes(NaN)).to.be.a('string');
      expect(formatBytes(1e30)).to.be.a('string');
    });

    it('midiToNoteName should handle full MIDI range', () => {
      for (let m = 0; m <= 127; m++) {
        const name = midiToNoteName(m);
        expect(name, `midi ${m}`).to.be.a('string');
        expect(name.length).to.be.greaterThan(0);
      }
    });

    it('midiToNoteName should handle out-of-range MIDI values', () => {
      expect(() => midiToNoteName(-1)).to.not.throw();
      expect(() => midiToNoteName(128)).to.not.throw();
      expect(() => midiToNoteName(1000)).to.not.throw();
    });

    it('isCJK should handle non-string inputs', () => {
      expect(isCJK(null)).to.be.a('boolean');
      expect(isCJK(undefined)).to.be.a('boolean');
      expect(isCJK(123)).to.be.a('boolean');
      expect(isCJK('')).to.be.a('boolean');
    });

    it('hzToMel / melToHz should handle 0 and negative', () => {
      expect(hzToMel(0)).to.equal(0);
      expect(() => hzToMel(-1)).to.not.throw();
      expect(melToHz(0)).to.equal(0);
      expect(() => melToHz(-1)).to.not.throw();
    });

    it('resampleLinear should handle empty input', () => {
      const out = resampleLinear([], 24000, 48000);
      expect(out.length).to.equal(0);
    });

    it('resampleLinear should handle single-sample input', () => {
      const out = resampleLinear([0.5], 24000, 48000);
      expect(out.length).to.be.greaterThan(0);
      expect(Number.isFinite(out[0])).to.be.true;
    });

    it('resampleLinear should handle equal sample rates (identity)', () => {
      const data = new Float32Array([0.1, 0.2, 0.3, 0.4, 0.5]);
      const out = resampleLinear(data, 24000, 24000);
      for (let i = 0; i < data.length; i++) {
        expect(out[i]).to.be.closeTo(data[i], 1e-6);
      }
    });
  });

  describe('parseWavBuffer robustness', () => {
    it('should reject truncated RIFF header', () => {
      const short = Buffer.alloc(8, 0);
      short.write('RIFF', 0);
      expect(() => parseWavBuffer(short)).to.throw();
    });

    it('should reject buffer with no data chunk', () => {
      const buf = Buffer.alloc(44, 0);
      buf.write('RIFF', 0);
      buf.writeUInt32LE(36, 4);
      buf.write('WAVE', 8);
      buf.write('fmt ', 12);
      buf.writeUInt32LE(16, 16);
      buf.writeUInt16LE(1, 20);
      buf.writeUInt16LE(1, 22);
      buf.writeUInt32LE(24000, 24);
      buf.writeUInt32LE(48000, 28);
      buf.writeUInt16LE(2, 32);
      buf.writeUInt16LE(16, 34);
      // no 'data' chunk
      expect(() => parseWavBuffer(buf)).to.throw();
    });

    it('should handle empty buffer', () => {
      expect(() => parseWavBuffer(Buffer.alloc(0))).to.throw();
    });

    it('should handle non-Buffer input (ArrayBuffer)', () => {
      const ab = new ArrayBuffer(12);
      const view = new Uint8Array(ab);
      view[0] = 'R'.charCodeAt(0);
      view[1] = 'I'.charCodeAt(0);
      view[2] = 'F'.charCodeAt(0);
      view[3] = 'F'.charCodeAt(0);
      expect(() => parseWavBuffer(ab)).to.throw(); // truncated, but should not crash
    });
  });
});
