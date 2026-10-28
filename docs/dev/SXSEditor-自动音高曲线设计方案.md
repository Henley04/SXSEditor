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

### 4.1 颤音 Vibrato —— 派生 + 后置叠加，UI 映射到 `note.vibrato` 影子参数

**决策（v2 修订）**：自动颤音**不写 `note.vibrato`**，而是

1. **派生**：由 `autoPitchAt()` / `autoVibratoOffset()` 按「音符 + 参数 + 逐音符特征」实时算出，不落字段；
2. **后置**：F0 路径在「中值 → SG → 贝塞尔」之后再叠加（与 jitter 同一条管道），所以深度不被平滑削弱；
3. **可接管**：右键菜单显示的是"如果用户不干预就会生效"的那组值（影子参数），用户动任一滑块 → 写入 `note.vibrato` 并打 `source:'manual'`，此后该音符由手动层接管。

**为什么改掉 v1 的"自动填充 `note.vibrato`"**：

| 问题 | 说明 |
|---|---|
| 与 §6.3 语义冲突 | 文档说颤音在"后处理之后"叠加，写进 `note.vibrato` 就变成了曲线层（会被 SG 削 6%） |
| 会覆盖用户资产 | 逐音符刷新时无法区分"用户改过的颤音"和"上次自动填的"，改一次参数整段用户手调就没了 |
| 撤销/重做边界模糊 | 自动填充属于派生量，却混进了"音符数据"，撤销栈里会出现用户没做过的动作 |
| 参数语义丢失 | `note.vibrato` 只有 5 个字段，装不下速率/深度慢变、逐音相位、概率闸门 |

v1 的 `applyAutoVibrato()`（写入 `note.vibrato`）已删除——它从未被调用，但留着就是定时炸弹：任何人接上它就会把用户的手动颤音冲掉。

**参数与真人区间**（默认值即"自然"预设）：

| 参数 | 真人典型 | 旧默认 | 现默认 | UI 范围 |
|---|---|---|---|---|
| `autoVibrato.rate` (Hz) | 3–9，常用 5–7 | 5.5 ✅ | **5.5** | 1–12，步进 0.1 |
| `autoVibrato.depth` (cents) | **15–30** | **80** ❌ | **22** | 0–100 |
| `autoVibrato.start` (音符占比) | 中后段起 | 0.2 | **0.25** | 0–1 |
| `autoVibrato.length` (占比) | — | 0.8 | **0.75** | 0–1 |
| `autoVibrato.fadeIn` (占比) | 渐入 | 0.3 | **0.35** | 0–1 |
| `autoVibrato.drift` (%) | 速率周期到周期变化 | — | **6** | 0–30 |
| `autoVibrato.depthDrift` (%) | 深度随气息起伏 | — | **8** | 0–40 |
| `vibratoProbability` | 不是每个长音都颤 | — | **0.82** | 0–1 |

> ⚠️ `DEFAULT_VIBRATO.depth = 80`（手动颤音默认值）保持不变——那是用户主动打开颤音时的起点，
> 与自动层的 22 是两套语义；改它会破坏旧工程。

**速率非恒定**（v2 不再是固定线性漂移）：

```js
// 瞬时速率被低频随机调制，相位用解析积分保证连续（不会"咔"）
rate(t)  = rate * (1 + drift * Σ aₖ·sin(2πfₖt + φₖ))     // f ∈ 0.5–1.4Hz
phase(t) = phase₀ + 2π·rate·(t + drift·∫Σ…)               // ∫ 有闭式解
depth(t) = depth * (1 + depthDrift * Σ bₖ·sin(2πgₖt + ψₖ)) // g ≈ rate/3 … rate/2
```

固定的 `1 + 0.06·t/T` 两小节就能听出规律；改成慢变随机后，"这一段抖得急一点、那一段幅度大一点"不可预测但完全可复现（种子由轨道 + 音符派生）。

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

- auto 生成的 jitter 与**自动颤音**都在**后处理之后**叠加 → 完全不被平滑/中值削弱
  （v2 实装：`applyExpressionToF0(f0, ctx, fmt, { jitter, vibrato })` 一条管道两路叠加）
