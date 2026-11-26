'use strict';
/**
 * 「帮助 → MCP 连接」生成的安装说明回归测试。
 *
 * 四个客户端的配置形状不同，最容易出的错是把同一段 mcpServers JSON 粘到所有
 * 端：OpenCode 要 command 数组、Codex 要 TOML 表。这里把四端片段分别解析/断言，
 * 并覆盖 Windows 路径在 TOML 里的反斜杠转义与「探测不到服务器」的降级说明。
 */
const fs = require('node:fs');
const path = require('node:path');
const { expect } = require('chai');

const { buildClientConfigs, buildMcpSetupPrompt } = require('../src/shared/mcpSetupPrompt.js');
const { resolveMcpLayout } = require('../src/main/mcpSetupInfo.js');

const ROOT = path.join(__dirname, '..');

function sampleInfo(overrides = {}) {
  return {
    serverPath: '/opt/SXSEditor/resources/mcp/sxseditor-mcp.js',
    skillDir: '/opt/SXSEditor/resources/mcp/skills',
    skillPath: '/opt/SXSEditor/resources/mcp/skills/mcp-driver/SKILL.md',
    endpointPath: '/home/me/.config/SXSEditor/mcp-endpoint.json',
    layout: 'bundled',
    available: true,
    nodeCommand: 'node',
    ...overrides,
  };
}

describe('MCP 连接 — 四端配置片段', () => {
  const info = sampleInfo();
  const configs = buildClientConfigs(info);

  it('Claude Code 用 mcpServers + command/args，路径是绝对路径', () => {
    const parsed = JSON.parse(configs.claudeCode.snippet);
    expect(parsed.mcpServers.sxseditor.command).to.equal('node');
    expect(parsed.mcpServers.sxseditor.args).to.deep.equal([info.serverPath]);
    expect(configs.claudeCode.cli).to.contain('--transport stdio');
    expect(configs.claudeCode.cli).to.contain(info.serverPath);
  });

  it('WorkBuddy / CodeBuddy 同为 mcpServers，并提示需要信任连接器', () => {
    const parsed = JSON.parse(configs.workbuddy.snippet);
    expect(parsed.mcpServers.sxseditor.args).to.deep.equal([info.serverPath]);
    expect(configs.workbuddy.note).to.match(/信任|trust/i);
  });

  it('OpenCode 用 mcp.<名称>.command 数组，不是 command + args', () => {
    const parsed = JSON.parse(configs.opencode.snippet);
    const entry = parsed.mcp.sxseditor;
    expect(entry.type).to.equal('local');
    expect(entry.enabled).to.equal(true);
    expect(entry.command).to.deep.equal(['node', info.serverPath]);
    expect(entry).to.not.have.property('args');
    expect(entry.timeout).to.be.greaterThan(30000);
  });

  it('Codex 用 TOML 的 [mcp_servers.*] 表，长任务放宽 tool_timeout_sec', () => {
    const snippet = configs.codex.snippet;
    expect(snippet).to.contain('[mcp_servers.sxseditor]');
    expect(snippet).to.contain('command = "node"');
    expect(snippet).to.contain(info.serverPath);
    expect(snippet).to.contain('tool_timeout_sec = 600');
    expect(snippet.startsWith('{')).to.equal(false);
    expect(configs.codex.cli).to.contain('codex mcp add');
  });

  it('Windows 路径在 TOML 基本字符串里正确转义反斜杠', () => {
    const win = sampleInfo({ serverPath: 'C:\\Program Files\\SXSEditor\\resources\\mcp\\sxseditor-mcp.js' });
    const snippet = buildClientConfigs(win).codex.snippet;
    expect(snippet).to.contain('C:\\\\Program Files\\\\SXSEditor');
    expect(snippet).to.not.contain('args = ["C:\\Program');
  });
});

