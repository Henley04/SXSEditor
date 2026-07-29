/**
 * Notes index for O(log n) hit-test / overlap detection / viewport culling.
 *
 * Invariants maintained:
 *   - `notes` array is sorted by start ascending; ties broken by duration
 *     descending (longer notes win when sharing a start tick, so they show up
 *     first in iteration and are preferred for hit-test at the shared start).
 *   - `pitchIndex` is a Map<pitch, number[]> mapping each pitch value to the
 *     sorted array of indices into `notes`. Rebuilt lazily when dirty.
 *   - `version` increments on every mutation that invalidates caches.
 *
 * All functions are pure w.r.t. the index object: callers pass the index in,
 * we mutate it explicitly and return it. No hidden module-level state.
 */

const EPS = 1e-9;

/**
 * Compare two notes by (start asc, duration desc).
 * @param {{start:number,duration:number}} a
 * @param {{start:number,duration:number}} b
 */
export function compareNotes(a, b) {
  if (a.start < b.start - EPS) return -1;
  if (a.start > b.start + EPS) return 1;
  // Same start: longer first (so it appears earlier in array and wins
  // hit-test at the shared boundary).
  if (a.duration > b.duration + EPS) return -1;
  if (a.duration < b.duration - EPS) return 1;
  return 0;
}

/**
 * Create a fresh index wrapping an existing notes array (which will be sorted
 * in place). The caller still owns `notes` — index just adds bookkeeping.
 * @param {Array} notes
 */
export function createNotesIndex(notes) {
  const idx = {
    notes,
    sorted: false,
    pitchIndex: null,
    pitchIndexVersion: -1,
    // Max note duration seen in the array. Refreshed on every sort. Used as
    // a lower-bound safety window for findAdjacentBoundary so we can binary
    // search the start index instead of scanning from 0.
    maxDuration: 0,
    maxDurationVersion: -1,
    version: 0,
  };
  ensureSorted(idx);
  return idx;
}

/**
 * Mark the index dirty. Call this after any unsorted mutation (push, splice,
 * direct assignment of start/duration). The next read will re-sort lazily.
 */
export function markDirty(idx) {
  idx.sorted = false;
  idx.pitchIndex = null;
  idx.pitchIndexVersion = -1;
  idx.maxDuration = 0;
  idx.maxDurationVersion = -1;
  idx.version++;
}

/**
 * Sort notes array in place if dirty and rebuild pitch index.
 * O(n log n) when dirty, O(n) when clean (verification scan).
 *
 * The O(n) verification scan catches in-place mutations performed outside
 * the index API (e.g. event handlers directly assigning note.start), so
 * callers do not need to call markDirty() after every such mutation.
 */
export function ensureSorted(idx) {
  if (idx.sorted) {
    // Verify still sorted — handles external in-place mutations.
    for (let i = 1; i < idx.notes.length; i++) {
      if (compareNotes(idx.notes[i - 1], idx.notes[i]) > 0) {
        idx.sorted = false;
        break;
      }
    }
  }
  if (idx.sorted) {
    _ensureMaxDuration(idx);
    return;
  }
  idx.notes.sort(compareNotes);
  idx.sorted = true;
  idx.pitchIndex = null;
  idx.pitchIndexVersion = -1;
  idx.maxDuration = 0;
  idx.maxDurationVersion = -1;
  idx.version++;
  _ensureMaxDuration(idx);
}

/**
 * Refresh idx.maxDuration if stale. O(n) scan but only runs when version
 * changed; cached otherwise. Used by findAdjacentBoundary to lower-bound
 * the binary search window.
 */
function _ensureMaxDuration(idx) {
  if (idx.maxDurationVersion === idx.version) return;
  let m = 0;
  for (let i = 0; i < idx.notes.length; i++) {
    const d = idx.notes[i].duration;
    if (d > m) m = d;
  }
  idx.maxDuration = m;
  idx.maxDurationVersion = idx.version;
}

function _ensurePitchIndex(idx) {
  ensureSorted(idx);
  if (idx.pitchIndex && idx.pitchIndexVersion === idx.version) return;
  const map = new Map();
  for (let i = 0; i < idx.notes.length; i++) {
    const n = idx.notes[i];
    let arr = map.get(n.pitch);
    if (!arr) {
      arr = [];
      map.set(n.pitch, arr);
    }
    // notes is already sorted by start, so push preserves order per pitch
    arr.push(i);
  }
  idx.pitchIndex = map;
  idx.pitchIndexVersion = idx.version;
}

