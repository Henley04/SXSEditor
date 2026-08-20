const { parentPort, workerData } = require('node:worker_threads');

try { require('./pipeline/float16Patch'); } catch (_) {}

const { OnnxSVSPipeline } = require('./pipeline');
const { RmvpePitchDetector } = require('./rmvpePitchDetector');

let pipeline = null;
let rmvpe = null;
let currentLanguage = workerData.language || null;
let queue = Promise.resolve();
// 协作式取消：记录每个合成请求对应的 AbortController，取消时 abort 而非杀线程。
// 合成结束（成功/失败）都会删除自身 id，避免 Map 累积泄漏。
const activeControllers = new Map();

function abortRequest(requestId) {
  if (requestId != null) {
    const c = activeControllers.get(requestId);
    if (c) { c.abort(); return true; }
  }
  // 未提供有效 id 时回退到最近一次请求，保证取消总能命中活跃合成。
  const entries = Array.from(activeControllers.entries());
  if (entries.length === 0) return false;
  activeControllers.get(entries[entries.length - 1][0]).abort();
  return true;
}

function serializeError(err) {
  return { message: err?.message || String(err), code: err?.code, stack: err?.stack };
}

function snapshot() {
  return {
    initialized: !!pipeline?.initialized,
    sessionEPs: pipeline?.sessionEPs || {},
    hardwareInfo: pipeline?.initialized && typeof pipeline.getHardwareInfo === 'function'
      ? pipeline.getHardwareInfo() : null,
    loadedModels: pipeline?.sessions ? Object.keys(pipeline.sessions) : [],
    // diff_step 模型签名标志：QDIT 新模型 / int8 旧模型不兼容
    diffStepIsQDIT: !!pipeline?.diffStepIsQDIT,
    diffStepLegacyInt8Incompatible: !!pipeline?.diffStepLegacyInt8Incompatible,
  };
}

async function ensurePipeline(language = currentLanguage) {
  if (!pipeline) {
    pipeline = new OnnxSVSPipeline(workerData.modelDir, {
      ...workerData.pipelineOptions,
      languageOverride: language,
    });
    await pipeline.init();
    currentLanguage = language;
  } else if (pipeline.initialized && language !== currentLanguage) {
    await pipeline.swapLanguageModels(language);
    currentLanguage = language;
  }
  return pipeline;
}

async function getRefF0Extractor() {
  return async (audioFloat, sampleRate) => {
    try {
      if (!rmvpe) {
        rmvpe = new RmvpePitchDetector(workerData.baseModelDir || workerData.modelDir, {
          deviceId: workerData.pipelineOptions?.deviceId,
        });
        await rmvpe.init();
      }
      return await rmvpe.extractF0(audioFloat, sampleRate);
    } catch (err) {
      console.warn('[SVS worker] RMVPE reference F0 failed:', err.message);
      return null;
    }
  };
}

function attachCallbacks(id, options = {}) {
  const opts = { ...options };
  if (options.__progress) {
    opts.onProgress = progress => parentPort.postMessage({ type: 'event', id, event: 'progress', data: progress });
  }
  if (options.__chunkAudio) {
    opts.onChunkAudio = data => parentPort.postMessage({ type: 'event', id, event: 'chunk-audio', data });
  }
  delete opts.__progress;
  delete opts.__chunkAudio;
  return opts;
}

async function handle(msg) {
  const { id, command, args = {} } = msg;
  switch (command) {
    case 'init':
      await ensurePipeline(args.language);
      return { success: true };
    case 'synthesize': {
      const p = await ensurePipeline(args.language);
      const options = attachCallbacks(id, args.options);
      const controller = new AbortController();
      activeControllers.set(id, controller);
      options.abortSignal = controller.signal;
      try {
        if (options.autoShift && options.refAudioWavBuffer) options.refF0Extractor = await getRefF0Extractor();
        return await p.synthesize(args.notes, args.bpm, options);
      } finally {
        activeControllers.delete(id);
      }
    }
    case 'synthesizeMultiStreaming': {
      const p = await ensurePipeline(args.language);
      const options = attachCallbacks(id, args.options);
      const controller = new AbortController();
      activeControllers.set(id, controller);
      options.abortSignal = controller.signal;
      try {
        for (const fragment of args.fragments || []) {
          if (fragment.options?.autoShift && fragment.options?.refAudioWavBuffer) {
            fragment.options = { ...fragment.options, refF0Extractor: await getRefF0Extractor() };
          }
        }
        return await p.synthesizeMultiStreaming(args.fragments, args.bpm, options);
      } finally {
        activeControllers.delete(id);
      }
    }
    case 'cancel': {
      abortRequest(args.requestId);
      return { success: true };
    }
    case 'resolvePhonemes': {
      const p = await ensurePipeline(args.language);
      return args.lyrics.map(lyric => p.resolveLyricToPhonemes(lyric));
    }
    case 'swapLanguageModels': {
      const p = await ensurePipeline(currentLanguage);
      await p.swapLanguageModels(args.language);
      currentLanguage = args.language;
      return true;
    }
    case 'swapVocoder': return (await ensurePipeline()).swapVocoder(args.value);
    case 'swapSifiganPrecision': return (await ensurePipeline()).swapSifiganPrecision(args.value);
    case 'loadModel': return (await ensurePipeline()).loadModel(args.key);
    case 'unloadModel': return (await ensurePipeline()).unloadModel(args.key);
    case 'ensureAllModelsLoaded': return (await ensurePipeline()).ensureAllModelsLoaded();
    case 'clearSynthCache': return pipeline?.clearSynthCache?.();
    case 'status': return snapshot();
    case 'dispose':
      try { pipeline?.dispose(); } catch (_) {}
      try { rmvpe?.dispose(); } catch (_) {}
      pipeline = null;
      rmvpe = null;
      return { success: true };
    default: throw new Error(`Unknown SVS worker command: ${command}`);
  }
}

parentPort.on('message', msg => {
  // 协作式取消：cancel 必须绕过串行合成队列立即执行，否则它会排在
  // 正在运行的合成之后，永远无法中断当前推理。
  if (msg.command === 'cancel') {
    abortRequest(msg.args?.requestId);
    parentPort.postMessage({ type: 'result', id: msg.id, result: { success: true }, state: snapshot() });
    return;
  }
  queue = queue.then(async () => {
    try {
      const result = await handle(msg);
      parentPort.postMessage({ type: 'result', id: msg.id, result, state: snapshot() });
    } catch (err) {
      parentPort.postMessage({ type: 'error', id: msg.id, error: serializeError(err), state: snapshot() });
    }
  });
});

parentPort.postMessage({ type: 'ready' });
