/**
 * 帮助菜单「MCP 连接」用的安装 prompt 生成器（纯函数）。
 *
 * 为什么要按客户端分别生成：四个客户端都支持 stdio MCP 服务器，但配置文件、
 * 顶层键与字段形状并不相同 —— Claude Code / WorkBuddy 用 JSON 的 mcpServers +
 * command/args，OpenCode 用 mcp.<名称>.command 数组（command 不是字符串），
 * Codex 用 TOML 的 [mcp_servers.*] 表。把同一段 JSON 粘到四端会静默失效，
 * 因此这里按客户端分别产出，并把「当前安装实际探测到的绝对路径」填进去。
 *
 * 格式依据（2026-11 复核）：
 *   · Claude Code 官方文档 code.claude.com/docs/en/mcp-quickstart
 *   · WorkBuddy / CodeBuddy 官方文档 workbuddy.ai / codebuddy.cn 的 mcp.json 说明
 *   · OpenCode 官方文档 opencode.ai/docs/mcp-servers
 *   · OpenAI Codex 官方 MCP 文档的 config.toml 说明
 *
 * 本模块不碰文件系统、不读 Electron：路径由主进程 mcpSetupInfo.js 探测后传入，
 * 这样生成逻辑可以独立单测，也不会把用户目录信息硬编码进字典。
 */

const SERVER_NAME = 'sxseditor';

function isZh(locale) {
  return String(locale || '').toLowerCase().startsWith('zh');
}

/** TOML basic string：Windows 路径里的反斜杠必须转义，否则会被当成非法转义序列。 */
function tomlString(value) {
  const text = String(value == null ? '' : value);
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function jsonBlock(value) {
  return JSON.stringify(value, null, 2);
}

/**
 * 生成四端配置片段。
 * @param {object} info getMcpSetupInfo() 的结果，至少含 serverPath / skillDir / endpointPath
 * @returns {object} 每个客户端的 { file, snippet, note, cli }
 */
export function buildClientConfigs(info, locale = 'zh-CN') {
  // 注意不能写 String(info && info.serverPath)：info 为 null 时结果是字符串
  // 'null'，truthy，会把无效路径塞进配置片段。
  const server = info && info.serverPath ? String(info.serverPath) : '<server path>';
  const node = info && info.nodeCommand ? String(info.nodeCommand) : 'node';
  const zh = isZh(locale);

  const claudeCode = {
    file: zh
      ? '.mcp.json（项目根）或 ~/.claude.json'
      : '.mcp.json (project root) or ~/.claude.json',
    snippet: jsonBlock({
      mcpServers: {
        [SERVER_NAME]: { type: 'stdio', command: node, args: [server] },
      },
    }),
    cli: `claude mcp add --transport stdio ${SERVER_NAME} -- ${node} "${server}"`,
    note: zh
      ? '项目级 .mcp.json 首次使用需要在客户端里确认授权；-- 之后的参数会原样传给服务器。'
      : 'A project-level .mcp.json needs client approval on first use; arguments after -- are passed to the server unchanged.',
  };

  const workbuddy = {
    file: zh
      ? '~/.workbuddy/mcp.json（或 ~/.codebuddy/mcp.json、项目级 .mcp.json）'
      : '~/.workbuddy/mcp.json (or ~/.codebuddy/mcp.json, or a project-level .mcp.json)',
    snippet: jsonBlock({
      mcpServers: {
        [SERVER_NAME]: { command: node, args: [server] },
      },
    }),
    cli: '',
    note: zh
      ? '写入后还需到连接器管理页对该服务器点「信任」，否则不会真正连接；合并配置时保留原有 mcpServers 条目。'
      : 'Trust the server in the connector manager afterwards, or it will not connect; keep existing mcpServers entries when merging.',
  };

  const opencode = {
    file: zh
      ? 'opencode.json / opencode.jsonc（项目根或 ~/.config/opencode）'
      : 'opencode.json / opencode.jsonc (project root or ~/.config/opencode)',
    snippet: jsonBlock({
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        [SERVER_NAME]: {
          type: 'local',
          command: [node, server],
          enabled: true,
          timeout: 600000,
        },
      },
    }),
    cli: '',
    note: zh
      ? 'command 是数组（命令与参数写在一起），不是 command + args；旧版若不支持 type，去掉该字段并保留 enabled。timeout 单位是毫秒，长导出需放宽。'
      : 'command is an array containing both the command and its arguments, not command + args; older versions may not support type — drop it and keep enabled. timeout is in milliseconds; raise it for long exports.',
  };

  const codexArgs = `[${tomlString(server)}]`;
  const codex = {
    file: zh
      ? '~/.codex/config.toml（或受信任项目下的 .codex/config.toml）'
      : '~/.codex/config.toml (or a trusted project-level .codex/config.toml)',
    snippet: [
      `[mcp_servers.${SERVER_NAME}]`,
      `command = ${tomlString(node)}`,
      `args = ${codexArgs}`,
      'startup_timeout_sec = 30',
      'tool_timeout_sec = 600',
    ].join('\n'),
    cli: `codex mcp add ${SERVER_NAME} -- ${node} "${server}"`,
    note: zh
      ? '这是 TOML，不是 JSON；顶层表名是 mcp_servers。tool_timeout_sec 默认 60 秒，导出类长任务需放宽。'
      : 'This is TOML, not JSON; the top-level table is mcp_servers. tool_timeout_sec defaults to 60 seconds — raise it for long exports.',
  };

  return { claudeCode, workbuddy, opencode, codex };
}

