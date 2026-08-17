/**
 * 导出对话框模块
 *
 * 按下导出按钮时不直接推理，而是打开导出对话框。
 * 对话框包含：
 *   - 模型精度选择（影响速度和音质）
 *   - 推理参数快捷调整（扩散步数 / CFG 强度 / CFG Rescale / Auto Shift）
 *   - 高级选项（折叠）：Vocoder 类型、SiFiGAN 精度、Vocoder 分片设置、显存释放选项
 *   - 导出音频位置
 * 按下开始后显示进度，完成后自动打开导出位置。
 */

import '../exportDialog.css';
import { t } from '../i18n/index.js';
import { dom, trackManager } from './state.js';
import { runExportJob } from './audioPlayback.js';
import { showAlertDialog } from '../alertDialog.js';
import { SAMPLE_RATE } from './constants.js';
import { createIcon } from '../icons/iconHelper.js';

// ==================== 常量 ====================

function resampleForExport(interleaved, sourceRate, targetRate, channels) {
  if (sourceRate === targetRate) return interleaved;
  const sourceFrames = Math.floor(interleaved.length / channels);
  const targetFrames = Math.max(1, Math.round(sourceFrames * targetRate / sourceRate));
  const output = new Float32Array(targetFrames * channels);
  for (let frame = 0; frame < targetFrames; frame++) {
    const sourcePosition = frame * sourceRate / targetRate;
    const left = Math.min(sourceFrames - 1, Math.floor(sourcePosition));
    const right = Math.min(sourceFrames - 1, left + 1);
    const mix = sourcePosition - left;
    for (let channel = 0; channel < channels; channel++) {
      const a = interleaved[left * channels + channel];
      const b = interleaved[right * channels + channel];
      output[frame * channels + channel] = a + (b - a) * mix;
    }
  }
  return output;
}


const PRECISION_OPTIONS = [
  { value: 'fp16', nameKey: 'main.exportDialog.precisionFp16Name', descKey: 'main.exportDialog.precisionFp16Desc' },
  { value: 'fp32', nameKey: 'main.exportDialog.precisionFp32Name', descKey: 'main.exportDialog.precisionFp32Desc' },
  { value: 'int8', nameKey: 'main.exportDialog.precisionInt8Name', descKey: 'main.exportDialog.precisionInt8Desc' },
  { value: 'int8-npu', nameKey: 'main.exportDialog.precisionInt8NpuName', descKey: 'main.exportDialog.precisionInt8NpuDesc' },
];

let _dialogOpen = false;

// ==================== 入口 ====================

export async function openExportDialog() {
  if (_dialogOpen) return;
  _dialogOpen = true;

  let overlay = null;
  const cleanupFns = [];

  const fullCleanup = () => {
    cleanupFns.forEach(fn => { try { fn(); } catch (_) {} });
    cleanupFns.length = 0;
    if (overlay && overlay.parentElement) overlay.remove();
    overlay = null;
    _dialogOpen = false;
  };

  try {
    // 早期检查：分片与音符
    const fragments = trackManager.getFragments();
    if (fragments.length === 0) {
      _dialogOpen = false;
      showAlertDialog(t('main.exportDialog.noFragments'));
      return;
    }
    const hasNotes = fragments.some(f => f.notes && f.notes.length > 0);
    if (!hasNotes) {
      _dialogOpen = false;
      showAlertDialog(t('main.exportDialog.noNotes'));
      return;
    }

    // 加载当前设置
    const settings = await window.electronAPI.getSettings();

    // 表单状态（与设置 key 一一对应）
    const form = {
      modelPrecision: settings.modelPrecision || 'fp32',
      exportDiffSteps: settings.exportDiffSteps ?? 32,
      exportCfgStrength: settings.exportCfgStrength ?? 3.0,
      exportCfgRescale: settings.exportCfgRescale ?? 0.7,
      exportSampler: settings.exportSampler || 'euler',
      autoShift: dom.autoShiftCheck ? dom.autoShiftCheck.checked : true,
      outputSampleRate: [24000, 44100, 48000, 96000].includes(settings.exportSampleRate) ? settings.exportSampleRate : 48000,
      vocoderType: settings.vocoderType === 'sifigan' ? 'sifigan' : 'default',
      sifiganPrecision: settings.sifiganPrecision === 'fp16' ? 'fp16' : 'fp32',
      vocoderChunkMode: settings.vocoderChunkMode === 'manual' ? 'manual' : 'smart',
      vocoderChunkFrames: Number.isFinite(settings.vocoderChunkFrames) ? settings.vocoderChunkFrames : 1024,
      releaseDmlVramAfterSynthesis: settings.releaseDmlVramAfterSynthesis === true,
      releaseDiffStepBeforeVocoder: settings.releaseDiffStepBeforeVocoder === true,
      // Task 11/17/18: new settings keys
      exportCfgScheduleMode: settings.exportCfgScheduleMode || settings.cfgScheduleMode || 'linear',
      exportCfgStrengthStart: Number.isFinite(settings.exportCfgStrengthStart) ? settings.exportCfgStrengthStart : (Number.isFinite(settings.cfgStrengthStart) ? settings.cfgStrengthStart : null),
      exportCfgScheduleKeyframes: Array.isArray(settings.exportCfgScheduleKeyframes) ? settings.exportCfgScheduleKeyframes : (Array.isArray(settings.cfgScheduleKeyframes) ? settings.cfgScheduleKeyframes : null),
      // M5: preview CFG schedule mirrors (fall back to top-level cfg* keys)
      previewCfgScheduleMode: settings.previewCfgScheduleMode || settings.cfgScheduleMode || 'linear',
      previewCfgStrengthStart: Number.isFinite(settings.previewCfgStrengthStart) ? settings.previewCfgStrengthStart : (Number.isFinite(settings.cfgStrengthStart) ? settings.cfgStrengthStart : null),
      previewCfgScheduleKeyframes: Array.isArray(settings.previewCfgScheduleKeyframes) ? settings.previewCfgScheduleKeyframes : (Array.isArray(settings.cfgScheduleKeyframes) ? settings.cfgScheduleKeyframes : null),
      // Dynamic thresholding (export path)
      exportDynamicThresholdEnabled: settings.exportDynamicThresholdEnabled === true,
      exportDynamicThresholdPercentile: Number.isFinite(settings.exportDynamicThresholdPercentile) ? settings.exportDynamicThresholdPercentile : 0.995,
      // Dynamic thresholding (preview path)
      previewDynamicThresholdEnabled: settings.previewDynamicThresholdEnabled === true,
      previewDynamicThresholdPercentile: Number.isFinite(settings.previewDynamicThresholdPercentile) ? settings.previewDynamicThresholdPercentile : 0.995,
      vocoderOverlapFrames: Number.isFinite(settings.vocoderOverlapFrames) ? settings.vocoderOverlapFrames : 32,
      diagnosticMode: settings.diagnosticMode === true,
      enableLoudnormFinal: settings.enableLoudnormFinal !== false,
      enableAntiAliasing: settings.enableAntiAliasing === true,
      enableSDEditRepair: settings.enableSDEditRepair === true,
      outputPath: '',
    };

    // 默认输出路径：用户上次导出位置或桌面
    const defaultName = `${t('main.exportDialog.defaultFileName')}_${formatTimestamp(new Date())}.wav`;
    form.outputPath = buildDefaultOutputPath(defaultName);

    overlay = buildDialog(form, settings, fullCleanup);
    document.body.appendChild(overlay);
  } catch (err) {
    console.error('[ExportDialog] Failed to open:', err);
    _dialogOpen = false;
    showAlertDialog(t('main.exportDialog.progressFailed') + ': ' + (err.message || ''));
  }
}

