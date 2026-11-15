'use strict';
/**
 * 欢迎页（不是通过双击工程文件启动时的首屏）。
 *
 * 覆盖三层：
 *   1. src/index.html 里确实有这副骨架（标题在左上、框头三栏、三列表头），
 *      并且用到的 i18n 键与图标都存在 —— 少了任何一个，界面就是英文残留或图标空洞；
 *   2. 列表渲染：文件名 / 文件路径 / 上一次打开的时间三列、空列表提示、
 *      路径里的 HTML 必须原样是文本（列表内容来自可被外部改写的配置文件）；
 *   3. 行为：点行打开工程、「新建工程」真的落盘一个空 .sxsproj、
 *      「打开工程文件」弹原生选择框、取消时欢迎页不塌、有工程被装载时自动收起，
 *      以及打开过的工程被记进最近列表。
 */
const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const WELCOME_KEYS = [
  'welcomeTitle', 'welcomeSubtitle', 'welcomeRecentProjects',
  'welcomeNewProject', 'welcomeNewProjectHint', 'welcomeOpenProject', 'welcomeOpenProjectHint',
  'welcomeColName', 'welcomeColPath', 'welcomeColTime', 'welcomeEmpty', 'welcomeClose',
  'newProjectDefaultName', 'newProjectFailed',
];

let welcomePage, recentProjects, projectManager, state, dom, trackManager;
let en, zh;
let saved;      // electronAPI.saveFile 捕获到的 { filePath, data }
let openCalls;  // showSaveDialog / showOpenDialog 的调用记录
let recentsCalls;

/** 真·骨架：直接取 src/index.html 里欢迎页那一段，避免测试与实现两张皮。 */
function welcomeHtml() {
  const html = readSrc('src/index.html');
  const start = html.indexOf('<div id="welcome-page"');
  const end = html.indexOf('<!-- ort.all.min.js');
  expect(start, 'src/index.html 应有 #welcome-page').to.be.greaterThan(-1);
  expect(end).to.be.greaterThan(start);
  return html.slice(start, end);
}

function installDom() {
  document.body.innerHTML = `
    <input id="bpm-input" type="number" value="120" />
    <input id="time-sig-num" type="number" value="4" />
    <input id="time-sig-den" type="number" value="4" />
    <div id="singer-list"></div>
    <button id="btn-export"></button><button id="btn-export-lrc"></button>
    <div id="fragment-canvas-container">
      <canvas id="fragment-canvas"></canvas>
      <canvas id="fragment-playhead-canvas"></canvas>
    </div>
    ${welcomeHtml()}
  `;
  const container = document.getElementById('fragment-canvas-container');
  Object.defineProperty(container, 'clientWidth', { value: 1200, configurable: true });
  Object.defineProperty(container, 'clientHeight', { value: 460, configurable: true });
  dom.bpmInput = document.getElementById('bpm-input');
  dom.timeSigNum = document.getElementById('time-sig-num');
  dom.timeSigDen = document.getElementById('time-sig-den');
  dom.singerListEl = document.getElementById('singer-list');
  dom.fragmentContainer = container;
  dom.fragmentCanvas = document.getElementById('fragment-canvas');
  dom.fragmentPlayheadCanvas = document.getElementById('fragment-playhead-canvas');
  dom.btnExport = document.getElementById('btn-export');
  dom.btnExportLrc = document.getElementById('btn-export-lrc');
}

/** 假主进程：最近列表 + 文件读写 + 原生对话框。 */
function installApi(items = []) {
  recentsCalls = { list: 0, record: [], remove: [] };
  saved = null;
  openCalls = { save: [], open: [] };
  window.electronAPI = {
    setDirty() {},
    getAppVersion: async () => '2.0.2',
    recents: {
      list: async () => { recentsCalls.list += 1; return { success: true, items }; },
      record: async (p) => { recentsCalls.record.push(p); return { success: true, items }; },
      remove: async (p) => { recentsCalls.remove.push(p); return { success: true, items: [] }; },
      clear: async () => ({ success: true, items: [] }),
    },
    showSaveDialog: async (opts) => {
      openCalls.save.push(opts);
      return opts && opts.__cancel
        ? { canceled: true }
        : { canceled: false, filePath: '/tmp/music/新工程.sxsproj' };
    },
    showOpenDialog: async () => {
      openCalls.open.push(1);
      return { canceled: true };
    },
    saveFile: async (filePath, data) => { saved = { filePath, data }; return { success: true }; },
    readFile: async () => JSON.stringify({
      version: '1.3.0', project: { bpm: 88, timeSignature: [4, 4] }, singers: [], fragments: [],
    }),
    fileExists: async () => true,
    authorizePath: async () => ({ success: true }),
  };
}

