const { expect } = require('chai');
const { METHODS, schema, getMethod, methodNames } = require('../src/shared/mcpSchema');

describe('MCP schema', function () {
  it('every method declares a summary and a target', function () {
    for (const name of methodNames()) {
      const def = METHODS[name];
      expect(def.summary, `${name} summary`).to.be.a('string').and.not.empty;
      expect(def.target, `${name} target`).to.be.oneOf(['main', 'renderer', 'editor']);
    }
  });

  it('every method has an object params schema', function () {
    for (const name of methodNames()) {
      const p = METHODS[name].params;
      expect(p, `${name} params`).to.be.an('object');
      expect(p.type, `${name} params.type`).to.equal('object');
    }
  });

  it('aliases point at declared parameters', function () {
    for (const [name, def] of Object.entries(METHODS)) {
      for (const [from, to] of Object.entries(def.aliases || {})) {
        expect(def.params.properties, `${name} has properties`).to.be.an('object');
        expect(def.params.properties[to], `${name}.${from} -> ${to}`).to.be.an('object');
      }
    }
  });

  it('required keys exist in properties', function () {
    for (const [name, def] of Object.entries(METHODS)) {
      for (const key of def.params.required || []) {
        expect(def.params.properties[key], `${name}.${key}`).to.be.an('object');
      }
    }
  });

  it('internal methods are hidden from the public schema', function () {
    const pub = schema();
    expect(pub.methods['midi.importParsed']).to.equal(undefined);
    expect(pub.methods['project.get']).to.be.an('object');
  });

  it('schema payload is JSON-serialisable and carries a version', function () {
    const pub = schema();
    expect(pub.version).to.be.a('string');
    expect(() => JSON.stringify(pub)).to.not.throw();
  });

  it('editor methods are routed to the editor window', function () {
    expect(getMethod('editor.setView').target).to.equal('editor');
    expect(getMethod('editor.getView').target).to.equal('editor');
    expect(getMethod('project.get').target).to.equal('renderer');
    expect(getMethod('ui.screenshot').target).to.equal('main');
  });

  it('long-running methods are flagged so clients can use jobs', function () {
    for (const name of ['audio.exportTo', 'fragment.exportTo', 'audio.extractMidi', 'midi.importFile']) {
      expect(getMethod(name).long, name).to.equal(true);
    }
  });

  it('midi.importFile forwards the renderer-facing options it documents', function () {
    const props = getMethod('midi.importFile').params.properties;
    expect(props).to.have.keys(['path', 'name', 'multiTrack', 'createTracks', 'singerId', 'startTime', 'applyProjectInfo']);
  });

  it('session grants do not advertise unimplemented flags', function () {
    const props = getMethod('session.grantRoot').params.properties;
    expect(props).to.have.keys(['path']);
  });

  it('project file methods exist for every action the stdio gateway routes', function () {
    for (const name of ['project.save', 'project.saveAs', 'project.load', 'project.saveTo', 'project.loadFrom']) {
      expect(getMethod(name), name).to.be.an('object');
    }
  });

  it('inference methods declare the models precondition', function () {
    for (const name of ['playback.play', 'audio.export', 'audio.exportTo', 'fragment.exportTo']) {
      expect(getMethod(name).requires, name).to.include('models');
    }
  });
});
