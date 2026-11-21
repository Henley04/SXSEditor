/**
 * 回归：独占输出（decibri）的 start 曾把 worker 钉死整首歌。
 *
 * decibri 的 Speaker 是 Writable：
 *   · `write()` 在 native 播放队列满时**同步阻塞**；
 *   · `_final`（由 `end()` 触发）会同步 drain 到**整段音频播完**才回调。
 *
 * 旧实现 `write(pcm) + end()` 于是把 worker 的事件循环占满整段时长：
 *   · start 的回执发不出去（父进程 8s 判超时 → kill worker），渲染层永远
 *     收不到结果 → 按"继续"后播放头与状态不动，但设备其实已经在出声；
 *   · 播放中 stop 根本没机会被处理（暂停/停止只能靠 3s 超时杀进程）。
 *
 * 本文件用假 Speaker 钉住修复后的契约：
 *   1. 只用 writeAsync（不碰同步 write / end）；
 *   2. start 在写入排空后立刻回执，不等整段播完；
 *   3. 写入/播放期间 stop 能被执行，且被取代的 start 不再报告成功；
 *   4. 播放结束（drainAsync resolve）只发一次 ended，被 stop 取代后不发。
 */
const { expect } = require('chai');

const decibriPath = require.resolve('decibri');

class FakeSpeaker {
  constructor(options) {
    this.options = options;
    this.listeners = new Map();
    this.writeSyncCalls = 0;
    this.writeAsyncCalls = 0;
    this.endCalls = 0;
    this.stopCalls = 0;
    this.drainCalls = 0;
    this._resolveWrite = null;
    this._resolveDrain = null;
    FakeSpeaker.instances.push(this);
  }

  on(event, cb) {
    this.listeners.set(event, cb);
    return this;
  }

  removeAllListeners() {
    this.listeners.clear();
  }

  write() {
    this.writeSyncCalls += 1;
  }

  end() {
    this.endCalls += 1;
  }

  writeAsync() {
    this.writeAsyncCalls += 1;
    if (!FakeSpeaker.manualWrite) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this._writeResolvers = this._writeResolvers || [];
      this._writeResolvers.push(resolve);
      this._resolveWrite = resolve;
      this._rejectWrite = reject;
    });
  }

  /** 放开"下一片"写入（按调用顺序）。 */
  resolveNextWrite() {
    const next = (this._writeResolvers || []).shift();
    if (next) next();
  }

  get pendingWrites() {
    return (this._writeResolvers || []).length;
  }

  drainAsync() {
    this.drainCalls += 1;
    return new Promise((resolve) => { this._resolveDrain = resolve; });
  }

  stop() {
    this.stopCalls += 1;
    // decibri 实测：stop() 会让挂起的 drainAsync 立刻返回（丢弃剩余音频）
    if (this._resolveDrain) this._resolveDrain();
  }

  emit(event, payload) {
    const cb = this.listeners.get(event);
    if (cb) cb(payload);
  }

  static devices() {
    return [];
  }
}
FakeSpeaker.instances = [];
FakeSpeaker.manualWrite = false;

function flush(times = 3) {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => new Promise((r) => setImmediate(r)));
  return p;
}