/**
 * Binary search for the largest index i such that notes[i].start <= t.
 * Returns -1 if no such note (all start later).
 * Requires notes sorted ascending by start.
 * @param {Array} notes
 * @param {number} t  beat time
 */
export function bisectLastStartLE(notes, t) {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (notes[mid].start <= t + EPS) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

/**
 * Binary search for the first index i such that notes[i].start >= t.
 * Returns notes.length if none.
 */
export function bisectFirstStartGE(notes, t) {
  let lo = 0;
  let hi = notes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (notes[mid].start < t - EPS) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Find notes whose [start, start+duration) overlaps a given beat window
 * [tStart, tEnd). Uses binary search on sorted notes.
 * @returns {Array} array of note objects (references, not copies)
 */
export function notesInRange(idx, tStart, tEnd) {
  ensureSorted(idx);
  _ensureMaxDuration(idx);
  const notes = idx.notes;
  // Lower-bound the scan start to tStart - maxDuration: a note whose start is
  // earlier than that cannot extend into [tStart, tEnd) because its duration
  // is <= maxDuration. Previously this used a hardcoded "1000 beats" safety
  // which would prematurely break the backwards walk for very long notes
  // (>1000 beats ≈ hundreds of bars), causing them to be dropped from the
  // viewport. Using the actual maxDuration keeps the lower bound both tight
  // and correct for any note length.
  const lowerBound = tStart - idx.maxDuration - EPS;
  const firstGE = Math.max(0, bisectFirstStartGE(notes, lowerBound));
  // Walk forward from firstGE; notes are sorted by start so we can break
  // once start > tEnd.
  const result = [];
  for (let i = firstGE; i < notes.length; i++) {
    const n = notes[i];
    if (n.start > tEnd + EPS) break;
    const nEnd = n.start + n.duration;
    if (nEnd > tStart + EPS && n.start < tEnd - EPS) {
      result.push(n);
    }
  }
  return result;
}

/**
 * Detect whether any note at the given pitch overlaps [tStart, tEnd).
 * O(log n) via pitch index + binary search on the per-pitch sub-array.
 * @param {object} idx
 * @param {Set<number>|null} excludeIds  ids to skip
 * @param {number} pitch
 * @param {number} tStart
 * @param {number} tEnd
 * @returns {boolean}
 */
export function hasOverlapAtPitch(idx, excludeIds, pitch, tStart, tEnd) {
  _ensurePitchIndex(idx);
  const arr = idx.pitchIndex.get(pitch);
  if (!arr || arr.length === 0) return false;
  const notes = idx.notes;
  // Binary search for last index in arr whose note.start < tEnd.
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (notes[arr[mid]].start < tEnd - EPS) lo = mid + 1;
    else hi = mid;
  }
  // Scan backwards from lo-1 while note.start >= tStart - safety. Since all
  // candidates whose start < tEnd are at indices < lo, and we only care about
  // those whose end > tStart, scan backwards until start < tStart AND the
  // note definitely can't reach tStart (start + duration <= tStart). With
  // bounded durations this is O(log n + k) where k is the count of notes
  // starting in [tStart - maxDur, tEnd).
  for (let i = lo - 1; i >= 0; i--) {
    const n = notes[arr[i]];
    if (n.start < tStart - EPS && n.start + n.duration <= tStart + EPS) break;
    if (excludeIds && excludeIds.has(n.id)) continue;
    const nEnd = n.start + n.duration;
    if (nEnd > tStart + EPS && n.start < tEnd - EPS) return true;
  }
  return false;
}

/**
 * Clamp `start` so that [start, start+duration) at `pitch` does not overlap
 * any other note. Mirrors the original canvasRenderer.clampNotePosition
 * semantics: for each conflicting neighbor (in start order), if the current
 * cursor sits inside the neighbor, push right (cur = neighbor.end); else push
 * left (cur = neighbor.start - duration). Multi-pass until stable, capped at
 * a small iteration count to avoid pathological oscillation.
 *
 * @param {object} idx
 * @param {number} excludeId  note id to ignore
 * @param {number} pitch
 * @param {number} start  proposed start
 * @param {number} duration
 * @returns {number} clamped start (>= 0)
 */
export function clampPosition(idx, excludeId, pitch, start, duration) {
  _ensurePitchIndex(idx);
  const arr = idx.pitchIndex.get(pitch);
  if (!arr || arr.length === 0) return Math.max(0, start);

  let cur = start;
  const notes = idx.notes;
  // Multi-pass: each pass scans all candidates once and resolves the first
  // conflict by adjusting cur. Continue until a pass produces no change.
  for (let iter = 0; iter < 16; iter++) {
    const tEnd = cur + duration;
    // Find candidates: notes at this pitch whose start < tEnd (so could
    // overlap). Binary search for last such index in arr.
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (notes[arr[mid]].start < tEnd - EPS) lo = mid + 1;
      else hi = mid;
    }
    let changed = false;
    // Walk backwards from lo-1 while notes still potentially overlap cur
    // (i.e., their end > cur).
    for (let i = lo - 1; i >= 0; i--) {
      const n = notes[arr[i]];
      if (n.start + n.duration <= cur + EPS) break; // safely before cur
      if (n.id === excludeId) continue;
      const nEnd = n.start + n.duration;
      if (nEnd > cur + EPS && n.start < tEnd - EPS) {
        // Overlap. Decide direction based on cur (not original start) so
        // multi-pass iterations stay consistent and converge.
        if (cur >= n.start - EPS) {
          // cur is inside [n.start, nEnd) → push right.
          const newCur = nEnd;
          if (Math.abs(newCur - cur) < EPS) { changed = false; break; }
          cur = newCur;
        } else {
          // cur is before n.start but [cur, tEnd) still reaches into n
          // (because tEnd > n.start). Push left.
          const newCur = n.start - duration;
          if (Math.abs(newCur - cur) < EPS) { changed = false; break; }
          cur = newCur;
        }
        changed = true;
        break; // re-scan with the new cur from the start of arr
      }
    }
    if (!changed) break;
  }
  return Math.max(0, cur);
}

