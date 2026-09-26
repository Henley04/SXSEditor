# SXSEditor 类 Vocaloid / SV2 参数化音色控制 —— 架构调研与实现路径

> 调研范围：`src/inference/pipeline/*`（ONNX 推理管线）、`onnx_models/README.md`、本地 `SoulX-Singer/` 训练仓库（`soulxsinger/models/*`、`train/lora_jp_v3/*`）、`src/fragmentEditor/*`（参数面板现状）。
> 目标：为 TENC / GENC / BREC / DYN 一类「每音符可调音色参数」找实现路径，优先级：**零训练 > 极少训练 > 后处理**。

---

## 0. TL;DR 结论

| # | 方法 | 训练量 | 改动面 | 可控粒度 | 效果预期 | 推荐度 |
|---|------|--------|--------|----------|----------|--------|
| A1 | **Prompt mel 属性变换**（对参考 mel 做共振峰/倾斜/气声/增益变换后再喂扩散） | **0** | 1 个纯函数 + 注入点 | 段级（每音符需分段） | 中～高 | ★★★★★ |
| A1+ | **离线预生成 Prompt 变体库**（每歌手 × 每个参数档位缓存一份变换后的 prompt mel） | **0** | 缓存层 + 歌手格式 | 段级 + 插值可连续 | **高**（质量最好、运行时零开销） | ★★★★★ |
| A2 | **多参考 / 风格库（Vocal Mode）** + prompt 插值 | 0 | 歌手格式 + 分段调度 | 段级 | 高（离散风格最稳） | ★★★★☆ |
| A3 | **负向 Prompt CFG**（uncond 分支换成「反属性 prompt」） | 0 | `diffusion.js` uncond 分支 | 段级 | 中～高，NFE 不增加 | ★★★★☆ |
| A4 | **F0 通道参数化**（起音 overshoot / vibrato / jitter / 滑音） | 0 | 复用 `pitchCurveF0` | **帧级（真·每音符）** | 中（覆盖 TENC/VIBR/PITD 的 F0 分量） | ★★★★★ |
| A5 | **采样/CFG 预设**（cfg、steps、sampler、dynamic threshold） | 0 | 已有 UI | 全局 | 中（"伪张力/柔和"） | ★★★☆☆ |
| B1 | **新增 param_encoder（Linear(K→512)）注入 cond，冻结主干 + 伪标签自监督** | **极少**（几十分钟～几小时数据，单卡） | 1 个小 ONNX + 训练脚本 | **真·每音符/每帧** | 高（唯一能真正 per-note 连续控音色的路） | ★★★★★ |
| B2 | **复用空 embedding 槽做风格 token**（`note_type` 256 槽只用了 3 个） | 极少 | 训练 + 导出 | 每音符（离散，训练后可插值） | 中～高 | ★★★★☆ |
| B3 | **属性 LoRA + 运行时缩放**（导出时把 α 暴露为标量输入） | 少（每属性一个 rank-8 LoRA） | LoRA 训练 + 导出改造 | 段级/全局 | 高但有工程成本 | ★★★☆☆ |
| C1 | mel 域 warp + 重跑 vocoder | 0 | 后处理 | 帧级 | 中（GENC 最实用） | ★★☆☆☆ |
| C2 | SiFiGAN source-filter（变调不变色 / 张力） | 0 | 后处理 | 帧级 | 中 | ★★☆☆☆ |
| C3/C4 | 波形域倾斜 EQ / 气声注入 / WORLD 重合成 | 0 | 后处理 | 帧级 | 中，有伪影风险 | ★☆☆☆☆ |

**一句话结论**：这个模型的音色**全部来自 prompt mel 前缀**（没有任何 speaker/style embedding），所以
**零训练的最优解是「操控 prompt」而不是「操控 cond」**；但 prompt 是整段共享的前缀，**真正的 per-note 连续音色参数只能靠 B1（一个几 KB 的 param_encoder + 冻结主干微调）**，代价极小。

---

## 1. 架构事实（这些事实决定了哪些方法可行）

### 1.1 模型拓扑（源自 `SoulX-Singer/soulxsinger/models/soulxsinger.py:29-37, 178-194`）