- 用户手动设置的 `note.vibrato` 保持 `'pre'`（在曲线层），保证旧工程逐位不变；
  自动颤音只在**没有手动颤音**的音符上叠加（`isManualVibrato()` 判定，见 §15.3）
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
| **颤音覆盖率**（长音中带颤音的比例） | 45%–98% | 100% = "每个长音都在颤"（§15.2） |
| 持续段 jitter RMS | ≥ 1.5 音分 | "过于规律，缺少人味" |
| 跳进（≥2 半音）过冲 | 有过多冲的跳进 ≥30%，其中位峰值 10–25 音分 | "缺少惯性感" |
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
      // 自然度（v2，见 §15；缺省即默认，旧工程读入后行为不变）
      vibratoProbability: 0.82, overshootProbability: 0.55,
      prepProbability: 0.40, releaseProbability: 0.65,
      releaseScope: 'phrase', releaseMinBeats: 2,
      legatoGapBeats: 0.12, staccatoGapBeats: 0.45, phraseGapBeats: 1.2,
      microGlideMs: 45, variation: 60,
      // 自动颤音（派生 + 后置叠加，不写 note.vibrato）
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
                   source: 'manual' | 'auto' }  // v2：来源标记，manual 时自动层不叠加
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
| **新版存（1.3.0）→ 1.2.0 开** | ① `features` 含 `autoPitchNaturalness` → 提示"未知特性"；② 读得进、听感基本一致，但重存会丢 §15 的概率/连奏参数（回落默认值） | ⚠️ 靠提示 + 文档 |
| **新版存（1.2.0/1.3.0）→ 旧版开（1.1.0）** | ① minor 更高 → 弹**已有**确认框"新版字段会被旧代码忽略，重存即丢数据"；② 确认后主窗口只画锚点，**自动曲线不可见**；③ 一旦打开分片编辑器 → auto 被抹掉 → 保存即永久丢失 | ⚠️ 靠确认框 + 文档；建议提供"导出旧版兼容工程"（见下） |
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
export const PROJECT_FORMAT_VERSION = '1.3.0';   // 1.3.0 新增 §15 的自然度参数
export const PROJECT_FORMAT_PARTS = [1, 3, 0];
export const PROJECT_MIN_READER = '1.2.0';       // 低于它重存会丢 autoPitchCurve 本身
export const PROJECT_FEATURES = ['autoPitchCurve', 'autoPitchNaturalness'];
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

---

## 15. 自然度增强（v2）：从"参数化机械"到"条件化人味"

> 本章是对第一版设计的**批判性修订**。v1 把四大波动做成了"每个音都按同一套参数执行"，
> 参数再精细也只是同一个模板复制 N 遍。v2 的核心改动是：**先判断"这个音要不要做"，再决定"做多少"**，
> 且所有随机都是 `(全局 seed, 轨道 salt, note.id)` 的确定性函数（可复现、不落盘）。

### 15.1 三类"新机械"与其根因

| 症状 | 根因（v1 实现） | v2 处置 |
|---|---|---|
| 每个长音都颤 | `vibratoOn = duration >= minDuration` —— 只有时长一个条件 | 概率闸门 × 时长/音高/乐句位置系数（§15.2） |
| 每个 ≥2 半音跳进都过冲 | `amp = min(max, |interval|·ratio)` —— 只要有音程就一定有值 | 概率闸门 × 音程/句首系数 + 逐音幅度浮动 |
| 每个音尾都 -25¢ | `release` 无条件生效 | 作用域限定：乐句尾 > 后接休止 > 长音收尾（§15.2） |
| 所有轨一起抖 | 抖动种子只含 `note.id`，多轨同度时 id 相同 | 混入轨道 salt + 逐音相位（§15.5） |
| 颤音"越唱越快"很规律 | `phase = 2π·rate·t·(1+drift·t/T)` 是固定线性加速 | 低频随机调制 + 解析积分保相位连续（§15.5） |

### 15.2 概率 + 上下文条件（`buildNoteTraits`）

对每个音符先算一张**特征表**（`src/shared/autoPitchCurve.js → buildNoteTraits`）：

