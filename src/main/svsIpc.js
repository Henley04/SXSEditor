const { ipcMain } = require('electron');
const { OnnxSVSPipeline, SAMPLE_RATE } = require('../inference/pipeline');
const { loadSettings } = require('./settings');
const { getModelDir } = require('./modelDir');
const { checkJpModelsExist } = require('../modelManager');
const { t } = require('./locale');
const { createLazyInitializer } = require('./lazyInitializer');
const { getRmvpeDetector, getBaseModelDir } = require('./pitchMidiIpc');
const { SvsWorkerClient } = require('./svsWorkerClient');
const { detectJapaneseNotes: _detectJapaneseNotes, detectEnglishNotes: _detectEnglishNotes, resolveLanguage: _resolveLanguage } = require('./languageDetection');

let currentLanguage = null; // Track current pipeline language

// diff_step 旧 int8 模型不兼容弹窗只提示一次（跨窗口去重：主窗口先 init 后，
// 分片窗口再 init 时不再重复弹窗）。
let _diffStepIncompatibleNotified = false;

// 合成级互斥锁：DML 后端下同一个 GPU 设备上的多个 InferenceSession 不支持并发 session.run()，
// 否则命令流交叉提交会导致 887A0005 (GPU device hung)。
// 此锁确保同一时刻只有一个合成请求在执行，防止 playAll/exportAll/fragment 合成并发。
let _synthMutex = Promise.resolve();
// 在飞合成计数：resetSvsPipeline 在合成进行中会 dispose 正在使用的 session，
// 导致 "Session already disposed" 崩溃；忙时改为延迟到空闲后执行。
let _synthBusy = 0;
let _pendingPipelineReset = false;
// 当前持有 mutex 的可取消管线引用：svs:cancel 在 lazy 实例尚未注册
// （pipeline 异步初始化窗口）或已被延迟重置清空时仍能命中正确的 worker。
let _activeCancellable = null;
function _withSynthMutex(fn, cancellable) {
  const prev = _synthMutex;
  let release;
  _synthBusy++;
  _synthMutex = new Promise((r) => { release = r; });
  const p = prev.then(async () => {
    if (cancellable) _activeCancellable = cancellable;
    try {
      return await fn();
    } finally {
      if (cancellable && _activeCancellable === cancellable) _activeCancellable = null;
    }
  }).finally(() => {
    _synthBusy--;
    if (_synthBusy === 0 && _pendingPipelineReset) {
      _pendingPipelineReset = false;
      console.log('[Main] Executing deferred pipeline reset (synthesis idle)');
      try { resetSvsPipeline(); } catch (_) {}
    }
    release();
  });
  return p;
}

