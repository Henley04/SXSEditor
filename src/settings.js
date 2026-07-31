import './common.css';
import './settings.css';
import { t, initI18n, applyLocale, setLocale, getLocale } from './i18n/index.js';
import { initWindowTheme } from './themes/themeInit.js';
import { createIcon, hydrateIcons } from './icons/iconHelper.js';
import {
    themeManager,
    TOKEN_CATALOG,
    BUILTIN_THEMES,
    computeIsDarkFromTokens as computeIsDark,
    validate,
    normalize,
} from './themes/index.js';

const inferenceProviderSelect = document.getElementById('inferenceProvider');
const inferenceProviderHint = document.getElementById('inferenceProviderHint');
const inferenceDeviceSelect = document.getElementById('inferenceDevice');
const deviceSelectGroup = document.getElementById('deviceSelectGroup');
const webnnStatusGroup = document.getElementById('webnnStatusGroup');
const webnnStatusValue = document.getElementById('webnnStatusValue');
const npuStatusValue = document.getElementById('npuStatusValue');
const gpuStatusValue = document.getElementById('gpuStatusValue');
const advancedSettingsGroup = document.getElementById('advancedSettingsGroup');
const modelDeviceMappingDiv = document.getElementById('modelDeviceMapping');
const deviceModeRadios = document.querySelectorAll('input[name="deviceMode"]');
const previewDiffStepsSlider = document.getElementById('previewDiffSteps');
const previewDiffStepsValue = document.getElementById('previewDiffStepsValue');
const previewSamplerSelect = document.getElementById('previewSampler');
const previewCfgStrengthSlider = document.getElementById('previewCfgStrength');
const previewCfgStrengthValue = document.getElementById('previewCfgStrengthValue');
const previewCfgRescaleSlider = document.getElementById('previewCfgRescale');
const previewCfgRescaleValue = document.getElementById('previewCfgRescaleValue');
// P1: CFG 强度调度（低→高）UI 引用
const previewCfgScheduleModeSelect = document.getElementById('previewCfgScheduleMode');
const previewCfgScheduleCurveGroup = document.getElementById('previewCfgScheduleCurveGroup');
const previewCfgScheduleEndGroup = document.getElementById('previewCfgScheduleEndGroup');
const previewCfgScheduleStartStrengthSlider = document.getElementById('previewCfgScheduleStartStrength');
const previewCfgScheduleStartStrengthValue = document.getElementById('previewCfgScheduleStartStrengthValue');
const previewCfgScheduleEndStrengthSlider = document.getElementById('previewCfgScheduleEndStrength');
const previewCfgScheduleEndStrengthValue = document.getElementById('previewCfgScheduleEndStrengthValue');
const previewDiffStepChunkEnabledCheckbox = document.getElementById('previewDiffStepChunkEnabled');
const previewDiffStepChunkGroup = document.getElementById('previewDiffStepChunkGroup');
const previewDiffStepChunkFramesSlider = document.getElementById('previewDiffStepChunkFrames');
const previewDiffStepChunkFramesValue = document.getElementById('previewDiffStepChunkFramesValue');
const previewDiffStepOverlapFramesSlider = document.getElementById('previewDiffStepOverlapFrames');
const previewDiffStepOverlapFramesValue = document.getElementById('previewDiffStepOverlapFramesValue');
const exportDiffStepsSlider = document.getElementById('exportDiffSteps');
const exportDiffStepsValue = document.getElementById('exportDiffStepsValue');
const exportSamplerSelect = document.getElementById('exportSampler');
const exportCfgStrengthSlider = document.getElementById('exportCfgStrength');
const exportCfgStrengthValue = document.getElementById('exportCfgStrengthValue');
const exportCfgRescaleSlider = document.getElementById('exportCfgRescale');
const exportCfgRescaleValue = document.getElementById('exportCfgRescaleValue');
// P1: CFG 强度调度（低→高）UI 引用（导出）
const exportCfgScheduleModeSelect = document.getElementById('exportCfgScheduleMode');
const exportCfgScheduleCurveGroup = document.getElementById('exportCfgScheduleCurveGroup');
const exportCfgScheduleEndGroup = document.getElementById('exportCfgScheduleEndGroup');
const exportCfgScheduleStartStrengthSlider = document.getElementById('exportCfgScheduleStartStrength');
const exportCfgScheduleStartStrengthValue = document.getElementById('exportCfgScheduleStartStrengthValue');
const exportCfgScheduleEndStrengthSlider = document.getElementById('exportCfgScheduleEndStrength');
const exportCfgScheduleEndStrengthValue = document.getElementById('exportCfgScheduleEndStrengthValue');
const audioOutputModeSelect = document.getElementById('audioOutputMode');
const audioOutputDeviceSelect = document.getElementById('audioOutputDevice');
const audioSampleRateSelect = document.getElementById('audioSampleRate');
const audioBitDepthSelect = document.getElementById('audioBitDepth');
const audioBufferSizeSelect = document.getElementById('audioBufferSize');
const audioVolumeSlider = document.getElementById('audioVolume');
const volumeValueSpan = document.getElementById('volumeValue');
const exclusiveInfoDiv = document.getElementById('exclusiveInfo');
const languageSelect = document.getElementById('languageSelect');
const modelPrecisionSelect = document.getElementById('modelPrecision');
const midiExtractToolSelect = document.getElementById('midiExtractTool');
const openModelDownloadBtn = document.getElementById('openModelDownloadBtn');
const openModelDownloadBtnTop = document.getElementById('openModelDownloadBtnTop');

// 模型状态总览区元素引用（聚合主模型/JP/SiFiGAN 三类模型状态）
const modelOverviewMainDot = document.getElementById('overviewMainDotSettings');
const modelOverviewMainStatus = document.getElementById('overviewMainStatusText');
const modelOverviewMainVersion = document.getElementById('overviewMainVersion');
const modelOverviewMainPrecision = document.getElementById('overviewMainPrecision');
const modelOverviewJpDot = document.getElementById('overviewJpDotSettings');
const modelOverviewJpStatus = document.getElementById('overviewJpStatusText');
const modelOverviewJpVersion = document.getElementById('overviewJpVersion');
const modelOverviewSifiganDot = document.getElementById('overviewSifiganDotSettings');
const modelOverviewSifiganStatus = document.getElementById('overviewSifiganStatusText');
const modelOverviewSifiganVersion = document.getElementById('overviewSifiganVersion');
const vocoderTypeSelect = document.getElementById('vocoderType');
const vocoderTypeHint = document.getElementById('vocoderTypeHint');
const sifiganPrecisionSelect = document.getElementById('sifiganPrecision');
const sifiganPrecisionGroup = document.getElementById('sifiganPrecisionGroup');
const japaneseVocalizationRadios = document.querySelectorAll('input[name="japaneseVocalization"]');
const vocoderChunkModeRadios = document.querySelectorAll('input[name="vocoderChunkMode"]');
const vocoderChunkManualGroup = document.getElementById('vocoderChunkManualGroup');
const vocoderChunkFramesSlider = document.getElementById('vocoderChunkFrames');
const vocoderChunkFramesValue = document.getElementById('vocoderChunkFramesValue');
const vocoderChunkSmartInfo = document.getElementById('vocoderChunkSmartInfo');
const vocoderChunkSmartText = document.getElementById('vocoderChunkSmartText');
const vocoderChunkTableBody = document.getElementById('vocoderChunkTableBody');
const vocoderChunkTableGroup = document.getElementById('vocoderChunkTableGroup');
const releaseDmlVramAfterSynthesisCheckbox = document.getElementById('releaseDmlVramAfterSynthesis');
const releaseDiffStepBeforeVocoderCheckbox = document.getElementById('releaseDiffStepBeforeVocoder');

// ORT advanced settings
const ortEnableMemPatternCheckbox = document.getElementById('ortEnableMemPattern');
const ortEnableCpuMemArenaCheckbox = document.getElementById('ortEnableCpuMemArena');
const ortGraphOptLevelSelect = document.getElementById('ortGraphOptLevel');
const ortExecutionModeSelect = document.getElementById('ortExecutionMode');
const ortForceMemPatternOnDmlCheckbox = document.getElementById('ortForceMemPatternOnDml');
const ortIntraOpNumThreadsSlider = document.getElementById('ortIntraOpNumThreads');
const ortIntraOpNumThreadsValue = document.getElementById('ortIntraOpNumThreadsValue');
const ortInterOpNumThreadsSlider = document.getElementById('ortInterOpNumThreads');
const ortInterOpNumThreadsValue = document.getElementById('ortInterOpNumThreadsValue');
const ortLogSeverityLevelSelect = document.getElementById('ortLogSeverityLevel');

const updateChannelSelect = document.getElementById('updateChannelSelect');
const autoCheckUpdatesCheckbox = document.getElementById('autoCheckUpdates');
const checkUpdateBtn = document.getElementById('checkUpdateBtn');
const updateCheckStatus = document.getElementById('updateCheckStatus');
const updateResultGroup = document.getElementById('updateResultGroup');
const updateResultBox = document.getElementById('updateResultBox');
const reEnableReminderGroup = document.getElementById('reEnableReminderGroup');
const reEnableReminderBtn = document.getElementById('reEnableReminderBtn');

// Device mode radio button handlers
const MODEL_GROUPS = [
    { id: 'svsDiffusion', labelKey: 'settings.modelGroupSvsDiffusion' },
    { id: 'svsEncoder', labelKey: 'settings.modelGroupSvsEncoder' },
    { id: 'svsAuxiliary', labelKey: 'settings.modelGroupSvsAuxiliary' },
    { id: 'rmvpe', labelKey: 'settings.modelGroupRmvpe' },
    { id: 'rosvot', labelKey: 'settings.modelGroupRosvot' },
];

let cachedDevices = [];
let cachedWebnnInfo = null;

/**
 * 立即应用已保存的设置到 UI（在硬件检测完成前显示正确的值）
 */
