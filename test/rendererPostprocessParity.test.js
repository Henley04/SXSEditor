/**
 * 主窗口后处理接入回归（P1-5）。
 *
 * 背景：主窗口播放/导出走 renderer/f0Utils.js（复制的 F0 构建）且不传
 * melPostprocess，导致分片编辑器里调好的 F0/频谱后处理在"播放全部/导出全部"
 * 完全不生效。修复后 f0Utils 应用同一套 F0 后处理、audioPlayback 逐 fragment
 * 下发 melPostprocess 载荷。这里钉死两条路径的行为。
 *
 * 注意：后处理全关时 buildFragmentPitchCurveF0 仍返回 null（管线用原生 F0
 * 路径，与旧版本逐位一致）——只有开启后处理才需要编辑器构建 F0 曲线。
 */
const { expect } = require('chai');
const { buildFragmentPitchCurveF0 } = require('../src/renderer/f0Utils.js');
const { buildMelPostprocessPayload } = require('../src/shared/postprocessCurves.js');

const SAMPLE_RATE = 24000;
const HOP = 480;

function makeFragment(postprocess) {
  return {
    duration: 4,
    pitchCurve: { enabled: true, anchorPoints: [], brushSegments: [] },
    notes: [
      { id: 'n1', start: 0, duration: 2, pitch: 60, lyric: 'a' }, // C4
      { id: 'n2', start: 2, duration: 2, pitch: 64, lyric: 'b' }, // E4（+4 半音跳变）
    ],
    postprocess: postprocess || null,
  };
}

const clipped = (frag) => frag.notes.map((n) => ({ ...n }));
const expectHz = (pitch) => 440 * Math.pow(2, (pitch - 69) / 12);

/** 与 f0Utils 相同规则的原始 F0（无后处理），用作对照。 */
function rawF0(frag, bpm) {
  const totalFrames = Math.floor(((frag.duration / bpm) * 60) * SAMPLE_RATE / HOP);
  const f0 = new Float32Array(totalFrames);
  for (let i = 0; i < totalFrames; i++) {
    const beat = (i * HOP) / SAMPLE_RATE / 60 * bpm;
    const note = frag.notes.find((n) => beat >= n.start && beat < n.start + n.duration);
    f0[i] = note ? expectHz(note.pitch) : 0;
  }
  return f0;
}

describe('主窗口 F0/频谱后处理接入', () => {
  it('后处理全关时返回 null（管线原生 F0，旧版本行为逐位不变）', () => {
    const frag = makeFragment(null);
    expect(buildFragmentPitchCurveF0(frag, clipped(frag), 120)).to.equal(null);
  });

  it('开启平滑后返回 F0 曲线：远离边界保形、跳变边界被 SG 改写', () => {
    const frag = makeFragment({ defaults: { f0Smooth: 100 }, curves: {} });
    const on = buildFragmentPitchCurveF0(frag, clipped(frag), 120);
    expect(on).to.not.equal(null);
    const raw = rawF0(frag, 120);
    // 远离边界处 SG 保形：C4 段中部取值不变（SG 系数和有 1e-16 级误差，
    // 经 cents 往返 + Float32 舍入可能偏 1 ULP ≈ 1.5e-5 Hz，容差取 1e-3）
    expect(on[40]).to.be.closeTo(raw[40], 1e-3);
    expect(on[40]).to.be.closeTo(expectHz(60), 1e-3);
    // 跳变边界（拍 2 = 帧 50）附近（±3 帧）必然被平滑改写
    let diff = 0;
    for (let i = 47; i <= 53; i++) diff += Math.abs(on[i] - raw[i]);
    expect(diff, '边界帧应被平滑').to.be.greaterThan(0);
    // 平滑后帧间最大跳变显著小于原始的 4 半音阶跃（>2400 音分）
    const cents = Array.from(on, (hz) => (hz > 0 ? 1200 * Math.log2(hz / 440) : null));
    let maxStep = 0;
    for (let i = 1; i < cents.length; i++) {
      if (cents[i] === null || cents[i - 1] === null) continue;
      maxStep = Math.max(maxStep, Math.abs(cents[i] - cents[i - 1]));
    }
    expect(maxStep, '4 半音阶跃应被抹平').to.be.lessThan(1200);
  });

  it('melPostprocess 载荷按 fragment.postprocess 构建（含时间锚点）', () => {
    const frag = makeFragment({ defaults: { specSmoothT: 1.0, specBlend: 50 }, curves: {} });
    const payload = buildMelPostprocessPayload(frag.postprocess, clipped(frag), 120, SAMPLE_RATE, HOP);
    expect(payload).to.not.equal(null);
    expect(payload.startBeat).to.equal(0);
    expect(payload.bpm).to.equal(120);
    expect(payload.sigmaT[0]).to.equal(1.0);
    // 第二个音符起点 = 2 拍 = 1s = 50 帧
    expect(Array.from(payload.boundaries)).to.deep.equal([50]);
  });
});
