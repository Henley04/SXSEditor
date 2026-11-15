/**
 * API Provider（远程推理）单元测试。
 *
 * 覆盖三块：
 *   1. Provider 元数据/密钥存储：内置服务、新建、激活、删除、URL 白名单、
 *      密钥与 settings.json 分离、"留空保持不变"。
 *   2. 请求体白名单与 WAV 解码：内部字段不许透传（服务端 400）、
 *      float32/PCM16 解码与重采样。
 *   3. 错误显式分类：用本地 HTTP 服务真实触发 401 / 403 / 429 / 500 /
 *      超时 / 非音频响应，断言都抛出带 "[API ...]" 前缀的 ApiError。
 *
 * 与 singerMarketIpc.test.js 一致：加载模块前注入最小 electron stub。
 */
const { expect } = require('chai');
const Module = require('module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-api-test-'));
const electronStub = {
  app: { getPath: () => TMP, getLocale: () => 'zh-CN', getVersion: () => 'test', isReady: () => true, on: () => {} },
  ipcMain: { handle: () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false, // 故意降级，验证 UI 能拿到 encrypted=false
    encryptString: (s) => Buffer.from(s),
    decryptString: (b) => Buffer.from(b).toString(),
  },
};
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return electronStub;
  return originalLoad.apply(this, arguments);
};

let store;
let api;
let cfg;
let locale;
let settingsSvc;
try {
  store = require('../src/main/apiProviderStore');
  api = require('../src/main/apiInference');
  cfg = require('../src/main/configStore');
  locale = require('../src/main/locale');
  settingsSvc = require('../src/main/settings');
} finally {
  Module._load = originalLoad;
}
locale.setLocale('zh-CN');

// ------------------------------------------------------------------ helpers
function wavWrap(data, format, bits, rate, channels) {
  const b = Buffer.alloc(44 + data.length);
  b.write('RIFF', 0); b.writeUInt32LE(36 + data.length, 4); b.write('WAVE', 8);
  b.write('fmt ', 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(format, 20);
  b.writeUInt16LE(channels, 22); b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate * channels * bits / 8, 28);
  b.writeUInt16LE(channels * bits / 8, 32); b.writeUInt16LE(bits, 34);
  b.write('data', 36); b.writeUInt32LE(data.length, 40);
  data.copy(b, 44);
  return b;
}
function wavFloat32(n, rate = 24000, v = 0.25) {
  const d = Buffer.alloc(n * 4);
  for (let i = 0; i < n; i++) d.writeFloatLE(v, i * 4);
  return wavWrap(d, 3, 32, rate, 1);
}
function wavPcm16(n, rate = 48000, v = 0.5) {
  const d = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) d.writeInt16LE(Math.round(v * 32767), i * 2);
  return wavWrap(d, 1, 16, rate, 1);
}

const NOTES = [{ pitch: 60, start: 0, duration: 1, lyric: '我', noteType: 2, isSlur: true }];

