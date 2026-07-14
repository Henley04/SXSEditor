# Tasks

- [x] Task 1: 新增设置键与默认值（`src/main/settings.js`）
  - [x] SubTask 1.1: 在 `ALLOWED_SETTINGS_KEYS` 增加 `updateChannel`、`autoCheckUpdates`、`skippedAppVersion`、`dontRemindAppUpdates`、`lastUpdateCheckTime`
  - [x] SubTask 1.2: 在 `loadSettings` 中为新键做类型校正与默认值回填（`updateChannel` 默认 `'release'`，`autoCheckUpdates` 默认 `true`，`skippedAppVersion` 默认 `null`，`dontRemindAppUpdates` 默认 `false`，`lastUpdateCheckTime` 默认 `null`）

- [x] Task 2: 新增 IPC 通道常量（`src/shared/ipcChannels.js`）
  - [x] SubTask 2.1: 增加 `UPDATE_CHECK_NOW`、`UPDATE_GET_STATUS`、`UPDATE_SKIP_VERSION`、`UPDATE_DONT_REMIND`、`UPDATE_OPEN_DOWNLOAD_PAGE`、`UPDATE_OPEN_MODEL_DOWNLOAD`、`UPDATE_NOTIFICATION_SHOW` 常量

- [x] Task 3: 创建主进程检查模块（`src/main/updateChecker.js`）
  - [x] SubTask 3.1: 实现 `_fetchGithubJson(url)`，使用 `https.request` 带 `User-Agent: SXSEditor-Updater` 头，处理 403 速率限制（读取 `X-RateLimit-Reset`）、超时、非 200
  - [x] SubTask 3.2: 实现 `checkAppUpdate(channel)`：`release` 频道请求 `/releases/latest` 取 `tag_name` 与 `app.getVersion()` 用 `compareVersions` 比较；`nightly` 频道请求 `/releases/tags/nightly` 取 `published_at` 与 `build-info.json` 的 `buildTimestamp` 比较；返回统一结构 `{ updateAvailable, currentVersion, latestVersion, releaseUrl, downloadUrl, publishedAt, releaseNotesHtml, channel, error? }`
  - [x] SubTask 3.3: 实现 `checkModelUpdates()`：调用 `modelManager.checkModelVersion` / `checkJpModelVersion` / `checkSifiganVersion` 聚合返回 `{ main, jp, sifigan, anyUpdateAvailable }`（复用现有函数，不改动其逻辑）
  - [x] SubTask 3.4: 实现 `checkAllUpdates(channel)`：并行调用 app + model 检查，返回合并结果
  - [x] SubTask 3.5: 实现 `shouldAutoCheck(settings, isPackaged)`：返回 `autoCheckUpdates && isPackaged && !dontRemindAppUpdates && 距 lastUpdateCheckTime > 24h`；实现 `recordCheckTime(settings)` 写入 `lastUpdateCheckTime`
  - [x] SubTask 3.6: 实现 `shouldShowNotification(appResult, settings)`：app 有更新且 `latestVersion !== skippedAppVersion` 时返回 true

- [x] Task 4: 创建主进程 IPC 模块（`src/main/updateIpc.js`）
  - [x] SubTask 4.1: 注册 `update:check-now`：读取 settings 的 channel，调用 `checkAllUpdates`，更新 `lastUpdateCheckTime`，返回结果
  - [x] SubTask 4.2: 注册 `update:get-status`：返回当前 settings 中的更新相关字段 + `app.getVersion()`
  - [x] SubTask 4.3: 注册 `update:skip-version`：写入 `skippedAppVersion = latestVersion`
  - [x] SubTask 4.4: 注册 `update:dont-remind`：写入 `dontRemindAppUpdates = true`
  - [x] SubTask 4.5: 注册 `update:open-download-page`：扩展 `model-download:open-external` 白名单增加 `https://github.com/Henley04/SXSEditor/`，通过 `shell.openExternal` 打开
  - [x] SubTask 4.6: 注册 `update:open-model-download`：复用 `model-download:open` 逻辑打开模型下载窗口

- [x] Task 5: 接入 main.js（`src/main.js`）
  - [x] SubTask 5.1: `require` 并调用 `registerUpdateIpc()`
  - [x] SubTask 5.2: 在主窗口 `did-finish-load` 后台硬件检测逻辑之后，追加启动自动检查：`if (shouldAutoCheck(...)) { checkAllUpdates(channel).then(result => { recordCheckTime(...); if (shouldShowNotification(...)) openUpdateNotificationWindow(result); }) }`，catch 错误仅打日志

- [x] Task 6: 新增窗口管理（`src/main/windowManager.js`）
  - [x] SubTask 6.1: 增加 `updateNotificationWindow` 变量与 `getUpdateNotificationWindow` / `setUpdateNotificationWindow`
  - [x] SubTask 6.2: 实现 `openUpdateNotificationWindow(data)`：创建 BrowserWindow（模态、parent=mainWindow、尺寸约 560x640、preload=`UPDATE_NOTIFICATION_WINDOW_PRELOAD_WEBPACK_ENTRY`），`did-finish-load` 后 `send('update:notification-show', data)`，`closed` 时置 null
  - [x] SubTask 6.3: 导出 `openUpdateNotificationWindow` 与 getter

