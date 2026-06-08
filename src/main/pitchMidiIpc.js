const { ipcMain } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { RmvpePitchDetector } = require('../inference/rmvpePitchDetector');
const { BasicPitchDetector } = require('../inference/basicPitch');
const { RosvotDetector } = require('../inference/rosvotDetector');
const { parseMidiFile } = require('../inference/midiParser');
const { loadSettings } = require('./settings');
const { getModelDir } = require('./modelDir');
const { createLazyInitializer } = require('./lazyInitializer');

const rmvpeLazy = createLazyInitializer(async () => {
  const modelPath = getModelDir();
  const settings = loadSettings();
  const deviceId = settings.deviceId ?? undefined;
  console.log(`[Main] 初始化 RMVPE Pitch Detector, 模型路径: ${modelPath}, deviceId: ${deviceId !== undefined ? deviceId : '自动'}`);
  const detector = new RmvpePitchDetector(modelPath, { deviceId });
  await detector.init();
  return detector;
});

const basicPitchLazy = createLazyInitializer(async () => {
  const modelPath = getModelDir();
  console.log(`[Main] 初始化 Basic Pitch Detector, 模型路径: ${modelPath}`);
  const detector = new BasicPitchDetector(modelPath);
  await detector.init();
  return detector;
});

const rosvotLazy = createLazyInitializer(async () => {
  const modelPath = getModelDir();
  const settings = loadSettings();
  const deviceId = settings.deviceId ?? undefined;
  console.log(`[Main] 初始化 RosvotDetector, 模型路径: ${modelPath}, deviceId: ${deviceId !== undefined ? deviceId : '自动'}`);
  const detector = new RosvotDetector(modelPath, { deviceId });
  await detector.init();
  return detector;
});

function getRmvpeDetector() { return rmvpeLazy.getInstance(); }
function getBasicPitchDetector() { return basicPitchLazy.getInstance(); }
function getRosvotDetector() { return rosvotLazy.getInstance(); }

function resetRmvpe() {
  const inst = rmvpeLazy.getInstance();
  if (inst) { try { inst.dispose(); } catch (_) {} }
  rmvpeLazy.reset();
}
function resetBasicPitch() {
  const inst = basicPitchLazy.getInstance();
  if (inst) { try { inst.dispose(); } catch (_) {} }
  basicPitchLazy.reset();
}
function resetRosvot() {
  const inst = rosvotLazy.getInstance();
  if (inst) { try { inst.dispose(); } catch (_) {} }
  rosvotLazy.reset();
}

function registerPitchMidiIpc() {
  ipcMain.handle('extractF0:onnx', async (event, { audioData, sampleRate }) => {
    try {
      const detector = await rmvpeLazy.get();
      const f0Array = await detector.extractF0(new Float32Array(audioData), sampleRate || 44100);
      return { success: true, f0Array };
    } catch (err) {
      console.error('[Main] F0提取失败:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('extractMidi:rosvot', async (event, { audioData, sampleRate, bpm }) => {
    try {
      const detector = await rmvpeLazy.get();
      const f0Array = await detector.extractF0(new Float32Array(audioData), sampleRate || 44100);

      let notes;
      const settings = loadSettings();
      const useRosvot = settings?.useRosvot === true;

      if (useRosvot) {
        const modelPath = getModelDir();
        const rosvotModelPath = path.join(modelPath, 'preprocess', 'rosvot_model.onnx');

        if (fs.existsSync(rosvotModelPath)) {
          try {
            const rosvot = await rosvotLazy.get();
            notes = await rosvot.extractNotes(
              new Float32Array(audioData), sampleRate || 44100, f0Array, bpm || 120
            );
            console.log(`[Main] RosVot 提取到 ${notes.length} 个音符`);

            const validNotes = notes.filter(n => n.pitch > 0);
            if (validNotes.length === 0) {
              console.log('[Main] RosVot 未提取到有效音符，回退到 f0ToNotes');
              notes = detector.f0ToNotes(f0Array, bpm || 120);
            }
          } catch (rosvotErr) {
            console.warn('[Main] RosVot 模型推理失败，回退到 f0ToNotes:', rosvotErr.message);
            resetRosvot();
            notes = detector.f0ToNotes(f0Array, bpm || 120);
          }
        } else {
          console.log('[Main] RosVot 模型不存在，使用 f0ToNotes 回退');
          notes = detector.f0ToNotes(f0Array, bpm || 120);
        }
      } else {
        console.log('[Main] 使用 f0ToNotes 从 F0 曲线提取 MIDI 音符');
        notes = detector.f0ToNotes(f0Array, bpm || 120);
      }

      return { success: true, f0Array, notes };
    } catch (err) {
      console.error('[Main] MIDI提取失败:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('extractF0:basicPitch', async (event, { audioData, sampleRate, bpm }) => {
    try {
      const detector = await basicPitchLazy.get();
      const result = await detector.extractF0AndNotes(new Float32Array(audioData), sampleRate || 44100, bpm || 120);
      return { success: true, f0Array: result.f0Array, notes: result.notes };
    } catch (err) {
      console.error('[Main] Basic Pitch 提取失败:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('midi:import', async () => {
    try {
      const { dialog } = require('electron');
      const { t } = require('./locale');
      const result = await dialog.showOpenDialog({
        title: t('dialog.importMidi'),
        filters: [{ name: 'MIDI Files', extensions: ['mid', 'midi'] }],
        properties: ['openFile'],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, canceled: true };
      }

      const filePath = result.filePaths[0];
      const buffer = await require('node:fs').promises.readFile(filePath);
      const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      const notes = parseMidiFile(arrayBuffer);

      return { success: true, notes };
    } catch (err) {
      console.error('[Main] MIDI导入失败:', err);
      return { success: false, error: err.message };
    }
  });
}

module.exports = {
  registerPitchMidiIpc,
  getRmvpeDetector,
  getBasicPitchDetector,
  getRosvotDetector,
  resetRmvpe,
  resetBasicPitch,
  resetRosvot,
  rmvpeLazy,
  basicPitchLazy,
  rosvotLazy,
};