function applySavedSettingsToUI(currentSetting) {
    if (!currentSetting) return;

    // Inference provider
    const inferenceProvider = currentSetting.inferenceProvider === 'ortweb' ? 'ortweb' : 'ortnode';
    if (inferenceProviderSelect) {
        inferenceProviderSelect.value = inferenceProvider;
        updateInferenceProviderHint(inferenceProvider);
    }

    // Device mode
    const deviceMode = currentSetting.deviceMode || 'smart';
    const radioToCheck = document.querySelector(`input[name="deviceMode"][value="${deviceMode}"]`);
    if (radioToCheck) radioToCheck.checked = true;
    updateDeviceModeUI(deviceMode);

    // Diffusion sliders
    const pSteps = currentSetting.previewDiffSteps ?? 16;
    const pCfg = currentSetting.previewCfgStrength ?? 3.0;
    const pRescale = currentSetting.previewCfgRescale ?? 0.75;
    const pSampler = currentSetting.previewSampler || 'stork2';
    previewDiffStepsSlider.value = pSteps;
    previewDiffStepsValue.textContent = pSteps;
    if (previewSamplerSelect) previewSamplerSelect.value = pSampler;
    previewCfgStrengthSlider.value = pCfg;
    previewCfgStrengthValue.textContent = parseFloat(pCfg).toFixed(1);
    previewCfgRescaleSlider.value = pRescale;
    previewCfgRescaleValue.textContent = parseFloat(pRescale).toFixed(2);

    // P1: CFG 强度调度（低→高）—— 预览
    const pSchedMode = ['fixed', 'linear', 'cosine'].includes(currentSetting.previewCfgScheduleMode)
        ? currentSetting.previewCfgScheduleMode : 'cosine';
    const pSchedStart = Number.isFinite(currentSetting.previewCfgScheduleStartStrength)
        ? currentSetting.previewCfgScheduleStartStrength : 1.0;
    const pSchedEnd = Number.isFinite(currentSetting.previewCfgScheduleEndStrength)
        ? currentSetting.previewCfgScheduleEndStrength : pCfg;
    if (previewCfgScheduleModeSelect) previewCfgScheduleModeSelect.value = pSchedMode;
    if (previewCfgScheduleStartStrengthSlider) previewCfgScheduleStartStrengthSlider.value = pSchedStart;
    if (previewCfgScheduleStartStrengthValue) previewCfgScheduleStartStrengthValue.textContent = parseFloat(pSchedStart).toFixed(2);
    if (previewCfgScheduleEndStrengthSlider) previewCfgScheduleEndStrengthSlider.value = pSchedEnd;
    if (previewCfgScheduleEndStrengthValue) previewCfgScheduleEndStrengthValue.textContent = parseFloat(pSchedEnd).toFixed(2);
    updateCfgScheduleVisibility('preview', pSchedMode);

    // diffStep 分块推理设置
    const pChunkEnabled = currentSetting.previewDiffStepChunkEnabled === true;
    const pChunkFrames = currentSetting.previewDiffStepChunkFrames ?? 500;
    const pOverlapFrames = currentSetting.previewDiffStepOverlapFrames ?? 50;
    if (previewDiffStepChunkEnabledCheckbox) previewDiffStepChunkEnabledCheckbox.checked = pChunkEnabled;
    if (previewDiffStepChunkGroup) previewDiffStepChunkGroup.classList.toggle('hidden', !pChunkEnabled);
    if (previewDiffStepChunkFramesSlider) previewDiffStepChunkFramesSlider.value = pChunkFrames;
    if (previewDiffStepChunkFramesValue) previewDiffStepChunkFramesValue.textContent = pChunkFrames;
    if (previewDiffStepOverlapFramesSlider) previewDiffStepOverlapFramesSlider.value = pOverlapFrames;
    if (previewDiffStepOverlapFramesValue) previewDiffStepOverlapFramesValue.textContent = pOverlapFrames;

    const eSteps = currentSetting.exportDiffSteps ?? 32;
    const eCfg = currentSetting.exportCfgStrength ?? 3.0;
    const eRescale = currentSetting.exportCfgRescale ?? 0.75;
    const eSampler = currentSetting.exportSampler || 'stork2';
    exportDiffStepsSlider.value = eSteps;
    exportDiffStepsValue.textContent = eSteps;
    if (exportSamplerSelect) exportSamplerSelect.value = eSampler;
    exportCfgStrengthSlider.value = eCfg;
    exportCfgStrengthValue.textContent = parseFloat(eCfg).toFixed(1);
    exportCfgRescaleSlider.value = eRescale;
    exportCfgRescaleValue.textContent = parseFloat(eRescale).toFixed(2);

    // P1: CFG 强度调度（低→高）—— 导出
    const eSchedMode = ['fixed', 'linear', 'cosine'].includes(currentSetting.exportCfgScheduleMode)
        ? currentSetting.exportCfgScheduleMode : 'cosine';
    const eSchedStart = Number.isFinite(currentSetting.exportCfgScheduleStartStrength)
        ? currentSetting.exportCfgScheduleStartStrength : 1.0;
    const eSchedEnd = Number.isFinite(currentSetting.exportCfgScheduleEndStrength)
        ? currentSetting.exportCfgScheduleEndStrength : eCfg;
    if (exportCfgScheduleModeSelect) exportCfgScheduleModeSelect.value = eSchedMode;
    if (exportCfgScheduleStartStrengthSlider) exportCfgScheduleStartStrengthSlider.value = eSchedStart;
    if (exportCfgScheduleStartStrengthValue) exportCfgScheduleStartStrengthValue.textContent = parseFloat(eSchedStart).toFixed(2);
    if (exportCfgScheduleEndStrengthSlider) exportCfgScheduleEndStrengthSlider.value = eSchedEnd;
    if (exportCfgScheduleEndStrengthValue) exportCfgScheduleEndStrengthValue.textContent = parseFloat(eSchedEnd).toFixed(2);
    updateCfgScheduleVisibility('export', eSchedMode);

    // Audio settings
    if (currentSetting.audioOutputMode) audioOutputModeSelect.value = currentSetting.audioOutputMode;
    if (currentSetting.audioSampleRate) audioSampleRateSelect.value = String(currentSetting.audioSampleRate);
    if (currentSetting.audioBitDepth) audioBitDepthSelect.value = currentSetting.audioBitDepth;
    if (currentSetting.audioBufferSize) audioBufferSizeSelect.value = String(currentSetting.audioBufferSize);
    if (currentSetting.audioVolume !== undefined) {
        audioVolumeSlider.value = Math.round(currentSetting.audioVolume * 100);
        volumeValueSpan.textContent = Math.round(currentSetting.audioVolume * 100) + '%';
    }

    // Language & precision
    languageSelect.value = getLocale();
    if (currentSetting.modelPrecision) {
        modelPrecisionSelect.value = currentSetting.modelPrecision;
    } else {
        modelPrecisionSelect.value = 'fp32';
    }

    // MIDI tool
    if (currentSetting.midiExtractTool) {
        const tool = currentSetting.midiExtractTool === 'rosvot' ? 'rmvpe' : currentSetting.midiExtractTool;
        midiExtractToolSelect.value = tool;
    } else {
        midiExtractToolSelect.value = 'basicpitch';
    }

    // Vocoder type (main process may have overridden 'sifigan' -> 'default' at startup)
    vocoderTypeSelect.value = currentSetting.vocoderType === 'sifigan' ? 'sifigan' : 'default';

    // SiFiGAN precision (only meaningful when vocoderType === 'sifigan')
    sifiganPrecisionSelect.value = currentSetting.sifiganPrecision === 'fp16' ? 'fp16' : 'fp32';
    updateSifiganPrecisionVisibility(vocoderTypeSelect.value);

    // Japanese vocalization mode: 'hybrid' (default, improved mapping) | 'en-phonemes' (original mapping) | 'jp-lora' (in development, disabled)
    const validJpVocalizations = ['en-phonemes', 'hybrid', 'jp-lora'];
    const jpVocalization = validJpVocalizations.includes(currentSetting.japaneseVocalization) ? currentSetting.japaneseVocalization : 'hybrid';
    const jpVocalRadioToCheck = document.querySelector(`input[name="japaneseVocalization"][value="${jpVocalization}"]`);
    if (jpVocalRadioToCheck) jpVocalRadioToCheck.checked = true;

    // Vocoder chunk mode (smart/manual)
    const vocoderChunkMode = currentSetting.vocoderChunkMode === 'manual' ? 'manual' : 'smart';
    const vcRadioToCheck = document.querySelector(`input[name="vocoderChunkMode"][value="${vocoderChunkMode}"]`);
    if (vcRadioToCheck) vcRadioToCheck.checked = true;
    updateVocoderChunkModeUI(vocoderChunkMode);

    // Vocoder chunk frames (manual mode)
    const vcFrames = Number.isFinite(currentSetting.vocoderChunkFrames) ? currentSetting.vocoderChunkFrames : 1008;
    vocoderChunkFramesSlider.value = vcFrames;
    vocoderChunkFramesValue.textContent = vcFrames;

    // Audio exclusive mode
    const isExclusive = audioOutputModeSelect.value === 'exclusive';
    exclusiveInfoDiv.classList.toggle('hidden', !isExclusive);
    audioBitDepthSelect.disabled = !isExclusive;

    // DML 显存回收选项（默认关闭，仅 DML 后端有效）
    if (releaseDmlVramAfterSynthesisCheckbox) {
        releaseDmlVramAfterSynthesisCheckbox.checked = currentSetting.releaseDmlVramAfterSynthesis === true;
    }
    // Vocoder 推理前释放 diffStep（默认开启，仅 DML 后端有效）
    if (releaseDiffStepBeforeVocoderCheckbox) {
        releaseDiffStepBeforeVocoderCheckbox.checked = currentSetting.releaseDiffStepBeforeVocoder !== false;
    }

    // ORT 高级设置
    if (ortEnableMemPatternCheckbox) {
        ortEnableMemPatternCheckbox.checked = currentSetting.ortEnableMemPattern !== false;
    }
    if (ortEnableCpuMemArenaCheckbox) {
        ortEnableCpuMemArenaCheckbox.checked = currentSetting.ortEnableCpuMemArena !== false;
    }
    if (ortGraphOptLevelSelect) {
        const lvl = ['disabled', 'basic', 'extended', 'all'].includes(currentSetting.ortGraphOptLevel)
            ? currentSetting.ortGraphOptLevel : 'all';
        ortGraphOptLevelSelect.value = lvl;
    }
    if (ortExecutionModeSelect) {
        const m = currentSetting.ortExecutionMode === 'parallel' ? 'parallel' : 'sequential';
        ortExecutionModeSelect.value = m;
    }
    if (ortForceMemPatternOnDmlCheckbox) {
        ortForceMemPatternOnDmlCheckbox.checked = currentSetting.ortForceMemPatternOnDml === true;
    }
    if (ortIntraOpNumThreadsSlider) {
        const v = Number.isFinite(currentSetting.ortIntraOpNumThreads) && currentSetting.ortIntraOpNumThreads > 0
            ? Math.min(64, Math.floor(currentSetting.ortIntraOpNumThreads)) : 0;
        ortIntraOpNumThreadsSlider.value = v;
        if (ortIntraOpNumThreadsValue) ortIntraOpNumThreadsValue.textContent = v;
    }
    if (ortInterOpNumThreadsSlider) {
        const v = Number.isFinite(currentSetting.ortInterOpNumThreads) && currentSetting.ortInterOpNumThreads > 0
            ? Math.min(64, Math.floor(currentSetting.ortInterOpNumThreads)) : 0;
        ortInterOpNumThreadsSlider.value = v;
        if (ortInterOpNumThreadsValue) ortInterOpNumThreadsValue.textContent = v;
    }
    if (ortLogSeverityLevelSelect) {
        const lvl = ['verbose', 'info', 'warning', 'error', 'fatal'].includes(currentSetting.ortLogSeverityLevel)
            ? currentSetting.ortLogSeverityLevel : 'warning';
        ortLogSeverityLevelSelect.value = lvl;
    }

    // Update channel & auto-check (persisted via saveSettings)
    if (updateChannelSelect) {
        const channel = currentSetting.updateChannel === 'nightly' ? 'nightly' : 'release';
        updateChannelSelect.value = channel;
    }
    if (autoCheckUpdatesCheckbox) {
        autoCheckUpdatesCheckbox.checked = currentSetting.autoCheckUpdates !== false;
    }
}

function getDeviceTypeLabel(deviceType) {
    switch (deviceType) {
        case 'discrete-gpu': return t('settings.discreteGpu');
        case 'integrated-gpu': return t('settings.integratedGpu');
        case 'npu': return t('settings.npuLabel');
        case 'webnn-gpu': return t('settings.webnnGpuDevice');
        case 'cpu': return t('settings.cpuLabel');
        default: return deviceType || '';
    }
}

function getDeviceOptionText(d) {
    const vramStr = d.vram ? ` (${d.vram})` : '';
    const typeStr = getDeviceTypeLabel(d.deviceType);
    const npuTag = d.deviceType === 'npu' ? ' [NPU(WebNN)]' : '';
    const webnnGpuTag = d.deviceType === 'webnn-gpu' ? ' [WebNN GPU]' : '';
    return `${d.name}${vramStr} ${typeStr}${npuTag}${webnnGpuTag}`;
}

function updateInferenceProviderHint(provider) {
    if (!inferenceProviderHint) return;
    if (provider === 'ortweb') {
        inferenceProviderHint.textContent = t('settings.inferenceProviderHintOrtweb');
    } else {
        inferenceProviderHint.textContent = t('settings.inferenceProviderHintOrtnode');
    }
}

function updateDeviceModeUI(mode) {
    const isManual = mode === 'manual';
    const isAdvanced = mode === 'advanced';

    inferenceDeviceSelect.disabled = !isManual;
    advancedSettingsGroup.classList.toggle('hidden', !isAdvanced);

    if (isAdvanced) {
        buildModelDeviceMapping();
    }
}

// ==================== Vocoder chunk frames (smart/manual) ====================

function updateVocoderChunkModeUI(mode) {
    const isManual = mode === 'manual';
    vocoderChunkManualGroup.classList.toggle('hidden', !isManual);
    // 智能模式下显示自动分配结果信息框；手动模式下隐藏（用户已自行指定）
    if (vocoderChunkSmartInfo) {
        vocoderChunkSmartInfo.classList.toggle('hidden', isManual);
    }
    // 对照表在两种模式下都显示，作为参考信息
}

let _vocoderChunkInfoLoaded = false;
let _currentVramGb = 0; // 当前显卡显存（GB），用于对照表高亮

