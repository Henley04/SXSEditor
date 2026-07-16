# 自动检查更新 Spec

## Why
当前应用没有任何机制通知用户有新的应用构建（nightly/release）或新的模型版本可用。用户必须手动查看 GitHub Release 和模型下载页，体验摩擦大，容易错过 bug 修复与模型改进。需要一套与现有 CI（已在 `release` / `master` 分支产出 GitHub Release）集成的自动检查更新机制，并在检测到更新时显式弹出更新提示窗口。

## What Changes
- 新增主进程模块 `src/main/updateChecker.js`：通过 GitHub Releases API 检查应用本体更新（按 `nightly` / `release` 频道），并复用 `modelManager` 的 `checkModelVersion` / `checkJpModelVersion` / `checkSifiganVersion` 聚合模型更新状态。
- 新增主进程 IPC 模块 `src/main/updateIpc.js`：注册 `update:check-now`、`update:get-status`、`update:skip-version`、`update:dont-remind`、`update:open-download-page`、`update:open-model-download` 等处理器。
- 新增独立的「更新提示」窗口（`src/updateNotification.html` / `.js` / `.css`）：检测到更新后显式弹出，展示应用与模型更新信息，提供「立即更新」「跳过本次更新」「不再提醒」按钮。
- 在设置页新增「更新」分区：频道选择（nightly / release）、自动检查开关、「立即检查更新」按钮、上次检查时间与当前/最新版本展示。
- 新增持久化设置项：`updateChannel`、`autoCheckUpdates`、`skippedAppVersion`、`dontRemindAppUpdates`、`lastUpdateCheckTime`。
- 启动时自动检查（主窗口就绪后后台执行，每 24h 至多一次，dev 模式跳过；被「不再提醒」或「跳过当前版本」时不再弹窗）。
- 暴露 preload API、注册 forge 入口、新增 i18n（zh-CN / en）、更新 README。
- **BREAKING**：无（纯新增功能；不修改现有模型版本逻辑）。

## Impact
- 受影响代码：
  - `src/main/settings.js`（新增设置键与默认值）
  - `src/main/settingsIpc.js`（无需改，复用 `settings:saveSettings`）
  - `src/main/windowManager.js`（新增 `openUpdateNotificationWindow`）
  - `src/main.js`（注册 `registerUpdateIpc`，启动时触发自动检查）
  - `src/preload.js`（暴露 `updateAPI`）
  - `src/shared/ipcChannels.js`（新增 `UPDATE_*` 通道常量）
  - `src/settings.html` / `src/settings.js` / `src/settings.css`（新增更新分区 UI）
  - `src/i18n/zh-CN.js` / `src/i18n/en.js`（新增 `update.*` 翻译）
  - `forge.config.js`（新增 `update_notification_window` 入口）
  - `README.md`（文档化新功能）
- 新增文件：
  - `src/main/updateChecker.js`
  - `src/main/updateIpc.js`
  - `src/updateNotification.html`
  - `src/updateNotification.js`
  - `src/updateNotification.css`
- CI 集成：无需修改 `.github/workflows/ci.yml`。现有 CI 已在 `release` 分支产出 semver tag 的正式 Release（`prerelease=false`），在 `master` 分支产出滚动 `nightly` tag 的预发布 Release（`prerelease=true`）。本方案直接消费 GitHub Releases API（`https://api.github.com/repos/Henley04/SXSEditor/releases`）。
- 复用：模型更新检测完全复用 `src/main/modelDownload.js` 中已有的 `model-download:check-all-versions` IPC 与 `modelManager` 的版本比对函数（`compareVersions`、`checkModelVersion` 等），不改动其逻辑。

## ADDED Requirements

### Requirement: 应用本体更新检查
系统 SHALL 通过 GitHub Releases API 检查应用本体是否有新版本，按用户选择的频道（nightly / release）执行不同比对策略。

