# SXSEditor 音高曲线 ↔ F0 转换审查报告（最终合并版）

> 审查对象：`github.com/henley04/sxseditor`（SoulX Singer Editor v2.0.2）
> 代码基线：`d6805a8`（2026-10-25 克隆）
> 三方合并：**本报告（R1，本次实测）** + 资料库《sxseditor-pitch-f0-review》（R2）+ 资料库《SXSEditor 模拟器式代码审查报告》（R3）
> 结论数据均由实际跑通仓库源码测得，脚本见 `/workspace/pitch-f0-audit/`（4 个文件，`node --experimental-detect-module` 直接运行，无需安装依赖）

---

## 0. 三方结论交叉核对

### 0.1 互相印证（可确认）

| 结论 | R1 | R2 | R3 | 裁定 |
|---|---|---|---|---|
| 数学内核正确（MIDI↔Hz、强度/平滑插值、SG 系数、cents 域滤波） | 边界实测通过 | 107 项断言通过 | — | ✅ 确认 |
| 音符数组乱序 → F0 被截断 | 实测 100 帧 vs 管线 50 帧 | — | 实测 150 帧 vs 应有 300 帧，丢 3 秒 | ✅ 确认，根因=R3（`getClippedNotes()` 不排序 + 新建音符 `push` 到末尾） |
| 锚点区间外回落 `note.pitch` | 实测拍 2.0→60、拍 2.1→64 | 实测拍 2.04 突回 440Hz（12 半音阶跃） | — | ✅ 确认（定性见下方分歧） |
| 长音频导入锚点膨胀 | 4500 锚点 / 260KB | 4500 锚点 / 分片 | — | ✅ 一致 |
| 颤音叠加、f0Shift 统一偏移、滤波不跨静音段 | 一致 | 一致 | — | ✅ 确认 |

### 0.2 分歧与裁定

| 分歧点 | 各方说法 | 本次裁定 |
|---|---|---|
| **区间外回落的定性** | R2：设计行为、非 bug，建议暗色/虚线提示<br>R1：P0 缺陷，应改为延续末锚点值 | **合并为 P1**：两条路径行为一致、确实不是代码 bug；但它是"与新手预期相反且无提示"的可操作性缺陷。且**新增实测**：若按 R2 建议单独改箱中心分箱，尾部会多出半箱无锚点 → 尾部阶跃从 400 音分恶化到 **1188 音分**。因此**箱中心修复必须与"末端保持"配套**，不能单独上线 |
| **架构"单一真源"是否成立** | R2：优秀 | **降级为"良好"**：数学真源（automationCurve / f0Smoothing）确实收敛了，但 **F0 构建仍有两份实现**（`buildPitchCurveF0Data` vs `buildFragmentPitchCurveF0`），靠注释 + parity 测试维持；F3（重叠音符未激活过滤）已证明它仍会分叉 |
| **MCP 是否暴露音高曲线读写** | R2：已暴露 | **裁定为未暴露**：`mcpSchema.js` 中无 `pitchCurve` / `anchorPoints` 的工具定义；`mcpAutomation.js:416` 只是在合成路径内部调用 `buildFragmentPitchCurveF0`。R2 表述不准确 |

### 0.3 各自独有发现（全部纳入下表）

- **R1 独有**：文档语义错误（绝对 vs 相对）、分箱单位用"拍"导致 BPM 耦合、强度不能去噪、曲线与音符解耦、渲染视觉欠采样、主窗口三处 `clippedNotes` 同样不排序
- **R2 独有**：重叠音符 inactive 过滤不一致（R1 已复现确认）、FCPE bend 丢弃、MIDI 导出无弯音、锚点无音域检查、insertAnchor smoothness 口径不一、SG 混合在 Hz 域
- **R3 独有**：乱序的根因定位与另外两个同源 bug（首 chunk 延迟、音频整体平移）——R1 补充确认**主窗口 `audioPlayback.js:952/1839` 存在同样的 `clippedNotes[0]` 首元素假设**

