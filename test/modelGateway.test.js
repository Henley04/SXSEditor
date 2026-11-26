const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { expect } = require('chai');

const { ERR, LIMITS } = require('../src/shared/modelContract');
const { ModelEndpointStore } = require('../src/main/models/ModelEndpointStore');
const { ModelAcl } = require('../src/main/models/ModelAcl');
const { ModelGateway } = require('../src/main/models/ModelGateway');
const { ModelAudit } = require('../src/main/models/ModelAudit');
const { ModelHandleStore } = require('../src/main/models/ModelHandleStore');

function memSecrets() {
  const m = new Map();
  return {
    map: m,
    get: (id) => (m.has(id) ? m.get(id) : null),
    set: (id, v) => m.set(id, v),
    delete: (id) => m.delete(id),
    isEncrypted: () => true,
  };
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-models-'));
}

const TERMINAL = new Set(['done', 'error', 'cancelled']);

/** 发起调用并等到终止事件。 */
function run(gw, subject, req, opts = {}) {
  return new Promise((resolve) => {
    const events = [];
    const handle = gw.invoke(subject, req, {
      ...opts,
      onEvent: (e) => {
        events.push(e);
        if (TERMINAL.has(e.type)) resolve({ events, handle });
      },
    });
    setTimeout(() => {
      if (!events.some((e) => TERMINAL.has(e.type))) resolve({ events, handle, timedOut: true });
    }, opts.waitMs || 3000);
  });
}

/** 可控的假 adapter：不碰网络，事件节奏由测试决定。 */
function fakeAdapter(fn) {
  return {
    name: 'fake',
    async invoke(ctx, emit, control) {
      return fn(ctx, emit, control);
    },
  };
}

function makeEnv(overrides = {}) {
  const dir = tmpDir();
  const secrets = memSecrets();
  const store = new ModelEndpointStore({ dir, secrets });
  const acl = new ModelAcl();
  const audit = new ModelAudit({});
  const adapter = fakeAdapter(async (ctx, emit) => {
    emit('chunk', { data: '你', bytes: 3 });
    emit('chunk', { data: '好', bytes: 3 });
  });
  const gw = new ModelGateway({
    store,
    acl,
    adapters: new Map([['openai-compatible', adapter]]),
    audit,
    consent: overrides.consent || (async () => 'session'),
    settings: { localFree: true, tokenBypass: new Map() },
  });
  store.upsert({
    id: 'user:local.7f3a',
    title: '测试端点',
    provider: 'example',
    adapter: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    secret: 'sk-test',
  });
  store.bind({ task: 'chat', endpointId: 'user:local.7f3a', isDefault: true });
  return { dir, secrets, store, acl, audit, gw, adapter };
}

