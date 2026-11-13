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
用户双击 `.sv2`（运行中的实例）也会路由到这里。本文以 `.sv2` 作教学示例；该示例
插件本身已随应用分发（见 §9），普通用户无需手动安装。

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
| `companionExts` | `['.wav', ...]` | 可选。声明"这个工程会引用同目录的素材文件"（见 §3.1） |

**不能注册的扩展名**：`.sxsproj`、`.sxs`、`.sxssinger`、`.sxsp`。工程与歌手文件走宿主的
格式版本协商（`version` / `minReader` / `features`），被插件顶掉就等于绕过了版本检查。

**同扩展名冲突**：先注册者胜（按插件加载顺序），后来者在管理器里被标为 shadowed。
不要赌这个顺序 —— 换一个更具体的扩展名。

## 3. `codec.read` 的契约

```js
codec.read(ctx, { ext, path, name, size, bytes, files }) → { document, warnings? } | { error } | { cancelled: true }
```

| 入参 | 说明 |
|---|---|
| `ext` | 小写扩展名（和你在 manifest 里写的一致） |
| `path` / `name` / `size` | 原始路径、文件名、字节数（仅供提示，别用它去读盘） |
| `bytes` | `Uint8Array`，完整文件内容（上限 64 MiB，超过宿主直接拒绝，不会调你） |
| `files` | 仅当 `fileTypes` 里声明了 `companionExts` 才有：同目录白名单素材的 `[{ name, bytes }]`（见 §3.1） |

### 3.1 相对路径引用的素材（`companionExts`）

有些格式（SVP 的 instrumental track）不内嵌音频，而是用相对路径指向工程
**同目录**的 wav。插件进程没有工程目录的读权限，所以由宿主代读：在
`fileTypes` 条目里声明 `"companionExts": [".wav"]`，打开该格式时宿主会扫一遍
主文件所在目录，把命中的素材作为 `files` 一并传进 `codec.read`。

不声明就**完全不会扫描**——打开一个普通工程不该顺手把用户目录翻一遍。

| 宿主只收 | 原因 |
|---|---|
| 主文件同目录、纯文件名的文件 | 跨目录引用等于让插件读任意位置 |
| `companionExts` 里列出的扩展名 | 最小权限；不按内容猜 |
| 普通文件（跳过符号链接、隐藏文件、主文件自身） | 同目录一个指向别处的链接就能把"只读同目录"变成读任意路径 |
| 最多 16 个、合计 256MB | 与保存侧旁挂文件的上限对称 |

被跳过的文件不会让打开失败，原因进 `warnings`；素材缺失时由你决定是告警
跳过还是直接报错（插件比宿主更清楚这条轨能不能没有音频）。

```js
async read(ctx, { bytes, files }) {
  const raw = JSON.parse(new TextDecoder().decode(bytes));
  const wav = new Map((files || []).map((f) => [f.name.toLowerCase(), f.bytes]));
  // raw.tracks[].audio.filename → wav.get(basename.toLowerCase())
}
```

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

`warnings` 可选：读的时候丢掉/修掉的东西（某条伴奏的音频找不到、某段曲线宿主
承载不了）在这里逐条说，宿主会和校验告警合并后弹给用户。返回 `{ document }`
也合法——但"静默跳过"不是好习惯，用户看到的是"歌里少了一段"。

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
| `files` | `Array<{name, bytes}>` | 可选。旁挂文件（见下） |

### 旁挂文件：一次保存写出多个文件

有些格式天生不是一个文件：工程 + 封面、工程 + 采样、工程 + 一份纯文本歌词。
把 `files` 一起返回，宿主会写进**主文件所在目录**。

```js
async write(ctx, { document }) {
  return {
    bytes: mainBytes,
    files: [
      { name: 'cover.png', bytes: pngBytes },
      { name: 'lyrics.txt', bytes: 'la la la' },
    ],
  };
}
```

三条限制，全部来自同一件事 —— 你没有目录遍历能力：

