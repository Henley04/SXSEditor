/**
 * 分片流式协议回归：流归属隔离 + 显式结束屏障 + 记账时机。
 *
 * 背景：IPC channel 是全局共享的，旧请求的迟到 chunk 会被新会话误收；
 * invoke 回执也不是"chunk 已全部到齐"的证明。这里钉住三条新契约：
 *   1. streamId 不匹配的 chunk 直接丢弃；
 *   2. END(lastSeq) 先于回执到达时，drain() 之后才允许 inferenceDone；
 *   3. coveredRanges 只在 source.start() 成功后登记。
 */
const { expect } = require('chai');
const sinon = require('sinon');
const fs = require('fs');
const path = require('path');

const SAMPLE_RATE = 24000;
global.requestAnimationFrame = (cb) => global.window.requestAnimationFrame(cb);
global.cancelAnimationFrame = (id) => global.window.cancelAnimationFrame(id);
global.Node = global.window.Node;
global.Element = global.window.Element;
global.HTMLElement = global.window.HTMLElement;

function ensureDom() {
  for (const id of ['piano-roll', 'piano-keys']) {
    if (!document.getElementById(id)) {
      const c = document.createElement('canvas');
      c.id = id;
      document.body.appendChild(c);
    }
  }
  if (!document.getElementById('autoShiftCheck')) {
    const el = document.createElement('input');
    el.type = 'checkbox';
    el.id = 'autoShiftCheck';
    document.body.appendChild(el);
  }
  if (!document.getElementById('btn-play-fragment')) {
    const btn = document.createElement('button');
    btn.id = 'btn-play-fragment';
    document.body.appendChild(btn);
  }
}
ensureDom();

