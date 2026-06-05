const { parseMidiFile } = require('../src/inference/midiParser');
const { expect } = require('chai');

function buildMidiBuffer(options = {}) {
  const ticksPerBeat = options.ticksPerBeat || 480;
  const tempo = options.tempo || 500000;
  const notes = options.notes || [];
  const lyrics = options.lyrics || [];

  const trackEvents = [];

  const tempoBytes = [
    (tempo >> 16) & 0xff,
    (tempo >> 8) & 0xff,
    tempo & 0xff,
  ];
  trackEvents.push({ delta: 0, data: [0xff, 0x51, 0x03, ...tempoBytes] });

  const allMidiEvents = [];
  for (const n of notes) {
    allMidiEvents.push({
      ticks: n.startTicks,
      type: 'on',
      note: n.midi,
      velocity: n.velocity || 100,
      channel: n.channel || 0,
    });
    allMidiEvents.push({
      ticks: n.startTicks + n.durationTicks,
      type: 'off',
      note: n.midi,
      velocity: 0,
      channel: n.channel || 0,
    });
  }

  for (const l of lyrics) {
    const textBytes = [];
    for (let i = 0; i < l.text.length; i++) {
      textBytes.push(l.text.charCodeAt(i));
    }
    allMidiEvents.push({
      ticks: l.ticks,
      type: 'lyric',
      textBytes: textBytes,
    });
  }

  allMidiEvents.sort((a, b) => a.ticks - b.ticks);

  let absTicks = 0;
  const trackData = [];

  for (const ev of allMidiEvents) {
    const delta = ev.ticks - absTicks;
    absTicks = ev.ticks;
    const varLen = encodeVarLen(delta);
    trackData.push(...varLen);

    if (ev.type === 'on') {
      trackData.push(0x90 | (ev.channel & 0x0f));
      trackData.push(ev.note & 0x7f);
      trackData.push(ev.velocity & 0x7f);
    } else if (ev.type === 'off') {
      trackData.push(0x80 | (ev.channel & 0x0f));
      trackData.push(ev.note & 0x7f);
      trackData.push(0);
    } else if (ev.type === 'lyric') {
      trackData.push(0xff, 0x05);
      const textLen = encodeVarLen(ev.textBytes.length);
      trackData.push(...textLen);
      trackData.push(...ev.textBytes);
    }
  }

  const endDelta = absTicks > 0 ? 0 : 0;
  const endVarLen = encodeVarLen(endDelta);
  trackData.push(...endVarLen, 0xff, 0x2f, 0x00);

  const headerChunk = buildChunk('MThd', [
    0x00, 0x00,
    0x00, 0x01,
    (ticksPerBeat >> 8) & 0xff, ticksPerBeat & 0xff,
  ]);

  const trackChunk = buildChunk('MTrk', trackData);

  const totalLength = headerChunk.length + trackChunk.length;
  const buffer = new ArrayBuffer(totalLength);
  const view = new DataView(buffer);
  let offset = 0;
  for (const b of headerChunk) {
    view.setUint8(offset++, b);
  }
  for (const b of trackChunk) {
    view.setUint8(offset++, b);
  }
  return buffer;
}