| 你会得到的 | 因为 |
|---|---|
| `name` 只能是**一个文件名** | 带 `/`、`\`、`:` 或以 `.` 开头一律拒绝（`../x` 能写到授权范围外） |
| 与主文件同名会被拒 | 否则后写的覆盖先写的，用户得到一个内容不对的文件 |
| 最多 16 个、单个不超过 256MB | 再多应该做成 zip（单文件），而不是往用户桌面上撒文件 |

被拒绝的旁挂文件不会让整次保存失败：主文件照常落地，拒绝原因进 `warnings`。
主文件是用户按 Ctrl+S 的直接目标，不能因为封面图写不出来就说"保存失败"。

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
| `phonemes` | 音素面板下层的灰色只读带（见下节） | 别家的音素表 |
| `text` | 文本框 | 备注、标识 |
| `number` | 数字框（`min` / `max` / `step` / `unit` / `digits`） | 引擎属性 |
| `enum` | 下拉（`options`，最多 512 项） | 风格、模式 |
| `toggle` | 开关 | 布尔属性 |
| `curve` | 曲线（插值由 `curve.interp` 决定） | 自动化通道 |

`editable: false` 的意思是**只读呈现**：用户看得见、改不了、保存时原样写回。
音素默认就该是只读 —— 宿主不知道 `["tS","a"]` 在你的引擎里合不合法，
让它"可编辑"只会制造无效值。

### 音素在界面上长什么样

分片编辑器的音素面板分两层：上层是宿主按歌词推导、可编辑、参与合成的那一份；
下层是**你声明的这一份**，灰色、只读、按顺序等宽铺开。

| 你的音素名 | 画法 |
|---|---|
| `en_AA1` / `jp_a` / `zh_ma` / `yue_gaa1` / `<SP>` | 实心浅灰块（落在宿主的命名空间里） |
| `tS` / `sil` / 任何别家的符号 | 虚线框（宿主不认识，只保证"看得见、按顺序排"） |

几条宿主侧的事实，写在这里免得你误判：

- **等宽**：宿主不知道每个音素的相对时长，也没有替你编一个。等宽是"只报顺序"的诚实表达。
- **不参与合成**：合成用的是宿主自己推导的那一份。要让你的音素影响声音，得走
  `render.hook`（§5 硬规则 3），而不是指望宿主拿它去合成。
- **`editable: true` 目前也不给改**：写回要经过你的语义校验，宿主代劳只会造出你
  不认的值。字段先留着，等编辑链路定下来再启用。
- **一条 note 只呈现一个插件**：两家插件都声明 `phonemes` 时，界面取第一个并在
  带子右端标出来源 id。

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

### 曲线字段长什么样

`kind: 'curve'` 的值是一串**音符内的相对位置**，不是绝对拍号：

```js
note.ext = {
  'example-sv2': {
    // [[t, v], ...]，t ∈ [0,1] 是音符内的位置，v 是你的量纲
    dynamics: [[0, 0.15], [0.5, 1], [1, 0.3]],
  },
};
```

为什么是相对位置：用户把音符拖长时，曲线要跟着拉伸。用绝对拍会让"改了时值，
曲线就跑到音符外面"。

宿主只做两件事，都不需要理解 v 是什么：

1. **画一条只读虚线**在音符矩形内部，纵向按 `curve.clamp`（没写则按数据 min/max）归一。
   画在音符里而不是音高/音量 lane 上 —— 画到 lane 上，用户会以为那是可拖的宿主参数，
   而拖了不会有任何效果。
2. **求某个位置的值**：`interp` 支持 `linear` / `step` / `smooth`（smoothstep），
   `quantize` 按步长取整后再 `clamp`。

`t` 超出 `[0,1]` 的点会被**丢弃**而不是夹到边界：夹边会把音符外的数据画成贴边竖线，
看起来像一条有效自动化 —— 比看不见更糟。

同一个音符上可以有多条曲线（不同插件、同一插件的不同字段），宿主逐条画。
它们都不会参与合成：要让数据影响声音，走 `render.hook`。

## 6. 导出成品：`contributes.exporters`

工程格式（`fileTypes`）与成品格式（`exporters`）是两件事，别混：

| | `fileTypes` | `exporters` |
|---|---|---|
| 输入 | 一个文件的字节 | 交错 `Float32Array` + 采样率 |
| 输出 | 工程文档 | 成品音频的字节 |
| 出现在 | 打开/另存为对话框 | 导出对话框的"格式"下拉 |
| 需要 `codec` | 是 | 否（`exporters`） |

```json
{
  "contributes": {
    "exporters": [
      {
        "id": "flac",
        "ext": ".flac",
        "label": { "en": "FLAC", "zh-CN": "FLAC" },
        "mime": "audio/flac"
      }
    ]
  }
}
```

```js
module.exports = {
  exporters: {
    async export(ctx, { name, format, audio, meta }) {
      // audio: { interleaved, channels, sampleRate, frames, duration }
      // meta:  { bpm, fragmentCount, exporter }
      return { bytes, warnings: [] };
    },
  },
};
```

| 约束 | 原因 |
|---|---|
| `ext` 不能是 `.sxsproj` / `.sxs` / `.sxssinger` / `.sxsp` | 成品不该长得像工程 |
| 目标路径扩展名必须与 `ext` 一致 | 否则等于"在保存对话框里改个后缀"就能让插件往任意后缀写字节 |
| 需要 `permissions.fs: ["userPicked:write"]` | 写盘由宿主完成，但授权仍然是用户选定位置那一次 |
| 单次产出上限 256MB | 与 `codec.write` 同一套上限 |

入参的采样**已经按用户在导出对话框里选的采样率重采样**（24k/44.1k/48k/96k），
你拿到的就是成品采样，不需要自己再转。

同名扩展名被两个插件声明时，先注册的赢，其余在清单里标 `shadowed`；
导出对话框只显示第一个。

## 7. 失败怎么说

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

## 8. 还没做的部分（写在这里免得踩空）

- `ext.render` 的**端到端**验证：意图（哪个插件、什么顺序）已经能推到主进程的
  pipeline 执行器，语义有单测覆盖；但这台机器没有模型文件，跑不了真实合成，
  所以"工程 A 要求 A 插件后处理"这件事还没有一次带声音的验证。
- `preset` / 批量导出：目前一次导出只有一组参数、一个格式、一个目标。
- 签名与市场：`.sxsp` 的签名位是留的，校验没做（M6）。

## 9. 完整示例

见 [`plugins/example-sv2/`](../../plugins/example-sv2/)：

- `manifest.json`：`fileTypes` 的 `role: "both"` + `userPicked:read/write` 权限；
- `main.js`：`read` 与 `write` 严格对称，演示三件事 ——
  元数据走 `ext` 原样保留、音素声明成只读、写不进去的东西（音素微调、颤音）
  显式告警而不是静默丢弃。

> **它现在随应用分发**：`example-sv2` 与 `official-project-import` 同在内置清单
> `src/shared/builtinPluginIds.js` 里，首次启动自动安装到用户插件目录（来源记为
> `builtin`），因此 `.sv2` 开箱即可打开与保存，伴奏的内嵌 / 相对路径写回也一并在。
> 内置副本按版本升级时保留用户的停用状态、设置与签名历史；用户自行安装的同名
> 插件一律不覆盖。安装与升级策略见
> [`plugins-official-project-import.md`](plugins-official-project-import.md) §2。
>
> `.sv2` 是本项目为演示数据面自造的示例 JSON 格式，**不是** Synthesizer V 2 的
> 官方工程文件。随包分发只为让示例格式开箱可用，不代表宿主能打开真实的 SV2 工程；
> 真实的 Synthesizer V 工程（`.svp`）由 `official-project-import` 处理。

打包装给别人（只用于另做第三方分发包；随应用分发的用户不需要这一步）：

```bash
npm run plugin:pack -- plugins/example-sv2 -o dist-plugins
# → dist-plugins/example-sv2-1.1.0.sxsp（版本号随 manifest.version）
```