/**
 * Compute inactive note ids: notes whose time range overlaps an earlier note
 * in array order. With sorted array, "earlier in array" = "earlier or equal
 * start". If two notes share start, the longer one (which sorts first) is
 * active; the shorter is inactive.
 *
 * O(n) after sort.
 *
 * @param {object} idx
 * @returns {Set<number>} inactive note ids
 */
export function computeInactiveNoteIds(idx) {
  ensureSorted(idx);
  const notes = idx.notes;
  const inactive = new Set();
  if (notes.length === 0) return inactive;
  let activeEnd = -Infinity;
  // First pass: mark notes that overlap any previously-active note.
  // Because notes are sorted by start, we can keep a single running
  // activeEnd that tracks the latest end among notes that have been
  // activated so far AND extend past the current note's start.
  //
  // However, the original semantics are slightly different: it considers
  // a note inactive if it overlaps ANY previously-activated note, where
  // activation order is array order. With sorted array, array order = start
  // order (with tie-break by duration desc). The original code processed
  // notes in raw insertion order; to preserve observable behavior we keep
  // "previous active set" semantics: a note is inactive if it overlaps any
  // note that appeared before it in the (now sorted) array AND that earlier
  // note was itself active.
  //
  // We use a sweep with active intervals. Simpler: maintain the maximum end
  // among activated notes; if the current note's start < that max end, it
  // overlaps some earlier active note → inactive. Else active, and we
  // extend max end.
  //
  // But ties (same start): the first (longer) note activates and sets
  // max end; the second (shorter, or equal) note's start == max start, but
  // its start < max end (if max end > start), so it's inactive. If first
  // note's duration is 0 (degenerate), max end == start, second note's
  // start == max end → not strictly less → active. Matches original.
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    if (n.start < activeEnd - EPS) {
      inactive.add(n.id);
    } else {
      activeEnd = Math.max(activeEnd, n.start + n.duration);
    }
  }
  return inactive;
}

