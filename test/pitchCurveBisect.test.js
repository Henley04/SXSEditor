/**
 * 二分查找等价性测试：验证 _bisectSegmentIndex 替换线性循环后，
 * getPitchAtTime 在锚点 / 笔刷 / 自动音高三条路径上与原线性实现数值一致。
 *
 * 策略：构造随机输入（含重复 time、相邻 note 边界等 corner case），
 * 对密集 time 采样，逐点对比线性参考实现与当前 getPitchAtTime。
 */
const { expect } = require('chai');

// canvasRenderer 在模块加载时即调用 document.getElementById('piano-roll').getContext。
// setup.js 已 mock HTMLCanvasElement.prototype.getContext，这里只需保证元素存在。
document.body.innerHTML =
  '<canvas id="piano-roll"></canvas><canvas id="piano-keys"></canvas>';

const {
  getPitchAtTime,
  generateAutoPitchPoints,
  getSortedAnchorPoints,
} = require('../src/fragmentEditor/canvasRenderer');
const state = require('../src/fragmentEditor/state');

const {
  setNotes,
  setPitchCurve,
  invalidatePitchCurveCache,
  bumpNotesVersion,
} = state;

// ---- 线性参考实现（改写前的原逻辑，O(n) 线性扫描）----
function linearRef(pitchCurve, sortedAnchors, autoPoints, time) {
  if (!pitchCurve.enabled) return null;
  let basePitch = null;

  if (pitchCurve.anchorPoints.length > 0) {
    if (!(time < sortedAnchors[0].time || time > sortedAnchors[sortedAnchors.length - 1].time)) {
      for (let i = 0; i < sortedAnchors.length - 1; i++) {
        if (time >= sortedAnchors[i].time && time <= sortedAnchors[i + 1].time) {
          const t = (sortedAnchors[i + 1].time - sortedAnchors[i].time) > 0
            ? (time - sortedAnchors[i].time) / (sortedAnchors[i + 1].time - sortedAnchors[i].time)
            : 0;
          const smoothness = (sortedAnchors[i].smoothness || 0) / 100;
          const smoothStepT = t * t * (3 - 2 * t);
          const smoothT = t + (smoothStepT - t) * smoothness;
          basePitch = sortedAnchors[i].pitch + smoothT * (sortedAnchors[i + 1].pitch - sortedAnchors[i].pitch);
          break;
        }
      }
      if (basePitch === null) basePitch = sortedAnchors[sortedAnchors.length - 1].pitch;
    }
  }

  if (basePitch === null) {
    for (const seg of pitchCurve.brushSegments) {
      if (seg.points.length < 2) continue;
      const pts = seg.points;
      if (time >= pts[0].time && time <= pts[pts.length - 1].time) {
        for (let i = 0; i < pts.length - 1; i++) {
          if (time >= pts[i].time && time <= pts[i + 1].time) {
            const t = (pts[i + 1].time - pts[i].time) > 0
              ? (time - pts[i].time) / (pts[i + 1].time - pts[i].time)
              : 0;
            basePitch = pts[i].pitch + t * (pts[i + 1].pitch - pts[i].pitch);
            break;
          }
        }
        break;
      }
    }
  }

  if (basePitch === null) {
    if (autoPoints.length > 0) {
      for (let i = 0; i < autoPoints.length - 1; i++) {
        if (time >= autoPoints[i].time && time <= autoPoints[i + 1].time) {
          if (autoPoints[i].breakAfter) break;
          const t = (autoPoints[i + 1].time - autoPoints[i].time) > 0
            ? (time - autoPoints[i].time) / (autoPoints[i + 1].time - autoPoints[i].time)
            : 0;
          basePitch = autoPoints[i].pitch + t * (autoPoints[i + 1].pitch - autoPoints[i].pitch);
          break;
        }
      }
    }
  }

  // vibrato 不参与本等价测试（测试用例一律禁用 vibrato）
  return basePitch;
}

// ---- 随机数据生成 ----
function makeRng(seed) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function genNotes(rng, count, maxBeat) {
  const notes = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    const dur = 0.25 + Math.floor(rng() * 8) * 0.25; // 0.25..2.0
    const pitch = 48 + Math.floor(rng() * 24); // C3..B4
    notes.push({
      id: i + 1,
      start: Math.round(t * 100) / 100,
      duration: dur,
      pitch,
      lyric: 'la',
      vibrato: { enabled: false },
    });
    t += dur;
    // 随机间隙（有时相邻 = 重复 time，有时有 gap）
    if (rng() < 0.3) t += Math.floor(rng() * 4) * 0.25;
    if (t > maxBeat) break;
  }
  return notes;
}

function genAnchors(rng, count, maxBeat) {
  const pts = [];
  let t = 0;
  for (let i = 0; i < count; i++) {
    pts.push({
      time: Math.round(t * 100) / 100,
      pitch: 48 + Math.floor(rng() * 24),
      smoothness: Math.floor(rng() * 101),
    });
    t += 0.25 + Math.floor(rng() * 4) * 0.25;
    if (t > maxBeat) break;
  }
  // 偶尔插入重复 time（与上一个相同）
  if (pts.length > 1 && rng() < 0.5) {
    const idx = 1 + Math.floor(rng() * (pts.length - 1));
    pts.splice(idx, 0, { ...pts[idx - 1], pitch: 48 + Math.floor(rng() * 24) });
  }
  pts.sort((a, b) => a.time - b.time);
  return pts;
}

