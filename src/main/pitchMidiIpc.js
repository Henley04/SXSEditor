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

/**
 * Get the base model directory (without precision subdirectory).
 * Shared models (basic_pitch, rmvpe, rosvot) live at the base level,
 * not inside precision-specific subdirectories like int8/optimized_npu/.
 */
function getBaseModelDir() {
  const dir = getModelDir();
  // Strip precision subdirectories if present
  const precisionSuffixes = [
    path.sep + 'int8' + path.sep + 'optimized_npu' + path.sep,
    path.sep + 'int8' + path.sep,
    path.sep + 'fp16' + path.sep,
  ];
  for (const suffix of precisionSuffixes) {
    if (dir.endsWith(suffix) || dir.endsWith(suffix.slice(0, -1))) {
      const base = dir.slice(0, dir.lastIndexOf(suffix) + 1);
      return base;
    }
  }
  return dir;
}

const rmvpeLazy = createLazyInitializer(async () => {
  const modelPath = getBaseModelDir();
  const settings = loadSettings();
  const deviceId = settings.deviceId ?? undefined;
  console.log(`[Main] Initialize RMVPE Pitch Detector, model path: ${modelPath}, deviceId: ${deviceId !== undefined ? deviceId : 'auto'}`);
  const detector = new RmvpePitchDetector(modelPath, { deviceId });
  await detector.init();
  return detector;
});

const basicPitchLazy = createLazyInitializer(async () => {
  const modelPath = getBaseModelDir();
  console.log(`[Main] Initialize Basic Pitch Detector, model path: ${modelPath}`);
  const detector = new BasicPitchDetector(modelPath);
  await detector.init();
  return detector;
});

const rosvotLazy = createLazyInitializer(async () => {
  const modelPath = getBaseModelDir();
  const settings = loadSettings();
  const deviceId = settings.deviceId ?? undefined;
  console.log(`[Main] Initialize RosvotDetector, model path: ${modelPath}, deviceId: ${deviceId !== undefined ? deviceId : 'auto'}`);
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
      console.error('[Main] F0 extraction failed:', err);
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
        const modelPath = getBaseModelDir();
        const rosvotModelPath = path.join(modelPath, 'preprocess', 'rosvot_model.onnx');

        if (fs.existsSync(rosvotModelPath)) {
          try {
            const rosvot = await rosvotLazy.get();
            notes = await rosvot.extractNotes(
              new Float32Array(audioData), sampleRate || 44100, f0Array, bpm || 120
            );
            console.log(`[Main] RosVot extracted ${notes.length} notes`);

            const validNotes = notes.filter(n => n.pitch > 0);
            if (validNotes.length === 0) {
              console.log('[Main] RosVot extracted no valid notes, falling back to f0ToNotes');
              notes = detector.f0ToNotes(f0Array, bpm || 120);
            }
          } catch (rosvotErr) {
            console.warn('[Main] RosVot model inference failed, falling back to f0ToNotes:', rosvotErr.message);
            resetRosvot();
            notes = detector.f0ToNotes(f0Array, bpm || 120);
          }
        } else {
          console.log('[Main] RosVot model does not exist, using f0ToNotes fallback');
          notes = detector.f0ToNotes(f0Array, bpm || 120);
        }
      } else {
        console.log('[Main] Using f0ToNotes to extract MIDI notes from F0 curve');
        notes = detector.f0ToNotes(f0Array, bpm || 120);
      }

      return { success: true, f0Array, notes };
    } catch (err) {
      console.error('[Main] MIDI extraction failed:', err);
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('extractF0:basicPitch', async (event, { audioData, sampleRate, bpm }) => {
    try {
      const detector = await basicPitchLazy.get();
      const result = await detector.extractF0AndNotes(new Float32Array(audioData), sampleRate || 44100, bpm || 120);
      return { success: true, f0Array: result.f0Array, notes: result.notes };
    } catch (err) {
      console.error('[Main] Basic Pitch extraction failed:', err);
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
      console.error('[Main] MIDI import failed:', err);
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
