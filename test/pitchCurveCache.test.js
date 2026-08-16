const { expect } = require('chai');

// canvasRenderer 在模块加载时即调用 document.getElementById('piano-roll').getContext。
// setup.js 已 mock HTMLCanvasElement.prototype.getContext，这里只需保证元素存在。
document.body.innerHTML =
  '<canvas id="piano-roll"></canvas><canvas id="piano-keys"></canvas>';

const state = require('../src/fragmentEditor/state');
const cr = require('../src/fragmentEditor/canvasRenderer');

function makeNotes(count, dur = 2, basePitch = 60) {
  const notes = [];
  for (let i = 0; i < count; i++) {
    notes.push({
      id: i + 1,
      start: i * dur,
      duration: dur,
      pitch: basePitch + (i % 12),
      lyric: 'la',
    });
  }
  return notes;
}

describe('pitch curve cache (long-fragment perf fix)', () => {
  beforeEach(() => {
    state.setNotes([]);
    state.setPitchCurve({ enabled: true, anchorPoints: [], brushSegments: [] });
    state.setCurrentProject({ bpm: 120, timeSignature: [4, 4] });
    state.setCurrentFragment({ duration: 99999 });
    cr.invalidateNoteAnalysisCache();
    // setPitchCurve does not bump pitchCurveVersion; invalidate the sorted
    // anchor cache explicitly so each test sees its own anchorPoints.
    state.invalidatePitchCurveCache();
  });

  it('generateAutoPitchPoints caches result: same ref on repeated calls', () => {
    state.setNotes(makeNotes(50));
    const a = cr.generateAutoPitchPoints();
    const b = cr.generateAutoPitchPoints();
    expect(a).to.equal(b); // same reference => no recompute
    expect(a.length).to.equal(100); // 2 points per note
  });

  it('generateAutoPitchPoints invalidates when notes are replaced', () => {
    state.setNotes(makeNotes(10, 2, 60));
    const a = cr.generateAutoPitchPoints();
    state.setNotes(makeNotes(10, 2, 72)); // new array + new notesVersion
    const b = cr.generateAutoPitchPoints();
    expect(b).to.not.equal(a);
    expect(b[0].pitch).to.equal(72);
  });

  it('generateAutoPitchPoints invalidates on bumpNotesVersion', () => {
    const notes = makeNotes(10, 2, 60);
    state.setNotes(notes);
    const a = cr.generateAutoPitchPoints();
    // mutate a note's pitch in place, then bump version (project convention)
    notes[0].pitch = 48;
    state.bumpNotesVersion();
    const b = cr.generateAutoPitchPoints();
    expect(b).to.not.equal(a);
    expect(b[0].pitch).to.equal(48);
  });

  it('getCachedInactiveNoteIds matches getInactiveNoteIds', () => {
    const notes = [
      { id: 1, start: 0, duration: 4, pitch: 60 },
      { id: 2, start: 2, duration: 4, pitch: 62 }, // overlaps note 1 -> inactive
    ];
    state.setNotes(notes);
    const cached = cr.getCachedInactiveNoteIds(notes);
    const fresh = cr.getInactiveNoteIds(notes);
    expect([...cached].sort((x, y) => x - y)).to.deep.equal(
      [...fresh].sort((x, y) => x - y)
    );
    expect(cached.has(2)).to.equal(true);
    expect(cached.has(1)).to.equal(false);
  });

  it('getPitchAtTime interpolates anchor points', () => {
    state.setNotes(makeNotes(5, 2, 60));
    state.setPitchCurve({
      enabled: true,
      anchorPoints: [
        { time: 0, pitch: 60, smoothness: 0 },
        { time: 10, pitch: 72, smoothness: 0 },
      ],
      brushSegments: [],
    });
    expect(cr.getPitchAtTime(0)).to.equal(60);
    expect(cr.getPitchAtTime(10)).to.equal(72);
    // linear interpolation at midpoint (smoothness=0 => linear)
    expect(cr.getPitchAtTime(5)).to.be.closeTo(66, 0.01);
  });

  it('isPitchCurveCustomized is true when a note has vibrato', () => {
    const notes = makeNotes(3, 2, 60);
    notes[1].vibrato = { enabled: true, depth: 80, rate: 5.5, start: 0.2, length: 0.8, fadeIn: 0.3 };
    state.setNotes(notes);
    state.setPitchCurve({ enabled: true, anchorPoints: [], brushSegments: [] });
    expect(cr.isPitchCurveCustomized()).to.equal(true);
  });

  it('long fragment: 30000 getPitchAtTime calls (vibrato path) do not freeze', () => {
    const N = 300;
    const notes = makeNotes(N, 2, 60);
    // enable vibrato on every note so getPitchAtTime exercises the
    // _findActiveNoteAtTime + autoPoints lookup path (the pre-fix hot loop)
    notes.forEach((n) => {
      n.vibrato = { enabled: true, depth: 80, rate: 5.5, start: 0.2, length: 0.8, fadeIn: 0.3 };
    });
    state.setNotes(notes);
    state.setPitchCurve({ enabled: true, anchorPoints: [], brushSegments: [] });

    // simulate renderPitchCurve sampling loop: ~599 beats / 0.02 ~= 30000 steps
    const startBeat = 0;
    const maxTime = 599;
    const interval = 0.02;
    const steps = Math.floor((maxTime - startBeat) / interval);
    const t0 = Date.now();
    let last = null;
    for (let i = 0; i <= steps; i++) {
      const t = startBeat + (i / steps) * (maxTime - startBeat);
      last = cr.getPitchAtTime(t);
    }
    const dt = Date.now() - t0;
    expect(last).to.not.equal(null);
    // Pre-fix this loop ran generateAutoPitchPoints (O(n^2) inactive + sort) on
    // every step => seconds-long freeze. Post-fix must stay well under 2s.
    expect(dt, `30000 getPitchAtTime calls took ${dt}ms`).to.be.below(2000);
  });

  it('long fragment: anchor-covered path also stays fast', () => {
    const N = 300;
    const notes = makeNotes(N, 2, 60);
    state.setNotes(notes);
    // two anchors spanning the whole range => hasCustom=true, anchor branch
    state.setPitchCurve({
      enabled: true,
      anchorPoints: [
        { time: 0, pitch: 60, smoothness: 0 },
        { time: 600, pitch: 72, smoothness: 50 },
      ],
      brushSegments: [],
    });

    const maxTime = 599;
    const steps = Math.floor(maxTime / 0.02);
    const t0 = Date.now();
    let last = null;
    for (let i = 0; i <= steps; i++) {
      const t = (i / steps) * maxTime;
      last = cr.getPitchAtTime(t);
    }
    const dt = Date.now() - t0;
    expect(last).to.not.equal(null);
    expect(dt, `anchor-path 30000 calls took ${dt}ms`).to.be.below(2000);
  });
});
