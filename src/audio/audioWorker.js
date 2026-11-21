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
// W2: Idempotent 'ended' guard (module-level declaration; previously this was
// an undeclared implicit global).
let _endedSent = false;
// 会话号：每次 start / stop 推进一次。start 的异步写入与 drain 监视器各自
// 记住启动时的会话号，只要被 stop 或新一轮 start 取代就静默退场 —— 否则
// 迟到的 drain 完成会把"已经换成新会话"的播放结束掉（发 ended / 停 Speaker）。
let _session = 0;

// Idle auto-shutdown: lets the device-query path (AudioOutputManager default
// instance) keep this process around for fast reuse while still freeing the
// fork ~30s after the last command. Never fires during playback.
let _idleTimer = null;
const IDLE_TIMEOUT_MS = 30000;

function _cancelIdleShutdown() {
  if (_idleTimer) {
    clearTimeout(_idleTimer);
    _idleTimer = null;
  }
}

function _scheduleIdleShutdown() {
  _cancelIdleShutdown();
  _idleTimer = setTimeout(() => {
    // Don't exit while a stream is playing.
    if (_isPlaying) return;
    try { handleStop(); } catch (_) {}
    _safeSend({ type: 'idle-shutdown' });
    process.exit(0);
  }, IDLE_TIMEOUT_MS);
  // 这个定时器不该单独维持进程存活：IPC 通道本身就会让子进程留着，
  // 一旦父进程断开，我们才能跟着退出（也方便测试进程收尾）。
  if (_idleTimer && typeof _idleTimer.unref === 'function') _idleTimer.unref();
}

// W2: process.send wrapper — avoids ERR_IPC_CHANNEL_CLOSED crashes when the
// parent has already disconnected.
function _safeSend(msg) {
  try {
    if (process.connected && typeof process.send === 'function') {
      process.send(msg);
    }
  } catch (_) { /* channel closed */ }
}

// W3: Idempotently notify the parent that playback has ended. Safe to call
// from both the Speaker finish event and the interval fallback.
function _notifyEnded() {
  if (_endedSent) return;
  _endedSent = true;
  _isPlaying = false;
  _stopPositionTracking();
  // 播完就放掉这段 PCM（一首歌几十 MB）；会话号已经推进时 handleStop 也会做，
  // 这里兜住"自然播完"这条路径。
  _audioData = null;
  _safeSend({ type: 'ended' });
  _scheduleIdleShutdown();
}

/**
 * 一份播放会话的收尾：释放设备句柄 + 通知父进程。
 * stop() 在队列已排空时是幂等的即时调用（不阻塞），之后不会再出声。
 */
function _releaseAndFinish(output) {
  if (output) {
    try { output.stop(); } catch (_) {}
  }
  if (_output === output) _output = null;
  _notifyEnded();
}

function resampleLinear(audio, sourceRate, targetRate) {
  if (sourceRate === targetRate) return audio;
  if (!Number.isFinite(sourceRate) || sourceRate <= 0 || !Number.isFinite(targetRate) || targetRate <= 0) {
    throw new RangeError('sourceRate and targetRate must be positive finite numbers');
  }
  if (audio.length === 0) return new Float32Array(0);
  const outputLength = Math.max(1, Math.round(audio.length * targetRate / sourceRate));
  const output = new Float32Array(outputLength);
  const scale = sourceRate / targetRate;
  for (let i = 0; i < outputLength; i++) {
    const src = Math.min(audio.length - 1, i * scale);
    const left = Math.floor(src);
    const right = Math.min(left + 1, audio.length - 1);
    const frac = src - left;
    output[i] = audio[left] + (audio[right] - audio[left]) * frac;
  }
  return output;
}

function handleGetDevices() {
  if (!Speaker) return { devices: [], isAvailable: false };
  try {
    const devices = Speaker.devices();
    return { devices: mapDevicesToLegacy(devices), isAvailable: true };
  } catch (e) {
    return { devices: [], isAvailable: false, error: e.message };
  }
}

/**
 * 播放结束监视器：等 native 队列真正播完再通知父进程。
 *
 * 必须用 drainAsync()（native 线程池）而不是 end()：decibri 的
 * `Writable._final` 会在事件循环上同步 drain 到整段音频播完，那会把 worker
 * 变成几十秒的哑巴 —— start 回执发不出去（父进程 8s 判超时并 kill），
 * stop 也没人处理（暂停/停止只能靠超时杀进程）。
 *
 * @param {object} output 本次会话的 Speaker
 * @param {number} session 启动时的会话号
 */
function _watchDrain(output, session) {
  if (!output || typeof output.drainAsync !== 'function') return;
  output.drainAsync().then(() => {
    // 已被 stop 或新一轮 start 取代：什么都不做（新会话可能正在出声，
    // 这里再发 ended 会让渲染层把新会话的播放头掐掉）。
    if (session !== _session || _output !== output || !_isPlaying) return;
    // 队列已播完，没有剩余音频可丢：stop() 释放设备句柄（幂等、不阻塞）。
    _releaseAndFinish(output);
  }).catch((err) => {
    if (session !== _session) return;
    // 失败不致命：位置跟踪的兜底 interval 与 'error' 事件仍会收尾。
    console.warn('[AudioWorker] drainAsync failed:', err && err.message);
  });
}

