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

方法名是 **`<pluginId>.<命令 id>`**，例如插件 `example-demo` 的命令 `stats` →
`example-demo.stats`。不接受在 `methods` 里写全名，只写本地 id。

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
SXSEditor --cli plugin methods --plugin example-demo

# 调用；--params 接受 JSON，`-` 表示从 stdin 读（适合管道）
SXSEditor --cli plugin call example-demo.stats --params '{"includeLast":false}'
echo '{"includeLast":false}' | SXSEditor --cli plugin call example-demo.stats --params -

# 脚本里只想要 JSON：单行输出，人类提示全部走 stderr
SXSEditor --cli plugin call example-demo.stats --json
```

默认**连接到已经打开的 SXSEditor**，走的是 MCP 用的同一条 `/automation`，所以看到
的状态、权限门、审计与 agent 完全一致。加 `--local` 才会另起一个临时实例（它会 fork
自己的一套插件进程，看不到 GUI 里的运行时状态，输出里会标注）。

`--cli plugin automation <id> off` 只改磁盘上的用户开关：正在运行的实例需要重载插件
或重启才生效，命令会明确提示这一点，不会假装已经挡住了调用。

## 7. 长任务：进度与取消

命令声明 `"long": true` 之后，三件事一起生效：

| 能力 | 表现 | 为什么只给 long |
|---|---|---|
| 异步提交 | `POST /automation {method, params, async: true}` → `202 {jobId}`，轮询 `GET /jobs/:id` | job 是给"等不起"的调用准备的。全都可异步会让 agent 习惯性异步提交，从而丢掉"这条到底慢不慢"的信号 |
| 进度 | `ctx.ui.progress(value, text)` → `job.progress` + `/events` 的 `job.progress` | 短命令的进度只是一闪而过的噪声 |
| 取消 | `jobs.cancel` → 宿主 abort 这次调用 → 插件收到 `ctx.signal` 的 abort | 没有 signal 的取消只是"调用方看不到结果"，机器还在烧 |

```json
{
  "contributes": {
    "commands": [
      { "id": "render", "title": "Render", "long": true }
    ],
    "automation": { "methods": ["render"] }
  }
}
```

```js
module.exports = {
  commands: {
    async render(ctx, args) {
      const total = args.frames || 1000;
      for (let i = 0; i < total; i++) {
        if (ctx.signal.aborted) {
          // 主动收工：抛 CANCELLED 比静默返回半个结果清楚
          throw Object.assign(new Error('已取消'), { code: 'CANCELLED' });
        }
        await renderFrame(i);
        // 进度按请求 id 回到发起人 —— 不会广播到所有窗口
        ctx.ui.progress((i + 1) / total, `frame ${i + 1}/${total}`);
      }
      return { frames: total };
    },
  },
};
```

几条边界：

- **超时**：long 命令在插件侧用 `TIMEOUTS.longCommand`（570s），桥接层 600s。
  桥接层永远更宽，是为了让插件先报"我超时了"（带它自己的上下文）。
- **取消是协作式的**：宿主在 abort 的瞬间就把这次调用结算成 `CANCELLED`，不等你返回；
  你不检查 `ctx.signal` 也能跑完，但结果没人要，算力白烧。
- **进度只保留最后一条**：进度是"现在到哪了"，不是审计日志。
- **非 long 命令带 `async: true` 会被拒**（`VALIDATION_ERROR`，`hint` 会告诉你要加
  `"long": true`）。

跨插件服务调用见 [`plugins-services.md`](plugins-services.md)，密钥见
[`plugins-secrets.md`](plugins-secrets.md)。

## 8. 完整示例

一个 `stats` 命令（示例 id `example-demo`，仅为教学占位名）：返回本进程处理过的
文件数，参数 `includeLast` 控制是否带出最后处理的文件名。它同时演示了"方法能跑在
没有窗口的进程里"和"返回值必须是普通对象"。仓库里可运行的自动化示例见
[`plugins/example-clock/`](../../plugins/example-clock/) 与
[`plugins/example-secrets/`](../../plugins/example-secrets/)。
