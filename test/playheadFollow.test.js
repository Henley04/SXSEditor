/**
 * shared/playheadFollow —— 播放头分页跟随（主窗口时间轴 / 分片编辑器钢琴卷帘共用）。
 *
 * 需求（对齐 SV2 手感）：
 *   · 播放头走到视口临界 + 用户前 3s 无操作 → 把视口往播放方向挪一页，
 *     让播放头落在左侧 1/5，并带过渡动画；
 *   · 用户一动手就让位（在途动画立即终止，空闲计时清零）；
 *   · 指针按住（拖音符/拖播放头 >3s）期间绝不跟随。
 *
 * 这里守护最容易回归的几条：
 *   - 落点精度：动画期间播放头还在前进，目标必须**预测补偿**，否则每次都偏右；
 *   - 末尾/无内容（滚不动）时不能每帧重试造成抖振；
 *   - 动画只能单向逼近目标，不能越过再回弹（会看成"错位"）；
 *   - 坐标必须用世界坐标（视口坐标在动画期间被滚动污染，速度估计会失真）。
 */
const { expect } = require('chai');
const {
  PLAYHEAD_FOLLOW_DEFAULTS,
  createPlayheadFollower,
  easeOutCubic,
} = require('../src/shared/playheadFollow.js');

/**
 * 造一个带虚拟时钟的跟随器。
 * @param {{viewport?: number, scroll?: number, maxScroll?: number, config?: object}} opts
 */
function createRig(opts = {}) {
  let t = 0;
  const rig = {
    viewport: opts.viewport == null ? 1000 : opts.viewport,
    scroll: opts.scroll == null ? 0 : opts.scroll,
    maxScroll: opts.maxScroll == null ? 1e6 : opts.maxScroll,
    get now() { return t; },
    setTime(v) { t = v; },
    advance(ms) { t += ms; },
    jumps: 0,
  };
  rig.follower = createPlayheadFollower({
    getScrollX: () => rig.scroll,
    setScrollX: (v) => { rig.scroll = v; },
    getMaxScrollX: () => rig.maxScroll,
    now: () => t,
    config: opts.config,
  });
  return rig;
}

/**
 * 播放头世界坐标：截距 + 速率（px/ms）。rate=0.32 对应 120BPM、beatWidth=160 的
 * 常速播放（320 px/s）。
 */
function makePlayhead({ atZero = 0, rate = 0.32 } = {}) {
  return (t) => atZero + rate * t;
}

/** 按 60fps 跑一段虚拟时间，返回最后一次 tick 的返回值。 */
function runFrames(rig, worldXAt, fromMs, toMs, stepMs = 16) {
  let last = false;
  for (let t = fromMs; t <= toMs; t += stepMs) {
    rig.setTime(t);
    last = rig.follower.tick(worldXAt(t), rig.viewport);
  }
  return last;
}

/**
 * 一直跑到"第一次分页动画落地"，返回落地时刻的播放头视口 x。
 * 必须**在动画刚落地的那一帧**取样：之后播放头继续前进（视口不动），
 * 视口 x 会自然变大，那不是落点误差。
 */
function runUntilFirstLanding(rig, worldXAt, fromMs = 0, maxMs = 20000, stepMs = 16) {
  let started = false;
  for (let t = fromMs; t <= fromMs + maxMs; t += stepMs) {
    rig.setTime(t);
    rig.follower.tick(worldXAt(t), rig.viewport);
    const snap = rig.follower.snapshot();
    if (snap.jumpCount > 0) started = true;
    if (started && !snap.animating) return worldXAt(t) - rig.scroll;
  }
  return null;
}

