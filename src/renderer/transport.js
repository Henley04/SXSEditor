/**
 * 传输控件（Play / Pause / Stop）的唯一状态机。
 *
 * 背景：此前三个按钮各自的 label 由十几次零散的 `setLabel(dom.btnPlay, …)`
 * 维护，没有任何单一真源，导致两个具体问题：
 *   1. 暂停后 btnPause 被改成"继续"（play 图标），而 btnPlay 一直是 play 图标
 *      → 界面上并排出现两个播放按钮，且两者点击行为**完全相同**（都是从
 *      playbackPauseOffset 继续播放）。
 *   2. 播放中拖拽 playhead 会先 pausePlayback()（btnPause → "继续"），松手恢复
 *      播放时没有任何代码把它改回"暂停"，按钮文案与真实状态脱节。
 *
 * 现在的约定：
 *   · 三个按钮的**图标永不改变**（play / pause / stop），只通过 disabled 表达
 *     可用性 —— 与 DAW 一致，用户不会看到图标语义前后矛盾。
 *   · 所有按钮状态只在本文件的 setTransport() 里派生，其他模块不得直接写
 *     btnPlay/btnPause/btnStop 的 disabled/title。
 *   · "正在合成"不再是 Play 按钮上的文案，而是右侧进度区的状态文本；
 *     Play 在合成期间保持可点，语义改为"取消推理"。
 */

import { state, dom } from './state.js';
import { t } from '../i18n/index.js';

export const TRANSPORT = {
    IDLE: 'idle',
    LOADING: 'loading',           // 模型加载中（pipeline init）
    SYNTHESIZING: 'synthesizing', // 推理中
    PLAYING: 'playing',
    PAUSED: 'paused',
};

let _state = TRANSPORT.IDLE;
let _progressVisible = false;

// ETA 基准：第一次收到进度时的 (时间, 百分比)。用"已用时间 / 已完成比例"
// 外推剩余时间，比逐帧差分稳定（进度回调本身是节流的、步长不均匀）。
let _etaStartAt = 0;
let _etaStartPct = -1;
let _etaSmoothedSec = -1;

export function getTransportState() {
    return _state;
}

function _isBusy() {
    return _state === TRANSPORT.LOADING || _state === TRANSPORT.SYNTHESIZING;
}

function _hasAudio() {
    return !!(state.currentAudioData && state.currentAudioData.length > 0);
}

/**
 * 派生并应用三个按钮的可用状态。
 *
 * | 状态 | Play | Pause | Stop |
 * |---|---|---|---|
 * | idle（无缓存音频） | 可点（合成并播放） | 禁用 | 禁用 |
 * | loading / synthesizing | 可点（= 取消） | 禁用 | 可点 |
 * | playing | 禁用 | 可点 | 可点 |
 * | paused | 可点（继续） | 禁用 | 可点 |
 */
function _applyButtonState() {
    const busy = _isBusy();
    const playing = _state === TRANSPORT.PLAYING;
    const paused = _state === TRANSPORT.PAUSED;

    if (dom.btnPlay) {
        dom.btnPlay.disabled = playing;
        // 合成期间 Play 的语义是"取消"，不是"播放"：给悬停提示与读屏标签
        const playLabelKey = busy ? 'main.cancelSynthesis' : 'main.play';
        const playLabel = t(playLabelKey);
        dom.btnPlay.title = playLabel;
        dom.btnPlay.setAttribute('aria-label', playLabel);
    }
    if (dom.btnPause) {
        dom.btnPause.disabled = !playing;
        const pauseLabel = t('main.pause');
        dom.btnPause.title = pauseLabel;
        dom.btnPause.setAttribute('aria-label', pauseLabel);
    }
    if (dom.btnStop) {
        dom.btnStop.disabled = !playing && !paused && !busy && !_hasAudio();
        const stopLabel = t('main.stop');
        dom.btnStop.title = stopLabel;
        dom.btnStop.setAttribute('aria-label', stopLabel);
    }
}

