// 推理管线的 require 从模块顶层下沉。
//
// 冷启动审查：pipeline/index.js 是 5118 行且连带 diffusion / preprocessing /
// postprocessing 等一整棵子树，require 它要解析并编译数万行 JS。此前它在
// svsIpc.js 第 1 行，而 svsIpc 在启动的 STEP 4 被同步 require —— 于是这份解析
// 成本落在主窗口显示之前。ORT native addon 本身已由 ortRuntime 惰性化，
// 这里再把 JS 解析也推迟到首次真正要建管线（或首次查询采样率）时。
//
// SAMPLE_RATE 是纯常量，但它在同一模块里，只能一起惰性化；下面的
// getSampleRate() 在拿值时触发加载，调用点语义不变（这些 handler 都在
// 用户交互后才跑）。
let _pipelineModule = null;
function getPipelineModule() {
  if (!_pipelineModule) _pipelineModule = require('../inference/pipeline');
  return _pipelineModule;
}
function getSampleRate() { return getPipelineModule().getSampleRate(); }
const { loadSettings } = require('./settings');
const { getModelDir } = require('./modelDir');
const { checkJpModelsExist } = require('../modelManager');
const { t } = require('./locale');
const { createLazyInitializer } = require('./lazyInitializer');

// 模型加载进度的目标窗口集合。
//
// 用集合而不是单个 sender：SVS_INIT 与 FRAGMENT_SVS_INIT 共享同一个
// svsPipelineLazy promise，两个窗口可能同时等待同一次初始化。单槽写法会让
// 后进入者覆盖前者、且先退出者的 finally 把槽位清空后又被后退出者写回旧值，
// 结果是"只有一个窗口能收到进度"外加一个残留的幽灵 sender。
const _loadProgressSenders = new Set();
const { getRmvpeDetector, getBaseModelDir } = require('./pitchMidiIpc');
const { SvsWorkerClient } = require('./svsWorkerClient');
const { detectJapaneseNotes: _detectJapaneseNotes, detectEnglishNotes: _detectEnglishNotes, resolveLanguage: _resolveLanguage } = require('./languageDetection');
const { safeHandle } = require('./ipcSafe');
// 插件宿主：registerPluginIpc 由 registerSvsIpc() 在末尾调用（main.js 暂不可改）；
// runPluginBackend 是三个 synthesize handler 的参数透传入口。
const { runPluginBackend, registerPluginIpc } = require('./pluginIpc');
const { IPC_CHANNELS } = require('../shared/ipcChannels');

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
      // 只有 WebNN 路径下真正可用的 NPU/GPU 才值得保留渲染进程推理桥接。
      webnnAvailable = !!(detected.webnnNpuAvailable || detected.gpuAvailable);
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
      // 主进程硬件检测结果（WebNN + PnP 回退），供 worker 内 winmlProvider 使用
      npuAvailable: globalThis.__SXS_NPU_AVAILABLE__ === true,
      openvinoNpuSafe: globalThis.__SXS_OPENVINO_NPU_SAFE__ === true,
      ...(winmlEps ? { winmlEps } : {}),
      ...(settings.winmlBootstrapDllPath ? { winmlBootstrapDllPath: settings.winmlBootstrapDllPath } : {}),
      settingsSnapshot: settings,
    });
  }
  // 模型加载进度：factory 在首次 init 时才跑，而 IPC handler 才知道发给哪个
  // webContents，所以这里把 sender 做成模块级可替换的（handler 进/出时设/清）。
  // 未设置时为 no-op，不影响 CLI。
  return new (getPipelineModule().OnnxSVSPipeline)(modelPath, {
    ...pipelineOptions,
    onLoadProgress: (p) => { for (const fn of _loadProgressSenders) fn(p); },
  });
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

/**
 * 判断某次合成请求是否走插件后端。
 *
 * 判定依据（渲染进程在 options 里声明）：
 *   options.backend = { type: 'plugin', pluginId, kindId?, params?, voiceId? }
 *
 * 注意：不做克隆、不做字段挑选 —— 下面把**同一个 options 对象引用**交给插件，
 * 这样 svsIpc 注入的 language / onProgress / refF0Extractor 与渲染进程传来的
 * refAudioWavBuffer / pitchCurveF0 / refF0Data（Float32Array）都会完整到达插件。
 *
 * @param {object} options
 * @returns {object|null} 插件后端描述，走内置 pipeline 时返回 null
 */