/**
 * 启动失败时把本次会话就地清干净（停设备、放掉 PCM、复位位置）。
 * 会话已被取代时不动共享状态 —— 那些字段现在属于新会话。
 */
function _abortStart(output, session) {
  if (session !== _session) return;
  _isPlaying = false;
  _stopPositionTracking();
  if (_output === output) _output = null;
  _audioData = null;
  _duration = 0;
  _playbackOffset = 0;
  if (output) {
    try { output.stop(); } catch (_) {}
  }
}

async function handleStart(audioData, options) {
  if (!Speaker) {
    return { success: false, error: 'decibri unavailable' };
  }
  if (!(audioData instanceof Float32Array)) {
    audioData = new Float32Array(audioData);
  }

  handleStop();

  // W3: Reset ended guard for the new playback session.
  _endedSent = false;
  const session = _session;

  const opts = options || {};
  const {
    sampleRate = 24000,
    sourceSampleRate = 24000,
    channels = 1,
    bitDepth = 'float32',
    volume = 1.0,
    offset = 0,
  } = opts;
  // 注意：decibri 忽略 bufferSize 与 exclusiveMode（始终共享模式）。

  const sourceDuration = audioData.length / sourceSampleRate;
  audioData = resampleLinear(audioData, sourceSampleRate, sampleRate);
  const dtype = resolveDtype(bitDepth); // int24/int32/未知 → float32
  const startSample = Math.floor(offset * sampleRate);

  const speakerOptions = buildSpeakerOptions({
    deviceId: opts.deviceId,
    sampleRate,
    channels,
    bitDepth,
  });

  let output;
  try {
    output = new Speaker(speakerOptions);
  } catch (e) {
    return { success: false, error: `Failed to create audio output: ${e.message}` };
  }

  // W3: 设备/驱动错误不能让 worker 以未捕获 'error' 崩掉，也不能替新会话报结束。
  output.on('error', (err) => {
    console.error('[AudioWorker] Speaker error:', err.message);
    if (session !== _session) return;
    _safeSend({ type: 'error', error: err.message });
    _notifyEnded();
  });

  _output = output;
  _sampleRate = sampleRate;
  _audioData = audioData;
  _duration = sourceDuration;
  _playbackOffset = offset;
  _isPlaying = true;
  _playbackStartTime = performance.now();

  // 写入必须**分片**且只等第一片落地就回执。
  //
  // writeAsync 解决的是"背压等待不在事件循环上"，但它仍然要等 native 队列
  // 接收完这整块 PCM；decibri 的队列是有限缓冲，一次性写 60s 音频时这个
  // promise 要等几乎整段播完才 resolve → 父进程 8s 判 `Command timeout: start`
  // 并杀掉 worker（长分片必现）。分片写 + 首片即回执后，回执延迟与音频长度无关。
  if (typeof output.writeAsync === 'function') {
    const totalToWrite = Math.max(0, audioData.length - startSample);
    const writeSlice = Math.max(1024, Math.round(sampleRate * 0.5));
    const firstCount = Math.min(totalToWrite, writeSlice);
    try {
      const firstPcm = buildPcmBuffer(audioData.subarray(startSample, startSample + firstCount), dtype, volume, 0);
      await output.writeAsync(firstPcm);
    } catch (e) {
      _abortStart(output, session);
      return { success: false, error: `Failed to write audio data: ${e.message}` };
    }

    // 写入首片期间被 stop / 新一轮 start 取代：不要再出声，也不要报告成功
    // （报告成功会让渲染层把播放头跑起来，而音频其实已经停了）。
    if (session !== _session) {
      try { output.stop(); } catch (_) {}
      return { success: false, error: 'superseded by stop' };
    }

    _startPositionTracking();
    // 剩余 PCM 在后台按序补写；写完才启动 drain 监视器（空队列的 drainAsync
    // 会立刻 resolve，提前启动会让“播完”事件在还有大半段没写时就发出）。
    _writeRemainder(output, audioData, dtype, volume, startSample + firstCount, writeSlice, session);
    return {
      success: true,
      sampleRate,
      channels,
      dtype,
      // decibri 始终共享模式；保留字段以兼容上层契约
      exclusiveMode: false,
    };
  }

  // 旧版 decibri（没有 writeAsync/drainAsync）：退回同步写入 + end()。
  // 这条路径会阻塞到音频播完，仅作兼容保留。
  let pcmBuffer;
  try {
    pcmBuffer = buildPcmBuffer(audioData, dtype, volume, startSample);
  } catch (e) {
    _abortStart(output, session);
    return { success: false, error: `Failed to write audio data: ${e.message}` };
  }
  output.on('finish', () => { if (session === _session) _notifyEnded(); });
  output.on('close', () => { if (session === _session) _notifyEnded(); });
  try {
    output.write(pcmBuffer);
    // 数据已全部写入，end() 让 Speaker 在内部缓冲播放完毕后自然 finish。
    output.end();
  } catch (e) {
    _abortStart(output, session);
    return { success: false, error: `Failed to write audio data: ${e.message}` };
  }
  if (session !== _session) {
    return { success: false, error: 'superseded by stop' };
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

/**
 * 首片回执之后继续写剩余 PCM（按序 await，保证样本顺序）。
 * @param {object} output Speaker
 * @param {Float32Array} audioData 源 PCM（已重采样到设备采样率）
 * @param {'int16'|'float32'} dtype
 * @param {number} volume
 * @param {number} from 起始采样
 * @param {number} slice 每片采样数
 * @param {number} session 会话号
 */
async function _writeRemainder(output, audioData, dtype, volume, from, slice, session) {
  let off = from;
  try {
    while (off < audioData.length) {
      if (session !== _session) return;
      const end = Math.min(audioData.length, off + slice);
      const pcm = buildPcmBuffer(audioData.subarray(off, end), dtype, volume, 0);
      await output.writeAsync(pcm);
      off = end;
    }
    if (session !== _session) return;
    _watchDrain(output, session);
  } catch (err) {
    if (session !== _session) return;
    console.error('[AudioWorker] Failed to write remaining audio:', err && err.message);
    _safeSend({ type: 'error', error: err && err.message });
    _releaseAndFinish(output);
  }
}

function handleStop() {
  // 推进会话号：在途的 writeAsync / drain 监视器/ finish 监听全部作废。
  _session += 1;
  _isPlaying = false;
  _stopPositionTracking();

  if (_output) {
    // W3: Remove our listeners before stop() so the Speaker's finish/close
    // events (triggered by stop()) don't fire a spurious 'ended' to parent.
    // handleStop is idempotent: subsequent calls find _output already null.
    try { _output.removeAllListeners('error'); } catch (_) {}
    try { _output.removeAllListeners('finish'); } catch (_) {}
    try { _output.removeAllListeners('close'); } catch (_) {}
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

    // 结束的主判据是 drainAsync（精确到队列真正排空）。墙钟估算会比真实
    // 播放早一点点（设备打开/首个缓冲还有延迟），直接按 _duration 收尾会把
    // 尾巴截掉几毫秒 —— 因此这里只做兜底：留 1s 余量，真卡住时才动手。
    if (position >= _duration + 1) {
      _releaseAndFinish(_output);
    }
  }, 100);
}

function _stopPositionTracking() {
  if (_positionInterval) {
    clearInterval(_positionInterval);
    _positionInterval = null;
  }
}

// 消息处理必须是"可重入"的：start 里有 await（writeAsync），期间到达的
// stop 必须立刻执行 —— 否则暂停/停止又要退化成靠父进程超时杀进程。
process.on('message', async (msg) => {
  const { id, type } = msg;
  _cancelIdleShutdown();

  let result;
  try {
    switch (type) {
      case 'isAvailable':
        result = { isAvailable: !!Speaker };
        break;
      case 'getDevices':
        result = handleGetDevices();
        break;
      case 'start':
        result = await handleStart(msg.audioData, msg.options);
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
    // W2: Use _safeSend to avoid ERR_IPC_CHANNEL_CLOSED if parent disconnected.
    _safeSend({ id, type, result });
  } catch (err) {
    // W2: Use _safeSend to avoid ERR_IPC_CHANNEL_CLOSED if parent disconnected.
    _safeSend({ id, type, result: { error: err.message } });
  }

  // Successful start keeps the process alive for the playback session;
  // everything else (queries, stops, errors) rearms idle shutdown.
  if (!_isPlaying) _scheduleIdleShutdown();
});

// W2: Handle SIGTERM so worker.kill() from the parent runs handleStop()
// (→ Speaker.stop()) and cleanly releases native audio device handles.
// handleStop is idempotent, so calling it here even if already stopped is safe.
process.on('SIGTERM', async () => {
  try { await handleStop(); } catch (_) {}
  process.exit(0);
});

// W2: Use _safeSend for the initial ready signal as well.
_safeSend({ type: 'ready', isAvailable: !!Speaker });
// Query-only sessions (device enumeration / availability check) auto-exit
// when idle; playback commands cancel this timer for their duration.
_scheduleIdleShutdown();

// 单元测试会在**同一个进程**里加载本模块来驱动消息处理。那种情况下空闲退出
// 定时器（30s 后 process.exit(0)）会把整个测试进程关掉 —— 调用方可以在收尾
// 时用这个钩子取消它。生产环境的 worker 是独立子进程，不需要用到导出。
module.exports = { _cancelIdleShutdown };