```
token 级:  Emb_text(3000,512) + Emb_pitch(256,512) + Emb_type(256,512)   ← 逐 token 求和
                ↓
           preflow = 4 × ConvNeXtV2Block(512)                            ← preflow.onnx
                ↓  expand_states(mel2token) 展开到 50Hz 帧
           + Emb_f0(361, 512)     ← 帧级量化 F0（20 cents/bin，C1–B6）
                ↓
           cond_emb = Linear(512 → 1024)                                  ← cond_emb.onnx
                ↓
    CFM / flow-matching 去噪：DiffLlama 22 层 / hidden 1024 / 16 头
    xt = [ prompt mel (ptFrameCount 帧) | 目标 mel (totalFrames 帧) ]
                ↓
    Vocos vocoder（默认）或 SiFiGAN（mel + f0 双输入）
```

* 采样率 24 kHz，hop 480（= 50 Hz 帧率），mel 128 bin（fmin 0 / fmax 12000，Slaney）。
* mel 归一化：`m = (log_mel − (−4.92)) / sqrt(8.14)=2.853`（`soulxsinger.py` 的 `MelSpectrogramEncoder.forward`；JS 侧见 `src/inference/pipeline/postprocessing.js:778-782`、`constants.js:18-19`）。
* 推理默认 32 步、CFG 3.0（`soulxsinger/config/soulxsinger.yaml:1-3`）。

### 1.2 关键结论性事实

| 事实 | 证据 | 含义 |
|------|------|------|
| **音色/风格 100% 来自 prompt mel 前缀**，模型里**不存在** speaker / style / emotion embedding | `soulxsinger.py:179-194`（cond 只由 text/pitch/type/f0 组成）；全仓 grep `spkEmbed\|speakerEmbed\|singerEmb\|styleVec` = 0 命中 | 改音色 = 改 prompt；改 cond 无音色语义 |
| **prompt 段的 cond 在 App 里是全 0** | `src/inference/pipeline/preprocessing.js:896-907`（`condCodeData` 前 `ptFrameCount*512` 位保持 0，只有目标段写入） | 与训练（prompt 段有真实 cond）不一致 → 既是风险也是可用的"免费空槽" |
| **uncond 分支 = cond 全 0 + 无 prompt** | `preprocessing/diffusion.js:319-356`（`_evalDiffStepSeparate` 的 uncond：xt 放 0 位、cond=0） | 改成「负向 prompt」成本≈0，NFE 不变 |
| **`note_type_encoder` = Embedding(256,512) 但只用了 1/2/3**（rest/normal/slur） | `soulxsinger.py:31`；`preprocessing.js:161-171` | 有 **250+ 个未使用的可控 token 槽** |
| **`note_pitch_encoder` = Embedding(256,512) 但只用了 0–127** | `soulxsinger.py:30` | 同上，128+ 号槽空闲 |
| **`f0_encoder` 是帧级、20 cents 分辨率** | `soulxsinger.py:32, 171-183`；`config: f0_bin: 361` | 任意 F0 曲线形状（颤音/过冲/滑音/抖动）都会进条件 → A4 完全零训练 |
| **Vocoder 有 SiFiGAN（mel + f0 双输入，source-filter）** | `onnx_models/README.md:44-125`；`postprocessing.js:1085-1120` | C 层后处理有天然优势通道 |
| **LoRA 全链路已在仓库跑通**（rank16/α32，22 层 q/k/v/o 共 88 适配器，~3.1M 参数，3 stage） | `train/lora_jp_v3/train_lora.py:83-85, 1-55`；`train/lora_jp_v3/lora.py`；导出 `tools/export_step4_jp.py` | B 层"极少训练"不是纸上谈兵，直接复用 |
| 参数面板已有 `'VOL' \| 'PAN' \| 'Phoneme' \| 'Timbre'` 四模式，`Timbre` 目前是**空壳** | `src/fragmentEditor/state.js:120-121`；`uiControls.js:145-148` | UI 落点现成 |

---

## 2. 四个可用「控制入口」

