const { expect } = require('chai');

const {
  attachHoverTip,
  hideHoverTip,
  getHoverTipTarget,
  installHoverTipGlobalDismiss,
} = require('../src/fragmentEditor/paramTooltip.js');

const SHOW_DELAY = 120;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 提示卡是懒创建的：没显示过就不存在，判"可见"必须先判空。 */
function tipVisible() {
  const tip = document.getElementById('pp-hover-tip');
  return !!tip && tip.classList.contains('visible');
}

function makeTarget() {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = '平滑强度';
  document.body.appendChild(el);
  return el;
}

describe('paramTooltip（音色参数悬浮提示卡）', () => {
  afterEach(() => {
    hideHoverTip();
    document.body.innerHTML = '';
  });

  it('悬浮超过延迟后显示提示卡，并写入标题/说明', async () => {
    const el = makeTarget();
    attachHoverTip(el, () => ({
      title: '平滑强度',
      meta: 'F0 平滑 · 范围 0–100%',
      desc: 'Savitzky-Golay 保形平滑',
    }));

    el.dispatchEvent(new window.MouseEvent('mouseenter'));
    expect(document.querySelector('.pp-tip.visible')).to.equal(null); // 尚未到延迟

    await wait(SHOW_DELAY + 60);
    const tip = document.getElementById('pp-hover-tip');
    expect(tip).to.not.equal(null);
    expect(tip.classList.contains('visible')).to.equal(true);
    expect(tip.querySelector('.pp-tip-title').textContent).to.equal('平滑强度');
    expect(tip.querySelector('.pp-tip-meta').textContent).to.contain('范围 0–100%');
    expect(tip.querySelector('.pp-tip-desc').textContent).to.equal('Savitzky-Golay 保形平滑');
  });

  it('挂接时补上 aria-describedby，读屏能读到说明', () => {
    const el = makeTarget();
    attachHoverTip(el, () => ({ title: '频谱插值', desc: 'x' }));
    expect(el.getAttribute('aria-describedby')).to.equal('pp-hover-tip');
  });

  it('移开 / 按下鼠标立即隐藏', async () => {
    const el = makeTarget();
    attachHoverTip(el, () => ({ title: 'A', desc: 'B' }));

    el.dispatchEvent(new window.MouseEvent('mouseenter'));
    await wait(SHOW_DELAY + 60);
    expect(document.getElementById('pp-hover-tip').classList.contains('visible')).to.equal(true);

    el.dispatchEvent(new window.MouseEvent('mouseleave'));
    expect(document.getElementById('pp-hover-tip').classList.contains('visible')).to.equal(false);
    expect(getHoverTipTarget()).to.equal(null);
  });

  it('提示卡还没出现就移开，不会延迟弹出（竞态）', async () => {
    const el = makeTarget();
    attachHoverTip(el, () => ({ title: 'A', desc: 'B' }));

    el.dispatchEvent(new window.MouseEvent('mouseenter'));
    el.dispatchEvent(new window.MouseEvent('mouseleave'));
    await wait(SHOW_DELAY + 60);
    expect(tipVisible()).to.equal(false);
  });

  it('每次显示都重新取内容，切语言 / 改数值后文案跟着变', async () => {
    const el = makeTarget();
    let label = '旧文案';
    attachHoverTip(el, () => ({ title: label, desc: 'D' }));

    el.dispatchEvent(new window.MouseEvent('mouseenter'));
    await wait(SHOW_DELAY + 60);
    expect(document.querySelector('.pp-tip-title').textContent).to.equal('旧文案');

    label = '新文案';
    el.dispatchEvent(new window.MouseEvent('mouseleave'));
    el.dispatchEvent(new window.MouseEvent('mouseenter'));
    await wait(SHOW_DELAY + 60);
    expect(document.querySelector('.pp-tip-title').textContent).to.equal('新文案');
  });

  it('缺少 meta / desc 时对应行隐藏，不显示空行', async () => {
    const el = makeTarget();
    attachHoverTip(el, () => ({ title: '仅标题' }));
    el.dispatchEvent(new window.MouseEvent('mouseenter'));
    await wait(SHOW_DELAY + 60);

    const tip = document.getElementById('pp-hover-tip');
    expect(tip.querySelector('.pp-tip-meta').style.display).to.equal('none');
    expect(tip.querySelector('.pp-tip-desc').style.display).to.equal('none');
  });

  it('builder 返回空内容时不弹提示', async () => {
    const el = makeTarget();
    attachHoverTip(el, () => null);
    el.dispatchEvent(new window.MouseEvent('mouseenter'));
    await wait(SHOW_DELAY + 60);
    expect(tipVisible()).to.equal(false);
  });

  it('Esc 与滚动都会收起提示卡', async () => {
    installHoverTipGlobalDismiss();
    const el = makeTarget();
    attachHoverTip(el, () => ({ title: 'A', desc: 'B' }));

    el.dispatchEvent(new window.MouseEvent('mouseenter'));
    await wait(SHOW_DELAY + 60);
    expect(document.getElementById('pp-hover-tip').classList.contains('visible')).to.equal(true);

    window.dispatchEvent(new window.Event('wheel'));
    expect(document.getElementById('pp-hover-tip').classList.contains('visible')).to.equal(false);

    el.dispatchEvent(new window.MouseEvent('mouseenter'));
    await wait(SHOW_DELAY + 60);
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.getElementById('pp-hover-tip').classList.contains('visible')).to.equal(false);
  });
});
