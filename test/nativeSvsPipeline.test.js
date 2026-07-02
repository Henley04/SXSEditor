const { NativeSVSPipeline, SAMPLE_RATE } = require('../src/inference/pipeline');
const { expect } = require('chai');
const path = require('path');
const os = require('os');
const fs = require('fs');

describe('NativeSVSPipeline - Pure Logic Tests', () => {
  let pipeline;

  beforeEach(() => {
    pipeline = new NativeSVSPipeline('/fake/model/dir/');
  });

  describe('midiToFreq', () => {
    it('should convert MIDI note 69 to 440 Hz', () => {
      expect(pipeline.midiToFreq(69)).to.be.closeTo(440, 0.001);
    });

    it('should convert MIDI note 60 (C4) to ~261.63 Hz', () => {
      expect(pipeline.midiToFreq(60)).to.be.closeTo(261.63, 0.01);
    });

    it('should convert MIDI note 72 (C5) to ~523.25 Hz', () => {
      expect(pipeline.midiToFreq(72)).to.be.closeTo(523.25, 0.01);
    });

    it('should convert MIDI note 0 to ~8.18 Hz', () => {
      expect(pipeline.midiToFreq(0)).to.be.closeTo(8.18, 0.01);
    });

    it('should convert MIDI note 127 to ~12543 Hz', () => {
      expect(pipeline.midiToFreq(127)).to.be.closeTo(12543.85, 0.01);
    });

    it('should handle negative pitch (extrapolation)', () => {
      const freq = pipeline.midiToFreq(-12);
      expect(freq).to.be.a('number');
      expect(freq).to.be.lessThan(pipeline.midiToFreq(0));
    });
  });

  describe('interpolateEnvelope', () => {
    const envelope = {
      keyframes: [
        { time: 0, value: 0 },
        { time: 1, value: 1 },
        { time: 2, value: 0.5 },
        { time: 4, value: 1 },
      ],
    };

    it('should return first value for time before first keyframe', () => {
      expect(pipeline.interpolateEnvelope(envelope, -1)).to.equal(0);
    });

    it('should return last value for time after last keyframe', () => {
      expect(pipeline.interpolateEnvelope(envelope, 10)).to.equal(1);
    });

    it('should return exact value at keyframe', () => {
      expect(pipeline.interpolateEnvelope(envelope, 0)).to.equal(0);
      expect(pipeline.interpolateEnvelope(envelope, 1)).to.equal(1);
      expect(pipeline.interpolateEnvelope(envelope, 2)).to.equal(0.5);
    });

    it('should interpolate linearly between keyframes', () => {
      const value = pipeline.interpolateEnvelope(envelope, 0.5);
      expect(value).to.be.closeTo(0.5, 0.001);
    });

    it('should handle single keyframe envelope', () => {
      const single = { keyframes: [{ time: 0, value: 0.7 }] };
      expect(pipeline.interpolateEnvelope(single, 0)).to.equal(0.7);
      expect(pipeline.interpolateEnvelope(single, 100)).to.equal(0.7);
    });

    it('should handle empty keyframes', () => {
      const empty = { keyframes: [] };
      expect(pipeline.interpolateEnvelope(empty, 0)).to.equal(0);
    });
  });

  describe('quantizeF0', () => {
    it('should quantize zero frequency to 0', () => {
      const result = pipeline.quantizeF0(new Float32Array([0]));
      expect(result[0]).to.equal(0);
    });

    it('should quantize negative frequency to 0', () => {
      const result = pipeline.quantizeF0(new Float32Array([-100]));
      expect(result[0]).to.equal(0);
    });

    it('should quantize valid frequency to positive bin', () => {
      const result = pipeline.quantizeF0(new Float32Array([440]));
      expect(result[0]).to.be.greaterThan(0);
      expect(result[0]).to.be.lessThanOrEqual(360);
    });

    it('should produce values within valid range [0, 360]', () => {
      const input = new Float32Array([30, 100, 440, 1000, 5000]);
      const result = pipeline.quantizeF0(input);

      for (let i = 0; i < result.length; i++) {
        expect(result[i]).to.be.at.least(0);
        expect(result[i]).to.be.at.most(360);
      }
    });

    it('should preserve array length', () => {
      const input = new Float32Array(100);
      input.fill(440);
      const result = pipeline.quantizeF0(input);
      expect(result.length).to.equal(100);
    });

    it('should produce higher bins for higher frequencies', () => {
      const f0_200 = pipeline.quantizeF0(new Float32Array([200]));
      const f0_400 = pipeline.quantizeF0(new Float32Array([400]));
      const f0_800 = pipeline.quantizeF0(new Float32Array([800]));

      expect(f0_400[0]).to.be.greaterThan(f0_200[0]);
      expect(f0_800[0]).to.be.greaterThan(f0_400[0]);
    });

    it('should use official SoulX-Singer F0 quantization formula', () => {
      const F0_MIN = 32.7031956625;
      const f0 = 440;
      const expectedBin = Math.round(1200 * Math.log2(f0 / F0_MIN) / 20) + 1;
      const result = pipeline.quantizeF0(new Float32Array([f0]));
      expect(result[0]).to.equal(Math.max(1, Math.min(360, expectedBin)));
    });
  });

  describe('buildF0FrameSequence', () => {
    const bpm = 120;

    it('should return empty array for empty notes', () => {
      const result = pipeline.buildF0FrameSequence([], bpm, null);
      expect(result).to.be.an.instanceOf(Float32Array);
      expect(result.length).to.equal(0);
    });

    it('should build F0 frames for a single note', () => {
      const notes = [{ pitch: 60, start: 0, duration: 1 }];
      const result = pipeline.buildF0FrameSequence(notes, bpm, null);

      expect(result).to.be.an.instanceOf(Float32Array);
      expect(result.length).to.be.greaterThan(0);

      const expectedFreq = pipeline.midiToFreq(60);
      expect(result[0]).to.be.closeTo(expectedFreq, 0.01);
    });

    it('should build F0 frames for multiple notes', () => {
      const notes = [
        { pitch: 60, start: 0, duration: 1 },
        { pitch: 64, start: 1, duration: 1 },
        { pitch: 67, start: 2, duration: 1 },
      ];
      const result = pipeline.buildF0FrameSequence(notes, bpm, null);

      expect(result.length).to.be.greaterThan(0);
    });

    it('should apply f0Envelope semitone shift', () => {
      const notes = [{ pitch: 60, start: 0, duration: 2 }];
      const envelope = { keyframes: [{ time: 0, value: 2 }] };
      const result = pipeline.buildF0FrameSequence(notes, bpm, envelope);

      const expectedFreq = pipeline.midiToFreq(62);
      expect(result[0]).to.be.closeTo(expectedFreq, 0.01);
    });

    it('should handle notes starting after time 0', () => {
      const notes = [{ pitch: 60, start: 2, duration: 1 }];
      const result = pipeline.buildF0FrameSequence(notes, bpm, null);

      expect(result.length).to.be.greaterThan(0);
    });
  });

  describe('notesToSequences', () => {
    const bpm = 120;

    it('should convert notes to all required sequences', () => {
      const notes = [
        { pitch: 60, start: 0, duration: 1, lyric: 'a' },
        { pitch: 64, start: 1, duration: 1, lyric: 'b' },
      ];
      const result = pipeline.notesToSequences(notes, bpm, null);

      expect(result).to.have.property('f0Ids');
      expect(result).to.have.property('noteTextSeq');
      expect(result).to.have.property('notePitchSeq');
      expect(result).to.have.property('noteTypeSeq');
      expect(result).to.have.property('mel2token');
      expect(result).to.have.property('tokenCount');
    });

    it('should include BOW/EOW wrapping tokens with zh lyric', () => {
      const notes = [{ pitch: 60, start: 0, duration: 1, lyric: 'zh_a1' }];
      const result = pipeline.notesToSequences(notes, bpm, null);

      expect(result.tokenCount).to.equal(4);
    });

    it('should set noteType to 2 for normal notes', () => {
      const notes = [{ pitch: 60, start: 0, duration: 1, lyric: 'zh_a1' }];
      const result = pipeline.notesToSequences(notes, bpm, null);

      expect(result.noteTypeSeq[2]).to.equal(2);
    });

    it('should set noteType to 1 for empty lyrics (rest)', () => {
      const notes = [{ pitch: 60, start: 0, duration: 1, lyric: '' }];
      const result = pipeline.notesToSequences(notes, bpm, null);

      expect(result.noteTypeSeq[2]).to.equal(1);
    });

    it('should set noteType to 3 for slur/continuation notes', () => {
      const notes = [{ pitch: 60, start: 0, duration: 1, lyric: 'zh_a1', isSlur: true }];
      const result = pipeline.notesToSequences(notes, bpm, null);

      expect(result.noteTypeSeq[2]).to.equal(3);
    });

    it('should produce mel2token mapping with correct frame count', () => {
      const notes = [
        { pitch: 60, start: 0, duration: 0.5, lyric: 'zh_a1' },
      ];
      const result = pipeline.notesToSequences(notes, bpm, null);

      expect(result.mel2token.length).to.equal(result.f0Ids.length);
    });

    it('should handle multiple notes with BOW/EOW wrapping', () => {
      const notes = [
        { pitch: 60, start: 0, duration: 1, lyric: 'zh_a1' },
        { pitch: 64, start: 1, duration: 1, lyric: 'zh_a4' },
      ];
      const result = pipeline.notesToSequences(notes, bpm, null);

      expect(result.tokenCount).to.equal(7);
      expect(result.noteTextSeq.length).to.equal(7);
      expect(result.notePitchSeq.length).to.equal(7);
      expect(result.noteTypeSeq.length).to.equal(7);
    });
  });

  describe('_buildMel2token', () => {
    const bpm = 120;

    it('should map frames to token indices based on note timing', () => {
      const notes = [
        { pitch: 60, start: 0, duration: 1, lyric: 'zh_a1' },
      ];
      const result = pipeline.notesToSequences(notes, bpm, null);

      expect(result.mel2token).to.be.an.instanceOf(Int32Array);
      expect(result.mel2token.length).to.be.greaterThan(0);

      for (let f = 0; f < result.mel2token.length; f++) {
        expect(result.mel2token[f]).to.be.at.least(0);
        expect(result.mel2token[f]).to.be.lessThan(result.tokenCount);
      }
    });

    it('should map all frames within note duration to non-PAD tokens', () => {
      const notes = [
        { pitch: 60, start: 0, duration: 1, lyric: 'zh_a1' },
      ];
      const result = pipeline.notesToSequences(notes, bpm, null);

      const midFrame = Math.floor(0.5 * 60 / bpm * 24000 / 480);
      if (midFrame < result.mel2token.length) {
        expect(result.mel2token[midFrame]).to.be.at.least(1);
        expect(result.mel2token[midFrame]).to.be.lessThan(result.tokenCount);
      }
    });

    it('should return all-zero mapping for empty phLocations', () => {
      const mel2token = pipeline._buildMel2token([], 1, 10);
      for (let f = 0; f < 10; f++) {
        expect(mel2token[f]).to.equal(0);
      }
    });

    it('should handle multiple notes with distinct token ranges', () => {
      const notes = [
        { pitch: 60, start: 0, duration: 1, lyric: 'zh_a1' },
        { pitch: 64, start: 1, duration: 1, lyric: 'zh_a4' },
      ];
      const result = pipeline.notesToSequences(notes, bpm, null);

      const note1Frame = Math.floor(0.5 * 60 / bpm * 24000 / 480);
      const note2Frame = Math.floor(1.5 * 60 / bpm * 24000 / 480);

      if (note1Frame < result.mel2token.length && note2Frame < result.mel2token.length) {
        expect(result.mel2token[note1Frame]).to.be.at.least(1);
        expect(result.mel2token[note1Frame]).to.be.lessThan(4);
        expect(result.mel2token[note2Frame]).to.be.at.least(4);
        expect(result.mel2token[note2Frame]).to.be.lessThan(result.tokenCount);
      }
    });
  });

  describe('randomNoise', () => {
    it('should generate noise tensor with correct shape', () => {
      const noise = pipeline.randomNoise(10, 128);

      expect(noise.dims).to.deep.equal([1, 10, 128]);
      expect(noise.data.length).to.equal(10 * 128);
    });

    it('should generate values in reasonable range', () => {
      const noise = pipeline.randomNoise(100, 10);

      for (let i = 0; i < noise.data.length; i++) {
        expect(noise.data[i]).to.be.within(-5, 5);
      }
      const mean = noise.data.reduce((s, v) => s + v, 0) / noise.data.length;
      expect(Math.abs(mean)).to.be.lessThan(1);
    });
  });

  describe('constants', () => {
    it('should have correct SAMPLE_RATE', () => {
      expect(SAMPLE_RATE).to.equal(24000);
    });
  });

  describe('mel2token construction', () => {
    const bpm = 120;

    it('should have first token as PAD (index 0)', () => {
      const notes = [
        { pitch: 60, start: 0, duration: 1, lyric: 'zh_a1' },
      ];
      const result = pipeline.notesToSequences(notes, bpm, null);
      expect(result.noteTextSeq[0]).to.equal(pipeline.phone2idx['<PAD>'] || 0);
    });

    it('should map each note with BOW, phoneme, EOW tokens to frames', () => {
      const notes = [
        { pitch: 60, start: 0, duration: 1, lyric: 'zh_a1' },
      ];
      const result = pipeline.notesToSequences(notes, bpm, null);
      const bowId = pipeline.phone2idx['<BOW>'] || 4;
      const eowId = pipeline.phone2idx['<EOW>'] || 5;
      expect(result.noteTextSeq[1]).to.equal(bowId);
      expect(result.noteTextSeq[result.tokenCount - 1]).to.equal(eowId);
    });

    it('should place EOW at nextPhonemeStart - 1', () => {
      const notes = [
        { pitch: 60, start: 0, duration: 1, lyric: 'zh_a1' },
        { pitch: 64, start: 1, duration: 1, lyric: 'zh_a4' },
      ];
      const result = pipeline.notesToSequences(notes, bpm, null);
      const note1Frames = Math.round((1 / bpm) * 60 * 24000 / 480);
      expect(result.mel2token[note1Frames - 1]).to.be.greaterThan(0);
    });

    it('should repeat phoneme tokens to fill available frames', () => {
      const notes = [
        { pitch: 60, start: 0, duration: 2, lyric: 'zh_a1' },
      ];
      const result = pipeline.notesToSequences(notes, bpm, null);
      let nonZeroCount = 0;
      for (let f = 0; f < result.mel2token.length; f++) {
        if (result.mel2token[f] > 0) nonZeroCount++;
      }
      expect(nonZeroCount).to.be.greaterThan(0);
    });

    it('should have no frame with token index >= tokenCount', () => {
      const notes = [
        { pitch: 60, start: 0, duration: 1, lyric: 'zh_a1' },
        { pitch: 64, start: 1, duration: 1, lyric: 'zh_a4' },
      ];
      const result = pipeline.notesToSequences(notes, bpm, null);
      for (let f = 0; f < result.mel2token.length; f++) {
        expect(result.mel2token[f]).to.be.at.least(0);
        expect(result.mel2token[f]).to.be.lessThan(result.tokenCount);
      }
    });
  });

  describe('English phoneme SEP position', () => {
    const bpm = 120;

    it('should place SEP after all sub-phonemes for en_HH-AH1-D', () => {
      const notes = [
        { pitch: 60, start: 0, duration: 1, lyric: 'en_HH-AH1-D' },
      ];
      const result = pipeline.notesToSequences(notes, bpm, null);
      const sepId = pipeline.phone2idx['<SEP>'] || 9;
      const enHhId = pipeline.phone2idx['en_HH'];
      const enAh1Id = pipeline.phone2idx['en_AH1'];
      const enDId = pipeline.phone2idx['en_D'];
      expect(enHhId).to.not.be.undefined;
      expect(enAh1Id).to.not.be.undefined;
      expect(enDId).to.not.be.undefined;
      const bowIdx = 1;
      expect(result.noteTextSeq[bowIdx]).to.equal(pipeline.phone2idx['<BOW>'] || 4);
      expect(result.noteTextSeq[bowIdx + 1]).to.equal(enHhId);
      expect(result.noteTextSeq[bowIdx + 2]).to.equal(enAh1Id);
      expect(result.noteTextSeq[bowIdx + 3]).to.equal(enDId);
      expect(result.noteTextSeq[bowIdx + 4]).to.equal(sepId);
      expect(result.noteTextSeq[bowIdx + 5]).to.equal(pipeline.phone2idx['<EOW>'] || 5);
    });

    it('should not place SEP between sub-phonemes', () => {
      const notes = [
        { pitch: 60, start: 0, duration: 1, lyric: 'en_HH-AH1-D' },
      ];
      const result = pipeline.notesToSequences(notes, bpm, null);
      const sepId = pipeline.phone2idx['<SEP>'] || 9;
      const enHhId = pipeline.phone2idx['en_HH'];
      const enAh1Id = pipeline.phone2idx['en_AH1'];
      const bowIdx = 1;
      expect(result.noteTextSeq[bowIdx + 1]).to.equal(enHhId);
      expect(result.noteTextSeq[bowIdx + 1]).to.not.equal(sepId);
      expect(result.noteTextSeq[bowIdx + 2]).to.equal(enAh1Id);
      expect(result.noteTextSeq[bowIdx + 2]).to.not.equal(sepId);
    });
  });

  describe('English multi-phoneme mel2token distribution', () => {
    const bpm = 120;

    it('should distribute frames evenly among English phonemes (not cycle)', () => {
      const notes = [
        { pitch: 60, start: 0, duration: 2, lyric: 'en_HH-AH1-L-OW1' },
      ];
      const result = pipeline.notesToSequences(notes, bpm, null);

      // 每个音素应该占据一段连续的帧，不应出现循环
      // token序列: PAD, BOW, en_HH, en_AH1, en_L, en_OW1, SEP, EOW
      // phIdx=1(BOW), 2(en_HH), 3(en_AH1), 4(en_L), 5(en_OW1), 6(SEP), 7(EOW)
      const bowToken = 1;
      const eowToken = 7;

      // 检查BOW在第一帧
      expect(result.mel2token[0]).to.equal(bowToken);

      // 检查EOW在最后一帧
      expect(result.mel2token[result.mel2token.length - 1]).to.equal(eowToken);

      // 检查音素token是连续分配的，不会循环
      // 收集每个token出现的帧范围
      const tokenRanges = {};
      for (let f = 0; f < result.mel2token.length; f++) {
        const t = result.mel2token[f];
        if (t > 0 && t < eowToken) {
          if (!tokenRanges[t]) {
            tokenRanges[t] = { first: f, last: f };
          } else {
            tokenRanges[t].last = f;
          }
        }
      }

      // 每个音素token应该只出现在一段连续帧中（不循环）
      for (const t of Object.keys(tokenRanges)) {
        const range = tokenRanges[t];
        // 连续性检查：token t占据的帧应该是连续的
        // 允许BOW和EOW各占1帧，音素之间可能有1帧的边界
        const span = range.last - range.first + 1;
        // token不应该出现间隔（即不应该循环出现）
        let count = 0;
        for (let f = range.first; f <= range.last; f++) {
          if (result.mel2token[f] === parseInt(t)) count++;
        }
        // 如果token是连续的，count应该等于span
        expect(count).to.equal(span);
      }
    });

    it('should not cycle phonemes for English word input', () => {
      const notes = [
        { pitch: 60, start: 0, duration: 2, lyric: 'hello' },
      ];
      const result = pipeline.notesToSequences(notes, bpm, null);

      // hello -> HH AH0 L OW1 -> en_HH, en_AH0, en_L, en_OW1, SEP
      // token序列: PAD, BOW, en_HH, en_AH0, en_L, en_OW1, SEP, EOW

      // 检查mel2token中不会出现音素循环
      // 即token 2(en_HH)不应该在token 3(en_AH0)之后再次出现
      const phonemeTokens = [];
      for (let f = 0; f < result.mel2token.length; f++) {
        const t = result.mel2token[f];
        if (t >= 2 && t <= 6) { // 音素token范围
          phonemeTokens.push(t);
        }
      }

      // 音素token应该是单调非递减的（每个音素占据连续帧后切换到下一个）
      for (let i = 1; i < phonemeTokens.length; i++) {
        expect(phonemeTokens[i]).to.be.at.least(phonemeTokens[i - 1]);
      }
    });

    it('should handle single Chinese phoneme correctly (unchanged behavior)', () => {
      const notes = [
        { pitch: 60, start: 0, duration: 1, lyric: 'zh_a1' },
      ];
      const result = pipeline.notesToSequences(notes, bpm, null);

      // 单音素：所有中间帧应该映射到同一个音素token
      const bowToken = 1;
      const phonemeToken = 2;
      const eowToken = 3;

      expect(result.mel2token[0]).to.equal(bowToken);
      expect(result.mel2token[result.mel2token.length - 1]).to.equal(eowToken);

      for (let f = 1; f < result.mel2token.length - 1; f++) {
        expect(result.mel2token[f]).to.equal(phonemeToken);
      }
    });

    it('should not starve first phoneme of short English multi-phoneme note (apples bug)', () => {
      // "apples" -> AE1 P AH0 L Z + SEP = 6 tokens (j=6)
      // bpm=120, duration=0.25 beats = 0.125s ≈ 6 frames; innerFrames = 6-2 = 4 < 6
      const notes = [
        { pitch: 60, start: 0, duration: 0.25, lyric: 'apples' },
      ];
      const result = pipeline.notesToSequences(notes, 120, null);

      // token sequence: PAD(0), BOW(1), en_AE1(2), en_P(3), en_AH0(4), en_L(5), en_Z(6), SEP(7), EOW(8)
      // Before fix: AE1 (token 2) got 0 frames due to floor interpolation when innerFrames < j
      // After fix: AE1 gets at least 1 frame (first extraFrame recipient)
      const ae1Token = 2;
      let ae1FrameCount = 0;
      for (let f = 0; f < result.mel2token.length; f++) {
        if (result.mel2token[f] === ae1Token) ae1FrameCount++;
      }
      expect(ae1FrameCount).to.be.at.least(1, 'AE1 (first phoneme of "apples") must get at least 1 frame');

      // Verify BOW still anchors first frame, EOW anchors last frame
      expect(result.mel2token[0]).to.equal(1);
      expect(result.mel2token[result.mel2token.length - 1]).to.equal(8);
    });

    it('should prioritize vowel over consonant in short Japanese syllable note', () => {
      // "か" -> k a = 2 tokens (j=2, no SEP for Japanese)
      // bpm=120, duration=0.125 beats = 0.0625s ≈ 3 frames; innerFrames = 3-2 = 1 < 2
      // 元音优先策略：帧数不足时，元音 a 优先于辅音 k 获得帧
      const notes = [
        { pitch: 60, start: 0, duration: 0.125, lyric: 'か' },
      ];
      const result = pipeline.notesToSequences(notes, 120, null);

      // token sequence: PAD(0), BOW(1), jp_k(2), jp_a(3), EOW(4)
      // 元音 a (token 3) 应获得至少 1 帧（优先于辅音 k）
      const aToken = 3;
      let aFrameCount = 0;
      for (let f = 0; f < result.mel2token.length; f++) {
        if (result.mel2token[f] === aToken) aFrameCount++;
      }
      expect(aFrameCount).to.be.at.least(1, 'jp_a (vowel of か) must get at least 1 frame');
    });

    it('should give vowel 2 frames in 8th-note Japanese syllable', () => {
      // "か" -> k a = 2 tokens (j=2)
      // bpm=120, duration=0.25 beats = 0.125s ≈ 6 frames; innerFrames = 6-2 = 4 >= 2
      // 帧数充足时走基数+余数，但元音应获得合理帧数
      const notes = [
        { pitch: 60, start: 0, duration: 0.25, lyric: 'か' },
      ];
      const result = pipeline.notesToSequences(notes, 120, null);

      // 元音 a (token 3) 应获得至少 2 帧
      const aToken = 3;
      let aFrameCount = 0;
      for (let f = 0; f < result.mel2token.length; f++) {
        if (result.mel2token[f] === aToken) aFrameCount++;
      }
      expect(aFrameCount).to.be.at.least(2, 'jp_a (vowel of か) should get at least 2 frames in 8th note');
    });

    it('should give vowels more frames than consonants in long English note (data-driven stats)', async () => {
      // "apples" -> AE1 P AH0 L Z + SEP = 6 phonemes
      // bpm=120, duration=8 beats = 4s ≈ 200 frames; innerFrames >> 6
      // 数据驱动统计表查表：元音 AE1/AH0 应比辅音 P/L/Z 获得更多帧
      const pipeline2 = new NativeSVSPipeline('/fake/model/dir/');
      // 等待统计表异步加载完成
      await new Promise(r => setTimeout(r, 200));
      const notes = [
        { pitch: 60, start: 0, duration: 8, lyric: 'apples' },
      ];
      const result = pipeline2.notesToSequences(notes, 120, null);

      // token sequence: PAD(0), BOW(1), en_AE1(2), en_P(3), en_AH0(4), en_L(5), en_Z(6), SEP(7), EOW(8)
      const tokenFrames = {};
      for (let f = 0; f < result.mel2token.length; f++) {
        const t = result.mel2token[f];
        if (t >= 2 && t <= 7) {
          tokenFrames[t] = (tokenFrames[t] || 0) + 1;
        }
      }
      // AE1(token 2) 和 AH0(token 4) 是元音；P(3), L(5), Z(6) 是辅音；SEP(7) 是特殊 token
      const ae1Frames = tokenFrames[2] || 0;
      const pFrames = tokenFrames[3] || 0;
      const ah0Frames = tokenFrames[4] || 0;

      // 元音应比相邻辅音获得更多帧（统计规律：元音 100ms+ > 辅音 ~70-90ms）
      expect(ae1Frames).to.be.greaterThan(pFrames, 'AE1 (vowel) should get more frames than P (consonant)');
      expect(ah0Frames).to.be.greaterThan(0, 'AH0 (second vowel) must get some frames');
    });

    it('should fall back to linear allocation when stats table not loaded', () => {
      // 构造一个无统计表的 pipeline，验证回退到线性插值
      const pipeline2 = new NativeSVSPipeline('/fake/model/dir/');
      pipeline2._preprocessing._durationStats = null; // 强制未加载
      const notes = [
        { pitch: 60, start: 0, duration: 4, lyric: 'apples' },
      ];
      const result = pipeline2.notesToSequences(notes, 120, null);

      // 线性插值下所有音素帧数应相近（差异 <= 1）
      const tokenFrames = {};
      for (let f = 0; f < result.mel2token.length; f++) {
        const t = result.mel2token[f];
        if (t >= 2 && t <= 6) { // en_AE1..en_Z (排除 SEP)
          tokenFrames[t] = (tokenFrames[t] || 0) + 1;
        }
      }
      const frames = Object.values(tokenFrames);
      if (frames.length > 1) {
        const maxF = Math.max(...frames);
        const minF = Math.min(...frames);
        expect(maxF - minF).to.be.at.most(1, 'linear allocation should produce near-equal frames');
      }
    });
  });

  describe('CFG global std rescale', () => {
    it('should compute global std across all frames and dimensions', () => {
      const totalFrames = 10;
      const melDim = 4;
      const predData = new Float32Array(totalFrames * melDim);
      const uncondPred = new Float32Array(totalFrames * melDim);
      for (let i = 0; i < totalFrames * melDim; i++) {
        predData[i] = 1.0;
        uncondPred[i] = 0.5;
      }
      let posSum = 0;
      const targetLen = totalFrames * melDim;
      for (let i = 0; i < targetLen; i++) {
        posSum += predData[i];
      }
      const posMean = posSum / targetLen;
      expect(posMean).to.equal(1.0);
      let posVarSum = 0;
      for (let i = 0; i < targetLen; i++) {
        posVarSum += (predData[i] - posMean) * (predData[i] - posMean);
      }
      const posStd = Math.sqrt(posVarSum / targetLen + 1e-8);
      expect(posStd).to.be.closeTo(0, 0.001);

      const CFG_STRENGTH = 3.0;
      const cfgPred = new Float32Array(targetLen);
      let cfgAdjSum = 0;
      for (let i = 0; i < targetLen; i++) {
        const cfgVal = predData[i] + CFG_STRENGTH * (predData[i] - uncondPred[i]);
        cfgPred[i] = cfgVal;
        cfgAdjSum += cfgVal;
      }
      const cfgAdjMean = cfgAdjSum / targetLen;
      let cfgAdjVarSum = 0;
      for (let i = 0; i < targetLen; i++) {
        cfgAdjVarSum += (cfgPred[i] - cfgAdjMean) * (cfgPred[i] - cfgAdjMean);
      }
      const cfgAdjStd = Math.sqrt(cfgAdjVarSum / targetLen + 1e-8);
      expect(cfgAdjStd).to.be.closeTo(0, 0.001);
    });

    it('should apply rescale formula correctly using CFG-adjusted std', () => {
      const CFG_RESCALE = 0.75;
      const CFG_STRENGTH = 3.0;
      const condVal = 2.0;
      const uncondVal = 0.5;
      const posStd = 1.5;
      const cfgAdjStd = 3.0;
      const rescale = posStd / (cfgAdjStd + 1e-8);
      const cfgVal = condVal + CFG_STRENGTH * (condVal - uncondVal);
      const rescaledVal = CFG_RESCALE * (cfgVal * rescale) + (1 - CFG_RESCALE) * cfgVal;
      expect(rescale).to.be.closeTo(0.5, 0.001);
      expect(cfgVal).to.equal(2.0 + 3.0 * (2.0 - 0.5));
      const expectedCfgVal = 6.5;
      expect(cfgVal).to.equal(expectedCfgVal);
      const expectedRescaled = CFG_RESCALE * (expectedCfgVal * 0.5) + (1 - CFG_RESCALE) * expectedCfgVal;
      expect(rescaledVal).to.be.closeTo(expectedRescaled, 0.001);
    });

    it('should produce different results with non-zero std', () => {
      const CFG_RESCALE = 0.75;
      const CFG_STRENGTH = 3.0;
      const predData = new Float32Array([2.0, 4.0, 1.0, 3.0]);
      const uncondPred = new Float32Array([0.5, 1.0, 0.5, 1.0]);
      const targetLen = predData.length;
      let posSum = 0;
      for (let i = 0; i < targetLen; i++) {
        posSum += predData[i];
      }
      const posMean = posSum / targetLen;
      let posVarSum = 0;
      for (let i = 0; i < targetLen; i++) {
        posVarSum += (predData[i] - posMean) * (predData[i] - posMean);
      }
      const posStd = Math.sqrt(posVarSum / targetLen + 1e-8);
      expect(posStd).to.be.greaterThan(0);

      const cfgPred = new Float32Array(targetLen);
      let cfgAdjSum = 0;
      for (let i = 0; i < targetLen; i++) {
        const cfgVal = predData[i] + CFG_STRENGTH * (predData[i] - uncondPred[i]);
        cfgPred[i] = cfgVal;
        cfgAdjSum += cfgVal;
      }
      const cfgAdjMean = cfgAdjSum / targetLen;
      let cfgAdjVarSum = 0;
      for (let i = 0; i < targetLen; i++) {
        cfgAdjVarSum += (cfgPred[i] - cfgAdjMean) * (cfgPred[i] - cfgAdjMean);
      }
      const cfgAdjStd = Math.sqrt(cfgAdjVarSum / targetLen + 1e-8);
      expect(cfgAdjStd).to.be.greaterThan(0);
      const rescale = posStd / (cfgAdjStd + 1e-8);
      const condVal = predData[0];
      const uncondVal = uncondPred[0];
      const cfgVal = condVal + CFG_STRENGTH * (condVal - uncondVal);
      const rescaledVal = CFG_RESCALE * (cfgVal * rescale) + (1 - CFG_RESCALE) * cfgVal;
      expect(rescaledVal).to.not.equal(cfgVal);
    });
  });

  describe('auto_shift', () => {
    it('should compute median correctly for odd-length array', () => {
      expect(pipeline._median([1, 3, 5])).to.equal(3);
    });

    it('should compute median correctly for even-length array', () => {
      expect(pipeline._median([1, 2, 3, 4])).to.equal(2.5);
    });

    it('should return 0 for empty array', () => {
      expect(pipeline._median([])).to.equal(0);
    });

    it('should compute F0 shift from ref and target medians', () => {
      const refMedian = 400;
      const targetMedian = 300;
      const f0Shift = Math.round(Math.log2(refMedian / targetMedian) * 1200 / 100);
      expect(f0Shift).to.equal(Math.round(Math.log2(400 / 300) * 12));
    });

    it('should apply f0Shift to quantizeF0 bins', () => {
      const f0 = new Float32Array([440]);
      const resultNoShift = pipeline.quantizeF0(f0, 0);
      const resultShift2 = pipeline.quantizeF0(f0, 2);
      if (resultNoShift[0] > 0) {
        expect(resultShift2[0]).to.equal(Math.min(360, resultNoShift[0] + 2 * 5));
      }
    });

    it('should apply f0Shift to notePitchSeq', () => {
      const bpm = 120;
      const notes = [
        { pitch: 60, start: 0, duration: 1, lyric: 'zh_a1' },
      ];
      const resultNoShift = pipeline.notesToSequences(notes, bpm, null, null, 0);
      const resultShift2 = pipeline.notesToSequences(notes, bpm, null, null, 2);
      let foundDiff = false;
      for (let t = 0; t < resultShift2.tokenCount; t++) {
        if (resultNoShift.notePitchSeq[t] > 0 && resultShift2.notePitchSeq[t] > 0) {
          expect(resultShift2.notePitchSeq[t]).to.equal(
            Math.max(0, Math.min(255, resultNoShift.notePitchSeq[t] + 2))
          );
          foundDiff = true;
        }
      }
      expect(foundDiff).to.be.true;
    });

    it('should apply f0Shift to f0Hz for vocoder f0 consistency', () => {
      // f0Hz 是 SiFiGAN vocoder 的 f0 输入，必须与 diffusion mel（基于偏移后音高）匹配。
      // 之前 f0Hz 未偏移导致 autoShift 较大时口齿不清。
      const bpm = 120;
      const notes = [
        { pitch: 60, start: 0, duration: 1, lyric: 'zh_a1' },
      ];
      const resultNoShift = pipeline.notesToSequences(notes, bpm, null, null, 0);
      const resultShift2 = pipeline.notesToSequences(notes, bpm, null, null, 2);
      let foundShifted = false;
      const expectedFactor = Math.pow(2, 2 / 12); // +2 semitones
      for (let i = 0; i < resultNoShift.f0Hz.length; i++) {
        const base = resultNoShift.f0Hz[i];
        const shifted = resultShift2.f0Hz[i];
        if (base > 0 && shifted > 0) {
          // 允许浮点误差
          expect(shifted).to.be.closeTo(base * expectedFactor, 0.01);
          foundShifted = true;
        }
      }
      expect(foundShifted).to.be.true;
    });
  });

  describe('_clampAutoShift', () => {
    it('should return 0 unchanged', () => {
      expect(pipeline._clampAutoShift(0, [60])).to.equal(0);
    });

    it('should return unchanged when within effective range', () => {
      // pitch 60 (C4) + shift 5 → 65, within [28, 88]
      expect(pipeline._clampAutoShift(5, [60])).to.equal(5);
      expect(pipeline._clampAutoShift(-5, [60])).to.equal(-5);
    });

    it('should clamp positive shift when max pitch would exceed upper bound', () => {
      // pitch 80 + shift 12 → 92 > 88, max allowed up = 88 - 80 = 8
      expect(pipeline._clampAutoShift(12, [80])).to.equal(8);
    });

    it('should clamp negative shift when min pitch would fall below lower bound', () => {
      // pitch 30 + shift -5 → 25 < 28, max allowed down = 28 - 30 = -2
      expect(pipeline._clampAutoShift(-5, [30])).to.equal(-2);
    });

    it('should cap absolute shift to 12 semitones even when range allows more', () => {
      // pitch 50, range allows ±38, but abs cap is 12
      expect(pipeline._clampAutoShift(20, [50])).to.equal(12);
      expect(pipeline._clampAutoShift(-20, [50])).to.equal(-12);
    });

    it('should handle wide pitch range within a fragment (root cause of garbled pronunciation)', () => {
      // 分片内音高相差大：C3(48) 到 C6(84)
      // max pitch 84, max allowed up = 88 - 84 = 4
      // 即使 autoShift 想偏移 +12，也只能 +4
      expect(pipeline._clampAutoShift(12, [48, 60, 72, 84])).to.equal(4);
      // min pitch 48, max allowed down = 28 - 48 = -20, but abs cap is -12
      expect(pipeline._clampAutoShift(-20, [48, 60, 72, 84])).to.equal(-12);
    });

    it('should return unchanged for empty or null pitch array', () => {
      expect(pipeline._clampAutoShift(5, [])).to.equal(5);
      expect(pipeline._clampAutoShift(5, null)).to.equal(5);
    });

    it('should use tighter upper bound (84) when vocoderType is sifigan', () => {
      // B1: SiFiGAN 对 f0 敏感，上限收紧到 84（~C6）防止激励畸变
      pipeline.vocoderType = 'sifigan';
      // pitch 80 + shift 12 → 92 > 84, max allowed up = 84 - 80 = 4
      expect(pipeline._clampAutoShift(12, [80])).to.equal(4);
      // pitch 84 + shift 1 → 85 > 84, max allowed up = 0
      expect(pipeline._clampAutoShift(1, [84])).to.equal(0);
      // 恢复 default 后上限回到 88
      pipeline.vocoderType = 'default';
      expect(pipeline._clampAutoShift(12, [80])).to.equal(8);
    });
  });

  describe('_computeSegF0Shift (B2 per-segment f0Shift)', () => {
    it('should return global f0Shift when globalTargetMedian is null (autoShift off)', () => {
      expect(pipeline._computeSegF0Shift(7, null, [{ pitch: 60, start: 0, duration: 1 }])).to.equal(7);
    });

    it('should return global f0Shift when segment has no pitched notes', () => {
      expect(pipeline._computeSegF0Shift(5, 60, [{ pitch: 0, start: 0, duration: 1 }])).to.equal(5);
    });

    it('should return global f0Shift when segment median equals global median', () => {
      // seg median 60 == global median 60, adjustment = 0
      expect(pipeline._computeSegF0Shift(5, 60, [{ pitch: 60, start: 0, duration: 1 }])).to.equal(5);
    });

    it('should shift up for low segment (segment median below global)', () => {
      // global median 60 (C4), seg median 48 (C3), adj = 60-48 = 12, capped to +5
      // global f0Shift 3 + 5 = 8, clamped by _clampAutoShift (pitch 48 → 53, within range)
      const segNotes = [{ pitch: 48, start: 0, duration: 1 }];
      expect(pipeline._computeSegF0Shift(3, 60, segNotes)).to.equal(8);
    });

    it('should shift down for high segment (segment median above global)', () => {
      // global median 60, seg median 72 (C5), adj = 60-72 = -12, capped to -5
      // global f0Shift -2 + (-5) = -7, clamped by _clampAutoShift (pitch 72 → 65, within range)
      const segNotes = [{ pitch: 72, start: 0, duration: 1 }];
      expect(pipeline._computeSegF0Shift(-2, 60, segNotes)).to.equal(-7);
    });

    it('should cap adjustment to ±5 semitones', () => {
      // global median 60, seg median 24 (very low), adj = 36, capped to +5
      const segNotes = [{ pitch: 24, start: 0, duration: 1 }];
      expect(pipeline._computeSegF0Shift(0, 60, segNotes)).to.equal(5);
      // global median 60, seg median 84 (high but in range), adj = -24, capped to -5
      // _clampAutoShift(-5, [84]): maxAllowedUp=4, maxAllowedDown=-56 → -5 (within range)
      const highNotes = [{ pitch: 84, start: 0, duration: 1 }];
      expect(pipeline._computeSegF0Shift(0, 60, highNotes)).to.equal(-5);
    });

    it('should respect _clampAutoShift bounds after per-segment adjustment', () => {
      // SiFiGAN: upper bound 84. seg pitch 80, global f0Shift 0, global median 88
      // seg median 80, adj = 88-80 = 8, capped to +5 → raw shift 5
      // _clampAutoShift: pitch 80 + 5 = 85 > 84, max allowed up = 84-80 = 4 → clamped to 4
      pipeline.vocoderType = 'sifigan';
      const segNotes = [{ pitch: 80, start: 0, duration: 1 }];
      expect(pipeline._computeSegF0Shift(0, 88, segNotes)).to.equal(4);
      pipeline.vocoderType = 'default';
    });
  });

  describe('quantizeF0 with f0Shift', () => {
    it('should produce same results with f0Shift=0 as default', () => {
      const f0 = new Float32Array([0, 100, 440, 1000]);
      const resultDefault = pipeline.quantizeF0(f0);
      const resultZero = pipeline.quantizeF0(f0, 0);
      for (let i = 0; i < f0.length; i++) {
        expect(resultZero[i]).to.equal(resultDefault[i]);
      }
    });

    it('should shift voiced bins by f0Shift*5', () => {
      const f0 = new Float32Array([440]);
      const resultNoShift = pipeline.quantizeF0(f0, 0);
      const resultShift2 = pipeline.quantizeF0(f0, 2);
      if (resultNoShift[0] > 0) {
        expect(resultShift2[0]).to.equal(Math.max(1, Math.min(360, resultNoShift[0] + 10)));
      }
    });

    it('should not shift unvoiced (zero) bins', () => {
      const f0 = new Float32Array([0]);
      const resultNoShift = pipeline.quantizeF0(f0, 0);
      const resultShift2 = pipeline.quantizeF0(f0, 2);
      expect(resultShift2[0]).to.equal(0);
      expect(resultNoShift[0]).to.equal(0);
    });

    it('should clamp shifted bins to valid range', () => {
      const f0High = new Float32Array([5000]);
      const resultHighShift = pipeline.quantizeF0(f0High, 100);
      expect(resultHighShift[0]).to.be.at.most(360);
      expect(resultHighShift[0]).to.be.at.least(1);
    });
  });

  describe('dispose', () => {
    it('should clear sessions and reset initialized flag', () => {
      pipeline.sessions = { fake: { release: () => {} } };
      pipeline.initialized = true;

      pipeline.dispose();

      expect(pipeline.sessions).to.deep.equal({});
      expect(pipeline.initialized).to.be.false;
    });
  });

  describe('synthesis cache', () => {
    it('should compute consistent cache key for same inputs', () => {
      const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      const options = { pitchCurveF0: [440, 440, 440], nSteps: 32, cfg: 3.0 };

      const key1 = pipeline._computeSynthCacheKey(notes, 120, options);
      const key2 = pipeline._computeSynthCacheKey(notes, 120, options);
      expect(key1).to.equal(key2);
    });

    it('should compute different cache key for different notes', () => {
      const notes1 = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      const notes2 = [{ lyric: 'a', pitch: 64, start: 0, duration: 1 }];
      const options = { pitchCurveF0: null, nSteps: 32, cfg: 3.0 };

      const key1 = pipeline._computeSynthCacheKey(notes1, 120, options);
      const key2 = pipeline._computeSynthCacheKey(notes2, 120, options);
      expect(key1).to.not.equal(key2);
    });

    it('should compute different cache key for different F0', () => {
      const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      const options1 = { pitchCurveF0: [440, 440], nSteps: 32, cfg: 3.0 };
      const options2 = { pitchCurveF0: [880, 880], nSteps: 32, cfg: 3.0 };

      const key1 = pipeline._computeSynthCacheKey(notes, 120, options1);
      const key2 = pipeline._computeSynthCacheKey(notes, 120, options2);
      expect(key1).to.not.equal(key2);
    });

    it('should compute different cache key for different bpm', () => {
      const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      const options = { pitchCurveF0: null, nSteps: 32, cfg: 3.0 };

      const key1 = pipeline._computeSynthCacheKey(notes, 120, options);
      const key2 = pipeline._computeSynthCacheKey(notes, 140, options);
      expect(key1).to.not.equal(key2);
    });

    it('should compute different cache key for different nSteps', () => {
      const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 1 }];
      const options1 = { pitchCurveF0: null, nSteps: 16, cfg: 3.0 };
      const options2 = { pitchCurveF0: null, nSteps: 32, cfg: 3.0 };

      const key1 = pipeline._computeSynthCacheKey(notes, 120, options1);
      const key2 = pipeline._computeSynthCacheKey(notes, 120, options2);
      expect(key1).to.not.equal(key2);
    });

    it('should initialize with null cache', () => {
      expect(pipeline._synthCache).to.be.null;
    });

    it('should clear cache with clearSynthCache', () => {
      pipeline._synthCache = { key: 'test', audio: new Float32Array(100) };
      pipeline.clearSynthCache();
      expect(pipeline._synthCache).to.be.null;
    });

    it('should hash arrays consistently', () => {
      const arr = new Float32Array([1, 2, 3, 4, 5]);
      const h1 = pipeline._hashArray(arr);
      const h2 = pipeline._hashArray(arr);
      expect(h1).to.equal(h2);
    });

    it('should return 0 for null array hash', () => {
      expect(pipeline._hashArray(null)).to.equal(0);
    });
  });

  describe('_buildVocalSegments', () => {
    it('should return single segment for short audio', () => {
      const notes = [
        { pitch: 60, start: 0, duration: 1, lyric: 'zh_a1' },
        { pitch: 64, start: 1, duration: 1, lyric: 'zh_a4' },
      ];
      const segments = pipeline._buildVocalSegments(notes, 120);
      expect(segments.length).to.equal(1);
      expect(segments[0].startBeat).to.equal(0);
    });

    it('should handle empty notes', () => {
      const segments = pipeline._buildVocalSegments([], 120);
      expect(segments.length).to.equal(1);
    });
  });

  describe('_runDiffusionLoop', () => {
    it('should exist as a method on the pipeline', () => {
      expect(pipeline._runDiffusionLoop).to.be.a('function');
    });
  });

  describe('_synthesizeSegment', () => {
    it('should exist as a method on the pipeline', () => {
      expect(pipeline._synthesizeSegment).to.be.a('function');
    });
  });
});
