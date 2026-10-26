# SXSEditor 自动音高曲线设计方案 v2

> 配套文档：《SXSEditor 音高曲线与 F0 转换审查报告（最终合并版）》
> 代码基线：`d6805a8` ｜ 目标版本：v2.1
> 原则：**零训练、零模型改动**（遵循仓库自有研究 `docs/dev/svs-expression-params-research.md` 的 A4 结论）
> v2 更新：落实四大波动的参数化、**"开 auto 不阻拦手动"**的交互契约、参数全可编辑、**与音色面板 F0 后处理的重合处理**
> v2.1 更新：新增第 9 章——**`.sxsproj` 保存内容、旧版兼容矩阵、版本号管理**
> **实施状态（本次已落地）**：M0–M5、M7 与 MIDI 导出已实现并通过验证；MCP 暴露、主窗口入口、自然度自检面板、批量工具未实施。详见《SXSEditor-实施记录.md》。

---

## 1. 目标与非目标

**目标**

1. 打开自动生成后，**新画的 MIDI 与没有任何手动锚点的 MIDI 自动拥有自然的音高曲线**
2. 自动曲线**永不阻止手动编辑**，且手动优先的范围一眼可辨
3. auto 的**每个参数都可编辑**，预设只是起点
4. 与既有音色面板（F0 后处理）**明确分工、不打架**

**非目标**：不训练/替换模型；不改变现有手动锚点语义；不解决非 F0 的表现力问题。

---

## 2. 概念与术语

| 术语 | 定义 |
|---|---|
| **自动曲线（auto）** | 由**音符 + 参数**实时派生、不落盘的曲线。改音符自动跟随；工程里只存十几个参数 |
| **手动曲线（manual）** | 用户显式创建的资产：手动锚点、笔刷段、派生段。存盘、可撤销、不随音符变化 |
| **派生段（bakedSegment）** | 拖动自动曲线（或从 F0 导入）时，把当时的自动曲线**快照复制**成一段手动曲线 |
| **作用域（coverage）** | 手动元素在时间轴上覆盖的区间并集。作用域内用手动、自动置灰；作用域外用自动 |

**为什么自动曲线不落锚点**：F0→锚点方案在 3 分钟歌曲上产出 4500 锚点 / 260KB（审查报告 F6），既不能手工编辑，也不随音符更新（F10）。做成派生量，这两个问题从根上消失。

---

## 3. 交互契约：开了 auto 也绝不阻拦手动

这是本方案对用户的核心承诺，逐条可验收：

| # | 契约 | 具体保证 |
|---|---|---|
| C1 | **手动操作零改动** | auto 开启时，点击加锚点、拖动、Shift 画笔、框选、删除、右键调强度/平滑——**行为与 auto 关闭时完全一致**，代码路径不变 |
| C2 | **自动曲线可点可拖** | 在自动曲线上按下即派生为手动段（§3.3），不存在"点不动"的区域 |
| C3 | **手动资产不被污染** | auto **永不写入 `anchorPoints` / `brushSegments`**。用户的手动资产与 auto 开关无关，关掉 auto 后完整保留 |
| C4 | **手动区不随参数变化** | 拖自动曲线产生的派生段是快照，改预设/滑块不动它（避免"我调了个滑块，手改的地方被冲掉"） |
| C5 | **自动区实时响应** | 拖滑块时非手动区立即重画 → 参数效果可见 |
| C6 | **随时可退出** | 关闭 auto 或 Reset 手动元素，任一层都能单独撤销，互不影响 |
| C7 | **不弹阻断式弹窗** | 重合/冲突一律用面板提示条 + 数值说明，不做"请先关闭 XX"的拦截 |
| C8 | **每音符可覆盖** | `note.autoPitch = { enabled: false }` 让个别音符退出自动，无需改全局 |

### 3.1 生效规则

| 规则 | 行为 |
|---|---|
| **R1** | `auto.enabled = true` → 所有不含手动元素的音符实时生成自然曲线（白色） |
| **R2** | 新建/导入的 MIDI，只要音符区间内没有手动元素 → 立即自动出现曲线，无需任何点击 |
| **R3** | 作用域内一律用手动求值，自动曲线在该区间**只画不发声** |
| **R4** | 自动生效 = **白色实线**；被覆盖 = **灰色虚线**；手动 = **主题强调色实线** |
| **R5** | 拖动自动曲线 = **复制**一份相同曲线成为派生段（手动色），**原自动曲线不删除**（段外仍生效，段内转灰保留作参考） |
| **R6** | 空白新建锚点 → 该锚点所在区间并入作用域 → **该区间自动曲线置灰**，其余保持白色 |
| **R7** | 删除手动元素 → 对应区间自动回到白色自动曲线 |

### 3.2 作用域计算

| 手动元素 | 作用域区间 |
|---|---|
| 手动锚点 | **所在音符区间** ∪ **锚点凸包 `[min(t), max(t)]`**（单锚点退化为所在音符） |
| 笔刷段 | 段自身 `[points[0].time, points[last].time]` |
| 派生段 | 段自身 `[start, end]` |

并集后按 `mergeGapBeats`（默认 0.5 拍）合并相邻区间。实现见 `computeManualCoverage()`（§5）。