// ==================== 对话框构建 ====================

function buildDialog(form, settings, fullCleanup) {
  const overlay = document.createElement('div');
  overlay.className = 'export-dialog-overlay export-dialog';

  const panel = document.createElement('div');
  panel.className = 'export-dialog-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  overlay.appendChild(panel);

  // ===== Header =====
  const header = document.createElement('div');
  header.className = 'export-dialog-header';
  const title = document.createElement('h3');
  title.textContent = t('main.exportDialog.title');
  const subtitle = document.createElement('div');
  subtitle.className = 'export-dialog-subtitle';
  subtitle.textContent = t('main.exportDialog.subtitle');
  header.appendChild(title);
  header.appendChild(subtitle);
  panel.appendChild(header);

  // ===== Body (config form) =====
  const body = document.createElement('div');
  body.className = 'export-dialog-body';
  panel.appendChild(body);

  // --- 精度选择区 ---
  body.appendChild(buildPrecisionSection(form));

  // --- 推理参数区 ---
  body.appendChild(buildParamsSection(form));

  // --- 高级选项区 ---
  body.appendChild(buildAdvancedSection(form, settings));

  // --- 导出位置区 ---
  body.appendChild(buildOutputSection(form));

  // ===== Footer =====
  const footer = document.createElement('div');
  footer.className = 'export-dialog-footer';
  panel.appendChild(footer);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'export-dialog-btn export-dialog-btn-secondary';
  cancelBtn.textContent = t('main.exportDialog.cancel');
  cancelBtn.addEventListener('click', fullCleanup);
  footer.appendChild(cancelBtn);

  const startBtn = document.createElement('button');
  startBtn.className = 'export-dialog-btn export-dialog-btn-primary';
  startBtn.textContent = t('main.exportDialog.startExport');
  startBtn.addEventListener('click', () => onStartClick(form, settings, panel, body, footer, fullCleanup));
  footer.appendChild(startBtn);

  // Esc 关闭
  const onKeyDown = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      fullCleanup();
    }
  };
  overlay.addEventListener('keydown', onKeyDown);

  // 点击遮罩关闭（仅点击遮罩自身，不点击面板）
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) fullCleanup();
  });

  // 自动聚焦开始按钮
  requestAnimationFrame(() => startBtn.focus());

  return overlay;
}

// ==================== 区段构建 ====================

function buildSectionTitle(key) {
  const title = document.createElement('div');
  title.className = 'export-dialog-section-title';
  title.textContent = t(key);
  return title;
}

function buildPrecisionSection(form) {
  const section = document.createElement('div');
  section.className = 'export-dialog-section';
  section.appendChild(buildSectionTitle('main.exportDialog.precisionSection'));

  const hint = document.createElement('div');
  hint.className = 'export-dialog-field-hint';
  hint.textContent = t('main.exportDialog.precisionHint');
  section.appendChild(hint);

  const grid = document.createElement('div');
  grid.className = 'export-dialog-precision-grid';

  for (const opt of PRECISION_OPTIONS) {
    const label = document.createElement('label');
    label.className = 'export-dialog-precision-option';
    if (form.modelPrecision === opt.value) label.classList.add('selected');

    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = 'export-precision';
    radio.value = opt.value;
    radio.checked = form.modelPrecision === opt.value;
    radio.addEventListener('change', () => {
      form.modelPrecision = opt.value;
      grid.querySelectorAll('.export-dialog-precision-option').forEach(el => el.classList.remove('selected'));
      label.classList.add('selected');
    });

    const name = document.createElement('div');
    name.className = 'export-dialog-precision-name';
    name.textContent = t(opt.nameKey);

    const desc = document.createElement('div');
    desc.className = 'export-dialog-precision-desc';
    desc.textContent = t(opt.descKey);

    label.appendChild(radio);
    label.appendChild(name);
    label.appendChild(desc);
    grid.appendChild(label);
  }
  section.appendChild(grid);
  return section;
}

