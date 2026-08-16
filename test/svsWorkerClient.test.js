const { expect } = require('chai');
const { SvsWorkerClient, findWorkerScript } = require('../src/main/svsWorkerClient');

describe('SvsWorkerClient', () => {
  it('finds the development worker script', () => {
    expect(findWorkerScript()).to.be.a('string').and.match(/svsWorker\.js$/);
  });

  it('exposes the pipeline compatibility surface', () => {
    const client = new SvsWorkerClient({ modelDir: '/tmp/models', pipelineOptions: {} });
    expect(client.initialized).to.equal(false);
    expect(client.sessionEPs).to.deep.equal({});
    expect(client.isModelLoaded('diffStep')).to.equal(false);
    expect(client.getHardwareInfo()).to.equal(null);
    expect(client).to.respondTo('synthesize');
    expect(client).to.respondTo('swapVocoder');
    expect(client).to.respondTo('ensureAllModelsLoaded');
  });

  it('updates local state snapshots without exposing worker internals', () => {
    const client = new SvsWorkerClient({ modelDir: '/tmp/models', pipelineOptions: {} });
    client._applyState({
      initialized: true,
      sessionEPs: { diffStep: 'dml' },
      loadedModels: ['diffStep'],
      hardwareInfo: { name: 'GPU' },
    });
    expect(client.initialized).to.equal(true);
    expect(client.isModelLoaded('diffStep')).to.equal(true);
    expect(client.sessionEPs.diffStep).to.equal('dml');
    expect(client.getHardwareInfo()).to.deep.equal({ name: 'GPU' });
  });
});
