# SXSEditor — 宣传片脚本

> **Creative Direction Memo**
> 一支约 95 秒的产品宣传片，遵循硅谷 AI 公司（OpenAI / DeepMind / PrimerML）的克制美学：
> 大量留白、单一克制色、衬线/无衬线混排、纪录片式运镜、真实 UI 与真实声学可视化优先。
> 严禁：深紫 / 深蓝 / 粒子发光 / 霓虹渐变 / 廉价配色与特效。

---

## 0. 创意总纲

### 核心叙事
**"从 30 秒的人声，到一首完整的歌。"**

宣传片沿一条单线叙事推进：一段真实人声采样 → 模型理解 → 可编辑的歌声 → 多设备推理 → 最终成曲。
不堆砌功能清单，而是让观众跟随"声音如何诞生"这条物理路径，自然经过每一个核心特性。

### 必须传达的 5 个产品事实
1. **开源**（MIT）——属于你的歌声合成工作站，不是租来的云服务。
2. **30 秒克隆**——只需一段 30 秒纯人声参考，无需训练即可生成新歌声。
3. **扩散模型驱动**——SoulX-Singer 神经声学模型，5 编码器 + 扩散 + 声码器。
4. **跨设备**——DirectML GPU / WebNN NPU / CPU 三套推理路径，消费级硬件即可运行。
5. **多语言**——中文、英文、日语同一应用内完成。

### 调性关键词
克制 · 精密 · 诚实 · 工艺感 · 留白
纪录片旁白：平静、技术、不夸张、不喊口号。

---

## 1. 视觉系统规范

### 配色（全局唯一调色板，严禁超出）

| Token | HEX | 用途 |
|-------|-----|------|
| `paper` | `#F5F1E8` | 主背景（暖纸白，非纯白） |
| `ink` | `#161513` | 主文字、UI 框线 |
| `ink-soft` | `#4A4640` | 次级文字、说明 |
| `hair` | `#D9D2C2` | 1px 分隔线、网格 |
| `amber` | `#C8841E` | **唯一强调色**——发光点、激活态、关键节点（低饱和琥珀） |
| `amber-soft` | `#E8C77F` | amber 的柔光态（仅用于描边，不做填充光晕） |
| `graphite` | `#1E1C1A` | 暗场背景（仅用于展示 app 暗色主题时） |
| `mute` | `#8A8478` | 弱化文字、禁用态 |

**禁用**：深紫（`#3x3x6x` 系）、深蓝（`#0x1x3x` 系）、霓虹紫蓝渐变、粒子发光、glow blur > 8px 的光晕、彩虹色谱。

> 当画面需要呈现 app 自身 UI 时，使用 SXSEditor 的 light-paper 主题（纸白底），并把其默认强调色临时映射到本片的 `amber`，保证整片色系统一。

### 字体
- **展示字**：`Söhne Breit` 或 `GT America Mono`（不可得时退回 `IBM Plex Mono`）——用于大字标题、章节序号、关键数据。
- **正文 / 旁白字幕**：`Söhne Buch` 或 `Inter`（不可得时退回 `Inter`）。
- **中文字**：`思源宋体`（标题）+ `思源黑体`（正文）——衬线 / 无衬线对照强化"工艺"感。
- **数字 / 单位**：等宽字体，与小数点对齐。

### 版式
- 安全边距：左右各 8% 画面宽度。
- 大字标题字号：占画面高度 14–18%，字重 500（中等），**不使用 700 粗体**。
- 行距：1.15（标题）/ 1.55（正文）。
- 所有标题左对齐，不居中（OpenAI 风格）。

### 运镜与动效原则
- **慢速推拉**为主（dolly in / pull out），速率 0.5–1.2 倍正常。
- **禁止**：手持晃动、快速剪辑（< 0.8s 镜头）、甩镜、zoom bounce。
- **转场**：硬切 + 1 帧黑场，或 12 帧交叉溶解；**禁止**：翻页、立方体、粒子飞散。
- **UI 内动画**：所有操作必须真实发生在屏幕录制中，不靠后期伪造点击。可用 OBS / ScreenToGif 60fps 录制，后期仅做 crop / pan。
- **声学可视化**（波形、频谱、mel 图）使用真实模型输出，不画装饰性图形。
- **强调动效**：仅在关键节点用一次 1px 描边从左到右扫过（250ms），无发光。

---

## 2. 声音设计规范