function buildParamsSection(form) {
  const section = document.createElement('div');
  section.className = 'export-dialog-section';
  section.appendChild(buildSectionTitle('main.exportDialog.paramsSection'));

  // 求解器（扩散采样器）
  const samplerField = document.createElement('div');
  samplerField.className = 'export-dialog-field';
  const samplerLabel = document.createElement('div');
  samplerLabel.className = 'export-dialog-field-label';
  samplerLabel.textContent = t('main.exportDialog.sampler');
  samplerField.appendChild(samplerLabel);
  const samplerHint = document.createElement('div');
  samplerHint.className = 'export-dialog-field-hint';
  samplerHint.textContent = t('main.exportDialog.samplerHint');
  samplerField.appendChild(samplerHint);
  const samplerSelect = document.createElement('select');
  // 求解器选项（与 src/inference/pipeline/samplers/index.js SOLVERS 对齐）
  const samplerOptions = [
    { value: 'euler', labelKey: 'main.exportDialog.samplerEuler' },
    { value: 'heun', labelKey: 'main.exportDialog.samplerHeun' },
    { value: 'extrap', labelKey: 'main.exportDialog.samplerExtrap' },
    { value: 'stork2', labelKey: 'main.exportDialog.samplerStork2' },
  ];
  for (const opt of samplerOptions) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = t(opt.labelKey);
    samplerSelect.appendChild(o);
  }
  samplerSelect.value = form.exportSampler;
  samplerSelect.addEventListener('change', () => {
    form.exportSampler = samplerSelect.value;
  });
  samplerField.appendChild(samplerSelect);
  section.appendChild(samplerField);

  // 扩散步数
  section.appendChild(buildRangeField({
    labelKey: 'main.exportDialog.diffSteps',
    min: 4, max: 64, step: 4,
    value: form.exportDiffSteps,
    onChange: (v) => { form.exportDiffSteps = v; },
  }));

  // CFG 强度
  section.appendChild(buildRangeField({
    labelKey: 'main.exportDialog.cfgStrength',
    min: 0, max: 10, step: 0.5,
    value: form.exportCfgStrength,
    format: (v) => parseFloat(v).toFixed(1),
    onChange: (v) => { form.exportCfgStrength = v; },
  }));

  // CFG Rescale
  section.appendChild(buildRangeField({
    labelKey: 'main.exportDialog.cfgRescale',
    min: 0, max: 1, step: 0.05,
    value: form.exportCfgRescale,
    format: (v) => parseFloat(v).toFixed(2),
    onChange: (v) => { form.exportCfgRescale = v; },
    warning: (v) => (v < 0.5 || v > 0.7) ? t('main.exportDialog.cfgRescaleRangeWarn') : '',
  }));

  // Task 11: CFG strength schedule (export path)
  section.appendChild(buildCfgScheduleField(form, 'export'));

  // M5: CFG strength schedule (preview path) — mirrors export so preview
  // playback uses the same configurable schedule instead of always 'linear'.
  section.appendChild(buildCfgScheduleField(form, 'preview'));

  // Dynamic thresholding (export path)
  section.appendChild(buildDynamicThresholdField(form, 'export'));
  // Dynamic thresholding (preview path)
  section.appendChild(buildDynamicThresholdField(form, 'preview'));

  // Auto Shift 复选框
  section.appendChild(buildCheckboxField({
    labelKey: 'main.exportDialog.autoShift',
    descKey: 'main.exportDialog.autoShiftHint',
    checked: form.autoShift,
    onChange: (v) => {
      form.autoShift = v;
      // 同步到工具栏复选框，保持一致
      if (dom.autoShiftCheck) dom.autoShiftCheck.checked = v;
    },
  }));



  const sampleRateField = document.createElement('div');
  sampleRateField.className = 'export-dialog-field';
  const sampleRateLabel = document.createElement('div');
  sampleRateLabel.className = 'export-dialog-field-label';
  sampleRateLabel.textContent = t('main.exportDialog.sampleRate');
  sampleRateField.appendChild(sampleRateLabel);
  const sampleRateHint = document.createElement('div');
  sampleRateHint.className = 'export-dialog-field-hint';
  sampleRateHint.textContent = t('main.exportDialog.sampleRateHint');
  sampleRateField.appendChild(sampleRateHint);
  const sampleRateSelect = document.createElement('select');
  for (const rate of [24000, 44100, 48000, 96000]) {
    const option = document.createElement('option');
    option.value = String(rate);
    option.textContent = `${rate} Hz${rate === 48000 ? ` (${t('main.exportDialog.sampleRateDefault')})` : ''}`;
    sampleRateSelect.appendChild(option);
  }
  sampleRateSelect.value = String(form.outputSampleRate);
  sampleRateSelect.addEventListener('change', () => { form.outputSampleRate = Number(sampleRateSelect.value); });
  sampleRateField.appendChild(sampleRateSelect);
  section.appendChild(sampleRateField);

  return section;
}

// ==================== CFG schedule field (export + preview) ====================

