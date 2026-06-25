/**
 * 音频格式与设备映射纯函数。
 *
 * 这些函数从 audioWorker.js 中提取出来，便于单元测试。
 * 它们不依赖任何 native 模块，可在 Node.js / 测试环境直接运行。
 *
 * decibri 的 Speaker 只接受 'int16' 与 'float32' 两种 dtype，
 * 不支持 int24 / int32 / 独占模式 / 自定义 bufferSize，
 * 因此本模块负责把上层传入的旧选项适配到 decibri 能力范围。
 */

/**
 * 根据平台返回音频后端名称（用于设备列表的 hostAPI 字段）。
 * decibri 在 Windows 用 WASAPI、macOS 用 CoreAudio、Linux 用 ALSA。
 */
function platformHostAPI(platform = process.platform) {
  switch (platform) {
    case 'win32': return 'WASAPI';
    case 'darwin': return 'CoreAudio';
    case 'linux': return 'ALSA';
    default: return 'Unknown';
  }
}

/**
 * 把上层 bitDepth 选项映射为 decibri Speaker 可接受的 dtype。
 * decibri 仅支持 'int16' 与 'float32'；int24 / int32 / 未知值统一降级为 float32，
 * 以保留最高精度（与原 naudiodon float32 路径行为一致）。
 */
function resolveDtype(bitDepth) {
  if (bitDepth === 'int16') return 'int16';
  return 'float32';
}

/**
 * 判断某 bitDepth 是否被 decibri 原生支持（用于 UI 提示）。
 */
function isSupportedBitDepth(bitDepth) {
  return bitDepth === 'int16' || bitDepth === 'float32';
}

/**
 * 将 Float32Array PCM 数据转换为与 dtype 匹配的 Buffer，同时应用音量与起始偏移。
 * 始终返回新分配或正确切片的 Buffer，可直接传给 decibri Speaker.write()。
 *
 * @param {Float32Array} float32Data 源音频数据
 * @param {'int16'|'float32'} dtype 目标编码
 * @param {number} volume 音量 0~1
 * @param {number} startSample 起始样本偏移
 * @returns {Buffer}
 */
function buildPcmBuffer(float32Data, dtype, volume, startSample = 0) {
  const safeStart = Math.max(0, Math.min(startSample, float32Data.length));
  const src = float32Data.subarray(safeStart);
  const v = Math.max(0, Math.min(1, volume));

  if (dtype === 'int16') {
    const int16 = new Int16Array(src.length);
    for (let i = 0; i < src.length; i++) {
      const s = Math.max(-1, Math.min(1, src[i] * v));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return Buffer.from(int16.buffer);
  }

  // float32 路径
  if (v === 1.0) {
    // 共享底层 buffer，按偏移与长度切片
    return Buffer.from(src.buffer, src.byteOffset, src.byteLength);
  }
  const out = new Float32Array(src.length);
  for (let i = 0; i < src.length; i++) {
    out[i] = src[i] * v;
  }
  return Buffer.from(out.buffer);
}

/**
 * 把 decibri Speaker.devices() 的返回值映射为上层（audioOutputManager / settings UI）
 * 期望的兼容结构，与原 naudiodon getDevices() 输出字段保持一致：
 *   { id, name, maxOutputChannels, defaultSampleRate, hostAPI }
 *
 * 其中 id 使用 decibri 的 index（数字），这样前端传回的 deviceId 可直接作为
 * decibri Speaker 的 device 选项（数字 index）。
 */
function mapDevicesToLegacy(devices, platform = process.platform) {
  const hostAPI = platformHostAPI(platform);
  return (devices || [])
    .filter((d) => d && d.maxOutputChannels > 0)
    .map((d) => ({
      id: d.index,
      name: d.name,
      maxOutputChannels: d.maxOutputChannels,
      defaultSampleRate: d.defaultSampleRate,
      hostAPI,
      isDefault: !!d.isDefault,
    }));
}

/**
 * 把上层 deviceId（-1 / 未定义 = 系统默认，数字 = decibri 设备 index，
 * 字符串 = 设备名子串）映射为 decibri Speaker 的 device 选项。
 * 返回 null 表示使用系统默认设备（不向 Speaker 传 device 选项）。
 */
function resolveDeviceOption(deviceId) {
  if (deviceId === undefined || deviceId === null || deviceId === -1) return null;
  return deviceId;
}

/**
 * 构造 decibri Speaker 的初始化选项。
 * 忽略 decibri 不支持的 bufferSize / wasapiExclusiveMode（始终共享模式）。
 */
function buildSpeakerOptions(options) {
  const {
    deviceId = -1,
    sampleRate = 24000,
    channels = 1,
    bitDepth = 'float32',
  } = options || {};

  const speakerOptions = {
    sampleRate,
    channels,
    dtype: resolveDtype(bitDepth),
  };
  const deviceOpt = resolveDeviceOption(deviceId);
  if (deviceOpt !== null) {
    speakerOptions.device = deviceOpt;
  }
  return speakerOptions;
}

module.exports = {
  platformHostAPI,
  resolveDtype,
  isSupportedBitDepth,
  buildPcmBuffer,
  mapDevicesToLegacy,
  resolveDeviceOption,
  buildSpeakerOptions,
};
