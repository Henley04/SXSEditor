#!/usr/bin/env node
'use strict';
// Generates docs/dev/mcp.html (bilingual) from src/shared/mcpSchema.js.
// Run: npm run mcp:docs (regenerates docs/MCP.md and this page together)
const fs = require('node:fs');
const path = require('node:path');
const { schema, VERSION } = require('../src/shared/mcpSchema');
const { CODES } = require('../src/main/mcpErrors');

const out = path.join(__dirname, '..', 'docs', 'dev', 'mcp.html');

// ---------------------------------------------------------------------------
// Bilingual copy (zh side is authored here; en side comes from the schema)
// ---------------------------------------------------------------------------
const GROUP_ORDER = [
  'schema', 'capabilities', 'session', 'ui', 'jobs', 'project', 'midi',
  'audio', 'accompaniment', 'singer', 'history', 'fragment', 'editor',
  'playback', 'lrc', 'settings',
];
const GROUP_TITLES = {
  schema: { en: 'Schema & Capabilities', zh: '架构与能力' },
  capabilities: { en: 'Schema & Capabilities', zh: '架构与能力' },
  session: { en: 'Session & File Access', zh: '会话与文件访问' },
  ui: { en: 'Windows & UI', zh: '窗口与界面' },
  jobs: { en: 'Jobs', zh: '后台任务' },
  project: { en: 'Project', zh: '项目' },
  midi: { en: 'MIDI', zh: 'MIDI' },
  audio: { en: 'Audio', zh: '音频' },
  accompaniment: { en: 'Accompaniment', zh: '伴奏' },
  singer: { en: 'Singers', zh: '歌手' },
  history: { en: 'History', zh: '编辑历史' },
  fragment: { en: 'Fragments', zh: '片段' },
  editor: { en: 'Editor', zh: '编辑器' },
  playback: { en: 'Playback', zh: '播放' },
  lrc: { en: 'Lyrics (LRC)', zh: '歌词（LRC）' },
  settings: { en: 'Settings', zh: '设置' },
};

const METHOD_ZH = {
  'schema.get': { summary: '返回本方法表（与 GET /schema 相同载荷）。' },
  'capabilities': { summary: '方法列表外加运行时特性与前提条件。' },
  'session.grantRoot': {
    summary: '授予自动化会话对某目录树的读写权限。',
    desc: '目录会经过校验（拒绝系统 / 敏感 / 隐藏路径），并加入文件对话框使用的同一内存允许列表。授权持续到应用退出或调用 session.revokeRoots 为止。',
  },
  'session.roots': { summary: '列出本会话已授权的目录。' },
  'session.revokeRoots': { summary: '撤销会话目录授权（省略 path 时撤销全部）。' },
  'ui.windows': { summary: '列出应用窗口（id、标题、url 与边界）。' },
  'ui.resize': { summary: '调整窗口大小（内容尺寸）。' },
  'ui.reload': { summary: '重新加载窗口渲染进程。' },
  'ui.locale': { summary: '切换应用语言并重载所有窗口。' },
  'ui.screenshot': {
    summary: '以指定 CSS 尺寸与设备缩放捕获窗口。',
    desc: '使用 DevTools 协议，因此即使物理显示器不是高 DPI，也可捕获 2 倍图。不带 path 时以 base64 返回 PNG。',
  },
  'ui.open': { summary: '打开次级窗口（歌手创建、市场、模型下载等）。' },
  'jobs.list': { summary: '列出自动化任务（最新在前）。' },
  'jobs.get': { summary: '按 id 获取单个任务。' },
  'jobs.cancel': { summary: '取消排队中的任务；运行中的任务会报告无法停止。' },
  'project.get': { summary: '读取当前项目快照。' },
  'project.validate': { summary: '校验项目文档，不影响当前打开的项目。' },
  'project.apply': {
    summary: '原子地应用一批操作。',
    desc: '所有操作先校验。atomic=true（默认）时，失败会回滚到调用前快照，并返回失败操作的序号。',
  },
  'project.replace': { summary: '替换整个项目文档。' },
  'project.saveTo': { summary: '将项目序列化为 .sxsproj 文件。' },
  'project.loadFrom': { summary: '打开 .sxsproj 文件到编辑器。' },
  'project.save': { summary: '保存到当前路径（对话框回退）。' },
  'project.saveAs': { summary: '经原生对话框保存并返回所选路径。' },
  'project.load': { summary: '经原生对话框打开项目。' },
  'midi.importFile': { summary: '导入 .mid 文件为轨道与片段。' },
  'audio.extractMidi': { summary: '对音频文件运行 F0 / MIDI 提取。' },
  'accompaniment.import': { summary: '从音频文件添加伴奏轨道。' },
  'singer.import': { summary: '导入 .sxssinger 音色档案。' },
  'history.undo': { summary: '撤销上一次项目编辑。' },
  'history.redo': { summary: '重做上一次撤销的编辑。' },
  'fragment.open': { summary: '在钢琴卷帘编辑器窗口中打开片段。' },
  'fragment.exportTo': { summary: '合成单个片段并写出 WAV。' },
  'editor.getView': { summary: '读取编辑器视图状态（缩放、滚动、模式、选择）。' },
  'editor.setView': { summary: '设置编辑器缩放、滚动、编辑模式与音符选择。' },
  'playback.play': { summary: '合成并播放项目。' },
  'playback.pause': { summary: '暂停播放。' },
  'playback.stop': { summary: '停止播放。' },
  'playback.seek': { summary: '跳转到指定秒数位置。' },
  'playback.get': { summary: '播放状态（位置、时长、合成中）。' },
  'audio.export': { summary: '通过 GUI 对话框导出。' },
  'audio.exportTo': { summary: '合成整个项目并写出 WAV。' },
  'lrc.export': { summary: '通过 GUI 对话框导出歌词。' },
  'lrc.exportTo': { summary: '写出 .lrc 文件。' },
  'settings.get': { summary: '读取设置对象。' },
  'settings.update': { summary: '修补设置并返回结果。' },
};

