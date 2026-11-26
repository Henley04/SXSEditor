'use strict';
/**
 * 项目级 MIDI 导出：轨道规划 + SMF 编码。
 *
 * 这里的断言都落在**字节层**，不调用项目自己的解码器 —— 用同一份实现
 * 编码再解码只能证明"自己跟自己一致"，证明不了别的 DAW 能读懂。
 * 测试里带一个最小 SMF 解析器，按规范读 header / 轨数 / delta-time 事件。
 */
const { expect } = require('chai');

let planMidiTracks, encodeProjectMidi, MIDI_PPQ;
before(async () => {
  ({ planMidiTracks, encodeProjectMidi } = await import('../src/shared/midiExportPlan.js'));
  ({ MIDI_PPQ } = await import('../src/shared/midiWriter.js'));
});

// ---------------------------------------------------------------- 最小解析器

function readU16(buf, off) { return (buf[off] << 8) | buf[off + 1]; }
function readU32(buf, off) { return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0; }

function readVlq(buf, state) {
  let value = 0;
  for (let i = 0; i < 4; i++) {
    const byte = buf[state.pos++];
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
  }
  return value;
}

/** @returns {{format:number, ntrks:number, division:number, tracks:Array}} */
function parseSmf(bytes) {
  const buf = Buffer.from(bytes);
  const tag = buf.toString('ascii', 0, 4);
  expect(tag, '文件必须以 MThd 开头').to.equal('MThd');
  const headerLen = readU32(buf, 4);
  expect(headerLen, 'MThd 长度必须是 6').to.equal(6);
  const format = readU16(buf, 8);
  const ntrks = readU16(buf, 10);
  const division = readU16(buf, 12);

  const tracks = [];
  let offset = 8 + headerLen;
  while (offset < buf.length) {
    expect(buf.toString('ascii', offset, offset + 4), '轨块标记必须是 MTrk').to.equal('MTrk');
    const len = readU32(buf, offset + 4);
    const start = offset + 8;
    const end = start + len;
    const state = { pos: start };
    const events = [];
    let absTick = 0;
    let name = null;
    let ended = false;
    while (state.pos < end) {
      const delta = readVlq(buf, state);
      absTick += delta;
      const status = buf[state.pos];
      if (status === 0xff) {
        state.pos++;
        const type = buf[state.pos++];
        const size = readVlq(buf, state);
        const data = Array.from(buf.subarray(state.pos, state.pos + size));
        state.pos += size;
        if (type === 0x03) name = Buffer.from(data).toString('utf8');
        events.push({ tick: absTick, kind: 'meta', type, data });
        if (type === 0x2f) { ended = true; break; }
      } else if (status === 0x90 || status === 0x80) {
        state.pos++;
        const pitch = buf[state.pos++];
        const velocity = buf[state.pos++];
        events.push({ tick: absTick, kind: status === 0x90 ? 'on' : 'off', pitch, velocity });
      } else {
        throw new Error(`unexpected status byte 0x${status.toString(16)} at ${state.pos - 1}`);
      }
    }
    expect(ended, '每条轨都必须以 end-of-track 结束').to.equal(true);
    expect(state.pos, 'MTrk 声明长度必须与实际事件长度一致').to.equal(end);
    tracks.push({ name, events });
    offset = end;
  }
  return { format, ntrks, division, tracks };
}

// ---------------------------------------------------------------- 造数据

const singer = (id, extra = {}) => ({
  id, type: 'singer', trackName: `Track ${id}`, singerName: `Singer ${id}`, mute: false, solo: false, ...extra,
});

const frag = (id, singerId, startTime, notes) => ({ id, singerId, startTime, duration: 8, notes });

const note = (pitch, start, duration, extra = {}) => ({ id: `${pitch}-${start}`, pitch, start, duration, lyric: 'la', ...extra });

