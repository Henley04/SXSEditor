const { expect } = require('chai');
const { validate, validateParams } = require('../src/main/mcpValidate');
const { getMethod } = require('../src/shared/mcpSchema');

describe('MCP parameter validation', function () {
  it('reports a missing required field by path', function () {
    const errors = validate({}, { type: 'object', properties: { seconds: { type: 'number' } }, required: ['seconds'] });
    expect(errors).to.have.length(1);
    expect(errors[0].field).to.equal('seconds');
    expect(errors[0].message).to.equal('is required');
  });

  it('reports type mismatches including the received type', function () {
    const errors = validate({ seconds: 'soon' }, { type: 'object', properties: { seconds: { type: 'number' } } });
    expect(errors[0].message).to.contain('expected number, got string');
  });

  it('enforces enum, bounds and array item schemas', function () {
    const s = {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['MIDI', 'Pitch'] },
        zoom: { type: 'number', minimum: 0.25, maximum: 8 },
        notes: { type: 'array', items: { type: 'object', properties: { pitch: { type: 'integer', minimum: 0, maximum: 127 } }, required: ['pitch'] } },
      },
    };
    const errors = validate({ mode: 'Nope', zoom: 99, notes: [{ pitch: 200 }, {}] }, s);
    const fields = errors.map((e) => e.field);
    expect(fields).to.include('mode');
    expect(fields).to.include('zoom');
    expect(fields).to.include('notes[0].pitch');
    expect(fields).to.include('notes[1].pitch');
  });

  it('rejects unknown parameters when additionalProperties is false', function () {
    const errors = validate({ bogus: 1 }, { type: 'object', properties: {}, additionalProperties: false });
    expect(errors[0].field).to.equal('bogus');
    expect(errors[0].hint).to.contain('known:');
  });

  it('applies legacy aliases and warns instead of failing', function () {
    const def = getMethod('fragment.open');
    const r = validateParams(def, { id: 'f1' });
    expect(r.ok).to.equal(true);
    expect(r.value.fragmentId).to.equal('f1');
    expect(r.value.id).to.equal(undefined);
    expect(r.warnings[0].code).to.equal('ALIAS_DEPRECATED');
  });

  it('accepts the legacy double-nested project.replace payload', function () {
    const def = getMethod('project.replace');
    const doc = { singers: [], fragments: [] };
    const r = validateParams(def, { project: { project: doc } });
    expect(r.ok, JSON.stringify(r.errors)).to.equal(true);
    expect(r.value.project).to.deep.equal(doc);
    expect(r.warnings).to.have.length(1);
  });

  it('validates a realistic project.replace payload', function () {
    const def = getMethod('project.replace');
    const r = validateParams(def, {
      project: {
        project: { bpm: 96, timeSignature: [4, 4] },
        singers: [{ id: 's1', trackName: 'Lead' }],
        fragments: [{ id: 'f1', singerId: 's1', startTime: 0, duration: 4, notes: [{ pitch: 60, start: 0, duration: 1, lyric: 'la' }] }],
      },
    });
    expect(r.ok, JSON.stringify(r.errors)).to.equal(true);
  });

  it('flags a fragment note without pitch', function () {
    const def = getMethod('project.replace');
    const r = validateParams(def, {
      project: { singers: [], fragments: [{ id: 'f', singerId: 's', notes: [{ start: 0, duration: 1 }] }] },
    });
    expect(r.ok).to.equal(false);
    expect(r.errors[0].field).to.contain('notes[0].pitch');
  });

  it('accepts settings.patch as an alias for settings', function () {
    const def = getMethod('settings.update');
    const r = validateParams(def, { patch: { theme: 'dark' } });
    expect(r.ok).to.equal(true);
    expect(r.value.settings).to.deep.equal({ theme: 'dark' });
  });
});
