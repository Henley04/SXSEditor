# 插件作者指南 · 数据面（v2）

> 面向 `apiVersion: 2` 的插件作者。模型调用见 [`plugins-models.md`](plugins-models.md)，
> v1 歌声后端契约见 [`plugins.md`](plugins.md)。
>
> 设计依据：[`SXSEditor-插件系统设计方案.md`](SXSEditor-插件系统设计方案.md) §3、§9.3。

## 0. 一句话

**你声明"我认识这个扩展名"，宿主管"文件怎么进来"，你只管"字节怎么变成工程"。**

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
| `role` | `open` / `save` / `both` | 决定出现在"打开"还是"保存"对话框。当前只实现了 `open` 的运行时链路 |
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

## 4. 打开之后发生了什么

1. 宿主把内容装进编辑器状态，`currentProjectFilePath` 设为 **`null`**；
2. 用户按保存时走「另存为」，落成 `.sxsproj`。

**为什么是导入而不是"就地编辑"**：本段只实现了 `codec.read`。若把 `.sv2` 当成当前工程
路径，用户按 Ctrl+S 就会把 sxsproj 的 JSON 写进 `.sv2`，把原文件毁掉。等到实现了
`codec.write` 才会认这条路径（见 §6）。

## 5. 失败怎么说

三种结局各有各的码，宿主按码决定提示：

| 你的返回 | 用户看到 |
|---|---|
| `throw { code: 'INVALID_REQUEST', message }` | 「插件无法打开该文件：`message`」 |
| `{ error: '...' }` 或 `{ error: { message } }` | 同上 |
| `{ cancelled: true }` | 静默（用户自己取消的） |
| `{ document }` 但校验不过 | 「插件无法打开该文件：工程文档不合法：…」 |
| 超过 60 秒没返回 | 「插件调用超时」 |

`message` 会原样出现在提示框里，**请按 `ctx.plugin.locale` 给出对应语言的文案**
（示例插件 `example-sv2` 的 `msg()` 就是这么做的）。宿主只负责自己那半句。

## 6. 还没做的部分（写在这里免得踩空）

- `codec.write`：保存回插件格式。语义是"工程 → 你的格式"，宿主会先做一次序列化。
- `contributes.exporters`（`export.audio`）：声明音频导出格式，导出对话框里出现。
- `role: 'save'` 的运行时链路：现在声明了也不会出现在保存流程里。
- Windows 系统级文件关联：`.sv2` 现在能被运行中的实例接收，但还没写进注册表，
  所以"未启动时双击"不会拉起应用。
- MCP 的 `project.loadFrom` 走的是另一条路（直接替换工程文档），暂不支持插件格式。

## 7. 完整示例

见 [`plugins/example-sv2/`](../../plugins/example-sv2/)：

- `manifest.json`：一段 `fileTypes` + 一个"关于"命令；
- `main.js`：`codecs['.sv2'].read` 把一个极简文本格式翻成工程文档，
  含本地化错误文案与状态栏回显。

打包装给别人：

```bash
npm run plugin:pack -- plugins/example-sv2 -o dist-plugins
# → dist-plugins/example-sv2-1.0.0.sxsp
```
