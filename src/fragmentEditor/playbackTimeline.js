/**
 * 分片编辑器流式播放的时间轴模型 —— **唯一时间真源**。
 *
 * 背景：流式预览同时存在四套时间坐标，旧实现把它们散在模块级变量里
 * （`_streamingFirstNoteStartSec` / `_streamingPlayFromSec` /
 * `_streamingDeliveredEndSec` / `_streamingSeqCursorSec`），任何一个在错误的
 * 时机被写一次，播放头与声音就永久错开，而且不同路径（缓存命中 / 多段拼接 /
 * 拖动起播）各错各的。这里把换算收进一个对象：
 *
 *   · chunk 采样坐标：`sampleOffset` 相对**首音符起点**（pipeline 约定）
 *   · 内容坐标：分片绝对秒（画布 / 播放头 / 起播位置都用它）
 *   · 上下文坐标：`AudioContext.currentTime`（调度域，声音真正排程的时刻）
 *
 * 三条不变量：
 *   1. 时间基准（anchor）只在**第一个真正要发声**的 chunk 上建立一次。
 *      起播点之前的 chunk 整块丢弃，绝不提前锚定 —— 旧实现一收到第一个 chunk
 *      就锚定，若它整块在起播点之前，后续每块都被算成"迟到"，头部被裁光，
 *      表现为"从中段起播没有声音 / 播放头空跑"。
 *   2. 锚定之后永不重建。迟到只裁头（`offsetSec`），不改 `when` 的斜率。
 *   3. 已交付末端只前进，且与内容坐标同源 —— 重叠块 / 迟到块都只裁头。
 *
 * 纯函数式对象：不碰 DOM、不碰 AudioContext，可在单测里直接驱动。
 */

/** 起播提前量：给设备一个渲染量子，避免首块排在过去。 */
export const STREAM_LEAD_SEC = 0.05;

/** 采样级容差（1 样本 ≈ 0.04ms @24k），避免 float 往返把整块判成"有剩余"。 */
const EPS_SEC = 1e-6;

/**
 * @typedef {Object} StreamChunkPlan
 * @property {'schedule'|'drop'} action
 * @property {'empty'|'before-start'|'duplicate'|'late'|'no-audio'} [reason]
 * @property {boolean} startedNow 本次是否刚建立时间基准
 * @property {number} when 排程的上下文时刻（秒）
 * @property {number} offsetSec 从 chunk 音频头部裁掉的秒数（迟到）
 * @property {number} skipSamples 从源音频跳过的采样数（起播点 / 重叠）
 * @property {number} contentStartSec 实际发声内容起点（分片绝对秒）
 * @property {number} contentEndSec chunk 内容末端（分片绝对秒）
 * @property {number} durationSec 剩余可播时长
 */

export class StreamTimeline {
  /**
   * @param {{startPositionSec?: number, firstNoteStartSec?: number, leadSec?: number}} [opts]
   */
  constructor({ startPositionSec = 0, firstNoteStartSec = 0, leadSec = STREAM_LEAD_SEC } = {}) {
    this.startPositionSec = Math.max(0, Number(startPositionSec) || 0);
    this.firstNoteStartSec = Math.max(0, Number(firstNoteStartSec) || 0);
    this.leadSec = Number.isFinite(leadSec) ? leadSec : STREAM_LEAD_SEC;
    /** 内容位置 startPositionSec 对应的 ctx 时刻；未起播为 null。 */
    this.anchorCtxTime = null;
    /** 已排程内容的最远末端（分片绝对秒）。 */
    this.deliveredEndSec = this.startPositionSec;
    /** 无 sampleOffset 时的顺序拼接游标（相对首音符）。 */
    this.seqCursorSec = 0;
    /** 已排程块数 / 丢弃块数（诊断用）。 */
    this.scheduledCount = 0;
    this.droppedCount = 0;
    this.lateCount = 0;
  }

  /** 时间基准是否已建立（= 是否已经开始出声）。 */
  get started() {
    return this.anchorCtxTime !== null;
  }