function _resolvePluginBackend(options) {
  const backend = options && options.backend;
  if (!backend || typeof backend !== 'object') return null;
  if (backend.type !== 'plugin') return null;
  return backend;
}

/** 分组 key：内置管线。 */
const BUILTIN_GROUP_KEY = '__builtin__';

/**
 * 按“分片自己声明的后端”计算分组 key。
 *
 *   内置管线 → '__builtin__'
 *   插件     → 'plugin:<pluginId>/<kindId>'（kindId 缺失时按 '-' 参与，
 *              因此同一插件的不同音色不会误并到同一组）
 *
 * 只要求 backend.type === 'plugin' 即可成组：pluginId 缺失/非法属于
 * “声明了插件后端却指向不存在的插件”，由 runPluginBackend().validateBackend()
 * 给出明确错误，而不是静默退回内置管线（旧实现正是静默退回）。
 * @param {object} frag
 * @returns {string}
 */
function _backendKeyOf(frag) {
  const backend = _resolvePluginBackend(frag && frag.options);
  if (!backend) return BUILTIN_GROUP_KEY;
  return `plugin:${backend.pluginId || '(missing-id)'}/${backend.kindId || '-'}`;
}

/**
 * 把一批分片按各自声明的后端分组（保持首次出现顺序）。
 *
 * 这是 P1-4 的根治点：旧实现用 fragments[0] 的后端决定**整批**走向，因此
 * “插件轨 + 内置轨混排”的工程要么把内置分片整批塞给插件（静默产出错误结果），
 * 要么被全等校验直接硬报错。分组之后每个分片只走自己那条路。
 *
 * @param {Array} fragments
 * @returns {Array<{key:string, backend:object|null, fragments:object[]}>}
 */
function _groupFragmentsByBackend(fragments) {
  const map = new Map();
  for (const frag of fragments || []) {
    const key = _backendKeyOf(frag);
    const group = map.get(key);
    if (group) {
      group.fragments.push(frag);
    } else {
      map.set(key, { key, backend: _resolvePluginBackend(frag && frag.options), fragments: [frag] });
    }
  }
  return Array.from(map.values());
}

/**
 * 把某一组（占 0-100 中的 [startPercent, endPercent] 区间）的进度换算回全局百分比。
 *
 * 分组渲染后每组内部都会报 0→100，直接透传会让 UI 进度条反复跳回 0，
 * 这里按分片段数占比线性缩放到全局区间。只有一组时区间就是 0-100，原样返回
 * 同一个 opts 引用（保持既有行为的字节级一致）。
 */
function _scopeProgress(opts, startPercent, endPercent) {
  if (startPercent <= 0 && endPercent >= 100) return opts;
  const onProgress = opts && opts.onProgress;
  const span = Math.max(0, endPercent - startPercent);
  return {
    ...opts,
    onProgress: (progress) => {
      if (typeof onProgress !== 'function') return;
      const clamped = Math.max(0, Math.min(100, Number(progress) || 0));
      onProgress(Math.round(startPercent + (clamped / 100) * span));
    },
  };
}

// 插件组混音缓冲的时长上限（秒）。startTimeBeat / bpm 都来自渲染进程，损坏或
// 恶意的工程数据可以把 offset 放大到任意值，而下面会按它一次性 new Float32Array，
// 没有上界就等于把 OOM 的开关交给了渲染进程。30 分钟 @ 24kHz ≈ 1.7e8 采样
// （约 170 MB），足以覆盖任何真实工程；超出的按错误处理而不是硬撑。
const MAX_PLUGIN_MIX_SECONDS = 30 * 60;

/**
 * 单组插件分片：逐分片调用插件，再按 startTimeBeat 混合成一条单声道，
 * 与内置 synthesizeMultiStreaming 的返回形态（Float32Array，beat 0 起算）保持一致。
 *
 * 组内后端一致由 _groupFragmentsByBackend 保证，因此无需再逐个比对
 * （旧实现在这里做全等校验并在不一致时报“无法混合”——那正是本次要消除的
 * “混排即失败”行为）。真正不可解的混排现在会按各自的后端分别渲染。
 * @param {object} args
 * @returns {Promise<{ok:boolean, audio?:Float32Array, error?:string}>}
 */
