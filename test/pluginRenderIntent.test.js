const { expect } = require('chai');

const { buildRenderIntent, missingRenderPlugins } = require('../src/shared/pluginRenderIntent.js');
const { normalizeExtSchema } = require('../src/shared/pluginExt.js');
const { PipelineHooks } = require('../src/main/plugins/PipelineHooks.js');

const quiet = { warn() {} };

function fakeService(rows, impls = {}) {
  return {
    registry: {
      hooksFor: (stage) => rows
        .filter((h) => h.stage === stage)
        .slice()
        .sort((a, b) => (a.order - b.order) || String(a.pluginId).localeCompare(String(b.pluginId))),
    },
    callPipelineHook(pluginId, hookId, payload) {
      const fn = impls[`${pluginId}.${hookId}`];
      if (!fn) throw new Error(`no hook ${pluginId}.${hookId}`);
      return fn(payload);
    },
  };
}

const gain = (k) => (payload) => payload.audio.map((v) => v * k);

/**
 * 工程级渲染意图（`extSchema[*].render`）。
 *
 * 两态语义是这一层唯一需要记住的东西：
 *   · 工程没有任何 render 声明 → 装了的插件都生效（向后兼容）；
 *   · 工程有 render 声明 → 该 stage 变成白名单，顺序按工程给。
 *
 * 白名单这一条容易被当成"过严"，但反过来的失败模式更难查：一份明明写着
 * "我要 A 的淡入"的工程，换台机器多装一个插件，声音就不一样了 —— 而文件
 * 本身没有任何变化。
 */
describe('pluginRenderIntent — 从 extSchema 提取', () => {
  it('按 stage 分组，带上 order', () => {
    const intent = buildRenderIntent({
      'a.plugin': { render: { hook: 'postWaveform', order: 20 } },
      'b.plugin': { render: { hook: 'postWaveform', order: 5 } },
    });
    expect(intent).to.deep.equal({ postWaveform: { 'a.plugin': 20, 'b.plugin': 5 } });
  });

  it('order 缺省按 0 —— 与 registry 默认一致，不会排到最后', () => {
    const intent = buildRenderIntent({ a: { render: { hook: 'postWaveform' } } });
    expect(intent.postWaveform.a).to.equal(0);
  });

  it('没有 render 声明的插件不产生条目', () => {
    const intent = buildRenderIntent({
      a: { note: { x: { kind: 'text' } } },
      b: { render: { hook: 'postMel' } },
    });
    expect(intent).to.deep.equal({ postMel: { b: 0 } });
  });

  it('完全没有声明返回 null（调用方据此回到默认语义）', () => {
    expect(buildRenderIntent(null)).to.equal(null);
    expect(buildRenderIntent({})).to.equal(null);
    expect(buildRenderIntent({ a: {} })).to.equal(null);
    expect(buildRenderIntent('nope')).to.equal(null);
  });

  it('经过 normalizeExtSchema 之后仍然能提出来', () => {
    const schema = normalizeExtSchema({
      p: {
        render: { hook: 'postWaveform', order: 7 },
        curve: { interp: 'smooth' },
        note: { c: { kind: 'curve' } },
      },
    }, []);
    expect(buildRenderIntent(schema)).to.deep.equal({ postWaveform: { p: 7 } });
  });

  it('点名了但没装的插件能被查出来', () => {
    const intent = buildRenderIntent({ a: { render: { hook: 'postWaveform' } }, b: { render: { hook: 'postWaveform' } } });
    expect(missingRenderPlugins(intent, ['a'])).to.deep.equal(['b']);
    expect(missingRenderPlugins(intent, new Set(['a', 'b']))).to.deep.equal([]);
    expect(missingRenderPlugins(null, ['a'])).to.deep.equal([]);
  });
});

