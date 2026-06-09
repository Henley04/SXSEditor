import { state, dom, trackManager } from './state.js';
import { initI18n, applyLocale, getLocale } from '../i18n/index.js';
import { markDirty, markClean, autoSaveProject, showSaveBeforeCloseDialog } from './projectManager.js';
import { refreshAll } from './timelineRenderer.js';

// Singer created IPC handler
if (window.electronAPI?.onSingerCreated) {
  const cleanup = window.electronAPI.onSingerCreated((singerData) => {
    const singer = trackManager.addSinger({
      trackName: singerData.singerName,
      singerName: singerData.singerName,
      color: singerData.color,
      avatarPath: singerData.avatarPath,
      wavPath: singerData.wavPath,
      midiPath: singerData.midiPath,
      singerFilePath: singerData.filePath || null,
      singerFileMissing: false,
    });
    if (singerData.wavBuffer) {
      singer.wavBuffer = singerData.wavBuffer;
    }
    if (singerData.midiNotes) {
      singer.midiNotes = singerData.midiNotes;
    }
    if (singerData.f0Data) {
      singer.f0Data = singerData.f0Data;
    }
    if (singerData.singerData) {
      singer.singerData = singerData.singerData;
    }
    state.selectedSingerId = singer.id;
    markDirty();
    refreshAll();
  });
  if (cleanup) state._ipcCleanups.push(cleanup);
}

// Fragment saved IPC handler
if (window.electronAPI?.onFragmentSaved) {
  const cleanup = window.electronAPI.onFragmentSaved((data) => {
    const { fragmentId, notes, envelopes, pitchCurve, startTime, duration } = data;
    const fragment = trackManager.getFragments().find(f => f.id === fragmentId);
    if (fragment) {
      if (notes) fragment.notes = notes;
      if (envelopes) fragment.envelopes = envelopes;
      if (pitchCurve) fragment.pitchCurve = pitchCurve;
      if (startTime !== undefined) fragment.startTime = startTime;
      if (duration !== undefined) fragment.duration = duration;
    }
    refreshAll();
    autoSaveProject();
  });
  if (cleanup) state._ipcCleanups.push(cleanup);
}

// i18n initialization
initI18n();
applyLocale();
document.documentElement.lang = getLocale();

document.addEventListener('localeChanged', () => {
  applyLocale();
});

// Locale changed IPC handler
if (window.electronAPI?.onLocaleChanged) {
  const cleanup = window.electronAPI.onLocaleChanged(() => {
    location.reload();
  });
  if (cleanup) state._ipcCleanups.push(cleanup);
}

// Close confirm IPC handler
if (window.electronAPI?.onCloseConfirm) {
  let closeAfterSave = false;
  let closeSavePollTimer = null;
  let closeSaveTimeoutTimer = null;

  function cleanupCloseTimers() {
    if (closeSavePollTimer) { clearInterval(closeSavePollTimer); closeSavePollTimer = null; }
    if (closeSaveTimeoutTimer) { clearTimeout(closeSaveTimeoutTimer); closeSaveTimeoutTimer = null; }
    closeAfterSave = false;
  }

  function doCloseConfirmed() {
    cleanupCloseTimers();
    if (window.electronAPI?.closeConfirmed) {
      window.electronAPI.closeConfirmed();
    }
  }

  // Intercept save button click to close window after save
  dom.btnSave.addEventListener('click', function onSaveForClose() {
    if (!closeAfterSave) return;
    cleanupCloseTimers();
    closeSavePollTimer = setInterval(() => {
      if (!state.isDirty) doCloseConfirmed();
    }, 100);
    closeSaveTimeoutTimer = setTimeout(() => {
      doCloseConfirmed();
    }, 10000);
  });

  const cleanupClose = window.electronAPI.onCloseConfirm(async () => {
    try {
      const result = await showSaveBeforeCloseDialog();
      if (result === 'save') {
        closeAfterSave = true;
        dom.btnSave.click();
      } else if (result === 'discard') {
        doCloseConfirmed();
      }
      // result === 'cancel' -> do nothing, window stays open
    } catch (err) {
      console.error('Close confirmation dialog error:', err);
      doCloseConfirmed();
    }
  });
  if (cleanupClose) state._ipcCleanups.push(cleanupClose);
}

