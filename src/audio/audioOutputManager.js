const path = require('path');
const fs = require('fs');

// 音频 worker 子进程入口。
//
// 必须用 Electron 的 utilityProcess.fork()，不能用 child_process.fork()：
// 打包后 runAsNode fuse 是关闭的（见 forge.config.js），child_process.fork 会
// 直接抛 "child_process.fork() is not supported when the runAsNode fuse is
// disabled"。utilityProcess 是 Electron 自带的 Node 子进程通道，不受该 fuse
// 影响，且同样是真进程（native decibri 崩溃不会拖垮主进程）。
//
// 惰性取 utilityProcess + 可注入的 fork 桩，让本模块在纯 Node 单测里也能加载
// （test/electronBinaryFallback 下 require('electron') 只是路径字符串）。
let _forkWorkerForTests = null;
function _setForkWorkerForTests(fn) { _forkWorkerForTests = fn || null; }

function _forkWorker(workerScript) {
  if (_forkWorkerForTests) return _forkWorkerForTests(workerScript);
  const { utilityProcess } = require('electron');
  const env = { ...process.env };
  // 与 PluginRuntimeManager 同理：绝不能带 ELECTRON_RUN_AS_NODE，否则
  // utility 进程被当成纯 Node 启动，Chromium 的 --type=utility 开关变成非法参数。
  for (const key of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_ENABLE_LOGGING', 'ELECTRON_ENABLE_STACK_DUMPING']) {
    delete env[key];
  }
  return utilityProcess.fork(workerScript, [], {
    serviceName: 'sxseditor-audio-output',
    stdio: 'pipe',
    env,
  });
}

// start 要把整段 PCM 交给 native Speaker；正常情况毫秒级就有回执，8s 还没回
// 只可能是子进程卡在设备打开/写入上。等满 15s 会让每次点播放都白等这么久。
const START_COMMAND_TIMEOUT_MS = 8000;
// stop 是用户主动操作，必须快速有反馈；超时就当作子进程失联处理。
const STOP_COMMAND_TIMEOUT_MS = 3000;

