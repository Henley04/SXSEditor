import {
  setSampleRate,
  getPipelineInitialized, setPipelineInitialized,
  getPipelineInitPromise, setPipelineInitPromise,
  getFragmentAudioSettings,
} from './state.js';
import { resolveQDriftDefault } from '../inference/pipeline/qdrift/defaults.js';

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
    cfgRescale: settings?.previewCfgRescale ?? 0.7,
    // 兜底采样器与主窗口/管线默认值（samplers/index.js DEFAULT_SOLVER）保持一致。
    sampler: settings?.previewSampler ?? 'stork2',
    qdrift: resolveQDriftDefault(settings, 'previewEnableQDrift'),
    npuDiffBatchSize: 1,
    npuVocoderBatchSize: 1,
    diffStepChunk: settings?.previewDiffStepChunkEnabled === true,
    diffStepChunkFrames: settings?.previewDiffStepChunkFrames ?? 500,
    diffStepOverlapFrames: settings?.previewDiffStepOverlapFrames ?? 50,
  };
}

export function getFragmentExportInferenceOptions() {
  const settings = getFragmentAudioSettings();
  return {
    nSteps: settings?.exportDiffSteps ?? 32,
    cfg: settings?.exportCfgStrength ?? 3.0,
    cfgRescale: settings?.exportCfgRescale ?? 0.7,
    sampler: settings?.exportSampler ?? 'stork2',
    qdrift: resolveQDriftDefault(settings, 'exportEnableQDrift'),
    npuDiffBatchSize: 1,
    npuVocoderBatchSize: 1,
  };
}
