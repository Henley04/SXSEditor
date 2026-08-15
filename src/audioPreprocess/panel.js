import { state, dom } from './state.js';
import { getOptions, saveOptions, applyPreset, resolveOptions } from './extractionOptions.js';
import { t } from '../i18n/index.js';
import { toggleSynth } from './synthPreview.js';

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
  dom.bpmInput.addEventListener('change', persist);
  dom.normalizeCheck.addEventListener('change', persist);

  dom.btnAudition.addEventListener('click', toggleSynth);

  dom.btnTogglePanel.addEventListener('click', () => {
    const collapsed = dom.extractPanel.classList.toggle('collapsed');
    dom.btnTogglePanel.textContent = t(collapsed ? 'preprocess.expandPanel' : 'preprocess.collapsePanel');
  });
}

/** 初始化参数面板：载入已保存选项 */
export function initPanel() {
  if (!dom.presetSelect) return;
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