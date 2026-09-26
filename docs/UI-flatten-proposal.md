# SXSEditor UI 检查报告 —— 现代化扁平化改造方案

> 审查范围：`src/` 下 13 个 CSS 文件（约 220KB）、9 个 HTML 页面、`src/themes/` 5 套主题 token。
> 结论：当前设计语言是 **2015–2018 年的「渐变 + 发光 + 位移」软拟物风**，与现代扁平（Fluent 2 / Material 3 / Linear 风格）存在系统性差距。差距主要集中在 **token 层**，因此改造成本可控。

---

## 一、总体判断

| 维度 | 现状 | 现代扁平标准 | 评级 |
|---|---|---|---|
| 表面质感 | 全渐变按钮/工具栏/头部 | 纯色 + 边框分层 | ❌ 需重构 |
| 阴影 | 彩色 glow 泛光（36+ 处） | 无彩色光，仅中性极低阴影 | ❌ 需清理 |
| 圆角 | 2/4/8/10/12 px，偏"尖" | 4/6/8/12/16 px | ⚠️ 需重定标 |
| 字号 | base 12px / sm 11px | base 13–14px | ⚠️ 偏小 |
| 装饰元素 | 渐变竖条、装饰线、左色条 | 靠留白 + 字重 + 色彩对比 | ❌ 需移除 |
| 动效 | hover 位移 + 缩放 + 回弹 + 发光 | 仅颜色/背景过渡 | ❌ 过度 |
| 组件体系 | 无 Card / Segmented / Switch | 有 | ⚠️ 缺失 |
| 主题一致性 | 硬编码色值泄漏 51 处 | 100% token 化 | ❌ 破坏主题 |

---

## 二、具体问题清单（按严重度）

### P0 — 系统性风格问题

#### 1. 按钮/工具栏/头部全部使用纵向渐变
`dark-aurora.theme.json:110-118`、`light-paper.theme.json:110-118`

```json
"--bg-button": "linear-gradient(180deg, #3a3a4e 0%, #323246 100%)",
"--bg-button-hover": "linear-gradient(180deg, #484860 0%, #3e3e56 100%)",
"--bg-button-primary": "linear-gradient(180deg, #5b8def 0%, #4a7de0 100%)"
```
共 8 组渐变 token（button / button-hover / button-active / primary / primary-hover / success / success-hover / danger / danger-hover），加上 `--bg-toolbar-start/end`、`--bg-header-start/end` 也有渐变。这是最典型的非扁平特征。

#### 2. 彩色发光阴影（glow）泛滥
全项目 `box-shadow` 出现 **120+ 次**，其中大量是彩色泛光：
```css
/* components.css:196 */ box-shadow: 0 2px 12px var(--accent-glow);
/* components.css:322 */ box-shadow: var(--shadow-xl), 0 0 40px var(--accent-softer);
/* index.css:205    */ box-shadow: 0 2px 10px var(--accent-glow);
```
`--accent-glow` / `--danger-glow` / `--success-glow` / `--warning-glow` 这套 token 本身就是为发光设计的。扁平设计应改为「边框 + 中性阴影」分层。

#### 3. 装饰性渐变竖条（伪拟物）
```css
/* common.css:102 */ .section-title::before { width:3px; height:14px; background:linear-gradient(...) }
/* common.css:123 */ h2::before            { width:4px; height:22px; background:linear-gradient(...) }
/* components.css:117 */ #toolbar::before  { 装饰线 }
/* exportDialog.css:63,106 */ 同样的渐变竖条
```
这些"小色块"是靠装饰物制造层级，扁平设计用字号 + 字重 + 留白即可。

