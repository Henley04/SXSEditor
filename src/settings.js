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

const inferenceDeviceSelect = document.getElementById('inferenceDevice');
const deviceSelectGroup = document.getElementById('deviceSelectGroup');
const webnnStatusGroup = document.getElementById('webnnStatusGroup');
const webnnStatusValue = document.getElementById('webnnStatusValue');
const npuStatusValue = document.getElementById('npuStatusValue');
const advancedSettingsGroup = document.getElementById('advancedSettingsGroup');
const modelDeviceMappingDiv = document.getElementById('modelDeviceMapping');
const deviceModeRadios = document.querySelectorAll('input[name="deviceMode"]');
const previewDiffStepsSlider = document.getElementById('previewDiffSteps');
const previewDiffStepsValue = document.getElementById('previewDiffStepsValue');
const previewCfgStrengthSlider = document.getElementById('previewCfgStrength');
const previewCfgStrengthValue = document.getElementById('previewCfgStrengthValue');
const previewCfgRescaleSlider = document.getElementById('previewCfgRescale');
const previewCfgRescaleValue = document.getElementById('previewCfgRescaleValue');
const exportDiffStepsSlider = document.getElementById('exportDiffSteps');
const exportDiffStepsValue = document.getElementById('exportDiffStepsValue');
const exportCfgStrengthSlider = document.getElementById('exportCfgStrength');
const exportCfgStrengthValue = document.getElementById('exportCfgStrengthValue');
const exportCfgRescaleSlider = document.getElementById('exportCfgRescale');
const exportCfgRescaleValue = document.getElementById('exportCfgRescaleValue');
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
const npuDiffBatchSizeSelect = document.getElementById('npuDiffBatchSize');
const npuVocoderBatchSizeSelect = document.getElementById('npuVocoderBatchSize');
const batchSizeDisabledHint = document.getElementById('batchSizeDisabledHint');
const vocoderTypeSelect = document.getElementById('vocoderType');
const vocoderTypeHint = document.getElementById('vocoderTypeHint');

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

    // Device mode
    const deviceMode = currentSetting.deviceMode || 'smart';
    const radioToCheck = document.querySelector(`input[name="deviceMode"][value="${deviceMode}"]`);
    if (radioToCheck) radioToCheck.checked = true;
    updateDeviceModeUI(deviceMode);

    // Diffusion sliders
    const pSteps = currentSetting.previewDiffSteps ?? 16;
    const pCfg = currentSetting.previewCfgStrength ?? 3.0;
    const pRescale = currentSetting.previewCfgRescale ?? 0.75;
    previewDiffStepsSlider.value = pSteps;
    previewDiffStepsValue.textContent = pSteps;
    previewCfgStrengthSlider.value = pCfg;
    previewCfgStrengthValue.textContent = parseFloat(pCfg).toFixed(1);
    previewCfgRescaleSlider.value = pRescale;
    previewCfgRescaleValue.textContent = parseFloat(pRescale).toFixed(2);

    const eSteps = currentSetting.exportDiffSteps ?? 32;
    const eCfg = currentSetting.exportCfgStrength ?? 3.0;
    const eRescale = currentSetting.exportCfgRescale ?? 0.75;
    exportDiffStepsSlider.value = eSteps;
    exportDiffStepsValue.textContent = eSteps;
    exportCfgStrengthSlider.value = eCfg;
    exportCfgStrengthValue.textContent = parseFloat(eCfg).toFixed(1);
    exportCfgRescaleSlider.value = eRescale;
    exportCfgRescaleValue.textContent = parseFloat(eRescale).toFixed(2);

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
        modelPrecisionSelect.value = 'fp16';
    }

    // MIDI tool
    if (currentSetting.midiExtractTool) {
        const tool = currentSetting.midiExtractTool === 'rosvot' ? 'rmvpe' : currentSetting.midiExtractTool;
        midiExtractToolSelect.value = tool;
    } else {
        midiExtractToolSelect.value = 'basicpitch';
    }

    // NPU batch sizes (set saved values before updateBatchSizeState which may override)
    _savedDiffBatch = String(currentSetting.npuDiffBatchSize ?? 4);
    _savedVocoderBatch = String(currentSetting.npuVocoderBatchSize ?? 4);
    updateBatchSizeState(modelPrecisionSelect.value);

    // Vocoder type (main process may have overridden 'sifigan' -> 'default' at startup)
    vocoderTypeSelect.value = currentSetting.vocoderType === 'sifigan' ? 'sifigan' : 'default';

    // Audio exclusive mode
    const isExclusive = audioOutputModeSelect.value === 'exclusive';
    exclusiveInfoDiv.classList.toggle('hidden', !isExclusive);
    audioBitDepthSelect.disabled = !isExclusive;
}

