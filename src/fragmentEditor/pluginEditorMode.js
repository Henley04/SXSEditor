/**
 * 插件定义的轨道形态（trackKind.editor）落到内置分片编辑器上。
 *
 * 契约侧（src/shared/pluginContract.js）给出三种编辑器模式：
 *   · 'midi'          → 整块复用内置 MIDI 分片编辑器（全部子面板）；
 *   · 'midi-partial'  → 只复用 editor.use 里列出的子面板，editor.hide 优先（可减法）；
 *   · 'plugin'        → 插件自带面板，内置编辑器整体退居占位。
 * 未声明 editor / 内置后端（sxs）→ 全开且可编辑，与历史行为完全一致。
 *
 * 本文件被刻意拆成两层：
 *   1. resolveEditorLayout() 是**纯函数**（不碰 DOM、不 import 任何 DOM 侧模块），
 *      因此可以被 node 直接 import 做穷举断言（见实现报告里的验证脚本）；
 *   2. applyEditorLayout() 才碰 DOM，且它依赖的 state/uiControls/canvasRenderer
 *      全部走 dynamic import —— 顶层 import 会拉进 canvasRenderer 的
 *      `document.getElementById('piano-keys')`，那样就没法在裸 node 里测了。
 *
 * 作者备注：这里所有插件提供的字符串（kind.name / kind.description）一律
 * 用 textContent 写入，绝不拼 innerHTML。
 */

import { MIDI_EDITOR_PANELS, TRACK_EDITOR_MODES, isBuiltinBackend } from '../shared/pluginContract.js';
import { t } from '../i18n/index.js';

/** 隐藏某个节点时挂的 class（配合 fragmentEditor.css 的 display:none !important）。 */
export const PANEL_OFF_CLASS = 'plugin-panel-off';

/** 主画布整块关闭时给 #app 挂的 class，用于修正 #main-content 的 grid 排布。 */
export const NO_PIANOROLL_CLASS = 'plugin-no-pianoroll';

/** readOnly 时给 #app 挂的 class。 */
export const READONLY_CLASS = 'plugin-readonly';

/**
 * 契约里的面板名 → 分片编辑器里的真实 DOM 选择器。
 * 隐藏一律用 class（不从 DOM 删除），避免其它模块持有的节点引用失效。
 */
export const PANEL_NODES = Object.freeze({
  // 钢琴卷帘：左键拖动/框选/双击改歌词全在这块画布上
  pianoRoll: ['#left-sidebar', '#right-content', '#btn-param-MIDI'],
  // 音高曲线：工具栏的 Pitch 切页 + Pitch 专属工具条
  pitch: ['#btn-param-Pitch', '#pitch-tools', '#pitch-tools-divider'],
  // 音素 / 歌词（inspector 分区）
  phoneme: ['#phoneme-section'],
  // 音量 / 声像包络（底部 lane 区）
  envelope: ['#param-panel'],
  // 侧边参数面板（inspector 里的音符属性）
  params: ['#note-props-section'],
});

/** 等后端字段到位的最大时间（毫秒）。分片数据没到就保持默认形态。 */
const BACKEND_WAIT_MS = 10000;
const BACKEND_POLL_MS = 60;

/** 展示用：插件名 / 描述的最大长度（防止恶意超长串撑爆布局）。 */
const MAX_TEXT_LEN = 160;

/**
 * 收敛一个可能是任意来源（payload / IPC / 旧工程）的 backend。
 * 缺失或非法一律退回内置后端 {type:'sxs'}，与 trackManager.normalizeBackend()
 * 的取向一致（我们不直接依赖它，是为了让本文件保持纯渲染层依赖）。
 * @param {unknown} raw
 * @returns {{type:string, pluginId?:string, kindId?:string}}
 */
export function normalizeTrackBackend(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.type === 'string' && raw.type) {
    return raw;
  }
  return { type: 'sxs' };
}

/**
 * 计算某个 trackKind 应打开哪些内置面板。
 *
 * 规则：
 *   · kind 为空 / 没有 editor / mode 不在 TRACK_EDITOR_MODES 里 → 内置轨道形态：
 *     enabledPanels = 全部，readOnly = false（保证内置轨道 100% 保持原行为）；
 *   · mode === 'midi'          → 全部面板，hide 无效（全开就是全开）；
 *   · mode === 'midi-partial'  → enabledPanels = use − hide，hide 优先；
 *     未知的面板名被丢弃；use 为空或全被过滤掉时兜底成全部面板
 *     （契约层已拒绝空 use，这里只是渲染层兜底，绝不给用户一个空编辑器）；
 *   · mode === 'plugin'        → 内置面板全关，readOnly = true，改由插件面板占位。
 *
 * @param {object|null|undefined} kind validateTrackKind() 产出的 trackKind
 * @returns {{mode:string, enabledPanels:string[], hiddenPanels:string[], readOnly:boolean}}
 */
