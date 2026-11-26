'use strict';
/**
 * 歌手行上的静音 / 独奏开关。
 *
 * 这一层容易出错的地方不是规则（规则在 shared/trackAudibility.js，有独立用例），
 * 而是渲染缓存：renderSingerList 用一串状态拼缓存键，键里漏掉 mute/solo 的话，
 * 点击后 refreshAll 会因为"列表没变"直接早退 —— 按钮看起来点不动，开关状态也
 * 不会更新。这里锁三件事：
 *   1. 每条轨道都渲染出 M / S 两个开关，且带 aria-pressed；
 *   2. 点击后工程数据真的变了（并进撤销栈）；
 *   3. 重渲染后按钮的 is-on / aria-pressed 与数据一致。
 */
const { expect } = require('chai');

// 用原生 import 取模块：本仓库里 state.js 同时可能被 babel 的 require 与原生
// ESM 各加载一次（见 singerRowAlignment.test.js 的注释），两条注册表里的
// `dom` / `trackManager` 是不同的对象。这里只走一条，保证「我 rebind 的节点」
// 与「渲染器实际写入的节点」是同一个。
let state, dom, trackManager, history, timeline;
before(async () => {
  ({ state, dom, trackManager, history } = await import('../src/renderer/state.js'));
  timeline = await import('../src/renderer/timelineRenderer.js');
});

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

const flagsOf = (row) => Array.from(row.querySelectorAll('.btn-track-flag'));

describe('轨道静音 / 独奏开关', () => {
  beforeEach(() => {
    installDom();
    trackManager.clearAll();
    if (history.undoStack) history.undoStack.length = 0;
    if (history.redoStack) history.redoStack.length = 0;
    state.editingTrackNameId = null;
    state.selectedSingerId = null;
    state.project.bpm = 120;
    // 缓存键跨用例复用，必须清掉，否则下一次 renderSingerList 直接早退
    timeline.renderSingerList._cacheKey = null;
  });

  it('每条轨道都有 M / S 两个开关，初始为未激活', () => {
    const singer = trackManager.addSinger({ name: 's1', type: 'singer' });
    timeline.renderSingerList();

    const row = dom.singerListEl.querySelector('[data-singer-id]');
    const flags = flagsOf(row);
    expect(flags.length).to.equal(2);
    expect(flags[0].classList.contains('btn-track-mute')).to.equal(true);
    expect(flags[1].classList.contains('btn-track-solo')).to.equal(true);
    expect(flags[0].textContent).to.equal('M');
    expect(flags[1].textContent).to.equal('S');
    for (const f of flags) {
      expect(f.getAttribute('aria-pressed')).to.equal('false');
      expect(f.getAttribute('aria-label'), '开关必须有可读名称').to.be.a('string');
    }
    expect(singer.mute).to.equal(false);
    expect(singer.solo).to.equal(false);
  });

  it('点击 M 写入工程数据并重渲染为激活态，再点关闭', () => {
    const singer = trackManager.addSinger({ name: 's1', type: 'singer' });
    timeline.renderSingerList();

    let row = dom.singerListEl.querySelector('[data-singer-id]');
    flagsOf(row)[0].click();

    expect(trackManager.getSinger(singer.id).mute).to.equal(true);
    row = dom.singerListEl.querySelector('[data-singer-id]');
    expect(flagsOf(row)[0].getAttribute('aria-pressed')).to.equal('true');
    expect(row.classList.contains('is-muted')).to.equal(true);

    flagsOf(row)[0].click();
    expect(trackManager.getSinger(singer.id).mute).to.equal(false);
    row = dom.singerListEl.querySelector('[data-singer-id]');
    expect(flagsOf(row)[0].getAttribute('aria-pressed')).to.equal('false');
    expect(row.classList.contains('is-muted')).to.equal(false);
  });

  it('点击 S 只改自己，不互相干扰', () => {
    const a = trackManager.addSinger({ name: 'a', type: 'singer' });
    const b = trackManager.addSinger({ name: 'b', type: 'singer' });
    timeline.renderSingerList();

    const rows = () => Array.from(dom.singerListEl.querySelectorAll('.singer-item'));
    flagsOf(rows()[0])[1].click();

    expect(trackManager.getSinger(a.id).solo).to.equal(true);
    expect(trackManager.getSinger(b.id).solo).to.equal(false);
    expect(flagsOf(rows()[0])[1].getAttribute('aria-pressed')).to.equal('true');
    expect(flagsOf(rows()[1])[1].getAttribute('aria-pressed')).to.equal('false');
  });

  it('开关进撤销栈：undo 能恢复', () => {
    const singer = trackManager.addSinger({ name: 's1', type: 'singer' });
    timeline.renderSingerList();
    flagsOf(dom.singerListEl.querySelector('[data-singer-id]'))[0].click();
    expect(trackManager.getSinger(singer.id).mute).to.equal(true);

    history.undo();
    expect(trackManager.getSinger(singer.id).mute).to.equal(false);
  });

  it('点击开关不会顺带把轨道选中（行 click 被 stopPropagation 挡住）', () => {
    trackManager.addSinger({ name: 's1', type: 'singer' });
    timeline.renderSingerList();
    state.selectedSingerId = null;

    const row = dom.singerListEl.querySelector('[data-singer-id]');
    flagsOf(row)[0].click();
    expect(state.selectedSingerId, '点 M 不应把轨道设为选中').to.not.equal(row.dataset.singerId);
  });

  it('M / S 归属信息区，动作区不得再出现开关', () => {
    // 240px 的歌手栏里，动作区每多一个按钮，flex:1 的信息区就被挤掉一段；
    // 四个按钮并排时信息区所剩无几，轨道名 / 歌手名 / 推理后端会被裁光。
    // 这里把「开关不占动作区宽度」锁成一条可回归的结构约束。
    trackManager.addSinger({ name: 's1', type: 'singer' });
    timeline.renderSingerList();

    const row = dom.singerListEl.querySelector('[data-singer-id]');
    const info = row.querySelector('.singer-info');
    const actions = row.querySelector('.singer-item-actions');
    expect(info.querySelector('.singer-track-flags'), '开关应归属信息区').to.exist;
    expect(actions.querySelectorAll('.btn-track-flag').length,
      '动作区不得再放开关，否则会挤掉三行文字').to.equal(0);
    expect(flagsOf(row).length).to.equal(2);
  });
});