describe('ModelEndpointStore', function () {
  it('密钥不进元数据文件，只有 hasSecret 标记', function () {
    const { store, dir, secrets } = makeEnv();
    expect(secrets.map.get('user:local.7f3a')).to.equal('sk-test');
    const raw = fs.readFileSync(path.join(dir, 'model-endpoints.json'), 'utf8');
    expect(raw).to.not.include('sk-test');
    expect(store.get('user:local.7f3a').hasSecret).to.equal(true);
  });

  it('校验 baseUrl / adapter / id', function () {
    const { store } = makeEnv();
    expect(store.upsert({ id: 'user:a.b', title: 'x', adapter: 'openai-compatible', baseUrl: 'ftp://x' }).ok).to.equal(false);
    expect(store.upsert({ id: 'user:a.b', title: 'x', adapter: 'grpc' }).ok).to.equal(false);
    expect(store.upsert({ id: 'bad-id', title: 'x', adapter: 'openai-compatible', baseUrl: 'http://x.dev' }).ok).to.equal(false);
  });

  it('绑定必须符合 adapter 能干的活', function () {
    const { store } = makeEnv();
    // openai-compatible 不该被绑到 midi 上：绑错了要到调用时才炸，错误还来自上游
    const r = store.bind({ task: 'midi', endpointId: 'user:local.7f3a' });
    expect(r.ok).to.equal(false);
    expect(store.bind({ task: 'chat', endpointId: 'user:local.7f3a', isDefault: true }).ok).to.equal(true);
  });

  it('同一 task 只有一个默认绑定', function () {
    const { store } = makeEnv();
    store.upsert({ id: 'user:second.a1', title: '备用', provider: 'example', adapter: 'openai-compatible', baseUrl: 'https://b.example.com', secret: 'k2' });
    store.bind({ task: 'chat', endpointId: 'user:second.a1', isDefault: true });
    const rows = store.listBindings('chat');
    expect(rows.filter((b) => b.isDefault)).to.have.length(1);
    expect(rows.find((b) => b.isDefault).endpointId).to.equal('user:second.a1');
  });

  it('没有默认端点时报 NEED_ENDPOINT，不自动挑第一个候选', function () {
    const { store } = makeEnv();
    store.upsert({ id: 'user:x.y', title: 'x', provider: 'custom', adapter: 'openai-compatible', baseUrl: 'https://x.dev', secret: 'k' });
    store.bind({ task: 'chat', endpointId: 'user:local.7f3a' }); // 无 isDefault
    store.setDefault('chat', 'user:local.7f3a');
    store.unbind('chat', 'user:local.7f3a');
    store.bind({ task: 'chat', endpointId: 'user:x.y' });
    const r = store.resolve('chat');
    expect(r.ok).to.equal(false);
    expect(r.error).to.equal(ERR.NEED_ENDPOINT);
    expect(r.candidates).to.include('user:x.y');
  });

  it('设置页快照带 baseUrl，调用方视图不带', function () {
    const { store } = makeEnv();
    // 设置页要拿它回填表单：不给的话编辑端点时地址是空的，保存要么被校验打回、
    // 要么把地址抹掉。插件 / MCP 走 list()，那里不该出现网络地址。
    const snap = store.snapshot().endpoints.find((e) => e.id === 'user:local.7f3a');
    expect(snap.baseUrl).to.equal('https://api.example.com/v1');
    const listed = store.listForCaller('plugin:x', null, { localFree: true })
      .find((e) => e.id === 'user:local.7f3a');
    expect(listed).to.be.an('object');
    expect(listed).to.not.have.property('baseUrl');
  });

  it('删除端点级联删绑定', function () {
    const { store } = makeEnv();
    const r = store.remove('user:local.7f3a');
    expect(r.ok).to.equal(true);
    expect(r.removedBindings).to.equal(1);
    expect(store.listBindings('chat')).to.have.length(0);
  });

  it('maxDuration 不允许超过宿主上限', function () {
    const { store } = makeEnv();
    const bad = store.upsert({
      id: 'user:long.a1', title: 'long', adapter: 'openai-compatible',
      baseUrl: 'https://l.example.com', secret: 'k', maxDurationMs: LIMITS.maxDurationMs + 1,
    });
    expect(bad.ok).to.equal(false);
    const ok = store.upsert({
      id: 'user:long.a2', title: 'long', adapter: 'openai-compatible',
      baseUrl: 'https://l.example.com', secret: 'k', maxDurationMs: 30000,
    });
    expect(ok.ok).to.equal(true);
  });

  it('能力发现：拒绝的端点不出现在列表里', function () {
    const { store, acl } = makeEnv();
    acl.setSubjectPolicy('plugin:bad', 'deny');
    expect(store.listForCaller('plugin:bad', acl)).to.have.length(0);
    const list = store.listForCaller('plugin:ok', acl);
    expect(list).to.have.length(1);
    expect(list[0].requiresConsent).to.equal(true);
    // 列表里不含 baseUrl：插件不需要知道用户的网络拓扑
    expect(list[0].baseUrl).to.equal(undefined);
  });
});