// M5: Builds a CFG strength schedule field for either the export or preview
// path. Mirrors the previous inline export schedule UI; preview uses the
// previewCfgSchedule* i18n keys and form fields so preview playback is
// configurable instead of always falling back to 'linear'.
function buildCfgScheduleField(form, scope) {
  const isPreview = scope === 'preview';
  // Export uses unprefixed cfgSchedule* keys; preview uses previewCfgSchedule*.
  const i18nKey = (base) => isPreview
    ? `main.exportDialog.preview${base.charAt(0).toUpperCase()}${base.slice(1)}`
    : `main.exportDialog.${base}`;
  const formMode = `${scope}CfgScheduleMode`;
  const formStart = `${scope}CfgStrengthStart`;
  const formKf = `${scope}CfgScheduleKeyframes`;

  const scheduleField = document.createElement('div');
  scheduleField.className = 'export-dialog-field';
  const scheduleLabel = document.createElement('div');
  scheduleLabel.className = 'export-dialog-field-label';
  scheduleLabel.textContent = t(i18nKey('cfgScheduleMode'));
  scheduleField.appendChild(scheduleLabel);
  const scheduleHint = document.createElement('div');
  scheduleHint.className = 'export-dialog-field-hint';
  scheduleHint.textContent = t(i18nKey('cfgScheduleModeHint'));
  scheduleField.appendChild(scheduleHint);
  const scheduleSelect = document.createElement('select');
  // Option labels (Constant/Linear/Cosine/Custom) are shared between scopes.
  const scheduleOptions = [
    { value: 'constant', labelKey: 'main.exportDialog.cfgScheduleConstant' },
    { value: 'linear', labelKey: 'main.exportDialog.cfgScheduleLinear' },
    { value: 'cosine', labelKey: 'main.exportDialog.cfgScheduleCosine' },
    { value: 'custom', labelKey: 'main.exportDialog.cfgScheduleCustom' },
  ];
  for (const opt of scheduleOptions) {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = t(opt.labelKey);
    scheduleSelect.appendChild(o);
  }
  scheduleSelect.value = form[formMode];
  scheduleField.appendChild(scheduleSelect);

  // cfgStrengthStart input (hidden in constant mode)
  const startField = document.createElement('div');
  startField.className = 'export-dialog-field';
  startField.dataset.cfgStartField = 'true';
  const startLabel = document.createElement('div');
  startLabel.className = 'export-dialog-field-label';
  startLabel.textContent = t(i18nKey('cfgStrengthStart'));
  startField.appendChild(startLabel);
  const startHint = document.createElement('div');
  startHint.className = 'export-dialog-field-hint';
  startHint.textContent = t(i18nKey('cfgStrengthStartHint'));
  startField.appendChild(startHint);
  const startInput = document.createElement('input');
  startInput.type = 'number';
  startInput.min = '0';
  startInput.max = '10';
  startInput.step = '0.1';
  startInput.value = form[formStart] ?? '';
  startInput.placeholder = t(i18nKey('cfgStrengthStartPlaceholder'));
  // M12: clamp parsed value to [0, 10] to prevent negative/out-of-range CFG
  // (negative CFG is undefined behavior in SVS).
  startInput.addEventListener('input', () => {
    let v = parseFloat(startInput.value);
    if (Number.isFinite(v)) {
      v = Math.max(0, Math.min(10, v));  // clamp to [0, 10]
    } else {
      v = null;
    }
    form[formStart] = v;
  });
  startField.appendChild(startInput);
  scheduleField.appendChild(startField);

  // custom keyframe editor (only visible in custom mode)
  const keyframeField = document.createElement('div');
  keyframeField.className = 'export-dialog-field';
  keyframeField.dataset.cfgKeyframeField = 'true';
  const kfLabel = document.createElement('div');
  kfLabel.className = 'export-dialog-field-label';
  kfLabel.textContent = t(i18nKey('cfgScheduleKeyframes'));
  keyframeField.appendChild(kfLabel);
  const kfHint = document.createElement('div');
  kfHint.className = 'export-dialog-field-hint';
  kfHint.textContent = t(i18nKey('cfgScheduleKeyframesHint'));
  keyframeField.appendChild(kfHint);
  const kfInput = document.createElement('input');
  kfInput.type = 'text';
  kfInput.placeholder = t(i18nKey('cfgScheduleKeyframesPlaceholder'));
  // Render existing keyframes as text
  if (Array.isArray(form[formKf]) && form[formKf].length > 0) {
    kfInput.value = form[formKf].map(kf => `${kf.step}:${kf.value}`).join(',');
  }
  kfInput.addEventListener('input', () => {
    const text = kfInput.value.trim();
    if (!text) { form[formKf] = null; return; }
    const parsed = [];
    for (const part of text.split(',')) {
      const [s, v] = part.split(':').map(x => parseFloat(x.trim()));
      if (Number.isFinite(s) && Number.isFinite(v)) parsed.push({ step: s, value: v });
    }
    form[formKf] = parsed.length > 0 ? parsed : null;
  });
  keyframeField.appendChild(kfInput);
  scheduleField.appendChild(keyframeField);

  // Toggle start/keyframe visibility on mode change
  const updateVisibility = () => {
    const mode = scheduleSelect.value;
    startField.hidden = (mode === 'constant');
    keyframeField.hidden = (mode !== 'custom');
  };
  scheduleSelect.addEventListener('change', () => {
    form[formMode] = scheduleSelect.value;
    updateVisibility();
  });
  updateVisibility();

  return scheduleField;
}

// ==================== Dynamic thresholding field (export + preview) ====================

function buildDynamicThresholdField(form, scope) {
  const isPreview = scope === 'preview';
  const i18nKey = (base) => isPreview
    ? `main.exportDialog.preview${base.charAt(0).toUpperCase()}${base.slice(1)}`
    : `main.exportDialog.${base}`;
  const formEnabled = `${scope}DynamicThresholdEnabled`;
  const formPercentile = `${scope}DynamicThresholdPercentile`;

  const wrapper = document.createElement('div');
  wrapper.className = 'export-dialog-field';

  // Checkbox
  const checkboxField = buildCheckboxField({
    labelKey: i18nKey('dynamicThresholdEnabled'),
    descKey: i18nKey('dynamicThresholdEnabledHint'),
    checked: form[formEnabled],
    onChange: (v) => {
      form[formEnabled] = v;
      percentileGroup.hidden = !v;
    },
  });
  wrapper.appendChild(checkboxField);

  // Percentile slider (hidden when disabled)
  const percentileGroup = document.createElement('div');
  percentileGroup.className = 'export-dialog-field';
  percentileGroup.hidden = !form[formEnabled];

  const pctLabel = document.createElement('div');
  pctLabel.className = 'export-dialog-field-label';
  const pctLabelText = document.createElement('span');
  pctLabelText.textContent = t(i18nKey('dynamicThresholdPercentile'));
  const pctValueBox = document.createElement('span');
  pctValueBox.className = 'export-dialog-field-value';
  pctValueBox.textContent = parseFloat(form[formPercentile]).toFixed(3);
  pctLabel.appendChild(pctLabelText);
  pctLabel.appendChild(pctValueBox);
  percentileGroup.appendChild(pctLabel);

  const pctHint = document.createElement('div');
  pctHint.className = 'export-dialog-field-hint';
  pctHint.textContent = t(i18nKey('dynamicThresholdPercentileHint'));
  percentileGroup.appendChild(pctHint);

  const pctSlider = document.createElement('input');
  pctSlider.type = 'range';
  pctSlider.min = '0.900';
  pctSlider.max = '0.999';
  pctSlider.step = '0.001';
  pctSlider.value = form[formPercentile];
  pctSlider.addEventListener('input', () => {
    const v = parseFloat(pctSlider.value);
    pctValueBox.textContent = v.toFixed(3);
    form[formPercentile] = v;
  });
  percentileGroup.appendChild(pctSlider);
  wrapper.appendChild(percentileGroup);

  return wrapper;
}

