/**
 * 静态 shape 分段窗口规划（纯函数）。
 *
 * 与旧的内联循环语义等价（从 0 起步、每次前进 winCap - overlap），但把「预算」
 * 显式参数化：调用方应传入 diff_step 模型的真实 seq（可能小于 NPU_STATIC_SEQ_LEN）。
 * 单测可直接断言：不丢帧、不重帧、overlap 不会吞掉整个窗口（advance > 0）。
 */

/**
 * @param {number} totalFrames 目标帧数
 * @param {number} ptFrameCount 每窗复用的 prompt 帧数
 * @param {number} budget 每窗允许的总序列长度（prompt + target）
 * @param {number} [requestedOverlap] 期望重叠帧数（会被限制到窗口的 1/4）
 * @returns {{winCap:number, overlap:number, advance:number, windows:Array<{segStart:number,segEnd:number,segFrames:number}>, error:string|null}}
 */
function planStaticWindows(totalFrames, ptFrameCount, budget, requestedOverlap = 50) {
    const frames = Math.max(0, Math.floor(Number(totalFrames) || 0));
    const pt = Math.max(0, Math.floor(Number(ptFrameCount) || 0));
    const seq = Math.floor(Number(budget) || 0);
    const winCap = seq - pt;
    if (seq <= 0 || winCap <= 0) {
        return {
            winCap: Math.max(0, winCap),
            overlap: 0,
            advance: 0,
            windows: [],
            error: 'NO_TARGET_BUDGET',
        };
    }
    const req = Math.max(1, Math.floor(Number(requestedOverlap) || 0));
    // overlap 不超过窗口的 1/4：否则 advance 太小，窗口数暴涨、每个窗口都要重跑
    // encoder；同时保证 advance >= 3/4 winCap，进度与耗时可预期。
    const overlap = Math.min(winCap - 1, req, Math.max(1, Math.floor(winCap / 4)));
    const advance = winCap - overlap;
    const windows = [];
    for (let ws = 0; ws < frames; ws += advance) {
        const segEnd = Math.min(frames, ws + winCap);
        windows.push({ segStart: ws, segEnd, segFrames: segEnd - ws });
        if (segEnd >= frames) break;
    }
    return { winCap, overlap, advance, windows, error: null };
}

module.exports = { planStaticWindows };
