import { state, trackManager } from './state.js';
import { initI18n, applyLocale, getLocale, tOr } from '../i18n/index.js';
import { markDirty, autoSaveProject, saveProject, showSaveBeforeCloseDialog, cancelPendingAutoSave } from './projectManager.js';
import { refreshAll, invalidateFragmentNoteSprites, invalidateSingerListCache } from './timelineRenderer.js';
import { showAlertDialog } from '../alertDialog.js';
// 2.2: 与主题管理共用同一份 token 注入实现，不再在本文件里复制一份。
import { injectTokens } from '../themes/themeInit.js';
import { refreshTransportLabels } from './transport.js';
import { normalizePostprocessState } from '../shared/postprocessCurves.js';

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

// Singer edited IPC handler: a .sxssinger was edited and saved from the
// preprocessing window. Update the singer that was loaded from that exact
// file (by path) instead of adding a duplicate entry.
if (window.electronAPI?.onSingerUpdated) {
  const cleanup = window.electronAPI.onSingerUpdated((data) => {
    const singers = trackManager.getSingers();
    const singer = singers.find(s => s.singerFilePath && s.singerFilePath === data.filePath);
    if (!singer) return; // 只是磁盘文件被改，项目里没加载它 —— 无需处理

    trackManager.updateSinger(singer.id, {
      singerName: data.singerName,
      trackName: data.singerName,
      color: data.color,
      ...(data.avatarPath ? { avatarPath: data.avatarPath } : {}),
    });
    if (data.wavBuffer) singer.wavBuffer = data.wavBuffer;
    if (data.midiNotes) singer.midiNotes = data.midiNotes;
    if (data.f0Data) singer.f0Data = data.f0Data;
    if (data.singerData) singer.singerData = data.singerData;

    invalidateSingerListCache();
    markDirty();
    refreshAll();
  });
  if (cleanup) state._ipcCleanups.push(cleanup);
}

// Fragment saved IPC handler
if (window.electronAPI?.onFragmentSaved) {
  const cleanup = window.electronAPI.onFragmentSaved((data) => {
    const { fragmentId, notes, envelopes, pitchCurve, kanjiGroups, postprocess, startTime, duration } = data;
    const fragment = trackManager.getFragments().find(f => f.id === fragmentId);
    if (fragment) {
      if (notes) fragment.notes = notes;
      if (envelopes) fragment.envelopes = envelopes;
      if (pitchCurve) fragment.pitchCurve = pitchCurve;
      if (kanjiGroups) fragment.kanjiGroups = kanjiGroups;
      // 音色 / 后处理曲线（F0 平滑、频谱后处理）：随分片保存，主窗口只做透传持久化。
      // 归一化后再存：手改工程或跨版本字段越界时，越界值不会随保存回填进工程
      // 文件累积（消费侧 sampleParamAt 虽有 clamp 兜底不会崩，但读数与存档会
      // 长期不一致）。分片编辑器侧已归一化，此处幂等。
      if (postprocess) fragment.postprocess = normalizePostprocessState(postprocess);
      if (startTime !== undefined) fragment.startTime = startTime;
      if (duration !== undefined) fragment.duration = duration;
      // 音符内容可能已变（增删改），分片预览精灵必须重建，否则拖到主窗口
      // 仍显示旧音符。
      invalidateFragmentNoteSprites();
    }
    refreshAll();
    // 分片编辑是实打实的工程改动，必须标脏。
    // ad3dfdc 给 autoSaveProject 加了 400ms 防抖之后，这一行缺失会变成静默丢数据：
    //   改完分片 → 主窗口 isDirty 仍为 false → 400ms 内关闭主窗口 →
    //   主进程认为工程干净、不弹保存提示 → 渲染进程被销毁、防抖定时器永不执行
    //   → 磁盘上还是编辑前的版本，用户毫无感知。
    markDirty();
    autoSaveProject();
  });
  if (cleanup) state._ipcCleanups.push(cleanup);
}

// i18n 初始化统一由 index.js 负责（本文件不再重复 initI18n，避免重复读取
// localStorage / 主进程 locale 的竞态）。

// 语言切换后除了静态 [data-i18n] 文本，动态构建的歌手列表与 canvas 文案也必须
// 重建：歌手列表有缓存键，需先失效再 refreshAll。
function _refreshLocalizedUI() {
  applyLocale();
  document.documentElement.lang = getLocale();
  invalidateSingerListCache();
  refreshAll();
  // applyLocale 会把三个传输按钮的 title/aria-label 重写成静态的
  // main.play/pause/stop；合成期间它们应该是"取消推理"，必须重新派生一次。
  refreshTransportLabels();
}

document.addEventListener('localeChanged', () => {
  _refreshLocalizedUI();
});

// Locale changed IPC handler
if (window.electronAPI?.onLocaleChanged) {
  const cleanup = window.electronAPI.onLocaleChanged(async () => {
    await initI18n();
    _refreshLocalizedUI();
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
    // 关闭确认期间不得让后台自动保存落盘：用户可能在对话框里选择“不保存”，
    // 若 pending 定时器此刻触发，会把用户明确要丢弃的改动写进文件。
    cancelPendingAutoSave();
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
      // 对话框/保存流程出错时绝不关窗：关闭会静默丢弃未保存改动。
      // 保持窗口打开并明确告知失败原因。
      console.error('Close confirmation dialog error:', err);
      try {
        showAlertDialog(tOr(
          'main.closeConfirmFailed',
          'Failed to confirm closing the window: {error}\n\nYour changes were not saved, so the window stays open.',
          { error: err?.message || String(err) },
        ));
      } catch (_) {}
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