function buildAdvancedSection(form, settings) {
  const section = document.createElement('div');
  section.className = 'export-dialog-section';

  // 折叠切换按钮
  const toggle = document.createElement('button');
  toggle.className = 'export-dialog-advanced-toggle';
  toggle.type = 'button';
  const toggleLabel = document.createElement('span');
  toggleLabel.textContent = t('main.exportDialog.advancedToggle');
  const chevron = document.createElement('span');
  chevron.className = 'chevron';
  chevron.textContent = '▾';
  toggle.appendChild(toggleLabel);
  toggle.appendChild(chevron);

  const content = document.createElement('div');
  content.className = 'export-dialog-advanced-content';
  content.hidden = true;

  toggle.addEventListener('click', () => {
    const expanded = !content.hidden;
    content.hidden = expanded;
    toggle.classList.toggle('expanded', !expanded);
    toggleLabel.textContent = expanded
      ? t('main.exportDialog.advancedToggle')
      : t('main.exportDialog.advancedToggleHide');
  });

  section.appendChild(toggle);
  section.appendChild(content);

  // Vocoder 类型
  const vocoderField = document.createElement('div');
  vocoderField.className = 'export-dialog-field';
  const vocoderLabel = document.createElement('div');
  vocoderLabel.className = 'export-dialog-field-label';
  vocoderLabel.textContent = t('main.exportDialog.vocoderType');
  vocoderField.appendChild(vocoderLabel);

  const vocoderSelect = document.createElement('select');
  const defOpt = document.createElement('option');
  defOpt.value = 'default';
  defOpt.textContent = t('main.exportDialog.vocoderTypeDefault');
  const sifiganOpt = document.createElement('option');
  sifiganOpt.value = 'sifigan';
  sifiganOpt.textContent = t('main.exportDialog.vocoderTypeSifigan');
  // 仅当 SiFiGAN 模型存在时允许选择
  sifiganOpt.disabled = !(settings.vocoderType === 'sifigan');
  vocoderSelect.appendChild(defOpt);
  vocoderSelect.appendChild(sifiganOpt);
  vocoderSelect.value = form.vocoderType;
  vocoderSelect.addEventListener('change', () => {
    form.vocoderType = vocoderSelect.value;
    updateSifiganPrecisionVisibility(content, form);
  });
  vocoderField.appendChild(vocoderSelect);
  content.appendChild(vocoderField);

  // SiFiGAN 精度（仅 vocoderType=sifigan 时显示）
  const sifiganGroup = document.createElement('div');
  sifiganGroup.className = 'export-dialog-field';
  sifiganGroup.dataset.sifiganGroup = 'true';
  const sifiganLabel = document.createElement('div');
  sifiganLabel.className = 'export-dialog-field-label';
  sifiganLabel.textContent = t('main.exportDialog.sifiganPrecision');
  sifiganGroup.appendChild(sifiganLabel);
  const sifiganSelect = document.createElement('select');
  const sifiganFp32 = document.createElement('option');
  sifiganFp32.value = 'fp32';
  sifiganFp32.textContent = 'FP32';
  const sifiganFp16 = document.createElement('option');
  sifiganFp16.value = 'fp16';
  sifiganFp16.textContent = 'FP16';
  sifiganSelect.appendChild(sifiganFp32);
  sifiganSelect.appendChild(sifiganFp16);
  sifiganSelect.value = form.sifiganPrecision;
  sifiganSelect.addEventListener('change', () => {
    form.sifiganPrecision = sifiganSelect.value;
  });
  sifiganGroup.appendChild(sifiganSelect);
  content.appendChild(sifiganGroup);

  // Vocoder 分片模式
  const chunkModeField = document.createElement('div');
  chunkModeField.className = 'export-dialog-field';
  const chunkModeLabel = document.createElement('div');
  chunkModeLabel.className = 'export-dialog-field-label';
  chunkModeLabel.textContent = t('main.exportDialog.vocoderChunkMode');
  chunkModeField.appendChild(chunkModeLabel);

  const chunkModeRow = document.createElement('div');
  chunkModeRow.className = 'chunk-mode-row';
  const smartLabel = document.createElement('label');
  smartLabel.className = 'chunk-mode-label';
  const smartRadio = document.createElement('input');
  smartRadio.type = 'radio';
  smartRadio.name = 'export-chunk-mode';
  smartRadio.value = 'smart';
  smartRadio.checked = form.vocoderChunkMode === 'smart';
  smartLabel.appendChild(smartRadio);
  smartLabel.appendChild(document.createTextNode(t('main.exportDialog.vocoderChunkSmart')));

  const manualLabel = document.createElement('label');
  manualLabel.className = 'chunk-mode-label';
  const manualRadio = document.createElement('input');
  manualRadio.type = 'radio';
  manualRadio.name = 'export-chunk-mode';
  manualRadio.value = 'manual';
  manualRadio.checked = form.vocoderChunkMode === 'manual';
  manualLabel.appendChild(manualRadio);
  manualLabel.appendChild(document.createTextNode(t('main.exportDialog.vocoderChunkManual')));
  chunkModeRow.appendChild(smartLabel);
  chunkModeRow.appendChild(manualLabel);
  chunkModeField.appendChild(chunkModeRow);
  content.appendChild(chunkModeField);

  // 分片长度（仅 manual 模式显示）
  const chunkFramesField = buildRangeField({
    labelKey: 'main.exportDialog.vocoderChunkFrames',
    min: 256, max: 2048, step: 8,
    value: form.vocoderChunkFrames,
    onChange: (v) => { form.vocoderChunkFrames = v; },
  });
  chunkFramesField.dataset.chunkFramesField = 'true';
  content.appendChild(chunkFramesField);

  const updateChunkFramesVisibility = () => {
    const isManual = (smartRadio.checked ? 'smart' : manualRadio.checked ? 'manual' : form.vocoderChunkMode) === 'manual';
    chunkFramesField.hidden = !isManual;
  };
  smartRadio.addEventListener('change', () => { form.vocoderChunkMode = 'smart'; updateChunkFramesVisibility(); });
  manualRadio.addEventListener('change', () => { form.vocoderChunkMode = 'manual'; updateChunkFramesVisibility(); });
  updateChunkFramesVisibility();

  // 显存释放选项
  content.appendChild(buildCheckboxField({
    labelKey: 'main.exportDialog.releaseDmlVram',
    checked: form.releaseDmlVramAfterSynthesis,
    onChange: (v) => { form.releaseDmlVramAfterSynthesis = v; },
  }));
  content.appendChild(buildCheckboxField({
    labelKey: 'main.exportDialog.releaseDiffStep',
    checked: form.releaseDiffStepBeforeVocoder,
    onChange: (v) => { form.releaseDiffStepBeforeVocoder = v; },
  }));

  // Task 5: Vocoder overlap frames (8-96, default 32)
  content.appendChild(buildRangeField({
    labelKey: 'main.exportDialog.vocoderOverlapFrames',
    min: 8, max: 96, step: 4,
    value: form.vocoderOverlapFrames,
    onChange: (v) => { form.vocoderOverlapFrames = v; },
  }));

  // Task 10: Loudnorm toggle (default on)
  content.appendChild(buildCheckboxField({
    labelKey: 'main.exportDialog.enableLoudnormFinal',
    descKey: 'main.exportDialog.enableLoudnormFinalHint',
    checked: form.enableLoudnormFinal,
    onChange: (v) => { form.enableLoudnormFinal = v; },
  }));

  // Task 16: Anti-aliasing toggle (default off)
  content.appendChild(buildCheckboxField({
    labelKey: 'main.exportDialog.enableAntiAliasing',
    descKey: 'main.exportDialog.enableAntiAliasingHint',
    checked: form.enableAntiAliasing,
    onChange: (v) => { form.enableAntiAliasing = v; },
  }));

  // Task 17: SDEdit repair toggle (default off)
  content.appendChild(buildCheckboxField({
    labelKey: 'main.exportDialog.enableSDEditRepair',
    descKey: 'main.exportDialog.enableSDEditRepairHint',
    checked: form.enableSDEditRepair,
    onChange: (v) => { form.enableSDEditRepair = v; },
  }));

  // Task 2: Diagnostic mode toggle (default off)
  content.appendChild(buildCheckboxField({
    labelKey: 'main.exportDialog.diagnosticMode',
    descKey: 'main.exportDialog.diagnosticModeHint',
    checked: form.diagnosticMode,
    onChange: (v) => { form.diagnosticMode = v; },
  }));

  updateSifiganPrecisionVisibility(content, form);

  return section;
}

