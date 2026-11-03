'use strict';

/**
 * 模型调用面的公共契约（CJS，主进程 / 渲染层 / 插件 runtime 共用）。
 *
 * 为什么单独抽一份：task 集合、locality 判定、错误码这三样东西，主进程的网关要判，
 * 渲染层的设置页要显示，插件作者的 SDK 要按它分支。三处各写一遍必然漂移——
 * 最典型的后果是"设置页说这个端点是本地，网关判它需要授权"，用户点了允许还弹窗。
 *
 * 冻结原则同 pluginApi.js：只增不改。破坏性调整必须升 API_VERSION。
 */

/** 基础 task 封闭集合。加一个 = 宿主发版（每个 task 对应一套编解码与校验）。 */
const TASKS = Object.freeze([
  'chat',          // 文本进、文本流式出
  'completion',    // 文本进、文本出（非对话）
  'embed',         // 文本进、向量出
  'midi',          // 结构化输入、MIDI 事件出
  'accompaniment', // 旋律/和弦进、音频轨出
  'singing',       // 歌词+音高进、歌声波形出（现有 synthesis.backend 投影）
  'tts',           // 文本进、音频出
  'asr',           // 音频进、文本出
]);

/** 端点的网络位置分类。决定是否免确认，见设计方案 §12.5。 */
const LOCALITIES = Object.freeze(['device', 'lan', 'cloud']);

/** 协议族（宿主实现，封闭集合）。插件只能指认，不能自定义。 */
const ADAPTERS = Object.freeze(['openai-compatible', 'anthropic', 'local-process']);

/**
 * 各 adapter 能处理的 task 基线。
 *
 * 故意不做成"端点上勾选支持哪些 task"（那是两套真相：勾了却绑不上，绑上了却没勾）。
 * 路由以 binding 为准；显式指定 endpointId 时用这张表判断"这个协议到底能不能干这活"。
 */
const ADAPTER_TASKS = Object.freeze({
  'openai-compatible': Object.freeze(['chat', 'completion', 'embed', 'tts', 'asr']),
  anthropic: Object.freeze(['chat', 'completion']),
  'local-process': Object.freeze(['singing', 'midi', 'accompaniment', 'tts', 'asr']),
});

/** 端点归属。决定卸载级联与 `provider:` scope 的来源隔离。 */
const OWNERS = Object.freeze(['builtin', 'plugin', 'user']);

/** 授权决定。没有记录时等效 ask。 */
const DECISIONS = Object.freeze(['allow', 'deny', 'ask']);

/** 授权持久化范围。默认按钮落在 session，不是 always。 */
const SCOPES = Object.freeze(['once', 'session', 'always']);

/** 流式事件类型。终止事件恰好一个：done / error / cancelled。 */
const EVENTS = Object.freeze({
  START: 'start',
  CHUNK: 'chunk',
  PROGRESS: 'progress',
  DONE: 'done',
  ERROR: 'error',
  CANCELLED: 'cancelled',
  /** 调用方回执，用于背压。 */
  ACK: 'ack',
});

/** 终止事件集合，网关据此判断"流已关闭"。 */
const TERMINAL_EVENTS = Object.freeze(['done', 'error', 'cancelled']);

/** 错误码。渲染层与 agent 都按它分支，不要靠 message 文本判。 */
const ERR = Object.freeze({
  NEED_ENDPOINT: 'NEED_ENDPOINT',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  CONSENT_REQUIRED: 'CONSENT_REQUIRED',
  CONSENT_TIMEOUT: 'CONSENT_TIMEOUT',
  TIMEOUT: 'TIMEOUT',
  BACKPRESSURE_OVERFLOW: 'BACKPRESSURE_OVERFLOW',
  PROTOCOL_VIOLATION: 'PROTOCOL_VIOLATION',
  HANDLE_EXPIRED: 'HANDLE_EXPIRED',
  ADAPTER_UNSUPPORTED: 'ADAPTER_UNSUPPORTED',
  ENDPOINT_UNAVAILABLE: 'ENDPOINT_UNAVAILABLE',
  INVALID_REQUEST: 'INVALID_REQUEST',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  UPSTREAM_ERROR: 'UPSTREAM_ERROR',
  CANCELLED: 'CANCELLED',
});