---

## 1. 最终结论

| 维度 | 评价 |
|---|---|
| 数学正确性 | **优秀**。锚点强度/平滑、MIDI↔Hz、cents 域中值/SG/贝塞尔、跳变两级判定（颤音零误判）全部验证正确 |
| 架构合理性 | **良好**。数学真源已收敛，但 F0 构建仍双实现，且已出现一次真实分叉（F3） |
| 双向转换保真度 | **中等**。默认密度下往返平均 8–17 音分；慢歌（BPM 60）最大偏差 **286 音分**；边界存在整段跳变 |
| 用户可操作性 | **良好偏下**。单锚点编辑模型完整；自动生成场景（4500 锚点）下不可用 |
| 自动音高曲线 | **空壳**。`generateAutoPitchPoints` 只生成音符首尾同音高点且恒被跳过 |

---

## 2. 缺陷总表（合并后统一编号）

| # | 问题 | 位置 | 来源 | 级别 |
|---|---|---|---|---|
| F1 | 文档写"最终音高 = 音符音高 + 曲线偏移"，实现是**绝对音高** | `docs/user/fragment-editor.html:357` | R1 | **P0** |
| F2 | 音符数组乱序 → F0 截断；主窗口 4 处构造同样不排序，且用 `clippedNotes[0]` 算音频偏移 | `canvasRenderer.getClippedNotes` / `audioPlayback.js:552,897,1781,952,1839` / `mcpAutomation.js:409` / `preprocessing.js:96` | R3 + R1 | **P0** |
| F3 | 重叠音符：编辑器过滤未激活音符，主窗口不过滤 → 两处听感不同（实测拍 5/5.9 主窗口仍唱出 60） | `audioPlayback.js:552` vs `canvasRenderer.js:507` | R2（R1 复现） | P1 |
| F4 | 锚点区间外曲线被丢弃、跳回 `note.pitch`，无视觉提示 | `f0Utils.js:121` / `canvasRenderer.js:1092` | R2 P4 + R1 | P1 |
| F5 | F0→锚点分箱：单位用"拍"（BPM 耦合）+ 取箱起点（半箱延迟） | `f0Utils.js:279,293` | R1 + R2 P2 | P1 |
| F6 | 锚点膨胀：4500 个/分片、260KB JSON、撤销栈深拷贝 | `f0Utils.js:279` | R2 P5 + R1 | P1 |
| F7 | 生成锚点无 `strength`（缺省 100，噪声全保留）、`smoothness` 硬编码 30、无预滤波 | `f0Utils.js:300` | R1 | P2 |
| F8 | FCPE pitchBends 在导入时被丢弃，"保留滑音"量化模式失效 | `fragmentOperations.js:182` | R2 P3 | P2 |
| F9 | 锚点不受 `PITCH_RANGES` 检查；MIDI>108 时 quantizeF0 钳到 bin360 而 vocoder 拿原始 Hz，两路不一致 | `canvasRenderer.js:791` / `preprocessing.js:146` | R2 P7a + R1 | P2 |
| F10 | 曲线与音符解耦：改音符音高曲线不跟随（无 transpose 同步） | 全局 | R1 | P2 |
| F11 | 渲染视觉欠采样：全曲视口只采约 1200 点，**看到的曲线比听到的干净** | `canvasRenderer.js:1971` | R1 | P2 |
| F12 | MIDI 导出不含音高曲线（无 pitch bend） | `midiExport.js:38-70` | R2 P6 | P3 |
| F13 | `insertAnchor` smoothness 缺省 30，与 `snapshotAnchors`/文档语义的 0 不一致 | `automationCurve.js:146` | R2 P7b | P3 |
| F14 | SG 混合在 Hz 域而非 cents 域（w=0.5 时约 8 音分，可忽略） | `f0Smoothing.js:434` | R2 P7c | P3 |
| F15 | 预处理钢琴卷轴 F0 曲线只读，歌手流程无法修 F0 | `pianoRoll.js:696` | R2 P7d | P3 |
| F16 | 无半音吸附、无跨分片复制粘贴、无形状库、右键菜单无数值输入 | — | R2 | P3 |

