# SXSEditor 界面走查修复记录

> 对应走查清单：`SXSEditor-界面走查清单.md`（§1 P0 六项、§2 主窗口 7 项 + 设置页 12 项、§3 音频预处理/分片编辑器/模型下载 9 项、§4 一致性打磨 4 项）。
> 本文只记「结论 + 落点」，不复述问题现象。

## 0. 验证结果

| 检查 | 结果 |
| --- | --- |
| `npx eslint src/ --ext .js` | **0 error**（70 warning 全为既有未使用变量，非本轮引入） |
| `npm run lint:ipc` | OK：229 个常量 / 229 被引用，无裸字符串通道 |
| `npm run test:ci` | **2153 passing / 7 failing**，7 项均为 Windows 专属 `onnxruntime.dll` 缺失，与改动无关（与 M1 时基线一致） |
| CSS 括号配平 | 5 个改动文件全部配平 |

## 1. 三条贯穿原则

1. **不引入泛光**。所有新增浮层只用「边框 + 背景色 + 位置」分层：`.toolbar-popover` 显式 `box-shadow: none`；骨架屏用不透明度呼吸（`sxs-skeleton-pulse`）而不是渐变扫光；折叠用原生 `<details>` 三角而不是自绘光效。顺手删掉了模型状态点上的 `box-shadow: 0 0 6px var(--success)`。
2. **状态色先命名再使用**。五态语义统一到 `--status-idle/busy/attention/error/ready`（见 §5）。
3. **能用原生控件就不自己造**。滑杆刻度用 `<datalist>` 风格端点 + 徽章改输入；长文案折叠用 `<details>`；弹出层才不得不自绘（`<details>` 会撑高工具栏）。

## 2. §1 P0 六项

| 条目 | 结论 | 落点 |
| --- | --- | --- |
| 1.1 缺模型红屏 | 已修 | `fragmentEditor/pipeline.js` 捕获 init 失败 → `showConfirmDialog`「缺少主模型 → 打开模型下载」；`fragmentEditor/index.js` 给 `initPipeline()` 加 `.catch()`，不再被 webpack dev overlay 接成全屏红屏 |
| 1.2 placeholder 不翻译 | 已修 | `settings.html` 搜索框与 CFG 占位符全部走 `data-i18n-placeholder` |
| 1.3 中英混排 | 已修 | `settings.js` `vocoderChunkSmartResult` 分支：两值皆缺走 `…Unknown`，仅缺显存走 `unknownVram` |
| 1.4 加载态无骨架/超时 | 已修 | 歌手市场：6 张骨架卡 + 12 s 超时 + `sr-only` 播报；资源管理器：10 s 超时 + 「一句原因 + 重试」；`#summaryContent` 补占位文案 |
| 1.5 窄栏 label 截断 | 已修 | `fragmentEditor.css` `.field-row` 改两行网格 + `.lbl` 允许换行；inspector 默认 220 → **300 px**，拖拽下限 160 → 240 |
| 1.6 模型行信息黑洞 | 已修 | 主进程 `settingsIpc.js` 补 `missingBytes`；渲染层拼「已就绪 12/18 个文件 · 1.2 GB」+ 就地「补齐」按钮 |

## 3. §2 主窗口

| 条目 | 结论 | 落点 |
| --- | --- | --- |
| a 顶栏 12 控件平铺 | 已修 | `index.html` 分 4 组 + 分隔线；Audio to MIDI / Import MIDI 收进 `⋯`（**id 全部保留**，`eventHandlers.js` 一行未改） |
| b 灰禁无 tooltip | 已修 | 导出按钮改 `aria-disabled` + `.is-unavailable`（原生 `disabled` 会让 Chromium 不弹 title），tooltip 说明「先添加一个分片」 |
| c 三个添加入口 | 已修 | 空工程时虚线 CTA 放大（56 px 虚线框、正文色）+ 第二行说明；标题栏 `+` 自动收起（`#btn-add-singer[hidden]` 需显式 `display:none`，否则被 `display:flex` 覆盖） |
| d Auto Shift 语义不明 | 已修 | 补 `data-i18n-title` 长说明，标签本身走 i18n |
| e BPM + 两个拍号框 | 已修 | 合并为单个 `4/4` 按钮 + 弹出层；`#time-sig-num/den` id 不变，原 change 监听照旧 |
| f 右上角 `1500px × 950px` | **不改** | 全仓（含 `ui-preview.html`）搜不到该文本，是截图采集工具叠加的视口标注，不是应用 UI |
| g 状态栏对比度 2.8:1 | 已修 | 字号 10.5 → 11.5 px、色阶 `--fg-muted` → `--fg-secondary` |

