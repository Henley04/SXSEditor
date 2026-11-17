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
    this._waitingForInference = false;
    this._onWaitStateChange(false);
    await this._resumeContext();
    return true;
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

  /** Start a new streaming session. */
  activate() {
    this._active = true;
    this.reset();
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
    this._contextSuspended = true;
    const ctx = this._getCtx();
    if (ctx && ctx.state === 'running') {
      const t0 = Date.now();
      const p = ctx.suspend().catch(err => {
        console.warn('[StreamingScheduler] Failed to suspend context:', err.message);
      }).then(() => {
        // 观测"发出 suspend"到"设备真正冻结时钟"之间的控制消息延迟。
        // 这段时间里渲染时钟照常前进，正是裁头量下限 —— 必须计入提前量。
        const sec = Math.max(0, Date.now() - t0) / 1000;
        const prev = _suspendLatencyByCtx.get(ctx) || 0;
        _suspendLatencyByCtx.set(ctx, Math.max(sec, prev * SUSPEND_LATENCY_DECAY));
      });
      this._suspendInFlight = p;
      try { await p; } finally {
        if (this._suspendInFlight === p) this._suspendInFlight = null;
      }
    }
  }

  async _resumeContext() {
    // 合并并发的解冻请求：resumeFromWait 与播放头自愈循环可能同一时刻各发一次
    // resume()，双倍控制消息只会加重排队（极端负载下实测每个接缝出现两次）。
    if (this._resumeInFlight) {
      try { await this._resumeInFlight; } catch (_) {}
      return;
    }
    if (!this._contextSuspended) return;
    if (this._suspendInFlight) {
      try { await this._suspendInFlight; } catch (_) {}
    }
    this._contextSuspended = false;
    const ctx = this._getCtx();
    const p = (async () => {
      if (ctx && ctx.state === 'suspended') {
        try { await ctx.resume(); } catch (err) {
          console.warn('[StreamingScheduler] Failed to resume context:', err.message);
        }
      }
    })();
    this._resumeInFlight = p;
    try { await p; } finally {
      if (this._resumeInFlight === p) this._resumeInFlight = null;
    }
  }

  async _abortContext() {
    this._waitingForInference = false;
    this._contextSuspended = false;
    const inflight = this._suspendInFlight;
    this._suspendInFlight = null;
    if (inflight) { try { await inflight; } catch (_) {} }
    // 已有 resume 在落地时不要第二次 resume()：等它，效果一样，控制消息少一条。
    const resuming = this._resumeInFlight;
    if (resuming) { try { await resuming; } catch (_) {} return; }
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
