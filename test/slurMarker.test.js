/**
 * 连音标记 '-' 不得作为音素送进词表
 *
 * 现场日志：
 *   [OnnxSVSPipeline] Unknown phoneme: "-" [vocab=3033], Using <UNK>
 *
 * 文档（docs/dev/inference-pipeline.html）写的是：noteType=3 的触发条件是
 * **歌词 '-' 或 isSlur / isContinuation**。实现却只认后两个标志：
 *
 *   1. preprocessing.notesToSequences() 只判断 isSlur/isContinuation，
 *      既没认 lyric '-'，也没认 noteType===3（而 isRestNote() 与
 *      audioSegmentation 都认 noteType===3，两边判据分叉）；
 *   2. '-' 顺着 else 分支落到 _lookupPhonemeId('-') → <UNK> + 告警；
 *   3. midiParser 在"第一个音符就是 '-'"或"前一个音符没有歌词"时会把这个
 *      字面连字符**当歌词存进工程**（`|| '-'` 兜底），之后每次播放都复现。
 *
 * 修复后：'-' 一律按连音处理（类型 3 + 空歌词 → <SP>），noteType===3 也算连音，
 * MIDI 导入不再把 '-' 当歌词落盘。
 */
const { expect } = require('chai');
const { TextProcessing } = require('../src/inference/pipeline/textProcessing');
const { Preprocessing } = require('../src/inference/pipeline/preprocessing');
const { parseMidiFile } = require('../src/inference/midiParser');

describe("连音标记 '-' 的处理", () => {
  let tp, prep;
  before(() => {
    tp = new TextProcessing();
    prep = new Preprocessing(tp);
  });

  function lastNoteTypeSeq(seq) {
    // 末尾是 EOW，往前找最后一个 BOW 之后的音符 token 对应的类型
    return seq.noteTypeSeq;
  }

  it('notesToSequences：lyric "-" 算连音（type 3），不进 <UNK>', () => {
    const notes = [
      { start: 0, duration: 1, pitch: 60, lyric: 'la' },
      { start: 1, duration: 1, pitch: 62, lyric: '-' },
    ];
    const seq = prep.notesToSequences(notes, 120, null, null);
    const types = Array.from(lastNoteTypeSeq(seq));
    expect(types, '第二个音符必须是 slur（type 3）').to.include(3);

    const unkId = tp.phone2idx['<UNK>'];
    const textIds = Array.from(seq.noteTextSeq);
    expect(textIds, '"-" 不该变成 <UNK>').to.not.include(unkId);
  });

  it('notesToSequences：只有 noteType===3（MIDI 导入的连音）也算连音', () => {
    const notes = [
      { start: 0, duration: 1, pitch: 60, lyric: 'la', noteType: 2 },
      { start: 1, duration: 1, pitch: 62, lyric: 'la', noteType: 3 },
    ];
    const seq = prep.notesToSequences(notes, 120, null, null);
    const types = Array.from(seq.noteTypeSeq);
    expect(types, 'noteType=3 不能被重新判成普通音符（会重新起音）').to.include(3);
    // 第一个音符仍然是普通音符，不能被连坐
    expect(types).to.include(2);
  });

  it('notesToSequences：空歌词 + isContinuation 仍是连音（既有行为不回归）', () => {
    const notes = [
      { start: 0, duration: 1, pitch: 60, lyric: 'la' },
      { start: 1, duration: 1, pitch: 62, lyric: '', isContinuation: true, isSlur: true },
    ];
    const seq = prep.notesToSequences(notes, 120, null, null);
    expect(Array.from(seq.noteTypeSeq)).to.include(3);
  });

  it('_lookupPhonemeId("-") 返回 <SP>，且不再报 Unknown phoneme', () => {
    const spId = tp.phone2idx['<SP>'];
    const origWarn = console.warn;
    const warnings = [];
    console.warn = (...args) => warnings.push(args.join(' '));
    let id;
    try {
      id = tp._lookupPhonemeId('-');
    } finally {
      console.warn = origWarn;
    }
    expect(id).to.equal(spId);
    expect(warnings.join('\n')).to.not.include('Unknown phoneme');
  });

  it('_lookupPhonemeId 其它未知歌词仍走 <UNK>（守卫不放宽）', () => {
    const origWarn = console.warn;
    console.warn = () => {};
    let id;
    try {
      id = tp._lookupPhonemeId('~~~not-a-phoneme~~~');
    } finally {
      console.warn = origWarn;
    }
    expect(id).to.equal(tp.phone2idx['<UNK>']);
  });

  it('MIDI 导入：首个音符就是 "-" 时不把字面 "-" 当歌词存下来', () => {
    const buffer = buildMidi([
      { midi: 60, startTicks: 0, durationTicks: 480 },
      { midi: 62, startTicks: 480, durationTicks: 480 },
    ], [
      { ticks: 0, text: '-' },
      { ticks: 480, text: 'ma' },
    ]);
    const notes = parseMidiFile(buffer);
    expect(notes[0].noteType).to.equal(3);
    expect(notes[0].lyric, '第一个音符没有可继承的歌词 → 留空').to.equal('');
    expect(notes.map((n) => n.lyric)).to.not.include('-');
  });

  it('MIDI 导入：连音继承前面最近的真正歌词，跳过连续的 "-"', () => {
    const buffer = buildMidi([
      { midi: 60, startTicks: 0, durationTicks: 480 },
      { midi: 62, startTicks: 480, durationTicks: 480 },
      { midi: 64, startTicks: 960, durationTicks: 480 },
    ], [
      { ticks: 0, text: 'la' },
      { ticks: 480, text: '-' },
      { ticks: 960, text: '-' },
    ]);
    const notes = parseMidiFile(buffer);
    const slurs = notes.filter((n) => n.noteType === 3);
    expect(slurs).to.have.length(2);
    for (const s of slurs) {
      expect(s.lyric, '连音必须继承 "la"，不能是字面 "-"').to.equal('la');
    }
  });
});

