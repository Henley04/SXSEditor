const { expect } = require('chai');
const sinon = require('sinon');
const child_process = require('child_process');

const { AudioOutputManager } = require('../src/audio/audioOutputManager');

/**
 * 构造一个 fake worker 子进程，用于模拟 child_process.fork 的返回值。
 * 通过 _emit(event, msg) 从子进程方向投递消息，触发主进程注册的监听器。
 */
function createFakeWorker() {
  const handlers = {};
  return {
    send: sinon.stub(),
    on: sinon.stub().callsFake((event, cb) => {
      handlers[event] = cb;
    }),
    kill: sinon.stub(),
    _emit: (event, msg) => {
      if (handlers[event]) handlers[event](msg);
    },
  };
}

describe('AudioOutputManager', () => {
  let forkStub;
  let fakeWorker;
  let mgr;

  beforeEach(() => {
    fakeWorker = createFakeWorker();
    forkStub = sinon.stub(child_process, 'fork').returns(fakeWorker);
    mgr = new AudioOutputManager();
  });

  // 关键：每个测试结束后销毁 manager，清理 _startPositionTracking 产生的 setInterval，
  // 防止 mocha 事件循环保持活跃导致进程挂起。
  // 同时手动 restore forkStub —— test/setup.js 使用独立 sandbox，不会清理本文件的 stub。
  afterEach(() => {
    if (mgr) {
      mgr.destroy();
      mgr = null;
    }
    if (forkStub) {
      forkStub.restore();
      forkStub = null;
    }
  });

  describe('isAvailable', () => {
    it('resolves true when worker reports ready with isAvailable=true', async () => {
      const promise = mgr.isAvailable();
      fakeWorker._emit('message', { type: 'ready', isAvailable: true });
      const result = await promise;
      expect(result).to.be.true;
      expect(forkStub.calledOnce).to.be.true;
    });

    it('resolves false when worker reports isAvailable=false', async () => {
      const promise = mgr.isAvailable();
      fakeWorker._emit('message', { type: 'ready', isAvailable: false });
      const result = await promise;
      expect(result).to.be.false;
    });

    it('resolves false when worker errors before ready', async () => {
      const promise = mgr.isAvailable();
      fakeWorker._emit('error', new Error('fork failed'));
      const result = await promise;
      expect(result).to.be.false;
    });
  });

  describe('getDevices', () => {
    it('forwards getDevices command and returns devices', async () => {
      const promise = mgr.getDevices();
      fakeWorker._emit('message', { id: 1, type: 'getDevices', result: { devices: [{ id: 0, name: 'A' }], isAvailable: true } });
      const devices = await promise;
      expect(devices).to.deep.equal([{ id: 0, name: 'A' }]);
      expect(fakeWorker.send.calledWithMatch({ type: 'getDevices' })).to.be.true;
    });

    it('returns empty array when worker reports an error', async () => {
      const promise = mgr.getDevices();
      fakeWorker._emit('message', { id: 1, type: 'getDevices', result: { error: 'failed' } });
      const devices = await promise;
      expect(devices).to.deep.equal([]);
    });
  });

  describe('start / stop / getPosition', () => {
    it('start sends command and sets isPlaying on success', async () => {
      const audio = new Float32Array(100);
      const promise = mgr.start(audio, { sampleRate: 24000 });
      // start() 内部先 await this.stop()，需让微任务 settles 后 _sendCommand 才被调用
      await Promise.resolve();
      fakeWorker._emit('message', { type: 'ready', isAvailable: true });
      fakeWorker._emit('message', { id: 1, type: 'start', result: { success: true, sampleRate: 24000 } });
      const result = await promise;
      expect(result.success).to.be.true;
      expect(mgr.isPlaying()).to.be.true;
    });

    it('start propagates failure without marking as playing', async () => {
      const audio = new Float32Array(100);
      const promise = mgr.start(audio, {});
      await Promise.resolve();
      fakeWorker._emit('message', { type: 'ready', isAvailable: true });
      fakeWorker._emit('message', { id: 1, type: 'start', result: { success: false, error: 'boom' } });
      try {
        await promise;
        expect.fail('should have rejected');
      } catch (err) {
        expect(err.message).to.equal('boom');
      }
      expect(mgr.isPlaying()).to.be.false;
    });

    it('stop sends stop command when playing', async () => {
      const audio = new Float32Array(100);
      const startPromise = mgr.start(audio, {});
      await Promise.resolve();
      fakeWorker._emit('message', { type: 'ready', isAvailable: true });
      fakeWorker._emit('message', { id: 1, type: 'start', result: { success: true } });
      await startPromise;
      expect(mgr.isPlaying()).to.be.true;

      const stopPromise = mgr.stop();
      fakeWorker._emit('message', { id: 2, type: 'stop', result: { success: true } });
      await stopPromise;
      expect(mgr.isPlaying()).to.be.false;
    });

    it('getPosition returns 0 when never played', () => {
      expect(mgr.getPosition()).to.equal(0);
    });

    it('getDuration reflects audio length and sample rate', async () => {
      const audio = new Float32Array(24000); // 1s @ 24kHz
      const promise = mgr.start(audio, { sampleRate: 24000 });
      await Promise.resolve();
      fakeWorker._emit('message', { type: 'ready', isAvailable: true });
      fakeWorker._emit('message', { id: 1, type: 'start', result: { success: true } });
      await promise;
      expect(mgr.getDuration()).to.be.closeTo(1.0, 1e-6);
    });
  });

  describe('ended event', () => {
    it('triggers onEnded callback when worker emits ended', async () => {
      const endedStub = sinon.stub();
      mgr.onEnded(endedStub);
      const audio = new Float32Array(100);
      const startPromise = mgr.start(audio, {});
      await Promise.resolve();
      fakeWorker._emit('message', { type: 'ready', isAvailable: true });
      fakeWorker._emit('message', { id: 1, type: 'start', result: { success: true } });
      await startPromise;

      fakeWorker._emit('message', { type: 'ended' });
      expect(endedStub.calledOnce).to.be.true;
      expect(mgr.isPlaying()).to.be.false;
    });
  });

  describe('destroy', () => {
    it('kills worker and rejects pending requests', async () => {
      // 直接使用 _sendCommand，避免 getDevices() 内部 try/catch 吞掉 rejection
      const promise = mgr._sendCommand('getDevices');
      mgr.destroy();
      mgr = null; // 已销毁，阻止 afterEach 重复销毁
      expect(fakeWorker.kill.calledOnce).to.be.true;
      try {
        await promise;
        expect.fail('should have rejected');
      } catch (err) {
        expect(err.message).to.match(/destroyed/i);
      }
    });

    it('is a no-op when no worker exists', () => {
      // mgr 在 beforeEach 中创建但未触发 _ensureWorker，_worker 为 null
      expect(() => mgr.destroy()).to.not.throw();
      mgr = null; // 已销毁，阻止 afterEach 重复销毁
    });
  });

  describe('command timeout', () => {
    it('rejects start() after the 15s timeout', async () => {
      // 使用 start() 而非 getDevices()，因为 start() 不吞掉 _sendCommand 的 rejection
      const clock = sinon.useFakeTimers();
      try {
        const audio = new Float32Array(100);
        const promise = mgr.start(audio, { sampleRate: 24000 });
        // 让微任务 settles，使 start() 执行到 _sendCommand 并设置 15s 超时
        await clock.tickAsync(0);
        // 推进 fake 时钟超过 15s 超时阈值
        await clock.tickAsync(16000);
        try {
          await promise;
          expect.fail('should have rejected');
        } catch (err) {
          expect(err.message).to.match(/超时|timeout/i);
        }
      } finally {
        clock.restore();
      }
    });
  });

  describe('static helpers', () => {
    it('getHostAPIs returns empty array', () => {
      expect(AudioOutputManager.getHostAPIs()).to.deep.equal([]);
    });
  });
});