const rows = () => [...document.querySelectorAll('#welcome-recent-list .welcome-row--item')];
const page = () => document.getElementById('welcome-page');

describe('欢迎页 — 骨架与文案', () => {
  before(async () => {
    ({ state, dom, trackManager } = await import('../src/renderer/state.js'));
    projectManager = await import('../src/renderer/projectManager.js');
    welcomePage = await import('../src/renderer/welcomePage.js');
    recentProjects = await import('../src/renderer/recentProjects.js');
    en = (await import('../src/i18n/en.js')).default;
    zh = (await import('../src/i18n/zh-CN.js')).default;
  });

  it('框头三栏齐全：左标题、中新建工程（新建文件图标）、右打开工程文件（文件夹图标）', () => {
    const html = readSrc('src/index.html');
    expect(html).to.include('id="welcome-btn-new"');
    expect(html).to.include('data-icon="file-plus"');
    expect(html).to.include('id="welcome-btn-open"');
    expect(html).to.include('data-icon="folder-open"');
    // 图标必须真的注册了，否则 hydrateIcons 会留一个空洞
    const registry = require('../src/icons/iconRegistry.js');
    expect(registry.getIconMarkup('file-plus')).to.be.a('string');
    expect(registry.getIconMarkup('folder-open')).to.be.a('string');
    expect(html).to.include('data-i18n="main.welcomeRecentProjects"');
  });

  it('三列表头：文件名 / 文件路径 / 上一次打开的时间', () => {
    const html = readSrc('src/index.html');
    for (const key of ['welcomeColName', 'welcomeColPath', 'welcomeColTime']) {
      expect(html, key).to.include(`data-i18n="main.${key}"`);
    }
    expect(html).to.match(/role="rowgroup"[^>]*id="welcome-recent-list"|id="welcome-recent-list"[^>]*role="rowgroup"/);
  });

  it('用到的 i18n 键中英都存在且非空', () => {
    for (const k of WELCOME_KEYS) {
      expect(en.main[k], `en ${k}`).to.be.a('string').and.not.empty;
      expect(zh.main[k], `zh-CN ${k}`).to.be.a('string').and.not.empty;
    }
  });

  it('CSS 里 .welcome-page 有 display:none 的 hidden 兜底（display:flex 会盖掉 hidden 属性）', () => {
    const css = readSrc('src/index.css');
    expect(css).to.match(/\.welcome-page\[hidden\]\s*\{[^}]*display:\s*none/);
  });
});

describe('欢迎页 — 最近列表渲染', () => {
  before(async () => {
    ({ state, dom, trackManager } = await import('../src/renderer/state.js'));
    projectManager = await import('../src/renderer/projectManager.js');
    welcomePage = await import('../src/renderer/welcomePage.js');
    recentProjects = await import('../src/renderer/recentProjects.js');
  });

  beforeEach(() => {
    installDom();
    trackManager.clearAll();
    state.currentProjectFilePath = null;
    state.isDirty = false;
  });

  it('时间列是本地的 YYYY-MM-DD HH:mm，非法时间戳显示占位符', () => {
    const d = new Date(2026, 10, 15, 9, 5);
    expect(welcomePage.formatOpenedAt(d.getTime())).to.equal('2026-11-15 09:05');
    expect(welcomePage.formatOpenedAt(0)).to.equal('—');
    expect(welcomePage.formatOpenedAt('abc')).to.equal('—');
    expect(welcomePage.formatOpenedAt(undefined)).to.equal('—');
  });

  it('三列内容来自列表项，路径同时进 title 方便看全', async () => {
    installApi([
      { path: '/tmp/music/第一首.sxsproj', name: '第一首.sxsproj', openedAt: new Date(2026, 10, 14, 23, 59).getTime() },
      { path: '/tmp/b.sxsproj', name: 'b.sxsproj', openedAt: new Date(2026, 10, 12, 8, 0).getTime() },
    ]);
    await welcomePage.refreshWelcomeRecents();
    const list = rows();
    expect(list).to.have.length(2);
    const cells = [...list[0].children].map((c) => c.textContent);
    expect(cells).to.deep.equal(['第一首.sxsproj', '/tmp/music/第一首.sxsproj', '2026-11-14 23:59']);
    expect(list[0].children[1].title).to.equal('/tmp/music/第一首.sxsproj');
    expect(document.getElementById('welcome-empty').hidden).to.equal(true);
  });

  it('列表为空时显示提示，而不是留一片空白', async () => {
    installApi([]);
    await welcomePage.refreshWelcomeRecents();
    expect(rows()).to.have.length(0);
    expect(document.getElementById('welcome-empty').hidden).to.equal(false);
  });

  it('路径里的尖括号原样是文本，不会被当成 HTML（列表来自可被改写的配置文件）', async () => {
    const evil = '/tmp/<img src=x onerror=alert(1)>.sxsproj';
    installApi([{ path: evil, name: evil.split('/').pop(), openedAt: 1 }]);
    await welcomePage.refreshWelcomeRecents();
    expect(document.querySelectorAll('#welcome-recent-list img')).to.have.length(0);
    expect(rows()[0].children[1].textContent).to.equal(evil);
  });

  it('主进程读不到列表时退化成空列表，不抛错', async () => {
    installApi([]);
    window.electronAPI.recents.list = async () => { throw new Error('boom'); };
    await welcomePage.refreshWelcomeRecents();
    expect(rows()).to.have.length(0);
  });
});

