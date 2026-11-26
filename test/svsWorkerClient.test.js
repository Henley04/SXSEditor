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

  /**
   * #8：取消不能误伤 init / loadModel / status 等非合成请求；
   * 也不能只对 activeSynthId 发 cancel（它是最后提交的，不一定是正在跑的）。
   */
  describe('精确取消（#8）', () => {
    function entry(command, log, name) {
      return {
        resolve() {},
        reject(err) { log.push({ name, code: err.code }); },
        command,
      };
    }

    it('只拒绝合成类 pending，init / loadModel 保持等待', async () => {
      const client = new SvsWorkerClient({ modelDir: '/tmp/models', pipelineOptions: {} });
      const posted = [];
      client.worker = { postMessage: (msg) => posted.push(msg) };
      const log = [];
      client.pending.set(1, entry('init', log, 'init'));
      client.pending.set(2, entry('synthesize', log, 'synth'));
      client.pending.set(3, entry('synthesizeMultiStreaming', log, 'multi'));
      client.pending.set(4, entry('loadModel', log, 'load'));
      client.runningSynthId = 2;

      await client.cancelActiveSynthesis();

      expect(log.map((x) => x.name).sort()).to.deep.equal(['multi', 'synth']);
      expect(log.every((x) => x.code === 'SYNTHESIS_CANCELLED')).to.equal(true);
      expect(client.pending.has(1), 'init 不能被拒绝').to.equal(true);
      expect(client.pending.has(4), 'loadModel 不能被拒绝').to.equal(true);
      expect(client.pending.has(2)).to.equal(false);
      expect(client.pending.has(3)).to.equal(false);
      expect(posted.map((m) => m.args.requestId).sort(), '对每个被取消的合成请求发 cancel')
        .to.deep.equal([2, 3]);
    });

    it('running id 缺失时用 activeSynthId；都为 null 时仍发一次无 id cancel 兜底', async () => {
      const client = new SvsWorkerClient({ modelDir: '/tmp/models', pipelineOptions: {} });
      const posted = [];
      client.worker = { postMessage: (msg) => posted.push(msg) };
      const log = [];
      client.pending.set(7, entry('synthesize', log, 'synth'));
      client.activeSynthId = 7;

      await client.cancelActiveSynthesis();
      expect(posted.map((m) => m.args.requestId)).to.deep.equal([7]);

      client.worker = { postMessage: (msg) => posted.push(msg) };
      await client.cancelActiveSynthesis();
      expect(posted[posted.length - 1].args.requestId).to.equal(undefined);
    });
  });
});
