# 插件作者指南 · 模型调用（v2）

> 面向 `apiVersion: 2` 的插件作者。v1 歌声后端契约见 [`plugins.md`](plugins.md)（那是另一套
> 机制，不走本文的端点与授权）。
>
> 设计依据：[`SXSEditor-插件系统设计方案.md`](SXSEditor-插件系统设计方案.md) §12。

## 0. 一句话

**插件只说"我要做哪个 task"，不指定端点，不碰密钥。**

```js
const { text } = await ctx.models.invokeOnce({
  task: 'chat',
  input: { messages: [{ role: 'user', content: '用一句话介绍你自己' }] },
});
```

端点由用户在 **设置 → 模型端点 → 任务绑定** 里选；第一次调用时用户会看到一次确认；
密钥只存在主进程，出站统一由宿主代发。插件拿到的是结果，不是连接。

为什么这样设计：一旦允许插件自带 HTTP，端点鉴权就形同虚设 —— 插件可以拿用户的数据
发给任何地方，而安装弹窗上不会有一行提示。所以出站能力收归宿主，插件只声明意图。

## 1. task 是封闭集合

`task` 决定输入输出的形状，宿主按它挑 adapter、算"将发送多少字节"、决定弹窗怎么写。
下表直接对应 `src/shared/modelContract.js` 的 `TASK_SPECS`：

| task | 用途 | 输入 | 输入上限 | 输出 | 流式 |
|---|---|---|---|---|---|
| `chat` | 对话 | 文本（字符串或 `{ messages }`） | 1 MiB | 流式文本 | ✓ |
| `completion` | 续写 | 文本 | 1 MiB | 流式文本 | ✓ |
| `embed` | 向量化 | 文本 | 1 MiB | JSON | ✗ |
| `midi` | MIDI 生成 | JSON | 4 MiB | 二进制 | ✗ |
| `accompaniment` | 伴奏生成 | JSON | 8 MiB | 二进制 | ✗ |
| `singing` | 歌声合成 | JSON | 8 MiB | 二进制 | ✗ |
| `tts` | 语音合成 | 文本 | 256 KiB | 二进制 | ✓ |
| `asr` | 语音识别 | 二进制 | 64 MiB | 文本 | ✓ |

"JSON" 的具体字段由对应 adapter 决定（`chat` / `embed` 目前已实现，其余见 §9）。
`task` 不能自定义：需要一种新的模型能力时，先来改宿主 —— 加 task 意味着同时要定
输入输出契约、字节上限、弹窗文案与 adapter 支持，那是契约变更，不是配置。

输入超过上限直接拒，不弹窗：用户没法对 50MB 的未知数据做判断。

## 2. `ctx.models` 的四个方法

```js
// 1) 能力发现：看得见哪些端点、要不要确认、是否可用
const { endpoints } = await ctx.models.list({ task: 'chat' });
// [{ id, title, provider, adapter, locality, requiresConsent, ready, preferredBy }]

// 2) 流式调用
const h = ctx.models.invoke(
  { task: 'chat', input: '你好' },
  {
    onStart: (evt) => {},        // { handleId, endpoint: { id, title, provider, locality } }
    onChunk: (text, evt) => {},  // 每个分片；evt.bytes 用于背压计费
    onProgress: (evt) => {},     // 生成式任务的进度（0..1）
  },
);
h.id;          // handleId（start 之前为 null）
h.cancel();    // 主动取消 → done 以 { cancelled: true } 结算
await h.done;  // { text, endpointId } | { cancelled: true }

// 3) 只要结果（内部仍走同一条流，中间分片由 runtime 聚合）
const result = await ctx.models.invokeOnce({ task: 'chat', input: '你好' });
```

**不需要自己处理背压。** runtime 每收到一个分片就回一次 `models.ack`，网关据此判断
消费方是否跟得上。自己实现 `onChunk` 时不要在里面做同步阻塞的重活（比如解码整首歌），
那是唯一会让通道被暂停的写法。

**取消是协作式的。** `h.cancel()` 之后 `done` 以 `{ cancelled: true }` 结算，不是抛错 ——
取消是正常结束，不是失败。

## 3. manifest 要声明什么

```json
{
  "permissions": {
    "models": ["consume"]
  },
  "contributes": {
    "models": {
      "consumes": ["chat", "tts"],
      "preferred": [
        { "task": "chat", "provider": "openai", "note": "长上下文对话更稳" },
        { "task": "tts", "endpoint": "plugin:com.example.voice.tts" }
      ]
    }
  }
}
```

- `permissions.models: ['consume']` —— 调用他人端点。**没有它，`ctx.models.*` 会被挡在
  宿主的权限分发处。** 声明了 `contributes.models` 却漏了这个权限，安装时直接失败
  （权限清单是给用户看的，不能与实际行为脱节）。
- `consumes` —— 会用到哪些 task。安装弹窗给用户看的就是这份清单，别漏报。
- `preferred` —— "哪个端点上跑这个 task 更合适"。**只影响设置页的一颗 ★，不影响路由。**
  插件不知道用户装了哪些端点，所以按 `provider` 指定是常态；按 `endpoint` 精确指定
  基本只有插件自己注册的端点才有意义。
- `permissions.models: ['provide']` —— 注册自己的端点（见 §6）。

## 4. 端点与授权，用户看到的是什么

```
插件调用 ──▶ 网关 ──▶ 解析 task 的默认端点 ──▶ 查 ACL ──▶ (首次) 弹确认窗 ──▶ adapter ──▶ 上游
```

