const { ipcMain } = require('electron');
const { OnnxSVSPipeline, SAMPLE_RATE } = require('../inference/pipeline');
const { loadSettings } = require('./settings');
const { getModelDir } = require('./modelDir');
const { checkJpModelsExist } = require('../modelManager');
const { t } = require('./locale');
const { createLazyInitializer } = require('./lazyInitializer');
const { getRmvpeDetector } = require('./pitchMidiIpc');

let currentLanguage = null; // Track current pipeline language

function _detectJapaneseNotes(notes) {
  if (!notes || !Array.isArray(notes)) return false;
  for (const note of notes) {
    const lyric = note.lyric || '';
    if (!lyric) continue;
    if (lyric.startsWith('jp_') || lyric.includes('jp_')) return true;
    if (/[ぁ-ゟァ-ヿ]/.test(lyric)) return true;
  }
  return false;
}

function _createPipeline(languageOverride) {
  const modelPath = getModelDir();
  const settings = loadSettings();
  const deviceMode = settings.deviceMode || 'smart';
  const deviceId = settings.preferredDeviceId ?? settings.deviceId ?? undefined;
  const preferredDeviceType = settings.preferredDeviceType || undefined;
  const modelDeviceMapping = settings.modelDeviceMapping || undefined;
  const modelPrecision = settings.modelPrecision || 'fp16';

  const langTag = languageOverride ? `, language=${languageOverride}` : '';
  console.log(`[Main] Initializing SVS Pipeline, model path: ${modelPath}, precision: ${modelPrecision}${langTag}`);

  const pipeline = new OnnxSVSPipeline(modelPath, {
    deviceId,
    deviceMode,
    preferredDeviceType,
    modelDeviceMapping,
    modelPrecision,
    languageOverride,
  });
  return pipeline;
}

const svsPipelineLazy = createLazyInitializer(async () => {
  const pipeline = _createPipeline(currentLanguage);
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
  currentLanguage = null;
}

/**
 * Ensure the pipeline is initialized with the correct language.
 * Uses incremental model swap when possible (only reloads note_text_encoder + preflow).
 */
async function ensurePipelineLanguage(language) {
  const pipeline = svsPipelineLazy.getInstance();

  if (pipeline && pipeline.initialized && language !== currentLanguage) {
    // Language changed — swap only the 2 language-specific models
    console.log(`[Main] Language ${currentLanguage || 'base'} → ${language || 'base'}, swapping models`);
    try {
      await pipeline.swapLanguageModels(language);
      currentLanguage = language;
      return pipeline;
    } catch (err) {
      if (err.message === 'JP_MODELS_MISSING') throw err;
      console.warn('[Main] Incremental swap failed, falling back to full re-init:', err.message);
      resetSvsPipeline();
    }
  }

  if (!pipeline || !pipeline.initialized) {
    currentLanguage = language;
    await svsPipelineLazy.get();
    return svsPipelineLazy.getInstance();
  }

  return pipeline;
}

/**
 * 构造一个 RMVPE 适配器，将 pipeline 期望的 (audioFloat, sampleRate) → Float32Array
 * 接口桥接到 RmvpePitchDetector.extractF0。仅在 autoShift + refAudio 路径下使用。
 * 失败时返回 null，让 pipeline 回退到自相关。
 */
function _makeRmvpeExtractor() {
  return async (audioFloat, sampleRate) => {
    try {
      const detector = getRmvpeDetector();
      if (!detector || !detector.initialized) return null;
      const result = await detector.extractF0(audioFloat, sampleRate);
      return result; // {time, f0, confidence}[] 或 Float32Array
    } catch (e) {
      console.warn('[Main] RMVPE F0 extraction failed in pipeline path:', e.message);
      return null;
    }
  };
}

function registerSvsIpc() {
  ipcMain.handle('svs:init', async () => {
    await svsPipelineLazy.get();
    return { success: true };
  });

  ipcMain.handle('svs:synthesize', async (event, { notes, bpm, options }) => {
    // Detect language
    const isJapanese = _detectJapaneseNotes(notes);
    const language = isJapanese ? 'ja' : null;

    // Check if JP models are needed but missing
    if (isJapanese) {
      const settings = loadSettings();
      const precision = settings.modelPrecision || 'fp16';
      const modelDir = getModelDir();
      if (!checkJpModelsExist(modelDir, precision)) {
        return { error: 'JP_MODELS_MISSING', message: '日语模型未下载。请在模型下载页面下载日语模型。' };
      }
    }

    try {
      const pipeline = await ensurePipelineLanguage(language);
      if (!pipeline) {
        throw new Error(t('error.svsNotInitialized'));
      }
      // 注入 RMVPE F0 提取器（仅在 autoShift + refAudio 路径下使用）
      const opts = options || {};
      if (opts.autoShift && opts.refAudioWavBuffer) {
        opts.refF0Extractor = _makeRmvpeExtractor();
      }
      return await pipeline.synthesize(notes, bpm, opts);
    } catch (err) {
      throw err;
    }
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
    // Detect language
    const isJapanese = _detectJapaneseNotes(notes);
    const language = isJapanese ? 'ja' : null;

    // Check if JP models are needed but missing
    if (isJapanese) {
      const settings = loadSettings();
      const precision = settings.modelPrecision || 'fp16';
      const modelDir = getModelDir();
      if (!checkJpModelsExist(modelDir, precision)) {
        return { error: 'JP_MODELS_MISSING', message: '日语模型未下载。请在模型下载页面下载日语模型。' };
      }
    }

    let pipeline;
    try {
      pipeline = await ensurePipelineLanguage(language);
    } catch (err) {
      return { error: err.message };
    }

    if (!pipeline) {
      return { error: t('error.fragmentSvsNotInitialized') };
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
    // 注入 RMVPE F0 提取器（仅在 autoShift + refAudio 路径下使用）
    if (opts.autoShift && opts.refAudioWavBuffer) {
      opts.refF0Extractor = _makeRmvpeExtractor();
    }
    try {
      const data = await pipeline.synthesize(notes, bpm, opts);
      return { data };
    } catch (err) {
      return { error: err.message };
    }
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

  ipcMain.handle('svs:checkJpModels', async () => {
    const settings = loadSettings();
    const precision = settings.modelPrecision || 'fp16';
    const modelDir = getModelDir();
    return checkJpModelsExist(modelDir, precision);
  });
}

module.exports = {
  registerSvsIpc,
  getSvsPipeline,
  resetSvsPipeline,
  svsPipelineLazy,
};
