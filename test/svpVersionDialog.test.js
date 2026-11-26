'use strict';
/**
 * 「另存为 .svp」版本询问对话框。
 *
 * 用户决策：SV1 / SV2 都是 .svp 但 schema 不兼容，**只有另存为 .svp 时询问**
 * 按什么版本行为保存。这里锁住三选一的 DOM 行为（默认沿用源版本）、取消语义、
 * 对话框关闭不残留，以及六个新增文案中英同步。就地 Ctrl+S 不弹窗由
 * projectManager.saveProject 的路径保证（不经过 saveProjectAs），另见
 * pluginSvpVersion.test.js 的「不传 svpVersion 默认 keep」端到端用例。
 */

const { expect } = require('chai');

let projectManager;
let t;
let zh;
let en;

const KEYS = [
  'svpVersionTitle', 'svpVersionDesc', 'svpVersionKeep',
  'svpVersion2', 'svpVersion1Compat', 'svpVersionDowngradeWarn',
];

describe('另存为 .svp — 版本行为询问对话框', () => {
  before(async () => {
    projectManager = await import('../src/renderer/projectManager.js');
    t = (await import('../src/i18n/index.js')).t;
    zh = (await import('../src/i18n/zh-CN.js')).default;
    en = (await import('../src/i18n/en.js')).default;
  });

  beforeEach(() => {
    document.body.innerHTML = '';
  });

  /** 打开对话框并取出 DOM 句柄；createDialog 把 overlay append 到 body 末尾。 */
  function open() {
    const pending = projectManager.showSvpVersionDialog();
    const overlay = document.body.lastElementChild;
    return {
      pending,
      overlay,
      radios: [...overlay.querySelectorAll('input[type="radio"]')],
      buttons: [...overlay.querySelectorAll('button')],
    };
  }

  it('六个文案 key 中英同步且非空', () => {
    for (const k of KEYS) {
      expect(zh.main[k], `zh-CN ${k}`).to.be.a('string').and.not.empty;
      expect(en.main[k], `en ${k}`).to.be.a('string').and.not.empty;
    }
  });

  it('三选一，默认「沿用源版本」；标题、说明与降级警示都来自 i18n', async () => {
    const { pending, overlay, radios, buttons } = open();
    expect(radios.map((r) => r.value)).to.deep.equal(['keep', 'sv2', 'sv1']);
    expect(radios.find((r) => r.checked).value).to.equal('keep');
    expect(overlay.textContent).to.contain(t('main.svpVersionTitle'));
    expect(overlay.textContent).to.contain(t('main.svpVersionDesc'));
    expect(overlay.textContent).to.contain(t('main.svpVersionKeep'));
    expect(overlay.textContent).to.contain(t('main.svpVersion2'));
    expect(overlay.textContent).to.contain(t('main.svpVersion1Compat'));
    expect(overlay.textContent).to.contain(t('main.svpVersionDowngradeWarn'));
    expect(buttons).to.have.length(2); // 取消 / 保存
    buttons[0].click(); // 取消
    expect(await pending).to.equal(null);
  });

  it('选中 SV2 / SV1 兼容后保存返回对应枚举值', async () => {
    {
      const { pending, radios, buttons } = open();
      radios[1].checked = true;
      buttons[1].click();
      expect(await pending).to.equal('sv2');
    }
    {
      const { pending, radios, buttons } = open();
      radios[2].checked = true;
      buttons[1].click();
      expect(await pending).to.equal('sv1');
    }
  });

  it('默认选项保存返回 keep，且对话框关闭后不残留 radio', async () => {
    const { pending, buttons } = open();
    buttons[1].click();
    expect(await pending).to.equal('keep');
    expect(document.querySelectorAll('input[name="svp-version"]')).to.have.length(0);
  });
});

/**
 * 触发条件：只有「另存为 .svp」才询问版本行为。
 *
 * 实机里 GTK 原生保存框在无窗口管理器的 Xvfb 下收不到注入事件，无法把整条
 * UI 链路跑通；这里在 jsdom 里走真实的 saveProjectAs()，只把两个外部依赖换成
 * 桩：原生保存对话框返回指定路径、createDialog 自动点主按钮（记录标题）。
 * 故意不提供写盘依赖，让 _writeProjectTo 抛错 —— 我们只关心「有没有弹版本框」
 * 这个条件；同时用 result.error 断言流程确实走到了写盘，排除「对话框之前就
 * 提前返回」造成的假通过。
 */
describe('saveProjectAs — 版本询问只在另存为 .svp 时出现', () => {
  let pm;
  let ui;
  let t2;

  before(async () => {
    pm = await import('../src/renderer/projectManager.js');
    ui = await import('../src/renderer/uiControls.js');
    t2 = (await import('../src/i18n/index.js')).t;
  });

  async function runSaveAs(filePath) {
    const titles = [];
    const origCreateDialog = ui.createDialog;
    const origAPI = window.electronAPI;
    const origConsoleError = console.error;
    document.body.innerHTML = '';

    ui.createDialog = (opts) => {
      titles.push(opts.title);
      const overlay = document.createElement('div');
      overlay.style.zIndex = '10000';
      document.body.appendChild(overlay);
      // showSvpVersionDialog 靠 contentElement 里的 radio 取值，必须真的挂进 DOM。
      if (opts.contentElement) overlay.appendChild(opts.contentElement);
      const primary = (opts.buttons || []).find((b) => b.type === 'primary');
      if (primary) queueMicrotask(() => primary.onClick());
      return { overlay, dialog: overlay, close: () => overlay.remove() };
    };
    window.electronAPI = {
      showSaveDialog: async () => ({ canceled: false, filePath }),
      // 没有 saveFile / pluginHost：_writeProjectTo 必然抛错，被 saveProjectAs
      // 捕获后返回 { saved:false, error }。这个错误是预期结果，静音它的日志，
      // 避免污染 CI 输出；但保留在 result 里用于断言流程确实走到了写盘。
    };
    console.error = () => {};

    let result;
    try {
      result = await pm.saveProjectAs();
    } finally {
      ui.createDialog = origCreateDialog;
      window.electronAPI = origAPI;
      console.error = origConsoleError;
    }
    return { titles, result };
  }

  /** 三个用例共用：确实进入了另存为流程、确实走到了写盘（而非中途取消）。 */
  function assertReachedWrite({ titles, result }) {
    expect(titles, '保存选项对话框').to.include(t2('main.saveProjectOptions'));
    expect(result, '写盘阶段').to.have.property('error').that.is.a('string').and.not.empty;
    expect(result.canceled, '未被取消').to.equal(false);
  }

  it('.svp：保存选项之后弹出版本询问，且两框顺序正确', async () => {
    const out = await runSaveAs('/tmp/probe.svp');
    assertReachedWrite(out);
    expect(out.titles).to.deep.equal([
      t2('main.saveProjectOptions'),
      t2('main.svpVersionTitle'),
    ]);
  });

  it('.vsqx（同为插件格式但不是 .svp）：不弹版本询问', async () => {
    const out = await runSaveAs('/tmp/probe.vsqx');
    assertReachedWrite(out);
    expect(out.titles).to.deep.equal([t2('main.saveProjectOptions')]);
    expect(out.titles).to.not.include(t2('main.svpVersionTitle'));
  });

  it('.sxsproj（宿主原生）：不弹版本询问', async () => {
    const out = await runSaveAs('/tmp/probe.sxsproj');
    assertReachedWrite(out);
    expect(out.titles).to.not.include(t2('main.svpVersionTitle'));
  });
});