- 解析不出端点 → `NEED_ENDPOINT`，提示用户去绑。**宿主不会替你挑一个。**
- ACL 默认 `ask`：第一次调用会弹窗，用户可选 拒绝 / 仅本次 / 本次运行 / 始终允许。
  默认焦点在"本次运行"，没有"全部允许"。
- 用户拒绝 → `PERMISSION_DENIED`。窗口没有焦点时（人不在电脑前）直接判拒，
  记 `CONSENT_UNATTENDED`。
- 授权按 `(调用方, 端点)` 记录，端点的 `baseUrl`/`provider`/`adapter` 一变，指纹失效，
  下次重新问。

插件能做的只有"把话说清楚"：调用失败时给用户一条能照做的提示，而不是把错误码原样抛出去。
`plugins/example-models` 里有一份可复制的写法。

## 5. locality：什么时候算"本地"

| 判定 | 条件 | 首次调用 |
|---|---|---|
| `device` | `local-process` adapter，或回环地址（`127.0.0.0/8`、`localhost`、`::1`） | **免确认**（用户可关掉这个开关） |
| `lan` | 私网地址（`10/8`、`172.16/12`、`192.168/16`、`fc00::/7`、`fe80::/10`） | 要确认 |
| `cloud` | 其他 | 要确认 |

私网**默认不算本地**：那台机器可能是别人的、可能计费、可能做日志。用户可以在端点
配置里显式把它标成"本机"。

这条规则对插件也有约束：**凡是在本机跑的东西，就不要绕道 API 端点。** 本地模型能被
宿主直接驱动（`local-process`），走云端只会把数据送出去、还要付钱。

## 6. 插件注册自己的端点（尚未开放）

设计上插件可以把自己包装成一个端点，让用户在设置页里给 task 绑定它：

```jsonc
// 计划中的形态 —— 当前版本会拒绝 contributes.models.provides
"permissions": { "models": ["provide"] },
"contributes": {
  "models": {
    "provides": [
      { "id": "gen", "task": "midi", "title": "Composer X", "adapter": "local-process" }
    ]
  }
}
```

落地时会是这样：端点 id 投影为 `plugin:<pluginId>.<localId>`，`owner = plugin`，
卸载时级联删除、授权记录一起清掉；`adapter` 只能从封闭集合里指认一个，**不能自带
请求函数**（否则等于把出站地址交给插件）；`baseUrl` 与密钥由用户在设置页填写，
插件不能代替用户配置。

本期只开放 `consume`。`permissions.models: ['provide']` 可以先声明（字段合法），
但 `contributes.models.provides` 会被校验拒绝 —— 与其静默忽略、让插件"看起来装好了
但不生效"，不如直接报错。

## 7. 不要自建 HTTP

插件进程装了出站封锁（`src/main/plugins/runtime/netGuard.js`）：

- `require('http' | 'https' | 'http2' | 'net' | 'tls' | 'dgram' | 'dns' | 'undici')` → 立即抛错
- 全局 `fetch` / `WebSocket` / `EventSource` → 立即抛错
- 错误码 `PLUGIN_NET_BLOCKED`，消息里直接给出改法

```js
// ✗ 这样写会在第一行就失败
const https = require('node:https');
await fetch('https://api.openai.com/v1/chat/completions');

// ✓ 换成这样
const { text } = await ctx.models.invokeOnce({ task: 'chat', input: prompt });
```

这是**防误用，不是防恶意**：真正的边界是插件拿不到 `baseUrl`、也拿不到密钥。万一你
确实需要访问自己的服务，把它注册成端点（§6），让用户看得见、授权得了、审计有记录。

## 8. 错误码与处理建议

| code | 含义 | 插件该怎么做 |
|---|---|---|
| `NEED_ENDPOINT` | 该 task 没有默认端点 | 提示用户去"任务绑定"里选一个 |
| `PERMISSION_DENIED` | 用户拒绝 / 无人应答 / 策略禁止 | 提示"去访问控制里授权"，不要自动重试 |
| `ENDPOINT_UNAVAILABLE` | 端点被禁用或缺凭据 | 提示用户检查端点配置 |
| `ADAPTER_UNSUPPORTED` | 宿主不认识该 adapter | 提示用户换端点；不要重试 |
| `TIMEOUT` | 空闲超时或总时长超限 | 可重试，但先想清楚是不是输入太大 |
| `BACKPRESSURE_OVERFLOW` | 消费方太慢（`retryable: false`） | 修消费逻辑，别重试 |
| `UPSTREAM_ERROR` | 上游返回非 2xx | `details.status === 429` 或 5xx 可退避重试 |
| `PROTOCOL_VIOLATION` | 你发出了终止事件之后的事件 | 是插件的 bug，结果已作废 |
| `CANCELLED` | 已取消 | 正常结束 |

`.retryable` 是宿主的判断，照它决定要不要重试，别自己猜。

## 9. 还没接线的部分

- `midi` / `accompaniment` / `singing` / `tts` / `asr` 的**二进制结果**：`ModelHandleStore`
  的句柄机制（`{ id, subject, sha256, size, mime, expiresAt, mac }`）已经就绪，但 adapter
  的 chunk 路径还没接上。在那之前这些 task 会返回文本分片或直接报未实现。
- `local-process` 的真实后端（等 `synthesis.backend` 迁移）。
- 插件提供端点（`contributes.models.provides`，§6）。

写插件时按最终形态调用即可，接线完成后不需要改插件代码。

## 10. 完整示例

[`plugins/example-models/`](../../plugins/example-models)：一个 `ask` 命令（流式写状态栏、
三种失败各给一条可照做的提示），一个 `probeNet` 命令（故意违规，用来看封锁生效）。

```bash
npm run plugin:pack plugins/example-models
# 然后在 设置 → 插件 → 从文件安装
```