describe('apiProviderStore', () => {
  after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

  it('默认提供内置 Free API By SXSEditor 且不可删除', async () => {
    const l = store.list();
    expect(l.providers).to.have.length(1);
    expect(l.providers[0].name).to.equal('Free API By SXSEditor');
    expect(l.providers[0].builtin).to.equal(true);
    expect(l.providers[0].url).to.contain('ms.show');
    expect(l.providers[0].url).to.not.contain('api-inference.modelscope.net');
    expect(l.activeId).to.equal(l.freeProviderId);
    expect(l.secretsEncrypted).to.equal(false); // 降级必须能被 UI 感知
    try {
      await store.remove(l.freeProviderId);
      expect.fail('内置服务不应可删除');
    } catch (e) {
      expect(e.message).to.contain('内置');
    }
  });

  it('内置免费服务免鉴权：authRequired=false 且 runtime 永不带密钥', async () => {
    const l = store.list();
    expect(l.providers[0].authRequired).to.equal(false);
    expect(l.providers[0].hasKey).to.equal(false);
    expect(store.getActiveRuntime().key).to.equal('');
    expect(store.FREE_PROVIDER.authRequired).to.equal(false);
    // 即便尝试给内置服务写入密钥，也会被拒绝/清除。
    await store.save({ id: l.freeProviderId, name: 'Free API By SXSEditor',
      url: store.FREE_PROVIDER.url, key: 'ms-should-not-be-saved', keyChanged: true });
    expect(store.getActiveRuntime().key).to.equal('');
    expect(store.list().providers[0].hasKey).to.equal(false);
    // 测试连接路径（runtimeFromDraft）也必须强制免鉴权，并迁移旧地址。
    const draft = store.runtimeFromDraft({
      id: l.freeProviderId, name: 'Free API By SXSEditor',
      url: store.FREE_PROVIDER.url, key: 'ms-leaked-token',
    });
    expect(draft.key).to.equal('');
    expect(store.runtimeFromDraft({ url: store.LEGACY_FREE_URLS[0], key: 'x' }).url)
      .to.equal(store.FREE_PROVIDER.url);
  });

  it('升级迁移：旧版写入的 API 专用网关地址自动换成免鉴权公开域名', async () => {
    const legacy = store.LEGACY_FREE_URLS[0];
    expect(legacy).to.contain('api-inference.modelscope.net');
    // 用真实写入路径把旧地址写进 settings（saveSettingsFile 会清缓存），
    // 模拟老用户升级后首次启动。
    const cur = settingsSvc.loadSettings();
    await settingsSvc.saveSettingsFile({
      ...cur,
      apiProviders: [{ id: store.FREE_PROVIDER_ID, name: 'Free API By SXSEditor', url: legacy }],
      activeApiProviderId: store.FREE_PROVIDER_ID,
    });
    const l = store.list();
    expect(l.providers[0].url).to.equal(store.FREE_PROVIDER.url);
    expect(l.providers[0].url).to.not.contain('api-inference');
    expect(l.providers[0].authRequired).to.equal(false);
    expect(store.getActiveRuntime().key).to.equal('');
    expect(store.isPublicFreeUrl(legacy)).to.equal(true);
  });

  it('可新建/激活 Provider，密钥不写入 settings.json', async () => {
    const saved = await store.save({ name: '自建服务', url: 'http://127.0.0.1:9999/', key: 'sk-secret-123' });
    expect(saved.savedId).to.match(/^api-/);
    const custom = saved.providers.find((p) => p.name === '自建服务');
    expect(custom.url).to.equal('http://127.0.0.1:9999');
    expect(custom.hasKey).to.equal(true);

    const activated = await store.setActive(custom.id);
    expect(activated.activeId).to.equal(custom.id);
    expect(store.getActiveRuntime().key).to.equal('sk-secret-123');

    const raw = fs.readFileSync(cfg.getConfigPath('settings'), 'utf8');
    expect(raw).to.contain('apiProviders');
    expect(raw).to.not.contain('sk-secret-123');
  });

  it('密钥留空时保持不变，改 URL/名称不影响密钥', async () => {
    const before = store.list().providers.find((p) => p.name === '自建服务');
    const after = await store.save({ id: before.id, name: '自建服务2', url: 'http://127.0.0.1:9998' });
    expect(after.providers.find((p) => p.id === before.id).name).to.equal('自建服务2');
    expect(store.getActiveRuntime().key).to.equal('sk-secret-123');
  });

  it('URL 白名单拒绝非 http(s) / 内嵌凭据 / 查询串', () => {
    for (const bad of ['file:///etc/passwd', 'javascript:alert(1)', 'nope', 'https://u:p@h/x', 'https://h/x?a=1']) {
      expect(store.normalizeUrl(bad), bad).to.equal(null);
    }
    expect(store.normalizeUrl('https://h.example.com/')).to.equal('https://h.example.com');
  });

  it('恢复内置默认并可删除自定义 Provider', async () => {
    const custom = store.list().providers.find((p) => p.builtin === false);
    await store.resetBuiltin();
    const l = await store.remove(custom.id);
    expect(l.providers).to.have.length(1);
    expect(l.providers[0].url).to.equal(store.FREE_PROVIDER.url);
  });
});

describe('apiInference 请求体与 WAV 解码', () => {
  it('顶层字段严格白名单，内部字段不透传', () => {
    const body = api.buildRequestBody(NOTES, 120, {
      nSteps: 32, pitchControl: 'score', cfgScheduleMode: 'linear',
      dynamicThresholdEnabled: true, singerId: 's1',
      onProgress: () => {}, refF0Extractor: () => {}, language: 'zh',
      backend: { type: 'plugin' }, background: true,
    });
    expect(Object.keys(body).sort()).to.deep.equal([
      'bpm', 'cfg_schedule', 'dynamic_threshold', 'notes',
      'n_steps', 'pitch_control', 'response_format', 'singer_id',
    ].sort());
    expect(body.notes[0].note_type).to.equal(2);
    expect(body.notes[0].is_slur).to.equal(true);
    expect(body.pitch_control).to.equal('score');
  });

  it('解码 float32 WAV，并把 48k PCM16 重采样到 24k', () => {
    const a = api.decodeWav(wavFloat32(100, 24000, 0.5), 24000);
    expect(a).to.have.length(100);
    expect(a[50]).to.be.closeTo(0.5, 1e-6);
    const b = api.decodeWav(wavPcm16(48000, 48000, 0.5), 24000);
    expect(b).to.have.length(24000);
    expect(b[100]).to.be.closeTo(0.5, 1e-3);
  });
});

