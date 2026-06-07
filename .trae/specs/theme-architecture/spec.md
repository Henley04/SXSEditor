# 全面个性化主题架构 Spec

## Why

SXSEditor 当前所有 UI 颜色、间距、阴影、字体均以硬编码十六进制值散落在 8 个 CSS 文件中（`common.css`, `index.css`, `settings.css`, `fragmentEditor.css`, `singerCreator.css`, `audioPreprocess.css`, `modelDownload.css`, `resourceManager.css`），没有任何可变层。用户无法切换暗色 / 亮色主题，更无法自定义颜色或在不同窗口中应用不同主题。这阻碍了产品化与用户个性化诉求。

需要一个 **可扩展、可继承、可视化编辑、可导入导出、跨窗口统一** 的主题架构，让"主题"成为一等公民。

## What Changes

- 引入 **三层设计令牌（Design Token）系统**：`global tokens`（原子值，例如 `blue-500`）→ `alias tokens`（语义化，例如 `color-accent`）→ `component tokens`（组件级，例如 `button-primary-bg`）。所有 CSS 通过 `var(--token)` 引用。
- 引入 **主题包（Theme Pack）JSON 格式**，定义一个完整主题的所有令牌值；通过 IPC 在主进程统一管理用户主题库。
- 内置 **4 套出厂主题**：`dark-aurora`（默认，暗色蓝紫）、`light-paper`（亮色白底）、`midnight-amber`（暗色琥珀强调）、`contrast-onyx`（高对比度无障碍）。
- 引入 `themeManager` 模块：负责加载、注册、激活、热切换、序列化、校验主题。监听 `theme-changed` 事件并通知所有打开的窗口。
- 在 `settings.html` 增设 **主题管理面板**：主题下拉切换、主题编辑器（按分类展开所有令牌、颜色拾取器、实时预览）、导入 / 导出按钮、重置为默认。
- 支持 **每窗口独立主题**（可选）：主窗口、分片编辑器、设置、歌手创建、音频预处理、模型下载、资源管理各自可指定主题 ID，默认回退到全局。
- 支持 **主题热重载**：编辑令牌值后无需重启窗口，所见即所得。
- 主题文件存储于 `userData/themes/<theme-id>.theme.json`；内置主题在 `src/themes/builtins/` 中只读。
- 主题支持继承：通过 `"extends": "dark-aurora"` 继承父主题，仅覆写差异令牌。
- 全部现有 CSS 重构为令牌驱动，保持外观与现状**像素级一致**（默认主题 `dark-aurora` 必须复刻当前所有硬编码值）。
- 设置项 `settings.theme`（全局主题 ID）和 `settings.themePerWindow`（每窗口覆盖 map）持久化到 `userData/settings.json`，主进程缓存并在启动时应用。

**BREAKING**：自定义 CSS 钩子 — 第三方扩展若直接覆盖硬编码颜色（而非通过令牌）将在亮色主题下失效。但项目当前无第三方扩展，故不构成外部破坏。

## Impact

- **Affected specs**:
  - `create-svs-editor`（主进程结构）
  - `complete-first-release`（设置页 UI）
  - `fix-all-bugs-and-missing`（保留 CSS 外观）
- **Affected code**:
  - `src/main.js`（IPC 主题通道、主题文件 IO、启动注入）
  - `src/preload.js`（暴露 `themeAPI`）
  - `src/common.css`（新增 `:root` 令牌基线）
  - `src/index.css`, `src/settings.css`, `src/fragmentEditor.css`, `src/singerCreator.css`, `src/audioPreprocess.css`, `src/modelDownload.css`, `src/resourceManager.css`（全部令牌化）
  - `src/settings.html` + `src/settings.js`（主题管理面板）
  - `src/themes/builtins/*.theme.json`（新增 4 个）
  - `src/themes/themeManager.js`（新增，渲染进程主题管理）
  - `src/themes/tokenCatalog.js`（新增，令牌目录 + 元数据）
  - `src/themes/themeValidator.js`（新增，JSON 校验）
  - `src/themes/themeStorage.js`（新增，主进程主题文件 IO）
  - `src/themes/index.js`（聚合导出）
  - 所有窗口的 `.html`（在 `<head>` 引入 `theme-bootstrap.js`）

## ADDED Requirements

### Requirement: 设计令牌系统（Design Token System）
The system SHALL provide a three-layer design token system: global, alias, and component.