### 3.3 拖动自动曲线（R5）

```
mousedown 命中自动曲线（且不在 coverage 内）:
  R = 光标所在音符区间（Shift+点击 = 扩展到选中音符）
  pts = buildAutoCurve(R, step = 0.05 拍)       // 采样当时的自动曲线
  seg = { id, start, end, origin: 'auto-drag', autoPreset, paramsHash,
          points: pts.map(p => ({...p, strength: 100, smoothness: 0})) }
  bakedSegments.push(seg)
  拖动：默认整体垂直平移；Alt = 高斯局部变形（σ ≈ 0.25 拍）
  mouseup → history.push({ undo: removeSeg, redo: addSeg })
  → 段内自动曲线转灰；段外仍白色
```

- **"原自动曲线不删除"的三重保证**：① 自动层是参数化派生量，本就不存在删除；② 派生段只覆盖自身区间；③ 段内自动曲线仍以灰色绘制保留，可"按当前预设重新派生"
- 派生段记录生成时的 `autoPreset` 与 `paramsHash`；改预设不跟随，但右键提供「重新派生」

### 3.4 边界过渡

手动区边界落在**音符内部**时（笔刷/派生段端点），用 25ms 线性 crossfade，避免台阶；边界落在音符边界时不处理（该处 F0 本就不连续）。

---

## 4. 四大波动的参数化（自然度的来源）

### 4.1 颤音 Vibrato —— 复用现有 `note.vibrato`，不另起炉灶

**关键决策**：auto **不自己实现颤音**，而是**自动填充 `note.vibrato`**。理由：现有颤音已是每音符可编辑参数、UI/合成路径完整；再做一个自动颤音层必然双重叠加且不可编辑。

| 参数 | 真人典型 | 现有默认值 | 建议默认值 | 建议 UI 范围 |
|---|---|---|---|---|
| `rate` (Hz) | 3–9，常用 5–7 | 5.5 ✅ | **5.5** | 3.0–9.0，步进 0.1 |
| `depth` (cents) | **15–30** | **80** ❌ | **22** | 0–60 |
| `start` (音符占比) | 中后段起 | 0.2 ✅ | 0.25 | 0–1 |
| `length` (占比) | — | 0.8 ✅ | 0.75 | 0–1 |
| `fadeIn` (占比) | 渐入 | 0.3 ✅ | 0.35 | 0–1 |
| **`rateDrift`** (新增, %) | 周期末细微加减速 | — | **6** | 0–20，0 = 旧行为 |
| **`depthDrift`** (新增, %) | 深度随气息起伏 | — | 8 | 0–30，0 = 旧行为 |

> ⚠️ 实测：`DEFAULT_VIBRATO.depth = 80` 音分 = 0.80 半音，而真人典型是 15–30 音分。**现有默认值偏高约 3.2 倍**，这是"开个颤音就像抖嗓子"的根因。建议把默认值降到 22，并在 UI 上把 15–30 标为"自然区间"底色带。
> `rateDrift` / `depthDrift` 缺省 0，保证旧工程逐位不变。

**速率非恒定**（用户点名的细节）：相位改为

```js
phase = 2π * rate * (t + (rateDrift/100) * 0.5 * t² / T)   // T = 颤音总时长
// rateDrift = 6% → 一个颤音周期内速率缓慢加快约 6%，末尾比开头略急
```

自动填充规则（auto 侧参数）：`autoVibrato: { enabled, minDurationBeats: 1.5, depth, rate, drift }` → 时长 ≥ 阈值的音符自动写入 `note.vibrato`，**用户仍可逐音符改**（它是普通音符参数，不是 auto 的私有数据）。

### 4.2 过冲 Overshoot 与预备 Preparation —— 跳进的"惯性"

用户指出：过冲是影响自然感**最重要的单一因素**。参数化为**音程比例 + 上限**双控：

```js
overshootCents = min(params.overshootMaxCents, |Δ半音| * 100 * params.overshootRatio)
```

| 参数 | 建议默认 | 范围 | 说明 |
|---|---|---|---|
| `overshootRatio` | 0.25 | 0–0.5 | 过冲 = 音程 × 该比例 |
| `overshootMaxCents` | 40 | 0–120 | 上限，防止大跳进过冲过头 |
| `overshootMs` | 120 | 40–250 | 过冲衰减时长（指数衰减，τ = ms/3） |
| `prepCents` | **−15** | −40–0 | **预备**：跳变前朝反方向的微小动作 |
| `prepMs` | 30 | 15–60 | 预备时长 |
| `prepMinSemitones` | 2 | 0–12 | 音程小于此值不做预备（避免每个小二度都抖一下） |

7 半音跳进时默认效果：过冲 ≈ 25 音分、预备 ≈ 15 音分——落在用户建议的"10–20 音分小包"量级。

### 4.3 滑音 Portamento —— 平滑连接，且时长随速度走

