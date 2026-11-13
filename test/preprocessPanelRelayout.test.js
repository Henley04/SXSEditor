'use strict';
/**
 * 歌手预处理：收起顶部参数面板后，下方钢琴卷帘/波形必须按新布局重绘。
 *
 * 现象：`#extract-panel.collapsed` 只是 display:none，主内容区变高但浏览器
 * 不会派发 window resize，画布后备缓冲仍是旧尺寸 → 下方出现一条空白。
 * 修复方式是在折叠按钮里主动调用钢琴卷帘的 resize 与波形重绘。
 */

const fs = require('node:fs');
const path = require('node:path');
const { expect } = require('chai');
const sinon = require('sinon');

const ROOT = path.resolve(__dirname, '..');

describe('preprocess panel collapse — 下方视图自动重排', function () {
  let state;
  let refreshViewportAfterPanelToggle;

  before(async function () {
    ({ state } = await import('../src/audioPreprocess/state.js'));
    ({ refreshViewportAfterPanelToggle } = await import('../src/audioPreprocess/panel.js'));
  });

  afterEach(function () {
    state.pianoRoll = null;
    state.wavAudioBuffer = null;
    state.isPlaying = false;
  });

  it('折叠后调用钢琴卷帘 _resize（按新高度重建画布并重绘）', function () {
    const resize = sinon.spy();
    state.pianoRoll = {
      _resize: resize,
      getCurrentTime: () => 1.5,
    };
    refreshViewportAfterPanelToggle();
    expect(resize.calledOnce).to.equal(true);
  });

  it('没有加载音频 / 没有卷帘时安全无操作', function () {
    state.pianoRoll = null;
    expect(() => refreshViewportAfterPanelToggle()).to.not.throw();
  });

  it('收起按钮的处理函数接入了视图重排（源码守卫）', function () {
    const src = fs.readFileSync(path.join(ROOT, 'src/audioPreprocess/panel.js'), 'utf8');
    const handler = /btnTogglePanel\.addEventListener\('click',\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\}\);/.exec(src);
    expect(handler, '未找到收起按钮的 click 处理函数').to.be.ok;
    expect(handler[1]).to.match(/refreshViewportAfterPanelToggle\(\)/);
  });
});
