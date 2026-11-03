'use strict';

/**
 * OpenAI 兼容协议的 adapter。
 *
 * 为什么它是一等公民：ollama / vLLM / LM Studio / one-api / LiteLLM 以及绝大多数
 * 云端中转，全是这一套 `/chat/completions`。把它做扎实，80% 的"接一个模型"就只是
 * 填一个 baseUrl 加一把 key。
 *
 * 这个文件只负责"说话"，不负责鉴权与超时 —— 那些在网关里，且只有一处。
 */

const { ERR } = require('../../../shared/modelContract');

/** 可暂停的闸门：背压时网关调 pause，读循环在每次 read 前 await 它。 */
function createGate() {
  let resolve = null;
  let promise = null;
  return {
    pause() {
      if (!promise) promise = new Promise((r) => { resolve = r; });
    },
    resume() {
      if (promise) {
        const r = resolve;
        promise = null;
        resolve = null;
        if (r) r();
      }
    },
    wait() {
      return promise || Promise.resolve();
    },
  };
}

function joinUrl(base, path) {
  return `${String(base || '').replace(/\/+$/, '')}${path}`;
}

function normalizeChatMessages(input) {
  if (typeof input === 'string') return [{ role: 'user', content: input }];
  if (input && Array.isArray(input.messages)) return input.messages;
  if (input && typeof input.text === 'string') return [{ role: 'user', content: input.text }];
  throw new Error('chat 需要字符串或 { messages: [...] }');
}

function upstreamError(status, text) {
  return Object.assign(new Error(`上游返回 ${status}：${String(text || '').slice(0, 300)}`), {
    code: ERR.UPSTREAM_ERROR,
    // 4xx 里只有 429 值得重试；5xx 一律可重试
    retryable: status === 429 || status >= 500,
    details: { status },
  });
}

/**
 * @param {{fetchImpl?:Function, logger?:object}} [opts]
 */