## 4. §2 设置页

h–s 全部落地，要点：

- **h** 硬件三灯从「永远黄字」变状态机：检测中（蓝，脉冲）/ 可用（绿）/ 不可用（灰）/ **失败（红 + 就地重试）**，`loadDevices()` catch 走 `markHardwareDetectionFailed()`。
- **j / l** `Precision Info` 首屏只留 2 条结论，5 条细节与 VRAM 参考表都折进 `<details class="settings-disclosure">`。
- **k** VRAM 表把「连续且 frames 与约时长相同」的档位合并成 `2–4GB` 区间行（12 行 → 9 行），高亮判定改区间包含。
- **o** 滑杆：端点刻度 + 徽章点击改数值 + 双击 label 复位。数值写入走「改 `range.value` 再派发 `input`/`change`」，15 条既有监听器无需感知来源。
- **p** 长 hint 超过 96 字自动折成 `<details class="hint-fold">`，正文仍用 `-webkit-line-clamp: 2`（文本留在 DOM 里，Ctrl+F 与读屏都能命中）。
- **q** 「仅导出生效」升级为 `.section-desc--callout` + 每个受控项挂 `仅导出` 标签。
- **r / s** 侧栏 15 条按 6 大类折叠，点条目先展开所在组；分类标题改 Title Case、`12.5px/650`。

## 5. 状态色语义化（§4 cc）

此前同一种"检测中"在设置页是黄、在模型下载页是蓝；"未安装"有深灰浅灰两档。现在统一为：

```css
/* src/components.css */
:root {
  --status-idle: var(--fg-muted);      /* 未开始 / 不适用 / 未安装 */
  --status-busy: var(--accent);        /* 进行中：检测、下载、加载 */
  --status-attention: var(--warning);  /* 需要用户操作：可更新、缺文件 */
  --status-error: var(--danger);       /* 失败 */
  --status-ready: var(--success);      /* 就绪 / 已安装 */
}
```

- 定义在 `components.css` 而**不是** `themeFallback.css`：后者被 `test/themeFallback.test.js` 与 `themeBootstrap.js` 逐项比对，加变量会牵动启动兜底链路；这里只是别名，取值随换肤自动变化。
- 消费方：`.overview-dot.*`、`.model-overview-dot.*`、`.model-overview-status.*`、`.status-indicator.*`、`.webnn-status-value.*`；`var(--warning, #f0ad4e)` 的硬编码兜底一并清掉（主题里根本没有 `#f0ad4e` 这个橙）。

## 6. §3 音频预处理 / 分片编辑器 / 模型下载

