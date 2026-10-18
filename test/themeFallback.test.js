const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');

/**
 * U2 回归测试：主题变量兜底的两份来源必须一致。
 *
 * 一份是 CSS 真源 src/themes/themeFallback.css（随 common.css 打包，覆盖
 * "JS 还没执行"的窗口期），另一份是 src/themes/themeBootstrap.js 里内联注入的
 * <style>（更早，但同优先级、顺序在 CSS 之前）。两者一旦漂移，用户会看到
 * "闪一下别的颜色"。这里把漂移变成 CI 失败。
 */
describe('theme fallback tokens (U2)', function () {
  const rootDir = path.resolve(__dirname, '..');
  const cssPath = path.join(rootDir, 'src/themes/themeFallback.css');
  const bootstrapPath = path.join(rootDir, 'src/themes/themeBootstrap.js');

  function parseVars(text) {
    const out = new Map();
    const re = /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi;
    let m;
    while ((m = re.exec(text)) !== null) {
      out.set(m[1], m[2].trim().replace(/\s+/g, ' '));
    }
    return out;
  }

  it('themeFallback.css 与 themeBootstrap.js 存在且可解析', function () {
    expect(fs.existsSync(cssPath), 'themeFallback.css 应存在').to.equal(true);
    expect(fs.existsSync(bootstrapPath), 'themeBootstrap.js 应存在').to.equal(true);
  });

  it('CSS 兜底里的每个变量在 JS 兜底里取值一致', function () {
    if (!fs.existsSync(cssPath) || !fs.existsSync(bootstrapPath)) this.skip();
    const css = parseVars(fs.readFileSync(cssPath, 'utf8'));
    const js = parseVars(fs.readFileSync(bootstrapPath, 'utf8'));
    expect(css.size).to.be.greaterThan(30);

    const mismatches = [];
    const missing = [];
    for (const [k, v] of css) {
      // select-arrow 在 JS 里是转义后的 data URI，格式差异不参与比对
      if (k === '--select-arrow') continue;
      if (!js.has(k)) { missing.push(k); continue; }
      if (js.get(k) !== v) mismatches.push(`${k}: css=${v} js=${js.get(k)}`);
    }
    expect(missing, `JS 兜底缺少变量: ${missing.join(', ')}`).to.be.an('array').that.is.empty;
    expect(mismatches, `取值不一致: ${mismatches.join(' | ')}`).to.be.an('array').that.is.empty;
  });

  it('common.css 必须在组件样式之前引入兜底', function () {
    const common = fs.readFileSync(path.join(rootDir, 'src/common.css'), 'utf8');
    const iFallback = common.indexOf('themeFallback.css');
    const iComponents = common.indexOf('components.css');
    expect(iFallback).to.be.greaterThan(-1);
    // @import 必须排在其它规则之前，兜底同样要早于组件样式
    expect(iFallback).to.be.lessThan(iComponents);
  });
});