function getDeviceTypeLabel(deviceType) {
    switch (deviceType) {
        case 'discrete-gpu': return t('settings.discreteGpu');
        case 'integrated-gpu': return t('settings.integratedGpu');
        case 'npu': return t('settings.npuLabel');
        case 'cpu': return t('settings.cpuLabel');
        default: return deviceType || '';
    }
}

function getDeviceOptionText(d) {
    const vramStr = d.vram ? ` (${d.vram})` : '';
    const typeStr = getDeviceTypeLabel(d.deviceType);
    const npuTag = d.deviceType === 'npu' ? ' [NPU(WebNN)]' : '';
    return `${d.name}${vramStr} ${typeStr}${npuTag}`;
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

let _savedDiffBatch = null;
let _savedVocoderBatch = null;

function updateBatchSizeState(precision) {
    const isOptimized = precision === 'int8-npu';
    npuDiffBatchSizeSelect.disabled = !isOptimized;
    npuVocoderBatchSizeSelect.disabled = !isOptimized;
    if (batchSizeDisabledHint) {
        batchSizeDisabledHint.classList.toggle('hidden', isOptimized);
    }
    if (isOptimized) {
        if (_savedDiffBatch !== null) npuDiffBatchSizeSelect.value = _savedDiffBatch;
        if (_savedVocoderBatch !== null) npuVocoderBatchSizeSelect.value = _savedVocoderBatch;
    } else {
        npuDiffBatchSizeSelect.value = '1';
        npuVocoderBatchSizeSelect.value = '1';
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
        const [onnxExists, statsExists] = await Promise.all([
            window.electronAPI.fileExists(base + '/sifigan_vocoder_dml.onnx'),
            window.electronAPI.fileExists(base + '/sifigan_stats.joblib'),
        ]);
        return { onnxExists, statsExists };
    } catch (err) {
        console.error('[Settings] 检测 SiFiGAN 模型文件失败:', err);
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
}

const PRECISION_LABELS = {
    'fp32': 'FP32',
    'fp16': 'FP16',
    'fp8': 'FP8',
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

async function loadDevices() {
    try {
        // 立即显示加载状态
        webnnStatusValue.textContent = t('settings.webnnChecking');
        webnnStatusValue.classList.remove('status-available', 'status-unavailable');
        webnnStatusValue.classList.add('status-checking');
        npuStatusValue.textContent = t('settings.webnnChecking');
        npuStatusValue.classList.remove('status-available', 'status-unavailable');
        npuStatusValue.classList.add('status-checking');

        // 先加载已保存的设置，立即应用到 UI（避免显示 HTML 默认值）
        const currentSetting = await window.electronAPI.getSettings();
        window._currentSetting = currentSetting;
        applySavedSettingsToUI(currentSetting);

        // 再获取设备列表（硬件检测可能较慢）
        const devices = await window.electronAPI.getDMLDevices();

        cachedDevices = devices;

        // NPU 结果已经包含在 getDMLDevices 中（并行检测）
        const hasNpu = devices.some(d => d.deviceType === 'npu');
        const webnnInfo = { webnnAvailable: hasNpu, npuAvailable: hasNpu };
        cachedWebnnInfo = webnnInfo;

        // 获取当前硬件信息（可能为 null 如果管道未初始化）
        const hardwareInfo = await window.electronAPI.getCurrentHardware();

        // 更新 WebNN/NPU 状态指示器
        if (webnnInfo.webnnAvailable) {
            webnnStatusValue.textContent = t('settings.webnnAvailable');
            webnnStatusValue.classList.add('status-available');
            webnnStatusValue.classList.remove('status-unavailable', 'status-checking');
        } else {
            webnnStatusValue.textContent = t('settings.webnnNotAvailable');
            webnnStatusValue.classList.add('status-unavailable');
            webnnStatusValue.classList.remove('status-available', 'status-checking');
        }
        if (webnnInfo.npuAvailable) {
            npuStatusValue.textContent = t('settings.npuAvailable');
            npuStatusValue.classList.add('status-available');
            npuStatusValue.classList.remove('status-unavailable', 'status-checking');
        } else {
            npuStatusValue.textContent = t('settings.npuNotAvailable');
            npuStatusValue.classList.add('status-unavailable');
            npuStatusValue.classList.remove('status-available', 'status-checking');
        }

        inferenceDeviceSelect.innerHTML = '';

        const discreteGPUs = devices.filter(d => d.deviceType === 'discrete-gpu' || d.isDiscrete);
        const autoLabel = discreteGPUs.length > 0
            ? t('settings.autoSelectPreferDiscrete', { name: discreteGPUs[0].name })
            : t('settings.autoSelect');
        const autoOption = document.createElement('option');
        autoOption.value = 'auto';
        autoOption.textContent = autoLabel;
        inferenceDeviceSelect.appendChild(autoOption);

        for (const d of devices) {
            const option = document.createElement('option');
            // NPU devices use 'npu' as value, others use dxgiAdapterNumber
            option.value = d.deviceType === 'npu' ? 'npu' : String(d.dxgiAdapterNumber);
            option.textContent = getDeviceOptionText(d);
            option.dataset.deviceType = d.deviceType || (d.isDiscrete ? 'discrete-gpu' : 'integrated-gpu');
            inferenceDeviceSelect.appendChild(option);
        }

        // Update cachedWebnnInfo from device list (NPU may now come from getDMLDevices)
        if (!cachedWebnnInfo.npuAvailable && devices.some(d => d.deviceType === 'npu')) {
            cachedWebnnInfo = { ...cachedWebnnInfo, npuAvailable: true };
        }

        // Restore device selection from settings (dropdown needs device list first)
        if (currentSetting && currentSetting.preferredDeviceId !== undefined && currentSetting.preferredDeviceId !== null) {
            inferenceDeviceSelect.value = String(currentSetting.preferredDeviceId);
        } else if (currentSetting && currentSetting.deviceId !== undefined && currentSetting.deviceId !== null) {
            inferenceDeviceSelect.value = String(currentSetting.deviceId);
        } else {
            inferenceDeviceSelect.value = 'auto';
        }

        updateCurrentHardwareDisplay(hardwareInfo, devices, currentSetting);

        // Load audio device list (needs hardware detection for device enumeration)
        await loadAudioDevices();
    } catch (err) {
        console.error('加载设备列表失败:', err);
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

        textEl.textContent = `${gpuName}${deviceTypeLabel}${deviceIdStr}${epDetail}`;
        return;
    }

    if (!devices || devices.length === 0) {
        textEl.textContent = t('settings.noGpuDetected');
        return;
    }

    const selectedDeviceId = currentSetting && (currentSetting.preferredDeviceId !== undefined && currentSetting.preferredDeviceId !== null)
        ? currentSetting.preferredDeviceId
        : (currentSetting && currentSetting.deviceId !== undefined && currentSetting.deviceId !== null ? currentSetting.deviceId : null);

    if (selectedDeviceId !== null) {
        // NPU devices use 'npu' as value, match by deviceType
        const selected = selectedDeviceId === 'npu'
            ? devices.find(d => d.deviceType === 'npu')
            : devices.find(d => d.dxgiAdapterNumber === selectedDeviceId);
        if (selected) {
            const vramStr = selected.vram ? ` (${selected.vram})` : '';
            const typeLabel = getDeviceTypeLabel(selected.deviceType || (selected.isDiscrete ? 'discrete-gpu' : 'integrated-gpu'));
            const npuTag = selected.deviceType === 'npu' ? ' [NPU(WebNN)]' : '';
            textEl.textContent = `${selected.name}${vramStr} ${typeLabel}${npuTag} [deviceId=${selectedDeviceId}] ${t('settings.pendingInit')}`;
            return;
        }
    }

    // Auto mode — show "自动选择" with best device hint, matching the dropdown display
    const discrete = devices.filter(d => d.deviceType === 'discrete-gpu' || d.isDiscrete);
    if (discrete.length > 0) {
        const best = discrete.sort((a, b) => (b.vramBytes || 0) - (a.vramBytes || 0))[0];
        textEl.textContent = t('settings.autoSelectPreferDiscrete', { name: best.name }) + ` ${t('settings.pendingInit')}`;
    } else {
        const best = devices.sort((a, b) => (b.vramBytes || 0) - (a.vramBytes || 0))[0];
        const vramStr = best.vram ? ` (${best.vram})` : '';
        textEl.textContent = `${t('settings.autoSelect')}: ${best.name}${vramStr} ${getDeviceTypeLabel(best.deviceType || (best.isDiscrete ? 'discrete-gpu' : 'integrated-gpu'))} ${t('settings.pendingInit')}`;
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
            // NPU devices use 'npu' as value, others use dxgiAdapterNumber
            opt.value = d.deviceType === 'npu' ? 'npu' : String(d.dxgiAdapterNumber);
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
        console.error('加载音频设备列表失败:', err);
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
        console.error('更新音频设备列表失败:', err);
    }
}

// ==================== Auto-apply settings ====================

let _saveDebounce = null;

function collectSettings() {
    const deviceModeRadio = document.querySelector('input[name="deviceMode"]:checked');
    const deviceMode = deviceModeRadio ? deviceModeRadio.value : 'smart';

    // 仅在 manual 模式下从 inferenceDeviceSelect 提取 preferredDeviceId/preferredDeviceType/deviceId。
    // smart/advanced 模式下这些字段保持 undefined，让 settingsIpc.saveSettings 跳过它们，
    // 避免用 null 覆盖之前 manual 模式保存的具体设备 ID（否则切回 manual 时自定义设备会丢失，
    // 且 main.js 启动验证会误弹 "deviceId=null not found" 对话框）。
    let preferredDeviceId;
    let preferredDeviceType;
    if (deviceMode === 'manual') {
        const inferenceValue = inferenceDeviceSelect.value;
        preferredDeviceId = inferenceValue === 'auto' ? null : (inferenceValue === 'npu' ? 'npu' : parseInt(inferenceValue));
        preferredDeviceType = null;
        if (preferredDeviceId !== null) {
            if (preferredDeviceId === 'npu') {
                preferredDeviceType = 'npu';
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
            modelDeviceMapping[groupId] = val === 'auto' ? 'auto' : (val === 'npu' ? 'npu' : parseInt(val));
        });
    }

    return {
        deviceMode,
        preferredDeviceId,
        preferredDeviceType,
        modelDeviceMapping,
        deviceId: preferredDeviceId,
        previewDiffSteps: parseInt(previewDiffStepsSlider.value),
        previewCfgStrength: parseFloat(previewCfgStrengthSlider.value),
        previewCfgRescale: parseFloat(previewCfgRescaleSlider.value),
        exportDiffSteps: parseInt(exportDiffStepsSlider.value),
        exportCfgStrength: parseFloat(exportCfgStrengthSlider.value),
        exportCfgRescale: parseFloat(exportCfgRescaleSlider.value),
        audioOutputMode: audioOutputModeSelect.value,
        audioOutputDevice: parseInt(audioOutputDeviceSelect.value),
        audioSampleRate: parseInt(audioSampleRateSelect.value),
        audioBitDepth: audioBitDepthSelect.value,
        audioBufferSize: parseInt(audioBufferSizeSelect.value),
        audioVolume: parseInt(audioVolumeSlider.value) / 100,
        locale: languageSelect.value,
        modelPrecision: modelPrecisionSelect.value,
        midiExtractTool: midiExtractToolSelect.value,
        npuDiffBatchSize: parseInt(npuDiffBatchSizeSelect.value),
        npuVocoderBatchSize: parseInt(npuVocoderBatchSizeSelect.value),
        vocoderType: vocoderTypeSelect.value,
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
        console.error('应用设置失败:', err);
    }
}

function applySettingsDebounced() {
    if (_saveDebounce) clearTimeout(_saveDebounce);
    _saveDebounce = setTimeout(() => applySettings(), 300);
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

// Language, precision, MIDI tool
languageSelect.addEventListener('change', () => applySettings({ reloadLocale: true }));
modelPrecisionSelect.addEventListener('change', async () => {
    updateBatchSizeState(modelPrecisionSelect.value);
    await applySettings(); // 等待保存 + pipeline 重置完成再刷新硬件显示
    // pipeline 已被重置，刷新"当前运行硬件"显示让用户确认精度切换生效
    updateCurrentHardwareDisplay(null, cachedDevices, collectSettings());
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
});
npuDiffBatchSizeSelect.addEventListener('change', () => {
    _savedDiffBatch = npuDiffBatchSizeSelect.value;
    applySettings();
});
npuVocoderBatchSizeSelect.addEventListener('change', () => {
    _savedVocoderBatch = npuVocoderBatchSizeSelect.value;
    applySettings();
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
            return;
        }
    }
    applySettings();
});
midiExtractToolSelect.addEventListener('change', () => applySettings());

openModelDownloadBtn.addEventListener('click', async () => {
    const precision = modelPrecisionSelect.value;
    try {
        await window.electronAPI.modelDownloadOpen(precision);
    } catch (err) {
        console.error('打开模型下载失败:', err);
    }
});

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

// Check model availability on load
if (window.electronAPI?.checkModels) {
    window.electronAPI.checkModels().then(modelStatus => {
        updateModelStatusDisplay(modelStatus);
    }).catch(() => {});
}

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
            console.error('应用主题失败:', e);
        }
    } else if (themeId && themeManager.get(themeId)) {
        try {
            themeManager.activate(themeId);
        } catch (e) {
            console.error('应用主题失败:', e);
        }
    }
}

async function refreshThemeList() {
    if (window.electronAPI?.themeAPI?.list) {
        try {
            themeList = await window.electronAPI.themeAPI.list();
        } catch (e) {
            console.error('列出主题失败:', e);
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
                console.error('重置主题失败:', e);
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
                console.error('删除主题失败:', e);
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
            console.error('设置令牌失败:', e);
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
        console.error('初始化主题列表失败:', e);
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
