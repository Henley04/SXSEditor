/**
 * SequencedChunkQueue —— 分片/流式音频 chunk 的有序交付队列。
 *
 * 借鉴 kizuna-ai-lab/sokuji 的 ModernAudioPlayer 序列排序实现，但做了关键适配：
 *   · sokuji 是网络实时流，chunk 带整数 sequenceNumber，序号 +1 即"下一个"；
 *   · 本项目的 chunk 来自本地 GPU 推理，带绝对采样区间 {sampleOffset, sampleEnd}，
 *     chunk 长度可变（vocoder 分块 + 静音 gap + segment overlap），不存在固定 +1。
 *
 * 因此这里用「采样前沿 frontier」代替整数序号，三态语义一一对应：
 *   1) 正好接续  start <= frontier + tol  → 立即交付，随后冲刷缓冲里的连续块；
 *   2) 超前(缺口) start >  frontier + tol  → 暂存 out-of-order + 启动 gap 超时；
 *   3) 重复/过时  end   <= frontier + tol  → 丢弃（整块已被前沿覆盖）。
 *
 * 兜底：gap 超时（默认 100ms）后按 sampleOffset 排序强制交付所有暂存块，并
 * "跳跃式"把 frontier 更新到最后一块的 sampleEnd —— 承认缺口不可弥补、让播放
 * 继续，而不是让播放头永久卡在静音等待（对应 sokuji _forceProcessBufferedSequences）。
 *
 * seek：rebase(target) 采用 moq "parking the playhead" 思想——不销毁缓冲/上下文，
 * 而是跳跃式重锚 frontier 到目标采样位置，丢弃目标之前的块、保留之后的块，
 * 让已到达的"未来"chunk 在 seek 后仍能接续消费。
 *
 * 零依赖：既可被渲染进程 require/import，也可被 Node 直接单测。
 * 计时器可注入（setTimer/clearTimer），便于虚拟时钟确定性测试。
 */

class SequencedChunkQueue {
  /**
   * @param {Object} [opts]
   * @param {(chunkInfo:Object)=>void} opts.onChunk - 有序交付回调（真正消费/排程播放）
   * @param {number} [opts.gapTimeoutMs=100] - 缺口兜底超时（毫秒）
   * @param {number} [opts.toleranceSamples=0] - 采样取整容差（衔接判定用）
   * @param {(info:Object)=>void} [opts.onGap] - 缺口触发诊断回调
   * @param {(chunk:Object, reason:string)=>void} [opts.onDuplicate] - 丢弃重复/过时块回调
   * @param {(chunk:Object, gapSamples:number)=>void} [opts.onOutOfOrder] - 暂存乱序块回调
   * @param {()=>number} [opts.now] - 时钟（毫秒），便于测试
   * @param {(fn:Function, ms:number)=>*} [opts.setTimer] - 定时器设置（注入）
   * @param {(id:*)=>void} [opts.clearTimer] - 定时器清除（注入）
   */
  constructor(opts = {}) {
    this.gapTimeoutMs = Number.isFinite(opts.gapTimeoutMs) ? opts.gapTimeoutMs : 100;
    this.toleranceSamples = Number.isFinite(opts.toleranceSamples) ? opts.toleranceSamples : 0;
    this.onChunk = opts.onChunk || (() => {});
    this.onGap = opts.onGap || (() => {});
    this.onDuplicate = opts.onDuplicate || (() => {});
    this.onOutOfOrder = opts.onOutOfOrder || (() => {});
    this._now = opts.now || (() => Date.now());
    this._setTimer = opts.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this._clearTimer = opts.clearTimer || ((id) => clearTimeout(id));
    this.reset(0);
  }

  /** 新会话/重播：清空前沿、缓冲与定时器。 */
  reset(frontier = 0) {
    // 未触发的兜底定时器必须真正取消：只把句柄置 null 会让它活到下一轮会话，
    // 到期后强制冲刷新会话的缓冲并跳跃前沿（停止→重播时的跨会话污染）。
    this._clearGapTimer();
    this.frontier = Number.isFinite(frontier) ? frontier : 0;
    this.buffer = new Map();          // sampleOffset -> chunkInfo
    this._finished = false;
    this._stats = {
      received: 0, consumed: 0, duplicate: 0,
      outOfOrder: 0, forced: 0, gaps: 0,
    };
  }

  get size() { return this.buffer.size; }
  get isFinished() { return this._finished; }

  _armGapTimer() {
    if (this._gapTimer != null) this._clearTimer(this._gapTimer);
    this._gapTimer = this._setTimer(() => {
      this._gapTimer = null;
      this._forceFlush('timeout');
    }, this.gapTimeoutMs);
  }

  _clearGapTimer() {
    if (this._gapTimer != null) {
      this._clearTimer(this._gapTimer);
      this._gapTimer = null;
    }
  }