/** 构造一个只含单轨的 MIDI buffer（参照 midiParser.test.js 的写法） */
function buildMidi(notes, lyrics) {
  const ticksPerBeat = 480;
  const tempo = 500000;
  const events = [];
  events.push({ delta: 0, data: [0xff, 0x51, 0x03, (tempo >> 16) & 0xff, (tempo >> 8) & 0xff, tempo & 0xff] });
  const all = [];
  for (const n of notes) {
    all.push({ ticks: n.startTicks, type: 'on', midi: n.midi });
    all.push({ ticks: n.startTicks + n.durationTicks, type: 'off', midi: n.midi });
  }
  for (const l of lyrics) {
    all.push({ ticks: l.ticks, type: 'lyric', text: l.text });
  }
  all.sort((a, b) => a.ticks - b.ticks);

  const trackData = [];
  let lastTicks = 0;
  for (const ev of all) {
    const delta = ev.ticks - lastTicks;
    lastTicks = ev.ticks;
    trackData.push(...vlq(delta));
    if (ev.type === 'on') trackData.push(0x90, ev.midi, 100);
    else if (ev.type === 'off') trackData.push(0x80, ev.midi, 0);
    else {
      const bytes = Array.from(ev.text).map((c) => c.charCodeAt(0));
      trackData.push(0xff, 0x05, ...vlq(bytes.length), ...bytes);
    }
  }
  trackData.push(0x00, 0xff, 0x2f, 0x00); // end of track

  const header = [
    0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6,
    0, 1, // format 1
    0, 1, // one track
    (ticksPerBeat >> 8) & 0xff, ticksPerBeat & 0xff,
  ];
  const trackHeader = [0x4d, 0x54, 0x72, 0x6b, (trackData.length >> 24) & 0xff, (trackData.length >> 16) & 0xff, (trackData.length >> 8) & 0xff, trackData.length & 0xff];
  const bytes = new Uint8Array([...header, ...trackHeader, ...trackData]);
  return bytes.buffer;
}

function vlq(value) {
  const out = [value & 0x7f];
  let v = value >> 7;
  while (v > 0) {
    out.unshift((v & 0x7f) | 0x80);
    v >>= 7;
  }
  return out;
}
