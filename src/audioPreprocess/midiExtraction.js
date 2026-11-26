import { state, dom } from './state.js';
import { BPM } from './constants.js';
import { t } from '../i18n/index.js';
import { showAlertDialog, showConfirmDialog } from '../alertDialog.js';
import { buildSingerFields, showLoading, hideLoading, updateMidiInfo } from './uiControls.js';
import { collectOptions, setStatus } from './panel.js';
import { saveOptions, resolveOptions } from './extractionOptions.js';

// 各提取工具的真实阶段序列——只用于进度文案，不是虚构的百分比里程碑。
const STAGE_SETS = {
  fcpe: ['analyze', 'extract', 'smooth', 'segment', 'quantize'],
  rmvpe: ['analyze', 'extract', 'smooth'],
  basicpitch: ['analyze', 'extract', 'segment'],
};

// 占位进度永远停在这个百分比之下：真实推理是一次性 IPC，中途没有里程碑回调，
// 一旦让进度条自己跑满，就会出现"进度先结束、结果后出来"。
const CREEP_CEILING = 90;
// 阶段/百分比推进节奏：真实推理通常 1.5~10s，太快就会像旧实现那样 1.3 秒跑满。
const STAGE_CADENCE_MS = 900;
// 文案重绘节奏：只刷"已用 X 秒"，比推进节奏密，避免读数停在 0.9s 显得卡住。
const REPAINT_MS = 450;

function stageLabel(key) {
  return t(`preprocess.stage.${key}`) || t('preprocess.processing');
}

/**
 * 创建提取进度反馈（不撒谎版）。
 *
 * 主进程的 FCPE / RMVPE 推理是一次性 IPC，渲染进程拿不到中途进度，所以这里
 * 只能做占位进度，但必须守住两条：
 *   1. 百分比在上限 CREEP_CEILING 之下渐进爬升，只有真正拿到结果、并且结果
 *      已经画到画布上之后，才由 finish() 推到 100%。
 *      （旧实现是 5 个固定档位 × 260ms，1.3 秒就冲到 96% 然后卡死：音频稍长
 *      一点就是"进度转圈比实际结果更早结束"。）
 *   2. 副标题只显示真实已用时间。
 *      （旧实现的"预计剩余 = elapsed × 0.6"是凭意外推，短音频恒显示"还剩
 *      0.5s"，等于又在暗示"马上就完了"。）
 */
function createProgressReporter(handle, textPrefix, stageKeys) {
  const stages = stageKeys && stageKeys.length ? stageKeys : STAGE_SETS.fcpe;
  const t0 = performance.now();
  let stageIdx = 0;
  let pct = 6;
  let stopped = false;

  const paint = () => {
    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    const label = stageLabel(stages[Math.min(stageIdx, stages.length - 1)]);
    handle.setProgress(pct, `${textPrefix} ${label} · ${t('preprocess.elapsed', { seconds: elapsed })}`);
  };

  paint();

  let lastAdvance = t0;
  const timer = setInterval(() => {
    if (stopped) return;
    const now = performance.now();
    if (now - lastAdvance >= STAGE_CADENCE_MS) {
      lastAdvance = now;
      if (stageIdx < stages.length - 1) stageIdx++;
      // 渐进爬升：越接近上限步长越小，永不触达 CREEP_CEILING 本身。
      pct = Math.min(CREEP_CEILING, pct + Math.max(1.5, (CREEP_CEILING - pct) * 0.16));
    }
    paint();
  }, REPAINT_MS);

  return {
    finish() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      handle.setProgress(100, '');
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/**
 * 等两帧再继续，确保结果已经真正绘制到画布上。
 * 窗口不可见时 rAF 不触发，用定时器兜底，避免遮罩永远不撤。
 */
function nextPaint(timeoutMs = 250) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    requestAnimationFrame(() => requestAnimationFrame(done));
    setTimeout(done, timeoutMs);
  });
}

function showQualityWarnings(warnings) {
  if (!warnings || warnings.length === 0) return;
  const msgs = warnings.map((w) => t(`preprocess.warn.${w}`)).filter(Boolean);
  if (msgs.length) showAlertDialog(t('preprocess.qualityWarnTitle') + '\n\n' + msgs.join('\n'));
}