function createOpenAICompatibleAdapter(opts = {}) {
  const doFetch = opts.fetchImpl || ((url, init) => globalThis.fetch(url, init));
  const log = opts.logger || console;

  async function readSSE(res, emit, gate, signal) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      await gate.wait();
      if (signal.aborted) {
        try { await reader.cancel(); } catch (_) { /* ignore */ }
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (!data) continue;
          if (data === '[DONE]') return;
          let json;
          try {
            json = JSON.parse(data);
          } catch (_) {
            log.warn('[models] 无法解析 SSE 分片，已跳过');
            continue;
          }
          const delta = json.choices && json.choices[0] && json.choices[0].delta;
          const text = delta && (delta.content != null ? delta.content : '');
          if (text) emit('chunk', { data: text, bytes: Buffer.byteLength(text, 'utf8') });
          if (json.usage) emit('progress', { usage: json.usage });
        }
      }
    }
  }

  /**
   * 二进制响应逐块下发。走同一条 gate，所以音频流也能被背压真正暂停 ——
   * TTS 的输出速度常常远快于一秒的播放进度，不暂停就是内存里堆整段音频。
   */
  async function pipeBinary(res, emit, gate, signal, mime) {
    if (!res.body || typeof res.body.getReader !== 'function') {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length) emit('chunk', { data: '', bytes: buf.length, binary: buf, mime });
      return;
    }
    const reader = res.body.getReader();
    for (;;) {
      await gate.wait();
      if (signal.aborted) {
        try { await reader.cancel(); } catch (_) { /* ignore */ }
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || !value.length) continue;
      // Buffer.from(Uint8Array) 是复制：reader 的块在下一轮可能被复用
      const buf = Buffer.from(value);
      emit('chunk', { data: '', bytes: buf.length, binary: buf, mime });
    }
  }

  return {
    name: 'openai-compatible',

    async invoke(ctx, emit, control) {
      const { endpoint, task, model, input, signal, secret } = ctx;
      const gate = createGate();
      // 交给网关：有了这两个函数，这条通道就是"可暂停"的，背压时真会停下读
      control.pause = () => gate.pause();
      control.resume = () => gate.resume();

      const headers = { 'content-type': 'application/json' };
      if (secret && endpoint.authKind !== 'none') headers.authorization = `Bearer ${secret}`;

      if (task === 'chat' || task === 'completion') {
        const messages = normalizeChatMessages(input);
        const extra = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
        const body = {
          model: model || (endpoint.models && endpoint.models[0]) || 'default',
          messages,
          stream: true,
          ...(extra.temperature != null ? { temperature: extra.temperature } : {}),
          ...(extra.maxTokens != null ? { max_tokens: extra.maxTokens } : {}),
        };
        const res = await doFetch(joinUrl(endpoint.baseUrl, '/chat/completions'), {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal,
        });
        if (!res.ok) throw upstreamError(res.status, await res.text().catch(() => ''));
        const ct = String(res.headers.get('content-type') || '');
        if (!/text\/event-stream/i.test(ct)) {
          // 有些兼容层无视 stream:true 直接返回整包 JSON
          const json = await res.json();
          const text = json.choices && json.choices[0] && json.choices[0].message
            ? json.choices[0].message.content
            : '';
          if (text) emit('chunk', { data: text, bytes: Buffer.byteLength(text, 'utf8') });
          return;
        }
        await readSSE(res, emit, gate, signal);
        return;
      }

      if (task === 'embed') {
        const inputArr = Array.isArray(input) ? input : [String(input || '')];
        const res = await doFetch(joinUrl(endpoint.baseUrl, '/embeddings'), {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: model || (endpoint.models && endpoint.models[0]) || 'default',
            input: inputArr,
          }),
          signal,
        });
        if (!res.ok) throw upstreamError(res.status, await res.text().catch(() => ''));
        const json = await res.json();
        for (const row of json.data || []) {
          const text = JSON.stringify(row.embedding || []);
          emit('chunk', { data: text, bytes: Buffer.byteLength(text, 'utf8') });
        }
        return;
      }

      if (task === 'tts') {
        const text = typeof input === 'string' ? input : String((input && (input.text || input.input)) || '');
        if (!text) throw Object.assign(new Error('tts 需要非空文本'), { code: ERR.INVALID_REQUEST });
        const res = await doFetch(joinUrl(endpoint.baseUrl, '/audio/speech'), {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model: model || (endpoint.models && endpoint.models[0]) || 'tts-1',
            input: text,
            voice: (input && input.voice) || endpoint.voice || 'alloy',
            ...(input && input.format ? { response_format: input.format } : {}),
          }),
          signal,
        });
        if (!res.ok) throw upstreamError(res.status, await res.text().catch(() => ''));
        const mime = String(res.headers.get('content-type') || 'audio/mpeg').split(';')[0].trim();
        // 200 + JSON 是这类中转最常见的错误表达（配额/模型名错），别当成音频存下来
        if (/application\/json/i.test(mime)) {
          const body = await res.json().catch(() => ({}));
          throw Object.assign(new Error(`上游未返回音频：${(body && (body.error || body.message)) || 'JSON 响应'}`), {
            code: ERR.UPSTREAM_ERROR,
            retryable: false,
          });
        }
        await pipeBinary(res, emit, gate, signal, mime);
        return;
      }

      if (task === 'asr') {
        const audio = Buffer.isBuffer(input) ? input : (input && input.audio);
        if (!audio || !audio.length) {
          throw Object.assign(new Error('asr 需要音频数据（{ handle } 或 Buffer）'), { code: ERR.INVALID_REQUEST });
        }
        const form = new FormData();
        form.append('file', new Blob([audio], { type: (input && input.mime) || 'audio/wav' }), 'audio.wav');
        form.append('model', model || (endpoint.models && endpoint.models[0]) || 'whisper-1');
        if (input && input.language) form.append('language', String(input.language));
        // multipart 的 boundary 由 fetch 自己算，这里**不能**带 content-type
        const { 'content-type': _drop, ...mpHeaders } = headers;
        const res = await doFetch(joinUrl(endpoint.baseUrl, '/audio/transcriptions'), {
          method: 'POST',
          headers: mpHeaders,
          body: form,
          signal,
        });
        if (!res.ok) throw upstreamError(res.status, await res.text().catch(() => ''));
        const json = await res.json();
        const text = json && (json.text != null ? json.text : (json.result && json.result.text));
        if (text != null) {
          emit('chunk', { data: String(text), bytes: Buffer.byteLength(String(text), 'utf8') });
        }
        return;
      }

      // midi / accompaniment / singing 在 OpenAI 兼容协议里没有标准端点，它们走
      // local-process 或由插件注册的端点。明确报不支持，不发半成品请求。
      const err = new Error(`openai-compatible adapter 不支持 task=${task}`);
      err.code = ERR.ADAPTER_UNSUPPORTED;
      throw err;
    },
  };
}

module.exports = { createOpenAICompatibleAdapter, joinUrl, normalizeChatMessages };