function genBrush(rng, maxBeat) {
  const pts = [];
  let t = rng() * maxBeat * 0.3;
  const n = 2 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    pts.push({
      time: Math.round(t * 100) / 100,
      pitch: 48 + Math.floor(rng() * 24),
    });
    t += 0.25 + Math.floor(rng() * 3) * 0.25;
  }
  pts.sort((a, b) => a.time - b.time);
  return [{ points: pts }];
}

describe('Pitch curve bisect equivalence', function () {
  beforeEach(function () {
    setNotes([]);
    setPitchCurve({ enabled: true, anchorPoints: [], brushSegments: [] });
    invalidatePitchCurveCache();
    bumpNotesVersion();
  });

  it('锚点路径：随机输入下二分与线性逐点一致', function () {
    const rng = makeRng(42);
    const maxBeat = 60;
    const notes = genNotes(rng, 30, maxBeat);
    setNotes(notes);
    bumpNotesVersion();
    const anchors = genAnchors(rng, 20, maxBeat);
    setPitchCurve({ enabled: true, anchorPoints: anchors, brushSegments: [] });
    invalidatePitchCurveCache();

    const sorted = getSortedAnchorPoints();
    const auto = generateAutoPitchPoints();
    let checked = 0;
    // 密集采样 + 锚点 time 本身 + 边界
    for (let t = 0; t <= maxBeat + 1; t += 0.013) {
      const ref = linearRef({ enabled: true, anchorPoints: anchors, brushSegments: [] }, sorted, auto, t);
      const cur = getPitchAtTime(t);
      if (ref === null) {
        expect(cur).to.equal(null);
      } else {
        expect(cur).to.not.equal(null);
        expect(Math.abs(cur - ref)).to.be.lessThan(1e-9, `mismatch at t=${t}: ref=${ref} cur=${cur}`);
      }
      checked++;
    }
    // 锚点 time 本身
    for (const a of anchors) {
      const ref = linearRef({ enabled: true, anchorPoints: anchors, brushSegments: [] }, sorted, auto, a.time);
      const cur = getPitchAtTime(a.time);
      if (ref === null) expect(cur).to.equal(null);
      else expect(Math.abs(cur - ref)).to.be.lessThan(1e-9);
      checked++;
    }
    expect(checked).to.be.greaterThan(4000);
  });

  it('笔刷路径：随机输入下二分与线性逐点一致', function () {
    const rng = makeRng(7);
    const maxBeat = 40;
    const notes = genNotes(rng, 20, maxBeat);
    setNotes(notes);
    bumpNotesVersion();
    const brush = genBrush(rng, maxBeat);
    setPitchCurve({ enabled: true, anchorPoints: [], brushSegments: brush });
    invalidatePitchCurveCache();

    const sorted = getSortedAnchorPoints();
    const auto = generateAutoPitchPoints();
    let checked = 0;
    for (let t = 0; t <= maxBeat + 1; t += 0.011) {
      const ref = linearRef({ enabled: true, anchorPoints: [], brushSegments: brush }, sorted, auto, t);
      const cur = getPitchAtTime(t);
      if (ref === null) {
        expect(cur).to.equal(null);
      } else {
        expect(cur).to.not.equal(null);
        expect(Math.abs(cur - ref)).to.be.lessThan(1e-9, `brush mismatch at t=${t}: ref=${ref} cur=${cur}`);
      }
      checked++;
    }
    expect(checked).to.be.greaterThan(3000);
  });

  it('自动音高路径：随机输入下二分与线性逐点一致', function () {
    const rng = makeRng(99);
    const maxBeat = 50;
    const notes = genNotes(rng, 25, maxBeat);
    setNotes(notes);
    bumpNotesVersion();
    setPitchCurve({ enabled: true, anchorPoints: [], brushSegments: [] });
    invalidatePitchCurveCache();

    const sorted = getSortedAnchorPoints();
    const auto = generateAutoPitchPoints();
    expect(auto.length).to.be.greaterThan(2);
    let checked = 0;
    for (let t = 0; t <= maxBeat + 1; t += 0.009) {
      const ref = linearRef({ enabled: true, anchorPoints: [], brushSegments: [] }, sorted, auto, t);
      const cur = getPitchAtTime(t);
      if (ref === null) {
        expect(cur).to.equal(null);
      } else {
        expect(cur).to.not.equal(null);
        expect(Math.abs(cur - ref)).to.be.lessThan(1e-9, `auto mismatch at t=${t}: ref=${ref} cur=${cur}`);
      }
      checked++;
    }
    expect(checked).to.be.greaterThan(5000);
  });

  it('混合路径（锚点+笔刷+自动）：随机输入下二分与线性逐点一致', function () {
    const rng = makeRng(2024);
    const maxBeat = 80;
    const notes = genNotes(rng, 40, maxBeat);
    setNotes(notes);
    bumpNotesVersion();
    const anchors = genAnchors(rng, 25, maxBeat);
    const brush = genBrush(rng, maxBeat);
    const pc = { enabled: true, anchorPoints: anchors, brushSegments: brush };
    setPitchCurve(pc);
    invalidatePitchCurveCache();

    const sorted = getSortedAnchorPoints();
    const auto = generateAutoPitchPoints();
    let checked = 0;
    for (let t = 0; t <= maxBeat + 1; t += 0.007) {
      const ref = linearRef(pc, sorted, auto, t);
      const cur = getPitchAtTime(t);
      if (ref === null) {
        expect(cur).to.equal(null);
      } else {
        expect(cur).to.not.equal(null);
        expect(Math.abs(cur - ref)).to.be.lessThan(1e-9, `mixed mismatch at t=${t}: ref=${ref} cur=${cur}`);
      }
      checked++;
    }
    expect(checked).to.be.greaterThan(10000);
  });
});
