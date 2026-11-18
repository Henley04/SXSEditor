/**
 * 播放头分页跟随（Playhead Follow）—— 主窗口分片时间轴与分片编辑器钢琴卷帘**共用同一套**。
 *
 * 行为（对齐 SV2 的"跟随播放"手感）：
 *   · 播放头从左侧 1/5 出发向右走，走到视口 90% 处视为"到临界"，此时**不**连续推视口
 *     （连续推会让播放头看起来钉死在屏幕上，历史 bug 见 timelineRenderer 的注释）；
 *   · 只有当用户最近 3s 内没有操作（或指针没按住）时，才把视口**分页**前移一次，
 *     让播放头落在左侧 1/5，并用一段时间做缓动过渡；
 *   · 用户一动手（滚轮/缩放/拖拽/按键）就立刻让位：在途动画立即取消，并把空闲计时清零；
 *   · 播放头反向越界（用户把视口滚走、或 seek 到左边以外）同样回填到 1/5。
 *
 * 为什么单独抽成模块：
 *   两个窗口的滚动状态（state.fragmentScrollX / fragmentEditor 的 scrollX）与渲染入口
 *   完全不同，但"什么时候该动、动到哪里、用多久"必须**逐像素一致** —— 否则同一个操作
 *   在两个窗口里手感不同。这里只放纯逻辑（不碰 DOM、不碰 rAF），窗口侧只提供
 *   getScrollX / setScrollX / getMaxScrollX 三个访问器与一个每帧 tick。
 *
 * 时钟：默认 performance.now()（毫秒）。测试/模拟器注入虚拟时钟，动画因此完全确定。
 */

/**
 * 默认参数。数字都带"为什么是这个值"：
 *   · idleMs 3000 —— 用户滚轮看完一处细节回到播放，3s 内不该被拽走；
 *   · rightRatio 0.9 —— 留 10% 余量，播放头贴着右边缘再跳视觉上太晚（会先撞边框）；
 *   · leftRatio 0.05 —— 只在播放头真的快出屏时才回填，避免正常小回退也触发；
 *   · anchorRatio 0.2 —— 落点 = 左侧 1/5（需求指定），也保证"跳一次能看很久"；
 *   · durationMs 220 + 按距离微调 —— 分页位移约 0.7 个视口，太快会糊、太慢会追不上。
 */
export const PLAYHEAD_FOLLOW_DEFAULTS = Object.freeze({
  idleMs: 3000,
  rightRatio: 0.9,
  leftRatio: 0.05,
  anchorRatio: 0.2,
  durationMs: 220,
  minDurationMs: 140,
  maxDurationMs: 420,
  durationPerPx: 0.08,
  // 小于这个位移就不动（贴着内容末尾时会被 clamp 成 0，避免每帧重新触发）
  minJumpPx: 2,
  // 无法再移动（已到滚动上限）时的重试间隔：不重试会一直判定"越界"，重试太快是空转
  retryCooldownMs: 900,
  // 速率预测只用"新鲜"的样本；陈旧样本（暂停恢复/掉帧）会把落点算飞
  rateMaxAgeMs: 160,
  // 速率上限（px/ms）：正常 60fps、beatWidth 320px 时约 5.3px/ms，留足余量防脏数据
  rateMaxPxPerMs: 24,
  // 起播时播放头在视口外 —— 立即回填（这不是"跟随"，是"让人看得见"，不受 3s 门控约束）
  revealOnStart: true,
});

/** ease-out-cubic：起步快、收尾稳，分页滚动读起来最像"翻页"而不是"滑动"。 */
export function easeOutCubic(t) {
  const x = t < 0 ? 0 : (t > 1 ? 1 : t);
  return 1 - Math.pow(1 - x, 3);
}

function _defaultNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function _clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * @typedef {Object} PlayheadFollowDeps
 * @property {() => number} getScrollX   当前滚动位置（px，世界坐标原点 = 时间轴 0）
 * @property {(v: number) => void} setScrollX 写入滚动位置（窗口侧负责触发重绘）
 * @property {() => number} [getMaxScrollX] 滚动上限（px）；缺省视为无穷（不 clamp）
 * @property {() => number} [now]        时钟（毫秒）
 * @property {(t: number) => number} [ease] 缓动函数
 * @property {Object} [config]           覆盖 PLAYHEAD_FOLLOW_DEFAULTS 的字段
 */

/**
 * 创建一个跟随器。**每个窗口一个实例**（滚动状态各自独立）。
 *
 * 生命周期约定：
 *   · 播放循环每帧调用 tick(worldPlayheadX, viewportWidth)
 *   · 起播 / seek：reset({ reveal: true })
 *   · 暂停 / 停止：settle()（把在途动画落到终点，不留半程）
 *   · 用户操作：markActivity() / markViewportGesture() / setPointerDown()
 */
