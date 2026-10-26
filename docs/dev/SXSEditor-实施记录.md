# SXSEditor 实施记录

> 基线 `d6805a8` → 本次改动约 20 个文件（新增 5 个 shared 纯函数模块）
> 执行顺序：**审查缺陷修复 → 工程文件地基（M0）→ auto 引擎（M1/M2）→ 渲染与交互（M3）→ 重合处理与导入（M4/M5）→ 导出（M6/M7）**

---

## 一、已实施（可直接运行）

### 1. 审查缺陷修复

| 编号 | 修复内容 | 文件 |
|---|---|---|
| **F1** | 文档语义改正：锚点是**绝对 MIDI 音高**，不是"音符音高 + 偏移"（中英文同步） | `docs/user/fragment-editor.html` |
| **F2** | 抽 `shared/activeNotes.js`（`computeActiveClippedNotes` / `lastNoteEnd` / `firstNoteStart`），五处调用点统一：过滤 inactive → 裁剪 → **按 start 排序**；总时长改用 `max(start+duration)`；音频前置偏移改用 `min(start)` | 新增 `src/shared/activeNotes.js`；`canvasRenderer.js`、`renderer/audioPlayback.js`（3 处 + 2 处偏移）、`fragmentEditor/audioPlayback.js`（2 处偏移）、`mcpAutomation.js`、`preprocessing.js` |
| **F3** | 主窗口不再把未激活的重叠音符唱出来（与编辑器同一套过滤） | `renderer/audioPlayback.js`、`mcpAutomation.js` |
| **F4** | 锚点作用域外**延续首/末锚点值**，不再跳回 `note.pitch`（两条路径同一行为，笔刷优先级保留） | `f0Utils.js`、`canvasRenderer.js`、`shared/autoPitchCurve.js` |
| **F5** | F0→锚点分箱**按秒**（默认 40ms，与 BPM 解耦）+ 时间戳取**桶内真实平均时间**（消除半箱滞后） | `f0Utils.js` |
| **F6** | **RDP 抽稀**（默认 6 音分）+ 锚点上限 4000 + 导入时打印实际数量 | `f0Utils.js` |
| **F7** | 生成前**中值 + Savitzky-Golay 滤波**；写入 `strength: 80`；`smoothness` 随桶宽自适应（10/20/30） | `f0Utils.js` |
| **F8** | FCPE 的 `bend` 在导入时携带 | `fragmentOperations.js` |
| **F9** | 锚点音域：生成阶段仍按量化器范围 [24,108] 过滤，八度偏差按整八度校正 | `f0Utils.js` |
| **F10** | 曲线随音符跟随（auto 层由音符派生，改音高自动更新） | `shared/autoPitchCurve.js` |
| **F11** | 渲染采样点 = 均匀采样 **∪ 全部锚点时间**（锚点必被画出，不再"看着干净听着抖"） | `canvasRenderer.js` |
| **F12** | MIDI 导出新增 **14-bit pitch bend**（每 16 分音符采样曲线，±2 半音） | `midiExport.js` |

### 2. M0 工程文件地基（auto 能存住的前提）

| 改动 | 文件 |
|---|---|
| 新增 `createDefaultPitchCurve` / `normalizePitchCurve`（**合并式**归一化，保留未知字段）、`hasManualContent` | 新增 `src/shared/pitchCurveState.js` |
| 新增版本常量与兼容判定 `checkProjectHeader`（`version` / `minReader` / `features`） | 新增 `src/shared/projectFormat.js` |
| **修掉三字段白名单**：`setPitchCurve({enabled, anchorPoints, brushSegments})` → `setPitchCurve(normalizePitchCurve(...))`（这是"打开一次编辑器就丢 auto"的根因） | `fragmentEditor/ipcHandlers.js` |
| `createFragment` 改为合并归一化；**默认值分入口**（新建分片 auto=on，加载旧工程 auto=off） | `editor/trackManager.js` |
| 版本号常量化（原来 `'1.1.0'` 与 `[1,1,0]` 两处硬编码）；写入 `minReader` / `features`；读取走统一判定 | `renderer/projectManager.js` |
| 新增文案 `projectMinReaderTooHigh`（中英） | `i18n/zh-CN.js`、`i18n/en.js` |

### 3. M1/M2 auto 引擎

新增 `src/shared/autoPitchCurve.js`（纯函数，无 DOM）：

- `AUTO_PITCH_DEFAULTS` / `AUTO_PITCH_PRESETS`（off/soft/natural/power/ballad）/ `AUTO_PITCH_PARAM_RANGES`
- `normalizeAutoConfig`（合并 + 夹紧 + 枚举校验）
- `autoPitchAt`：起音滑音、滑音（按速度缩放）、**过冲（起点落在滑音之后）**、**预备（反向）**、句尾下滑、抖动、量化、音域夹紧
- `applyJitterToF0`：抖动**后置**叠加（避开中值/SG 削峰）
- `computeManualCoverage` / `coverageAt` / `boundaryWeight`：手动作用域与 25ms 边界过渡
- `evalManualAt`：锚点 → 笔刷 → 派生段
- `createPitchResolver`：**预构建求值器**（热路径用，一次排序多次求值）
- `applyAutoVibrato`：给长音符自动填 `note.vibrato`（含 `rateDrift` / `depthDrift`）
- `resolvePitchRanges`：按语言返回 base[28,88] / ja[48,84]