#### Scenario: release 频道检查
- **WHEN** 用户选择 `release` 频道并触发检查（手动或自动）
- **THEN** 系统请求 `https://api.github.com/repos/Henley04/SXSEditor/releases/latest`（GitHub 该端点返回最新非预发布 Release）
- **AND** 取其 `tag_name`（semver X.Y.Z），与 `app.getVersion()` 使用 `modelManager.compareVersions` 做语义化版本比较
- **AND** 返回 `{ updateAvailable, currentVersion, latestVersion, releaseUrl, downloadUrl, publishedAt, releaseNotesHtml, channel: 'release' }`

#### Scenario: nightly 频道检查
- **WHEN** 用户选择 `nightly` 频道并触发检查
- **THEN** 系统请求 `https://api.github.com/repos/Henley04/SXSEditor/releases/tags/nightly`
- **AND** 取其 `published_at`（ISO8601），与本地 `src/build-info.json` 的 `buildTimestamp`（epoch ms）比较；若远程 `published_at` 晚于本地构建时间戳，则 `updateAvailable=true`
- **AND** 返回 `{ updateAvailable, currentVersion, latestVersion: nightlyTagInfo, releaseUrl, downloadUrl, publishedAt, releaseNotesHtml, channel: 'nightly' }`

#### Scenario: 网络错误 / 速率限制
- **WHEN** GitHub API 请求失败（速率限制 403、网络超时、非 200 等）
- **THEN** 检查返回 `{ error: message, updateAvailable: false }`，UI 显示友好错误提示，绝不崩溃
- **AND** 速率限制时记录响应头 `X-RateLimit-Reset`，在 UI 提示「GitHub API 速率限制，请稍后重试」

### Requirement: 模型更新检查（复用已有逻辑）
系统 SHALL 复用 `model-download:check-all-versions` IPC 检测模型更新，不重复实现版本比对。

#### Scenario: 模型更新可用
- **WHEN** `main` / `jp` / `sifigan` 任一返回 `updateAvailable: true`
- **THEN** 更新提示窗口列出对应模型更新项，并提供「打开模型下载」按钮跳转到现有模型下载窗口
- **AND** 模型更新不参与「跳过本次版本」语义（仅应用本体版本可被跳过）

#### Scenario: 无模型更新
- **WHEN** 所有模型 `updateAvailable: false`
- **THEN** 更新提示窗口的模型区域显示「已是最新」并隐藏模型更新按钮

### Requirement: 更新提示窗口
系统 SHALL 在检测到更新时（自动检查或设置页手动检查）显式弹出独立的更新提示窗口。

#### Scenario: 显示窗口
- **WHEN** 一次检查（自动或手动）发现应用或模型有更新
- **AND** 应用更新未被「跳过本次版本」/「不再提醒」屏蔽
- **THEN** 调用 `openUpdateNotificationWindow(data)` 打开独立窗口，展示当前版本、最新版本、发布时间、更新说明摘要、模型更新状态
- **AND** 窗口模态附着到主窗口，包含三个主操作：「立即更新」「跳过本次更新」「不再提醒」

#### Scenario: 跳过本次更新
- **WHEN** 用户点击「跳过本次更新」
- **THEN** 将当前检测到的最新版本写入 `skippedAppVersion` 设置项，关闭窗口
- **AND** 后续自动检查若最新版本等于 `skippedAppVersion` 则不再弹窗；出现更新的版本时恢复弹窗

#### Scenario: 不再提醒
- **WHEN** 用户点击「不再提醒」
- **THEN** 设置 `dontRemindAppUpdates = true`，关闭窗口
- **AND** 后续自动检查不再弹出窗口（设置页手动检查仍可触发，且手动检查时即使 `dontRemindAppUpdates=true` 也允许显示窗口）
- **AND** 设置页提供「重新启用更新提醒」入口以重置该标志

#### Scenario: 立即更新（应用）
- **WHEN** 用户点击「立即更新」（应用区域）
- **THEN** 系统通过 `shell.openExternal` 打开对应 Release 的下载 URL（`https://github.com/Henley04/SXSEditor/releases/download/<tag>/sxsinstaller_x64_no_models.exe` 或 `releases/latest/download/...`）
- **AND** 窗口提示「已打开浏览器下载安装包，下载完成后请手动安装」

