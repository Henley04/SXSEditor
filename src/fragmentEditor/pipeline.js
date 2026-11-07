import {
  setSampleRate,
  getPipelineInitialized, setPipelineInitialized,
  getPipelineInitPromise, setPipelineInitPromise,
  getFragmentAudioSettings,
  getCurrentFragment, getTrackBackend,
} from './state.js';
import { needsBuiltinForFragment } from '../shared/pipelineDecision.js';
import { resolveQDriftDefault } from '../inference/pipeline/qdrift/defaults.js';
import { showConfirmDialog } from '../alertDialog.js';
import { t } from '../i18n/index.js';

// 只提示一次：用户点"取消"之后每次切分片都再弹一遍是很糟的体验，
// 但重启窗口/应用后应该能再提示（模块级变量随窗口重建而重置）。
let _modelMissingNotified = false;

// 加载遮罩上的等待时长。10 秒后再补一句预期范围，避免用户以为卡死。
// 主进程会推 svs:loadProgress（stage/percent/current/total），有事件时以进度条为准，
// 没有时（旧后端 / 无进度实现）仍靠秒数兜底。
let _loadingTicker = null;
function stopLoadingTicker() {
  if (_loadingTicker) {
    clearInterval(_loadingTicker);
    _loadingTicker = null;
  }
}

let _loadingProgressCleanup = null;
let _loadingDetached = false; // 用户点了"先在后台加载"

function setStatusModelText(text, busy = false) {
  const el = document.getElementById('status-model-text');
  if (el) el.textContent = text;
  // 加载中亮强调色指示灯，就绪后回落到默认色（否则"Ready"也顶着一颗高亮灯）
  const led = document.getElementById('status-model-led');
  if (led) led.classList.toggle('led-accent', busy === true);
}

function describeStage(payload) {
  const stage = String(payload.stage || 'model');
  if (stage === 'hardware') return t('fragment.loadStageHardware');
  if (stage === 'resolve') return t('fragment.loadStageResolve');
  const current = Number(payload.current) || 0;
  const total = Number(payload.total) || 0;
  if (total > 0) return t('fragment.loadStageModel', { current, total });
  return t('fragment.loadStageModelBare');
}

function renderLoadProgress(payload) {
  const percent = Math.max(0, Math.min(100, Math.round(Number(payload.percent) || 0)));
  const stageText = describeStage(payload);
  // 状态栏：即使遮罩被收进后台，进度也要一直看得见
  setStatusModelText(`${stageText} · ${percent}%`, true);

  const box = document.getElementById('model-loading-progress');
  const fill = document.getElementById('model-loading-progress-fill');
  const meta = document.getElementById('model-loading-progress-meta');
  if (box) box.hidden = false;
  if (fill) fill.style.width = `${percent}%`;
  if (meta) meta.textContent = `${stageText} · ${percent}%`;
}

function startLoadingTicker() {
  const el = document.getElementById('model-loading-elapsed');
  if (!el) return;
  const startedAt = Date.now();
  const render = () => {
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    el.textContent = seconds >= 10
      ? t('fragment.loadingElapsedLong', { seconds })
      : t('fragment.loadingElapsed', { seconds });
  };
  render();
  _loadingTicker = setInterval(render, 1000);
}

function bindLoadProgress(overlay) {
  if (!window.electronAPI?.onSVSLoadProgress) return;
  try {
    _loadingProgressCleanup = window.electronAPI.onSVSLoadProgress(renderLoadProgress);
  } catch (err) {
    console.warn('[FragmentEditor] 订阅加载进度失败:', err);
  }

  const btn = document.getElementById('btn-loading-background');
  if (btn) {
    btn.addEventListener('click', () => {
      // 没有真正的中止通道（主进程 init 不支持 cancel），所以不做假的"取消"：
      // 收起遮罩让用户先编辑音符，进度改到状态栏继续显示，加载本身不受影响。
      _loadingDetached = true;
      if (overlay) overlay.classList.remove('visible');
      stopLoadingTicker();
      setStatusModelText(t('fragment.loadBackgroundRunning'), true);
    });
  }
}

function unbindLoadProgress() {
  if (typeof _loadingProgressCleanup === 'function') {
    try { _loadingProgressCleanup(); } catch (_) {}
  }
  _loadingProgressCleanup = null;
}

/**
 * 模型缺失的可操作出口。
 *
 * 这里刻意**不**依赖错误里的路径：IPC 边界会把绝对路径替换成 `<path>`
 * （`src/main/ipcSafe.js`），拿它拼文案只会拼出一句没用的 "Model file does not
 * exist: <path>"。改成一句人话 + 一个按钮。
 */
async function notifyModelMissing() {
  try {
    const openDownload = await showConfirmDialog(
      t('fragmentEditor.modelMissingPrompt'),
      { okText: t('fragmentEditor.openModelDownload'), danger: false },
    );
    if (openDownload && window.electronAPI?.modelDownloadOpen) {
      await window.electronAPI.modelDownloadOpen();
    }
  } catch (err) {
    // 对话框本身失败不能盖掉原始错误（那是用户真正需要排障的信息）
    console.warn('[FragmentEditor] 显示模型缺失提示失败:', err);
  }
}

export function initPipeline() {
  if (getPipelineInitialized()) return Promise.resolve();
  if (getPipelineInitPromise()) return getPipelineInitPromise();

  // 插件后端轨道不需要内置 ONNX 模型。短路必须早于加载遮罩与
  // getFragmentSVSSampleRate()，否则会连带推"加载模型"进度条、甚至因缺模型
  // 弹下载框。编辑器内三处"未初始化就 initPipeline()"的调用点因此自动不加载。
  if (!needsBuiltinForFragment(getCurrentFragment(), getTrackBackend())) {
    return Promise.resolve();
  }

  const overlay = document.getElementById('model-loading-overlay');
  if (overlay) {
    _loadingDetached = false;
    overlay.classList.add('visible');
    startLoadingTicker();
    bindLoadProgress(overlay);
  }

  const promise = (async () => {
    try {
      setSampleRate(await window.electronAPI.getFragmentSVSSampleRate());
      await window.electronAPI.initFragmentSVSPipeline();
      setPipelineInitialized(true);
      // 加载完成后状态栏回到 Ready，避免一直停在上次的"加载模型 99%"
      setStatusModelText(t('fragment.statusReady'));
      console.log('[FragmentEditor] SVS Pipeline initialized');
    } catch (err) {
      console.error('[FragmentEditor] SVS Pipeline init failed:', err);
      setPipelineInitPromise(null);
      setStatusModelText(t('fragment.loadFailed'), false);
      // 缺模型是可预期状态（首次安装、切了精度、删了目录），不是"程序坏了"。
      // ENOENT 也一并接住：某些路径下 stat 直接抛，消息里没有那句模板文案。
      const msg = String((err && err.message) || '');
      if (!_modelMissingNotified && /Model file does not exist|ENOENT/i.test(msg)) {
        _modelMissingNotified = true;
        notifyModelMissing();
      }
      throw err;
    } finally {
      stopLoadingTicker();
      unbindLoadProgress();
      if (overlay && !_loadingDetached) overlay.classList.remove('visible');
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
