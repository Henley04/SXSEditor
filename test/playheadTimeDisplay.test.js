/**
 * 播放时间码展示位（#time-display）的存在性 + 写入口的 null 守卫
 *
 * 现场：工具栏改版（插件 M2 那一轮）把 #time-display 从 index.html 删掉了，
 * 但 audioPlayback / eventHandlers / 插件阻滞浮层仍在写这个节点。于是
 * Play All 之后 updatePlayhead 的 rAF 每帧抛
 *
 *   TypeError: Cannot set properties of null (setting 'textContent')
 *
 * playhead 动画当场停住、运行时错误弹窗刷屏，而音频其实还在播。
 *
 * 这里锁三件事：
 *   1. index.html 里这个节点必须在（CSS 也还在为它排版，说明它属于工具栏）；
 *   2. 所有写入走 state.js 的 setTimeDisplay（内部有 null 守卫），
 *      不再出现 `dom.timeDisplay.textContent = …` 这种裸写；
 *   3. setTimeDisplay 在节点缺失时是 no-op —— 时间码看不见可以接受，
 *      把播放流程打断不行。
 */
const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

describe('播放时间码展示位', () => {
  it('index.html 提供 #time-display（挂在传输控件组内）', () => {
    const html = readSrc('src/index.html');
    expect(html).to.match(/<span id="time-display"/);
    // 必须落在 transport-group 里：它是播放/推理状态的同一块展示位
    const groupStart = html.indexOf('transport-group');
    const groupEnd = html.indexOf('<div class="toolbar-divider"></div>', groupStart);
    const timeIdx = html.indexOf('id="time-display"');
    expect(groupStart, 'index.html 应有 .transport-group').to.be.greaterThan(-1);
    expect(groupEnd, 'transport-group 之后应有分隔线').to.be.greaterThan(-1);
    expect(timeIdx).to.be.greaterThan(groupStart);
    expect(timeIdx).to.be.lessThan(groupEnd);
  });

  it('index.css 仍为 #time-display 排版（节点不该被单方面删掉）', () => {
    const css = readSrc('src/index.css');
    expect(css).to.match(/#time-display\s*\{/);
    // 窄屏分档里也要有，否则改版后只有宽屏能用
    expect(css).to.include('#time-display { min-width:');
  });

  it('state.js 导出带 null 守卫的 setTimeDisplay', () => {
    const src = readSrc('src/renderer/state.js');
    expect(src).to.include('export function setTimeDisplay');
    const body = src.slice(src.indexOf('export function setTimeDisplay'));
    const snippet = body.slice(0, body.indexOf('\n}'));
    expect(snippet).to.include('if (!dom.timeDisplay) return;');
  });

  it('播放 / 拖拽 / 合成进度都不再裸写 dom.timeDisplay', () => {
    for (const rel of ['src/renderer/audioPlayback.js', 'src/renderer/eventHandlers.js']) {
      const src = readSrc(rel);
      expect(src, `${rel} 不应直写 dom.timeDisplay.textContent`)
        .to.not.match(/dom\.timeDisplay\.textContent\s*=/);
      expect(src, `${rel} 应使用 setTimeDisplay`).to.include('setTimeDisplay(');
    }
  });

  it('播放头 rAF（updatePlayhead）走 setTimeDisplay', () => {
    const src = readSrc('src/renderer/audioPlayback.js');
    const start = src.indexOf('function updatePlayhead');
    expect(start, 'audioPlayback.js 应有 updatePlayhead').to.be.greaterThan(-1);
    const end = src.indexOf('_sharedUpdateFn = updatePlayhead', start);
    const body = src.slice(start, end === -1 ? undefined : end);
    expect(body).to.include('setTimeDisplay(');
    expect(body).to.not.match(/dom\.timeDisplay\.textContent\s*=/);
  });

  it('节点缺失时 setTimeDisplay 不抛（no-op）', () => {
    // 共享的 jsdom 文档里没有 #time-display → dom.timeDisplay 为 null，
    // 正是线上崩溃的那种状态。
    const { dom, setTimeDisplay } = require('../src/renderer/state.js');
    expect(dom.timeDisplay).to.equal(null);
    expect(() => setTimeDisplay('00:00:000')).to.not.throw();
  });
});
