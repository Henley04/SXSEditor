let naudio = null;
let _output = null;
let _isPlaying = false;
let _playbackStartTime = 0;
let _playbackOffset = 0;
let _audioData = null;
let _sampleRate = 24000;
let _duration = 0;
let _positionInterval = null;

const FORMAT_MAP = {
  'float32': 0x01,
  'int16': 0x02,
  'int24': 0x04,
  'int32': 0x08,
};

try {
  naudio = require('naudiodon');
  if (naudio) {
    FORMAT_MAP['float32'] = naudio.SampleFormatFloat32;
    FORMAT_MAP['int16'] = naudio.SampleFormatInt16;
    FORMAT_MAP['int24'] = naudio.SampleFormatInt24;
    FORMAT_MAP['int32'] = naudio.SampleFormatInt32;
  }
} catch (e) {
  naudio = null;
}

function handleGetDevices() {
  if (!naudio) return { devices: [], isAvailable: false };
  try {
    const devices = naudio.getDevices();
    const filtered = devices
      .filter(d => d.maxOutputChannels > 0)
      .map(d => ({
        id: d.id,
        name: d.name,
        maxOutputChannels: d.maxOutputChannels,
        defaultSampleRate: d.defaultSampleRate,
        hostAPI: d.hostAPIName || 'Unknown',
      }));
    return { devices: filtered, isAvailable: true };
  } catch (e) {
    return { devices: [], isAvailable: false, error: e.message };
  }
}

function handleStart(audioData, options) {
  if (!naudio) {
    return { success: false, error: 'naudiodon 不可用' };
  }
  // Ensure audioData is Float32Array
  if (!(audioData instanceof Float32Array)) {
    audioData = new Float32Array(audioData);
  }

  handleStop();

  const {
    deviceId = -1,
    sampleRate = 24000,
    channels = 1,
    bitDepth = 'float32',
    bufferSize = 2048,
    exclusiveMode = false,
    volume = 1.0,
    offset = 0,
  } = options;

  _sampleRate = sampleRate;
  _audioData = _applyVolume(audioData, Math.max(0, Math.min(1, volume)));
  _duration = _audioData.length / _sampleRate;
  _playbackOffset = offset;

  const format = FORMAT_MAP[bitDepth] || FORMAT_MAP['float32'];

  let outputData = _audioData;
  if (bitDepth !== 'float32') {
    outputData = _convertBitDepth(_audioData, bitDepth);
  }

  const outputOptions = {
    deviceId: deviceId,
    sampleRate: sampleRate,
    channels: channels,
    sampleFormat: format,
    bufferSize: bufferSize,
  };

  if (exclusiveMode && process.platform === 'win32') {
    outputOptions.wasapiExclusiveMode = true;
  }

  try {
    _output = new naudio.AudioOutput(outputOptions);
  } catch (e) {
    return { success: false, error: `创建音频输出失败: ${e.message}` };
  }

  _isPlaying = true;
  _playbackStartTime = performance.now();

  const startSample = Math.floor(offset * sampleRate);
  const dataToWrite = outputData.slice(startSample);

  try {
    _output.write(dataToWrite);
  } catch (e) {
    _isPlaying = false;
    try { _output.end(); } catch (_) {}
    _output = null;
    return { success: false, error: `写入音频数据失败: ${e.message}` };
  }
  _startPositionTracking();

  return {
    success: true,
    sampleRate: sampleRate,
    channels: channels,
    bufferSize: bufferSize,
    exclusiveMode: exclusiveMode,
  };
}

function handleStop() {
  _isPlaying = false;
  _stopPositionTracking();

  if (_output) {
    try { _output.end(); } catch (_) {}
    _output = null;
  }

  _audioData = null;
  _duration = 0;
  _playbackOffset = 0;
}

function handleGetPosition() {
  if (!_isPlaying) {
    return { position: _playbackOffset, duration: _duration };
  }
  const elapsedMs = performance.now() - _playbackStartTime;
  const elapsedSeconds = elapsedMs / 1000;
  return { position: _playbackOffset + elapsedSeconds, duration: _duration };
}

function _startPositionTracking() {
  _stopPositionTracking();
  _positionInterval = setInterval(() => {
    if (!_isPlaying) return;

    const elapsedMs = performance.now() - _playbackStartTime;
    const elapsedSeconds = elapsedMs / 1000;
    const position = _playbackOffset + elapsedSeconds;

    if (position >= _duration) {
      _isPlaying = false;
      _stopPositionTracking();
      process.send({ type: 'ended' });
    }
  }, 100);
}

function _stopPositionTracking() {
  if (_positionInterval) {
    clearInterval(_positionInterval);
    _positionInterval = null;
  }
}

function _applyVolume(audioData, volume) {
  if (volume === 1.0) return audioData;
  const result = new Float32Array(audioData.length);
  for (let i = 0; i < audioData.length; i++) {
    result[i] = audioData[i] * volume;
  }
  return result;
}

function _convertBitDepth(float32Data, targetFormat) {
  switch (targetFormat) {
    case 'int16': {
      const int16 = new Int16Array(float32Data.length);
      for (let i = 0; i < float32Data.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Data[i]));
        int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      return Buffer.from(int16.buffer);
    }
    case 'int24': {
      const buf = Buffer.alloc(float32Data.length * 3);
      for (let i = 0; i < float32Data.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Data[i]));
        const val = s < 0 ? s * 0x800000 : s * 0x7FFFFF;
        const abs = Math.abs(val) | 0;
        const sign = val < 0 ? 1 : 0;
        const v = sign ? (0x1000000 - abs) : abs;
        buf[i * 3] = v & 0xFF;
        buf[i * 3 + 1] = (v >> 8) & 0xFF;
        buf[i * 3 + 2] = (v >> 16) & 0xFF;
      }
      return buf;
    }
    case 'int32': {
      const int32 = new Int32Array(float32Data.length);
      for (let i = 0; i < float32Data.length; i++) {
        const s = Math.max(-1, Math.min(1, float32Data[i]));
        int32[i] = s < 0 ? s * 0x80000000 : s * 0x7FFFFFFF;
      }
      return Buffer.from(int32.buffer);
    }
    default:
      return float32Data;
  }
}

process.on('message', (msg) => {
  const { id, type } = msg;

  try {
    let result;
    switch (type) {
      case 'isAvailable':
        result = { isAvailable: !!naudio };
        break;
      case 'getDevices':
        result = handleGetDevices();
        break;
      case 'start':
        result = handleStart(msg.audioData, msg.options);
        break;
      case 'stop':
        handleStop();
        result = { success: true };
        break;
      case 'getPosition':
        result = handleGetPosition();
        break;
      default:
        result = { error: `Unknown command: ${type}` };
    }
    process.send({ id, type, result });
  } catch (err) {
    process.send({ id, type, result: { error: err.message } });
  }
});

process.send({ type: 'ready', isAvailable: !!naudio });