| 入口 | 位置 | 粒度 | 零训练可用？ | 说明 |
|------|------|------|--------------|------|
| **① prompt mel**（`xt` 的前缀帧） | `postprocessing.js:1008` 产出 → `index.js:2940-2954` → `diffusion.js:448-449` | 整段共享 | ✅ 完全可用 | 音色唯一来源，语义最正确 |
| **② cond 加法空间**（token 级 512 维 / 帧级 512 维） | `preprocessing.js:848-854`（`tokenEmb = text+pitch+type`）、`888-894`（`combinedFeatures = expanded + f0Emb`） | **每音符 / 每帧** | ❌ 需训练（无音色语义） | B1 的注入点 |
| **③ F0 曲线**（帧级量化 F0） | `preprocessing.js:70-121, 323-385`（`buildF0FrameSequence` / `notesToSequences` 的 `pitchCurveF0`） | **每帧** | ✅ 完全可用 | TENC/VIBR/PITD 的 F0 分量 |
| **④ 空 embedding 槽 + LoRA** | `note_type` 4–255、`note_pitch` 128–255 | 每音符 | 需极少训练 | B2 |
| （附）**采样/CFG/步数/求解器** | `diffusion.js:375+`、`cfgSchedule.js` | 全局 | ✅ 可用 | A5 |

---

## 3. 参数 → 声学本质 → 最佳入口

| SV2 / Vocaloid 参数 | 声学本质 | 最佳入口（零训练） | 最佳入口（极少训练） |
|---------------------|----------|--------------------|----------------------|
| **GENC**（性别 / 音色） | 声道长度 → 共振峰 F1–F3 整体缩放，**基频不变** | ① prompt mel 频率轴 warp（VTLP 式，α∈[0.85,1.18]） | ② param_encoder |
| **TENC**（张力） | 声带闭合速度 → 高频能量/频谱倾斜↑、谐波更丰富、起音更陡、F0 微扰与过冲 | ① 频谱倾斜；③ 起音 overshoot + jitter + vibrato depth | ② param_encoder |
| **BREC**（气声） | HNR↓、噪声 floor↑（尤其高频）、谐波谷被填平 | ① 谱谷填充 / 噪声 floor 抬升 | ② param_encoder |
| **DYN / VOL**（力度） | 帧能量 + 高频能量 + 起音速度 | ① prompt 整体增益；已有 volume 包络 | ② param_encoder |
| **BRI / CLE**（明亮/清澈） | 频谱倾斜、谐音结构 | ① 倾斜 | ② param_encoder |
| **VIBR**（颤音） | F0 的 4–7 Hz 调制 | ③ F0 曲线（**已完全可用**） | — |
| **PITD / 滑音 / 转音** | F0 轨迹 | ③ F0 曲线（**已完全可用**） | — |

---

## 4. 方法清单

### 4.1 A 层：零训练

#### A1 ★★★★★ Prompt mel 属性变换（"pre-conditioning"，不是后处理）

原理：prompt mel 是模型唯一看到的"音色样本"。在**它进入扩散之前**做声学变换，模型会把变换后的音色带进整段输出——输出是模型自己生成的，没有波形/mel 后处理的重建伪影。

变换都在归一化 mel 域做（`m` = 归一化 mel，反归一化 `L = m*2.853 − 4.92` 即 log 幅度）：

| 参数 | 变换 | 公式 |
|------|------|------|
| GENC | mel 频率轴 warp（bin→Hz→×α→bin，线性插值重采样） | `m'[k] = m[warp(k; α)]`，α<1 男声化，α>1 女声/童声化 |
| TENC / BRI | 频谱倾斜 | `L' = L + γ·log(f/f_ref)`；128 维斜率向量可预计算 |
| BREC | 谱谷填充 + 噪声 floor | `mag' = max(mag, floor·tilt(f))` 或 `mag' = (1−β)·mag + β·noise·env` |
| DYN | 整体增益 | `m' = m + log(G)/2.853` |

