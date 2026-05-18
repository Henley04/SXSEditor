import './settings.css';
import { t, initI18n, applyLocale } from './i18n/index.js';

const inferenceDeviceSelect = document.getElementById('inferenceDevice');
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
const saveBtn = document.getElementById('saveBtn');
const cancelBtn = document.getElementById('cancelBtn');
const languageSelect = document.getElementById('languageSelect');

previewDiffStepsSlider.addEventListener('input', () => {
    previewDiffStepsValue.textContent = previewDiffStepsSlider.value;
});
previewCfgStrengthSlider.addEventListener('input', () => {
    previewCfgStrengthValue.textContent = parseFloat(previewCfgStrengthSlider.value).toFixed(1);
});
previewCfgRescaleSlider.addEventListener('input', () => {
    previewCfgRescaleValue.textContent = parseFloat(previewCfgRescaleSlider.value).toFixed(2);
});
exportDiffStepsSlider.addEventListener('input', () => {
    exportDiffStepsValue.textContent = exportDiffStepsSlider.value;
});
exportCfgStrengthSlider.addEventListener('input', () => {
    exportCfgStrengthValue.textContent = parseFloat(exportCfgStrengthSlider.value).toFixed(1);
});
exportCfgRescaleSlider.addEventListener('input', () => {
    exportCfgRescaleValue.textContent = parseFloat(exportCfgRescaleSlider.value).toFixed(2);
});
audioVolumeSlider.addEventListener('input', () => {
    volumeValueSpan.textContent = audioVolumeSlider.value + '%';
});

audioOutputModeSelect.addEventListener('change', () => {
    const isExclusive = audioOutputModeSelect.value === 'exclusive';
    exclusiveInfoDiv.classList.toggle('hidden', !isExclusive);
    audioBitDepthSelect.disabled = !isExclusive;
    updateAudioDeviceList();
});

async function loadDevices() {
    try {
        const devices = await window.electronAPI.getDMLDevices();
        const currentSetting = await window.electronAPI.getSettings();
        const hardwareInfo = await window.electronAPI.getCurrentHardware();

        inferenceDeviceSelect.innerHTML = '';

        const discreteGPUs = devices.filter(d => d.isDiscrete);
        const autoLabel = discreteGPUs.length > 0
            ? t('settings.autoSelectPreferDiscrete', { name: discreteGPUs[0].name })
            : t('settings.autoSelect');
        const autoOption = document.createElement('option');
        autoOption.value = 'auto';
        autoOption.textContent = autoLabel;
        inferenceDeviceSelect.appendChild(autoOption);

        for (const d of devices) {
            const option = document.createElement('option');
            option.value = String(d.dxgiAdapterNumber);
            const vramStr = d.vram ? ` (${d.vram})` : '';
            const discreteStr = d.isDiscrete ? ` ${t('settings.discreteGpu')}` : ` ${t('settings.integratedGpu')}`;
            option.textContent = `${d.name}${vramStr}${discreteStr}`;
            inferenceDeviceSelect.appendChild(option);
        }

        if (currentSetting && currentSetting.deviceId !== undefined && currentSetting.deviceId !== null) {
            inferenceDeviceSelect.value = String(currentSetting.deviceId);
        } else {
            inferenceDeviceSelect.value = 'auto';
        }

        updateCurrentHardwareDisplay(hardwareInfo, devices, currentSetting);

        await loadAudioSettings(currentSetting);

        if (currentSetting && currentSetting.locale) {
            languageSelect.value = currentSetting.locale;
        } else {
            languageSelect.value = 'zh-CN';
        }
    } catch (err) {
        console.error('加载设备列表失败:', err);
        inferenceDeviceSelect.innerHTML = `<option value="auto">${t('settings.autoSelect')}</option>`;
    }
}

