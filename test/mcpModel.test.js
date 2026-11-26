const { expect } = require('chai');
const {
  noteId, normalizeNote, normalizeFragment, validateProjectDoc, shapeSnapshot,
} = require('../src/shared/mcpModel');

describe('MCP project model helpers', function () {
  it('derives stable note ids from content', function () {
    const n = { pitch: 60, start: 1, duration: 0.5, lyric: 'la' };
    expect(noteId(n, 0)).to.equal(noteId({ ...n }, 0));
    expect(noteId(n, 0)).to.not.equal(noteId(n, 1));
    expect(noteId(n, 0)).to.match(/^n_[0-9a-f]{12}$/);
  });

  it('keeps an explicit note id', function () {
    const out = normalizeNote({ id: 'custom', pitch: 60, start: 0, duration: 1 });
    expect(out.id).to.equal('custom');
  });

  it('rejects out-of-range pitch with a field path', function () {
    expect(() => normalizeNote({ pitch: 200, start: 0, duration: 1 }, 2, 'notes'))
      .to.throw(/pitch/).with.property('field', 'notes[2].pitch');
  });

  it('rejects non-positive duration', function () {
    expect(() => normalizeNote({ pitch: 60, start: 0, duration: 0 }))
      .to.throw(/duration/);
  });

  it('normalises fragments and their notes', function () {
    const f = normalizeFragment({ name: 'v', notes: [{ pitch: 61.4, start: 0, duration: 2 }] }, 0);
    expect(f.startTime).to.equal(0);
    expect(f.notes[0].pitch).to.equal(61);
    expect(f.id).to.equal(undefined);
  });

  it('validateProjectDoc accepts a coherent document', function () {
    const r = validateProjectDoc({
      project: { bpm: 120, timeSignature: [4, 4] },
      singers: [{ id: 's1', trackName: 'Lead' }],
      fragments: [{ id: 'f1', singerId: 's1', startTime: 0, duration: 4, notes: [{ pitch: 60, start: 0, duration: 1 }] }],
    });
    expect(r.valid, JSON.stringify(r.errors)).to.equal(true);
  });

  it('validateProjectDoc reports unknown singer references', function () {
    const r = validateProjectDoc({
      singers: [{ id: 's1', trackName: 'Lead' }],
      fragments: [{ id: 'f1', singerId: 'ghost', duration: 4 }],
    });
    expect(r.valid).to.equal(false);
    expect(r.errors[0].field).to.equal('fragments[0].singerId');
    expect(r.errors[0].message).to.contain('unknown singer');
  });

  it('validateProjectDoc rejects duplicate singer ids', function () {
    const r = validateProjectDoc({
      singers: [{ id: 's1', trackName: 'A' }, { id: 's1', trackName: 'B' }],
      fragments: [],
    });
    expect(r.valid).to.equal(false);
    expect(r.errors.some((e) => /duplicate/.test(e.message))).to.equal(true);
  });

  it('shapeSnapshot can drop notes but keep counts', function () {
    const snap = {
      project: { bpm: 120 },
      singers: [],
      fragments: [{ id: 'f1', notes: [{ id: 'a' }, { id: 'b' }] }],
      isDirty: false,
    };
    const out = shapeSnapshot(snap, { includeNotes: false });
    expect(out.fragments[0].notes).to.equal(undefined);
    expect(out.fragments[0].noteCount).to.equal(2);
  });

  it('shapeSnapshot paginates notes', function () {
    const snap = {
      fragments: [{ id: 'f1', notes: [1, 2, 3, 4].map((i) => ({ id: `n${i}` })) }],
    };
    const out = shapeSnapshot(snap, { noteOffset: 1, noteLimit: 2 });
    expect(out.fragments[0].notes.map((n) => n.id)).to.deep.equal(['n2', 'n3']);
    expect(out.fragments[0].noteCount).to.equal(4);
  });

  it('shapeSnapshot can project a subset of fields', function () {
    const snap = { project: { bpm: 120 }, singers: [1], fragments: [], isDirty: true };
    const out = shapeSnapshot(snap, { fields: ['project'] });
    expect(Object.keys(out)).to.deep.equal(['project']);
  });
});