```js
{
  onset: 'legato' | 'normal' | 'detached' | 'start',  // 起音侧
  gapAfter, isPhraseEnd, isPhraseStart, phrase,
  gateVibrato, gateOvershoot, gatePrep, gateRelease, releaseScale,
  depthScale, rateScale, attackScale, jitterScale, overshootScale,
  vibratoStartShift, phase0, seed,
}
```

**闸门公式**（`gateBy(rnd, userProb, ctxFactor)`）：

```
gate = rnd < userProb × ctxFactor        // userProb = 用户滑块；=1 时直接放行
```

| 闸门 | 默认 userProb | 上下文系数 |
|---|---|---|
| 颤音 | 0.82 | 时长 0.72–1.27、音高 0.86–1.16、句尾 1.15（长音/高音/句尾更容易颤） |
| 过冲 | 0.55 | 音程 0.55–1.0、句首 1.1（大跳进、重音位置更容易过冲） |
| 预备 | 0.40 | 目标音程 0.65–1.0；且**后接长休止时不做**（提前压低毫无意义） |
| 句尾 | 0.65 | 见下表的 `releaseScale` |

> **概率 = 1 必须等于"一定做"**。上下文系数只在 `0 < p < 1` 时相乘——否则用户把滑块拉到
> 100% 仍会有四分之一的音"没反应"，会被当成 bug。

**逐音变化幅度** `variation`（0–100，默认 60）：深度 ±45%、速率 ±16%、起音 ±35%、抖动 ±40%、
过冲 ±40%，另有一个**乐句级**系数（同一句整体更收敛或更外放）。`variation=0` 时回到"每个音完全一致"，
用于 A/B 对比与回归测试。

### 15.3 句尾下滑：区分"音符尾"和"乐句尾"

| 条件 | `releaseScale` | 听感 |
|---|---|---|
| 乐句尾（后接 ≥1.2 拍休止 / 无后续 / 歌词以标点结尾） | 1.0 | 正常的句末下落 |
| 后接 ≥0.25 拍休止（乐句未结束） | 0.7 | 呼吸口的小落 |
| 连奏且时长 ≥ `releaseMinBeats` | 0.32 | 只是"松一口气"，不是下滑 |
| 连奏的短音 | 0 | **完全不做** |

同时：**连奏时起音弱化到 35%**（前一个音的余音还在响，重新"咬"一次会很假）。
`releaseScope: 'always'` 保留旧行为（每个音尾都下滑），给需要"老派抒情"的用户一个开关。

### 15.4 颤音来源标记（`vibratoSource`）

`note.vibrato.source` 三态：

| 值 | 含义 | 自动层行为 |
|---|---|---|
| 缺省 | 旧工程 | 按 `enabled` 判断：`true` = 手动 |
| `'manual'` | 用户在右键菜单动过（**包括关掉**） | 不叠加，尊重用户 |
| `'auto'` | v1 遗留的自动填充 | 可被派生量覆盖 |

- **关掉也算手动**：`{enabled:false, source:'manual'}` 必须挡住自动层，否则用户关一次、下一帧又被打开。
- **影子参数**：菜单显示 `resolveAutoVibratoForNote()` 的结果（含逐音 `depthScale`/`rateScale`），
  用户拖动滑块时先把影子值**抄进** `note.vibrato` 再改——否则会从 22¢ 突跳到 `DEFAULT_VIBRATO` 的 80¢。
- **"清除效果"回到自动**：删除 `source` 且 `enabled=false`，音符号重新由自动层决定；
  想彻底不颤就用开关关掉（钉成手动）。

### 15.5 抖动与颤音的去相关

1. **逐音符**：种子 `= hash(seed, 轨道 salt, note.id)`；`note.id` 缺失时退化为 `start|pitch|duration`。
   刻意**不用 start**：横向拖动音符会让"抽签"整体重掷，颤音忽有忽无。
2. **逐轨道**：`ctx.seedSalt = saltFromKey(fragment.id ?? singerId)`。多轨同度叠唱时，
   若只按 `note.id` 派生，两条轨会**完全同步**地抖——比不抖更假。
3. **音高缩放**：低音区的音分抖动天然更大（同样的 Hz 波动折合更多音分），`pitchScale ∈ [0.65, 1.15]`。
4. **起振保护**：前 30ms 线性进入（声带还没稳定起振）。
5. **颤音相位** `phase0 = 2π·hash(...)`：不同音、不同轨的颤音起始相位不同。

