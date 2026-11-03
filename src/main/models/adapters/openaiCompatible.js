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

      // tts / asr / midi / accompaniment 需要二进制句柄与 multipart，随第 2 段
      // （ModelHandleStore）接入。现在明确报不支持，而不是发一个半成品请求出去。
      const err = new Error(`openai-compatible adapter 暂未实现 task=${task}`);
      err.code = ERR.ADAPTER_UNSUPPORTED;
      throw err;
    },
  };
}

module.exports = { createOpenAICompatibleAdapter, joinUrl, normalizeChatMessages };