| 参数 | 建议默认 | 范围 | 说明 |
|---|---|---|---|
| `glideMs` | 90 | 0–250 | 换音过渡时长 |
| `glideUnit` | `'ms'` | `ms` / `beats` | 按拍计时时随 BPM 自动缩放 |
| `glideAutoScale` | `true` | bool | 按速度自动缩放：**BPM<80 ×1.5（叙事曲稍长）、BPM 80–140 ×1.0、BPM>140 ×0.6（快歌收紧）** |
| `glideMinSemitones` | 2 | 0–12 | 音程小于此值不滑（同音/级进保持断奏感） |
| `glideCurve` | `'bezier'` | `bezier`/`linear`/`exp` | 默认复用 `f0Smoothing.cubicBezierY` |

原则：**永不产生台阶式 F0**。即使乐谱断奏，也在音符首尾保留符合气息的短过渡（`glideMs > 0` 即可）。

### 4.4 微抖动 Jitter —— 隐形的真实感

| 参数 | 建议默认 | 范围 | 说明 |
|---|---|---|---|
| `jitterCents` | 6 | 0–20 | 幅度（RMS 口径）；>15 会显得不稳 |
| `jitterSource` | `'synth'` | `synth`/`singer` | 抖动来源 |
| `jitterStage` | **`'post'`** | `pre`/`post` | **施加位置：后处理之后**（见 §6.3，这是关键） |
| `seed` | 0 | int | 确定性种子，保证撤销/重做与导出一致 |

- `synth`：确定性伪随机 + 一阶低通（避免逐帧跳变，更接近真人"慢抖动"）
- `singer`（用户建议的高级做法）：从歌手文件的 `singer.f0Data` 提取**残差模板**（原始 F0 减去 SG 平滑基线），切成片段随机拼接并缩放到当前音高与 `jitterCents`。仓库已具备数据源，无需新模型

**Jitter 必须覆盖所有持续音，包括颤音音符**（用户强调：无颤音的长音加 jitter 也能明显提升自然感）。

---

## 5. 自动曲线算法模块：`src/shared/autoPitchCurve.js`

放在 `shared/` 是**硬要求**：审查报告 F3 已证明主窗口与分片编辑器两份 F0 构建会分叉。该模块无 DOM、无 state，被两条路径共同 import。

```js
/** 单个时刻的自动音高（MIDI 绝对音高；null = 无覆盖，交由 note.pitch 回退） */
export function autoPitchAt(ctx, beat) {
  const note = findNoteAtBeat(ctx.notes, beat);
  if (!note || isUnvoiced(note) || !(note.pitch > 0)) return null;
  if (note.autoPitch?.enabled === false) return null;
  const p = resolveAutoParams(ctx.auto, note);        // 音符级覆盖优先
  const durSec = (note.duration / ctx.bpm) * 60;
  const ageSec = ((beat - note.start) / ctx.bpm) * 60;
  let v = note.pitch;

  v += prepOffset(note, prevVoicedNote(ctx.notes, note), ageSec, durSec, p);   // 预备（跳变前反向）
  v += glideOffset(note, prevVoicedNote(ctx.notes, note), ageSec, durSec, p, ctx.bpm); // 滑音
  v += attackOffset(ageSec, p);                       // 起音上滑
  v += overshootOffset(ageSec, p);                    // 起音过冲（音程比例 + 上限）
  v += releaseOffset(ageSec, durSec, p);              // 句尾下滑
  // 注意：jitter / vibrato 默认在「后处理之后」施加，见 §6.3
  if (p.quantize > 0) v = Math.round(v / p.quantize) * p.quantize;
  return clamp(v, ctx.ranges.min, ctx.ranges.max);    // PITCH_RANGES base[28,88] / ja[48,84]
}

/** 统一求值入口：手动 > 自动 > note.pitch，三条路径共用 */
export function resolvePitchAt(ctx, beat) {
  const cov = coverageAt(ctx.coverage, beat);
  let v = cov ? evalManual(ctx.pitchCurve, beat) : null;   // 锚点 → 笔刷 → 派生段
  const a = ctx.auto?.enabled ? autoPitchAt(ctx, beat) : null;
  if (cov && a !== null) {
    const w = boundaryWeight(ctx.coverage, beat, ctx.crossfadeMs ?? 25);
    v = v === null ? a : a * (1 - w) + v * w;
  } else if (!cov) v = a;
  if (v === null) v = ctx.activeNote?.pitch ?? null;       // 现有回退（F4 另案修复）
  if (v !== null) v += vibratoOffset(ctx.activeNote, beat, ctx.bpm);
  return v;
}
```

**可复用现成代码**：`cubicBezierY`（`f0Smoothing.js:317`）、`computeVibratoOffset`（`canvasRenderer.js:1019`）、`getOutOfPitchRangeNotes`（`canvasRenderer.js:829`）、`buildEffectiveValues`/`evalSortedCurve`（`automationCurve.js`）。

**预设**（开局 5 个，全部可微调后存为 custom）：

