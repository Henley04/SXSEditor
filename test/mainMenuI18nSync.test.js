/**
 * 主进程菜单文案走的是 src/main/locale.js（CJS），渲染层走 src/i18n/*.js（ESM）。
 * 两套字典必须同步：只在渲染层加键时，菜单会静默显示成 "menu.xxx" 原始键名，
 * 而且不报任何错 —— 只有打开菜单才看得见。这里把「菜单模板用到的键」与
 * 主进程字典绑定起来，避免同类遗漏再次发生。
 */
const { expect } = require('chai');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function resolveKey(dict, dotted) {
  return dotted.split('.').reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), dict);
}

describe('主进程菜单文案跨字典同步', () => {
  const source = fs.readFileSync(path.join(ROOT, 'src/main/windowManager.js'), 'utf8');
  const keys = [...new Set(
    [...source.matchAll(/\bt\(['"](menu\.[A-Za-z0-9_]+)['"]/g)].map((m) => m[1]),
  )].sort();
  const mainLocales = require('../src/main/locale.js').getMainLocales();

  it('能从菜单模板提取到本轮新增的导出 MIDI 项', () => {
    expect(keys.length).to.be.greaterThan(10);
    expect(keys).to.include('menu.exportMidi');
  });

  for (const locale of ['zh-CN', 'en']) {
    it(`${locale}：主进程字典覆盖所有菜单键，且不回退成键名`, () => {
      for (const key of keys) {
        const value = resolveKey(mainLocales[locale], key);
        expect(value, `${locale} 缺少 ${key}`).to.be.a('string').and.not.empty;
        expect(value, `${locale} 的 ${key} 未翻译`).to.not.equal(key);
      }
    });
  }

  it('主进程与渲染层对同名 menu 键的译文一致', () => {
    // mocha 里动态 import() 会被 babel 降级为 require()，直接 require 即可；
    // 字典是无状态模块，不需要跨模块注册表一致。
    const zh = require('../src/i18n/zh-CN.js').default;
    const en = require('../src/i18n/en.js').default;
    const renderer = { 'zh-CN': zh, en };

    for (const locale of ['zh-CN', 'en']) {
      for (const key of keys) {
        // 渲染层没有用到的菜单键无需在渲染层字典里存在；两边都有的必须同义。
        const rendererValue = resolveKey(renderer[locale], key);
        if (rendererValue === undefined) continue;
        expect(resolveKey(mainLocales[locale], key), `${locale} 的 ${key} 两处译文不一致`)
          .to.equal(rendererValue);
      }
    }
    // 本轮新增项两侧都必须存在。
    expect(resolveKey(zh, 'menu.exportMidi')).to.equal('导出项目为 MIDI...');
    expect(resolveKey(en, 'menu.exportMidi')).to.equal('Export Project as MIDI...');
  });
});
