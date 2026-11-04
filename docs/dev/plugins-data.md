# 插件作者指南 · 数据面（v2）

> 面向 `apiVersion: 2` 的插件作者。模型调用见 [`plugins-models.md`](plugins-models.md)，
> v1 歌声后端契约见 [`plugins.md`](plugins.md)。
>
> 设计依据：[`SXSEditor-插件系统设计方案.md`](SXSEditor-插件系统设计方案.md) §3、§9.3。

## 0. 一句话

**你声明"我认识这个扩展名"，宿主管文件的来去与权限，你只管两端的转换：字节 ↔ 工程。**

```json
{
  "permissions": { "fs": ["userPicked:read"] },
  "contributes": {
    "fileTypes": [{ "ext": ".sv2", "role": "open", "label": { "en": "SV2 Project", "zh-CN": "SV2 工程" } }]
  }
}
```

```js
module.exports = {
  codecs: {
    '.sv2': {
      async read(ctx, { name, bytes }) {
        const doc = JSON.parse(new TextDecoder().decode(bytes));
        return { document: toProjectDocument(doc) };
      },
    },
  },
};
```

装好之后，**文件 → 打开工程**的对话框里会多出「SV2 工程」一项，选中即打开；
用户双击 `.sv2`（运行中的实例）也会路由到这里。

## 1. 两件事必须分开：声明 ≠ 权限

| 你写的 | 含义 | 少了它会怎样 |
|---|---|---|
| `contributes.fileTypes` | "这个扩展名归我"（UI 与路由） | 对话框里不出现，文件也不会路由给你 |
| `permissions.fs: ["userPicked:read"]` | "允许宿主把用户选的文件字节给我" | 路由到了你，但打开会以 `PERMISSION_DENIED` 失败 |

**为什么分开**：声明是界面上可见的选择（安装弹窗会列出"关联文件类型"），读盘是能力。
一个只想在菜单里加个"导入"按钮的插件不需要后者。

`userPicked:read` 的真实含义是"**用户主动选中的那一个文件**"。你没有目录遍历能力，
`ctx.fs` 也读不到用户主目录 —— 传入的 `path` 只是给"同目录找伴生文件"之类的判断做参考，
真正可信的是 `bytes`。

## 2. `fileTypes` 的字段

```json
{ "ext": ".sv2", "role": "open", "label": { "en": "SV2 Project", "zh-CN": "SV2 工程" } }
```

| 字段 | 取值 | 说明 |
|---|---|---|
| `ext` | `.` + 1–16 位 `[a-z0-9]` | 必须带点；大小写不敏感（宿主统一小写） |
| `role` | `open` / `save` / `both` | 决定出现在"打开"还是"保存"对话框，也决定你能否被 `codec.write` 调到 |
| `label` | 字符串或 `{ en, 'zh-CN' }` | 对话框过滤器里显示的名字 |

**不能注册的扩展名**：`.sxsproj`、`.sxs`、`.sxssinger`、`.sxsp`。工程与歌手文件走宿主的
格式版本协商（`version` / `minReader` / `features`），被插件顶掉就等于绕过了版本检查。

**同扩展名冲突**：先注册者胜（按插件加载顺序），后来者在管理器里被标为 shadowed。
不要赌这个顺序 —— 换一个更具体的扩展名。

## 3. `codec.read` 的契约

```js
codec.read(ctx, { ext, path, name, size, bytes }) → { document } | { error } | { cancelled: true }
```

| 入参 | 说明 |
|---|---|
| `ext` | 小写扩展名（和你在 manifest 里写的一致） |
| `path` / `name` / `size` | 原始路径、文件名、字节数（仅供提示，别用它去读盘） |
| `bytes` | `Uint8Array`，完整文件内容（上限 64 MiB，超过宿主直接拒绝，不会调你） |

返回值里 `document` 是**宿主的工程文档形状**：

```js
{
  project: { bpm: 96, timeSignature: [4, 4] },
  singers: [{ id: 's1', type: 'singer', singerName: 'Lead', trackName: 'Lead' }],
  fragments: [{
    id: 'f1', singerId: 's1', startTime: 0, duration: 4, name: 'Lead',
    notes: [{ pitch: 60, start: 0, duration: 1, lyric: 'la' }],
  }],
}
```

- `notes[].start` / `duration` 以**拍**为单位，`pitch` 是 MIDI 音高（0–127）。
- `singers[].id` 与 `fragments[].singerId` 要能对上；对不上时宿主保留分片并给一条
  warning（不静默丢内容）。
