import { state, trackManager } from './state.js';
import { initI18n, applyLocale, getLocale, tOr } from '../i18n/index.js';
import { markDirty, autoSaveProject, saveProject, showSaveBeforeCloseDialog } from './projectManager.js';
import { refreshAll } from './timelineRenderer.js';
import { showAlertDialog } from '../alertDialog.js';

// int8 旧版 diff_step 模型不兼容弹窗（主进程在 svs:init 时检测并推送一次）
if (window.electronAPI?.onSVSDiffStepIncompatible) {
  const cleanup = window.electronAPI.onSVSDiffStepIncompatible(() => {
    showAlertDialog(tOr('main.diffStepLegacyInt8Incompatible', 'An incompatible legacy INT8 diff_step model was detected. Please update the model.'));
  });
  if (cleanup) state._ipcCleanups.push(cleanup);
}

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
    const { fragmentId, notes, envelopes, pitchCurve, kanjiGroups, startTime, duration } = data;
    const fragment = trackManager.getFragments().find(f => f.id === fragmentId);
    if (fragment) {
      if (notes) fragment.notes = notes;
      if (envelopes) fragment.envelopes = envelopes;
      if (pitchCurve) fragment.pitchCurve = pitchCurve;
      if (kanjiGroups) fragment.kanjiGroups = kanjiGroups;
      if (startTime !== undefined) fragment.startTime = startTime;
      if (duration !== undefined) fragment.duration = duration;
    }
    refreshAll();
    autoSaveProject();
  });
  if (cleanup) state._ipcCleanups.push(cleanup);
}

// i18n initialization
initI18n().then(() => {
  applyLocale();
  document.documentElement.lang = getLocale();
});

document.addEventListener('localeChanged', () => {
  applyLocale();
});

// Locale changed IPC handler
if (window.electronAPI?.onLocaleChanged) {
  const cleanup = window.electronAPI.onLocaleChanged(async () => {
    await initI18n();
    applyLocale();
    document.documentElement.lang = getLocale();
  });
  if (cleanup) state._ipcCleanups.push(cleanup);
}

// Close confirm IPC handler
if (window.electronAPI?.onCloseConfirm) {
  function doCloseConfirmed() {
    if (window.electronAPI?.closeConfirmed) {
      window.electronAPI.closeConfirmed();
    }
  }

  const cleanupClose = window.electronAPI.onCloseConfirm(async () => {
    try {
      const result = await showSaveBeforeCloseDialog();
      if (result === 'save') {
        const res = await saveProject();
        if (res && res.saved && !state.isDirty) {
          doCloseConfirmed();
        }
        // If save was canceled or failed, leave the window open.
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
      const mod = await import('../inference/webnn/index.js');
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

  // Model file prefetch — pre-read file into OS cache to overlap I/O with NPU compilation
  api.onWebnnPrefetchRequest(async ({ modelPath }) => {
    try {
      await api.webnnReadModelFile(modelPath);
    } catch (_) {}
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
        // Progress callback: forward to main process via IPC
        const onProgress = (progress) => {
          try { api.webnnProgress(`webnn:progress:${requestId}`, { progress }); } catch (_) {}
        };
        // Chunk audio callback: 流式推送 vocoder chunk 到主进程（主进程再转发到 fragment 窗口）
        const onChunkComplete = (chunkInfo) => {
          try {
            // Float32Array 通过 structured clone 传输；主进程监听 chunkChannel
            api.webnnChunk(`webnn:runSynthesis:response:chunk:${requestId}`, chunkInfo);
          } catch (e) {
            console.warn('[WebNN] Failed to forward chunk audio:', e.message);
          }
        };
        // Array params = batch synthesis (2 segments, batch=4) — batch 路径暂不支持流式
        if (Array.isArray(params)) {
          result = await pipeline.runSynthesisBatch(params.map(p => ({ ...p, onProgress })));
        } else {
          result = await pipeline.runSynthesis({ ...params, onProgress, onChunkComplete });
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

// ==================== Theme initialization ====================
// Apply saved theme on startup and listen for theme changes
(async () => {
  const api = window.electronAPI;
  if (!api?.themeAPI) return;

  function injectTokens(tokens) {
    if (!tokens || typeof document === 'undefined') return;
    const root = document.documentElement;
    // Clear previous theme inline styles to avoid stale tokens from prior themes
    const toRemove = [];
    for (let i = 0; i < root.style.length; i++) {
      if (root.style[i].startsWith('--')) toRemove.push(root.style[i]);
    }
    for (const prop of toRemove) root.style.removeProperty(prop);
    // Apply new theme tokens
    for (const [k, v] of Object.entries(tokens)) {
      try { root.style.setProperty(k, v); } catch (_) {}
    }
  }

  async function applyTheme(themeId) {
    if (!themeId) return;
    try {
      const themeObj = await api.themeAPI.get(themeId);
      if (themeObj && themeObj.tokens) {
        injectTokens(themeObj.tokens);
      }
    } catch (_) {}
  }

  try {
    const bootstrap = await api.themeAPI.bootstrap();
    if (bootstrap && bootstrap.themeId) {
      await applyTheme(bootstrap.themeId);
    }
  } catch (_) {}

  if (api.themeAPI.onChanged) {
    const cleanup = api.themeAPI.onChanged(async (data) => {
      if (data && data.themeId) {
        await applyTheme(data.themeId);
      }
    });
    if (cleanup) state._ipcCleanups.push(cleanup);
  }
})();