function _findWorkerScript() {
  const searchPaths = [
    // Dev mode: audioOutputManager.js lives in src/audio/, audioWorker.js next to it.
    path.join(__dirname, 'audioWorker.js'),
    // Webpack-bundled main process: __dirname is .webpack/main/, audioWorker.js
    // is copied to .webpack/main/audio/audioWorker.js via CopyPlugin.
    path.join(__dirname, 'audio', 'audioWorker.js'),
    // Fallback: sibling audio directory (kept for legacy layouts).
    path.join(__dirname, '..', 'audio', 'audioWorker.js'),
  ];
  for (const p of searchPaths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

class AudioOutputManager {
  constructor() {
    this._volume = 1.0;
    this._worker = null;
    this._workerReady = false;
    this._workerAvailable = false;
    this._pendingRequests = new Map();
    this._requestId = 0;
    this._onEndedCallback = null;
    this._isPlaying = false;
    this._duration = 0;
    this._lastPosition = 0;
    this._playbackStartTime = 0;
    this._playbackOffset = 0;
    this._readyResolve = null;
    this._readyPromise = null;
    // S12: Track unexpected worker death so _ensureWorker() won't fork zombies
    // during getPosition polls; cleared only by an explicit start() request.
    this._workerCrashed = false;
    // S12: Guard against firing onEnded twice (interval + Speaker finish/crash).
    this._endedSent = false;
    // Set when the worker announced its own idle auto-shutdown, so the
    // following 'exit' event is not treated as an unexpected crash.
    this._idleExitExpected = false;
    // 用户停止计数器：每次 forceStop() 推进一次。start() 在进入时拍快照，
    // 在每个 await 之后重新比对 —— 排队中的 start（play 锁、worker ready）
    // 不能因为"回执晚到"就在用户已经停止之后把声音放出来。
    this._stopGeneration = 0;
    // start 回执可能晚于 worker 的 ended 消息（短音频）。若不用标志记住这次
    // "结束先到"，start 的 success 回执会把 _isPlaying 错误地反转回 true。
    this._starting = false;
    this._endedDuringStart = false;
    // fork 失败的 fuse 错误只记录一次（每次 isAvailable/start 都会重试 fork）。
    this._forkFailureLogged = false;
  }

  _ensureWorker() {
    // S12: Don't auto-fork a new worker if the previous one died unexpectedly.
    // This prevents getPosition polls from forking zombie workers every 200ms.
    // The flag is cleared only in start() when a fresh play is requested.
    if (this._workerCrashed) return null;
    if (this._worker) return this._worker;

    const workerScript = _findWorkerScript();
    if (!workerScript) {
      console.warn('[AudioOutputManager] audioWorker.js not found, WASAPI exclusive mode unavailable');
      return null;
    }

    try {
      this._worker = _forkWorker(workerScript);
    } catch (e) {
      // 每条 start/isAvailable 都会触发一次 fork 尝试；同一个 fuse 错误每次刷
      // 两行 ERROR 只会淹没有效日志。首次记录完整原因，后续只静默降级。
      if (!this._forkFailureLogged) {
        console.warn('[AudioOutputManager] audio worker unavailable, falling back to shared audio:', e.message);
        this._forkFailureLogged = true;
      }
      this._worker = null;
      return null;
    }

    // 捕获本次 fork 的进程身份：旧 worker 被 _killUnresponsiveWorker() 终止后，
    // 它的 'exit' 事件可能在新 worker 已经 fork 之后才到达。若不过滤，旧事件
    // 会把新进程的 _worker / _workerReady 一并清掉（表现为播放状态错乱）。
    const worker = this._worker;
    this._readyPromise = new Promise((resolve) => {
      this._readyResolve = resolve;
    });

    // The previous worker (if any) is gone; reset the idle-expectation flag
    // for this freshly forked process.
    this._idleExitExpected = false;

    worker.on('message', (msg) => {
      if (this._worker !== worker) return;
      if (msg.type === 'ready') {
        this._workerReady = true;
        this._workerAvailable = msg.isAvailable;
        if (this._readyResolve) {
          this._readyResolve(this._workerAvailable);
          this._readyResolve = null;
        }
        return;
      }

      // Worker announced its own 30s idle auto-shutdown. The following 'exit'
      // event is expected: keep the instance usable (it will re-fork on demand)
      // and do not reject pending requests or fire onEnded.
      if (msg.type === 'idle-shutdown') {
        this._idleExitExpected = true;
        return;
      }

      if (msg.type === 'ended') {
        // S12: Guard against firing onEnded twice (e.g. interval + Speaker finish).
        if (this._endedSent) return;
        this._endedSent = true;
        if (this._starting) this._endedDuringStart = true;
        this._isPlaying = false;
        if (this._onEndedCallback) {
          try { this._onEndedCallback(); } catch (_) {}
        }
        return;
      }

      if (msg.id !== undefined && this._pendingRequests.has(msg.id)) {
        const { resolve, reject } = this._pendingRequests.get(msg.id);
        this._pendingRequests.delete(msg.id);
        if (msg.result && msg.result.error) {
          reject(new Error(msg.result.error));
        } else {
          resolve(msg.result);
        }
      }
    });

    worker.on('error', (typeOrErr, location) => {
      if (this._worker !== worker) return;
      // Electron UtilityProcess 的 error 事件是 (type, location, report)，
      // 不是 Error 对象；纯 Node 测试桩仍可能给 Error。两种形状都取到有意义的
      // 文本，避免日志里打出 undefined。
      const detail = (typeOrErr && typeOrErr.message)
        || [typeOrErr, location].filter(Boolean).join(' ')
        || 'unknown child process error';
      console.error('[AudioOutputManager] child process error:', detail);
      this._workerReady = false;
      this._workerAvailable = false;
      // S12: Mark crashed so _ensureWorker() won't fork zombies during polls.
      this._workerCrashed = true;
      this._handleWorkerDeath();
      if (this._readyResolve) {
        this._readyResolve(false);
        this._readyResolve = null;
      }
      this._rejectAllPending(new Error(detail));
    });

    worker.on('exit', (code) => {
      if (this._worker !== worker) return;
      this._workerReady = false;
      this._workerAvailable = false;
      this._worker = null;
      // Expected idle auto-shutdown: just reset state so the next command
      // re-forks on demand. This is not a crash — don't reject pending
      // requests, fire onEnded, or mark the instance crashed.
      if (this._idleExitExpected) {
        this._idleExitExpected = false;
        this._workerCrashed = false;
        if (this._readyResolve) {
          this._readyResolve(false);
          this._readyResolve = null;
        }
        return;
      }
      // S12: Mark crashed so _ensureWorker() won't fork zombies during polls.
      this._workerCrashed = true;
      this._handleWorkerDeath();
      if (this._readyResolve) {
        this._readyResolve(false);
        this._readyResolve = null;
      }
      this._rejectAllPending(new Error(`Audio child process exited (code=${code})`));
    });

    return worker;
  }

  _rejectAllPending(err) {
    for (const [, { reject }] of this._pendingRequests) {
      reject(err);
    }
    this._pendingRequests.clear();
  }

  /**
   * 终止没有回执的音频子进程，并把父进程状态复位到"可重新开播"。
   *
   * 只 kill 是不够的：`exit` 事件会按"意外崩溃"把 _workerCrashed 置 true，
   * 之后 _ensureWorker() 永远返回 null，独占模式就再也用不了。这里显式把它
   * 标成预期退出，并清掉 ready/playing 状态，让下一次 start() 重新 fork。
   */
  _killUnresponsiveWorker() {
    const worker = this._worker;
    this._worker = null;
    this._workerReady = false;
    this._workerAvailable = false;
    this._isPlaying = false;
    this._endedSent = false;
    this._workerCrashed = false;
    this._idleExitExpected = true;
    if (this._readyResolve) {
      this._readyResolve(false);
      this._readyResolve = null;
    }
    this._handleWorkerDeath();
    this._rejectAllPending(new Error('Audio worker did not respond'));
    if (!worker) return;
    // UtilityProcess.kill() 无参数（d.ts: kill(): boolean），传 'SIGKILL' 会被忽略。
    // 它底层走的是进程终止而非 SIGTERM，本身已经是强杀；延迟再调一次仅作兜底。
    try { worker.kill(); } catch (_) {}
    const forceTimer = setTimeout(() => {
      try { worker.kill(); } catch (_) {}
    }, 500);
    if (forceTimer && typeof forceTimer.unref === 'function') forceTimer.unref();
  }

  // S12: Called from worker 'error'/'exit' handlers to clean up playing state
  // and fire a synthetic onEnded so the UI doesn't stay stuck in "playing".
  _handleWorkerDeath() {
    const wasPlaying = this._isPlaying;
    this._isPlaying = false;
    if (wasPlaying && !this._endedSent) {
      this._endedSent = true;
      if (this._onEndedCallback) {
        try { this._onEndedCallback(); } catch (_) {}
      }
    }
  }

  // transferList 保留为位置参数（旧调用点把 timeoutMs 放在第 4 位），但
  // utilityProcess 不再支持 ArrayBuffer transfer，实际发送时忽略它。
  _sendCommand(type, data = {}, _transferList = null, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const worker = this._ensureWorker();
      if (!worker) {
        reject(new Error('Audio child process unavailable'));
        return;
      }

      const id = ++this._requestId;
      // B3: Per-command timeout (default 15s; quick status commands use 2s).
      const timeout = setTimeout(() => {
        if (!this._pendingRequests.has(id)) return;
        this._pendingRequests.delete(id);
        const err = new Error(`Command timeout: ${type}`);
        // start 没有回执时，worker 端可能已经把 PCM 交给音频设备开始出声，只是
        // native 调用卡住导致回执发不回来。父进程此刻 _isPlaying 仍是 false，
        // 带守卫的 stop() 会直接跳过 → 留下"UI 认为没在播、用户却停不掉"的
        // 幽灵播放（且播放的是没混伴奏的纯人声）。因此 start 超时必须连
        // 子进程一起终止，让系统释放音频设备句柄。
        if (type === 'start') this._killUnresponsiveWorker();
        reject(err);
      }, timeoutMs);

      this._pendingRequests.set(id, {
        resolve: (result) => { clearTimeout(timeout); resolve(result); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });

      // utilityProcess 的 postMessage 第二参数只接受 MessagePortMain 数组
      // （Electron 45 electron.d.ts / electron_api_utility_process.cc：
      // "transferables must be an array of MessagePorts"），不能传 ArrayBuffer。
      // 因此 PCM 走结构化克隆（复制一份）而非 transfer —— 一首 3 分钟 24kHz
      // fp32 约 17MB，复制是毫秒级；正确性优先于零拷贝。
      worker.postMessage({ id, type, ...data });
    });
  }

  async isAvailable() {
    this._ensureWorker();
    if (this._workerReady) return this._workerAvailable;
    if (this._readyPromise) {
      await this._readyPromise;
    }
    return this._workerAvailable;
  }

  async getDevices() {
    try {
      // B3: getDevices is a quick status command, use 2s timeout.
      const result = await this._sendCommand('getDevices', {}, null, 2000);
      return result.devices || [];
    } catch (_e) {
      return [];
    }
  }

  async start(audioData, options = {}) {
    // 快照必须取在第一个 await 之前：本次 start 可能已经在 play 锁里排队，
    // 或正在等 worker ready，期间用户完全可能按了停止。
    const stopGeneration = this._stopGeneration;
    await this.stop();

    // S12: Clear crash flag so start() can fork a fresh worker; reset ended
    // flag so the new playback session can fire onEnded.
    this._workerCrashed = false;
    this._endedSent = false;

    // sessionId 只用于主进程判断"这条 play 是否已被更新的命令取代"，
    // 不该下发给 worker（它不需要知道 UI 会话）。
    const { sessionId: _sessionId, ...workerOptions } = options;
    const {
      volume = 1.0,
      offset = 0,
    } = workerOptions;

    this._volume = Math.max(0, Math.min(1, volume));
    this._playbackOffset = offset;
    this._isPlaying = false;
    this._lastPosition = offset;
    // C14: 时长必须按源采样率换算。audioData 是源采样率下的样本，worker 会先
    // resample 到 options.sampleRate 再播放（见 audioWorker.js handleStart 的
    // sourceDuration）。用目标采样率除源长度会在 24k→48k 时把时长减半。
    this._duration = audioData.length / (workerOptions.sourceSampleRate || workerOptions.sampleRate || 24000);

    const audioArray = audioData instanceof Float32Array ? audioData : new Float32Array(audioData);

    // 等待 worker 就绪
    if (this._readyPromise) {
      await this._readyPromise;
    }

    if (this._stopGeneration !== stopGeneration) {
      this._isPlaying = false;
      return { success: false, error: 'Audio start cancelled by stop' };
    }

    // 标记"start 在途"：worker 可能在回执之前就发 ended（短音频）。
    this._starting = true;
    this._endedDuringStart = false;
    let result;
    try {
      result = await this._sendCommand('start', {
        audioData: audioArray,
        options: { ...workerOptions, volume: this._volume },
      }, [audioArray.buffer], START_COMMAND_TIMEOUT_MS);
    } finally {
      this._starting = false;
    }

    if (this._stopGeneration !== stopGeneration) {
      // 回执回来之前用户已经按了停止：这一路可能真的在出声（start 无回执
      // ≠ 没在播），必须立刻掐掉，并且不能把 _isPlaying 置回 true。
      this._isPlaying = false;
      try {
        await this._sendCommand('stop', {}, null, STOP_COMMAND_TIMEOUT_MS);
      } catch (_) {}
      return { success: false, error: 'Audio start cancelled by stop' };
    }

    if (result.success && !this._endedDuringStart) {
      this._isPlaying = true;
      this._playbackStartTime = performance.now();
      // Playback end is driven by the worker's 'ended' IPC message (Speaker
      // finish event + its own interval fallback); no parent-side polling.
    }

    return result;
  }

  async stop() {
    if (this._isPlaying) {
      this._isPlaying = false;
      try {
        await this._sendCommand('stop', {}, null, STOP_COMMAND_TIMEOUT_MS);
      } catch (_) {}
    }
  }

  /**
   * UI 发起的停止/暂停：无条件停掉音频子进程的出声。
   *
   * 与 stop() 的区别：stop() 带 `_isPlaying` 守卫，只用于 start() 内部清理。
   * 当 start 的回执超时、或 worker 已经开始播放但父进程还没标记 playing 时，
   * 这个守卫会让"停止"变成一个静默 no-op —— 正是用户遇到的"播放停不下来"。
   * 这里不看状态，只要 worker 还在就发 stop；不响应就按失联处理直接终止。
   */
  async forceStop() {
    // 先推进停止代：正在排队/等待回执的 start 会在下一个检查点自行放弃。
    this._stopGeneration += 1;
    this._isPlaying = false;
    this._lastPosition = 0;
    // 从未 fork 过 worker（一直在共享 WebAudio 模式）时，不要为了一个 no-op
    // stop 凭空创建子进程。
    if (!this._worker) return { success: true };
    try {
      return await this._sendCommand('stop', {}, null, STOP_COMMAND_TIMEOUT_MS);
    } catch (err) {
      this._killUnresponsiveWorker();
      return { success: false, error: err.message };
    }
  }

  getPosition() {
    if (!this._isPlaying) {
      return this._lastPosition;
    }
    const elapsedMs = performance.now() - this._playbackStartTime;
    return this._playbackOffset + elapsedMs / 1000;
  }

  getDuration() {
    return this._duration;
  }

  isPlaying() {
    return this._isPlaying;
  }

  onEnded(callback) {
    this._onEndedCallback = callback;
  }

  destroy() {
    this._isPlaying = false;
    this._onEndedCallback = null;
    if (this._worker) {
      try { this._worker.removeAllListeners(); } catch (_) {}
      try { this._worker.kill(); } catch (_) {}
      this._worker = null;
    }
    this._workerReady = false;
    this._workerAvailable = false;
    this._idleExitExpected = false;
    this._rejectAllPending(new Error('AudioOutputManager destroyed'));
  }
}

// 静态方法：共享默认实例用于设备查询和可用性检查
let _defaultInstance = null;

let _cachedDevices = null;
let _cachedDevicesTime = 0;
let _cachedIsAvailable = null;
let _cachedIsAvailableTime = 0;
const CACHE_TTL = 5000; // 5 秒

function _getDefaultInstance() {
  if (!_defaultInstance) {
    _defaultInstance = new AudioOutputManager();
  }
  return _defaultInstance;
}

AudioOutputManager.isAvailable = async function () {
  const now = Date.now();
  if (_cachedIsAvailable !== null && now - _cachedIsAvailableTime < CACHE_TTL) {
    return _cachedIsAvailable;
  }
  // Keep the default instance around for reuse: the worker process forks once
  // and exits itself after 30s idle, so repeated device polls no longer pay a
  // fork per query. The lightweight manager object staying resident is fine.
  const result = await _getDefaultInstance().isAvailable();
  _cachedIsAvailable = result;
  _cachedIsAvailableTime = now;
  return result;
};

AudioOutputManager.getDevices = async function () {
  const now = Date.now();
  if (_cachedDevices !== null && now - _cachedDevicesTime < CACHE_TTL) {
    return _cachedDevices;
  }
  const result = await _getDefaultInstance().getDevices();
  _cachedDevices = result;
  _cachedDevicesTime = now;
  return result;
};

AudioOutputManager.getHostAPIs = function () {
  return [];
};

module.exports = { AudioOutputManager, _setForkWorkerForTests };