describe('PipelineHooks — 工程意图对执行链的影响', () => {
  const rows = [
    { stage: 'postWaveform', kind: 'js', hook: 'h1', order: 100, pluginId: 'p1' },
    { stage: 'postWaveform', kind: 'js', hook: 'h2', order: 50, pluginId: 'p2' },
    { stage: 'postMel', kind: 'js', hook: 'h3', order: 10, pluginId: 'p3' },
  ];

  it('没有意图时保持现状：装了的都跑', () => {
    const hooks = new PipelineHooks({ service: fakeService(rows), logger: quiet });
    expect(hooks.collect('postWaveform').map((h) => h.pluginId)).to.deep.equal(['p2', 'p1']);
  });

  it('有意图时变成白名单：只跑被点名的插件', () => {
    const hooks = new PipelineHooks({ service: fakeService(rows), logger: quiet });
    hooks.setRenderIntent({ postWaveform: { p1: 100 } });
    expect(hooks.collect('postWaveform').map((h) => h.pluginId)).to.deep.equal(['p1']);
  });

  it('工程给的 order 覆盖插件默认顺序', () => {
    const hooks = new PipelineHooks({ service: fakeService(rows), logger: quiet });
    hooks.setRenderIntent({ postWaveform: { p1: 10, p2: 99 } });
    expect(hooks.collect('postWaveform').map((h) => h.pluginId)).to.deep.equal(['p1', 'p2']);
    const out = hooks.run('postWaveform', new Float32Array([1]), { sampleRate: 24000 });
    return out;
  });

  it('意图只作用于被点名的 stage，别的 stage 不受影响', () => {
    const hooks = new PipelineHooks({ service: fakeService(rows), logger: quiet });
    hooks.setRenderIntent({ postWaveform: { p1: 100 } });
    expect(hooks.collect('postMel').map((h) => h.pluginId)).to.deep.equal(['p3']);
  });

  it('点名了未安装的插件：链为空，但合成照常（不抛）', async () => {
    const hooks = new PipelineHooks({ service: fakeService(rows), logger: quiet });
    hooks.setRenderIntent({ postWaveform: { ghost: 1 } });
    expect(hooks.collect('postWaveform')).to.deep.equal([]);
    const audio = new Float32Array([1, 2, 3]);
    const out = await hooks.run('postWaveform', audio, { sampleRate: 24000 });
    expect([...out]).to.deep.equal([1, 2, 3]);
  });

  it('传 null 回到默认语义（打开另一份没有声明的工程）', () => {
    const hooks = new PipelineHooks({ service: fakeService(rows), logger: quiet });
    hooks.setRenderIntent({ postWaveform: { p1: 1 } });
    hooks.setRenderIntent(null);
    expect(hooks.collect('postWaveform').map((h) => h.pluginId)).to.deep.equal(['p2', 'p1']);
  });

  it('非法 order 被丢弃，整个意图为空时回到默认', () => {
    const hooks = new PipelineHooks({ service: fakeService(rows), logger: quiet });
    hooks.setRenderIntent({ postWaveform: { p1: NaN } });
    expect(hooks.getRenderIntent()).to.equal(null);
    expect(hooks.collect('postWaveform').map((h) => h.pluginId)).to.deep.equal(['p2', 'p1']);
  });

  it('取到的意图是副本，改它不影响执行器', () => {
    const hooks = new PipelineHooks({ service: fakeService(rows), logger: quiet });
    hooks.setRenderIntent({ postWaveform: { p1: 10 } });
    const snap = hooks.getRenderIntent();
    snap.postWaveform.p2 = 1;
    expect(hooks.collect('postWaveform').map((h) => h.pluginId)).to.deep.equal(['p1']);
  });

  it('按工程顺序真的改变处理结果', async () => {
    const service = fakeService(rows, { 'p1.h1': gain(10), 'p2.h2': gain(3) });
    const hooks = new PipelineHooks({ service, logger: quiet });
    hooks.setRenderIntent({ postWaveform: { p1: 1, p2: 2 } });
    const out = await hooks.run('postWaveform', new Float32Array([1]), { sampleRate: 24000 });
    expect([...out]).to.deep.equal([30]); // 先 p1 ×10 再 p2 ×3
  });
});