describe('planMidiTracks — 每歌手一轨', () => {
  it('同一位歌手的多个分片合并到一条轨，位置按全局拍累加', () => {
    const tracks = planMidiTracks({
      singers: [singer('s1')],
      fragments: [
        frag('f1', 's1', 0, [note(60, 0, 1)]),
        frag('f2', 's1', 4, [note(62, 1, 1)]),
      ],
    });
    expect(tracks).to.have.length(1);
    expect(tracks[0].notes.map(n => n.tick)).to.deep.equal([0, (4 + 1) * MIDI_PPQ]);
  });

  it('两位歌手得到两条轨，互不混入', () => {
    const tracks = planMidiTracks({
      singers: [singer('s1'), singer('s2')],
      fragments: [
        frag('f1', 's1', 0, [note(60, 0, 1)]),
        frag('f2', 's2', 2, [note(67, 0, 1)]),
      ],
    });
    expect(tracks.map(t => t.singerId)).to.deep.equal(['s1', 's2']);
    expect(tracks[0].notes).to.have.length(1);
    expect(tracks[1].notes).to.have.length(1);
    expect(tracks[1].notes[0].tick).to.equal(2 * MIDI_PPQ);
  });

  it('伴奏轨不生成 MIDI 轨', () => {
    const tracks = planMidiTracks({
      singers: [singer('s1'), { id: 'a1', type: 'accompaniment', trackName: '伴奏' }],
      fragments: [frag('f1', 's1', 0, [note(60, 0, 1)]), frag('f2', 'a1', 0, [note(60, 0, 1)])],
    });
    expect(tracks.map(t => t.singerId)).to.deep.equal(['s1']);
  });

  it('静音轨被跳过；有独奏时只导出独奏轨', () => {
    const muted = planMidiTracks({
      singers: [singer('s1', { mute: true }), singer('s2')],
      fragments: [frag('f1', 's1', 0, [note(60, 0, 1)]), frag('f2', 's2', 0, [note(62, 0, 1)])],
    });
    expect(muted.map(t => t.singerId)).to.deep.equal(['s2']);

    const solo = planMidiTracks({
      singers: [singer('s1', { solo: true }), singer('s2')],
      fragments: [frag('f1', 's1', 0, [note(60, 0, 1)]), frag('f2', 's2', 0, [note(62, 0, 1)])],
    });
    expect(solo.map(t => t.singerId)).to.deep.equal(['s1']);
  });

  it('被遮挡的重叠音符不写入 MIDI（与合成同一真源）', () => {
    const tracks = planMidiTracks({
      singers: [singer('s1')],
      // 第二个音符被第一个完全覆盖 → 参与合成的只有第一个
      fragments: [frag('f1', 's1', 0, [note(60, 0, 4), note(72, 1, 2)])],
    });
    expect(tracks[0].notes).to.have.length(1);
    expect(tracks[0].notes[0].pitch).to.equal(60);
  });

  it('没有音高或时值非正的音符被跳过', () => {
    const tracks = planMidiTracks({
      singers: [singer('s1')],
      fragments: [frag('f1', 's1', 0, [note(0, 0, 1), note(60, 2, 0), note(64, 4, 1)])],
    });
    expect(tracks[0].notes.map(n => n.pitch)).to.deep.equal([64]);
  });

  it('没有任何带音符的轨时返回空数组（调用方据此提示而不是写空文件）', () => {
    const tracks = planMidiTracks({
      singers: [singer('s1')],
      fragments: [frag('f1', 's1', 0, [])],
    });
    expect(tracks).to.deep.equal([]);
  });

  it('连音音符的歌词写成 "-"', () => {
    const tracks = planMidiTracks({
      singers: [singer('s1')],
      fragments: [frag('f1', 's1', 0, [note(60, 0, 1, { lyric: 'la', isContinuation: true })])],
    });
    expect(tracks[0].notes[0].lyric).to.equal('-');
  });
});