* **实现落点**：`postprocessing.js` 的 `extractRefMelOnnx` 之后、`index.js:2940-2954` 拿到 `ptMelData/ptFrameCount` 之后、进入 `_synthesizeSegment` 之前，插入一个纯函数 `transformPromptMel(ptMel, frames, params)`。
* **成本**：几行 JS + 128 维查找表，运行时 ~0。
* **注意**：
  1. 变换后建议**重对齐 mean/var**（否则整体能量漂移会被模型读成"力度变化"）；
  2. mel warp 会同时移动谐波 → 相当于把参考音频整体变调，需用现有 `autoShift`（`index.js:3406-3430`）重新对齐 prompt/target 音高，否则高 α 时音色会"飘"；
  3. prompt 很短（<1 s）时效果会弱，建议 ≥2–3 s 参考。

#### A1+ ★★★★★ 离线预生成 Prompt 变体库（推荐首选）

把 A1 的变换**离线做**（在歌手创建/参数首次使用时），每个歌手 × 每个参数档位缓存一份变换后的 prompt mel：

```
singer.sxssinger
  └── promptBank: {
        genc: { "-3": mel, "-2": …, 0: 原始, "+1": …, "+3": … },
        tenc: { … }, brec: { … }, dyn: { … }
      }
```

* 运行时 = 选一份 / 在两份之间线性插值 → **零开销**，且可以离线用**高质量链路**做变换（而不是粗糙的 mel warp）：
  仓库里已经验证了 `pyworld.harvest + cheaptrick + sp2mc(order=39, alpha=0.466)` 的谱包络提取（`scripts/verify_mcep_extract.py`、`scripts/test_aperiodicity.py`）。用 **cheaptrick 谱包络（已去除谐波结构）做共振峰缩放 + 原 F0 重合成** = 真正"只动共振峰、不动基频"的 GENC，质量远高于直接 mel warp。
* 多轴组合：先变体库选档，再对 mel 做一次线性插值混合（prompt mel 插值是有效的，等价于"概念滑块"）。
* 缓存 key 必须带上所选档位（`audioSegmentation.js:408` `computeSynthCacheKey` / `:431` `computeSegmentCacheKey`）。

#### A2 ★★★★☆ 多参考 / 风格库（= SV2 的 Vocal Mode）+ prompt 插值

* `.sxssinger` 扩展为 `styles: [{ id: 'soft', wav, f0, midi }, { id:'power', … }, …]`（现有格式已存 WAV+F0+MIDI+avatar）。
* 单风格：直接换 prompt（离散、最稳，质量最高）。
* 连续：两份 prompt mel 做插值（需 DTW/时长对齐，或先对齐 mel 统计量）。
* per-note：按风格变化点分段合成 → 复用现有 `buildVocalSegments` + WSOLA 交叉淡化（`audioSegmentation.js:148-299`、`diffusion.js/_runSingleDiffusionChunk` 已有 WSOLA mel 域交叉淡化）。

#### A3 ★★★★☆ 负向 Prompt CFG（把 uncond 换成"反属性 prompt"）

* 现状：CFG 的 uncond 分支是 `cond=0、无 prompt`（`diffusion.js:319-356` 与 `475-499` 的 row1）。
* 改造：uncond 分支的 xt 前缀换成**反属性 prompt**（如"气声很重"的参考），cond 仍可置 0：
  `v = v_cond + γ·(v_cond − v_neg)` → 沿"属性方向"推/拉，就是天然的滑块。
* **NFE 完全不变**（uncond 本来就要跑一次），只改 uncond 的 xt/cond/mask 构造；与现有 `cfgStrength / cfgRescale / cfgSchedule / dynamicThreshold` 完全兼容。
* 注意：训练时 CFG dropout 是 `cond=0 且 prompt_len=0`（`flow_matching.py` 注释 + `config: cfg_drop_prob: 0.2`），用负向 prompt 属于 OOD 用法，需小 γ 起测（建议 γ 1–2，不要直接上 3）。

#### A4 ★★★★★ F0 通道参数化（TENC / VIBR / PITD 的 F0 分量，真·每音符、零训练）

`f0_encoder` 是**帧级**、20 cents 分辨率，任何 F0 形状都进条件，并且同时喂 SiFiGAN 的 f0 输入（`onnx_models/README.md:70`）。因此：

