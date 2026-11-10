'use strict';
/**
 * MCP 随包分发目录（mcp/）的一致性回归。
 *
 * 打包版应用只把 `.webpack / node_modules / onnx_models` 塞进 app.asar，
 * scripts/ 与 src/ 都不在里面。MCP 客户端是独立进程、配置里写的是磁盘绝对路径，
 * 所以 mcp/ 必须由 scripts/build-mcp-resources.js 生成并作为 extraResource 分发。
 *
 * 这里锁两件事：副本必须与真源逐字节一致（否则打包版会用旧 schema），以及
 * 在「没有 src/ 树」的安装包布局下服务器确实能靠同目录副本启动。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { expect } = require('chai');

const root = path.join(__dirname, '..');
const mcpDir = path.join(root, 'mcp');

const COPIES = [
  ['scripts/sxseditor-mcp.js', 'sxseditor-mcp.js'],
  ['src/shared/mcpSchema.js', 'mcpSchema.js'],
  ['src/shared/modelContract.js', 'modelContract.js'],
  ['.atomcode/skills/mcp-driver/SKILL.md', 'skills/mcp-driver/SKILL.md'],
];

describe('MCP 随包分发目录（mcp/）', () => {
  it('自包含目录齐备', () => {
    for (const [, to] of COPIES) {
      expect(fs.existsSync(path.join(mcpDir, to)), `mcp/${to} 缺失`).to.equal(true);
    }
    expect(fs.existsSync(path.join(mcpDir, 'README.md')), 'mcp/README.md 缺失').to.equal(true);
  });

  it('每份副本与仓库真源逐字节一致（改了真源要重跑 build-mcp-resources）', () => {
    for (const [from, to] of COPIES) {
      const src = fs.readFileSync(path.join(root, from));
      const dst = fs.readFileSync(path.join(mcpDir, to));
      expect(
        dst.equals(src),
        `${from} 与 mcp/${to} 不一致，请运行 node scripts/build-mcp-resources.js`,
      ).to.equal(true);
    }
  });

  it('forge 把 mcp/ 声明为 extraResource（asar 里没有它，必须靠外部复制）', () => {
    const forge = require('../forge.config.js');
    expect(forge.packagerConfig.extraResource).to.include('mcp');
    // extraResource 由 electron-packager 用 fs-extra.copy 直接复制，不走 ignore；
    // 这里仍然确认 mcp/ 不会被误当成 asar 内容（ignore 返回 true 即不进 asar）。
    expect(forge.packagerConfig.ignore('mcp/sxseditor-mcp.js')).to.equal(true);
  });

  it('安装包布局（没有 src/ 树）下服务器靠同目录副本完成握手并列出工具', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-mcp-bundle-'));
    try {
      const dest = path.join(tmp, 'resources', 'mcp');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(mcpDir, dest, { recursive: true });
      expect(fs.existsSync(path.join(tmp, 'src', 'shared', 'mcpSchema.js'))).to.equal(false);

      const input = [
        JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: {
            protocolVersion: '2025-06-18', capabilities: {},
            clientInfo: { name: 'bundle-test', version: '1' },
          },
        }),
        JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      ].join('\n') + '\n';

      const out = execFileSync(process.execPath, [path.join(dest, 'sxseditor-mcp.js')], {
        input, encoding: 'utf8', timeout: 20000,
      });
      const responses = out.trim().split('\n').map((line) => JSON.parse(line));
      const init = responses.find((r) => r.id === 1);
      const list = responses.find((r) => r.id === 2);
      expect(init, '缺少 initialize 响应').to.be.an('object');
      expect(init.result.protocolVersion).to.equal('2025-06-18');
      expect(list, '缺少 tools/list 响应').to.be.an('object');
      expect(list.result.tools.length).to.be.greaterThan(50);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('initialize 回显客户端请求的协议版本，不固定回单一版本', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sxs-mcp-proto-'));
    try {
      const dest = path.join(tmp, 'resources', 'mcp');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(mcpDir, dest, { recursive: true });
      const input = JSON.stringify({
        jsonrpc: '2.0', id: 7, method: 'initialize',
        params: {
          protocolVersion: '2024-11-05', capabilities: {},
          clientInfo: { name: 'proto-test', version: '1' },
        },
      }) + '\n';
      const out = execFileSync(process.execPath, [path.join(dest, 'sxseditor-mcp.js')], {
        input, encoding: 'utf8', timeout: 20000,
      });
      const init = JSON.parse(out.trim());
      expect(init.result.protocolVersion).to.equal('2024-11-05');
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
