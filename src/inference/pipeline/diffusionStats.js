/**
 * 扩散输出数值统计（纯函数，运行时与单测共用）。
 *
 * 背景：原实现把 Inf 打印成 `xtInf - xtNaN`，而 xtInf 只统计真正的 Infinity、
 * xtNaN 单独统计 NaN —— 全 NaN 时会打印 `Inf=-70144` 这种负值，排查时极易
 * 误判成「NaN 与 Inf 各占一半」。统计与格式化都收在这里，日志格式只有一处真源。
 */

/**
 * 统计一段 Float32Array 的有限性分布。
 * @param {Float32Array|number[]} data
 * @param {number} [start] 起始下标（含）
 * @param {number} [end] 结束下标（不含），缺省为数组末尾
 * @returns {{total:number,nan:number,inf:number,finite:number,invalid:number,min:number,max:number,mean:number,std:number}}
 */
function summarizeXt(data, start = 0, end) {
    const len = data && typeof data.length === 'number' ? data.length : 0;
    const from = Math.max(0, Math.floor(Number(start) || 0));
    const to = Math.min(len, end === undefined || end === null ? len : Math.floor(Number(end)));
    let nan = 0;
    let inf = 0;
    let finite = 0;
    let min = Infinity;
    let max = -Infinity;
    let sum = 0;
    let sumSq = 0;
    for (let i = from; i < to; i++) {
        const v = data[i];
        if (Number.isNaN(v)) { nan++; continue; }
        if (!Number.isFinite(v)) { inf++; continue; }
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
        sumSq += v * v;
        finite++;
    }
    const count = Math.max(1, finite);
    const mean = sum / count;
    const std = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
    return {
        total: Math.max(0, to - from),
        nan,
        inf,
        finite,
        invalid: nan + inf,
        min: finite > 0 ? min : NaN,
        max: finite > 0 ? max : NaN,
        mean,
        std,
    };
}

/**
 * 统一的日志片段：`NaN=n, Inf=n, total=n, min=.., max=.., mean=.., std=..`
 * @param {ReturnType<typeof summarizeXt>} stats
 */
function formatXtStats(stats) {
    const s = stats || summarizeXt([]);
    const f = (v) => (Number.isFinite(v) ? v.toFixed(6) : 'n/a');
    return `NaN=${s.nan}, Inf=${s.inf}, total=${s.total}, min=${f(s.min)}, max=${f(s.max)}, mean=${f(s.mean)}, std=${f(s.std)}`;
}

module.exports = { summarizeXt, formatXtStats };