| 预设 | attack | overshoot(比例/上限) | prep | glide | release | jitter | 适用 |
|---|---|---|---|---|---|---|---|
| Off | — | 0 | 0 | 0 | 0 | 0 | 机械/电子风，等价现状 |
| Soft | 80ms/−40¢ | 0.15 / 25¢ | −10¢ | 120ms（≥3 半音） | −15¢ | 3¢ | 抒情、气声 |
| **Natural** | 60ms/−60¢ | 0.25 / 40¢ | −15¢ | 90ms（≥2 半音） | −25¢ | 6¢ | **默认** |
| Power | 40ms/−90¢ | 0.35 / 70¢ | −20¢ | 60ms（≥2 半音） | −35¢ | 10¢ | 张力、冲击 |
| Ballad | 100ms/−50¢ | 0.20 / 30¢ | −12¢ | 140ms（≥1 半音） | −30¢ | 4¢ | 慢歌长音 |

---

## 6. 与音色面板（F0 后处理）的重合处理 ★

音色 lane 现有四个 F0 参数：`f0Median`（中值窗口，帧）、`f0Smooth`（SG 强度，%）、`f0Glide`（贝塞尔过渡强度，%）、`f0GlideMs`（过渡时长，ms）。它们与 auto 的重合分三类，处理方式不同。

### 6.1 重合矩阵

| 音色面板参数 | 与 auto 的关系 | 处理策略 |
|---|---|---|
| `f0Glide` / `f0GlideMs` | **与 auto 的 glide + overshoot 语义重合**（都做换音过渡与过冲） | **默认由 auto 接管**，见 §6.2 |
| `f0Smooth`（SG） | **与 auto 的 jitter / 颤音冲突**（平滑会削掉它们） | **错开施加顺序**，见 §6.3 |
| `f0Median`（中值） | 同上，冲突更温和 | 同上 |
| `specBlend` / `specSmoothT/F` | 频谱域，**无重合** | 不动 |

### 6.2 f0Glide：让 auto 接管，后处理退居"额外叠加"

先说一个实测事实——**f0Glide 自身的过冲效果严重打折**，这直接决定了该怎么分工：

> 名义过冲 = 音程 × 35% × 强度。7 半音（700 音分）跳进时，实测过冲（音分）：
>
> | glideMs ＼ glide | 50% | 100% | 名义值 |
> |---|---|---|---|
> | 45 / 60 ms | **0.0** | 4.2 | 122 / 245 |
> | 90 ms | **0.0** | 33.0 | 122 / 245 |
> | 150 ms | 7.5 | 31.1 | 122 / 245 |
> | 250 ms | 8.5 | 33.4 | 122 / 245 |
>
> 即：**glide ≤ 50% 时几乎没有过冲；100% 时也只达到名义值的 13%**。原因是三次贝塞尔的控制点配置把过冲稀释了，50fps 采样又容易错过峰值，短窗口（≤3 帧）更是完全采不到。

**处理策略（三档，默认第一档）**：

| 档位 | 行为 | 何时用 |
|---|---|---|
| **① auto 接管（默认）** | `auto.enabled && glideMs > 0` 时，`f0Glide` 面板灰显并显示"换音过渡已由自动曲线接管（90ms / 25% 过冲）"，**保留数值不生效**；用户点「恢复后处理接管」即在两处显式切换 | 绝大多数情况 |
| ② 强制叠加 | 两者串行。面板显示叠加后的总过冲预估值（如"25¢ + 8¢ = 33¢"） | 想要夸张滑音 |
| ③ 只用后处理 | 关闭 auto（或把 `glideMs = 0`），`f0Glide` 恢复原样 | 老工程/习惯旧流程 |

UI 上不做阻断，只做**显式的归属提示 + 一键切换**（契约 C7）。

**顺带建议**（不属于本方案，但应一起修）：`f0Glide` 自身的过冲标定不符预期（名义 245 → 实测 33），建议重新标定控制点或改用"目标过冲音分"作为参数单位，否则用户"设了没反应"。

### 6.3 f0Smooth / f0Median 会削掉抖动与颤音 —— 用施加顺序解决

实测（`savitzkyGolayFilter(window=7, order=3)`，`f0Smooth = 100%`）：

| 被平滑的对象 | 平滑前 | 平滑后 | 保留 |
|---|---|---|---|
| 4 Hz 颤音 ±25¢ | 25.0¢ | 24.6¢ | 98% |
| **5.5 Hz 颤音 ±25¢** | 25.0¢ | 23.5¢ | **94%** |
| 7 Hz 颤音 ±25¢ | 25.0¢ | 21.8¢ | 88% |
| 9 Hz 颤音 ±25¢ | 25.0¢ | 19.9¢ | 80% |
| **Jitter ±10¢（RMS）** | 5.86¢ | 3.01¢ | **51%** |
| Jitter，`f0Median = 5` | 5.86¢ | 3.68¢ | 63% |
| Jitter，`f0Median = 9` | 5.86¢ | 2.82¢ | 48% |
| 颤音+jitter，中值5 + 平滑100 全开 | 幅度 31.7¢ | 24.5¢ | 77% |

结论：**用户开了 auto 的 jitter，再开 f0Smooth，jitter 会被削掉近一半**——正是"设了没反应"的另一例。

**解法：错开施加顺序**（`jitterStage: 'post'`）

```
旧：曲线（含颤音/jitter） → 中值 → SG → 贝塞尔 → 输出
新：曲线（不含 auto 抖动） → 中值 → SG → 贝塞尔 → 【叠加 auto jitter + 自动颤音】 → 输出
```