#### 4. 动效过度 + 性能反模式
```css
/* common.css:69-70 —— 全局所有按钮常驻合成层，严重浪费显存 */
button { transform: translateZ(0); will-change: transform; }

/* common.css:73-75 —— 每个按钮 hover 都位移 */
button:hover:not(:disabled) { transform: translateY(-1px); }

/* common.css:77 —— 按下缩放 */
button:active:not(:disabled) { transform: translateY(0) scale(0.97); }

/* components.css:41 —— dialog 打开带模糊，重且慢 */
@keyframes dialog-enter { ... filter: blur(4px); }

/* index.css:340 —— 列表项 hover 横向位移，会导致文字重绘模糊 */
.singer-item:hover { transform: translateX(2px); }
```
另外 `--ease-bounce`（`cubic-bezier(0.34,1.56,0.64,1)` 回弹）被用在大量 hover 上，扁平设计基本不用 overshoot。

---

### P1 — 架构与一致性问题

#### 5. 样式重复定义（维护债）
| 选择器 | 重复位置 | 冲突点 |
|---|---|---|
| `#toolbar` | `index.css:10` / `components.css:102` | padding 不一致（`--space-5` vs `10px`） |
| `::selection` | `common.css:44` / `common.css:322` | 完全重复 |
| `.section-desc` | `common.css:132` / `settings.css:94` | margin/字号不一致 |

#### 6. `!important` 16 处
`common.css`×5、`settings.css`×4、`fragmentEditor.css`×4、`index.css`×1、`exportDialog.css`×1、`updateNotification.css`×1。
典型如 `index.css:252` `.accompaniment-item { border-left: 3px solid var(--accent) !important; }`，说明选择器特异性已失控。

#### 7. 硬编码颜色泄漏 51 处（破坏主题切换）
`modelDownload.css`×17、`singerMarket.css`×7、`fragmentEditor.css`×7、`audioPreprocess.css`×7、`index.css`×5、`exportDialog.css`×4、`settings.css`×3、`updateNotification.css`×1。

最典型：
```css
/* settings.css:163 —— 箭头颜色写死为 dark-aurora 的 gray-500 */
background-image: url("data:image/svg+xml,...fill='%238888a8'...");
```
切到 `light-paper` 主题后箭头会因对比度不足而看不清。

#### 8. 字号与间距偏小、层级不足
```json
"--font-xs":"10px", "--font-sm":"11px", "--font-base":"12px", "--font-md":"13px"
"--space-8": "24px"   // 最大只到 24px，缺 32/40 大间距
```
工具栏 44px、面板头 36px 偏密；现代扁平通常 48px 工具栏、40px 面板头、正文 13–14px。

#### 9. 圆角标尺不连贯
`2 / 4 / 8 / 10 / 12`。`--radius-xl(10)` 与 `--radius-2xl(12)` 仅差 2px，且 modal 用 `xl`、卡片用 `lg`，层级区分度不够。

#### 10. 缺少现代扁平核心组件
- **无 Segmented Control**：`settings.html` 有 30 处 `checkbox`/`radio`/`select`，大量二选一场景仍用下拉或单选圆点。
- **无 Switch**：开关全用 `input[type=checkbox]`（16px，热区偏小，现代建议视觉 ≥20px / 热区 ≥44px）。
- **无 Card 规范**：`.info-box`、`.export-dialog-section`、`.settings-subgroup` 各自实现，边框/圆角/内边距不统一。
- **无 IconButton 尺寸规范**：`24px / 22px / 24px / 26px` 各种尺寸散落。

---

### P2 — 细节优化

11. **聚焦环与 hover 阴影冲突**：`common.css:149` 用 `box-shadow: var(--focus-ring)` 做聚焦，但大量组件 hover 也用 `box-shadow`，会互相覆盖导致聚焦态不可见。
12. **滚动条 6px 偏细**：高分屏/触控下难以命中，建议 8–10px + hover 加宽。
13. **`backdrop-filter: blur(4px)`** 用在 `.modal-overlay` / `.loading-overlay` / `.export-dialog-overlay`，在低端 GPU 上开销大，扁平设计可用纯半透明遮罩替代。
14. **`.singer-item` 固定 80px 高 + `translateX` hover**：列表密度偏高，建议 64px 且去掉位移。
15. **`--fg-*` 语义混乱**：`--fg-primary/secondary/muted/disabled` 之外还有 `--fg-bpm` `--fg-time` `--fg-toolbar-hover` `--bg-singer-active` 等一次性 token，命名不体系化。
16. **`--bg-panel / --bg-elevated / --bg-input` 层级语义模糊**：三个值在 dark 主题下是 `#1a1a2a / #1e1e2e / #1a1a28`，其中 panel(26) 比 elevated(30) 更暗，命名与实际层级相反。

