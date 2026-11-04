# 插件作者指南 · 自动化面（v2）

> 面向 `apiVersion: 2` 的插件作者。数据面见 [`plugins-data.md`](plugins-data.md)，
> 模型调用见 [`plugins-models.md`](plugins-models.md)。
> 设计依据：[`SXSEditor-插件系统设计方案.md`](SXSEditor-插件系统设计方案.md) §9.7。

## 0. 一句话

**你声明哪几条命令可以被外部调用，宿主管权限、命名、审计与超时，你只管这条命令做什么。**

```json
{
  "permissions": { "automation": ["expose"] },
  "contributes": {
    "commands": [
      { "id": "stats", "title": { "en": "Decoder statistics", "zh-CN": "解码统计" }, "headless": true }
    ],
    "automation": { "methods": ["stats"] }
  }
}
```

```js
module.exports = {
  commands: {
    async stats(ctx, args) {
      return { read: counts.read, lastFile: args && args.includeLast === false ? null : counts.lastFile };
    },
  },
};
```

装好之后，MCP 客户端在 `capabilities` / `GET /schema` 里看到 `example.stats`
（`target: "plugin"`、`source: "plugin:example"`），`POST /automation` 直接调它。

## 1. 三条硬规则（都在安装时校验）

| 规则 | 为什么 |
|---|---|
| 每个方法必须是**你自己已声明的命令** | 悬空引用能安装成功、调用才 404，而用户完全不知道"这个插件自称有这个方法" |
| `methods` 非空 → `permissions.automation` 必须含 `'expose'` | 权限清单是安装弹窗上用户看的那张表，不能与实际暴露面脱节 |
| 拼出的方法名不能等于内置方法 | 内置优先，撞名等于你的方法永远调不到 —— 必须在安装时报错 |

方法名是 **`<pluginId>.<命令 id>`**，例如插件 `example-sv2` 的命令 `stats` →
`example-sv2.stats`。不接受在 `methods` 里写全名，只写本地 id。

`automation.expose: false` 是总开关（与 `methods` 非空同时出现会被判为自相矛盾）。

## 2. 参数与返回值

- **参数由你定义**。宿主只校验"是个对象"，不做 schema 校验 —— 你的参数形状会随版本
  变化，宿主替你做校验只会让插件升级被旧宿主挡住。
- **返回值必须能 JSON 化**：它要穿过 IPC → 主进程 → MCP result。`undefined` 会变成
  `null`，函数、循环引用、`Float32Array` 之外的二进制对象会在序列化时失败。
  要大块音频/二进制，走数据面（`exporters`）或模型面的 handle，不要塞进返回值。
- 抛错请带 `code`：`PERMISSION_DENIED` / `NOT_FOUND` / `TIMEOUT` / `INVALID_REQUEST`
  / `CANCELLED`。宿主会翻成 MCP 错误码（`PERMISSION_DENIED` → `FORBIDDEN`，
  未知码 → `INTERNAL`），原始码保留在 `error.details.pluginCode`。不带的后果是
  调用方只能看到 `INTERNAL`，分不清"被拒"和"炸了"，重试策略全错。

## 3. 不要假设有人看着界面

自动化方法的调用者是脚本或 agent，**可能在任何窗口都最小化、甚至主窗口没打开的
时候发生**：

- 不要用它弹对话框、等用户点确认 —— 它会一直卡到 60 秒超时；
- 需要在界面里有反馈时，用 `ctx.ui.status`（状态栏文案），它会留在 UI 上；
- 真的必须有人看着才成立的命令，声明 `"headless": false`：它不会出现在自动化面上，
  但仍然可以从菜单/按钮调用。

`headless` 默认 `true`。

## 4. 用户随时可以关掉你

插件管理器里每个插件有「External automation / Allow external calls」开关（默认开）。
用户关掉之后：

- 你的方法从 `/schema` 与 `capabilities` 里**消失**（不是"调用时报错"）；
- 硬调也拒绝，且不会启动你的进程；
- 你自己的菜单命令/按钮不受影响 —— 用户要的是"别让外面的脚本动我的工程"，
  不是你在这个插件上不能用。

所以不要在启动时缓存"我的方法一定在表里"，也不要把自动化面当成持久契约。

## 5. 审计与超时

- 每次外部调用写一行 `automation-invoke`（方法、成败、错误码、耗时）到
  `<userData>/logs/plugins-audit.jsonl`，管理器「Activity log」可见；
- 开关变更写 `automation`（`{expose: true|false, via: 'cli'?}`）。`via` 只在命令行
  改开关时出现 —— 同一天里用户点的开关与脚本写的开关必须能分开；
- 单次调用按命令超时 **60 秒**掐断（`TIMEOUTS.command`）。桥接层的等待比它更宽，
  所以你给出的超时错误不会被"Automation timeout"抢走。

## 6. 与其它入口的关系

| 入口 | 走的是 | 需要窗口 |
|---|---|---|
| 菜单 / 工具栏 / 快捷键 | `command.run` | 是（主窗口） |
| 面板 iframe | `panel.rpc`（受 `apiScopes` 限制） | 是（面板） |
| MCP（HTTP / stdio 网关） | `automation` 方法 → `command.run` | **否** |
| `--cli plugin call` | 同上（转发现有实例的 `/automation`） | **否** |

同一个 `command.run` handler 会被两个入口调用，参数形状不同（菜单传 `{}`，自动化传
调用方的对象）。写 handler 时把参数当成"可选"处理，别假设 `args` 里一定有值。

### 命令行（`--cli plugin`）

```bash
# 装了哪些插件；右边一列是"现在真的能调什么"
SXSEditor --cli plugin list
SXSEditor --cli plugin methods --plugin example-sv2

# 调用；--params 接受 JSON，`-` 表示从 stdin 读（适合管道）
SXSEditor --cli plugin call example-sv2.stats --params '{"includeLast":false}'
echo '{"includeLast":false}' | SXSEditor --cli plugin call example-sv2.stats --params -

# 脚本里只想要 JSON：单行输出，人类提示全部走 stderr
SXSEditor --cli plugin call example-sv2.stats --json
```

默认**连接到已经打开的 SXSEditor**，走的是 MCP 用的同一条 `/automation`，所以看到
的状态、权限门、审计与 agent 完全一致。加 `--local` 才会另起一个临时实例（它会 fork
自己的一套插件进程，看不到 GUI 里的运行时状态，输出里会标注）。

`--cli plugin automation <id> off` 只改磁盘上的用户开关：正在运行的实例需要重载插件
或重启才生效，命令会明确提示这一点，不会假装已经挡住了调用。

## 7. 还没做的部分

- 长任务形态：`async: true` 提交成 job（桥接层支持，插件侧还没有进度/取消语义）；
- 密钥的读写见 [`plugins-secrets.md`](plugins-secrets.md)（已落地，不在此列）；
- 跨插件 service 调用（`contributes.services` 已校验，未接线）。

## 8. 完整示例

[`plugins/example-sv2/`](../../plugins/example-sv2/) 的 `stats` 命令：返回本进程处理过的
文件数，参数 `includeLast` 控制是否带出最后处理的文件名。它同时演示了"方法能跑在
没有窗口的进程里"和"返回值必须是普通对象"。