- auto 生成的 jitter 与**自动填充的颤音**默认在**后处理之后**叠加 → 完全不被平滑/中值削弱
- 用户手动设置的 `note.vibrato` 保持 `'pre'`（在曲线层），保证旧工程逐位不变
- 面板显示实时提示："当前平滑设置会把手动颤音削弱至 94%（5.5Hz）／把后处理前抖动削弱至 51%"，并给一个「把自动抖动放到后处理之后」的开关（默认开）

这样两者各司其职：**后处理管"信号清洁"（去掉导入 F0 的噪声、手绘曲线的毛刺），auto 管"表现力生成"**，互不抵消。

### 6.4 重合处理的总原则

> **有音符语义的事交给 auto（起音、过冲、预备、滑音、句尾、颤音填充、抖动）；无音符语义的事留给后处理（降噪、平滑、额外过渡）。**
> 两者串行而非互斥，用归属提示 + 施加顺序避免互相抵消。**永不拦截用户，只提示与可切换。**

---

## 7. 自然度验收标准（可测，不是"听起来还行"）

给每个分片提供**自然度自检面板**，实时显示以下指标的实测值（在后处理之后测量）：

| 指标 | 合格区间 | 不达标提示 |
|---|---|---|
| 长音（≥1.5 拍）颤音深度 | 15–30 音分 | "长音过于平直" |
| 长音颤音速率 | 3–9 Hz | "颤音过快/过慢" |
| 持续段 jitter RMS | ≥ 1.5 音分 | "过于规律，缺少人味" |
| 跳进（≥2 半音）过冲 | 10–25 音分 | "缺少惯性感" |
| 跳进预备 | 8–20 音分 | — |
| 音符间过渡时长 | 60–140 ms（随速度缩放） | "存在台阶式跳变" |
| 帧间最大跳变（滑音段内） | < 120 音分/帧 | "过渡太陡" |
| 句尾下滑 | 15–35 音分 | — |
| **"死平"检测** | 连续 ≥500ms 且帧间差 RMS < 1 音分 → 机械 | 高亮该区间 |

这些指标同时用作自动化测试的断言（§11）。

---

## 8. 数据模型

```js
fragment.pitchCurve = {
  enabled: true,

  auto: {
    enabled: true,                 // 旧工程缺省 false → 行为与今天完全一致
    preset: 'natural',             // off | soft | natural | power | ballad | custom
    version: 1,                    // 任何 auto 改动自增，用于缓存/签名失效
    params: {
      // 起音
      attackMs: 60, attackCents: -60,
      // 过冲与预备
      overshootRatio: 0.25, overshootMaxCents: 40, overshootMs: 120,
      prepCents: -15, prepMs: 30, prepMinSemitones: 2,
      // 滑音
      glideMs: 90, glideUnit: 'ms', glideAutoScale: true,
      glideMinSemitones: 2, glideCurve: 'bezier',
      // 句尾
      releaseRatio: 0.15, releaseCents: -25,
      // 抖动
      jitterCents: 6, jitterSource: 'synth', jitterStage: 'post', seed: 0,
      // 自动颤音填充（写入 note.vibrato，不是私有层）
      autoVibrato: { enabled: true, minDurationBeats: 1.5, depth: 22, rate: 5.5,
                     drift: 6, depthDrift: 8, start: 0.25, length: 0.75, fadeIn: 0.35 },
      // 其它
      quantize: 0,                 // 0 | 0.5 | 1 半音吸附
      crossfadeMs: 25,
      glideOwnership: 'auto',       // auto | post | both  （§6.2 三档）
      mergeGapBeats: 0.5
    }
  },

  anchorPoints:  [ { time, pitch, strength, smoothness } ],   // 手动，语义不变
  brushSegments: [ { points: [...] } ],                        // 手动，语义不变
  bakedSegments: [                                             // 新增：派生段（手动资产）
    { id: 'bk_1', start: 2.0, end: 4.0, origin: 'auto-drag',   // auto-drag | f0-import
      autoPreset: 'natural', paramsHash: 'a91f…',
      points: [ { time, pitch, strength: 100, smoothness: 0 } ] }
  ]
}

// 音符级覆盖（缺省继承分片设置）
note.autoPitch = { enabled: false }     // 这个音不要自动曲线
note.autoPitch = { preset: 'power' }    // 这个音换预设
note.vibrato   = { enabled, depth, rate, start, length, fadeIn,
                   rateDrift, depthDrift }   // 新增两个 drift，缺省 0
```

**向后兼容**：无 `auto` → `enabled: false`、`bakedSegments: []`；`note.vibrato` 无 drift → 0。求值路径与 v2.0.2 逐位相同。工程文件层面的落地（存什么、怎么归一化、版本号）见 **§9**。

**参数全可编辑**：预设只写 `params` 的默认值，用户改任何一个参数即自动切到 `custom`；面板分「基础」（4 个大滑块）与「高级」（全部参数，可折叠），**没有任何只读或联动锁死的参数**。

---

## 9. 工程文件 `.sxsproj`：存什么、旧版能否打开、要不要版本号

### 9.1 结论先说

