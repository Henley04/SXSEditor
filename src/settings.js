import './settings.css';

const inferenceDeviceSelect = document.getElementById('inferenceDevice');
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
            ? `自动选择 (优先独显: ${discreteGPUs[0].name})`
            : '自动选择';
        const autoOption = document.createElement('option');
        autoOption.value = 'auto';
        autoOption.textContent = autoLabel;
        inferenceDeviceSelect.appendChild(autoOption);

        for (const d of devices) {
            const option = document.createElement('option');
            option.value = String(d.dxgiAdapterNumber);
            const vramStr = d.vram ? ` (${d.vram})` : '';
            const discreteStr = d.isDiscrete ? ' [独显]' : ' [核显]';
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
    } catch (err) {
        console.error('加载设备列表失败:', err);
        inferenceDeviceSelect.innerHTML = '<option value="auto">自动选择</option>';
    }
}

function updateCurrentHardwareDisplay(hardwareInfo, devices, currentSetting) {
    const textEl = document.getElementById('currentHardwareText');
    if (!textEl) return;

    if (hardwareInfo) {
        const gpuName = hardwareInfo.gpuDeviceName || '无 GPU (仅 CPU)';
        const dmlCount = hardwareInfo.dmlModelCount || 0;
        const cpuCount = hardwareInfo.cpuModelCount || 0;
        const total = hardwareInfo.totalModels || 0;

        let epDetail = '';
        if (dmlCount > 0 && cpuCount > 0) {
            epDetail = ` (DML: ${dmlCount}/${total} 模型, CPU: ${cpuCount}/${total} 模型)`;
        } else if (dmlCount > 0) {
            epDetail = ` (DML: ${dmlCount}/${total} 模型)`;
        } else if (cpuCount > 0) {
            epDetail = ` (CPU: ${cpuCount}/${total} 模型)`;
        }

        let deviceIdStr = '';
        if (hardwareInfo.dmlDeviceId !== undefined && hardwareInfo.dmlDeviceId !== null) {
            deviceIdStr = ` [deviceId=${hardwareInfo.dmlDeviceId}]`;
        }

        textEl.textContent = `${gpuName}${deviceIdStr}${epDetail}`;
        return;
    }

    if (!devices || devices.length === 0) {
        textEl.textContent = '未检测到 GPU 设备';
        return;
    }

    const selectedDeviceId = currentSetting && currentSetting.deviceId !== undefined && currentSetting.deviceId !== null
        ? currentSetting.deviceId
        : null;

    if (selectedDeviceId !== null) {
        const selected = devices.find(d => d.dxgiAdapterNumber === selectedDeviceId);
        if (selected) {
            const vramStr = selected.vram ? ` (${selected.vram})` : '';
            const discreteStr = selected.isDiscrete ? ' [独显]' : ' [核显]';
            textEl.textContent = `${selected.name}${vramStr}${discreteStr} [deviceId=${selectedDeviceId}] (待初始化)`;
            return;
        }
    }

    const discrete = devices.filter(d => d.isDiscrete);
    if (discrete.length > 0) {
        const best = discrete.sort((a, b) => (b.vramBytes || 0) - (a.vramBytes || 0))[0];
        const vramStr = best.vram ? ` (${best.vram})` : '';
        textEl.textContent = `自动选择: ${best.name}${vramStr} [独显] (待初始化)`;
    } else {
        const best = devices.sort((a, b) => (b.vramBytes || 0) - (a.vramBytes || 0))[0];
        const vramStr = best.vram ? ` (${best.vram})` : '';
        textEl.textContent = `自动选择: ${best.name}${vramStr} [核显] (待初始化)`;
    }
}

async function loadAudioSettings(currentSetting) {
    try {
        const audioResult = await window.electronAPI.getAudioDevices();
        const audioDevices = audioResult.devices || [];
        const isNaudiodonAvailable = audioResult.isAvailable || false;

        if (!isNaudiodonAvailable) {
            audioOutputModeSelect.innerHTML = '<option value="shared">共享模式 (WASAPI 不可用)</option>';
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

        const isExclusive = audioOutputModeSelect.value === 'exclusive';
        exclusiveInfoDiv.classList.toggle('hidden', !isExclusive);
        audioBitDepthSelect.disabled = !isExclusive || !isNaudiodonAvailable;
    } catch (err) {
        console.error('加载音频设置失败:', err);
    }
}

function populateAudioDevices(audioDevices) {
    audioOutputDeviceSelect.innerHTML = '<option value="-1">系统默认</option>';

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
        audioOutputMode: audioOutputModeSelect.value,
        audioOutputDevice: parseInt(audioOutputDeviceSelect.value),
        audioSampleRate: parseInt(audioSampleRateSelect.value),
        audioBitDepth: audioBitDepthSelect.value,
        audioBufferSize: parseInt(audioBufferSizeSelect.value),
        audioVolume: parseInt(audioVolumeSlider.value) / 100,
    };

    try {
        await window.electronAPI.saveSettings(settings);
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
