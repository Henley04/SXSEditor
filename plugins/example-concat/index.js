/**
 * SXSEditor 示例插件：传统拼接（concatenative）歌声后端。
 *
 * 这是一个**可直接运行**的最小后端，同时是第三方插件的模板：
 *   · 无模型、无依赖、无网络，纯 JS 生成波形；
 *   · 演示了插件契约的全部要点：initialize / getVoices / synthesize / dispose；
 *   · 演示了 host.blockPlayback 的 ticket 生命周期（含 update / end / 取消感知）；
 *   · 演示了 request.scratch 复用（避免每次合成都分配大数组）。
 *
 * 安装：把 `plugins/example-concat/` 整个目录复制到
 *   <userData>/plugins/example-concat/
 * 然后在编辑器里调用 `pluginAPI.reload()`（或重启应用）即可看到它。
 *
 * 音符结构（与内置 pipeline 一致）：
 *   { start: 起点(拍), duration: 时长(拍), pitch: MIDI 音高(0=休止), lyric: 歌词 }
 */

'use strict';

const PLUGIN_ID = 'example-concat';
const KIND_ID = 'concat-basic';
/**
 * 第二种轨道：只复用内置 MIDI 编辑器的**一部分**面板（不要音高曲线、不要音素栏），
 * 用来演示 `editor.mode: 'midi-partial'` + `editor.use`。
 * 合成行为与 concat-basic 完全一致，区别只在编辑器形态。
 */
const KIND_ID_LIGHT = 'concat-light';
const KIND_IDS = [KIND_ID, KIND_ID_LIGHT];

/** 内置音色（拼接库只有一个"音源"时的最小示例） */
const VOICES = [
  { id: 'demo-sine', name: '演示·正弦', tags: ['demo', 'concat'], sampleRate: 44100 },
  { id: 'demo-pulse', name: '演示·脉冲', tags: ['demo', 'concat'], sampleRate: 44100 },
];

let initialized = false;
let ctxRef = null;

/**
 * 单音符波形生成：把 [start, end) 秒区间的样本写进 out。
 *
 * @param {Float32Array} out 输出缓冲（可能是调用方预分配的 scratch）
 * @param {object} note  音符
 * @param {number} startSec 音符起点（秒，相对 out[0]）
 * @param {number} endSec   音符终点（秒）
 * @param {number} sampleRate
 * @param {object} params 插件自定义参数
 */
function renderNote(out, note, startSec, endSec, sampleRate, params) {
  const freq = midiToHz(note.pitch);
  const attack = Math.max(0, params.attackSec || 0) * sampleRate;
  const release = Math.max(0, params.releaseSec || 0) * sampleRate;
  const gain = typeof params.gain === 'number' ? params.gain : 0.6;
  const harmonics = Math.max(1, Math.min(8, Math.round(params.harmonics || 1)));
  const vibratoHz = Math.max(0, params.vibratoHz || 0);
  const waveform = params.waveform === 'triangle' || params.waveform === 'pulse'
    ? params.waveform
    : 'sine';
  // 音色 id 也能决定波形：demo-pulse 强制脉冲，方便 UI 切换音色时听出差别
  const effectiveWave = params.voiceId === 'demo-pulse' ? 'pulse' : waveform;

  const i0 = Math.max(0, Math.floor(startSec * sampleRate));
  const i1 = Math.min(out.length, Math.floor(endSec * sampleRate));
  if (i1 <= i0) return;

  const total = i1 - i0;
  for (let i = 0; i < total; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * freq * t;
    // 颤音：音高周期微扰，模拟人声抖动
    const vibrato = vibratoHz > 0
      ? 1 + 0.01 * Math.sin(2 * Math.PI * vibratoHz * t)
      : 1;

    let sample = 0;
    if (effectiveWave === 'pulse') {
      // 脉冲串：占空比 25%，谐波丰富，接近传统拼接的"激励源"听感
      const p = ((phase / (2 * Math.PI)) * vibrato) % 1;
      sample = p < 0.25 ? 0.8 : -0.2;
    } else if (effectiveWave === 'triangle') {
      const p = ((phase / (2 * Math.PI)) * vibrato) % 1;
      sample = 4 * Math.abs(p - 0.5) - 1;
    } else {
      // 正弦 + 谐波叠加（谐波幅度按 1/n 衰减）
      for (let h = 1; h <= harmonics; h++) {
        sample += Math.sin(phase * h * vibrato) / h;
      }
      sample /= harmonics > 1 ? 1.6 : 1;
    }

    // 简化的 ADSR：起音线性上升 + 释音线性下降（拼接方案的包络整形）
    let env = 1;
    if (i < attack && attack > 0) env = i / attack;
    const fromEnd = total - i;
    if (fromEnd < release && release > 0) env = Math.min(env, fromEnd / release);

    // 与已有样本叠加（多音符重叠时自然混音，不额外分配缓冲）
    out[i0 + i] += sample * env * gain;
  }
}

