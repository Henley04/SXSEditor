# 官方工程导入插件（VOCALOID / Synthesizer V）

> 插件 id：`official-project-import` · 版本 1.1.0 · 发布者 `SXSEditor Official`
>
> 源码：`plugins/official-project-import/` · 随应用内置，首次启动自动安装

## 1. 支持的格式

| 扩展名 | 来源 | 容器 | 版本 | 能力 |
|---|---|---|---|---|
| `.vsqx` | VOCALOID 3 / 4 | XML（`vsq3` / `vsq4` 命名空间） | 3.x、4.x | 打开、保存 |
| `.vpr` | VOCALOID 5 / 6 | ZIP，工程在 `Project/sequence.json` | 5.x、6.x | 打开、保存 |
| `.svp` | Synthesizer V / SV2 | JSON（可用 `\u0000` 串联多份，取 version 最大者） | 1.x / 2.x 工程 | 打开、保存 |

三种格式都声明 `role: "both"`，既出现在「文件 → 打开工程」，也出现在「另存为」。
**写回外部工程格式是有损的**：歌手库、音色与风格、颤音、音素属性、变速与变拍号
在宿主中没有等价字段，不会写入；插件会逐条返回告警，并建议另存为宿主原生工程
格式以完整保留编辑结果。插件不会把有损写回伪装成无损。

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
4. 不覆盖用户选择：已安装（含用户停用、或自行安装了其它版本）时保持原状；
   目录被移除而注册表仍在时重新补齐，但保留此前的停用状态。

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
| 全局速度 | 工程 BPM（VSQX/VPR 的 `bpm × 100` 会先除以 100） |
| 拍号 | 工程拍号（取第一处） |
| PIT + PBS（VOCALOID） | 音高曲线：`相对半音 = PIT × PBS / 8191`，叠加到音符基础音高 |
| `pitchDelta`（SVP） | 音高曲线：`cent / 100` 半音，叠加到音符基础音高 |
| 轨道颜色 | 歌手颜色（`0xAARRGGBB` → `#rrggbb`） |

歌词中的 `br` 是 Synthesizer V 的呼吸标记。宿主的声学模型把 `<AP>` 定义为
可发声的吸气音素（`src/inference/phone_set.json`、用户指南与音素预处理注释一致），
与表示静音的 `<SP>` 不是同一概念。因此导入时把 `br` 转译为 `<AP>`，写回时还原为
`br`，保证往返对称；`<SP>` 与普通歌词不参与转译。三种格式共用同一条歌词映射，
不存在某一格式单独漏译的情况。

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
| SVP 颤音 | 无等价字段，统计受影响音符数并告警 |
| VOCALOID 音素、歌手、风格 | 不导入；歌词保留，音素由宿主按歌词推导 |
| 音高曲线 | 是"音符基础音高 + 控制器偏移"的采样近似，不是逐采样还原 |
| 重叠音符 | 按后一个音符的起点裁掉前一个的尾巴（编辑器假定音符不重叠） |
| 非法/零长度音符 | 跳过，不阻断整份工程 |
| 写回外部格式 | 歌手库、音色与风格、颤音、音素属性、变速与变拍号、前导小节与弯音灵敏度曲线不写入；逐条返回告警，并建议另存为宿主原生工程格式 |

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

`test/pluginProjectImport.test.js`（13 个用例）用三份最小样例工程断言**内容一致**，
而不只是"没抛异常"：

| 样例 | 断言 |
|---|---|
| `test/fixtures/plugin-import/sample.vsqx` | preMeasure 偏移后起点 1 拍；BPM 90；3/4；音符 60/64/67 与歌词 la/li/lu；PIT=4096、PBS=2 → 第二音符 +1 半音 |
| `test/fixtures/plugin-import/sample.vpr` | ZIP 内 `Project/sequence.json`；BPM 90；4/4；音符 60/64 与 do/re；pitchBend=8191、PBS=2 → +2 半音 |
| `test/fixtures/plugin-import/sample.svp` | blickOffset=1 拍；BPM 100；轨道色 `#3366cc`；音符 60「啊」/62「呀」；pitchDelta 50 音分 → 0.5 拍处 60.5 |

三份输出都再经过 `validateProjectDocument`，确保能直接进编辑器。此外还断言：

- 三种格式的 `read → write → read` 往返：音符、速度、拍号与音高曲线采样保持一致；
  写回产物分别是合法的 XML、ZIP 与 JSON 容器，不是空壳。
- `br` ↔ `<AP>` 双向转译对称，`<SP>` 静音与普通歌词不受影响；并用一份含呼吸
  音符的 SVP 走完整的字节往返。
- manifest 的三个 `fileTypes` 都声明 `role: "both"` 与 `userPicked:write` 权限，
  且每个 codec 同时实现 `read` 与 `write`。
- 写回返回的告警含有损说明，以及另存为宿主原生工程格式的建议。

内置安装、界面 EP 显示与曲线采样另有独立回归测试：
`test/pluginBuiltinInstall.test.js`（首次安装、不覆盖、停用保持、拒绝卸载）、
`test/copyWebpackClosure.test.js`（随包目录完整性）、`test/epLabel.test.js`、
`test/automationCurve.test.js` 与 `test/winmlEpState.test.js`。

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
