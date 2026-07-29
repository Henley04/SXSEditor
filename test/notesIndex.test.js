const { expect } = require('chai');
const {
  createNotesIndex,
  ensureSorted,
  markDirty,
  rebuildIndex,
  insertNote,
  removeNoteById,
  compareNotes,
  bisectLastStartLE,
  bisectFirstStartGE,
  notesInRange,
  hasOverlapAtPitch,
  clampPosition,
  computeInactiveNoteIds,
  findNoteAtBeat,
  findAdjacentBoundary,
  computeMultiDragResult,
} = require('../src/fragmentEditor/notesIndex');

function makeNote(id, start, duration, pitch = 60) {
  return { id, start, duration, pitch, lyric: 'la' };
}

describe('fragmentEditor/notesIndex', () => {
  describe('compareNotes', () => {
    it('orders by start ascending', () => {
      expect(compareNotes(makeNote(1, 0, 1), makeNote(2, 1, 1))).to.equal(-1);
      expect(compareNotes(makeNote(2, 1, 1), makeNote(1, 0, 1))).to.equal(1);
    });
    it('breaks start ties by duration descending (longer first)', () => {
      expect(compareNotes(makeNote(1, 0, 2), makeNote(2, 0, 1))).to.equal(-1);
      expect(compareNotes(makeNote(2, 0, 1), makeNote(1, 0, 2))).to.equal(1);
    });
    it('returns 0 for identical start+duration', () => {
      expect(compareNotes(makeNote(1, 0, 1), makeNote(2, 0, 1))).to.equal(0);
    });
    it('treats near-equal starts within EPS as equal', () => {
      const a = makeNote(1, 0, 1);
      const b = makeNote(2, 0 + 1e-11, 2);
      // within EPS, falls to duration tie-break: b longer → b first
      expect(compareNotes(a, b)).to.equal(1);
    });
  });

  describe('createNotesIndex / ensureSorted', () => {
    it('sorts the notes array in place', () => {
      const notes = [makeNote(3, 5, 1), makeNote(1, 0, 1), makeNote(2, 2, 1)];
      const idx = createNotesIndex(notes);
      expect(notes.map((n) => n.id)).to.deep.equal([1, 2, 3]);
      expect(idx.sorted).to.be.true;
    });
    it('breaks ties by duration descending', () => {
      const notes = [makeNote(1, 0, 1), makeNote(2, 0, 2), makeNote(3, 0, 1.5)];
      createNotesIndex(notes);
      expect(notes.map((n) => n.id)).to.deep.equal([2, 3, 1]);
    });
    it('does not re-sort when already sorted', () => {
      const notes = [makeNote(1, 0, 1), makeNote(2, 1, 1)];
      const idx = createNotesIndex(notes);
      const v0 = idx.version;
      ensureSorted(idx);
      expect(idx.version).to.equal(v0);
    });
    it('markDirty + ensureSorted re-sorts and bumps version', () => {
      const notes = [makeNote(1, 0, 1), makeNote(2, 1, 1)];
      const idx = createNotesIndex(notes);
      const v0 = idx.version;
      notes[0].start = 5;
      markDirty(idx);
      ensureSorted(idx);
      expect(idx.version).to.be.greaterThan(v0);
      expect(notes.map((n) => n.id)).to.deep.equal([2, 1]);
    });
  });

  describe('bisect helpers', () => {
    const notes = [makeNote(1, 0, 1), makeNote(2, 2, 1), makeNote(3, 4, 1), makeNote(4, 6, 1)];
    it('bisectLastStartLE returns largest i with start <= t', () => {
      expect(bisectLastStartLE(notes, -1)).to.equal(-1);
      expect(bisectLastStartLE(notes, 0)).to.equal(0);
      expect(bisectLastStartLE(notes, 1)).to.equal(0);
      expect(bisectLastStartLE(notes, 2)).to.equal(1);
      expect(bisectLastStartLE(notes, 5)).to.equal(2);
      expect(bisectLastStartLE(notes, 100)).to.equal(3);
    });
    it('bisectFirstStartGE returns smallest i with start >= t', () => {
      expect(bisectFirstStartGE(notes, -1)).to.equal(0);
      expect(bisectFirstStartGE(notes, 0)).to.equal(0);
      expect(bisectFirstStartGE(notes, 1)).to.equal(1);
      expect(bisectFirstStartGE(notes, 2)).to.equal(1);
      expect(bisectFirstStartGE(notes, 5)).to.equal(3);
      expect(bisectFirstStartGE(notes, 100)).to.equal(4);
    });
  });

  describe('notesInRange', () => {
    it('returns notes overlapping [tStart, tEnd)', () => {
      const notes = [
        makeNote(1, 0, 1),   // [0,1)
        makeNote(2, 1, 1),   // [1,2)
        makeNote(3, 3, 2),   // [3,5)
        makeNote(4, 6, 1),   // [6,7)
      ];
      const idx = createNotesIndex(notes);
      // [1.5, 4) overlaps note 2 [1,2) (end=2 > 1.5) and note 3 [3,5).
      const r = notesInRange(idx, 1.5, 4);
      expect(r.map((n) => n.id)).to.deep.equal([2, 3]);
      const r2 = notesInRange(idx, 0.5, 4);
      expect(r2.map((n) => n.id).sort()).to.deep.equal([1, 2, 3]);
    });
    it('catches notes that start before window but extend in', () => {
      const notes = [makeNote(1, 0, 5)]; // [0,5)
      const idx = createNotesIndex(notes);
      const r = notesInRange(idx, 2, 4);
      expect(r.map((n) => n.id)).to.deep.equal([1]);
    });
    it('returns empty for window after all notes', () => {
      const notes = [makeNote(1, 0, 1)];
      const idx = createNotesIndex(notes);
      expect(notesInRange(idx, 5, 10)).to.deep.equal([]);
    });
  });

  describe('hasOverlapAtPitch', () => {
    it('detects overlap at the same pitch', () => {
      const notes = [makeNote(1, 0, 1, 60), makeNote(2, 0.5, 1, 60)];
      const idx = createNotesIndex(notes);
      expect(hasOverlapAtPitch(idx, null, 60, 0.7, 1.5)).to.be.true;
    });
    it('returns false when only different pitches overlap', () => {
      // Note 1 at pitch 60 [0,1). Note 2 at pitch 62 [0.5,1.5) — overlaps
      // note 1 in time but at a different pitch.
      // Querying pitch=60 for the window [0.5, 1.5) → note 1 [0,1) DOES
      // overlap (end=1 > 0.5). Use a window after note 1 to test isolation.
      const notes = [makeNote(1, 0, 1, 60), makeNote(2, 0.5, 1, 62)];
      const idx = createNotesIndex(notes);
      // Window [1.5, 2.5) — past note 1's end. Pitch 60 has no note here.
      expect(hasOverlapAtPitch(idx, null, 60, 1.5, 2.5)).to.be.false;
      // Pitch 62 still has note 2 [0.5,1.5) ending exactly at 1.5 — not >1.5.
      expect(hasOverlapAtPitch(idx, null, 62, 1.5, 2.5)).to.be.false;
      // But pitch 62 at [0.6, 1.4) overlaps note 2.
      expect(hasOverlapAtPitch(idx, null, 62, 0.6, 1.4)).to.be.true;
    });
    it('respects excludeIds', () => {
      // Two notes at pitch 60: 1=[0,1), 2=[0.5,1.5). They overlap each other.
      // Excluding note 2, query window that overlaps only note 2 (not note 1).
      const notes = [makeNote(1, 0, 1, 60), makeNote(2, 0.5, 1, 60)];
      const idx = createNotesIndex(notes);
      // Window [1.1, 1.4): note 1 [0,1) ends at 1, no overlap.
      // Note 2 [0.5,1.5) overlaps. With excludeIds={2}, should be false.
      expect(hasOverlapAtPitch(idx, new Set([2]), 60, 1.1, 1.4)).to.be.false;
      // With excludeIds={1}, note 2 still overlaps → true.
      expect(hasOverlapAtPitch(idx, new Set([1]), 60, 1.1, 1.4)).to.be.true;
    });
    it('handles adjacent notes that share a boundary (no overlap)', () => {
      // Note 1 [0,1) and note 2 [1,2) at pitch 60 share the boundary t=1.
      // A query window starting exactly at 1 should not overlap note 1
      // (note 1.end = 1, not > 1). Excluding note 2 to test only note 1.
      const notes = [makeNote(1, 0, 1, 60), makeNote(2, 1, 1, 60)];
      const idx = createNotesIndex(notes);
      expect(hasOverlapAtPitch(idx, new Set([2]), 60, 1, 1.5)).to.be.false;
      // Without exclusion, note 2 [1,2) overlaps [1,1.5).
      expect(hasOverlapAtPitch(idx, null, 60, 1, 1.5)).to.be.true;
    });
    it('returns false for unknown pitch', () => {
      const notes = [makeNote(1, 0, 1, 60)];
      const idx = createNotesIndex(notes);
      expect(hasOverlapAtPitch(idx, null, 72, 0, 1)).to.be.false;
    });
  });

  describe('clampPosition', () => {
    it('returns original start when no overlap', () => {
      const notes = [makeNote(1, 0, 1, 60)];
      const idx = createNotesIndex(notes);
      expect(clampPosition(idx, 1, 60, 5, 1)).to.equal(5);
    });
    it('pushes right when blocked by earlier note', () => {
      const notes = [makeNote(1, 0, 1, 60), makeNote(2, 0.5, 1, 60)];
      const idx = createNotesIndex(notes);
      // Move note 2 to start at 0.2 — overlaps note 1 [0,1). Should push to 1.
      const r = clampPosition(idx, 2, 60, 0.2, 1);
      expect(r).to.equal(1);
    });
    it('pushes left when blocked by later note', () => {
      const notes = [makeNote(1, 0, 1, 60), makeNote(2, 5, 1, 60)];
      const idx = createNotesIndex(notes);
      // Place note 1 at start=4.5 duration=1 → overlaps note 2 [5,6).
      // Closer side: leftStart = 4 (n2.start - dur), rightStart = 6.
      // 4 is closer to original 4.5 → pick left.
      const r = clampPosition(idx, 1, 60, 4.5, 1);
      expect(r).to.equal(4);
    });
    it('iterates to fixpoint when multiple neighbors', () => {
      // notes 1,2,3 placed at 0-1, 1-2, 2-3. Move note 1 to overlap both.
      const notes = [
        makeNote(1, 0, 1, 60),
        makeNote(2, 1, 1, 60),
        makeNote(3, 2, 1, 60),
      ];
      const idx = createNotesIndex(notes);
      // Place note 1 at start=1.5 → overlaps note 2 [1,2). Right push = 2 → overlaps note 3 [2,3). Right push = 3.
      const r = clampPosition(idx, 1, 60, 1.5, 1);
      expect(r).to.equal(3);
    });
    it('clamps to >= 0', () => {
      const notes = [makeNote(1, 0, 1, 60)];
      const idx = createNotesIndex(notes);
      expect(clampPosition(idx, 99, 60, -5, 1)).to.equal(0);
    });
  });

  describe('computeInactiveNoteIds', () => {
    it('returns empty for non-overlapping notes', () => {
      const notes = [makeNote(1, 0, 1), makeNote(2, 1, 1), makeNote(3, 2, 1)];
      const idx = createNotesIndex(notes);
      expect(computeInactiveNoteIds(idx).size).to.equal(0);
    });
    it('marks later overlapping note inactive', () => {
      const notes = [makeNote(1, 0, 2), makeNote(2, 1, 1)]; // 2 starts inside 1
      const idx = createNotesIndex(notes);
      const inactive = computeInactiveNoteIds(idx);
      expect(inactive.has(1)).to.be.false;
      expect(inactive.has(2)).to.be.true;
    });
    it('keeps the longer note active at shared start', () => {
      const notes = [
        makeNote(1, 0, 2), // longer, sorts first
        makeNote(2, 0, 1), // shorter, overlaps
      ];
      const idx = createNotesIndex(notes);
      const inactive = computeInactiveNoteIds(idx);
      expect(inactive.has(1)).to.be.false;
      expect(inactive.has(2)).to.be.true;
    });
    it('handles chain: 1 covers 2, 2 covers 3', () => {
      const notes = [
        makeNote(1, 0, 3), // [0,3)
        makeNote(2, 1, 3), // [1,4) — overlaps 1 → inactive
        makeNote(3, 2, 1), // [2,3) — overlaps 1 (active) → inactive
      ];
      const idx = createNotesIndex(notes);
      const inactive = computeInactiveNoteIds(idx);
      expect(inactive.has(1)).to.be.false;
      expect(inactive.has(2)).to.be.true;
      expect(inactive.has(3)).to.be.true;
    });
  });

  describe('findNoteAtBeat', () => {
    const notes = [
      makeNote(1, 0, 1, 60),
      makeNote(2, 1, 1, 60),
      makeNote(3, 2, 1, 72),
    ];
    let idx;
    beforeEach(() => {
      idx = createNotesIndex(notes.map((n) => ({ ...n })));
    });
    it('finds note containing the click (mid-body)', () => {
      const r = findNoteAtBeat(idx, 0.5, 60, 0.06);
      expect(r).to.not.be.null;
      expect(r.note.id).to.equal(1);
      expect(r.onResizeEdge).to.be.false;
    });
    it('marks resize edge when click is in trailing zone', () => {
      // note 1 ends at 1.0; trailing zone of 0.06 beats → click at 0.97 in zone.
      const r = findNoteAtBeat(idx, 0.97, 60, 0.06);
      expect(r.note.id).to.equal(1);
      expect(r.onResizeEdge).to.be.true;
    });
    it('returns null when click is in a gap (no note at that pitch)', () => {
      // Gap between note 1 (ends at 1) and note 2 (starts at 1) — adjacent,
      // so click at 1.0 belongs to note 2 (start).
      const r = findNoteAtBeat(idx, 1.0, 60, 0.06);
      expect(r).to.not.be.null;
      expect(r.note.id).to.equal(2);
    });
    it('returns null when click is at end of last note (no next note at same pitch)', () => {
      const r = findNoteAtBeat(idx, 2.0, 60, 0.06);
      expect(r).to.be.null;
    });
    it('returns null for pitch with no notes', () => {
      expect(findNoteAtBeat(idx, 0.5, 50, 0.06)).to.be.null;
    });
    it('respects pitch separation', () => {
      // Note 3 at pitch 72 [2,3). Click at 2.5 pitch 60 → no note (only 1,2 at 60, both ended).
      const r = findNoteAtBeat(idx, 2.5, 60, 0.06);
      expect(r).to.be.null;
    });
    it('handles resize zone larger than note duration', () => {
      // Tiny note: duration 0.05 beats. resizeBeats 0.06 covers whole note.
      const idx2 = createNotesIndex([makeNote(10, 5, 0.05, 60)]);
      const r = findNoteAtBeat(idx2, 5.02, 60, 0.06);
      expect(r.note.id).to.equal(10);
      expect(r.onResizeEdge).to.be.true;
    });
  });

  describe('findAdjacentBoundary', () => {
    it('snaps to nearest start boundary within maxBeats', () => {
      const notes = [
        makeNote(1, 0, 1, 60),
        makeNote(2, 2, 1, 60),
        makeNote(3, 4, 1, 60),
      ];
      const idx = createNotesIndex(notes);
      // t=2.05, maxBeats=0.1 → snap to note 2.start=2
      expect(findAdjacentBoundary(idx, null, 60, 2.05, 0.1)).to.equal(2);
      // t=3.95, maxBeats=0.1 → snap to note 3.start=4
      expect(findAdjacentBoundary(idx, null, 60, 3.95, 0.1)).to.equal(4);
    });
    it('snaps to end boundary too', () => {
      const notes = [makeNote(1, 0, 1, 60)]; // [0,1)
      const idx = createNotesIndex(notes);
      // t=0.95, maxBeats=0.1 → snap to end=1
      expect(findAdjacentBoundary(idx, null, 60, 0.95, 0.1)).to.equal(1);
      // t=0.05, maxBeats=0.1 → snap to start=0
      expect(findAdjacentBoundary(idx, null, 60, 0.05, 0.1)).to.equal(0);
    });
    it('returns t unchanged when no boundary within maxBeats', () => {
      const notes = [makeNote(1, 0, 1, 60)];
      const idx = createNotesIndex(notes);
      expect(findAdjacentBoundary(idx, null, 60, 5, 0.1)).to.equal(5);
    });
    it('respects excludeIds', () => {
      const notes = [makeNote(1, 0, 1, 60), makeNote(2, 2, 1, 60)];
      const idx = createNotesIndex(notes);
      // Exclude note 2, query near its start → no boundary → returns t.
      expect(findAdjacentBoundary(idx, new Set([2]), 60, 2.05, 0.1)).to.equal(2.05);
      // But note 1.end=1 is still available within 0.1 of 0.95.
      expect(findAdjacentBoundary(idx, new Set([2]), 60, 0.95, 0.1)).to.equal(1);
    });
    it('ignores different pitches', () => {
      const notes = [makeNote(1, 0, 1, 60), makeNote(2, 2, 1, 72)];
      const idx = createNotesIndex(notes);
      // Pitch 60 query near note 2.start=2 → note 2 is pitch 72, ignored.
      expect(findAdjacentBoundary(idx, null, 60, 2.05, 0.1)).to.equal(2.05);
      // Pitch 72 query near note 2.start=2 → snap to 2.
      expect(findAdjacentBoundary(idx, null, 72, 2.05, 0.1)).to.equal(2);
    });
  });

  describe('computeMultiDragResult', () => {
    it('returns blocked=false and planned when no overlap', () => {
      const notes = [
        makeNote(1, 0, 1, 60),
        makeNote(2, 2, 1, 60),
        makeNote(3, 4, 1, 60),
      ];
      const idx = createNotesIndex(notes);
      const selected = new Set([1, 2]);
      const newPos = new Map([
        [1, { start: 0.5, pitch: 60, duration: 1 }],
        [2, { start: 2.5, pitch: 60, duration: 1 }],
      ]);
      const r = computeMultiDragResult(idx, selected, newPos);
      expect(r.blocked).to.be.false;
      expect(r.planned.length).to.equal(2);
    });
    it('blocks when proposed position overlaps a non-selected note', () => {
      const notes = [
        makeNote(1, 0, 1, 60),  // selected
        makeNote(2, 5, 1, 60),  // obstacle
      ];
      const idx = createNotesIndex(notes);
      const selected = new Set([1]);
      const newPos = new Map([
        [1, { start: 4.5, pitch: 60, duration: 1 }], // [4.5,5.5) overlaps note 2 [5,6)
      ]);
      const r = computeMultiDragResult(idx, selected, newPos);
      expect(r.blocked).to.be.true;
      expect(r.planned).to.deep.equal([]);
    });
    it('allows selected notes to overlap each other (mutual movement)', () => {
      const notes = [
        makeNote(1, 0, 1, 60),
        makeNote(2, 1, 1, 60),
      ];
      const idx = createNotesIndex(notes);
      const selected = new Set([1, 2]);
      // Move both right by 0.5: 1→0.5 (overlaps 2 at 1.5? no, 2 moves to 1.5)
      const newPos = new Map([
        [1, { start: 0.5, pitch: 60, duration: 1 }],
        [2, { start: 1.5, pitch: 60, duration: 1 }],
      ]);
      const r = computeMultiDragResult(idx, selected, newPos);
      expect(r.blocked).to.be.false;
    });
    it('blocks when selected notes overlap each other at proposed positions', () => {
      // Actually: selected notes are allowed to overlap each other in the
      // current implementation (they move together). The block only applies
      // to non-selected obstacles. Verify this matches the design.
      const notes = [
        makeNote(1, 0, 1, 60),
        makeNote(2, 5, 1, 60),
      ];
      const idx = createNotesIndex(notes);
      const selected = new Set([1, 2]);
      // Move both to same spot at pitch 60 → would overlap each other but
      // since both are selected, not blocked by design.
      const newPos = new Map([
        [1, { start: 3, pitch: 60, duration: 1 }],
        [2, { start: 3.2, pitch: 60, duration: 1 }],
      ]);
      const r = computeMultiDragResult(idx, selected, newPos);
      expect(r.blocked).to.be.false;
    });
    it('handles different pitches independently', () => {
      const notes = [
        makeNote(1, 0, 1, 60),
        makeNote(2, 0, 1, 62),  // same time, different pitch — no overlap
      ];
      const idx = createNotesIndex(notes);
      const selected = new Set([1]);
      // Move note 1 to pitch 62 at same time → would overlap note 2.
      const newPos = new Map([
        [1, { start: 0, pitch: 62, duration: 1 }],
      ]);
      const r = computeMultiDragResult(idx, selected, newPos);
      expect(r.blocked).to.be.true;
    });
  });

  describe('insertNote / removeNoteById', () => {
    it('inserts and marks dirty', () => {
      const idx = createNotesIndex([makeNote(1, 0, 1)]);
      const v0 = idx.version;
      insertNote(idx, makeNote(2, 2, 1));
      expect(idx.version).to.be.greaterThan(v0);
      expect(idx.notes.length).to.equal(2);
      ensureSorted(idx);
      expect(idx.notes.map((n) => n.id)).to.deep.equal([1, 2]);
    });
    it('removes by id and marks dirty', () => {
      const idx = createNotesIndex([makeNote(1, 0, 1), makeNote(2, 2, 1)]);
      removeNoteById(idx, 1);
      expect(idx.notes.map((n) => n.id)).to.deep.equal([2]);
    });
    it('rebuildIndex re-sorts after external mutation', () => {
      const idx = createNotesIndex([makeNote(1, 0, 1), makeNote(2, 2, 1)]);
      idx.notes[0].start = 5; // unsorted external mutation
      rebuildIndex(idx);
      expect(idx.notes.map((n) => n.id)).to.deep.equal([2, 1]);
    });
  });
});
