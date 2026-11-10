#!/usr/bin/env node
'use strict';
/**
 * 生成随应用分发的自包含 MCP 目录 mcp/。
 *
 * 背景：MCP 客户端是**独立进程**，配置里必须写 stdio 服务器的绝对路径。
 * 源码树里 `scripts/sxseditor-mcp.js` 存在，但安装包只把 `.webpack / node_modules /
 * onnx_models` 塞进 app.asar，scripts/ 与 src/ 都不在里面；docs 之外也没有别的
 * extraResource。结果就是打包版用户按文档配置 MCP 时，路径指向一个不存在的文件，
 * 而且脚本 require('../src/shared/mcpSchema') 也因为依赖缺失起不来。
 *
 * 因此把「入口 + 它 require 的两个模块 + skill」复制成一棵自包含的树，通过
 * forge 的 extraResource 落到 <app>/resources/mcp/：
 *
 *   mcp/sxseditor-mcp.js        ← scripts/sxseditor-mcp.js（同一份逻辑）
 *   mcp/mcpSchema.js            ← src/shared/mcpSchema.js
 *   mcp/modelContract.js        ← src/shared/modelContract.js
 *   mcp/skills/mcp-driver/SKILL.md ← .atomcode/skills/mcp-driver/SKILL.md
 *
 * 服务器的 resolveSchema() 优先从源码树加载，找不到才用同目录副本，所以源码
 * 运行始终用唯一真源，副本只服务安装包。test/mcpBundle.test.js 会比对每组副本
 * 与源文件，防止改了真源却忘了重新生成。
 *
 * 运行：node scripts/build-mcp-resources.js（prepackage / premake 会自动调用）
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'mcp');

const COPIES = [
  ['scripts/sxseditor-mcp.js', 'sxseditor-mcp.js'],
  ['src/shared/mcpSchema.js', 'mcpSchema.js'],
  ['src/shared/modelContract.js', 'modelContract.js'],
  ['.atomcode/skills/mcp-driver/SKILL.md', 'skills/mcp-driver/SKILL.md'],
];

const README = `# SXSEditor MCP（随应用分发）

本目录由 \`node scripts/build-mcp-resources.js\` 从仓库真源生成，请勿手工编辑。

| 文件 | 用途 |
|---|---|
| \`sxseditor-mcp.js\` | stdio MCP 服务器入口 |
| \`mcpSchema.js\` / \`modelContract.js\` | 服务器运行所需的方法表与契约副本 |
| \`skills/mcp-driver/SKILL.md\` | 驱动编辑器的 skill 说明 |

## 使用

1. 先启动 SXSEditor，让它写出 \`mcp-endpoint.json\` 发现文件；服务器会自行读取端口与令牌。
2. 在应用「帮助 → MCP 连接」里复制按当前安装生成的配置片段，粘贴到对应客户端的配置文件。
3. 配置里的服务器路径必须是本目录 \`sxseditor-mcp.js\` 的**绝对路径**。

各客户端的配置文件与格式不同：Claude Code 与 WorkBuddy 用 \`mcpServers\` +
\`command\`/\`args\`，OpenCode 用 \`mcp.<名称>.command\` 数组，Codex 用 TOML 的
\`[mcp_servers.*]\`。请以「MCP 连接」生成的片段为准，不要照抄单一格式。

源码树运行时请改用 \`scripts/sxseditor-mcp.js\`（\`npm run mcp\`）；两处是同一份逻辑，
差别只在 schema 从源码树加载还是从本目录副本加载。
`;

function main() {
  fs.mkdirSync(path.join(outDir, 'skills', 'mcp-driver'), { recursive: true });
  for (const [from, to] of COPIES) {
    const src = path.join(root, from);
    if (!fs.existsSync(src)) throw new Error(`缺少源文件：${from}`);
    fs.copyFileSync(src, path.join(outDir, to));
  }
  fs.writeFileSync(path.join(outDir, 'README.md'), README, 'utf8');
  process.stdout.write(
    `[mcp] 已生成 mcp/：${COPIES.length} 份源文件副本 + README（extraResource → resources/mcp）\n`,
  );
}

main();
