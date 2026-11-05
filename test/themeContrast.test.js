'use strict';
/**
 * 主题对比度回归测试（M6 第 3 段：a11y）。
 *
 * 为什么要测这个：主题 token 是九个窗口共用的，改一个弱化文字色就能让某个
 * 主题的正文掉到 3:1。截图看不出来，公式看得出来。
 *
 * 这里不只断言"当前这套色值算出来是 X"，还断言**所有主题的所有组合都过 AA**。
 * 以后谁调色，只要踩线就会有测试失败，而不是等用户抱怨看不清。
 */

const assert = require('node:assert');
const audit = require('../scripts/audit-contrast.js');

describe('主题对比度审计', () => {
  describe('颜色解析', () => {
    it('解析 6 位与 3 位十六进制', () => {
      assert.deepStrictEqual(audit.parseColor('#ffffff'), { r: 255, g: 255, b: 255, a: 1 });
      assert.deepStrictEqual(audit.parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
      assert.deepStrictEqual(audit.parseColor('#3FB8C9'), { r: 63, g: 184, b: 201, a: 1 });
    });

    it('解析 rgba 并保留 alpha', () => {
      assert.deepStrictEqual(audit.parseColor('rgba(42, 52, 65, 0.35)'), { r: 42, g: 52, b: 65, a: 0.35 });
    });

    it('解析不了的值返回 null，不抛错', () => {
      assert.strictEqual(audit.parseColor('linear-gradient(180deg, #fff, #000)'), null);
      assert.strictEqual(audit.parseColor(''), null);
      assert.strictEqual(audit.parseColor(undefined), null);
    });
  });

  describe('对比度公式', () => {
    it('黑白是 21:1', () => {
      const ratio = audit.contrast(audit.parseColor('#000000'), audit.parseColor('#ffffff'));
      assert.ok(Math.abs(ratio - 21) < 0.01, `期望 21，实际 ${ratio}`);
    });

    it('同色是 1:1', () => {
      const ratio = audit.contrast(audit.parseColor('#3fb8c9'), audit.parseColor('#3fb8c9'));
      assert.ok(Math.abs(ratio - 1) < 1e-9);
    });

    it('前景带 alpha 时先合成到背景上再算', () => {
      const panel = audit.parseColor('#ffffff');
      const half = audit.composite(audit.parseColor('rgba(0, 0, 0, 0.5)'), panel);
      // 50% 黑叠白 = #808080 附近，对比度约 3.95
      assert.strictEqual(half.a, 1);
      assert.ok(Math.abs(half.r - 128) <= 1);
      const ratio = audit.contrast(half, panel);
      assert.ok(ratio > 3.8 && ratio < 4.1, `实际 ${ratio}`);
    });
  });

  describe('token 解析', () => {
    it('展开 var() 到最终色值', () => {
      const tokens = { '--a': 'var(--b)', '--b': 'var(--c)', '--c': '#123456' };
      assert.strictEqual(audit.resolveToken('--a', tokens), '#123456');
    });

    it('var() 带兜底时用兜底值', () => {
      const tokens = { '--a': 'var(--missing, #abcdef)' };
      assert.strictEqual(audit.resolveToken('--a', tokens), '#abcdef');
    });

    it('环不会把脚本挂死', () => {
      const tokens = { '--a': 'var(--b)', '--b': 'var(--a)' };
      // 解不出来就返回空串（调用方按"缺失"处理），而不是抛错或死循环。
      assert.ok(!audit.resolveToken('--a', tokens));
    });

    it('能从 CSS 文本里抽 token', () => {
      const out = audit.parseCssTokens(':root { --x: #000; --y: var(--x); }');
      assert.strictEqual(out['--x'], '#000');
      assert.strictEqual(out['--y'], 'var(--x)');
    });
  });

  describe('内置主题', () => {
    const result = audit.runAudit();

    it('四个内置主题 + 兜底都被审到', () => {
      const ids = result.themes.map((t) => t.id);
      for (const id of ['acg', 'dark-aurora', 'light-paper', 'midnight-amber', 'fallback']) {
        assert.ok(ids.includes(id), `缺少主题 ${id}`);
      }
    });

    it('没有缺 token 或解析不了的组合', () => {
      const bad = result.rows.filter((r) => r.status === 'missing' || r.status === 'unparsed');
      assert.deepStrictEqual(
        bad.map((r) => `${r.theme}:${r.fg} on ${r.bg}`),
        [],
        '有组合取不到色值 —— 多半是新增了 token 却没写进所有主题',
      );
    });

    it('没有低于 AA 的组合', () => {
      const bad = result.rows.filter((r) => r.status === 'fail' || r.status === 'warn');
      const detail = bad.map((r) => `${r.theme} ${r.label} ${Number(r.ratio).toFixed(2)}:1`).join('; ');
      assert.deepStrictEqual(bad.map((r) => r.label), [], detail || '');
    });

    it('每个主题审的组合数一致（避免某个主题被漏审）', () => {
      const counts = new Map();
      for (const row of result.rows) counts.set(row.theme, (counts.get(row.theme) || 0) + 1);
      assert.strictEqual(new Set(counts.values()).size, 1, `各主题组合数不一致：${[...counts]}`);
      assert.strictEqual(counts.get('acg'), audit.PAIRS.length);
    });
  });
});