两条消费路径接入：
- 主窗口 `f0Utils.buildFragmentPitchCurveF0` → 同一 resolver；**auto 开启但无手动内容时也产出 F0**（原来返回 null → 平线）
- 分片编辑器 `canvasRenderer.getPitchAtTime` / `buildPitchCurveF0Data` → 同一 resolver（缓存键含 notes/pitchCurve 版本）；`isPitchCurveCustomized` 计入派生段

### 4. M3 渲染与交互

- **三色**：`pitchAutoActive`（白）/ `pitchAutoMuted`（灰虚线）/ `pitchManual`（沿用原色）；四套主题均加了 token，**light-paper 用深色**（白不可见）
- 手动区背景带（`pitchManualRegion`）
- **拖动自动曲线 = 派生**：`hitAutoCurveAt` 命中（仅作用域外、±6px）→ `createBakedSegmentAt` 复制快照 → 拖动整体平移 → 撤销栈；`Ctrl/Cmd+点击` 强制新建锚点
- **空白新建锚点**：锚点所在音符区间自动并入作用域 → 该段自动曲线转灰
- 撤销快照包含 `auto` + `bakedSegments`；Reset 同时清派生段
- 参数面板：开关 / 预设下拉 / **15 个可编辑参数** + `换音过渡归属` 三档（无只读项，改任一参数自动切 custom）

### 5. M4 重合处理

- `applyGlideOwnership`（`shared/postprocessCurves.js`）：`auto` 档把 `f0Glide` 置零，`post` 档让自动层不产生滑音，`both` 档叠加
- 抖动 `jitterStage: 'post'` 在两条路径均在滤波后叠加
- 面板内注明归属关系

### 6. M5 F0 导入改造

- `f0DataToSlipSegments`：只把**偏离音符 > 25 音分**的连续区间做成 `bakedSegment`，其余交给 auto
- 导入路径不再写几千个锚点（原来 3 分钟约 4500 个 / 260KB）

### 7. M7 旧版兼容导出

- `buildLegacyProjectJson()`：全自动分片把 auto **烘焙成锚点**（0.08 拍），版本写 `1.1.0`，剔除 `auto`/`bakedSegments`
- `exportLegacyProject()`：弹保存对话框写盘

---

## 二、验证结果（实际跑通，非静态推断）