describe('ModelGateway', function () {
  it('正常流：start → chunk* → done，且只有一个终止事件', async function () {
    const { gw } = makeEnv();
    const { events } = await run(gw, 'plugin:demo', { task: 'chat', input: '你好' });
    expect(events[0].type).to.equal('start');
    expect(events[events.length - 1].type).to.equal('done');
    expect(events.filter((e) => TERMINAL.has(e.type))).to.have.length(1);
    const text = events.filter((e) => e.type === 'chunk').map((e) => e.data).join('');
    expect(text).to.equal('你好');
  });

  it('用户拒绝 → PERMISSION_DENIED，且不调 adapter', async function () {
    const { gw, store } = makeEnv({ consent: async () => 'deny' });
    let called = false;
    gw.adapters.set('openai-compatible', fakeAdapter(async () => { called = true; }));
    const { events } = await run(gw, 'plugin:demo', { task: 'chat', input: 'x' });
    const last = events[events.length - 1];
    expect(last.type).to.equal('error');
    expect(last.error.code).to.equal(ERR.PERMISSION_DENIED);
    expect(called).to.equal(false);
    expect(store.get('user:local.7f3a').id).to.equal('user:local.7f3a');
  });

  it('同意一次后（session）不再弹窗', async function () {
    let asked = 0;
    const { gw } = makeEnv({ consent: async () => { asked++; return 'session'; } });
    await run(gw, 'plugin:demo', { task: 'chat', input: 'a' });
    await run(gw, 'plugin:demo', { task: 'chat', input: 'b' });
    expect(asked).to.equal(1);
  });

  it('cancel 发出 cancelled，不是 error', async function () {
    const { gw } = makeEnv();
    gw.adapters.set('openai-compatible', fakeAdapter(async (ctx, emit) => {
      emit('chunk', { data: 'a', bytes: 1 });
      await new Promise((r) => setTimeout(r, 200));
    }));
    const events = [];
    const handle = gw.invoke('plugin:demo', { task: 'chat', input: 'x' }, { onEvent: (e) => events.push(e) });
    await new Promise((r) => setTimeout(r, 60));
    handle.cancel();
    await new Promise((r) => setTimeout(r, 120));
    const terminals = events.filter((e) => TERMINAL.has(e.type));
    expect(terminals).to.have.length(1);
    expect(terminals[0].type).to.equal('cancelled');
  });

  it('adapter 抛错 → error，且终止事件不重复', async function () {
    const { gw } = makeEnv();
    gw.adapters.set('openai-compatible', fakeAdapter(async () => {
      throw Object.assign(new Error('上游 500'), { code: ERR.UPSTREAM_ERROR, retryable: true });
    }));
    const { events } = await run(gw, 'plugin:demo', { task: 'chat', input: 'x' });
    const terminals = events.filter((e) => TERMINAL.has(e.type));
    expect(terminals).to.have.length(1);
    expect(terminals[0].error.code).to.equal(ERR.UPSTREAM_ERROR);
    expect(terminals[0].error.retryable).to.equal(true);
  });

  it('idle 超时按端点覆写生效', async function () {
    const { gw, store } = makeEnv();
    // 下限是 1s：防止插件把 idle 设成 1ms 把所有调用都掐死
    const up = store.upsert({
      id: 'user:local.7f3a', title: '测试端点', provider: 'example', adapter: 'openai-compatible',
      baseUrl: 'https://api.example.com/v1', secret: 'sk-test', idleTimeoutMs: 1000,
    });
    expect(up.ok).to.equal(true);
    gw.adapters.set('openai-compatible', fakeAdapter(async () => {
      await new Promise((r) => setTimeout(r, 3000));
    }));
    const { events } = await run(gw, 'plugin:demo', { task: 'chat', input: 'x' }, { waitMs: 4000 });
    const last = events[events.length - 1];
    expect(last.type).to.equal('error');
    expect(last.error.code).to.equal(ERR.TIMEOUT);
  });

  it('同一 clientRequestId 不重复调用上游', async function () {
    const { gw } = makeEnv();
    let calls = 0;
    gw.adapters.set('openai-compatible', fakeAdapter(async (ctx, emit) => {
      calls++;
      emit('chunk', { data: 'ok', bytes: 2 });
    }));
    const req = { task: 'chat', input: 'x', clientRequestId: 'req-1' };
    const first = await run(gw, 'plugin:demo', req);
    const second = await run(gw, 'plugin:demo', req);
    expect(calls).to.equal(1);
    expect(second.events.some((e) => e.replayed)).to.equal(true);
    expect(second.events.filter((e) => TERMINAL.has(e.type))).to.have.length(1);
    expect(first.events.filter((e) => e.type === 'chunk').map((e) => e.data).join('')).to.equal('ok');
  });

  it('失败不写入去重缓存：重试是真的重试', async function () {
    const { gw } = makeEnv();
    let calls = 0;
    gw.adapters.set('openai-compatible', fakeAdapter(async (ctx, emit) => {
      calls++;
      if (calls === 1) throw Object.assign(new Error('boom'), { code: ERR.UPSTREAM_ERROR });
      emit('chunk', { data: 'ok', bytes: 2 });
    }));
    const req = { task: 'chat', input: 'x', clientRequestId: 'req-2' };
    const a = await run(gw, 'plugin:demo', req);
    expect(a.events[a.events.length - 1].type).to.equal('error');
    const b = await run(gw, 'plugin:demo', req);
    expect(b.events[b.events.length - 1].type).to.equal('done');
    expect(calls).to.equal(2);
  });

  it('没有默认端点 → NEED_ENDPOINT，带候选', async function () {
    const { gw, store } = makeEnv();
    store.unbind('chat', 'user:local.7f3a');
    const { events } = await run(gw, 'plugin:demo', { task: 'chat', input: 'x' });
    const last = events[events.length - 1];
    expect(last.type).to.equal('error');
    expect(last.error.code).to.equal(ERR.NEED_ENDPOINT);
  });

  it('不可暂停的通道在缓冲超限时明确失败，而不是丢数据', async function () {
    const { gw } = makeEnv();
    // 不提供 control.pause → 网关识别为不可暂停；一直发 chunk 且消费方不 ack
    gw.adapters.set('openai-compatible', fakeAdapter(async (ctx, emit) => {
      for (let i = 0; i < 200; i++) {
        emit('chunk', { data: 'x'.repeat(8192), bytes: 8192 });
        await new Promise((r) => setTimeout(r, 18));
      }
    }));
    const { events } = await run(gw, 'plugin:demo', { task: 'chat', input: 'x' }, { waitMs: 6000 });
    const last = events[events.length - 1];
    expect(last.type).to.equal('error');
    expect(last.error.code).to.equal(ERR.BACKPRESSURE_OVERFLOW);
    expect(last.error.retryable).to.equal(false);
    expect(last.error.hint).to.equal('consumer_too_slow');
  });

  it('可暂停的通道会真的 pause，而不是失败', async function () {
    const { gw } = makeEnv();
    let paused = 0;
    gw.adapters.set('openai-compatible', fakeAdapter(async (ctx, emit, control) => {
      control.pause = () => { paused++; };
      control.resume = () => {};
      for (let i = 0; i < 60; i++) {
        emit('chunk', { data: 'x'.repeat(4096), bytes: 4096 });
        await new Promise((r) => setTimeout(r, 17));
      }
    }));
    const { events } = await run(gw, 'plugin:demo', { task: 'chat', input: 'x' }, { waitMs: 6000 });
    expect(paused).to.be.greaterThan(0);
    expect(events[events.length - 1].type).to.equal('done');
  });

  it('审计记下 invoke 与 consent，且不含输入内容', async function () {
    const { gw, audit } = makeEnv();
    await run(gw, 'plugin:demo', { task: 'chat', input: '这是一段很私密的歌词' });
    const rows = audit.list({ limit: 50 });
    const invoke = rows.find((r) => r.kind === 'invoke');
    expect(invoke.subject).to.equal('plugin:demo');
    expect(invoke.outcome).to.equal('done');
    expect(JSON.stringify(rows)).to.not.include('很私密');
  });
});

