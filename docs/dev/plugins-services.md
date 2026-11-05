# 插件作者指南 · 跨插件服务（v2）

> 面向 `apiVersion: 2` 的插件作者。自动化面见 [`plugins-automation.md`](plugins-automation.md)，
> 密钥见 [`plugins-secrets.md`](plugins-secrets.md)。
> 设计依据：[`SXSEditor-插件系统设计方案.md`](SXSEditor-插件系统设计方案.md) §9.10。

## 0. 一句话

**一个插件注册命名服务，另一个插件声明依赖并直接调用它 —— 名字全局唯一，调用走主进程，提供方消失时消费方拿到 `SERVICE_GONE`。**

```json
// 提供方
{
  "permissions": { "services": ["provide"] },
  "contributes": {
    "services": {
      "provides": [
        { "id": "example.clock", "version": "1.0.0", "methods": ["now"] }
      ]
    }
  }
}
```

```js
// 提供方：module.exports.services[serviceId][method] = (ctx, args, meta) => ...
module.exports = {
  services: {
    'example.clock': {
      async now() { return { epochMs: Date.now() }; },
    },
  },
};
```

```json
// 消费方
{
  "permissions": { "services": ["consume"] },
  "contributes": {
    "services": {
      "consumes": [{ "id": "example.clock", "range": "^1.0.0" }]
    }
  }
}
```

```js
module.exports = {
  commands: {
    async now(ctx) {
      const clock = ctx.services.get('example.clock'); // 不可用则抛 SERVICE_GONE
      return await clock.now();
    },
  },
};
```

完整可运行的例子：[`plugins/example-clock/`](../../plugins/example-clock/) 与
[`plugins/example-consumer/`](../../plugins/example-consumer/)。

## 1. 命名：为什么必须 `namespace.name`

服务 id 是**全局命名空间**，不是插件内局部 id —— 与自动化方法 `<pluginId>.<commandId>`
正好相反。理由：

- 服务表达的是**能力**（`audio.vad`、`sv2.codec`），消费方写代码时就该知道名字，
  而"拼别人的插件 id"意味着换个实现方就要改代码；
- 全局名字意味着**同名只有一个赢家**。裸词（`codec`、`clock`）会被先装的插件抢注，
  所以 id 必须带至少一个点。这不是风格要求，是校验规则：`"id": "clock"` 装不上。

冲突时胜者按**插件 id 字典序**决定，与安装顺序无关。输的一方在管理器里显示
`service 'x.y' 已由插件 z 提供（同名冲突）`，状态为 degraded。

## 2. 版本与依赖

`version` 是提供方的版本（默认 `1.0.0`），`range` 是消费方的要求，语法与
`engines.app` 完全一致：`*`、`^1.2.0`、`~1.2.0`、`>=1.0.0 <3.0.0`、`1.2.3`。

- **不满足就装不上（degraded）**，不是"运行期再说"。管理器会写明
  `service 'x.y' 的版本不满足 '^2.0.0'（已提供：a@1.0.0）`。
- `"optional": true` 表示"没有也行"。此时缺失不算错，插件状态仍是 loaded，
  消费方应该用 `ctx.services.tryGet()` 拿到 `null` 自行降级。
- **循环依赖只报告、不拒绝**：A→B→A 只有在真的递归调用时才致命，而"声明的环"
  可能只是两个插件互为可选扩展。管理器与 `adminSnapshot.serviceCycles` 会列出来，
  运行时还有调用深度上限（8 层）兜底。

## 3. 运行时 API

提供方（在插件进程里，方法签名与 `codecs` / `exporters` 一致）：

```js
module.exports.services = {
  'example.clock': {
    // ctx:  请求级上下文（含 signal）
    // args: 调用方传的对象，形状你自己定义，宿主不校验
    // meta: { caller: {id, version}, service, method }
    async now(ctx, args, meta) { /* ... */ },
  },
};
```

消费方：

| 调用 | 行为 |
|---|---|
| `ctx.services.get(id)` | 返回句柄（`{id, version, provider, methods, [method](args)}`）；不可用抛 `SERVICE_GONE` |
| `ctx.services.tryGet(id)` | 同上，不可用返回 `null` |
| `ctx.services.call(id, method, args)` | 不拿句柄直接调 |
| `ctx.services.has(id)` / `list()` | 当前可用性与依赖清单 |
| `ctx.services.onDidChange(fn)` | 提供方消失/恢复（`{id, available}`） |

**方法名就是句柄上的键**：`methods: ["decode"]` → `svc.decode(args)`。
带点的名字（`codec.decode`）需要用下标访问 `svc['codec.decode'](args)`。

## 4. 宿主守的四条线

| 线 | 行为 | 为什么 |
|---|---|---|
| 未声明 `consumes` 的调用 | `PERMISSION_DENIED` + `service-denied` 审计 | 安装弹窗要能告诉用户"这个插件会去调别人"，没声明的调用是绕过知情同意 |
| 提供方不在 / 被停用 | `SERVICE_GONE` + `service-gone` 审计 | 对消费方来说"端点没了"和"你调错了"是两种处理方式（重试 vs 降级） |
| 方法没在 `provides.methods` 里 | `NOT_FOUND`，**不跨进程** | 声明了才有资格被调；在校验期拦住比让对端报"未知方法"清楚 |
| 调用链 > 8 层 | `SERVICE_RECURSION` | 两个插件互相调用会无限递归，宿主必须在中间截断 |

宿主不校验参数与返回值的内容（那是双方的契约）。但注意：**返回值要能结构化克隆**，
跨进程不能传函数、类实例、DOM 对象。

## 5. 卸载、停用与热切换

提供方被卸载/停用时：

1. 注册表里的服务条目被摘除（`removeContributions` 按 pluginId 一扫而空）；
2. 依赖它的插件收到 `service.changed { available: false }`；
3. 在途调用以 `PLUGIN_UNLOADED` 失败，宿主翻成 `SERVICE_GONE`；
4. 依赖方本身**不会**立刻变成 degraded —— 状态在下次加载时重算。这一点是刻意的：
   用户卸载一个插件时不该看到另一个插件连带变灰，那会让"卸错了"的错觉放大。

重新装回提供方后无需重启消费方：解析是每次调用现算的，`get()` 立刻恢复。

## 6. 计数与诊断

- `adminSnapshot.serviceStats`：`service.method` → 调用次数 / 错误数 / 平均耗时。
  服务调用是插件之间的高频内部流量，**不逐条写审计**（会把真正要看的事件冲掉），
  只统计数；失败与拒绝仍然写 `service-gone` / `service-denied`。
- 管理器每个插件卡片上的"跨插件服务"块：提供中 / 被谁占用 / 依赖谁 / 是否可用。

## 7. 还没做的部分

- 服务方法的流式返回（当前一次往返一个结果）；
- 提供方侧的配额（调用频次/并发上限由消费方自律）。
