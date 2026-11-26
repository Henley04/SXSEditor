'use strict';
/**
 * 导出内容三选一：混合 / 仅人声 / 仅伴奏。
 *
 * 这一层的风险不在"能不能导出"，而在"导出的到底是不是听到的"：
 *   - 仅人声若仍混进伴奏，用户拿到的所谓干声没法直接送去做混音；
 *   - 仅伴奏若把总长按人声算，末尾会多出一段静音；
 *   - 仅伴奏若还去初始化推理管线，等于为了不跑推理先加载 9 个模型。
 *
 * 用例按可观测的输出样本断言：伴奏铺在 [0, 0.5s)，人声铺满 [0, 1s)，
 * 三档导出在重叠区与非重叠区的取值必须各不相同。
 */
const { expect } = require('chai');

// 与其它 renderer 用例一致：只走原生 import，避免 state.js 被 require 与
// 原生 ESM 各加载一次导致 trackManager 不是同一个对象。
let state, trackManager, runExportJob, t;
before(async () => {
  ({ state, trackManager } = await import('../src/renderer/state.js'));
  ({ runExportJob } = await import('../src/renderer/audioPlayback.js'));
  ({ t } = await import('../src/i18n/index.js'));
});

const SR = 24000;          // 与 audioPlayback.SAMPLE_RATE 一致
const BPM = 120;           // 1 拍 = 0.5s = 12000 样本
const VOCAL_VALUE = 0.5;
const ACC_VALUE = 0.25;
const VOCAL_SAMPLES = 24000;   // 2 拍
const ACC_SAMPLES = 12000;     // 1 拍

/** 造一份「1 轨歌手 + 1 轨伴奏」的最小工程 */
function buildProject({ withAccompaniment = true } = {}) {
  trackManager.clearAll();
  state.project.bpm = BPM;

  const singer = trackManager.addSinger({ id: 's1', name: 's1', type: 'singer' });
  trackManager.addFragment({
    id: 'f1',
    singerId: singer.id,
    startTime: 0,
    duration: 2,
    notes: [{ pitch: 60, start: 0, duration: 2, lyric: 'a' }],
  });

  if (withAccompaniment) {
    const acc = trackManager.addSinger({ id: 'a1', name: 'a1', type: 'accompaniment' });
    // audioBuffer / audioChannels 是运行时字段（加载音频后由伴奏轨装载流程写入），
    // createSinger 的白名单不含它们，所以这里直接挂到已存在的对象上。
    trackManager.updateSinger(acc.id, {
      audioBuffer: new Float32Array(ACC_SAMPLES).fill(ACC_VALUE),
      audioChannels: [new Float32Array(ACC_SAMPLES).fill(ACC_VALUE)],
      audioSampleRate: SR,
      accompanimentStartTime: 0,
      accompanimentVolume: 1,
    });
  }
}

let synthCalls = 0;

function installElectronApi() {
  synthCalls = 0;
  global.window.electronAPI = {
    getSettings: async () => ({}),
    initSVSPipeline: async () => ({ success: true }),
    onSVSProgress: () => () => {},
    onSVSLoadProgress: () => () => {},
    synthesizeSVS: async () => {
      synthCalls++;
      return new Float32Array(VOCAL_SAMPLES).fill(VOCAL_VALUE);
    },
  };
}

/** 取交织缓冲里指定声道的第 index 个样本 */
const sampleAt = (interleaved, numChannels, index, ch = 0) => interleaved[index * numChannels + ch];