async function loadVocoderChunkFramesInfo() {
    if (!window.electronAPI?.getVocoderChunkFramesInfo) return;
    try {
        const info = await window.electronAPI.getVocoderChunkFramesInfo();
        // 检测未完成时不覆盖（保持默认提示文字，等启动后再次刷新）
        if (info.gpuPhase !== 'full') return;
        _vocoderChunkInfoLoaded = true;
        const gb = info.bestVramBytes / (1024 * 1024 * 1024);
        _currentVramGb = gb;
        const gpuName = info.bestGpuName || '';
        const vramStr = gb > 0 ? `${gb.toFixed(1)}GB` : '未知';
        const text = t('settings.vocoderChunkSmartResult', {
            frames: info.smartFrames,
            vram: vramStr,
            gpu: gpuName || t('settings.unknownGpu'),
        });
        if (vocoderChunkSmartText) {
            vocoderChunkSmartText.textContent = text;
        }
        // 智能分配结果加载完成后，刷新对照表以高亮当前显卡对应的行
        loadVocoderChunkFramesTable();
    } catch (err) {
        console.error('[Settings] Failed to load vocoder chunk frames info:', err);
    }
}

/**
 * 加载并渲染不同显存档位下的 vocoder 分片对照表。
 * 当精度或 vocoder 类型切换时由对应的事件监听器调用，重新刷新。
 */
async function loadVocoderChunkFramesTable() {
    if (!vocoderChunkTableBody || !window.electronAPI?.getVocoderChunkFramesTable) return;
    try {
        const rows = await window.electronAPI.getVocoderChunkFramesTable();
        if (!Array.isArray(rows) || rows.length === 0) {
            vocoderChunkTableBody.innerHTML = `<tr><td colspan="4">${t('settings.vocoderChunkTableEmpty')}</td></tr>`;
            return;
        }
        // 当前显卡显存对应的档位：选取 ≤ _currentVramGb 的最大档位（即实际会落入的分档）
        // 注意：这里用档位值本身做匹配，因为对照表中的 frames 是该档位显存下的推荐值
        let currentTierGb = 0;
        if (_currentVramGb > 0) {
            for (const r of rows) {
                if (r.tierGb <= _currentVramGb) currentTierGb = r.tierGb;
            }
        }
        const rowsHtml = rows.map((r) => {
            const isCurrent = r.tierGb === currentTierGb && currentTierGb > 0;
            const budgetStr = r.budgetGb > 0 ? `${r.budgetGb.toFixed(2)}GB` : '—';
            const durStr = `${r.approxSeconds.toFixed(1)}s`;
            const currentBadge = isCurrent
                ? `<span class="vram-current-badge">${t('settings.vocoderChunkTableCurrent')}</span>`
                : '';
            return `<tr class="${isCurrent ? 'vram-row-current' : ''}">
                <td>${r.tierGb}GB${currentBadge}</td>
                <td>${budgetStr}</td>
                <td>${r.frames}</td>
                <td>${durStr}</td>
            </tr>`;
        }).join('');
        vocoderChunkTableBody.innerHTML = rowsHtml;
    } catch (err) {
        console.error('[Settings] Failed to load vocoder chunk frames table:', err);
        vocoderChunkTableBody.innerHTML = `<tr><td colspan="4">${t('settings.vocoderChunkTableEmpty')}</td></tr>`;
    }
}

// ==================== Vocoder type (SiFiGAN) ====================

/**
 * 通过现有 IPC 检测 SiFiGAN 模型文件是否存在。
 * 复用 getModelDir + authorizePath + fileExists，不新增 IPC。
 */
async function checkSifiganVocoderFiles() {
    try {
        const modelDir = await window.electronAPI.getModelDir();
        if (!modelDir) return { onnxExists: false, statsExists: false };
        // 授权模型目录，使 file:exists 可访问其内部文件
        await window.electronAPI.authorizePath(modelDir);
        const base = modelDir.replace(/[\\/]+$/, '');
        // SiFiGAN onnx 变体: FP16 优先, FP32 DML 优化版回退, FP32 plain 兜底
        const [fp16Exists, fp32DmlExists, fp32PlainExists, statsExists] = await Promise.all([
            window.electronAPI.fileExists(base + '/sifigan_vocoder_dml_fp16.onnx'),
            window.electronAPI.fileExists(base + '/sifigan_vocoder_dml.onnx'),
            window.electronAPI.fileExists(base + '/sifigan_vocoder.onnx'),
            window.electronAPI.fileExists(base + '/sifigan_stats.joblib'),
        ]);
        const onnxExists = !!(fp16Exists || fp32DmlExists || fp32PlainExists);
        return { onnxExists, statsExists };
    } catch (err) {
        console.error('[Settings] Failed to detect SiFiGAN model files:', err);
        return { onnxExists: false, statsExists: false };
    }
}

/**
 * 根据文件检测结果更新 sifigan 选项的禁用状态与提示文字。
 * 若当前选中 sifigan 但模型文件不存在，自动回退到 default（仅 UI，不主动持久化）。
 */
function updateVocoderTypeUI(fileStatus) {
    const sifiganOption = vocoderTypeSelect.querySelector('option[value="sifigan"]');
    if (!sifiganOption) return;
    const { onnxExists, statsExists } = fileStatus;
    if (onnxExists) {
        sifiganOption.disabled = false;
        sifiganOption.textContent = 'SiFiGAN';
        if (vocoderTypeHint) {
            vocoderTypeHint.textContent = statsExists
                ? 'SiFiGAN 已安装'
                : 'SiFiGAN 模型已就绪，但统计文件缺失，输入归一化可能不可用';
        }
    } else {
        sifiganOption.disabled = true;
        sifiganOption.textContent = 'SiFiGAN（未下载）';
        if (vocoderTypeHint) {
            vocoderTypeHint.textContent = 'SiFiGAN 未下载，可在模型下载页获取后手动放置';
        }
    }
    // 若当前选中 sifigan 但文件不存在，显示警告并回退到 default
    if (vocoderTypeSelect.value === 'sifigan' && !onnxExists) {
        vocoderTypeSelect.value = 'default';
        if (vocoderTypeHint) {
            vocoderTypeHint.textContent = 'SiFiGAN 模型文件不存在，已自动回退到默认 Vocoder';
        }
    }
    // SiFiGAN 精度下拉框仅在选择 SiFiGAN 时可见
    updateSifiganPrecisionVisibility(vocoderTypeSelect.value);
}

/**
 * SiFiGAN 精度选择下拉框的显隐控制：仅当 vocoderType === 'sifigan' 时显示。
 * @param {string} vocoderType - 'default' | 'sifigan'
 */
function updateSifiganPrecisionVisibility(vocoderType) {
    if (!sifiganPrecisionGroup) return;
    sifiganPrecisionGroup.classList.toggle('hidden', vocoderType !== 'sifigan');
}

/**
 * P1: 根据 CFG 调度模式显示/隐藏 start/end 强度滑块。
 * 'fixed' 模式下隐藏（用上方常量 cfgStrength），'linear'/'cosine' 模式下显示。
 */
function updateCfgScheduleVisibility(prefix, mode) {
    const curveGroup = (prefix === 'preview') ? previewCfgScheduleCurveGroup : exportCfgScheduleCurveGroup;
    const endGroup = (prefix === 'preview') ? previewCfgScheduleEndGroup : exportCfgScheduleEndGroup;
    const show = (mode === 'linear' || mode === 'cosine');
    if (curveGroup) curveGroup.classList.toggle('hidden', !show);
    if (endGroup) endGroup.classList.toggle('hidden', !show);
}

const PRECISION_LABELS = {
    'fp32': 'FP32',
    'fp16': 'FP16',
    'int8': 'INT8',
    'int8-npu': 'INT8-NPU',
};

function updateModelStatusDisplay(modelStatus) {
    const el = document.getElementById('modelStatusList');
    if (!el || !modelStatus) return;
    el.innerHTML = '';
    for (const [prec, status] of Object.entries(modelStatus)) {
        const item = document.createElement('div');
        item.className = 'model-status-item';
        const dot = document.createElement('span');
        dot.className = 'model-status-dot ' + (status.ready ? 'ready' : 'missing');
        const label = document.createElement('span');
        label.className = 'model-status-label';
        label.textContent = PRECISION_LABELS[prec] || prec;
        const info = document.createElement('span');
        info.className = 'model-status-info';
        info.textContent = status.ready ? t('settings.modelReady') : t('settings.modelMissing', { count: status.missing });
        item.appendChild(dot);
        item.appendChild(label);
        item.appendChild(info);
        el.appendChild(item);
    }
}

// ==================== 模型状态总览区 ====================
// 聚合主模型/JP/SiFiGAN 三类模型的安装与版本状态，使用 model-download:check-all-versions
// 一次性获取三类模型的版本信息，避免多次 IPC 调用。
// 兼容旧版本：若 IPC 不可用或返回异常，总览区保持默认"检测中..."状态，不影响其他功能。

function _setOverviewCard(dotEl, statusEl, versionEl, dotState, statusText, versionText, statusClass) {
    if (dotEl) dotEl.className = 'model-overview-dot ' + dotState;
    if (statusEl) {
        statusEl.textContent = statusText;
        statusEl.className = 'model-overview-status' + (statusClass ? ' ' + statusClass : '');
    }
    if (versionEl) versionEl.textContent = versionText || '';
}

/**
 * 解析单个模型组的版本信息，返回 { dotState, statusText, versionText, statusClass }
 * dotState: 'installed' | 'missing' | 'warning' | 'checking'
 * 与 modelDownload.js 中的 updateOverviewStatus 保持一致的语义。
 */
function _resolveOverviewState(info, opts = {}) {
    const { isDownloading = false } = opts;
    if (isDownloading) {
        return {
            dotState: 'checking',
            statusText: t('modelDownload.overviewDownloading'),
            versionText: '',
            statusClass: 'checking',
        };
    }
    if (!info) {
        return {
            dotState: 'checking',
            statusText: t('settings.modelOverviewChecking'),
            versionText: '',
            statusClass: 'checking',
        };
    }
    // SiFiGAN 特殊状态：download_url_not_configured（视为未安装，无可用下载源）
    if (info.status === 'download_url_not_configured' || info.status === 'not_downloaded') {
        return {
            dotState: 'missing',
            statusText: t('settings.modelOverviewMissing'),
            versionText: '',
            statusClass: 'missing',
        };
    }
    if (info.hasModelFiles === false && !info.allExist) {
        return {
            dotState: 'missing',
            statusText: t('settings.modelOverviewMissing'),
            versionText: '',
            statusClass: 'missing',
        };
    }
    // 已安装：根据 updateAvailable 进一步区分
    const installed = info.hasModelFiles === true || info.allExist === true || info.updateAvailable !== undefined;
    if (!installed) {
        return {
            dotState: 'missing',
            statusText: t('settings.modelOverviewMissing'),
            versionText: '',
            statusClass: 'missing',
        };
    }
    if (info.updateAvailable) {
        return {
            dotState: 'warning',
            statusText: t('settings.modelOverviewUpdateAvailable'),
            versionText: _formatVersionLine(info),
            statusClass: 'warning',
        };
    }
    return {
        dotState: 'installed',
        statusText: t('settings.modelOverviewInstalled'),
        versionText: _formatVersionLine(info),
        statusClass: 'installed',
    };
}

function _formatVersionLine(info) {
    if (!info) return '';
    const localRaw = info.localVersion;
    const localStr = (!localRaw || localRaw === 'master')
        ? t('settings.modelOverviewLegacyVersion')
        : localRaw;
    const latestStr = info.latestVersion || '-';
    // 仅当存在本地版本时才显示版本行，避免未安装时显示多余信息
    if (!localRaw && !info.latestVersion) return '';
    return `${t('settings.modelOverviewVersionLocal', { version: localStr })}  ·  ${t('settings.modelOverviewVersionLatest', { version: latestStr })}`;
}

/**
 * 刷新模型状态总览区。调用 model-download:check-all-versions 一次性获取
 * 主模型/JP/SiFiGAN 的版本信息并更新 UI。
 * 在以下场景调用：
 *  - 设置页面加载完成
 *  - 精度切换后
 *  - 模型下载窗口关闭后（用户可能下载/更新了模型）
 */