#### Scenario: 立即更新（模型）
- **WHEN** 用户点击「打开模型下载」
- **THEN** 复用现有 `model-download:open` IPC 打开模型下载窗口，关闭更新提示窗口

#### Scenario: 无更新
- **WHEN** 检查结果为应用与模型均无更新
- **THEN** 自动检查路径不弹窗；手动检查路径在设置页内联显示「已是最新版本」

### Requirement: 设置页 — 更新分区
系统 SHALL 在设置页新增「更新」分区，位于「模型」分区之后。

#### Scenario: 频道选择
- **WHEN** 用户切换频道（nightly / release）
- **THEN** `updateChannel` 持久化到 settings.json，下次检查按新频道执行

#### Scenario: 自动检查开关
- **WHEN** 用户切换「自动检查更新」开关
- **THEN** `autoCheckUpdates` 持久化；关闭后启动时不再自动检查

#### Scenario: 手动检查
- **WHEN** 用户点击「立即检查更新」按钮
- **THEN** 按当前频道执行检查，按钮显示 loading 状态
- **AND** 检查完成后内联展示「当前版本 / 最新版本 / 上次检查时间」
- **AND** 若发现更新且未被跳过/禁用，同时打开更新提示窗口

#### Scenario: 重新启用提醒
- **WHEN** `dontRemindAppUpdates === true` 时设置页显示「重新启用更新提醒」按钮
- **THEN** 点击后重置 `dontRemindAppUpdates=false` 与 `skippedAppVersion=null`

### Requirement: 启动时自动检查
系统 SHALL 在主窗口就绪后后台触发一次自动检查。

#### Scenario: 正常启动
- **WHEN** 应用启动、`autoCheckUpdates=true`、非 dev 模式、距 `lastUpdateCheckTime` 超过 24 小时（或从未检查）
- **THEN** 后台执行检查；若发现更新且未被跳过/禁用，打开更新提示窗口
- **AND** 无论结果如何，更新 `lastUpdateCheckTime` 为当前时间

#### Scenario: 最近已检查
- **WHEN** 距 `lastUpdateCheckTime` 不足 24 小时
- **THEN** 启动时跳过自动检查（手动检查仍可用）

#### Scenario: dev 模式
- **WHEN** `app.isPackaged === false`
- **THEN** 启动时跳过自动检查（避免开发时频繁请求 GitHub API）；手动检查仍可用

#### Scenario: 被禁用
- **WHEN** `autoCheckUpdates=false` 或 `dontRemindAppUpdates=true`
- **THEN** 启动时跳过自动检查

### Requirement: 安全与 CSP
系统 SHALL 通过主进程 Node.js `https` 模块发起 GitHub API 请求，不放宽渲染进程 CSP。

#### Scenario: 主进程发起请求
- **WHEN** 执行应用更新检查
- **THEN** 请求在主进程发起（`https.request`），渲染进程仅通过 IPC 获取结果
- **AND** `connect-src` CSP 无需修改；GitHub API 域名不加入渲染进程白名单

#### Scenario: 外链打开
- **WHEN** 用户点击「立即更新」打开 GitHub 下载链接
- **THEN** 复用现有 `model-download:open-external` 白名单机制（`https://henley04.github.io/SXSEditor/`）并扩展允许 `https://github.com/Henley04/SXSEditor/` 前缀
- **AND** 通过 `shell.openExternal` 打开

## MODIFIED Requirements

### Requirement: 设置项持久化
`src/main/settings.js` 的 `ALLOWED_SETTINGS_KEYS` 与 `loadSettings` 默认值 SHALL 新增以下键：
- `updateChannel`：`'nightly' | 'release'`，默认 `'release'`
- `autoCheckUpdates`：boolean，默认 `true`
- `skippedAppVersion`：string | null，默认 `null`
- `dontRemindAppUpdates`：boolean，默认 `false`
- `lastUpdateCheckTime`：ISO8601 string | null，默认 `null`

`loadSettings` SHALL 对这些键做类型校正与默认值回填（与现有 `vocoderType` 等键一致的模式）。