const PARAM_ZH = {
  'session.grantRoot\u0000path': '目录绝对路径',
  'session.revokeRoots\u0000path': '要撤销的目录',
  'ui.resize\u0000window': '窗口 id、url 子串或标题子串（默认：主窗口）',
  'ui.resize\u0000width': '内容宽度（CSS px）',
  'ui.resize\u0000height': '内容高度（CSS px）',
  'ui.reload\u0000window': '窗口选择器（默认：主窗口）',
  'ui.locale\u0000locale': '目标语言',
  'ui.screenshot\u0000window': '窗口选择器（默认：主窗口）',
  'ui.screenshot\u0000width': '要模拟的 CSS 宽度',
  'ui.screenshot\u0000height': '要模拟的 CSS 高度',
  'ui.screenshot\u0000scale': '设备缩放因子（默认 2）',
  'ui.screenshot\u0000path': '保存 PNG 到此路径，而非返回 base64',
  'ui.screenshot\u0000keepSize': '保持窗口当前尺寸（默认：调整、捕获、恢复）',
  'ui.open\u0000precision': 'modelDownload 的模型精度',
  'jobs.get\u0000jobId': '任务 id',
  'jobs.cancel\u0000jobId': '任务 id',
  'project.get\u0000includeNotes': '包含片段音符（默认 true）',
  'project.get\u0000noteOffset': '每个片段跳过的音符数',
  'project.get\u0000noteLimit': '每个片段最多返回的音符数',
  'project.get\u0000fields': '要包含的顶层字段：project、singers、fragments、selection、filePath、isDirty',
  'project.apply\u0000dryRun': '校验并报告将发生的变化，不做修改',
  'project.apply\u0000atomic': '失败时回滚（默认 true）',
  'project.replace\u0000dryRun': '仅校验',
  'project.saveTo\u0000path': '目标路径',
  'project.saveTo\u0000embedSingerFiles': '将歌手数据嵌入项目内',
  'project.saveTo\u0000embedAccompanimentAudio': '嵌入伴奏音频',
  'project.loadFrom\u0000path': '项目文件路径',
  'midi.importFile\u0000path': 'MIDI 文件路径',
  'midi.importFile\u0000name': '轨道名覆盖',
  'midi.importFile\u0000multiTrack': '每个 MIDI 轨道创建一个轨道（默认 true）',
  'midi.importFile\u0000createTracks': '创建新轨道而非复用 singerId（默认 true）',
  'midi.importFile\u0000singerId': '用于放置音符的现有歌手',
  'midi.importFile\u0000startTime': '第一个片段的起始位置（拍）',
  'midi.importFile\u0000applyProjectInfo': '应用 MIDI 文件中的速度 / 拍号（默认 true）',
  'audio.extractMidi\u0000path': '音频文件路径',
  'audio.extractMidi\u0000bpm': '用于拍号换算的速度',
  'audio.extractMidi\u0000withPitch': '同时返回 F0 曲线（默认 true）',
  'accompaniment.import\u0000path': '音频文件路径',
  'accompaniment.import\u0000name': '轨道名',
  'accompaniment.import\u0000startTime': '起始偏移（秒）',
  'accompaniment.import\u0000volume': '轨道音量 0-1',
  'singer.import\u0000path': '歌手文件路径',
  'fragment.open\u0000fragmentId': '片段 id',
  'fragment.exportTo\u0000fragmentId': '片段 id',
  'fragment.exportTo\u0000path': '目标 WAV 路径',
  'fragment.exportTo\u0000options': '推理参数覆盖（nSteps、cfg、sampler、sampleRate 等）',
  'editor.setView\u0000zoomX': '水平缩放因子 0.25-8',
  'editor.setView\u0000scrollBeats': '滚动到指定拍位于左边缘',
  'editor.setView\u0000scrollY': '垂直滚动（px）',
  'editor.setView\u0000mode': '顶部编辑模式',
  'editor.setView\u0000paramLane': '底部参数通道',
  'editor.setView\u0000selectedNoteIds': '替换音符选择',
  'playback.seek\u0000seconds': '目标位置',
  'audio.exportTo\u0000path': '目标 WAV 路径',
  'audio.exportTo\u0000options': 'sampleRate / numChannels / 推理参数覆盖',
  'lrc.exportTo\u0000path': '目标路径',
  'settings.update\u0000settings': '设置补丁',
};

