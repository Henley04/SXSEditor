'use strict';
/**
 * 传输区进度条：常驻 + 位置不随状态变化。
 *
 * 现场（用户报告）：等待推理时缩放/横向滚动，进度指示会"固定在屏幕上"。
 * 播放头那一半由 test/playheadRedraw.test.js 覆盖；这里管工具栏里的进度条本身：
 *
 * 旧实现有两处会让它"自己动位置"：
 *   · 空闲时 `.transport-status { display: none }` —— 整块塌陷，两侧控件复位；
 *   · 等待推理（百分比未知）时 `transportProgress.hidden = true` —— 轨道被拿掉，
 *     右侧内容整体右移。
 * 两者都发生在"任务状态变化"而不是"窗口尺寸变化"时，看起来就是位置自动更改。
 *
 * 现在：容器固定宽度、始终在布局里；轨道始终显示；百分比未知时只更新文本，
 * 填充宽度保持原值（进度不倒退显示）。
 */
const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.join(__dirname, '..');
const readSrc = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

describe('传输区进度条 — 常驻且位置稳定', () => {
  it('index.html 的进度轨道不再带 hidden 属性', () => {
    const html = readSrc('src/index.html');
    expect(html).to.match(/<div id="transport-progress" class="transport-progress">/);
    expect(html).to.not.match(/id="transport-progress"[^>]*\shidden\b/);
  });

  it('index.css 默认 display:flex + 固定宽度，不再靠 .active 才显示', () => {
    const css = readSrc('src/index.css');
    const block = css.slice(css.indexOf('.transport-status {'), css.indexOf('.transport-status-text {'));
    expect(block).to.include('display: flex;');
    expect(block).to.match(/width:\s*\d+px;/);
    expect(block).to.not.match(/max-width:\s*\d+px;/);
    expect(css, '.transport-status.active 不应再控制显隐').to.not.match(/\.transport-status\.active\s*\{[^}]*display:\s*none/);
    // 旧规则在窄屏直接砍掉进度条（display:none），改完之后只允许压缩宽度
    expect(css).to.not.match(/\.transport-progress\s*\{\s*display:\s*none/);
  });

  it('transport.js 不再切换进度轨道的 hidden', () => {
    const src = readSrc('src/renderer/transport.js');
    expect(src).to.not.match(/transportProgress\.hidden\s*=/);
  });

  describe('行为：百分比未知时不清空、不隐藏', () => {
    let transport;
    let dom;

    before(() => {
      document.body.innerHTML = `
        <button id="btn-play"></button>
        <button id="btn-pause"></button>
        <button id="btn-stop"></button>
        <div id="transport-status" class="transport-status">
          <span id="transport-status-text" class="transport-status-text"></span>
          <div id="transport-progress" class="transport-progress">
            <div id="transport-progress-fill" class="transport-progress-fill"></div>
          </div>
        </div>
      `;
      ({ dom } = require('../src/renderer/state.js'));
      // dom 的节点引用在首个 import state.js 的用例里就固定了；本文件可能不是第一个，
      // 按 id 重新绑定一次（只动测试用的假 DOM，不影响产品代码）。
      dom.btnPlay = document.getElementById('btn-play');
      dom.btnPause = document.getElementById('btn-pause');
      dom.btnStop = document.getElementById('btn-stop');
      dom.transportStatus = document.getElementById('transport-status');
      dom.transportStatusText = document.getElementById('transport-status-text');
      dom.transportProgress = document.getElementById('transport-progress');
      dom.transportProgressFill = document.getElementById('transport-progress-fill');
      transport = require('../src/renderer/transport.js');
    });

    it('有百分比：填充到对应宽度，轨道可见', () => {
      transport.setTransportProgress('推理中', 40);
      expect(dom.transportProgressFill.style.width).to.equal('40%');
      expect(dom.transportProgress.hidden).to.equal(false);
    });

    it('等待推理（percent=null）：填充停在原处，不隐藏轨道', () => {
      transport.setTransportProgress('等待推理中', null);
      expect(dom.transportProgressFill.style.width, '等待态不应把进度打回 0').to.equal('40%');
      expect(dom.transportProgress.hidden, '等待态不应隐藏轨道').to.equal(false);
      expect(dom.transportStatusText.textContent).to.include('等待');
    });

    it('流程结束：清文本与填充，但容器与轨道仍在布局里', () => {
      transport.clearTransportStatus();
      expect(dom.transportStatusText.textContent).to.equal('');
      expect(dom.transportProgressFill.style.width).to.equal('0%');
      expect(dom.transportProgress.hidden).to.equal(false);
      expect(dom.transportStatus.classList.contains('active')).to.equal(false);
    });
  });
});
