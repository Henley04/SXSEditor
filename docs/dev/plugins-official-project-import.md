# 官方工程导入插件（VOCALOID / Synthesizer V）

> 插件 id：`official-project-import` · 版本 1.0.0 · 发布者 `SXSEditor Official`
>
> 源码：`plugins/official-project-import/` · 签名包：`dist-plugins/official-project-import-1.0.0.sxsp`

## 1. 支持的格式

| 扩展名 | 来源 | 容器 | 版本 |
|---|---|---|---|
| `.vsqx` | VOCALOID 3 / 4 | XML（`vsq3` / `vsq4` 命名空间） | 3.x、4.x |
| `.vpr` | VOCALOID 5 / 6 | ZIP，工程在 `Project/sequence.json` | 5.x、6.x |
| `.svp` | Synthesizer V / SV2 | JSON（可用 `\u0000` 串联多份，取 version 最大者） | 1.x / 2.x 工程 |

导入是**只读**的：插件只声明 `role: "open"`，只出现在「文件 → 打开工程」，
不会出现在「另存为」。原因是这些格式里的歌手、风格、颤音、音素等字段在
SXSEditor 中没有等价表达，写回必然丢数据；需要保留原格式时请保留源文件。

## 2. 安装

1. 启动 SXSEditor，打开「插件管理器」。
2. 点「安装插件…」，选择 `dist-plugins/official-project-import-1.0.0.sxsp`。
3. 包由内置官方密钥签名（`ed25519-a9e0599774865c81`），安装时直接显示
   `verified / SXSEditor Official`，**不会**出现未知来源的信任横幅。
4. 也可以在「文件 → 打开工程」时直接选择 `.vsqx` / `.vpr` / `.svp` —— 未安装时
   宿主会提示缺少可处理该格式的插件。

验证安装是否可信：

```powershell
npx electron . --cli plugin verify official-project-import
# official-project-import: 安装目录与安装时的清单一致
```

## 3. 使用与映射结果

打开文件后，插件返回宿主工程文档，宿主再走 `validateProjectDocument` 校验，
所以进入编辑器的一定是合法文档。映射关系：

| 源工程 | SXSEditor |
|---|---|
| 每条有音符的轨道 | 一个歌手（`type: 'singer'`，轨道名同时作为 `trackName` / `singerName`） |
| 轨道里的每个 part / 音符组 | 一个分片（`fragment`），保留起始拍、时长、名称 |
| 音符 `posTick` / `onset` / `pos` | 相对分片起点的拍（1 拍 = 四分音符） |
| 音符音高 | MIDI 音高，整数 |
| 歌词 `lyric` / `y` / `lyrics` | 音符歌词（最多 24 字符；空歌词回落为 `la`） |
| 全局速度 | 工程 BPM（VSQX/VPR 的 `bpm × 100` 会先除以 100） |
| 拍号 | 工程拍号（取第一处） |
| PIT + PBS（VOCALOID） | 音高曲线：`相对半音 = PIT × PBS / 8191`，叠加到音符基础音高 |
| `pitchDelta`（SVP） | 音高曲线：`cent / 100` 半音，叠加到音符基础音高 |
| 轨道颜色 | 歌手颜色（`0xAARRGGBB` → `#rrggbb`） |

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

## 5. 为什么是一个插件而不是两个

三种格式的差异集中在"怎么把字节读成中间谱面"：`.vsqx` 是 XML、`.vpr` 是 ZIP+JSON、
`.svp` 是 JSON。读出来之后走的是**同一条**管线（`lib/score.js`）：

```
reader（3 个，各自约 100–390 行）
   → { bpm, timeSignature, tracks[].parts[].notes/pitchOffsets }
   → buildDocument：轨道→歌手、part→分片、音符清洗、音高采样、文档组装
```

共享部分（`score.js` + `main.js` 的 read 包装，约 60–70% 的导入代码）承担了
全部映射与宿主契约；拆成两个插件只会复制这条管线，并把"官方签名 + 安装"
做两遍。格式识别由宿主按扩展名路由，单插件不会让 `.svp` 与 VOCALOID 互相干扰。

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

`test/pluginProjectImport.test.js`（6 个用例）用三份最小样例工程断言**内容一致**，
而不只是"没抛异常"：

| 样例 | 断言 |
|---|---|
| `test/fixtures/plugin-import/sample.vsqx` | preMeasure 偏移后起点 1 拍；BPM 90；3/4；音符 60/64/67 与歌词 la/li/lu；PIT=4096、PBS=2 → 第二音符 +1 半音 |
| `test/fixtures/plugin-import/sample.vpr` | ZIP 内 `Project/sequence.json`；BPM 90；4/4；音符 60/64 与 do/re；pitchBend=8191、PBS=2 → +2 半音 |
| `test/fixtures/plugin-import/sample.svp` | blickOffset=1 拍；BPM 100；轨道色 `#3366cc`；音符 60「啊」/62「呀」；pitchDelta 50 音分 → 0.5 拍处 60.5 |

三份输出都再经过 `validateProjectDocument`，确保能直接进编辑器。

```powershell
npx mocha --require ./test/setup.js "test/pluginProjectImport.test.js" --timeout 30000
npx mocha --require ./test/setup.js "test/pluginSignature.test.js" --timeout 30000
```

### 7.2 对照开源实现

用 UtaFormatix 仓库的公开样例做过交叉检查（只在本地临时目录，不随仓库分发）：

- `sample.svp`：4 个音符、BPM 120、pitchDelta 50 音分，导入结果与样例一致；
- `vsqx_export.vsqx`：4 个音符 do/re/mi/fa、245 个 PIT 点，音高与起止拍一致；
- `vpr_export.txt`（其内容压成 ZIP 的 `Project/sequence.json`）：4 个音符、
  pitchBend 2048、速度 120→140，导入后取 120 并给出变速告警；
- `svp_import.ufdata`：确认 tempo 120/140 分别位于 tick 0/960，与解析结果一致。

### 7.3 签名包安装

在隔离的临时插件根目录、`requireSignature = true` 下：

- 官方包安装成功，状态 `verified`，keyId `ed25519-a9e0599774865c81`，
  publisher `SXSEditor Official`；
- 用临时陌生密钥重签同名插件后安装被拒，返回 `SIGNATURE_UNKNOWN_KEY` 与
  `pendingKey`，不会覆盖已安装的官方目录。

## 8. 重新打包与签名

```powershell
node scripts/package-plugin.js plugins/official-project-import `
  -o dist-plugins `
  --key "D:\Document\electron\SXSEditor-official-keys\plugin-signing.key" `
  --publisher "SXSEditor Official"
```

私钥在仓库之外，不入库。签名与信任的机制见 `docs/dev/plugins-signing.md`。