/**
 * Find a note at canvas coordinates (xTime, pitch).
 *
 * Returns { note, onResizeEdge } or null.
 *
 * - onResizeEdge: true if xTime is within the trailing resize zone of the
 *   note. The resize zone is computed in beats from a pixel width so it
 *   scales sensibly with zoom.
 * - Half-open interval [start, start+duration): eliminates boundary
 *   ambiguity. If two notes share an end/start boundary, the click at the
 *   boundary belongs to the SECOND note's start — but we still prefer the
 *   FIRST note's resize edge when the click is within its trailing resize
 *   zone, so the user can grab the end of either note.
 *
 * @param {object} idx
 * @param {number} xTime  beat time at click x
 * @param {number} pitch  snapped pitch at click y
 * @param {number} resizeBeats  half-width of the resize hot zone in beats
 * @returns {{note:object, onResizeEdge:boolean}|null}
 */
export function findNoteAtBeat(idx, xTime, pitch, resizeBeats) {
  ensureSorted(idx);
  const notes = idx.notes;
  _ensurePitchIndex(idx);
  const arr = idx.pitchIndex.get(pitch);
  if (!arr || arr.length === 0) return null;

  // Binary search for last index in arr whose note.start <= xTime.
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (notes[arr[mid]].start <= xTime + EPS) lo = mid + 1;
    else hi = mid;
  }
  // Candidate 1: note at arr[lo-1] whose [start, end) contains xTime.
  if (lo > 0) {
    const n = notes[arr[lo - 1]];
    const nEnd = n.start + n.duration;
    if (xTime >= n.start - EPS && xTime < nEnd - EPS) {
      const onResize = (nEnd - xTime) <= resizeBeats + EPS;
      return { note: n, onResizeEdge: onResize };
    }
  }
  // Candidate 2: note at arr[lo] whose start == xTime (boundary click on
  // the start of the next note). This case fires when xTime falls in the
  // gap before this note OR exactly at the previous note's end.
  if (lo < arr.length) {
    const n = notes[arr[lo]];
    if (Math.abs(n.start - xTime) <= EPS && xTime < n.start + n.duration - EPS) {
      const onResize = (n.start + n.duration - xTime) <= resizeBeats + EPS;
      return { note: n, onResizeEdge: onResize };
    }
  }
  return null;
}

/**
 * Find the closest adjacent boundary (start or end) of any non-excluded note
 * at the given pitch within `maxBeats` of `t`. Used for magnetic snap during
 * drag/resize: when the proposed edge is within a few pixels of a neighbor's
 * edge, snap to it.
 *
 * Returns the snapped beat, or `t` (unchanged) if no boundary is close.
 *
 * @param {object} idx
 * @param {Set<number>|null} excludeIds  notes to ignore (e.g. the dragged note)
 * @param {number} pitch
 * @param {number} t  proposed beat (edge of the dragged note)
 * @param {number} maxBeats  max distance to consider for snapping
 * @returns {number} snapped beat (or `t` if no snap)
 */
export function findAdjacentBoundary(idx, excludeIds, pitch, t, maxBeats) {
  _ensurePitchIndex(idx);
  _ensureMaxDuration(idx);
  const arr = idx.pitchIndex.get(pitch);
  if (!arr || arr.length === 0) return t;
  const notes = idx.notes;
  let bestT = t;
  let bestDist = maxBeats;
  // A note's END can reach into the snap window only if its start is within
  // (t - maxBeats - maxDuration). Use that as a binary-searchable lower
  // bound: find the first arr index whose note.start >= lowerBound, then
  // scan forward. Upper bound is tight (start > t + maxBeats).
  //
  // Complexity: O(log n + k) where k = notes whose [start, start+duration]
  // intersects [t - maxBeats, t + maxBeats]. Previously this scanned from
  // index 0, which degenerated to O(n) when t was near the array end.
  const safety = Math.max(idx.maxDuration, maxBeats);
  const lowerBound = t - safety - EPS;
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (notes[arr[mid]].start < lowerBound) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < arr.length; i++) {
    const n = notes[arr[i]];
    if (n.start > t + maxBeats + EPS) break;
    if (excludeIds && excludeIds.has(n.id)) continue;
    const nEnd = n.start + n.duration;
    // Skip notes whose end is also far before t (no boundary near t).
    if (nEnd < t - maxBeats - EPS) continue;
    // Check start boundary.
    const dStart = Math.abs(n.start - t);
    if (dStart < bestDist) {
      bestDist = dStart;
      bestT = n.start;
    }
    // Check end boundary.
    const dEnd = Math.abs(nEnd - t);
    if (dEnd < bestDist) {
      bestDist = dEnd;
      bestT = nEnd;
    }
  }
  return bestT;
}