| 问题 | 答案 |
|---|---|
| 需要往 sxsproj 加保存内容吗？ | **需要**：`pitchCurve.auto`（十几个参数）+ `pitchCurve.bakedSegments`（用户派生的段）。但**序列化代码不用改**——`JSON.stringify(fragments)` 是整对象透传，字段自动带上 |
| 旧版软件打开会出错吗？ | **不会崩溃**，已有三段版本检查；但**会静默丢 auto**——只要打开一次分片编辑器，`ipcHandlers.js` 的三字段白名单就会把它抹掉（已实测） |
| 需要版本号管理吗？ | **已有**（`version: '1.1.0'` + 三段检查），但有三个缺陷：硬编码两处、缺"最低可读版本"、提示文案不具体 |

### 9.2 现状：四处透传、一处白名单，而白名单已经踩过坑

| 位置 | 行为 | 对 auto 的影响 |
|---|---|---|
| `trackManager.js:143` `pitchCurve: data.pitchCurve ?? createPitchCurve()` | 整对象透传 | ✅ 保留 |
| `trackManager.js:250` `updateFragment` → `Object.assign` | 浅合并 | ✅ 保留 |
| `projectManager.js:563` `fragments: getFragments()` → `JSON.stringify` | 整对象 | ✅ 保留 |
| `main/windowManager.js:874` IPC `SAVE_FRAGMENT_DATA` | 只转发，不白名单 | ✅ 保留 |
| **`fragmentEditor/ipcHandlers.js:133-148`** | **只取 `enabled`/`anchorPoints`/`brushSegments` 重建对象** | ❌ **打开编辑器即丢** |

实测（`audit-proj.mjs`）：

```
编辑器 state 的键: enabled, anchorPoints, brushSegments
auto 是否存活: false | bakedSegments: false
回写主窗口后 pitchCurve 的键: enabled, anchorPoints, brushSegments
→ auto 丢失: true | bakedSegments 丢失: true
```

**丢失时序**：打开分片编辑器 → 白名单重建 → 500ms 防抖 → `currentFragment.pitchCurve = pitchCurve`（`projectIO.js:34`，整体替换）→ 回传主窗口 → 下次存盘永久丢失。用户完全无感。

同一个文件里 `postprocess` 走的是 `normalizePostprocessState()`（补默认 + 夹紧），`pitchCurve` 还停在白名单重建——这是历史遗留，而 `trackManager.js:144-146` 的注释已经记录过"postprocess 丢失"的同类事故。

### 9.3 保存内容清单

**落盘**

| 字段 | 说明 | 体积 |
|---|---|---|
| `pitchCurve.auto.enabled/preset/params` | 全部参数（含 `jitterStage`、`glideOwnership`） | 约 300–500 字节/分片 |
| `pitchCurve.bakedSegments[]` | 用户实际派生/导入的段 | 每段约 `时长/0.05拍` 个点 |
| `note.vibrato.rateDrift/depthDrift` | 随 notes 走，已有通道 | 可忽略 |
| `note.autoPitch` | 每音符覆盖开关 | 可忽略 |

**不落盘**（派生量或运行时）

- `coverage`：每次由手动元素重算（缓存键含 notesVersion）
- `auto.version`：运行时递增即可；变化检测用 `paramsHash`
- 渲染采样点、jitter 相位、撤销栈

> 对比：`auto` 参数 ≈ 0.4KB/分片，而现在的 F0→锚点方案是 **260KB/3 分钟**（审查报告 F6）。

### 9.4 必须改的 4 个点

1. **新增 `src/shared/pitchCurveState.js`**（纯函数，无 DOM）
   - `createDefaultPitchCurve({ autoDefault })` —— 两个入口用不同默认值（见 §9.6）
   - `normalizePitchCurve(raw)` —— **合并补默认 + 夹紧 + 剔除非法段**，且必须 `{ ...raw, ...defaults }` 形式的合并，不能白名单重建
2. **`trackManager.js:120-126`** `createPitchCurve()` 改为调用上述工厂
3. **`fragmentEditor/ipcHandlers.js:133-148`**（关键）
   ```js
   setPitchCurve(normalizePitchCurve(data.fragment.pitchCurve));
   ```
   注意 `convertExistingBrushSegmentsToAnchorPoints()` 只处理 `brushSegments`，**不要碰 `bakedSegments`**
4. **`projectManager.js:557 / 910`** 版本号抽常量，写入 `minReader` / `features`（§9.7）

### 9.5 跨版本矩阵

| 场景 | 会发生什么 | 处置 |
|---|---|---|
| 新版存 → 新版开 | 全字段往返（实测通过） | ✅ 加回归测试 |
| **新版存（1.2.0）→ 旧版开（1.1.0）** | ① minor 更高 → 弹**已有**确认框"新版字段会被旧代码忽略，重存即丢数据"；② 确认后主窗口只画锚点，**自动曲线不可见**；③ 一旦打开分片编辑器 → auto 被抹掉 → 保存即永久丢失 | ⚠️ 靠确认框 + 文档；建议提供"导出旧版兼容工程"（见下） |
| 旧版存（1.1.0）→ 新版开 | 无 `auto` 字段 → 归一化后 `enabled = false` → **听感与旧版逐位一致** | ✅ 必须保证（§9.6） |
| 旧版存 → 旧版开 | 不涉及 auto | — |