### 旁白
- 性别中立偏女声，平静、有质感的纪实腔（参考 OpenAI Sora 介绍片、DeepMind AlphaFold 片）。
- 语速约 145 wpm（中文约 4.5 字/秒）。
- 录音棚干声，无混响，仅做轻 de-ess。
- 中英双语各录一版，主版为**英文**（国际发布），中文版用于国内。

### 音乐与音效
- **背景音乐**：极简钢琴 + 单低频正弦铺底（参考 Max Richter / Ólafur Arnalds 的克制风格），全程音量 -28LUFS，旁白出现时 duck -6dB。
- **音效（SFX）**：
  - 鼠标点击：极轻的木质短促声（不是默认 OS 声）
  - 模型加载：单频正弦从 200Hz 升至 800Hz 的 1.5s 扫频，无失真
  - 扩散步骤：每步一声极轻的"咔"（类似相机快门 1/10 音量）
  - 最终合成声：直接播放模型真实输出，不加效果
- **关键静音**：第 0–3 秒、第 88–91 秒为**绝对静音**，制造呼吸感。

---

## 3. 分镜脚本（Shot List）

> 总时长 95 秒 · 16 个镜头
> 时间码格式 `MM:SS.cs`

---

### SHOT 01 · 「沉默与第一声」
**00:00.00 – 00:04.00** | 4.0s

- **画面**：纯黑（`#0A0908`，非纯黑），中心一个 1px 白点，静止 2 秒。
- **动画**：2.0s 处，白点纵向拉伸成一条 1px 高的波形线，再回缩成点。无声。
- **VO**（旁白）：无。
- **SFX**：绝对静音。
- **意图**：建立"从无到有"的物理感，让观众屏息。

---

### SHOT 02 · 「真实采样」
**00:04.00 – 00:11.00** | 7.0s

- **画面**：浅纸白背景。画面左侧，一段真实人声的波形从屏幕外缓缓推入（横向 dolly right），波形用 `ink` 描边 1px、无填充。波形下方出现等宽小字：`REF · 44.1kHz · 00:30.000 · pure vocal`。
- **动画**：波形右端持续生成，左端持续流出屏幕，模拟"磁带过带"。在 30 秒标记处出现一个 `amber` 1px 竖线，标注 `30s`。
- **VO**：
  > "A singing voice starts as thirty seconds of someone singing."
- **SFX**：极轻的磁带过带白噪（-42LUFS），仅在波形流动时存在。
- **意图**：交代输入——SXSEditor 仅需 30 秒纯人声参考。

---

### SHOT 03 · 「模型在听」
**00:11.00 – 00:18.00** | 7.0s

- **画面**：波形停在画面中央。镜头缓慢下移（tilt down），波形之下浮现一张 mel 频谱图（真实从参考音频计算的 80 维 mel），灰阶呈现，无伪彩。
- **动画**：mel 图从左向右逐列绘制（每帧 2 列），同时画面右侧出现等宽文字行，逐行打字：
  ```
  → f0 extraction      (rmvpe)
  → midi extraction    (basic pitch)
  → phoneme alignment
  → singer profile
  ```
  每行完成后出现一个 `amber` 1px 对勾。
- **VO**：
  > "SXSEditor listens — extracting pitch, notes, and the texture that makes a voice itself."
- **SFX**：每行打字完成时一声极轻的"咔"。
- **意图**：展示预处理管线——RMVPE 提取 F0、Basic Pitch 提取 MIDI。

---

### SHOT 04 · 「定义你的歌手」
**00:18.00 – 00:25.00** | 7.0s

- **画面**：真实 UI 录屏（Singer Creator 窗口，light-paper 主题，amber 强调色覆盖）。镜头从左上角缓慢 push in 到画面中央的"Create & Save"按钮。
- **UI 动作**（真实操作，60fps 录制）：
  1. 上传一段 WAV（拖拽）→ 波形预览出现
  2. 点击 "Start Audio Preprocessing" → 预处理窗口打开
  3. 短暂展示 F0 曲线 + MIDI 编辑画布
  4. 回到 Singer Creator，"Preprocess ✓" 徽章淡入
- **VO**：
  > "From one recording, a singer is born — a voice profile you can compose with."
- **字幕**（画面下方，等宽小字）：`Singer Creator · .sxssinger`
- **SFX**：UI 点击声（极轻木质）。
- **意图**：第一段功能展示——Singer Creator + 音频预处理。

---

### SHOT 05 · 「钢琴卷帘」
**00:25.00 – 00:33.00** | 8.0s