async function refreshModelOverview() {
    // 若总览区不在 DOM 中（旧版 HTML），直接跳过
    if (!modelOverviewMainDot && !modelOverviewJpDot && !modelOverviewSifiganDot) return;
    // 显示检测中状态
    _setOverviewCard(modelOverviewMainDot, modelOverviewMainStatus, modelOverviewMainVersion, 'checking', t('settings.modelOverviewChecking'), '');
    _setOverviewCard(modelOverviewJpDot, modelOverviewJpStatus, modelOverviewJpVersion, 'checking', t('settings.modelOverviewChecking'), '');
    _setOverviewCard(modelOverviewSifiganDot, modelOverviewSifiganStatus, modelOverviewSifiganVersion, 'checking', t('settings.modelOverviewChecking'), '');

    // 显示当前精度标签
    if (modelOverviewMainPrecision) {
        const prec = modelPrecisionSelect.value || 'fp32';
        modelOverviewMainPrecision.textContent = PRECISION_LABELS[prec] || prec;
    }

    if (!window.electronAPI?.modelDownloadCheckAllVersions) return;
    try {
        const precision = modelPrecisionSelect.value || 'fp32';
        const result = await window.electronAPI.modelDownloadCheckAllVersions(precision);
        const mainInfo = result?.main;
        const jpInfo = result?.jp;
        const sifiganInfo = result?.sifigan;

        const mainState = _resolveOverviewState(mainInfo);
        _setOverviewCard(modelOverviewMainDot, modelOverviewMainStatus, modelOverviewMainVersion,
            mainState.dotState, mainState.statusText, mainState.versionText, mainState.statusClass);

        const jpState = _resolveOverviewState(jpInfo);
        _setOverviewCard(modelOverviewJpDot, modelOverviewJpStatus, modelOverviewJpVersion,
            jpState.dotState, jpState.statusText, jpState.versionText, jpState.statusClass);

        // SiFiGAN: 当 status === 'download_url_not_configured' 时也视为未安装
        const sifiganState = _resolveOverviewState(sifiganInfo);
        _setOverviewCard(modelOverviewSifiganDot, modelOverviewSifiganStatus, modelOverviewSifiganVersion,
            sifiganState.dotState, sifiganState.statusText, sifiganState.versionText, sifiganState.statusClass);
    } catch (err) {
        console.error('[Settings] Failed to refresh model overview:', err);
        // IPC 失败时显示"检测中..."，不影响其他功能
    }
}

async function loadDevices() {
    try {
        // 立即显示加载状态
        for (const el of [webnnStatusValue, npuStatusValue, gpuStatusValue]) {
            if (!el) continue;
            el.textContent = t('settings.webnnChecking');
            el.classList.remove('status-available', 'status-unavailable');
            el.classList.add('status-checking');
        }

        // 先加载已保存的设置，立即应用到 UI（避免显示 HTML 默认值）
        const currentSetting = await window.electronAPI.getSettings();
        window._currentSetting = currentSetting;
        applySavedSettingsToUI(currentSetting);
        // 设置加载完成后刷新模型状态总览区：初次调用（initI18n 触发）时 DOM 下拉框
        // 仍是 HTML 默认值 'fp32'，会按错误精度扫描模型目录。此处 DOM 已更新为用户
        // 保存的精度，重新刷新以覆盖错误结果。注意：精度切换的 change 事件仍读 DOM
        // 当前值（预览未保存的新值），此处的二次调用不影响该路径。
        refreshModelOverview().catch(() => {});
        const provider = currentSetting?.inferenceProvider || 'ortnode';

        // 再获取设备列表（硬件检测可能较慢）
        const allDevices = await window.electronAPI.getDMLDevices();
        const hasNpu = allDevices.some(d => d.deviceType === 'npu');
        const hasWebnnGpu = allDevices.some(d => d.deviceType === 'webnn-gpu');
        cachedWebnnInfo = {
            webnnAvailable: hasNpu || hasWebnnGpu,
            npuAvailable: hasNpu,
            gpuAvailable: hasWebnnGpu,
        };

        // 根据推理提供者过滤可选项：ORTNODE 仅显示本地 GPU/CPU；ORTWEB 仅显示 WebNN NPU/GPU
        const devices = provider === 'ortweb'
            ? allDevices.filter(d => d.deviceType === 'npu' || d.deviceType === 'webnn-gpu')
            : allDevices.filter(d => d.deviceType !== 'npu' && d.deviceType !== 'webnn-gpu');
        cachedDevices = devices;

        // 获取当前硬件信息（可能为 null 如果管道未初始化）
        const hardwareInfo = await window.electronAPI.getCurrentHardware();

        // 更新 WebNN/NPU/GPU 状态指示器
        if (cachedWebnnInfo.webnnAvailable) {
            webnnStatusValue.textContent = t('settings.webnnAvailable');
            webnnStatusValue.classList.add('status-available');
            webnnStatusValue.classList.remove('status-unavailable', 'status-checking');
        } else {
            webnnStatusValue.textContent = t('settings.webnnNotAvailable');
            webnnStatusValue.classList.add('status-unavailable');
            webnnStatusValue.classList.remove('status-available', 'status-checking');
        }
        if (cachedWebnnInfo.npuAvailable) {
            npuStatusValue.textContent = t('settings.npuAvailable');
            npuStatusValue.classList.add('status-available');
            npuStatusValue.classList.remove('status-unavailable', 'status-checking');
        } else {
            npuStatusValue.textContent = t('settings.npuNotAvailable');
            npuStatusValue.classList.add('status-unavailable');
            npuStatusValue.classList.remove('status-available', 'status-checking');
        }
        if (cachedWebnnInfo.gpuAvailable) {
            gpuStatusValue.textContent = t('settings.webnnGpuAvailable');
            gpuStatusValue.classList.add('status-available');
            gpuStatusValue.classList.remove('status-unavailable', 'status-checking');
        } else {
            gpuStatusValue.textContent = t('settings.webnnGpuNotAvailable');
            gpuStatusValue.classList.add('status-unavailable');
            gpuStatusValue.classList.remove('status-available', 'status-checking');
        }

        inferenceDeviceSelect.innerHTML = '';

        const discreteGPUs = devices.filter(d => d.deviceType === 'discrete-gpu' || d.isDiscrete);
        const autoLabel = provider === 'ortnode' && discreteGPUs.length > 0
            ? t('settings.autoSelectPreferDiscrete', { name: discreteGPUs[0].name })
            : t('settings.autoSelect');
        const autoOption = document.createElement('option');
        autoOption.value = 'auto';
        autoOption.textContent = autoLabel;
        inferenceDeviceSelect.appendChild(autoOption);

        for (const d of devices) {
            const option = document.createElement('option');
            if (d.deviceType === 'npu') {
                option.value = 'npu';
            } else if (d.deviceType === 'webnn-gpu') {
                option.value = 'webnn-gpu';
            } else {
                option.value = String(d.dxgiAdapterNumber);
            }
            option.textContent = getDeviceOptionText(d);
            option.dataset.deviceType = d.deviceType || (d.isDiscrete ? 'discrete-gpu' : 'integrated-gpu');
            inferenceDeviceSelect.appendChild(option);
        }

        // Restore device selection from settings（若当前 provider 下不可用则回退 auto）
        const preferredId = currentSetting?.preferredDeviceId ?? currentSetting?.deviceId ?? null;
        const desiredValue = preferredId !== null ? String(preferredId) : 'auto';
        const validValues = new Set(Array.from(inferenceDeviceSelect.options).map(o => o.value));
        inferenceDeviceSelect.value = validValues.has(desiredValue) ? desiredValue : 'auto';

        updateCurrentHardwareDisplay(hardwareInfo, devices, currentSetting);

        // Load audio device list (needs hardware detection for device enumeration)
        await loadAudioDevices();
    } catch (err) {
        console.error('Failed to load device list:', err);
        inferenceDeviceSelect.textContent = '';
        const opt = document.createElement('option');
        opt.value = 'auto';
        opt.textContent = t('settings.autoSelect');
        inferenceDeviceSelect.appendChild(opt);
    }
}

function updateCurrentHardwareDisplay(hardwareInfo, devices, currentSetting) {
    const textEl = document.getElementById('currentHardwareText');
    if (!textEl) return;

    const deviceMode = currentSetting?.deviceMode || 'smart';

    if (hardwareInfo) {
        const gpuName = hardwareInfo.gpuDeviceName || t('settings.cpuOnly');
        const dmlCount = hardwareInfo.dmlModelCount || 0;
        const cpuCount = hardwareInfo.cpuModelCount || 0;
        const webnnCount = hardwareInfo.webnnModelCount || 0;
        const total = hardwareInfo.totalModels || 0;

        // Determine device type label
        let deviceTypeLabel = '';
        if (hardwareInfo.isUsingWebNN) {
            deviceTypeLabel = ` ${t('settings.npuLabel')}`;
        } else if (hardwareInfo.dmlDeviceId !== undefined && hardwareInfo.dmlDeviceId !== null) {
            const matchedDevice = devices.find(d => d.dxgiAdapterNumber === hardwareInfo.dmlDeviceId);
            if (matchedDevice) {
                deviceTypeLabel = ` ${getDeviceTypeLabel(matchedDevice.deviceType || (matchedDevice.isDiscrete ? 'discrete-gpu' : 'integrated-gpu'))}`;
            }
        }

        const epParts = [];
        if (webnnCount > 0) epParts.push(t('settings.webnnModels', { count: webnnCount, total }));
        if (dmlCount > 0) epParts.push(t('settings.dmlModels', { count: dmlCount, total }));
        if (cpuCount > 0) epParts.push(t('settings.cpuModels', { count: cpuCount, total }));
        const epDetail = epParts.length > 0 ? ` (${epParts.join(', ')})` : '';

        let deviceIdStr = '';
        if (!hardwareInfo.isUsingWebNN && hardwareInfo.dmlDeviceId !== undefined && hardwareInfo.dmlDeviceId !== null) {
            deviceIdStr = ` [deviceId=${hardwareInfo.dmlDeviceId}]`;
        }

        const provider = currentSetting?.inferenceProvider || 'ortnode';
        const providerLabel = provider === 'ortweb' ? 'ORTWEB / ' : 'ORTNODE / ';
        textEl.textContent = `${providerLabel}${gpuName}${deviceTypeLabel}${deviceIdStr}${epDetail}`;
        return;
    }

    if (!devices || devices.length === 0) {
        textEl.textContent = t('settings.noGpuDetected');
        return;
    }

    const provider = currentSetting?.inferenceProvider || 'ortnode';
    const providerLabel = provider === 'ortweb' ? 'ORTWEB / ' : 'ORTNODE / ';

    const selectedDeviceId = currentSetting && (currentSetting.preferredDeviceId !== undefined && currentSetting.preferredDeviceId !== null)
        ? currentSetting.preferredDeviceId
        : (currentSetting && currentSetting.deviceId !== undefined && currentSetting.deviceId !== null ? currentSetting.deviceId : null);

    if (selectedDeviceId !== null) {
        // WebNN/NPU devices match by deviceType, local GPU by dxgiAdapterNumber
        let selected;
        if (selectedDeviceId === 'npu') {
            selected = devices.find(d => d.deviceType === 'npu');
        } else if (selectedDeviceId === 'webnn-gpu') {
            selected = devices.find(d => d.deviceType === 'webnn-gpu');
        } else {
            selected = devices.find(d => d.dxgiAdapterNumber === selectedDeviceId);
        }
        if (selected) {
            const vramStr = selected.vram ? ` (${selected.vram})` : '';
            const typeLabel = getDeviceTypeLabel(selected.deviceType || (selected.isDiscrete ? 'discrete-gpu' : 'integrated-gpu'));
            const webnnTag = selected.deviceType === 'npu' ? ' [NPU(WebNN)]' : (selected.deviceType === 'webnn-gpu' ? ' [WebNN GPU]' : '');
            textEl.textContent = `${providerLabel}${selected.name}${vramStr} ${typeLabel}${webnnTag} [deviceId=${selectedDeviceId}] ${t('settings.pendingInit')}`;
            return;
        }
    }

    // Auto mode — show "自动选择" with best device hint, matching the dropdown display
    if (provider === 'ortweb') {
        const best = devices.find(d => d.deviceType === 'npu') || devices.find(d => d.deviceType === 'webnn-gpu');
        if (best) {
            const typeLabel = getDeviceTypeLabel(best.deviceType);
            textEl.textContent = `${providerLabel}${t('settings.autoSelect')}: ${best.name} ${typeLabel} ${t('settings.pendingInit')}`;
            return;
        }
    }

    const discrete = devices.filter(d => d.deviceType === 'discrete-gpu' || d.isDiscrete);
    if (discrete.length > 0) {
        const best = discrete.sort((a, b) => (b.vramBytes || 0) - (a.vramBytes || 0))[0];
        textEl.textContent = `${providerLabel}${t('settings.autoSelectPreferDiscrete', { name: best.name })} ${t('settings.pendingInit')}`;
    } else {
        const best = devices.sort((a, b) => (b.vramBytes || 0) - (a.vramBytes || 0))[0];
        const vramStr = best?.vram ? ` (${best.vram})` : '';
        textEl.textContent = best
            ? `${providerLabel}${t('settings.autoSelect')}: ${best.name}${vramStr} ${getDeviceTypeLabel(best.deviceType || (best.isDiscrete ? 'discrete-gpu' : 'integrated-gpu'))} ${t('settings.pendingInit')}`
            : `${providerLabel}${t('settings.noGpuDetected')}`;
    }
}

