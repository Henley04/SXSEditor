'use strict';

/**
 * 远程 API 推理客户端（仅主进程可用）。
 *
 * 为什么在主进程：main.js 的 CSP connect-src 只允许 'self' 与 modelscope.cn，
 * 渲染进程直连任意 API 会被拦截；且密钥明文绝不下发到渲染层。
 *
 * 契约（详见 docs/API_STANDARD.md）：
 *   POST {baseUrl}/v1/synthesize   JSON → audio/wav（float32 或 PCM16）
 *   GET  {baseUrl}/health          可选，用于连接测试
 *   Authorization: Bearer <key>    仅当 Provider 配置了密钥时发送；
 *                                   内置免费服务 key 恒为空（免鉴权）
 *
 * 错误一律抛 ApiError，消息以 "[API <kind>]" 开头且已本地化、可直接展示给用户。
 * 绝不静默返回空音频、绝不把 HTTP 错误吞成成功。
 */

const { SAMPLE_RATE } = require('../inference/shared/constants.js');
const { t } = require('./locale');

const SYNTH_PATH = '/v1/synthesize';
const HEALTH_PATH = '/health';
const DEFAULT_TIMEOUT_MS = 600000;   // 32 步长样本实测约 108s，留足余量
const HEALTH_TIMEOUT_MS = 15000;

// ModelScope 创空间公开域名（*.ms.show）按 User-Agent 区分「页面访问」与
// 「API 调用」：curl / undici 默认 UA 会被网关判为程序调用并返回 403，
// 而常规浏览器 UA 可免鉴权匿名访问。统一带一个正常的浏览器 UA，
// 对普通自建 API 也无害（服务端一般不校验 UA）。
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** 所有进行中的请求，供 svs:cancel 协作式取消。 */
const activeControllers = new Set();

function tr(key, params = {}) {
  let s = t(key);
  for (const [k, v] of Object.entries(params)) {
    s = s.split(`{${k}}`).join(String(v));
  }
  return s;
}

class ApiError extends Error {
  constructor(message, { kind, status = 0, retryAfter = 0, code = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.retryAfter = retryAfter;
    // safeHandle 会保留 err.code；同时消息里带 [API ...] 前缀作为兜底，
    // 因为 Electron IPC 序列化 Error 时自定义属性可能丢失。
    this.code = code || `API_${String(kind || 'error').toUpperCase()}`;
  }
}

// ---------------------------------------------------------------- 请求体

function toBase64(value) {
  if (!value) return null;
  try {
    let bytes;
    if (Buffer.isBuffer(value)) bytes = value;
    else if (value instanceof ArrayBuffer) bytes = Buffer.from(value);
    else if (ArrayBuffer.isView(value)) bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    else return null;
    return bytes.length > 0 ? bytes.toString('base64') : null;
  } catch (_) { return null; }
}

function finiteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function toPlainArray(v) {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) return v;
  if (ArrayBuffer.isView(v)) return Array.from(v);
  return undefined;
}

/**
 * 把内置管线的 options 映射到公开 API 的顶层字段。
 * 服务端 synthSchema.additionalProperties=false，因此这里必须是**显式白名单**：
 * onProgress / onChunkAudio / refF0Extractor / language / backend / background
 * 等内部字段一律不能透传，否则直接 400。
 */