/**
 * 切换传输状态（唯一的写入口）。
 * @param {string} next TRANSPORT 之一
 */
export function setTransport(next) {
    if (next === _state) {
        _applyButtonState();
        return;
    }
    _state = next;
    // 离开忙态时清掉进度区，避免"合成中 100%"滞留在界面上
    if (!_isBusy() && _progressVisible) clearTransportStatus();
    _applyButtonState();
}

/**
 * 更新右侧进度区。
 *
 * 文本由调用方给出（"模型加载中" / "推理中"），百分比与 ETA 在这里统一拼装，
 * 保证两种阶段的时间估算方式一致。
 *
 * @param {string} label 阶段名（已本地化）
 * @param {number} percent 0–100；非有限值 → 只显示阶段名（不确定进度）
 */
export function setTransportProgress(label, percent) {
    if (!dom.transportStatus || !dom.transportStatusText) return;
    const pct = Number(percent);
    const hasPct = Number.isFinite(pct) && pct >= 0 && pct <= 100;

    let text = label;
    if (hasPct) {
        const eta = _updateEta(pct);
        text = eta == null
            ? t('main.statusWithPercent', { label, percent: Math.round(pct) })
            : t('main.statusWithPercentEta', { label, percent: Math.round(pct), time: _formatEta(eta) });
    }

    dom.transportStatusText.textContent = text;
    dom.transportStatus.classList.add('active');
    _progressVisible = true;

    if (dom.transportProgress && dom.transportProgressFill) {
        if (hasPct) {
            dom.transportProgress.hidden = false;
            dom.transportProgressFill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
        } else {
            dom.transportProgress.hidden = true;
        }
    }
}

/** 清空进度区并复位 ETA 基准。 */
export function clearTransportStatus() {
    _progressVisible = false;
    _etaStartAt = 0;
    _etaStartPct = -1;
    _etaSmoothedSec = -1;
    if (dom.transportStatus) dom.transportStatus.classList.remove('active');
    if (dom.transportStatusText) dom.transportStatusText.textContent = '';
    if (dom.transportProgressFill) dom.transportProgressFill.style.width = '0%';
    if (dom.transportProgress) dom.transportProgress.hidden = true;
}

/**
 * 用"已用时间 / 已完成比例"估算剩余秒数，并对结果做指数平滑。
 *
 * 为什么不用逐次差分：进度回调被主进程按 100ms / 2% 节流，步长不均匀，
 * 逐次差分会在 0%/1% 这种小步长上给出荒谬的估计（除以接近 0 的量）。
 * 用累计比例做分母天然稳定。
 *
 * @returns {number|null} 剩余秒数；样本不足时返回 null（不显示 ETA）
 */
function _updateEta(pct) {
    const now = Date.now();
    if (_etaStartPct < 0) {
        _etaStartPct = pct;
        _etaStartAt = now;
        return null;
    }
    const done = pct - _etaStartPct;
    const elapsedSec = (now - _etaStartAt) / 1000;
    // 至少完成 1%、且已过 0.4s 才值得外推，否则抖动太大
    if (done < 1 || elapsedSec < 0.4 || pct >= 100) return pct >= 100 ? 0 : null;

    const remaining = (elapsedSec / done) * (100 - pct);
    _etaSmoothedSec = _etaSmoothedSec < 0
        ? remaining
        : _etaSmoothedSec * 0.7 + remaining * 0.3;
    return _etaSmoothedSec;
}

/**
 * 剩余时间格式化：<60s 用秒，否则 m:ss。
 * @param {number} sec
 * @returns {string}
 */
function _formatEta(sec) {
    const s = Math.max(0, Math.round(sec));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${String(rem).padStart(2, '0')}`;
}

/**
 * 在窗口尺寸/DPR 变化后重新派发一次按钮状态。
 *
 * 不需要重算布局，只是让 i18n 语言切换后 title/aria-label 回到正确语言
 * （applyLocale 会把 title 重置成静态的 data-i18n-title）。
 */
export function refreshTransportLabels() {
    _applyButtonState();
}
