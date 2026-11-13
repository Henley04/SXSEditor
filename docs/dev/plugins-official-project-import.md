# 官方工程导入插件（VOCALOID / Synthesizer V）

> 插件 id：`official-project-import` · 版本 1.2.0 · 发布者 `SXSEditor Official`
>
> 源码：`plugins/official-project-import/` · 随应用内置，首次启动自动安装

## 1. 支持的格式

| 扩展名 | 来源 | 容器 | 版本 | 能力 |
|---|---|---|---|---|
| `.vsqx` | VOCALOID 3 / 4 | XML（`vsq3` / `vsq4` 命名空间） | 3.x、4.x | 打开、保存 |
| `.vpr` | VOCALOID 5 / 6 | ZIP，工程在 `Project/sequence.json`，伴奏在 `Project/Audio/*.wav` | 5.x、6.x | 打开、保存 |
| `.svp` | Synthesizer V / SV2 | JSON（可用 `\u0000` 串联多份，取 version 最大者） | 1.x / 2.x 工程 | 打开、保存 |

三种格式都声明 `role: "both"`，既出现在「文件 → 打开工程」，也出现在「另存为」。
**凡是能读进宿主工程文档的数据，写回时都要能存回去**：音符、歌词、音高曲线、
速度、拍号、轨道名与颜色、分片名与起点，以及 VPR 的伴奏轨（含音频字节、
`wav.name` / `originalName`、轨道 `type` / `isMuted` / `volume`、part 的 `pos` /
`name` / `region`）都会在另存为同格式时还原。`.vsqx` / `.svp` 没有内嵌音频容器，
宿主里新建的伴奏轨无法写回，会逐条告警。

**写回外部工程格式仍是有损的**：歌手库、音色与风格、组级颤音强度包络、颤音起始
相位与渐出、音素属性、变速与变拍号在宿主中没有等价字段，不会写入；插件会逐条
返回告警，并建议另存为宿主原生工程格式以完整保留编辑结果。音符颤音的深度、频率、
起点、时长与渐入可以双向转换，写回时还原为 SVP 的 `note.attributes`。插件不会
把有损写回伪装成无损。

源工程中可精简保留的元数据（版本、容器附加字段、轨道与音色库条目等）通过
`document.ext` 的 `official-project-import.sourceMeta` 在打开与保存之间携带，
仅在目标格式与源文件格式一致时合并回新生成的文件；跨格式另存按全新工程生成，
并额外告警说明元数据未沿用。

## 2. 内置安装与停用

本插件随应用分发，**无需手动安装**：

1. 打包后源码位于 `.webpack/main/bundled-plugins/official-project-import/`。
2. 首次启动、插件服务加载之前，宿主把该目录复制到用户插件目录并走标准安装链路
   （`src/main/plugins/builtinPlugins.js`），来源记为 `builtin`。随包分发没有独立的
   插件签名文件，安装记录如实标为未签名，不显示为验签通过。
3. 插件管理器显示「内置」徽标，不提供卸载入口；服务层同样拒绝卸载，避免命令行
   与自动化入口绕过。需要关闭其贡献点时，在管理器中停用即可。
4. 默认不覆盖用户选择：已安装（含用户停用、或自行安装了其它版本）时保持原状；
   目录被移除而注册表仍在时重新补齐，但保留此前的停用状态。唯一例外是按版本
   升级：仅当注册记录存在、目录完好、来源为 `builtin`，且包内清单版本严格高于
   用户目录里的版本时，才用包内副本覆盖（`src/main/plugins/builtinPlugins.js`
   的 `needsUpgrade`）。这用于修掉早期内置副本缺少 `.svp` 保存能力所导致的
   「没有插件能保存该格式」误报。升级保留停用状态、设置、签名历史与首次安装
   时间，并写一条带 `from` / `to` 的 `upgrade` 审计；用户自行安装的同名插件、
   版本相同或更高者一律不覆盖。

在插件管理器的「已安装」页可以看到「内置」徽标，签名栏显示为未签名、来源为内置，
这是随应用分发的真实状态。手动制作签名包分发是另一条路径，见 §8。

## 3. 使用与映射结果

打开文件后，插件返回宿主工程文档，宿主再走 `validateProjectDocument` 校验，
所以进入编辑器的一定是合法文档。保存时方向相反：插件把校验过的工程文档转成
目标格式字节，由宿主原子写盘，插件不接触文件路径。映射关系：