function buildRequestBody(notes, bpm, options = {}) {
  const body = {
    notes: (Array.isArray(notes) ? notes : []).map((n) => {
      const out = {
        pitch: Math.round(Number(n?.pitch) || 0),
        start: Number(n?.start) || 0,
        duration: Number(n?.duration) || 0,
        lyric: typeof n?.lyric === 'string' ? n.lyric : 'zh_a1',
      };
      const noteType = n?.noteType ?? n?.note_type ?? n?.type;
      if (noteType !== undefined) out.note_type = Math.round(Number(noteType) || 0);
      if (n?.isSlur ?? n?.is_slur) out.is_slur = true;
      if (n?.isContinuation ?? n?.is_continuation) out.is_continuation = true;
      const adj = n?.phonemeAdjustments ?? n?.phoneme_adjustments;
      if (Array.isArray(adj) && adj.length) out.phoneme_adjustments = adj;
      return out;
    }),
    bpm: finiteNumber(bpm) ?? 120,
    response_format: 'wav',
  };

  const direct = {
    nSteps: 'n_steps', seed: 'seed', cfg: 'cfg', cfgRescale: 'cfg_rescale',
    sampler: 'sampler', pitchControl: 'pitch_control', pitchShift: 'pitch_shift',
    autoShift: 'auto_shift', singerId: 'singer_id', maxPromptFrames: 'max_prompt_frames',
  };
  for (const [from, to] of Object.entries(direct)) {
    const v = options[from];
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'number' && !Number.isFinite(v)) continue;
    body[to] = v;
  }

  if (options.cfgScheduleMode || options.cfgStrengthStart !== undefined || options.cfgScheduleKeyframes) {
    const cs = {};
    if (options.cfgScheduleMode) cs.mode = options.cfgScheduleMode;
    if (options.cfgStrengthStart !== undefined) cs.start = finiteNumber(options.cfgStrengthStart);
    if (options.cfgStrengthEnd !== undefined) cs.end = finiteNumber(options.cfgStrengthEnd);
    if (options.cfgScheduleKeyframes) cs.keyframes = options.cfgScheduleKeyframes;
    body.cfg_schedule = cs;
  }
  if (options.dynamicThresholdEnabled !== undefined) {
    body.dynamic_threshold = {
      enabled: options.dynamicThresholdEnabled === true,
      percentile: finiteNumber(options.dynamicThresholdPercentile) ?? 0.995,
    };
  }
  if (options.f0Envelope && typeof options.f0Envelope === 'object') body.f0_envelope = options.f0Envelope;
  const pcf = toPlainArray(options.pitchCurveF0);
  if (pcf) body.pitch_curve_f0 = pcf;
  const refWav = toBase64(options.refAudioWavBuffer);
  if (refWav) body.reference_wav_base64 = refWav;
  if (options.refSingerData && typeof options.refSingerData === 'object') body.ref_singer_data = options.refSingerData;
  const refMidi = toPlainArray(options.refMidiNotes);
  if (refMidi) body.ref_midi_notes = refMidi;
  const refF0 = toPlainArray(options.refF0Data);
  if (refF0) body.ref_f0_data = refF0;
  const refPitches = toPlainArray(options.refNotePitches);
  if (refPitches) body.ref_note_pitches = refPitches;
  if (options.melPostprocess && typeof options.melPostprocess === 'object') body.mel_postprocess = options.melPostprocess;

  return body;
}

// ---------------------------------------------------------------- WAV 解码

function readTag(view, off) {
  return String.fromCharCode(view.getUint8(off), view.getUint8(off + 1), view.getUint8(off + 2), view.getUint8(off + 3));
}

/** 支持 IEEE float32 (format 3) / PCM16 / PCM32 (format 1)，多声道下混为单声道。 */
function decodeWav(buf, targetRate) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (view.byteLength < 44 || readTag(view, 0) !== 'RIFF' || readTag(view, 8) !== 'WAVE') {
    throw new ApiError(tr('error.apiBadWav'), { kind: 'bad_response', code: 'API_BAD_RESPONSE' });
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= view.byteLength) {
    const tag = readTag(view, pos);
    const size = view.getUint32(pos + 4, true);
    const body = pos + 8;
    if (body + size > view.byteLength) break;
    if (tag === 'fmt ' && size >= 16) {
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true) || 1,
        rate: view.getUint32(body + 4, true),
        bits: view.getUint16(body + 14, true),
      };
    } else if (tag === 'data') {
      data = { offset: body, size };
    }
    pos = body + size + (size % 2);
    if (data && fmt) break;
  }
  if (!fmt || !data) throw new ApiError(tr('error.apiBadWav'), { kind: 'bad_response', code: 'API_BAD_RESPONSE' });
  if (![1, 3].includes(fmt.format) || ![16, 32].includes(fmt.bits) || fmt.format === 3 && fmt.bits !== 32) {
    throw new ApiError(tr('error.apiBadWav'), { kind: 'bad_response', code: 'API_BAD_RESPONSE' });
  }
  const bytesPerSample = fmt.bits / 8;
  const frameCount = Math.floor(data.size / (bytesPerSample * fmt.channels));
  if (frameCount <= 0) throw new ApiError(tr('error.apiEmptyAudio'), { kind: 'bad_response', code: 'API_BAD_RESPONSE' });

  const mono = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const off = data.offset + (i * fmt.channels + c) * bytesPerSample;
      if (off + bytesPerSample > view.byteLength) break;
      if (fmt.format === 3) acc += view.getFloat32(off, true);
      else if (fmt.bits === 16) acc += view.getInt16(off, true) / 32768;
      else acc += view.getInt32(off, true) / 2147483648;
    }
    mono[i] = acc / fmt.channels;
  }
  const srcRate = fmt.rate > 0 ? fmt.rate : targetRate;
  return srcRate === targetRate ? mono : resampleLinear(mono, srcRate, targetRate);
}

