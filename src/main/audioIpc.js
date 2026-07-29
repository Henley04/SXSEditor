const { ipcMain, BrowserWindow } = require('electron');
const { AudioOutputManager } = require('../audio/audioOutputManager');
const { getFragmentWindows } = require('./windowManager');

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
  ipcMain.handle('audio:getDevices', async () => {
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

  ipcMain.handle('audio:play', async (event, { audioData, options }) => {
    try {
      const manager = _getAudioManagerForSender(event);
      // S13: Serialize concurrent play calls on the same instance.
      const result = await _withPlayLock(manager, async () => {
        manager.onEnded(null);
        const r = await manager.start(audioData, options);

        manager.onEnded(() => {
          try {
            if (!event.sender.isDestroyed()) {
              event.sender.send('audio:ended', {});
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

  ipcMain.handle('audio:stop', async (event) => {
    try {
      const manager = _getAudioManagerForSender(event);
      await manager.stop();
      return { success: true };
    } catch (err) {
      console.error('[Main] Audio stop failed:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('audio:getPosition', async (event) => {
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

  ipcMain.handle('audio:isAvailable', async () => {
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