| 项目 | 结果 |
|---|---|
| 全部改动文件语法检查 | 20/20 通过（ESM `--check`） |
| F0→锚点往返（BPM 60/120/240） | 平均 11.8 / 12.5 / 15.9 音分；锚点数 16–18 个/秒（修复前 17.0/**286** / 8.1/153 / 0.3/8，锚点数固定 50） |
| F4 区间外 | 拍 2.0→60、2.1→60、3.9→60（修复前 64） |
| 工程往返 | `auto` + `bakedSegments` 全字段保留；编辑器归一化后仍在 |
| 旧工程 / 新建分片 | `auto.enabled` = `false` / `true` ✓ |
| 版本矩阵 | 1.0→ok / 1.1→ok / 1.3→confirm / 2.0→reject / 无版本→ok |
| 过冲 | 7 半音跳进 → **41 音分**（上限 40），峰值落在滑音结束之后（beat 2.19） |
| 滑音 | 90ms 内 60→67 平滑过渡；阈值调到 12 半音后不再滑 |
| 抖动 | `includeJitter=false` → 0；`jitterCents=10` → 峰峰 21.8 音分 |
| 作用域 | 单锚点 → 只覆盖所在音符；区外走自动；F4 在区内生效 |
| auto 开启但无手动 | 150 帧 F0（修复前 null → 平线） |
| auto 关闭（旧工程） | 仍返回 null，与 v2.0.2 一致 |
| 自动颤音 | 只填长音符、跳过用户已启用的、不改短音符 |

验证脚本：`/workspace/pitch-f0-audit/verify-{fix,m0,auto}.mjs`（`node --experimental-detect-module` 直接运行）。

---

## 二B、Linux 构建与 MCP 实机核验

### 构建

- `npm run package:lite` 产出 **`out/SXSEditor-linux-x64/`**（Electron 24 可执行包）。
- 构建注意事项：
  1. `sxs-ort-bridge`（`native/ort-bridge`）声明 `os: win32`，Linux 上 `npm ci` 会 EBADPLATFORM → 用 `--force`；
  2. `onnxruntime-node` 的 postinstall 需联网拉二进制 → `--ignore-scripts` 后单独补 `node node_modules/electron/install.js`（ELECTRON_MIRROR 指向 npmmirror）；
  3. `@electron/rebuild` 需联网下载 Electron headers → 本仓库的 native 模块（decibri/ort-bridge）都是 Windows 专用，Linux 构建加 `packagerConfig.nativeRebuild: process.platform !== 'linux'`（已写入 forge.config.js，Windows/macOS 行为不变）；
  4. @electron/get 下载 Electron zip 需 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

### MCP 实机核验（打包产物 + Xvfb 实跑）

| 核验项 | 结果 |
|---|---|
| MCP 端点 | 打包产物启动后 `~/.config/SXSEditor/mcp-endpoint.json` 正常生成，bridge 127.0.0.1 正常监听 |
| 新方法暴露 | `GET /schema` 方法数 46，含 **`fragment.getPitchCurve` / `fragment.setPitchCurve`** |
| 默认状态 | 新建分片 → `auto.enabled=true, preset=natural`，15 个参数齐全，anchors=0 |
| 参数写入 | `setPitchCurve` 改 `overshootMaxCents: 70 / jitterCents: 10` → 读回一致，`version` 自增 |
| 手动锚点写入 | 2 个锚点（拍 2.4/3.4）→ 读回一致 |
| **作用域计算** | coverage = `[{start:2, end:4, kind:"anchor"}]` —— 锚点所在音符区间自动成为手动区 ✓ |
| **自动曲线渲染** | 打包产物实跑截图：4 个音符上均叠加白色自动曲线（见下图） |
| 主窗口徽标 | 分片卡片显示 "Auto" 徽标（见下图） |
| 工具栏 | "Auto" 开关勾选、"自然" 预设下拉、Pitch 模式高亮、i18n 正常 |

![分片编辑器：白色自动曲线](docs/images/verify/editor-auto-curve.png)

![主窗口：Auto 徽标](docs/images/verify/fragment-badge-auto.png)

### MCP 核验中发现的一个边界

`fragment.setPitchCurve` 修改主窗口的 fragment 数据后，**已打开的分片编辑器窗口不会自动刷新**（原项目的同步是单向的：编辑器→主窗口）。若编辑器窗口开着，之后编辑器的 500ms 自动保存会用旧数据覆盖。当前用法：MCP 写入前先关闭该分片的编辑器窗口（`fragment.open` 重新打开即可拿到新数据）。补一条"主窗口→编辑器"的推送通道在任务 #9 里跟踪。

### 测试回归

- 全量 `npm run test:ci`：**2010 passing / 7 failing**，失败项全部是 Windows 专有（NPU PowerShell 探测 ×3、WinML onnxruntime.dll ×4），Linux 环境必然失败，与本次改动无关。
- 两个音高曲线测试（bisect 等价性 / rendererPostprocessParity）的**线性参考实现已同步 F4 新语义**（作用域内延续端点、作用域外交回音符音高），等价性守护仍然逐点成立。

---

## 三、未实施（需要 UI 层或额外确认，非核心）

| 项 | 原因 | 接入位置 |
|---|---|---|
| **MCP 暴露 auto 读写** | `mcpSchema.js` 的工具表结构与 handler 参数校验需要整体对齐，改动面大于本次范围 | `shared/mcpSchema.js` + `renderer/mcpAutomation.js` |
| **主窗口入口与"自动/手动"徽标** | 需要 timeline 卡片渲染与检查器 UI | `renderer/timelineRenderer.js`、分片检查器 |
| **自然度自检面板** | 依赖 9 项指标的实时 UI | 分片编辑器右侧检查器 |
| **Alt 局部高斯变形** | 拖动派生目前只做整体平移（先保证语义正确） | `eventHandlers.js` 的 `pitch-baked` 分支 |
| **批量工具**（抽稀/选区平滑/整体移调/贴合半音） | 独立工具条功能 | 分片编辑器工具栏 |
| **F13–F16** | `insertAnchor` smoothness 口径、SG 的 Hz 域混合、预处理卷轴 F0 只读、吸附/复制/形状库 | 见审查报告 F13–F16 |

---

## 四、兼容性与回归风险

1. **旧工程听感不变**：`auto.enabled` 缺省 `false`；`rateDrift`/`depthDrift` 缺省 0；`f0Glide` 在没有 auto 时行为不变。
2. **已知行为变化（有意）**：
   - 锚点区间外不再跳回 `note.pitch`（F4）——这是修复，但会改变旧工程在该处的听感；
   - 分片编辑器与主窗口现在都不再合成未激活的重叠音符（F3）——主窗口侧是修复；
   - F0→锚点默认带 `strength: 80` 与滤波，导入曲线不再"原样含噪"。
3. **风险点**：`canvasRenderer.getPitchAtTime` 现在依赖 shared resolver，缓存键少了 `auto.version`（已由 `pitchCurveVersion` 覆盖，因为改 auto 会 `invalidatePitchCurveCache()`）。若将来有其他路径在**不 bump 版本**时改 auto，需要补键。
4. **未跑仓库测试套件**：环境未安装 `node_modules`（Electron 依赖体积大），本次用等价纯函数脚本验证。建议在 CI 上先跑 `npm run test:ci`，重点关注 `test/rendererPostprocessParity.test.js`（F4 改动会影响其中"区间外回落到 note.pitch"的断言，但该用例的末锚点与 note.pitch 同为 60，应仍通过）。
