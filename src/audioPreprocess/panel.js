import { state, dom } from './state.js';
import { getOptions, saveOptions, applyPreset, resolveOptions } from './extractionOptions.js';
import { t } from '../i18n/index.js';
import { setLabel } from '../icons/iconHelper.js';
import { toggleSynth } from './synthPreview.js';
import { drawWaveformWithPlayhead, invalidateWaveformCache } from './canvasRenderer.js';

/** 根据 MIDI 提取工具显示/隐藏 FCPE 参数面板 */
export async function updateFcpePanelVisibility() {
  if (!dom.extractPanelBody) return;
  const settings = await window.electronAPI.getSettings();
  const tool = (settings?.midiExtractTool === 'rosvot' ? 'rmvpe' : settings?.midiExtractTool) || 'fcpe';
  const isFcpe = tool === 'fcpe';
  dom.extractPanelBody.style.display = isFcpe ? '' : 'none';
  if (dom.fcpeParamsNotice) {
    if (!isFcpe) {
      const toolName = tool === 'rmvpe' ? 'RMVPE' : 'Basic Pitch';
      dom.fcpeParamsNotice.textContent = t('preprocess.fcpeParamsDisabled', { tool: toolName });
      dom.fcpeParamsNotice.style.display = '';
    } else {
      dom.fcpeParamsNotice.style.display = 'none';
    }
  }
}

/** 把 DOM 控件值收集为 options 对象 */
export function collectOptions() {
  const opts = getOptions();
  return {
    ...opts,
    preset: dom.presetSelect.value,
    threshold: dom.thresholdSelect.value,
    smoothing: dom.smoothingSelect.value,
    quantization: dom.quantizationSelect.value,
    f0RangeAuto: dom.rangeAuto.checked,
    f0Min: Number(dom.f0Min.value) || 80,
    f0Max: Number(dom.f0Max.value) || 880,
    minNoteDuration: Number(dom.minNote.value) || 0.05,
    autoBpm: dom.bpmAuto.checked,
    bpm: Number(dom.bpmInput.value) || 120,
    normalize: dom.normalizeCheck.checked,
  };
}

/**
 * 把面板里的 BPM 同步到卷帘。
 *
 * 波形、播放头、F0 曲线、音量包络的 beat↔秒换算全部读 `pianoRoll.bpm`；只改输入框
 * 而不回写，就会出现"面板显示 96、网格还是 120"的错位——这是用户反馈的
 * "时间对齐不稳定"来源之一。
 */
function applyBpmToPianoRoll() {
  const bpm = Number(dom.bpmInput.value);
  const pr = state.pianoRoll;
  if (!pr || !(bpm > 0) || pr.bpm === bpm) return;
  pr.bpm = bpm;
  pr._staticCacheDirty = true;
  pr.render();
  invalidateWaveformCache();
  drawWaveformWithPlayhead(pr.getCurrentTime());
}

function bindControls() {
  const persist = () => saveOptions(collectOptions());

  dom.presetSelect.addEventListener('change', () => {
    const applied = applyPreset(dom.presetSelect.value);
    dom.thresholdSelect.value = applied.threshold;
    dom.smoothingSelect.value = applied.smoothing;
    dom.quantizationSelect.value = applied.quantization;
    dom.f0Min.value = applied.f0Min;
    dom.f0Max.value = applied.f0Max;
    dom.rangeAuto.checked = applied.f0RangeAuto;
    persist();
  });

  dom.thresholdSelect.addEventListener('change', persist);
  dom.smoothingSelect.addEventListener('change', persist);
  dom.quantizationSelect.addEventListener('change', persist);
  dom.rangeAuto.addEventListener('change', persist);
  dom.f0Min.addEventListener('change', persist);
  dom.f0Max.addEventListener('change', persist);
  dom.minNote.addEventListener('change', persist);
  dom.bpmAuto.addEventListener('change', persist);
  dom.bpmInput.addEventListener('change', () => {
    persist();
    applyBpmToPianoRoll();
  });
  dom.normalizeCheck.addEventListener('change', persist);

  dom.btnAudition.addEventListener('click', toggleSynth);

  dom.btnTogglePanel.addEventListener('click', () => {
    const collapsed = dom.extractPanel.classList.toggle('collapsed');
    setLabel(dom.btnTogglePanel, t(collapsed ? 'preprocess.expandPanel' : 'preprocess.collapsePanel'), { icon: collapsed ? 'chevron-down' : 'chevron-up' });
  });
}

/** 初始化参数面板：载入已保存选项 */
export async function initPanel() {
  if (!dom.presetSelect) return;
  await updateFcpePanelVisibility();
  const opts = getOptions();
  dom.presetSelect.value = opts.preset;
  dom.thresholdSelect.value = opts.threshold;
  dom.smoothingSelect.value = opts.smoothing;
  dom.quantizationSelect.value = opts.quantization;
  dom.rangeAuto.checked = opts.f0RangeAuto;
  dom.f0Min.value = opts.f0Min;
  dom.f0Max.value = opts.f0Max;
  dom.minNote.value = opts.minNoteDuration;
  dom.bpmAuto.checked = opts.autoBpm;
  dom.bpmInput.value = opts.bpm;
  dom.normalizeCheck.checked = opts.normalize;
  state.extractOptions = resolveOptions(collectOptions());
  bindControls();
}

/** 更新面板状态栏（设备/质量提示） */
export function setStatus(text) {
  if (dom.extractStatus) dom.extractStatus.textContent = text || '';
}