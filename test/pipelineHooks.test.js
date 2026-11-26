const { expect } = require('chai');

const { PipelineHooks, setPipelineHookRunner, applyPipelineHooks } = require('../src/main/plugins/PipelineHooks');

function fakeService(plugins, impls) {
  return {
    // 与 PluginRegistry.hooksFor 同构：按 stage 过滤 + order/pluginId 排序
    registry: {
      hooksFor: (stage) => plugins
        .filter((p) => p.status === 'loaded')
        .flatMap((p) => (p.manifest.contributes.pipeline || [])
          .filter((h) => h.stage === stage)
          .map((h) => ({ ...h, pluginId: p.id })))
        .sort((a, b) => (a.order - b.order) || String(a.pluginId).localeCompare(String(b.pluginId))),
    },
    callPipelineHook(pluginId, hookId, payload) {
      const fn = impls[`${pluginId}.${hookId}`];
      if (!fn) throw new Error(`no hook ${pluginId}.${hookId}`);
      return fn(payload);
    },
  };
}

function plugin(id, hooks, status = 'loaded') {
  return { id, status, manifest: { contributes: { pipeline: hooks } } };
}

const quiet = { warn() {} };

describe('pipeline hook 执行器', function () {
  it('只收集 js + 指定 stage，按 order 排序', function () {
    const service = fakeService([
      plugin('b.plugin', [
        { stage: 'postWaveform', kind: 'js', hook: 'second', order: 200 },
        { stage: 'postMel', kind: 'js', hook: 'other', order: 1 },
        { stage: 'postWaveform', kind: 'model', model: 'x.onnx', order: 1 },
      ]),
      plugin('a.plugin', [{ stage: 'postWaveform', kind: 'js', hook: 'first', order: 100 }]),
      plugin('off.plugin', [{ stage: 'postWaveform', kind: 'js', hook: 'third', order: 1 }], 'disabled'),
    ]);
    const hooks = new PipelineHooks({ service, logger: quiet });
    const rows = hooks.collect('postWaveform');
    expect(rows.map((h) => `${h.pluginId}.${h.hook}`)).to.deep.equal(['a.plugin.first', 'b.plugin.second']);
  });

  it('按 order 依次执行，前一个的输出是后一个的输入', async function () {
    const calls = [];
    const service = fakeService([
      plugin('p1', [{ stage: 'postWaveform', kind: 'js', hook: 'gain', order: 1 }]),
      plugin('p2', [{ stage: 'postWaveform', kind: 'js', hook: 'plus', order: 2 }]),
    ], {
      'p1.gain': (p) => { calls.push('gain'); return p.audio.map((v) => v * 2); },
      'p2.plus': (p) => { calls.push('plus'); return p.audio.map((v) => v + 1); },
    });
    const hooks = new PipelineHooks({ service, logger: quiet });
    const out = await hooks.run('postWaveform', new Float32Array([1, 2]), { sampleRate: 24000 });
    expect(calls).to.deep.equal(['gain', 'plus']);
    expect([...out]).to.deep.equal([3, 5]);
  });

  it('hook 抛错被跳过，合成结果照常返回', async function () {
    const service = fakeService([
      plugin('p1', [{ stage: 'postWaveform', kind: 'js', hook: 'bad', order: 1 }]),
      plugin('p2', [{ stage: 'postWaveform', kind: 'js', hook: 'ok', order: 2 }]),
    ], {
      'p1.bad': () => { throw new Error('boom'); },
      'p2.ok': (p) => p.audio.map((v) => v + 10),
    });
    const hooks = new PipelineHooks({ service, logger: quiet });
    const out = await hooks.run('postWaveform', new Float32Array([1]), { sampleRate: 24000 });
    expect([...out]).to.deep.equal([11]);
  });

  it('改变样本数的 hook 被拒：时间轴不能错位', async function () {
    const service = fakeService([
      plugin('p1', [{ stage: 'postWaveform', kind: 'js', hook: 'trim', order: 1 }]),
    ], { 'p1.trim': () => new Float32Array([1, 2, 3]) });
    const hooks = new PipelineHooks({ service, logger: quiet });
    const out = await hooks.run('postWaveform', new Float32Array([1, 2]), { sampleRate: 24000 });
    expect([...out]).to.deep.equal([1, 2]);
    expect(hooks.snapshot()[0].fails).to.equal(1);
  });

  it('连续失败 3 次后熔断，不再调用；reset 后恢复', async function () {
    let calls = 0;
    const service = fakeService([
      plugin('p1', [{ stage: 'postWaveform', kind: 'js', hook: 'bad', order: 1 }]),
    ], { 'p1.bad': () => { calls++; throw new Error('boom'); } });
    const hooks = new PipelineHooks({ service, logger: quiet });
    for (let i = 0; i < 5; i++) await hooks.run('postWaveform', new Float32Array([1]), {});
    expect(calls).to.equal(3);
    expect(hooks.snapshot()[0].disabled).to.equal(true);

    hooks.reset();
    await hooks.run('postWaveform', new Float32Array([1]), {});
    expect(calls).to.equal(4);
  });

  it('没有注入执行器时 applyPipelineHooks 原样返回', async function () {
    const audio = new Float32Array([1, 2, 3]);
    setPipelineHookRunner(null);
    const out = await applyPipelineHooks('postWaveform', audio, {});
    expect(out).to.equal(audio);
  });

  it('执行器自身抛错也不影响出音频', async function () {
    const audio = new Float32Array([1]);
    setPipelineHookRunner(() => { throw new Error('runner down'); });
    const out = await applyPipelineHooks('postWaveform', audio, {});
    expect(out).to.equal(audio);
    setPipelineHookRunner(null);
  });
});

describe('与真实注册表的契约对齐', function () {
  const { PluginRegistry } = require('../src/main/plugins/PluginRegistry');

  it('registry.register("hook", …) 的条目形状正好是执行器要的', async function () {
    const registry = new PluginRegistry();
    registry.register('hook', 'p1:postWaveform:100', {
      stage: 'postWaveform', kind: 'js', hook: 'soften', order: 100, pluginId: 'p1',
    });
    registry.register('hook', 'p2:postWaveform:50', {
      stage: 'postWaveform', kind: 'js', hook: 'first', order: 50, pluginId: 'p2',
    });
    const service = {
      registry,
      callPipelineHook: (pluginId, hookId, payload) => (
        pluginId === 'p2' ? payload.audio.map((v) => v * 10) : payload.audio.map((v) => v + 1)
      ),
    };
    const hooks = new PipelineHooks({ service, logger: quiet });
    // order 50 在前：注册表已经按 order 排好，执行器不该再排一次
    expect(hooks.collect('postWaveform').map((h) => h.pluginId)).to.deep.equal(['p2', 'p1']);
    const out = await hooks.run('postWaveform', new Float32Array([1]), { sampleRate: 24000 });
    expect([...out]).to.deep.equal([11]);
  });

  it('停用插件（摘掉贡献）后 hook 立刻消失', function () {
    const registry = new PluginRegistry();
    registry.addPlugin({ id: 'p1', manifest: {}, dir: '/tmp', state: {} });
    registry.register('hook', 'p1:s:1', { stage: 'postWaveform', kind: 'js', hook: 'x', order: 1, pluginId: 'p1' });
    const service = { registry, callPipelineHook: () => new Float32Array(0) };
    const hooks = new PipelineHooks({ service, logger: quiet });
    expect(hooks.collect('postWaveform')).to.have.length(1);
    registry.removeContributions('p1');
    expect(hooks.collect('postWaveform')).to.have.length(0);
  });
});