describe('MCP 连接 — 完整 prompt', () => {
  it('中英两版都填入真实路径并覆盖四个客户端', () => {
    const info = sampleInfo();
    for (const locale of ['zh-CN', 'en']) {
      const prompt = buildMcpSetupPrompt(info, locale);
      expect(prompt).to.contain(info.serverPath);
      expect(prompt).to.contain(info.skillDir);
      expect(prompt).to.contain(info.endpointPath);
      for (const label of ['Claude Code', 'WorkBuddy / CodeBuddy', 'OpenCode', 'Codex']) {
        expect(prompt, `${locale} 缺少 ${label}`).to.contain(label);
      }
      expect(prompt).to.contain('sxs_capabilities');
      expect(prompt).to.match(/绝对路径|absolute path/i);
    }
  });

  it('探测不到服务器时给出明确警示，不静默生成看似可用的路径', () => {
    const prompt = buildMcpSetupPrompt(sampleInfo({ available: false }), 'zh-CN');
    expect(prompt).to.match(/没有找到服务器文件|安装完整/);
  });

  it('完全没有安装信息时也不抛异常，用占位符兜底', () => {
    const prompt = buildMcpSetupPrompt(null, 'en');
    expect(prompt).to.contain('<server path>');
    expect(prompt).to.contain('[mcp_servers.sxseditor]');
  });

  it('英文 prompt 不夹中文说明，中文 prompt 不夹英文整句', () => {
    const info = sampleInfo();
    const en = buildMcpSetupPrompt(info, 'en');
    const zh = buildMcpSetupPrompt(info, 'zh-CN');
    // 四端配置文件说明与 Notes 曾硬编码中文，英文版会出现中英混排。
    expect(en).to.not.match(/[\u4e00-\u9fff]/);
    expect(en).to.contain('command is an array');
    expect(en).to.contain('Trust the server in the connector manager');
    expect(zh).to.contain('command 是数组');
    expect(zh).to.contain('写入后还需到连接器管理页');
    expect(zh).to.not.contain('command is an array');
  });

  it('单独取配置片段时也按语言输出文件名说明', () => {
    const en = buildClientConfigs(sampleInfo(), 'en');
    const zh = buildClientConfigs(sampleInfo(), 'zh-CN');
    expect(en.claudeCode.file).to.contain('project root');
    expect(en.claudeCode.file).to.not.match(/[\u4e00-\u9fff]/);
    expect(en.codex.note).to.contain('This is TOML');
    expect(zh.claudeCode.file).to.contain('项目根');
    expect(zh.codex.note).to.contain('这是 TOML');
  });

  it('源码树布局在说明里标注为源码树', () => {
    const prompt = buildMcpSetupPrompt(sampleInfo({ layout: 'source' }), 'zh-CN');
    expect(prompt).to.contain('源码树');
  });
});

describe('MCP 连接 — 主进程路径探测', () => {
  it('命中真实存在的 mcp/ 目录，返回绝对路径与 skill 位置', () => {
    const dir = path.join(ROOT, 'mcp');
    const result = resolveMcpLayout([{ dir, layout: 'source' }]);
    expect(result.available).to.equal(true);
    expect(result.layout).to.equal('source');
    expect(result.serverPath).to.equal(path.join(dir, 'sxseditor-mcp.js'));
    expect(fs.existsSync(result.serverPath)).to.equal(true);
    expect(result.skillExists).to.equal(true);
  });

  it('候选都不存在时标为不可用，但仍给出可用于诊断的路径', () => {
    const missing = path.join(ROOT, 'no-such-mcp-dir');
    const result = resolveMcpLayout([{ dir: missing, layout: 'bundled' }]);
    expect(result.available).to.equal(false);
    expect(result.serverPath).to.contain('sxseditor-mcp.js');
    expect(result.skillExists).to.equal(false);
  });

  it('按候选顺序取第一个命中的目录（安装包优先于源码树）', () => {
    const dir = path.join(ROOT, 'mcp');
    const result = resolveMcpLayout([
      { dir: path.join(ROOT, 'missing-first'), layout: 'bundled' },
      { dir, layout: 'source' },
    ]);
    expect(result.available).to.equal(true);
    expect(result.root).to.equal(dir);
  });
});
