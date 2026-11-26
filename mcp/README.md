# SXSEditor MCP（随应用分发）

本目录由 `node scripts/build-mcp-resources.js` 从仓库真源生成，请勿手工编辑。

| 文件 | 用途 |
|---|---|
| `sxseditor-mcp.js` | stdio MCP 服务器入口 |
| `mcpSchema.js` / `modelContract.js` | 服务器运行所需的方法表与契约副本 |
| `skills/mcp-driver/SKILL.md` | 驱动编辑器的 skill 说明 |

## 使用

1. 先启动 SXSEditor，让它写出 `mcp-endpoint.json` 发现文件；服务器会自行读取端口与令牌。
2. 在应用「帮助 → MCP 连接」里复制按当前安装生成的配置片段，粘贴到对应客户端的配置文件。
3. 配置里的服务器路径必须是本目录 `sxseditor-mcp.js` 的**绝对路径**。

各客户端的配置文件与格式不同：Claude Code 与 WorkBuddy 用 `mcpServers` +
`command`/`args`，OpenCode 用 `mcp.<名称>.command` 数组，Codex 用 TOML 的
`[mcp_servers.*]`。请以「MCP 连接」生成的片段为准，不要照抄单一格式。

源码树运行时请改用 `scripts/sxseditor-mcp.js`（`npm run mcp`）；两处是同一份逻辑，
差别只在 schema 从源码树加载还是从本目录副本加载。