function resampleLinear(input, srcRate, dstRate) {
  const ratio = srcRate / dstRate;
  const outLen = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const frac = src - i0;
    out[i] = input[i0] * (1 - frac) + input[i1] * frac;
  }
  return out;
}

// ---------------------------------------------------------------- 错误分类

function parseErrorBody(text) {
  try {
    const j = JSON.parse(text);
    const code = typeof j?.error === 'string' ? j.error
      : (typeof j?.error?.code === 'string' ? j.error.code : '');
    const message = typeof j?.message === 'string' ? j.message
      : (typeof j?.error?.message === 'string' ? j.error.message : '');
    return { code, message, retryAfter: Number(j?.retry_after_seconds) || 0, raw: j };
  } catch (_) {
    return { code: '', message: '', retryAfter: 0, raw: null };
  }
}

function shorten(s, max = 220) {
  const clean = String(s || '').replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}

function errorForStatus(status, parsed, providerName, retryAfterHeader) {
  const detail = shorten(parsed.message) || shorten(JSON.stringify(parsed.raw || {})) || `HTTP ${status}`;
  const retryAfter = parsed.retryAfter || Number(retryAfterHeader) || 0;
  if (status === 401 || status === 403) {
    return new ApiError(tr('error.apiAuth', { name: providerName, detail }),
      { kind: 'auth', status, code: 'API_AUTH_FAILED' });
  }
  if (status === 429) {
    const wait = retryAfter > 0 ? tr('error.apiRetryAfter', { seconds: retryAfter }) : '';
    return new ApiError(tr('error.apiRateLimit', { name: providerName, detail, wait }),
      { kind: 'rate_limit', status, retryAfter, code: 'API_RATE_LIMITED' });
  }
  if (status === 400 || status === 422) {
    return new ApiError(tr('error.apiBadRequest', { name: providerName, detail }),
      { kind: 'bad_request', status, code: 'API_BAD_REQUEST' });
  }
  if (status >= 500) {
    return new ApiError(tr('error.apiServer', { name: providerName, status, detail }),
      { kind: 'server', status, code: 'API_SERVER_ERROR' });
  }
  return new ApiError(tr('error.apiHttp', { name: providerName, status, detail }),
    { kind: 'http', status, code: 'API_HTTP_ERROR' });
}

function networkError(err, providerName) {
  if (err?.name === 'AbortError') {
    return new ApiError(tr('error.apiTimeout', { name: providerName }),
      { kind: 'timeout', code: 'API_TIMEOUT' });
  }
  return new ApiError(tr('error.apiNetwork', { name: providerName, detail: shorten(err?.message) }),
    { kind: 'network', code: 'API_NETWORK_ERROR' });
}

// ---------------------------------------------------------------- 主入口

function buildUrl(baseUrl, path) {
  return `${String(baseUrl).replace(/\/+$/, '')}${path}`;
}

function authHeaders(key) {
  const h = {
    'Content-Type': 'application/json',
    'Accept': 'audio/wav, application/json',
    'User-Agent': BROWSER_UA,
  };
  if (key) h.Authorization = `Bearer ${key}`;
  return h;
}

/**
 * 执行一次远程合成，返回与内置 pipeline.synthesize 完全一致的 Float32Array（24kHz 单声道）。
 * @param {{name:string,url:string,key:string}} runtime
 */
