import {
  getSampleRate, setSampleRate,
  getPipelineInitialized, setPipelineInitialized,
  getPipelineInitPromise, setPipelineInitPromise,
  getFragmentAudioSettings,
} from './state.js';

export function initPipeline() {
  if (getPipelineInitialized()) return Promise.resolve();
  if (getPipelineInitPromise()) return getPipelineInitPromise();

  const overlay = document.getElementById('model-loading-overlay');
  if (overlay) overlay.classList.add('visible');

  const promise = (async () => {
    try {
      setSampleRate(await window.electronAPI.getFragmentSVSSampleRate());
      await window.electronAPI.initFragmentSVSPipeline();
      setPipelineInitialized(true);
      console.log('[FragmentEditor] SVS Pipeline initialized');
    } catch (err) {
      console.error('[FragmentEditor] SVS Pipeline init failed:', err);
      setPipelineInitPromise(null);
      throw err;
    } finally {
      if (overlay) overlay.classList.remove('visible');
    }
  })();

  setPipelineInitPromise(promise);
  return promise;
}

export function getFragmentPreviewInferenceOptions() {
  const settings = getFragmentAudioSettings();
  return {
    nSteps: settings?.previewDiffSteps ?? 16,
    cfg: settings?.previewCfgStrength ?? 3.0,
    cfgRescale: settings?.previewCfgRescale ?? 0.75,
    sampler: settings?.previewSampler ?? 'stork2',
    npuDiffBatchSize: 1,
    npuVocoderBatchSize: 1,
    diffStepChunk: settings?.previewDiffStepChunkEnabled === true,
    diffStepChunkFrames: settings?.previewDiffStepChunkFrames ?? 500,
    diffStepOverlapFrames: settings?.previewDiffStepOverlapFrames ?? 50,
    // P1: CFG 强度调度（低→高）。pipeline 侧 mode='fixed'/null 退回常量行为。
    cfgSchedule: buildFragmentCfgSchedule(settings, 'preview'),
  };
}

export function getFragmentExportInferenceOptions() {
  const settings = getFragmentAudioSettings();
  return {
    nSteps: settings?.exportDiffSteps ?? 32,
    cfg: settings?.exportCfgStrength ?? 3.0,
    cfgRescale: settings?.exportCfgRescale ?? 0.75,
    sampler: settings?.exportSampler ?? 'stork2',
    npuDiffBatchSize: 1,
    npuVocoderBatchSize: 1,
    cfgSchedule: buildFragmentCfgSchedule(settings, 'export'),
  };
}

/**
 * P1: 从 settings 构建 cfgSchedule 对象，传给 pipeline._normalizeCfgSchedule。
 * 缺省或 mode='fixed' 时返回 null（pipeline 退回常量 cfgStrength 行为）。
 * 默认 mode='cosine'：A-CFG / dynamic CFG 文献表明早期低引导、后期高引导可减少伪影。
 */
function buildFragmentCfgSchedule(settings, prefix) {
  if (!settings) return null;
  const mode = settings[`${prefix}CfgScheduleMode`];
  if (!mode || mode === 'fixed') return null;
  if (!['linear', 'cosine'].includes(mode)) return null;
  const cfgStrength = settings[`${prefix}CfgStrength`] ?? 3.0;
  const startStrength = Number.isFinite(settings[`${prefix}CfgScheduleStartStrength`])
    ? settings[`${prefix}CfgScheduleStartStrength`] : 1.0;
  const endStrength = Number.isFinite(settings[`${prefix}CfgScheduleEndStrength`])
    ? settings[`${prefix}CfgScheduleEndStrength`] : cfgStrength;
  return { mode, startStrength, endStrength };
}
