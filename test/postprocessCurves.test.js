/**
 * shared/postprocessCurves 纯模块（分片编辑器与主窗口共用）。
 *
 * 关键回归点：
 *   - normalizePostprocessState 必须夹紧默认值与锚点值（防越界 σ 进管线）
 *   - mel 载荷必须携带 startBeat/bpm（多段/多 region/单音符 padding 的时间对齐依据）
 *   - 主窗口与编辑器共用同一采样数学（同一 state 进来，结果必须一致）
 */
const { expect } = require('chai');
const {
  normalizePostprocessState,
  buildF0PostprocessParams,
  buildMelPostprocessPayload,
  hasF0PostprocessEffect,
  hasSpectralPostprocessEffect,
  serializePostprocessForSignature,
  sampleParamAt,
} = require('../src/shared/postprocessCurves.js');

describe('shared/postprocessCurves', () => {
  describe('normalizePostprocessState', () => {
    it('无输入 → 全默认（所有处理关闭）', () => {
      const state = normalizePostprocessState(null);
      expect(state.defaults.f0Smooth).to.equal(0);
      expect(state.defaults.specSmoothT).to.equal(0);
      expect(Object.keys(state.curves)).to.have.length(7);
    });

    it('默认值与锚点值全部夹紧到注册表值域', () => {
      const state = normalizePostprocessState({
        defaults: { f0Smooth: 250, specSmoothT: 999, f0Median: 4, f0GlideMs: -5 },
        curves: {
          specBlend: { keyframes: [{ time: 1, value: 1e9, strength: 50, smoothness: 30 }] },
          f0Smooth: { keyframes: [{ time: 0, value: -20 }] },
        },
      });
      expect(state.defaults.f0Smooth).to.equal(100);
      expect(state.defaults.specSmoothT).to.equal(6);
      expect(state.defaults.f0Median).to.equal(5); // 奇数量化：4 → 5
      expect(state.defaults.f0GlideMs).to.equal(0);
      expect(state.curves.specBlend.keyframes[0].value).to.equal(100);
      expect(state.curves.f0Smooth.keyframes[0].value).to.equal(0);
    });

    it('部分参数缺失时不影响其余参数（旧工程逐参数合并）', () => {
      const state = normalizePostprocessState({ defaults: { f0Smooth: 40 } });
      expect(state.defaults.f0Smooth).to.equal(40);
      expect(state.defaults.specBlend).to.equal(0);
      expect(state.curves.specBlend.keyframes).to.deep.equal([]);
    });
  });

  describe('效果判定 / 采样', () => {
    it('默认值或锚点任一非关闭即视为生效', () => {
      expect(hasF0PostprocessEffect(normalizePostprocessState(null))).to.equal(false);
      expect(hasSpectralPostprocessEffect(normalizePostprocessState(null))).to.equal(false);
      const on = normalizePostprocessState({ defaults: { specSmoothT: 0.8 } });
      expect(hasSpectralPostprocessEffect(on)).to.equal(true);
    });

    it('曲线锚点按拍插值，区间外保持端点值', () => {
      const state = normalizePostprocessState({
        curves: { f0Smooth: { keyframes: [
          { time: 0, value: 0 },
          { time: 4, value: 80 },
        ] } },
      });
      expect(sampleParamAt(state, null, 'f0Smooth', 2)).to.be.closeTo(40, 1e-6);
      expect(sampleParamAt(state, null, 'f0Smooth', 99)).to.be.closeTo(80, 1e-6);
      expect(sampleParamAt(state, null, 'f0Smooth', -5)).to.be.closeTo(0, 1e-6);
    });
  });

  describe('buildF0PostprocessParams', () => {
    it('未启用时 active=false，启用时逐帧取值', () => {
      const idle = buildF0PostprocessParams(normalizePostprocessState(null), 100, 120, 24000, 480);
      expect(idle.active).to.equal(false);

      const state = normalizePostprocessState({ defaults: { f0Smooth: 50, f0Median: 5 } });
      const params = buildF0PostprocessParams(state, 100, 120, 24000, 480);
      expect(params.active).to.equal(true);
      expect(params.smooth).to.have.length(100);
      expect(params.smooth[0]).to.equal(50);
      expect(params.median[0]).to.equal(5);
    });
  });

  describe('buildMelPostprocessPayload', () => {
    const notes = [
      { id: 1, start: 2, duration: 2, pitch: 60, lyric: 'a' },
      { id: 2, start: 4, duration: 2, pitch: 62, lyric: 'b' },
    ];

    it('未启用 → null', () => {
      expect(buildMelPostprocessPayload(normalizePostprocessState(null), notes, 120, 24000, 480)).to.equal(null);
    });

    it('载荷携带 startBeat/bpm（管线 re-base 对齐的依据）', () => {
      const state = normalizePostprocessState({ defaults: { specSmoothT: 1.2, specBlend: 50 } });
      const payload = buildMelPostprocessPayload(state, notes, 120, 24000, 480);
      expect(payload).to.be.an('object');
      expect(payload.startBeat).to.equal(2);
      expect(payload.bpm).to.equal(120);
      expect(payload.frames).to.be.closeTo(101, 1);
      expect(Array.from(payload.boundaries)).to.deep.equal([50]);
    });
  });

  describe('serializePostprocessForSignature', () => {
    it('曲线变化 → 签名变化（改曲线必须触发重新合成）', () => {
      const before = serializePostprocessForSignature(normalizePostprocessState(null));
      const after = serializePostprocessForSignature(normalizePostprocessState({
        curves: { specBlend: { keyframes: [{ time: 1, value: 80 }] } },
      }));
      expect(after).to.not.equal(before);
    });
  });
});