describe('二进制结果（midi / tts / singing / accompaniment）', function () {
  /** 专门造一个带句柄存储与二进制端点的环境。 */
  function makeBinaryEnv(runAdapter, task = 'tts') {
    const dir = tmpDir();
    const store = new ModelEndpointStore({ dir, secrets: memSecrets() });
    const acl = new ModelAcl();
    const audit = new ModelAudit({});
    const handles = new ModelHandleStore({ dir: path.join(dir, 'cache'), key: 'k'.repeat(64), logger: { warn() {} } });
    const adapter = fakeAdapter(runAdapter);
    const gw = new ModelGateway({
      store, acl, audit, handles,
      adapters: new Map([['openai-compatible', adapter], ['local-process', adapter]]),
      consent: async () => 'session',
      settings: { localFree: true, tokenBypass: new Map() },
    });
    store.upsert({
      id: 'user:local.audio', title: '音频端点', provider: 'custom',
      adapter: 'openai-compatible', baseUrl: 'https://api.example.com/v1', secret: 'k',
    });
    store.bind({ task, endpointId: 'user:local.audio', isDefault: true });
    return { dir, store, acl, audit, handles, gw };
  }

  it('小结果内联在 done 里，不产生句柄', async function () {
    const { gw, handles } = makeBinaryEnv(async (ctx, emit) => {
      emit('chunk', { data: '', bytes: 4, binary: Buffer.from([1, 2, 3, 4]), mime: 'audio/wav' });
    });
    const { events } = await run(gw, 'plugin:demo', { task: 'tts', input: 'hi' });
    const done = events.find((e) => e.type === 'done');
    expect(done.binary.size).to.equal(4);
    expect(done.binary.mime).to.equal('audio/wav');
    expect(done.binary.inline).to.equal(true);
    expect(Buffer.from(done.binary.base64, 'base64')).to.deep.equal(Buffer.from([1, 2, 3, 4]));
    expect(done).to.not.have.property('handle');
    expect(handles.snapshot()).to.have.length(0);
    // 二进制不该混进文本分片流
    expect(events.filter((e) => e.type === 'chunk')).to.have.length(0);
  });

  it('超过 256KB 落盘，done 给句柄，读回内容一致', async function () {
    const payload = Buffer.alloc(LIMITS.inlineBytes + 1024, 7);
    const { gw, handles } = makeBinaryEnv(async (ctx, emit) => {
      // 分三块发：验证拼接，而不是只支持单块
      const third = Math.floor(payload.length / 3);
      emit('chunk', { data: '', bytes: third, binary: payload.subarray(0, third) });
      emit('chunk', { data: '', bytes: third, binary: payload.subarray(third, third * 2) });
      emit('chunk', { data: '', bytes: payload.length - third * 2, binary: payload.subarray(third * 2) });
    });
    const { events } = await run(gw, 'plugin:demo', { task: 'tts', input: 'hi' });
    const done = events.find((e) => e.type === 'done');
    expect(done).to.not.have.property('binary');
    expect(done.handle.size).to.equal(payload.length);
    expect(done.handle.subject).to.equal('plugin:demo');
    expect(handles.usage()).to.equal(payload.length);
    const buf = handles.read(done.handle, 'plugin:demo');
    expect(buf.length).to.equal(payload.length);
    expect(buf[0]).to.equal(7);
  });

  it('句柄跨 subject 读取被拒，过期报 HANDLE_EXPIRED', async function () {
    const big = Buffer.alloc(LIMITS.inlineBytes + 10, 1);
    const { gw, handles } = makeBinaryEnv(async (ctx, emit) => {
      emit('chunk', { data: '', bytes: big.length, binary: big });
    });
    const { events } = await run(gw, 'plugin:demo', { task: 'tts', input: 'hi' });
    const h = events.find((e) => e.type === 'done').handle;

    let code = null;
    try { handles.read(h, 'plugin:other'); } catch (e) { code = e.code; }
    expect(code).to.equal(ERR.PERMISSION_DENIED);

    // host 可以读任何句柄
    expect(handles.read(h, 'host').length).to.equal(big.length);
  });

  it('output=binary 却收到文本 → INVALID_RESPONSE，不产出空结果', async function () {
    const { gw } = makeBinaryEnv(async (ctx, emit) => {
      emit('chunk', { data: '这不是音频', bytes: 12 });
    });
    const { events } = await run(gw, 'plugin:demo', { task: 'tts', input: 'hi' });
    const last = events[events.length - 1];
    expect(last.type).to.equal('error');
    expect(last.error.code).to.equal(ERR.INVALID_RESPONSE);
  });

  it('结果超上限 → RESULT_TOO_LARGE，且不可重试', async function () {
    const { gw } = makeBinaryEnv(async (ctx, emit) => {
      // 一块就越过上限：上限判断不能等全部收完
      emit('chunk', { data: '', bytes: 1, binary: Buffer.alloc(LIMITS.maxBinaryBytes + 1, 0) });
    });
    const { events } = await run(gw, 'plugin:demo', { task: 'tts', input: 'hi' }, { waitMs: 8000 });
    const last = events[events.length - 1];
    expect(last.type).to.equal('error');
    expect(last.error.code).to.equal(ERR.RESULT_TOO_LARGE);
    expect(last.error.retryable).to.equal(false);
  });

  it('asr 接受句柄作输入，读盘后换算成真实字节数', async function () {
    const { store, handles, gw } = makeBinaryEnv(async (ctx, emit) => {
      emit('chunk', { data: `收到 ${ctx.input.audio.length} 字节`, bytes: 1 });
    }, 'asr');
    store.bind({ task: 'asr', endpointId: 'user:local.audio', isDefault: true });
    const audio = Buffer.from('fake-wav-bytes');
    const h = handles.put({ subject: 'plugin:demo', jobId: 'seed', data: audio, mime: 'audio/wav' });
    const { events } = await run(gw, 'plugin:demo', { task: 'asr', input: { handle: h } });
    const text = events.filter((e) => e.type === 'chunk').map((e) => e.data).join('');
    expect(text).to.equal(`收到 ${audio.length} 字节`);
  });

  it('别人的句柄当输入 → PERMISSION_DENIED，不把内容读出来', async function () {
    const { handles, gw } = makeBinaryEnv(async () => {}, 'asr');
    const h = handles.put({ subject: 'plugin:other', jobId: 'seed', data: Buffer.from('x') });
    const { events } = await run(gw, 'plugin:demo', { task: 'asr', input: { handle: h } });
    const last = events[events.length - 1];
    expect(last.type).to.equal('error');
    expect(last.error.code).to.equal(ERR.PERMISSION_DENIED);
  });
});