  /**
   * 把 chunk 换算成内容区间。
   *
   * 采样位置无效（旧版主进程 / 插件后端不带 sampleOffset）时退化为顺序拼接：
   * 接在已交付内容之后。游标"收到即前进"（含随后被丢弃的块），保证每块只占
   * 一次位，否则后续块会被重复裁头。
   *
   * @param {{sampleOffset?: number, sampleEnd?: number, audio?: Float32Array}} chunkInfo
   * @param {number} sampleRate
   * @returns {{contentStartSec:number, contentEndSec:number, durationSec:number, hasSampleRange:boolean}}
   */
  _contentRange(chunkInfo, sampleRate) {
    const audioLength = chunkInfo && chunkInfo.audio ? chunkInfo.audio.length : 0;
    const rawStart = Number(chunkInfo && chunkInfo.sampleOffset);
    const rawEnd = Number(chunkInfo && chunkInfo.sampleEnd);
    const hasSampleRange = Number.isFinite(rawStart) && Number.isFinite(rawEnd) && rawEnd > rawStart;
    const chunkSec = audioLength / sampleRate;
    const relStartSec = hasSampleRange ? rawStart / sampleRate : this.seqCursorSec;
    const relEndSec = hasSampleRange ? rawEnd / sampleRate : relStartSec + chunkSec;
    if (!hasSampleRange) this.seqCursorSec = relEndSec;
    return {
      contentStartSec: this.firstNoteStartSec + relStartSec,
      contentEndSec: this.firstNoteStartSec + relEndSec,
      durationSec: chunkSec,
      hasSampleRange,
    };
  }

  /**
   * 规划一个 chunk。
   *
   * @param {{sampleOffset?: number, sampleEnd?: number, audio?: Float32Array}} chunkInfo
   * @param {number} sampleRate
   * @param {number} ctxNow 当前 `ctx.currentTime`
   * @returns {StreamChunkPlan}
   */
  plan(chunkInfo, sampleRate, ctxNow) {
    const audioLength = chunkInfo && chunkInfo.audio ? chunkInfo.audio.length : 0;
    if (audioLength <= 0) {
      this.droppedCount += 1;
      return this._drop('empty');
    }

    const { contentStartSec, contentEndSec } = this._contentRange(chunkInfo, sampleRate);
    // 有效起点 = 起播点之后、且未被已排程内容覆盖的部分
    const effectiveStartSec = Math.max(
      contentStartSec,
      this.startPositionSec,
      this.deliveredEndSec,
    );

    if (contentEndSec <= effectiveStartSec + EPS_SEC) {
      // 整块都在起播点之前 / 已被前一块覆盖：丢弃。**不建立时间基准** ——
      // 否则后续块会被按"从首个收到块算起"的迟到量裁头。
      const reason = contentEndSec <= this.startPositionSec + EPS_SEC ? 'before-start' : 'duplicate';
      this.droppedCount += 1;
      return this._drop(reason);
    }

    // 到这里说明这一块"应该出声"（或至少部分落在起播点之后），此刻才锚定。
    const startedNow = !this.started;
    if (startedNow) this.anchorCtxTime = ctxNow + this.leadSec;

    const skipSamples = Math.max(0, Math.round((effectiveStartSec - contentStartSec) * sampleRate));
    const trimmedDurSec = (audioLength - skipSamples) / sampleRate;
    if (trimmedDurSec <= 0) {
      this.droppedCount += 1;
      return this._drop('no-audio', startedNow);
    }

    // 内容位置 X 应在 anchor + (X − startPosition) 出声。
    const wantCtxTime = this.anchorCtxTime + (effectiveStartSec - this.startPositionSec);
    // 迟到只裁头、不移基准：把这部分从头部裁掉，内容位置始终等于播放头位置。
    const lateSec = Math.max(0, ctxNow - wantCtxTime);
    if (lateSec >= trimmedDurSec - EPS_SEC) {
      this.droppedCount += 1;
      this.lateCount += 1;
      // 丢掉整块但保留基准：基准代表时间轴原点，丢了它下一块会重新锚定，
      // 播放头会凭空回跳。
      return this._drop('late', startedNow);
    }

    this.deliveredEndSec = Math.max(this.deliveredEndSec, contentEndSec);
    this.scheduledCount += 1;
    if (lateSec > 0) this.lateCount += 1;

    return {
      action: 'schedule',
      startedNow,
      when: wantCtxTime + lateSec,
      offsetSec: lateSec,
      skipSamples,
      contentStartSec: effectiveStartSec,
      contentEndSec,
      durationSec: trimmedDurSec - lateSec,
    };
  }

  _drop(reason, startedNow = false) {
    return {
      action: 'drop',
      reason,
      startedNow,
      when: 0,
      offsetSec: 0,
      skipSamples: 0,
      contentStartSec: 0,
      contentEndSec: 0,
      durationSec: 0,
    };
  }

  /**
   * 当前应显示的播放位置（分片绝对秒）。
   *
   * @param {number} ctxNow 当前 `ctx.currentTime`
   * @param {number} latencySec 设备输出延迟（人耳位置 = 渲染位置 − 延迟）
   */
  positionAt(ctxNow, latencySec = 0) {
    if (!this.started) return this.startPositionSec;
    const audible = ctxNow - (Number.isFinite(latencySec) ? latencySec : 0);
    return this.startPositionSec + Math.max(0, audible - this.anchorCtxTime);
  }
}

export default StreamTimeline;
