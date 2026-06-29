// 音频输出子进程：使用 decibri (Speaker) 进行 WASAPI/系统音频播放。
//
// 该文件由 audioOutputManager.js 通过 child_process.fork 启动，并通过 IPC
// (process.send / process.on('message')) 通信。它不直接被 webpack 打包，
// 而是由 CopyPlugin 复制到 .webpack/main/audio/ 下运行，因此其 require
// 的相对模块（./audioFormatUtils）也必须由 CopyPlugin 一并复制。
//
// decibri 的 Speaker 是一个 Writable stream，仅支持 'int16' 与 'float32'
// 两种 dtype，不支持 int24 / int32 / 独占模式 / 自定义 bufferSize。
// 上层传入的这些选项会在 audioFormatUtils 中适配：
// int24/int32 降级为 float32，独占模式与缓冲区大小被忽略（始终共享模式）。

const { Speaker } = (() => {
  try {
    return require('decibri');
  } catch (e) {
    console.warn('[AudioWorker] decibri load failed:', e.message);
    console.warn(`[AudioWorker] Env: Node ${process.version}, platform ${process.platform}, arch ${process.arch}`);
    return {};
  }
})();

const {
  mapDevicesToLegacy,
  buildSpeakerOptions,
  buildPcmBuffer,
  resolveDtype,
} = require('./audioFormatUtils');

let _output = null;
let _isPlaying = false;
let _playbackStartTime = 0;
let _playbackOffset = 0;
let _audioData = null;
let _sampleRate = 24000;
let _duration = 0;
let _positionInterval = null;

function handleGetDevices() {
  if (!Speaker) return { devices: [], isAvailable: false };
  try {
    const devices = Speaker.devices();
    return { devices: mapDevicesToLegacy(devices), isAvailable: true };
  } catch (e) {
    return { devices: [], isAvailable: false, error: e.message };
  }
}

function handleStart(audioData, options) {
  if (!Speaker) {
    return { success: false, error: 'decibri unavailable' };
  }
  if (!(audioData instanceof Float32Array)) {
    audioData = new Float32Array(audioData);
  }

  handleStop();

  const {
    sampleRate = 24000,
    channels = 1,
    bitDepth = 'float32',
    volume = 1.0,
    offset = 0,
  } = options || {};
  // 注意：decibri 忽略 bufferSize 与 exclusiveMode（始终共享模式）。

  _sampleRate = sampleRate;
  const dtype = resolveDtype(bitDepth); // int24/int32/未知 → float32
  const startSample = Math.floor(offset * sampleRate);

  _audioData = audioData;
  _duration = audioData.length / _sampleRate;
  _playbackOffset = offset;

  const speakerOptions = buildSpeakerOptions({
    deviceId: options.deviceId,
    sampleRate,
    channels,
    bitDepth,
  });

  try {
    _output = new Speaker(speakerOptions);
  } catch (e) {
    return { success: false, error: `Failed to create audio output: ${e.message}` };
  }

  _isPlaying = true;
  _playbackStartTime = performance.now();

  try {
    const pcmBuffer = buildPcmBuffer(audioData, dtype, volume, startSample);
    _output.write(pcmBuffer);
    // 数据已全部写入，end() 让 Speaker 在内部缓冲播放完毕后自然 finish。
    _output.end();
  } catch (e) {
    _isPlaying = false;
    try { _output.stop(); } catch (_) {}
    _output = null;
    return { success: false, error: `Failed to write audio data: ${e.message}` };
  }
  _startPositionTracking();

  return {
    success: true,
    sampleRate,
    channels,
    dtype,
    // decibri 始终共享模式；保留字段以兼容上层契约
    exclusiveMode: false,
  };
}

function handleStop() {
  _isPlaying = false;
  _stopPositionTracking();

  if (_output) {
    // stop() 立即停止并丢弃剩余音频（区别于 end() 的 drain 行为）
    try { _output.stop(); } catch (_) {}
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

process.on('message', (msg) => {
  const { id, type } = msg;

  try {
    let result;
    switch (type) {
      case 'isAvailable':
        result = { isAvailable: !!Speaker };
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

process.send({ type: 'ready', isAvailable: !!Speaker });
