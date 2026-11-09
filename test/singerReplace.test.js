'use strict';
/**
 * 「双击歌手名 → 替换歌手」。
 *
 * 需求指定的两个替换入口：
 *   · 歌手文件（按文件里的**歌手名字**显示，走 loadSingerFile）
 *   · 音色后端（列表顶部的 SXS INFERENCE 那一行 → 切回内置推理）
 *
 * 第二条以前是不存在的：插件分区的列表只遍历 listTrackKinds()（插件声明的
 * 轨道种类），轨道一旦被换到插件后端，用户就没有回到内置推理的入口，除非把
 * 插件卸掉。这里锁住"那一行确实在、点了确实切回 sxs"。
 */
const { expect } = require('chai');

let state, dom, trackManager, timeline, pluginTrackDialog, projectManager, i18n;

const tick = () => new Promise((r) => setTimeout(r, 0));

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

/** 找出分区里所有可点条目（插件 kind 与内置后端共用同一种 button 外壳）。 */
function itemsOf(wrap) {
  return Array.from(wrap.querySelectorAll('button')).filter((b) => b.style.textAlign === 'left');
}

describe('替换歌手 — 入口与后端切换', () => {
  before(async () => {
    ({ state, dom, trackManager } = await import('../src/renderer/state.js'));
    timeline = await import('../src/renderer/timelineRenderer.js');
    pluginTrackDialog = await import('../src/renderer/pluginTrackDialog.js');
    projectManager = await import('../src/renderer/projectManager.js');
    i18n = await import('../src/i18n/index.js');
    i18n.setLocale('zh-CN');
  });

  beforeEach(() => {
    installDom();
    trackManager.clearAll();
    state.editingTrackNameId = null;
    state.selectedSingerId = null;
    timeline.renderSingerList._cacheKey = null;
  });

  it('后端分区在没有插件时也列出 SXS INFERENCE（否则换过去就回不来）', async () => {
    const singer = trackManager.addSinger({
      name: 's1',
      type: 'singer',
      backend: { type: 'plugin', pluginId: 'p', kindId: 'k' },
    });
    const wrap = pluginTrackDialog.createPluginBackendSection({
      singerId: singer.id,
      includeBuiltin: true,
    });
    await tick();

    const items = itemsOf(wrap);
    expect(items.length, '至少要有内置后端那一行').to.be.greaterThan(0);
    expect(items[0].textContent).to.include('SXS INFERENCE');
    expect(items[0].textContent).to.include(i18n.t('main.builtinBackendHint'));
  });

  it('点 SXS INFERENCE 行把轨道切回内置后端，并回调 onCreated', async () => {
    const singer = trackManager.addSinger({
      name: 's1',
      type: 'singer',
      backend: { type: 'plugin', pluginId: 'p', kindId: 'k' },
    });
    trackManager.updateSinger(singer.id, { backendMissing: true });

    let applied = null;
    const wrap = pluginTrackDialog.createPluginBackendSection({
      singerId: singer.id,
      includeBuiltin: true,
      onCreated: (s) => { applied = s; },
    });
    await tick();

    itemsOf(wrap)[0].click();

    const updated = trackManager.getSinger(singer.id);
    expect(updated.backend.type).to.equal('sxs');
    expect(updated.backendMissing, '切回内置后必须清掉插件缺失标记').to.equal(false);
    expect(applied && applied.id).to.equal(singer.id);
  });

  it('新建模式下不列内置后端（那条路径没有"切回内置"的语义）', async () => {
    const wrap = pluginTrackDialog.createPluginBackendSection({
      singerId: null,
      includeBuiltin: true,
    });
    await tick();
    const items = itemsOf(wrap);
    for (const item of items) {
      expect(item.textContent).to.not.include(i18n.t('main.builtinBackendHint'));
    }
  });

  it('替换模式不提供"新建歌手"按钮', async () => {
    const singer = trackManager.addSinger({ name: 's1', type: 'singer' });
    projectManager.showSingerSelectDialog(singer.id, { mode: 'replace' });
    const text = document.body.textContent;
    expect(text).to.include(i18n.t('main.replaceSinger'));
    expect(text).to.include(i18n.t('main.chooseSingerFile'));
    expect(text).to.include(i18n.t('main.currentVoice'));
    expect(text, '替换的不是新建').to.not.include(i18n.t('main.openSingerCreator'));
  });

  it('歌手名可双击（可点样式 + 键盘可达 + 双击真的打开替换对话框）', () => {
    const singer = trackManager.addSinger({ name: 's1', type: 'singer', singerName: '小明' });
    timeline.renderSingerList();

    const nameEl = dom.singerListEl.querySelector('.singer-singer-name--replaceable');
    expect(nameEl, '歌手名应带可替换标记类').to.not.equal(null);
    expect(nameEl.textContent).to.equal('小明');
    expect(nameEl.getAttribute('role')).to.equal('button');
    expect(nameEl.getAttribute('aria-label')).to.equal(i18n.t('main.replaceSinger'));
    expect(nameEl.tabIndex).to.equal(0);

    document.body.textContent = '';
    nameEl.dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }));
    expect(document.body.textContent, '双击后应打开替换对话框').to.include(i18n.t('main.replaceSinger'));
    // 对话框里应当能看到当前歌手名
    expect(document.body.textContent).to.include('小明');
    expect(trackManager.getSinger(singer.id)).to.not.equal(null);
  });

  it('伴奏轨的"名字"（文件名）不可替换', () => {
    trackManager.clearAll();
    trackManager.addSinger({ name: 'acc', type: 'accompaniment', audioFileName: 'bed.wav' });
    timeline.renderSingerList._cacheKey = null;
    timeline.renderSingerList();
    expect(dom.singerListEl.querySelector('.singer-singer-name--replaceable')).to.equal(null);
  });

  describe('歌手文件替换', () => {
    const singerDoc = (singerName) => {
      const doc = {
        formatVersion: '1.0',
        singerName,
        wavBase64: Buffer.from('fake-wav').toString('base64'),
      };
      return new TextEncoder().encode(JSON.stringify(doc)).buffer;
    };

    it('替换模式只换音色：歌手名更新、用户起的轨道名保留', async () => {
      const singer = trackManager.addSinger({
        name: 's1',
        type: 'singer',
        trackName: '主唱',
        singerName: '旧歌手',
      });

      await projectManager.loadSingerFile(singer.id, singerDoc('新歌手'), 'x.sxssinger', { keepTrackName: true });

      const updated = trackManager.getSinger(singer.id);
      expect(updated.singerName).to.equal('新歌手');
      expect(updated.trackName, '轨道名是用户的标签，换音色不该改掉它').to.equal('主唱');
      expect(updated.wavBuffer).to.be.an.instanceof(ArrayBuffer);
      expect(updated.singerFilePath).to.equal('x.sxssinger');
    });

    it('默认行为不变（不传 keepTrackName 时轨道名跟随歌手名）', async () => {
      const singer = trackManager.addSinger({
        name: 's2',
        type: 'singer',
        trackName: '主唱',
        singerName: '旧歌手',
      });

      await projectManager.loadSingerFile(singer.id, singerDoc('另一位'), 'y.sxssinger');

      const updated = trackManager.getSinger(singer.id);
      expect(updated.singerName).to.equal('另一位');
      expect(updated.trackName).to.equal('另一位');
    });
  });
});