**"旧版打开会不会出错"的准确回答**：不会崩溃、不会拒绝加载（除非 major 更高），但属于**静默降级**——自动曲线不可见，且打开编辑器后丢数据。这是"不出错但会丢东西"，比报错更需要防。

**建议新增「导出旧版兼容工程（1.1.0）」**：把 auto 层烘焙成普通锚点写入 `anchorPoints`（按 0.08 拍采样，数据源用 `autoPitchAt`），版本号写 1.1.0。旧版打开就是普通手绘曲线，听感基本一致。跨版本协作时这是最干净的路径（比"传工程+让对方向上升级"更现实）。

### 9.6 默认值必须分入口（最容易写错的一处）

| 入口 | `auto.enabled` 默认 | 理由 |
|---|---|---|
| **加载工程**（`pitchCurve.auto` 缺失） | **false** | 旧工程听感必须逐位不变——这是仓库既有承诺（`postprocess` 默认全关同理） |
| **新建分片 / 新建工程** | **true** | 开箱即用，用户要的就是"不画也自然" |

若统一成 `true`，老工程一打开就多出自动曲线，直接违背兼容承诺。实现上靠**字段存在性**区分，不要靠版本号（用户可能从别处拿到 1.2 工程再降级使用）。

### 9.7 版本号管理：已有，但建议补三项

**现状缺陷**

1. **硬编码两处**：`projectManager.js:557` 写 `'1.1.0'`，`:910` 写 `[1, 1, 0]`。改一处忘另一处，会把所有新工程误判成"版本过高"或"过低"
2. 只有 `version`，**没有"最低可读版本"**，无法表达"旧版能打开、但重存会丢数据"这一类
3. 确认框文案是笼统的"新版字段"，用户不知道丢的是自动音高曲线

**建议**

```js
// src/shared/projectFormat.js（新增）
export const PROJECT_FORMAT_VERSION = '1.2.0';
export const PROJECT_FORMAT_PARTS = [1, 2, 0];
export const PROJECT_MIN_READER = '1.2.0';      // 低于它重存会丢 autoPitchCurve
export const PROJECT_FEATURES = ['autoPitchCurve'];
```

写入：`{ version, minReader, features, project, singers, fragments }`
读取：保留现有三段检查 + 增加 `minReader` 检查 + `features` 含未知项时**提示但不阻断**

**升降规则**

| 变更类型 | 版本动作 | 旧版表现 |
|---|---|---|
| 只改默认值（如颤音深度 80→22） | patch | 无感 |
| 新增可选字段，旧版忽略仅丢功能 | minor | 确认框，重存丢该字段 |
| **新增字段，旧版忽略会改变听感** | minor + `minReader` 提升 | 确认框（**auto 属于此类**：旧版会把有自动曲线的分片当"无自定义曲线"，合成出平线） |
| 改字段语义 / 删字段 | major | 拒绝加载 |

**前向兼容原则（对下一次扩展很关键）**

- 写时**保留未知字段**：当前靠整对象透传天然满足；但改成 `normalize` 后必须**合并而非重建**，否则下一版加字段又会踩同一个白名单坑
- 读时只补默认、不删未知
- 未知 `features` 不阻断，只提示

### 9.8 工程文件相关测试

1. **往返**：带 `auto` + `bakedSegments` 的工程 save→load→save，逐字段相等
2. **白名单回归**：走一遍"编辑器 open → 500ms autosave"，`auto` 仍在（专门防 §9.2 回归）
3. **旧工程**：无 `auto` → `enabled === false`，且 F0 与 v2.0.2 **逐位相同**
4. **版本矩阵**：`1.0.0 / 1.1.0 / 1.2.0 / 2.0.0` 四种文件行为符合 §9.5
5. **归一化**：缺字段、`NaN`、负值、超范围参数被夹紧且不抛错
6. **前向兼容**：工程里塞一个未来字段 `foo`，save 后仍在

---

## 10. 渲染层

### 10.1 颜色 token（新增，需进 4 套内置主题）

| Token | 语义 | 深色主题 | light-paper |
|---|---|---|---|
| `pitchAutoActive` | 自动生效（**白**） | `#ffffff` | **改深色**（白不可见） |
| `pitchAutoMuted` | 被手动覆盖（**灰**） | `#6b7280` | `#9ca3af` |
| `pitchManual` | 手动（沿用 `pitchLine`） | 主题强调色 | 主题强调色 |
| `pitchManualRegionBg` | 手动区背景带（8%） | 强调色 8% | 强调色 8% |

> token 语义是"自动生效色/自动失效色"，具体色值由主题定义 —— **浅色主题必须改成深色**，不要硬编码白色。

### 10.2 绘制顺序

1. 手动区背景带（默认开）
2. 自动曲线按 coverage 分段：段外 `pitchAutoActive` 实线 2px；段内 `pitchAutoMuted` 虚线 `[4,3]` 1.5px（**仍绘制**，作为参考）
3. 手动曲线：`pitchManual` 实线 2px + 锚点圆点（逻辑不变）
4. 派生段：手动色 + 段首尾竖线标记
5. 拖动预览：手动色 50% 透明