function buildModelDeviceMapping() {
    if (!modelDeviceMappingDiv) return;
    modelDeviceMappingDiv.innerHTML = '';

    const currentSetting = window._currentSetting || {};
    const existingMapping = currentSetting.modelDeviceMapping || {};

    for (const group of MODEL_GROUPS) {
        const row = document.createElement('div');
        row.className = 'model-mapping-row';

        const label = document.createElement('span');
        label.className = 'model-mapping-label';
        label.textContent = t(group.labelKey);

        const select = document.createElement('select');
        select.className = 'model-mapping-select';
        select.dataset.groupId = group.id;

        // Auto option
        const autoOpt = document.createElement('option');
        autoOpt.value = 'auto';
        autoOpt.textContent = t('settings.autoAssign');
        select.appendChild(autoOpt);

        // Populate with available devices
        for (const d of cachedDevices) {
            const opt = document.createElement('option');
            if (d.deviceType === 'npu') {
                opt.value = 'npu';
            } else if (d.deviceType === 'webnn-gpu') {
                opt.value = 'webnn-gpu';
            } else {
                opt.value = String(d.dxgiAdapterNumber);
            }
            opt.textContent = getDeviceOptionText(d);
            select.appendChild(opt);
        }

        // Restore saved mapping
        const savedValue = existingMapping[group.id];
        if (savedValue !== undefined) {
            select.value = String(savedValue);
        }

        row.appendChild(label);
        row.appendChild(select);
        modelDeviceMappingDiv.appendChild(row);
    }
}

/**
 * 加载音频设备列表（需要 IPC 获取设备信息）
 * 注意：音频设置值已在 applySavedSettingsToUI 中提前应用
 */
async function loadAudioDevices() {
    try {
        const audioResult = await window.electronAPI.getAudioDevices();
        const audioDevices = audioResult.devices || [];
        const isAudioAvailable = audioResult.isAvailable || false;

        if (!isAudioAvailable) {
            audioOutputModeSelect.textContent = '';
            const opt = document.createElement('option');
            opt.value = 'shared';
            opt.textContent = t('settings.sharedModeUnavailable');
            audioOutputModeSelect.appendChild(opt);
            audioOutputModeSelect.disabled = true;
            audioBitDepthSelect.disabled = true;
        }

        populateAudioDevices(audioDevices);

        // Restore audio output device selection (needs populated dropdown)
        const currentSetting = window._currentSetting;
        if (currentSetting && currentSetting.audioOutputDevice !== undefined) {
            audioOutputDeviceSelect.value = String(currentSetting.audioOutputDevice);
        }

        const isExclusive = audioOutputModeSelect.value === 'exclusive';
        audioBitDepthSelect.disabled = !isExclusive || !isAudioAvailable;
    } catch (err) {
        console.error('Failed to load audio device list:', err);
    }
}

function populateAudioDevices(audioDevices) {
    audioOutputDeviceSelect.innerHTML = `<option value="-1">${t('settings.systemDefault')}</option>`;

    for (const d of audioDevices) {
        const option = document.createElement('option');
        option.value = String(d.id);
        const hostApiStr = d.hostAPI ? ` [${d.hostAPI}]` : '';
        const srStr = d.defaultSampleRate ? ` (${d.defaultSampleRate}Hz)` : '';
        option.textContent = `${d.name}${hostApiStr}${srStr}`;
        audioOutputDeviceSelect.appendChild(option);
    }
}

async function updateAudioDeviceList() {
    try {
        const audioResult = await window.electronAPI.getAudioDevices();
        const audioDevices = audioResult.devices || [];
        const currentValue = audioOutputDeviceSelect.value;
        populateAudioDevices(audioDevices);
        if (currentValue && audioOutputDeviceSelect.querySelector(`option[value="${currentValue}"]`)) {
            audioOutputDeviceSelect.value = currentValue;
        }
    } catch (err) {
        console.error('Failed to update audio device list:', err);
    }
}

// ==================== Auto-apply settings ====================

let _saveDebounce = null;

function collectSettings() {
    const deviceModeRadio = document.querySelector('input[name="deviceMode"]:checked');
    const deviceMode = deviceModeRadio ? deviceModeRadio.value : 'smart';
    const inferenceProvider = inferenceProviderSelect ? inferenceProviderSelect.value : 'ortnode';

    // 仅在 manual 模式下从 inferenceDeviceSelect 提取 preferredDeviceId/preferredDeviceType/deviceId。
    // smart/advanced 模式下这些字段保持 undefined，让 settingsIpc.saveSettings 跳过它们，
    // 避免用 null 覆盖之前 manual 模式保存的具体设备 ID（否则切回 manual 时自定义设备会丢失，
    // 且 main.js 启动验证会误弹 "deviceId=null not found" 对话框）。
    let preferredDeviceId;
    let preferredDeviceType;
    if (deviceMode === 'manual') {
        const inferenceValue = inferenceDeviceSelect.value;
        preferredDeviceId = inferenceValue === 'auto'
            ? null
            : (inferenceValue === 'npu' || inferenceValue === 'webnn-gpu' ? inferenceValue : parseInt(inferenceValue));
        preferredDeviceType = null;
        if (preferredDeviceId !== null) {
            if (preferredDeviceId === 'npu' || preferredDeviceId === 'webnn-gpu') {
                preferredDeviceType = preferredDeviceId;
            } else {
                const selectedOption = inferenceDeviceSelect.options[inferenceDeviceSelect.selectedIndex];
                preferredDeviceType = selectedOption?.dataset?.deviceType || null;
            }
        }
    }

    let modelDeviceMapping = {};
    if (deviceMode === 'advanced') {
        const mappingSelects = modelDeviceMappingDiv.querySelectorAll('.model-mapping-select');
        mappingSelects.forEach(sel => {
            const groupId = sel.dataset.groupId;
            const val = sel.value;
            modelDeviceMapping[groupId] = val === 'auto'
                ? 'auto'
                : (val === 'npu' || val === 'webnn-gpu' ? val : parseInt(val));
        });
    }

    return {
        deviceMode,
        inferenceProvider,
        preferredDeviceId,
        preferredDeviceType,
        modelDeviceMapping,
        deviceId: preferredDeviceId,
        previewDiffSteps: parseInt(previewDiffStepsSlider.value),
        previewCfgStrength: parseFloat(previewCfgStrengthSlider.value),
        previewCfgRescale: parseFloat(previewCfgRescaleSlider.value),
        previewSampler: previewSamplerSelect ? previewSamplerSelect.value : 'stork2',
        previewDiffStepChunkEnabled: previewDiffStepChunkEnabledCheckbox ? previewDiffStepChunkEnabledCheckbox.checked : false,
        previewDiffStepChunkFrames: previewDiffStepChunkFramesSlider ? parseInt(previewDiffStepChunkFramesSlider.value) : 500,
        previewDiffStepOverlapFrames: previewDiffStepOverlapFramesSlider ? parseInt(previewDiffStepOverlapFramesSlider.value) : 50,
        exportDiffSteps: parseInt(exportDiffStepsSlider.value),
        exportCfgStrength: parseFloat(exportCfgStrengthSlider.value),
        exportCfgRescale: parseFloat(exportCfgRescaleSlider.value),
        exportSampler: exportSamplerSelect ? exportSamplerSelect.value : 'stork2',
        // P1: CFG 强度调度（低→高）
        previewCfgScheduleMode: previewCfgScheduleModeSelect ? previewCfgScheduleModeSelect.value : 'cosine',
        previewCfgScheduleStartStrength: previewCfgScheduleStartStrengthSlider ? parseFloat(previewCfgScheduleStartStrengthSlider.value) : 1.0,
        previewCfgScheduleEndStrength: previewCfgScheduleEndStrengthSlider ? parseFloat(previewCfgScheduleEndStrengthSlider.value) : 3.0,
        exportCfgScheduleMode: exportCfgScheduleModeSelect ? exportCfgScheduleModeSelect.value : 'cosine',
        exportCfgScheduleStartStrength: exportCfgScheduleStartStrengthSlider ? parseFloat(exportCfgScheduleStartStrengthSlider.value) : 1.0,
        exportCfgScheduleEndStrength: exportCfgScheduleEndStrengthSlider ? parseFloat(exportCfgScheduleEndStrengthSlider.value) : 3.0,
        audioOutputMode: audioOutputModeSelect.value,
        audioOutputDevice: parseInt(audioOutputDeviceSelect.value),
        audioSampleRate: parseInt(audioSampleRateSelect.value),
        audioBitDepth: audioBitDepthSelect.value,
        audioBufferSize: parseInt(audioBufferSizeSelect.value),
        audioVolume: parseInt(audioVolumeSlider.value) / 100,
        locale: languageSelect.value,
        modelPrecision: modelPrecisionSelect.value,
        midiExtractTool: midiExtractToolSelect.value,
        vocoderType: vocoderTypeSelect.value,
        sifiganPrecision: sifiganPrecisionSelect.value === 'fp16' ? 'fp16' : 'fp32',
        japaneseVocalization: (() => {
            const r = document.querySelector('input[name="japaneseVocalization"]:checked');
            return r ? r.value : 'hybrid';
        })(),
        vocoderChunkMode: (() => {
            const r = document.querySelector('input[name="vocoderChunkMode"]:checked');
            return r ? r.value : 'smart';
        })(),
        vocoderChunkFrames: parseInt(vocoderChunkFramesSlider.value),
        releaseDmlVramAfterSynthesis: releaseDmlVramAfterSynthesisCheckbox ? releaseDmlVramAfterSynthesisCheckbox.checked : false,
        releaseDiffStepBeforeVocoder: releaseDiffStepBeforeVocoderCheckbox ? releaseDiffStepBeforeVocoderCheckbox.checked : true,
        // ORT 高级设置
        ortEnableMemPattern: ortEnableMemPatternCheckbox ? ortEnableMemPatternCheckbox.checked : true,
        ortEnableCpuMemArena: ortEnableCpuMemArenaCheckbox ? ortEnableCpuMemArenaCheckbox.checked : true,
        ortGraphOptLevel: ortGraphOptLevelSelect ? ortGraphOptLevelSelect.value : 'all',
        ortExecutionMode: ortExecutionModeSelect ? ortExecutionModeSelect.value : 'sequential',
        ortForceMemPatternOnDml: ortForceMemPatternOnDmlCheckbox ? ortForceMemPatternOnDmlCheckbox.checked : false,
        ortIntraOpNumThreads: ortIntraOpNumThreadsSlider ? parseInt(ortIntraOpNumThreadsSlider.value) : 0,
        ortInterOpNumThreads: ortInterOpNumThreadsSlider ? parseInt(ortInterOpNumThreadsSlider.value) : 0,
        ortLogSeverityLevel: ortLogSeverityLevelSelect ? ortLogSeverityLevelSelect.value : 'warning',
        updateChannel: updateChannelSelect ? updateChannelSelect.value : 'release',
        autoCheckUpdates: autoCheckUpdatesCheckbox ? autoCheckUpdatesCheckbox.checked : true,
    };
}

async function applySettings(options = {}) {
    const settings = collectSettings();
    try {
        await window.electronAPI.saveSettings(settings);
        if (options.reloadLocale) {
            setLocale(settings.locale);
            // Locale change needs main window reload to apply UI language
            if (window.electronAPI?.reloadMainWindow) {
                window.electronAPI.reloadMainWindow().catch(() => {});
            }
        }
        // Other settings (device, audio, diffusion) are saved and take effect on next synthesis / app restart
        // No main window reload needed — avoids losing user's work
    } catch (err) {
        console.error('Failed to apply settings:', err);
    }
}

function applySettingsDebounced() {
    if (_saveDebounce) clearTimeout(_saveDebounce);
    _saveDebounce = setTimeout(() => applySettings(), 300);
}

// Inference provider select
if (inferenceProviderSelect) {
    inferenceProviderSelect.addEventListener('change', async () => {
        updateInferenceProviderHint(inferenceProviderSelect.value);
        await applySettings();
        await loadDevices();
    });
}

// Device mode radio buttons
deviceModeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
        updateDeviceModeUI(radio.value);
        applySettings();
        updateCurrentHardwareDisplay(null, cachedDevices, collectSettings());
    });
});