  /**
   * 推入一个 chunk。返回处理分支标识，便于诊断/测试。
   * @param {Object} chunkInfo - { sampleOffset, sampleEnd, audio, isLast, ... }
   */
  push(chunkInfo) {
    if (!chunkInfo || !chunkInfo.audio || chunkInfo.audio.length === 0) return 'empty';
    this._stats.received++;

    const start = Number(chunkInfo.sampleOffset);
    const end = Number(chunkInfo.sampleEnd);
    const hasRange = Number.isFinite(start) && Number.isFinite(end) && end > start;

    // 无采样区间（旧版主进程 / 插件后端）：退化为到达顺序交付，行为与旧实现一致。
    if (!hasRange) {
      this._consume(chunkInfo, NaN);
      return 'consumed';
    }

    const tol = this.toleranceSamples;
    const frontier = this.frontier;

    // 情况 3：重复或过时 —— 整块（含容差）已被前沿覆盖，直接丢弃。
    if (end <= frontier + tol) {
      this._stats.duplicate++;
      this.onDuplicate(chunkInfo, 'stale');
      if (chunkInfo.isLast) this._deliverLastFlag(chunkInfo);
      return 'duplicate';
    }

    // 情况 1：正好接续（允许小段重叠）—— 立即交付，随后冲刷缓冲里的连续块。
    if (start <= frontier + tol) {
      this._consume(chunkInfo, end);
      this._flushContiguous();
      return 'consumed';
    }

    // 情况 2：超前 —— 存在缺口，暂存并启动超时兜底。
    if (this.buffer.has(start)) {
      // 同一采样起点重复到达：保留先到的，避免接缝重复播放。
      this._stats.duplicate++;
      this.onDuplicate(chunkInfo, 'buffered');
      if (chunkInfo.isLast) this._deliverLastFlag(chunkInfo);
      return 'buffered-duplicate';
    }
    this._stats.outOfOrder++;
    this.buffer.set(start, chunkInfo);
    this.onOutOfOrder(chunkInfo, start - frontier);
    this._armGapTimer();
    return 'buffered';
  }

  /** 交付：更新前沿（采样域）并回调真正消费者。 */
  _consume(chunkInfo, end) {
    if (Number.isFinite(end)) this.frontier = Math.max(this.frontier, end);
    this._stats.consumed++;
    this.onChunk(chunkInfo);
  }

  /** 冲刷缓冲：只要下一个块的起点已在前沿之内（含容差），就按序连续交付。 */
  _flushContiguous() {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const starts = Array.from(this.buffer.keys()).sort((a, b) => a - b);
      for (const start of starts) {
        const chunk = this.buffer.get(start);
        const end = Number(chunk.sampleEnd);
        if (start <= this.frontier + this.toleranceSamples) {
          this.buffer.delete(start);
          this._consume(chunk, end);
          progressed = true;
        } else {
          break; // 有序数组，后续起点只会更大，等下一次缺口补齐
        }
      }
    }
    if (this.buffer.size === 0) this._clearGapTimer();
  }

  /**
   * 超时/收尾兜底：按 sampleOffset 排序强制交付所有暂存块，跳跃式更新前沿。
   * 缺口区间没有音频可造，表现为客观静音；但播放不会永久卡死。
   */
  _forceFlush(reason) {
    if (this.buffer.size === 0) return;
    const starts = Array.from(this.buffer.keys()).sort((a, b) => a - b);
    this._stats.gaps++;
    this._stats.forced += starts.length;
    this.onGap({ reason, gapFrom: this.frontier, gapTo: starts[0], count: starts.length });
    for (const start of starts) {
      const chunk = this.buffer.get(start);
      this.buffer.delete(start);
      this._consume(chunk, Number(chunk.sampleEnd));
    }
  }

  /** 推理完成：不再等缺口，排空所有暂存块。 */
  finish() {
    this._finished = true;
    this._clearGapTimer();
    this._forceFlush('finish');
  }

  /**
   * parking-style seek：跳跃式重锚前沿到目标采样位置。
   * 丢弃目标之前的块，保留之后的块（缓冲与上下文不销毁），随后尝试接续冲刷；
   * 若仍有缺口则重新启动超时，让"未来"chunk 自然到达后继续。
   * @param {number} targetSample - 目标采样位置（与 sampleOffset 同坐标系）
   */
  rebase(targetSample) {
    const target = Number.isFinite(targetSample) ? targetSample : 0;
    this._clearGapTimer();
    this.frontier = target;
    for (const [start, chunk] of this.buffer) {
      if (Number(chunk.sampleEnd) <= target + this.toleranceSamples) this.buffer.delete(start);
    }
    if (this.buffer.size > 0) {
      this._flushContiguous();
      if (this.buffer.size > 0) this._armGapTimer();
    }
  }

  /**
   * 重复/过时块若携带 isLast，仍需把"最后一块已到达"信号透传出去，
   * 否则依赖 markLastReceived 的收尾判定会漏触发（与 isLast 语义保持一致）。
   */
  _deliverLastFlag(chunkInfo) {
    // 复制一个空音频标记块，仅传递 isLast，避免把重复音频再播一遍。
    this.onChunk({ ...chunkInfo, audio: new Float32Array(0), __lastOnly: true });
  }

  stats() {
    return Object.assign({}, this._stats, {
      frontier: this.frontier,
      buffered: this.buffer.size,
    });
  }
}

// CommonJS 导出（Node 单测 / Electron 主进程 require）
if (typeof module !== 'undefined' && module.exports) {
  module.exports = SequencedChunkQueue;
  module.exports.SequencedChunkQueue = SequencedChunkQueue;
}
// ESM 命名导出由 webpack/babel 通过 CommonJS interop 处理；如未来需纯 ESM 可追加 export。
