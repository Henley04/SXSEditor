const { expect } = require('chai');

const { createSynthesisBackend, syncSynthesisEndpoints, synthResultToWav } = require('../src/main/models/synthesisBackend');

/** 造一个最小可用的 v1 宿主桩。 */
function fakeV1Host(plugins, synthImpl) {
  return {
    listPlugins: () => plugins,
    synthesize: synthImpl || (async () => ({ success: true, pcm: new Float32Array([0.1, -0.1]), channels: 1, sampleRate: 24000, leadingSamples: 0 })),
  };
}

/** 造一个 ModelService 的最小子集（只用到 store / local / removeEndpoint）。 */
function fakeService() {
  const endpoints = new Map();
  const registered = new Map();
  return {
    endpoints,
    registered,
    local: { register: (id, impl) => registered.set(id, impl) },
    store: {
      list: () => [...endpoints.values()],
      upsert: (row) => {
        endpoints.set(row.id, { ...row, locality: 'device' });
        return { ok: true };
      },
    },
    removeEndpoint: (id) => { endpoints.delete(id); return { ok: true }; },
  };
}

function readWavHeader(buf) {
  return {
    riff: buf.slice(0, 4).toString('ascii'),
    wave: buf.slice(8, 12).toString('ascii'),
    channels: buf.readUInt16LE(22),
    sampleRate: buf.readUInt32LE(24),
    bits: buf.readUInt16LE(34),
    dataBytes: buf.readUInt32LE(40),
    size: buf.length,
  };
}

describe('synthesis.backend → local-process', function () {
  it('把 pcm 编成可解析的 WAV（32bit float）', function () {
    const wav = synthResultToWav({
      pcm: new Float32Array([0, 0.5, -0.5]), channels: 1, sampleRate: 24000, leadingSamples: 0,
    });
    const h = readWavHeader(wav);
    expect(h.riff).to.equal('RIFF');
    expect(h.wave).to.equal('WAVE');
    expect(h.channels).to.equal(1);
    expect(h.sampleRate).to.equal(24000);
    expect(h.bits).to.equal(32);
    expect(h.dataBytes).to.equal(3 * 4);
    expect(h.size).to.equal(44 + 3 * 4);
  });

  it('leadingSamples 在前面补零，不改变总时长以外的东西', function () {
    const wav = synthResultToWav({
      pcm: new Float32Array([1, 1]), channels: 1, sampleRate: 8000, leadingSamples: 2,
    });
    const h = readWavHeader(wav);
    expect(h.dataBytes).to.equal((2 + 2) * 4);
    // 前两个样本必须是 0
    expect(wav.readFloatLE(44)).to.equal(0);
    expect(wav.readFloatLE(48)).to.equal(0);
    expect(wav.readFloatLE(52)).to.equal(1);
  });

  it('逐声道数组按交错写入，双声道 WAV 的 blockAlign 对得上', function () {
    const wav = synthResultToWav({
      pcm: [new Float32Array([1, 0]), new Float32Array([0, 1])],
      channels: 2, sampleRate: 44100, leadingSamples: 0,
    });
    const h = readWavHeader(wav);
    expect(h.channels).to.equal(2);
    expect(h.dataBytes).to.equal(4 * 4);
    // L,R,L,R → 1,0,0,1
    expect(wav.readFloatLE(44)).to.equal(1);
    expect(wav.readFloatLE(48)).to.equal(0);
    expect(wav.readFloatLE(52)).to.equal(0);
    expect(wav.readFloatLE(56)).to.equal(1);
  });

  it('插件失败时抛 UPSTREAM_ERROR 并带上插件错误码', async function () {
    const host = fakeV1Host([], async () => ({ success: false, error: { code: 'PLUGIN_TIMEOUT', message: '超时了' } }));
    const impl = createSynthesisBackend({ host, pluginId: 'demo' });
    let err = null;
    try {
      await impl.run({ input: { notes: [{ pitch: 60 }] }, signal: { aborted: false } });
    } catch (e) { err = e; }
    expect(err).to.be.an('error');
    expect(err.code).to.equal('UPSTREAM_ERROR');
    expect(err.details.pluginCode).to.equal('PLUGIN_TIMEOUT');
  });

  it('notes 为空直接拒绝，不把空请求发给插件', async function () {
    const impl = createSynthesisBackend({ host: fakeV1Host([]), pluginId: 'demo' });
    let err = null;
    try { await impl.run({ input: {}, signal: { aborted: false } }); } catch (e) { err = e; }
    expect(err.code).to.equal('INVALID_REQUEST');
  });

  it('同步端点：已存在的保留用户改过的标题，不重复注册', function () {
    const service = fakeService();
    const host = fakeV1Host([
      { id: 'com.example.singer', name: '示例后端', state: 'ready', capabilities: { synthesize: true } },
    ]);
    const a = syncSynthesisEndpoints({ service, host });
    expect(a.added).to.equal(1);
    // 点被换成横线：endpoint id 的 localId 段不允许出现二义
    expect([...service.endpoints.keys()]).to.deep.equal(['builtin:singing.com-example-singer']);

    service.endpoints.get('builtin:singing.com-example-singer').title = '我改的名字';
    const b = syncSynthesisEndpoints({ service, host });
    expect(b.added).to.equal(0);
    expect(b.kept).to.equal(1);
    expect(service.endpoints.get('builtin:singing.com-example-singer').title).to.equal('我改的名字');
  });

  it('插件卸载后端点被清掉；但插件列表为空时不做孤儿清理', function () {
    const service = fakeService();
    const withPlugin = fakeV1Host([{ id: 'p1', name: 'P1', state: 'ready', capabilities: { synthesize: true } }]);
    syncSynthesisEndpoints({ service, host: withPlugin });
    expect(service.endpoints.size).to.equal(1);

    // 插件目录还在，但扫描结果为空：可能是还没加载，不能当作"全卸载"
    const empty = fakeV1Host([]);
    syncSynthesisEndpoints({ service, host: empty });
    expect(service.endpoints.size).to.equal(1);

    // 有插件但列表里没有这个后端 = 真的没了
    const other = fakeV1Host([{ id: 'p2', name: 'P2', state: 'ready', capabilities: { synthesize: true } }]);
    syncSynthesisEndpoints({ service, host: other });
    expect(service.endpoints.has('builtin:singing.p1')).to.equal(false);
    expect(service.endpoints.has('builtin:singing.p2')).to.equal(true);
  });

  it('未声明 synthesize 或加载失败的插件不注册端点', function () {
    const service = fakeService();
    const host = fakeV1Host([
      { id: 'no-cap', name: 'N', state: 'ready', capabilities: { synthesize: false } },
      { id: 'broken', name: 'B', state: 'failed', capabilities: { synthesize: true } },
    ]);
    const r = syncSynthesisEndpoints({ service, host });
    expect(r.added).to.equal(0);
    expect(service.endpoints.size).to.equal(0);
  });
});
