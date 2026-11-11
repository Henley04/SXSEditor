'use strict';
/**
 * 伴奏内嵌音频的保存口径。
 *
 * 从外部工程（`.vpr`）导入的伴奏只有 base64 一份，没有源文件路径。两条容易
 * 出事的规则在这里锁住：
 *   · 有源文件路径的伴奏不该被嵌入（工程文件会白白胖肿）；
 *   · 没有源路径的伴奏必须嵌入，否则按一次 Ctrl+S 音频就没了 —— 而且已有
 *     的 base64 要复用，不能每次自动保存都重编码几十 MB 的 WAV。
 */

const { expect } = require('chai');

let state, dom, trackManager, projectManager;

function installDom() {
  document.body.innerHTML = `
    <div id="singer-list"></div>
    <div id="fragment-canvas-container">
      <canvas id="fragment-canvas"></canvas>
      <canvas id="fragment-playhead-canvas"></canvas>
    </div>
  `;
  const container = document.getElementById('fragment-canvas-container');
  Object.defineProperty(container, 'clientWidth', { value: 1200, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 460, configurable: true });
  dom.singerListEl = document.getElementById('singer-list');
  dom.fragmentContainer = container;
  dom.fragmentCanvas = document.getElementById('fragment-canvas');
  dom.fragmentPlayheadCanvas = document.getElementById('fragment-playhead-canvas');
}

/** 假伴奏：只需要 audioBuffer/audioChannels 与 embeddedAudioData 这几个字段。 */
function addAccompaniment(extra = {}) {
  const singer = trackManager.addSinger({ type: 'accompaniment', trackName: '伴奏', ...extra });
  singer.audioChannels = [new Float32Array(16), new Float32Array(16)];
  singer.audioBuffer = singer.audioChannels[0];
  singer.audioSampleRate = 44100;
  singer.audioDuration = 1;
  return singer;
}

async function build(embed) {
  const { out } = await projectManager.buildProjectObject(false, embed);
  return out.singers.find((s) => s.type === 'accompaniment');
}

describe('buildProjectObject — 伴奏内嵌音频', () => {
  before(async () => {
    ({ state, dom, trackManager } = await import('../src/renderer/state.js'));
    projectManager = await import('../src/renderer/projectManager.js');
  });

  beforeEach(() => {
    installDom();
    trackManager.clearAll();
  });

  it('已有 base64 直接复用：不重编码，字节一字不差', async () => {
    const singer = addAccompaniment();
    singer.audioFileName = '心墙.wav';
    singer.embeddedAudioData = { wavBase64: 'QUJD', audioFileName: '心墙.wav', audioDuration: 1 };

    const out = await build(true);
    expect(out.embeddedAudioData.wavBase64).to.equal('QUJD');
    expect(out.embeddedAudioData.audioFileName).to.equal('心墙.wav');
    // 运行时字段不落盘
    expect(out.audioBuffer).to.equal(undefined);
    expect(out.audioChannels).to.equal(undefined);
  });

  it('不勾选嵌入时清空（有源文件路径的伴奏靠路径重新加载）', async () => {
    const singer = addAccompaniment({ audioFilePath: 'D:/music/伴奏.wav' });
    singer.embeddedAudioData = { wavBase64: 'QUJD' };

    const out = await build(false);
    expect(out.embeddedAudioData).to.equal(null);
  });

  it('换过音频文件后旧 base64 不再复用（否则保存会把旧音频写回去）', async () => {
    const singer = addAccompaniment();
    singer.embeddedAudioData = { wavBase64: 'QUJD' };
    // loadAccompanimentFile 会这样清空（换源即作废）
    trackManager.updateSinger(singer.id, { embeddedAudioData: null, audioFilePath: 'D:/new.wav' });

    const out = await build(false);
    expect(out.embeddedAudioData).to.equal(null);
  });
});