async function _runPluginGroup({ group, bpm, sender, sampleRate }) {
  const sr = Number.isFinite(sampleRate) ? sampleRate : getSampleRate();
  const maxSamples = Math.floor(MAX_PLUGIN_MIX_SECONDS * sr);
  // bpm 同样来自渲染进程：非正数 / 非有限值时退回 120（与旧实现的 `bpm || 120`
  // 一致），但极小值（如 1e-9）会把 offset 放大几个数量级，交给下面的上限兜住。
  const effectiveBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const parts = [];
  let totalSamples = 0;

  for (let i = 0; i < group.fragments.length; i++) {
    const frag = group.fragments[i];
    // ★ 传 frag.options 本身：分片级完整 options（含该分片的 pitchCurveF0 等）
    const result = await runPluginBackend({
      backend: group.backend,
      notes: frag.notes,
      bpm,
      options: frag.options,
      sender,
      sampleRate: sr,
      trackId: frag.trackId || frag.id || null,
    });
    if (!result || !result.ok) {
      // 带上分片位置与 trackId：混排工程里“哪个插件挂了”必须一眼可见
      const reason = result && result.error ? result.error : '插件合成失败';
      const track = frag.trackId || frag.id || `#${i + 1}`;
      return { ok: false, error: `分片 ${i + 1}/${group.fragments.length}（trackId=${track}）合成失败：${reason}` };
    }

    // startTimeBeat 必须是有限的非负数：NaN/Infinity 会让 offset 变成 NaN
    // （Math.max(0, NaN) 仍是 NaN，随后的下标写全是 undefined）或天文数字。
    const startBeat = Number(frag.startTimeBeat);
    if (!Number.isFinite(startBeat) || startBeat < 0) {
      return { ok: false, error: `分片 ${i + 1}/${group.fragments.length}（trackId=${frag.trackId || frag.id || `#${i + 1}`}）的 startTimeBeat 非法：${frag.startTimeBeat}` };
    }
    const offset = Math.max(0, Math.round(((startBeat / effectiveBpm) * 60) * sr));
    const endSample = offset + result.audio.length;
    if (!Number.isFinite(endSample) || endSample > maxSamples) {
      return {
        ok: false,
        error: `分片 ${i + 1}/${group.fragments.length}（trackId=${frag.trackId || frag.id || `#${i + 1}`}）的混音长度 ${endSample} 采样`
          + ` 超出上限（${MAX_PLUGIN_MIX_SECONDS} 秒 @ ${sr} Hz = ${maxSamples} 采样）：请检查工程的 startTimeBeat / BPM`,
      };
    }
    parts.push({ audio: result.audio, offset });
    totalSamples = Math.max(totalSamples, endSample);
  }

  // 只有最后一次分配（混音缓冲），分片音频是插件直接产出的，不再逐样本拷贝中间态
  const mixed = new Float32Array(totalSamples);
  for (const part of parts) {
    for (let i = 0; i < part.audio.length; i++) mixed[part.offset + i] += part.audio[i];
  }
  return { ok: true, audio: mixed };
}

/**
 * 把各组已渲染好的音频叠加到同一条 beat 0 起算的单声道。
 *
 * 每组结果都已经是“绝对路径”布局（内置管线 Phase 4 与插件组混合都按
 * startTimeBeat 从 beat 0 起算），所以这里直接逐样本相加即可。
 *
 * 归一化：多组叠加后峰值可能远超 1.0（两条各 0.95 的音轨同时段叠加达 1.9），
 * Int16 转换会严重削波。这里统一按 0.95 阈值归一化 —— 与内置
 * synthesizeMultiStreaming 末尾的 normalizePeakTo 同一阈值、同一语义。
 * @param {Float32Array[]} tracks
 * @returns {Float32Array}
 */
function _mixTrackAudio(tracks) {
  let totalSamples = 0;
  for (const audio of tracks) {
    if (audio && audio.length > totalSamples) totalSamples = audio.length;
  }
  const mixed = new Float32Array(totalSamples);
  let peak = 0;
  for (const audio of tracks) {
    if (!audio || audio.length === 0) continue;
    for (let i = 0; i < audio.length; i++) {
      const v = mixed[i] + audio[i];
      mixed[i] = v;
      const abs = v < 0 ? -v : v;
      if (abs > peak) peak = abs;
    }
  }
  if (peak > 0.95) {
    const gain = 0.95 / peak;
    for (let i = 0; i < totalSamples; i++) mixed[i] *= gain;
  }
  return mixed;
}

// 进度节流发送器：100ms 最小间隔，且进度变化 <2% 时跳过；progress>=100 必发。
// svs:synthesize / svs:synthesizeMultiStreaming / fragment-svs:synthesize 共用，
// 避免 diffusion 每步回调直接 win.send 形成 IPC 风暴。
function _makeThrottledSender(win, channel) {
  let lastSentAt = 0;
  let lastValue = -1;
  return (progress) => {
    const now = Date.now();
    if (progress < 100 && now - lastSentAt < 100 && Math.abs(progress - lastValue) < 2) return;
    lastSentAt = now;
    lastValue = progress;
    try {
      if (win && !win.isDestroyed()) win.send(channel, { progress });
    } catch (_) {}
  };
}

/**
 * 在等待管线初始化期间，把加载进度定向转发给发起请求的窗口。
 *
 * 只转发给这一个 webContents：FRAGMENT_SVS_INIT 与 SVS_INIT 可能并发，
 * 广播会让两个窗口都收到对方的进度。
 */
async function _withLoadProgress(event, fn) {
  const { BrowserWindow } = require('electron');
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return fn();
  // 注意不能复用 _makeThrottledSender：它只接受数字 progress 并包成
  // { progress }，而加载进度是 { stage, percent, current, total, name } 对象。
  let lastAt = 0;
  let lastPct = -1;
  const send = (payload) => {
    const pct = Number(payload && payload.percent);
    const now = Date.now();
    const isFinal = pct >= 100;
    if (!isFinal && now - lastAt < 80 && Math.abs(pct - lastPct) < 1) return;
    lastAt = now;
    lastPct = pct;
    try {
      if (win && !win.isDestroyed()) win.send(IPC_CHANNELS.SVS_LOAD_PROGRESS, payload);
    } catch (_) {}
  };
  _loadProgressSenders.add(send);
  try {
    return await fn();
  } finally {
    _loadProgressSenders.delete(send);
  }
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
        win.send(IPC_CHANNELS.SVS_MODEL_INCOMPATIBLE);
      }
    } catch (_) {}
  }

  function getDiffStepIncompatible() {
    const pipeline = svsPipelineLazy.getInstance();
    return !!(pipeline && pipeline.diffStepLegacyInt8Incompatible === true);
  }

  safeHandle(IPC_CHANNELS.SVS_INIT, async (event) => {
    await _withLoadProgress(event, () => svsPipelineLazy.get());
    const incompatible = getDiffStepIncompatible();
    if (incompatible) notifyDiffStepIncompatible(event.sender);
    return { success: true, diffStepLegacyInt8Incompatible: incompatible };
  });

  safeHandle(IPC_CHANNELS.SVS_SYNTHESIZE, async (event, { notes, bpm, options }) => {
    // Load japaneseVocalization setting: 'hybrid' (default) / 'en-phonemes' use English phonemes on base model;
    // 'jp-lora' uses JP LoRA models (in development)
    const settingsForLang = loadSettings();
    const japaneseVocalization = settingsForLang.japaneseVocalization || 'hybrid';

    // Detect language: en-phonemes / hybrid mode always uses base model (null); jp-lora mode uses original logic
    const language = _resolveLanguage(notes, japaneseVocalization);

    // ---- 合成参数装配（内置管线与插件共用同一份 opts）----
    // 装配必须排在"内置管线初始化"之前：插件后端不依赖任何 ONNX 模型，若把插件
    // 派发塞在 ensurePipelineLanguage() 之后，没装 SoulX-Singer 模型的用户就
    // 完全用不了第三方后端 —— 与插件系统"允许非 SoulX 模型"的立项目标正面冲突。
    const opts = options || {};
    opts.language = language; // 用于缓存 key 区分（避免命中错误模型的结果）
    // 进度回调：推送 'svs:progress' 到主窗口，与 fragment-svs:progress 对齐。
    // 之前主页面合成无进度推送，导致推理预览百分比不显示。
    const win = event.sender;
    // 进度推送节流（100ms / 2% 阈值），与 fragment-svs:synthesize 共用同一实现。
    opts.onProgress = _makeThrottledSender(win, IPC_CHANNELS.SVS_PROGRESS);
    // 注入 RMVPE F0 提取器（仅在 autoShift + refAudio 路径下使用）。
    // 插件路径下 RMVPE 往往压根没初始化（用户没装内置模型），这里容错处理：
    // 取不到就不注入，由插件自己的 F0 逻辑兜底，不能因为内置模型缺失而阻塞插件。
    if (opts.autoShift && opts.refAudioWavBuffer) {
      try { opts.refF0Extractor = _makeRmvpeExtractor(); } catch (_) { opts.refF0Extractor = null; }
    }

    // ---- 插件后端透传（options.backend = {type:'plugin', ...}）----
    // 此刻 opts 已经是"内置 pipeline.synthesize() 会收到的完整 options"：
    // 渲染进程的原始参数 + 这里注入的 language / onProgress / refF0Extractor。
    // 直接把这一个引用交给插件，保证给模型的参数全部能给到插件。
    //
    // ★ 引用共享的代价：插件可以改写 opts。因此一旦命中插件分支就立刻 return，
    //   绝不再把同一个 opts 交给内置 pipeline（否则内置链路会读到被插件改过的
    //   参数）。若将来需要"插件 + 内置"双路并行，调用方必须自行浅拷贝 opts。
    const pluginBackend = _resolvePluginBackend(opts);
    if (pluginBackend) {
      const pluginResult = await runPluginBackend({
        backend: pluginBackend,
        notes,
        bpm,
        options: opts,
        sender: win,
        sampleRate: getSampleRate(),
      });
      if (!pluginResult.ok) {
        throw new Error(`PLUGIN_SYNTHESIS_FAILED: ${pluginResult.error}`);
      }
      return pluginResult.audio;
    }

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

      return await _withSynthMutex(() => pipeline.synthesize(notes, bpm, opts), pipeline);
    } catch (err) {
      console.error('[Main] svs:synthesize failed:', err.message);
      throw err;
    }
  });

  // 多分片时间交错流式合成（主页面 Play All 启用分块时使用）
  // 接收所有分片，按时间顺序交错推理各分片的 diffusion chunk，边推理边推送音频
  safeHandle(IPC_CHANNELS.SVS_SYNTHESIZE_MULTI_STREAMING, async (event, { fragments, bpm }) => {
    const settingsForLang = loadSettings();
    const japaneseVocalization = settingsForLang.japaneseVocalization || 'hybrid';

    // 确定语言用于 pipeline 初始化（假设所有内置分片同语言）。
    // 注意：必须取**内置分片**的首个音符——旧实现取 fragments[0]，当第一条轨是
    // 插件轨时，会拿插件轨的语言去初始化管线（日语/英语分流取决于轨道顺序）。
    const groups = _groupFragmentsByBackend(fragments);
    const builtinGroup = groups.find((g) => !g.backend) || null;
    const langNotes = builtinGroup
      ? (builtinGroup.fragments[0].notes || [])
      : (fragments && fragments.length > 0 ? fragments[0].notes || [] : []);
    const language = _resolveLanguage(langNotes, japaneseVocalization);

    // 参数装配与插件派发一律排在内置管线初始化之前（理由同 svs:synthesize）。
    const win = event.sender;
    const opts = {
      onProgress: _makeThrottledSender(win, IPC_CHANNELS.SVS_PROGRESS),
      onChunkAudio: (chunkInfo) => {
        try {
          if (win && !win.isDestroyed()) {
            win.send(IPC_CHANNELS.SVS_CHUNK_AUDIO, chunkInfo);
          }
        } catch (_) {}
      },
    };
    // 注入 RMVPE F0 提取器（所有匹配的 fragment 都需要注入，
    // 否则后续 fragment 在 pipeline 中回退到自相关 F0，导致 autoShift 值不一致）
    // 插件路径下 RMVPE 可能未初始化，容错不注入（插件用自己的 F0 逻辑）。
    for (const frag of fragments) {
      if (frag.options && frag.options.autoShift && frag.options.refAudioWavBuffer) {
        try { frag.options.refF0Extractor = _makeRmvpeExtractor(); } catch (_) { frag.options.refF0Extractor = null; }
      }
    }

    // ---- 逐分片按自己的后端路由（P1-4）----
    // 分片级 options 在这里已经注入完 refF0Extractor，是“内置 pipeline 会收到
    // 的完整 options”；插件拿到的就是这些同一引用（见 _resolvePluginBackend 注释）。
    //
    // 每条脉各走各的路：插件组 → runPluginBackend，内置组 → 内置 pipeline，
    // 两组结果都在 beat 0 起算的同一条时间轴上，最后叠加成一条单声道。
    // 只有真的存在内置分片时才初始化内置管线 —— 纯插件工程依旧不需要 SXS 模型
    // （这是“插件派发排在 ensurePipelineLanguage 之前”的那条硬约束）。
    if (builtinGroup && language === 'ja') {
      const settings = loadSettings();
      const precision = settings.modelPrecision || 'fp32';
      const modelDir = getModelDir();
      if (!checkJpModelsExist(modelDir, precision)) {
        // W19: use i18n key instead of hardcoded Chinese error message.
        return { error: 'JP_MODELS_MISSING', message: t('error.jpModelNotDownloaded') };
      }
    }

    const totalFragments = groups.reduce((n, g) => n + g.fragments.length, 0);
    const tracks = [];
    let doneFragments = 0;
    for (const group of groups) {
      const startPercent = totalFragments > 0 ? Math.round((doneFragments / totalFragments) * 100) : 0;
      doneFragments += group.fragments.length;
      const endPercent = totalFragments > 0 ? Math.round((doneFragments / totalFragments) * 100) : 100;

      if (group.backend) {
        const pluginResult = await _runPluginGroup({
          group,
          bpm,
          sender: win,
          sampleRate: getSampleRate(),
        });
        if (!pluginResult.ok) {
          throw new Error(`PLUGIN_SYNTHESIS_FAILED: ${pluginResult.error}`);
        }
        tracks.push(pluginResult.audio);
      } else {
        try {
          const pipeline = await ensurePipelineLanguage(language);
          if (!pipeline) {
            throw new Error(t('error.svsNotInitialized'));
          }
          // 多组并行渲染时每组内部都报 0→100，缩放到自己的区间避免进度条回跳
          const builtinOpts = _scopeProgress(opts, startPercent, endPercent);
          const builtinAudio = await _withSynthMutex(
            () => pipeline.synthesizeMultiStreaming(group.fragments, bpm, builtinOpts),
            pipeline,
          );
          // 明确报错而不是让空值一路滑到 _mixTrackAudio 里抛 TypeError
          if (!builtinAudio || typeof builtinAudio.length !== 'number') {
            throw new Error('内置管线多分片合成未返回音频数据');
          }
          tracks.push(builtinAudio);
        } catch (err) {
          console.error('[Main] svs:synthesizeMultiStreaming failed:', err.message);
          throw err;
        }
      }
    }

    return _mixTrackAudio(tracks);
  });

  safeHandle(IPC_CHANNELS.SVS_CANCEL, async () => {
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

  safeHandle(IPC_CHANNELS.SVS_DISPOSE, async () => {
    resetSvsPipeline();
    return { success: true };
  });

  safeHandle(IPC_CHANNELS.FRAGMENT_SVS_GET_SAMPLE_RATE, async () => {
    return getSampleRate();
  });

  safeHandle(IPC_CHANNELS.FRAGMENT_SVS_INIT, async (event) => {
    await _withLoadProgress(event, () => svsPipelineLazy.get());
    const incompatible = getDiffStepIncompatible();
    if (incompatible) notifyDiffStepIncompatible(event.sender);
    return { success: true, diffStepLegacyInt8Incompatible: incompatible };
  });

  safeHandle(IPC_CHANNELS.FRAGMENT_SVS_SYNTHESIZE, async (event, { notes, bpm, options }) => {
    // Load japaneseVocalization setting: 'hybrid' (default) / 'en-phonemes' use English phonemes on base model;
    // 'jp-lora' uses JP LoRA models (in development)
    const settingsForLang = loadSettings();
    const japaneseVocalization = settingsForLang.japaneseVocalization || 'hybrid';

    // Detect language: en-phonemes / hybrid mode always uses base model (null); jp-lora mode uses original logic
    const language = _resolveLanguage(notes, japaneseVocalization);

    // 参数装配与插件派发一律排在内置管线初始化之前（理由同 svs:synthesize）：
    // 插件后端不依赖内置 ONNX 模型，没装 SoulX-Singer 也要能用第三方后端。
    const win = event.sender;
    const opts = options || {};
    opts.language = language; // 用于缓存 key 区分（避免命中错误模型的结果）
    // 进度推送节流：与 svs:synthesize 共用 _makeThrottledSender（100ms / 2% 变化阈值）。
    // 长合成时 diffusion 每步都回调，无节流会形成 IPC 风暴（每秒数百次 win.send +
    // 序列化开销），拖慢主进程与渲染进程。
    opts.onProgress = _makeThrottledSender(win, IPC_CHANNELS.FRAGMENT_SVS_PROGRESS);
    // 流式 chunk 音频推送：vocoder 每完成一个 chunk 即推送到 fragment 窗口，实现边合成边播放。
    // background=true（编辑后自动实时推理）时不需要边合成边播，跳过 chunk 推送以免
    // 每帧 Float32Array 白白跨进程序列化；合成结果本身完全一致。
    opts.onChunkAudio = opts.background === true
      ? null
      : (chunkInfo) => {
        try {
          if (!win.isDestroyed()) {
            win.send(IPC_CHANNELS.FRAGMENT_SVS_CHUNK_AUDIO, chunkInfo);
          }
        } catch (_) {}
      };
    // 注入 RMVPE F0 提取器（仅在 autoShift + refAudio 路径下使用）。
    // 插件路径下 RMVPE 可能未初始化，容错不注入，由插件自己的 F0 逻辑兜底。
    if (opts.autoShift && opts.refAudioWavBuffer) {
      try { opts.refF0Extractor = _makeRmvpeExtractor(); } catch (_) { opts.refF0Extractor = null; }
    }

    // ---- 插件后端透传 ----
    // 与 svs:synthesize 同一套语义：opts 是内置 pipeline 会收到的完整 options，
    // 插件拿到同一引用；命中插件分支直接 return，不再调用内置 pipeline。
    // 返回值仍是 { data }，渲染层无需区分后端。
    const pluginBackend = _resolvePluginBackend(opts);
    if (pluginBackend) {
      const pluginResult = await runPluginBackend({
        backend: pluginBackend,
        notes,
        bpm,
        options: opts,
        sender: win,
        sampleRate: getSampleRate(),
      });
      if (!pluginResult.ok) {
        return { error: `PLUGIN_SYNTHESIS_FAILED: ${pluginResult.error}` };
      }
      return { data: pluginResult.audio };
    }

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

    try {
      const data = await _withSynthMutex(() => pipeline.synthesize(notes, bpm, opts), pipeline);
      return { data };
    } catch (err) {
      return { error: err.message };
    }
  });

  safeHandle(IPC_CHANNELS.FRAGMENT_SVS_DISPOSE, async () => {
    return { success: true };
  });

  safeHandle(IPC_CHANNELS.FRAGMENT_SVS_RESOLVE_PHONEMES, async (event, { lyrics }) => {
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

  safeHandle(IPC_CHANNELS.SVS_CHECK_JP_MODELS, async () => {
    const settings = loadSettings();
    const precision = settings.modelPrecision || 'fp32';
    const modelDir = getModelDir();
    return checkJpModelsExist(modelDir, precision);
  });

  // 插件宿主 IPC（plugin:*）与 SVS 同属 STEP 4 重型阶段，且 svsIpc 是插件
  // 合成的调用方，因此在这里一并注册。main.js 解锁后可挪到 registerSvsIpc()
  // 旁边单独一行调用，行为等价。
  registerPluginIpc();
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