| 源工程 | SXSEditor |
|---|---|
| 每条有音符的轨道 | 一个歌手（`type: 'singer'`，轨道名同时作为 `trackName` / `singerName`） |
| 轨道里的每个 part / 音符组 | 一个分片（`fragment`），保留起始拍、时长、名称 |
| 音符 `posTick` / `onset` / `pos` | 相对分片起点的拍（1 拍 = 四分音符） |
| 音符音高 | MIDI 音高，整数 |
| 歌词 `lyric` / `y` / `lyrics` | 音符歌词（最多 24 字符；空歌词回落为 `la`） |
| 歌词 `br`（呼吸） | 宿主吸气音素 `<AP>`，写回时还原为 `br` |
| SVP 音符颤音 `attributes` | 宿主「音符颤音」的 `depth` / `rate` / `start` / `length` / `fadeIn`，写回时还原为 `attributes` |
| 全局速度 | 工程 BPM（VSQX/VPR 的 `bpm × 100` 会先除以 100） |
| 拍号 | 工程拍号（取第一处） |
| PIT + PBS（VOCALOID） | 音高曲线：`相对半音 = PIT × PBS / 8191`，叠加到音符基础音高 |
| `pitchDelta`（SVP） | 音高曲线：`cent / 100` 半音，叠加到音符基础音高 |
| 轨道颜色 | 歌手颜色（`0xAARRGGBB` → `#rrggbb`） |
| VPR 音频轨（`type: 1`，`part.wav` + `part.region`） | 伴奏轨（`type: 'accompaniment'`），音频内嵌为 `embeddedAudioData.wavBase64` |

### 3.1 VPR 的伴奏轨

VOCALOID 5/6 的音频轨没有音符，只有一段素材：`part.pos`（tick）决定它在时间线
上的位置，`part.wav.name` 指向包内 `Project/Audio/` 下的文件，`part.region`
（毫秒）记录用了源文件的哪一段。映射关系：

| VPR | 宿主 |
|---|---|
| `part.pos / 480` | `accompanimentStartTime`（拍） |
| `part.wav.originalName` | `audioFileName`（轨道显示名，缺省用 `track.name`） |
| `region.begin` / `region.end`（毫秒） | 导入前按毫秒裁剪音频（宿主没有"裁剪偏移"概念，不裁就会整体平移） |
| 音频字节 | `embeddedAudioData.wavBase64`（与 `.sxsproj` 的"嵌入伴奏音频"同一形态，宿主解码出波形） |
| `track.volume`（0.01dB 定点，与 `tempo` 的 `value/100` 同一套约定） | `accompanimentVolume`（线性增益 0–1，-80dB 以下归零） |
| `track.isMuted` | `mute` |
| WAV 头的声道数 | `numberOfChannels`、`audioDuration` |

`.vpr` 是 ZIP，带伴奏的工程里那份 WAV 常有几十 MB（44.1kHz/16bit 立体声约
10MB 每分钟）。因此**解压是按需的**：`readZip` 接受一个 `accept` 谓词，只有工程
JSON（32MB 上限）与音频（单条 128MB、合计 192MB）会被解压，图片等素材直接跳过。
超限的音频只丢伴奏并告警，绝不因此把整份工程判成"打不开" —— 之前正是 32MB 的
单条目上限让一个正常工程完全打不开。

伴奏音频随文档走 base64，所以宿主侧的文档校验要配合：`validateProjectDocument`
对 `wavBase64` 不套用 10 万字符的字符串截断（截断等于把 WAV 剪成噪音），改由
`PROJECT_DOC_LIMITS.embeddedAudioBytes`（256MB）单独预算，超限整份拒绝。

### 3.2 VPR 伴奏的写回

1.2.0 起伴奏是双向的。源工程里宿主模型没有独立字段的结构（`type`、
`wav.name` / `originalName`、`region`、轨道名与 part 的其余标量）在导入时
收进**伴奏轨自己的** `ext.official-project-import.vpr`，随轨道穿过编辑器状态；
不放在文档级 `ext`，才能在用户增删、重排伴奏轨之后仍然对得上。写回时
`documentToScore` 把伴奏轨连同 `wavBase64` 一起交给 `encodeVpr`：

| 写回内容 | 来源 |
|---|---|
| `Project/Audio/<wav.name>` 的 WAV 字节 | `embeddedAudioData.wavBase64`（宿主保存 VPR 时强制嵌入，插件不接触文件系统） |
| 音频轨 `type: 1` / `name` / `isMuted` | 源轨道快照 + 宿主 `mute` |
| `volume.events[0].value` | 宿主 `accompanimentVolume` 线性增益反算为 0.01dB 定点（`0` → `-100000` 表示 -∞） |
| `part.pos` | 宿主 `accompanimentStartTime`（拍 × 480） |
| `part.wav.originalName` | 宿主 `audioFileName` |
| `part.region` | 重建为 `{ begin: 0, end: 裁剪后时长(ms) }` |

