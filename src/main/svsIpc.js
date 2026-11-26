// 推理管线的 require 从模块顶层下沉。
//
// 冷启动审查：pipeline/index.js 是 5118 行且连带 diffusion / preprocessing /
// postprocessing 等一整棵子树，require 它要解析并编译数万行 JS。此前它在
// svsIpc.js 第 1 行，而 svsIpc 在启动的 STEP 4 被同步 require —— 于是这份解析
// 成本落在主窗口显示之前。ORT native addon 本身已由 ortRuntime 惰性化，
// 这里再把 JS 解析也推迟到首次真正要建管线时（采样率查询不再触发加载，
// 见下面的 SAMPLE_RATE）。
//
// 采样率不从 pipeline 取：它只是 inference/shared/constants.js 里的一个常量，
// 而 pipeline/index.js 仅导出 { OnnxSVSPipeline, NativeSVSPipeline, SAMPLE_RATE,
// enumerateDMLDevices }，从来没有 getSampleRate() 这个函数。此前的写法
// getPipelineModule().getSampleRate() 让 fragment-svs:getSampleRate 必然抛
// "is not a function"（渲染进程初始化采样率是打开分片编辑器的第一步）。
// 直接读轻量常量模块：既修掉异常，也不必为了回答一次采样率查询去解析整棵
// 5000 行 pipeline（该常量模块本就是 pipeline/constants.js 的唯一来源）。
const { SAMPLE_RATE } = require('../inference/shared/constants.js');
let _pipelineModule = null;
function getPipelineModule() {
  if (!_pipelineModule) _pipelineModule = require('../inference/pipeline');
  return _pipelineModule;
}
function getSampleRate() { return SAMPLE_RATE; }
const { loadSettings } = require('./settings');
const { getModelDir } = require('./modelDir');
const { checkJpModelsExist } = require('../modelManager');
const { t } = require('./locale');
const { createLazyInitializer } = require('./lazyInitializer');

