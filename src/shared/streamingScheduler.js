/**
 * Shared streaming playback scheduler for chunk-based audio inference.
 *
 * Encapsulates:
 * - Buffer frontier tracking (furthest received audio position)
 * - AudioContext suspend/resume for underrun (freezes all sources + context clock)
 * - Watchdog timer for background underrun detection (rAF is suspended when
 *   the window is minimized/tab hidden, but WebAudio continues playing)
 * - Active source counting and completion detection (isLast + all sources ended)
 *
 * Callers (renderer, fragment editor) handle:
 * - Chunk source creation and scheduling (different coordinate systems)
 * - playbackStartTime adjustment during recovery
 * - UI updates (button text, playhead drawing)
 */

// suspend()/resume() 是异步控制消息：从发出到设备真正冻结时钟之间，渲染时钟照常
// 前进。提前量必须覆盖这段延迟，否则冻结点落在 buffer 前沿之后，晚到的 chunk 会
// 被按"迟到量"裁头 —— 每个接缝永久丢掉一段音频（静音缝 + 内容缺失）。
// 正常机器上这段延迟约 8ms，0.3s 提前量绰绰有余；GPU 被训练/nvcodec 抢占时
// 实测可达 300–500ms，固定提前量必然失效（见 docs/PLAYHEAD_STALL_REPORT.md）。
const WATCHDOG_TICK_MS = 250;
const MAX_UNDERRUN_MARGIN_SEC = 2.0;
// 观测到新延迟立即采信（快升）；旧延迟按此系数逐次衰减（缓降），
// 避免一次性尖峰把提前量永久钉死在大值上。
const SUSPEND_LATENCY_DECAY = 0.9;

// 延迟估计按 AudioContext 归属，而不是按 scheduler 实例：控制消息延迟是"这台
// 设备的音频栈在当前系统负载下"的属性，与播放会话无关。挂在实例上时每次重播都
// 要从零学起，第一个接缝必然再丢一次（换设备时 ctx 变化，估计自然作废）。
const _suspendLatencyByCtx = new WeakMap();

export class StreamingScheduler {
  /**
   * @param {Object} opts
   * @param {() => AudioContext} opts.getCtx - Returns the shared AudioContext
   * @param {() => number} opts.getElapsed - Returns current playback position in seconds
   * @param {(isWaiting: boolean) => void} [opts.onWaitStateChange] - Called when underrun wait starts/stops
   * @param {() => void} [opts.onFinish] - Called when all sources ended and isLast received
   * @param {number} [opts.watchdogMarginSec] - Safety margin (seconds) applied to the
   *   watchdog's underrun check. The watchdog ticks periodically (250ms), so by the
   *   time it observes the frontier the playhead has already overshot it. Freezing
   *   with a margin >= tick period means the freeze lands BEFORE the frontier: the
   *   next chunk's original schedule time is still in the future at resume, so
   *   playback continues with zero drift and zero overlap.
   *   This value is the FLOOR of the margin: the effective margin also grows with the
   *   measured AudioContext.suspend() commit latency (see requiredUnderrunMarginSec).
   * @param {() => number} [opts.getPacingFrontier] - Optional pacing frontier in
   *   seconds (defaults to bufferEndSec). Multi-stream playback (interleaved
   *   fragments/regions) MUST return the MINIMUM delivered end across all active
   *   streams: pacing by the max-end frontier lets a fast stream push the playhead
   *   past a slow stream's undelivered range, making the slow stream's chunks
   *   arrive "late" — which forces either shifted playback (overlap/drift) or
   *   head-trimming (content loss). Pacing by the min end keeps every stream
   *   lossless and drift-free; finished streams must be excluded (return Infinity
   *   for them).
   */
  constructor({ getCtx, getElapsed, onWaitStateChange, onFinish, watchdogMarginSec = 0, getPacingFrontier }) {
    this._getCtx = getCtx;
    this._getElapsed = getElapsed;
    this._onWaitStateChange = onWaitStateChange || (() => {});
    this._onFinish = onFinish || (() => {});
    this._watchdogMarginSec = watchdogMarginSec;
    this._getPacingFrontier = getPacingFrontier || null;

    this.bufferEndSec = 0;
    this.inferenceDone = false;
    this.isLastReceived = false;
    this.activeSourceCount = 0;
    // onFinish 的一次性标志：一轮会话只允许触发一次，直到下次 reset()。
    this._finished = false;

    this._active = false;
    this._waitingForInference = false;
    this._contextSuspended = false;
    this._suspendInFlight = null;
    this._resumeInFlight = null;
    // 解冻是一次异步状态转换：在它真正完成前清掉 waiting，会让 rAF/drain
    // 再次 checkUnderrun() 进入新的 suspend，与在途 resume 交错。
    this._resumeTransition = null;
    this._watchdogTimer = null;
  }

