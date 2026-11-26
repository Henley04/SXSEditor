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

const { SAMPLE_RATE, HOP_SIZE } = require('../inference/shared/constants.js');
const { t } = require('./locale');

const SYNTH_PATH = '/v1/synthesize';
const STREAM_PATH = '/v1/synthesize/stream';
const HEALTH_PATH = '/health';
const DEFAULT_TIMEOUT_MS = 600000;   // 32 步长样本实测约 108s，留足余量
const HEALTH_TIMEOUT_MS = 15000;

/**
 * 单次请求携带的音符上限。
 *
 * 服务端 schema 对 `notes` 有 maxItems（官方服务默认 256，见 MAX_NOTES），
 * 而编辑器里一个分片动辄几百个音符（长句 / 多字连唱），直接整段发过去会被
 * 400 拒绝：「notes must NOT have more than 256 items」。这里按 200 保守切片，
 * 留出余量给上限更小的自建服务；真正的上限以服务端报错为准（见
 * parseServerNoteLimit），命中后本次会话按服务端值重切。
 */
const DEFAULT_MAX_NOTES_PER_REQUEST = 200;
/** 音高曲线的帧率：pitchCurveF0 / melPostprocess 都是 50fps（20ms 一帧）。 */
const CURVE_FPS = SAMPLE_RATE / HOP_SIZE;

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

// ---------------------------------------------------------------- 分段（notes 上限）

function noteStart(n) {
  const v = Number(n?.start);
  return Number.isFinite(v) ? v : 0;
}

function noteEnd(n) {
  const d = Number(n?.duration);
  return noteStart(n) + (Number.isFinite(d) && d > 0 ? d : 0);
}

function noteLimitFor(runtime) {
  const n = Number(runtime?.maxNotes);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_MAX_NOTES_PER_REQUEST;
}

/**
 * 把整段 notes 切成「每片 ≤ limit 个音符」的连续时间片。
 *
 * 切点选择：在 [60% limit, limit] 范围内找相邻音符间隙最大的位置，并惩罚
 * 「下一音符是连音尾 / 滑音」的切点 —— 每片是独立推理，切在字中间会丢掉
 * 前文音素上下文，听起来像断字；切在自然停顿处几乎无损。
 *
 * 输入按 start 稳定排序（同一 start 保持原序），因为歌词 token 顺序由数组
 * 顺序决定；单段路径不排序，保证 ≤limit 时行为与改造前逐字一致。
 */
function splitNoteChunks(notes, limit) {
  const ordered = notes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => noteStart(a.n) - noteStart(b.n) || a.i - b.i)
    .map((x) => x.n);

  const chunks = [];
  let from = 0;
  while (from < ordered.length) {
    const maxEnd = Math.min(ordered.length, from + limit);
    let cut = maxEnd;
    if (maxEnd < ordered.length) {
      const lo = from + Math.max(1, Math.floor(limit * 0.6));
      let bestScore = -Infinity;
      for (let k = lo; k <= maxEnd; k++) {
        const prev = ordered[k - 1];
        const next = ordered[k];
        const gap = noteStart(next) - noteEnd(prev);
        const slurTail = next?.isSlur || next?.is_slur || next?.isContinuation || next?.is_continuation;
        // 间隙相同时偏向更靠后的切点（把片填满，少发一次请求）；1e-6 只做 tie-break。
        const score = gap - (slurTail ? 0.25 : 0) + k * 1e-6;
        if (score > bestScore) { bestScore = score; cut = k; }
      }
    }
    chunks.push(ordered.slice(from, cut));
    from = cut;
  }
  return chunks;
}

/** 从 400 的英文细节里抠出服务端真实的 notes 上限（拿不到返回 0）。 */
function parseServerNoteLimit(err) {
  if (!err || err.kind !== 'bad_request') return 0;
  const msg = String(err.message || '');
  const m = /more than\s+(\d+)\s+items/i.exec(msg)
    || /at most\s+(\d+)\s+items/i.exec(msg)
    || /最多\s*(\d+)\s*(?:个|条)?(?:音符|items)/i.exec(msg);
  const n = m ? Number(m[1]) : 0;
  return Number.isFinite(n) && n >= 1 ? n : 0;
}

/**
 * 把「整段坐标系」的可选参数裁到单个分片。
 *
 * 只有三类参数是绝对时间轴，必须跟着 baseBeat 平移 / 裁剪：
 *   - pitchCurveF0：50fps 的逐帧 F0（索引 0 = 绝对 beat 0）
 *   - f0Envelope.keyframes[].time：单位拍
 *   - melPostprocess：逐帧音色曲线，自带 startBeat 锚点
 * 其余（参考音频、参考歌手数据、采样参数）与时间轴无关，原样透传。
 */