// Device select
inferenceDeviceSelect.addEventListener('change', () => {
    applySettings();
    updateCurrentHardwareDisplay(null, cachedDevices, collectSettings());
});

// Model mapping selects (advanced mode)
if (modelDeviceMappingDiv) {
    modelDeviceMappingDiv.addEventListener('change', (e) => {
        if (e.target.classList.contains('model-mapping-select')) {
            applySettings();
        }
    });
}

// Audio controls
audioOutputModeSelect.addEventListener('change', () => {
    const isExclusive = audioOutputModeSelect.value === 'exclusive';
    exclusiveInfoDiv.classList.toggle('hidden', !isExclusive);
    audioBitDepthSelect.disabled = !isExclusive;
    updateAudioDeviceList();
    applySettings();
});
audioOutputDeviceSelect.addEventListener('change', () => applySettings());
audioSampleRateSelect.addEventListener('change', () => applySettings());
audioBitDepthSelect.addEventListener('change', () => applySettings());
audioBufferSizeSelect.addEventListener('change', () => applySettings());
audioVolumeSlider.addEventListener('input', () => {
    volumeValueSpan.textContent = audioVolumeSlider.value + '%';
    applySettingsDebounced();
});

// Diffusion sliders
previewDiffStepsSlider.addEventListener('input', () => {
    previewDiffStepsValue.textContent = previewDiffStepsSlider.value;
    applySettingsDebounced();
});
previewCfgStrengthSlider.addEventListener('input', () => {
    previewCfgStrengthValue.textContent = parseFloat(previewCfgStrengthSlider.value).toFixed(1);
    applySettingsDebounced();
});
previewCfgRescaleSlider.addEventListener('input', () => {
    previewCfgRescaleValue.textContent = parseFloat(previewCfgRescaleSlider.value).toFixed(2);
    applySettingsDebounced();
});
// P1: CFG 强度调度 —— 预览
if (previewCfgScheduleModeSelect) {
    previewCfgScheduleModeSelect.addEventListener('change', () => {
        updateCfgScheduleVisibility('preview', previewCfgScheduleModeSelect.value);
        applySettings();
    });
}
if (previewCfgScheduleStartStrengthSlider) {
    previewCfgScheduleStartStrengthSlider.addEventListener('input', () => {
        previewCfgScheduleStartStrengthValue.textContent = parseFloat(previewCfgScheduleStartStrengthSlider.value).toFixed(2);
        applySettingsDebounced();
    });
}
if (previewCfgScheduleEndStrengthSlider) {
    previewCfgScheduleEndStrengthSlider.addEventListener('input', () => {
        previewCfgScheduleEndStrengthValue.textContent = parseFloat(previewCfgScheduleEndStrengthSlider.value).toFixed(2);
        applySettingsDebounced();
    });
}
// diffStep 分块推理设置
if (previewDiffStepChunkEnabledCheckbox) {
    previewDiffStepChunkEnabledCheckbox.addEventListener('change', () => {
        if (previewDiffStepChunkGroup) previewDiffStepChunkGroup.classList.toggle('hidden', !previewDiffStepChunkEnabledCheckbox.checked);
        applySettings();
    });
}
if (previewDiffStepChunkFramesSlider) {
    previewDiffStepChunkFramesSlider.addEventListener('input', () => {
        previewDiffStepChunkFramesValue.textContent = previewDiffStepChunkFramesSlider.value;
        applySettingsDebounced();
    });
}
if (previewDiffStepOverlapFramesSlider) {
    previewDiffStepOverlapFramesSlider.addEventListener('input', () => {
        previewDiffStepOverlapFramesValue.textContent = previewDiffStepOverlapFramesSlider.value;
        applySettingsDebounced();
    });
}
exportDiffStepsSlider.addEventListener('input', () => {
    exportDiffStepsValue.textContent = exportDiffStepsSlider.value;
    applySettingsDebounced();
});
exportCfgStrengthSlider.addEventListener('input', () => {
    exportCfgStrengthValue.textContent = parseFloat(exportCfgStrengthSlider.value).toFixed(1);
    applySettingsDebounced();
});
exportCfgRescaleSlider.addEventListener('input', () => {
    exportCfgRescaleValue.textContent = parseFloat(exportCfgRescaleSlider.value).toFixed(2);
    applySettingsDebounced();
});
// P1: CFG 强度调度 —— 导出
if (exportCfgScheduleModeSelect) {
    exportCfgScheduleModeSelect.addEventListener('change', () => {
        updateCfgScheduleVisibility('export', exportCfgScheduleModeSelect.value);
        applySettings();
    });
}
if (exportCfgScheduleStartStrengthSlider) {
    exportCfgScheduleStartStrengthSlider.addEventListener('input', () => {
        exportCfgScheduleStartStrengthValue.textContent = parseFloat(exportCfgScheduleStartStrengthSlider.value).toFixed(2);
        applySettingsDebounced();
    });
}
if (exportCfgScheduleEndStrengthSlider) {
    exportCfgScheduleEndStrengthSlider.addEventListener('input', () => {
        exportCfgScheduleEndStrengthValue.textContent = parseFloat(exportCfgScheduleEndStrengthSlider.value).toFixed(2);
        applySettingsDebounced();
    });
}

// Language, precision, MIDI tool
languageSelect.addEventListener('change', () => applySettings({ reloadLocale: true }));
modelPrecisionSelect.addEventListener('change', async () => {
    await applySettings(); // 等待保存 + pipeline 重置完成再刷新硬件显示
    // pipeline 已被重置，刷新"当前运行硬件"显示让用户确认精度切换生效
    updateCurrentHardwareDisplay(null, cachedDevices, collectSettings());
    // 刷新对照表（精度变化导致常驻权重不同，预算与分片数会变化）
    loadVocoderChunkFramesTable();
    // 刷新智能分配结果信息框（精度变化也会影响 smartFrames）
    _vocoderChunkInfoLoaded = false;
    loadVocoderChunkFramesInfo();
    // Check if models exist for the new precision, auto-open download if not
    try {
        const modelStatus = await window.electronAPI.checkModels();
        const prec = modelPrecisionSelect.value;
        const status = modelStatus[prec];
        updateModelStatusDisplay(modelStatus);
        if (status && !status.ready) {
            await window.electronAPI.modelDownloadOpen(prec);
        }
    } catch (_) {}
    // 精度切换后刷新模型状态总览区（不同精度对应不同主模型/JP 模型版本）
    refreshModelOverview().catch(() => {});
});
vocoderTypeSelect.addEventListener('change', () => {
    if (vocoderTypeSelect.value === 'sifigan') {
        const sifiganOption = vocoderTypeSelect.querySelector('option[value="sifigan"]');
        if (sifiganOption && sifiganOption.disabled) {
            // 选项被禁用时不应被选中（浏览器正常情况下无法选中），此处做保护性回退
            vocoderTypeSelect.value = 'default';
            if (vocoderTypeHint) {
                vocoderTypeHint.textContent = 'SiFiGAN 不可用，已回退到默认 Vocoder';
            }
            updateSifiganPrecisionVisibility('default');
            return;
        }
    }
    updateSifiganPrecisionVisibility(vocoderTypeSelect.value);
    applySettings();
    // 刷新对照表（vocoder 类型变化导致常驻权重表与分档表都不同）
    loadVocoderChunkFramesTable();
    // 刷新智能分配结果信息框
    _vocoderChunkInfoLoaded = false;
    loadVocoderChunkFramesInfo();
});
sifiganPrecisionSelect.addEventListener('change', () => {
    applySettings();
    // SiFiGAN 精度变化也会影响常驻权重（fp32 vs fp16），刷新对照表
    loadVocoderChunkFramesTable();
    _vocoderChunkInfoLoaded = false;
    loadVocoderChunkFramesInfo();
});

// Japanese vocalization mode (en-phonemes / jp-lora)
japaneseVocalizationRadios.forEach(radio => {
    radio.addEventListener('change', () => {
        applySettings();
    });
});

// Vocoder chunk mode (smart/manual) and manual frames slider
vocoderChunkModeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
        updateVocoderChunkModeUI(radio.value);
        applySettings();
    });
});
vocoderChunkFramesSlider.addEventListener('input', () => {
    // 强制对齐到 8 的倍数（与 VOCODER_OVERLAP_FRAMES 兼容）
    let v = parseInt(vocoderChunkFramesSlider.value);
    if (!Number.isFinite(v)) v = 1008;
    v = Math.round(v / 8) * 8;
    if (v != vocoderChunkFramesSlider.value) {
        vocoderChunkFramesSlider.value = v;
    }
    vocoderChunkFramesValue.textContent = v;
    applySettingsDebounced();
});

if (releaseDmlVramAfterSynthesisCheckbox) {
    releaseDmlVramAfterSynthesisCheckbox.addEventListener('change', () => applySettings());
}

if (releaseDiffStepBeforeVocoderCheckbox) {
    releaseDiffStepBeforeVocoderCheckbox.addEventListener('change', () => applySettings());
}

// ORT advanced settings — 修改后需要重置 pipeline（RESET_TRIGGER_KEYS 已在 main 端处理）
if (ortEnableMemPatternCheckbox) {
    ortEnableMemPatternCheckbox.addEventListener('change', () => applySettings());
}
if (ortEnableCpuMemArenaCheckbox) {
    ortEnableCpuMemArenaCheckbox.addEventListener('change', () => applySettings());
}
if (ortGraphOptLevelSelect) {
    ortGraphOptLevelSelect.addEventListener('change', () => applySettings());
}
if (ortExecutionModeSelect) {
    ortExecutionModeSelect.addEventListener('change', () => applySettings());
}
if (ortForceMemPatternOnDmlCheckbox) {
    ortForceMemPatternOnDmlCheckbox.addEventListener('change', () => applySettings());
}
if (ortIntraOpNumThreadsSlider) {
    ortIntraOpNumThreadsSlider.addEventListener('input', () => {
        ortIntraOpNumThreadsValue.textContent = ortIntraOpNumThreadsSlider.value;
        applySettingsDebounced();
    });
}
if (ortInterOpNumThreadsSlider) {
    ortInterOpNumThreadsSlider.addEventListener('input', () => {
        ortInterOpNumThreadsValue.textContent = ortInterOpNumThreadsSlider.value;
        applySettingsDebounced();
    });
}
if (ortLogSeverityLevelSelect) {
    ortLogSeverityLevelSelect.addEventListener('change', () => applySettings());
}

midiExtractToolSelect.addEventListener('change', () => applySettings());

async function _openModelDownloadWindow() {
    const precision = modelPrecisionSelect.value;
    try {
        await window.electronAPI.modelDownloadOpen(precision);
    } catch (err) {
        console.error('Failed to open model download:', err);
    }
}

openModelDownloadBtn.addEventListener('click', _openModelDownloadWindow);

// 顶部"打开模型下载"按钮：与底部按钮行为一致
if (openModelDownloadBtnTop) {
    openModelDownloadBtnTop.addEventListener('click', _openModelDownloadWindow);
}

// 监听模型下载窗口关闭事件：用户可能在下载窗口中下载/更新了模型，
// 关闭后刷新总览区，让设置页面状态与实际文件状态保持同步。
if (window.electronAPI?.onModelDownloadWindowClosed) {
    window.electronAPI.onModelDownloadWindowClosed(() => {
        refreshModelOverview().catch(() => {});
        // 同时刷新模型状态列表（按精度列出各精度文件就绪情况）
        if (window.electronAPI?.checkModels) {
            window.electronAPI.checkModels().then(modelStatus => {
                updateModelStatusDisplay(modelStatus);
            }).catch(() => {});
        }
        // 重新检测 SiFiGAN 文件状态（可能刚下载完）
        checkSifiganVocoderFiles().then(updateVocoderTypeUI).catch(() => {});
    });
}

// ==================== Update section ====================

if (updateChannelSelect) {
    updateChannelSelect.addEventListener('change', () => applySettings());
}
if (autoCheckUpdatesCheckbox) {
    autoCheckUpdatesCheckbox.addEventListener('change', () => applySettings());
}

if (checkUpdateBtn) {
    checkUpdateBtn.addEventListener('click', async () => {
        const api = window.electronAPI && window.electronAPI.updateAPI;
        if (!api || typeof api.checkNow !== 'function') return;
        const originalText = checkUpdateBtn.textContent;
        checkUpdateBtn.disabled = true;
        checkUpdateBtn.textContent = t('update.checking');
        if (updateCheckStatus) updateCheckStatus.textContent = '';
        try {
            const result = await api.checkNow();
            renderUpdateResult(result);
        } catch (err) {
            console.error('[Update] checkNow failed:', err);
            if (updateResultBox) {
                updateResultBox.textContent = t('update.networkError');
            }
            if (updateResultGroup) updateResultGroup.classList.remove('hidden');
        } finally {
            checkUpdateBtn.disabled = false;
            checkUpdateBtn.textContent = originalText || t('update.checkNow');
        }
    });
}