---

## 3. 关键缺陷详解（含实测）

### F1（P0）文档与实现的语义冲突

`docs/user/fragment-editor.html:357`：

> The final pitch is: **MIDI note pitch + pitch curve offset**. ｜ 最终音高为：**MIDI 音符音高 + 音高曲线偏移**

实现里锚点存的是绝对 MIDI，直接换 Hz（`f0Utils.js:72`），没有 `+ note.pitch`。用户按文档把锚点当偏移量画会得到废值。这份文档是新人理解"自动/手动曲线共存"的基础，必须先改——自动音高曲线的设计（见配套方案文档）正是建立在"曲线是绝对音高"这一真实语义上的。

### F2（P0）乱序：一个根因，四处表现

根因（R3 定位）：`eventHandlers.js` 新建音符 `getNotes().push(newNote)` 不按 start 重排，而 `getClippedNotes()` 只 filter + 裁剪、**不排序**，多个消费方却隐式假定"数组有序"。

| 消费方 | 假设 | 后果 |
|---|---|---|
| `canvasRenderer.buildPitchCurveF0Data` | 末元素 = 最晚音符 | F0 150 帧 vs 应有 300 帧，尾部 3 秒 conditioning 丢失 |
| `fragmentEditor.audioPlayback.js:953/792` | 首元素 = 最早音符 | 首 chunk 延迟 4.05s（应 0.05s）；音频整体平移 4 秒 |
| **主窗口 `audioPlayback.js:952/1839`** | 首元素 = 最早音符 | **同上，R3 未覆盖的主窗口同源点**（实测乱序首元素 start=8 拍 → 4.00s，正确 0.00s） |
| 管线 `buildF0FrameSequence` | 末元素 = 最晚音符 | 短数组尾部补 0 → unvoiced |

一处修复（`getClippedNotes()` 返回前按 start 排序 + 抽成 shared 的 `computeActiveClippedNotes(fragment)`）可同时覆盖 F2 与 F3。

### F3（P1）重叠音符两条路径不一致（R1 实测复现）

```
音符 A(拍 0-4, 音高 72) + 音符 B(拍 2-6, 音高 60)   // B 后插入 → 编辑器判定未激活
主窗口 buildFragmentPitchCurveF0：拍1=72  拍3=72  拍5=60  拍5.9=60
编辑器语义应为：              拍1=72  拍3=72  拍5=静音  拍5.9=静音
```

主窗口把编辑器里静音的段落唱了出来，播放/导出与编辑器试听听感不同。

### F4 + F5（P1）分箱与边界，必须成对修

```js
const anchorInterval = 0.08;                                             // 拍，而非秒
const anchorBeat = Math.floor(beat / anchorInterval) * anchorInterval;   // 箱起点
```

| BPM | 每锚点时间跨度 | 往返平均/最大误差（现状） |
|---|---|---|
| 60 | 80 ms | 17.0 / **286** 音分 |
| 120 | 40 ms | 8.1 / 153 音分 |
| 240 | 21 ms | 0.3 / 8 音分 |

取箱中心的收益（R1 实测，2 秒一个八度的滑音）：

| BPM | 箱起点 平均\|误差\| | 箱中心 平均\|误差\| | 系统偏移 |
|---|---|---|---|
| 60 | 52.7 音分 | 17.8 音分 | −17.8（偏低） |
| 120 | 18.3 音分 | **5.5 音分** | −5.5（偏低） |

**但箱中心会让尾部多出半箱无锚点** → 配合 F4 的"跳回 note.pitch"，尾部最大误差从 400 音分恶化到 **1188 音分**。二者必须成对上线。

### F7（P1）噪声保留，"强度"救不了

生成锚点不带 `strength` → 缺省 100 → 曲线强制穿过每个含噪锚点。降强度实测反而更偏离真值（120BPM，含颤音+抖动）：

