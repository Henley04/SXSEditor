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
      console.error('[FragmentEditor] SVS Pipeline 初始化失败:', err);
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
    npuDiffBatchSize: settings?.npuDiffBatchSize ?? 4,
    npuVocoderBatchSize: settings?.npuVocoderBatchSize ?? 4,
  };
}

export function getFragmentExportInferenceOptions() {
  const settings = getFragmentAudioSettings();
  return {
    nSteps: settings?.exportDiffSteps ?? 32,
    cfg: settings?.exportCfgStrength ?? 3.0,
    cfgRescale: settings?.exportCfgRescale ?? 0.75,
    npuDiffBatchSize: settings?.npuDiffBatchSize ?? 4,
    npuVocoderBatchSize: settings?.npuVocoderBatchSize ?? 4,
  };
}
