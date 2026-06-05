const { fork } = require('child_process');
const path = require('path');
const fs = require('fs');

function _findWorkerScript() {
  const searchPaths = [
    path.join(__dirname, 'audioWorker.js'),
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
    this._positionInterval = null;
    this._playbackStartTime = 0;
    this._playbackOffset = 0;
    this._readyResolve = null;
    this._readyPromise = null;
  }

  _ensureWorker() {
    if (this._worker) return this._worker;

    const workerScript = _findWorkerScript();
    if (!workerScript) {
      console.warn('[AudioOutputManager] audioWorker.js 未找到，WASAPI 独占模式不可用');
      return null;
    }

    try {
      this._worker = fork(workerScript, [], {
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env },
        serialization: 'advanced',
      });
    } catch (e) {
      console.error('[AudioOutputManager] fork 子进程失败:', e.message);
      this._worker = null;
      return null;
    }

    this._readyPromise = new Promise((resolve) => {
      this._readyResolve = resolve;
    });

    this._worker.on('message', (msg) => {
      if (msg.type === 'ready') {
        this._workerReady = true;
        this._workerAvailable = msg.isAvailable;
        if (this._readyResolve) {
          this._readyResolve(this._workerAvailable);
          this._readyResolve = null;
        }
        return;
      }

      if (msg.type === 'ended') {
        this._isPlaying = false;
        this._stopPositionTracking();
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

    this._worker.on('error', (err) => {
      console.error('[AudioOutputManager] 子进程错误:', err.message);
      this._workerReady = false;
      this._workerAvailable = false;
      if (this._readyResolve) {
        this._readyResolve(false);
        this._readyResolve = null;
      }
      this._rejectAllPending(err);
    });

    this._worker.on('exit', (code) => {
      this._workerReady = false;
      this._workerAvailable = false;
      this._worker = null;
      if (this._readyResolve) {
        this._readyResolve(false);
        this._readyResolve = null;
      }
      this._rejectAllPending(new Error(`音频子进程退出 (code=${code})`));
    });

    return this._worker;
  }

  _rejectAllPending(err) {
    for (const [, { reject }] of this._pendingRequests) {
      reject(err);
    }
    this._pendingRequests.clear();
  }

  _sendCommand(type, data = {}) {
    return new Promise((resolve, reject) => {
      const worker = this._ensureWorker();
      if (!worker) {
        reject(new Error('音频子进程不可用'));
        return;
      }

      const id = ++this._requestId;
      const timeout = setTimeout(() => {
        if (this._pendingRequests.has(id)) {
          this._pendingRequests.delete(id);
          reject(new Error(`命令超时: ${type}`));
        }
      }, 15000);

      this._pendingRequests.set(id, {
        resolve: (result) => { clearTimeout(timeout); resolve(result); },
        reject: (err) => { clearTimeout(timeout); reject(err); },
      });

      worker.send({ id, type, ...data });
    });
  }

  _startPositionTracking() {
    this._stopPositionTracking();
    this._positionInterval = setInterval(async () => {
      if (!this._isPlaying) return;
      try {
        const result = await this._sendCommand('getPosition');
        if (result.position !== undefined) {
          this._lastPosition = result.position;
          this._duration = result.duration || 0;
        }
      } catch (_) {}
    }, 200);
  }

  _stopPositionTracking() {
    if (this._positionInterval) {
      clearInterval(this._positionInterval);
      this._positionInterval = null;
    }
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
      const result = await this._sendCommand('getDevices');
      return result.devices || [];
    } catch (e) {
      return [];
    }
  }

  async start(audioData, options = {}) {
    await this.stop();

    const {
      volume = 1.0,
      offset = 0,
    } = options;

    this._volume = Math.max(0, Math.min(1, volume));
    this._playbackOffset = offset;
    this._isPlaying = false;
    this._lastPosition = offset;
    this._duration = audioData.length / (options.sampleRate || 24000);

    const audioArray = audioData instanceof Float32Array ? audioData : new Float32Array(audioData);

    // 等待 worker 就绪
    if (this._readyPromise) {
      await this._readyPromise;
    }

    const result = await this._sendCommand('start', {
      audioData: audioArray,
      options: { ...options, volume: this._volume },
    });

    if (result.success) {
      this._isPlaying = true;
      this._playbackStartTime = performance.now();
      this._startPositionTracking();
    }

    return result;
  }

  async stop() {
    if (this._isPlaying) {
      this._isPlaying = false;
      this._stopPositionTracking();
      try {
        await this._sendCommand('stop');
      } catch (_) {}
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
    this._stopPositionTracking();
    if (this._worker) {
      try { this._worker.kill(); } catch (_) {}
      this._worker = null;
    }
    this._workerReady = false;
    this._workerAvailable = false;
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

function _destroyDefaultInstance() {
  if (_defaultInstance) {
    _defaultInstance.destroy();
    _defaultInstance = null;
  }
}

AudioOutputManager.isAvailable = async function () {
  const now = Date.now();
  if (_cachedIsAvailable !== null && now - _cachedIsAvailableTime < CACHE_TTL) {
    return _cachedIsAvailable;
  }
  const result = await _getDefaultInstance().isAvailable();
  _cachedIsAvailable = result;
  _cachedIsAvailableTime = now;
  _destroyDefaultInstance();
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
  _destroyDefaultInstance();
  return result;
};

AudioOutputManager.getHostAPIs = function () {
  return [];
};

module.exports = { AudioOutputManager };
