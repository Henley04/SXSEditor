/**
 * 音频预处理窗口播放头 —— 必须按"耳朵听到的位置"走。
 *
 * 回归背景（用户反馈"进度条和声音不同步"）：这个窗口是唯一一条没走
 * shared/audioOutputClock 的播放路径。播放头直接用 ctx.currentTime 画，
 * 而 ctx.currentTime 是渲染线程的位置——声音还要过一遍输出设备缓冲
 * （Windows 上实测 20–120 ms）才到喇叭，所以指示器稳定跑在声音前面。
 *
 * 主窗口与分片编辑器在 2.0.3 就改成了 getAudibleElapsedSec，这里漏了；
 * 表现是"同一首歌在主窗口对得上、进预处理窗口就超前一截"。
 *
 * 另一个相关点：暂停位置。若用渲染域累加 playStartOffset，每次暂停/续播
 * 都会把设备延迟重复计一次，拖几次之后位置会越走越靠前。
 */

const { expect } = require('chai');

// jsdom 没有 rAF，而 startPlaybackLoop 用它驱动逐帧重绘。
// 用 setTimeout 顶替（可被 cancelAnimationFrame 取消），免得每次 start 都
// 往控制台吐一条 ReferenceError，掩盖真正的断言失败。
if (!global.requestAnimationFrame) {
  global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
  global.cancelAnimationFrame = (id) => clearTimeout(id);
}

const { state, dom } = require('../src/audioPreprocess/state.js');
const { startPlayback, pausePlayback, stopPlayback } = require('../src/audioPreprocess/playback.js');
const { initPianoRoll } = require('../src/audioPreprocess/pianoRoll.js');
const { _resetOutputLatencyCache } = require('../src/shared/audioOutputClock.js');

const SAMPLE_RATE = 44100;
const LATENCY = 0.02;

function makeFakeContext() {
  const starts = [];
  const ctx = {
    state: 'running',
    currentTime: 10,
    outputLatency: LATENCY,
    destination: {},
    starts,
    resume: async () => {},
    createBufferSource() {
      const src = {
        buffer: null,
        onended: null,
        connect() {},
        start(when, offset) {
          starts.push({ when, offset: offset === undefined ? 0 : offset });
        },
        stop() {},
      };
      return src;
    },
  };
  return ctx;
}

function makeBuffer(duration) {
  const n = 1000;
  const data = new Float32Array(n);
  return {
    duration,
    sampleRate: SAMPLE_RATE,
    length: n,
    numberOfChannels: 1,
    getChannelData: () => data,
  };
}

describe('preprocess playhead — audible clock', () => {
  let ctx;

  beforeEach(() => {
    // 波形画布需要一个有 parentElement 的真实节点（drawWaveformWithPlayhead 读 container 尺寸）
    document.body.innerHTML = `
      <div id="waveform-container"><canvas id="waveform-canvas"></canvas></div>
    `;
    dom.waveformCanvas = document.getElementById('waveform-canvas');

    ctx = makeFakeContext();
    _resetOutputLatencyCache(ctx);

    state.audioContext = ctx;
    state.wavAudioBuffer = makeBuffer(10);
    state.wavDuration = 10;
    state.isPlaying = false;
    state.playStartOffset = 0;
    state.playStartTime = 0;
    state.playbackRaf = null;
    state.pianoRoll = null;
  });

  afterEach(() => {
    stopPlayback();
  });

  it('起播基准与 source.start 的时刻一致（不是 start 之后才取钟）', async () => {
    await startPlayback();
    expect(ctx.starts).to.have.length(1);
    // start(0) 只保证"下一个渲染量子"，基准必须等于真正传入的 when
    expect(state.playStartTime).to.equal(ctx.starts[0].when);
    expect(state.playStartTime).to.equal(10);
  });

  it('暂停位置扣掉设备输出延迟（可听域），不是渲染域', async () => {
    await startPlayback();
    ctx.currentTime = 10.1; // 渲染域走了 100 ms
    pausePlayback();
    // 可听位置 = 100 ms - 20 ms 设备延迟
    expect(state.playStartOffset).to.be.closeTo(0.08, 1e-3);
  });

  it('无 outputLatency 时不补偿（不能凭空滞后）', async () => {
    ctx.outputLatency = 0;
    ctx.baseLatency = 0;
    _resetOutputLatencyCache(ctx);
    await startPlayback();
    ctx.currentTime = 10.1;
    pausePlayback();
    expect(state.playStartOffset).to.be.closeTo(0.1, 1e-3);
  });

  it('连续暂停/续播不累积延迟（每次只按听到的位置前进）', async () => {
    await startPlayback();
    // 第一次：听到 0.08s
    ctx.currentTime = 10.1;
    pausePlayback();
    expect(state.playStartOffset).to.be.closeTo(0.08, 1e-3);

    // 续播：基准重新取当前渲染时刻
    await startPlayback();
    expect(state.playStartTime).to.equal(10.1);
    // 再走 100 ms → 只在 0.08 基础上加 0.08，而不是加 0.1
    ctx.currentTime = 10.2;
    pausePlayback();
    expect(state.playStartOffset).to.be.closeTo(0.16, 1e-3);
  });

  it('卷帘播放头与波形用同一速度（同样扣延迟）', async () => {
    document.body.insertAdjacentHTML('beforeend', '<canvas id="midi-canvas"></canvas>');
    dom.midiCanvas = document.getElementById('midi-canvas');
    await initPianoRoll();
    const pr = state.pianoRoll;
    expect(pr).to.exist;

    pr.isPlaying = true;
    pr.playStartTime = 10;   // 由 playback.js 赋的渲染域基准
    pr.playStartOffset = 0;
    ctx.currentTime = 10.5;  // 渲染域走了 500 ms

    // 可听位置 = 500 - 20 = 480 ms
    expect(pr.getCurrentTime()).to.be.closeTo(0.48, 1e-3);
    expect(pr._elapsedSinceStart()).to.be.closeTo(0.48, 1e-3);

    pr.destroy();
    state.pianoRoll = null;
  });
});
