const { expect } = require('chai');

describe('inference/shared/constants', () => {
  let constants;

  before(() => {
    constants = require('../src/inference/shared/constants.js');
  });

  it('should export SAMPLE_RATE = 24000', () => {
    expect(constants.SAMPLE_RATE).to.equal(24000);
  });

  it('should export HOP_SIZE = 480', () => {
    expect(constants.HOP_SIZE).to.equal(480);
  });

  it('should export SIFIGAN_HOP_SIZE = 120', () => {
    expect(constants.SIFIGAN_HOP_SIZE).to.equal(120);
  });

  it('should export MEL_DIM = 128', () => {
    expect(constants.MEL_DIM).to.equal(128);
  });

  it('should export EMBED_DIM = 512', () => {
    expect(constants.EMBED_DIM).to.equal(512);
  });

  it('should export COND_DIM = 1024', () => {
    expect(constants.COND_DIM).to.equal(1024);
  });

  it('should export VOCODER_CHUNK_FRAMES = 1024', () => {
    expect(constants.VOCODER_CHUNK_FRAMES).to.equal(1024);
  });

  it('should export VOCODER_OVERLAP_FRAMES = 32', () => {
    expect(constants.VOCODER_OVERLAP_FRAMES).to.equal(32);
  });

  it('should export NPU_STATIC_SEQ_LEN = 2048', () => {
    expect(constants.NPU_STATIC_SEQ_LEN).to.equal(2048);
  });

  it('should export NPU_VOCODER_SEQ_LEN = 500', () => {
    expect(constants.NPU_VOCODER_SEQ_LEN).to.equal(500);
  });

  it('should export all constants as numbers', () => {
    const keys = Object.keys(constants).filter(k => k !== '__esModule');
    keys.forEach(key => {
      expect(constants[key], `constant "${key}"`).to.be.a('number');
    });
  });

  it('should have valid hop size ratio (SAMPLE_RATE / HOP_SIZE = 50)', () => {
    expect(constants.SAMPLE_RATE / constants.HOP_SIZE).to.equal(50);
  });
});