function updateSifiganPrecisionVisibility(content, form) {
  const group = content.querySelector('[data-sifigan-group="true"]');
  if (group) group.hidden = form.vocoderType !== 'sifigan';
}

function buildOutputSection(form) {
  const section = document.createElement('div');
  section.className = 'export-dialog-section';
  section.appendChild(buildSectionTitle('main.exportDialog.outputSection'));

  const hint = document.createElement('div');
  hint.className = 'export-dialog-field-hint';
  hint.textContent = t('main.exportDialog.outputHint');
  section.appendChild(hint);

  const row = document.createElement('div');
  row.className = 'export-dialog-path-row';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = form.outputPath;
  input.placeholder = t('main.exportDialog.outputHint');
  input.addEventListener('input', () => { form.outputPath = input.value; });
  row.appendChild(input);

  const browseBtn = document.createElement('button');
  browseBtn.className = 'export-dialog-browse-btn';
  browseBtn.type = 'button';
  const browseIcon = createIcon ? createIcon('folder-open') : null;
  if (browseIcon) browseBtn.appendChild(browseIcon);
  browseBtn.appendChild(document.createTextNode(t('main.exportDialog.browse')));
  browseBtn.addEventListener('click', async () => {
    const result = await window.electronAPI.showSaveDialog({
      title: t('main.exportDialog.title'),
      defaultPath: form.outputPath || undefined,
      filters: [{ name: 'WAV Audio', extensions: ['wav'] }],
    });
    if (!result.canceled && result.filePath) {
      form.outputPath = result.filePath;
      input.value = result.filePath;
    }
  });
  row.appendChild(browseBtn);

  section.appendChild(row);
  return section;
}

// ==================== 通用控件 ====================

function buildRangeField(opts) {
  const field = document.createElement('div');
  field.className = 'export-dialog-field';

  const label = document.createElement('div');
  label.className = 'export-dialog-field-label';
  const labelText = document.createElement('span');
  labelText.textContent = t(opts.labelKey);
  const valueBox = document.createElement('span');
  valueBox.className = 'export-dialog-field-value';
  valueBox.textContent = opts.format ? opts.format(opts.value) : opts.value;
  label.appendChild(labelText);
  label.appendChild(valueBox);

  const slider = document.createElement('input');
  slider.type = 'range';
  slider.min = opts.min;
  slider.max = opts.max;
  slider.step = opts.step;
  slider.value = opts.value;

  // Optional warning hint element. When `opts.warning(v)` returns a non-empty
  // string, the hint is shown below the slider; the value is still applied
  // (no clamping/blocking).
  let warnEl = null;
  const updateWarning = (v) => {
    if (typeof opts.warning !== 'function') return;
    const msg = opts.warning(v);
    if (msg) {
      if (!warnEl) {
        warnEl = document.createElement('div');
        warnEl.className = 'export-dialog-field-hint export-dialog-field-warn';
        field.appendChild(warnEl);
      }
      warnEl.textContent = msg;
      warnEl.hidden = false;
    } else if (warnEl) {
      warnEl.hidden = true;
    }
  };

  slider.addEventListener('input', () => {
    const v = parseFloat(slider.value);
    valueBox.textContent = opts.format ? opts.format(v) : v;
    opts.onChange(v);
    updateWarning(v);
  });

  field.appendChild(label);
  field.appendChild(slider);
  // Initialize warning visibility for the starting value.
  updateWarning(parseFloat(slider.value));
  return field;
}

