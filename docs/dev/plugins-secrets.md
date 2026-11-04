# 插件密钥（`permissions.secrets`）

## 0. 一句话

`ctx.secrets` 用来存**用户交给你的凭据**（token、cookie、本地证书口令）。它不是
`ctx.settings` 的加密版，也不是 `ctx.state` 的抽屉 —— 三者的可见性完全不同：

| | 谁看得见 | 存在哪 | 适合放什么 |
|---|---|---|---|
| `ctx.settings` | 用户在设置页里看得到、改得了 | 宿主的设置存储 | 问候语、步长、偏好 |
| `ctx.state` | 只有你的插件（但仍是一个明文 JSON） | `plugin-data/<id>/state.json` | 计数、上次选中的项 |
| `ctx.secrets` | 只有你的插件（值不回显给界面/日志） | `plugin-data/<id>/secrets.enc` | token、密钥、口令 |

把 token 放进 `state` 的后果不是"不能用"，而是"它会出现在备份、日志、用户随手
打开的文件夹里"。

## 1. 声明权限

读与写是**两个**权限：

```json
"permissions": {
  "secrets": ["read", "write"]
}
```

只读的展示面板没有理由能覆盖用户的 token，所以能分开就分开声明。没声明就调用会
抛 `PERMISSION_DENIED`（`err.code` 可直接分支），宿主同时写一条 `secret-denied`
审计 —— 反复尝试会在活动日志里留下频次。

## 2. API

```js
await ctx.secrets.set('cloud.apiKey', 'sk-...');   // { ok, created, encrypted }
await ctx.secrets.get('cloud.apiKey');             // string | null
await ctx.secrets.delete('cloud.apiKey');          // { ok, existed }
await ctx.secrets.keys();                          // { keys: string[], encrypted }
```

- `get` 返回 `null` 表示"没存过"；返回 `''` 表示"存过，但值是空串"。两者不要混。
- `delete` 幂等：删不存在的 key 也返回成功（`existed: false`）。
- `keys()` 只给名字，不给值 —— 用来做"已保存 3 个密钥"这类展示。
- 命名规则：1–64 位，字母/数字/点/下划线/连字符，以字母或数字开头
  （`cloud.apiKey` 这种分层写法是推荐的）。
- 上限：每个插件 64 个 key，单值 8KB（UTF-8 字节）。密钥不是数据库，超过这个
  量级说明该换 `state` 或让用户选文件。

## 3. `encrypted` 是事实，不是承诺

```js
const r = await ctx.secrets.set('token', value);
if (!r.encrypted) {
  // 这台机器没有可用的系统密钥环（常见于 Linux 无 libsecret 的桌面）
  // 宿主仍然存了，但你要在界面上如实说"当前是明文"
}
```

宿主用 Electron `safeStorage`（macOS Keychain / Windows DPAPI / Linux libsecret）。
不可用时**不静默降级成"看起来安全"**：照存，但 `encrypted:false` 会一路带回给
调用方，文件本身也记着 `encrypted:false`，下次读取不会被当成密文去解。

## 4. 审计只记"改了哪个 key"

每次 set / delete 写一行 `secret` 审计（`{action, key, created|existed, encrypted}`）。
**值永远不进审计、不进日志、不进界面快照**。所以你能回答"谁在什么时候改了哪个
密钥"，但答不出"值是什么"—— 后者不该由日志系统承担。

## 5. 边界（必须知道）

- **这不是沙箱**。插件仍可 `require('node:fs')` 读别的插件的 `secrets.enc`；加密
  可用时读到的是密文，不可用时就是明文。`ctx.secrets` 防的是"意外泄漏到日志、
  界面、工程文件、备份"，不是"恶意插件偷看"。
- **`keepData` 会影响密钥**。卸载时默认连 `plugin-data/<id>` 一起删；勾选"保留
  数据"则密钥也保留（重装同一 id 能读回）。这是"保留数据"的应有之义，但要在
  卸载确认里说清楚。
- **不要回显**。示例插件把 token 放进返回值，是为了让命令行能验证往返；真实插件
  只在调用外部服务时自己用一下，不要进 UI、日志或通知。

## 6. 完整示例

[`plugins/example-secrets/`](../../plugins/example-secrets/)：`save` / `reveal` /
`clear` 三个命令，演示写入、跨进程读回、删除，以及如何把 `encrypted:false`
如实报给用户。用命令行验证（不需要打开窗口）：

```bash
SXSEditor --cli plugin call example-secrets.save --params '{"value":"sk-test"}' --local
SXSEditor --cli plugin call example-secrets.reveal --local --json
```