class FakeGain {
  constructor() { this.gain = { value: 1, setValueAtTime() {}, linearRampToValueAtTime() {} }; }
  connect(n) { return n; }
  disconnect() {}
}
class FakeCtx {
  constructor() {
    this.state = 'running';
    this.sampleRate = SAMPLE_RATE;
    this.t = 0;
    this.destination = {};
    this.outputLatency = 0;
    this.baseLatency = 0;
    this.sources = [];
  }
  get currentTime() { return this.t; }
  createGain() { return new FakeGain(); }
  createStereoPanner() {
    return { pan: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect(n) { return n; }, disconnect() {} };
  }
  createBuffer(channels, length, rate) {
    const data = new Float32Array(length);
    return { length, numberOfChannels: channels, sampleRate: rate, duration: length / rate, getChannelData: () => data };
  }
  createBufferSource() {
    const ctx = this;
    return {
      buffer: null,
      onended: null,
      connect(n) { return n; },
      disconnect() {},
      start(when, offset) { this.when = when; this.offset = offset || 0; ctx.sources.push(this); },
      stop() {},
    };
  }
  async suspend() { this.state = 'suspended'; }
  async resume() { this.state = 'running'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function chunkAt(relStartSec, durSec, extra = {}) {
  return {
    sampleOffset: Math.round(relStartSec * SAMPLE_RATE),
    sampleEnd: Math.round((relStartSec + durSec) * SAMPLE_RATE),
    audio: new Float32Array(Math.round(durSec * SAMPLE_RATE)).fill(0.1),
    ...extra,
  };
}

describe('分片流式协议', () => {
  let ctx;
  let state;
  let audioPlayback;
  let sessionModule;
  let chunkCb;
  let endCb;
  let resolveSynth;
  let playPromise;

  beforeEach(() => {
    ensureDom();
    ctx = new FakeCtx();
    global.window.AudioContext = function () { return ctx; };
    global.AudioContext = global.window.AudioContext;
    chunkCb = null;
    endCb = null;
    resolveSynth = null;
    global.window.electronAPI = {
      getSettings: sinon.stub().resolves({ audioOutputMode: 'shared', audioVolume: 1, previewDiffStepChunkEnabled: true }),
      onFragmentSVSChunkAudio: sinon.stub().callsFake((cb) => { chunkCb = cb; return () => { chunkCb = null; }; }),
      onFragmentSVSStreamEnd: sinon.stub().callsFake((cb) => { endCb = cb; return () => { endCb = null; }; }),
      synthesizeFragmentSVS: sinon.stub().callsFake(() => new Promise((res) => { resolveSynth = res; })),
      onAudioEnded: sinon.stub().returns(() => {}),
      audioStop: sinon.stub().resolves({ success: true }),
      cancelSVSSynthesis: sinon.stub().resolves({ success: true }),
      getFragmentSVSSampleRate: sinon.stub().resolves(SAMPLE_RATE),
    };
    state = require('../src/fragmentEditor/state.js');
    state.setPipelineInitialized(true);
    state.setSampleRate(SAMPLE_RATE);
    state.setFragmentAudioSettings({ audioOutputMode: 'shared', audioVolume: 1, previewDiffStepChunkEnabled: true });
    const notes = [];
    for (let i = 0; i < 8; i += 1) {
      notes.push({ id: i + 1, pitch: 60, start: i * 4, duration: 4, lyric: 'la' });
    }
    state.setNotes(notes);
    state.setCurrentProject({ bpm: 120 });
    state.setCurrentFragment({ id: 'frag-proto', notes, duration: 32, singerId: null });
    state.setWavFileBuffer(null);
    state.setSingerAnnotation(null);
    state.setTrackBackend({ type: 'sxs' });
    state.setFragmentAudioData(null);
    state.setFragmentAudioDataSignature(null);
    state.setFragmentPlayStartPosition(0);
    state.setFragmentIsPlaying(false);
    state.setFragmentIsSynthesizing(false);
    state.setFragmentIsExporting(false);
    state.setFragmentIsAutoInferring(false);
    state.setFragmentAudioContext(null);
    state.setFragmentGainNode(null);
    state.setFragmentAudioSource(null);

    sessionModule = require('../src/fragmentEditor/playbackSession.js');
    sessionModule._resetPlaybackSessions();
    audioPlayback = require('../src/fragmentEditor/audioPlayback.js');
    playPromise = audioPlayback.playFragment();
  });

  afterEach(() => {
    if (state.getFragmentIsSynthesizing()) audioPlayback.cancelFragmentSynthesis();
    else audioPlayback.stopFragmentPlayback();
    if (resolveSynth) resolveSynth(new Float32Array(0));
    if (playPromise) playPromise.catch(() => {});
    sessionModule._resetPlaybackSessions();
    global.window.electronAPI = undefined;
  });

  it('旧流的迟到 chunk 不得进入新会话，也不得污染时间轴账本', async () => {
    await sleep(40);
    const sess = sessionModule.getCurrentSession();
    expect(sess.streamId, '新会话必须持有 streamId').to.be.a('string');

    chunkCb(chunkAt(0, 4, { streamId: sess.streamId, seq: 1 }));
    await sleep(40);
    expect(ctx.sources, '本流首块应正常起播').to.have.lengthOf(1);

    // 模拟：会话 A 已被停止，B 已开播，A 的迟到 chunk 到达全局 channel。
    chunkCb(chunkAt(4, 4, { streamId: 'frag-stale-old', seq: 4, isLast: true }));
    await sleep(40);
    expect(ctx.sources, '旧流 chunk 不得排程出声').to.have.lengthOf(1);
    expect(sess.timeline.deliveredEndSec, '旧流 chunk 不得推进前沿').to.be.closeTo(4, 1e-3);

    endCb({ streamId: sess.streamId, lastSeq: 1 });
    resolveSynth(new Float32Array(4 * SAMPLE_RATE));
    await playPromise;
    expect(sess.deliveryDone).to.equal(true);
    expect(sess.deliveryComplete).to.equal(true);
  });

  it('END 之前入队的 chunk 都会在 inferenceDone 之前处理完', async () => {
    await sleep(40);
    const sess = sessionModule.getCurrentSession();

    chunkCb(chunkAt(0, 2, { streamId: sess.streamId, seq: 1 }));
    chunkCb(chunkAt(2, 2, { streamId: sess.streamId, seq: 2 }));
    // END 在 invoke 回执之前到达（主进程同向 IPC 有序）
    endCb({ streamId: sess.streamId, lastSeq: 2 });
    expect(sess.endSeen, 'END 到达即同步置位').to.equal(true);
    expect(sess.deliveryDone, 'END 尚未处理完，不能标记交付完成').to.equal(false);

    resolveSynth(new Float32Array(4 * SAMPLE_RATE));
    await playPromise;
    expect(sess.deliveryDone).to.equal(true);
    expect(sess.seenSeqs.has(1) && sess.seenSeqs.has(2)).to.equal(true);
    expect(ctx.sources, 'END 之前的两块都必须被排程').to.have.lengthOf(2);
    expect(sess.scheduler.inferenceDone).to.equal(true);
  });

  it('首块乱序：先到 seq=5 再到 seq=1 时按 seq 排序后的最早块锚定', async () => {
    await sleep(40);
    const sess = sessionModule.getCurrentSession();
    // 先到的是 5~7s 块。若在串行 handler 内部 sleep，seq=1 会排在它后面，
    // 导致按 5s 锚定、开头静音。
    chunkCb(chunkAt(5, 2, { streamId: sess.streamId, seq: 5 }));
    await sleep(10);
    chunkCb(chunkAt(0, 2, { streamId: sess.streamId, seq: 1 }));
    await sleep(80);
    expect(ctx.sources, '两块都应被排程').to.have.lengthOf(2);
    expect(ctx.sources[0].when, '首块必须按 0s 内容锚定，不是 5s').to.be.lessThan(1);
    expect(sess.timeline.anchorCtxTime).to.be.closeTo(ctx.sources[0].when, 1e-3);

    endCb({ streamId: sess.streamId, lastSeq: 5 });
    resolveSynth(new Float32Array(7 * SAMPLE_RATE));
    await playPromise;
  });

  it('所有 source.start 失败时不得宣告 streamStarted，整段兜底仍可触发', async () => {
    await sleep(40);
    const sess = sessionModule.getCurrentSession();
    const origCreate = ctx.createBufferSource.bind(ctx);
    let failNext = true;
    ctx.createBufferSource = () => {
      const src = origCreate();
      if (failNext) {
        failNext = false;
        src.start = () => { throw new Error('forced start failure'); };
      }
      return src;
    };
    chunkCb(chunkAt(0, 2, { streamId: sess.streamId, seq: 1 }));
    await sleep(60);
    expect(sess.streamStarted, '没有 source 成功启动就不能算开播').to.equal(false);
    expect(state.getFragmentIsPlaying()).to.equal(false);

    resolveSynth(new Float32Array(2 * SAMPLE_RATE));
    await playPromise;
    expect(sess.streamDisabled, '应走整段兜底而不是静音').to.equal(true);
  });

  it('重复 seq 只排程一次', async () => {
    await sleep(40);
    const sess = sessionModule.getCurrentSession();
    const chunk = chunkAt(0, 2, { streamId: sess.streamId, seq: 1 });
    chunkCb(chunk);
    chunkCb(chunk);
    await sleep(60);
    expect(ctx.sources, '重复块不得再排一个 source').to.have.lengthOf(1);
    resolveSynth(new Float32Array(2 * SAMPLE_RATE));
    await playPromise;
  });

  it('合成中 seek 保留合成 session 并记录最终位置，结束时正常清 synthesizing', async () => {
    await sleep(40);
    const sess = sessionModule.getCurrentSession();
    chunkCb(chunkAt(0, 2, { streamId: sess.streamId, seq: 1 }));
    await sleep(60);
    expect(state.getFragmentIsPlaying(), '流式 chunk 应已起播').to.equal(true);

    await audioPlayback.seekFragmentPlayback(5);
    expect(sess.disposed, 'seek 不能 dispose 合成 session').to.equal(false);
    expect(sessionModule.getCurrentSession()).to.equal(sess);
    expect(sess.pendingSeek).to.equal(5);
    expect(sess.streamDisabled).to.equal(true);
    expect(state.getFragmentIsPlaying()).to.equal(false);
    expect(state.getFragmentIsSynthesizing(), '推理仍在跑，不能提前清').to.equal(true);

    resolveSynth(new Float32Array(6 * SAMPLE_RATE));
    await playPromise;
    expect(state.getFragmentIsSynthesizing(), '合成结束后必须清掉，不能卡在 100%').to.equal(false);
    expect(sess.pendingSeek).to.equal(null);
    expect(sess.startPositionSec).to.equal(5);
  });

  it('seq 缺口会被显式记录，而不是被当成完整交付', async () => {
    await sleep(40);
    const sess = sessionModule.getCurrentSession();
    chunkCb(chunkAt(0, 2, { streamId: sess.streamId, seq: 2 }));
    endCb({ streamId: sess.streamId, lastSeq: 2 });
    resolveSynth(new Float32Array(2 * SAMPLE_RATE));
    await playPromise;
    expect(sess.deliveryComplete, '缺 seq=1 不能报完整交付').to.equal(false);
  });
});

describe('分片流式协议 — 静态契约', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  it('IPC 通道 / preload / 主进程三处都接上了 END 与 streamId', () => {
    const channels = read('src/shared/ipcChannels.js');
    const preload = read('src/preload.js');
    const svsIpc = read('src/main/svsIpc.js');

    expect(channels).to.include('FRAGMENT_SVS_STREAM_END');
    expect(preload).to.include('onFragmentSVSStreamEnd');
    expect(preload).to.match(/cancelSVSSynthesis:\s*\(options\)/);
    expect(svsIpc).to.include('IPC_CHANNELS.FRAGMENT_SVS_STREAM_END');
    expect(svsIpc).to.match(/streamId:\s*fragmentStreamId/);
    expect(svsIpc).to.match(/chunkSeq = nextSeq/);   // send 成功后才提交序号
    expect(svsIpc).to.include('transportFailed');
    expect(svsIpc).to.include('ignoredStaleStream');
  });

  it('mousedown seek 分支保留合成 session，不再调用会话级 stop', () => {
    const events = read('src/fragmentEditor/eventHandlers.js');
    const mousedownBranch = events.slice(
      events.indexOf("setDragMode('playhead');"),
      events.indexOf("setDragMode('playhead');") + 700,
    );
    expect(mousedownBranch).to.include('cur.requestSeekDuringSynthesis(newStartTime)');
    expect(mousedownBranch).to.include('getFragmentIsSynthesizing()');
    expect(mousedownBranch).to.include('setFragmentPlayheadDragging(true)');
    // 合成分支内不能再出现 stopFragmentPlayback()（else 非合成路径允许）。
    const synthStart = mousedownBranch.indexOf('if (getFragmentIsSynthesizing()');
    const synthEnd = mousedownBranch.indexOf('} else {', synthStart);
    const synthBranch = mousedownBranch.slice(synthStart, synthEnd)
      .replace(/\/\/.*$/gm, '');
    expect(synthBranch).not.to.include('stopFragmentPlayback()');
  });

  it('合成 token：旧任务迟到 finish 不得清新任务状态', () => {
    const s = require('../src/fragmentEditor/state.js');
    s.beginFragmentSynthesis('task-A');
    s.beginFragmentSynthesis('task-B');
    expect(s.finishFragmentSynthesis('task-A')).to.equal(false);
    expect(s.getFragmentIsSynthesizing()).to.equal(true);
    expect(s.getFragmentSynthesisId()).to.equal('task-B');
    expect(s.finishFragmentSynthesis('task-B')).to.equal(true);
    expect(s.getFragmentIsSynthesizing()).to.equal(false);
    expect(s.getFragmentSynthesisId()).to.equal(null);
  });

  it('进度由状态派生，且按 synthesisId 过滤旧任务', () => {
    const ipc = read('src/fragmentEditor/ipcHandlers.js');
    const ui = read('src/fragmentEditor/uiControls.js');
    expect(ipc).to.include('data.synthesisId !== getFragmentSynthesisId()');
    expect(ipc).to.include('setFragmentSynthesisProgress(progress)');
    expect(ipc).not.to.match(/setLabel\(btnPlayFragment, t\('fragment\.cancelSynthesisProgress'/);
    expect(ui).to.include("t('fragment.cancelSynthesisProgress', { progress })");
  });

  it('StreamTimeline: reserve:false 未 commit 的区间不会占位', () => {
    const { StreamTimeline } = require('../src/fragmentEditor/playbackTimeline.js');
    const t = new StreamTimeline({ startPositionSec: 0, firstNoteStartSec: 0 });
    const data = new Float32Array(2 * SAMPLE_RATE).fill(0.1);
    const plan = t.plan({
      sampleOffset: 0,
      sampleEnd: 2 * SAMPLE_RATE,
      audio: data,
    }, SAMPLE_RATE, 0, { reserve: false });
    expect(plan.action).to.equal('schedule');
    expect(t.coveredRanges, '未 commit 前不得登记占位').to.have.lengthOf(0);
    expect(t.deliveredEndSec).to.equal(0);

    t.commit(plan, [plan.segments[0]]);
    expect(t.coveredRanges, 'commit 后才登记').to.have.lengthOf(1);
    expect(t.deliveredEndSec).to.be.closeTo(2, 1e-3);
  });
});