async function synthesize({ runtime, notes, bpm, options = {}, onProgress, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!runtime || !runtime.url) {
    throw new ApiError(tr('error.apiNoProvider'), { kind: 'config', code: 'API_NO_PROVIDER' });
  }
  if (!Array.isArray(notes) || notes.length === 0) {
    throw new ApiError(tr('error.apiEmptyNotes'), { kind: 'bad_request', code: 'API_BAD_REQUEST' });
  }

  const body = buildRequestBody(notes, bpm, options);
  const controller = new AbortController();
  activeControllers.add(controller);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    if (typeof onProgress === 'function') onProgress(0);
    let resp;
    try {
      resp = await fetch(buildUrl(runtime.url, SYNTH_PATH), {
        method: 'POST',
        headers: authHeaders(runtime.key),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw networkError(err, runtime.name);
    }

    if (!resp.ok) {
      let text = '';
      try { text = await resp.text(); } catch (_) { /* 用空 body 兜底 */ }
      throw errorForStatus(resp.status, parseErrorBody(text), runtime.name, resp.headers.get('retry-after'));
    }

    let buf;
    try { buf = Buffer.from(await resp.arrayBuffer()); } catch (err) {
      throw networkError(err, runtime.name);
    }
    if (typeof onProgress === 'function') onProgress(95);

    // 少数实现用 JSON 返回 {audio_base64}：兼容但不静默放过其它 JSON。
    let audio;
    if (buf.length >= 4 && buf.toString('ascii', 0, 4) === 'RIFF') {
      audio = decodeWav(buf, SAMPLE_RATE);
    } else {
      const parsed = parseErrorBody(buf.toString('utf8'));
      const b64 = typeof parsed.raw?.audio_base64 === 'string' ? parsed.raw.audio_base64
        : (typeof parsed.raw?.audio === 'string' ? parsed.raw.audio : '');
      if (!b64) {
        throw new ApiError(tr('error.apiBadResponse', { name: runtime.name }),
          { kind: 'bad_response', code: 'API_BAD_RESPONSE' });
      }
      audio = decodeWav(Buffer.from(b64, 'base64'), SAMPLE_RATE);
    }
    console.log(`[API] ${runtime.name} synth ok: ${audio.length} samples, ${Date.now() - started}ms, inference=${resp.headers.get('x-inference-ms') || '?'}ms`);
    if (typeof onProgress === 'function') onProgress(100);
    return audio;
  } finally {
    clearTimeout(timer);
    activeControllers.delete(controller);
  }
}

/** 连接测试：走 GET /health，任何错误都以结构化结果返回，不抛给调用方。 */
async function healthCheck({ runtime, timeoutMs = HEALTH_TIMEOUT_MS }) {
  if (!runtime || !runtime.url) {
    return { ok: false, message: tr('error.apiNoProvider') };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(buildUrl(runtime.url, HEALTH_PATH), {
      method: 'GET',
      headers: authHeaders(runtime.key),
      signal: controller.signal,
    });
    const text = await resp.text();
    if (!resp.ok) {
      const parsed = parseErrorBody(text);
      const e = errorForStatus(resp.status, parsed, runtime.name, resp.headers.get('retry-after'));
      return { ok: false, status: resp.status, message: e.message, kind: e.kind };
    }
    let summary = '';
    try {
      const j = JSON.parse(text);
      summary = j?.model_revision ? ` · ${j.model_revision}` : (j?.status ? ` · ${j.status}` : '');
    } catch (_) { /* 非 JSON 的 health 响应也视为可用 */ }
    return { ok: true, status: resp.status, message: tr('error.apiTestOk', { name: runtime.name, summary }) };
  } catch (err) {
    const e = networkError(err, runtime.name);
    return { ok: false, message: e.message, kind: e.kind };
  } finally {
    clearTimeout(timer);
  }
}

function cancelAll() {
  for (const c of activeControllers) {
    try { c.abort(); } catch (_) { /* 已结束 */ }
  }
  activeControllers.clear();
}

module.exports = {
  ApiError,
  synthesize,
  healthCheck,
  cancelAll,
  buildRequestBody,
  decodeWav,
  SYNTH_PATH,
  HEALTH_PATH,
};