#### Scenario: 全局令牌定义
- **WHEN** 主题被激活
- **THEN** `document.documentElement` 上至少出现以下全局令牌：`--color-blue-50` … `--color-blue-900`、`--color-gray-50` … `--color-gray-900`、`--color-red-500`、`--color-green-500`、`--color-amber-500`、`--color-magenta-500`、`--color-cyan-500`、`--space-0` … `--space-8`、`--radius-sm` `--radius-md` `--radius-lg` `--radius-full`、`--shadow-sm` `--shadow-md` `--shadow-lg`、`--font-xs` `--font-sm` `--font-base` `--font-md` `--font-lg` `--font-xl`、`--motion-fast` `--motion-base` `--motion-slow`
- **AND** 这些令牌的值由当前激活主题提供

#### Scenario: 别名令牌定义
- **WHEN** 主题被激活
- **THEN** 至少定义别名令牌：`--bg-app`、`--bg-panel`、`--bg-elevated`、`--bg-input`、`--fg-primary`、`--fg-secondary`、`--fg-muted`、`--accent`、`--accent-hover`、`--accent-pressed`、`--border-subtle`、`--border-strong`、`--success`、`--warning`、`--danger`、`--scrollbar-thumb`、`--scrollbar-track`
- **AND** 别名令牌引用全局令牌（`var(--color-blue-500)` 等）

#### Scenario: 组件令牌定义
- **WHEN** 主题被激活
- **THEN** 至少定义组件令牌：`--button-primary-bg`、`--button-primary-fg`、`--button-secondary-bg`、`--button-secondary-fg`、`--button-disabled-bg`、`--input-bg`、`--input-border`、`--input-focus-ring`、`--panel-border`、`--panel-bg`、`--tooltip-bg`、`--tooltip-fg`、`--selection-bg`、`--selection-fg`
- **AND** 组件令牌引用别名令牌

### Requirement: 主题包格式（Theme Pack）
The system SHALL define a JSON-based theme pack format.

#### Scenario: 主题 JSON 结构
- **WHEN** 加载主题文件
- **THEN** 必须包含 `id`（kebab-case 唯一）、`name`（人类可读）、`version`（semver）、`author`（可选）、`isDark`（boolean）、`description`（可选）
- **AND** 必须包含 `tokens` 字段，键为完整令牌名（如 `--color-blue-500`），值为字符串
- **AND** 可选 `extends` 字段引用父主题 id

#### Scenario: 主题继承
- **WHEN** 主题 A 包含 `"extends": "B"`
- **THEN** 主题 A 的最终令牌 = 主题 B 令牌 ∪ 主题 A 覆盖
- **AND** 继承深度超过 3 层时校验失败
- **AND** 父主题不存在时校验失败

#### Scenario: 主题校验
- **WHEN** 加载主题文件
- **THEN** 通过 `themeValidator` 校验
- **AND** 缺失 `id` 或 `tokens` 抛错并提示
- **AND** 令牌键名格式不正确（不以 `--` 开头或包含非法字符）抛错
- **AND** 颜色值不符合 `#rgb` / `#rrggbb` / `#rrggbbaa` / `rgba(...)` / `transparent` 抛错

### Requirement: themeManager 主题管理
The system SHALL provide a `themeManager` module in the renderer process.

#### Scenario: 注册主题
- **WHEN** 调用 `themeManager.register(themeObj)` 或 `themeManager.registerBuiltins()`
- **THEN** 主题被加入内存注册表
- **AND** 同 id 重复注册时后者覆盖前者并发出 `theme-overwritten` 事件

#### Scenario: 激活主题
- **WHEN** 调用 `themeManager.activate(themeId, { scope: 'global' | <windowName> })`
- **THEN** 通过 `document.documentElement.style.setProperty` 注入所有令牌
- **AND** 触发 `theme-changed` 事件，event.detail 包含 `{ themeId, scope, tokens }`
- **AND** 主题未注册时抛 `ThemeNotFoundError`

#### Scenario: 列出主题
- **WHEN** 调用 `themeManager.list()`
- **THEN** 返回所有已注册主题的元数据数组（`id`, `name`, `isDark`, `author`, `version`, `source` ∈ `'builtin' | 'user'`，未持久化返回 `'memory'`）

#### Scenario: 导出主题
- **WHEN** 调用 `themeManager.export(themeId)`
- **THEN** 返回完整主题 JSON 字符串（已解析 `extends` 后展开为扁平 tokens）
- **AND** 内置主题导出时 `source` 标记为 `builtin`

