#!/usr/bin/env node
/**
 * 静态预检 Inno Setup 脚本（.iss）里各段 Flags 的常见跨段误用。
 *
 * 背景：ISCC 只在 Windows + CI 上安装运行，本地（含 npm test/lint）无法覆盖。
 * 2026-11 曾因 [Files] 段误用 [Run] 段专属的 `skipifdoesntexist` 导致 build
 * job 连续失败，而错误在 2 分多钟的打包末尾才暴露。此脚本在打包前几秒内
 * 抓出这类"flag 用错段"的问题，并给出正确写法。
 *
 * 设计原则：零误报。只检测下方 CROSS_SEGMENT 里列出的、明确属于其它段的
 * flag；对未知/新增 flag 一律放过（它们的合法性由 ISCC 自己判定），避免
 * 未来新增合法 flag 时这里误报把 CI 卡住。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCRIPTS = ['inno/no_onnx.iss', 'inno/EA.iss'];

// flag -> { 合法所在段: 正确写法提示 }；当前段不在 keys 里即判为用错段。
const CROSS_SEGMENT = {
  // [Run] 段专属：判断"要运行的程序是否存在"，不是"源文件是否存在"。
  skipifdoesntexist: {
    legal: ['Run'],
    hint: '属于 [Run] 段；[Files] 段请改用 skipifsourcedoesntexist',
  },
  // [Files] 段专属：判断"Source 源文件是否存在"。
  skipifsourcedoesntexist: {
    legal: ['Files'],
    hint: '属于 [Files] 段；[Run] 段请改用 skipifdoesntexist',
  },
};

let failures = 0;
for (const rel of SCRIPTS) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) {
    console.error(`[check-inno] 缺少脚本：${rel}`);
    failures++;
    continue;
  }
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  let segment = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const sec = line.match(/^\[([^\]]+)\]/);
    if (sec) { segment = sec[1]; continue; }
    if (!line || line.startsWith(';') || !line.includes('Flags:')) continue;
    const flags = line.slice(line.indexOf('Flags:') + 6).trim().split(/\s+/).filter(Boolean);
    for (const flag of flags) {
      const rule = CROSS_SEGMENT[flag];
      if (rule && !rule.legal.includes(segment)) {
        console.error(`[check-inno] ${rel}:${i + 1}  [${segment}] 段误用 "${flag}" — ${rule.hint}`);
        failures++;
      }
    }
  }
  if (failures === 0) console.log(`[check-inno] OK  ${rel}`);
}

if (failures) {
  console.error(`[check-inno] 发现 ${failures} 处 Flags 跨段误用；ISCC 会报 "unknown flag"。`);
  process.exit(1);
}
console.log('[check-inno] 全部通过');