function renderUpdateResult(result) {
    if (!updateResultBox || !updateResultGroup) return;
    if (!result) {
        updateResultBox.textContent = t('update.networkError');
        updateResultGroup.classList.remove('hidden');
        return;
    }
    const app = result.app || {};
    const lines = [];
    if (app.error) {
        lines.push(app.error === 'rate_limited' ? t('update.rateLimited') : t('update.networkError'));
    }
    lines.push(`${t('update.currentVersion')}: ${app.currentVersion || '-'}`);
    lines.push(`${t('update.latestVersion')}: ${app.latestVersion || '-'}`);
    if (app.error) {
        // status line already pushed
    } else if (app.updateAvailable) {
        lines.push(t('update.updateAvailable'));
    } else {
        lines.push(t('update.upToDate'));
    }
    updateResultBox.innerHTML = lines.map(l => `<div>${l}</div>`).join('');
    updateResultGroup.classList.remove('hidden');
}

async function initUpdateSection() {
    const api = window.electronAPI && window.electronAPI.updateAPI;
    if (!api || typeof api.getStatus !== 'function') return;
    let status;
    try {
        status = await api.getStatus();
    } catch (err) {
        console.error('[Update] getStatus failed:', err);
        return;
    }
    if (!status) return;
    if (status.updateChannel && updateChannelSelect) {
        const v = status.updateChannel === 'nightly' ? 'nightly' : 'release';
        updateChannelSelect.value = v;
    }
    if (typeof status.autoCheckUpdates === 'boolean' && autoCheckUpdatesCheckbox) {
        autoCheckUpdatesCheckbox.checked = status.autoCheckUpdates;
    }
    if (status.dontRemindAppUpdates === true && reEnableReminderGroup) {
        reEnableReminderGroup.classList.remove('hidden');
    }
    if (status.lastUpdateCheckTime && updateCheckStatus) {
        const d = new Date(status.lastUpdateCheckTime);
        updateCheckStatus.textContent = `${t('update.lastCheck')}: ${d.toLocaleString()}`;
    }
}

if (reEnableReminderBtn) {
    reEnableReminderBtn.addEventListener('click', async () => {
        try {
            const current = await window.electronAPI.getSettings();
            current.dontRemindAppUpdates = false;
            current.skippedAppVersion = null;
            await window.electronAPI.saveSettings(current);
        } catch (err) {
            console.error('[Update] re-enable reminder failed:', err);
        }
        if (reEnableReminderGroup) reEnableReminderGroup.classList.add('hidden');
    });
}

initUpdateSection().catch(() => {});

(async () => {
    try {
        const version = await window.electronAPI.getAppVersion();
        document.getElementById('settings-version').textContent = `v${version}`;
    } catch (_) {
        document.getElementById('settings-version').textContent = 'v1.0.0';
    }
})();

// Load devices and check SiFiGAN vocoder availability in parallel.
// Previously checkSifiganVocoderFiles was gated behind loadDevices() via
// .finally(), which meant the SiFiGAN dropdown stayed at "未下载" until the
// (slow) hardware/device enumeration finished. Running them independently
// makes the SiFiGAN detection appear instantly.
loadDevices().catch(() => {});
checkSifiganVocoderFiles().then(updateVocoderTypeUI).catch(() => {});

// 立即加载显存对照表（不依赖 GPU 检测完成，因为对照表是按显存档位预算计算的）
loadVocoderChunkFramesTable();

// Load vocoder chunk frames info (smart allocation result).
// GPU detection runs asynchronously after did-finish-load, so retry
// until gpuPhase === 'full' (max 30s).
(async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        await loadVocoderChunkFramesInfo();
        if (_vocoderChunkInfoLoaded) break;
        await new Promise(r => setTimeout(r, 2000));
    }
})();

// Check model availability on load
if (window.electronAPI?.checkModels) {
    window.electronAPI.checkModels().then(modelStatus => {
        updateModelStatusDisplay(modelStatus);
    }).catch(() => {});
}

// 初始加载模型状态总览区（主模型/JP/SiFiGAN 安装与版本状态）
// 等 i18n 初始化完成后再调用，确保状态文字正确翻译。
initI18n().then(() => {
    refreshModelOverview().catch(() => {});
}).catch(() => {
    refreshModelOverview().catch(() => {});
});

initI18n().then(() => {
  applyLocale();
  document.documentElement.lang = getLocale();
  hydrateIcons(document);
});

// Apply saved theme
initWindowTheme();

// ============================================================================
// Theme management
// ============================================================================
const themeSelect = document.getElementById('themeSelect');
const themeEditBtn = document.getElementById('themeEditBtn');
const themeImportBtn = document.getElementById('themeImportBtn');
const themeExportBtn = document.getElementById('themeExportBtn');
const themeDeleteBtn = document.getElementById('themeDeleteBtn');
const themeResetBtn = document.getElementById('themeResetBtn');

const themeEditorModal = document.getElementById('themeEditorModal');
const themeEditorBody = document.getElementById('themeEditorBody');
const themeEditorUndoBtn = document.getElementById('themeEditorUndoBtn');
const themeEditorRedoBtn = document.getElementById('themeEditorRedoBtn');
const themeEditorResetAllBtn = document.getElementById('themeEditorResetAllBtn');
const themeEditorSaveAsBtn = document.getElementById('themeEditorSaveAsBtn');
const themeEditorCloseBtn = document.getElementById('themeEditorCloseBtn');

const themeSaveAsModal = document.getElementById('themeSaveAsModal');
const themeSaveAsIdInput = document.getElementById('themeSaveAsId');
const themeSaveAsIdError = document.getElementById('themeSaveAsIdError');
const themeSaveAsNameInput = document.getElementById('themeSaveAsName');
const themeSaveAsCancelBtn = document.getElementById('themeSaveAsCancelBtn');
const themeSaveAsConfirmBtn = document.getElementById('themeSaveAsConfirmBtn');

const themeToast = document.getElementById('themeToast');

let themeList = [];
let editorActive = false;
let toastTimer = null;

function getThemeDisplayName(meta) {
    if (!meta) return '';
    const key = `settings.theme.names.${meta.id}`;
    const localized = t(key);
    return localized !== key ? localized : (meta.name || meta.id);
}

function showToast(message, kind = 'info') {
    if (!themeToast) return;
    themeToast.textContent = message;
    themeToast.className = `theme-toast theme-toast-${kind}`;
    themeToast.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        themeToast.hidden = true;
    }, 3000);
}

function isValidThemeId(id) {
    return typeof id === 'string' && /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(id);
}

function buildThemeList() {
    themeList = (window.electronAPI?.themeAPI?.list
        ? []
        : BUILTIN_THEMES.map(t => ({ ...t, source: 'builtin' })));
    // Prefer runtime themeManager registry; fall back to builtins
    try {
        const live = themeManager.list();
        if (live && live.length) themeList = live;
    } catch (_) { /* keep fallback */ }
}

function populateThemeSelect() {
    if (!themeSelect) return;
    const builtinGroup = document.createElement('optgroup');
    builtinGroup.label = t('settings.theme.builtinGroup');
    const userGroup = document.createElement('optgroup');
    userGroup.label = t('settings.theme.userGroup');

    let hasBuiltin = false;
    let hasUser = false;
    for (const meta of themeList) {
        const opt = document.createElement('option');
        opt.value = meta.id;
        opt.textContent = getThemeDisplayName(meta);
        if (meta.source === 'builtin') {
            builtinGroup.appendChild(opt);
            hasBuiltin = true;
        } else {
            userGroup.appendChild(opt);
            hasUser = true;
        }
    }
    themeSelect.innerHTML = '';
    if (hasBuiltin) themeSelect.appendChild(builtinGroup);
    if (hasUser) themeSelect.appendChild(userGroup);

    const current = (window.electronAPI?.themeAPI?.current
        ? null
        : (themeManager.current()?.themeId || null));
    if (current) themeSelect.value = current;
}

function getCurrentThemeId() {
    if (window.electronAPI?.themeAPI?.current) return null;
    return themeManager.current()?.themeId || null;
}

async function applyThemeViaAPI(themeId) {
    if (window.electronAPI?.themeAPI?.apply) {
        try {
            await window.electronAPI.themeAPI.apply(themeId, { scope: 'global' });
        } catch (e) {
            console.error('Failed to apply theme:', e);
        }
    } else if (themeId && themeManager.get(themeId)) {
        try {
            themeManager.activate(themeId);
        } catch (e) {
            console.error('Failed to apply theme:', e);
        }
    }
}

async function refreshThemeList() {
    if (window.electronAPI?.themeAPI?.list) {
        try {
            themeList = await window.electronAPI.themeAPI.list();
        } catch (e) {
            console.error('Failed to list themes:', e);
            themeList = BUILTIN_THEMES.map(t => ({ ...t, source: 'builtin' }));
        }
    } else {
        buildThemeList();
    }
    populateThemeSelect();
}

if (themeSelect) {
    themeSelect.addEventListener('change', async (e) => {
        const id = e.target.value;
        if (!id) return;
        await applyThemeViaAPI(id);
        const meta = themeList.find(m => m.id === id);
        showToast(t('settings.theme.selectLabel') + ': ' + getThemeDisplayName(meta), 'info');
    });
}

if (themeResetBtn) {
    themeResetBtn.addEventListener('click', async () => {
        const defaultMeta = themeList.find(m => m.id === 'dark-aurora') || { id: 'dark-aurora', name: 'Aurora Dark' };
        if (!confirm(t('settings.theme.confirmReset', { defaultTheme: getThemeDisplayName(defaultMeta) }))) return;
        if (window.electronAPI?.themeAPI?.reset) {
            try {
                await window.electronAPI.themeAPI.reset();
            } catch (e) {
                console.error('Failed to reset theme:', e);
            }
        } else {
            try {
                themeManager.activate('dark-aurora');
            } catch (_) { /* ignore */ }
        }
        await refreshThemeList();
        showToast(t('settings.theme.reset'), 'info');
    });
}

if (themeImportBtn) {
    themeImportBtn.addEventListener('click', async () => {
        if (!window.electronAPI?.themeAPI?.import) {
            showToast(t('settings.theme.importFailed', { error: 'IPC not available' }), 'error');
            return;
        }
        try {
            const result = await window.electronAPI.themeAPI.import();
            if (!result || !result.ok) {
                showToast(t('settings.theme.importFailed', { error: (result && result.error) || 'unknown' }), 'error');
                return;
            }
            showToast(t('settings.theme.importSuccess', { name: getThemeDisplayName(result.theme) || result.theme?.id || '' }), 'success');
            await refreshThemeList();
        } catch (e) {
            showToast(t('settings.theme.importFailed', { error: e.message || String(e) }), 'error');
        }
    });
}

if (themeExportBtn) {
    themeExportBtn.addEventListener('click', async () => {
        const id = themeSelect.value;
        if (!id) {
            showToast(t('settings.theme.exportFailed', { error: 'no theme selected' }), 'error');
            return;
        }
        if (!window.electronAPI?.themeAPI?.export) {
            showToast(t('settings.theme.exportFailed', { error: 'IPC not available' }), 'error');
            return;
        }
        try {
            const result = await window.electronAPI.themeAPI.export(id);
            if (!result || !result.ok) {
                showToast(t('settings.theme.exportFailed', { error: (result && result.error) || 'unknown' }), 'error');
                return;
            }
            showToast(t('settings.theme.exportSuccess', { path: result.filePath || '' }), 'success');
        } catch (e) {
            showToast(t('settings.theme.exportFailed', { error: e.message || String(e) }), 'error');
        }
    });
}

if (themeDeleteBtn) {
    themeDeleteBtn.addEventListener('click', async () => {
        const id = themeSelect.value;
        if (!id) return;
        const meta = themeList.find(m => m.id === id);
        if (!meta) return;
        if (meta.source === 'builtin') {
            showToast(t('settings.theme.cannotDeleteBuiltin'), 'error');
            return;
        }
        if (!confirm(t('settings.theme.confirmDelete', { name: getThemeDisplayName(meta) }))) return;
        if (window.electronAPI?.themeAPI?.delete) {
            try {
                await window.electronAPI.themeAPI.delete(id);
            } catch (e) {
                console.error('Failed to delete theme:', e);
                return;
            }
        }
        await refreshThemeList();
    });
}

