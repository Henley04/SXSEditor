const { parentPort, workerData } = require('node:worker_threads');

try { require('./pipeline/float16Patch'); } catch (_) {}

// Windows ML 快照注入：worker_threads 里 require('electron') 不可用（退化为
// 路径字符串），settings 模块与 dynwinrt/catalog 在 worker 内都不可靠。
// 主进程在 spawn 时经 workerData 显式下发开关与已就绪的 EP libraryPath 列表，
// 这里在任何 pipeline/winml 模块加载之前挂到 globalThis。
if (workerData && typeof workerData === 'object') {
    const snapshot = {
        ...(workerData.settingsSnapshot || {}),
        ...(typeof workerData.winmlEnabled === 'boolean' ? { winmlEnabled: workerData.winmlEnabled } : {}),
        ...(workerData.winmlBootstrapDllPath ? { winmlBootstrapDllPath: workerData.winmlBootstrapDllPath } : {}),
    };
    if (Object.keys(snapshot).length > 0) {
        globalThis.__SXS_SETTINGS_SNAPSHOT__ = snapshot;
    }
    if (Array.isArray(workerData.winmlEps)) {
        globalThis.__SXS_WINML_EPS__ = workerData.winmlEps;
    }
    if (typeof workerData.npuAvailable === 'boolean') {
        globalThis.__SXS_NPU_AVAILABLE__ = workerData.npuAvailable;
    }
    if (typeof workerData.openvinoNpuSafe === 'boolean') {
        globalThis.__SXS_OPENVINO_NPU_SAFE__ = workerData.openvinoNpuSafe;
    }
}

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
    opts.onChunkAudio = data => {
      const message = { type: 'event', id, event: 'chunk-audio', data };
      // 零拷贝传输 chunk 音频：pipeline 所有发出点（postprocessing 的
      // output.slice()、index.js 的 chunk.audio.slice()/cached 分支）给出的
      // 都是独立副本，回调返回后不再复用，可直接移交 ArrayBuffer，省去每个
      // 流式 chunk 的结构化克隆（整条链路原共 3 次拷贝）。
      // 仅当视图独占整个 backing store 时才移交，避免误伤共享缓冲池。
      const a = data && data.audio;
      const ab = a instanceof ArrayBuffer ? a
        : (ArrayBuffer.isView(a) && a.buffer instanceof ArrayBuffer
          && a.byteOffset === 0 && a.byteLength === a.buffer.byteLength
          ? a.buffer : null);
      if (ab) {
        parentPort.postMessage(message, [ab]);
      } else {
        parentPort.postMessage(message);
      }
    };
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

// 合成请求世代号：合成类命令入队时记录序号，轮到它执行时若已不是最新世代，
// 直接跳过——快速多次触发时，排队中的陈旧请求不再完整占用一次 GPU 推理。
// cancel 只能 abort 已开始（已有 AbortController）的请求，救不了纯排队请求。
let latestSynthSeq = 0;

parentPort.on('message', msg => {
  // 协作式取消：cancel 必须绕过串行合成队列立即执行，否则它会排在
  // 正在运行的合成之后，永远无法中断当前推理。
  if (msg.command === 'cancel') {
    abortRequest(msg.args?.requestId);
    parentPort.postMessage({ type: 'result', id: msg.id, result: { success: true }, state: snapshot() });
    return;
  }
  const isSynthCommand = msg.command === 'synthesize'
    || msg.command === 'synthesizeMultiStreaming';
  const synthSeq = isSynthCommand ? ++latestSynthSeq : 0;
  queue = queue.then(async () => {
    // 排队期间已有更新的合成请求入队：本请求已过期，跳过 GPU 执行。
    if (isSynthCommand && synthSeq !== latestSynthSeq) {
      parentPort.postMessage({
        type: 'error',
        id: msg.id,
        error: { message: 'Synthesis superseded by a newer request', code: 'SVS_SUPERSEDED' },
        state: snapshot(),
      });
      return;
    }
    try {
      const result = await handle(msg);
      parentPort.postMessage({ type: 'result', id: msg.id, result, state: snapshot() });
    } catch (err) {
      parentPort.postMessage({ type: 'error', id: msg.id, error: serializeError(err), state: snapshot() });
    }
  });
});

parentPort.postMessage({ type: 'ready' });