function buildCheckboxField(opts) {
  const label = document.createElement('label');
  label.className = 'export-dialog-checkbox';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = !!opts.checked;
  cb.addEventListener('change', () => opts.onChange(cb.checked));

  const content = document.createElement('div');
  content.className = 'export-dialog-checkbox-content';
  const labelText = document.createElement('div');
  labelText.className = 'export-dialog-checkbox-label';
  labelText.textContent = t(opts.labelKey);
  content.appendChild(labelText);
  if (opts.descKey) {
    const desc = document.createElement('div');
    desc.className = 'export-dialog-checkbox-desc';
    desc.textContent = t(opts.descKey);
    content.appendChild(desc);
  }

  label.appendChild(cb);
  label.appendChild(content);
  return label;
}

// ==================== 开始导出 ====================

async function onStartClick(form, settings, panel, body, footer, fullCleanup) {
  // 校验输出路径
  if (!form.outputPath || !form.outputPath.trim()) {
    showAlertDialog(t('main.exportDialog.selectPathFirst'));
    return;
  }
  const trimmedPath = form.outputPath.trim();
  if (!trimmedPath.toLowerCase().endsWith('.wav')) {
    form.outputPath = trimmedPath + '.wav';
  } else {
    form.outputPath = trimmedPath;
  }

  // 检测精度是否变更（用于显示提示）
  const precisionChanged = (settings.modelPrecision || 'fp32') !== form.modelPrecision;

  // 保存设置（触发 pipeline 重置如果精度变化）
  const settingsToSave = {
    modelPrecision: form.modelPrecision,
    exportDiffSteps: form.exportDiffSteps,
    exportCfgStrength: form.exportCfgStrength,
    exportCfgRescale: form.exportCfgRescale,
    exportSampler: form.exportSampler,
    vocoderType: form.vocoderType,
    sifiganPrecision: form.sifiganPrecision,
    vocoderChunkMode: form.vocoderChunkMode,
    vocoderChunkFrames: form.vocoderChunkFrames,
    releaseDmlVramAfterSynthesis: form.releaseDmlVramAfterSynthesis,
    releaseDiffStepBeforeVocoder: form.releaseDiffStepBeforeVocoder,
    // Task 11/17/18: new settings keys
    exportCfgScheduleMode: form.exportCfgScheduleMode,
    exportCfgStrengthStart: form.exportCfgStrengthStart,
    exportCfgScheduleKeyframes: form.exportCfgScheduleKeyframes,
    // M5: preview CFG schedule mirrors
    previewCfgScheduleMode: form.previewCfgScheduleMode,
    previewCfgStrengthStart: form.previewCfgStrengthStart,
    previewCfgScheduleKeyframes: form.previewCfgScheduleKeyframes,
    vocoderOverlapFrames: form.vocoderOverlapFrames,
    diagnosticMode: form.diagnosticMode,
    enableLoudnormFinal: form.enableLoudnormFinal,
    enableAntiAliasing: form.enableAntiAliasing,
    enableSDEditRepair: form.enableSDEditRepair,
    exportSampleRate: form.outputSampleRate,
  };

  // 禁用开始按钮，显示保存中状态
  const startBtn = footer.querySelector('.export-dialog-btn-primary');
  if (startBtn) {
    startBtn.disabled = true;
    startBtn.textContent = t('main.exportDialog.progressPreparing');
  }
  const cancelBtn = footer.querySelector('.export-dialog-btn-secondary');
  if (cancelBtn) cancelBtn.disabled = true;

  try {
    await window.electronAPI.saveSettings(settingsToSave);

    // 切换到进度视图
    showProgressView(panel, body, footer, form, precisionChanged, fullCleanup);
  } catch (err) {
    console.error('[ExportDialog] Failed to save settings:', err);
    if (startBtn) {
      startBtn.disabled = false;
      startBtn.textContent = t('main.exportDialog.startExport');
    }
    if (cancelBtn) cancelBtn.disabled = false;
    showAlertDialog(t('main.exportDialog.progressFailed') + ': ' + (err.message || ''));
  }
}

// ==================== 进度视图 ====================

function showProgressView(panel, body, footer, form, precisionChanged, fullCleanup) {
  // 清空 body 和 footer
  body.innerHTML = '';
  footer.innerHTML = '';

  // 进度视图容器
  const progressView = document.createElement('div');
  progressView.className = 'export-dialog-progress';
  body.appendChild(progressView);

  const percentEl = document.createElement('div');
  percentEl.className = 'export-dialog-progress-percent';
  percentEl.textContent = '0%';
  progressView.appendChild(percentEl);

  const statusBar = document.createElement('div');
  statusBar.className = 'export-dialog-progress-status';
  statusBar.textContent = t('main.exportDialog.progressPreparing');
  progressView.appendChild(statusBar);

  const precisionNote = document.createElement('div');
  precisionNote.className = 'export-dialog-field-hint';
  precisionNote.style.textAlign = 'center';
  if (precisionChanged) {
    precisionNote.textContent = t('main.exportDialog.precisionChanged');
  }
  progressView.appendChild(precisionNote);

  const progressBar = document.createElement('div');
  progressBar.className = 'export-dialog-progress-bar';
  const progressFill = document.createElement('div');
  progressFill.className = 'export-dialog-progress-bar-fill';
  progressBar.appendChild(progressFill);
  progressView.appendChild(progressBar);

  // 调整 panel 高度以适应进度视图
  panel.style.maxHeight = '90vh';

  const setProgress = (pct) => {
    const clamped = Math.max(0, Math.min(100, pct));
    percentEl.textContent = Math.round(clamped) + '%';
    progressFill.style.width = clamped + '%';
  };

  const setStatus = (statusKey, params) => {
    if (statusKey === 'progressSynthesizing') {
      const p = params?.progress ?? 0;
      statusBar.textContent = t('main.exportDialog.progressSynthesizing', { progress: Math.round(p) });
    } else {
      statusBar.textContent = t('main.exportDialog.' + statusKey, params);
    }
  };

  // 启动导出任务
  runExportTask(panel, body, footer, form, setProgress, setStatus, fullCleanup);
}