export function createPlayheadFollower(deps) {
  if (!deps || typeof deps.getScrollX !== 'function' || typeof deps.setScrollX !== 'function') {
    throw new TypeError('createPlayheadFollower 需要 getScrollX / setScrollX');
  }
  const cfg = Object.assign({}, PLAYHEAD_FOLLOW_DEFAULTS, deps.config || {});
  const now = typeof deps.now === 'function' ? deps.now : _defaultNow;
  const ease = typeof deps.ease === 'function' ? deps.ease : easeOutCubic;
  const getMaxScrollX = typeof deps.getMaxScrollX === 'function'
    ? deps.getMaxScrollX
    : () => Infinity;

  // 上一次用户操作的时间戳。初值 -Infinity：刚打开的窗口没有"用户正在操作"的语义，
  // 但起播那一帧通常紧跟一次 pointerdown，实际仍会从那一刻起算 3s。
  let lastActivityAt = -Infinity;
  // 指针按住（拖音符/拖播放头/拖滚动条）期间一律不跟随：按住不动 >3s 也不能被拽走。
  let pointerDown = false;
  // 在途动画 { from, to, startAt, duration }；null = 没有动画
  let anim = null;
  // 上一个样本 { x, t }，用于估计播放头速度（动画期间补偿位移，见 tick 内注释）
  let lastSample = null;
  // 无法移动时的冷却截止时间
  let cooldownUntil = -Infinity;
  // 起播回填待处理标记
  let revealPending = false;
  // 诊断计数（模拟器/测试用）：总共触发了几次分页
  let jumpCount = 0;

  function _apply(v, force) {
    const target = Number.isFinite(v) ? v : deps.getScrollX();
    const cur = deps.getScrollX();
    if (!Number.isFinite(cur)) {
      deps.setScrollX(target);
      return true;
    }
    // 亚像素阈值：动画首尾会算出与当前值几乎相同的数，没必要再触发一次整条时间轴重绘。
    // force=true 用于"动画收尾"：必须把精确终点写进去，否则会留下 0.x px 的残差
    // （落点断言/后续 clamp 都会看到这个残差，表现为"跳完总是差一点点"）。
    if (!force && Math.abs(target - cur) < 0.01) return false;
    deps.setScrollX(target);
    return true;
  }

  function _maxScroll() {
    const m = getMaxScrollX();
    return Number.isFinite(m) && m > 0 ? m : 0;
  }

  /** 估计播放头速度（px/ms，只取前进方向）。 */
  function _rateAt(worldX, t) {
    const s = lastSample;
    if (!s) return 0;
    const dt = t - s.t;
    if (!(dt > 0) || dt > cfg.rateMaxAgeMs) return 0;
    const dx = worldX - s.x;
    if (!Number.isFinite(dx)) return 0;
    // 反向位移只可能来自 seek / 拖拽（都已 reset 或 markActivity），这里保守取 0，
    // 免得把一个"回跳"当成速度，把落点算向左。
    if (dx <= 0) return 0;
    return Math.min(cfg.rateMaxPxPerMs, dx / dt);
  }

  function _animationDuration(deltaPx) {
    const d = Math.abs(deltaPx);
    return _clamp(cfg.durationMs + d * cfg.durationPerPx, cfg.minDurationMs, cfg.maxDurationMs);
  }

  /**
   * 规划一次跳转：把"动画结束时播放头会在哪"算进目标，否则动画期间的位移会稳定
   * 让落点偏右 rate*duration（高缩放下可差上百像素 —— 表现为"每次跳完播放头都不在
   * 1/5 处，越跳越靠右"）。
   */
  function _plan(scroll, worldX, rate, anchorPx) {
    // scroll' 满足 worldX - scroll' = anchorPx → scroll' = worldX - anchorPx
    const ideal = worldX - anchorPx;
    const duration = _animationDuration(ideal - scroll);
    const predicted = worldX + rate * duration;
    const target = _clamp(predicted - anchorPx, 0, _maxScroll());
    return { target, duration };
  }

  function _startAnimation(from, to, duration, t) {
    const delta = to - from;
    if (Math.abs(delta) < cfg.minJumpPx) {
      // 已到滚动上限：这一次什么也做不了，隔一会儿再试（不每帧重算）
      cooldownUntil = t + cfg.retryCooldownMs;
      return false;
    }
    anim = { from, to, startAt: t, duration: Math.max(1, duration) };
    jumpCount += 1;
    return true;
  }

  return {
    /**
     * 每帧调用。
     *
     * @param {number} worldX 播放头在**世界坐标**下的 x（px，不是视口坐标）。
     *   必须用世界坐标：动画期间滚动在变，视口坐标被滚动污染后速度估计会失真。
     * @param {number} viewportWidth 视口宽度（px）
     * @param {boolean} [isPlaying] 传 false 时只推进/结束动画，不发起新的跳转
     * @returns {boolean} 本帧是否改写了滚动位置（调用方据此决定要不要重绘）
     */
    tick(worldX, viewportWidth, isPlaying = true) {
      if (!Number.isFinite(worldX) || !(viewportWidth > 0)) return false;
      const t = now();

      // ---- 1) 在途动画：绝对插值，不依赖外部滚动值 ----
      if (anim) {
        const p = anim.duration > 0 ? (t - anim.startAt) / anim.duration : 1;
        if (p >= 1) {
          const done = _apply(anim.to, true);
          anim = null;
          lastSample = { x: worldX, t };
          return done;
        }
        const v = anim.from + (anim.to - anim.from) * ease(p);
        const moved = _apply(v);
        lastSample = { x: worldX, t };
        return moved;
      }

      const rate = _rateAt(worldX, t);
      lastSample = { x: worldX, t };

      if (pointerDown) return false;

      const w = viewportWidth;
      const anchorPx = w * cfg.anchorRatio;
      const scroll = deps.getScrollX();
      if (!Number.isFinite(scroll)) return false;
      const viewX = worldX - scroll;

      // ---- 2) 起播回填：播放头整个在视口外 → 立刻把它拉回来（不受 3s 门控） ----
      if (revealPending) {
        revealPending = false;
        if (cfg.revealOnStart && (viewX < 0 || viewX > w)) {
          const plan = _plan(scroll, worldX, rate, anchorPx);
          // 回填用短动画（不做"翻页"的观感，只是把画面挪过去）
          if (_startAnimation(scroll, plan.target, Math.min(plan.duration, cfg.durationMs), t)) {
            return _apply(anim.from);
          }
        }
        return false;
      }

      if (!isPlaying) return false;

      // ---- 3) 空闲门控：用户刚动过就不许抢视口 ----
      if (t - lastActivityAt < cfg.idleMs) return false;

      // ---- 4) 冷却（上一次动不了 / 刚跳过） ----
      if (t < cooldownUntil) return false;

      // ---- 5) 临界判定 + 落点 ----
      const hi = w * cfg.rightRatio;
      const lo = w * cfg.leftRatio;
      if (viewX <= hi && viewX >= lo) return false;

      const plan = _plan(scroll, worldX, rate, anchorPx);
      if (!_startAnimation(scroll, plan.target, plan.duration, t)) return false;
      // 动画从"当前位置"起步，本帧没有视觉变化（第一帧 t≈startAt）
      return _apply(anim.from);
    },

    /** 任意用户操作（点击任意 UI、按键、输入）：只清零空闲计时。 */
    markActivity() {
      lastActivityAt = Math.max(lastActivityAt, now());
    },

    /**
     * 用户直接操作视口（滚轮 / 缩放 / 在画布上按下拖拽）：
     * 清零空闲计时**并且**立刻终止在途动画 —— 不能一边动画一边和用户抢滚动。
     */
    markViewportGesture() {
      const t = now();
      lastActivityAt = Math.max(lastActivityAt, t);
      anim = null;
    },

    /** 指针按住状态（拖拽期间禁止跟随，即使按住超过 3s）。 */
    setPointerDown(down) {
      pointerDown = !!down;
      // 按下/抬起都算一次操作：抬起后同样要重新等满 3s，不能刚松手就被拽走
      lastActivityAt = Math.max(lastActivityAt, now());
    },

    /**
     * 兜底解除"按住"状态，**不动空闲计时**。
     * 用途：pointerup 丢事件（焦点被原生对话框抢走、指针移出窗口松开）时自愈，
     * 否则 pointerDown 会永久为真 → 跟随彻底失效。鼠标移动自愈必须走这里，
     * 不能走 setPointerDown(false)：那会把"光标在窗口里晃"当成用户操作，
     * 一直晃就一直不跟随。
     */
    clearPointerDown() {
      pointerDown = false;
    },

    /**
     * 播放会话开始 / seek：清掉在途动画与速度样本。
     * @param {{reveal?: boolean}} [options] reveal=true 时允许"播放头在视口外就回填"
     */
    reset(options) {
      anim = null;
      lastSample = null;
      cooldownUntil = -Infinity;
      revealPending = !!(options && options.reveal) && cfg.revealOnStart;
    },

    /** 暂停/停止：把在途动画直接落到终点（停在半程会像卡住）。返回是否改写了滚动。 */
    settle() {
      if (!anim) return false;
      const to = anim.to;
      anim = null;
      lastSample = null;
      return _apply(to, true);
    },

    /** 诊断/测试用快照。 */
    snapshot() {
      return {
        animating: !!anim,
        pointerDown,
        revealPending,
        jumpCount,
        lastActivityAt,
        cooldownUntil,
        target: anim ? anim.to : null,
      };
    },
  };
}