---

## 三、改造方案

### 阶段 A：Token 层扁平化（改动小、收益最大）

因为所有组件都走 `var()`，**只需改 5 个主题 JSON 的 token 值，全站即可扁平化**。

**A1. 渐变 → 纯色**
```jsonc
// dark-aurora.theme.json
"--bg-button":          "#2a2a3a",   // 原 linear-gradient
"--bg-button-hover":    "#34344a",
"--bg-button-active":   "#22222e",
"--bg-button-primary":  "#4a7de0",   // 原渐变
"--bg-button-primary-hover": "#5b8def",
"--bg-toolbar-start": "#1e1e2e", "--bg-toolbar-end": "#1e1e2e",  // 直接同色
"--bg-header-start":  "#1a1a28", "--bg-header-end": "#1a1a28"
```

**A2. 彩色 glow → 中性阴影 + 边框**
```jsonc
"--shadow-sm": "0 1px 2px rgba(0,0,0,.24)",
"--shadow-md": "0 1px 3px rgba(0,0,0,.28)",
"--shadow-lg": "0 4px 12px rgba(0,0,0,.32)",
"--shadow-xl": "0 8px 24px rgba(0,0,0,.40)",
// 新增分层 token（扁平核心：用边框而非阴影做层级）
"--surface-1": "#14141f",  // app
"--surface-2": "#1a1a26",  // panel
"--surface-3": "#22222f",  // elevated / hover
"--border-hairline": "rgba(255,255,255,.06)"
// 保留 --accent-glow 但降级为极低值，或直接把引用处改为 --accent-soft
```

**A3. 圆角/字号/间距重定标**
```jsonc
"--radius-sm":"4px","--radius-md":"6px","--radius-lg":"8px",
"--radius-xl":"12px","--radius-2xl":"16px","--radius-full":"9999px",

"--font-xs":"11px","--font-sm":"12px","--font-base":"13px",
"--font-md":"14px","--font-lg":"15px","--font-xl":"18px","--font-2xl":"22px",

"--space-9":"32px","--space-10":"40px"
```
配套：`#toolbar` 高 44→48px，面板头 36→40px，`.singer-item` 80→64px。

---

### 阶段 B：清理装饰与动效

**B1. 删除装饰伪元素**
```css
/* 删除 common.css .section-title::before / h2::before */
/* 删除 components.css #toolbar::before */
/* 删除 exportDialog.css h3::before / section-title::before */
```
改为：`.section-title { font-size:12px; font-weight:600; letter-spacing:.4px; color:var(--fg-muted); }`（去掉 uppercase 与多余字距）。

**B2. 动效收敛**
```css
/* 删除 common.css button 的 will-change / translateZ */
button { transition: background-color .15s, border-color .15s, color .15s; }

/* hover 只改背景，不位移、不发光 */
button:hover:not(:disabled) { background: var(--bg-button-hover); }

/* dialog 去掉 filter: blur() */
@keyframes dialog-enter {
  from { opacity:0; transform: translateY(8px); }
  to   { opacity:1; transform: translateY(0); }
}

/* 列表项去掉 translateX */
.singer-item:hover { background: var(--surface-3); }
```
`--ease-bounce` 仅保留给 checkbox/radio 的勾选动画。

---

### 阶段 C：架构去重与 Token 化

**C1. 去重**
- 删掉 `components.css` 中的 `#toolbar` 整段（保留 `index.css` 版本，或反过来只留一处并让所有页面引入）。
- 删掉 `common.css:322` 重复的 `::selection`。
- 统一 `.section-desc` 到 `common.css`，`settings.css` 中的覆盖版删除。
- 逐步消除 16 处 `!important`（改用提升选择器特异性解决）。