| 条目 | 结论 | 落点 |
| --- | --- | --- |
| t 字段无分组、宽度不一 | 已修 | `audioPreprocess.html` 拆三组（预设与算法 / F0 范围 / 节拍与响度）；`.extract-row` 改 `auto-fit minmax(148px, 1fr)` |
| u 两个空面板像渲染失败 | 已修 | `#waveform-empty` / `#midi-empty` 空态（`.panel-empty`，`pointer-events: none`），载入音频与有音符时隐藏 |
| v 主次按钮不分 | 已修 | `RVMPE Extract F0` 保持实心主色，`Basic Pitch` 从 `btn-success` 降为描边 |
| w 加载遮罩无进度 | 已修（改造） | 接上主进程一直在推、但没人订阅的 `svs:loadProgress`：进度条 + 阶段（检测硬件 / 定位模型 / 加载 8/18）+ 已等待秒数；底部状态栏同步显示。**没有做「取消」**——主进程 init 无中止通道，做假的取消只会骗人；改为「先在后台加载」：收起遮罩，进度转到底部状态栏，音符编辑不依赖模型，可先改音符 |
| x 顶部 `F#9` 出现两次 | 已修（误读） | `midiToNoteName` 按 `midi % 12` 取名，数据不会重复。真因是 10 px 下 `#` 与 10 px 标签对比度不足：黑键标签 `#cccccc`、白键 `#2a2a3d`，缩放后 `#` 先糊掉，`F#9` 退化成 `F9`。改 11px/600 + 提高对比度 |
| y 折叠箭头压住 `Minim…` | 已修 | `Minim…` 是 `#pp-mode-tag` 在 220 px 栏宽下被裁；栏宽 300 px 后消失。另加 `.insp-head > span:first-child` 单行省略 + `.tag` 不收缩，`.nat-actions` 允许换行（说明文字不再被按钮挤成窄柱） |
| z 导出与 tab 交叉 | 已修 | 两个导出按钮收进 `导出 ▾` 弹出层，**id 与监听器不变**；定位逻辑抽到 `src/utils/popoverMenu.js`，主窗口的 `⋯` 与拍号复用同一份 |
| aa tab 只写 Missing | 已修 | 总览卡片带缺口数：「未安装 · 缺 12 个文件」（主模型读 `missingFiles`，JP 读 `result.missing`，SiFiGAN/FCPE 数 `files` 里 `exists === false` 的项）。**没做体积合计**：manifest 里刻意不含 size（不猜），真实体积要等远端 Content-Length，填个假数只会误导 |
| bb 版本行挤压 | 已修 | `.version-info-row` 行高 1.6 + 相邻行 `margin-top`；`.version-select-row` 上边距 |

## 7. §4 其余

| 条目 | 结论 | 落点 |
| --- | --- | --- |
| dd 字号偏小 | 已修 | hint 12 px / 行高 **1.6**；正文 13 px（`--font-base`）；分片编辑器状态栏 11.5 px |
| ee 撤销/重做不可辨 | 已修 | 主题编辑器：`themeManager` 新增 `canUndo/canRedo/peekUndo/peekRedo`（历史是整份快照，用相邻快照做差集反推动作对象），按钮按栈空置灰（`opacity .42` + 锁光标 + 去 hover 位移），tooltip 写「撤销：--accent、--bg-panel 等 N 项」 |
| ff 资源管理器列宽 | 已修 | ≥1000 px 断点：GPU 信息与汇总并排、模型列表整行，容器 `max-width` 680 → 1040。原截图的「480 px」是 1400 宽窗口按 0.77 缩放后的测量值（实际列宽 624 px） |
| gg 登录与刷新同级 | 已修 | 登录改实心主色 CTA，`#btn-refresh` 降为 30 px 图标按钮 |

## 8. 本轮新增 / 改动文件

新增：
- `src/renderer/toolbarPopovers.js`（拍号 + `⋯`，定位逻辑已抽走）
- `src/utils/popoverMenu.js`（弹出层通用装配：fixed 定位、点外关闭、Esc、resize 关闭）
- `src/settingsUi.js`（滑杆增强 + 长 hint 折叠）

主要改动（约 25 个文件）：`index.html/css`、`fragmentEditor.{html,css}`、`fragmentEditor/{pipeline,index,canvasRenderer}.js`、`settings.{html,css,js}`、`modelDownload.{css,js}`、`resourceManager.{html,css,js}`、`singerMarket.{html,css,js}`、`audioPreprocess.{html,css}`、`components.css`、`themes/themeManager.js`、`i18n/{zh-CN,en}.js`、`eslint.config.cjs`。

## 9. 后续可选

1. 「先在后台加载」目前只藏遮罩：若主进程补一个 init 中止通道，可把它换成真取消。
2. 模型体积合计要等远端返回 Content-Length 后才有真值，届时再把 `必需 5.4 GB` 加到页头。
3. 分片编辑器的 `Fragment` 按钮（打开分片选择）与左栏「添加歌手」不是同一件事，未合并；若后续两个窗口合并成一个，可再收敛。