function sliceOptionsForChunk(options, baseBeat, spanBeats, bpm) {
  const out = { ...options };
  const secPerBeat = 60 / (Number.isFinite(bpm) && bpm > 0 ? bpm : 120);

  const curve = options.pitchCurveF0;
  if (curve && (Array.isArray(curve) || ArrayBuffer.isView(curve))) {
    const fromFrame = Math.max(0, Math.round(baseBeat * secPerBeat * CURVE_FPS));
    const toFrame = Math.max(fromFrame + 2, Math.round((baseBeat + spanBeats) * secPerBeat * CURVE_FPS));
    const sliced = curve.slice(fromFrame, toFrame);
    if (sliced.length >= 2) out.pitchCurveF0 = sliced;
    else delete out.pitchCurveF0;
  }

  const env = options.f0Envelope;
  if (env && Array.isArray(env.keyframes) && env.keyframes.length) {
    const keyframes = env.keyframes
      .map((k) => ({ ...k, time: Number(k?.time) - baseBeat }))
      .filter((k) => Number.isFinite(k.time) && k.time >= -16 && k.time <= spanBeats + 16)
      .sort((a, b) => a.time - b.time);
    if (keyframes.length) out.f0Envelope = { ...env, keyframes };
    else delete out.f0Envelope;
  }

  const mp = options.melPostprocess;
  if (mp && typeof mp === 'object') {
    const shifted = shiftMelPostprocess(mp, baseBeat, spanBeats, secPerBeat);
    if (shifted) out.melPostprocess = shifted;
    else delete out.melPostprocess;
  }
  return out;
}

/** 音色曲线随分片平移：帧号 -from，锚点 startBeat 归零。越界帧按 0（不处理）补齐。 */
function shiftMelPostprocess(mp, baseBeat, spanBeats, fallbackSecPerBeat) {
  const mpBpm = Number(mp.bpm);
  const secPerBeat = Number.isFinite(mpBpm) && mpBpm > 0 ? 60 / mpBpm : fallbackSecPerBeat;
  const anchor = Number(mp.startBeat);
  const startBeat = Number.isFinite(anchor) ? anchor : 0;
  const from = Math.round((baseBeat - startBeat) * secPerBeat * CURVE_FPS);
  const frames = Math.max(1, Math.round(spanBeats * secPerBeat * CURVE_FPS) + 4);

  const sliceCurve = (src) => {
    if (!src) return undefined;
    const dst = new Array(frames);
    for (let i = 0; i < frames; i++) {
      const v = src[from + i];
      dst[i] = Number.isFinite(v) ? v : 0;
    }
    return dst;
  };
  const sigmaT = sliceCurve(mp.sigmaT);
  const sigmaF = sliceCurve(mp.sigmaF);
  const blend = sliceCurve(mp.blend);
  if (!sigmaT && !sigmaF && !blend) return null;

  const boundaries = Array.isArray(mp.boundaries)
    ? mp.boundaries.map((b) => Number(b) - from).filter((b) => Number.isFinite(b) && b > 0 && b < frames).sort((a, b) => a - b)
    : [];
  return {
    ...mp,
    startBeat: 0,
    frames,
    ...(sigmaT ? { sigmaT } : {}),
    ...(sigmaF ? { sigmaF } : {}),
    ...(blend ? { blend } : {}),
    boundaries,
  };
}

