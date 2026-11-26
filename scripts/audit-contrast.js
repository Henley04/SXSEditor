#!/usr/bin/env node
'use strict';
/**
 * 主题对比度审计（M6 第 3 段：a11y）。
 *
 * 为什么要有这个脚本：对比度问题在截图里"看着还行"，在低亮度屏或强光下就是
 * 读不出来。而主题是可切换的，改一个 token 会影响九个窗口 —— 靠肉眼看九个窗口
 * 不现实，靠公式几毫秒就能给答案。
 *
 * 判据用 WCAG 2.1：
 *   · AA 正文 4.5:1，大字（≥18.66px 粗体 / ≥24px）3:1；
 *   · 非文本（边框、图标）3:1，本项目只审文字；
 *   · disabled 状态在 WCAG 里是豁免项，这里仍以 3:1 作为"最低可辨识"的下限。
 *
 * 用法：
 *   node scripts/audit-contrast.js            # 人类可读表格
 *   node scripts/audit-contrast.js --json     # 机器可读
 *   node scripts/audit-contrast.js --strict   # 有 warn 也返回 1（CI 用）
 */

const fs = require('node:fs');
const path = require('node:path');

const THEMES_DIR = path.join(__dirname, '..', 'src', 'themes', 'builtins');
const FALLBACK_CSS = path.join(__dirname, '..', 'src', 'themes', 'themeFallback.css');

const AA = 4.5;
const MIN = 3;

/** 需要审计的「前景 / 背景」组合。名字进报告，改这里就等于改判定范围。 */
const PAIRS = [
  { fg: '--fg-primary', bg: '--bg-app', label: '正文 / 应用背景', size: 'normal' },
  { fg: '--fg-primary', bg: '--bg-panel', label: '正文 / 面板', size: 'normal' },
  { fg: '--fg-secondary', bg: '--bg-panel', label: '次要文字 / 面板', size: 'normal' },
  { fg: '--fg-muted', bg: '--bg-panel', label: '弱化文字 / 面板', size: 'normal' },
  { fg: '--fg-muted', bg: '--bg-app', label: '弱化文字 / 应用背景', size: 'normal' },
  { fg: '--fg-disabled', bg: '--bg-button', label: '禁用文字 / 按钮底', size: 'disabled' },
  { fg: '--fg-primary', bg: '--bg-input', label: '输入框文字', size: 'normal' },
  { fg: '--button-primary-fg', bg: '--button-primary-bg', label: '主按钮文字', size: 'normal' },
  { fg: '--fg-on-accent', bg: '--accent', label: '强调底上的文字', size: 'normal' },
  // `--accent` 是"填充色"（选中下划线、聚焦环、软色底），不是文字色。
  // 文字用 `--accent-fg`：浅色主题里 #3fb8c9 那种青只在填充时好看，当正文只有 2.2:1。
  // 这一对原来按 `--accent` 审，等于在审一个从不该出现的组合；改审真正在用的 token。
  { fg: '--accent-fg', bg: '--bg-panel', label: '强调文字 / 面板', size: 'normal' },
  { fg: '--accent-fg', bg: '--bg-app', label: '强调文字 / 应用背景', size: 'normal' },
  { fg: '--fg-on-danger', bg: '--bg-button-danger', label: '危险按钮文字', size: 'normal' },
  // 语义色当文字。--success/--warning/--danger 是填充色：浅色主题里绿色 2:1、
  // 黄色 1.5:1，压在 soft 底上更糟。文字一律走 -fg 变体，这里就审这一组。
  { fg: '--success-fg', bg: '--success-soft', label: '成功文字 / soft 底', size: 'normal' },
  { fg: '--warning-fg', bg: '--warning-soft', label: '警告文字 / soft 底', size: 'normal' },
  { fg: '--danger-fg', bg: '--danger-soft', label: '危险文字 / soft 底', size: 'normal' },
  { fg: '--success-fg', bg: '--bg-panel', label: '成功文字 / 面板', size: 'normal' },
  { fg: '--warning-fg', bg: '--bg-panel', label: '警告文字 / 面板', size: 'normal' },
  { fg: '--danger-fg', bg: '--bg-panel', label: '危险文字 / 面板', size: 'normal' },
  { fg: '--tooltip-fg', bg: '--tooltip-bg', label: '浮层提示文字', size: 'normal' },
];

// ------------------------------------------------------------ 颜色解析

function parseHex(value) {
  const hex = value.trim();
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(hex)) return null;
  const body = hex.slice(1);
  const full = body.length === 3 ? body.split('').map((c) => c + c).join('') : body;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a: 1,
  };
}

function parseRgba(value) {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)$/i.exec(value.trim());
  if (!m) return null;
  return {
    r: Number(m[1]), g: Number(m[2]), b: Number(m[3]),
    a: m[4] === undefined ? 1 : Number(m[4]),
  };
}

function parseColor(value) {
  if (typeof value !== 'string') return null;
  return parseHex(value) || parseRgba(value);
}

/** 把带 alpha 的前景叠到不透明背景上（主题里大量 rgba 文字/边框）。 */
function composite(fg, bg) {
  if (fg.a >= 1) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
  const a = fg.a;
  return {
    r: Math.round(fg.r * a + bg.r * (1 - a)),
    g: Math.round(fg.g * a + bg.g * (1 - a)),
    b: Math.round(fg.b * a + bg.b * (1 - a)),
    a: 1,
  };
}