export async function importMidiFile() {
  try {
    const result = await window.electronAPI.importMidi();
    if (!result.success) {
      if (!result.canceled) {
        showAlertDialog(t('preprocess.midiImportFailed') + ': ' + (result.error || t('preprocess.extractionFailed')));
      }
      return;
    }

    const notes = (result.notes || []).map((n, i) => ({
      id: n.id ?? (Date.now() + i),
      pitch: n.pitch ?? 60,
      start: n.start ?? 0,
      duration: n.duration ?? 0.25,
      lyric: n.lyric || '',
      noteType: n.noteType,
    }));

    // 导入会整体覆盖当前音符：已有音符时先确认，避免误操作丢失编辑。
    const existingCount = state.pianoRoll ? state.pianoRoll.notes.length : 0;
    if (existingCount > 0) {
      const ok = await showConfirmDialog(t('preprocess.midiImportOverwriteConfirm', { count: existingCount }));
      if (!ok) return;
    }

    if (state.pianoRoll) {
      state.pianoRoll.notes = notes;
      state.pianoRoll._staticCacheDirty = true;
      state.pianoRoll.render();
      updateMidiInfo();
    }

    const fields = buildSingerFields(notes);
    const importTrimOffsetMs = Math.floor((state.trimOffsetSec || 0) * 1000);
    // 音符时值是拍，换回秒必须用当前工程的 BPM。这里原先是常量 120，
    // 工程设成 96 时导入的 singerData 时长会整体短 20%，与音频对不上。
    const importBpm = (state.pianoRoll && state.pianoRoll.bpm)
      || (state.extractOptions && state.extractOptions.bpm)
      || BPM;
    state.singerData = {
      index: `vocal_${Math.floor(state.wavDuration * 1000)}`,
      language: 'Mandarin',
      time: [importTrimOffsetMs, importTrimOffsetMs + Math.floor(state.wavDuration * 1000)],
      trimOffsetSec: state.trimOffsetSec || 0,
      duration: notes.map((n) => (n.duration * (60 / importBpm)).toFixed(2)).join(' '),
      text: fields.text,
      phoneme: fields.phoneme,
      note_pitch: notes.map((n) => n.pitch).join(' '),
      note_type: fields.note_type,
      f0: (state.f0Data || []).map((f) => f.f0.toFixed(1)).join(' '),
    };

    updateMidiInfo();
    showAlertDialog(t('preprocess.midiImportComplete'));
  } catch (err) {
    console.error('MIDI import failed:', err);
    showAlertDialog(t('preprocess.midiImportFailed') + ': ' + err.message);
  }
}