#### Scenario: 导入主题
- **WHEN** 调用 `themeManager.import(jsonString)` 或 `themeManager.importFromFile(filePath)`
- **THEN** 解析并校验
- **AND** 校验失败抛 `ThemeValidationError` 并附错误详情
- **AND** 校验通过后注册为 `user` 来源并触发 `theme-imported` 事件

### Requirement: 主题持久化（主进程）
The system SHALL persist user themes and current selection in main process.

#### Scenario: 主题文件存储
- **WHEN** 用户保存主题
- **THEN** 写入 `userData/themes/<theme-id>.theme.json`
- **AND** 主题 id 含非法字符（`/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`, 控制字符）时抛错
- **AND** 写入失败时回滚已存在的同名文件

#### Scenario: 启动加载
- **WHEN** 应用启动
- **THEN** 主进程扫描 `userData/themes/`，注册所有 `.theme.json` 文件
- **AND** 注册 4 个内置主题（来自 `src/themes/builtins/`，标记 `source: 'builtin'`）
- **AND** 读取 `settings.theme` 与 `settings.themePerWindow`，通过 IPC 推送到每个打开的窗口

#### Scenario: IPC 通道
The preload SHALL expose `window.themeAPI` with at least:
- `getAvailableThemes()` → 主题元数据数组
- `getCurrentTheme({ scope })` → 当前激活主题 id
- `applyTheme(themeId, { scope })` → 切换
- `getThemeTokens(themeId)` → 完整扁平 tokens
- `saveTheme(themeObj)` → 持久化
- `deleteTheme(themeId)` → 删除用户主题
- `importThemeFromFile()` → 弹出文件选择对话框导入
- `exportTheme(themeId, filePath?)` → 导出
- `onThemeChanged(callback)` → 订阅 `theme-changed` 事件
- `onThemeListChanged(callback)` → 订阅 `theme-list-changed` 事件

### Requirement: 主题管理面板（设置页）
The system SHALL provide a theme management UI inside `settings.html`.

#### Scenario: 主题选择
- **WHEN** 用户在主题下拉中选中某主题
- **THEN** 立即通过 `themeAPI.applyTheme(id, { scope: 'global' })` 应用
- **AND** 下拉分组显示"内置"和"用户"

#### Scenario: 主题编辑器
- **WHEN** 用户点击"编辑当前主题"
- **THEN** 打开模态面板，按 `global / alias / component` 三层分组列出令牌
- **AND** 颜色令牌旁显示颜色块、十六进制值、颜色拾取器
- **AND** 尺寸令牌旁显示数值输入框（带单位下拉 px/rem/%）
- **AND** 修改后实时更新（debounce 200ms）应用到当前窗口

#### Scenario: 保存为新主题
- **WHEN** 用户在编辑器中点击"另存为"
- **THEN** 弹出输入框要求 `id` 与 `name`
- **AND** 校验 id 唯一（不与已注册冲突）
- **AND** 校验通过后调用 `themeAPI.saveTheme(themeObj)` 写入 userData
- **AND** 主题出现在"用户"分组

#### Scenario: 导入 / 导出
- **WHEN** 用户点击"导入主题"
- **THEN** 弹出文件选择对话框，过滤 `.theme.json` `.json`
- **AND** 校验失败时显示错误提示（包含失败令牌列表）
- **WHEN** 用户点击"导出主题"
- **THEN** 弹出保存对话框，默认文件名 `<theme-id>.theme.json`
- **AND** 写入所选路径

#### Scenario: 重置为默认
- **WHEN** 用户点击"重置为默认主题"
- **THEN** 应用 `dark-aurora` 到全局
- **AND** 清空 `settings.themePerWindow`

### Requirement: 主题热切换
The system SHALL switch themes without page reload.

#### Scenario: 跨窗口同步
- **WHEN** 主窗口切换主题
- **THEN** 所有已打开窗口的 `theme-changed` 事件触发
- **AND** 各窗口立即更新令牌

#### Scenario: 每窗口覆盖
- **WHEN** 某窗口注册了 `themePerWindow[windowName]`
- **THEN** 该窗口使用覆盖值，其他窗口仍使用全局
- **AND** 主题下拉在每个窗口中显示当前实际主题

#### Scenario: 主题未应用
- **WHEN** 窗口启动时主题尚未注入
- **THEN** 使用 `dark-aurora` 作为兜底（避免 FOUC）
- **AND** 主题准备好后立即覆盖

### Requirement: 现有 CSS 重构
The system SHALL refactor all 8 existing CSS files to use design tokens.