function midiToHz(pitch) {
  if (!Number.isFinite(pitch) || pitch <= 0) return 0;
  return 440 * Math.pow(2, (pitch - 69) / 12);
}

/** 削波保护：谐波叠加很容易超过 ±1。 */
function softClip(out) {
  for (let i = 0; i < out.length; i++) {
    const v = out[i];
    if (v > 1) out[i] = 1;
    else if (v < -1) out[i] = -1;
  }
}

module.exports = {
  id: PLUGIN_ID,
  name: '示例拼接后端',
  version: '1.0.0',
  apiVersion: 1,

  capabilities: {
    synthesize: true,
    blockPlayback: true,
    streaming: false,
    voices: true,
  },

  // 轨道种类（含 paramSchema / defaults）在 manifest.json 里声明即可，这里不必重复。
  // 若你选择在模块里导出 trackKinds 覆盖 manifest，请一并带上 paramSchema，
  // 否则宿主没有 schema 可依据，UI 传进来的自定义参数会被全部过滤掉
  // （宿主对同名 kind 会自动继承 manifest 的 schema，但显式声明更稳）。
  trackKinds: [
    {
      id: KIND_ID,
      name: '拼接音源',
      description: '按音符拼接简单波形的演示轨道（复用内置 MIDI 编辑器）',
      editor: { mode: 'midi', readOnly: false },
    },
    {
      id: KIND_ID_LIGHT,
      name: '拼接音源·精简',
      description: '只复用内置编辑器的钢琴卷帘、参数与包络面板（midi-partial 演示）',
      // 关键：只启用三个面板，音高曲线(pitch)与音素栏(phoneme)被关掉。
      // 宿主会据此隐藏对应 DOM、并把当前激活 lane 收敛到仍然可见的那个。
      editor: { mode: 'midi-partial', use: ['pianoRoll', 'params', 'envelope'], readOnly: false },
    },
  ],

  async initialize(ctx) {
    ctxRef = ctx;
    // ctx.log / ctx.getSetting / ctx.pluginDir / ctx.hostVersion 均可用
    ctx.log('info', `初始化，宿主版本 ${ctx.hostVersion}，插件目录 ${ctx.pluginDir}`);
    const gain = ctx.getSetting('masterGain');
    if (typeof gain === 'number') ctx.log('debug', `读到主输出增益设置：${gain}`);
    initialized = true;
  },

  async getVoices(kindId) {
    if (kindId && !KIND_IDS.includes(kindId)) return [];
    return VOICES.map((v) => ({ ...v }));
  },

  /**
   * 合成入口。
   *
   * @param {object} request {kindId, pluginId, trackId, notes, bpm, options, params,
   *                          voiceId, sampleRate, scratch, abortSignal}
   * @param {object} host    {emitProgress, emitAudio, log, blockPlayback, isCancelled, diagnostics}
   */
  async synthesize(request, host) {
    if (!initialized) throw new Error('插件未初始化');

    const sampleRate = request.sampleRate || 44100;
    const bpm = request.bpm || 120;
    const notes = Array.isArray(request.notes) ? request.notes : [];
    // params 已由宿主按 paramSchema + defaults 计算好，未声明的键会被丢弃
    const params = { ...request.params, voiceId: request.voiceId };
    // options 是调用方（svsIpc）手上的那个完整 options 对象，这里只读地用其中
    // 几个字段来演示"参数全量透传"确实生效
    const options = request.options || {};
    const secondsPerBeat = 60 / bpm;

    // ---- 阻滞播放：告诉 UI 正在准备音源 ----
    // 只有 manifest 声明 capabilities.blockPlayback=true 才会拿到 ticket。
    const ticket = host.blockPlayback({
      title: '正在拼接音源',
      message: `准备 ${notes.length} 个音符的拼接单元`,
      cancellable: true,
    });
    let cancelled = false;
    try {
      if (ticket) host.log('debug', `已创建阻滞 ticket ${ticket.id}`);
      ticket && ticket.update({ message: '装载拼接单元…', progress: 10 });

      // 计算总长度：最后一个音符的结束位置（拍 → 秒）
      let totalBeats = 0;
      for (const note of notes) {
        const end = (note.start || 0) + (note.duration || 0);
        if (end > totalBeats) totalBeats = end;
      }
      const totalSamples = Math.max(1, Math.ceil(totalBeats * secondsPerBeat * sampleRate));

      // 优先复用调用方预分配的 scratch，避免每次合成都分配一个几 MB 的数组
      let out = request.scratch instanceof Float32Array && request.scratch.length >= totalSamples
        ? request.scratch.subarray(0, totalSamples)
        : new Float32Array(totalSamples);

      ticket && ticket.update({ message: '拼接中…', progress: 30 });
      host.emitProgress(0);

      // 上报粒度：按"百分比每前进 ≥1% 才上报"，而不是逐音符上报。
      // ticket.update / emitProgress 每次都是一条 IPC（worker 模式下还是一条跨线程
      // 消息），逐音符上报会让 400 音符的工程在一次合成里推上千次 —— 宿主侧虽有
      // 节流兜底（100ms/2%），但代理调用本身也有成本。首尾与终态必发。
      let lastReported = 0;

      for (let n = 0; n < notes.length; n++) {
        // 协作式取消：UI 点了取消按钮后 host.isCancelled() 会变成 true
        if (host.isCancelled() || request.abortSignal?.aborted) {
          cancelled = true;
          break;
        }
        const note = notes[n];
        if (!note.pitch || note.pitch < 1) continue; // 休止符：天然留白
        const startSec = (note.start || 0) * secondsPerBeat;
        const endSec = ((note.start || 0) + (note.duration || 0)) * secondsPerBeat;
        renderNote(out, note, startSec, endSec, sampleRate, params);

        const progress = Math.round(((n + 1) / Math.max(1, notes.length)) * 100);
        if (progress - lastReported >= 1 || n === notes.length - 1) {
          lastReported = progress;
          host.emitProgress(progress);
          if (ticket) ticket.update({ message: `已拼接 ${n + 1}/${notes.length}`, progress: 30 + Math.round(progress * 0.65) });
        }
      }

      softClip(out);
      host.emitProgress(100);

      if (cancelled) {
        // 取消时返回 null：宿主不会把空数据灌进混音链路
        host.diagnostics({ cancelled: true, reason: 'user-cancelled' });
        return { pcm: null, channels: 1, sampleRate, leadingSamples: 0 };
      }

      const diagnostics = {
        notes: notes.length,
        sampleRate,
        durationSec: totalSamples / sampleRate,
        // 演示：这些字段确确实实是从宿主透传过来的完整 options 里读到的
        sawOptionsKeys: Object.keys(options).slice(0, 12),
        sawRefAudio: !!options.refAudioWavBuffer,
        sawPitchCurve: !!options.pitchCurveF0,
      };
      // 推给 UI（plugin:diagnostics 事件），同时也放进返回值（宿主会转交调用方）
      host.diagnostics(diagnostics);

      return {
        pcm: out,
        channels: 1,
        sampleRate,
        leadingSamples: 0,
        diagnostics,
      };
    } finally {
      // ticket 必须在任何退出路径上收尾（宿主也有兜底，但插件应当自己 end）
      if (ticket) {
        ticket.update({ message: cancelled ? '已取消' : '拼接完成', progress: 100 });
        ticket.end();
      }
    }
  },

  async dispose() {
    initialized = false;
    if (ctxRef) ctxRef.log('info', '已释放');
    ctxRef = null;
  },
};
