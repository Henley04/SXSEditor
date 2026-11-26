'use strict';
/**
 * 播放中 M/S 即时生效（计划 4.8）：点 M/S 只改增益，不暂停、不重新合成、播放头不动。
 */
const { expect } = require('chai');
const sinon = require('sinon');

const { state, dom, trackManager, history } = require('../src/renderer/state.js');
const { refreshAll } = require('../src/renderer/timelineRenderer.js');
const { registerTrackGain, clearTrackGains } = require('../src/renderer/trackGainMixer.js');
const ap = require('../src/renderer/audioPlayback.js');

function makeGain() {
  return {
    gain: { value: 1, cancelScheduledValues() {}, setTargetAtTime(v) { this.value = v; } },
    context: { currentTime: 0 },
    connect() { return this; },
    disconnect() {},
  };
}

function installDom() {
  document.body.innerHTML = `
    <div id="singer-list"></div>
    <div id="fragment-canvas-container">
      <canvas id="fragment-canvas"></canvas>
      <canvas id="fragment-playhead-canvas"></canvas>
    </div>
    <button id="btn-export"></button><button id="btn-export-lrc"></button>
    <div id="transport-status"><span id="transport-status-text"></span><div id="transport-progress"><div id="transport-progress-fill"></div></div></div>
    <span id="time-display"></span>
    <input id="bpm-input"/><input id="time-sig-num"/><input id="time-sig-den"/><input id="auto-shift-check" type="checkbox"/>
  `;
  const c = document.getElementById('fragment-canvas-container');
  Object.defineProperty(c, 'clientWidth', { value: 1200, configurable: true });
  Object.defineProperty(c, 'clientHeight', { value: 460, configurable: true });
  dom.singerListEl = document.getElementById('singer-list');
  dom.fragmentContainer = c;
  dom.fragmentCanvas = document.getElementById('fragment-canvas');
  dom.fragmentPlayheadCanvas = document.getElementById('fragment-playhead-canvas');
  dom.timeDisplay = document.getElementById('time-display');
  dom.bpmInput = document.getElementById('bpm-input');
  dom.timeSigNum = document.getElementById('time-sig-num');
  dom.timeSigDen = document.getElementById('time-sig-den');
  dom.autoShiftCheck = document.getElementById('auto-shift-check');
  dom.btnExport = document.getElementById('btn-export');
  dom.btnExportLrc = document.getElementById('btn-export-lrc');
}

describe('播放中 M/S 即时生效', () => {
  let g1;
  let g2;

  beforeEach(() => {
    installDom();
    clearTrackGains();
    trackManager.clearAll();
    history.clear();
    state.project = { bpm: 120, timeSignature: [4, 4] };
    state.isPlaying = true;
    state.playbackPauseOffset = 0;
    state.playbackStartTime = 999;
    state.currentAudioData = new Float32Array(24000);
    const s1 = trackManager.addSinger({ name: 's1', type: 'singer' });
    const s2 = trackManager.addSinger({ name: 's2', type: 'singer' });
    g1 = makeGain();
    g2 = makeGain();
    registerTrackGain(s1.id, g1, 1);
    registerTrackGain(s2.id, g2, 1);
    refreshAll(); // 初始 applyAudibility
  });

  afterEach(() => {
    clearTrackGains();
    state.isPlaying = false;
  });

  it('改 mute 后 refreshAll 立即写增益，不暂停、不重新合成、播放头不动', () => {
    const playStub = sinon.stub(ap, 'playAll');
    const pauseStub = sinon.stub(ap, 'pausePlayback');
    const offsetBefore = state.playbackPauseOffset;
    const startTimeBefore = state.playbackStartTime;
    try {
      const s1 = trackManager.getSingers()[0];
      trackManager.updateSinger(s1.id, { mute: true });
      refreshAll();
      expect(g1.gain.value).to.equal(0, '静音轨增益应立即归零');
      expect(g2.gain.value).to.equal(1);
      expect(playStub.called, '不应重新合成').to.equal(false);
      expect(pauseStub.called, '不应暂停').to.equal(false);
      expect(state.playbackPauseOffset).to.equal(offsetBefore);
      expect(state.playbackStartTime).to.equal(startTimeBefore);
      expect(state.isPlaying).to.equal(true);
    } finally {
      playStub.restore();
      pauseStub.restore();
    }
  });

  it('改 solo 后其余人声立即静音', () => {
    const s1 = trackManager.getSingers()[0];
    trackManager.updateSinger(s1.id, { solo: true });
    refreshAll();
    expect(g1.gain.value).to.equal(1);
    expect(g2.gain.value).to.equal(0);
  });

  it('撤销/重做走 refreshAll 同样即时生效', () => {
    const s1 = trackManager.getSingers()[0];
    trackManager.updateSinger(s1.id, { mute: true });
    history.push({
      undo() { trackManager.updateSinger(s1.id, { mute: false }); },
      redo() { trackManager.updateSinger(s1.id, { mute: true }); },
    });
    refreshAll();
    expect(g1.gain.value).to.equal(0);

    history.undo();
    refreshAll();
    expect(g1.gain.value).to.equal(1);

    history.redo();
    refreshAll();
    expect(g1.gain.value).to.equal(0);
  });
});