#### Scenario: 硬编码颜色替换
- **WHEN** 重构 CSS
- **THEN** 所有 `color: #xxxxxx` / `background: #xxxxxx` / `border: 1px solid #xxxxxx` / 包含颜色的 `linear-gradient` / `box-shadow` 改为引用令牌
- **AND** 选区颜色、滚动条颜色、阴影颜色等"易被遗忘"位置同样令牌化

#### Scenario: 外观零回归
- **WHEN** 默认主题 `dark-aurora` 被激活
- **THEN** 应用截图与重构前像素级一致（误差 ≤ 1 像素 / 通道）
- **AND** 工具栏、歌手面板、分片时间轴、设置、分片编辑器、歌手创建、音频预处理、模型下载、资源管理 8 个界面统一外观

#### Scenario: 字号 / 间距令牌化
- **WHEN** 重构 CSS
- **THEN** `font-size` 使用 `--font-*`
- **AND** `padding` `margin` `gap` 使用 `--space-*`（含负值 `--space-neg-1` 等）
- **AND** `border-radius` 使用 `--radius-*`
- **AND** `transition-duration` 使用 `--motion-*`

### Requirement: 主题编辑器辅助（Visual Theme Editor）
The system SHALL support a basic visual theme editor (basic / 进阶可选)。

#### Scenario: 颜色拾取器
- **WHEN** 用户在编辑器中点击颜色令牌
- **THEN** 显示一个颜色拾取面板（HSL/RGB/HEX 三种输入）
- **AND** 提供"取色器"按钮，弹出系统级屏幕取色（使用 `desktopCapturer` 取屏幕截图 + 像素采样）

#### Scenario: 调色盘预览
- **WHEN** 用户编辑 `global` 颜色阶（如 `--color-blue-500`）
- **THEN** 实时显示该阶 50-900 全系列（基于编辑值插值生成，或显示单点）
- **AND** 自动推导 `isDark` 字段（基于 `--bg-app` 亮度计算）

#### Scenario: 撤销 / 重做
- **WHEN** 用户在编辑器中编辑令牌
- **THEN** 编辑器内部维护 20 步撤销栈
- **AND** Ctrl+Z / Ctrl+Y 触发撤销 / 重做（不影响其他历史栈）
- **AND** "重置当前令牌" 按钮将单个令牌恢复为内置主题对应值

### Requirement: 主题文件导入兼容性
The system SHALL accept loose and strict JSON forms.

#### Scenario: 解析兼容
- **WHEN** JSON 缺少 `version`
- **THEN** 视为 `"1.0.0"`
- **WHEN** JSON 包含 `author`, `description`, `tags`
- **THEN** 保留这些字段
- **WHEN** `tokens` 键名是 `color-blue-500` 而非 `--color-blue-500`
- **THEN** 自动补全前缀并发出 `theme-import-warning` 事件

#### Scenario: 错误恢复
- **WHEN** 单个用户主题文件损坏
- **THEN** 主进程跳过该文件并打印警告
- **AND** 其他主题仍可使用
- **AND** 设置页通知用户"1 个用户主题加载失败"

## MODIFIED Requirements

### Requirement: 设置持久化（修改）
设置结构扩展 `theme` 字段：

```json
{
  "theme": "dark-aurora",
  "themePerWindow": {
    "fragmentEditor": "light-paper",
    "settings": "midnight-amber"
  },
  "deviceId": 0,
  ...
}
```

主进程在 `loadSettings()` 时合并默认值；`saveSettings` 时 `ALLOWED_SETTINGS_KEYS` 增加 `'theme'` 与 `'themePerWindow'`。

### Requirement: 启动流程（修改）
The main process SHALL inject theme tokens into all windows before first paint.

#### Scenario: 启动注入
- **WHEN** 创建 `BrowserWindow`（包括主窗口 / fragmentEditor / singerCreator / audioPreprocess / modelDownload / resourceManager / settings）
- **THEN** 在 `did-finish-load` 之前向 `webContents.executeJavaScript` 注入令牌注入脚本
- **AND** 注入脚本在 DOMContentLoaded 阶段执行

### Requirement: i18n 集成（修改）
设置页与主题管理面板的所有字符串支持中英文（`data-i18n` 标签）。

新增 i18n key:
- `theme.title`、`theme.builtin`、`theme.user`、`theme.scope.global`、`theme.scope.window`、`theme.editor`、`theme.saveAs`、`theme.import`、`theme.export`、`theme.delete`、`theme.reset`、`theme.color`、`theme.size`、`theme.motion`、`theme.untitled`

## REMOVED Requirements

无。