async function _createPipeline(languageOverride) {
  const modelPath = getModelDir();
  const settings = loadSettings();
  const deviceMode = settings.deviceMode || 'smart';
  const deviceId = settings.preferredDeviceId ?? settings.deviceId ?? undefined;
  const preferredDeviceType = settings.preferredDeviceType || undefined;
  const modelDeviceMapping = settings.modelDeviceMapping || undefined;
  const modelPrecision = settings.modelPrecision || 'fp32';
  const inferenceProvider = settings.inferenceProvider || 'ortnode';
  const japaneseVocalization = settings.japaneseVocalization || 'hybrid';
  console.log(`[Main] Pipeline settings: winmlEnabled=${settings.winmlEnabled === true} deviceMode=${deviceMode} inferenceProvider=${inferenceProvider}`);

  const langTag = languageOverride ? `, language=${languageOverride}` : '';
  console.log(`[Main] Initializing SVS Pipeline, model path: ${modelPath}, precision: ${modelPrecision}${langTag}, jpVocal=${japaneseVocalization}`);

  const pipelineOptions = {
    deviceId,
    deviceMode,
    preferredDeviceType,
    modelDeviceMapping,
    modelPrecision,
    languageOverride,
    inferenceProvider,
    japaneseVocalization,
  };

  // WebNN contexts exist only in Chromium renderer processes. A Node
  // worker_threads worker cannot access navigator.ml and must not own a
  // pipeline that may select NPU/WebNN-GPU. Keep pure ORT Node CPU/DML in the
  // worker, but retain WebNN-capable smart/explicit configurations in-process
  // so the existing main -> renderer WebNN bridge remains reachable.
  const explicitWebNN = deviceId === 'npu' || deviceId === 'webnn-gpu'
    || preferredDeviceType === 'npu' || preferredDeviceType === 'webnn-gpu';
  let webnnAvailable = explicitWebNN;
  if (!explicitWebNN && deviceMode === 'smart') {
    try {
      const { detectNPUAvailability } = require('./webnnIpc');
      const detected = await detectNPUAvailability();
      webnnAvailable = !!(detected.npuAvailable || detected.gpuAvailable);
    } catch (err) {
      console.warn('[Main] WebNN preflight failed; using ORT Node worker:', err.message);
    }
  }
  const keepRendererBridge = inferenceProvider === 'ortweb' || explicitWebNN || webnnAvailable;
  // Windows ML 开启时强制 worker 路径（inferenceProvider=ortnode 场景）：
  // WinML vendor-EP 由主进程解析 libraryPath 后经 workerData 注入，
  // 该链路已端到端验证；in-process 分支的 bundled catalog 存在未定差异。
  const winmlWorkerMode = settings.winmlEnabled === true && inferenceProvider === 'ortnode';
  if (!keepRendererBridge || winmlWorkerMode) {
    // WinML vendor-EP 开关注入：worker_threads 里 require('electron') 不可用
    // （退化为路径字符串），worker 内的 settings 模块与 dynwinrt/catalog 均
    // 不可靠。因此由主进程在此解析就绪的 EP libraryPath，经 workerData 下发；
    // svsWorker 启动时挂到 globalThis，winmlProvider 直接 registerEp。
    let winmlEps;
    let winmlEnabled = false;
    if (settings.winmlEnabled === true) {
      try {
        winmlEps = await require('../inference/winml/winmlProvider').getReadyEpLibraries();
        winmlEnabled = true;
        console.log(`[Main] WinML enabled: resolved ${winmlEps ? winmlEps.length : 0} ready EP(s)${winmlEps && winmlEps.length ? ' -> ' + winmlEps.map((e) => e.name).join(', ') : ''}`);
      } catch (err) {
        console.warn('[Main] WinML EP resolution failed; worker will use DML/CPU:', err.message);
        winmlEps = [];
      }
    }
    return new SvsWorkerClient({
      modelDir: modelPath,
      baseModelDir: getBaseModelDir(),
      pipelineOptions,
      language: languageOverride,
      winmlEnabled,
      ...(winmlEps ? { winmlEps } : {}),
      ...(settings.winmlBootstrapDllPath ? { winmlBootstrapDllPath: settings.winmlBootstrapDllPath } : {}),
      settingsSnapshot: settings,
    });
  }
  return new OnnxSVSPipeline(modelPath, pipelineOptions);
}

const svsPipelineLazy = createLazyInitializer(async () => {
  const pipeline = await _createPipeline(currentLanguage);
  await pipeline.init();
  return pipeline;
});

function getSvsPipeline() {
  return svsPipelineLazy.getInstance();
}