// ==================== WebNN renderer process listeners ====================
// Handle WebNN requests from main process (NPU detection, Model load/unload/inference)
(async () => {
  let webnnPipeline = null;

  async function getWebnnPipeline() {
    if (webnnPipeline) return webnnPipeline;
    try {
      const mod = await import('../inference/webnnPipeline.js');
      webnnPipeline = mod;
      return webnnPipeline;
    } catch (e) {
      console.error('[Renderer] Failed to load webnnPipeline:', e);
      return null;
    }
  }

  const api = window.electronAPI;
  if (!api) return;

  // NPU detection request
  api.onWebnnDetectNPURequest(async ({ requestId }) => {
    const pipeline = await getWebnnPipeline();
    let result;
    if (pipeline) {
      try {
        result = await pipeline.detectNPU();
      } catch (e) {
        result = { webnnAvailable: false, npuAvailable: false, gpuAvailable: false, details: e.message };
      }
    } else {
      result = { webnnAvailable: false, npuAvailable: false, gpuAvailable: false, details: 'webnnPipeline module not available' };
    }
    api.webnnRespond(`webnn:detectNPU:response:${requestId}`, result);
  });

  // Model load request
  api.onWebnnLoadModelRequest(async ({ requestId, modelId, modelPath, options }) => {
    console.log(`[Renderer] WebNN load request: ${modelId} (${modelPath})`);
    let result;
    try {
      const pipeline = await getWebnnPipeline();
      if (!pipeline) {
        result = { success: false, error: 'webnnPipeline module not available' };
      } else {
        result = await pipeline.loadModel(modelId, modelPath, options);
      }
    } catch (e) {
      console.error(`[Renderer] WebNN load error: ${e.message}`);
      result = { success: false, error: e.message };
    }
    console.log(`[Renderer] WebNN load result for ${modelId}:`, JSON.stringify(result));
    api.webnnRespond(`webnn:loadModel:response:${requestId}`, result);
  });

  // Model unload request
  api.onWebnnUnloadModelRequest(async ({ requestId, modelId }) => {
    const pipeline = await getWebnnPipeline();
    let result;
    if (pipeline) {
      try {
        await pipeline.unloadModel(modelId);
        result = { success: true };
      } catch (e) {
        result = { success: false, error: e.message };
      }
    } else {
      result = { success: false, error: 'webnnPipeline module not available' };
    }
    api.webnnRespond(`webnn:unloadModel:response:${requestId}`, result);
  });

  // Inference request
  api.onWebnnRunInferenceRequest(async ({ requestId, modelId, inputs }) => {
    const pipeline = await getWebnnPipeline();
    let result;
    if (pipeline) {
      try {
        result = await pipeline.runInference(modelId, inputs);
      } catch (e) {
        result = { error: e.message };
      }
    } else {
      result = { error: 'webnnPipeline module not available' };
    }
    api.webnnRespond(`webnn:runInference:response:${requestId}`, result);
  });

  // Status query request
  api.onWebnnGetStatusRequest(async ({ requestId }) => {
    const pipeline = await getWebnnPipeline();
    let result;
    if (pipeline) {
      result = pipeline.getStatus();
    } else {
      result = {};
    }
    api.webnnRespond(`webnn:getStatus:response:${requestId}`, result);
  });

  // Full synthesis pipeline request (runs in renderer process to eliminate per-IPC overhead)
  api.onWebnnRunSynthesisRequest(async ({ requestId, params }) => {
    const pipeline = await getWebnnPipeline();
    let result;
    if (pipeline) {
      try {
        // Array params = batch synthesis (2 segments, batch=4)
        if (Array.isArray(params)) {
          result = await pipeline.runSynthesisBatch(params);
        } else {
          result = await pipeline.runSynthesis(params);
        }
      } catch (e) {
        result = { error: e.message };
      }
    } else {
      result = { error: 'webnnPipeline module not available' };
    }
    api.webnnRespond(`webnn:runSynthesis:response:${requestId}`, result);
  });
})();
