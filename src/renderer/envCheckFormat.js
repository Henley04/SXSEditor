/**
 * 环境检测的展示层格式化（纯函数，不碰 DOM）。
 *
 * 为什么单独抽出来：弹层里看到的每一行与「一键复制」的纯文本必须逐字一致。
 * 如果 UI 和复制各拼一套，很容易出现界面显示「8.0 GB」而复制出来是「8192 MB」
 * 这类偏差，而且只有把文本贴出去才会被发现。
 *
 * 所有文案都经 `t()` 注入，因此本文件可以脱离 Electron 在 jsdom / node 下直测。
 */

/** 复制按钮轮询 GPU 结果的节奏：主窗口启动时已在后台跑 startGPUPreload。 */
export const GPU_POLL_INTERVAL_MS = 800;
/** 主进程的 GPU worker 自带 15s 超时，这里留 1s 余量后放弃等待。 */
export const GPU_POLL_DEADLINE_MS = 16000;

/**
 * 字节 → 人类可读。`0` / 负数 / 非数字 / null 一律返回 null（由调用方决定
 * 显示「未知」还是「检测中」）——显存为 0 基本等同于「没探到」，不该显示成 0。
 *
 * @param {number|null|undefined} bytes
 * @returns {string|null}
 */
export function formatBytesHuman(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return null;
  const gib = n / (1024 ** 3);
  if (gib >= 1) return `${gib.toFixed(1)} GB`;
  const mib = n / (1024 ** 2);
  if (mib >= 1) return `${Math.round(mib)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

function formatTime(ts) {
  const d = new Date(Number(ts) || Date.now());
  const p = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
    + `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function deviceLabel(item, t) {
  if (item.isDiscrete || item.deviceType === 'discrete-gpu') return t('envCheck.deviceDiscrete');
  if (item.deviceType === 'integrated-gpu') return t('envCheck.deviceIntegrated');
  if (item.deviceType === 'cpu') return t('envCheck.deviceCpu');
  if (item.deviceType === 'npu') return t('envCheck.deviceNpu');
  return t('envCheck.deviceUnknown');
}

function vramRowValue(item, phase, t, pendingText) {
  if (item.vramBytes) {
    const budget = formatBytesHuman(item.budgetBytes || item.vramBytes);
    const used = formatBytesHuman(item.usedBytes);
    if (used && budget) {
      const percent = item.budgetBytes
        ? Math.min(100, Math.round((item.usedBytes / item.budgetBytes) * 100))
        : 0;
      return t('envCheck.vramUsageValue', { used, budget, percent });
    }
    return budget;
  }
  if (phase === 'full') return t('envCheck.unknown');
  return pendingText;
}

function providerLine(list, t) {
  if (!Array.isArray(list) || list.length === 0) return t('envCheck.none');
  return list.map((p) => {
    const state = p.ready ? t('envCheck.providerReady') : t('envCheck.providerOnDemand');
    const devices = (p.devices || [])
      .map((d) => t('envCheck.providerDevices', { type: d.type, count: d.count }))
      .join(', ');
    // 库文件名是 getEnvCheckProbes() 里做过 basename 脱敏的（只剩文件名，不含目录）。
    // 保留它是因为「同一个 EP 实际加载到哪个版本的 DLL」是排障时最常被追问的线索。
    const name = p.library ? `${p.name || t('envCheck.unknown')} [${p.library}]` : (p.name || t('envCheck.unknown'));
    const meta = [state, devices].filter(Boolean).join(', ');
    return `${name} (${meta})`;
  }).join('; ');
}

/**
 * 生成弹层分区与复制文本。
 *
 * @param {object} report `getEnvReport()` 的返回值
 * @param {object|null} probes `getEnvCheckProbes()` 的返回值（可能尚未到达）
 * @param {(key:string, params?:object)=>string} t 渲染层 i18n
 * @returns {{sections:Array<{key:string, title:string, rows:Array<{label:string, value:string}>}>, plainText:string}}
 */
export function buildEnvCheckView(report, probes, t, options = {}) {
  const r = report || {};
  const os = r.os || {};
  const cpu = r.cpu || {};
  const memory = r.memory || {};
  const gpu = r.gpu || { supported: false, phase: 'none', items: [] };
  const winml = r.winml || { gate: 'settingOff', detail: {} };
  const settings = r.settings || {};
  const runtime = r.runtime || {};
  const probeWinml = probes && probes.winml ? probes.winml : null;
  const probeNpu = probes && probes.npu ? probes.npu : null;

  const unknown = t('envCheck.unknown');
  // GPU 两阶段检测：full 之前显存数字不可信（WMI AdapterRAM 是 uint32），
  // 显示「检测中…」；轮询超过主进程 15s 兜底后改显示「检测超时」，
  // 避免用户对着一个永远转不完的「检测中」发呆。
  const gpuPendingText = options.gpuTimedOut ? t('envCheck.timeout') : t('envCheck.detecting');

  // ---- 系统 ----
  const systemRows = [
    {
      // 非 Windows 上显示「Windows 版本」会自相矛盾（值会是 Linux 6.x），
      // 换一个中性标签；Windows 上仍用用户要求的「Windows 版本」。
      label: r.isWindows ? t('envCheck.osVersion') : t('envCheck.osVersionGeneric'),
      value: os.display || unknown,
    },
  ];
  const threads = Number(cpu.threads) || 0;
  systemRows.push({
    label: t('envCheck.cpu'),
    value: [
      cpu.model || '',
      threads > 0 ? t('envCheck.threads', { count: threads }) : '',
    ].filter(Boolean).join(' · ') || unknown,
  });
  const totalRam = formatBytesHuman(memory.totalBytes);
  const freeRam = formatBytesHuman(memory.freeBytes);
  systemRows.push({
    label: t('envCheck.ram'),
    value: totalRam
      ? t('envCheck.ramValue', { total: totalRam, free: freeRam || unknown })
      : unknown,
  });

  // ---- 显卡 ----
  const gpuRows = [];
  if (!gpu.supported) {
    gpuRows.push({ label: t('envCheck.gpuStatus'), value: t('envCheck.notSupported') });
  } else if (!gpu.items || gpu.items.length === 0) {
    gpuRows.push({
      label: t('envCheck.gpuStatus'),
      value: gpu.phase === 'none' || gpu.phase === 'fast' ? gpuPendingText : unknown,
    });
  } else {
    // 分区标题已经是「显卡」，单卡时行标签改用「型号」，避免「显卡 → 显卡：xxx」
    // 这种标题与标签重复；多卡时才退回带序号的「显卡 N」。
    const multi = gpu.items.length > 1;
    gpu.items.forEach((item, index) => {
      gpuRows.push({
        label: multi ? t('envCheck.gpuIndexed', { index: index + 1 }) : t('envCheck.gpuModel'),
        value: `${item.name || unknown} · ${deviceLabel(item, t)}`,
      });
      gpuRows.push({
        label: t('envCheck.vram'),
        value: formatBytesHuman(item.vramBytes) || (gpu.phase === 'full' ? unknown : gpuPendingText),
      });
      gpuRows.push({
        label: t('envCheck.vramUsage'),
        value: vramRowValue(item, gpu.phase, t, gpuPendingText),
      });
      gpuRows.push({
        label: t('envCheck.driverVersion'),
        value: item.driverVersion || unknown,
      });
    });
  }

  // ---- AI 加速 ----
  const gateText = t(`envCheck.winmlGate.${winml.gate || 'settingOff'}`, {
    build: (winml.detail && winml.detail.build) || 0,
    minBuild: (winml.detail && winml.detail.minBuild) || 0,
    provider: (winml.detail && winml.detail.provider) || '',
  });
  const runtimeText = probeWinml && probeWinml.status
    ? t(`envCheck.winmlRuntime.${probeWinml.status}`)
    : '';
  const npuState = (probeNpu && probeNpu.state) || (r.npu && r.npu.state) || 'unknown';

  const aiRows = [
    {
      label: t('envCheck.winml'),
      value: runtimeText ? `${gateText} · ${runtimeText}` : gateText,
    },
  ];
  if (probeWinml && probeWinml.bridge && probeWinml.bridge.failureReason) {
    // 桥失败是本进程不可恢复的状态（ensureBridgeInit 单飞且失败不重试），
    // 单独一行放原因，方便直接贴进 issue。
    aiRows.push({
      label: t('envCheck.winmlReasonLabel'),
      value: String(probeWinml.bridge.failureReason),
    });
  }
  aiRows.push({
    label: t('envCheck.winmlProviders'),
    value: !winml.supported
      ? t('envCheck.notSupported')
      : (probeWinml
        ? providerLine(probeWinml.providers, t)
        : (winml.enabled ? t('envCheck.detecting') : t('envCheck.none'))),
  });
  aiRows.push({
    label: t('envCheck.npu'),
    value: t(`envCheck.npuState.${npuState}`),
  });
  aiRows.push({
    label: t('envCheck.backend'),
    value: [
      t(`envCheck.backendValue.${settings.nativeInferenceBackend || 'auto'}`),
      settings.inferenceProvider || '',
    ].filter(Boolean).join(' · '),
  });

  // ---- 运行时 ----
  const runtimeRows = [
    { label: t('envCheck.appVersion'), value: runtime.app || unknown },
    { label: t('envCheck.electronVersion'), value: runtime.electron || unknown },
    { label: t('envCheck.nodeVersion'), value: runtime.node || unknown },
    {
      label: t('envCheck.platform'),
      value: `${r.platform || ''} ${r.arch || ''}`.trim() || unknown,
    },
  ];

  const sections = [
    { key: 'system', title: t('envCheck.sectionSystem'), rows: systemRows },
    { key: 'gpu', title: t('envCheck.sectionGpu'), rows: gpuRows },
    { key: 'ai', title: t('envCheck.sectionAi'), rows: aiRows },
    { key: 'runtime', title: t('envCheck.sectionRuntime'), rows: runtimeRows },
  ];

  const lines = [
    `SXSEditor ${t('envCheck.title')}`,
    t('envCheck.kv', { label: t('envCheck.generatedAt'), value: formatTime(r.generatedAt) }),
    '='.repeat(60),
    '',
  ];
  for (const section of sections) {
    lines.push(`[${section.title}]`);
    for (const row of section.rows) {
      lines.push(t('envCheck.kv', { label: row.label, value: row.value }));
    }
    lines.push('');
  }

  return { sections, plainText: `${lines.join('\n').trimEnd()}\n` };
}
