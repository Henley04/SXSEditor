'use strict';

/**
 * Anthropic Messages API 的 adapter。
 *
 * 与 OpenAI 的差别不只是路径：SSE 是 `event:` + `data:` 成对出现，增量在
 * `content_block_delta.delta.text`，结束是一个 `message_stop` 事件。照抄 OpenAI 的
 * 解析会得到一串空 chunk —— 这是接第二家协议时最常见的坑。
 */

const { ERR } = require('../../../shared/modelContract');

function createGate() {
  let resolve = null;
  let promise = null;
  return {
    pause() { if (!promise) promise = new Promise((r) => { resolve = r; }); },
    resume() {
      if (promise) {
        const r = resolve;
        promise = null;
        resolve = null;
        if (r) r();
      }
    },
    wait() { return promise || Promise.resolve(); },
  };
}

function createAnthropicAdapter(opts = {}) {
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
        let eventName = '';
        let data = '';
        for (const line of raw.split('\n')) {
          if (line.startsWith('event:')) eventName = line.slice(6).trim();
          else if (line.startsWith('data:')) data += line.slice(5).trim();
        }
        if (!data) continue;
        if (eventName === 'message_stop') return;
        let json;
        try {
          json = JSON.parse(data);
        } catch (_) {
          log.warn('[models] 无法解析 Anthropic SSE 分片');
          continue;
        }
        if (json.type === 'content_block_delta' && json.delta && json.delta.text) {
          emit('chunk', { data: json.delta.text, bytes: Buffer.byteLength(json.delta.text, 'utf8') });
        } else if (json.type === 'message_delta' && json.usage) {
          emit('progress', { usage: json.usage });
        }
      }
    }
  }

  return {
    name: 'anthropic',

    async invoke(ctx, emit, control) {
      const { endpoint, task, model, input, signal, secret } = ctx;
      const gate = createGate();
      control.pause = () => gate.pause();
      control.resume = () => gate.resume();

      if (task !== 'chat' && task !== 'completion') {
        const err = new Error(`anthropic adapter 不支持 task=${task}`);
        err.code = ERR.ADAPTER_UNSUPPORTED;
        throw err;
      }

      const extra = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
      const system = extra.system || (typeof input === 'object' ? input.system : '');
      const messages = Array.isArray(extra.messages)
        ? extra.messages
        : [{ role: 'user', content: typeof input === 'string' ? input : String(extra.text || '') }];

      const res = await doFetch(`${String(endpoint.baseUrl || '').replace(/\/+$/, '')}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'anthropic-version': '2023-06-01',
          ...(secret ? { 'x-api-key': secret } : {}),
        },
        body: JSON.stringify({
          model: model || (endpoint.models && endpoint.models[0]) || 'claude-3-5-sonnet-latest',
          max_tokens: extra.maxTokens || 4096,
          stream: true,
          ...(system ? { system } : {}),
          messages,
        }),
        signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw Object.assign(new Error(`上游返回 ${res.status}：${text.slice(0, 300)}`), {
          code: ERR.UPSTREAM_ERROR,
          retryable: res.status === 429 || res.status >= 500,
          details: { status: res.status },
        });
      }
      await readSSE(res, emit, gate, signal);
    },
  };
}

module.exports = { createAnthropicAdapter };