- **画面**：硬切到 Fragment Editor（piano roll）真实录屏。镜头从左侧钢琴键缓慢右移（pan right），随 MIDI 音符逐个出现。
- **UI 动作**：
  1. 在 piano roll 上点击放置 4 个音符（拖拽设定长度）
  2. 双击第一个音符 → 输入中文歌词"明 天 见"（演示中文输入）
  3. 切换到英文音符 → 输入 "hello"
  4. 切换到日文音符 → 输入假名，触发 kanji/kana 自动分组（上方括号出现）
- **VO**：
  > "Write notes on a piano roll. Type lyrics in Chinese, English, or Japanese — the model handles the rest."
- **动画叠加**（后期，仅描边）：每个音符放置时，1px `amber` 描边从左扫过（250ms）后消失。
- **SFX**：每次点击一声极轻"咔"；输入歌词时无音效。
- **意图**：核心编辑能力 + 三语支持。

---

### SHOT 06 · 「不止音符」
**00:33.00 – 00:41.00** | 8.0s

- **画面**：同一 piano roll，镜头微微拉远露出底部参数面板。依次切换模式（数字键 2/3/4/5 真实触发）。
- **UI 动作**（4 个子段，每段 2s）：
  1. **Pitch 模式（按 2）**：Shift+拖拽绘制自由 pitch 曲线，展示颤音
  2. **VOL 模式（按 3）**：添加 3 个音量包络控制点
  3. **PAN 模式（按 4）**：左右移动包络点
  4. **Phoneme 模式（按 5）**：拖拽音素边界 + 右键锁定一个音素（出现 "L" 标记）
- **VO**：
  > "Beyond pitch and timing — shape vibrato, dynamics, stereo, and the phonemes themselves."
- **字幕**（每个子段切换时，画面右下角等宽小字显示当前模式名）：
  `PITCH` / `VOLUME` / `PAN` / `PHONEME`
- **SFX**：模式切换时一声轻"咔"。
- **意图**：展示表达力深度——逐音素控制，对标专业 SVS 工具。

---

### SHOT 07 · 「多轨时间线」
**00:41.00 – 00:46.00** | 5.0s

- **画面**：硬切到主窗口时间线。3 个歌手轨道，每条颜色不同（但全部在 `amber / mute / ink-soft` 范围内）。4 个 fragment 矩形分布在不同时间点。
- **UI 动作**：拖拽一个 fragment 横向移动（吸附到节拍），再纵向拖到另一条歌手轨道。
- **VO**：
  > "Arrange fragments across singers. Each voice, its own line."
- **动画**：playhead（`amber` 1px 竖线）从左向右匀速移动一次。
- **SFX**：playhead 移动时极轻短促 tick。
- **意图**：多歌手 / 多轨编曲能力。

---

### SHOT 08 · 「按下播放」
**00:46.00 – 00:50.00** | 4.0s

- **画面**：特写工具栏 ▶ Play 按钮。一根手指（或鼠标光标）缓慢按下。
- **UI 动作**：按下后，状态栏出现 `pipeline initializing…`，9 个 ONNX 模型图标逐个点亮（无发光，仅描边从 `hair` 变为 `amber`）。
- **VO**：无。
- **SFX**：单频正弦 200→800Hz 扫频 1.5s（模型加载声），第 9 个点亮时停止。
- **意图**：制造期待，引出技术内核。

---

### SHOT 09 · 「扩散在发生」（技术核心镜头）
**00:50.00 – 01:00.00** | 10.0s

- **画面**：全屏 mel 频谱图（真实模型中间输出，灰阶 + `amber` 高亮轮廓）。从纯噪声（左侧）开始，随扩散步骤推进，逐步去噪，mel 图从左向右"凝固"成有结构的歌声频谱。
- **动画**：
  - 顶部等宽计数器：`step 01 / 32 → step 32 / 32`
  - 每步：mel 图新增一列、计数器 +1、一声"咔"
  - 画面右侧逐行打字显示管线：
    ```
    text encoder    →
    pitch encoder   →
    note type enc.  →
    f0 encoder      →
    preflow         →
    diffusion (×32) →
    vocoder (SiFiGAN)
    ```
- **VO**：
  > "Underneath, a diffusion model iteratively denoises a spectrogram — guided by five encoders, rendered by a neural vocoder. This is singing voice synthesis, from first principles."
- **字幕**（画面底部）：`SoulX-Singer · ONNX Runtime · 9 models`
- **SFX**：32 声"咔"（每步一声），与计数器同步；mel 图凝实时一声低频"嗡"渐弱。
- **意图**：技术可信度。这一镜是全片的"工艺感"高潮。