/**
 * 生成可直接复制给 AI 助手的完整安装 prompt。
 * @param {object} info getMcpSetupInfo() 的结果
 * @param {string} [locale] 'zh-CN' | 'en'
 * @returns {string}
 */
export function buildMcpSetupPrompt(info, locale = 'zh-CN') {
  const zh = isZh(locale);
  const configs = buildClientConfigs(info, locale);
  const pick = (key, fallback) => (info && info[key] ? String(info[key]) : fallback);
  const server = pick('serverPath', '<server path>');
  const skillDir = pick('skillDir', '<skill dir>');
  const skillPath = pick('skillPath', '<skill path>');
  const endpointPath = pick('endpointPath', '<endpoint path>');
  const available = !info || info.available !== false;

  const lines = [];
  if (zh) {
    lines.push('# 任务：为当前 AI 客户端接入 SXSEditor MCP 与配套 skill');
    lines.push('');
    lines.push('你是正在配置开发环境的助手。请按下列**环境事实**把 SXSEditor 的 MCP 服务器与配套 skill 安装到当前客户端，安装后做一次连通性验证。不要凭记忆猜路径或配置格式。');
    lines.push('');
    lines.push('## 环境事实（由 SXSEditor 按当前安装实际探测，请直接采用）');
    lines.push('');
    lines.push(`- MCP stdio 服务器绝对路径：\`${server}\``);
    lines.push(`- 配套 skill 目录：\`${skillDir}\`（入口 \`${skillPath}\`）`);
    lines.push(`- 应用运行时写出的发现文件：\`${endpointPath}\`（服务器自行读取端口与令牌）`);
    lines.push(`- 当前布局：${info && info.layout === 'source' ? '源码树' : '安装包'}`);
    lines.push('- 前置条件：先启动 SXSEditor，再启动 MCP 客户端；应用未运行时服务器会报「未找到 MCP 端点」。');
    if (!available) {
      lines.push('- **注意**：本次探测没有找到服务器文件，请先确认应用安装完整；源码树可运行 `node scripts/build-mcp-resources.js` 生成随包目录。');
    }
    lines.push('');
    lines.push('## 第一步：识别当前客户端，按对应格式写入配置');
    lines.push('');
    lines.push('四个客户端的配置格式不同，**不要照抄其它端的片段**。只改当前客户端对应的那一份文件，保留文件中已有的其它条目。');
  } else {
    lines.push('# Task: connect the current AI client to SXSEditor MCP and its skill');
    lines.push('');
    lines.push('You are configuring a development environment. Using the **environment facts** below, install the SXSEditor MCP server and the companion skill for the current client, then run one connectivity check. Do not guess paths or config shapes from memory.');
    lines.push('');
    lines.push('## Environment facts (probed from this installation — use them verbatim)');
    lines.push('');
    lines.push(`- Absolute path to the MCP stdio server: \`${server}\``);
    lines.push(`- Companion skill directory: \`${skillDir}\` (entry point \`${skillPath}\`)`);
    lines.push(`- Discovery file written by the running app: \`${endpointPath}\` (the server reads the port and token itself)`);
    lines.push(`- Layout: ${info && info.layout === 'source' ? 'source tree' : 'packaged app'}`);
    lines.push('- Prerequisite: start SXSEditor before the MCP client; otherwise the server reports that the MCP endpoint was not found.');
    if (!available) {
      lines.push('- **Note**: the server file was not found in this probe. Verify the installation; in a source tree run `node scripts/build-mcp-resources.js` to generate the bundled directory.');
    }
    lines.push('');
    lines.push('## Step 1: identify the current client and write only its config');
    lines.push('');
    lines.push('The four clients use different formats. **Do not paste a snippet from another client.** Edit only the matching file and keep any existing entries.');
  }

  const blocks = [
    ['Claude Code', configs.claudeCode],
    ['WorkBuddy / CodeBuddy', configs.workbuddy],
    ['OpenCode', configs.opencode],
    ['Codex', configs.codex],
  ];
  for (const [label, cfg] of blocks) {
    lines.push('');
    lines.push(`### ${label}`);
    lines.push('');
    lines.push(zh ? `配置文件：\`${cfg.file}\`` : `Config file: \`${cfg.file}\``);
    lines.push('');
    lines.push('```' + (label === 'Codex' ? 'toml' : 'json'));
    lines.push(cfg.snippet);
    lines.push('```');
    if (cfg.cli) {
      lines.push('');
      lines.push(zh ? `也可用命令行写入：\`${cfg.cli}\`` : `Or register it from the CLI: \`${cfg.cli}\``);
    }
    lines.push('');
    lines.push(zh ? `说明：${cfg.note}` : `Notes: ${cfg.note}`);
  }

  if (zh) {
    lines.push('');
    lines.push('## 第二步：安装配套 skill');
    lines.push('');
    lines.push(`把 \`${skillDir}/mcp-driver\` 整个目录复制成客户端 skill 目录下的 \`sxseditor-mcp-driver/\`（入口为 SKILL.md）：`);
    lines.push('');
    lines.push('- Claude Code：`<项目>/.claude/skills/` 或 `~/.claude/skills/`');
    lines.push('- WorkBuddy / CodeBuddy：`<项目>/.codebuddy/skills/` 或 `~/.workbuddy/skills/`');
    lines.push('- OpenCode / Codex：没有统一的 skill 目录，请把 SKILL.md 的内容并入项目的 AGENTS.md 或按该客户端的文档放置。');
    lines.push('');
    lines.push('## 第三步：验证');
    lines.push('');
    lines.push('1. 启动 SXSEditor。');
    lines.push('2. 重启当前客户端使配置生效。');
    lines.push('3. 列出 MCP 工具：Claude Code 用 `/mcp` 或 `claude mcp list`；Codex 用 `codex mcp list`；WorkBuddy 确认连接器已「信任」；OpenCode 在会话里查看 MCP 工具。');
    lines.push('4. 依次调用 `sxs_capabilities` 与 `sxs_schema_get`，确认返回成功且能读到方法表。');
    lines.push('5. 若失败，先确认服务器文件存在、应用已启动、发现文件可读；不要猜端口或令牌，也不要把令牌写进配置、脚本或日志。');
    lines.push('');
    lines.push('## 注意事项');
    lines.push('');
    lines.push('- 所有路径必须使用绝对路径；相对路径在客户端工作目录不同时会失效。');
    lines.push('- 不要把发现文件里的令牌写进任何配置或提交到仓库。');
    lines.push('- 应用每次重启端口可能变化，服务器每次启动都重新读取发现文件，配置无需改动。');
    lines.push('- Windows 原生命令行若用 npx 需 `cmd /c` 包装；本服务器直接由 node 启动，无需额外包装。');
  } else {
    lines.push('');
    lines.push('## Step 2: install the companion skill');
    lines.push('');
    lines.push(`Copy the whole \`${skillDir}/mcp-driver\` directory into the client skill directory as \`sxseditor-mcp-driver/\` (SKILL.md is the entry point):`);
    lines.push('');
    lines.push('- Claude Code: `<project>/.claude/skills/` or `~/.claude/skills/`');
    lines.push('- WorkBuddy / CodeBuddy: `<project>/.codebuddy/skills/` or `~/.workbuddy/skills/`');
    lines.push('- OpenCode / Codex: there is no unified skill directory; merge SKILL.md into the project AGENTS.md or follow that client documentation.');
    lines.push('');
    lines.push('## Step 3: verify');
    lines.push('');
    lines.push('1. Start SXSEditor.');
    lines.push('2. Restart the client so the config takes effect.');
    lines.push('3. List MCP tools: `/mcp` or `claude mcp list` for Claude Code; `codex mcp list` for Codex; confirm the connector is trusted for WorkBuddy; inspect MCP tools in an OpenCode session.');
    lines.push('4. Call `sxs_capabilities`, then `sxs_schema_get`, and confirm both succeed and return the method table.');
    lines.push('5. On failure, check that the server file exists, the app is running, and the discovery file is readable. Never guess the port or token, and never write the token into config, scripts or logs.');
    lines.push('');
    lines.push('## Notes');
    lines.push('');
    lines.push('- Every path must be absolute; relative paths break when the client working directory differs.');
    lines.push('- Do not copy the token from the discovery file into any config or commit it.');
    lines.push('- The port may change on each app restart; the server re-reads the discovery file every time, so the config does not need updating.');
    lines.push('- On native Windows, wrap npx commands with `cmd /c`; this server is launched directly by node and needs no wrapper.');
  }

  return lines.join('\n');
}