`region` 必须重建而不是原样照搬：导入时已经按 `region` 把 WAV 裁好（宿主没有
裁剪偏移概念），字节本身就是裁剪后的片段。原样写回会让外部软件二次裁剪，
伴奏再次平移。裁剪已烘焙进音频，因此原始入点偏移不作为宿主可编辑数据保留，
插件会为此单独告警。没有音频字节的伴奏不会生成引用不存在素材的空轨，同样
告警。多条伴奏的包内文件名会安全化并去重，防止路径穿越与同名覆盖。

源工程里 `volume` / `pan` 这类 `{ events: [{ pos, value }] }` 控制器按首个标量
事件精简保留；被元数据精简压成空对象的键直接跳过，不写回 `{}` 空壳 ——
"看起来保存了、内容其实已损坏"比明确的有损告警更糟。

宿主侧的 `src/renderer/saveAsPath.js` 维护一份「能写回伴奏的格式」清单
（当前只有 `vpr`）：另存为这些格式时不再弹「伴奏将丢失」确认，且保存时强制
嵌入伴奏字节；`.svp` / `.vsqx` / `.sv2` 仍按旧行为在写盘前提醒。插件新增
可写回伴奏的格式时必须同步这份清单。

歌词中的 `br` 是 Synthesizer V 的呼吸标记。宿主的声学模型把 `<AP>` 定义为
可发声的吸气音素（`src/inference/phone_set.json`、用户指南与音素预处理注释一致），
与表示静音的 `<SP>` 不是同一概念。因此导入时把 `br` 转译为 `<AP>`，写回时还原为
`br`，保证往返对称；`<SP>` 与普通歌词不参与转译。三种格式共用同一条歌词映射，
不存在某一格式单独漏译的情况。

SVP 的音符颤音参数在 `note.attributes`（缺省值回落到 `mainRef.voice`），组级
强度包络在 `group.parameters.vibratoEnv`。换算规则集中在 `lib/vibrato.js`：

| SVP | 宿主 | 换算 |
|---|---|---|
| `dF0Vbr`（半音，振幅再乘 0.5） | `depth`（音分） | `depth = dF0Vbr × 50` |
| `fF0Vbr`（Hz） | `rate`（Hz） | 直接对应 |
| `tF0VbrStart`（秒） | `start`（0–1） | 除以音符时长 |
| `tF0VbrLeft`（秒） | `fadeIn`（0–1） | 除以颤音区间时长 |
| 音符剩余时长 | `length`（0–1） | `1 − start` |

只有显式写了 `attributes` 的音符才导入：SVP 只在用户手动改过参数时才写这个字段，
自动生成（未写 `attributes`）的颤音若一并导入，会与宿主自己的自动音高层叠加成
双重颤音。`pF0Vbr`（起始相位）、`tF0VbrRight`（渐出）与非平凡的 `vibratoEnv`
曲线在宿主没有承载，导入时逐类告警；写回 `.svp` 时从源工程元数据快照沿用原值。
超出宿主可调范围的参数按边界处理并告警。

音高曲线按 1/16 拍为最小步长采样（每分片最多 2000 个锚点，长分片会自动放大步长），
写入 `pitchCurve.anchorPoints` 并置 `pitchMode: 'manual'`，在编辑器里可以直接改锚点。
源工程没有音高事件时不生成曲线，交给宿主的自动音高，避免造一条假平线。

时间与容器细节（与开源实现一致）：

- VOCALOID 两代都是 480 tick/拍；工程可带 `preMeasure` 前导小节，part/音符位置
  会减去前导小节累计 tick。VSQX 的 V3/V4 标签名不同（`musicalPart`/`vsPart`、
  `noteNum`/`n`、`lyric`/`y`、`mCtrl`/`cc`），按 XML 命名空间选择。
- SVP 的时间单位是 blick，705600000 blick/拍；音符的 `onset`/`duration` 相对
  `mainRef.blickOffset`，附加音符组通过 `track.groups[].groupID` 到
  `library[].uuid` 解析。

## 4. 已知限制（会显式告警，不静默丢弃）