/**
 * 各 task 的输入输出契约。
 *
 * `input` / `output` 决定网关怎么搬运数据，`maxInputBytes` 决定"将发送"弹窗里那个
 * 数字的上限（超过就直接拒，不弹窗——用户没法对 50MB 的未知数据做判断）。
 * `streaming` 假的 task 仍然走同一条流，只是正常只会有一个 chunk。
 */
const TASK_SPECS = Object.freeze({
  chat: { input: 'text', output: 'stream-text', maxInputBytes: 1 << 20, streaming: true },
  completion: { input: 'text', output: 'stream-text', maxInputBytes: 1 << 20, streaming: true },
  embed: { input: 'text', output: 'json', maxInputBytes: 1 << 20, streaming: false },
  midi: { input: 'json', output: 'binary', maxInputBytes: 4 << 20, streaming: false },
  accompaniment: { input: 'json', output: 'binary', maxInputBytes: 8 << 20, streaming: false },
  singing: { input: 'json', output: 'binary', maxInputBytes: 8 << 20, streaming: false },
  tts: { input: 'text', output: 'binary', maxInputBytes: 256 << 10, streaming: true },
  asr: { input: 'binary', output: 'text', maxInputBytes: 64 << 20, streaming: true },
});

/** 统一限额。端点可以在 maxDuration 上**调小**，不能调大。 */
const LIMITS = Object.freeze({
  /** 无任何事件多久判超时（端点可覆写，MIDI/音频常几十秒无输出）。 */
  idleTimeoutMs: 60 * 1000,
  /** 单次调用总时长硬上限。 */
  maxDurationMs: 10 * 60 * 1000,
  /** chunk 合并窗口，约一帧。 */
  chunkFlushMs: 16,
  /** 背压：在途未确认 chunk 数上限。 */
  ackWindowChunks: 32,
  /** 背压：在途未确认字节上限。 */
  ackWindowBytes: 1 << 20,
  /** 内联二进制阈值，超过落盘走 file_ref。 */
  inlineBytes: 256 << 10,
  /** 去重窗口。 */
  dedupeWindowMs: 5 * 60 * 1000,
  /** 首次确认弹窗的等待上限。 */
  consentTimeoutMs: 30 * 1000,
  /** 连击合并窗口：同一主体 500ms 内的多次 ask 合成一个弹窗。 */
  consentCoalesceMs: 500,
  /** 句柄有效期。 */
  handleTtlMs: 60 * 60 * 1000,
  /** model-cache 总容量上限。 */
  cacheBytes: 512 << 20,
  /** 单次调用允许的最大 chunk 数（防止无限流占住管道）。 */
  maxChunks: 200000,
});

/** 端点 id：`<owner>:<ownerId>.<localId>`。 */
const ENDPOINT_ID_RE = /^(builtin|plugin|user):([A-Za-z0-9._-]{1,64})\.([A-Za-z0-9._-]{1,64})$/;

/**
 * 拼 endpoint id。ownerId 对 builtin 是模块名、对 plugin 是插件 id、对 user 是 uuid/别名。
 */
function endpointId(owner, ownerId, localId) {
  const id = `${owner}:${ownerId}.${localId}`;
  if (!ENDPOINT_ID_RE.test(id)) throw new Error(`非法 endpoint id：${id}`);
  return id;
}

function parseEndpointId(id) {
  const m = ENDPOINT_ID_RE.exec(String(id || ''));
  if (!m) return null;
  return { owner: m[1], ownerId: m[2], localId: m[3] };
}

/**
 * 判断某个 host 是否是回环地址。
 * 只认字面量与前缀，不做 DNS 解析——"localhost 解析到 127.0.0.1" 是运行期的事，
 * 判定必须离线完成，否则设置页会显示一个跟实际不一致的标签。
 */
