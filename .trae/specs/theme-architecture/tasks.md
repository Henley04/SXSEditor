# Tasks

> 实施顺序按依赖排列；Task N 依赖列表写在底部。
> 每个任务均包含可验证的子任务。

- [x] **Task 1：设计令牌基线（`:root` 全局 / alias / component 令牌）**
  - [x] SubTask 1.1：创建 `src/themes/tokens.js`（或 `common.css` 顶部）定义所有 global 令牌（颜色阶、空间阶、半径阶、字号阶、动效阶）的命名清单与默认值
  - [x] SubTask 1.2：定义 alias 令牌（`--bg-*`, `--fg-*`, `--accent`, `--border-*`, `--success/warning/danger`）映射到 global 令牌
  - [x] SubTask 1.3：定义 component 令牌（按钮、输入、面板、tooltip、selection）
  - [x] SubTask 1.4：把当前 `common.css` 中的基础值迁移为令牌并验证默认值与现状一致

- [x] **Task 2：内置主题包（4 套 JSON）**
  - [x] SubTask 2.1：创建 `src/themes/builtins/dark-aurora.theme.json`（**默认值必须复刻当前所有硬编码值**，包含所有 global + alias + component 令牌）
  - [x] SubTask 2.2：创建 `src/themes/builtins/light-paper.theme.json`（亮色白底）
  - [x] SubTask 2.3：创建 `src/themes/builtins/midnight-amber.theme.json`（暗色琥珀强调）
  - [x] SubTask 2.4：创建 `src/themes/builtins/contrast-onyx.theme.json`（高对比度，符合 WCAG AA）
  - [x] SubTask 2.5：编写 `src/themes/builtins/index.js` 通过 `import.meta.glob` 或 `require.context` 批量导入

- [x] **Task 3：主题校验器 `themeValidator`**
  - [x] SubTask 3.1：实现 `validate(themeObj)`：检查 `id` 格式（kebab-case，不以 `-` 开头/结尾）
  - [x] SubTask 3.2：检查 `tokens` 必须是对象
  - [x] SubTask 3.3：检查每个 token 键名匹配 `^--[a-z0-9][a-z0-9-]*$`
  - [x] SubTask 3.4：检查颜色值（`#/rgb(/rgba)+/`、`rgba(...)`、`hsla(...)`、`transparent`、`currentColor`）
  - [x] SubTask 3.5：检查 `extends` 不超过 3 层且不形成环
  - [x] SubTask 3.6：返回 `{ ok: boolean, errors: [{ token, message }], warnings: [...] }`

- [x] **Task 4：渲染进程 `themeManager`**
  - [x] SubTask 4.1：实现 `register(theme)` / `registerBuiltins()` / `unregister(id)` / `list()`
  - [x] SubTask 4.2：实现 `activate(themeId, { scope })`：展开 `extends`、注入到 `document.documentElement.style.setProperty`、触发 `theme-changed` CustomEvent
  - [x] SubTask 4.3：实现 `export(themeId)`：返回扁平化 JSON 字符串
  - [x] SubTask 4.4：实现 `import(jsonString)`：解析 → 校验 → 注册 → 返回新主题
  - [x] SubTask 4.5：实现 `mergeOverrides(patch)`：合并部分令牌覆盖（用于实时编辑器）
  - [x] SubTask 4.6：实现 `computeIsDark(tokens)`：根据 `--bg-app` 计算明暗
  - [x] SubTask 4.7：实现 20 步撤销栈 `pushHistory()` / `undo()` / `redo()`

- [x] **Task 5：主进程 `themeStorage`**
  - [x] SubTask 5.1：实现 `loadUserThemes()`：扫描 `userData/themes/*.theme.json`，跳过损坏文件
  - [x] SubTask 5.2：实现 `saveTheme(themeObj)`：原子写入（先 `.tmp` 再 rename），校验 id 合法性
  - [x] SubTask 5.3：实现 `deleteTheme(themeId)`：仅允许删除 user 来源
  - [x] SubTask 5.4：实现 `importFromDialog()`：调 `dialog.showOpenDialog`
  - [x] SubTask 5.5：实现 `exportToDialog(themeId)`：调 `dialog.showSaveDialog`

- [x] **Task 6：主进程 IPC 通道 + preload 暴露 `themeAPI`**
  - [x] SubTask 6.1：在 `main.js` 注册 `ipcMain.handle`：`theme:list`、`theme:get`、`theme:apply`、`theme:save`、`theme:delete`、`theme:import`、`theme:export`、`theme:current`
  - [x] SubTask 6.2：实现 `webContents` 注入脚本 `applyThemeOnLoad.js`（打包到 `src/themes/`），在所有 BrowserWindow 创建时 `webContents.on('did-finish-load')` 调用
  - [x] SubTask 6.3：实现广播 `theme:changed` / `theme:list:changed` 到所有打开窗口
  - [x] SubTask 6.4：在 `preload.js` 暴露 `window.themeAPI`（参照现有 `electronAPI` 风格）
  - [x] SubTask 6.5：在 `ALLOWED_SETTINGS_KEYS` 加入 `'theme'` 与 `'themePerWindow'`
  - [x] SubTask 6.6：在 `loadSettings()` 中合并默认值：`theme: 'dark-aurora'`、`themePerWindow: {}`

