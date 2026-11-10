'use strict';
/**
 * prompt cond 对齐回归测试。
 *
 * 背景：app 过去只编码 target，prompt 段 cond 全 0；仓库的官方对比脚本
 * scripts/verify_e2e_precision.py 会把 prompt token + target token 拼在一起
 * 跑 encoder/preflow。本文件锁住：
 *   1) 从 .sxssinger 的 MIDI/歌词/F0 构建 prompt token 序列并与参考 mel 对齐；
 *   2) runEncoder 的 prompt+target 合并、f0 顺序、cond 前缀不再被 PAD/f0-bin0 污染；
 *   3) score 模式把 prompt/target f0 一起清零，但保留 prompt 的 text 条件。
 */
const { expect } = require('chai');
const ort = require('onnxruntime-node');
const { TextProcessing } = require('../src/inference/pipeline/textProcessing');
const { Preprocessing } = require('../src/inference/pipeline/preprocessing');
const { EMBED_DIM, COND_DIM, MEL_DIM } = require('../src/inference/pipeline/constants');

function makeSingerData(overrides = {}) {
  const f0 = new Array(100).fill(0);
  for (let i = 10; i < 100; i++) f0[i] = 220;
  return {
    text: 'zh_a1 zh_a2 zh_a3 zh_a4',
    duration: '0.5 0.5 0.5 0.5',
    note_pitch: '60 62 64 65',
    note_type: '2 2 2 2',
    f0: f0.map(v => v.toFixed(1)).join(' '),
    trimOffsetSec: 0,
    ...overrides,
  };
}

function makeMidiNotes() {
  return [
    { lyric: 'zh_a1', pitch: 60, start: 0, duration: 1 },
    { lyric: 'zh_a2', pitch: 62, start: 1, duration: 1 },
    { lyric: 'zh_a3', pitch: 64, start: 2, duration: 1 },
    { lyric: 'zh_a4', pitch: 65, start: 3, duration: 1 },
  ];
}

function makeMel(frames) {
  const m = new Float32Array(frames * MEL_DIM);
  for (let f = 0; f < frames; f++) m[f * MEL_DIM] = f;
  return m;
}