采样沿用视口自适应 `steps`，但**保证不跨越手动锚点**（修审查报告 F11）。

---

## 11. 事件层

`handlePitchMouseDown`（`eventHandlers.js:1493`）分支：

| 命中 | 行为 |
|---|---|
| 手动锚点 | 现有拖动逻辑，不变 |
| 派生段（新增 `hitBakedSegmentAt`） | 拖动；默认整体平移，Alt = 高斯局部变形 |
| **自动曲线**（新增 `hitAutoCurveAt`，不在 coverage 内） | §3.3 新建派生段并进入拖动 |
| 空白 | 现有新建锚点 + 重算 coverage（§3.2） |
| Shift+拖 | 现有笔刷，作用域 = 段自身 |

右键补充：白色自动曲线 → 「自动生成设置…」；灰色自动曲线 → 「按当前预设重新派生为手动」／「删除手动，恢复自动」；手动段 → 现有菜单 + 「重置为自动曲线」。

主窗口：分片检查器加「自动生成」开关 + 预设 + 「高级参数…」；分片卡片显示「自动／手动／混合」徽标。

---

## 12. 测试清单

**作用域与优先级（8 项）**：空作用域全程自动；单锚点作用域 = 所在音符；跨音符锚点覆盖凸包；笔刷/派生段作用域 = 自身；mergeGap 合并；作用域内外求值正确；删除手动后恢复自动。

**拖动派生（5 项）**：产生 `origin='auto-drag'` 段；拖动前与自动曲线逐点相同；段内转灰不影响求值；段外不受影响；撤销后恢复白色。

**四大波动（10 项）**：颤音 3–9Hz / 15–30¢ 默认与边界；`rateDrift` 使周期末速率上扬且 0 时逐位不变；过冲 = min(比例×音程, 上限)；预备方向与时长；`glideAutoScale` 在 BPM 60/120/180 下的缩放；`glideMinSemitones` 阈值；句尾下滑；jitter 可复现（同 seed）；`jitterStage='post'` 时不被 SG/中值削弱（**断言：开 f0Smooth=100 后 jitter RMS 保留 ≥95%**）；自动颤音写入 `note.vibrato` 且用户可改。

**与音色面板重合（4 项）**：`glideOwnership='auto'` 时 f0Glide 不生效；切到 `both` 时过冲可叠加；切到 `post` 时 auto 不产生 glide；四种组合下旧工程（无 auto）结果逐位不变。

**兼容与一致性（5 项）**：旧工程逐位相同；编辑器 vs 主窗口在混合场景逐帧相同；乱序不影响 F0 长度与音频偏移；重叠未激活音符不产生自动曲线；改音符音高自动跟随、派生段不跟随。

**自然度（9 项）**：即 §7 的九项指标断言。

---

## 13. 分期

| 里程碑 | 内容 | 周期 |
|---|---|---|
| **M0（前置）** | **工程文件地基**：`shared/pitchCurveState.js`（`createDefaultPitchCurve` + `normalizePitchCurve`）、**修 `ipcHandlers.js:133-148` 白名单**、版本号抽常量 + `minReader`/`features` | 3–5 天 |
| **M1** | 数据模型 + shared `computeManualCoverage` + 三色渲染（auto 暂时 = 音符平线，等价现状）+ 向后兼容 | 1 周 |
| **M2** | `autoPitchAt` 采样器 + 四大波动参数 + 5 预设 + 面板（基础/高级）+ 两条路径接入 | 2 周 |
| **M3** | 拖动派生、空白新建锚点、crossfade、撤销/重做、自然度自检面板 | 1 周 |
| **M4** | 与音色面板的重合处理（归属三档 + jitter 后置）+ 顺带修 f0Glide 过冲标定 | 1 周 |
| **M5** | F0 导入改造（仅滑音模式、滤波、八度校正）+ 批量工具（抽稀/选区平滑/整体移调/贴合半音） | 1 周 |
| **M6** | MCP 暴露 auto 读写、MIDI 导出弯音、主窗口入口与徽标 | 1 周 |
| **M7** | 「导出旧版兼容工程（1.1.0）」：把 auto 层烘焙成锚点，供跨版本协作 | 2–3 天 |

> **M0 不能后置**：在它完成前，任何 auto 字段都会在"打开一次分片编辑器"后消失（§9.2 实测），后续所有工作都存不住。这也是为什么把它单独拆成一个前置里程碑而不是塞进 M1。

**并行依赖**：审查报告第一批修复（F1 文档、F2/F3 抽 shared `computeActiveClippedNotes`、F4/F5 成对修复）。否则自动曲线会建在"两条路径会分叉、边界会跳变"的地基上。

---

## 14. 一句话总结

把"自动"做成**不落盘的派生层**（四大波动由音符实时派生），把"手动"做成**显式的作用域资产**，用**白/灰/强调色**把覆盖关系画出来；auto 与音色面板按"有音符语义 vs 无音符语义"分工、用施加顺序错开冲突；用户点一下就切手动、拖一下就把自动曲线复制成手动副本，而自动曲线永远不会被删掉。
