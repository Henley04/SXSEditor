#!/usr/bin/env node
/**
 * check-ipc-channels —— IPC 通道契约守卫（审查项 A3）。
 *
 * 背景：src/shared/ipcChannels.js 里定义了 200+ 个通道常量，但主进程与 preload
 * 里长期直接用裸字符串 `safeHandle('svs:synthesize')`。常量表因此沦为"看起来
 * 有契约、实际没人用"的死代码：改了常量的值不会同步到调用点，写错通道名也只能
 * 等运行时才发现。
 *
 * 本脚本做三件事：
 *   1. 扫描 src/** 里 IPC 调用点上的裸字符串通道名，凡是符合 `ns:event` 命名
 *      约定却没登记进常量表的，直接报错；
 *   2. 反向检查常量表里登记了但代码里一次都没用的条目（可能是改名后的残留）；
 *   3. 检查主进程注册的 handler（safeHandle / ipcMain.handle）与 preload 暴露
 *      的 invoke 通道是否对得上，提前暴露"渲染进程调用了没人处理的通道"。
 *
 * 用法：node scripts/check-ipc-channels.js   （CI 里以非零退出码阻断）
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');

const { IPC_CHANNELS } = require(path.join(ROOT, 'src/shared/ipcChannels.js'));
const VALUE_TO_KEY = new Map();
for (const [k, v] of Object.entries(IPC_CHANNELS)) {
  if (!VALUE_TO_KEY.has(v)) VALUE_TO_KEY.set(v, k);
}

// 只在这些调用形式里认通道名 —— 避免把 DOM 事件名（'click'、'change'）误判成 IPC。
const CALL_RE = /(?:\b(?:safeHandle|ipcMain\.handle|ipcMain\.on|ipcMain\.once|ipcRenderer\.invoke|ipcRenderer\.on|ipcRenderer\.once|ipcRenderer\.send|\.invoke|\.once|\.on|\.send|removeListener|removeAllListeners)\s*\(\s*)'([a-zA-Z][a-zA-Z0-9:._-]*)'/g;
// 已使用常量引用的通道名：IPC_CHANNELS.FOO
const CONST_RE = /\bIPC_CHANNELS\.([A-Z][A-Z0-9_]*)/g;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'winml' && dir.includes('inference')) continue; // 原生桥接层，无 IPC
      walk(full, out);
    } else if (e.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(SRC).filter((f) => !f.endsWith(path.join('shared', 'ipcChannels.js')));

const bare = new Map();      // 裸字符串通道 -> 文件列表
const usedKeys = new Set();  // 通过常量引用的 KEY
const invokeChannels = new Set();  // preload 侧 invoke 的通道（字符串形式）
const handleChannels = new Set();  // 主进程侧 handle 的通道

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');

  let m;
  CALL_RE.lastIndex = 0;
  while ((m = CALL_RE.exec(text)) !== null) {
    const ch = m[1];
    if (!ch.includes(':')) continue; // 非 IPC 命名约定（DOM / Node 事件）
    if (!VALUE_TO_KEY.has(ch)) {
      if (!bare.has(ch)) bare.set(ch, []);
      bare.get(ch).push(rel);
    }
    if (/\.invoke\s*\(\s*'/.test(m[0])) invokeChannels.add(ch);
    if (/(?:safeHandle|ipcMain\.handle)\s*\(\s*'/.test(m[0])) handleChannels.add(ch);
  }

  CONST_RE.lastIndex = 0;
  while ((m = CONST_RE.exec(text)) !== null) {
    usedKeys.add(m[1]);
    const v = IPC_CHANNELS[m[1]];
    if (v === undefined) continue;
    // 用常量形式出现的调用点，也按调用类型归档
    const around = text.slice(Math.max(0, m.index - 40), m.index);
    if (/\.invoke\s*\(\s*$/.test(around)) invokeChannels.add(v);
    if (/(?:safeHandle|ipcMain\.handle)\s*\(\s*$/.test(around)) handleChannels.add(v);
  }
}

const problems = [];

// 1) 裸字符串通道
if (bare.size > 0) {
  problems.push('以下 IPC 通道仍以裸字符串书写，请改用 IPC_CHANNELS 常量：');
  for (const [ch, locs] of bare) {
    problems.push(`  ${ch}  (${[...new Set(locs)].slice(0, 3).join(', ')})`);
  }
}

// 2) 常量表里登记但从未使用（只提示，不阻断：有些常量给插件/文档用）
const unused = Object.keys(IPC_CHANNELS).filter((k) => !usedKeys.has(k));
if (unused.length > 0) {
  console.warn(`[check-ipc-channels] 提示：${unused.length} 个常量在 src/ 内未见引用（可能是插件契约或预留）：`);
  console.warn(`  ${unused.slice(0, 20).join(', ')}${unused.length > 20 ? ' …' : ''}`);
}

// 3) preload 调用但主进程没有 handler
const orphan = [...invokeChannels].filter(
  (ch) => !handleChannels.has(ch) && !ch.endsWith(':reply') && !ch.endsWith(':response')
);
if (orphan.length > 0) {
  console.warn('[check-ipc-channels] 提示：以下通道被渲染进程 invoke，但未在主进程找到 safeHandle/ipcMain.handle：');
  console.warn(`  ${orphan.slice(0, 20).join(', ')}`);
}

if (problems.length > 0) {
  console.error('[check-ipc-channels] 失败：\n' + problems.join('\n'));
  process.exit(1);
}

console.log(`[check-ipc-channels] OK：${Object.keys(IPC_CHANNELS).length} 个常量 / ${usedKeys.size} 个被引用，未发现裸字符串通道。`);