- 缺 `id` 会被补成 `plugin-singer-N` / `plugin-fragment-N`；`duration <= 0` 按 4 拍处理。

**宿主还会再校验一遍**（`validateProjectDocument`）：规模上限（256 轨 / 5000 分片 /
单分片 20000 音符）、嵌套深度 12 层、字符串 10 万字符、危险键（`__proto__` 等）丢弃、
非 JSON 值（`NaN` / 函数 / TypedArray）丢弃。坏项丢弃 + warning，不整体拒绝 ——
用户手上的文件改不了，"能开多少开多少"比"打不开"有用。

**返回值的传输**：`document` 原样走结构化克隆（不过 `safe()` 的裁剪），所以几千个分片
不会被截断。但对象必须可克隆：带函数、循环引用会直接失败并报 `INTERNAL`。

## 4. `codec.write` 的契约

```js
codecs: {
  '.sv2': {
    async read(ctx, { name, bytes }) { return { document } },
    async write(ctx, { name, document }) { return { bytes, warnings } },
  },
}
```

`manifest` 里 `role` 要改成 `both`（或新增一条 `role: 'save'`），权限里要有
`fs: ["userPicked:write"]`。只声明 `open` 的格式不会出现在保存对话框里。

| 入参 | 含义 |
|---|---|
| `document` | **已经校验过**的工程文档：`version / project / singers / fragments / ext / extSchema` |
| `name` | 目标文件名（只用于状态栏、错误文案，不要拿它做路径判断） |
| `path` | 目标路径。**只是提示** —— 你没有文件系统权限，写盘由宿主完成 |
| `target` | `'save'`（Ctrl+S / 另存为）或 `'export'`（MCP 导出） |

返回值：

| 字段 | 类型 | 说明 |
|---|---|---|
| `bytes` | `Uint8Array` / `ArrayBuffer` / `string` | 必填。`string` 按 UTF-8 编码 |
| `warnings` | `string[]` | 可选。**写不进去的东西必须在这里说**，宿主会弹给用户看 |

失败与 `read` 同构：`throw { code, message }` 或 `{ error }`、`{ cancelled: true }`。

宿主会拒绝三种返回值：无法收敛成字节的东西、单次超过 256MB、以及文档校验不过
（后者在调用你之前就拒了 —— 脏数据不会经你的手写进用户文件）。

### 保存路径是怎么决定的

只看**目标扩展名**：`.sxsproj` / `.sxs` 走宿主 JSON，其余一律问插件。
所以这三种情况都成立：

| 场景 | 结果 |
|---|---|
| 打开 `a.sv2` → Ctrl+S | 插件写回 `a.sv2`（写盘前原文件转成 `a.sv2.bak`） |
| 打开 `a.sv2` → 另存为 `b.sxsproj` | 宿主写 JSON，之后 Ctrl+S 走 JSON |
| 新建工程 → 另存为 `c.sv2` | 插件编码，文件里没有 `ext`（本来就没有来源数据） |

## 5. 宿主看不懂的数据：`ext`

编辑器自己的模型只覆盖"能渲染 + 能编辑"的最小闭包。你的格式里总有它装不下的东西
—— 元数据、引擎私有属性、别家的音素表。**不认识的必须能原样带回去**，否则用户
"打开再保存"一次就永久丢数据，而且没有任何痕迹。

`ext` 分两层：**数据**跟着层走，**声明**跟着文档走。

```js
// 声明：这份文档里有哪些扩展字段、能不能改、参不参与渲染
document.extSchema = {
  'example-sv2': {
    note: {
      phonemes: { kind: 'phonemes', editable: false, maxLength: 200 },
    },
    render: { hook: 'postWaveform', order: 20 },   // 可选
    curve: { interp: 'step', quantize: 1 },        // 可选
  },
};

// 数据：任意层都能带
document.ext = { 'example-sv2': { meta: { author: '…' } } };
fragment.ext = { 'example-sv2': { style: 'soft' } };
note.ext     = { 'example-sv2': { phonemes: ['l', 'a'] } };
```

`kind` 是宿主唯一认识的东西，一共六种：