**关于"用歌手 F0 残差模板"**：本仓库的歌手是 ONNX 模型，**没有**可读的逐帧 F0 模板资产
（`state.f0Data` 只存在于"音频转 MIDI"向导，且不随分片保存）。要实现"按歌手音色取抖动纹理"，
需要新增模型侧输出或 `.sxssinger` 资产字段——属于独立课题，本轮不做，也不假装做了。
当前用"逐音/逐轨去相关 + 慢变"达到同一目的：**没有两条轨、两个音在用同一段噪声**。

### 15.6 慢变速率与幅度

```js
rate(t)  = rate · (1 + drift·Σ aₖ·sin(2πfₖt + φₖ))          f ∈ 0.5–1.4Hz
phase(t) = phase₀ + 2π·rate·(t + drift·∫Σ…)                  // 闭式积分，相位连续
depth(t) = depth · (1 + depthDrift·Σ bₖ·sin(2πgₖt + ψₖ))     g ∈ [rate/3.2, rate/2.2]
```

- `f ∈ 0.5–1.4Hz` 对应"每 2–4 个颤音周期换一次方向/幅度"，正是真人"周期到周期不完全一样"的尺度。
- 相位用**解析积分**而不是逐帧累加：速率变化时不会产生相位跳变（听感上是"咔"）。
- `depthDrift` 的高频分量（`g ≈ rate/3`）制造"这一下深一点"，而不是整体音量包络。

### 15.7 连奏 / 断奏

MIDI 没有力度（本仓库音符模型只有 `pitch/start/duration/lyric/noteType/vibrato/fadeIn/fadeOut`），
所以判定只用**间隙 + 重叠 + 歌词**：

| 条件（与前一音的间隙 `gapBefore`） | `onset` | 行为 |
|---|---|---|
| 无前音 | `start` | 正常起音 |
| `≤ legatoGapBeats`（默认 0.12 拍，负值 = 重叠） | `legato` | 起音 ×0.35；级进（1 半音）走 `microGlideMs` 微滑；可走微预备（35% 幅度） |
| `≥ staccatoGapBeats`（默认 0.45 拍） | `detached` | **不滑**（这不是过渡，是重新起音）；起音保持原幅度 |
| 中间 | `normal` | 按音程阈值决定是否滑 |

> v1 的 `articulation` 误用了**与下一音**的间隙来判断起音，导致句尾长音被判成 `isolated`、
> 起音不再弱化。v2 拆成"起音侧 `onset`"与"结尾侧 `gapAfter`"两个独立维度。

**没做的**：用 MIDI velocity 做力度分档（音符模型无此字段，加字段会牵动合成/导出/工程格式，
收益不足）；用音节类型（汉字/假名）做连奏判定（实听差异小于间隙判定，且会让同一句的换音行为
依赖歌词录入方式，不可预期）。

### 15.8 新增参数一览（工程字段全部可选，缺省即默认）

| 参数 | 默认 | 范围 | 作用 |
|---|---|---|---|
| `vibratoProbability` | 0.82 | 0–1 | 颤音闸门基准 |
| `overshootProbability` | 0.55 | 0–1 | 过冲闸门基准 |
| `prepProbability` | 0.40 | 0–1 | 预备闸门基准 |
| `releaseProbability` | 0.65 | 0–1 | 句尾闸门基准 |
| `releaseScope` | `'phrase'` | phrase/always | 句尾作用域 |
| `releaseMinBeats` | 2 | 0–8 | 连奏长音允许轻微下滑的门槛 |
| `legatoGapBeats` | 0.12 | 0–1 | 连奏判定 |
| `staccatoGapBeats` | 0.45 | 0–2 | 断奏判定 |
| `phraseGapBeats` | 1.2 | 0–4 | 乐句分界 |
| `microGlideMs` | 45 | 0–150 | 级进微滑时长 |
| `variation` | 60 | 0–100 | 逐音变化幅度 |

工程格式因此升到 **1.3.0**（`features` 增 `autoPitchNaturalness`，`minReader` 仍为 1.2.0）。
缺字段时全部回落默认值——1.2.0 的工程读进来听感不变，只是"更机械"。

