# Checklist

> 全部检查项须通过。所有项可在应用启动、`npm test`、`npm run package:lite` 与手动操作下验证。

## 设计令牌基线（Task 1）
- [ ] `src/common.css`（或 `src/themes/tokens.css`）定义所有 global 令牌（颜色阶 50-900、空间阶、半径阶、字号阶、动效阶）
- [ ] alias 令牌引用 global 令牌（`var(--color-...)`），不出现硬编码颜色
- [ ] component 令牌引用 alias 令牌
- [ ] 默认值与重构前硬编码值一致（取色对照通过）

## 内置主题（Task 2）
- [ ] `dark-aurora.theme.json` 复刻所有现有硬编码值（8 个 CSS 文件逐一验证）
- [ ] `light-paper.theme.json` 在 4 个颜色阶（蓝/灰/红/绿/琥珀）覆盖
- [ ] `midnight-amber.theme.json` 琥珀色为主强调色
- [ ] `contrast-onyx.theme.json` 满足 WCAG AA 文本对比度（≥ 4.5:1）
- [ ] 4 套主题均通过 `themeValidator.validate()` 校验

## 校验器（Task 3）
- [ ] 缺 `id` / `tokens` 报错并定位字段
- [ ] 非法 token 键名（如 `Color-blue-500`、含 `!`）报错
- [ ] 非法颜色值（如 `red`、不完整 hex）报错
- [ ] `extends` 超过 3 层报错
- [ ] 环状继承（`A extends B, B extends A`）报错
- [ ] 父主题不存在报错

## themeManager（Task 4）
- [ ] `register` / `registerBuiltins` / `unregister` / `list` 行为正确
- [ ] `activate` 注入令牌到 `document.documentElement.style`
- [ ] `theme-changed` 事件触发，detail 含 `{ themeId, scope, tokens }`
- [ ] `extends` 在激活时递归展开
- [ ] `export` 返回扁平化 JSON 字符串
- [ ] `import` 校验失败抛 `ThemeValidationError`
- [ ] `mergeOverrides` 支持部分覆盖
- [ ] `computeIsDark` 根据 `--bg-app` 亮度正确判定
- [ ] 撤销栈 20 步，`undo` / `redo` 行为正确

## 主进程存储（Task 5）
- [ ] `loadUserThemes` 扫描 `userData/themes/*.theme.json`
- [ ] 损坏 JSON 跳过并打印警告，应用不崩溃
- [ ] `saveTheme` 原子写入（`tmp` + `rename`），失败回滚
- [ ] `saveTheme` 拒绝非法 id（含 `/`, `\`, `:`, `*`, `?`, `"`, `<`, `>`, `|`, 控制字符）
- [ ] `deleteTheme` 拒绝 builtin 主题
- [ ] `importFromDialog` 使用 `.theme.json` 过滤器
- [ ] `exportToDialog` 默认文件名 `<theme-id>.theme.json`

## IPC + preload（Task 6）
- [ ] `ipcMain.handle` 注册 8 个主题通道
- [ ] 所有 BrowserWindow 在 `did-finish-load` 前注入令牌（避免 FOUC）
- [ ] 主题变更广播到所有打开窗口
- [ ] `window.themeAPI` 暴露所有方法
- [ ] `ALLOWED_SETTINGS_KEYS` 包含 `theme` 与 `themePerWindow`
- [ ] `loadSettings` 默认 `theme='dark-aurora'`、`themePerWindow={}`

## HTML 注入（Task 7）
- [ ] 7 个 HTML 引入 `themeBootstrap.js`
- [ ] `themeBootstrap.js` 在主进程注入前提供 `dark-aurora` 兜底
- [ ] 启动至主窗口绘制前无白屏 / 闪烁

## CSS 重构（Task 8）
- [ ] `src/index.css` 全部颜色 / 间距 / 半径 / 字号 / 动效引用令牌
- [ ] `src/fragmentEditor.css` 全部令牌化
- [ ] `src/settings.css` 全部令牌化
- [ ] `src/singerCreator.css` 全部令牌化
- [ ] `src/audioPreprocess.css` 全部令牌化
- [ ] `src/modelDownload.css` 全部令牌化
- [ ] `src/resourceManager.css` 全部令牌化
- [ ] `src/common.css` 保留重置、滚动条、按钮基础，全部令牌化
- [ ] grep 验证 `src/**/*.css` 除 `src/themes/builtins/*.json` 外无残余硬编码十六进制颜色

## 视觉无回归（Task 11）
- [ ] 切换到 `dark-aurora` 后，与重构前 UI 截图像素级一致（误差 ≤ 1 像素 / 通道）
- [ ] 4 套主题截图保存在 `docs/theme-screenshots/`
- [ ] 工具栏、歌手面板、分片时间轴、设置、分片编辑器、歌手创建、音频预处理、模型下载、资源管理 9 个界面（8 CSS + 1 settings）全部外观正常

## 设置页 UI（Task 9）
- [ ] 主题下拉分组显示"内置"与"用户"
- [ ] 主题切换无需重启，所见即所得
- [ ] 主题编辑器按 `global / alias / component` 三组列出令牌
- [ ] 颜色拾取器支持 HEX / RGB / HSL 输入
- [ ] 屏幕取色按钮（`desktopCapturer` + 像素采样）工作正常
- [ ] "另存为"对话框校验 id 唯一
- [ ] 撤销 / 重做（编辑器内）20 步
- [ ] 导入 / 导出 / 删除 / 重置按钮全部工作
- [ ] i18n key 全部覆盖 zh-CN / en

## 测试（Task 10）
- [ ] `npm test` 全部通过
- [ ] `test/themeValidator.test.js` 覆盖合法 / 非法 / 继承 / 颜色 / 键名
- [ ] `test/themeManager.test.js` 覆盖注册 / 激活 / 继承 / 撤销
- [ ] `test/themeStorage.test.js` 覆盖读写 / 原子写入 / 损坏跳过
- [ ] `test/themeTokens.test.js` 验证 4 套主题覆盖必需令牌；`dark-aurora` 关键颜色匹配现状
- [ ] 现有 `wavEncoder` / `trackManager` / `nativeSvsPipeline` 等测试保持通过

## 持久化集成
- [ ] `settings.json` 出现 `theme` 与 `themePerWindow` 字段
- [ ] 切换主题后关闭再开，应用仍保持上次选择
- [ ] 卸载应用（删除 userData）后重新启动回退到 `dark-aurora`

## 跨窗口
- [ ] 主窗口切换主题，其他窗口（已打开）同步
- [ ] 每个窗口可设置 `themePerWindow` 覆盖，互不干扰
- [ ] 关闭窗口后 `themePerWindow` 配置保留

## 文档
- [ ] `README.md` 增"主题"章节
- [ ] `docs/wiki/Developer-Guide.md` 增"添加新主题"指南
- [ ] 4 套主题在文档中介绍

## 构建与打包
- [ ] `npm start` 启动正常
- [ ] `npm test` 全部通过
- [ ] `npm run package:lite` 打包成功
- [ ] 主题文件被正确打包到 `app.asar`
