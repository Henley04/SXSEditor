/**
 * 主编辑器「歌手列表 ↔ 分片时间轴」行对齐 + 插件建轨对话框关闭行为
 *
 * 1) 行对齐
 *    canvas 侧行高来自 SINGER_ROW_HEIGHT（同时用于绘制与命中测试），
 *    DOM 侧必须消费同一常量。此前 index.css 写死 64px而常���是 80px，
 *    第 N 行就偏 16×N px，滚动同步（scrollTop = fragmentScrollY）也跟着错。
 *    这里断言 CSS 只消费 state.js 发布的 CSS 变量，不再写死 px。
 *
 * 2) 对话框关闭
 *    - createDialog：onClick 抛错时close() 仍必须执行（try/finally）。
 *    - showSingerSelectDialog：插件建轨成功后，外层「选择歌手」对话框
 *      必须一起关掉，否则它会重新盖住主窗口（用户报的"提示窗不消失"）。
 */
const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

describe('主编辑器行对齐（歌手列表 vs 分片时间轴）', () => {
  let constants, css;

  before(() => {
    // 统一 require：见下方 createDialog describe 的注释（原生 import 会绕开
    // require.cache 另建模块注册表，导致同一份源码被加载两次）。
    constants = require('../src/renderer/constants.js');
    css = readSrc('src/index.css');
  });

  it('SINGER_ROW_HEIGHT / HEADER_HEIGHT 是正数且行高大于表头', () => {
    const { SINGER_ROW_HEIGHT, HEADER_HEIGHT } = constants;
    expect(SINGER_ROW_HEIGHT).to.be.a('number').and.to.be.greaterThan(0);
    expect(HEADER_HEIGHT).to.be.a('number').and.to.be.greaterThan(0);
    expect(SINGER_ROW_HEIGHT).to.be.greaterThan(HEADER_HEIGHT);
  });

  it('state.js 把行高/表头高发布成 CSS 变量（DOM 侧的唯一真源）', async () => {
    // state.js 在 import 时对 documentElement 写 --singer-row-height /
    // --timeline-header-height；这里验证源码里确实绑定了常量而不是写死数值。
    const stateSrc = readSrc('src/renderer/state.js');
    expect(stateSrc).to.include('SINGER_ROW_HEIGHT, HEADER_HEIGHT');
    expect(stateSrc).to.include("'--singer-row-height'");
    expect(stateSrc).to.include("'--timeline-header-height'");
    expect(stateSrc).to.include('${SINGER_ROW_HEIGHT}px');
    expect(stateSrc).to.include('${HEADER_HEIGHT}px');
  });

  it('.singer-item 消费 --singer-row-height，不写死 px', () => {
    const block = css.match(/\.singer-item\s*\{[^}]*\}/);
    expect(block, 'index.css 里应存在 .singer-item 规则').to.not.be.null;
    expect(block[0]).to.include('var(--singer-row-height');
    // 规则的 height 声明不得是裸 px
    const heightDecl = block[0].match(/height:\s*([^;]+);/);
    expect(heightDecl, '.singer-item 应声明 height').to.not.be.null;
    expect(heightDecl[1].trim()).to.not.match(/^\d+px$/);
  });

  it('.singer-row-spacer 消费 --timeline-header-height（等于 HEADER_HEIGHT）', () => {
    const block = css.match(/\.singer-row-spacer\s*\{[^}]*\}/);
    expect(block, 'index.css 里应存在 .singer-row-spacer 规则').to.not.be.null;
    expect(block[0]).to.include('var(--timeline-header-height');
    const heightDecl = block[0].match(/height:\s*([^;]+);/);
    expect(heightDecl[1].trim()).to.not.match(/^\d+px$/);
  });

  it('.singer-item 的 fallback 值与常量一致（变量未注入时也不至于错位）', () => {
    const fallback = css.match(/height:\s*var\(--singer-row-height,\s*(\d+)px\)/);
    expect(fallback, '应带 px fallback').to.not.be.null;
    expect(Number(fallback[1])).to.equal(constants.SINGER_ROW_HEIGHT);
    const headerFallback = css.match(/height:\s*var\(--timeline-header-height,\s*(\d+)px\)/);
    expect(headerFallback).to.not.be.null;
    expect(Number(headerFallback[1])).to.equal(constants.HEADER_HEIGHT);
  });

  it('CSS 中不存在遗留的 64px 歌手行高', () => {
    expect(css).to.not.match(/\.singer-item\s*\{[^}]*height:\s*64px/);
  });
});

describe('createDialog 关闭语义', () => {
  let createDialog, win;

  beforeEach(() => {
    win = global.window;
    document.body.innerHTML = '';
    // 用 require 而非 dynamic import：babel 会把本文件转成 CJS，
    // 原生 import 会绕开 require.cache 另建一份模块注册表，
    // 导致这里拿到的 createDialog 与被测模块内部用的不是同一个。
    createDialog = require('../src/renderer/uiControls.js').createDialog;
  });

  const overlayCount = () => document.querySelectorAll('div[style*="position: fixed"]').length;
  const clickByText = (text) => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === text);
    expect(btn, `应存在按钮「${text}」`).to.not.be.undefined;
    btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  };

  it('点击按钮后关闭弹窗', () => {
    createDialog({
      title: 'T',
      content: 'C',
      buttons: [{ text: '确定', type: 'primary', onClick: () => {} }],
    });
    expect(overlayCount()).to.equal(1);
    clickByText('确定');
    expect(overlayCount()).to.equal(0);
  });

  it('onClick 抛错时仍然关闭弹窗（try/finally）', () => {
    createDialog({
      title: 'T',
      content: 'C',
      buttons: [{
        text: '确定',
        type: 'primary',
        onClick: () => { throw new Error('boom from onClick'); },
      }],
    });
    expect(overlayCount()).to.equal(1);
    // 注意：jsdom 会把事件监听器里的异常收进 virtual console 而不重抛，
    // 所以这里只断言真正要守住的不变量 —— 弹窗已被收掉。
    clickByText('确定');
    expect(overlayCount(), 'onClick 抛错不应把弹窗留在屏幕上').to.equal(0);
  });
});

