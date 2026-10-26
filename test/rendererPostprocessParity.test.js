/**
 * 主窗口后处理接入回归（P1-5）。
 *
 * 背景：主窗口播放/导出走 renderer/f0Utils.js（复制的 F0 构建）且不传
 * melPostprocess，导致分片编辑器里调好的 F0/频谱后处理在"播放全部/导出全部"
 * 完全不生效。修复后 f0Utils 应用同一套 F0 后处理、audioPlayback 逐 fragment
 * 下发 melPostprocess 载荷。这里钉死两条路径的行为。
 *
 * 锚点强度回归：f0Utils 曾本地复刻音高曲线插值，但只抄了 smoothness、漏了
 * strength —— 分片编辑器里把锚点强度从 100 调到 0，主窗口播放/导出的 F0
 * 逐位不变（"修改后曲线完全一致"）。现在锚点分支委托 shared 真源
 * fragmentEditor/automationCurve.js，下面钉死：强度生效、与真源逐点一致、
 * 旧工程（无 strength 字段）行为不变。
 *
 * 注意：后处理全关时 buildFragmentPitchCurveF0 仍返回 null（管线用原生 F0
 * 路径，与旧版本逐位一致）——只有开启后处理才需要编辑器构建 F0 曲线。
 */
const { expect } = require('chai');
const { buildFragmentPitchCurveF0, computePitchCurveF0 } = require('../src/renderer/f0Utils.js');
const { buildMelPostprocessPayload } = require('../src/shared/postprocessCurves.js');
const { sortAnchors, buildEffectiveValues, evalSortedCurve } = require('../src/fragmentEditor/automationCurve.js');

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

/**
 * 音高曲线"强度 / 平滑"在主窗口 F0 路径的回归。
 *
 * 这三个用例各自钉死修复前被破坏的一环：
 *   ① 强度生效 —— 修复前强度 0/50/100 产出同一条 F0；
 *   ② 与 shared 真源逐点一致 —— 防 f0Utils 再次本地复刻而分叉；
 *   ③ 旧工程无 strength 字段 → 与 strength=100 逐位相同（向后兼容）。
 */