| 限制 | 行为 |
|---|---|
| 变速 / 变拍号 | SXSEditor 只有全局 BPM 与拍号；使用第一处，并在导入后弹出告警 |
| SVP 颤音 | 音符级参数换算为宿主的「音符颤音」；组级强度包络、起始相位与渐出无承载，逐类告警，写回时尽量沿用原值 |
| VOCALOID 音素、歌手、风格 | 不导入；歌词保留，音素由宿主按歌词推导 |
| 音高曲线 | 是"音符基础音高 + 控制器偏移"的采样近似，不是逐采样还原 |
| 重叠音符 | 按后一个音符的起点裁掉前一个的尾巴（编辑器假定音符不重叠） |
| 非法/零长度音符 | 跳过，不阻断整份工程 |
| VPR 伴奏体积 | 单条音频 128MB、合计 192MB；超限只跳过伴奏并告警，工程其余部分照常导入 |
| 伴奏写回 | `.vpr` 的伴奏音频与音频轨结构写回 ZIP 容器（见 §3.2）；`.vsqx` / `.svp` / `.sv2` 没有内嵌音频容器，伴奏不写回并告警，需保留请另存为 `.sxsproj`。源 `region` 裁剪已烘焙进音频，写回按全长重建，原始入点偏移不保留（会告警） |
| 宿主新建的伴奏轨 | 没有源工程结构快照时按宿主当前设置生成全新的 VPR 音频轨，并告警说明；没有音频字节的伴奏不生成空引用 |
| 写回外部格式 | 歌手库、音色与风格、组级颤音强度包络、颤音起始相位与渐出、音素属性、变速与变拍号、前导小节与弯音灵敏度曲线不写入；音符颤音主参数写回 `note.attributes`；逐条返回告警，并建议另存为宿主原生工程格式 |

## 5. 为什么是一个插件而不是两个

三种格式的差异集中在「字节与中间谱面之间的转换」：`.vsqx` 是 XML、`.vpr` 是
ZIP+JSON、`.svp` 是 JSON。读与写共用**同一条**映射管线（`lib/score.js`）：

```
reader / writer（3 组，各格式自实现序列化）
   ↕ { bpm, timeSignature, tracks[].parts[].notes/pitchOffsets }
buildDocument / documentToScore：轨道↔歌手、part↔分片、音符清洗、
   音高采样与逆变换、文档组装、扩展域元数据
```

共享部分（`score.js` + `main.js` 的 read / write 包装）承担了全部映射与宿主契约；
拆成两个插件只会复制这条管线，并把内置安装做两遍。格式识别由宿主按扩展名路由，
单插件不会让 `.svp` 与 VOCALOID 互相干扰。

## 6. 实现来源与许可

- 格式结构参考了 **UtaFormatix**（Apache-2.0，`https://github.com/sdercolin/utaformatix3`）
  的 `Vsqx.kt`、`Vpr.kt`、`Svp.kt` 及音高转换实现，并用其仓库内的测试样例做对照。
- 本插件是**独立重写的 JavaScript 实现**，没有复制 UtaFormatix 的 Kotlin 代码；
  XML 解析、ZIP 读取（中央目录 + `inflateRaw`）、SVP/VSQX/VPR 读取与音高采样
  均在 `lib/` 下自行实现。
- 本项目为 MIT；UtaFormatix 为 Apache-2.0，二者兼容。此处保留上述来源与许可声明，
  以满足 Apache-2.0 的署名要求。未使用 GPL/AGPL 实现。

## 7. 验证

### 7.1 仓库内测试

`test/pluginProjectImport.test.js` 用三份最小样例工程断言**内容一致**，
而不只是"没抛异常"：

| 样例 | 断言 |
|---|---|
| `test/fixtures/plugin-import/sample.vsqx` | preMeasure 偏移后起点 1 拍；BPM 90；3/4；音符 60/64/67 与歌词 la/li/lu；PIT=4096、PBS=2 → 第二音符 +1 半音 |
| `test/fixtures/plugin-import/sample.vpr` | ZIP 内 `Project/sequence.json`；BPM 90；4/4；音符 60/64 与 do/re；pitchBend=8191、PBS=2 → +2 半音 |
| `test/fixtures/plugin-import/sample.svp` | blickOffset=1 拍；BPM 100；轨道色 `#3366cc`；音符 60「啊」/62「呀」；pitchDelta 50 音分 → 0.5 拍处 60.5 |

三份输出都再经过 `validateProjectDocument`，确保能直接进编辑器。此外还断言：

- 三种格式的 `read → write → read` 往返：音符、速度、拍号与音高曲线采样保持一致；
  写回产物分别是合法的 XML、ZIP 与 JSON 容器，不是空壳。