/** 把一个分片的音频叠加进总缓冲；段尾与下一段重叠时裁剪并做短淡出，避免双声与爆音。 */
function mixChunk(out, audio, offset, limit, sampleRate) {
  const avail = Math.max(0, Math.min(audio.length, limit - offset));
  if (avail <= 0) return;
  const fadeIn = Math.min(Math.round(0.002 * sampleRate), avail);
  const fadeOut = Math.min(Math.round(0.012 * sampleRate), avail);
  for (let i = 0; i < avail; i++) {
    let gain = 1;
    if (fadeIn > 0 && i < fadeIn) gain = i / fadeIn;
    if (fadeOut > 0 && i >= avail - fadeOut) gain = Math.min(gain, (avail - i) / fadeOut);
    out[offset + i] += audio[i] * gain;
  }
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
 * 单次远程合成（普通端点，等整段生成完再返回）。
 *
 * 进度只有 0 / 95 / 100 三档 —— 服务端在 HTTP 响应前无法回传中间状态。
 * 需要真实进度请走 _synthesizeOnceStreaming（synthesize 会优先尝试）。
 */
async function _synthesizeOncePlain({ runtime, notes, bpm, options = {}, onProgress, timeoutMs = DEFAULT_TIMEOUT_MS }) {
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

/**
 * 单次远程合成（流式端点）：把服务端 NDJSON 里的**真实推理进度**透传给 UI。
 *
 * 服务端不支持流式（旧版本 / 第三方实现）时抛 kind='stream_unsupported'，
 * 由 _synthesizeOnce 回退普通端点。回退只发生在「一个字节音频都没拿到」之前，
 * 401/429/500 等业务错误一律原样上抛，绝不重复消耗配额。
 */
async function _synthesizeOnceStreaming({ runtime, notes, bpm, options = {}, onProgress, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const body = buildRequestBody(notes, bpm, options);
  const controller = new AbortController();
  activeControllers.add(controller);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    if (typeof onProgress === 'function') onProgress(0);
    let resp;
    try {
      resp = await fetch(buildUrl(runtime.url, STREAM_PATH), {
        method: 'POST',
        headers: { ...authHeaders(runtime.key), Accept: 'application/x-ndjson' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw networkError(err, runtime.name);
    }

    const contentType = String(resp.headers.get('content-type') || '');
    if (!resp.ok || !contentType.includes('ndjson')) {
      let text = '';
      try { text = await resp.text(); } catch (_) { /* 用空 body 兜底 */ }
      // 404/405/501 = 服务端没有这个端点；200 但不是 ndjson = 被反代改写成页面。
      if (resp.status === 404 || resp.status === 405 || resp.status === 501 || (resp.ok && !contentType.includes('ndjson'))) {
        throw new ApiError('stream endpoint unavailable',
          { kind: 'stream_unsupported', status: resp.status, code: 'API_NO_STREAM' });
      }
      throw errorForStatus(resp.status, parseErrorBody(text), runtime.name, resp.headers.get('retry-after'));
    }

    const reader = resp.body && typeof resp.body.getReader === 'function' ? resp.body.getReader() : null;
    if (!reader) {
      throw new ApiError('stream body unavailable',
        { kind: 'stream_unsupported', status: resp.status, code: 'API_NO_STREAM' });
    }

    const decoder = new TextDecoder();
    let pending = '';
    let doneEvent = null;
    const handleEvent = (evt) => {
      if (!evt || typeof evt !== 'object') return;
      if (evt.type === 'progress') {
        const p = Number(evt.percent);
        if (typeof onProgress === 'function' && Number.isFinite(p)) {
          onProgress(Math.max(0, Math.min(100, Math.round(p))));
        }
      } else if (evt.type === 'error') {
        throw new ApiError(
          tr('error.apiStreamFail', { name: runtime.name, detail: shorten(evt.message) }),
          { kind: 'server', status: resp.status, code: 'API_SYNTHESIS_FAILED' },
        );
      } else if (evt.type === 'done') {
        doneEvent = evt;
      }
    };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, nl).trim();
          pending = pending.slice(nl + 1);
          if (!line) continue;
          let evt = null;
          try { evt = JSON.parse(line); } catch (_) { continue; }
          handleEvent(evt);
        }
      }
    } catch (err) {
      if (err instanceof ApiError) throw err;
      // 连接中断 / 超时 abort：给出可展示的网络或超时文案，而不是裸的 DOMException。
      throw networkError(err, runtime.name);
    }
    if (pending.trim()) {
      try {
        handleEvent(JSON.parse(pending.trim()));
      } catch (err) {
        if (err instanceof ApiError) throw err;
      }
    }

    if (!doneEvent || typeof doneEvent.audio_base64 !== 'string' || !doneEvent.audio_base64) {
      throw new ApiError(tr('error.apiBadResponse', { name: runtime.name }),
        { kind: 'bad_response', code: 'API_BAD_RESPONSE' });
    }
    const audio = decodeWav(Buffer.from(doneEvent.audio_base64, 'base64'), SAMPLE_RATE);
    console.log(`[API] ${runtime.name} stream ok: ${audio.length} samples, ${Date.now() - started}ms, inference=${doneEvent.inference_ms ?? '?'}ms`);
    if (typeof onProgress === 'function') onProgress(100);
    return audio;
  } finally {
    clearTimeout(timer);
    activeControllers.delete(controller);
  }
}

/** 单次合成：优先流式（真实进度），服务端不支持时回退普通端点。 */
async function _synthesizeOnce(params) {
  try {
    return await _synthesizeOnceStreaming(params);
  } catch (err) {
    if (err && err.kind === 'stream_unsupported') {
      return _synthesizeOncePlain(params);
    }
    throw err;
  }
}

/**
 * 切片合成：逐片串行请求后按绝对拍偏移叠回一条完整音轨。
 *
 * 串行而非并发：创空间是单卡 CPU 串行推理，并发只会排队 + 触发限流（20/min），
 * 还会让进度条乱跳。每片的 onProgress 折算到整体区间，用户看到的是单调进度。
 */
async function _synthesizeChunked({ runtime, notes, bpm, options, onProgress, timeoutMs, limit }) {
  const chunks = splitNoteChunks(notes, limit);
  const effBpm = Number.isFinite(bpm) && bpm > 0 ? bpm : 120;
  const secPerBeat = 60 / effBpm;
  const sr = SAMPLE_RATE;

  console.log(`[API] ${runtime.name}: ${notes.length} notes > ${limit}/request → ${chunks.length} chunks`);

  const parts = [];
  let totalSamples = 0;
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    let baseBeat = Infinity;
    let lastEnd = 0;
    for (const n of chunk) {
      baseBeat = Math.min(baseBeat, noteStart(n));
      lastEnd = Math.max(lastEnd, noteEnd(n));
    }
    if (!Number.isFinite(baseBeat)) baseBeat = 0;
    const spanBeats = Math.max(0.001, lastEnd - baseBeat);

    const shifted = chunk.map((n) => ({ ...n, start: noteStart(n) - baseBeat }));
    const chunkOptions = sliceOptionsForChunk(options, baseBeat, spanBeats, effBpm);
    const progressBase = ci / chunks.length;
    const chunkProgress = (p) => {
      if (typeof onProgress !== 'function') return;
      const c = Math.max(0, Math.min(100, Number(p) || 0));
      onProgress(Math.round((progressBase + (c / 100) / chunks.length) * 100));
    };

    const audio = await _synthesizeOnce({
      runtime,
      notes: shifted,
      bpm: effBpm,
      options: chunkOptions,
      onProgress: chunkProgress,
      timeoutMs,
    });
    const offset = Math.max(0, Math.round(baseBeat * secPerBeat * sr));
    parts.push({ audio, offset });
    totalSamples = Math.max(totalSamples, offset + audio.length);
  }

  const out = new Float32Array(totalSamples);
  for (let i = 0; i < parts.length; i++) {
    const nextOffset = i + 1 < parts.length ? parts[i + 1].offset : Infinity;
    mixChunk(out, parts[i].audio, parts[i].offset, nextOffset, sr);
  }
  if (typeof onProgress === 'function') onProgress(100);
  console.log(`[API] ${runtime.name} chunked synth ok: ${(totalSamples / sr).toFixed(2)}s audio, ${chunks.length} chunks`);
  return out;
}