**C2. 硬编码 Token 化**
```css
/* settings.css select 箭头：硬编码 → token */
/* 方案：新增 token --select-arrow-fg，或用 mask + background-color: currentColor */
select {
  -webkit-mask: url("data:image/svg+xml,...") no-repeat right 12px center;
  background-color: var(--fg-muted);
}
```
`modelDownload.css` 的 17 处、其余 7 个文件的硬编码逐项替换为 token。

**C3. 命名体系化**
```
--fg-1 / --fg-2 / --fg-3 / --fg-disabled      （正文层级，替代 primary/secondary/muted）
--surface-1 / --surface-2 / --surface-3        （背景层级，替代 bg-panel/elevated/app）
--border-1 / --border-2 / --border-3           （subtle/default/strong）
--accent / --accent-hover / --accent-active
--danger / --success / --warning
```
保留旧 token 作为别名做平滑迁移，避免一次性改爆 13 个文件。

---

### 阶段 D：补齐扁平组件

在 `components.css` 中新增统一组件（所有页面复用，不再各写各的）：

| 组件 | 说明 | 替代现状 |
|---|---|---|
| `.btn` / `.btn--primary` / `.btn--ghost` / `.btn--danger` / `.btn--icon` | 32px / 24px 两档，纯色 + 1px 边框，无位移 | 分散的 `#toolbar button` / `.btn-small` / `#btn-add-singer` |
| `.card` | 1px 边框 + `--radius-lg` + 16px 内边距，无阴影 | `.info-box` / `.settings-subgroup` |
| `.segmented` | 分段控件，选中项纯色块 + 圆角 | 二选一的 radio / select |
| `.switch` | 36×20 滑块开关 | `input[type=checkbox]` 做开关处 |
| `.chip` | 标签/徽章 | `.version-badge` / BPM badge |
| `.field` / `.field__label` / `.field__hint` | 统一表单行 | `.form-group` / `.setting-group` / `.export-dialog-field` |

---

## 四、建议实施顺序

| 步骤 | 内容 | 风险 | 视觉效果 |
|---|---|---|---|
| 1 | 5 个主题 JSON 的 token 扁平化（A1+A2+A3） | 低（纯 token 值） | ⭐⭐⭐⭐⭐ 立竿见影 |
| 2 | 删除装饰伪元素 + 动效收敛（B1+B2） | 低 | ⭐⭐⭐⭐ |
| 3 | 工具栏/面板头/列表项尺寸调整 | 低 | ⭐⭐⭐ |
| 4 | 去重 + 硬编码 token 化（C1+C2） | 中（需回归各页面） | ⭐⭐ |
| 5 | 新增扁平组件并逐步替换（D） | 中高 | ⭐⭐⭐⭐ |

**建议先执行步骤 1+2**，这两步基本不触碰组件逻辑、风险极低，且能一次性把整站从「渐变发光软拟物」切换为「纯色边框扁平」，改动集中在 5 个 JSON + 2 个 CSS。

---

## 五、附带建议（非风格）

1. **统一入口**：目前 `index.css` 与 `components.css` 存在职责重叠，建议明确 `common.css`（基础+全局）→ `components.css`（跨页组件）→ 页面 CSS 的三层结构，页面 CSS 不再定义跨页选择器。
2. **对比度校验**：`--fg-muted: #8888a8` 在 `--bg-app: #14141f` 上对比度约 5.4:1，勉强达标；但硬编码的 `#8888a8` 箭头在浅色主题下会掉到 2.5:1 以下，建议统一提升到 ≥4.5:1。
3. **密度自适应**：设置页 30 处表单控件集中，可考虑引入 `--density-compact/comfortable` 主题维度。
4. **暗色纯黑问题**：当前暗色主题带蓝紫偏色（`#14141f`），扁平风格下建议改用中性灰阶（`#18181b` / zinc 系），更现代。

---

*是否需要我直接执行「步骤 1 + 步骤 2」（token 扁平化 + 装饰/动效清理）？这是收益最大、风险最低的部分。*