export function resolveEditorLayout(kind) {
  const all = [...MIDI_EDITOR_PANELS];
  const editor = kind && typeof kind.editor === 'object' && kind.editor !== null ? kind.editor : null;
  const declared = editor && typeof editor.mode === 'string' ? editor.mode : null;

  // 内置后端 / 未声明 editor / 未知 mode → 全开且可编辑
  if (!editor || !TRACK_EDITOR_MODES.includes(declared)) {
    return { mode: 'builtin', enabledPanels: all, hiddenPanels: [], readOnly: false };
  }

  if (declared === 'plugin') {
    // 插件自带面板：内置面板全部关闭，内容以只读方式呈现
    return { mode: 'plugin', enabledPanels: [], hiddenPanels: all, readOnly: true };
  }

  const useList = Array.isArray(editor.use) ? editor.use : [];
  const known = all.filter(p => useList.includes(p));
  // 空 use（或 use 里全是不认识的面板名）兜底：按全开处理
  const used = declared === 'midi' ? all : (known.length > 0 ? known : all);

  const hideList = Array.isArray(editor.hide) ? editor.hide : [];
  // hide 优先：即使 use 里写了，被 hide 命中也要关掉
  const hiddenSet = all.filter(p => hideList.includes(p));
  let enabled = used.filter(p => !hiddenSet.includes(p));
  // hide 把 use 掏空了 → 退回"全开减 hide"，再空就彻底全开（不给空编辑器）
  if (enabled.length === 0) enabled = all.filter(p => !hiddenSet.includes(p));
  if (enabled.length === 0) enabled = all;

  return {
    mode: declared,
    enabledPanels: enabled,
    hiddenPanels: all.filter(p => !enabled.includes(p)),
    readOnly: editor.readOnly === true,
  };
}

/**
 * 把 layout 应用到 DOM 上。
 * @param {{mode:string, enabledPanels:string[], readOnly:boolean}} layout
 * @param {object} [options]
 * @param {object} [options.kind]      mode==='plugin' 时用于渲染占位标题的 trackKind
 * @param {object} [options.backend]   当前分片后端
 */
export async function applyEditorLayout(layout, options = {}) {
  const enabled = new Set(Array.isArray(layout?.enabledPanels) ? layout.enabledPanels : []);

  for (const panel of MIDI_EDITOR_PANELS) {
    const off = !enabled.has(panel);
    const selectors = PANEL_NODES[panel] || [];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) el.classList.toggle(PANEL_OFF_CLASS, off);
    }
  }

  // 主画布整块关掉时，#main-content 的 grid 会少了两个子项、inspector 会被
  // 自动排到第一列（80px）挤成一团。这里显式锁定列位（配合 css）。
  const app = document.getElementById('app');
  if (app) app.classList.toggle(NO_PIANOROLL_CLASS, !enabled.has('pianoRoll'));

  // 当前激活的 lane 被关掉了 → 切回还开着的那个
  await reconcileActiveLane(enabled);

  if (layout.mode === 'plugin') {
    renderPluginPanelPlaceholder(options.kind, options.backend);
  }

  if (layout.readOnly === true) {
    installReadOnlyGuard();
  }

  // 面板显隐改了可视尺寸：只在主画布还开着的时候重算 canvas，
  // 隐藏元素的 clientWidth 是 0，重算会把 canvas 压成 0 宽。
  if (enabled.has('pianoRoll')) {
    const { resizeCanvases, render } = await import('./canvasRenderer.js');
    resizeCanvases();
    render();
  }
}

/**
 * 插件定义了自己的面板（mode === 'plugin'）。
 *
 * 当前宿主还没有"读取插件静态面板资源"的 IPC（pluginHost / pluginIpc 里只有
 * list / reload / getVoices / synthesize / plugin dir 几组，没有任何取 HTML 的
 * 接口），因此这里**不硬做 iframe 渲染**，改为占位 —— 见实现报告的未完成项。
 * @param {object} kind
 */
function renderPluginPanelPlaceholder(kind) {
  const app = document.getElementById('app');
  const paramPanel = document.getElementById('param-panel');
  if (!app || document.getElementById('plugin-panel-placeholder')) return;

  const panel = document.createElement('div');
  panel.id = 'plugin-panel-placeholder';
  panel.className = 'plugin-panel-placeholder';

  const head = document.createElement('div');
  head.className = 'plugin-panel-head';
  // 插件自定义名称属于外部数据：一律 textContent + 截断，不拼 HTML
  const kindName = truncateExternalText(kind?.name || '', MAX_TEXT_LEN) || (kind?.id || 'plugin');
  head.textContent = kindName;

  const body = document.createElement('div');
  body.className = 'plugin-panel-body';
  body.textContent = t('fragment.pluginPanelPlaceholder');

  const desc = truncateExternalText(kind?.description || '', MAX_TEXT_LEN);
  if (desc) {
    const p = document.createElement('div');
    p.className = 'plugin-panel-desc';
    p.textContent = desc;
    body.appendChild(p);
  }

  panel.appendChild(head);
  panel.appendChild(body);
  app.insertBefore(panel, paramPanel);
}

