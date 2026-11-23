/**
 * StreamTimeline —— 分片编辑器流式播放的时间轴模型单测。
 *
 * 覆盖用户报告过的几类"位置异常"：
 *   · 前导静音（首音符不在 0）时 chunk 该晚多久出声
 *   · 从中段起播：起播点之前的块必须丢弃且**不锚定**（旧实现在这里锚定，
 *     后续每块都被算成迟到，头部被裁光 → 中段起播没声音）
 *   · 分块重叠只放一次、迟到只裁头、时间基准永不重建
 *   · 无 sampleOffset 的后端退化成顺序拼接
 *   · 播放头位置与排程共用同一锚点
 */
const { expect } = require('chai');
const { StreamTimeline, STREAM_LEAD_SEC } = require('../src/fragmentEditor/playbackTimeline.js');

const SR = 24000;
const EPS = 1e-6;

/** 构造一个带绝对内容区间的 chunk（采样坐标相对首音符）。 */
function chunkAt(relStartSec, durSec, extra = {}) {
  return {
    sampleOffset: Math.round(relStartSec * SR),
    sampleEnd: Math.round((relStartSec + durSec) * SR),
    audio: new Float32Array(Math.round(durSec * SR)),
    ...extra,
  };
}

describe('StreamTimeline（流式播放时间轴）', () => {
  it('前导静音：首音符在 4s，chunk 从首音符起 → 排程推迟 4s（而不是立刻出声）', () => {
    const t = new StreamTimeline({ startPositionSec: 0, firstNoteStartSec: 4 });
    const plan = t.plan(chunkAt(0, 2), SR, 100);
    expect(plan.action).to.equal('schedule');
    expect(plan.startedNow).to.equal(true);
    expect(plan.when).to.be.closeTo(100 + STREAM_LEAD_SEC + 4, EPS);
    expect(plan.skipSamples).to.equal(0);
    expect(plan.contentStartSec).to.be.closeTo(4, EPS);
    // 播放头从 0 起，t=4 时正好到首音符
    expect(t.positionAt(100 + STREAM_LEAD_SEC, 0)).to.be.closeTo(0, EPS);
    expect(t.positionAt(100 + STREAM_LEAD_SEC + 4, 0)).to.be.closeTo(4, EPS);
  });

  it('从中段 10s 起播：起播点之前的块丢弃且不锚定，覆盖起播点的块即时开播', () => {
    const t = new StreamTimeline({ startPositionSec: 10, firstNoteStartSec: 0 });

    const before1 = t.plan(chunkAt(0, 4), SR, 5);
    const before2 = t.plan(chunkAt(4, 4), SR, 9);
    expect(before1.action).to.equal('drop');
    expect(before1.reason).to.equal('before-start');
    expect(before1.startedNow).to.equal(false);
    expect(before2.action).to.equal('drop');
    expect(t.started, '起播点之前不得锚定').to.equal(false);

    // 关键：块到达时时钟已经走了 9s，但锚定发生在**此刻**，不能把 9s 算成迟到
    const plan = t.plan(chunkAt(8, 4), SR, 9);
    expect(plan.action).to.equal('schedule');
    expect(plan.startedNow).to.equal(true);
    expect(plan.skipSamples, '起播点 10s 落在块内 → 裁掉头部 2s').to.equal(2 * SR);
    expect(plan.when).to.be.closeTo(9 + STREAM_LEAD_SEC, 0.001);
    expect(plan.contentStartSec).to.be.closeTo(10, EPS);
    expect(plan.contentEndSec).to.be.closeTo(12, EPS);
    expect(t.positionAt(9 + STREAM_LEAD_SEC, 0)).to.be.closeTo(10, EPS);
  });

  it('分块重叠：同一段内容只排一次，第二块裁掉重叠头', () => {
    const t = new StreamTimeline({ startPositionSec: 0, firstNoteStartSec: 0 });
    const a = t.plan(chunkAt(0, 10), SR, 0);
    expect(a.when).to.be.closeTo(STREAM_LEAD_SEC, EPS);
    expect(t.deliveredEndSec).to.be.closeTo(10, EPS);

    const b = t.plan(chunkAt(8, 10), SR, 0);
    expect(b.skipSamples).to.equal(2 * SR);
    expect(b.when, '起点接在已交付末端').to.be.closeTo(STREAM_LEAD_SEC + 10, EPS);
    expect(b.contentStartSec).to.be.closeTo(10, EPS);
    expect(t.deliveredEndSec).to.be.closeTo(18, EPS);
  });

  it('迟到只裁头、基准不动：when = 当前时钟，offset = 迟到量', () => {
    const t = new StreamTimeline({ startPositionSec: 0, firstNoteStartSec: 0 });
    t.plan(chunkAt(0, 4), SR, 0);
    const anchor = t.anchorCtxTime;

    // 第二块本该在 anchor+4 出声，但直到 anchor+5.2 才到
    const late = t.plan(chunkAt(4, 4), SR, anchor + 5.2);
    expect(late.action).to.equal('schedule');
    expect(late.offsetSec).to.be.closeTo(1.2, 0.001);
    expect(late.when).to.be.closeTo(anchor + 5.2, 0.001);
    expect(t.anchorCtxTime, '时间基准不得重建').to.equal(anchor);
    // 内容位置 = 播放头位置：4 + 1.2 = 5.2
    expect(t.positionAt(anchor + 5.2, 0)).to.be.closeTo(5.2, 0.001);
  });

  it('整块迟到（超过自身时长）→ 丢弃但保留基准，播放头不回跳', () => {
    const t = new StreamTimeline({ startPositionSec: 0, firstNoteStartSec: 0 });
    t.plan(chunkAt(0, 2), SR, 0);
    const anchor = t.anchorCtxTime;
    const dropped = t.plan(chunkAt(2, 2), SR, anchor + 10);
    expect(dropped.action).to.equal('drop');
    expect(dropped.reason).to.equal('late');
    expect(dropped.startedNow).to.equal(false);
    expect(t.anchorCtxTime).to.equal(anchor);
    // 下一块照旧按绝对位置排（不会被"重建基准"拉回）
    const next = t.plan(chunkAt(4, 2), SR, anchor + 10);
    expect(next.action).to.equal('drop'); // 也过期了
    expect(t.deliveredEndSec, '未排程的块不得推进前沿').to.be.closeTo(2, EPS);
  });

  it('无 sampleOffset 的后端：按到达顺序顺序拼接，游标收到即前进', () => {
    const t = new StreamTimeline({ startPositionSec: 0, firstNoteStartSec: 0 });
    const a = t.plan({ audio: new Float32Array(2 * SR) }, SR, 0);
    expect(a.action).to.equal('schedule');
    expect(a.contentStartSec).to.be.closeTo(0, EPS);
    const b = t.plan({ audio: new Float32Array(2 * SR) }, SR, 0);
    expect(b.contentStartSec).to.be.closeTo(2, EPS);
    // 被丢弃的块也要占位，否则下一块会被重复裁头
    const c = t.plan({ audio: new Float32Array(0) }, SR, 0);
    expect(c.action).to.equal('drop');
    const d = t.plan({ audio: new Float32Array(2 * SR) }, SR, 0);
    expect(d.contentStartSec, '空块占用 0 长度，游标不变').to.be.closeTo(4, EPS);
  });

  it('播放头位置 = 起播点 + （可听时钟 − 锚点），带输出延迟补偿', () => {
    const t = new StreamTimeline({ startPositionSec: 12, firstNoteStartSec: 0 });
    expect(t.positionAt(999, 0.02), '未起播时停在起播点').to.equal(12);
    t.plan(chunkAt(12, 4), SR, 50);
    expect(t.positionAt(50, 0.02), '锚点之前（还没出声）停在起播点').to.be.closeTo(12, EPS);
    // 锚点 = 50 + lead(0.05)；ctx=53 → 可听 52.98 → 内容 12 + 2.93
    expect(t.positionAt(53, 0.02), '渲染 53s、设备延迟 20ms → 听到 52.98s')
      .to.be.closeTo(14.93, 0.001);
  });

  it('锚点只建立一次：后续 chunk 的 startedNow 恒为 false', () => {
    const t = new StreamTimeline({ startPositionSec: 0, firstNoteStartSec: 0 });
    expect(t.plan(chunkAt(0, 2), SR, 0).startedNow).to.equal(true);
    expect(t.plan(chunkAt(2, 2), SR, 0).startedNow).to.equal(false);
    expect(t.plan(chunkAt(0, 2), SR, 0).action, '重复内容整块丢弃').to.equal('drop');
  });

  /**
   * 乱序到达（后段先到、前段后到）。单一前沿（旧的 deliveredEndSec）会把
   * 后到的前段整块判成 duplicate —— 表现为"偶发缺一句、播放头照走"。
   * 区间账本让前段仍能按**它自己的**绝对时刻排进去。
   */
  it('乱序回填：后段先到只占自己的区间，前段后到仍按原时刻排程', () => {
    const t = new StreamTimeline({ startPositionSec: 0, firstNoteStartSec: 0 });
    const b = t.plan(chunkAt(2, 2), SR, 0);          // 2..4 先到
    expect(b.action).to.equal('schedule');
    expect(b.startedNow).to.equal(true);
    expect(b.when).to.be.closeTo(STREAM_LEAD_SEC + 2, EPS);

    const a = t.plan(chunkAt(0, 2), SR, 0);          // 0..2 后到
    expect(a.action, '旧实现会判 duplicate 并丢掉整块').to.equal('schedule');
    expect(a.when).to.be.closeTo(STREAM_LEAD_SEC, EPS);
    expect(a.skipSamples).to.equal(0);
    expect(a.offsetSec).to.equal(0);
    expect(t.backfillCount).to.equal(1);
    expect(t.deliveredEndSec, '最远末端不变').to.be.closeTo(4, EPS);
    // 时间轴原点仍是第一次锚定的位置：播放头不回跳
    expect(t.positionAt(STREAM_LEAD_SEC + 1, 0)).to.be.closeTo(1, EPS);
  });

  it('乱序回填超过块时长：只裁头不丢块，播放头仍然连续', () => {
    const t = new StreamTimeline({ startPositionSec: 0, firstNoteStartSec: 0 });
    t.plan(chunkAt(2, 2), SR, 0);                    // 锚点 = lead(0.05)
    const late = t.plan(chunkAt(0, 2), SR, 1.0);      // 理想 0.05s 出声，实际已到 1.0s
    expect(late.action).to.equal('schedule');
    expect(late.offsetSec).to.be.closeTo(1.0 - STREAM_LEAD_SEC, 1e-3);
    expect(late.when).to.be.closeTo(1.0, 1e-3);
    expect(late.durationSec).to.be.closeTo(2 - (1.0 - STREAM_LEAD_SEC), 1e-3);
  });

  it('块被已排区间从中间切开：逐段排程，不丢任何一段', () => {
    const t = new StreamTimeline({ startPositionSec: 0, firstNoteStartSec: 0 });
    t.plan(chunkAt(0, 2), SR, 0);                    // 0..2
    t.plan(chunkAt(4, 2), SR, 0);                    // 4..6（先占后段）
    const split = t.plan(chunkAt(0, 8), SR, 0);      // 0..8，被 0..2 / 4..6 切成两段
    expect(split.action).to.equal('schedule');
    expect(split.splitParts).to.equal(2);
    const starts = split.segments.map((s) => +s.contentStartSec.toFixed(3));
    expect(starts).to.deep.equal([2, 6]);
    expect(split.segments[0].skipSamples).to.equal(2 * SR);
    expect(split.segments[1].skipSamples).to.equal(6 * SR);
    expect(split.contentEndSec).to.be.closeTo(8, EPS);
  });

  /**
   * #1：锚点必须在 source.start() 成功后才写入。
   * plan() 提前写 anchor 时，启动失败会让后续块按一个没有声音源的时间原点排程。
   */
  describe('延迟锚定（plan 只给候选，commit 才生效）', () => {
    it('plan(reserve:false) 不写 anchor / 不占账本；commit 后才建立时间基准', () => {
      const t = new StreamTimeline({ startPositionSec: 0, firstNoteStartSec: 0 });
      const plan = t.plan(chunkAt(0, 2), SR, 100, { reserve: false });

      expect(plan.action).to.equal('schedule');
      expect(plan.startedNow).to.equal(true);
      expect(plan.anchorCtxTime).to.be.closeTo(100 + STREAM_LEAD_SEC, EPS);
      expect(t.started, 'plan 阶段不得锚定').to.equal(false);
      expect(t.anchorCtxTime).to.equal(null);
      expect(t.coveredRanges, 'plan 阶段不得占账本').to.have.lengthOf(0);

      t.commit(plan, plan.segments);
      expect(t.started).to.equal(true);
      expect(t.anchorCtxTime).to.be.closeTo(plan.anchorCtxTime, EPS);
      expect(t.coveredRanges).to.have.lengthOf(1);
    });

    it('所有 source 都启动失败（不 commit）→ 不锚定；下一块用新的候选值', () => {
      const t = new StreamTimeline({ startPositionSec: 0, firstNoteStartSec: 0 });
      t.plan(chunkAt(0, 2), SR, 100, { reserve: false });
      // 调用方 start() 全部抛异常：不调用 commit
      expect(t.started).to.equal(false);
      expect(t.coveredRanges).to.have.lengthOf(0);

      const retry = t.plan(chunkAt(0, 2), SR, 105, { reserve: false });
      expect(retry.startedNow).to.equal(true);
      expect(retry.anchorCtxTime, '重试必须使用新时钟，而不是失败时的旧候选').to.be.closeTo(105 + STREAM_LEAD_SEC, EPS);
    });
  });

  /**
   * #6：带 sampleOffset 的块也必须推进顺序游标，否则其后第一个"无范围"块
   * 会从旧游标（通常是 0）重发，被整块判 duplicate。
   */
  describe('混合协议顺序游标', () => {
    it('带范围块之后的无范围块接在其末端（不回 0）', () => {
      const t = new StreamTimeline({ startPositionSec: 0, firstNoteStartSec: 0 });
      t.plan(chunkAt(4, 2), SR, 0);                     // 带范围：4..6s
      const legacy = { audio: new Float32Array(2 * SR) }; // 无 sampleOffset/End
      const plan = t.plan(legacy, SR, 0.1);

      expect(plan.action).to.equal('schedule');
      expect(plan.contentStartSec).to.be.closeTo(6, EPS);
      expect(plan.contentEndSec).to.be.closeTo(8, EPS);
      expect(t.mixedRangeProtocol, '混合协议应被显式记录').to.equal(true);
    });
  });
});