describe('audioWorker：start 不得阻塞事件循环', () => {
  let sent;
  let workerMod;

  before(() => {
    // 用假 decibri 替换真模块，避免测试真的去开声卡
    const original = require.cache[decibriPath];
    require.cache[decibriPath] = {
      id: decibriPath,
      filename: decibriPath,
      loaded: true,
      exports: { Speaker: FakeSpeaker },
      children: [],
      paths: [],
    };
    sent = [];
    // mocha 进程不是 Electron worker 子进程：process.send / connected 都不存在，
    // 而 _safeSend 只在两者都有时才发消息 —— 手工补上以便观察回执。
    process.send = (msg) => { sent.push(msg); };
    Object.defineProperty(process, 'connected', { configurable: true, value: true });
    // 加载即注册 process.on('message')
    workerMod = require('../src/audio/audioWorker.js');
    require.cache[decibriPath] = original;
  });

  after(() => {
    // worker 的空闲退出定时器会在 30s 后 process.exit(0)：同一进程里跑测试
    // 必须取消它，否则它会替 mocha 结束进程（测试套件跑到一半就"成功退出"）。
    if (workerMod && typeof workerMod._cancelIdleShutdown === 'function') {
      workerMod._cancelIdleShutdown();
    }
    delete process.send;
    delete process.connected;
  });

  beforeEach(() => {
    sent.length = 0;
    FakeSpeaker.instances.length = 0;
  });

  function lastAck(id) {
    return sent.filter((m) => m && m.id === id).pop();
  }

  it('start 用 writeAsync 回执，且不等整段播完（不调用 end）', async () => {
    process.emit('message', {
      id: 101,
      type: 'start',
      audioData: new Float32Array(24000),
      options: { sampleRate: 24000, sourceSampleRate: 24000 },
    });
    await flush();

    const speaker = FakeSpeaker.instances[0];
    expect(speaker, '应当创建一个 Speaker').to.be.ok;
    expect(speaker.writeSyncCalls, '不能再用会阻塞的同步 write').to.equal(0);
    expect(speaker.endCalls, 'end() 会 drain 到播完才返回，必须避免').to.equal(0);
    expect(speaker.writeAsyncCalls, 'PCM 必须走 writeAsync').to.be.at.least(1);

    const ack = lastAck(101);
    expect(ack, 'start 必须在首片写入落地后立刻回执').to.be.ok;
    expect(ack.result.success).to.be.true;
    expect(speaker.drainCalls, '回执之后才挂 drain 监视器，不等它完成').to.equal(1);

    // 播放结束：drainAsync resolve → 发一次 ended
    speaker._resolveDrain();
    await flush();
    expect(sent.filter((m) => m && m.type === 'ended').length).to.equal(1);
    expect(speaker.stopCalls, '播完后要 stop() 释放设备句柄').to.be.greaterThan(0);
  });

  it('长音频分片写入：首片落地即回执，剩余 PCM 在后台补写（回执与时长无关）', async () => {
    // 回归：整段一次 writeAsync 时，decibri 的有限队列要几乎播完才 resolve →
    // 父进程 8s 判 `Command timeout: start` 并杀掉 worker（长分片必现）。
    FakeSpeaker.manualWrite = true;
    try {
      process.emit('message', {
        id: 301,
        type: 'start',
        // 4s @24k：按 0.5s 切片 → 8 片
        audioData: new Float32Array(24000 * 4),
        options: { sampleRate: 24000, sourceSampleRate: 24000 },
      });
      await flush(1);
      const speaker = FakeSpeaker.instances[0];
      expect(speaker.writeAsyncCalls, '只等第一片，不应一次性写整段').to.equal(1);
      expect(lastAck(301), '首片未落地前不得回执').to.be.undefined;

      speaker.resolveNextWrite();
      await flush();
      expect(lastAck(301), '首片落地后立即回执').to.be.ok;
      expect(lastAck(301).result.success).to.be.true;
      expect(speaker.writeAsyncCalls, '剩余 PCM 仍在后台按序补写').to.be.greaterThan(1);

      // 把剩余片全部放开：写完才挂 drain，避免空队列立刻"播完"
      let guard = 0;
      while (speaker.pendingWrites > 0 && guard++ < 50) {
        speaker.resolveNextWrite();
        await flush(1);
      }
      expect(speaker.drainCalls, '全部写完才启动 drain 监视器').to.equal(1);
    } finally {
      FakeSpeaker.manualWrite = false;
    }
  });

  it('写入期间到达的 stop 会被立刻处理，被取代的 start 不报告成功', async () => {
    FakeSpeaker.manualWrite = true;
    try {
      process.emit('message', {
        id: 201,
        type: 'start',
        audioData: new Float32Array(24000),
        options: { sampleRate: 24000, sourceSampleRate: 24000 },
      });
      await flush(1);
      const speaker = FakeSpeaker.instances[0];
      expect(speaker.writeAsyncCalls).to.equal(1);
      expect(lastAck(201), '写入未完成时不该有回执').to.be.undefined;

      // 播放中（writeAsync 未决）用户按停止
      process.emit('message', { id: 202, type: 'stop' });
      await flush(1);
      expect(lastAck(202), 'stop 必须能被执行（事件循环不能被占住）').to.be.ok;
      expect(lastAck(202).result.success).to.be.true;

      // 迟到的写入完成：不能报告成功，否则渲染层会把播放头跑起来
      speaker._resolveWrite();
      await flush();
      const ack = lastAck(201);
      expect(ack).to.be.ok;
      expect(ack.result.success).to.be.false;

      // 被停止的会话不得再发 ended（否则新会话的播放头会被掐掉）
      sent.length = 0;
      if (speaker._resolveDrain) speaker._resolveDrain();
      await flush();
      expect(sent.filter((m) => m && m.type === 'ended')).to.be.empty;
    } finally {
      FakeSpeaker.manualWrite = false;
    }
  });

  it('自然播完后 stop 不再发第二次 ended', async () => {
    process.emit('message', {
      id: 301,
      type: 'start',
      audioData: new Float32Array(24000),
      options: { sampleRate: 24000, sourceSampleRate: 24000 },
    });
    await flush();
    const speaker = FakeSpeaker.instances[0];
    speaker._resolveDrain();
    await flush();
    expect(sent.filter((m) => m && m.type === 'ended').length).to.equal(1);

    process.emit('message', { id: 302, type: 'stop' });
    await flush();
    expect(sent.filter((m) => m && m.type === 'ended').length, 'ended 必须幂等').to.equal(1);
  });
});
