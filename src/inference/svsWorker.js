const { parentPort, workerData } = require('node:worker_threads');

// float16 补丁由 ortRuntime.getOrt() 在加载 ORT 后统一施加（幂等），见 ortRuntime.js。

// Windows ML 快照注入：worker_threads 里 require('electron') 不可用（退化为
// 路径字符串），settings 模块与 dynwinrt/catalog 在 worker 内都不可靠。
// 主进程在 spawn 时经 workerData 显式下发开关与已就绪的 EP libraryPath 列表，
// 这里在任何 pipeline/winml 模块加载之前挂到 globalThis。
if (workerData && typeof workerData === 'object') {
    // 持久化缓存（dummy 校验 / WinML 探测）在 worker 内拿不到 electron.app，
    // 由主进程把 userData 目录显式下发。
    if (typeof workerData.userDataDir === 'string' && workerData.userDataDir) {
        globalThis.__SXS_USER_DATA_DIR__ = workerData.userDataDir;
    }
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
// cancel 可能在 synthesize 的 ensurePipeline() 之前到达（此时 controller 尚未
// 注册）。必须记住"预取消"的目标 id，否则这次取消会永久丢失。
const pendingCancelledIds = new Set();

function abortRequest(requestId) {
  if (requestId != null) {
    const c = activeControllers.get(requestId);
    if (c) { c.abort(); return true; }
    pendingCancelledIds.add(requestId);
    // 防止未知 id 无限累积：只保留最近 256 个待取消目标。
    if (pendingCancelledIds.size > 256) {
      const oldest = pendingCancelledIds.values().next().value;
      pendingCancelledIds.delete(oldest);
    }
    return false;
  }
  // 未提供有效 id 时回退到最近一次请求，保证取消总能命中活跃合成。
  const entries = Array.from(activeControllers.entries());
  if (entries.length === 0) return false;
  activeControllers.get(entries[entries.length - 1][0]).abort();
  return true;
}

/** 注册 controller 时兑现此前到达的取消。 */
function registerController(id, controller) {
  activeControllers.set(id, controller);
  if (pendingCancelledIds.delete(id)) controller.abort();
  return controller;
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
      try {
        // 下游统一按 Float32Array.length 使用；裸 ArrayBuffer 没有 length，
        // 必须在 worker 边界归一化，不能要求每个调用方兼容两种类型。
        const a = data && data.audio;
        let pcm = null;
        if (a instanceof Float32Array) pcm = a;
        else if (a instanceof ArrayBuffer && a.byteLength % 4 === 0) pcm = new Float32Array(a);
        else if (ArrayBuffer.isView(a) && !(a instanceof DataView)) {
          const out = new Float32Array(a.length);
          for (let i = 0; i < a.length; i++) out[i] = Number(a[i]) || 0;
          pcm = out;
        }
        if (!pcm) return;
        const message = {
          type: 'event',
          id,
          event: 'chunk-audio',
          data: { ...data, audio: pcm },
        };
        // 仅当视图独占 backing store 时移交，避免误伤共享缓冲池。
        // postMessage 失败不能反向打断整轮合成。
        const ab = pcm.buffer instanceof ArrayBuffer
          && pcm.byteOffset === 0 && pcm.byteLength === pcm.buffer.byteLength
          ? pcm.buffer : null;
        if (ab) parentPort.postMessage(message, [ab]);
        else parentPort.postMessage(message);
      } catch (err) {
        console.warn('[SVS worker] Failed to post chunk audio:', err && err.message);
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
      const controller = registerController(id, new AbortController());
      options.abortSignal = controller.signal;
      if (controller.signal.aborted) {
        activeControllers.delete(id);
        const err = new Error('Synthesis cancelled before start');
        err.code = 'SYNTHESIS_CANCELLED';
        throw err;
      }
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
      const controller = registerController(id, new AbortController());
      options.abortSignal = controller.signal;
      if (controller.signal.aborted) {
        activeControllers.delete(id);
        const err = new Error('Synthesis cancelled before start');
        err.code = 'SYNTHESIS_CANCELLED';
        throw err;
      }
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
