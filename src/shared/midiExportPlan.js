/**
 * 项目级 MIDI 导出的纯逻辑：把工程里的**歌手轨道**整理成多轨 MIDI。
 *
 * 粒度是「每个歌手一条 MIDI 轨」——
 *   · 同一位歌手的多个分片按全局时间合并到一条轨：分片是编辑单位，
 *     不是音乐单位，用户不会希望一段歌词被切成 8 条轨；
 *   · 伴奏轨不参与：它没有音高信息，写进 MIDI 只会多出空轨。
 *
 * 静音 / 独奏与音频导出同一套判定（shared/trackAudibility.js）：
 * 导出的应该是"听到的"，不是"工程里全部的"。
 *
 * 本模块无 DOM、无 state，便于单测。
 */
import { computeActiveClippedNotes } from './activeNotes.js';
import { computeAudibility } from './trackAudibility.js';
import {
  MIDI_PPQ, MIDI_DEFAULT_VELOCITY,
  encodeMidiTrack, assembleMidiFile,
  midiMeta, midiUtf8, midiTimeSignatureBytes,
} from './midiWriter.js';

/**
 * 连音音符的歌词写成 '-'（歌声合成软件的通用约定），否则写实际歌词。
 * 与分片编辑器的导出规则保持一致。
 */
function lyricOf(note) {
  if (note.isContinuation || note.isSlur || note.noteType === 3) return '-';
  return String(note.lyric || '').trim();
}

/**
 * @param {Object} opts
 * @param {Array} [opts.singers] trackManager 的歌手/轨道列表
 * @param {Array} [opts.fragments] 分片列表
 * @param {number} [opts.ppq=MIDI_PPQ]
 * @returns {Array<{singerId:string, name:string, notes:Array<{tick:number,durationTick:number,pitch:number,lyric:string}>}>}
 *   只含真正有音符的轨道；音符已按 tick 升序。
 */
export function planMidiTracks({ singers = [], fragments = [], ppq = MIDI_PPQ } = {}) {
  const audibility = computeAudibility(singers);
  const tracks = new Map();
  for (const singer of singers) {
    if (singer.type === 'accompaniment') continue;
    if (!audibility.audible(singer)) continue;
    tracks.set(singer.id, {
      singerId: singer.id,
      // 轨道名优先用 trackName（用户改的就是它），退回歌手名，最后用 id 兜底。
      name: String(singer.trackName || singer.singerName || singer.id || 'Track'),
      notes: [],
    });
  }

  for (const fragment of fragments) {
    const track = tracks.get(fragment.singerId);
    if (!track) continue;
    // 与合成同一真源：过滤被遮挡的重叠音符、裁到分片时长、按起点排序。
    const notes = computeActiveClippedNotes(fragment, fragment.notes || []);
    const fragStart = Number(fragment.startTime) || 0;
    for (const note of notes) {
      const pitch = Math.round(Number(note.pitch));
      // 音高缺失或为 0 的音符写不进 MIDI（0 是保留的"无音高"），静默跳过。
      if (!Number.isFinite(pitch) || pitch <= 0) continue;
      const startBeat = fragStart + (Number(note.start) || 0);
      const durationBeat = Number(note.duration) || 0;
      if (durationBeat <= 0) continue;
      track.notes.push({
        tick: Math.max(0, Math.round(startBeat * ppq)),
        durationTick: Math.max(1, Math.round(durationBeat * ppq)),
        pitch: Math.max(0, Math.min(127, pitch)),
        lyric: lyricOf(note),
      });
    }
  }

  const out = [];
  for (const track of tracks.values()) {
    if (track.notes.length === 0) continue;
    track.notes.sort((a, b) => a.tick - b.tick || b.durationTick - a.durationTick);
    out.push(track);
  }
  return out;
}

/**
 * 把 planMidiTracks 的结果编码成 format 1 的 SMF。
 *
 * 第 0 轨是指挥轨（只有轨道名、速度、拍号），后面每歌手一轨 ——
 * 这样在任何 DAW 里速度与拍号都显示在顶部，而不是藏在某条乐器轨里。
 *
 * @param {Object} opts
 * @param {Array} opts.tracks planMidiTracks 的输出
 * @param {number} [opts.bpm=120]
 * @param {[number, number]} [opts.timeSignature=[4,4]]
 * @param {string} [opts.name] 指挥轨名称
 * @param {number} [opts.ppq=MIDI_PPQ]
 * @returns {Uint8Array}
 */
export function encodeProjectMidi({ tracks = [], bpm = 120, timeSignature = [4, 4], name = 'SXSEditor', ppq = MIDI_PPQ } = {}) {
  const tempo = Math.max(1, Math.round(60000000 / Math.max(1, Number(bpm) || 120)));
  const conductor = encodeMidiTrack([
    { tick: 0, order: 0, bytes: midiMeta(0x03, midiUtf8(String(name || 'SXSEditor'))) },
    { tick: 0, order: 1, bytes: midiMeta(0x51, [(tempo >>> 16) & 0xff, (tempo >>> 8) & 0xff, tempo & 0xff]) },
    { tick: 0, order: 2, bytes: midiMeta(0x58, midiTimeSignatureBytes(timeSignature)) },
  ]);

  const chunks = [conductor];
  for (const track of tracks) {
    const events = [{ tick: 0, order: 0, bytes: midiMeta(0x03, midiUtf8(String(track.name || 'Track'))) }];
    for (const note of track.notes) {
      if (note.lyric) {
        events.push({ tick: note.tick, order: 1, bytes: midiMeta(0x05, midiUtf8(note.lyric)) });
      }
      events.push({ tick: note.tick, order: 2, bytes: [0x90, note.pitch, MIDI_DEFAULT_VELOCITY] });
      events.push({ tick: note.tick + note.durationTick, order: 0, bytes: [0x80, note.pitch, 0] });
    }
    chunks.push(encodeMidiTrack(events));
  }

  return assembleMidiFile({ format: 1, ppq, tracks: chunks });
}