// ==================== Theme Editor ====================

function openThemeEditor() {
    if (!themeEditorModal) return;
    editorActive = true;
    themeEditorModal.hidden = false;
    renderEditorBody();
    document.addEventListener('keydown', handleEditorKey);
}

function closeThemeEditor(force = false) {
    if (!themeEditorModal) return;
    if (!force && editorActive) {
        if (!confirm(t('settings.theme.editor.closeConfirm'))) return;
    }
    themeEditorModal.hidden = true;
    editorActive = false;
    document.removeEventListener('keydown', handleEditorKey);
}

function handleEditorKey(e) {
    if (!editorActive) return;
    if (e.key === 'Escape') {
        e.preventDefault();
        closeThemeEditor();
    } else if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        e.preventDefault();
        themeEditorUndoBtn.click();
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
        e.preventDefault();
        themeEditorRedoBtn.click();
    }
}

function layerLabel(layer) {
    if (layer === 'global') return t('settings.theme.editor.layerGlobal');
    if (layer === 'alias') return t('settings.theme.editor.layerAlias');
    if (layer === 'component') return t('settings.theme.editor.layerComponent');
    return t('settings.theme.editor.layerCustom');
}

function resolveTokenValue(tokenName) {
    const cur = themeManager.currentTokens();
    if (cur && cur.tokens && Object.prototype.hasOwnProperty.call(cur.tokens, tokenName)) {
        return cur.tokens[tokenName];
    }
    return TOKEN_CATALOG[tokenName]?.default || '';
}

function buildEditorInput(tokenName, meta) {
    const value = resolveTokenValue(tokenName);
    const isColor = meta?.type === 'color';
    const wrap = document.createElement('div');
    wrap.className = 'theme-token-field';
    if (isColor) {
        const swatch = document.createElement('input');
        swatch.type = 'color';
        swatch.className = 'theme-token-color-swatch';
        swatch.value = toHexForColorInput(value);
        swatch.dataset.token = tokenName;
        swatch.title = t('settings.theme.editor.colorPicker');
        const text = document.createElement('input');
        text.type = 'text';
        text.className = 'theme-token-text';
        text.value = value;
        text.dataset.token = tokenName;
        text.spellcheck = false;
        swatch.addEventListener('input', () => {
            text.value = swatch.value;
            applyTokenChange(tokenName, swatch.value);
        });
        text.addEventListener('input', () => {
            const hex = toHexForColorInput(text.value);
            if (hex) swatch.value = hex;
            applyTokenChange(tokenName, text.value);
        });
        wrap.appendChild(swatch);
        wrap.appendChild(text);
    } else {
        const text = document.createElement('input');
        text.type = 'text';
        text.className = 'theme-token-text theme-token-text-wide';
        text.value = value;
        text.dataset.token = tokenName;
        text.spellcheck = false;
        text.addEventListener('input', () => applyTokenChange(tokenName, text.value));
        wrap.appendChild(text);
    }
    const resetBtn = document.createElement('button');
    resetBtn.className = 'theme-token-reset';
    resetBtn.type = 'button';
    resetBtn.title = t('settings.theme.editor.resetToken');
    resetBtn.setAttribute('aria-label', t('settings.theme.editor.resetToken'));
    const resetIcon = createIcon('refresh', { size: 14 });
    if (resetIcon) resetBtn.appendChild(resetIcon);
    resetBtn.addEventListener('click', () => {
        const def = TOKEN_CATALOG[tokenName]?.default || '';
        applyTokenChange(tokenName, def);
        renderEditorBody();
    });
    wrap.appendChild(resetBtn);
    return wrap;
}

function toHexForColorInput(value) {
    if (typeof value !== 'string') return '#000000';
    const v = value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
    if (/^#[0-9a-fA-F]{3}$/.test(v)) {
        return '#' + v.slice(1).split('').map(c => c + c).join('');
    }
    if (/^#[0-9a-fA-F]{8}$/.test(v)) return v.slice(0, 7);
    // Try to parse rgba()
    const m = v.match(/rgba?\(([^)]+)\)/);
    if (m) {
        const parts = m[1].split(',').map(s => parseFloat(s.trim()));
        if (parts.length >= 3) {
            const toHex = n => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
            return '#' + toHex(parts[0]) + toHex(parts[1]) + toHex(parts[2]);
        }
    }
    return '#000000';
}

let editDebounce = null;
function applyTokenChange(tokenName, value) {
    if (editDebounce) clearTimeout(editDebounce);
    editDebounce = setTimeout(() => {
        try {
            themeManager.setOverrideValue(tokenName, value);
        } catch (e) {
            console.error('Failed to set token:', e);
        }
    }, 80);
}

function renderEditorBody() {
    if (!themeEditorBody) return;
    themeEditorBody.innerHTML = '';
    const tokens = themeManager.currentTokens()?.tokens || {};

    // Group tokens by layer
    const byLayer = { global: [], alias: [], component: [], custom: [] };
    for (const [name, meta] of Object.entries(TOKEN_CATALOG)) {
        byLayer[meta.layer || 'custom'].push({ name, meta });
    }
    // Also include any active overrides not in catalog
    for (const name of Object.keys(tokens)) {
        if (!TOKEN_CATALOG[name] && !byLayer.custom.find(x => x.name === name)) {
            byLayer.custom.push({ name, meta: { layer: 'custom', type: 'string', label: name } });
        }
    }

    for (const layerKey of ['global', 'alias', 'component', 'custom']) {
        if (!byLayer[layerKey].length) continue;
        const section = document.createElement('div');
        section.className = 'theme-editor-section';
        const h = document.createElement('h4');
        h.className = 'theme-editor-section-title';
        h.textContent = layerLabel(layerKey);
        section.appendChild(h);

        // Group by sub-group (e.g. color-blue, color-gray, ...)
        const groups = {};
        for (const item of byLayer[layerKey]) {
            const g = item.meta.group || 'other';
            if (!groups[g]) groups[g] = [];
            groups[g].push(item);
        }
        for (const [groupName, items] of Object.entries(groups)) {
            const groupEl = document.createElement('div');
            groupEl.className = 'theme-editor-group';
            const gh = document.createElement('h5');
            gh.className = 'theme-editor-group-title';
            gh.textContent = groupName;
            groupEl.appendChild(gh);
            for (const item of items) {
                const row = document.createElement('div');
                row.className = 'theme-editor-row';
                const label = document.createElement('label');
                label.className = 'theme-editor-label';
                label.textContent = item.meta.label || item.name;
                label.title = item.name;
                const field = buildEditorInput(item.name, item.meta);
                row.appendChild(label);
                row.appendChild(field);
                groupEl.appendChild(row);
            }
            section.appendChild(groupEl);
        }
        themeEditorBody.appendChild(section);
    }
}

if (themeEditBtn) {
    themeEditBtn.addEventListener('click', () => openThemeEditor());
}
if (themeEditorCloseBtn) {
    themeEditorCloseBtn.addEventListener('click', () => closeThemeEditor());
}
if (themeEditorUndoBtn) {
    themeEditorUndoBtn.addEventListener('click', () => {
        if (themeManager.undo()) renderEditorBody();
    });
}
if (themeEditorRedoBtn) {
    themeEditorRedoBtn.addEventListener('click', () => {
        if (themeManager.redo()) renderEditorBody();
    });
}
if (themeEditorResetAllBtn) {
    themeEditorResetAllBtn.addEventListener('click', () => {
        if (confirm(t('settings.theme.editor.resetAll') + '?')) {
            themeManager.clearOverrides();
            renderEditorBody();
        }
    });
}

document.querySelectorAll('[data-theme-editor-close]').forEach(el => {
    el.addEventListener('click', () => closeThemeEditor());
});

// ==================== Save As Modal ====================

function openSaveAsModal() {
    if (!themeSaveAsModal) return;
    themeSaveAsModal.hidden = false;
    themeSaveAsIdInput.value = '';
    const selectedMeta = themeList.find(m => m.id === themeSelect.value);
    themeSaveAsNameInput.value = selectedMeta ? getThemeDisplayName(selectedMeta) : '';
    themeSaveAsIdError.hidden = true;
    themeSaveAsIdInput.focus();
}

function closeSaveAsModal() {
    if (!themeSaveAsModal) return;
    themeSaveAsModal.hidden = true;
}

if (themeEditorSaveAsBtn) {
    themeEditorSaveAsBtn.addEventListener('click', () => {
        openSaveAsModal();
    });
}
if (themeSaveAsCancelBtn) {
    themeSaveAsCancelBtn.addEventListener('click', () => closeSaveAsModal());
}
document.querySelectorAll('[data-theme-saveas-close]').forEach(el => {
    el.addEventListener('click', () => closeSaveAsModal());
});

if (themeSaveAsIdInput) {
    themeSaveAsIdInput.addEventListener('input', () => {
        themeSaveAsIdError.hidden = true;
    });
}

if (themeSaveAsConfirmBtn) {
    themeSaveAsConfirmBtn.addEventListener('click', async () => {
        const id = themeSaveAsIdInput.value.trim();
        const name = themeSaveAsNameInput.value.trim() || id;
        if (!isValidThemeId(id)) {
            themeSaveAsIdError.textContent = t('settings.theme.saveAsInvalidId');
            themeSaveAsIdError.hidden = false;
            return;
        }
        if (themeList.some(m => m.id === id)) {
            themeSaveAsIdError.textContent = t('settings.theme.saveAsIdExists', { id });
            themeSaveAsIdError.hidden = false;
            return;
        }
        // Build a theme object from current overrides + base
        const cur = themeManager.currentTokens();
        const baseTheme = cur ? themeManager.get(themeSelect.value) : null;
        const tokens = { ...(baseTheme?.tokens || {}), ...(cur?.overrides || {}) };
        const newTheme = {
            id,
            name,
            version: '1.0.0',
            isDark: computeIsDark(tokens),
            tokens,
        };
        const result = validate(newTheme, { getThemeById: (id2) => themeManager.get(id2) });
        if (!result.ok) {
            themeSaveAsIdError.textContent = result.errors.map(e => e.message).join('; ');
            themeSaveAsIdError.hidden = false;
            return;
        }
        const normalized = normalize(newTheme);
        if (window.electronAPI?.themeAPI?.save) {
            try {
                const saveResult = await window.electronAPI.themeAPI.save(normalized);
                if (!saveResult || !saveResult.ok) {
                    themeSaveAsIdError.textContent = (saveResult && saveResult.error) || 'save failed';
                    themeSaveAsIdError.hidden = false;
                    return;
                }
            } catch (e) {
                themeSaveAsIdError.textContent = e.message || String(e);
                themeSaveAsIdError.hidden = false;
                return;
            }
        } else {
            try {
                themeManager.register({ ...normalized, source: 'user' });
            } catch (e) {
                themeSaveAsIdError.textContent = e.message || String(e);
                themeSaveAsIdError.hidden = false;
                return;
            }
        }
        closeSaveAsModal();
        closeThemeEditor(true);
        await refreshThemeList();
        themeSelect.value = id;
        showToast(t('settings.theme.saveAsTitle') + ': ' + name, 'success');
    });
}

// ==================== Bootstrap theme list ====================
(async () => {
    try {
        // Try main-process list
        if (window.electronAPI?.themeAPI?.list) {
            const current = await window.electronAPI.themeAPI.current({ scope: 'global' });
            themeList = await window.electronAPI.themeAPI.list();
            populateThemeSelect();
            if (current && current.themeId) themeSelect.value = current.themeId;
        } else {
            // Renderer-only fallback
            themeManager.registerBuiltins(BUILTIN_THEMES);
            buildThemeList();
            populateThemeSelect();
        }
    } catch (e) {
        console.error('Failed to initialize theme list:', e);
    }
})();

// Listen for theme list changes from main process
if (window.electronAPI?.themeAPI?.onListChanged) {
    window.electronAPI.themeAPI.onListChanged(async () => {
        await refreshThemeList();
    });
}

// ==================== Sidebar Navigation ====================

document.querySelectorAll('.sidebar-item').forEach(item => {
    item.addEventListener('click', () => {
        const target = item.dataset.target;
        if (!target) return;

        // Update active sidebar item
        document.querySelectorAll('.sidebar-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');

        // Show target section, hide others
        document.querySelectorAll('.settings-section').forEach(s => s.classList.add('hidden'));
        const section = document.getElementById(target);
        if (section) section.classList.remove('hidden');
    });
});