describe('encodeProjectMidi — SMF format 1', () => {
  const build = () => {
    const tracks = planMidiTracks({
      singers: [singer('s1'), singer('s2')],
      fragments: [
        frag('f1', 's1', 0, [note(60, 0, 1, { lyric: 'あ' }), note(62, 1, 1)]),
        frag('f2', 's2', 2, [note(67, 0, 2)]),
      ],
    });
    return encodeProjectMidi({ tracks, bpm: 120, timeSignature: [3, 4], name: 'Demo' });
  };

  it('header 声明 format 1、轨数 = 1 指挥轨 + 每歌手一轨、PPQ 480', () => {
    const smf = parseSmf(build());
    expect(smf.format).to.equal(1);
    expect(smf.ntrks).to.equal(3);
    expect(smf.division).to.equal(480);
    expect(smf.tracks).to.have.length(3);
  });

  it('指挥轨带速度与拍号，且没有任何音符事件', () => {
    const smf = parseSmf(build());
    const conductor = smf.tracks[0];
    expect(conductor.name).to.equal('Demo');
    const tempo = conductor.events.find(e => e.kind === 'meta' && e.type === 0x51);
    expect(tempo, '缺少速度元事件').to.be.ok;
    const us = (tempo.data[0] << 16) | (tempo.data[1] << 8) | tempo.data[2];
    expect(us).to.equal(500000); // 120 BPM
    const ts = conductor.events.find(e => e.kind === 'meta' && e.type === 0x58);
    expect(ts.data.slice(0, 2)).to.deep.equal([3, 2]); // 3/4
    expect(conductor.events.some(e => e.kind === 'on' || e.kind === 'off')).to.equal(false);
  });

  it('每条歌手轨带轨道名，音符首尾配对且时值正确', () => {
    const smf = parseSmf(build());
    const t1 = smf.tracks[1];
    expect(t1.name).to.equal('Track s1');
    const ons = t1.events.filter(e => e.kind === 'on');
    const offs = t1.events.filter(e => e.kind === 'off');
    expect(ons).to.have.length(2);
    expect(offs).to.have.length(2);
    // 第一个音符：tick 0 起，1 拍（480）长
    expect(ons[0]).to.include({ tick: 0, pitch: 60 });
    expect(offs[0]).to.include({ tick: 480, pitch: 60 });
    // 第二个音符从第 2 拍（相对分片 1 拍 + 分片起点 0）开始
    expect(ons[1]).to.include({ tick: 480, pitch: 62 });
  });

  it('同一 tick 上音符结束排在开始之前（避免零长度/悬挂音符）', () => {
    const tracks = planMidiTracks({
      singers: [singer('s1')],
      fragments: [frag('f1', 's1', 0, [note(60, 0, 1), note(62, 1, 1)])],
    });
    const smf = parseSmf(encodeProjectMidi({ tracks, bpm: 120 }));
    const seq = smf.tracks[1].events.filter(e => e.kind === 'on' || e.kind === 'off');
    const at480 = seq.filter(e => e.tick === 480);
    expect(at480.map(e => e.kind)).to.deep.equal(['off', 'on']);
  });

  it('歌词以 meta 0x05 写出，UTF-8 可用', () => {
    const smf = parseSmf(build());
    const lyric = smf.tracks[1].events.find(e => e.kind === 'meta' && e.type === 0x05);
    expect(Buffer.from(lyric.data).toString('utf8')).to.equal('あ');
  });

  it('BPM 换算为微秒每四分音符', () => {
    const tracks = planMidiTracks({
      singers: [singer('s1')],
      fragments: [frag('f1', 's1', 0, [note(60, 0, 1)])],
    });
    const smf = parseSmf(encodeProjectMidi({ tracks, bpm: 90 }));
    const tempo = smf.tracks[0].events.find(e => e.kind === 'meta' && e.type === 0x51);
    const us = (tempo.data[0] << 16) | (tempo.data[1] << 8) | tempo.data[2];
    expect(us).to.equal(Math.round(60000000 / 90));
  });

  it('二进制是 Uint8Array，且长度与 header 声明一致', () => {
    const bytes = build();
    expect(bytes).to.be.instanceOf(Uint8Array);
    expect(bytes.length).to.be.greaterThan(14);
    // 能被解析且严格校验了每段 MTrk 长度 —— 解析失败会在此抛错
    expect(() => parseSmf(bytes)).to.not.throw();
  });
});