  get isWaiting() { return this._waitingForInference; }

  /** 已有一次 resume 正在落地（设备尚未真正解冻）——自愈路径据此不要重复发。 */
  get isResuming() { return !!this._resumeInFlight; }

  /** 当前设备实测的 suspend 控制消息落地延迟（秒）。 */
  _suspendLatencySec() {
    const ctx = this._getCtx();
    return ctx ? (_suspendLatencyByCtx.get(ctx) || 0) : 0;
  }

  /**
   * underrun 冻结提前量（秒）。调用方（rAF / watchdog）都应用它，而不是写死常量：
   * 提前量至少要覆盖 suspend 真正冻结时钟所需的控制消息延迟。
   *
   * @param {number} [allowanceSec] - 调用方自身的检测量化误差（rAF 一帧 ≈ 0.017s，
   *   watchdog 一个 tick = 0.25s）。
   */
  requiredUnderrunMarginSec(allowanceSec = 0) {
    const need = this._suspendLatencySec() + allowanceSec;
    return Math.min(MAX_UNDERRUN_MARGIN_SEC, Math.max(this._watchdogMarginSec, need));
  }

  /**
   * 等 suspend 真正落地（时钟已冻结）。chunk 回调必须在读 ctx.currentTime 计算
   * 迟到量之前调用它：in-flight 期间时钟仍在走，直接读会把"控制消息还没送到"
   * 误判成"内容迟到了"，从而裁掉本来没迟的音频头。
   */
  async awaitSuspendSettled() {
    if (this._suspendInFlight) {
      try { await this._suspendInFlight; } catch (_) {}
    }
  }

  updateBufferFrontier(endSec) {
    if (endSec > this.bufferEndSec) this.bufferEndSec = endSec;
  }

  addSource() { this.activeSourceCount++; }

  sourceEnded() {
    // 下界钳制：onended 重复触发（或跨会话残留 source）不能把计数压成负数，
    // 否则 _checkCompletion 的 "<= 0" 判断会把「还有源在播」误判为「全部结束」。
    if (this.activeSourceCount > 0) this.activeSourceCount--;
    this._checkCompletion();
  }

  markLastReceived() {
    this.isLastReceived = true;
    this._checkCompletion();
  }

  /**
   * Detect buffer underrun: playhead has caught up to the buffer frontier
   * (minus an optional safety margin) and inference is not yet complete.
   * Freezes AudioContext.
   *
   * @param {number} elapsed - Current playback position in seconds
   * @param {() => void} [onEnterWait] - Called when entering wait state (e.g., cancel rAF, update UI)
   * @param {number} [marginSec] - Enter the wait this many seconds BEFORE the
   *   frontier. Freezing early keeps the late chunk's original schedule time in
   *   the future, so recovery needs no content trimming at all. Callers with
   *   coarse detection latency (watchdog tick) should pass a margin >= their
   *   latency; frame-accurate callers (rAF) can pass 0.
   * @returns {boolean} true if wait state was entered (caller must return from its loop)
   */
  checkUnderrun(elapsed, onEnterWait, marginSec = 0) {
    if (this.inferenceDone || this._waitingForInference) return false;
    // 正在解冻时不能启动新的冻结转换，否则 context 最终状态与 waiting 撕裂。
    if (this._resumeTransition || this._resumeInFlight) return false;
    // 尚未收到任何音频：没有可判断的前沿。此时 elapsed 可能来自上一轮
    // 播放遗留的 playbackStartTime（垃圾值），绝不能据此冻结 context，
    // 否则首 chunk 到达前 context 就被挂起，后续调度时序全部错乱。
    if (this.bufferEndSec <= 0) return false;
    const pacingFrontier = this._getPacingFrontier ? this._getPacingFrontier() : this.bufferEndSec;
    if (elapsed < pacingFrontier - marginSec) return false;
    this._waitingForInference = true;
    this._onWaitStateChange(true);
    void this._suspendContext();
    if (onEnterWait) onEnterWait();
    return true;
  }

