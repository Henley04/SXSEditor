'use strict';
/**
 * Pure helpers shared by the automation renderer, the bridge and the tests.
 *
 * Nothing here touches the DOM or Electron, so it can be unit-tested with plain
 * mocha and reused by any front-end that needs to build project payloads.
 */

function validationError(field, message, hint) {
  const err = new Error(message);
  err.code = 'VALIDATION_ERROR';
  err.field = field;
  if (hint) err.hint = hint;
  return err;
}

/** FNV-1a style 64-bit-ish hash. No node:crypto: this module is bundled into the renderer. */
function hash12(input) {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 + c, 2654435761) ^ (h2 >>> 13);
  }
  return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0')).slice(0, 12);
}

/** Stable id derived from note content, so re-sending the same payload is a no-op for diffs. */
function noteId(n, index) {
  const key = `${n.pitch}|${n.start}|${n.duration}|${n.lyric}|${index}`;
  return `n_${hash12(key)}`;
}

function normalizeNote(n, index = 0, fieldPrefix = 'notes') {
  if (!n || typeof n !== 'object') throw validationError(`${fieldPrefix}[${index}]`, 'note must be an object');
  const field = `${fieldPrefix}[${index}]`;
  const pitch = Math.round(Number(n.pitch));
  const start = Number(n.start);
  const duration = Number(n.duration);
  if (!Number.isInteger(pitch) || pitch < 0 || pitch > 127) {
    throw validationError(`${field}.pitch`, 'pitch must be an integer 0-127', `got ${n.pitch}`);
  }
  if (!Number.isFinite(start) || start < 0) {
    throw validationError(`${field}.start`, 'start must be a number >= 0', `got ${n.start}`);
  }
  if (!Number.isFinite(duration) || duration <= 0) {
    throw validationError(`${field}.duration`, 'duration must be a number > 0', `got ${n.duration}`);
  }
  const lyric = n.lyric === undefined || n.lyric === null ? 'la' : String(n.lyric);
  const out = { pitch, start, duration, lyric };
  if (n.id) out.id = String(n.id);
  return { ...n, ...out, id: out.id || noteId(out, index) };
}

function normalizeFragment(f, index = 0) {
  if (!f || typeof f !== 'object') throw validationError(`fragments[${index}]`, 'fragment must be an object');
  const duration = Number(f.duration === undefined ? 4 : f.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw validationError(`fragments[${index}].duration`, 'duration must be a number > 0');
  }
  const startTime = Number(f.startTime === undefined ? 0 : f.startTime);
  if (!Number.isFinite(startTime) || startTime < 0) {
    throw validationError(`fragments[${index}].startTime`, 'startTime must be a number >= 0');
  }
  const notes = Array.isArray(f.notes)
    ? f.notes.map((n, i) => normalizeNote(n, i, `fragments[${index}].notes`))
    : [];
  return { ...f, startTime, duration, notes };
}

function validateProjectDoc(doc) {
  const errors = [];
  if (!doc || typeof doc !== 'object') {
    return { valid: false, errors: [{ field: '(root)', message: 'project document must be an object' }] };
  }
  if (doc.project) {
    if (doc.project.bpm !== undefined && !(Number(doc.project.bpm) > 0)) {
      errors.push({ field: 'project.bpm', message: 'bpm must be > 0' });
    }
    if (doc.project.timeSignature !== undefined) {
      const ts = doc.project.timeSignature;
      if (!Array.isArray(ts) || ts.length !== 2 || !ts.every((v) => Number.isInteger(v) && v > 0)) {
        errors.push({ field: 'project.timeSignature', message: 'timeSignature must be [numerator, denominator]' });
      }
    }
  }
  if (!Array.isArray(doc.singers)) errors.push({ field: 'singers', message: 'must be an array' });
  if (!Array.isArray(doc.fragments)) errors.push({ field: 'fragments', message: 'must be an array' });

  const singerIds = new Set();
  (Array.isArray(doc.singers) ? doc.singers : []).forEach((s, i) => {
    if (!s || typeof s !== 'object') {
      errors.push({ field: `singers[${i}]`, message: 'must be an object' });
      return;
    }
    if (s.id) {
      if (singerIds.has(s.id)) errors.push({ field: `singers[${i}].id`, message: `duplicate singer id ${s.id}` });
      singerIds.add(s.id);
    }
    if (!s.trackName && !s.singerName) {
      errors.push({ field: `singers[${i}]`, message: 'trackName or singerName is required' });
    }
  });

  (Array.isArray(doc.fragments) ? doc.fragments : []).forEach((f, i) => {
    if (!f || typeof f !== 'object') {
      errors.push({ field: `fragments[${i}]`, message: 'must be an object' });
      return;
    }
    if (!f.singerId) errors.push({ field: `fragments[${i}].singerId`, message: 'is required' });
    else if (singerIds.size && !singerIds.has(f.singerId)) {
      errors.push({ field: `fragments[${i}].singerId`, message: `unknown singer ${f.singerId}`, hint: `known: ${[...singerIds].join(', ')}` });
    }
    try {
      normalizeFragment(f, i);
    } catch (e) {
      errors.push({ field: e.field || `fragments[${i}]`, message: e.message, hint: e.hint });
    }
  });

  return { valid: errors.length === 0, errors };
}

/** Slim/paginate a snapshot for project.get. */
function shapeSnapshot(snapshot, opts = {}) {
  const { includeNotes = true, noteOffset = 0, noteLimit, fields } = opts;
  let out = snapshot;
  if (Array.isArray(fields) && fields.length) {
    out = {};
    for (const key of fields) if (snapshot[key] !== undefined) out[key] = snapshot[key];
  }
  if (!includeNotes && Array.isArray(out.fragments)) {
    out = { ...out, fragments: out.fragments.map((f) => ({ ...f, notes: undefined, noteCount: (f.notes || []).length })) };
  } else if (Array.isArray(out.fragments) && (noteOffset > 0 || noteLimit)) {
    out = {
      ...out,
      fragments: out.fragments.map((f) => {
        const notes = f.notes || [];
        const start = Math.min(noteOffset, notes.length);
        const end = noteLimit ? Math.min(start + noteLimit, notes.length) : notes.length;
        return { ...f, notes: notes.slice(start, end), noteCount: notes.length, noteOffset: start };
      }),
    };
  }
  return out;
}

module.exports = {
  validationError,
  noteId,
  normalizeNote,
  normalizeFragment,
  validateProjectDoc,
  shapeSnapshot,
};