/**
 * readOnly：以最小侵入的方式让面板"看得见但改不动"。
 *
 * 做法是给 #app 挂 READONLY_CLASS（css 里把画布与 inspector 输入控件的
 * pointer-events 关掉），再加一个 capture 阶段的键盘守卫。这样既不用改
 * eventHandlers.js 里几十处交互逻辑，也能挡住绝大多数编辑入口。
 * 已知的局限见实现报告：画布上的指针事件与 document 级快捷键被挡，
 * 但"程序化调用"层面的编辑（例如 autoSave 把外部改动写回来）不受影响。
 */
function installReadOnlyGuard() {
  const app = document.getElementById('app');
  if (!app || app.classList.contains(READONLY_CLASS)) return;
  app.classList.add(READONLY_CLASS);

  if (app.dataset.pluginReadonlyGuard === '1') return;
  app.dataset.pluginReadonlyGuard = '1';

  document.addEventListener('keydown', (e) => {
    const target = e.target;
    // 工具栏（播放/导出/lane 切换）、快捷键浮层、alert 弹窗仍要能操作
    if (target instanceof Element && target.closest('#toolbar, #shortcuts-overlay, .alert-dialog-overlay')) {
      return;
    }
    e.stopPropagation();
    e.preventDefault();
  }, true);
}

/**
 * 当前激活 lane 若已被关闭，切回还开着的那个。
 * @param {Set<string>} enabled
 */
async function reconcileActiveLane(enabled) {
  const state = await import('./state.js');
  const { PARAM_MODES } = await import('./constants.js');
  const { updateParamModeButtons, updateParamPanelState } = await import('./uiControls.js');

  let top = state.getCurrentParamMode();
  if (!enabled.has('pitch') && top === PARAM_MODES.PITCH) {
    top = PARAM_MODES.MIDI;
  } else if (!enabled.has('pianoRoll') && top === PARAM_MODES.MIDI && enabled.has('pitch')) {
    top = PARAM_MODES.PITCH;
  }
  if (top !== state.getCurrentParamMode()) {
    state.setCurrentParamMode(top);
    updateParamModeButtons();
  }

  // phoneme 面板关掉时，底部 lane 若停在 Phoneme 也要退回 VOL
  if (!enabled.has('phoneme') && state.getParamPanelMode() === 'Phoneme') {
    state.setParamPanelMode('VOL');
    updateParamPanelState();
  }
}

function truncateExternalText(text, max) {
  const str = typeof text === 'string' ? text : String(text ?? '');
  return str.length > max ? str.slice(0, Math.max(1, max - 1)) + '…' : str;
}

/**
 * 初始化入口：等到分片数据（含 backend）到达后，按插件清单调整编辑器形态。
 *
 * 内置后端在这条路上第一行就 return，除一次 60ms 的轮询外零开销，
 * 也不会阻塞窗口首帧（全程 await，不占渲染）。
 */
export async function applyPluginEditorLayout() {
  try {
    const { getTrackBackend } = await import('./state.js');
    const backend = await waitForBackend(getTrackBackend);
    if (isBuiltinBackend(backend?.type)) return; // 内置轨道：保持原样

    const { ensurePluginCatalog, findTrackKind } = await import('../renderer/pluginBackend.js');
    await ensurePluginCatalog();
    const kind = findTrackKind(backend.pluginId, backend.kindId);
    if (!kind) {
      // 插件被删了 / 清单没拉到：不做形态裁剪，保持整套内置编辑器可用
      return;
    }
    const layout = resolveEditorLayout(kind);
    await applyEditorLayout(layout, { kind, backend });
  } catch (err) {
    // 形态裁剪是"锦上添花"，失败绝对不能让分片编辑器打不开
    console.warn('[plugins] 应用插件编辑器形态失败，已回退到默认形态：', err && err.message ? err.message : err);
  }
}

/**
 * 轮询等待 backend 就绪（分片数据经 IPC 异步到达）。
 * @param {() => object|null} getTrackBackend
 */
async function waitForBackend(getTrackBackend) {
  const deadline = Date.now() + BACKEND_WAIT_MS;
  for (;;) {
    const backend = getTrackBackend();
    if (backend) return backend;
    if (Date.now() >= deadline) return null;
    await new Promise(resolve => setTimeout(resolve, BACKEND_POLL_MS));
  }
}