`test/pluginVprAccompaniment.test.js` 专测 `.vpr` 的伴奏双向链路（在内存里现造
ZIP，不依赖外部素材）：音频真的落到 `type: 'accompaniment'` 的轨道上（位置、
音量、声道、字节逐项对照）、`region` 按毫秒裁剪、静音与 -∞ 音量、超限音频只丢
伴奏不阻断导入、缺文件时告警；写回侧断言 ZIP 音频条目与字节、音频轨全部标量键、
人声轨 `color` / `type`、`region` 重建后不二次平移、宿主新建伴奏轨也能写回、
路径穿越安全化与同名去重、缺音频字节时不写空引用、`.svp` / `.vsqx` 仍明确告警。
- `br` ↔ `<AP>` 双向转译对称，`<SP>` 静音与普通歌词不受影响；并用一份含呼吸
  音符的 SVP 走完整的字节往返。
- manifest 的三个 `fileTypes` 都声明 `role: "both"` 与 `userPicked:write` 权限，
  且每个 codec 同时实现 `read` 与 `write`。
- 写回返回的告警含有损说明，以及另存为宿主原生工程格式的建议。
- SVP 音符颤音的换算与往返：显式 `attributes` 转译为宿主音符颤音、缺省值回落
  `mainRef.voice`、关闭状态写回不复活颤音、组级 `vibratoEnv` 与起始相位/渐出
  逐类告警、超出宿主范围的参数按边界处理；换算规则见 §3。

内置安装、界面 EP 显示与曲线采样另有独立回归测试：
`test/pluginBuiltinInstall.test.js`（首次安装、不覆盖、停用保持、拒绝卸载，
以及内置旧副本按版本升级、升级保留用户状态、`upgrade` 审计、同版本不覆盖、
包内版本更低不降级、非内置来源不覆盖）、
`test/copyWebpackClosure.test.js`（随包目录完整性）、`test/epLabel.test.js`、
`test/automationCurve.test.js` 与 `test/winmlEpState.test.js`。

自动保存失败去重由 `test/autoSaveNotification.test.js` 覆盖；MCP 随包分发与
帮助菜单安装说明分别由 `test/mcpBundle.test.js`（副本与真源一致、模拟安装包
布局启动、`initialize` 回显协议版本）和 `test/mcpSetupPrompt.test.js`（四端
配置片段、路径探测、中英文案）覆盖。

```powershell
npx mocha --require ./test/setup.js "test/pluginProjectImport.test.js" "test/pluginBuiltinInstall.test.js" "test/copyWebpackClosure.test.js" "test/epLabel.test.js" "test/automationCurve.test.js" "test/winmlEpState.test.js" --timeout 30000
```

### 7.2 对照开源实现

用 UtaFormatix 仓库的公开样例做过交叉检查（只在本地临时目录，不随仓库分发）：

- `sample.svp`：4 个音符、BPM 120、pitchDelta 50 音分，导入结果与样例一致；
- `vsqx_export.vsqx`：4 个音符 do/re/mi/fa、245 个 PIT 点，音高与起止拍一致；
- `vpr_export.txt`（其内容压成 ZIP 的 `Project/sequence.json`）：4 个音符、
  pitchBend 2048、速度 120→140，导入后取 120 并给出变速告警；
- `svp_import.ufdata`：确认 tempo 120/140 分别位于 tick 0/960，与解析结果一致。

### 7.3 签名包安装

以下验证针对**另行制作 `.sxsp` 签名包**的分发路径，与 §2 的内置默认安装相互独立：
内置安装不经过签名校验，也不受 `requireSignature` 开关影响。

在隔离的临时插件根目录、`requireSignature = true` 下：

- 官方包安装成功，状态 `verified`，keyId `ed25519-a9e0599774865c81`，
  publisher `SXSEditor Official`；
- 用临时陌生密钥重签同名插件后安装被拒，返回 `SIGNATURE_UNKNOWN_KEY` 与
  `pendingKey`，不会覆盖已安装的官方目录。

## 8. 重新打包与签名

内置默认安装直接使用仓库中的插件源码目录，由 webpack 的 CopyPlugin 随包分发，
不需要本步骤。下面用于另行制作可分发的签名包：

```powershell
node scripts/package-plugin.js plugins/official-project-import `
  -o dist-plugins `
  --key "D:\Document\electron\SXSEditor-official-keys\plugin-signing.key" `
  --publisher "SXSEditor Official"
```

私钥在仓库之外，不入库。签名与信任的机制见 `docs/dev/plugins-signing.md`。
打包后的内置源码落点为 `.webpack/main/bundled-plugins/official-project-import/`，
由 `test/copyWebpackClosure.test.js` 守卫其完整性。