const CODE_MEANINGS = {
  VALIDATION_ERROR: { en: 'params failed JSON Schema validation (see `field` / `details.errors`)', zh: '参数未通过 JSON Schema 校验（见 `field` / `details.errors`）' },
  UNKNOWN_METHOD: { en: 'method not in the schema (hint: `see GET /schema`)', zh: '方法不在架构中（提示：`see GET /schema`）' },
  NOT_FOUND: { en: 'referenced job, file, fragment or singer does not exist', zh: '引用的任务、文件、片段或歌手不存在' },
  CONFLICT: { en: 'state conflict with the current project / job', zh: '与当前项目 / 任务状态冲突' },
  PRECONDITION_FAILED: { en: 'inference models not installed, or no project window open', zh: '推理模型未安装，或没有打开的项目窗口' },
  FORBIDDEN: { en: 'non-loopback client, system path, or path outside granted roots', zh: '非回环客户端、系统路径，或授权根目录之外的路径' },
  UNAUTHORIZED: { en: 'missing or invalid Bearer token', zh: '缺少或无效的 Bearer token' },
  RATE_LIMITED: { en: 'too many requests (see `retry` hint)', zh: '请求过多（见 `retry` 提示）' },
  TIMEOUT: { en: 'automation call exceeded its timeout', zh: '自动化调用超时' },
  CANCELLED: { en: 'job was cancelled', zh: '任务已取消' },
  INTERNAL: { en: 'unexpected error', zh: '意外错误' },
};

const ENDPOINTS = [
  { method: 'GET', path: '/health', en: 'Liveness, app + schema version (Bearer token still required)', zh: '存活探针，应用 + 架构版本（仍需 Bearer token）' },
  { method: 'GET', path: '/schema', en: 'Method table with JSON Schema', zh: '带 JSON Schema 的方法表' },
  { method: 'GET', path: '/events', en: 'Server-sent events (`?token=` allowed, EventSource cannot set headers)', zh: '服务器推送事件（允许 `?token=`，EventSource 无法设置请求头）' },
  { method: 'GET', path: '/jobs, /jobs/:id', en: 'Background job status', zh: '后台任务状态' },
  { method: 'POST', path: '/automation', en: '`{method, params, requestId?, async?}`', zh: '`{method, params, requestId?, async?}`' },
];

// ---------------------------------------------------------------------------
// Schema helpers (mirrors scripts/gen-mcp-docs.js)
// ---------------------------------------------------------------------------
function typeOf(s) {
  if (!s) return 'any';
  if (s.enum) return s.enum.map((v) => `\`${v}\``).join(' | ');
  if (s.type === 'array') return `${typeOf(s.items)}[]`;
  if (s.type === 'object' && s.properties) return 'object';
  return s.type || 'any';
}