* 起音 **overshoot**（+30–80 cents，80–150 ms 衰减）→ 听感"更有张力/更有冲击力"
* **vibrato**（depth/rate/start）→ 直接写进 `pitchCurveF0`
* **jitter / 微扰** → 张力、紧张感
* **滑音 / overshoot 幅度** → 与 TENC 强相关
* **实现**：在 `preprocessing.buildF0FrameSequence`（`:70-103`）或上层生成 `pitchCurveF0` 之前，用每音符的 `params.tenc / params.vibr` 合成曲线。**零训练、零模型改动、每音符粒度**。

#### A5 ★★★☆☆ 采样 / CFG 预设（"伪 TENC / 伪柔和"）

已有旋钮：`nSteps`、`cfg`、`cfgRescale`、sampler、CFG schedule（linear/cosine/custom）、dynamic threshold（`cfgSchedule.js`）。经验规律：高 CFG + 多步 → 咬字更硬、更"用力"；低 CFG + 少步 → 更柔和、更气声。做成 preset（Powerful / Soft / Breathy）成本最低，可作为 A1 的补充。

#### A6 ★★☆☆☆ Prompt 强度 / 长度旋钮

prompt 长度裁剪（保留前 N 帧）、prompt 与目标之间的间距/mask、变调对齐强度，都会影响 in-context 复制强度 → 可做成"音色贴合度"旋钮。

---

### 4.2 B 层：极少训练（本仓库已有完整 LoRA 链路可复用）

#### B1 ★★★★★ 新增 param_encoder 注入 cond（唯一能真正 per-note 连续控音色的路）

* **结构**：新增 `param_encoder = Linear(K, 512)`（K = 参数个数，如 genc/tenc/brec/dyn 共 4 个标量），输出加到：
  * **方案 a（最省事，推荐先试）— 帧级注入**：`combinedFeatures = expandedEmb + f0Emb + param_proj(params_frame)`（`preprocessing.js:888-894`）。
    → 只需新增**一个几 KB 的小 ONNX**（`param_encoder.onnx`），现有 9 个模型**一个都不用重导**。per-note 参数经 `mel2token` 展开成帧级即可（`:873-881` 已有展开逻辑）。
  * **方案 b — token 级注入**：加到 `tokenEmb` 的求和里（`:848-854`），语义更"每音符"，但加法在 preflow **之前**，必须把新 Linear 融合进 `preflow.onnx` 重新导出（`tools/export_step3_postprocess.py` 改一下即可）。
* **标签从哪来 → 全自动伪标签，零人工标注**（这点最关键）：
  * `GENC` ← mel 频率质心 / F1–F3 / mcep 第 2–5 阶，归一化到 [−1,1]
  * `BREC` ← HNR / aperiodicity（仓库已有 `scripts/test_aperiodicity.py`）
  * `TENC` ← 频谱倾斜 + 起音斜率 + 高频能量比
  * `DYN` ← 帧 RMS 相对中位数
  * 直接用训练音频自身回归即可 → **不需要任何人工风格标注**。
* **训练**：flow-matching MSE（沿用 `train/lora_jp_v3/train_lora.py` 的 `compute_flow_loss`），参数**随机采样**（其中固定比例置全 0 → 天然 classifier-free，直接复用现有 uncond 分支）。
* **可训练量**：只训 `Linear(4,512)`（2 K 参数）+ 可选 rank-8 LoRA 挂 preflow/前几层 DiffLlama；**DiffLlama 22 层完全冻结**。参考 jp LoRA 的规模（3.1M 参数 / 3 stage 就能跑通），这个量级是"几十分钟～几小时单卡"级别。
* **导出/部署**：新增 1 个小 ONNX（方案 a 甚至可以是纯 JS 实现的 Linear——`m += W·p`，连 ONNX 都不用加）。

#### B2 ★★★★☆ 复用空 embedding 槽做风格 token

`note_type_encoder = Embedding(256, 512)` 只用了 1/2/3 → 把 4–11 号槽定义为 `{power, soft, breathy, falsetto, belt, …}`；只训练这些行（每行 512 参数，总计几千参数）+ preflow 小 LoRA（否则 preflow/diff 读不懂新槽）。训练后**可在 embedding 空间插值**得到连续强度。
（同理可用 `note_pitch` 的 128–255 号槽，但会与音高语义纠缠，**不建议**。）

