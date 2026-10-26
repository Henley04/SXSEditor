/**
 * 分片内"参与合成"的音符集合 —— **唯一真源**。
 *
 * 背景（审查报告 F2 / F3）：渲染层与主窗口各自复制了一份构造逻辑，导致三处分叉：
 *   1) 主窗口（audioPlayback / mcpAutomation）**不过滤**未激活的重叠音符，而编辑器
 *      过滤 —— 同一工程在编辑器里静音的段落，主窗口播放/导出会唱出来；
 *   2) 四处都**不排序**，而下游消费方隐式假定有序：
 *        · buildPitchCurveF0Data 取末元素当"最晚音符" → F0 数组被截断；
 *        · 音频前置偏移取 clippedNotes[0] 当"最早音符" → 音频整体平移；
 *   3) 相邻音符的"最晚结束"未必是数组末元素（长音符在前、短音符在后时），
 *      因此除了排序，总时长必须用 max(start+duration) 显式求。
 *
 * 本模块无 DOM、无 state，主窗口与分片编辑器共用。
 */

/**
 * 计算未激活（被遮挡）的 note id 集合。
 *
 * 规则：同一时间点只能有一个 note 被激活，**按传入数组顺序**（先插入者优先）判定；
 * 后面的 note 只要与前面任意已激活 note 时间重叠（跨 pitch），即标记为未激活。
 *
 * 注意：这里刻意按"原始数组顺序"而非排序后顺序判定 —— 与历史行为一致
 * （同 start 多 note 时先插入者激活），换成排序序会变成"更长者激活"，
 * 属用户可见的行为变化。
 *
 * @param {Array<{id:any,start:number,duration:number}>} notes
 * @returns {Set<any>}
 */
export function computeInactiveNoteIds(notes) {
  const inactive = new Set();
  const activeRanges = []; // 已激活 note 的时间区间
  for (const n of notes) {
    const nEnd = n.start + n.duration;
    let overlapped = false;
    for (const r of activeRanges) {
      if (n.start < r.end && nEnd > r.start) { overlapped = true; break; }
    }
    if (overlapped) inactive.add(n.id);
    else activeRanges.push({ start: n.start, end: nEnd });
  }
  return inactive;
}

/**
 * 裁剪到分片时长：起点超过分片末的丢弃，跨越末端的截断 duration。
 * @param {Array} notes
 * @param {number} fragDuration 分片时长（拍）；非正/缺省时不裁剪
 * @returns {Array}
 */
export function clipNotesToDuration(notes, fragDuration) {
  if (!(fragDuration > 0)) return notes.slice();
  const out = [];
  for (const note of notes) {
    if (note.start >= fragDuration) continue;
    const noteEnd = note.start + note.duration;
    if (noteEnd > fragDuration) out.push({ ...note, duration: fragDuration - note.start });
    else out.push(note);
  }
  return out;
}

/**
 * 参与合成的音符：过滤未激活重叠 → 裁剪到分片时长 → 按 start 升序
 * （同 start 取较长者在前，与 _getActiveSortedNotes 一致）。
 *
 * @param {object|null} fragment 分片（取 duration）；null 时按全量处理
 * @param {Array} notes 原始 notes 数组
 * @returns {Array} 新数组（元素可能是原引用或浅拷贝，调用方不要原地改）
 */
export function computeActiveClippedNotes(fragment, notes) {
  const all = Array.isArray(notes) ? notes : [];
  const inactiveIds = computeInactiveNoteIds(all);
  const active = inactiveIds.size > 0 ? all.filter((n) => !inactiveIds.has(n.id)) : all;
  const fragDuration = fragment && fragment.duration ? fragment.duration : 0;
  const clipped = clipNotesToDuration(active, fragDuration);
  return clipped.sort((a, b) => a.start - b.start || b.duration - a.duration);
}

/**
 * 一组音符的"最晚结束时间"（拍）。取 max(start+duration)，**不使用数组末元素**。
 * 无音符时返回 0。
 */
export function lastNoteEnd(notes) {
  let end = 0;
  for (const n of notes) {
    const e = n.start + n.duration;
    if (e > end) end = e;
  }
  return end;
}

/**
 * 一组音符的"最早起点"（拍）。取 min(start)，**不使用首元素**。
 * 无音符时返回 0。
 */
export function firstNoteStart(notes) {
  let start = Infinity;
  for (const n of notes) if (n.start < start) start = n.start;
  return Number.isFinite(start) ? start : 0;
}
