/**
 * 插件轨道的创建 UI：
 *   · createPluginBackendSection() —— "添加歌手"对话框里的插件后端分区；
 *   · showPluginTrackCreateDialog() —— 选音色 + 按 paramSchema 编辑参数后建轨。
 *
 * 安全约束：插件的 name / description / paramSchema.label 都是外部数据，
 * 一律经 truncateText() 后用 textContent 写入，绝不拼进 innerHTML。
 */

import { t } from '../i18n/index.js';
import { trackManager, state } from './state.js';
import { createPluginBackend } from '../editor/trackManager.js';
import {
  ensurePluginCatalog,
  reloadPluginCatalog,
  listTrackKinds,
  fetchVoices,
  resolveKindParams,
  coerceParamValue,
  isRenderableParam,
  truncateText,
  MAX_DESC_LEN,
} from './pluginBackend.js';
import { createDialog } from './uiControls.js';
import { showAlertDialog } from '../alertDialog.js';

/** 分区里的小按钮样式（与对话框主按钮区分开）。 */
const SMALL_BTN_CSS = `
  padding: 3px 8px;
  font-size: 11px;
  background: var(--bg-button);
  border: 1px solid var(--button-secondary-border);
  border-radius: var(--radius-md);
  color: var(--fg-secondary);
  cursor: pointer;
`;

function makeSmallButton(text, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = text;
  btn.style.cssText = SMALL_BTN_CSS;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return btn;
}

function makeRow(text, cssText) {
  const div = document.createElement('div');
  if (cssText) div.style.cssText = cssText;
  div.textContent = text;
  return div;
}

/**
 * 构造"插件后端"分区。插件清单是异步 IPC，这里先渲染加载态再填充，
 * 插件系统不可用（旧 preload / 宿主失败）也不会卡住对话框。
 *
 * @param {object} [options]
 * @param {string|null} [options.singerId] 非 null 时把后端应用到该轨道而非新建
 * @param {(singer:object)=>void} [options.onCreated] 建轨后的回调（markDirty / refresh）
 * @returns {HTMLElement}
 */
export function createPluginBackendSection(options = {}) {
  const { singerId = null, onCreated = null } = options;

  const wrap = document.createElement('div');
  wrap.style.cssText = 'display: flex; flex-direction: column; gap: 8px; margin-bottom: 4px;';

  const header = document.createElement('div');
  header.style.cssText = 'display: flex; align-items: center; gap: 8px;';
  const title = document.createElement('div');
  title.style.cssText = 'flex: 1; font-size: 12px; font-weight: 600; color: var(--fg-secondary);';
  title.textContent = t('main.plugin.sectionTitle');
  header.appendChild(title);
  header.appendChild(makeSmallButton(t('main.plugin.openFolder'), () => {
    const api = window.electronAPI?.pluginAPI;
    if (!api || typeof api.openPluginsFolder !== 'function') return;
    Promise.resolve(api.openPluginsFolder()).then((res) => {
      if (res && res.success === false) {
        showAlertDialog(t('main.plugin.openFolderFailed', { detail: res.error || '' }));
      }
    }).catch(() => {});
  }));
  header.appendChild(makeSmallButton(t('main.plugin.reload'), () => {
    statusEl.textContent = t('main.plugin.loading');
    listWrap.replaceChildren(statusEl);
    reloadPluginCatalog().then((catalog) => {
      renderList(catalog);
    }).catch((err) => {
      statusEl.textContent = t('main.plugin.reloadFailed', { detail: err && err.message ? err.message : '' });
      listWrap.replaceChildren(statusEl);
    });
  }));
  wrap.appendChild(header);

  const sep = document.createElement('div');
  sep.style.cssText = 'height: 1px; background: var(--border-subtle);';
  wrap.appendChild(sep);

  const listWrap = document.createElement('div');
  listWrap.style.cssText = 'display: flex; flex-direction: column; gap: 6px; max-height: 220px; overflow-y: auto;';
  const statusEl = makeRow(t('main.plugin.loading'), 'font-size: 11px; color: var(--fg-muted); padding: 4px 0;');
  listWrap.appendChild(statusEl);
  wrap.appendChild(listWrap);

  function renderList(catalog) {
    const entries = listTrackKinds();
    if (entries.length === 0) {
      statusEl.textContent = catalog && catalog.unavailable
        ? t('main.plugin.loadFailed')
        : t('main.plugin.none');
      listWrap.replaceChildren(statusEl);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const entry of entries) {
      frag.appendChild(makeKindItem(entry, () => {
        showPluginTrackCreateDialog(entry, (singer) => {
          if (onCreated) onCreated(singer);
        }, singerId);
      }));
    }
    listWrap.replaceChildren(frag);
  }

  // 异步拉清单：不阻塞对话框打开，失败也只退化成一条提示。
  ensurePluginCatalog().then(renderList).catch((err) => {
    statusEl.textContent = t('main.plugin.loadFailedDetail', { detail: err && err.message ? err.message : '' });
    listWrap.replaceChildren(statusEl);
  });

  return wrap;
}