- [x] Task 7: 创建更新提示窗口 UI（`src/updateNotification.html` / `.js` / `.css`）
  - [x] SubTask 7.1: HTML 结构：标题区（应用图标 + 「发现新版本」）、应用更新区（当前版本/最新版本/发布时间/更新说明摘要/「立即更新」按钮）、模型更新区（模型列表/「打开模型下载」按钮）、底部操作区（「跳过本次更新」「不再提醒」「关闭」）
  - [x] SubTask 7.2: JS 逻辑：监听 `update:notification-show` 填充数据；按钮分别 invoke `update:open-download-page`、`update:open-model-download`、`update:skip-version`、`update:dont-remind`；调用 i18n `t()` 做文案；无应用更新时隐藏「立即更新/跳过/不再提醒」仅保留模型区；无模型更新时隐藏模型区
  - [x] SubTask 7.3: CSS 复用 `common.css` 与主题变量，与 settings/modelDownload 窗口视觉一致

- [x] Task 8: 注册 forge 入口（`forge.config.js`）
  - [x] SubTask 8.1: 在 `entryPoints` 增加 `update_notification_window`（html=`./src/updateNotification.html`, js=`./src/updateNotification.js`, preload=`./src/preload.js`）

- [x] Task 9: 暴露 preload API（`src/preload.js`）
  - [x] SubTask 9.1: 增加 `updateAPI` 命名空间：`checkNow()`、`getStatus()`、`skipVersion(version)`、`dontRemind()`、`openDownloadPage(url)`、`openModelDownload()`、`onNotificationShow(callback)`

- [x] Task 10: 设置页新增「更新」分区（`src/settings.html` / `src/settings.js` / `src/settings.css`）
  - [x] SubTask 10.1: settings.html 在侧边栏「模型」分类下增加「更新」条目（`data-target="section-update"`），在 main 区域增加 `#section-update` 分区
  - [x] SubTask 10.2: 分区内容：频道选择 select（nightly/release）、自动检查 checkbox、「立即检查更新」按钮、结果展示区（当前版本/最新版本/上次检查时间/状态文案）、「重新启用更新提醒」按钮（仅 `dontRemindAppUpdates=true` 时显示）
  - [x] SubTask 10.3: settings.js 绑定事件：频道切换保存 settings、自动检查 toggle 保存、立即检查按钮调用 `updateAPI.checkNow()` 显示 loading→结果、检测到更新且未屏蔽时调用 `updateAPI.openDownloadPage`? 否——自动检查路径不弹窗，手动检查发现更新时应打开更新提示窗口（由主进程在 `update:check-now` 后判断并 send 给设置页？更简单：主进程 `update:check-now` 返回结果后，设置页内联展示；若需弹窗由主进程直接 openUpdateNotificationWindow）
  - [x] SubTask 10.4: settings.css 补充更新分区必要样式（复用现有 setting-group/info-box 类，最小新增）

- [x] Task 11: 新增 i18n 翻译（`src/i18n/zh-CN.js` / `en.js`）
  - [x] SubTask 11.1: 增加 `update` 命名空间键：`title`、`section`、`channel`、`channelNightly`、`channelRelease`、`channelHint`、`autoCheck`、`autoCheckHint`、`checkNow`、`checking`、`lastCheck`、`currentVersion`、`latestVersion`、`upToDate`、`updateAvailable`、`updateAvailableAppHint`、`updateAvailableModelHint`、`openModelDownload`、`updateNow`、`skipVersion`、`dontRemind`、`close`、`reEnableReminder`、`rateLimited`、`networkError`、`publishedAt`、`releaseNotes`、`appUpdateAreaTitle`、`modelUpdateAreaTitle`、`openBrowserHint`

- [x] Task 12: 更新 README.md
  - [x] SubTask 12.1: 在功能列表与设置说明中补充「自动检查更新」功能（频道选择、自动检查、手动检查、跳过/不再提醒）

- [x] Task 13: 测试与验证
  - [x] SubTask 13.1: 运行 `npm test` 确保现有测试不回归
  - [x] SubTask 13.2: 运行 `npm run package:lite` 冒烟验证打包成功（按工作区规则）
  - [x] SubTask 13.3: 手动验证：启动应用 → 设置页可见「更新」分区 → 切换频道/开关持久化 → 「立即检查更新」返回结果 → dev 模式启动不自动检查

# Task Dependencies
- Task 3 依赖 Task 1（读取 settings）
- Task 4 依赖 Task 2、Task 3
- Task 5 依赖 Task 4、Task 6
- Task 6 依赖 Task 8（preload entry 常量名）
- Task 7 依赖 Task 8、Task 9、Task 11
- Task 10 依赖 Task 9、Task 11
- Task 13 依赖所有前置任务
