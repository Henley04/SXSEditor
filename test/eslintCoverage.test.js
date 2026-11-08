const { expect } = require('chai');
const fs = require('node:fs');
const path = require('node:path');

/**
 * ESLint 分档覆盖守护。
 *
 * eslint.config.cjs 是"基础档 + 若干 files 列表"。基础档只给 es2022 globals，
 * 所以任何**没有显式登记**的文件都会掉进基础档：CJS 文件里的 require / module /
 * console 全被判 no-undef（3 条 error），`npm run lint` 直接非零退出。
 *
 * 这个坑已经在 CI 上踩过至少四次（fcpePitchDetector / ortRuntime / winml/** /
 * officialKeys.js），每次都是"新增一个共享模块、忘了往 files 列表里加一行"，
 * 而症状要到 push 之后才在 GitHub Actions 的 Lint 步骤炸出来（2026-11-07 的
 * run 272 就是这么红的）。这里把判定自动化：逐个文件问 eslint "你给它的配置里
 * 有没有 console 全局"，没有即说明掉进了基础档。
 */
describe('ESLint 分档覆盖', function () {
  this.timeout(120000);

  const ROOT = path.resolve(__dirname, '..');
  let ESLint = null;
  let eslint = null;

  before(async function () {
    try {
      ({ ESLint } = require('eslint'));
    } catch (err) {
      this.skip();
      return;
    }
    eslint = new ESLint({ cwd: ROOT });
  });

  /** 递归收集 .js（跳过 eslint 已 ignore 的目录，避免遍历 node_modules） */
  function walk(dir, out = []) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return out;
    }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (e.isFile() && e.name.endsWith('.js')) out.push(p);
    }
    return out;
  }

  it('用到 Node/CJS 全局的 .js 都在分档里（否则 CI Lint 必红）', async function () {
    if (!eslint) this.skip();
    const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts'))];
    expect(files.length).to.be.above(50);

    // 只检查"真的用到了 Node/CJS 全局"的文件：纯 es2022 的 ESM 文件掉进基础档
    // 不会报错，没必要为它制造噪音。这里盯的就是 run 272 那类回归 ——
    // 新增一个 CJS 模块但忘了登记，require/module/console 全被判 no-undef。
    const NEEDS = ['require', 'module', 'console', 'process', 'Buffer'];
    const offenders = [];
    for (const abs of files) {
      if (await eslint.isPathIgnored(abs)) continue;
      const src = fs.readFileSync(abs, 'utf-8');
      const used = NEEDS.filter((g) => new RegExp(`(^|[^\\w$.])${g}\\s*[.(\\[]`, 'm').test(src));
      if (used.length === 0) continue;
      const cfg = await eslint.calculateConfigForFile(abs);
      const globals = (cfg && cfg.languageOptions && cfg.languageOptions.globals) || {};
      const missing = used.filter((g) => globals[g] === undefined);
      if (missing.length > 0) {
        offenders.push(
          `${path.relative(ROOT, abs).replace(/\\/g, '/')} 用到了 ${missing.join(', ')}`,
        );
      }
    }

    expect(
      offenders,
      '下列文件用到了 Node/CJS 全局，但没有登记进 eslint.config.cjs 的任何 files 列表，'
      + '因此掉进只含 es2022 的基础档 —— `npm run lint` 会因 no-undef 非零退出'
      + '（CI 的 Lint 步骤挂在这里）：\n'
      + offenders.map((f) => `  - ${f}`).join('\n'),
    ).to.deep.equal([]);
  });

  it('官方公钥表是 CJS 且已登记（run 272 的 Lint 回归）', async function () {
    if (!eslint) this.skip();
    const abs = path.join(ROOT, 'src', 'shared', 'officialKeys.js');
    expect(fs.existsSync(abs)).to.equal(true);
    const cfg = await eslint.calculateConfigForFile(abs);
    expect(cfg.languageOptions.sourceType).to.equal('commonjs');
    // globals 包里 require/console 的取值是 false（= 只读），不是字符串
    expect(cfg.languageOptions.globals).to.have.property('require');
    expect(cfg.languageOptions.globals).to.have.property('console');
  });
});