#### B3 ★★★☆☆ 属性 LoRA + 运行时缩放

* 用现有 `train/lora_jp_v3/lora.py`（rank16/α32）为每种风格训一个 LoRA。
* 想要"滑块"：导出时把 LoRA 分支 `α·(x@A@B)` 的 `α` **暴露成标量输入**（在 ONNX 图里插一个 `Mul`），一个模型即可连续调节；或离线合并 N 个插值点（简单但体积 ×N）。
* 工程成本高于 B1，效果与 B1 相当，建议只在 B1 不达标时做。

#### B4 ★★★☆☆ 用 GTSinger 的唱法标签做监督（数据侧增强）

GTSinger 提供**同歌手多唱法**（belt / breathy / falsetto / husky / pressed / vibrato / vocal fry / …），天然就是 TENC / BREC / GENC 的监督信号。仓库已有下载脚本 `train/dit_distill/download_gtsinger.py`，但当前 `data/GTSinger/wavs` **是空的**（只有 5 个歌手目录），需要重新下载。
→ 这是 B1/B2 质量最高的训练数据来源；若愿意下载，优先用它的"同歌手跨唱法"配对数据。

#### B5 ★☆☆☆☆ GST / 参考编码器

加一个 reference encoder（仓库已有 `modules/whisper_encoder.py`）从任意参考音频提 style vector 注入 cond。数据量大、训练重，**不建议优先**。

---

### 4.3 C 层：后处理（优先级最低，作兜底）

| 方法 | 说明 |
|------|------|
| **C1 mel 域 warp + 重跑 vocoder** | 对**生成的 mel** 做频率轴 warp / 倾斜，再送 vocoder。比波形域干净得多，是 GENC 最实用的后处理兜底（若 A1+ 变体库不够用）。 |
| **C2 SiFiGAN source-filter** | 已接入（`postprocessing.js:1085-1120`，mel+f0 双输入）。source/filter 分离 → 变调不变色、共振峰独立缩放、张力（source 波形陡峭度）都可做。 |
| **C3 波形域** | 动态倾斜 EQ（BRI/TENC）、包络跟随的调制噪声（BREC）、饱和/激励（TENC）。快但有伪影。 |
| **C4 WORLD / cheaptrick 重合成** | 仓库已验证 mcep 链路（`scripts/verify_mcep_extract.py`：harvest + cheaptrick + sp2mc(order=39, α=0.466)），可做高质量共振峰缩放 + 原 F0 重合成。 |
| **C5 已有** | volume / pan 包络、`loudnorm.js`、`wsola.js`（formant-preserving 变调、时长不影响音高）。 |

---

## 5. 推荐落地路线

| 阶段 | 内容 | 预期工作量 | 产出 |
|------|------|------------|------|
| **M0** | 参数数据结构（note.params + 曲线）+ `Timbre` 面板；接 A4（F0 侧 TENC/VIBR）+ A5（CFG 预设）+ A1（mel warp / 倾斜 / 气声 / 增益） | 1–2 周 | 段级 GENC/BREC/TENC/DYN + 每音符 F0 类参数 |
| **M1** | A1+ 离线 prompt 变体库（用 cheaptrick 谱包络做高质量 GENC）+ A2 风格库 + 按风格分段 + 缓存 key 扩展 | +1–2 周 | 高质量、零开销、连续可调 |
| **M2** | **B1 方案 a（帧级 param_encoder）** + 伪标签脚本；先只做 1 个参数（GENC）验证 | +1–2 周（含训练） | **真正的 per-note 连续音色参数** |
| **M3** | B1 扩到多参数 + 解耦（TENC 与 BRI/DYN 高度相关，需正交化或解耦正则）+ B2 风格 token | +2–4 周 | 完整 SV2 级参数集 |

> 若要"最快看到 SV2 味道"：M0 的 A4 + A1 就能出 70% 的听感；要"per-note 连续"必须上 M2（B1）。

---

## 6. 代码落点清单

