'use strict';
/**
 * P2-2 回归：流式播放期间改 M/S 不得触发独占 PCM 重建。
 *
 * 流式 chunk 走 WebAudio（每轨 GainNode 实时生效），不可能同时用独占 PCM。
 * 旧逻辑只判断 isPlaying && useExclusiveMode：若这两者残留为 true，M/S 变化会
 * 启动独占输出，与仍在响的 streamingSources 叠加，并用错乱的时钟算 elapsed。
 *
 * 守卫：重建入口在 _streamingActive || streamingSources.length > 0 时直接返回。
 */
const { expect } = require('chai');
const sinon = require('sinon');

if (!global.requestAnimationFrame) {
  global.requestAnimationFrame = (cb) => global.window.requestAnimationFrame(cb);
  global.cancelAnimationFrame = (id) => global.window.cancelAnimationFrame(id);
}

const { state, trackManager } = require('../src/renderer/state.js');
const {
  applyAudibility,
  clearTrackGains,
} = require('../src/renderer/trackGainMixer.js');

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('流式播放期间 M/S 不触发独占重建 (P2-2)', () => {
  let audioPlayCalls;
  let rafStub;

  beforeEach(() => {
    audioPlayCalls = [];
    global.window.electronAPI = {
      audioStop: async () => ({ success: true }),
      audioPlay: async (data, options) => {
        audioPlayCalls.push({ data, options });
        return { success: true };
      },
      onAudioEnded: () => () => {},
    };
    rafStub = sinon.stub(global, 'requestAnimationFrame').returns(1);
    trackManager.clearAll();
    clearTrackGains();
    state.isPlaying = true;
    state.useExclusiveMode = true; // 故意残留 true：模拟上一次会话的设置
    state.playbackStartTime = Date.now() / 1000 - 1;
    state.currentAudioData = new Float32Array(48000);
    state.currentAudioChannels = null;
    state.currentAudioBuffer = null;
    state.trackSegments = [];
    state.trackSegmentsReady = false;
    state.streamingSources = [];
    state.playheadRaf = null;
    state.exclusivePlaybackRaf = null;
    state.audioSettings = {};
    state.project = { bpm: 120 };
  });

  afterEach(() => {
    rafStub.restore();
    trackManager.clearAll();
    clearTrackGains();
  });

  it('streamingSources 非空时改 M/S 不启动独占输出', async () => {
    // 模拟流式播放：仍有在响的 chunk source。
    state.streamingSources = [{ onended: null, stop() {} }];
    const s1 = trackManager.addSinger({ name: 's1', type: 'singer' });

    // 改 M/S，触发 applyAudibility → 订阅回调。
    s1.mute = true;
    applyAudibility(trackManager.getSingers());
    await delay(80); // 超过 40ms 防抖窗口

    expect(audioPlayCalls.length, '流式播放不得启动独占 PCM').to.equal(0);
  });

  it('重建入口包含流式守卫（源码契约）', () => {
    // 通过源码契约锁定守卫：流式活跃时直接返回，不启动独占重建。
    // 运行时的正向触发由 exclusiveRealtimeMs.test.js 覆盖，避免测试间状态耦合。
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'audioPlayback.js'), 'utf8');
    const fn = src.slice(
      src.indexOf('function _rebuildExclusiveForAudibilityChange'),
      src.indexOf('subscribeAudibilityChange(_rebuildExclusiveForAudibilityChange)'),
    );
    expect(fn).to.include('_streamingActive');
    expect(fn).to.include('state.streamingSources');
  });
});