- [x] **Task 7：HTML 注入入口（7 个窗口）**
  - [x] SubTask 7.1：在 `index.html` / `fragmentEditor.html` / `settings.html` / `singerCreator.html` / `audioPreprocess.html` / `modelDownload.html` / `resourceManager.html` 的 `<head>` 引入 `<script src="./themes/themeBootstrap.js"></script>`（在 `common.css` 之后）
  - [x] SubTask 7.2：`themeBootstrap.js` 在主进程注入之前提供 `dark-aurora` 兜底令牌，避免 FOUC

- [x] **Task 8：现有 CSS 全量令牌化重构**
  - [x] SubTask 8.1：重构 `src/index.css`（工具栏、歌手面板、分片时间轴）
  - [x] SubTask 8.2：重构 `src/fragmentEditor.css`
  - [x] SubTask 8.3：重构 `src/settings.css`
  - [x] SubTask 8.4：重构 `src/singerCreator.css`
  - [x] SubTask 8.5：重构 `src/audioPreprocess.css`
  - [x] SubTask 8.6：重构 `src/modelDownload.css`
  - [x] SubTask 8.7：重构 `src/resourceManager.css`
  - [x] SubTask 8.8：重构 `src/common.css`（仅保留重置、滚动条、按钮基础）
  - [x] SubTask 8.9：清理残余 `rgba(91, 141, 239, ...)`、`rgba(0, 0, 0, ...)` 等带透明度颜色，引入新 alias 令牌（`--accent-soft`, `--accent-glow`, `--shadow-soft`, `--overlay`）并替换
  - [x] SubTask 8.10：grep 验证 `src/**/*.css` 除 `src/themes/builtins/*.json` 外无残余硬编码颜色

- [x] **Task 9：设置页主题管理 UI**
  - [x] SubTask 9.1：在 `settings.html` 增设 `.theme-section`，包含：主题下拉、编辑按钮、导入 / 导出 / 删除 / 重置按钮
  - [x] SubTask 9.2：实现主题编辑器模态（`themeEditor.html` 片段或动态构建）：按 `global / alias / component` 三组列出令牌
  - [x] SubTask 9.3：实现颜色拾取器（HEX / RGB 输入 + HEX 颜色面板）
  - [x] SubTask 9.4：实现"另存为"对话框
  - [x] SubTask 9.5：实现撤销 / 重做（编辑器内）
  - [x] SubTask 9.6：实现 i18n key 添加到 `zh-CN.js` 与 `en.js`

- [x] **Task 10：测试（Mocha + Chai）**
  - [x] SubTask 10.1：`test/themeValidator.test.js`：合法 / 非法 / 继承深度 / 环检测 / 颜色值类型
  - [x] SubTask 10.2：`test/themeManager.test.js`：注册 / 激活 / 注入 / 继承展开 / 撤销栈
  - [x] SubTask 10.3：`test/themeStorage.test.js`：读写 / 原子写入 / 损坏跳过 / id 校验（用临时目录）
  - [x] SubTask 10.4：`test/themeTokens.test.js`：所有内置主题覆盖必需令牌；`dark-aurora` 与现状色值匹配
  - [x] SubTask 10.5：现有 `wavEncoder` / `trackManager` / `nativeSvsPipeline` 等测试保持通过

- [ ] **Task 11：视觉回归 + 文档**
  - [ ] SubTask 11.1：在 4 套主题下分别启动应用（`npm start` + 切换主题），截图保存到 `docs/theme-screenshots/`
  - [ ] SubTask 11.2：手动对比 `dark-aurora` 与重构前 UI 是否一致
  - [x] SubTask 11.3：在 `README.md` 增"主题"章节，说明如何切换、导入、导出、自定义
  - [x] SubTask 11.4：在 `docs/wiki/Developer-Guide.md` 增"添加新主题"指南

# Task Dependencies

- [Task 2] 依赖 [Task 1]
- [Task 3] 依赖 [Task 1]
- [Task 4] 依赖 [Task 2, Task 3]
- [Task 5] 依赖 [Task 3]
- [Task 6] 依赖 [Task 4, Task 5]
- [Task 7] 依赖 [Task 6]
- [Task 8] 依赖 [Task 1, Task 2]
- [Task 9] 依赖 [Task 6, Task 7]
- [Task 10] 依赖 [Task 3, Task 4, Task 5, Task 2]
- [Task 11] 依赖 [Task 8, Task 9]
