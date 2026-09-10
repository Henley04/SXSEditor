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
export class StreamingScheduler {
  /**
   * @param {Object} opts
   * @param {() => AudioContext} opts.getCtx - Returns the shared AudioContext
   * @param {() => number} opts.getElapsed - Returns current playback position in seconds
   * @param {(isWaiting: boolean) => void} [opts.onWaitStateChange] - Called when underrun wait starts/stops
   * @param {() => void} [opts.onFinish] - Called when all sources ended and isLast received
   */
  constructor({ getCtx, getElapsed, onWaitStateChange, onFinish }) {
    this._getCtx = getCtx;
    this._getElapsed = getElapsed;
    this._onWaitStateChange = onWaitStateChange || (() => {});
    this._onFinish = onFinish || (() => {});

    this.bufferEndSec = 0;
    this.inferenceDone = false;
    this.isLastReceived = false;
    this.activeSourceCount = 0;

    this._active = false;
    this._waitingForInference = false;
    this._contextSuspended = false;
    this._suspendInFlight = null;
    this._watchdogTimer = null;
  }

  get isWaiting() { return this._waitingForInference; }

  updateBufferFrontier(endSec) {
    if (endSec > this.bufferEndSec) this.bufferEndSec = endSec;
  }

  addSource() { this.activeSourceCount++; }

  sourceEnded() {
    this.activeSourceCount--;
    this._checkCompletion();
  }

  markLastReceived() {
    this.isLastReceived = true;
    this._checkCompletion();
  }

  /**
   * Detect buffer underrun: playhead has caught up to the buffer frontier
   * and inference is not yet complete. Freezes AudioContext.
   *
   * @param {number} elapsed - Current playback position in seconds
   * @param {() => void} [onEnterWait] - Called when entering wait state (e.g., cancel rAF, update UI)
   * @returns {boolean} true if wait state was entered (caller must return from its loop)
   */
  checkUnderrun(elapsed, onEnterWait) {
    if (this.inferenceDone || this._waitingForInference) return false;
    if (elapsed < this.bufferEndSec) return false;
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
    this._waitingForInference = false;
    this._contextSuspended = false;
    this._suspendInFlight = null;
    this._clearWatchdog();
  }

  // ==================== Watchdog ====================

  startWatchdog() {
    if (this._watchdogTimer) return;
    const tick = () => {
      if (!this._active) { this._watchdogTimer = null; return; }
      try {
        const elapsed = this._getElapsed();
        this.checkUnderrun(elapsed);
      } catch (_) {}
      this._watchdogTimer = setTimeout(tick, 250);
    };
    this._watchdogTimer = setTimeout(tick, 250);
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
      const p = ctx.suspend().catch(err => {
        console.warn('[StreamingScheduler] Failed to suspend context:', err.message);
      });
      this._suspendInFlight = p;
      try { await p; } finally {
        if (this._suspendInFlight === p) this._suspendInFlight = null;
      }
    }
  }

  async _resumeContext() {
    if (!this._contextSuspended) return;
    if (this._suspendInFlight) {
      try { await this._suspendInFlight; } catch (_) {}
    }
    this._contextSuspended = false;
    const ctx = this._getCtx();
    if (ctx && ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (err) {
        console.warn('[StreamingScheduler] Failed to resume context:', err.message);
      }
    }
  }

  async _abortContext() {
    this._waitingForInference = false;
    this._contextSuspended = false;
    const inflight = this._suspendInFlight;
    this._suspendInFlight = null;
    if (inflight) { try { await inflight; } catch (_) {} }
    const ctx = this._getCtx();
    if (ctx && ctx.state === 'suspended') {
      try { await ctx.resume(); } catch (_) {}
    }
  }

  _checkCompletion() {
    if (this.isLastReceived && this.activeSourceCount <= 0) {
      this._onFinish();
    }
  }
}