function resetSvsPipeline() {
  // 合成进行中立即 dispose 会杀掉在用的 session（"Session already disposed"），
  // 推迟到 _withSynthMutex 的空闲钩子执行。
  if (_synthBusy > 0) {
    if (!_pendingPipelineReset) {
      console.log('[Main] Synthesis in progress; deferring pipeline reset until idle');
    }
    _pendingPipelineReset = true;
    return;
  }
  const inst = svsPipelineLazy.getInstance();
  if (inst) {
    try { Promise.resolve(inst.dispose()).catch(() => {}); } catch (_) {}
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
  // 当 int8 目录下检测到旧版 diff_step 模型（cond≠1024）时，向触发初始化的窗口推送提示事件。
  // 由渲染进程用自身 i18n 渲染弹窗文案（主/渲染进程双语字典各自维护）。
  // 仅首次触发初始化的窗口收到事件（_diffStepIncompatibleNotified 全局去重）。
  function notifyDiffStepIncompatible(win) {
    if (_diffStepIncompatibleNotified) return;
    _diffStepIncompatibleNotified = true;
    try {
      if (win && !win.isDestroyed()) {
        win.send('svs:model-incompatible');
      }
    } catch (_) {}
  }

  function getDiffStepIncompatible() {
    const pipeline = svsPipelineLazy.getInstance();
    return !!(pipeline && pipeline.diffStepLegacyInt8Incompatible === true);
  }

  ipcMain.handle('svs:init', async (event) => {
    await svsPipelineLazy.get();
    const incompatible = getDiffStepIncompatible();
    if (incompatible) notifyDiffStepIncompatible(event.sender);
    return { success: true, diffStepLegacyInt8Incompatible: incompatible };
  });

  ipcMain.handle('svs:synthesize', async (event, { notes, bpm, options }) => {
    // Load japaneseVocalization setting: 'hybrid' (default) / 'en-phonemes' use English phonemes on base model;
    // 'jp-lora' uses JP LoRA models (in development)
    const settingsForLang = loadSettings();
    const japaneseVocalization = settingsForLang.japaneseVocalization || 'hybrid';

    // Detect language: en-phonemes / hybrid mode always uses base model (null); jp-lora mode uses original logic
    const language = _resolveLanguage(notes, japaneseVocalization);

    // Check if JP models are needed but missing (only in jp-lora mode)
    if (language === 'ja') {
      const settings = loadSettings();
      const precision = settings.modelPrecision || 'fp32';
      const modelDir = getModelDir();
      if (!checkJpModelsExist(modelDir, precision)) {
        // W19: use i18n key instead of hardcoded Chinese error message.
        return { error: 'JP_MODELS_MISSING', message: t('error.jpModelNotDownloaded') };
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
      let lastProgressSentAt = 0;
      let lastProgressValue = -1;
      opts.onProgress = (progress) => {
        const now = Date.now();
        if (progress < 100 && now - lastProgressSentAt < 100 && Math.abs(progress - lastProgressValue) < 2) return;
        lastProgressSentAt = now;
        lastProgressValue = progress;
        try {
          if (win && !win.isDestroyed()) win.send('svs:progress', { progress });
        } catch (_) {}
      };
      if (opts.autoShift && opts.refAudioWavBuffer) {
        opts.refF0Extractor = _makeRmvpeExtractor();
      }
      return await _withSynthMutex(() => pipeline.synthesize(notes, bpm, opts), pipeline);
    } catch (err) {
      console.error('[Main] svs:synthesize failed:', err.message);
      throw err;
    }
  });

  // 多分片时间交错流式合成（主页面 Play All 启用分块时使用）
  // 接收所有分片，按时间顺序交错推理各分片的 diffusion chunk，边推理边推送音频
  ipcMain.handle('svs:synthesizeMultiStreaming', async (event, { fragments, bpm }) => {
    const settingsForLang = loadSettings();
    const japaneseVocalization = settingsForLang.japaneseVocalization || 'hybrid';

    // 确定第一个分片的语言用于 pipeline 初始化（假设所有分片同语言）
    const firstNotes = fragments && fragments.length > 0 ? fragments[0].notes : [];
    const language = _resolveLanguage(firstNotes, japaneseVocalization);

    if (language === 'ja') {
      const settings = loadSettings();
      const precision = settings.modelPrecision || 'fp32';
      const modelDir = getModelDir();
      if (!checkJpModelsExist(modelDir, precision)) {
        // W19: use i18n key instead of hardcoded Chinese error message.
        return { error: 'JP_MODELS_MISSING', message: t('error.jpModelNotDownloaded') };
      }
    }

    try {
      const pipeline = await ensurePipelineLanguage(language);
      if (!pipeline) {
        throw new Error(t('error.svsNotInitialized'));
      }
      const win = event.sender;
      const opts = {
        onProgress: (progress) => {
          try {
            if (win && !win.isDestroyed()) {
              win.send('svs:progress', { progress });
            }
          } catch (_) {}
        },
        onChunkAudio: (chunkInfo) => {
          try {
            if (win && !win.isDestroyed()) {
              win.send('svs:chunk-audio', chunkInfo);
            }
          } catch (_) {}
        },
      };
      // 注入 RMVPE F0 提取器（所有匹配的 fragment 都需要注入，
      // 否则后续 fragment 在 pipeline 中回退到自相关 F0，导致 autoShift 值不一致）
      for (const frag of fragments) {
        if (frag.options && frag.options.autoShift && frag.options.refAudioWavBuffer) {
          frag.options.refF0Extractor = _makeRmvpeExtractor();
        }
      }
      return await _withSynthMutex(() => pipeline.synthesizeMultiStreaming(fragments, bpm, opts), pipeline);
    } catch (err) {
      console.error('[Main] svs:synthesizeMultiStreaming failed:', err.message);
      throw err;
    }
  });

  ipcMain.handle('svs:cancel', async () => {
    // 优先命中当前持有 mutex 的实例（覆盖 lazy 实例尚未注册的初始化窗口，
    // 以及延迟重置清空 getInstance() 后仍在收尾的场景）。
    const target = _activeCancellable || svsPipelineLazy.getInstance();
    console.log(`[Main] svs:cancel active=${!!_activeCancellable} lazyInstance=${!!svsPipelineLazy.getInstance()} busy=${_synthBusy}`);
    if (target && typeof target.cancelActiveSynthesis === 'function') {
      // 协作式取消：只通知 worker 在安全点退出推理，worker 线程保持存活。
      // 不再调用 svsPipelineLazy.reset()（旧逻辑会在 terminate 后重建 worker），
      // 否则会 dispose()→terminate() 打断尚未安全退出的推理，重新引入 GPU 崩溃。
      await target.cancelActiveSynthesis();
      return { success: true };
    }
    // 没有可取消对象且不在合成中：保持旧行为（清理残留状态）。
    if (_synthBusy === 0) {
      resetSvsPipeline();
    }
    return { success: true };
  });

  ipcMain.handle('svs:dispose', async () => {
    resetSvsPipeline();
    return { success: true };
  });

  ipcMain.handle('fragment-svs:getSampleRate', async () => {
    return SAMPLE_RATE;
  });

  ipcMain.handle('fragment-svs:init', async (event) => {
    await svsPipelineLazy.get();
    const incompatible = getDiffStepIncompatible();
    if (incompatible) notifyDiffStepIncompatible(event.sender);
    return { success: true, diffStepLegacyInt8Incompatible: incompatible };
  });

  ipcMain.handle('fragment-svs:synthesize', async (event, { notes, bpm, options }) => {
    // Load japaneseVocalization setting: 'hybrid' (default) / 'en-phonemes' use English phonemes on base model;
    // 'jp-lora' uses JP LoRA models (in development)
    const settingsForLang = loadSettings();
    const japaneseVocalization = settingsForLang.japaneseVocalization || 'hybrid';

    // Detect language: en-phonemes / hybrid mode always uses base model (null); jp-lora mode uses original logic
    const language = _resolveLanguage(notes, japaneseVocalization);

    // Check if JP models are needed but missing (only in jp-lora mode)
    if (language === 'ja') {
      const settings = loadSettings();
      const precision = settings.modelPrecision || 'fp32';
      const modelDir = getModelDir();
      if (!checkJpModelsExist(modelDir, precision)) {
        // W19: use i18n key instead of hardcoded Chinese error message.
        return { error: 'JP_MODELS_MISSING', message: t('error.jpModelNotDownloaded') };
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
      const data = await _withSynthMutex(() => pipeline.synthesize(notes, bpm, opts), pipeline);
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
      if (typeof p.resolvePhonemes === 'function') {
        return await p.resolvePhonemes(lyrics, currentLanguage);
      }
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