// ---- 远程 API 推理（设置里「推理系统 = API」）----
// 惰性 require：这两个模块只依赖 shared/constants 与 locale，不会触发 ONNX 加载。
// 放在这里而不是文件顶层，是为了不拖慢冷启动（与主注释的惰性化策略一致）。
let _apiModules = null;
function apiModules() {
  if (!_apiModules) {
    _apiModules = {
      store: require('./apiProviderStore'),
      inference: require('./apiInference'),
    };
  }
  return _apiModules;
}
function isApiMode() {
  try { return loadSettings().inferenceProvider === 'api'; } catch (_) { return false; }
}
function apiRuntime() {
  const rt = apiModules().store.getActiveRuntime();
  if (!rt) throw new Error(t('error.apiNoProvider'));
  return rt;
}

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
// 分片预览的流身份。旧会话 dispose 时带 streamId 调 svs:cancel；若此刻在跑的
// 已是新一轮，必须忽略那次取消，否则"停止 A"会把刚启动的 B 一起杀掉。
let _activeFragmentStreamId = null;
// streamId -> {state:'queued'|'running'|'cancelled', cancel}。
// 单一 active ID 只能表达"最后提交者"，无法表示 mutex 队列里排队但尚未
// 执行的请求；取消必须按 streamId 精确命中任务。
const _fragmentStreamTasks = new Map();
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
  const japaneseVocalization = settings.japaneseVocalization || 'en-phonemes';
  console.log(`[Main] Pipeline settings: winmlEnabled=${settings.winmlEnabled === true} deviceMode=${deviceMode} inferenceProvider=${inferenceProvider}`);

  const langTag = languageOverride ? `, language=${languageOverride}` : '';
  console.log(`[Main] Initializing SVS Pipeline, model path: ${modelPath}, precision: ${modelPrecision}${langTag}, jpVocal=${japaneseVocalization}`);

  // dummy 校验结果缓存目录（跨重启复用，避免每次启动重跑一遍校验推理）。
  // worker_threads 内拿不到 electron.app，这里解析后随 pipelineOptions / workerData 下发。
  let userDataDir = null;
  try {
    const electron = require('electron');
    if (electron && electron.app && typeof electron.app.getPath === 'function') {
      userDataDir = electron.app.getPath('userData');
    }
  } catch (_) { /* 非 Electron 环境（测试 / CLI 片段） */ }

  const pipelineOptions = {
    deviceId,
    deviceMode,
    preferredDeviceType,
    modelDeviceMapping,
    modelPrecision,
    languageOverride,
    inferenceProvider,
    japaneseVocalization,
    userDataDir,
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
    // 显式后端也要参与判定：settings.winmlEnabled 是界面保存时派生的值，
    // 后端被改成 DML 但派生字段尚未同步时，不能继续按 WinML 路径下发。
    // 变量名沿用 backendIsDml 以兼容既有调用点，含义是「不应下发 WinML EP」：
    // 除 DML 外，全局强制 CPU 后端也必须关掉这条路径，否则 worker 会带着
    // winmlEps 启动，与设置里的 'cpu' 相互矛盾。
    const backendIsDml = settings.nativeInferenceBackend === 'dml'
      || settings.nativeInferenceBackend === 'cpu'
      || (settings.inferenceProvider && settings.inferenceProvider !== 'ortnode');
    if (settings.winmlEnabled === true && !backendIsDml) {
      try {
        const winmlProvider = require('../inference/winml/winmlProvider');
        winmlEps = await winmlProvider.getReadyEpLibraries();
        // 后端已切回 Windows ML 却解析到空列表，通常是旧的门控缓存未失效。
        // 清一次进程级状态再解析，仍为空则如实告知并回退，不把空快照伪装
        // 成"WinML 已就绪"。
        if (!Array.isArray(winmlEps) || winmlEps.length === 0) {
          winmlProvider.resetEpState();
          winmlEps = await winmlProvider.getReadyEpLibraries();
        }
        winmlEnabled = true;
        console.log(`[Main] WinML enabled: resolved ${winmlEps ? winmlEps.length : 0} ready EP(s)${winmlEps && winmlEps.length ? ' -> ' + winmlEps.map((e) => e.name).join(', ') : ''}`);
        if (!winmlEps || winmlEps.length === 0) {
          console.warn('[Main] WinML enabled but no compatible EP resolved; sessions will fall back to DML/CPU for this worker');
        }
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
      ...(userDataDir ? { userDataDir } : {}),
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
 * MCP pipeline.status 用：只读地披露管线运行态，不触发任何加载。
 * pendingReset 为 true 表示合成仍在进行、reset 已排队但尚未执行 —— 调用方
 * 据此决定是稍后重查还是继续等待，不能把"已排队"当成"已卸载"。
 */
function getPipelineRuntimeState() {
  const inst = svsPipelineLazy.getInstance();
  return {
    initialized: !!(inst && inst.initialized),
    pendingReset: _pendingPipelineReset,
    language: currentLanguage,
  };
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
    parts.push({ audio: result.audio, offset, trackId: frag.trackId || frag.id || null });
    totalSamples = Math.max(totalSamples, endSample);
  }

  // 只有最后一次分配（混音缓冲），分片音频是插件直接产出的，不再逐样本拷贝中间态
  const mixed = new Float32Array(totalSamples);
  for (const part of parts) {
    for (let i = 0; i < part.audio.length; i++) mixed[part.offset + i] += part.audio[i];
  }
  // 分轨片段：每片按自己的 trackId + 绝对起点保留，供渲染层实时 M/S。
  const segments = parts.map(p => ({ trackId: p.trackId, startSample: p.offset, audio: p.audio }));
  return { ok: true, audio: mixed, segments };
}

/**
 * 单组 API 分片：逐分片调用远程 /v1/synthesize，再按 startTimeBeat 混合成
 * 一条 beat 0 起算的单声道，与内置 synthesizeMultiStreaming / _runPluginGroup
 * 的返回形态完全一致。任何一个分片报错都直接抛出（含 429/401 明确文案），
 * 不降级、不静默。
 * @returns {Promise<Float32Array>}
 */
async function _runApiGroup({ group, bpm, runtime, options, startPercent, endPercent }) {
  const { inference } = apiModules();
  const sr = getSampleRate();
  const maxSamples = Math.floor(MAX_PLUGIN_MIX_SECONDS * sr);
  const effectiveBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const parts = [];
  let totalSamples = 0;
  const span = Math.max(0, endPercent - startPercent);
  const rawProgress = options && options.onProgress;

  for (let i = 0; i < group.fragments.length; i++) {
    const frag = group.fragments[i];
    const fragBase = startPercent + Math.round((i / Math.max(1, group.fragments.length)) * span);
    const fragEnd = startPercent + Math.round(((i + 1) / Math.max(1, group.fragments.length)) * span);
    const onProgress = (p) => {
      if (typeof rawProgress !== 'function') return;
      const c = Math.max(0, Math.min(100, Number(p) || 0));
      rawProgress(Math.round(fragBase + (c / 100) * Math.max(0, fragEnd - fragBase)));
    };
    let audio;
    try {
      audio = await inference.synthesize({
        runtime,
        notes: frag.notes || [],
        bpm,
        options: { ...(frag.options || {}), onProgress },
        onProgress,
      });
    } catch (err) {
      // 带分片位置，便于定位是哪个轨道触发了限流/鉴权失败。
      throw new Error(`分片 ${i + 1}/${group.fragments.length}（trackId=${frag.trackId || frag.id || `#${i + 1}`}）：${err.message}`);
    }
    const startBeat = Number(frag.startTimeBeat);
    if (!Number.isFinite(startBeat) || startBeat < 0) {
      throw new Error(`分片 ${i + 1}/${group.fragments.length} 的 startTimeBeat 非法：${frag.startTimeBeat}`);
    }
    const offset = Math.max(0, Math.round(((startBeat / effectiveBpm) * 60) * sr));
    const endSample = offset + audio.length;
    if (!Number.isFinite(endSample) || endSample > maxSamples) {
      throw new Error(`分片 ${i + 1}/${group.fragments.length} 的混音长度超出上限（${MAX_PLUGIN_MIX_SECONDS} 秒）`);
    }
    parts.push({ audio, offset, trackId: frag.trackId || frag.id || null });
    totalSamples = Math.max(totalSamples, endSample);
  }
  const mixed = new Float32Array(totalSamples);
  for (const part of parts) {
    for (let i = 0; i < part.audio.length; i++) mixed[part.offset + i] += part.audio[i];
  }
  const segments = parts.map(p => ({ trackId: p.trackId, startSample: p.offset, audio: p.audio }));
  return { audio: mixed, segments };
}

/**
 * 把内置组累积的 segments 归一化到与其权威混音一致的峰值（P2-1）。
 *
 * 背景：内置 synthesizeMultiStreaming 在返回前对 mixedAudio 做了
 * normalizePeakTo(0.95)，但 onChunkAudio 发出的 chunk（svsIpc 据此累积
 * builtinSegments）是归一化前的原始峰值。若直接把这些 segments 交给
 * _mixTrackAudio，它按"已归一化"的 audio 峰值算出的增益≈1，segments 保持
 * 原始峰值 → 分轨播放比整段混音响、甚至削波；内置 + 插件混用时两组在 mix
 * 与 segments 里的相对比例也不一致。
 *
 * 这里从 segments 重建混音峰值，按其与参考混音（归一化后的内置 audio）峰值
 * 的比例缩放所有 segment，使二者峰值对齐。之后 _mixTrackAudio 的统一增益
 * 对 audio 与 segments 就是同一系数。
 *
 * @param {Array<{trackId:string, startSample:number, audio:Float32Array}>} segments
 * @param {Float32Array} referenceAudio 归一化后的内置组混音
 * @returns {number} 实际应用到 segments 的增益（1 表示未改）
 */
function _alignBuiltinSegmentsToMix(segments, referenceAudio) {
  if (!Array.isArray(segments) || segments.length === 0) return 1;
  if (!referenceAudio || !referenceAudio.length) return 1;
  let refPeak = 0;
  for (let i = 0; i < referenceAudio.length; i++) {
    const a = Math.abs(referenceAudio[i]);
    if (a > refPeak) refPeak = a;
  }
  if (refPeak <= 0) return 1;

  // 从 segments 按绝对起点重建混音，求其归一化前的峰值。
  let maxLen = 0;
  for (const seg of segments) {
    if (seg && seg.audio && seg.audio.length) {
      maxLen = Math.max(maxLen, (seg.startSample | 0) + seg.audio.length);
    }
  }
  if (maxLen <= 0) return 1;
  const rebuilt = new Float32Array(maxLen);
  for (const seg of segments) {
    if (!seg || !seg.audio || !seg.audio.length) continue;
    const start = Math.max(0, seg.startSample | 0);
    for (let i = 0; i < seg.audio.length && start + i < maxLen; i++) {
      rebuilt[start + i] += seg.audio[i];
    }
  }
  let segPeak = 0;
  for (let i = 0; i < rebuilt.length; i++) {
    const a = Math.abs(rebuilt[i]);
    if (a > segPeak) segPeak = a;
  }
  if (segPeak <= 0) return 1;
  const gain = refPeak / segPeak;
  if (Number.isFinite(gain) && gain > 0 && Math.abs(gain - 1) > 1e-9) {
    for (const seg of segments) {
      if (!seg || !seg.audio) continue;
      for (let i = 0; i < seg.audio.length; i++) seg.audio[i] *= gain;
    }
  }
  return gain;
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
 * 统一增益必须同时作用于混音与所有 segments，否则实时播放与重新 seek 后音量不一致（4.4）。
 * @param {Array<Float32Array|{audio:Float32Array, segments:Array}>} tracks
 * @param {Array<{trackId:string, startSample:number, audio:Float32Array}>} extraSegments
 * @returns {{audio:Float32Array, segments:Array}}
 */
function _mixTrackAudio(tracks, extraSegments = []) {
  // 兼容：tracks 既可能是 Float32Array（内置管线 / 旧调用），也可能是
  // { audio, segments }（插件 / API 组）。统一取出 audio 与逐轨 segments。
  const audios = tracks.map(t => (t && ArrayBuffer.isView(t) ? t : (t && t.audio) || null));
  const allSegments = [];
  for (const t of tracks) {
    if (t && !ArrayBuffer.isView(t) && Array.isArray(t.segments)) {
      for (const seg of t.segments) if (seg && seg.audio && seg.audio.length) allSegments.push(seg);
    }
  }
  for (const seg of extraSegments) {
    if (seg && seg.audio && seg.audio.length) allSegments.push(seg);
  }

  let totalSamples = 0;
  for (const audio of audios) {
    if (audio && audio.length > totalSamples) totalSamples = audio.length;
  }
  const mixed = new Float32Array(totalSamples);
  let peak = 0;
  for (const audio of audios) {
    if (!audio || audio.length === 0) continue;
    for (let i = 0; i < audio.length; i++) {
      const v = mixed[i] + audio[i];
      mixed[i] = v;
      const abs = v < 0 ? -v : v;
      if (abs > peak) peak = abs;
    }
  }
  // 统一峰值增益：混音与 segments 乘同一个系数，否则实时播放与重新 seek 后音量不一致。
  const gain = peak > 0.95 ? 0.95 / peak : 1;
  if (gain !== 1) {
    for (let i = 0; i < totalSamples; i++) mixed[i] *= gain;
    for (const seg of allSegments) {
      for (let i = 0; i < seg.audio.length; i++) seg.audio[i] *= gain;
    }
  }
  return { audio: mixed, segments: allSegments };
}

// 进度节流发送器：100ms 最小间隔，且进度变化 <2% 时跳过；progress>=100 必发。
// svs:synthesize / svs:synthesizeMultiStreaming / fragment-svs:synthesize 共用，
// 避免 diffusion 每步回调直接 win.send 形成 IPC 风暴。
function _makeThrottledSender(win, channel, extra = null) {
  let lastSentAt = 0;
  let lastValue = -1;
  return (progress) => {
    const now = Date.now();
    if (progress < 100 && now - lastSentAt < 100 && Math.abs(progress - lastValue) < 2) return;
    lastSentAt = now;
    lastValue = progress;
    try {
      if (win && !win.isDestroyed()) win.send(channel, { progress, ...(extra || {}) });
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

  safeHandle(IPC_CHANNELS.SVS_INIT, async (event, options) => {
    // 纯插件工程没有任何由内置模型支持的轨道，渲染层显式传 needsBuiltin:false。
    // 必须在 _withLoadProgress 之前短路：一旦进去就会 svsPipelineLazy.get()
    // 把 9 个 ONNX 模型读进显存，并推"加载模型"进度条。未传或传 true 时
    // 保持原逻辑逐字不变，内置与混合工程的行为不受影响。
    if (options && options.needsBuiltin === false) {
      return { success: true, skipped: true, diffStepLegacyInt8Incompatible: false };
    }
    // API 模式不需要任何本地 ONNX 模型：必须在 svsPipelineLazy.get() 之前短路，
    // 否则没下载 SoulX-Singer 模型的用户仍会被要求加载 882MB 权重并卡在进度条。
    if (isApiMode()) {
      return { success: true, skipped: true, diffStepLegacyInt8Incompatible: false };
    }
    await _withLoadProgress(event, () => svsPipelineLazy.get());
    const incompatible = getDiffStepIncompatible();
    if (incompatible) notifyDiffStepIncompatible(event.sender);
    return { success: true, diffStepLegacyInt8Incompatible: incompatible };
  });

  safeHandle(IPC_CHANNELS.SVS_SYNTHESIZE, async (event, { notes, bpm, options }) => {
    // Load japaneseVocalization setting: 'en-phonemes' (default) / 'hybrid' use English phonemes on base model;
    // 'jp-lora' uses JP LoRA models (in development)
    const settingsForLang = loadSettings();
    const japaneseVocalization = settingsForLang.japaneseVocalization || 'en-phonemes';

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

    // ---- 远程 API 后端（设置里「推理系统 = API」）----
    // 与插件分支同处"内置管线初始化之前"：API 模式不加载本地模型。
    // 错误（401/403 鉴权、429 限流、超时、网络）由 apiInference 生成已本地化、
    // 带 [API ...] 前缀的消息，经 safeHandle 抛给渲染层弹窗，绝不静默返回空音频。
    if (isApiMode()) {
      const { inference } = apiModules();
      return await inference.synthesize({
        runtime: apiRuntime(),
        notes,
        bpm,
        options: opts,
        onProgress: opts.onProgress,
      });
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
    const japaneseVocalization = settingsForLang.japaneseVocalization || 'en-phonemes';

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
    // 内置组的权威分轨数据：转发 chunk 的同时按 trackId 累积。
    // chunk 只负责"边合成边听"；渲染层最终以这里返回的 segments 为准（4.4）。
    const builtinSegments = [];
    const opts = {
      onProgress: _makeThrottledSender(win, IPC_CHANNELS.SVS_PROGRESS),
      onChunkAudio: (chunkInfo) => {
        try {
          if (chunkInfo && chunkInfo.trackId && chunkInfo.audio && chunkInfo.audio.length) {
            builtinSegments.push({
              trackId: chunkInfo.trackId,
              startSample: chunkInfo.sampleOffset,
              // chunkInfo.audio 会被结构化克隆发给渲染层；这里保留一份独立副本作权威数据。
              audio: chunkInfo.audio.slice(),
            });
          }
        } catch (_) {}
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
        tracks.push({ audio: pluginResult.audio, segments: pluginResult.segments || [] });
      } else if (isApiMode()) {
        // API 模式：内置组分片逐个走远程合成，再按 startTimeBeat 混合成绝对路径
        // 布局的单声道，与内置 synthesizeMultiStreaming 返回形态一致。
        const apiAudio = await _runApiGroup({
          group,
          bpm,
          runtime: apiRuntime(),
          options: opts,
          startPercent,
          endPercent,
        });
        tracks.push(apiAudio); // { audio, segments }
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

    // P2-1: 内置组混音在 pipeline 末尾已归一化到 0.95，但 onChunkAudio 累积的
    // builtinSegments 是归一化前的原始峰值。先把 segments 对齐到内置混音的峰值，
    // 再交给 _mixTrackAudio 统一增益 —— 保证分轨播放与整段混音音量/比例一致。
    const builtinMix = tracks.find(t => t && ArrayBuffer.isView(t));
    if (builtinMix) _alignBuiltinSegmentsToMix(builtinSegments, builtinMix);

    // 内置组的 segments 由 onChunkAudio 累积（builtinSegments）；插件/API 组随各自
    // 返回值带上。统一峰值增益后一起返回给渲染层（结构升级为 { audio, segments }）。
    return _mixTrackAudio(tracks, builtinSegments);
  });

  safeHandle(IPC_CHANNELS.SVS_CANCEL, async (_event, options) => {
    const requestedStreamId = options && typeof options.streamId === 'string' ? options.streamId : null;
    if (requestedStreamId) {
      // 携带 streamId 时必须精确命中任务：active 为空或任务尚未执行，
      // 都不能退化成"取消当前在跑的任意合成"。
      const task = _fragmentStreamTasks.get(requestedStreamId);
      if (!task || task.state !== 'running') {
        if (task && task.state === 'queued') task.state = 'cancelled';
        console.log(`[Main] svs:cancel ignored stream ${requestedStreamId} (state=${task ? task.state : 'missing'})`);
        return { success: true, ignoredStaleStream: true };
      }
      try { await task.cancel?.cancelActiveSynthesis?.(); } catch (_) {}
      return { success: true };
    }
    // API 模式没有可取消的本地 pipeline，但要中止在途 HTTP 请求（Fetch AbortController）。
    if (isApiMode()) {
      try { apiModules().inference.cancelAll(); } catch (_) { /* 尚未加载 API 模块 */ }
    }
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

  safeHandle(IPC_CHANNELS.FRAGMENT_SVS_INIT, async (event, options) => {
    // 与 svs:init 同一套短路：分片编辑器显示插件后端轨道时，不应为了在编辑器
    // 里按一次播放就把整套内置 ONNX 模型读进显存。未传或传 true 时原逻辑不变。
    if (options && options.needsBuiltin === false) {
      return { success: true, skipped: true, diffStepLegacyInt8Incompatible: false };
    }
    // API 模式不需要任何本地 ONNX 模型：必须在 svsPipelineLazy.get() 之前短路，
    // 否则没下载 SoulX-Singer 模型的用户仍会被要求加载 882MB 权重并卡在进度条。
    if (isApiMode()) {
      return { success: true, skipped: true, diffStepLegacyInt8Incompatible: false };
    }
    await _withLoadProgress(event, () => svsPipelineLazy.get());
    const incompatible = getDiffStepIncompatible();
    if (incompatible) notifyDiffStepIncompatible(event.sender);
    return { success: true, diffStepLegacyInt8Incompatible: incompatible };
  });

  safeHandle(IPC_CHANNELS.FRAGMENT_SVS_SYNTHESIZE, async (event, { notes, bpm, options }) => {
    // Load japaneseVocalization setting: 'en-phonemes' (default) / 'hybrid' use English phonemes on base model;
    // 'jp-lora' uses JP LoRA models (in development)
    const settingsForLang = loadSettings();
    const japaneseVocalization = settingsForLang.japaneseVocalization || 'en-phonemes';

    // Detect language: en-phonemes / hybrid mode always uses base model (null); jp-lora mode uses original logic
    const language = _resolveLanguage(notes, japaneseVocalization);

    // 参数装配与插件派发一律排在内置管线初始化之前（理由同 svs:synthesize）：
    // 插件后端不依赖内置 ONNX 模型，没装 SoulX-Singer 也要能用第三方后端。
    const win = event.sender;
    const opts = options || {};
    opts.language = language; // 用于缓存 key 区分（避免命中错误模型的结果）
    // 进度也要带 streamId：渲染侧据此过滤旧任务的迟到进度，避免 A 的 100%
    // 覆盖 B 的按钮文案。
    const fragmentStreamId = typeof opts.streamId === 'string' && opts.streamId
      ? opts.streamId
      : null;
    // 进度推送节流：与 svs:synthesize 共用 _makeThrottledSender（100ms / 2% 变化阈值）。
    // 长合成时 diffusion 每步都回调，无节流会形成 IPC 风暴（每秒数百次 win.send +
    // 序列化开销），拖慢主进程与渲染进程。
    opts.onProgress = _makeThrottledSender(
      win,
      IPC_CHANNELS.FRAGMENT_SVS_PROGRESS,
      fragmentStreamId ? { synthesisId: fragmentStreamId } : null,
    );
    // 流式 chunk 音频推送：vocoder 每完成一个 chunk 即推送到 fragment 窗口，实现边合成边播放。
    // background=true（编辑后自动实时推理）时不需要边合成边播，跳过 chunk 推送以免
    // 每帧 Float32Array 白白跨进程序列化；合成结果本身完全一致。
    //
    // 每个 chunk 都带 streamId + 单调 seq，流结束时再发一条 STREAM_END(lastSeq)。
    // 目的有两个：① 旧请求的迟到 chunk 不能被新会话误收（channel 是全局的）；
    // ② renderer 不再靠 `invoke 回执 + setTimeout(0)` 猜"chunk 已全部到齐"。
    // STREAM_END 在 invoke 回执之前发出（同一 win 的消息有序），构成显式屏障。
    let chunkSeq = 0;
    let streamSendFailed = false;
    let firstFailedSeq = null;
    let sendFailuresAfterFirst = 0;
    const isBackground = opts.background === true;
    const fragmentTask = !isBackground && fragmentStreamId
      ? { state: 'queued', cancel: null }
      : null;
    if (fragmentTask) _fragmentStreamTasks.set(fragmentStreamId, fragmentTask);
    /**
     * 流结束屏障。接收端必须能区分"正常完成 / 合成失败 / 用户取消"，
     * 否则失败或取消都会被当成完整交付（seq 连续但尾段根本没合成）。
     *
     * @param {{complete?:boolean, failed?:boolean, cancelled?:boolean, errorCode?:string|null}} [outcome]
     */
    const sendStreamEnd = (outcome = {}) => {
      if (isBackground || !fragmentStreamId || win.isDestroyed()) return;
      const failed = outcome.failed === true;
      const cancelled = outcome.cancelled === true;
      // 有块发送失败 = 交付不完整，不能报 complete。
      const complete = outcome.complete === true && !streamSendFailed;
      const status = cancelled ? 'cancelled' : failed ? 'failed' : complete ? 'complete' : 'incomplete';
      try {
        win.send(IPC_CHANNELS.FRAGMENT_SVS_STREAM_END, {
          streamId: fragmentStreamId,
          lastSeq: chunkSeq,
          transportFailed: streamSendFailed,
          complete,
          failed,
          cancelled,
          status,
          firstFailedSeq,
          sendFailuresAfterFirst,
          errorCode: outcome.errorCode ?? null,
        });
      } catch (_) {
        console.warn(`[Main] Failed to send STREAM_END for ${fragmentStreamId}`);
      }
    };
    opts.onChunkAudio = isBackground
      ? null
      : (chunkInfo) => {
        if (win.isDestroyed()) return;
        // 先发送、成功后才提交 seq：否则 send 抛错时 lastSeq 会声明一个
        // renderer 永远收不到的序号，结束屏障永远无法满足。
        const nextSeq = chunkSeq + 1;
        // 诊断：区分"推理侧推出静音"与"渲染端播放静音"。抽样 RMS（步长 64）
        // 足以看出长空当后的块是否真的有内容，开销可忽略。
        let chunkRms = 0;
        const audio = chunkInfo && chunkInfo.audio;
        if (audio && audio.length > 0) {
          const stride = 64;
          let sum = 0;
          let count = 0;
          for (let i = 0; i < audio.length; i += stride) {
            const v = audio[i];
            sum += v * v;
            count += 1;
          }
          chunkRms = count > 0 ? Math.sqrt(sum / count) : 0;
        }
        console.log(`[FragStream] send seq=${nextSeq} offset=${chunkInfo.sampleOffset ?? '-'} end=${chunkInfo.sampleEnd ?? '-'} samples=${audio ? audio.length : 0} rms=${chunkRms.toFixed(6)} isLast=${!!chunkInfo.isLast} stream=${fragmentStreamId}`);
        try {
          win.send(IPC_CHANNELS.FRAGMENT_SVS_CHUNK_AUDIO, {
            ...chunkInfo,
            streamId: fragmentStreamId,
            seq: nextSeq,
          });
          chunkSeq = nextSeq;
        } catch (_) {
          streamSendFailed = true;
          // 只记首个失败序号：诊断"从哪一块开始丢"比"丢了几个"更有用。
          if (firstFailedSeq === null) firstFailedSeq = nextSeq;
          else sendFailuresAfterFirst += 1;
          console.warn(`[Main] Failed to send fragment chunk seq=${nextSeq} firstFailedSeq=${firstFailedSeq} stream=${fragmentStreamId}`);
        }
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

    // ---- 远程 API 后端 ----
    // 返回 {error} 而不是 throw：preload 的 synthesizeFragmentSVS 会把它转成
    // Error 抛出，渲染层（含后台自动推理路径）据此显式报错。
    if (isApiMode()) {
      const { inference } = apiModules();
      try {
        const data = await inference.synthesize({
          runtime: apiRuntime(),
          notes,
          bpm,
          options: opts,
          onProgress: opts.onProgress,
        });
        return { data };
      } catch (err) {
        console.error('[Main] fragment-svs:synthesize (API) failed:', err.message);
        return { error: err.message };
      }
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

    /** @type {{complete:boolean, failed:boolean, cancelled:boolean, errorCode:string|null}} */
    let outcome = { complete: false, failed: false, cancelled: false, errorCode: null };
    try {
      // active ID 必须在实际进入 mutex、真正要用 GPU 时才置位；排队中的
      // 请求不能被当成"当前执行者"，否则取消会命中错任务。
      const data = await _withSynthMutex(() => {
        if (fragmentTask && fragmentTask.state === 'cancelled') {
          const err = new Error('Synthesis cancelled');
          err.code = 'SYNTHESIS_CANCELLED';
          throw err;
        }
        if (fragmentTask) {
          fragmentTask.state = 'running';
          fragmentTask.cancel = pipeline;
          _activeFragmentStreamId = fragmentStreamId;
        }
        return pipeline.synthesize(notes, bpm, opts);
      }, pipeline);
      outcome = { complete: true, failed: false, cancelled: false, errorCode: null };
      return { data };
    } catch (err) {
      outcome = {
        complete: false,
        failed: true,
        cancelled: err && err.code === 'SYNTHESIS_CANCELLED',
        errorCode: (err && err.code) || null,
      };
      return { error: err.message };
    } finally {
      // 必须在 invoke 回执之前投递结束屏障；win.send 与 handle 的回复同属
      // main→renderer 方向，Electron 保证顺序，renderer 处理回执时 END 已排队。
      sendStreamEnd(outcome);
      if (fragmentTask) _fragmentStreamTasks.delete(fragmentStreamId);
      if (_activeFragmentStreamId === fragmentStreamId) _activeFragmentStreamId = null;
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
  getPipelineRuntimeState,
  resetSvsPipeline,
  svsPipelineLazy,
  // 重新导出纯函数供测试（来自 languageDetection 模块）
  detectJapaneseNotes: _detectJapaneseNotes,
  detectEnglishNotes: _detectEnglishNotes,
  resolveLanguage: _resolveLanguage,
  // 供测试：分轨 segments 汇总（4.4）。这些是纯函数，导出不改变运行时行为。
  __test: { _mixTrackAudio, _runPluginGroup, _runApiGroup, _alignBuiltinSegmentsToMix },
};