export async function extractF0BasicPitch() {
  if (!state.wavAudioBuffer) {
    showAlertDialog(t('preprocess.pleaseLoadAudio'));
    return;
  }

  const settings = await window.electronAPI.getSettings();
  const midiTool = (settings?.midiExtractTool === 'rosvot' ? 'rmvpe' : settings?.midiExtractTool) || 'fcpe';
  const loadingMsg = midiTool === 'rmvpe'
    ? t('preprocess.extractingMidiRmvpe')
    : midiTool === 'fcpe'
    ? t('preprocess.extractingMidiFcpe')
    : t('preprocess.extractingMidiBasicPitch');
  const loading = showLoading(loadingMsg);
  let progress = null;
  // 遮罩的关闭点必须可控：成功路径要等结果真正绘制完成才撤，否则会出现
  // "进度转圈已经结束、音符还没画出来"。
  let overlayClosed = false;
  const closeOverlay = () => {
    if (overlayClosed) return;
    overlayClosed = true;
    hideLoading(loading);
  };

  try {
    const channelData = state.wavAudioBuffer.getChannelData(0);
    const audioData = channelData.buffer;
    const sampleRate = state.wavAudioBuffer.sampleRate;
    // 三种提取工具都使用面板/设置里的 BPM（原先硬编码 BPM=120，忽略用户设置）。
    const resolvedOptions = resolveOptions(collectOptions());
    // 实际生效的 BPM（自动测速回填后会更新），用于音符 beat→秒换算。
    let effectiveBpm = resolvedOptions.bpm;
    // 设备标记（仅 FCPE 会回传），用于状态栏文案。
    let deviceTag = null;
    progress = createProgressReporter(loading, loadingMsg, STAGE_SETS[midiTool]);

    let result;
    if (midiTool === 'rmvpe') {
      result = await window.electronAPI.extractMidiRosvot({
        audioData: audioData,
        sampleRate,
        bpm: resolvedOptions.bpm,
      });
    } else if (midiTool === 'fcpe') {
      result = await window.electronAPI.extractMidiFcpe({
        audioData: audioData,
        sampleRate,
        bpm: resolvedOptions.bpm,
        options: resolvedOptions,
      });
    } else {
      result = await window.electronAPI.extractF0BasicPitch({
        audioData: audioData,
        sampleRate,
        bpm: resolvedOptions.bpm,
      });
    }

    if (!result.success) {
      // FCPE model not downloaded yet — prompt the user and open the model
      // download page so they can install the optional FCPE model.
      if (result.code === 'MODEL_NOT_FOUND') {
        showAlertDialog(t('preprocess.fcpeModelMissing'));
        try { await window.electronAPI.updateAPI.openModelDownload(); } catch (_) {}
        return;
      }
      throw new Error(result.error || 'MIDI extraction failed');
    }

    // 检测器的帧数可能基于重采样 / padding 后的输入。把时间轴映射回解码后的 WAV
    // 时长，并且 F0 与音符共用同一个 scale，波形、预览曲线、MIDI 才会对齐。
    //
    // 旧实现用"首两帧步长 × 帧数"外推。首帧步长受抖动影响大（重采样插值、前置
    // padding），算出的 scale 偏离几十分之一就会把整段音符拉长或压缩——这正是
    // 用户反馈的"时间对齐有时不稳"。现改为中位帧步长，并把结果夹在可信区间内：
    // 超出区间说明时间轴本身不可信（模型输入被裁剪 / 补齐过头），此时宁可不缩放。
    let timeScale = 1;
    if (Array.isArray(result.f0Array) && result.f0Array.length > 2 && state.wavDuration > 0) {
      const steps = [];
      for (let i = 1; i < result.f0Array.length; i++) {
        const d = result.f0Array[i].time - result.f0Array[i - 1].time;
        if (d > 1e-6) steps.push(d);
      }
      if (steps.length) {
        steps.sort((a, b) => a - b);
        const step = steps[steps.length >> 1];
        const detectorDuration = result.f0Array[result.f0Array.length - 1].time + step;
        if (detectorDuration > 0.1) {
          const raw = state.wavDuration / detectorDuration;
          // ±20% / +25% 之外不再当作"时间轴缩放误差"处理：那多半是尾部帧缺失
          // 或前导静音被裁，缩放只会把错误放大。
          timeScale = raw > 0.8 && raw < 1.25 ? raw : 1;
        }
      }
      result.f0Array = result.f0Array.map(frame => ({ ...frame, time: Math.max(0, frame.time * timeScale) }));
    }
    if (result.notes && Math.abs(timeScale - 1) > 1e-6) {
      result.notes = result.notes.map(note => ({
        ...note,
        start: Math.max(0, (note.start || 0) * timeScale),
        duration: Math.max(0.01, (note.duration || 0.01) * timeScale),
      }));
    }

    if (midiTool === 'fcpe') {
      // 设备/速度提示
      deviceTag = result.device === 'DML' ? 'DML (GPU)' : 'CPU';
      setStatus(`${t('preprocess.deviceLabel')}: ${deviceTag}`);
      // 自动 BPM：回填到面板
      if (resolvedOptions.autoBpm && result.bpm && result.bpm > 0) {
        const opts = collectOptions();
        opts.bpm = result.bpm;
        if (dom.bpmInput) dom.bpmInput.value = result.bpm;
        saveOptions(opts);
        state.extractOptions = resolveOptions(opts);
        // 主进程在本次提取里已经用检测到的 BPM 完成秒→beat 换算
        // （pitchMidiIpc → segmentNotes({ bpm: useBpm })），因此 result.notes
        // 无需再按新 BPM 重算；这里只需同步生效 BPM，让后续提取 / beat→秒
        // 换算（singerData、试听、钢琴卷轴）都使用新值。
        effectiveBpm = result.bpm;
        if (state.pianoRoll) state.pianoRoll.bpm = result.bpm;
      }
      // UVR 分离质量提示
      showQualityWarnings(result.warnings);
    }

    const rawNotes = result.notes || [];
    const notes = rawNotes.map((n, i) => {
      const previous = i > 0 ? rawNotes[i - 1] : null;
      const gap = previous ? (n.start ?? 0) - ((previous.start ?? 0) + (previous.duration ?? 0)) : Infinity;
      // FCPE may split one sustained syllable at a stable pitch transition.
      // Mark only practically gapless follow-up notes as slurs; users enter the
      // lyric on the first note and continuation notes use '-'.
      const continuation = midiTool === 'fcpe' && previous && gap <= 0.03;
      return {
        id: n.id ?? (Date.now() + i),
        pitch: n.pitch ?? 60,
        start: n.start ?? 0,
        duration: n.duration ?? 0.25,
        lyric: n.lyric || n.text || (continuation ? '' : 'la'),
        noteType: continuation ? 3 : (n.noteType ?? 2),
        isContinuation: continuation,
      };
    });

    // F0 归属：RMVPE 是专用 F0 提取器，FCPE / Basic Pitch 的 F0 只服务于
    // 音符切分（各自的归一化、阈值、平滑、量程会把曲线形状改得面目全非）。
    // 用户先点「RMVPE提取F0」再点「提取MIDI」时，此前会被这里的赋值悄悄顶掉，
    // 表现为"提取完 MIDI，F0 曲线整条变了"。已有 RMVPE 结果时保留它。
    const detectedF0 = result.f0Array && result.f0Array.length > 0 ? result.f0Array : null;
    const keepRmvpeF0 = midiTool !== 'rmvpe'
      && state.f0Source === 'rmvpe'
      && Array.isArray(state.f0Data) && state.f0Data.length > 0;
    if (detectedF0 && !keepRmvpeF0) {
      state.f0Data = detectedF0;
      state.f0Source = midiTool;
    }
    if (keepRmvpeF0) {
      const prefix = deviceTag ? `${t('preprocess.deviceLabel')}: ${deviceTag} · ` : '';
      setStatus(`${prefix}${t('preprocess.f0KeptFromRmvpe')}`);
    }

    if (state.pianoRoll) {
      // beat↔秒换算（f0 曲线、播放头、试听）统一使用本次提取的 BPM，
      // 否则面板 BPM ≠ 120 时音符与 f0 曲线在时间轴上错位。
      state.pianoRoll.bpm = effectiveBpm;
      state.pianoRoll.notes = notes;
      if (state.f0Data) {
        state.pianoRoll.f0Data = state.f0Data;
      }
      // 替换 notes/f0 后必须失效静态缓存，否则首帧仍绘制旧内容。
      state.pianoRoll._staticCacheDirty = true;
      state.pianoRoll.render();
      updateMidiInfo();
    }

    const currentF0 = state.f0Data || [];
    const fields = buildSingerFields(notes);
    // 音符时值是 beat，换算秒必须用本次提取的 BPM（而非常量 BPM）。
    const activeBpm = (state.pianoRoll && state.pianoRoll.bpm) || BPM;
    // 音频可能被裁剪掉前导静音，singerData 需回到原始时间轴。
    const trimOffsetMs = Math.floor((state.trimOffsetSec || 0) * 1000);
    state.singerData = {
      index: `vocal_${Math.floor(state.wavDuration * 1000)}`,
      language: 'Mandarin',
      time: [trimOffsetMs, trimOffsetMs + Math.floor(state.wavDuration * 1000)],
      trimOffsetSec: state.trimOffsetSec || 0,
      duration: notes.map((n) => (n.duration * (60 / activeBpm)).toFixed(2)).join(' '),
      text: fields.text,
      phoneme: fields.phoneme,
      note_pitch: notes.map((n) => n.pitch).join(' '),
      note_type: fields.note_type,
      f0: currentF0.map((f) => f.f0.toFixed(1)).join(' '),
    };

    updateMidiInfo();
    // 结果已写入状态并触发重绘：等两帧确认真的画出来了，再把进度推到 100%
    // 并撤掉遮罩。IPC 返回只代表数据到了，不代表用户已经能看到结果。
    await nextPaint();
    if (progress) progress.finish();
    closeOverlay();
    showAlertDialog(t('preprocess.midiExtractionComplete'));
  } catch (err) {
    console.error('Extraction failed:', err);
    if (progress) progress.stop();
    closeOverlay();
    showAlertDialog(t('preprocess.extractionFailed') + ': ' + err.message);
  } finally {
    if (progress) progress.stop();
    closeOverlay();
  }
}
