/**
 * 插件宿主的 IPC 层。
 *
 * 本文件只做两件事：
 *   1. 把 pluginHost 的能力以 safeHandle 暴露给渲染进程（全部走 safeHandle，
 *      与仓库其它 70 处保持一致；异常在 ipcSafe.js 里统一脱敏后 reject）；
 *   2. 提供 runPluginBackend() —— 供 svsIpc.js 的三个 synthesize handler 做
 *      "参数全量透传"接线（见文件末尾的导出说明）。
 *
 * 由于 main.js 目前由其它改动占用，registerPluginIpc() 由 registerSvsIpc()
 * 内部调用（同一个 STEP 4 重型模块加载阶段）。等 main.js 解锁后，可把它挪到
 * main.js 的 registerSvsIpc() 旁边单独一行调用，行为完全等价。
 */

const fs = require('node:fs');
const path = require('node:path');
const { IPC_CHANNELS } = require('../shared/ipcChannels');
const { safeHandle } = require('./ipcSafe');
const { isPathAllowed } = require('./security');
const contract = require('../shared/pluginContract.js');
const { getPluginHost } = require('./pluginHost');

/** 惰性加载：首次用到插件能力时才扫描磁盘，避免拖慢启动。 */
let _loadPromise = null;

/**
 * 确保插件已扫描加载（幂等、并发安全）。
 * @returns {Promise<object>} pluginHost.loadPlugins() 的结果
 */
function ensurePluginsLoaded() {
  if (!_loadPromise) {
    _loadPromise = getPluginHost().loadPlugins().catch((err) => {
      console.error('[Main] 插件扫描失败：', err && err.message ? err.message : err);
      return { success: false, plugins: [], errors: [{ pluginId: null, stage: 'scan', message: String(err && err.message || err) }] };
    });
  }
  return _loadPromise;
}

/** 热重载后重置惰性加载标记（reloadPlugins 自己会重新扫描）。 */
function invalidateLoadPromise() {
  _loadPromise = null;
}

/**
 * 校验 options.backend 是否指向一个插件后端。
 * @param {unknown} backend
 * @returns {{ok:true, backend:object}|{ok:false, error:string}}
 */
function validateBackend(backend) {
  if (!backend || typeof backend !== 'object') return { ok: false, error: 'backend 缺失' };
  if (backend.type !== 'plugin') return { ok: false, error: `backend.type 不是 plugin：${JSON.stringify(backend.type)}` };
  if (!contract.isValidPluginId(backend.pluginId)) {
    return { ok: false, error: `backend.pluginId 非法：${JSON.stringify(backend.pluginId)}` };
  }
  if (backend.kindId !== undefined && backend.kindId !== null && !contract.isValidKindId(backend.kindId)) {
    return { ok: false, error: `backend.kindId 非法：${JSON.stringify(backend.kindId)}` };
  }
  return { ok: true, backend };
}

/**
 * 把插件返回结果压成内置 pipeline 的同款单声道 Float32Array。
 *
 * 说明：内置 pipeline 返回的是"首音符起点对齐"的 Float32Array，渲染层负责前置
 * 补零。插件声明的 leadingSamples 由宿主在这里补掉，使渲染层无需区分后端。
 *
 * @param {object} result pluginHost.synthesize() 的返回
 * @param {number} expectedSampleRate
 * @returns {{ok:true, audio: Float32Array, sampleRate:number, diagnostics:object|null}|{ok:false, error:string}}
 */
function toBuiltinAudio(result, expectedSampleRate) {
  const pcm = result.pcm;
  if (!pcm) return { ok: true, audio: new Float32Array(0), sampleRate: expectedSampleRate, diagnostics: result.diagnostics || null };

  let mono;
  if (Array.isArray(pcm)) {
    // Float32Array[]：按声道分离存放，取第一声道（内置链路是单声道）
    if (pcm.length > 1) console.warn(`[Main] 插件返回 ${pcm.length} 声道，内置链路仅取第一声道`);
    mono = pcm[0];
  } else if (result.channels > 1) {
    // 交错存放：抽取出第 0 声道
    const frames = Math.floor(pcm.length / result.channels);
    mono = new Float32Array(frames);
    for (let i = 0; i < frames; i++) mono[i] = pcm[i * result.channels];
    console.warn(`[Main] 插件返回 ${result.channels} 声道交错数据，内置链路仅取第一声道`);
  } else {
    mono = pcm;
  }

  if (!(mono instanceof Float32Array)) return { ok: false, error: '插件返回的音频不是 Float32Array' };

  if (Number.isFinite(expectedSampleRate) && result.sampleRate !== expectedSampleRate) {
    // 不做重采样（会引入额外分配与延迟），只记录：调用方应让插件输出工程采样率。
    console.warn(`[Main] 插件采样率 ${result.sampleRate} 与工程采样率 ${expectedSampleRate} 不一致，按原样返回`);
  }

  const leading = Number.isInteger(result.leadingSamples) ? result.leadingSamples : 0;
  if (leading > 0) {
    const padded = new Float32Array(leading + mono.length);
    padded.set(mono, leading);
    mono = padded;
  }

  return { ok: true, audio: mono, sampleRate: result.sampleRate, diagnostics: result.diagnostics || null };
}