describe('shared/playheadFollow', () => {
  describe('默认参数', () => {
    it('空闲 3s / 右临界 0.9 / 落点 0.2（需求指定的 1/5）', () => {
      expect(PLAYHEAD_FOLLOW_DEFAULTS.idleMs).to.equal(3000);
      expect(PLAYHEAD_FOLLOW_DEFAULTS.rightRatio).to.equal(0.9);
      expect(PLAYHEAD_FOLLOW_DEFAULTS.anchorRatio).to.equal(0.2);
      expect(PLAYHEAD_FOLLOW_DEFAULTS.rightRatio).to.be.greaterThan(PLAYHEAD_FOLLOW_DEFAULTS.anchorRatio);
    });

    it('缺 getScrollX/setScrollX 直接报错（接线漏了要立刻炸，不能静默不跟随）', () => {
      expect(() => createPlayheadFollower({})).to.throw(TypeError);
      expect(() => createPlayheadFollower({ getScrollX: () => 0 })).to.throw(TypeError);
    });

    it('easeOutCubic 单调且首尾精确', () => {
      expect(easeOutCubic(0)).to.equal(0);
      expect(easeOutCubic(1)).to.equal(1);
      let prev = -1;
      for (let i = 0; i <= 20; i++) {
        const v = easeOutCubic(i / 20);
        expect(v).to.be.at.least(prev);
        prev = v;
      }
    });
  });

  describe('临界判定', () => {
    it('播放头在安全带内：不滚动、不触发', () => {
      const rig = createRig();
      const ph = makePlayhead();
      runFrames(rig, ph, 0, 2000);
      expect(rig.scroll).to.equal(0);
      expect(rig.follower.snapshot().jumpCount).to.equal(0);
    });

    it('越右临界 + 已空闲 → 分页前移，落点在左侧 1/5（含变速预测补偿）', () => {
      const rig = createRig();
      const ph = makePlayhead({ atZero: 850, rate: 0.32 });
      // 从 t=0 起持续 tick：先建立速度样本，播放头在 t≈160ms 越过右临界
      const landing = runUntilFirstLanding(rig, ph);
      expect(landing).to.be.a('number');
      // 动画期间播放头仍在前进 → 目标必须预测补偿，否则会稳定偏右几十像素
      expect(landing).to.be.closeTo(200, 4);
      expect(rig.follower.snapshot().jumpCount).to.equal(1);
      expect(rig.follower.snapshot().animating).to.equal(false);
    });

    it('用视口坐标会被滚动污染：世界坐标下动画期间落点仍准确', () => {
      const rig = createRig({ viewport: 1200 });
      rig.setTime(4000);
      rig.follower.tick(1200 * 0.95, rig.viewport);
      runFrames(rig, () => 1200 * 0.95, 4016, 5000);
      // 播放头不动（rate=0）→ 落点必须精确等于 0.2*1200
      expect(1200 * 0.95 - rig.scroll).to.be.closeTo(240, 1);
    });

    it('播放头滚出左侧（viewX < 左临界）→ 回填到 1/5', () => {
      const rig = createRig({ scroll: 2000 });
      rig.setTime(4000);
      rig.follower.tick(2020, rig.viewport); // viewX = 20 < 0.05*1000
      runFrames(rig, () => 2020, 4016, 5000);
      expect(2020 - rig.scroll).to.be.closeTo(200, 2);
    });
  });

  describe('3s 空闲门控', () => {
    it('刚操作过不跟随，满 3s 后才跟', () => {
      const rig = createRig();
      const ph = makePlayhead({ atZero: 950, rate: 0 });
      rig.follower.markActivity();          // t=0 用户操作
      rig.setTime(1000);
      rig.follower.tick(ph(1000), rig.viewport);
      expect(rig.follower.snapshot().animating).to.equal(false);
      expect(rig.scroll).to.equal(0);

      rig.setTime(2990);
      rig.follower.tick(ph(2990), rig.viewport);
      expect(rig.follower.snapshot().animating).to.equal(false);

      rig.setTime(3010);
      rig.follower.tick(ph(3010), rig.viewport);
      expect(rig.follower.snapshot().animating).to.equal(true);
    });

    it('动画途中用户滚轮 → 立即让位，保留用户的新位置', () => {
      const rig = createRig();
      rig.setTime(4000);
      rig.follower.tick(950, rig.viewport);
      expect(rig.follower.snapshot().animating).to.equal(true);

      rig.setTime(4080);
      rig.follower.tick(950, rig.viewport);
      const mid = rig.scroll;
      expect(mid).to.be.greaterThan(0);

      // 用户滚轮把视口挪到别处
      rig.scroll = 123;
      rig.follower.markViewportGesture();
      expect(rig.follower.snapshot().animating).to.equal(false);

      runFrames(rig, () => 950, 4100, 9000);
      // 动画已经取消，用户位置必须保留（不能再被写回动画目标）
      expect(rig.scroll).to.equal(123);
    });

    it('指针按住超过 3s 也不跟随（拖音符/拖播放头）', () => {
      const rig = createRig();
      rig.follower.setPointerDown(true);
      runFrames(rig, makePlayhead({ atZero: 950, rate: 0 }), 0, 6000);
      expect(rig.scroll).to.equal(0);

      rig.follower.setPointerDown(false);
      runFrames(rig, () => 950, 6000 + 16, 9500);
      expect(rig.scroll).to.be.greaterThan(0);
    });

    it('鼠标移动自愈：clearPointerDown 不动空闲计时', () => {
      const rig = createRig();
      rig.follower.markActivity();
      rig.follower.setPointerDown(true);
      rig.follower.clearPointerDown();
      // 计时仍从 t=0 起算：3s 后应能跟随（若 clearPointerDown 记了操作就会推迟）
      rig.setTime(3100);
      rig.follower.tick(950, rig.viewport);
      expect(rig.follower.snapshot().animating).to.equal(true);
    });
  });

  describe('滚不动 / 无内容：不许抖振', () => {
    it('已到滚动上限：一次也不跳，且不反复重试', () => {
      // scroll 已在 maxScroll，播放头仍在右临界之外 → 目标被 clamp 成"原地"
      const rig = createRig({ scroll: 1000, maxScroll: 1000 });
      const ph = makePlayhead({ atZero: 1900, rate: 0 });
      runFrames(rig, ph, 4000, 12000);
      expect(rig.scroll).to.equal(1000);
      expect(rig.follower.snapshot().jumpCount).to.equal(0);
      expect(rig.follower.snapshot().animating).to.equal(false);
    });

    it('内容比视口还短（maxScroll=0）：完全不动', () => {
      const rig = createRig({ maxScroll: 0 });
      runFrames(rig, makePlayhead({ atZero: 5000, rate: 0.5 }), 4000, 12000);
      expect(rig.scroll).to.equal(0);
      expect(rig.follower.snapshot().jumpCount).to.equal(0);
    });
  });

  describe('生命周期', () => {
    it('settle：把在途动画直接落到终点（暂停不留半程）', () => {
      const rig = createRig();
      rig.setTime(4000);
      rig.follower.tick(950, rig.viewport);
      rig.setTime(4060);
      rig.follower.tick(950, rig.viewport);
      const target = rig.follower.snapshot().target;
      expect(rig.scroll).to.be.lessThan(target);

      const changed = rig.follower.settle();
      expect(changed).to.equal(true);
      expect(rig.scroll).to.equal(target);
      expect(rig.follower.snapshot().animating).to.equal(false);
      // 幂等
      expect(rig.follower.settle()).to.equal(false);
    });

    it('reset({reveal:true})：起播时播放头在视口外 → 立即回填（不受 3s 门控）', () => {
      const rig = createRig();
      rig.follower.reset({ reveal: true });
      rig.follower.markActivity();      // 用户刚点了播放按钮
      rig.setTime(16);
      rig.follower.tick(5000, rig.viewport);
      expect(rig.follower.snapshot().animating).to.equal(true);
      runFrames(rig, () => 5000, 32, 600);
      expect(5000 - rig.scroll).to.be.closeTo(200, 6);
    });

    it('reset({reveal:true})：播放头本来可见 → 不动', () => {
      const rig = createRig();
      rig.follower.reset({ reveal: true });
      rig.follower.markActivity();
      rig.setTime(16);
      rig.follower.tick(600, rig.viewport);
      expect(rig.follower.snapshot().animating).to.equal(false);
      expect(rig.scroll).to.equal(0);
    });

    it('reset() 后不残留动画', () => {
      const rig = createRig();
      rig.setTime(4000);
      rig.follower.tick(950, rig.viewport);
      rig.follower.reset();
      expect(rig.follower.snapshot().animating).to.equal(false);
      runFrames(rig, () => 950, 4016, 6000);
      // reset 清掉速度样本 → 不会用旧样本算出一个飞掉的落点
      expect(Math.abs(950 - rig.scroll - 200)).to.be.lessThan(6);
    });
  });

  describe('动画形状（不能越过目标再回弹）', () => {
    it('逐帧单调逼近目标且不越界', () => {
      const rig = createRig({ viewport: 1000 });
      rig.setTime(4000);
      rig.follower.tick(950, rig.viewport);
      const target = rig.follower.snapshot().target;
      let prev = rig.scroll;
      for (let t = 4016; t <= 4600; t += 16) {
        rig.setTime(t);
        rig.follower.tick(950, rig.viewport);
        expect(rig.scroll).to.be.at.least(prev - 1e-9);
        expect(rig.scroll).to.be.at.most(target + 1e-9);
        prev = rig.scroll;
      }
      expect(rig.scroll).to.be.closeTo(target, 1e-6);
    });

    it('动画时长随距离增长但有上下界', () => {
      const maxFrames = Math.ceil(PLAYHEAD_FOLLOW_DEFAULTS.maxDurationMs / 16) + 1;
      const short = createRig({ viewport: 300 });
      short.setTime(4000);
      short.follower.tick(299, short.viewport); // 位移 ~0.7*300
      const shortTarget = short.follower.snapshot().target;
      let frames = 0;
      for (let t = 4016; t < 5000 && short.scroll !== shortTarget; t += 16) {
        short.setTime(t);
        short.follower.tick(299, short.viewport);
        frames++;
      }
      expect(short.scroll).to.equal(shortTarget);
      expect(frames).to.be.at.most(maxFrames);

      const long = createRig({ viewport: 4000 });
      long.setTime(4000);
      long.follower.tick(3999, long.viewport);
      const longTarget = long.follower.snapshot().target;
      let framesLong = 0;
      for (let t = 4016; t < 6000 && long.scroll !== longTarget; t += 16) {
        long.setTime(t);
        long.follower.tick(3999, long.viewport);
        framesLong++;
      }
      expect(long.scroll).to.equal(longTarget);
      expect(framesLong).to.be.greaterThan(frames);
      expect(framesLong).to.be.at.most(maxFrames);
    });
  });

  describe('连续的多次分页', () => {
    it('每走完一页才触发一次，不会连发', () => {
      const rig = createRig({ viewport: 1000, maxScroll: 1e6 });
      const ph = makePlayhead({ atZero: 0, rate: 0.6 }); // 0.6px/ms → 每页约 1.17s
      let jumpsSeen = 0;
      for (let t = 4000; t <= 12000; t += 16) {
        rig.setTime(t);
        rig.follower.tick(ph(t), rig.viewport);
        const n = rig.follower.snapshot().jumpCount;
        if (n !== jumpsSeen) {
          jumpsSeen = n;
          // 每次触发时播放头都必须在右临界之后
          expect(ph(t) - rig.scroll).to.be.at.least(1000 * 0.9 - 1);
        }
      }
      expect(jumpsSeen).to.be.at.least(3);
      // 每次跳完落点都在 1/5 附近（允许动画期间前进的残余误差）
      expect(ph(12000) - rig.scroll).to.be.lessThan(1000 * 0.9);
    });
  });
});
