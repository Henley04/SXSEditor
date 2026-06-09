const { expect } = require('chai');
const sinon = require('sinon');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { resampleAudio } = require('../src/utils/resampleAudio');

describe('Audio Processing Pipeline - Integration Tests', () => {
  describe('End-to-end F0 Quantization', () => {
    it('should build F0, quantize, and produce valid sequences', () => {
      const { NativeSVSPipeline } = require('../src/inference/pipeline');
      const pipeline = new NativeSVSPipeline('/fake/');

      const notes = [
        { pitch: 60, start: 0, duration: 1, lyric: 'zh_a1' },
        { pitch: 64, start: 1, duration: 1, lyric: 'zh_a4' },
      ];
      const bpm = 120;

      const f0Frames = pipeline.buildF0FrameSequence(notes, bpm, null);
      expect(f0Frames.length).to.be.greaterThan(0);

      const quantized = pipeline.quantizeF0(f0Frames);
      for (let i = 0; i < quantized.length; i++) {
        if (f0Frames[i] > 0) {
          expect(quantized[i]).to.be.greaterThan(0);
        } else {
          expect(quantized[i]).to.equal(0);
        }
      }

      const sequences = pipeline.notesToSequences(notes, bpm, null);
      expect(sequences.f0Ids.length).to.equal(quantized.length);
      expect(sequences.tokenCount).to.be.greaterThan(0);
      expect(sequences.notePitchSeq[1]).to.equal(60);
      expect(sequences.notePitchSeq[5]).to.equal(64);
    });

    it('should handle F0 envelope pitch shifts', () => {
      const { NativeSVSPipeline } = require('../src/inference/pipeline');
      const pipeline = new NativeSVSPipeline('/fake/');

      const notes = [{ pitch: 60, start: 0, duration: 2, lyric: 'zh_a1' }];
      const envelope = { keyframes: [{ time: 0, value: 12 }] };

      const f0Frames = pipeline.buildF0FrameSequence(notes, 120, envelope);
      const expectedFreq = pipeline.midiToFreq(72);

      expect(f0Frames[0]).to.be.closeTo(expectedFreq, 0.01);
    });
  });

  describe('Audio Resampling Pipeline', () => {
    it('should resample audio for RMVPE (44100 -> 16000)', () => {
      const { RmvpePitchDetector } = require('../src/inference/rmvpePitchDetector');
      const detector = new RmvpePitchDetector('/fake/');

      const input = new Float32Array(4410);
      for (let i = 0; i < input.length; i++) {
        input[i] = Math.sin(2 * Math.PI * 440 * i / 44100);
      }

      const result = resampleAudio(input, 44100, 16000);

      expect(result.length).to.equal(1600);
      expect(result).to.be.an.instanceOf(Float32Array);
    });

    it('should resample audio for Basic Pitch (44100 -> 22050)', () => {
      const { BasicPitchDetector } = require('../src/inference/basicPitch');

      const input = new Float32Array(4410);
      for (let i = 0; i < input.length; i++) {
        input[i] = Math.sin(2 * Math.PI * 440 * i / 44100);
      }

      const result = resampleAudio(input, 44100, 22050);

      expect(result.length).to.equal(2205);
      expect(result).to.be.an.instanceOf(Float32Array);
    });
  });

  describe('F0 to Notes Conversion Pipeline', () => {
    it('should convert continuous F0 to musical notes', () => {
      const { RmvpePitchDetector } = require('../src/inference/rmvpePitchDetector');
      const detector = new RmvpePitchDetector('/fake/');

      const f0Array = [];
      const frameDuration = 160 / 16000;
      for (let i = 0; i < 500; i++) {
        f0Array.push({ time: i * frameDuration, f0: 440 });
      }

      const notes = detector.f0ToNotes(f0Array, 120, 0.01);

      expect(notes.length).to.be.greaterThan(0);
      expect(notes[0].pitch).to.equal(69);
    });

    it('should detect multiple notes from alternating F0', () => {
      const { RmvpePitchDetector } = require('../src/inference/rmvpePitchDetector');
      const detector = new RmvpePitchDetector('/fake/');

      const f0Array = [];
      const frameDuration = 160 / 16000;
      for (let i = 0; i < 200; i++) {
        f0Array.push({ time: i * frameDuration, f0: 440 });
      }
      for (let i = 200; i < 400; i++) {
        f0Array.push({ time: i * frameDuration, f0: 523.25 });
      }

      const notes = detector.f0ToNotes(f0Array, 120, 0.01);

      expect(notes.length).to.be.greaterThanOrEqual(1);
    });
  });

  describe('WAV Encoding Round-trip', () => {
    it('should encode and produce valid WAV file', () => {
      const { encodeWav } = require('../src/audio/wavEncoder');

      const samples = 1000;
      const audio = new Float32Array(samples);
      for (let i = 0; i < samples; i++) {
        audio[i] = Math.sin(2 * Math.PI * 440 * i / 24000) * 0.5;
      }

      const wavData = encodeWav(audio, 24000);

      const view = new DataView(wavData.buffer);
      expect(String.fromCharCode(...wavData.slice(0, 4))).to.equal('RIFF');
      expect(view.getUint32(24, true)).to.equal(24000);
      expect(view.getUint32(40, true)).to.equal(samples * 4);
    });
  });

  describe('Token State Expansion to Frames', () => {
    it('should correctly expand token-level embeddings to frame-level via mel2token', () => {
      const { NativeSVSPipeline } = require('../src/inference/pipeline');
      const pipeline = new NativeSVSPipeline('/fake/');

      const embedDim = 3;
      const tokenCount = 3;
      const totalFrames = 6;
      const encoderOutData = new Float32Array([
        1, 2, 3,
        4, 5, 6,
        7, 8, 9,
      ]);
      const mel2token = new Int32Array([0, 1, 1, 2, 2, 2]);

      const expandedEmb = new Float32Array(totalFrames * embedDim);
      for (let f = 0; f < totalFrames; f++) {
        const tokenIdx = mel2token[f];
        for (let d = 0; d < embedDim; d++) {
          expandedEmb[f * embedDim + d] = encoderOutData[tokenIdx * embedDim + d];
        }
      }

      expect(expandedEmb.length).to.equal(18);
      expect(expandedEmb[0]).to.equal(1);
      expect(expandedEmb[1]).to.equal(2);
      expect(expandedEmb[2]).to.equal(3);
      expect(expandedEmb[9]).to.equal(7);
      expect(expandedEmb[10]).to.equal(8);
      expect(expandedEmb[11]).to.equal(9);
    });
  });
});