async function runExportTask(panel, body, footer, form, setProgress, setStatus, fullCleanup) {
  try {
    setProgress(0);
    setStatus('progressPreparing');

    const { mixedAudio, numChannels, maxDuration, fragmentCount } = await runExportJob({
      nSteps: form.exportDiffSteps,
      cfg: form.exportCfgStrength,
      cfgRescale: form.exportCfgRescale,
      sampler: form.exportSampler,
      autoShift: form.autoShift,
      // Task 11: CFG schedule opts
      cfgScheduleMode: form.exportCfgScheduleMode,
      cfgStrengthStart: form.exportCfgStrengthStart,
      cfgScheduleKeyframes: form.exportCfgScheduleKeyframes,
      // Dynamic thresholding (export path)
      dynamicThresholdEnabled: form.exportDynamicThresholdEnabled,
      dynamicThresholdPercentile: form.exportDynamicThresholdPercentile,
      // Keep the status percentage and progress bar on the same
      // whole-export scale. Per-fragment progress resets to 0 for every
      // fragment and previously made the two percentages disagree.
      onFragmentProgress: () => {},
      onOverallProgress: (pct) => {
        setProgress(pct);
        setStatus('progressSynthesizing', { progress: pct });
      },
      onStatus: (statusKey) => {
        setStatus(statusKey);
      },
    });

    setStatus('progressEncoding');
    setProgress(95);

    // 编码 WAV
    // B2: wavEncoder.js is now CommonJS — use require instead of dynamic import.
    const { encodeWav } = require('../audio/wavEncoder.js');
    const outputAudio = resampleForExport(mixedAudio, SAMPLE_RATE, form.outputSampleRate, numChannels || 1);
    const wavData = encodeWav(outputAudio, form.outputSampleRate, numChannels || 1);

    setStatus('progressSaving');
    setProgress(98);

    // 保存文件
    await window.electronAPI.saveFile(form.outputPath, wavData);

    setProgress(100);
    setStatus('progressDone');

    // 显示成功视图
    showSuccessView(body, footer, form.outputPath, maxDuration, fragmentCount, fullCleanup);

    // 自动打开导出位置
    try {
      await window.electronAPI.showItemInFolder(form.outputPath);
    } catch (err) {
      console.warn('[ExportDialog] Failed to open folder:', err.message);
    }

    // 同步工具栏 timeDisplay
    if (dom.timeDisplay) {
      try {
        const { formatTime } = await import('./uiControls.js');
        dom.timeDisplay.textContent = formatTime(maxDuration);
      } catch (_) {}
    }
  } catch (err) {
    console.error('[ExportDialog] Export failed:', err);
    setStatus('progressFailed');
    showFailureView(body, footer, err, fullCleanup);
  }
}

// ==================== 成功/失败视图 ====================

function showSuccessView(body, footer, outputPath, maxDuration, fragmentCount, fullCleanup) {
  body.innerHTML = '';

  const progressView = document.createElement('div');
  progressView.className = 'export-dialog-progress';
  body.appendChild(progressView);

  const result = document.createElement('div');
  result.className = 'export-dialog-progress-result';
  progressView.appendChild(result);

  const icon = document.createElement('div');
  icon.className = 'export-dialog-progress-result-icon';
  icon.textContent = '✓';
  result.appendChild(icon);

  const titleEl = document.createElement('div');
  titleEl.className = 'export-dialog-progress-status';
  titleEl.style.fontSize = 'var(--font-lg)';
  titleEl.style.fontWeight = '600';
  titleEl.style.color = 'var(--accent-fg)';
  titleEl.textContent = t('main.exportDialog.progressDone');
  result.appendChild(titleEl);

  const pathEl = document.createElement('div');
  pathEl.className = 'export-dialog-progress-result-path';
  pathEl.textContent = outputPath;
  result.appendChild(pathEl);

  const metaEl = document.createElement('div');
  metaEl.className = 'export-dialog-field-hint';
  metaEl.style.textAlign = 'center';
  metaEl.textContent = `${formatDuration(maxDuration)} · ${fragmentCount} fragments`;
  result.appendChild(metaEl);

  // Footer 按钮
  footer.innerHTML = '';
  const openFolderBtn = document.createElement('button');
  openFolderBtn.className = 'export-dialog-btn export-dialog-btn-secondary';
  openFolderBtn.textContent = t('main.exportDialog.openFolder');
  openFolderBtn.addEventListener('click', async () => {
    try {
      await window.electronAPI.showItemInFolder(outputPath);
    } catch (_) {}
  });
  footer.appendChild(openFolderBtn);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'export-dialog-btn export-dialog-btn-primary';
  closeBtn.textContent = t('main.exportDialog.close');
  closeBtn.addEventListener('click', fullCleanup);
  footer.appendChild(closeBtn);

  requestAnimationFrame(() => closeBtn.focus());
}

function showFailureView(body, footer, err, fullCleanup) {
  body.innerHTML = '';

  const progressView = document.createElement('div');
  progressView.className = 'export-dialog-progress';
  body.appendChild(progressView);

  const result = document.createElement('div');
  result.className = 'export-dialog-progress-result';
  progressView.appendChild(result);

  const icon = document.createElement('div');
  icon.className = 'export-dialog-progress-result-icon error';
  icon.textContent = '✕';
  result.appendChild(icon);

  const titleEl = document.createElement('div');
  titleEl.className = 'export-dialog-progress-status';
  titleEl.style.fontSize = 'var(--font-lg)';
  titleEl.style.fontWeight = '600';
  titleEl.style.color = '#ef4444';
  titleEl.textContent = t('main.exportDialog.progressFailed');
  result.appendChild(titleEl);

  const msgEl = document.createElement('div');
  msgEl.className = 'export-dialog-progress-result-path';
  msgEl.textContent = err.message || String(err);
  result.appendChild(msgEl);

  // Footer 按钮
  footer.innerHTML = '';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'export-dialog-btn export-dialog-btn-primary';
  closeBtn.textContent = t('main.exportDialog.close');
  closeBtn.addEventListener('click', fullCleanup);
  footer.appendChild(closeBtn);

  requestAnimationFrame(() => closeBtn.focus());
}

// ==================== 工具函数 ====================

function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function buildDefaultOutputPath(fileName) {
  // 渲染进程无法访问 fs/os/path，直接返回文件名作为默认值。
  // 用户点击"浏览..."时，showSaveDialog 会以系统默认目录（通常为文档）+ 此文件名打开。
  return fileName;
}