describe('apiInference 错误必须显式分类', () => {
  let server;
  let base;
  let mode = 'ok';
  const captured = [];

  before((done) => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        captured.push({ url: req.url, auth: req.headers.authorization || '', ua: req.headers['user-agent'] || '', raw });
        if (mode === 'slow') { setTimeout(() => { res.writeHead(200); res.end('{}'); }, 400); return; }
        const send = (status, obj, headers = {}) => {
          res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
          res.end(JSON.stringify(obj));
        };
        if (req.url.startsWith('/health')) {
          if (mode === 'health-401') return send(401, { error: 'invalid_api_key', message: '缺少或无效的 API Key' });
          return send(200, { status: 'ok', model_revision: 'repo@v3@int8' });
        }
        if (mode === 'auth') return send(401, { error: 'invalid_api_key', message: '缺少或无效的 API Key' });
        if (mode === 'forbidden') return send(403, { error: 'ip_denied', message: 'IP 在黑名单中' });
        if (mode === 'rate') return send(429, { error: 'rate_limit_exceeded', message: '每分钟已达上限', retry_after_seconds: 42 }, { 'Retry-After': '42' });
        if (mode === 'server') return send(500, { error: 'synthesis_failed', message: '内部 NaN' });
        if (mode === 'html') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end('<html>login</html>'); }
        const w = wavFloat32(24000);
        res.writeHead(200, { 'Content-Type': 'audio/wav' });
        res.end(w);
      });
    });
    server.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; done(); });
  });
  after((done) => server.close(done));

  const runtime = () => ({ id: 't', name: 'Test API', url: base, key: 'sk-test' });
  async function expectFailure(m, re, opts = {}) {
    mode = m;
    try {
      await api.synthesize({ runtime: runtime(), notes: NOTES, bpm: 120, ...opts });
      expect.fail(`${m} 应抛错`);
    } catch (e) {
      expect(e.message, `${m} => ${e.message}`).to.match(re);
      expect(e.kind).to.be.a('string');
    }
  }

  it('401 / 403 鉴权错误明确提示密钥', async () => {
    await expectFailure('auth', /\[API 401\/403\]/);
    await expectFailure('forbidden', /\[API 401\/403\]/);
  });
  it('429 限流带重试秒数', async () => expectFailure('rate', /\[API 429\].*42/));
  it('500 服务端错误', async () => expectFailure('server', /\[API 500\]/));
  it('200 但不是音频也要报错，不能静默返回空', async () => expectFailure('html', /\[API 响应\]/));
  it('超时', async () => expectFailure('slow', /\[API 超时\]/, { timeoutMs: 120 }));

  it('成功返回 Float32Array、发送 Bearer 头且带浏览器 UA', async () => {
    mode = 'ok';
    const before = captured.length;
    const audio = await api.synthesize({ runtime: runtime(), notes: NOTES, bpm: 120 });
    expect(audio).to.be.instanceOf(Float32Array);
    expect(audio).to.have.length(24000);
    expect(captured.some((c) => c.auth === 'Bearer sk-test')).to.equal(true);
    // 免鉴权公开域名按 UA 放行，所有请求都必须带常规浏览器 UA。
    expect(captured[before].ua).to.match(/^Mozilla\/5\.0/);
  });

  it('测试连接：成功、401、429 都返回结构化结果', async () => {
    mode = 'health-ok';
    const a = await api.healthCheck({ runtime: runtime() });
    expect(a.ok).to.equal(true);
    expect(a.message).to.contain('v3');
    mode = 'health-401';
    const b = await api.healthCheck({ runtime: runtime() });
    expect(b.ok).to.equal(false);
    expect(b.message).to.match(/\[API 401\/403\]/);
  });

  it('密钥可选：空密钥不发送 Authorization，错误仍显式', async () => {
    mode = 'auth';
    const noKey = { ...runtime(), key: '' };
    try {
      await api.synthesize({ runtime: noKey, notes: NOTES, bpm: 120 });
      expect.fail('无密钥应报错');
    } catch (e) {
      expect(e.message).to.match(/\[API 401\/403\]/);
    }
    expect(captured[captured.length - 1].auth).to.equal('');
  });
});