describe('runExportJob — 导出内容（mix / vocal / accompaniment）', () => {
  beforeEach(() => {
    installElectronApi();
    // 不真的去初始化推理管线：ensurePipelineInitialized 见到这个标记会直接返回
    state.pipelineInitialized = true;
    buildProject();
  });

  it('缺省 scope 等价于混合：人声段叠加了伴奏', async () => {
    const r = await runExportJob({ autoShift: false });
    expect(r.scope).to.equal('mix');
    expect(synthCalls).to.equal(1);
    // 重叠区：0.5 + 0.25
    expect(sampleAt(r.mixedAudio, r.numChannels, 0)).to.be.closeTo(VOCAL_VALUE + ACC_VALUE, 1e-6);
    // 伴奏已结束、人声仍在：只剩 0.5
    expect(sampleAt(r.mixedAudio, r.numChannels, ACC_SAMPLES + 100)).to.be.closeTo(VOCAL_VALUE, 1e-6);
  });

  it('scope=vocal：成品不含伴奏，且总长按人声算', async () => {
    const mix = await runExportJob({ autoShift: false });
    const vocal = await runExportJob({ autoShift: false, scope: 'vocal' });

    expect(vocal.scope).to.equal('vocal');
    expect(sampleAt(vocal.mixedAudio, vocal.numChannels, 0)).to.be.closeTo(VOCAL_VALUE, 1e-6);
    // 伴奏原本覆盖的前 0.5s 必须干净
    for (const i of [0, 1, ACC_SAMPLES - 1]) {
      expect(sampleAt(vocal.mixedAudio, vocal.numChannels, i)).to.be.closeTo(VOCAL_VALUE, 1e-6);
    }
    // 混合里同样的位置是 0.75，两者必须不同（否则说明伴奏没被排除）
    expect(sampleAt(mix.mixedAudio, mix.numChannels, 0)).to.not.be.closeTo(VOCAL_VALUE, 1e-3);
    expect(vocal.maxDuration).to.be.closeTo(VOCAL_SAMPLES / SR, 1e-6);
  });

  it('scope=accompaniment：人声段全零、不跑推理、总长按伴奏算', async () => {
    const r = await runExportJob({ autoShift: false, scope: 'accompaniment' });

    expect(r.scope).to.equal('accompaniment');
    // 关键：仅伴奏绝不能触发合成
    expect(synthCalls).to.equal(0);
    expect(r.fragmentCount).to.equal(0);
    expect(r.accompanimentCount).to.equal(1);
    // 总长由伴奏决定（1 拍 = 0.5s），而不是人声的 1s
    expect(r.maxDuration).to.be.closeTo(ACC_SAMPLES / SR, 1e-6);
    expect(r.mixedAudio.length).to.equal(ACC_SAMPLES * r.numChannels);
    expect(sampleAt(r.mixedAudio, r.numChannels, 0)).to.be.closeTo(ACC_VALUE, 1e-6);
    expect(sampleAt(r.mixedAudio, r.numChannels, ACC_SAMPLES - 1)).to.be.closeTo(ACC_VALUE, 1e-6);
  });

  it('scope=accompaniment 但工程里没有伴奏轨：明确报错，不产出静音文件', async () => {
    buildProject({ withAccompaniment: false });
    let err = null;
    try {
      await runExportJob({ autoShift: false, scope: 'accompaniment' });
    } catch (e) {
      err = e;
    }
    expect(err, '缺少伴奏轨时必须拒绝导出').to.be.instanceOf(Error);
    // 用当前语言的文案断言，避免把用例绑死在英文或中文
    expect(err.message).to.equal(t('main.exportDialog.noAccompaniment'));
  });

  it('scope=vocal 但所有分片都被静音：报"没有音符"，而不是导出静音人声', async () => {
    trackManager.updateSinger('s1', { mute: true });
    let err = null;
    try {
      await runExportJob({ autoShift: false, scope: 'vocal' });
    } catch (e) {
      err = e;
    }
    expect(err, '无人声可导出时必须拒绝').to.be.instanceOf(Error);
  });

  it('未知 scope 回落到混合（MCP / 插件传脏参数时不丢伴奏）', async () => {
    const r = await runExportJob({ autoShift: false, scope: 'somethig-typo' });
    expect(r.scope).to.equal('mix');
    expect(sampleAt(r.mixedAudio, r.numChannels, 0)).to.be.closeTo(VOCAL_VALUE + ACC_VALUE, 1e-6);
  });
});