function buildChunk(tag, data) {
  const bytes = [];
  for (let i = 0; i < tag.length; i++) {
    bytes.push(tag.charCodeAt(i));
  }
  const len = data.length;
  bytes.push((len >> 24) & 0xff, (len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff);
  bytes.push(...data);
  return bytes;
}

function encodeVarLen(value) {
  if (value < 0) value = 0;
  const bytes = [];
  bytes.push(value & 0x7f);
  value >>= 7;
  while (value > 0) {
    bytes.push((value & 0x7f) | 0x80);
    value >>= 7;
  }
  bytes.reverse();
  return bytes;
}

describe('MIDI Parser', () => {
  it('should parse note_on/note_off events correctly', () => {
    const buffer = buildMidiBuffer({
      ticksPerBeat: 480,
      notes: [
        { midi: 60, startTicks: 0, durationTicks: 480 },
        { midi: 62, startTicks: 480, durationTicks: 480 },
      ],
    });

    const result = parseMidiFile(buffer);
    expect(result.length).to.be.at.least(2);
    expect(result[0].pitch).to.equal(60);
    expect(result[1].pitch).to.equal(62);
  });

  it('should attach lyrics to notes', () => {
    const buffer = buildMidiBuffer({
      ticksPerBeat: 480,
      notes: [
        { midi: 60, startTicks: 0, durationTicks: 480 },
        { midi: 62, startTicks: 480, durationTicks: 480 },
      ],
      lyrics: [
        { ticks: 0, text: 'a' },
        { ticks: 480, text: 'b' },
      ],
    });

    const result = parseMidiFile(buffer);
    expect(result.length).to.be.at.least(2);
    expect(result[0].lyric).to.equal('a');
    expect(result[1].lyric).to.equal('b');
  });

  it('should insert SP notes for gaps > 0.2s', () => {
    const tempo = 500000;
    const ticksPerBeat = 480;
    const gapTicks = Math.ceil(0.3 / (tempo / 1000000) * ticksPerBeat);
    const note1Dur = 480;
    const note2Start = note1Dur + gapTicks;

    const buffer = buildMidiBuffer({
      ticksPerBeat,
      tempo,
      notes: [
        { midi: 60, startTicks: 0, durationTicks: note1Dur },
        { midi: 62, startTicks: note2Start, durationTicks: 480 },
      ],
    });

    const result = parseMidiFile(buffer);
    const spNotes = result.filter(n => n.pitch === 0);
    expect(spNotes.length).to.be.at.least(1);
  });

  it('should determine note_type correctly', () => {
    const buffer = buildMidiBuffer({
      ticksPerBeat: 480,
      notes: [
        { midi: 60, startTicks: 0, durationTicks: 480 },
      ],
      lyrics: [
        { ticks: 0, text: '<SP>' },
      ],
    });

    const result = parseMidiFile(buffer);
    const spNote = result.find(n => n.lyric === '<SP>');
    expect(spNote).to.not.be.undefined;
    expect(spNote.noteType).to.equal(1);
  });

  it('should set noteType 2 for normal lyric notes', () => {
    const buffer = buildMidiBuffer({
      ticksPerBeat: 480,
      notes: [
        { midi: 60, startTicks: 0, durationTicks: 480 },
      ],
      lyrics: [
        { ticks: 0, text: 'la' },
      ],
    });

    const result = parseMidiFile(buffer);
    const normalNote = result.find(n => n.lyric === 'la');
    expect(normalNote).to.not.be.undefined;
    expect(normalNote.noteType).to.equal(2);
  });

  it('should set noteType 3 for slur notes', () => {
    const buffer = buildMidiBuffer({
      ticksPerBeat: 480,
      notes: [
        { midi: 60, startTicks: 0, durationTicks: 480 },
        { midi: 62, startTicks: 480, durationTicks: 480 },
      ],
      lyrics: [
        { ticks: 0, text: 'la' },
        { ticks: 480, text: '-' },
      ],
    });

    const result = parseMidiFile(buffer);
    const slurNote = result.find(n => n.noteType === 3);
    expect(slurNote).to.not.be.undefined;
  });

  it('should throw error for invalid MIDI file', () => {
    const buffer = new ArrayBuffer(10);
    const view = new DataView(buffer);
    for (let i = 0; i < 10; i++) view.setUint8(i, 0);
    expect(() => parseMidiFile(buffer)).to.throw();
  });

  it('should throw error when no notes found', () => {
    const buffer = buildMidiBuffer({
      ticksPerBeat: 480,
      notes: [],
    });
    expect(() => parseMidiFile(buffer)).to.throw('No notes found');
  });

  it('should handle truncated MIDI file gracefully', () => {
    const buffer = buildMidiBuffer({
      ticksPerBeat: 480,
      notes: [{ midi: 60, startTicks: 0, durationTicks: 480, velocity: 100 }],
    });
    // Truncate the buffer
    const truncated = buffer.slice(0, Math.floor(buffer.length / 2));
    expect(() => parseMidiFile(truncated)).to.throw();
  });

  it('should handle empty buffer', () => {
    const buffer = new ArrayBuffer(0);
    expect(() => parseMidiFile(buffer)).to.throw();
  });

  it('should handle buffer with only header', () => {
    const buffer = new ArrayBuffer(14);
    const view = new DataView(buffer);
    view.setUint8(0, 0x4d); // M
    view.setUint8(1, 0x54); // T
    view.setUint8(2, 0x68); // h
    view.setUint8(3, 0x64); // d
    view.setUint32(4, 6, false); // header length
    view.setUint16(8, 0, false); // format
    view.setUint16(10, 0, false); // num tracks
    view.setUint16(12, 480, false); // ticks per beat
    expect(() => parseMidiFile(buffer)).to.throw('No notes found');
  });
});
