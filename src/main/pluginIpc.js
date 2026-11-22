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
 * 插件加载/重载完成后的回调（宿主用它在端点表里同步"本地歌声后端"）。
 * 只允许一个订阅者：这是内部接线，不是事件总线。
 */
let _afterLoad = null;

function setAfterPluginsLoaded(fn) {
  _afterLoad = typeof fn === 'function' ? fn : null;
}

function notifyAfterLoad(result) {
  if (!_afterLoad) return;
  try {
    _afterLoad(result);
  } catch (err) {
    console.warn('[plugins] afterLoad callback failed:', err && err.message);
  }
}

/**
 * 确保插件已扫描加载（幂等、并发安全）。
 * @returns {Promise<object>} pluginHost.loadPlugins() 的结果
 */
function ensurePluginsLoaded() {
  if (!_loadPromise) {
    _loadPromise = getPluginHost().loadPlugins().catch((err) => {
      console.error('[Main] Plugin scan failed:', err && err.message ? err.message : err);
      return { success: false, plugins: [], errors: [{ pluginId: null, stage: 'scan', message: String(err && err.message || err) }] };
    }).then((result) => {
      notifyAfterLoad(result);
      return result;
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
const MAX_PLUGIN_CHANNELS = 32;
const MAX_PLUGIN_AUDIO_SAMPLES = 30 * 60 * 48000; // 30 分钟 @48k 的硬上限

function _asFloat32Pcm(value, label) {
  if (value instanceof Float32Array) return value.slice();
  if (value instanceof ArrayBuffer) {
    if (value.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) {
      throw new TypeError(`${label} ArrayBuffer byteLength 不是 4 的整数倍`);
    }
    return new Float32Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    if (value instanceof DataView) throw new TypeError(`${label} 不支持 DataView`);
    const out = new Float32Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const n = Number(value[i]);
      if (!Number.isFinite(n)) throw new TypeError(`${label} 包含非有限数值`);
      out[i] = n;
    }
    return out;
  }
  if (Array.isArray(value)) {
    const out = new Float32Array(value.length);
    for (let i = 0; i < value.length; i++) {
      const n = Number(value[i]);
      if (!Number.isFinite(n)) throw new TypeError(`${label} 包含非有限数值`);
      out[i] = n;
    }
    return out;
  }
  throw new TypeError(`${label} 不是可识别的 PCM 类型`);
}

function _resampleLinear(input, fromRate, toRate) {
  if (fromRate === toRate) return input;
  const outLen = Math.max(0, Math.round(input.length * toRate / fromRate));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * fromRate / toRate;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = input[i0] || 0;
    const b = input[i0 + 1] === undefined ? a : input[i0 + 1];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

function toBuiltinAudio(result, expectedSampleRate) {
  const pcm = result.pcm;
  if (!pcm) return { ok: true, audio: new Float32Array(0), sampleRate: expectedSampleRate, diagnostics: result.diagnostics || null };

  const rate = Number(result.sampleRate);
  if (!Number.isInteger(rate) || rate < 8000 || rate > 384000) {
    return { ok: false, error: `插件返回的采样率非法：${result.sampleRate}` };
  }
  // 必须本来就是 number：Number('2') 会把字符串悄悄接受，掩盖插件协议错误。
  if (result.channels != null && typeof result.channels !== 'number') {
    return { ok: false, error: `插件返回的声道数类型非法：${typeof result.channels}` };
  }
  const channels = result.channels == null ? 1 : result.channels;
  if (!Number.isInteger(channels) || channels < 1 || channels > MAX_PLUGIN_CHANNELS) {
    return { ok: false, error: `插件返回的声道数非法：${result.channels}` };
  }

  try {
    // 平面声道数组：元素必须是 PCM 容器，而不是普通数值（普通数值数组按
    // 单声道/交错单声道处理，避免把 [0.1, 0.2] 误读成两个声道再取第一个）。
    const planar = Array.isArray(pcm) && pcm.length > 0
      && pcm.every(ch => ch instanceof Float32Array || ch instanceof ArrayBuffer || ArrayBuffer.isView(ch));
    let mono;
    if (planar) {
      if (pcm.length !== channels) {
        return { ok: false, error: `平面 PCM 声道数 ${pcm.length} 与声明的 ${channels} 不一致` };
      }
      const chans = pcm.map((ch, i) => _asFloat32Pcm(ch, `PCM 声道 ${i}`));
      const len = chans[0].length;
      if (chans.some(ch => ch.length !== len)) {
        return { ok: false, error: '平面 PCM 各声道长度不一致' };
      }
      mono = new Float32Array(len);
      for (const ch of chans) {
        for (let i = 0; i < len; i++) mono[i] += ch[i] / channels; // 下混，避免只取第 0 声道丢信号
      }
    } else {
      const flat = _asFloat32Pcm(pcm, 'PCM');
      if (channels > 1) {
        if (flat.length % channels !== 0) {
          return { ok: false, error: `交错 PCM 长度 ${flat.length} 不能被声道数 ${channels} 整除` };
        }
        const frames = flat.length / channels;
        mono = new Float32Array(frames);
        for (let f = 0; f < frames; f++) {
          let sum = 0;
          for (let c = 0; c < channels; c++) sum += flat[f * channels + c];
          mono[f] = sum / channels;
        }
      } else {
        mono = flat;
      }
    }

    const leading = result.leadingSamples == null ? 0 : Number(result.leadingSamples);
    if (!Number.isSafeInteger(leading) || leading < 0) {
      return { ok: false, error: `插件返回的 leadingSamples 非法：${result.leadingSamples}` };
    }

    // 在插件采样率域内先补 leading，再统一重采样到工程采样率，
    // 否则 leadingSamples 的时间含义会被错误缩放。
    const totalAtSource = leading + mono.length;
    const targetRate = Number.isInteger(expectedSampleRate) && expectedSampleRate > 0
      ? expectedSampleRate : rate;
    if (!Number.isSafeInteger(totalAtSource) || totalAtSource > MAX_PLUGIN_AUDIO_SAMPLES) {
      return { ok: false, error: `插件音频总长度 ${totalAtSource} 超出上限` };
    }
    let pcmFull = mono;
    if (leading > 0) {
      pcmFull = new Float32Array(totalAtSource);
      pcmFull.set(mono, leading);
    }
    const audio = _resampleLinear(pcmFull, rate, targetRate);
    if (audio.length > MAX_PLUGIN_AUDIO_SAMPLES) {
      return { ok: false, error: `重采样后音频长度 ${audio.length} 超出上限` };
    }
    return { ok: true, audio, sampleRate: targetRate, diagnostics: result.diagnostics || null };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : '插件音频归一化失败' };
  }
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
    notifyAfterLoad(result);
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
      console.warn('[Main] Failed to create plugin directory:', err && err.message ? err.message : err);
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
  setAfterPluginsLoaded,
  validateBackend,
  toBuiltinAudio,
};