| 强度 | vs 原始 F0 | vs 无噪真值 |
|---|---|---|
| 100 | 8.1 / 153 | 9.2 / 154 |
| 60 | 10.4 / 159 | 11.2 / 160 |
| 40 | 12.5 / 163 | 13.1 / 164 |

（平均 / 最大，音分）原因：强度只是"拉向邻居连线"，邻居本身也含噪，不等于低通。正确做法是在生成前用仓库现成的 `medianFilterF0` / `savitzkyGolayFilter` 预滤波。

### F6 / F11 规模与"看到的 vs 听到的"

3 分钟 @120BPM：9000 F0 帧 → **4500 锚点 / 260KB JSON**；`buildFragmentPitchCurveF0` 2.6ms、`deepClone` 2.8ms（性能可接受，瓶颈在工程体积与可操作性）。

渲染侧 `steps = min(max(200, w), denseSteps)`：全曲视口约 1200 点，每 8 个锚点才画 1 个 → **界面上被抹平的噪声，合成时一个不少地进入 F0**，用户"看着干净、听着发抖"。

---

## 4. 用户可操作性总评（合并）

**已具备**（R2 评价"同类产品中偏高水准"，R1 认同）：点击加锚点、拖动、Shift 画笔、右键拖拽调强度/平滑（带 HUD）、中键框选、右键上下文菜单（预设 + 删除）、Reset 还原、撤销/重做全覆盖、500ms 防抖自动同步、每音符颤音、F0 后处理 lane（默认全关的兼容性决策很专业）、自动实时推理约 1.3s 出声。

**缺失**（按对"自动曲线"的阻塞程度排序）：

1. 主窗口无入口：audio-to-MIDI 一次性写入 4500 锚点，用户必须打开分片编辑器才发现
2. 无批量工具：抽稀、选区平滑、整体移调、统一强度/平滑、贴合半音
3. 无半音吸附、无跨分片复制粘贴、无形状库（F16）
4. 无"曲线 vs 音符"偏差可视化（只有音符首尾散点）
5. F11 视觉欠采样
6. MCP 未暴露曲线读写（R2 表述有误，已裁定）

---

## 5. 修复优先级

| 批次 | 内容 | 工作量 |
|---|---|---|
| 第一批 | F1 文档；F2+F3 抽 shared `computeActiveClippedNotes()`（排序 + inactive 过滤），四处调用点对齐 | 小 |
| 第一批 | F4 区间外改为延续首/末锚点值（或至少灰化）；F5 分箱改按秒 + 箱中心（**与 F4 配套**） | 小 |
| 第二批 | F7 生成前滤波 + 写入 strength + smoothness 自适应；F6 抽稀（RDP）与上限 | 中 |
| 第二批 | F8 携带 bend；F9 锚点音域检查；F11 渲染采样保证不跨锚点 | 小 |
| 第三批 | F10 曲线跟随移调、F12 MIDI 导出弯音、F16 吸附/复制/形状库 | 中 |
| 第三批 | 补 parity 测试：编辑器 vs 主窗口逐帧相同；往返误差阈值断言 | 小 |

> 完整的自动音高曲线设计（数据模型、作用域与手动/自动共存规则、拖动派生语义、渲染配色）见配套文档 **《SXSEditor 自动音高曲线设计方案》**。

---

## 附：复现方式

```bash
cd /workspace/sxseditor
node --experimental-detect-module /workspace/pitch-f0-audit/audit-f0.mjs    # 往返误差、字段、音域过滤
node --experimental-detect-module /workspace/pitch-f0-audit/audit-f0b.mjs   # 平滑隔离、强度影响、按 BPM 误差
node --experimental-detect-module /workspace/pitch-f0-audit/audit-f0c.mjs   # 作用域边界、3 分钟规模、密度权衡
node --experimental-detect-module /workspace/pitch-f0-audit/audit-f0d.mjs   # 交叉验证 R2 的 P1/P2（箱中心、重叠音符、主窗口首元素）
```