/**
 * 远程合成入口：notes 超过单请求上限时自动切片 + 拼接。
 *
 * 上限来源优先级：Provider 自带 maxNotes → 服务端 400 报错里声明的值 → 默认 200。
 * 命中服务端更小上限时用 parseServerNoteLimit 学到的值重切一次（仅一次，避免死循环）。
 */
async function synthesize({ runtime, notes, bpm, options = {}, onProgress, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!runtime || !runtime.url) {
    throw new ApiError(tr('error.apiNoProvider'), { kind: 'config', code: 'API_NO_PROVIDER' });
  }
  if (!Array.isArray(notes) || notes.length === 0) {
    throw new ApiError(tr('error.apiEmptyNotes'), { kind: 'bad_request', code: 'API_BAD_REQUEST' });
  }

  const limit = noteLimitFor(runtime);
  const params = { runtime, notes, bpm, options, onProgress, timeoutMs };
  try {
    if (notes.length <= limit) {
      return await _synthesizeOnce(params);
    }
    return await _synthesizeChunked({ ...params, limit });
  } catch (err) {
    // 服务端声明的上限可能比默认值更小（自建服务 / MAX_NOTES 调低）：
    // 按它重新切一次，而不是把 400 直接甩给用户。
    const serverLimit = parseServerNoteLimit(err);
    if (serverLimit && serverLimit < notes.length) {
      console.warn(`[API] ${runtime.name}: server accepts ${serverLimit} notes/request, retry chunking`);
      return _synthesizeChunked({ ...params, limit: serverLimit });
    }
    throw err;
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
  // 分段：由 synthesize 内部使用，导出供单测直接验证切点与参数裁剪
  splitNoteChunks,
  sliceOptionsForChunk,
  parseServerNoteLimit,
  DEFAULT_MAX_NOTES_PER_REQUEST,
  SYNTH_PATH,
  HEALTH_PATH,
};
