'use strict';

/**
 * 契约 v1 的歌声后端（`src/main/pluginHost.js`）→ `local-process` adapter 的
 * `singing` 实现。
 *
 * 为什么不让网关直接调 v1 的 IPC：v1 后端本来就是"本机进程内的合成函数"，把它
 * 投影成一个端点之后，歌声、TTS、MIDI 走的是**同一条**调用面 —— 同一套授权、
 * 同一套超时、同一套审计、同一套取消。用户不再需要理解"这条轨走的是插件通道还是
 * 模型通道"。
 *
 * 边界：
 *   - 只做 `singing`。v1 的其它能力（blockPlayback / voices）不在这里；
 *   - v1 的合成是**原子**的，没有中间结果可暂停；取消只能在返回后丢弃，
 *     不做假取消（见 localProcess.js 的说明）；
 *   - 结果统一编码成 32bit float WAV（与 `cli.js` 的导出格式一致），
 *     不留 Float32Array 跨进程 —— 那样调用方还要懂 PCM 布局。
 */

const { ERR } = require('../../shared/modelContract');
const { encodeWav } = require('../../audio/wavEncoder');

/** 逐声道数组 → 交错；单声道原样返回。 */
function interleave(pcm, channels) {
  if (!Array.isArray(pcm)) return pcm;
  const n = pcm[0] ? pcm[0].length : 0;
  const out = new Float32Array(n * pcm.length);
  for (let ch = 0; ch < pcm.length; ch++) {
    const src = pcm[ch];
    for (let i = 0; i < n; i++) out[i * pcm.length + ch] = src[i];
  }
  return out;
}

/** 把 v1 的 SynthResult（pcm + leadingSamples + sampleRate）编成 WAV。 */
function synthResultToWav(result) {
  let data = interleave(result.pcm, result.channels);
  if (!data || typeof data.length !== 'number') {
    throw Object.assign(new Error('插件返回的 pcm 不可用'), { code: ERR.INVALID_RESPONSE });
  }
  const channels = Number(result.channels) > 1 ? 2 : 1;
  // leadingSamples：v1 把"相对请求起点要前置补零多少"交给宿主处理。
  // 不补的话，多片拼接会在第二个片起整体错位。
  const lead = Math.max(0, Math.trunc(Number(result.leadingSamples) || 0));
  if (lead > 0) {
    const padded = new Float32Array(data.length + lead * channels);
    padded.set(data, lead * channels);
    data = padded;
  }
  if (channels === 2 && data.length % 2 !== 0) {
    const padded = new Float32Array(data.length + 1);
    padded.set(data);
    data = padded;
  }
  return Buffer.from(encodeWav(data, Number(result.sampleRate) || 44100, channels, 32));
}

/**
 * 一个插件 → 一个 local-process 后端实现。
 * @param {{host:object, pluginId:string, logger?:object}} opts
 */
function createSynthesisBackend(opts) {
  const { host, pluginId } = opts;
  return {
    async run(ctx) {
      const input = (ctx && ctx.input) || {};
      const notes = input.notes;
      if (!Array.isArray(notes) || !notes.length) {
        throw Object.assign(new Error('singing 需要 { notes: [...] }'), { code: ERR.INVALID_REQUEST });
      }
      if (ctx.signal && ctx.signal.aborted) {
        throw Object.assign(new Error('已取消'), { code: ERR.CANCELLED });
      }
      const res = await host.synthesize({
        pluginId,
        kindId: input.kindId || null,
        trackId: null,
        notes,
        bpm: Number(input.bpm) || 120,
        options: input.options || {},
        params: input.params || {},
        voiceId: input.voiceId || null,
        sampleRate: Number(input.sampleRate) || 44100,
      });
      // 合成跑完才发现已被取消：结果直接丢，别把一段没人要的音频写进缓存
      if (ctx.signal && ctx.signal.aborted) {
        throw Object.assign(new Error('已取消'), { code: ERR.CANCELLED });
      }
      if (!res || res.success !== true) {
        const detail = (res && res.error) || {};
        throw Object.assign(new Error(detail.message || `插件合成失败：${pluginId}`), {
          code: ERR.UPSTREAM_ERROR,
          details: { pluginCode: detail.code, pluginId },
        });
      }
      return { binary: synthResultToWav(res), mime: 'audio/wav' };
    },
  };
}

/**
 * 让"已加载的 v1 歌声后端"在端点表里出现，并接到 local-process adapter 上。
 *
 * 幂等：每次插件重载后调一次即可。只有在端点确实不存在时才新建 —— 已存在的
 * 端点保留用户改过的标题，否则用户每次重载插件都会看到自己改的名字被冲掉。
 *
 * @param {{service:object, host:object, logger?:object}} opts
 */
function syncSynthesisEndpoints(opts) {
  const { service, host } = opts;
  const log = opts.logger || console;
  const out = { added: 0, removed: 0, kept: 0 };
  if (!service || !host || typeof host.listPlugins !== 'function') return out;

  let plugins = [];
  try {
    plugins = host.listPlugins() || [];
  } catch (err) {
    log.warn('[models] 读取歌声后端失败：', err && err.message);
    return out;
  }

  const wanted = new Map();
  for (const p of plugins) {
    if (!p || p.state !== 'ready') continue;
    if (!p.capabilities || p.capabilities.synthesize !== true) continue;
    // endpoint id 的 localId 段不允许出现歧义：插件 id 里的点换成横线，
    // 原值记在 localBackend 上，不靠反解 id 去猜。
    const localId = String(p.id).replace(/\./g, '-').slice(0, 64);
    const id = `builtin:singing.${localId}`;
    wanted.set(id, p);
    service.local.register(id, createSynthesisBackend({ host, pluginId: p.id }));
  }

  // 插件还没扫描过（返回空）时不能按"孤儿"清理：那会把用户上次装的后端端点
  // 连同绑定一起删掉，等下一次真正扫描时也回不来了。
  if (!plugins.length) return out;

  const existing = new Map(service.store.list().map((e) => [e.id, e]));
  for (const [id, p] of wanted) {
    if (existing.has(id)) {
      out.kept++;
      continue;
    }
    const r = service.store.upsert({
      id,
      title: `${p.name || p.id}（本地歌声）`,
      provider: 'local',
      adapter: 'local-process',
      localBackend: id,
      localityOverride: 'device',
      authKind: 'none',
    });
    if (r.ok) out.added++;
    else log.warn('[models] 歌声端点注册失败：', r.error);
  }

  // 插件被卸载/加载失败：端点留着但不可用比删掉更糟（用户会一直看到一条
  // 永远调不通的条目），所以这里连同绑定一起清掉。
  for (const id of existing.keys()) {
    if (!id.startsWith('builtin:singing.')) continue;
    if (wanted.has(id)) continue;
    service.removeEndpoint(id);
    out.removed++;
  }
  return out;
}

module.exports = { createSynthesisBackend, syncSynthesisEndpoints, synthResultToWav };
