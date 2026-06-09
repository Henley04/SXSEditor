const { ipcMain } = require('electron');
const { OnnxSVSPipeline, SAMPLE_RATE } = require('../inference/pipeline');
const { loadSettings } = require('./settings');
const { getModelDir } = require('./modelDir');
const { t } = require('./locale');
const { createLazyInitializer } = require('./lazyInitializer');

const svsPipelineLazy = createLazyInitializer(async () => {
  const modelPath = getModelDir();
  const settings = loadSettings();
  const deviceMode = settings.deviceMode || 'smart';
  const deviceId = settings.preferredDeviceId ?? settings.deviceId ?? undefined;
  const preferredDeviceType = settings.preferredDeviceType || undefined;
  const modelDeviceMapping = settings.modelDeviceMapping || undefined;
  const modelPrecision = settings.modelPrecision || 'fp16';
  console.log(`[Main] Initializing SVS Pipeline (ONNX Runtime), model path: ${modelPath}, deviceMode: ${deviceMode}, deviceId: ${deviceId !== undefined ? deviceId : 'auto'}, precision: ${modelPrecision}`);

  const pipeline = new OnnxSVSPipeline(modelPath, {
    deviceId,
    deviceMode,
    preferredDeviceType,
    modelDeviceMapping,
    modelPrecision,
  });
  await pipeline.init();
  return pipeline;
});

function getSvsPipeline() {
  return svsPipelineLazy.getInstance();
}

function resetSvsPipeline() {
  const inst = svsPipelineLazy.getInstance();
  if (inst) {
    try { inst.dispose(); } catch (_) {}
  }
  svsPipelineLazy.reset();
}

function registerSvsIpc() {
  ipcMain.handle('svs:init', async () => {
    await svsPipelineLazy.get();
    return { success: true };
  });

  ipcMain.handle('svs:synthesize', async (event, { notes, bpm, options }) => {
    const pipeline = svsPipelineLazy.getInstance();
    if (!pipeline) {
      throw new Error(t('error.svsNotInitialized'));
    }
    return await pipeline.synthesize(notes, bpm, options);
  });

  ipcMain.handle('svs:dispose', async () => {
    resetSvsPipeline();
    return { success: true };
  });

  ipcMain.handle('fragment-svs:getSampleRate', async () => {
    return SAMPLE_RATE;
  });

  ipcMain.handle('fragment-svs:init', async () => {
    await svsPipelineLazy.get();
    return { success: true };
  });

  ipcMain.handle('fragment-svs:synthesize', async (event, { notes, bpm, options }) => {
    const pipeline = svsPipelineLazy.getInstance();
    if (!pipeline) {
      throw new Error(t('error.fragmentSvsNotInitialized'));
    }
    const win = event.sender;
    const opts = options || {};
    opts.onProgress = (progress) => {
      try {
        if (!win.isDestroyed()) {
          win.send('fragment-svs:progress', { progress });
        }
      } catch (_) {}
    };
    return await pipeline.synthesize(notes, bpm, opts);
  });

  ipcMain.handle('fragment-svs:dispose', async () => {
    return { success: true };
  });

  ipcMain.handle('fragment-svs:resolvePhonemes', async (event, { lyrics }) => {
    try {
      const pipeline = svsPipelineLazy.getInstance();
      if (!pipeline || !pipeline.initialized) {
        await svsPipelineLazy.get();
      }
      const p = svsPipelineLazy.getInstance();
      return lyrics.map(lyric => p.resolveLyricToPhonemes(lyric));
    } catch (err) {
      console.error('[Main] Phoneme resolution failed:', err);
      return lyrics.map(lyric => [{ name: lyric || '<SP>', display: lyric || 'SP' }]);
    }
  });
}

module.exports = {
  registerSvsIpc,
  getSvsPipeline,
  resetSvsPipeline,
  svsPipelineLazy,
};
