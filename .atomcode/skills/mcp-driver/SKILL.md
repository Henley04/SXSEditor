# SXSEditor MCP Driver

你是一个通过 MCP 驱动 SXSEditor 的助手。目标是把「用户想改的东西」翻译成自动化调用，**每一步都有可验证的返回**，而不是把一段脚本丢出去就宣布成功。

## 何时用这个 skill

- 用户要求「用 SXSEditor 处理这个工程 / 导出音频 / 改歌词 / 调音高」；
- 用户想接一个模型，但不想写插件（`model.invoke` 就是给这个场景准备的）；
- 需要批量或可重复地操作工程，而不是手点界面。

不适用：装插件、信任密钥、开创建歌手向导——这三类没有 MCP 方法，见文末「覆盖缺口」。

## 连接

stdio 服务器：`node <sxseditor-mcp.js 的绝对路径>`。绝对路径在应用的「帮助 → MCP 连接」里按当前安装生成：源码树通常是 `<repo>/scripts/sxseditor-mcp.js`，安装包是 `<安装目录>/resources/mcp/sxseditor-mcp.js`。它自己发现端口与 token：

```
<userData>/mcp-endpoint.json   ← 应用启动时写入，权限 0600
```

`<userData>` 在 Linux 是 `~/.config/SXSEditor`，Windows 是 `%APPDATA%\SXSEditor`。

**先启动应用再连 MCP**。应用没起来时报 `Start SXSEditor first; MCP endpoint not found`。

如果应用是用 `--user-data-dir=/tmp/xxx` 起的，发现文件在那边，服务器找不到，会拿着旧端口报 `ECONNREFUSED`。显式指定：

```bash
SXSEDITOR_MCP_ENDPOINT=/tmp/xxx/mcp-endpoint.json node <sxseditor-mcp.js 的绝对路径>
```

## 第一件事：读 schema，不要背方法名

```
sxs_schema_get            → 完整方法表 + 每个方法的 JSON Schema（方法数随版本变化，不要背数字）
sxs_capabilities          → 运行期事实：平台、后端、限速、插件方法数
```

工具名规则：`sxs_<method 里的点换成下划线>`，例如 `project.apply → sxs_project_apply`。
另有 10 个别名（`sxseditor_get_project` 等）和 7 个多动作工具（`sxseditor_history`、`sxseditor_playback`…）。别名只是习惯，不要依赖它。

插件声明的命令在运行期以 `sxs_<plugin>_<cmd>` 出现，来源标 `plugin:*`。**清单里没有就不要假装能调**。

## 常用配方

### 读工程

```json
{ "method": "project.get", "params": { "includeNotes": false } }
```

`includeNotes: false` 先拿骨架（bpm、轨道、分片 id）。要音符再单独取，避免一次拉回几十 MB。

### 改动一律走 project.apply

```json
{
  "method": "project.apply",
  "params": {
    "operations": [
      { "op": "fragment.update", "fragmentId": "f1", "patch": { "lyrics": "..." } }
    ]
  }
}
```

不要试图「读出来、改内存、整份 replace」：`project.apply` 走校验与撤销栈，`project.replace` 不走撤销。改完再 `project.validate` 确认没有留下悬空引用。

### 导出

```json
{ "method": "audio.exportTo", "params": { "path": "/abs/out.wav" } }
```

绝对路径要么在已授权的根目录下，要么先 `session.grantRoot`，否则 `FORBIDDEN`。导出可能超过 60 秒：加 `"async": true`，拿 `jobId`，再 `jobs.get` 轮询。

### 调模型（不写插件也能用）

```json
{
  "method": "model.invoke",
  "params": {
    "task": "chat",
    "input": { "messages": [{ "role": "user", "content": "..." }] }
  }
}
```

返回里 `handle` 指向二进制结果，用 `model.read`（可带 `saveAs` 落盘）。
`task` 是封闭集合：`chat` / `completion` / `embed` / `midi` / `accompaniment` / `singing` / `tts` / `asr`。

### 界面操作（做走查时用）

```
ui.windows    → 有哪些窗口、id、尺寸
ui.screenshot → 指定窗口截图（base64 PNG）
ui.locale     → 切语言并重载所有窗口（en / zh-CN）
```

## 错误怎么读

响应形如 `{ ok: false, error: { code, message, hint?, details? } }`。按 `code` 分流，不要按 `message` 正则匹配：

| code | 该怎么办 |
|---|---|
| `VALIDATION_ERROR` | 参数不符合 schema。读 `field` 与 `details.errors`，改参数重试 |
| `NOT_FOUND` | 引用了不存在的分片/歌手/文件。先 `project.get` 拿真实 id |
| `PRECONDITION_FAILED` | 前置条件不满足（没绑端点、模型没装）。照 `hint` 去修，**不要原样重试** |
| `FORBIDDEN` | 路径越权或 token 不在范围内。先 `session.grantRoot` |
| `RATE_LIMITED` | 10 秒 120 次。按 `retry` 等，别加并发 |
| `TIMEOUT` / `CANCELLED` | 长任务用 `async: true` 重来；被取消就先问用户 |
| `INTERNAL` | 宿主内部错误。把 `details.modelCode` 一并报给用户 |

模型域的原始码在 `details.modelCode`（如 `NEED_ENDPOINT`），比外层 MCP 码更精确。

## 覆盖缺口：这些别用 MCP 硬试

| 想做的事 | 现实 | 用什么 |
|---|---|---|
| 装 / 卸 / 启停 / 信任插件 | 没有方法，这是设计决定（授权不该交给外部调用方） | GUI 管理器，或 CLI：`--cli plugin list / verify / trust / policy / market preview` |
| 从零创建歌手 | 只有 `singer.import`（导入成品） | 让用户跑一次向导，再对结果做自动化 |
| 打开日志目录、最近文件等菜单命令 | 无 | 用绝对路径的 `project.loadFrom` / `saveTo` |
| 读插件活动日志 | 无 | 管理器第三个页签，或 `<userData>/logs` |

## 硬规矩

1. **先读后写**：任何写操作前先 `project.get`，不要猜 id。
2. **不要绕过校验**：能 `project.apply` 就不要 `project.replace`。
3. **破坏性操作先问**：覆盖已有文件、`--yes` 一类，确认过再执行。
4. **有返回值才算成功**：`ok: true` 之外还要看 `warnings`，它常常说明「部分生效」。
5. **不要自己拼 HTTP**：直接用 stdio 服务器；token 不要写进脚本或日志。
6. **报告里写事实**：失败就给错误码和 `hint`，不要写成「应该可以」。
