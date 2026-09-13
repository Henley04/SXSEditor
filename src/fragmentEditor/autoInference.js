import {
  getFragmentAudioSettings,
  getFragmentCurrentTime,
  getFragmentAudioDataSignature,
  getDragMode,
  getCurrentFragment,
} from './state.js';
import {
  loadFragmentAudioSettings,
  computeFragmentAudioSignature,
  synthesizeFragmentInBackground,
} from './audioPlayback.js';

// ==================== 编辑后自动实时推理 ====================
//
// 由设置项 `autoRealtimeInference` 控制，默认关闭（见 src/main/settings.js）。
//
// 设计要点：
// 1) 变更检测：轮询比对"当前合成输入签名"与"上次合成成功时的签名"。签名由
//    audioPlayback.computeFragmentAudioSignature() 计算，覆盖 notes 内容
//    （歌词/音高/时值/滑音/音素微调/颤音）、bpm、pitchCurveF0、参考音频、
//    autoShift、singerId 与预览推理参数 —— 即任何会改变输出音频的编辑。
// 2) 防抖：拖拽音符/画笔拉曲线期间不做任何重活，内容稳定 DEBOUNCE_MS 后才触发。
// 3) 分段兼容：真正的"只推理改动分段"由主进程的分片级缓存完成
//    （OnnxSVSPipeline._segCacheMap）：未改动 segment 的缓存键不变 → 直接命中，
//    跳过 diffusion+vocoder。这里刻意不触碰任何清缓存路径。
// 4) 优先次序：把播放进度条位置作为 priorityTimeSec 传给主进程，主进程据此决定
//    多 segment 的推理遍历起点；缺失时退化为"第一个未命中缓存的分段"。

// 签名轮询间隔（ms）。远小于一次推理耗时，用于及时感知"停下来了"。
const POLL_INTERVAL_MS = 400;
// 内容稳定多久后才真正开始推理（ms）。避免拖拽/连续输入过程中反复触发。
const DEBOUNCE_MS = 900;
// 设置拉取间隔（ms）。设置窗口可能在分片编辑器打开期间随时开关此功能。
const SETTINGS_REFRESH_MS = 3000;
// 推理失败后的冷却时间（ms），避免模型缺失/显存不足时每秒重试。
const ERROR_COOLDOWN_MS = 15000;

let _pollTimer = null;
let _debounceTimer = null;
let _pendingSignature = null;
let _settingsRefreshedAt = 0;
let _blockedUntil = 0;
let _running = false;

function _isEnabled() {
  return getFragmentAudioSettings()?.autoRealtimeInference === true;
}

async function _refreshSettingsIfStale() {
  const now = Date.now();
  if (now - _settingsRefreshedAt < SETTINGS_REFRESH_MS) return;
  _settingsRefreshedAt = now;
  try {
    await loadFragmentAudioSettings();
  } catch (_) {
    // 拉取失败：保持上一次的设置快照，下个周期再试
  }
}

function _scheduleWithDebounce() {
  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    _debounceTimer = null;
    void _runPending();
  }, DEBOUNCE_MS);
}

async function _runPending() {
  if (_running) return;
  if (Date.now() < _blockedUntil) return;
  if (!_isEnabled() || !getCurrentFragment()) return;
  // 拖拽过程中不抢占 GPU/显存，等下一轮轮询再决策。
  if (getDragMode() !== null) return;

  // 异步间隙里状态可能已变（用户手动播放同步了音频 / 内容又被改动），
  // 一律放弃本次后台推理，让下次检测重新决策。
  const lastSynth = getFragmentAudioDataSignature();
  if (lastSynth === null) return;
  const pending = _pendingSignature;
  if (!pending || pending === lastSynth) return;

  _running = true;
  try {
    // 优先推理播放进度条所在分段：fragmentCurrentTime 是相对分片起点的秒数，
    // 与 pipeline 中 segment 的绝对时间坐标系一致。
    const result = await synthesizeFragmentInBackground({ priorityTimeSec: getFragmentCurrentTime() });
    // 只有真正的推理失败（模型缺失 / 显存不足等）才进入冷却；
    // 'skip' 是主动放弃（用户接管播放、内容又变了等），下一次轮询会自然重试。
    if (result === 'error') {
      _blockedUntil = Date.now() + ERROR_COOLDOWN_MS;
    }
  } finally {
    _running = false;
  }
}

async function _tick() {
  try {
    await _refreshSettingsIfStale();
    if (!_isEnabled()) return;
    if (!getCurrentFragment()) return;

    const sig = computeFragmentAudioSignature();
    // 与已合成版本一致 → 没有需要追赶的改动
    if (sig === getFragmentAudioDataSignature()) return;
    // 同一份内容已在防抖等待中 → 重置计时即可（内容又动了一次）
    if (sig === _pendingSignature && _debounceTimer) return;

    _pendingSignature = sig;
    _scheduleWithDebounce();
  } catch (_) {
    // 签名计算失败（如 DOM 尚未就绪 / fragment 未加载）直接跳过本轮
  }
}

/**
 * 启动自动推理监听。幂等，可重复调用。
 * 建议在分片数据加载完成之后调用；在此之前 getCurrentFragment() 为空会直接空转。
 */
export function startAutoInferenceWatcher() {
  if (_pollTimer) return;
  _settingsRefreshedAt = 0;
  _pollTimer = setInterval(() => { void _tick(); }, POLL_INTERVAL_MS);
}

/** 停止监听（窗口关闭 / 切换分片时调用）。 */
export function stopAutoInferenceWatcher() {
  if (_pollTimer) {
    clearInterval(_pollTimer);
    _pollTimer = null;
  }
  if (_debounceTimer) {
    clearTimeout(_debounceTimer);
    _debounceTimer = null;
  }
  _pendingSignature = null;
}