| kind | 宿主怎么呈现 | 适用 |
|---|---|---|
| `phonemes` | 按音素切分显示在音符上 | 别家的音素表 |
| `text` | 文本框 | 备注、标识 |
| `number` | 数字框（`min` / `max` / `step` / `unit` / `digits`） | 引擎属性 |
| `enum` | 下拉（`options`，最多 512 项） | 风格、模式 |
| `toggle` | 开关 | 布尔属性 |
| `curve` | 曲线（插值由 `curve.interp` 决定） | 自动化通道 |

`editable: false` 的意思是**只读呈现**：用户看得见、改不了、保存时原样写回。
音素默认就该是只读 —— 宿主不知道 `["tS","a"]` 在你的引擎里合不合法，
让它"可编辑"只会制造无效值。

### 三条硬规则

1. **`ext` 不是塞原文件的地方。** 单条上限 512KB、整份文档 8MB，超了整条丢弃并告警。
   不认识的部分请**结构化成字段**放进来，而不是把 5MB 原文整个塞进去。
2. **派生逻辑只发生在编解码边界。** 编辑与绘制是每帧的（16ms），那里只能跑声明式
   数据；`read` / `write` 是每文件一次的冷路径，想算什么都可以。把"张力由 f0 与力度
   推导"这类计算放进 `codec.read`，不要指望宿主在编辑循环里调你的函数。
3. **渲染行为走 hook，不要另造一套。** `render: { hook: 'postWaveform' }` 复用 M3 的
   管线后处理（拿到 `Float32Array`，返回等长 `Float32Array`），意味着"这段要 -3dB
   淡入"这种意图可以**跟着工程走**，而不是跟着插件安装状态走。

宿主在保存时会做三件事：把 `ext` 原样交回你的 `write`、统计总体积、以及在
`document → .sxsproj → document` 这一趟里继续带着它。**它不会判断这些数据是否过期**
—— 你手上有 `document` 与 `ext`，只有你知道某个字段还对不对。

## 6. 失败怎么说

三种结局各有各的码，宿主按码决定提示：

| 你的返回 | 用户看到 |
|---|---|
| `throw { code: 'INVALID_REQUEST', message }` | 「插件无法打开该文件：`message`」 |
| `{ error: '...' }` 或 `{ error: { message } }` | 同上 |
| `{ cancelled: true }` | 静默（用户自己取消的） |
| `{ document }` 但校验不过 | 「插件无法打开该文件：工程文档不合法：…」 |
| 超过 60 秒没返回 | 「插件调用超时」 |

保存时同理，另外多两种：

| 情况 | 用户看到 |
|---|---|
| 没有插件能以该扩展名保存 | 「没有插件能以 .sv2 格式保存」 |
| 缺少 `fs:userPicked:write` | 「插件 … 缺少权限」 |
| 返回了无法收敛成字节的东西 | 「插件没有返回可写入的字节」 |
| `warnings` 非空 | 「文件已保存，但有 N 项内容未能完整写入：…」 |

`message` 会原样出现在提示框里，**请按 `ctx.plugin.locale` 给出对应语言的文案**
（示例插件 `example-sv2` 的 `msg()` 就是这么做的）。宿主只负责自己那半句。

## 7. 还没做的部分（写在这里免得踩空）

- `contributes.exporters`（`export.audio`）：声明音频导出格式，导出对话框里出现。
- 音素的只读呈现：`extSchema` 已经能表达"这是音素、不可编辑"，数据也完整保留，
  但分片编辑器还没把这个声明接到界面上。
- `ext.curve` / `ext.render` 的运行时接线：声明能通过校验，尚未参与绘制与渲染。
- Windows 系统级文件关联：`.sv2` 现在能被运行中的实例接收，但还没写进注册表，
  所以"未启动时双击"不会拉起应用。
- 旁挂文件：`write` 目前只能产出**一个**文件。需要"工程 + 素材"多文件输出的格式
  暂时得自己塞进单文件容器。

## 8. 完整示例

见 [`plugins/example-sv2/`](../../plugins/example-sv2/)：

- `manifest.json`：`fileTypes` 的 `role: "both"` + `userPicked:read/write` 权限；
- `main.js`：`read` 与 `write` 严格对称，演示三件事 ——
  元数据走 `ext` 原样保留、音素声明成只读、写不进去的东西（音素微调、颤音）
  显式告警而不是静默丢弃。

打包装给别人：

```bash
npm run plugin:pack -- plugins/example-sv2 -o dist-plugins
# → dist-plugins/example-sv2-1.0.0.sxsp
```