describe('欢迎页 — 行为', () => {
  let disposeWelcome, disposeTracking;

  before(async () => {
    ({ state, dom, trackManager } = await import('../src/renderer/state.js'));
    projectManager = await import('../src/renderer/projectManager.js');
    welcomePage = await import('../src/renderer/welcomePage.js');
    recentProjects = await import('../src/renderer/recentProjects.js');
  });

  beforeEach(() => {
    installDom();
    installApi([
      { path: '/tmp/music/第一首.sxsproj', name: '第一首.sxsproj', openedAt: 1 },
    ]);
    trackManager.clearAll();
    state.currentProjectFilePath = null;
    state.isDirty = false;
    disposeWelcome = welcomePage.installWelcomePage();
    disposeTracking = recentProjects.installRecentProjectTracking();
    welcomePage.showWelcome();
  });

  afterEach(() => {
    disposeWelcome();
    disposeTracking();
    delete window.electronAPI;
  });

  it('显示时拉一次列表，收起时不改数据', async () => {
    await new Promise((r) => setTimeout(r, 0));
    expect(page().hidden).to.equal(false);
    expect(recentsCalls.list).to.be.greaterThan(0);
    expect(rows()).to.have.length(1);
    welcomePage.hideWelcome();
    expect(page().hidden).to.equal(true);
  });

  it('点某一行 = 打开那个工程，欢迎页随之收起并记进最近列表', async () => {
    await new Promise((r) => setTimeout(r, 0));
    rows()[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(state.currentProjectFilePath).to.equal('/tmp/music/第一首.sxsproj');
    expect(page().hidden).to.equal(true);
    expect(recentsCalls.record).to.deep.equal(['/tmp/music/第一首.sxsproj']);
  });

  it('键盘 Enter 同样能打开（行是 div[role=row]，不是 button）', async () => {
    await new Promise((r) => setTimeout(r, 0));
    rows()[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(state.currentProjectFilePath).to.equal('/tmp/music/第一首.sxsproj');
  });

  it('「新建工程」写出一份空的 .sxsproj 并把它当当前工程', async () => {
    await document.getElementById('welcome-btn-new')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    expect(openCalls.save).to.have.length(1);
    expect(openCalls.save[0].defaultPath).to.match(/\.sxsproj$/);
    expect(saved).to.not.equal(null);
    expect(saved.filePath).to.equal('/tmp/music/新工程.sxsproj');
    const obj = JSON.parse(saved.data);
    expect(obj.singers).to.deep.equal([]);
    expect(obj.fragments).to.deep.equal([]);
    expect(obj.project.bpm).to.equal(120);
    expect(state.currentProjectFilePath).to.equal('/tmp/music/新工程.sxsproj');
    expect(state.isDirty).to.equal(false);
    expect(page().hidden).to.equal(true);
    expect(recentsCalls.record).to.deep.equal(['/tmp/music/新工程.sxsproj']);
  });

  it('新建对话框取消时什么都不发生（不清空、不落盘、不收起）', async () => {
    await new Promise((r) => setTimeout(r, 0));
    trackManager.addSinger({ trackName: '主唱' });
    window.electronAPI.showSaveDialog = async () => ({ canceled: true });
    document.getElementById('welcome-btn-new').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(saved).to.equal(null);
    expect(trackManager.getSingers()).to.have.length(1);
    expect(page().hidden).to.equal(false);
  });

  it('「打开工程文件」走原生选择框；取消时欢迎页留在原地', async () => {
    document.getElementById('welcome-btn-open').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(openCalls.open).to.have.length(1);
    expect(page().hidden).to.equal(false);
  });

  it('工程从别处被装载（Ctrl+O、MCP）时欢迎页也会收起', () => {
    expect(page().hidden).to.equal(false);
    document.dispatchEvent(new window.CustomEvent('sxse:project-applied', { detail: { filePath: '/tmp/x.sxsproj' } }));
    expect(page().hidden).to.equal(true);
  });

  it('× 只关掉浮层，底下的空白工程还能继续编辑', () => {
    document.getElementById('welcome-btn-close').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(page().hidden).to.equal(true);
    expect(trackManager.getSingers()).to.have.length(0);
  });

  it('Esc 关掉欢迎页', () => {
    page().dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(page().hidden).to.equal(true);
  });

  it('重复安装不会挂出两套监听', async () => {
    const again = welcomePage.installWelcomePage();
    document.getElementById('welcome-btn-close').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    welcomePage.showWelcome();
    document.getElementById('welcome-btn-close').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    expect(page().hidden).to.equal(true);
    again();
  });
});

describe('projectManager.createNewProjectFile', () => {
  before(async () => {
    ({ state, dom, trackManager } = await import('../src/renderer/state.js'));
    projectManager = await import('../src/renderer/projectManager.js');
  });

  beforeEach(() => {
    installDom();
    installApi([]);
    trackManager.clearAll();
    state.currentProjectFilePath = null;
    state.isDirty = false;
  });

  it('没有 electronAPI 时安静地什么都不做', async () => {
    delete window.electronAPI;
    const res = await projectManager.createNewProjectFile();
    expect(res).to.deep.equal({ created: false, canceled: true });
  });

  it('保存框给的路径没有扩展名时补 .sxsproj', async () => {
    window.electronAPI.showSaveDialog = async () => ({ canceled: false, filePath: '/tmp/music/song' });
    const res = await projectManager.createNewProjectFile();
    expect(res.created).to.equal(true);
    expect(saved.filePath).to.equal('/tmp/music/song.sxsproj');
  });

  it('保存框给的路径是别的扩展名时不冒充那种格式，补成 .sxsproj', async () => {
    window.electronAPI.showSaveDialog = async () => ({ canceled: false, filePath: '/tmp/music/song.vpr' });
    const res = await projectManager.createNewProjectFile();
    expect(res.created).to.equal(true);
    expect(saved.filePath).to.equal('/tmp/music/song.vpr.sxsproj');
  });

  it('写盘失败时不认作当前工程，也不改动 dirty 标记', async () => {
    // alertDialog 用裸 requestAnimationFrame，jsdom 只在 window 上有
    const raf = global.requestAnimationFrame;
    global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
    window.electronAPI.saveFile = async () => ({ success: false, error: 'EPERM' });
    const res = await projectManager.createNewProjectFile();
    expect(res.created).to.equal(false);
    expect(res.error).to.equal('EPERM');
    expect(state.currentProjectFilePath).to.equal(null);
    if (raf) global.requestAnimationFrame = raf; else delete global.requestAnimationFrame;
  });
});

describe('启动时是否显示欢迎页（consumePendingOpenFile 的返回值）', () => {
  let openFromOs;

  before(async () => {
    ({ state, dom, trackManager } = await import('../src/renderer/state.js'));
    openFromOs = await import('../src/renderer/openFromOs.js');
  });

  beforeEach(() => {
    installDom();
    installApi([]);
    trackManager.clearAll();
    state.currentProjectFilePath = null;
    state.isDirty = false;
  });

  it('没有投递文件 → false（调用方据此显示欢迎页）', async () => {
    window.electronAPI.takePendingOpenFile = async () => null;
    expect(await openFromOs.consumePendingOpenFile()).to.equal(false);
  });

  it('投递了工程 → true，并且真的打开了', async () => {
    window.electronAPI.takePendingOpenFile = async () => ({ kind: 'project', path: '/tmp/music/第一首.sxsproj' });
    expect(await openFromOs.consumePendingOpenFile()).to.equal(true);
    expect(state.currentProjectFilePath).to.equal('/tmp/music/第一首.sxsproj');
  });

  it('取文件这件事本身失败时也回 false，而不是把启动流程打断', async () => {
    window.electronAPI.takePendingOpenFile = async () => { throw new Error('ipc down'); };
    expect(await openFromOs.consumePendingOpenFile()).to.equal(false);
  });

  it('renderer/index.js 里"没投递文件就显示欢迎页"这条线还在', () => {
    const src = readSrc('src/renderer/index.js');
    expect(src).to.include('consumePendingOpenFile().then((opened) => {');
    expect(src).to.include('consumePendingOpenFile().then(');
    expect(src).to.include('if (!opened) showWelcome();');
    // 监听必须在取文件之前挂好，否则冷启动打开的工程会漏记、欢迎页会闪一下
    expect(src.indexOf('installWelcomePage()')).to.be.lessThan(src.indexOf('consumePendingOpenFile().then('));
  });
});
