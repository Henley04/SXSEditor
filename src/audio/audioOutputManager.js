const { fork } = require('child_process');
const path = require('path');

let _worker = null;
let _workerReady = false;
let _workerAvailable = false;
let _pendingRequests = new Map();
let _requestId = 0;
let _onEndedCallback = null;
let _isPlaying = false;
let _duration = 0;
let _lastPosition = 0;
let _positionInterval = null;
let _playbackStartTime = 0;
let _playbackOffset = 0;

function _findWorkerScript() {
  const searchPaths = [
    path.join(__dirname, 'audioWorker.js'),
    path.join(__dirname, '..', 'audio', 'audioWorker.js'),
  ];
  for (const p of searchPaths) {
    try {
      if (require('fs').existsSync(p)) return p;
    } catch (_) {}
  }
  return null;
}

function _ensureWorker() {
  if (_worker) return _worker;

  const workerScript = _findWorkerScript();
  if (!workerScript) {
    console.warn('[AudioOutputManager] audioWorker.js 未找到，WASAPI 独占模式不可用');
    return null;
  }

  _worker = fork(workerScript, [], {
    stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env },
    serialization: 'advanced',
  });

  _worker.on('message', (msg) => {
    if (msg.type === 'ready') {
      _workerReady = true;
      _workerAvailable = msg.isAvailable;
      return;
    }

    if (msg.type === 'ended') {
      _isPlaying = false;
      _stopPositionTracking();
      if (_onEndedCallback) {
        try { _onEndedCallback(); } catch (_) {}
      }
      return;
    }

    if (msg.id !== undefined && _pendingRequests.has(msg.id)) {
      const { resolve } = _pendingRequests.get(msg.id);
      _pendingRequests.delete(msg.id);
      resolve(msg.result);
    }
  });

  _worker.on('error', (err) => {
    console.error('[AudioOutputManager] 子进程错误:', err.message);
    _workerReady = false;
    _workerAvailable = false;
    _rejectAllPending(err);
  });

  _worker.on('exit', (code) => {
    _workerReady = false;
    _workerAvailable = false;
    _worker = null;
    _rejectAllPending(new Error(`音频子进程退出 (code=${code})`));
  });

  return _worker;
}

function _rejectAllPending(err) {
  for (const [id, { reject }] of _pendingRequests) {
    reject(err);
  }
  _pendingRequests.clear();
}

function _sendCommand(type, data = {}) {
  return new Promise((resolve, reject) => {
    const worker = _ensureWorker();
    if (!worker) {
      resolve({ error: '音频子进程不可用' });
      return;
    }

    const id = ++_requestId;
    _pendingRequests.set(id, { resolve, reject });

    const timeout = setTimeout(() => {
      if (_pendingRequests.has(id)) {
        _pendingRequests.delete(id);
        resolve({ error: `命令超时: ${type}` });
      }
    }, 15000);

    _pendingRequests.set(id, {
      resolve: (result) => { clearTimeout(timeout); resolve(result); },
      reject: (err) => { clearTimeout(timeout); reject(err); },
    });

    worker.send({ id, type, ...data });
  });
}

function _startPositionTracking() {
  _stopPositionTracking();
  _positionInterval = setInterval(async () => {
    if (!_isPlaying) return;
    try {
      const result = await _sendCommand('getPosition');
      if (result.position !== undefined) {
        _lastPosition = result.position;
        _duration = result.duration || 0;
      }
    } catch (_) {}
  }, 200);
}

function _stopPositionTracking() {
  if (_positionInterval) {
    clearInterval(_positionInterval);
    _positionInterval = null;
  }
}

class AudioOutputManager {
  constructor() {
    this._volume = 1.0;
  }

  static isAvailable() {
    if (!_worker || !_workerReady) {
      _ensureWorker();
    }
    return _workerAvailable;
  }

  static getDevices() {
    return _sendCommand('getDevices').then(result => {
      return result.devices || [];
    }).catch(() => []);
  }

  static getHostAPIs() {
    return [];
  }

  async start(audioData, options = {}) {
    this.stop();

    const {
      volume = 1.0,
      offset = 0,
    } = options;

    this._volume = Math.max(0, Math.min(1, volume));
    _playbackOffset = offset;
    _isPlaying = false;
    _lastPosition = offset;
    _duration = audioData.length / (options.sampleRate || 24000);

    const audioArray = audioData instanceof Float32Array ? audioData : new Float32Array(audioData);

    const result = await _sendCommand('start', {
      audioData: audioArray,
      options: { ...options, volume: this._volume },
    });

    if (result.success) {
      _isPlaying = true;
      _playbackStartTime = Date.now();
      _startPositionTracking();
    }

    return result;
  }

  stop() {
    if (_isPlaying) {
      _isPlaying = false;
      _stopPositionTracking();
      _sendCommand('stop').catch(() => {});
    }
  }

  getPosition() {
    if (!_isPlaying) {
      return _lastPosition;
    }
    const elapsedMs = Date.now() - _playbackStartTime;
    return _playbackOffset + elapsedMs / 1000;
  }

  getDuration() {
    return _duration;
  }

  isPlaying() {
    return _isPlaying;
  }

  onEnded(callback) {
    _onEndedCallback = callback;
  }
}

module.exports = { AudioOutputManager };
