const { BrowserWindow } = require('electron');
const { AudioOutputManager } = require('../audio/audioOutputManager');
const { createSessionGate } = require('../audio/uiSession');
const { getFragmentWindows } = require('./windowManager');
const { safeHandle } = require('./ipcSafe');
const { IPC_CHANNELS } = require('../shared/ipcChannels');

let _audioManager = null;
let _fragmentAudioManager = null;

// S13: Per-instance play mutex (Promise-chain lock). Serializes concurrent
// audio:play calls on the same manager so two rapid start() calls can't
// interleave at await points and drop A's onEnded. Reentrancy is not needed
// because play() does not call itself.
const _playLocks = new WeakMap();

function _withPlayLock(manager, task) {
  const prev = _playLocks.get(manager) || Promise.resolve();
  let release;
  const next = new Promise((r) => { release = r; });
  _playLocks.set(manager, next);
  return prev.then(task).finally(release);
}

// UI 会话号（每个 manager 一份）：渲染层每次 play / stop 都带上单调递增的
// 会话号，主进程只接受"不早于已见最大值"的命令。
//
// 解决的是这个时序：用户快速点两次播放再按停止 —— 第二条 play 还排在
// `_withPlayLock` 队列里，stop 先执行完，随后排队的 play 才轮到执行，
// 于是"停止之后声音自己响起来"。有了会话号，那条排队的 play 一进队列就被
// 丢弃，不必等到 audioPlay 回执才在渲染层补救。
// 裁决逻辑本身在 ../audio/uiSession.js（可单测的纯逻辑）。
const _sessionGates = new WeakMap();

function _acceptUiSession(manager, sessionId) {
  let gate = _sessionGates.get(manager);
  if (!gate) {
    gate = createSessionGate();
    _sessionGates.set(manager, gate);
  }
  return gate.accept(sessionId);
}

function getAudioManager() {
  if (!_audioManager) {
    _audioManager = new AudioOutputManager();
  }
  return _audioManager;
}

function getFragmentAudioManager() {
  if (!_fragmentAudioManager) {
    _fragmentAudioManager = new AudioOutputManager();
  }
  return _fragmentAudioManager;
}

function _getAudioManagerForSender(event) {
  const senderWin = BrowserWindow.fromWebContents(event.sender);
  if (senderWin) {
    const fragmentWindows = getFragmentWindows();
    for (const id in fragmentWindows) {
      if (fragmentWindows[id] === senderWin) {
        return getFragmentAudioManager();
      }
    }
  }
  return getAudioManager();
}

function resetAudioManagers() {
  if (_audioManager) { try { _audioManager.destroy(); } catch (_) {} _audioManager = null; }
  if (_fragmentAudioManager) { try { _fragmentAudioManager.destroy(); } catch (_) {} _fragmentAudioManager = null; }
}

function registerAudioIpc() {
  safeHandle(IPC_CHANNELS.AUDIO_GET_DEVICES, async () => {
    try {
      // S13: Use sequential awaits instead of Promise.all so the shared
      // _defaultInstance isn't destroyed mid-call by whichever resolves first.
      const devices = await AudioOutputManager.getDevices();
      const isAvailable = await AudioOutputManager.isAvailable();
      return { success: true, devices, isAvailable };
    } catch (err) {
      console.error('[Main] Failed to get audio devices:', err);
      return { success: false, devices: [], isAvailable: false, error: err.message };
    }
  });

  safeHandle(IPC_CHANNELS.AUDIO_PLAY, async (event, payload = {}) => {
    try {
      const { audioData, options } = payload;
      const manager = _getAudioManagerForSender(event);
      const sessionId = options?.sessionId;
      // 已经有一条更新的命令（通常是 stop）被接受：这条 play 属于旧会话，丢弃。
      if (!_acceptUiSession(manager, sessionId)) {
        return { success: false, error: 'stale session' };
      }
      // S13: Serialize concurrent play calls on the same instance.
      const result = await _withPlayLock(manager, async () => {
        // 排队期间可能又来了 stop / 更新的 play：轮到自己时再判一次。
        if (!_acceptUiSession(manager, sessionId)) {
          return { success: false, error: 'stale session' };
        }
        manager.onEnded(null);
        const r = await manager.start(audioData, options);

        manager.onEnded(() => {
          try {
            if (!event.sender.isDestroyed()) {
              event.sender.send(IPC_CHANNELS.AUDIO_ENDED, {});
            }
          } catch (_) {}
        });

        return r;
      });

      return { ...result };
    } catch (err) {
      console.error('[Main] Audio playback failed:', err);
      return { success: false, error: err.message };
    }
  });

  safeHandle(IPC_CHANNELS.AUDIO_STOP, async (event, payload = {}) => {
    try {
      const manager = _getAudioManagerForSender(event);
      const sessionId = payload?.sessionId;
      if (!_acceptUiSession(manager, sessionId)) {
        // 这条 stop 属于更早的会话，而更新的命令已经接管：此时执行它反而会把
        // 新会话刚开始的声音掐掉（旧 start 迟到时的补救就靠这个判定）。
        return { success: true, skipped: true };
      }
      // 必须用 forceStop：start 超时后 worker 可能仍在出声，而父进程的
      // _isPlaying 是 false，带守卫的 stop() 会跳过 → 幽灵播放停不掉。
      return await manager.forceStop();
    } catch (err) {
      console.error('[Main] Audio stop failed:', err);
      return { success: false, error: err.message };
    }
  });

  safeHandle(IPC_CHANNELS.AUDIO_GET_POSITION, async (event) => {
    try {
      const manager = _getAudioManagerForSender(event);
      if (manager.isPlaying()) {
        return { success: true, position: manager.getPosition(), duration: manager.getDuration() };
      }
      return { success: true, position: 0, duration: 0 };
    } catch (err) {
      return { success: false, position: 0, duration: 0, error: err.message };
    }
  });

  safeHandle(IPC_CHANNELS.AUDIO_IS_AVAILABLE, async () => {
    const available = await AudioOutputManager.isAvailable();
    return { available };
  });
}

module.exports = {
  registerAudioIpc,
  getAudioManager,
  getFragmentAudioManager,
  resetAudioManagers,
};