  /**
   * Called when a chunk arrives after underrun. Resumes AudioContext if it was
   * suspended. Returns true if recovery happened (caller should adjust
   * playbackStartTime and restart rAF).
   */
  async resumeFromWait() {
    if (!this._waitingForInference) return false;
    if (this._resumeTransition) {
      await this._resumeTransition;
      return !this._contextSuspended;
    }
    const p = (async () => {
      // 先等 suspend 真正落地、context 真正 running，再清 waiting：
      // 否则这中间的 checkUnderrun 会再次进入冻结。
      const resumed = await this._resumeContext();
      if (!resumed) {
        // resume 失败：保持 waiting，watchdog 会重试。清 waiting 会让调度器
        // 以为已经恢复，继续往一个仍 suspended 的 context 里排块。
        console.warn('[StreamingScheduler] resume failed; keeping underrun wait for retry');
        return false;
      }
      this._waitingForInference = false;
      this._onWaitStateChange(false);
      return true;
    })();
    this._resumeTransition = p;
    try {
      return await p;
    } finally {
      if (this._resumeTransition === p) this._resumeTransition = null;
    }
  }

  /**
   * 所有已排程 source 都已播完（由 source.onended 调用）—— underrun 的最后一道
   * 防线，**不依赖 rAF / 定时器**。
   *
   * 为什么必须有：窗口最小化或被完全遮挡时，Chromium 把 rAF 与 250ms 看门狗
   * 一起节流到约 1 次/分钟。若此刻推理还没送来下一块，播放头会在无人冻结的
   * 情况下冲过缓冲前沿；之后到达的每一块都按"迟到"裁头甚至整块丢弃，听感是
   * "从这里开始再也没有声音"，只有点播放头/重播（新建会话重新锚定）才恢复。
   * source.onended 由音频线程在缓冲播完的瞬间触发，不受后台定时器节流影响 ——
   * 它给出最后一个"时钟还停在前沿"的窗口，此时冻结不会丢任何内容。
   *
   * @param {() => void} [onEnterWait] - 进入等待时的 UI 回调（如重绘）
   * @returns {boolean} 是否进入了等待冻结
   */
  onSourcesDrained(onEnterWait) {
    if (!this._active) return false;
    if (this.inferenceDone || this.isLastReceived) return false;
    if (this._waitingForInference) return false;
    if (this.activeSourceCount > 0) return false;
    if (this.bufferEndSec <= 0) return false;
    // onended 任务派发可能略晚于精确的前沿时刻；0.05s 容差保证仍能命中。
    return this.checkUnderrun(this._getElapsed(), onEnterWait, 0.05);
  }

  /**
   * Mark inference as done. No more underrun waits will be triggered.
   * If currently waiting, resumes the context.
   */
  async setInferenceDone() {
    this.inferenceDone = true;
    if (this._waitingForInference) {
      await this.resumeFromWait();
    }
  }

  /**
   * Start the streaming session's watchdog.
   *
   * **Non-destructive**: must NOT reset bufferEndSec / inferenceDone /
   * activeSourceCount. Callers activate on the first chunk that actually
   * sounds, which can be *after* the synthesis invoke already resolved
   * (cold AudioContext creation, cached-audio burst replay). Resetting there
   * wipes the already-set inferenceDone flag, so the final underrun freeze
   * has nobody left to resume it — playback dies before the end and the
   * playhead hangs forever. State is initialised in the constructor and only
   * cleared by an explicit reset() on a brand-new session.
   */
  activate() {
    this._active = true;
    this.startWatchdog();
  }

  /** End the streaming session (pause/stop/seek). Aborts context if suspended. */
  deactivate() {
    this._active = false;
    this._waitingForInference = false;
    this._clearWatchdog();
    if (this._contextSuspended || this._suspendInFlight) {
      void this._abortContext();
    }
  }

  /** Full reset of all state for a new streaming session. */
  reset() {
    this.bufferEndSec = 0;
    this.inferenceDone = false;
    this.isLastReceived = false;
    this.activeSourceCount = 0;
    this._finished = false;
    this._waitingForInference = false;
    this._contextSuspended = false;
    this._suspendInFlight = null;
    this._resumeInFlight = null;
    this._clearWatchdog();
  }

  // ==================== Watchdog ====================

