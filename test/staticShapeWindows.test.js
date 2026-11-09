'use strict';
/**
 * 静态 shape 分段窗口规划的回归测试。
 *
 * 现场日志：`totalFrames=911, ptFrameCount=1500, winCap=548` 后第一窗就
 * 产出全 NaN。这里锁住窗口布局（不丢帧、不重帧、overlap 有上限），
 * 避免后续改动把 1500 帧 prompt + 548 帧目标这种「刚好满载」的布局再放大。
 */
const { expect } = require('chai');
const { planStaticWindows } = require('../src/inference/pipeline/staticShapePlan.js');

describe('planStaticWindows — 静态 shape 分段规划', () => {
    it('911 帧 + 1500 prompt + 2048 预算：两窗，第二窗覆盖尾部', () => {
        const plan = planStaticWindows(911, 1500, 2048, 50);
        expect(plan.error).to.equal(null);
        expect(plan.winCap).to.equal(548);
        expect(plan.overlap).to.equal(50);
        expect(plan.advance).to.equal(498);
        expect(plan.windows).to.deep.equal([
            { segStart: 0, segEnd: 548, segFrames: 548 },
            { segStart: 498, segEnd: 911, segFrames: 413 },
        ]);
    });

    it('所有目标帧都被覆盖，窗口不越界', () => {
        const frames = 5000;
        const plan = planStaticWindows(frames, 1000, 2048, 50);
        const covered = new Uint8Array(frames);
        for (const w of plan.windows) {
            expect(w.segStart).to.be.at.least(0);
            expect(w.segEnd).to.be.at.most(frames);
            for (let i = w.segStart; i < w.segEnd; i++) covered[i] = 1;
        }
        expect(covered.every((v) => v === 1)).to.equal(true);
    });

    it('overlap 不超过窗口的 1/4，advance 恒大于 0', () => {
        for (const winCap of [51, 100, 548, 1024]) {
            const plan = planStaticWindows(winCap * 3, 2048 - winCap, 2048, 50);
            expect(plan.overlap).to.be.at.most(Math.floor(winCap / 4));
            expect(plan.advance).to.be.greaterThan(0);
        }
    });

    it('单窗口可容纳时只返回一个窗口', () => {
        const plan = planStaticWindows(548, 1500, 2048, 50);
        expect(plan.windows).to.deep.equal([{ segStart: 0, segEnd: 548, segFrames: 548 }]);
    });

    it('prompt 占满预算时返回 NO_TARGET_BUDGET', () => {
        const plan = planStaticWindows(911, 2048, 2048, 50);
        expect(plan.error).to.equal('NO_TARGET_BUDGET');
        expect(plan.windows).to.deep.equal([]);
    });

    it('极小窗口下 advance 仍大于 0，不会死循环', () => {
        const plan = planStaticWindows(200, 2047, 2048, 50);
        expect(plan.winCap).to.equal(1);
        expect(plan.advance).to.be.greaterThan(0);
        expect(plan.windows.length).to.be.greaterThan(0);
    });

    it('预算小于 NPU 常量时按真实预算规划（int8 v2 动态导出）', () => {
        const plan = planStaticWindows(600, 400, 1024, 50);
        expect(plan.winCap).to.equal(624);
        expect(plan.windows).to.deep.equal([{ segStart: 0, segEnd: 600, segFrames: 600 }]);
    });
});