/**
 * 单个 trackKind 条目：kind 名 + 插件名/版本 + 描述。
 * @param {{plugin:object, kind:object}} entry
 * @param {()=>void} onPick
 */
function makeKindItem(entry, onPick) {
  const { plugin, kind } = entry;
  const item = document.createElement('button');
  item.type = 'button';
  item.style.cssText = `
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 8px 10px;
    text-align: left;
    background: var(--bg-button);
    border: 1px solid var(--button-secondary-border);
    border-radius: var(--radius-md);
    color: var(--fg-primary);
    cursor: pointer;
    transition: background var(--motion-fast) var(--ease-standard), border-color var(--motion-fast) var(--ease-standard);
  `;
  item.addEventListener('mouseenter', () => {
    item.style.background = 'var(--bg-button-hover)';
    item.style.borderColor = 'var(--accent-glow)';
  });
  item.addEventListener('mouseleave', () => {
    item.style.background = 'var(--bg-button)';
    item.style.borderColor = 'var(--button-secondary-border)';
  });
  item.appendChild(makeRow(truncateText(kind.name || kind.id), 'font-size: 12px; font-weight: 600;'));
  item.appendChild(makeRow(
    truncateText(plugin.name || plugin.id, 40) + (plugin.version ? ` v${truncateText(plugin.version, 24)}` : ''),
    'font-size: 11px; color: var(--fg-muted);',
  ));
  if (kind.description) {
    item.appendChild(makeRow(truncateText(kind.description, MAX_DESC_LEN), 'font-size: 11px; color: var(--fg-muted); line-height: 1.4;'));
  }
  item.addEventListener('click', (e) => {
    e.stopPropagation();
    onPick();
  });
  return item;
}

/**
 * 创建插件轨道的对话框：音色选择 + paramSchema 参数编辑。
 *
 * @param {{plugin:object, kind:object}} entry
 * @param {(singer:object)=>void} onCreated
 * @param {string|null} [singerId] 非 null 时改后端而不是新建轨道
 */
export function showPluginTrackCreateDialog(entry, onCreated, singerId = null) {
  const { plugin, kind } = entry;
  const container = document.createElement('div');
  container.style.cssText = 'display: flex; flex-direction: column; gap: 10px; min-width: 320px;';

  // ---- 音色 ----
  const voicesEnabled = !!(plugin.capabilities && plugin.capabilities.voices);
  let voiceId = null;
  if (voicesEnabled) {
    const voiceWrap = document.createElement('label');
    voiceWrap.style.cssText = 'display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--fg-secondary);';
    const voiceLabel = document.createElement('span');
    voiceLabel.textContent = t('main.plugin.voiceLabel');
    const voiceSelect = document.createElement('select');
    voiceSelect.style.cssText = `
      padding: 6px;
      background: var(--bg-input);
      border: 1px solid var(--border-strong);
      border-radius: var(--radius-md);
      color: var(--fg-primary);
      font-size: 12px;
    `;
    const loadingOption = document.createElement('option');
    loadingOption.value = '';
    loadingOption.textContent = t('main.plugin.voiceLoading');
    voiceSelect.appendChild(loadingOption);
    voiceWrap.append(voiceLabel, voiceSelect);
    container.appendChild(voiceWrap);

    // 音色是异步 IPC：拉到后填充，失败只留一条提示，参数编辑不受影响。
    fetchVoices(plugin.id, kind.id).then((voices) => {
      voiceSelect.replaceChildren();
      if (voices.length === 0) {
        const opt = document.createElement('option');
        opt.value = '';
        opt.textContent = t('main.plugin.voiceNone');
        voiceSelect.appendChild(opt);
        return;
      }
      voices.forEach((v, idx) => {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = truncateText(v.name || v.id, 40);
        if (idx === 0) opt.selected = true;
        voiceSelect.appendChild(opt);
      });
      voiceId = voices[0].id;
    }).catch(() => {
      voiceSelect.replaceChildren();
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = t('main.plugin.voiceLoadFailed');
      voiceSelect.appendChild(opt);
    });
    voiceSelect.addEventListener('change', () => {
      voiceId = voiceSelect.value || null;
    });
  }

  // ---- 参数 ----
  const schema = (Array.isArray(kind.paramSchema) ? kind.paramSchema : []).filter(isRenderableParam);
  const defaults = resolveKindParams(kind);
  const paramReaders = [];

  const paramsTitle = makeRow(t('main.plugin.paramsTitle'), 'font-size: 12px; font-weight: 600; color: var(--fg-secondary);');
  container.appendChild(paramsTitle);

  if (schema.length === 0) {
    container.appendChild(makeRow(t('main.plugin.paramsNone'), 'font-size: 11px; color: var(--fg-muted);'));
  } else {
    for (const entrySchema of schema) {
      const control = makeParamControl(entrySchema, defaults[entrySchema.key], plugin, kind);
      container.appendChild(control.wrap);
      paramReaders.push(() => ({
        key: entrySchema.key,
        value: coerceParamValue(entrySchema, control.read()),
      }));
    }
  }

  createDialog({
    title: t('main.plugin.createTitle'),
    contentElement: container,
    minWidth: 360,
    buttons: [
      {
        text: t('common.cancel'),
        type: 'default',
        onClick: () => {},
      },
      {
        text: t('main.plugin.create'),
        type: 'primary',
        onClick: () => {
          const params = resolveKindParams(kind);
          for (const read of paramReaders) {
            const item = read();
            params[item.key] = item.value;
          }
          const backend = createPluginBackend({
            pluginId: plugin.id,
            kindId: kind.id,
            voiceId,
            params,
          });
          let singer;
          const existing = singerId != null ? trackManager.getSinger(singerId) : null;
          if (existing) {
            trackManager.updateSinger(singerId, { backend });
            singer = existing;
          } else {
            singer = trackManager.addSinger({
              trackName: truncateText(kind.name || kind.id, 40),
              singerName: truncateText(plugin.name || plugin.id, 40),
              backend,
            });
            state.selectedSingerId = singer.id;
          }
          if (onCreated) onCreated(singer);
        },
      },
    ],
    styles: { buttonMarginTop: '0' },
  });
}