---

### SHOT 10 · 「跨设备」
**01:00.00 – 01:07.00** | 7.0s

- **画面**：黑底（`graphite`）+ 三栏并置。三栏从左到右分别显示：
  - **栏 1**：一台笔记本剪影 + 标签 `CPU`，下方 mel 图慢速生成
  - **栏 2**：一块 GPU 显卡剪影 + 标签 `DirectML GPU`，mel 图中速生成
  - **栏 3**：一块 NPU 芯片剪影 + 标签 `WebNN NPU`，mel 图快速生成
- **动画**：三栏 mel 图同时开始生成，速度比约 1 : 2.5 : 4。每栏底部等宽字显示 `xx ms / segment`。
- **VO**：
  > "It runs on consumer hardware — CPU, GPU, or the neural processing unit shipping in modern laptops."
- **字幕**：`Smart Mode · auto-selects best device`
- **SFX**：三栏各自的"咔"声错开 30ms，形成轻微立体感。
- **意图**：硬件普适性——NPU 支持是差异化亮点。

---

### SHOT 11 · 「精度可选」
**01:07.00 – 01:11.00** | 4.0s

- **画面**：硬切到 Settings 页面 Model 区域。4 个精度选项卡片：`FP32` / `FP16` / `INT8` / `INT8-NPU`。
- **UI 动作**：依次 hover 4 张卡片，每张 hover 时下方说明文字切换：
  - FP32 → `Highest quality · 4GB+ VRAM`
  - FP16 → `Balanced · integrated GPU`
  - INT8 → `Low VRAM · <2GB`
  - INT8-NPU → `NPU hardware`
- **VO**：无。
- **SFX**：每次 hover 一声轻"咔"。
- **意图**：精度可切换、共存、无需重下——技术深度速写。

---

### SHOT 12 · 「Audio → MIDI 反向工作流」
**01:11.00 – 01:16.00** | 5.0s

- **画面**：主工具栏点击 🎵 Audio to MIDI。弹出对话框，选择一段音频（WAV/MP3/FLAC/OGG/AAC/M4A 文件图标依次掠过）。
- **UI 动作**：选择 RMVPE 提取 → 进度条 → 时间线上出现一条新轨道，自动填入 MIDI 音符 + pitch 曲线。
- **VO**：
  > "Or reverse the flow — turn any recording back into editable notes."
- **字幕**：`Basic Pitch · RMVPE`
- **意图**：差异化工作流——从已有音频反向编辑。

---

### SHOT 13 · 「多轨合成」
**01:16.00 – 01:24.00** | 8.0s

- **画面**：回到主窗口，3 条歌手轨道同时亮起（描边变 `amber`）。Export 对话框出现，选择保存路径。
- **UI 动作**：
  1. 点击 📤 Export
  2. 进度条显示：`synthesizing fragment 1/3 → 2/3 → 3/3 → mixing → encoding WAV`
  3. 文件保存到桌面，文件名 `my_song.wav`
- **VO**：
  > "Press export. SXSEditor synthesizes every fragment, mixes them, and writes a twenty-four kilohertz WAV."
- **字幕**：`24kHz · 16-bit PCM · .wav`
- **SFX**：每个 fragment 完成时一声"咔"，最终保存时一声短促"嗡"。
- **意图**：闭环——从输入到产出。

---

### SHOT 14 · 「成曲」
**01:24.00 – 01:31.00** | 7.0s

- **画面**：硬切到全屏黑底（`#0A0908`），中心一个极简播放器：单个 ▶ 按钮 + 一条 1px 波形进度条。
- **动画**：按下 ▶，波形从左向右流动，**真实播放模型合成出的歌声**（约 6 秒中文歌声片段）。波形为 `amber` 描边、无填充、无发光。
- **VO**：无（让歌声本身说话）。
- **SFX**：仅歌声本身。
- **意图**：让产品自己证明自己。这一镜之后不再有 UI。

---

### SHOT 15 · 「开源」
**01:31.00 – 01:36.00** | 5.0s

- **画面**：歌声淡出。画面中心等宽大字逐行打字：
  ```
  open source.
  MIT licensed.
  yours, not rented.
  ```
  字色 `ink`，背景 `paper`。
- **VO**：
  > "Open source. MIT licensed. Yours — not rented."
- **SFX**：每行打字完成一声轻"咔"。
- **意图**：价值观收束——与商业 SVS 工具的根本区别。

---

### SHOT 16 · 「结尾」
**01:36.00 – 01:42.00** | 6.0s

