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
 *   3. 占位按**已排程区间集合**（`coveredRanges`）判定，不是单一前沿。
 *      重叠块裁头、重复块丢弃、乱序块回填 —— 后段先到时它只占自己的区间，
 *      前段随后到达仍能按原时刻排进去（旧的"单一前沿"会把前段整块误判为重复）。
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
 * @property {Array<{skipSamples:number,when:number,offsetSec:number,durationSec:number,contentStartSec:number,contentEndSec:number}>} segments
 *   实际要排程的片段（通常一段；块被已排区间切成多段时逐段排，避免静默丢音频）
 * @property {number} [splitParts] 该块被已排程区间切成了几段
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
    /** 已排程内容的最远末端（分片绝对秒）—— 收尾判定 / UI 前沿用。 */
    this.deliveredEndSec = this.startPositionSec;
    /** 已排程内容区间 [{start,end}]，升序且互不重叠（乱序回填 / 去重的判据）。 */
    this.coveredRanges = [];
    /** 无 sampleOffset 时的顺序拼接游标（相对首音符）。 */
    this.seqCursorSec = 0;
    /** 已排程块数 / 丢弃块数 / 迟到块数 / 乱序回填块数（诊断用）。 */
    this.scheduledCount = 0;
    this.droppedCount = 0;
    this.lateCount = 0;
    this.backfillCount = 0;
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
   * 把已排程区间 [from, to) 记入账本（与相邻区间合并）。
   * 只增不减：区间代表"这段时间轴已经被占用"，与是否真的播完无关。
   *
   * @param {number} from
   * @param {number} to
   */
  _cover(from, to) {
    if (!(to > from)) return;
    const ranges = this.coveredRanges;
    let i = 0;
    while (i < ranges.length && ranges[i].end < from) i++;
    let start = from;
    let end = to;
    let j = i;
    while (j < ranges.length && ranges[j].start <= end) {
      start = Math.min(start, ranges[j].start);
      end = Math.max(end, ranges[j].end);
      j++;
    }
    ranges.splice(i, j - i, { start, end });
    this.deliveredEndSec = Math.max(this.deliveredEndSec, end);
  }

  /**
   * 求 [from, to) 中**尚未被占用**的片段（升序）。
   *
   * 这是"乱序回填"的关键：后段先到时只登记自己的区间，前段随后到达仍能看到
   * 一段空白并原样排进去。若改用单一前沿（旧的 deliveredEndSec），前段会被
   * 整块当成重复丢掉 —— 表现为"偶发缺一句、播放头照走"。
   *
   * @param {number} from
   * @param {number} to
   * @returns {Array<{start:number,end:number}>}
   */
  _uncoveredParts(from, to) {
    const parts = [];
    let cursor = from;
    for (const r of this.coveredRanges) {
      if (r.end <= cursor) continue;
      if (r.start >= to) break;
      if (r.start > cursor) parts.push({ start: cursor, end: Math.min(r.start, to) });
      cursor = Math.max(cursor, r.end);
      if (cursor >= to) break;
    }
    if (cursor < to) parts.push({ start: cursor, end: to });
    return parts;
  }

  /**
   * 规划一个 chunk。
   *
   * @param {{sampleOffset?: number, sampleEnd?: number, audio?: Float32Array}} chunkInfo
   * @param {number} sampleRate
   * @param {number} ctxNow 当前 `ctx.currentTime`
   * @returns {StreamChunkPlan}
   */
  plan(chunkInfo, sampleRate, ctxNow, opts = {}) {
    // reserve=false：先把排程方案算出来但不记账。调用方（_handleChunk）必须
    // 在 source.start() 真正成功后再 commit —— 否则 start 失败也会留下
    // coveredRanges 占位，后续重传被判重复 → 永久静音。单测直接调 plan()
    // 时保持默认 reserve=true，既有契约不变。
    const reserve = opts.reserve !== false;
    const audioLength = chunkInfo && chunkInfo.audio ? chunkInfo.audio.length : 0;
    if (audioLength <= 0) {
      this.droppedCount += 1;
      return this._drop('empty');
    }

    const { contentStartSec, contentEndSec } = this._contentRange(chunkInfo, sampleRate);
    const fromSec = Math.max(contentStartSec, this.startPositionSec);
    const deliveredBeforeSec = this.deliveredEndSec;
    const parts = this._uncoveredParts(fromSec, contentEndSec);

    if (parts.length === 0) {
      // 整块都在起播点之前 / 已被前一块覆盖：丢弃。**不建立时间基准** ——
      // 否则后续块会被按"从首个收到块算起"的迟到量裁头。
      const reason = contentEndSec <= this.startPositionSec + EPS_SEC ? 'before-start' : 'duplicate';
      this.droppedCount += 1;
      return this._drop(reason);
    }

    // 到这里说明这一块"应该出声"（或至少部分落在起播点之后），此刻才锚定。
    const startedNow = !this.started;
    if (startedNow) this.anchorCtxTime = ctxNow + this.leadSec;

    // 一个块被已排程区间切成多段时逐段排程 —— 少排一段就是静默丢一句歌词，
    // 而 WebAudio 完全支持同一块音频按不同 offset 排多个 source。
    const segments = [];
    let scheduledEndSec = 0;
    for (const part of parts) {
      const skipSamples = Math.max(0, Math.round((part.start - contentStartSec) * sampleRate));
      const availableSamples = audioLength - skipSamples;
      if (availableSamples <= 0) continue;
      // 只播到本段末端（被后面的已排区间截断时不能越界播放）。
      const durSec = Math.min(availableSamples / sampleRate, part.end - part.start);
      if (durSec <= EPS_SEC) continue;

      // 内容位置 X 应在 anchor + (X − startPosition) 出声。
      const wantCtxTime = this.anchorCtxTime + (part.start - this.startPositionSec);
      // 迟到只裁头、不移基准：把这部分从头部裁掉，内容位置始终等于播放头位置。
      const lateSec = Math.max(0, ctxNow - wantCtxTime);
      if (lateSec >= durSec - EPS_SEC) {
        this.lateCount += 1;
        continue;
      }
      segments.push({
        skipSamples,
        when: wantCtxTime + lateSec,
        offsetSec: lateSec,
        durationSec: durSec - lateSec,
        // 该段完整长度（未扣迟到）。排程时按它切片、用 offsetSec 表示迟到裁头；
        // 若按 durationSec 切片再传 offsetSec，late 会被扣两次（尾部被吃掉）。
        sourceDurationSec: durSec,
        contentStartSec: part.start,
        contentEndSec: part.start + durSec,
      });
      scheduledEndSec = Math.max(scheduledEndSec, part.start + durSec);
    }

    if (segments.length === 0) {
      this.droppedCount += 1;
      // 丢掉整块但保留基准：基准代表时间轴原点，丢了它下一块会重新锚定，
      // 播放头会凭空回跳。
      return this._drop('late', startedNow);
    }

    if (reserve) this._commitPlan(fromSec, segments, startedNow, deliveredBeforeSec);

    const first = segments[0];
    return {
      action: 'schedule',
      fromSec,
      deliveredBeforeSec,
      startedNow,
      // 以下字段是"第一段"的等价描述（兼容既有调用方 / 测试）。
      when: first.when,
      offsetSec: first.offsetSec,
      skipSamples: first.skipSamples,
      contentStartSec: first.contentStartSec,
      contentEndSec: scheduledEndSec,
      durationSec: first.durationSec,
      segments,
      splitParts: parts.length,
    };
  }

  /** 给 plan(reserve:false) 的调用方补记账：只登记真正启动成功的段。 */
  commit(plan, startedSegments) {
    if (!plan || plan.action !== 'schedule' || !plan.segments) return;
    if (!Array.isArray(startedSegments) || startedSegments.length === 0) return;
    this._commitPlan(plan.fromSec, startedSegments, plan.startedNow, plan.deliveredBeforeSec);
  }

  _commitPlan(fromSec, segments, startedNow, deliveredBeforeSec) {
    let endSec = 0;
    for (const s of segments) {
      // 每段只登记自己的区间：块被切成多段时，中间的空洞不能被一并标记覆盖。
      this._cover(s.contentStartSec, s.contentEndSec);
      endSec = Math.max(endSec, s.contentEndSec);
    }
    if (endSec > 0) this.deliveredEndSec = Math.max(this.deliveredEndSec, endSec);
    this.scheduledCount += 1;
    if (segments.some((s) => s.offsetSec > 0)) this.lateCount += 1;
    // 乱序回填 = 排到了"已交付末端之前"的位置（后段先到、前段后到）。
    if (!startedNow && fromSec + EPS_SEC < deliveredBeforeSec) this.backfillCount += 1;
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
      segments: [],
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