/**
 * 按 paramSchema 条目生成一个控件。取值范围与 validateParamSchemaEntry()
 * 保持一致（min/max、enum options），写入前再经 coerceParamValue() 收口。
 *
 * @param {object} schemaEntry
 * @param {unknown} value
 * @param {object} plugin
 * @param {object} kind
 * @returns {{wrap: HTMLElement, read: ()=>unknown}}
 */
function makeParamControl(schemaEntry, value, plugin, kind) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display: flex; align-items: center; gap: 8px;';

  const label = document.createElement('span');
  label.style.cssText = 'flex: 0 0 40%; font-size: 11px; color: var(--fg-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;';
  label.textContent = truncateText(schemaEntry.label || schemaEntry.key, 40);
  label.title = String(schemaEntry.label || schemaEntry.key);
  wrap.appendChild(label);

  const inputCss = `
    flex: 1;
    padding: 4px 6px;
    background: var(--bg-input);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    color: var(--fg-primary);
    font-size: 11px;
    min-width: 0;
  `;

  if (schemaEntry.type === 'boolean') {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = value === true || value === 'true';
    wrap.appendChild(input);
    return { wrap, read: () => input.checked };
  }

  if (schemaEntry.type === 'enum') {
    const select = document.createElement('select');
    select.style.cssText = inputCss;
    const options = Array.isArray(schemaEntry.options) ? schemaEntry.options : [];
    options.forEach((opt) => {
      const option = document.createElement('option');
      option.value = String(opt);
      option.textContent = truncateText(String(opt), 40);
      if (String(opt) === String(value)) option.selected = true;
      select.appendChild(option);
    });
    wrap.appendChild(select);
    return { wrap, read: () => select.value };
  }

  if (schemaEntry.type === 'number' || schemaEntry.type === 'integer') {
    const input = document.createElement('input');
    input.type = 'number';
    input.style.cssText = inputCss;
    if (Number.isFinite(schemaEntry.min)) input.min = String(schemaEntry.min);
    if (Number.isFinite(schemaEntry.max)) input.max = String(schemaEntry.max);
    input.step = schemaEntry.type === 'integer' ? '1' : (Number.isFinite(schemaEntry.step) ? String(schemaEntry.step) : 'any');
    input.value = String(Number.isFinite(Number(value)) ? value : (schemaEntry.type === 'integer' ? 0 : 0));
    wrap.appendChild(input);
    return { wrap, read: () => input.value };
  }

  if (schemaEntry.type === 'voice') {
    const select = document.createElement('select');
    select.style.cssText = inputCss;
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = t('main.plugin.voiceLoading');
    select.appendChild(placeholder);
    // 复用同一份音色缓存：与上面的音色下拉共用一次 IPC。
    fetchVoices(plugin.id, kind.id).then((voices) => {
      select.replaceChildren();
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = t('main.plugin.voiceNone');
      select.appendChild(empty);
      voices.forEach((v) => {
        const opt = document.createElement('option');
        opt.value = v.id;
        opt.textContent = truncateText(v.name || v.id, 40);
        if (v.id === value) opt.selected = true;
        select.appendChild(opt);
      });
    }).catch(() => {});
    wrap.appendChild(select);
    return { wrap, read: () => select.value };
  }

  if (schemaEntry.type === 'file') {
    const input = document.createElement('input');
    input.type = 'text';
    input.style.cssText = inputCss;
    input.value = typeof value === 'string' ? value : '';
    const browse = makeSmallButton(t('main.plugin.browse'), () => {
      if (!window.electronAPI?.showOpenDialog) return;
      Promise.resolve(window.electronAPI.showOpenDialog({ properties: ['openFile'] })).then((res) => {
        if (res && !res.canceled && res.filePaths && res.filePaths.length > 0) {
          input.value = res.filePaths[0];
        }
      }).catch(() => {});
    });
    wrap.append(input, browse);
    return { wrap, read: () => input.value };
  }

  // string 及未知类型：单行文本输入
  const input = document.createElement('input');
  input.type = 'text';
  input.style.cssText = inputCss;
  input.value = typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value));
  wrap.appendChild(input);
  return { wrap, read: () => input.value };
}