describe('showSingerSelectDialog 建轨后关闭外层对话框', () => {
  const PLUGIN_LIST = {
    plugins: [{
      id: 'example-concat',
      name: '示例拼接后端',
      version: '1.0.0',
      capabilities: { synthesize: true, blockPlayback: true, streaming: false, voices: false },
      trackKinds: [{ id: 'concat', name: '拼接音源·精简', paramSchema: [] }],
    }],
    pluginsDir: 'C:/plugins',
    errors: [],
  };

  // 对话框遮罩（createDialog 用 position:fixed 全屏 overlay）
  const overlayCount = () => document.querySelectorAll('div[style*="position: fixed"]').length;
  const clickByText = (win, text) => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.textContent === text);
    expect(btn, `应存在按钮「${text}」`).to.not.be.undefined;
    btn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  };

  /** 把 index.html 的 body 灌进 jsdom，并按真实路径完整走一遍插件建轨。 */
  async function runCreateTrackFlow(win) {
    const html = readSrc('src/index.html').replace(/<script[\s\S]*?<\/script>/g, '');
    document.body.innerHTML = html.replace(/<!doctype html>|<html[^>]*>|<\/html>|<head>[\s\S]*?<\/head>|<body>/gi, '');

    win.electronAPI = {
      setDirty: () => {},
      pluginAPI: { list: async () => PLUGIN_LIST },
    };

    // state.js 在 import 期抓取 DOM 引用，必须先清缓存再重新加载，
    // 否则会拿到模块初始化时那份（body 已被 beforeEach 清空的）dom 引用。
    // 统一用 require：babel 会把本文件转成 CJS，require 与被测模块内部
    // 走同一个缓存；原生 dynamic import 会绕开 require.cache 拿到另一份实例。
    for (const key of Object.keys(require.cache)) {
      if (key.includes(`${path.sep}src${path.sep}renderer${path.sep}`)
        || key.includes(`${path.sep}src${path.sep}editor${path.sep}`)) {
        delete require.cache[key];
      }
    }
    const { showSingerSelectDialog } = require('../src/renderer/projectManager.js');
    // 与 projectManager 共用同一份 state.js 模块实例：
    // 在它之后 require，命中的是它加载时放进缓存的那份。
    const { trackManager } = require('../src/renderer/state.js');
    // 锁定 locale：全量跑时别的测试文件可能已把语言切成 zh-CN，
    // 那样按钮文案会变，按文本找按钮就不可靠了。
    require('../src/i18n/index.js').setLocale('en');
    showSingerSelectDialog(null);

    // 等插件清单 IPC 到达、分区列表渲染出来
    await new Promise((r) => setTimeout(r, 30));
    // 选中 trackKind -> 叠加"创建插件轨道"对话框
    clickByText(win, '拼接音源·精简示例拼接后端 v1.0.0');
    await new Promise((r) => setTimeout(r, 30));
    expect(overlayCount(), '此时应有两层对话框').to.equal(2);

    // 点"创建轨道"（locale 已锁定为 en）
    clickByText(win, 'Create Track');
    await new Promise((r) => setTimeout(r, 30));
    return trackManager;
  }

  let win;

  beforeEach(() => {
    win = global.window;
    document.body.innerHTML = '';
    delete win.electronAPI;
  });

  it('插件建轨成功后，选择歌手 + 创建插件轨道两层对话框全部关闭', async () => {
    const trackManager = await runCreateTrackFlow(win);

    // 轨道确实建出来了
    expect(trackManager.getSingers().length).to.equal(1);
    expect(trackManager.getSingers()[0].trackName).to.equal('拼接音源·精简');
    expect(trackManager.getSingers()[0].backend.type).to.equal('plugin');

    // 内层"创建插件轨道" + 外层"选择歌手"都必须消失，
    // 否则外层会重新盖住主窗口（这正是用户报的"提示窗不自动消失"）。

    // 内层"创建插件轨道" + 外层"选择歌手"都必须消失，
    // 否则外层会重新盖住主窗口（这正是用户报的"提示窗不自动消失"）。
    expect(overlayCount(), '建轨后不应残留任何对话框遮罩').to.equal(0);
  });

  it('外层对话框由 onCreated 主动关闭（不依赖内层close 的副作用）', () => {
    const src = readSrc('src/renderer/projectManager.js');
    const start = src.indexOf('export function showSingerSelectDialog');
    expect(start).to.be.greaterThan(-1);
    const body = src.slice(start, src.indexOf('\n}\n', start));
    expect(body).to.include('closeSelf');
    expect(body).to.include('dialogRef = createDialog(');
    // closeSelf 必须在 markDirty / refreshAll 之前，避免留下"遮罩还在、
    // 列表已更新"的中间态
    expect(body.indexOf('closeSelf();')).to.be.lessThan(body.indexOf('markDirty();'));
  });
});