describe('prompt cond alignment', () => {
  let tp;
  let prep;

  before(() => {
    tp = new TextProcessing();
    prep = new Preprocessing(tp);
  });

  describe('buildPromptSequence', () => {
    it('caps the prompt and keeps mel2token/f0/mel in sync', () => {
      const out = prep.buildPromptSequence(
        makeSingerData(), makeMidiNotes(), null, makeMel(100), 100,
        { maxPromptFrames: 50 }
      );
      expect(out.promptSeq).to.be.an('object');
      expect(out.ptFrameCount).to.equal(50);
      expect(out.promptSeq.mel2token.length).to.equal(50);
      expect(out.promptSeq.f0Ids.length).to.equal(50);
      expect(out.promptSeq.tokenCount).to.be.greaterThan(1);
      expect(out.ptMelData.length).to.equal(50 * MEL_DIM);
      expect(out.promptSeq.mel2token[0]).to.equal(1); // BOW
    });

    it('shifts the mel crop by trimOffsetSec', () => {
      const out = prep.buildPromptSequence(
        makeSingerData({ trimOffsetSec: 0.4 }), makeMidiNotes(), null, makeMel(100), 100,
        { maxPromptFrames: 25 }
      );
      expect(out.promptSeq).to.be.an('object');
      expect(out.ptFrameCount).to.equal(25);
      // 0.4s @50Hz = 20 帧
      expect(out.ptMelData[0]).to.equal(20);
    });

    it('uses f0Data when available and leaves leading unvoiced frames at bin 0', () => {
      const f0Data = [];
      for (let i = 0; i < 100; i++) f0Data.push({ time: i / 50, f0: i < 20 ? 0 : 330 });
      const out = prep.buildPromptSequence(
        makeSingerData({ f0: '' }), makeMidiNotes(), f0Data, makeMel(100), 100,
        { maxPromptFrames: 30 }
      );
      expect(out.promptSeq).to.be.an('object');
      expect(out.promptSeq.f0Ids[0]).to.equal(0);
      expect(out.promptSeq.f0Ids[25]).to.be.greaterThan(0);
    });

    it('fills note gaps with rests so the token timeline matches the mel', () => {
      const notes = [
        { lyric: 'zh_a1', pitch: 60, start: 0, duration: 1 },
        { lyric: 'zh_a4', pitch: 64, start: 3, duration: 1 },
      ];
      const sd = makeSingerData({
        text: 'zh_a1 zh_a4', duration: '0.5 0.5',
        note_pitch: '60 64', note_type: '2 2',
      });
      const out = prep.buildPromptSequence(sd, notes, null, makeMel(120), 120, { maxPromptFrames: 100 });
      expect(out.promptSeq).to.be.an('object');
      // 0.5s note + 1.0s gap + 0.5s note = 2.0s -> 100 帧
      expect(out.promptSeq.mel2token.length).to.equal(100);
      // PAD + 3 + 3(rest) + 3 = 10 token
      expect(out.promptSeq.tokenCount).to.equal(10);
    });

    it('returns null when there is no annotation or no reference mel', () => {
      expect(prep.buildPromptSequence(null, makeMidiNotes(), null, makeMel(100), 100).promptSeq).to.equal(null);
      expect(prep.buildPromptSequence(makeSingerData(), makeMidiNotes(), null, null, 0).promptSeq).to.equal(null);
    });

    it('caps a 30s reference prompt to 5s by default; maxPromptFrames=0 disables the cap', () => {
      const N = 60; // 60 × 0.5s = 30s
      const text = [];
      const dur = [];
      const pitch = [];
      const type = [];
      const midi = [];
      for (let i = 0; i < N; i++) {
        const syllable = `zh_a${(i % 4) + 1}`;
        text.push(syllable);
        dur.push('0.5');
        pitch.push(String(60 + (i % 5)));
        type.push('2');
        midi.push({ lyric: syllable, pitch: 60 + (i % 5), start: i, duration: 1 });
      }
      const f0 = new Array(1500).fill(220);
      const sd = {
        text: text.join(' '), duration: dur.join(' '),
        note_pitch: pitch.join(' '), note_type: type.join(' '),
        f0: f0.map(v => v.toFixed(1)).join(' '), trimOffsetSec: 0,
      };
      const capped = prep.buildPromptSequence(sd, midi, null, makeMel(1500), 1500, {});
      expect(capped.ptFrameCount).to.equal(250);
      const full = prep.buildPromptSequence(sd, midi, null, makeMel(1500), 1500, { maxPromptFrames: 0 });
      expect(full.ptFrameCount).to.equal(1500);
    });
  });

  describe('runEncoder prompt merge', () => {
    function makeSessions(capture) {
      const textEncoder = {
        run: async (feeds) => {
          const n = feeds.input_ids.dims[1];
          const d = new Float32Array(n * EMBED_DIM);
          for (let i = 0; i < n; i++) d.fill(i + 1, i * EMBED_DIM, (i + 1) * EMBED_DIM);
          return { embeddings: new ort.Tensor('float32', d, [1, n, EMBED_DIM]) };
        },
      };
      const zeroEncoder = {
        run: async (feeds) => {
          const n = feeds.input_ids.dims[1];
          return { embeddings: new ort.Tensor('float32', new Float32Array(n * EMBED_DIM), [1, n, EMBED_DIM]) };
        },
      };
      return {
        noteTextEncoder: textEncoder,
        notePitchEncoder: zeroEncoder,
        noteTypeEncoder: zeroEncoder,
        f0Encoder: {
          run: async (feeds) => {
            const n = feeds.input_ids.dims[1];
            const ids = Array.from(feeds.input_ids.data, Number);
            capture.f0 = ids;
            const d = new Float32Array(n * EMBED_DIM);
            for (let i = 0; i < n; i++) {
              d.fill(ids[i] > 10 ? 2 : 0, i * EMBED_DIM, (i + 1) * EMBED_DIM);
            }
            return { embeddings: new ort.Tensor('float32', d, [1, n, EMBED_DIM]) };
          },
        },
        preflow: {
          run: async (feeds) => {
            capture.preflowDims = feeds.features.dims;
            return { processed_features: new ort.Tensor('float32', feeds.features.data, feeds.features.dims) };
          },
        },
        condEmb: {
          run: async (feeds) => {
            capture.condDims = feeds.cond_code.dims;
            capture.cond = Array.from(feeds.cond_code.data);
            const n = feeds.cond_code.dims[1];
            return { cond_embedding: new ort.Tensor('float32', new Float32Array(n * COND_DIM), [1, n, COND_DIM]) };
          },
        },
      };
    }

    function makeSequences() {
      return {
        tokenCount: 3,
        noteTextSeq: Int32Array.from([0, 6, 7]),
        notePitchSeq: Int32Array.from([0, 60, 62]),
        noteTypeSeq: Int32Array.from([1, 2, 2]),
        f0Ids: Int32Array.from([17, 18, 19, 20]),
        mel2token: Int32Array.from([0, 1, 2, 2]),
      };
    }

    function makePromptSeq() {
      return {
        tokenCount: 3,
        noteTextSeq: Int32Array.from([0, 8, 9]),
        notePitchSeq: Int32Array.from([0, 55, 57]),
        noteTypeSeq: Int32Array.from([1, 2, 2]),
        f0Ids: Int32Array.from([5, 6]),
        mel2token: Int32Array.from([0, 1]),
      };
    }

    it('concatenates prompt+target tokens/f0 and expands both sections', async () => {
      const capture = {};
      const seq = makeSequences();
      await prep.runEncoder(makeSessions(capture), seq, 3, 4, false, 2, false, false, makePromptSeq());

      expect(capture.f0).to.deep.equal([5, 6, 17, 18, 19, 20]);
      expect(capture.preflowDims).to.deep.equal([1, 6, EMBED_DIM]);
      expect(capture.condDims).to.deep.equal([1, 6, EMBED_DIM]);
      // prompt frame 0 -> prompt token 0 (text=1) + f0 bin 5 (mock=0) = 1
      expect(capture.cond[0]).to.be.closeTo(1, 1e-6);
      // prompt frame 1 -> prompt token 1 (text=2)
      expect(capture.cond[EMBED_DIM]).to.be.closeTo(2, 1e-6);
      // target frame 0 -> target token 3 (text=4) + target f0 (mock=2) = 6
      expect(capture.cond[2 * EMBED_DIM]).to.be.closeTo(6, 1e-6);
    });

    it('keeps the prompt cond exactly zero when no promptSeq is supplied', async () => {
      const capture = {};
      const seq = makeSequences();
      await prep.runEncoder(makeSessions(capture), seq, 3, 4, false, 2, false, false, null);

      expect(capture.f0).to.deep.equal([0, 0, 17, 18, 19, 20]);
      expect(capture.preflowDims).to.deep.equal([1, 3, EMBED_DIM]);
      expect(capture.cond[0]).to.equal(0);
      // target frame 0 -> target token 0 (text=1) + f0 (mock=2) = 3
      expect(capture.cond[2 * EMBED_DIM]).to.be.closeTo(3, 1e-6);
    });

    it('score mode zeros prompt+target f0 but keeps prompt text cond', async () => {
      const capture = {};
      const seq = makeSequences();
      await prep.runEncoder(makeSessions(capture), seq, 3, 4, false, 2, false, true, makePromptSeq());

      expect(capture.f0).to.deep.equal([0, 0, 0, 0, 0, 0]);
      expect(capture.cond[0]).to.be.closeTo(1, 1e-6);
      // target frame 0 -> target token 3 (text=4) + f0 0 = 4
      expect(capture.cond[2 * EMBED_DIM]).to.be.closeTo(4, 1e-6);
    });
  });
});