function updateCurrentHardwareDisplay(hardwareInfo, devices, currentSetting) {
    const textEl = document.getElementById('currentHardwareText');
    if (!textEl) return;

    if (hardwareInfo) {
        const gpuName = hardwareInfo.gpuDeviceName || t('settings.cpuOnly');
        const dmlCount = hardwareInfo.dmlModelCount || 0;
        const cpuCount = hardwareInfo.cpuModelCount || 0;
        const total = hardwareInfo.totalModels || 0;

        let epDetail = '';
        if (dmlCount > 0 && cpuCount > 0) {
            epDetail = ` (${t('settings.dmlModels', { count: dmlCount, total })}, ${t('settings.cpuModels', { count: cpuCount, total })})`;
        } else if (dmlCount > 0) {
            epDetail = ` (${t('settings.dmlModels', { count: dmlCount, total })})`;
        } else if (cpuCount > 0) {
            epDetail = ` (${t('settings.cpuModels', { count: cpuCount, total })})`;
        }

        let deviceIdStr = '';
        if (hardwareInfo.dmlDeviceId !== undefined && hardwareInfo.dmlDeviceId !== null) {
            deviceIdStr = ` [deviceId=${hardwareInfo.dmlDeviceId}]`;
        }

        textEl.textContent = `${gpuName}${deviceIdStr}${epDetail}`;
        return;
    }

    if (!devices || devices.length === 0) {
        textEl.textContent = t('settings.noGpuDetected');
        return;
    }

    const selectedDeviceId = currentSetting && currentSetting.deviceId !== undefined && currentSetting.deviceId !== null
        ? currentSetting.deviceId
        : null;

    if (selectedDeviceId !== null) {
        const selected = devices.find(d => d.dxgiAdapterNumber === selectedDeviceId);
        if (selected) {
            const vramStr = selected.vram ? ` (${selected.vram})` : '';
            const discreteStr = selected.isDiscrete ? ` ${t('settings.discreteGpu')}` : ` ${t('settings.integratedGpu')}`;
            textEl.textContent = `${selected.name}${vramStr}${discreteStr} [deviceId=${selectedDeviceId}] ${t('settings.pendingInit')}`;
            return;
        }
    }

    const discrete = devices.filter(d => d.isDiscrete);
    if (discrete.length > 0) {
        const best = discrete.sort((a, b) => (b.vramBytes || 0) - (a.vramBytes || 0))[0];
        const vramStr = best.vram ? ` (${best.vram})` : '';
        textEl.textContent = `${t('settings.autoSelect')}: ${best.name}${vramStr} ${t('settings.discreteGpu')} ${t('settings.pendingInit')}`;
    } else {
        const best = devices.sort((a, b) => (b.vramBytes || 0) - (a.vramBytes || 0))[0];
        const vramStr = best.vram ? ` (${best.vram})` : '';
        textEl.textContent = `${t('settings.autoSelect')}: ${best.name}${vramStr} ${t('settings.integratedGpu')} ${t('settings.pendingInit')}`;
    }
}

async function loadAudioSettings(currentSetting) {
    try {
        const audioResult = await window.electronAPI.getAudioDevices();
        const audioDevices = audioResult.devices || [];
        const isNaudiodonAvailable = audioResult.isAvailable || false;

        if (!isNaudiodonAvailable) {
            audioOutputModeSelect.innerHTML = `<option value="shared">${t('settings.sharedModeUnavailable')}</option>`;
            audioOutputModeSelect.disabled = true;
            audioBitDepthSelect.disabled = true;
        }

        populateAudioDevices(audioDevices);

        if (currentSetting) {
            if (currentSetting.audioOutputMode) audioOutputModeSelect.value = currentSetting.audioOutputMode;
            if (currentSetting.audioOutputDevice !== undefined) audioOutputDeviceSelect.value = String(currentSetting.audioOutputDevice);
            if (currentSetting.audioSampleRate) audioSampleRateSelect.value = String(currentSetting.audioSampleRate);
            if (currentSetting.audioBitDepth) audioBitDepthSelect.value = currentSetting.audioBitDepth;
            if (currentSetting.audioBufferSize) audioBufferSizeSelect.value = String(currentSetting.audioBufferSize);
            if (currentSetting.audioVolume !== undefined) {
                audioVolumeSlider.value = Math.round(currentSetting.audioVolume * 100);
                volumeValueSpan.textContent = Math.round(currentSetting.audioVolume * 100) + '%';
            }
        }

        if (currentSetting) {
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
        }

        const isExclusive = audioOutputModeSelect.value === 'exclusive';
        exclusiveInfoDiv.classList.toggle('hidden', !isExclusive);
        audioBitDepthSelect.disabled = !isExclusive || !isNaudiodonAvailable;
    } catch (err) {
        console.error('加载音频设置失败:', err);
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

saveBtn.addEventListener('click', async () => {
    const inferenceValue = inferenceDeviceSelect.value;
    const deviceId = inferenceValue === 'auto' ? null : parseInt(inferenceValue);

    const settings = {
        deviceId,
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
    };

    try {
        await window.electronAPI.saveSettings(settings);
        if (languageSelect.value === 'zh-CN' || languageSelect.value === 'en') {
            localStorage.setItem('sxseditor-locale', languageSelect.value);
        }
        window.close();
    } catch (err) {
        console.error('保存设置失败:', err);
    }
});

cancelBtn.addEventListener('click', () => {
    window.close();
});

(async () => {
    try {
        const version = await window.electronAPI.getAppVersion();
        document.getElementById('settings-version').textContent = `v${version}`;
    } catch (_) {
        document.getElementById('settings-version').textContent = 'v1.0.0';
    }
})();

loadDevices();

initI18n();
applyLocale();