- **画面**：文字渐隐。2 秒后，画面中心出现 SXSEditor 标志（八角星，`amber` 描边 1.5px，无填充，无发光），下方等宽小字：
  ```
  SXSEditor
  AI Singing Voice Synthesis Workstation
  ```
  再下方一行更小的字：`github.com/Henley04/SXSEditor`
- **动画**：标志静止 4 秒，第 5 秒整画面 12 帧溶解到纯 `paper`，最后 1 秒纯静音纯色。
- **VO**：无。
- **SFX**：绝对静音。
- **意图**：OpenAI 式结尾——克制、留白、信息密度极低但记忆点明确。

---

## 4. 时间线总览

| # | 时间码 | 时长 | 镜头 | 核心信息 |
|---|--------|------|------|----------|
| 01 | 00:00–00:04 | 4.0s | 沉默与第一声 | 呼吸感开场 |
| 02 | 00:04–00:11 | 7.0s | 真实采样 | 30 秒输入 |
| 03 | 00:11–00:18 | 7.0s | 模型在听 | RMVPE + Basic Pitch 预处理 |
| 04 | 00:18–00:25 | 7.0s | 定义你的歌手 | Singer Creator |
| 05 | 00:25–00:33 | 8.0s | 钢琴卷帘 | piano roll + 三语 |
| 06 | 00:33–00:41 | 8.0s | 不止音符 | pitch/vol/pan/phoneme |
| 07 | 00:41–00:46 | 5.0s | 多轨时间线 | 多歌手编曲 |
| 08 | 00:46–00:50 | 4.0s | 按下播放 | 期待建立 |
| 09 | 00:50–01:00 | 10.0s | 扩散在发生 | 技术核心 · 5 编码器 + 扩散 + 声码器 |
| 10 | 01:00–01:07 | 7.0s | 跨设备 | CPU/GPU/NPU |
| 11 | 01:07–01:11 | 4.0s | 精度可选 | FP32/FP16/INT8/INT8-NPU |
| 12 | 01:11–01:16 | 5.0s | Audio→MIDI | 反向工作流 |
| 13 | 01:16–01:24 | 8.0s | 多轨合成 | 闭环导出 |
| 14 | 01:24–01:31 | 7.0s | 成曲 | 真实模型输出 |
| 15 | 01:31–01:36 | 5.0s | 开源 | MIT 价值观 |
| 16 | 01:36–01:42 | 6.0s | 结尾 | logo + 链接 |
| **合计** | | **95.0s** | | |

---

## 5. 制作执行清单

### 录屏素材（必须真实）
- [ ] Singer Creator 完整流程：上传 WAV → 预处理 → 保存 `.sxssinger`
- [ ] Fragment Editor 4 模式切换（MIDI / Pitch / VOL / Phoneme）
- [ ] 三语歌词输入（中文 "明天见" / 英文 "hello" / 日文假名 + kanji 分组）
- [ ] 多轨时间线拖拽
- [ ] Settings 精度切换 + Smart Mode
- [ ] Audio to MIDI 完整流程
- [ ] Export 完整流程（含进度条）
- 所有录屏分辨率 ≥ 2560×1600，60fps，无损。

### 真实声学素材
- [ ] 一段 30 秒中文纯人声参考（用于 SHOT 02–04）
- [ ] 模型中间输出 mel 频谱（用于 SHOT 03, 09）—— 可在 `pipeline/index.js` 中临时插入 dump
- [ ] 扩散过程 32 步的中间 mel（用于 SHOT 09）—— 同上
- [ ] 最终合成 WAV（用于 SHOT 14）
- [ ] CPU/GPU/NPU 三设备的真实推理耗时（用于 SHOT 10）—— 从 `Resource Manager` 录制

### 不需要制作的素材
- ❌ 任何粒子 / 光晕 / 深紫深蓝渐变背景
- ❌ 3D 渲染的"AI 大脑"
- ❌ 演员口播镜头
- ❌ 城市夜景 / 数据流蒙太奇

### 后期软件建议
- 剪辑：DaVinci Resolve（免费版即可）
- 配色 LUT：自建，仅含本片 8 色
- 字幕：Burn-in，等宽字体
- 音乐授权：Artlist 或 Epidemic Sound，选 Max Richter 风格钢琴 + drone

---

## 6. 一句话定调

> 这支片子的成功标准是：看完后，观众觉得 SXSEditor 像一个**认真的研究工具**，
> 而不是一个营销产品。克制是它的力量。
