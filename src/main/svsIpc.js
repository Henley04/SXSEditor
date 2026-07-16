const { ipcMain } = require('electron');
const { OnnxSVSPipeline, SAMPLE_RATE } = require('../inference/pipeline');
const { loadSettings } = require('./settings');
const { getModelDir } = require('./modelDir');
const { checkJpModelsExist } = require('../modelManager');
const { t } = require('./locale');
const { createLazyInitializer } = require('./lazyInitializer');
const { getRmvpeDetector } = require('./pitchMidiIpc');
const { detectJapaneseNotes: _detectJapaneseNotes, detectEnglishNotes: _detectEnglishNotes, resolveLanguage: _resolveLanguage } = require('./languageDetection');

let currentLanguage = null; // Track current pipeline language

// 合成级互斥锁：DML 后端下同一个 GPU 设备上的多个 InferenceSession 不支持并发 session.run()，
// 否则命令流交叉提交会导致 887A0005 (GPU device hung)。
// 此锁确保同一时刻只有一个合成请求在执行，防止 playAll/exportAll/fragment 合成并发。
let _synthMutex = Promise.resolve();
function _withSynthMutex(fn) {
  const prev = _synthMutex;
  let release;
  _synthMutex = new Promise((r) => { release = r; });
  return prev.then(fn).finally(release);
}

function _createPipeline(languageOverride) {
  const modelPath = getModelDir();
  const settings = loadSettings();
  const deviceMode = settings.deviceMode || 'smart';
  const deviceId = settings.preferredDeviceId ?? settings.deviceId ?? undefined;
  const preferredDeviceType = settings.preferredDeviceType || undefined;
  const modelDeviceMapping = settings.modelDeviceMapping || undefined;
  const modelPrecision = settings.modelPrecision || 'fp32';
  const inferenceProvider = settings.inferenceProvider || 'ortnode';
  const japaneseVocalization = settings.japaneseVocalization || 'en-phonemes';

  const langTag = languageOverride ? `, language=${languageOverride}` : '';
  console.log(`[Main] Initializing SVS Pipeline, model path: ${modelPath}, precision: ${modelPrecision}${langTag}, jpVocal=${japaneseVocalization}`);

  const pipeline = new OnnxSVSPipeline(modelPath, {
    deviceId,
    deviceMode,
    preferredDeviceType,
    modelDeviceMapping,
    modelPrecision,
    languageOverride,
    inferenceProvider,
    japaneseVocalization,
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
    console.log(`[Main] Language ${currentLanguage || 'base'} -> ${language || 'base'}, swapping models`);
    try {
      await pipeline.swapLanguageModels(language);
      currentLanguage = language;
      // 清除 NPU 失败缓存：新语言模型在 NPU 上的表现可能不同，允许重新检测
      try {
        const { clearNPUFailureCache } = require('./webnnIpc');
        clearNPUFailureCache();
      } catch (_) {}
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
    // Load japaneseVocalization setting: 'en-phonemes' (default) / 'hybrid' use English phonemes on base model;
    // 'jp-lora' uses JP LoRA models (in development)
    const settingsForLang = loadSettings();
    const japaneseVocalization = settingsForLang.japaneseVocalization || 'en-phonemes';

    // Detect language: en-phonemes / hybrid mode always uses base model (null); jp-lora mode uses original logic
    const language = _resolveLanguage(notes, japaneseVocalization);

    // Check if JP models are needed but missing (only in jp-lora mode)
    if (language === 'ja') {
      const settings = loadSettings();
      const precision = settings.modelPrecision || 'fp32';
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
      opts.language = language; // 用于缓存 key 区分（避免命中错误模型的结果）
      // 进度回调：推送 'svs:progress' 到主窗口，与 fragment-svs:progress 对齐。
      // 之前主页面合成无进度推送，导致推理预览百分比不显示。
      const win = event.sender;
      opts.onProgress = (progress) => {
        try {
          if (win && !win.isDestroyed()) {
            win.send('svs:progress', { progress });
          }
        } catch (_) {}
      };
      if (opts.autoShift && opts.refAudioWavBuffer) {
        opts.refF0Extractor = _makeRmvpeExtractor();
      }
      return await _withSynthMutex(() => pipeline.synthesize(notes, bpm, opts));
    } catch (err) {
      console.error('[Main] svs:synthesize failed:', err.message);
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
    // Load japaneseVocalization setting: 'en-phonemes' (default) / 'hybrid' use English phonemes on base model;
    // 'jp-lora' uses JP LoRA models (in development)
    const settingsForLang = loadSettings();
    const japaneseVocalization = settingsForLang.japaneseVocalization || 'en-phonemes';

    // Detect language: en-phonemes / hybrid mode always uses base model (null); jp-lora mode uses original logic
    const language = _resolveLanguage(notes, japaneseVocalization);

    // Check if JP models are needed but missing (only in jp-lora mode)
    if (language === 'ja') {
      const settings = loadSettings();
      const precision = settings.modelPrecision || 'fp32';
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
    opts.language = language; // 用于缓存 key 区分（避免命中错误模型的结果）
    opts.onProgress = (progress) => {
      try {
        if (!win.isDestroyed()) {
          win.send('fragment-svs:progress', { progress });
        }
      } catch (_) {}
    };
    // 流式 chunk 音频推送：vocoder 每完成一个 chunk 即推送到 fragment 窗口，实现边合成边播放
    opts.onChunkAudio = (chunkInfo) => {
      try {
        if (!win.isDestroyed()) {
          win.send('fragment-svs:chunk-audio', chunkInfo);
        }
      } catch (_) {}
    };
    // 注入 RMVPE F0 提取器（仅在 autoShift + refAudio 路径下使用）
    if (opts.autoShift && opts.refAudioWavBuffer) {
      opts.refF0Extractor = _makeRmvpeExtractor();
    }
    try {
      const data = await _withSynthMutex(() => pipeline.synthesize(notes, bpm, opts));
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
    const precision = settings.modelPrecision || 'fp32';
    const modelDir = getModelDir();
    return checkJpModelsExist(modelDir, precision);
  });
}

module.exports = {
  registerSvsIpc,
  getSvsPipeline,
  resetSvsPipeline,
  svsPipelineLazy,
  // 重新导出纯函数供测试（来自 languageDetection 模块）
  detectJapaneseNotes: _detectJapaneseNotes,
  detectEnglishNotes: _detectEnglishNotes,
  resolveLanguage: _resolveLanguage,
};
