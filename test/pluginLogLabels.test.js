/**
 * 插件管理器「活动日志」的事件码 → i18n 键映射必须每个都能解析。
 *
 * 走查时发现：中英词典对称测试只保证两套词典键名一致，不保证 eventLabel
 * 引用的键真的存在。一旦漏一个，界面会直接显示原始 key（例如
 * "plugins.logEventPluginInstall"），而不是中文事件名。这里把映射表与词典
 * 对起来锁死，本轮新增的 6 个事件码单独点名。
 */
const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const managerSrc = read('pluginManager/index.js');
const labelBody = managerSrc.slice(
  managerSrc.indexOf('function eventLabel'),
  managerSrc.indexOf('function renderCount'),
);
const mappedKeys = [...labelBody.matchAll(/'([^']+\.logEvent[A-Za-z]+)'/g)].map((m) => m[1]);

describe('插件活动日志事件码 → i18n 键', () => {
  it('eventLabel 至少映射 25 个事件码', () => {
    expect(mappedKeys.length).to.be.at.least(25);
  });

  it('本轮新增的 6 个事件码都有映射', () => {
    for (const code of ['market-install', 'trust-update', 'plugin-install',
      'plugin-self-update', 'plugin-cycle', 'service-gone']) {
      expect(labelBody, `缺事件码 ${code}`).to.include(`'${code}':`);
    }
  });

  for (const lang of ['zh-CN', 'en']) {
    it(`${lang} 词典包含 eventLabel 引用的全部键`, () => {
      const dict = read(`i18n/${lang}.js`);
      const missing = mappedKeys.filter((key) => {
        const leaf = key.split('.').pop();
        return !new RegExp(`\\b${leaf}\\s*:`).test(dict);
      });
      expect(missing, `${lang} 缺键: ${missing.join(', ')}`).to.deep.equal([]);
    });
  }
});