/**
 * 插件后端合成（svsIpc 的透传入口）。
 *
 * 关键点：`options` 原样（**同一个对象引用**）交给插件，不克隆、不挑字段，
 * 因此 svsIpc 注入的 language / onProgress / refF0Extractor 与渲染进程传来的
 * refAudioWavBuffer 等 Float32Array 都会完整到达插件。
 *
 * @param {object} args
 * @param {object} args.backend      {type:'plugin', pluginId, kindId, params, voiceId}
 * @param {Array}  [args.notes]
 * @param {number} [args.bpm]
 * @param {object} [args.options]    ★ 完整 options
 * @param {object} [args.sender]     事件推送目标（event.sender）
 * @param {string} [args.trackId]
 * @param {number} [args.sampleRate]
 * @returns {Promise<{ok:boolean, audio?:Float32Array, sampleRate?:number, diagnostics?:object|null, error?:string}>}
 */
async function runPluginBackend(args) {
  const input = args || {};
  const checked = validateBackend(input.backend);
  if (!checked.ok) return { ok: false, error: checked.error };

  const backend = checked.backend;
  await ensurePluginsLoaded();
  const sampleRate = Number.isFinite(input.sampleRate) ? input.sampleRate : undefined;

  const result = await getPluginHost().synthesize({
    pluginId: backend.pluginId,
    kindId: backend.kindId || null,
    trackId: input.trackId || backend.trackId || null,
    notes: input.notes,
    bpm: input.bpm,
    options: input.options,
    params: backend.params,
    voiceId: backend.voiceId || null,
    sampleRate,
    sender: input.sender || null,
  });

  if (!result || !result.success) {
    const err = result && result.error;
    return { ok: false, error: err && err.message ? err.message : '插件合成失败' };
  }
  return toBuiltinAudio(result, sampleRate);
}

function registerPluginIpc() {
  safeHandle(IPC_CHANNELS.PLUGIN_LIST, async () => {
    const result = await ensurePluginsLoaded();
    return {
      success: true,
      pluginsDir: getPluginHost().pluginsDir,
      plugins: result.plugins || getPluginHost().listPlugins(),
      errors: result.errors || [],
    };
  });

  safeHandle(IPC_CHANNELS.PLUGIN_RELOAD, async () => {
    invalidateLoadPromise();
    const result = await getPluginHost().reloadPlugins();
    return { success: true, pluginsDir: result.pluginsDir, plugins: result.plugins, errors: result.errors };
  });

  safeHandle(IPC_CHANNELS.PLUGIN_GET_VOICES, async (event, { pluginId, kindId } = {}) => {
    await ensurePluginsLoaded();
    return getPluginHost().getVoices(pluginId, kindId);
  });

  safeHandle(IPC_CHANNELS.PLUGIN_SYNTHESIZE, async (event, request = {}) => {
    await ensurePluginsLoaded();
    const result = await getPluginHost().synthesize({
      pluginId: request.pluginId,
      kindId: request.kindId,
      trackId: request.trackId,
      notes: request.notes,
      bpm: request.bpm,
      options: request.options, // ★ 同一引用
      params: request.params,
      voiceId: request.voiceId,
      sampleRate: request.sampleRate,
      scratch: request.scratch,
      sender: event.sender,
    });
    if (!result || !result.success) return result;
    // 过 IPC 前把多声道数组摊平成可序列化的形态（数组本身可序列化，
    // 这里只补齐字段，仍保持零拷贝语义——不复制样本数据）。
    return {
      success: true,
      pluginId: result.pluginId,
      pcm: result.pcm,
      channels: result.channels,
      sampleRate: result.sampleRate,
      leadingSamples: result.leadingSamples,
      diagnostics: result.diagnostics,
    };
  });

  safeHandle(IPC_CHANNELS.PLUGIN_CANCEL_TICKET, async (event, { ticketId } = {}) =>
    getPluginHost().requestTicketCancel(ticketId));

  safeHandle(IPC_CHANNELS.PLUGIN_GET_PLUGINS_DIR, async () => {
    const dir = getPluginHost().pluginsDir;
    if (!isPathAllowed(dir)) return { success: false, error: '插件目录未通过路径授权' };
    return { success: true, dir };
  });

  // 在系统文件管理器中打开插件目录。与 dialogIpc 的 shell:showItemInFolder 一致：
  // 先 isPathAllowed，再 shell.openPath —— 不接受渲染进程传入的任意路径。
  safeHandle(IPC_CHANNELS.PLUGIN_OPEN_PLUGINS_FOLDER, async () => {
    const dir = path.resolve(getPluginHost().pluginsDir);
    if (!isPathAllowed(dir)) return { success: false, error: '插件目录未通过路径授权' };
    try {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      console.warn('[Main] 创建插件目录失败：', err && err.message ? err.message : err);
    }
    // eslint-disable-next-line global-require
    const { shell } = require('electron');
    const opened = await shell.openPath(dir);
    // openPath 返回空串表示成功，否则是系统给出的错误描述
    return { success: !opened, dir, error: opened || '' };
  });
}

module.exports = {
  registerPluginIpc,
  runPluginBackend,
  ensurePluginsLoaded,
  invalidateLoadPromise,
  validateBackend,
  toBuiltinAudio,
};