function paramEntries(params) {
  const props = (params && params.properties) || {};
  const required = new Set((params && params.required) || []);
  return Object.entries(props).map(([name, s]) => ({ name, s, required: required.has(name) }));
}

function example(name, def) {
  const p = (def.params && def.params.properties) || {};
  const args = {};
  for (const [key, s] of Object.entries(p)) {
    if (s.type === 'string') args[key] = s.enum ? s.enum[0] : `\${${key}}`;
    else if (s.type === 'number' || s.type === 'integer') args[key] = 1;
    else if (s.type === 'boolean') args[key] = true;
    else if (s.type === 'array') args[key] = [];
    else if (s.type === 'object') args[key] = {};
  }
  return JSON.stringify({ method: name, params: args }, null, 2);
}

// ---------------------------------------------------------------------------
// HTML emission
// ---------------------------------------------------------------------------
function esc(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function code(text) { return `<code>${esc(text)}</code>`; }

function bi(en, zh) {
  return `<span data-lang="en">${en}</span><span data-lang="zh">${zh}</span>`;
}

function biP(en, zh, cls) {
  return `<p${cls ? ` class="${cls}"` : ''} data-lang="en">${en}</p>\n      <p${cls ? ` class="${cls}"` : ''} data-lang="zh">${zh}</p>`;
}

function biPre(codeText) {
  return `<pre><code>${esc(codeText)}</code></pre>`;
}

const L = [];
L.push(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Automation API (MCP) — SXSEditor Developer Docs</title>
  <link rel="icon" href="../images/icon.png" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="../css/style.css" />
</head>
<body>

  <header class="site-header">
    <div class="site-header-inner">
      <a class="brand" href="../index.html">
        <img src="../images/icon.png" alt="SXSEditor" class="brand-logo" />
        <span class="brand-name" data-i18n="brand.name">SXSEditor</span>
      </a>
      <nav class="header-nav" data-header-nav>
        <a class="nav-link" href="../index.html" data-i18n="nav.home">Home</a>
        <a class="nav-link" href="../user/quick-start.html" data-i18n="nav.user">User Guide</a>
        <a class="nav-link" href="build.html" data-i18n="nav.dev">Developer Guide</a>
        <a class="nav-link" href="https://github.com/Henley04/SXSEditor" target="_blank" rel="noopener">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .5C5.7.5.5 5.7.5 12c0 5.1 3.3 9.4 7.9 10.9.6.1.8-.2.8-.5v-2c-3.2.7-3.9-1.4-3.9-1.4-.5-1.3-1.3-1.7-1.3-1.7-1.1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.8 1.8 1.8.9 0 1.6-.6 1.9-1.2-2.5-.3-5.2-1.3-5.2-5.8 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.3 1.2 0 0 2.2-.3 4.6 1.3.9-1.4 2.2-1.9 3.4-1.9 1.2 0 2.6.5 3.4 1.9 2.5-1.7 4.6-1.3 4.6-1.3 2.3 1.8 1.2 2.8 1.2 3.1 0 4.6-2.6 5.5-5.2 5.8.4.4.8 1.1.8 2.2v3.3c0 .6.2.7.8.5 4.6-1.5 7.9-5.7 7.9-10.9C23.5 5.7 18.3.5 12 .5z"/></svg>
          <span data-i18n="nav.github">GitHub</span>
        </a>
      </nav>
      <div class="header-actions">
        <div class="lang-switcher" role="group" aria-label="Language">
          <button class="lang-btn" data-lang-btn="en" type="button">EN</button>
          <button class="lang-btn" data-lang-btn="zh" type="button">中文</button>
        </div>
        <button class="theme-toggle" data-theme-toggle type="button" aria-label="Toggle theme">
          <svg class="icon-moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>
          <svg class="icon-sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>
        </button>
        <button class="menu-btn" data-menu-btn type="button" aria-label="Open menu">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12h18M3 6h18M3 18h18"/></svg>
        </button>
      </div>
    </div>
  </header>

  <div class="docs-layout">
    <aside class="docs-sidebar scrollbar-thin" data-nav-section="dev"></aside>

    <main class="prose">
      <nav class="breadcrumb">
        <a href="../index.html" data-i18n="nav.home">Home</a>
        <span class="sep">/</span>
        <a href="build.html" data-i18n="sidebar.dev">Developer Guide</a>
        <span class="sep">/</span>
        <span data-lang="en">Automation API (MCP)</span><span data-lang="zh">自动化 API（MCP）</span>
      </nav>

      <h1>
        <span data-lang="en">Automation API (MCP)</span>
        <span data-lang="zh">自动化 API（MCP）</span>
      </h1>
`);

L.push(biP(
  'SXSEditor exposes a loopback HTTP bridge so agents and scripts can drive the editor. The stdio MCP server (<code>npm run mcp</code>) wraps the same API; both share one schema.',
  'SXSEditor 暴露一个回环 HTTP 桥，使智能体与脚本可以驱动编辑器。stdio MCP 服务器（<code>npm run mcp</code>）包装同一套 API；两者共用同一份架构。',
));
L.push(`
      <div class="callout note">
        <div class="callout-icon">ℹ️</div>
        <div class="callout-body">
          <p data-lang="en">Schema version <strong>${esc(VERSION)}</strong> — this page is generated from <code>src/shared/mcpSchema.js</code> by <code>npm run mcp:docs</code>, together with the raw Markdown reference <code>docs/MCP.md</code>. Do not edit by hand. Source files: <code>src/main/mcpBridge.js</code> (HTTP bridge), <code>src/main/mcpErrors.js</code> (error codes), <code>src/main/mcpJobs.js</code> (background jobs), <code>src/main/mcpValidate.js</code> (schema validation), <code>src/main/mcpWindowOps.js</code> (window operations), <code>scripts/sxseditor-mcp.js</code> (stdio server).</p>
          <p data-lang="zh">架构版本 <strong>${esc(VERSION)}</strong>——本页由 <code>npm run mcp:docs</code> 从 <code>src/shared/mcpSchema.js</code> 生成，同时产出原始 Markdown 参考 <code>docs/MCP.md</code>。请勿手工编辑。相关源文件：<code>src/main/mcpBridge.js</code>（HTTP 桥）、<code>src/main/mcpErrors.js</code>（错误码）、<code>src/main/mcpJobs.js</code>（后台任务）、<code>src/main/mcpValidate.js</code>（架构校验）、<code>src/main/mcpWindowOps.js</code>（窗口操作）、<code>scripts/sxseditor-mcp.js</code>（stdio 服务器）。</p>
        </div>
      </div>
`);

// ---- Endpoints -------------------------------------------------------------
L.push(`
      <h2>
        <span data-lang="en">Endpoints</span>
        <span data-lang="zh">端点</span>
      </h2>
      <table class="doc-table">
        <thead>
          <tr>
            <th><span data-lang="en">Method</span><span data-lang="zh">方法</span></th>
            <th><span data-lang="en">Path</span><span data-lang="zh">路径</span></th>
            <th><span data-lang="en">Purpose</span><span data-lang="zh">用途</span></th>
          </tr>
        </thead>
        <tbody>
`);
for (const ep of ENDPOINTS) {
  L.push(`          <tr>
            <td><code>${esc(ep.method)}</code></td>
            <td><code>${esc(ep.path)}</code></td>
            <td>${bi(ep.en, ep.zh)}</td>
          </tr>
`);
}
L.push(`        </tbody>
      </table>
`);
L.push(biP(
  'The bridge listens on <code>127.0.0.1</code> only — non-loopback clients are rejected with <code>FORBIDDEN</code>. Discovery file: <code>&lt;userData&gt;/mcp-endpoint.json</code> (mode <code>0600</code>) with <code>port</code>, <code>token</code> (the default token only), <code>pid</code>, <code>version</code>, <code>schemaVersion</code>, and <code>urls</code>. Named tokens stay in <code>&lt;userData&gt;/mcp-tokens.json</code> — readers of the discovery file cannot impersonate every configured client. <code>&lt;userData&gt;</code> is <code>%APPDATA%/SXSEditor</code> on Windows and <code>~/.config/SXSEditor</code> on Linux.',
  '桥仅监听 <code>127.0.0.1</code>——非回环客户端会被 <code>FORBIDDEN</code> 拒绝。发现文件：<code>&lt;userData&gt;/mcp-endpoint.json</code>（权限 <code>0600</code>），含 <code>port</code>、<code>token</code>（仅默认 token）、<code>pid</code>、<code>version</code>、<code>schemaVersion</code> 与 <code>urls</code>。命名 token 保存在 <code>&lt;userData&gt;/mcp-tokens.json</code>——发现文件的读取者无法冒充每个已配置的客户端。<code>&lt;userData&gt;</code> 在 Windows 上为 <code>%APPDATA%/SXSEditor</code>，Linux 上为 <code>~/.config/SXSEditor</code>。',
));

// ---- Calling ---------------------------------------------------------------
L.push(`
      <h2>
        <span data-lang="en">Calling</span>
        <span data-lang="zh">调用</span>
      </h2>
`);
L.push(biPre(`EP=$(node -p "require(process.env.HOME+'/.config/SXSEditor/mcp-endpoint.json').port")
TOKEN=$(node -p "require(process.env.HOME+'/.config/SXSEditor/mcp-endpoint.json').token")
curl -s localhost:$EP/automation -H "Authorization: Bearer $TOKEN" \\
  -H "content-type: application/json" \\
  -d '{"method":"project.get","params":{"includeNotes":false}}'`));
L.push(biP(
  'Every response is <code>{ok, result, warnings?, requestId?}</code> or <code>{ok:false, error:{code, message, field?, hint?, details?}}</code>.',
  '每个响应都是 <code>{ok, result, warnings?, requestId?}</code> 或 <code>{ok:false, error:{code, message, field?, hint?, details?}}</code>。',
));
L.push(`
      <div class="callout note">
        <div class="callout-icon">ℹ️</div>
        <div class="callout-body">
          <p data-lang="en"><strong>Limits.</strong> Rate limit is 120 requests per 10-second window (<code>RATE_LIMITED</code> with a <code>retry</code> hint). Request bodies are capped at 32 MiB. A synchronous call times out after 60 s (<code>TIMEOUT</code>); long methods get 600 s.</p>
          <p data-lang="zh"><strong>限额。</strong>限速为每 10 秒窗口 120 次请求（超限返回 <code>RATE_LIMITED</code> 并带 <code>retry</code> 提示）。请求体上限 32 MiB。同步调用 60 秒超时（<code>TIMEOUT</code>）；长时方法为 600 秒。</p>
        </div>
      </div>
`);

// ---- Errors ----------------------------------------------------------------
L.push(`
      <h2>
        <span data-lang="en">Errors</span>
        <span data-lang="zh">错误</span>
      </h2>
      <table class="doc-table">
        <thead>
          <tr>
            <th><span data-lang="en">Code</span><span data-lang="zh">错误码</span></th>
            <th><span data-lang="en">HTTP</span><span data-lang="zh">HTTP</span></th>
            <th><span data-lang="en">Meaning</span><span data-lang="zh">含义</span></th>
          </tr>
        </thead>
        <tbody>
`);
for (const [code, status] of Object.entries(CODES)) {
  const m = CODE_MEANINGS[code] || { en: '—', zh: '—' };
  L.push(`          <tr>
            <td><code>${esc(code)}</code></td>
            <td>${esc(status)}</td>
            <td>${bi(esc(m.en), esc(m.zh))}</td>
          </tr>
`);
}
L.push(`        </tbody>
      </table>
`);

// ---- Events ----------------------------------------------------------------
L.push(`
      <h2>
        <span data-lang="en">Events</span>
        <span data-lang="zh">事件</span>
      </h2>
`);
L.push(biP(
  '<code>/events</code> streams <code>event: &lt;type&gt;</code> frames. Current types: <code>bridge.started</code>, <code>project.changed</code>, <code>project.saved</code>, <code>fragment.opened</code>, <code>playback.state</code>, <code>ui.opened</code>, <code>job.started</code>, <code>job.completed</code>, <code>job.failed</code>.',
  '<code>/events</code> 推送 <code>event: &lt;type&gt;</code> 帧。当前类型：<code>bridge.started</code>、<code>project.changed</code>、<code>project.saved</code>、<code>fragment.opened</code>、<code>playback.state</code>、<code>ui.opened</code>、<code>job.started</code>、<code>job.completed</code>、<code>job.failed</code>。',
));

// ---- Jobs ------------------------------------------------------------------
L.push(`
      <h2>
        <span data-lang="en">Jobs</span>
        <span data-lang="zh">后台任务</span>
      </h2>
`);
L.push(biP(
  'Add <code>"async": true</code> to <code>POST /automation</code> for long methods (export, synthesis, MIDI extraction). The call returns <code>202 {jobId, poll}</code>; poll <code>GET /jobs/&lt;id&gt;</code> for <code>status</code> (<code>queued</code> → <code>running</code> → <code>completed</code> / <code>failed</code> / <code>cancelled</code>) plus <code>result</code> or <code>error</code>.',
  '对长时方法（导出、合成、MIDI 提取）在 <code>POST /automation</code> 中加 <code>"async": true</code>。调用返回 <code>202 {jobId, poll}</code>；轮询 <code>GET /jobs/&lt;id&gt;</code> 获取 <code>status</code>（<code>queued</code> → <code>running</code> → <code>completed</code> / <code>failed</code> / <code>cancelled</code>）以及 <code>result</code> 或 <code>error</code>。',
));

// ---- Method reference ------------------------------------------------------
const methods = schema().methods;
const grouped = {};
for (const [name, def] of Object.entries(methods)) {
  const g = GROUP_ORDER.includes(name.split('.')[0]) ? name.split('.')[0] : 'schema';
  (grouped[g] = grouped[g] || []).push([name, def]);
}

L.push(`
      <h2>
        <span data-lang="en">Method Reference</span>
        <span data-lang="zh">方法参考</span>
      </h2>
`);
L.push(biP(
  `All ${Object.keys(methods).length} methods, grouped by area. Parameters are flat: the document for <code>project.replace</code> goes directly under <code>params.project</code>.`,
  `全部 ${Object.keys(methods).length} 个方法，按领域分组。参数是扁平的：<code>project.replace</code> 的文档直接放在 <code>params.project</code> 下。`,
));

for (const g of GROUP_ORDER) {
  const entries = grouped[g];
  if (!entries || !entries.length) continue;
  const title = GROUP_TITLES[g] || { en: g, zh: g };
  L.push(`
      <h3>
        <span data-lang="en">${esc(title.en)}</span>
        <span data-lang="zh">${esc(title.zh)}</span>
      </h3>
`);
  for (const [name, def] of entries) {
    const zh = METHOD_ZH[name] || { summary: def.summary };
    L.push(`
      <h4><code>${esc(name)}</code></h4>
`);
    L.push(`      ${biP(def.summary, zh.summary).trim()}
`);
    if (def.description && zh.desc) {
      L.push(`      ${biP(def.description, zh.desc).trim()}
`);
    }
    const metaEn = [`target: <code>${esc(def.target)}</code>`];
    const metaZh = [`目标：<code>${esc(def.target)}</code>`];
    if (def.mutates) { metaEn.push('mutates project'); metaZh.push('修改项目'); }
    if (def.long) { metaEn.push('long-running (job-able)'); metaZh.push('长时运行（可异步）'); }
    if (def.requires && def.requires.length) {
      metaEn.push(`requires: ${def.requires.map((r) => `<code>${esc(r)}</code>`).join(', ')}`);
      metaZh.push(`依赖：${def.requires.map((r) => `<code>${esc(r)}</code>`).join(', ')}`);
    }
    L.push(`      <p><em>${bi(metaEn.join(' · '), metaZh.join(' · '))}</em></p>
`);
    const params = paramEntries(def.params);
    if (!params.length) {
      L.push(`      ${biP('<em>No parameters.</em>', '<em>无参数。</em>').trim()}
`);
    } else {
      L.push(`      <table class="doc-table">
        <thead>
          <tr>
            <th><span data-lang="en">Parameter</span><span data-lang="zh">参数</span></th>
            <th><span data-lang="en">Type / notes</span><span data-lang="zh">类型 / 说明</span></th>
          </tr>
        </thead>
        <tbody>
`);
      for (const { name: pName, s, required } of params) {
        const type = typeOf(s);
        const reqEn = required ? 'required' : 'optional';
        const reqZh = required ? '必填' : '可选';
        const noteEn = s.description || '';
        const noteZh = PARAM_ZH[`${name}\u0000${pName}`] || '';
        const rangeEn = (s.minimum !== undefined || s.maximum !== undefined)
          ? `range ${s.minimum !== undefined ? s.minimum : '-∞'}..${s.maximum !== undefined ? s.maximum : '∞'}`
          : '';
        const bitsEn = [type, reqEn, noteEn, rangeEn].filter(Boolean).join(' · ');
        const bitsZh = [type, reqZh, noteZh, rangeEn ? `范围 ${rangeEn.replace('range ', '')}` : ''].filter(Boolean).join(' · ');
        L.push(`          <tr>
            <td><code>${esc(pName)}</code></td>
            <td>${bi(esc(bitsEn), esc(bitsZh))}</td>
          </tr>
`);
      }
      L.push(`        </tbody>
      </table>
`);
    }
    if (def.aliases && Object.keys(def.aliases).length) {
      const list = Object.entries(def.aliases).map(([from, to]) => `<code>${esc(from)}</code> → <code>${esc(to)}</code>`).join(', ');
      L.push(`      <p><em>${bi(`Legacy aliases: ${list} (accepted with a deprecation warning).`, `旧别名：${list}（接受，但会发出弃用警告）。`)}</em></p>
`);
    }
    L.push(`      ${biPre(example(name, def))}
`);
  }
}

// ---- Notes -----------------------------------------------------------------
L.push(`
      <h2>
        <span data-lang="en">Notes</span>
        <span data-lang="zh">备注</span>
      </h2>
      <ul>
        <li>${bi('File paths must be inside a directory granted with <code>session.grantRoot</code> (or one of the app\'s default save roots). Grants are session-scoped and disappear on exit. The renderer additionally self-authorizes individually whitelisted media/project files (<code>.wav</code>, <code>.sxssinger</code>, <code>.sxsproj</code>, <code>.mid</code>, <code>.lrc</code>) through the same path rules as the dialogs.', '文件路径必须位于用 <code>session.grantRoot</code> 授权的目录内（或应用默认保存根目录之一）。授权随会话生效，退出即失效。渲染进程另外会通过对话框相同的路径规则，自行放行个别白名单媒体 / 项目文件（<code>.wav</code>、<code>.sxssinger</code>、<code>.sxsproj</code>、<code>.mid</code>、<code>.lrc</code>）。')}</li>
        <li>${bi('<code>project.apply</code> validates every operation before mutating and rolls back on failure (<code>atomic: false</code> opts out). <code>dryRun: true</code> returns the plan without touching state.', '<code>project.apply</code> 会在修改前校验每个操作，失败即回滚（<code>atomic: false</code> 可退出回滚）。<code>dryRun: true</code> 只返回计划，不触碰状态。')}</li>
        <li>${bi('Note ids are derived from note content, so identical payloads produce identical ids.', '音符 id 由音符内容派生，因此相同的载荷会产生相同的 id。')}</li>
      </ul>

      <nav class="doc-pager">
        <a href="plugins.html"><div class="pager-card"><div class="pager-label" data-i18n="pager.prev">Previous</div><div class="pager-title"><span data-lang="en">Plugin Backends</span><span data-lang="zh">插件后端</span></div></div></a>
        <a href="themes.html" class="next"><div class="pager-card"><div class="pager-label" data-i18n="pager.next">Next</div><div class="pager-title"><span data-lang="en">Themes &amp; UI</span><span data-lang="zh">主题与界面</span></div></div></a>
      </nav>
    </main>

    <aside class="docs-toc scrollbar-thin">
      <div class="toc-title" data-i18n="toc.title">On this page</div>
      <div data-toc></div>
    </aside>
  </div>

  <footer class="site-footer">
    <div class="footer-inner">
      <div class="footer-links">
        <a href="../index.html" data-i18n="footer.docs">Documentation</a>
        <a href="../user/faq.html" data-i18n="footer.help">Help &amp; FAQ</a>
        <a href="https://github.com/Henley04/SXSEditor" target="_blank" rel="noopener" data-i18n="footer.github">GitHub Repository</a>
        <a href="https://gitcode.com/qq_50331623/SXSEditor" target="_blank" rel="noopener" data-i18n="footer.gitcode">GitCode Mirror</a>
        <a href="https://github.com/Henley04/SXSEditor/issues" target="_blank" rel="noopener" data-i18n="footer.issues">Issue Tracker</a>
      </div>
      <div class="footer-copy" data-i18n="footer.copy">© 2026 SXSEditor. MIT License.</div>
    </div>
  </footer>

  <button class="back-to-top" data-back-to-top type="button" aria-label="Back to top">
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 15l-6-6-6 6"/></svg>
  </button>

  <script src="../js/i18n.js"></script>
  <script src="../js/docs-nav.js"></script>
  <script src="../js/layout.js"></script>
</body>
</html>`);

fs.writeFileSync(out, L.join(''));
console.log(`wrote ${path.relative(process.cwd(), out)} (${Object.keys(methods).length} methods)`);