| 需要改的地方 | 文件 | 位置 |
|--------------|------|------|
| prompt mel 产出（A1/A1+ 注入点之前） | `src/inference/pipeline/postprocessing.js` | `extractRefMelOnnx` `:1008-1066`、mel 归一化 `:778-782` |
| prompt 拿到之后、分段之前（**主注入点**） | `src/inference/pipeline/index.js` | `:2940-2954`（`ptMelData/ptFrameCount`）、`_synthesizeSegment` `:2440+` |
| CFG uncond 分支（A3） | `src/inference/pipeline/diffusion.js` | `_evalDiffStepSeparate` `:319-356`；batched row1 `:475-499` |
| cond 加法（B1 方案 a / b） | `src/inference/pipeline/preprocessing.js` | `tokenEmb` 求和 `:848-854`；`combinedFeatures` `:888-894`；prompt 段留零 `:896-907` |
| F0 曲线（A4） | `src/inference/pipeline/preprocessing.js` | `buildF0FrameSequence` `:70-103`；`notesToSequences` `:323-385` |
| 合成 options 入口 | `src/inference/pipeline/index.js` | `synthesize` options `:3345-3357` |
| 缓存 key（务必加参数） | `src/inference/pipeline/audioSegmentation.js` | `computeSynthCacheKey` `:408`、`computeSegmentCacheKey` `:431` |
| 分段 / 交叉淡化（A2 per-note 切换） | `src/inference/pipeline/audioSegmentation.js` + `diffusion.js` | `buildVocalSegments` `:148-299`；`_runSingleDiffusionChunk` `:1122-1188` |
| 参数 UI | `src/fragmentEditor/state.js` / `uiControls.js` | 面板模式 `:120-121`；`param-mode-select` `:145-148` |
| 训练（B1/B2/B3） | `SoulX-Singer/train/lora_jp_v3/` | `lora.py`、`train_lora.py:83-85`、三阶段配置 |
| 导出（B1 方案 b / B2） | `tools/export_step3_postprocess.py`、`tools/export_step4_jp.py` | — |
| 常量 | `src/inference/pipeline/constants.js` | `MEL_MEAN/MEL_VAR/F0_BIN/CFG_STRENGTH` `:15-22` |

---

## 7. 风险与验证清单

1. **prompt 段 cond 全 0 与训练不一致**：训练时 prompt 段有真实 cond（`flow_matching.py` 的 prompt 切分训练），App 侧置零。任何依赖 prompt 的改造要先做 A/B 听感验证；**顺手建议**：用 `.sxssinger` 里已有的 F0 + MIDI 补齐 prompt 段的 cond（可能同时提升质量与可控性）。
2. **A1 的 mel warp 会移动谐波** → 必须配合 `autoShift`（`index.js:3406-3430`）重对齐，否则高 α 时音色发飘。
3. **A3 负向 prompt 是 OOD 用法**（训练时 uncond = 全 0）→ 小 γ 起测，观察是否出现咬字崩坏/过冲。
4. **per-note 切换 = 分段**：音色跳变与边界伪影，必须在音符/乐句边界切 + WSOLA 交叉淡化；且每个分段要重新跑完整扩散（成本 ×N），需靠 `computeSegmentCacheKey` 缓存。
5. **参数耦合**：TENC ↑ 往往伴随 BRI ↑ / DYN ↑，用户会误以为"参数串扰"。建议首批只暴露**相互正交**的 3 个：GENC（共振峰）、BREC（HNR）、TENC（F0 分量 + 倾斜），并在训练侧做解耦（正交约束或对抗解耦）。
6. **多精度/多 EP 回归**：`fp16 / int8 / qdit / trt_fp16 / NPU 静态形状` 都要过一遍。A1/A1+/A4 只改数据不改形状 → 安全；新增 ONNX（B1）要处理 `NPU_STATIC_SEQ_LEN` 的 pad（`preprocessing.js:792-807`）。
7. **验证指标**：建议固定一组测试句 + 客观指标（mel 质心、HNR、F0 RMSE、speaker cosine 相似度是否保持在"同一人"阈值内）+ 主观 ABX。GENC 的关键验收是"**音色变了但听起来还是同一个歌手**"（speaker embedding 余弦相似度不应显著下降）。
