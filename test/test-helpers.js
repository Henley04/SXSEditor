/**
 * Test helpers for mocking Electron environment
 */

function mockElectronAPI() {
  return {
    extractF0: sinon.stub().resolves({ success: true, f0Array: [], notes: [] }),
    extractF0BasicPitch: sinon.stub().resolves({ success: true, f0Array: [], notes: [] }),
    sendPreprocessData: sinon.stub().resolves({ success: true }),
    onLoadPreprocessData: sinon.stub(),
    dialog: {
      showSaveDialog: sinon.stub().resolves({ canceled: false, filePath: '/test/path.sxssinger' }),
      showOpenDialog: sinon.stub().resolves({ canceled: false, filePaths: ['/test/file.wav'] }),
    },
    file: {
      saveFile: sinon.stub().resolves({ success: true }),
      readFile: sinon.stub().resolves(Buffer.from('test')),
      readFileBuffer: sinon.stub().resolves(new ArrayBuffer(100)),
    },
  };
}

function mockAudioBuffer(duration = 1.0, sampleRate = 44100) {
  const numSamples = Math.floor(duration * sampleRate);
  const data = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) {
    data[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5;
  }
  return {
    getChannelData: () => data,
    sampleRate,
    duration,
    numberOfChannels: 1,
    length: numSamples,
  };
}

function createTestNote(overrides = {}) {
  return {
    id: overrides.id ?? Date.now() + Math.random(),
    pitch: overrides.pitch ?? 60,
    start: overrides.start ?? 0,
    duration: overrides.duration ?? 0.25,
    lyric: overrides.lyric ?? 'la',
    ...overrides,
  };
}

function createTestSinger(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    trackName: overrides.trackName ?? 'test track',
    singerName: overrides.singerName ?? 'test singer',
    avatarPath: overrides.avatarPath ?? null,
    wavPath: overrides.wavPath ?? './test.wav',
    midiPath: overrides.midiPath ?? null,
    color: overrides.color ?? '#3498db',
    ...overrides,
  };
}

function createTestFragment(overrides = {}) {
  return {
    id: overrides.id ?? 1,
    singerId: overrides.singerId ?? 1,
    startTime: overrides.startTime ?? 0,
    duration: overrides.duration ?? 4,
    name: overrides.name ?? 'test fragment',
    color: overrides.color ?? '#3498db',
    notes: overrides.notes ?? [],
    envelopes: {
      volume: { keyframes: [{ time: 0, value: 1, smoothness: 0 }] },
      pan: { keyframes: [{ time: 0, value: 0, smoothness: 0 }] },
      f0: { keyframes: [{ time: 0, value: 0, smoothness: 0 }] },
      ...overrides.envelopes,
    },
    ...overrides,
  };
}

module.exports = {
  mockElectronAPI,
  mockAudioBuffer,
  createTestNote,
  createTestSinger,
  createTestFragment,
};