describe('主窗口 F0 的锚点强度 / 平滑', () => {
  const BPM = 120;
  const NOTES = [{ id: 'n1', start: 0, duration: 4, pitch: 60, lyric: 'a' }];

  /** 三锚点音高曲线：中间锚点带可变强度 / 平滑，两端固定。 */
  function makeAnchorFragment(strength, smoothness) {
    return {
      duration: 4,
      pitchCurve: {
        enabled: true,
        anchorPoints: [
          { time: 0, pitch: 60, strength: 100, smoothness: 0 },
          { time: 1, pitch: 72, strength, smoothness },
          { time: 2, pitch: 60, strength: 100, smoothness: 0 },
        ],
        brushSegments: [],
      },
      notes: NOTES,
      postprocess: null,
    };
  }

  it('锚点强度生效：100 过锚点 / 0 走邻居连线 / 50 半程', () => {
    const clippedNotes = NOTES.map((n) => ({ ...n }));
    const at = (strength, smoothness) =>
      buildFragmentPitchCurveF0(makeAnchorFragment(strength, smoothness), clippedNotes, BPM)[25]; // 拍 1
    // 强度 100：曲线精确经过锚点（72）
    expect(at(100, 0)).to.be.closeTo(expectHz(72), 1e-3);
    // 强度 0：锚点被完全忽略，退化为前后锚点（60/60）连线 → 60
    expect(at(0, 0)).to.be.closeTo(expectHz(60), 1e-3);
    // 强度 50：锚点只被拉走一半 → 66
    expect(at(50, 0)).to.be.closeTo(expectHz(66), 1e-3);
  });

  it('与 shared automationCurve 真源逐点一致（强度 + 平滑 + 重复时间混合）', () => {
    const anchors = [
      { time: 0, pitch: 60, strength: 100, smoothness: 0 },
      { time: 0.5, pitch: 64, strength: 0, smoothness: 100 },
      { time: 1, pitch: 72, strength: 50, smoothness: 60 },
      { time: 1, pitch: 74, strength: 30, smoothness: 0 }, // 重复时间
      { time: 2, pitch: 60, strength: 100, smoothness: 100 },
      { time: 3, pitch: 67, strength: 20, smoothness: 40 },
    ];
    const frag = {
      duration: 4,
      pitchCurve: { enabled: true, anchorPoints: anchors, brushSegments: [] },
      notes: NOTES,
      postprocess: null,
    };
    const f0 = buildFragmentPitchCurveF0(frag, NOTES.map((n) => ({ ...n })), BPM);
    const totalFrames = Math.floor(((frag.duration / BPM) * 60) * SAMPLE_RATE / HOP);
    expect(f0).to.have.length(totalFrames);

    const first = anchors[0].time;
    const last = anchors[anchors.length - 1].time;
    // 真源参考：与分片编辑器 getPitchAtTime 同一函数、同一 valueKey('pitch')
    const sorted = sortAnchors(anchors);
    const eff = buildEffectiveValues(sorted, 'pitch');
    for (let i = 0; i < f0.length; i++) {
      const beat = (i * HOP) / SAMPLE_RATE / 60 * BPM;
      // 锚点区间内与真源逐点一致；区间外**延续首/末锚点值**（F4 修复）——
      // 旧实现回落到 note.pitch，会在末锚点之后造成 12 半音级的可闻台阶。
      const expected = beat >= first && beat <= last
        ? expectHz(evalSortedCurve(sorted, eff, beat))
        : expectHz(beat < first ? eff[0] : eff[eff.length - 1]);
      expect(f0[i], `帧 ${i}（拍 ${beat.toFixed(2)}）`).to.be.closeTo(expected, 1e-3);
    }
  });

  it('旧工程锚点（无 strength 字段）与 strength=100 逐位一致', () => {
    const legacy = [
      { time: 0, pitch: 60, smoothness: 0 },
      { time: 1, pitch: 72, smoothness: 30 },
      { time: 2, pitch: 60, smoothness: 0 },
    ];
    const withDefault = legacy.map((a) => ({ ...a, strength: 100 }));
    const mk = (anchorPoints) => ({
      duration: 2,
      pitchCurve: { enabled: true, anchorPoints, brushSegments: [] },
      notes: NOTES,
      postprocess: null,
    });
    const clippedNotes = NOTES.map((n) => ({ ...n }));
    const fLegacy = buildFragmentPitchCurveF0(mk(legacy), clippedNotes, BPM);
    const fDefault = buildFragmentPitchCurveF0(mk(withDefault), clippedNotes, BPM);
    for (let i = 0; i < fLegacy.length; i++) {
      expect(fLegacy[i], `帧 ${i}`).to.equal(fDefault[i]);
    }
  });

  it('computePitchCurveF0 同样应用锚点强度（同源复刻守护）', () => {
    const mkFrag = (strength) => ({
      id: 'f1',
      startTime: 0,
      duration: 2,
      pitchCurve: {
        enabled: true,
        anchorPoints: [
          { time: 0, pitch: 60, strength: 100, smoothness: 0 },
          { time: 1, pitch: 72, strength, smoothness: 0 },
          { time: 2, pitch: 60, strength: 100, smoothness: 0 },
        ],
        brushSegments: [],
      },
    });
    const notes = [{ id: 'n1', start: 0, duration: 2, pitch: 60, lyric: 'a' }];
    // 拍 1 = 帧 25（24k/480，bpm 120）
    expect(computePitchCurveF0([mkFrag(100)], notes, BPM)[25]).to.be.closeTo(expectHz(72), 1e-3);
    expect(computePitchCurveF0([mkFrag(0)], notes, BPM)[25]).to.be.closeTo(expectHz(60), 1e-3);
    expect(computePitchCurveF0([mkFrag(50)], notes, BPM)[25]).to.be.closeTo(expectHz(66), 1e-3);
  });
});