/**
 * Compute the multi-drag result: given a set of selected notes and their
 * proposed new (start, pitch), determine which ones can move without
 * overlapping any non-selected note. Returns:
 *   { blocked: boolean, planned: Array<{note, newStart, newPitch}> }
 *
 * O((k + n) log k) instead of O(k * n).
 *
 * @param {object} idx  notes index (non-selected notes are the obstacles)
 * @param {Set<number>} selectedIds
 * @param {Map<number,{start:number,pitch:number,duration:number}>} newPositions
 *   map from note id to proposed new start/pitch/duration
 * @returns {{blocked:boolean, planned:Array}}
 */
export function computeMultiDragResult(idx, selectedIds, newPositions) {
  ensureSorted(idx);
  // Collect proposed intervals for selected notes, grouped by pitch.
  const byPitch = new Map();
  for (const id of selectedIds) {
    const np = newPositions.get(id);
    if (!np) continue;
    let arr = byPitch.get(np.pitch);
    if (!arr) {
      arr = [];
      byPitch.set(np.pitch, arr);
    }
    arr.push({ id, start: np.start, end: np.start + np.duration });
  }
  // Sort each pitch group by start.
  for (const arr of byPitch.values()) {
    arr.sort((a, b) => a.start - b.start);
  }
  // For each pitch, merge the proposed intervals with the non-selected
  // notes' intervals at that pitch and check for overlap.
  let blocked = false;
  const planned = [];
  _ensurePitchIndex(idx);
  for (const [pitch, proposed] of byPitch) {
    const obstacleArr = idx.pitchIndex.get(pitch) || [];
    // Build obstacle interval list (skip selected ids).
    const obstacles = [];
    for (const oi of obstacleArr) {
      const n = idx.notes[oi];
      if (selectedIds.has(n.id)) continue;
      obstacles.push({ start: n.start, end: n.start + n.duration });
    }
    // Two-pointer merge: both arrays sorted by start.
    let i = 0;
    for (const p of proposed) {
      // Advance i past obstacles that end before p.start.
      while (i < obstacles.length && obstacles[i].end <= p.start + EPS) i++;
      // Check obstacles[i] (and possibly subsequent) for overlap with p.
      let j = i;
      while (j < obstacles.length && obstacles[j].start < p.end - EPS) {
        const o = obstacles[j];
        if (o.end > p.start + EPS && o.start < p.end - EPS) {
          blocked = true;
          break;
        }
        j++;
      }
      if (blocked) break;
    }
    if (blocked) break;
  }
  if (!blocked) {
    // Build id -> note map once (O(n)) so the per-id lookup below is O(1).
    // Previously this used idx.notes.find() inside the loop, making the
    // whole planned construction O(k * n) — which directly contradicts the
    // O((k+n) log k) goal for the large-scale multi-drag case.
    const idToNote = new Map();
    for (let i = 0; i < idx.notes.length; i++) {
      idToNote.set(idx.notes[i].id, idx.notes[i]);
    }
    for (const id of selectedIds) {
      const np = newPositions.get(id);
      if (!np) continue;
      planned.push({ note: idToNote.get(id), newStart: np.start, newPitch: np.pitch });
    }
  }
  return { blocked, planned };
}

/**
 * Insert a note into the sorted array in O(n) (shift). For batch inserts,
 * push all then call ensureSorted() once.
 * @param {object} idx
 * @param {object} note
 */
export function insertNote(idx, note) {
  idx.notes.push(note);
  markDirty(idx);
}

/**
 * Remove a note by id. O(n).
 * @param {object} idx
 * @param {number} id
 */
export function removeNoteById(idx, id) {
  const i = idx.notes.findIndex((n) => n.id === id);
  if (i !== -1) {
    idx.notes.splice(i, 1);
    markDirty(idx);
  }
}

/**
 * Rebuild the index after external mutations (e.g., undo/redo replaced the
 * notes array contents). Call this whenever you mutate note.start/duration
 * in place outside of insertNote/removeNoteById.
 */
export function rebuildIndex(idx) {
  markDirty(idx);
  ensureSorted(idx);
}