function channel(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(c) {
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

function contrast(fg, bg) {
  const l1 = luminance(fg);
  const l2 = luminance(bg);
  const light = Math.max(l1, l2);
  const dark = Math.min(l1, l2);
  return (light + 0.05) / (dark + 0.05);
}

// ------------------------------------------------------------ token 解析

/** 递归展开 `var(--x)`，最多 12 层（超过说明主题里有环）。 */
function resolveToken(name, tokens, depth = 0) {
  if (depth > 12) return null;
  const raw = tokens[name];
  if (raw === undefined) return null;
  const m = /^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/.exec(String(raw).trim());
  if (!m) return String(raw).trim();
  const next = resolveToken(m[1], tokens, depth + 1);
  return next === null ? (m[2] || '').trim() : next;
}

/**
 * 从 themeFallback.css 的 `:root` 块里抽 token。
 * 只认 `--name: value;` 这一种形状 —— 主题文件的 tokens 是扁平 map，
 * fallback 是 CSS，两边都要能读。
 */
function parseCssTokens(text) {
  const out = {};
  const re = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[2].trim();
  return out;
}

function loadThemes() {
  const themes = [];
  const files = fs.readdirSync(THEMES_DIR).filter((f) => f.endsWith('.theme.json')).sort();
  for (const file of files) {
    const json = JSON.parse(fs.readFileSync(path.join(THEMES_DIR, file), 'utf8'));
    themes.push({ id: json.id, name: json.name, isDark: !!json.isDark, tokens: json.tokens || {} });
  }
  // fallback 不是"第五个主题"，但它是首帧与缺主题时真正生效的那套，必须一起审。
  const fallbackText = fs.readFileSync(FALLBACK_CSS, 'utf8');
  themes.push({ id: 'fallback', name: 'Fallback（首帧/兜底）', isDark: false, tokens: parseCssTokens(fallbackText) });
  return themes;
}

// ------------------------------------------------------------ 审计

function auditTheme(theme) {
  const rows = [];
  for (const pair of PAIRS) {
    const fgRaw = resolveToken(pair.fg, theme.tokens);
    const bgRaw = resolveToken(pair.bg, theme.tokens);
    if (!fgRaw || !bgRaw) {
      rows.push({
        ...pair, theme: theme.id, status: 'missing', ratio: null,
        fg: fgRaw || '(缺失)', bg: bgRaw || '(缺失)',
      });
      continue;
    }
    const fgColor = parseColor(fgRaw);
    const bgColor = parseColor(bgRaw);
    if (!fgColor || !bgColor) {
      rows.push({
        ...pair, theme: theme.id, status: 'unparsed', ratio: null,
        fg: fgRaw, bg: bgRaw,
      });
      continue;
    }
    // 背景带 alpha 时先叠到应用底色上，否则算出来的是"和透明比"，没有意义。
    let effectiveBg = bgColor;
    if (bgColor.a < 1) {
      const base = parseColor(resolveToken('--bg-app', theme.tokens) || '#ffffff') || { r: 255, g: 255, b: 255, a: 1 };
      effectiveBg = composite(bgColor, base);
    }
    const effectiveFg = composite(fgColor, effectiveBg);
    const ratio = contrast(effectiveFg, effectiveBg);

    let status = 'ok';
    if (pair.size === 'disabled') {
      status = ratio >= MIN ? 'ok' : 'fail';
    } else if (ratio < MIN) {
      status = 'fail';
    } else if (ratio < AA) {
      status = 'warn';
    }
    rows.push({ ...pair, theme: theme.id, status, ratio, fg: fgRaw, bg: bgRaw });
  }
  return rows;
}

function runAudit() {
  const themes = loadThemes();
  const rows = [];
  for (const theme of themes) rows.push(...auditTheme(theme));
  const summary = {
    themes: themes.map((t) => ({ id: t.id, name: t.name, isDark: t.isDark })),
    total: rows.length,
    fail: rows.filter((r) => r.status === 'fail').length,
    warn: rows.filter((r) => r.status === 'warn').length,
    missing: rows.filter((r) => r.status === 'missing' || r.status === 'unparsed').length,
    rows,
  };
  return summary;
}

function printHuman(result) {
  const byTheme = new Map();
  for (const row of result.rows) {
    if (!byTheme.has(row.theme)) byTheme.set(row.theme, []);
    byTheme.get(row.theme).push(row);
  }
  for (const theme of result.themes) {
    const rows = byTheme.get(theme.id) || [];
    const bad = rows.filter((r) => r.status === 'fail' || r.status === 'warn');
    console.log(`\n■ ${theme.name}（${theme.id}${theme.isDark ? ' · 暗色' : ''}）`);
    for (const row of rows) {
      const ratio = row.ratio === null ? '  —  ' : `${row.ratio.toFixed(2)}:1`;
      const mark = row.status === 'ok' ? '  ' : row.status === 'warn' ? '⚠ ' : row.status === 'fail' ? '✗ ' : '? ';
      if (row.status === 'ok') continue;
      console.log(`  ${mark}${ratio.padEnd(7)} ${row.label}  ${row.fg} on ${row.bg}`);
    }
    if (!bad.length) console.log('  ✓ 全部达标（AA 4.5:1）');
  }
  console.log(`\n共 ${result.total} 组：fail ${result.fail}，warn ${result.warn}，无法解析 ${result.missing}`);
}

module.exports = {
  PAIRS,
  AA,
  parseColor,
  composite,
  luminance,
  contrast,
  resolveToken,
  parseCssTokens,
  loadThemes,
  auditTheme,
  runAudit,
};

if (require.main === module) {
  const args = process.argv.slice(2);
  const result = runAudit();
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printHuman(result);
  }
  const strict = args.includes('--strict');
  process.exitCode = result.fail > 0 || (strict && result.warn > 0) ? 1 : 0;
}
