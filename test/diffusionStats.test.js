'use strict';
/**
 * 扩散输出统计的回归测试。
 *
 * 用户日志里出现 `NaN=70144, Inf=-70144`：旧实现把 Inf 打印成
 * `xtInf - xtNaN`，全 NaN 时得到负数，容易误判成「NaN/Inf 各半」。
 * 这里锁住计数与文案，避免同类误报再次出现。
 */
const { expect } = require('chai');
const { summarizeXt, formatXtStats } = require('../src/inference/pipeline/diffusionStats.js');

describe('diffusionStats — 扩散输出统计', () => {
    it('全有限值：计数、极值、均值正确', () => {
        const stats = summarizeXt(new Float32Array([1, 2, 3, 4]));
        expect(stats.total).to.equal(4);
        expect(stats.nan).to.equal(0);
        expect(stats.inf).to.equal(0);
        expect(stats.finite).to.equal(4);
        expect(stats.invalid).to.equal(0);
        expect(stats.min).to.equal(1);
        expect(stats.max).to.equal(4);
        expect(stats.mean).to.equal(2.5);
    });

    it('NaN 与 Infinity 分开计数（不再用减法伪装 Inf）', () => {
        const stats = summarizeXt([NaN, Infinity, -Infinity, 1]);
        expect(stats.nan).to.equal(1);
        expect(stats.inf).to.equal(2);
        expect(stats.invalid).to.equal(3);
        expect(stats.finite).to.equal(1);
    });

    it('全 NaN 时 Inf 为 0，日志不出现负数', () => {
        const stats = summarizeXt(new Float32Array(10).fill(NaN));
        expect(stats.nan).to.equal(10);
        expect(stats.inf).to.equal(0);
        expect(Number.isNaN(stats.min)).to.equal(true);
        const text = formatXtStats(stats);
        expect(text).to.contain('NaN=10');
        expect(text).to.contain('Inf=0');
        expect(text).not.to.contain('Inf=-');
    });

    it('支持 start/end 切片', () => {
        const stats = summarizeXt([0, 1, 2, 3, 4], 1, 4);
        expect(stats.total).to.equal(3);
        expect(stats.min).to.equal(1);
        expect(stats.max).to.equal(3);
    });

    it('空输入安全', () => {
        const stats = summarizeXt([]);
        expect(stats.total).to.equal(0);
        expect(stats.invalid).to.equal(0);
        expect(formatXtStats(stats)).to.contain('total=0');
    });
});