### 15.9 验证

自然度自检新增/修改两项指标，把"不机械"变成可回归的数字：

| 指标 | 区间 | 说明 |
|---|---|---|
| **颤音覆盖率** | 45%–98% | 100% 说明每个长音都在颤（v1 的机械感）；<25% 说明基本没颤音 |
| **跳进过冲** | 有过冲的比例 ≥30%，其中位峰值 8–30¢ | 不再要求"每个跳进都过冲" |

`test/autoPitchNaturalness.test.js` 14 条断言分别锁定：闸门 0/1/默认三态、短音不颤、
句尾作用域、标点断句、连奏起音 35%、级进微滑/断奏不滑、慢变漂移、多轨去相关、手动颤音优先、
影子参数、后置颤动深度。`test/naturalness.test.js` 的 7 条守住"数值落在真人区间"。

**实测（120BPM / 3 音）**：默认参数自然度 92 分（颤音 18.9¢、速率 5.8Hz、覆盖率合规）；
把闸门全开 + `variation=0` 后 100 分——说明扣分来自"故意的不均匀"，不是算法退化。

### 15.10 实机核验暴露的六个问题（v2 补丁）

单测全绿不等于功能可用。用 MCP automation 在真实 Electron 实例上跑一遍"改参数 → 落盘 →
重开 → 读回"和"右键 → 拨开关 → 看徽标"，抓到六个问题，全部已修：

| # | 现象 | 根因 | 修法 |
|---|---|---|---|
| 1 | MCP 把 `preset` 改成 `soft`，参数却还是 natural 的值 | 自动化路径只合并 `auto` 对象，没有像 UI 那样调 `paramsForPreset()` | 换预设 = 换整组参数；同批带 `params` 时以 `params` 为准；只改参数则落到 `custom` |
| 2 | 传非法枚举（`releaseScope:'bogus'`）会把原来的 `'always'` 悄悄改回 `'phrase'` | `normalizeAutoConfig` 拿不到"改动前的值"，非法枚举只能回落全局默认 | 新增 `sanitizeAutoParamPatch()`：补丁层先剔非法键，非法输入 = 无操作 |
| 3 | 只改 `autoVibrato.depth` 时，同层的 `rate`/`drift` 被重置成默认 | 参数合并是浅拷贝，嵌套对象被整体替换 | `autoVibrato` 单独深合并 |
| 4 | 音符级 `vibrato` 完全无法通过 MCP 读写 | `mcpSchema` 的 NOTE 定义了 `additionalProperties:false` 且没有 `vibrato` | NOTE 增 `vibrato`（enabled/depth/rate/start/length/fadeIn/source） |
| 5 | 手动关掉某音的颤音后，右键菜单的徽标直接消失 | 三态分支里"手动关闭"落在 `else`（因为 `derived` 在手动时被置空） | 手动两档：`手动` / `手动·不颤`，与自动层的 `自动·不颤` 区分 |
| 6 | 窗口变窄后右侧 inspector（含自然度自检）被挤出屏幕 | `#app` 只有行定义 → 隐式列是 `auto`（= 子项 max-content）；画布被 `resizeCanvases()` 写成固定像素宽度，把整列顶到 1707px，且 grid/flex 项默认 `min-width:auto` 不允许收缩 | `#app` 用 `grid-template-columns: minmax(0,1fr)`；`#main-content`/`#piano-roll-container` 加 `min-width:0`；`#piano-roll` 加 `max-width:100%` |

第 6 条是通用布局缺陷（与 v2 无关，任何窗口缩放都会触发），顺手修掉。
第 4 条顺带解决了"手动标记能否被脚本验证"——现在可以：写入
`notes[].vibrato.source='manual'` → `project.saveTo` → 读文件 → `project.loadFrom`，标记仍在。

**核验结果**：45 条实机断言全通过（默认值 12 项、预设 6 项、夹紧/枚举 5 项、锚点共存 3 项、
落盘格式 4 项、往返 1 项、开关 2 项、音符级 source 持久化 4 项，其余为同批断言）。
`test/autoPitchNaturalness.test.js` 增至 24 条（新增 `sanitizeAutoParamPatch` 7 条、`paramsForPreset` 3 条）。