function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  return /^127\./.test(h);
}

/** 私网（RFC1918 + 链路本地 + ULA）。这些**默认不算本地**，需用户显式标记。 */
function isPrivateHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (/^10\./.test(h)) return true;
  if (/^192\.168\./.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  if (h === '::' || /^f[cd][0-9a-f]{2}:/.test(h) || /^fe80:/.test(h)) return true;
  return false;
}

/**
 * 端点的 locality。
 * @param {{adapter?:string, baseUrl?:string, localityOverride?:string}} ep
 * @returns {'device'|'lan'|'cloud'}
 *
 * 优先级：用户显式 override > local-process > 回环 > 私网 > 公网。
 * 注意私网返回 cloud：内网服务器可能是别人管的、可能计费，不能自动信任。
 */
function localityOf(ep) {
  const o = ep && ep.localityOverride;
  if (o && LOCALITIES.includes(o)) return o;
  if (!ep) return 'cloud';
  if (ep.adapter === 'local-process') return 'device';
  let host = '';
  try {
    host = new URL(String(ep.baseUrl || '')).hostname;
  } catch (_) {
    return 'cloud';
  }
  if (isLoopbackHost(host)) return 'device';
  // 私网单独返回 lan，UI 据此提示"内网端点，需你确认是否计费"
  if (isPrivateHost(host)) return 'lan';
  return 'cloud';
}

/** 该 locality 是否默认免确认（仅 device）。 */
function isLocalityFree(locality) {
  return locality === 'device';
}

/** 校验一次调用请求的形状。返回错误字符串或 null。 */
function validateInvokeRequest(req) {
  if (!req || typeof req !== 'object') return '请求必须是对象';
  if (!TASKS.includes(req.task)) return `未知 task：${req.task}`;
  if (req.endpointId != null && !parseEndpointId(req.endpointId)) return `非法 endpointId：${req.endpointId}`;
  if (req.clientRequestId != null && String(req.clientRequestId).length > 128) return 'clientRequestId 过长';
  const spec = TASK_SPECS[req.task];
  const size = inputBytes(req.input);
  if (size > spec.maxInputBytes) return `输入过大：${size} > ${spec.maxInputBytes}`;
  return null;
}

/**
 * UTF-8 字节数。渲染层没有 Buffer，所以先试 TextEncoder —— 这个文件是三层共用的，
 * 任何一处直接摸 Buffer 都会在设置页里抛 ReferenceError。
 */
function utf8Bytes(str) {
  const s = String(str);
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
  if (typeof Buffer !== 'undefined') return Buffer.byteLength(s, 'utf8');
  return s.length * 3; // 最保守：按每字符 3 字节估，宁可高估
}

/**
 * 估算输入字节数（用于"将发送 N KB"与上限判断）。
 * 不做精算：字符串按 UTF-8 粗算、Buffer/TypedArray 按 byteLength、对象按 JSON 长度。
 */
function inputBytes(input) {
  if (input == null) return 0;
  if (typeof input === 'string') return utf8Bytes(input);
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(input)) return input.length;
  if (ArrayBuffer.isView(input)) return input.byteLength;
  if (input instanceof ArrayBuffer) return input.byteLength;
  try {
    return utf8Bytes(JSON.stringify(input));
  } catch (_) {
    return 0;
  }
}

module.exports = {
  TASKS,
  ADAPTER_TASKS,
  TASK_SPECS,
  LOCALITIES,
  ADAPTERS,
  OWNERS,
  DECISIONS,
  SCOPES,
  EVENTS,
  TERMINAL_EVENTS,
  ERR,
  LIMITS,
  ENDPOINT_ID_RE,
  endpointId,
  parseEndpointId,
  isLoopbackHost,
  isPrivateHost,
  localityOf,
  isLocalityFree,
  validateInvokeRequest,
  inputBytes,
};