  startWatchdog() {
    if (this._watchdogTimer) return;
    const tick = () => {
      if (!this._active) { this._watchdogTimer = null; return; }
      try {
        const elapsed = this._getElapsed();
        // 提前量含一个 tick 的量化误差：watchdog 看到前沿时播放头已经冲过去了。
        this.checkUnderrun(elapsed, undefined, this.requiredUnderrunMarginSec(WATCHDOG_TICK_MS / 1000));
      } catch (_) {}
      this._watchdogTimer = setTimeout(tick, WATCHDOG_TICK_MS);
    };
    this._watchdogTimer = setTimeout(tick, WATCHDOG_TICK_MS);
  }

  _clearWatchdog() {
    if (this._watchdogTimer) {
      clearTimeout(this._watchdogTimer);
      this._watchdogTimer = null;
    }
  }

  // ==================== AudioContext suspend/resume ====================

  async _suspendContext() {
    if (this._contextSuspended) return;
    const ctx = this._getCtx();
    if (ctx && ctx.state === 'running') {
      this._contextSuspended = true;
      const t0 = Date.now();
      const p = (async () => {
        try {
          await ctx.suspend();
        } catch (err) {
          // suspend 失败必须回退内部标志：否则后续 underrun 会认为已冻结
          // 而永远不再尝试，context 实际仍在 running。
          this._contextSuspended = false;
          console.warn('[StreamingScheduler] Failed to suspend context:', err.message);
          return;
        }
        // 观测"发出 suspend"到"设备真正冻结时钟"之间的控制消息延迟。
        const sec = Math.max(0, Date.now() - t0) / 1000;
        const prev = _suspendLatencyByCtx.get(ctx) || 0;
        _suspendLatencyByCtx.set(ctx, Math.max(sec, prev * SUSPEND_LATENCY_DECAY));
      })();
      this._suspendInFlight = p;
      try { await p; } finally {
        if (this._suspendInFlight === p) this._suspendInFlight = null;
      }
    }
  }

  /** @returns {Promise<boolean>} 解冻后 AudioContext 是否真的不再 suspended。 */
  async _resumeContext() {
    // 合并并发的解冻请求：resumeFromWait 与播放头自愈循环可能同一时刻各发一次
    // resume()，双倍控制消息只会加重排队（极端负载下实测每个接缝出现两次）。
    if (this._resumeInFlight) {
      try { await this._resumeInFlight; } catch (_) {}
      return !this._contextSuspended;
    }
    if (!this._contextSuspended) return true;
    if (this._suspendInFlight) {
      try { await this._suspendInFlight; } catch (_) {}
    }
    this._contextSuspended = false;
    const ctx = this._getCtx();
    const p = (async () => {
      if (ctx && ctx.state === 'suspended') {
        try {
          await ctx.resume();
          // 以真实 ctx.state 为准：resume() 返回成功也可能仍未真正恢复。
          this._contextSuspended = ctx.state === 'suspended';
        } catch (err) {
          // 失败时保持 suspended，让 watchdog 还能再试一次。
          this._contextSuspended = true;
          console.warn('[StreamingScheduler] Failed to resume context:', err.message);
        }
      } else {
        this._contextSuspended = ctx ? ctx.state === 'suspended' : false;
      }
    })();
    this._resumeInFlight = p;
    try { await p; } finally {
      if (this._resumeInFlight === p) this._resumeInFlight = null;
    }
    // 以真实状态为准：resume() 抛异常或返回后仍是 suspended 都算失败。
    return !this._contextSuspended;
  }

  async _abortContext() {
    this._waitingForInference = false;
    this._contextSuspended = false;
    const inflight = this._suspendInFlight;
    this._suspendInFlight = null;
    if (inflight) { try { await inflight; } catch (_) {} }
    // 已有 resume 在落地时不要第二次 resume()：等它，但等待后必须复查真实
    // 状态——resume 抛错或被拒绝时 context 仍可能停在 suspended。
    const resuming = this._resumeInFlight;
    if (resuming) { try { await resuming; } catch (_) {} }
    if (this._resumeTransition) {
      try { await this._resumeTransition; } catch (_) {}
    }
    const ctx = this._getCtx();
    if (ctx && ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (_) {}
    }
  }

  _checkCompletion() {
    // 一次性标志：onFinish 只允许触发一次，直到下次 reset()（新会话）。
    if (this._finished) return;
    if (this.isLastReceived && this.activeSourceCount <= 0) {
      this._finished = true;
      this._onFinish();
    }
  }
}
