import { expect } from 'chai';
import {
  AUTO_PITCH_DEFAULTS,
  normalizeAutoConfig,
  sanitizeAutoParamPatch,
  paramsForPreset,
  buildNoteTraits,
  autoPitchAt,
  autoVibratoOffset,
  applyExpressionToF0,
  isManualVibrato,
  resolveAutoVibratoForNote,
  saltFromKey,
} from '../src/shared/autoPitchCurve.js';

/**
 * "人味"回归护栏（设计方案 §15）。
 *
 * 这一组测试防的不是"算错了"，而是**算对了但很机械**：
 *   · 每个长音都颤 / 每个跳进都过冲 / 每个音尾都下滑；
 *   · 颤音速率固定线性漂移、多轨完全同步抖动；
 *   · 自动颤音覆盖用户手设的颤音。
 * 每条用例都把"该有的差异"钉成可断言的数字，改坏了先在这里失败。
 */
describe('auto pitch — 逐音符人味（§15）', () => {
  const bpm = 120;
  const ranges = { min: 28, max: 88 };

  const BASE = {
    attackMs: 0,
    attackCents: 0,
    overshootProbability: 0,
    prepProbability: 0,
    prepCents: 0,
    jitterCents: 0,
    vibratoProbability: 0,
    glideMs: 0,
    microGlideMs: 0,
    releaseCents: 0,
    variation: 0,
  };

  function makeAuto(over = {}) {
    return normalizeAutoConfig({
      enabled: true,
      preset: 'custom',
      params: {
        ...AUTO_PITCH_DEFAULTS,
        ...BASE,
        ...over,
      },
    });
  }

  function makeCtx(notes, over = {}, seedSalt = 0) {
    return { sortedNotes: notes, auto: makeAuto(over), bpm, ranges, seedSalt };
  }

  const cents = (value, ref) => (value === null ? null : (value - ref) * 100);

  it('同一音符的特征确定；不同音符的幅度/相位不同（不是同一个模板）', () => {
    const notes = [
      { id: 1, pitch: 60, start: 0, duration: 2, lyric: 'la' },
      { id: 2, pitch: 60, start: 2, duration: 2, lyric: 'la' },
      { id: 3, pitch: 60, start: 4, duration: 2, lyric: 'la' },
      { id: 4, pitch: 60, start: 6, duration: 2, lyric: 'la' },
    ];
    const ctx = makeCtx(notes, { vibratoProbability: 1, variation: 60 });
    const a = buildNoteTraits(ctx);
    const b = buildNoteTraits(ctx);
    for (const n of notes) {
      expect(a.get(n).depthScale).to.equal(b.get(n).depthScale);
      expect(a.get(n).phase0).to.equal(b.get(n).phase0);
    }
    const depths = notes.map((n) => a.get(n).depthScale);
    const spread = Math.max(...depths) - Math.min(...depths);
    // variation=60% 时逐音幅度至少差 15%，否则就是"每个音都一模一样"
    expect(spread).to.be.greaterThan(0.15);
    const phases = new Set(notes.map((n) => Math.round(a.get(n).phase0 * 100)));
    expect(phases.size).to.be.greaterThan(1);
  });

  it('颤音概率闸门：0 = 全部直声，1 = 全部颤音，默认值落在两者之间', () => {
    const notes = [];
    for (let i = 0; i < 16; i++) {
      notes.push({ id: 500 + i, pitch: 60, start: i * 2, duration: 2, lyric: 'la' });
    }
    const count = (over) => {
      const traits = buildNoteTraits(makeCtx(notes, over));
      return notes.filter((n) => traits.get(n).gateVibrato).length;
    };
    expect(count({ vibratoProbability: 0 })).to.equal(0);
    expect(count({ vibratoProbability: 1 })).to.equal(notes.length);
    const mid = count({ vibratoProbability: AUTO_PITCH_DEFAULTS.vibratoProbability });
    expect(mid).to.be.greaterThan(0);
    expect(mid).to.be.lessThan(notes.length);
  });

  it('短音不颤：低于 autoVibrato.minDurationBeats 时闸门必然关闭', () => {
    const notes = [{ id: 1, pitch: 60, start: 0, duration: 0.8, lyric: 'la' }];
    const traits = buildNoteTraits(makeCtx(notes, { vibratoProbability: 1 }));
    expect(traits.get(notes[0]).gateVibrato).to.equal(false);
  });

  it('句尾下滑只发生在乐句尾/休止前，连奏的中段音尾不下滑', () => {
    // 两个 1 拍音连在一起（间隙 0）：n1 不是乐句尾
    const legato = [
      { id: 1, pitch: 60, start: 0, duration: 1, lyric: 'la' },
      { id: 2, pitch: 62, start: 1, duration: 1, lyric: 'la' },
    ];
    const ctxLegato = makeCtx(legato, { releaseCents: -60, releaseProbability: 1 });
    expect(buildNoteTraits(ctxLegato).get(legato[0]).releaseScale).to.equal(0);
    expect(cents(autoPitchAt(ctxLegato, 0.98), 60)).to.be.above(-10);

    // 同样的音，但句尾作用域改成 always → 每个音尾都下滑
    const ctxAlways = makeCtx(legato, {
      releaseCents: -60, releaseProbability: 1, releaseScope: 'always',
    });
    expect(buildNoteTraits(ctxAlways).get(legato[0]).releaseScale).to.equal(1);
    expect(cents(autoPitchAt(ctxAlways, 0.98), 60)).to.be.below(-30);
  });

  it('乐句尾（后接长休止）会给足下滑；后接短休止只给 70%', () => {
    const notes = [
      { id: 1, pitch: 60, start: 0, duration: 1, lyric: 'la' },
      { id: 2, pitch: 62, start: 4, duration: 1, lyric: 'la' },   // 间隔 3 拍 = 断句
    ];
    const traits = buildNoteTraits(makeCtx(notes, { releaseProbability: 1 }));
    expect(traits.get(notes[0]).isPhraseEnd).to.equal(true);
    expect(traits.get(notes[0]).releaseScale).to.equal(1);

    const pause = [
      { id: 1, pitch: 60, start: 0, duration: 1, lyric: 'la' },
      { id: 2, pitch: 62, start: 1.4, duration: 1, lyric: 'la' }, // 间隔 0.4 拍 = 短休止
    ];
    const t2 = buildNoteTraits(makeCtx(pause, { releaseProbability: 1 }));
    expect(t2.get(pause[0]).isPhraseEnd).to.equal(false);
    expect(t2.get(pause[0]).releaseScale).to.be.within(0.6, 0.8);
  });

  it('歌词标点视为断句（长句里也能标出句尾）', () => {
    const notes = [
      { id: 1, pitch: 60, start: 0, duration: 1, lyric: '啊，' },
      { id: 2, pitch: 62, start: 1, duration: 1, lyric: '啦' },
    ];
    expect(buildNoteTraits(makeCtx(notes)).get(notes[0]).isPhraseEnd).to.equal(true);
  });

  it('连奏时起音弱化到 35%，断奏保持原幅度', () => {
    const legato = [
      { id: 1, pitch: 60, start: 0, duration: 1, lyric: 'la' },
      { id: 2, pitch: 62, start: 1, duration: 1, lyric: 'la' },
    ];
    const ctxL = makeCtx(legato, { attackMs: 80, attackCents: -60, glideMinSemitones: 3 });
    const atkL = cents(autoPitchAt(ctxL, 1.001), 62);
    expect(atkL).to.be.within(-24, -18); // 60 × 0.35 ≈ 21

    const staccato = [
      { id: 1, pitch: 60, start: 0, duration: 1, lyric: 'la' },
      { id: 2, pitch: 62, start: 1.7, duration: 1, lyric: 'la' }, // 间隙 0.7 拍
    ];
    const ctxS = makeCtx(staccato, { attackMs: 80, attackCents: -60, glideMinSemitones: 3 });
    const atkS = cents(autoPitchAt(ctxS, 1.701), 62);
    expect(atkS).to.be.within(-60, -50);
  });

  it('连奏的级进给微滑，断奏的大跳不滑', () => {
    // 级进 1 半音 + 连奏 → 从上一个音高起步（微滑 45ms）
    const step = [
      { id: 1, pitch: 60, start: 0, duration: 1, lyric: 'la' },
      { id: 2, pitch: 61, start: 1, duration: 1, lyric: 'la' },
    ];
    const ctxStep = makeCtx(step, { microGlideMs: 45, glideMinSemitones: 2 });
    expect(autoPitchAt(ctxStep, 1.001)).to.be.closeTo(60, 0.03);
    // 45ms 之后应已到达目标音高
    expect(autoPitchAt(ctxStep, 1.12)).to.be.closeTo(61, 0.05);

    // 5 半音 + 断奏 → 不滑，起点就是目标音高
    const jump = [
      { id: 1, pitch: 60, start: 0, duration: 1, lyric: 'la' },
      { id: 2, pitch: 65, start: 1.6, duration: 1, lyric: 'la' },
    ];
    const ctxJump = makeCtx(jump, { glideMs: 90, glideMinSemitones: 2 });
    expect(autoPitchAt(ctxJump, 1.601)).to.be.closeTo(65, 0.05);
  });

  it('颤音速率/幅度是慢变随机的：drift=0 时逐音同形，drift>0 时逐音不同', () => {
    const note = { id: 9, pitch: 60, start: 0, duration: 4, lyric: 'la' };
    const ctx = makeCtx([note], { vibratoProbability: 1, variation: 0 });
    const cfg = (over) => ({ ...AUTO_PITCH_DEFAULTS.autoVibrato, ...over });
    const tr = buildNoteTraits(ctx).get(note);

    const fixed = [];
    const drifted = [];
    for (let i = 0; i < 200; i++) {
      const t = 1.1 + i * 0.002;   // 颤音区中段：已过渐入、未到淡出
      fixed.push(autoVibratoOffset(note, t, 2, cfg({ drift: 0, depthDrift: 0 }), tr));
      drifted.push(autoVibratoOffset(note, t, 2, cfg({ drift: 30, depthDrift: 40 }), tr));
    }
    const diff = fixed.map((v, i) => Math.abs(v - drifted[i]));
    const rms = Math.sqrt(diff.reduce((a, b) => a + b * b, 0) / diff.length);
    // 有可见差异，但不会跑调（相位不失控 → 差异远小于幅度）
    expect(rms).to.be.greaterThan(0.0005);
    expect(Math.max(...diff)).to.be.lessThan(0.6);

    // drift=0 时是纯正弦：极值应等于深度（22¢ = 0.22 半音）
    expect(Math.max(...fixed)).to.be.closeTo(0.22, 0.01);
  });

  it('多轨同度：salt 不同 → 抖动/颤音互不同步；salt 相同 → 完全一致', () => {
    const notes = [{ id: 1, pitch: 60, start: 0, duration: 2, lyric: 'la' }];
    const over = { vibratoProbability: 1, jitterCents: 8 };
    const a = autoPitchAt(makeCtx(notes, over, saltFromKey('singer-A')), 0.9);
    const b = autoPitchAt(makeCtx(notes, over, saltFromKey('singer-B')), 0.9);
    const a2 = autoPitchAt(makeCtx(notes, over, saltFromKey('singer-A')), 0.9);
    expect(a).to.equal(a2);
    expect(Math.abs(a - b)).to.be.greaterThan(0.01);
  });

  it('用户手设的颤音优先；关掉也算手动（auto 不会偷偷打开）', () => {
    const note = { id: 1, pitch: 60, start: 0, duration: 2, lyric: 'la' };
    const tr = buildNoteTraits(makeCtx([note], { vibratoProbability: 1 })).get(note);
    const av = AUTO_PITCH_DEFAULTS.autoVibrato;

    expect(autoVibratoOffset({ ...note }, 1, 2, av, tr)).to.not.equal(0);
    expect(autoVibratoOffset({ ...note, vibrato: { enabled: true } }, 1, 2, av, tr)).to.equal(0);
    expect(autoVibratoOffset(
      { ...note, vibrato: { enabled: true, source: 'manual' } }, 1, 2, av, tr,
    )).to.equal(0);
    // enabled=false + source=manual：用户显式关掉 → 自动层不得重新开启
    expect(autoVibratoOffset(
      { ...note, vibrato: { enabled: false, source: 'manual' } }, 1, 2, av, tr,
    )).to.equal(0);
    // 早期版本写入的自动填充可以被派生量覆盖
    expect(autoVibratoOffset(
      { ...note, vibrato: { enabled: true, source: 'auto' } }, 1, 2, av, tr,
    )).to.not.equal(0);
  });

  it('影子参数：UI 能读到"实际会生效"的幅度/速率，且标记为自动', () => {
    const notes = [{ id: 3, pitch: 64, start: 0, duration: 2, lyric: 'la' }];
    const ctx = makeCtx(notes, { vibratoProbability: 1, variation: 0 });
    ctx.auto = makeAuto({ vibratoProbability: 1, variation: 0 });
    const shadow = resolveAutoVibratoForNote(ctx, notes[0]);
    expect(shadow.auto).to.equal(true);
    expect(shadow.enabled).to.equal(true);
    expect(shadow.depth).to.be.closeTo(22, 0.2);
    expect(shadow.rate).to.be.closeTo(5.5, 0.2);
  });

  it('后置层叠加的颤音深度不被滤波削弱（曲线层不含颤音）', () => {
    const notes = [{ id: 1, pitch: 60, start: 0, duration: 2, lyric: 'la' }];
    const frames = 50; // 1s @ 20ms
    const f0 = new Float32Array(frames).fill(440 * Math.pow(2, (60 - 69) / 12));
    const ctx = makeCtx(notes, { vibratoProbability: 1, variation: 0 });
    const out = applyExpressionToF0(f0, ctx, { sampleRate: 24000, hopSize: 480 }, {
      jitter: false, vibrato: true,
    });
    let peak = 0;
    for (let i = 0; i < frames; i++) {
      const beat = (i * 480 / 24000 / 60) * bpm;
      if (beat < 1.0 || beat > 1.6) continue;   // 避开渐入与收尾淡出
      peak = Math.max(peak, Math.abs(1200 * Math.log2(out[i] / f0[i])));
    }
    expect(peak).to.be.within(19, 23);
  });

  it('isManualVibrato 的三态语义', () => {
    expect(isManualVibrato({ vibrato: { enabled: true } })).to.equal(true);
    expect(isManualVibrato({ vibrato: { enabled: true, source: 'manual' } })).to.equal(true);
    expect(isManualVibrato({ vibrato: { enabled: false, source: 'manual' } })).to.equal(true);
    expect(isManualVibrato({ vibrato: { enabled: true, source: 'auto' } })).to.equal(false);
    expect(isManualVibrato({ vibrato: { enabled: false } })).to.equal(false);
    expect(isManualVibrato({})).to.equal(false);
  });

  // ---------------------------------------------------------------------
  // 参数补丁清洗：非法枚举不能"看起来没动、实际被改回默认"
  // （实机核验发现：{releaseScope:'bogus'} 会把 'always' 悄悄变成 'phrase'，
  //   因为 normalizeAutoConfig 拿不到旧值，只能回落到全局默认）
  // ---------------------------------------------------------------------
  describe('sanitizeAutoParamPatch', () => {
    it('非法枚举直接丢弃，不进入补丁', () => {
      expect(sanitizeAutoParamPatch({ releaseScope: 'bogus' })).to.deep.equal({});
      expect(sanitizeAutoParamPatch({ glideCurve: 'spline' })).to.deep.equal({});
      expect(sanitizeAutoParamPatch({ jitterStage: 'mid' })).to.deep.equal({});
    });

    it('合法枚举原样保留', () => {
      expect(sanitizeAutoParamPatch({ releaseScope: 'always' })).to.deep.equal({ releaseScope: 'always' });
      expect(sanitizeAutoParamPatch({ glideCurve: 'exp', jitterSource: 'singer' }))
        .to.deep.equal({ glideCurve: 'exp', jitterSource: 'singer' });
    });

    it('数值键收数字、字符串数字也认；非数值丢弃', () => {
      expect(sanitizeAutoParamPatch({ vibratoProbability: '0.3' }))
        .to.deep.equal({ vibratoProbability: 0.3 });
      expect(sanitizeAutoParamPatch({ vibratoProbability: 'abc' })).to.deep.equal({});
      expect(sanitizeAutoParamPatch({ variation: NaN })).to.deep.equal({});
    });

    it('越界数值交给 normalize 夹紧，这里不做截断', () => {
      const patch = sanitizeAutoParamPatch({ vibratoProbability: 5, variation: -20 });
      expect(patch.vibratoProbability).to.equal(5);
      const out = normalizeAutoConfig({ enabled: true, params: { ...AUTO_PITCH_DEFAULTS, ...patch } }).params;
      expect(out.vibratoProbability).to.equal(1);
      expect(out.variation).to.equal(0);
    });

    it('autoVibrato 走嵌套对象，不展开成顶层键', () => {
      const patch = sanitizeAutoParamPatch({ autoVibrato: { depth: 12 } });
      expect(patch).to.deep.equal({ autoVibrato: { depth: 12 } });
      expect(patch.depth).to.equal(undefined);
    });

    it('未知键（拼错/脏字段）不会写进工程', () => {
      expect(sanitizeAutoParamPatch({ vibratoProbabillity: 0.9 })).to.deep.equal({});
    });

    it('空/非对象入参返回空补丁', () => {
      expect(sanitizeAutoParamPatch(null)).to.deep.equal({});
      expect(sanitizeAutoParamPatch(undefined)).to.deep.equal({});
      expect(sanitizeAutoParamPatch('x')).to.deep.equal({});
    });
  });

  // 预设必须是"整组替换"，否则会出现 preset=soft 但参数是 natural 的自相矛盾
  describe('paramsForPreset', () => {
    it('每个预设都带齐 v2 概率参数', () => {
      for (const id of ['soft', 'natural', 'power', 'ballad']) {
        const p = paramsForPreset(id);
        for (const k of ['vibratoProbability', 'overshootProbability', 'prepProbability',
          'releaseProbability', 'variation']) {
          expect(p[k], `${id}.${k}`).to.be.a('number');
        }
      }
    });

    it('预设之间确实不同（否则"换预设"没有意义）', () => {
      const soft = paramsForPreset('soft');
      const power = paramsForPreset('power');
      expect(soft.vibratoProbability).to.not.equal(power.vibratoProbability);
      expect(soft.variation).to.not.equal(power.variation);
      expect(soft.autoVibrato.depth).to.not.equal(power.autoVibrato.depth);
    });

    it('返回深拷贝：改返回值不会污染全局默认值', () => {
      const a = paramsForPreset('natural');
      a.autoVibrato.depth = 999;
      a.vibratoProbability = 0;
      expect(AUTO_PITCH_DEFAULTS.autoVibrato.depth).to.not.equal(999);
      expect(AUTO_PITCH_DEFAULTS.vibratoProbability).to.not.equal(0);
      expect(paramsForPreset('natural').autoVibrato.depth).to.not.equal(999);
    });
  });
});