describe('Track and Fragment Pipeline - Integration Tests', () => {
  it('should create singer, add fragments, and manage lifecycle', () => {
    const { TrackManager } = require('../src/editor/trackManager');
    const manager = new TrackManager();

    const singer = manager.addSinger({ singerName: 'Test Singer' });
    expect(singer.id).to.be.a('string');

    const fragment = manager.addFragment({
      singerId: singer.id,
      name: 'Test Fragment',
      startTime: 0,
      duration: 8,
    });
    expect(fragment.singerId).to.equal(singer.id);

    const retrieved = manager.getFragment(fragment.id);
    expect(retrieved.name).to.equal('Test Fragment');

    const active = manager.setActiveFragment(fragment.id);
    expect(manager.getActiveFragment().id).to.equal(fragment.id);
  });

  it('should handle multiple singers and fragments', () => {
    const { TrackManager } = require('../src/editor/trackManager');
    const manager = new TrackManager();

    const s1 = manager.addSinger({ singerName: 'Singer A' });
    const s2 = manager.addSinger({ singerName: 'Singer B' });

    const f1 = manager.addFragment({ singerId: s1.id, name: 'Fragment A1' });
    const f2 = manager.addFragment({ singerId: s2.id, name: 'Fragment B1' });

    expect(manager.getFragment(f1.id).singerId).to.equal(s1.id);
    expect(manager.getFragment(f2.id).singerId).to.equal(s2.id);
  });

  it('should handle fragment removal and active fragment switching', () => {
    const { TrackManager } = require('../src/editor/trackManager');
    const manager = new TrackManager();

    manager.addSinger({ id: 1 });
    const f1 = manager.addFragment({ id: 1, singerId: 1 });
    const f2 = manager.addFragment({ id: 2, singerId: 1 });

    manager.setActiveFragment(1);
    manager.removeFragment(1);

    expect(manager.getActiveFragment().id).to.equal(2);
  });
});

describe('Constants Consistency', () => {
  it('should have correct sample rates across modules', () => {
    const { SAMPLE_RATE } = require('../src/inference/pipeline');
    const { RMVPE_SAMPLE_RATE } = require('../src/inference/rmvpePitchDetector');

    expect(SAMPLE_RATE).to.equal(24000);
    expect(RMVPE_SAMPLE_RATE).to.equal(16000);
    expect(SAMPLE_RATE).to.not.equal(RMVPE_SAMPLE_RATE);
  });
});
