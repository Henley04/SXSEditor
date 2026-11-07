'use strict';
/**
 * VOCALOID 工程读取：.vsqx（VOCALOID3/4，XML）与 .vpr（VOCALOID5/6，ZIP+JSON）。
 *
 * 结构依据开源实现 UtaFormatix（Apache-2.0，https://github.com/sdercolin/utaformatix3）
 * 的 Vsqx.kt / Vpr.kt 与 VOCALOID 官方手册；这里按规范独立重写为 JavaScript，
 * 没有搬运其代码。
 *
 * 关键事实（两个容器都一样）：
 *  - 时间单位 tick，480 tick = 1 拍；工程可以带 preMeasure 前导小节，需要减掉。
 *  - 速度节点存的是 bpm × 100（VPR 的 value、VSQX 的 bpm/v 都是整数）。
 *  - 音高由 PIT（弯音，范围 ±8191）+ PBS（灵敏度，半音，默认 2）控制器表达：
 *    相对音高（半音）= PIT × PBS / 8191。
 *  - VPR 是 ZIP，真正的工程在 `Project/sequence.json`；音符 pos 相对 part.pos。
 *  - VSQX V3 与 V4 的标签名不同（musicalPart/vsPart、noteNum/n、lyric/y…），
 *    按 XML 命名空间区分。
 */

const { parseXml, child, children, textOf, numberOf, numberIn } = require('./xml.js');
const { isZip, readZip } = require('./zip.js');
const { TICKS_PER_BEAT, normalizeColor } = require('./score.js');

const PITCH_MAX = 8191;
const DEFAULT_PBS = 2;

// ---------------------------------------------------------------------------
// 解码

function decodeXmlBytes(bytes) {
  const buf = Buffer.from(bytes);
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) {
      return new TextDecoder('utf-16le', { fatal: false }).decode(buf.subarray(2));
    }
    if (buf[0] === 0xfe && buf[1] === 0xff) {
      const swapped = Buffer.from(buf.subarray(2));
      swapped.swap16();
      return new TextDecoder('utf-16le', { fatal: false }).decode(swapped);
    }
  }
  let body = buf;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) body = buf.subarray(3);

  const head = body.subarray(0, 256).toString('latin1');
  const declared = /<\?xml[^>]*encoding=["']([^"']+)["']/i.exec(head);
  const encoding = (declared ? declared[1] : 'utf-8').toLowerCase();
  try {
    return new TextDecoder(encoding === 'shift-jis' ? 'shift_jis' : encoding, { fatal: false }).decode(body);
  } catch (_) {
    return new TextDecoder('utf-8', { fatal: false }).decode(body);
  }
}

// ---------------------------------------------------------------------------
// VOCALOID 音高：PIT/PBS → 相对音高（半音）

/**
 * @param {Array<{pos:number,value:number}>} pit
 * @param {Array<{pos:number,value:number}>} pbs
 * @param {number} partStartTick 该 part 在工程中的绝对 tick 位置
 */
function pitchOffsets(pit, pbs, partStartTick) {
  if (!pit.length) return [];
  const pbsSorted = pbs.slice().sort((a, b) => a.pos - b.pos);
  const byBeat = new Map();
  for (const event of pit) {
    let sensitivity = DEFAULT_PBS;
    for (const pbsEvent of pbsSorted) {
      if (pbsEvent.pos <= event.pos) sensitivity = pbsEvent.value;
      else break;
    }
    if (!Number.isFinite(sensitivity) || sensitivity <= 0) sensitivity = DEFAULT_PBS;
    const semitones = (event.value * sensitivity) / PITCH_MAX;
    const beat = (partStartTick + event.pos) / TICKS_PER_BEAT;
    byBeat.set(Math.round(beat * 480) / 480, semitones);
  }
  // 第一个 PIT 事件之前没有弯音（VOCALOID 控制器默认 0），
  // 不能拿第一点的值向前外推，否则分片开头会整体跑调。
  const partStartBeat = Math.round((partStartTick / TICKS_PER_BEAT) * 480) / 480;
  const firstBeat = Math.min(...byBeat.keys());
  if (firstBeat > partStartBeat) byBeat.set(partStartBeat, 0);
  return [...byBeat.entries()]
    .map(([beat, semitones]) => ({ beat, semitones }))
    .sort((a, b) => a.beat - b.beat);
}

function sumPlayTime(part) {
  const value = numberOf(part, 'playTime');
  return value === null ? 0 : value;
}

// ---------------------------------------------------------------------------
// .vsqx（XML）

const TAGS = {
  v3: {
    preMeasure: 'preMeasure',
    timeSig: 'timeSig',
    posMes: 'posMes',
    nume: 'nume',
    denomi: 'denomi',
    tempo: 'tempo',
    posTick: 'posTick',
    bpm: 'bpm',
    vsTrack: 'vsTrack',
    trackName: 'trackName',
    part: 'musicalPart',
    note: 'note',
    duration: 'durTick',
    noteNum: 'noteNum',
    lyric: 'lyric',
    mCtrl: 'mCtrl',
    ctrlValue: 'attr',
    pbs: 'PBS',
    pit: 'PIT',
  },
  v4: {
    preMeasure: 'preMeasure',
    timeSig: 'timeSig',
    posMes: 'm',
    nume: 'nu',
    denomi: 'de',
    tempo: 'tempo',
    posTick: 't',
    bpm: 'v',
    vsTrack: 'vsTrack',
    trackName: 'name',
    part: 'vsPart',
    note: 'note',
    duration: 'dur',
    noteNum: 'n',
    lyric: 'y',
    mCtrl: 'cc',
    ctrlValue: 'v',
    pbs: 'S',
    pit: 'P',
  },
};

function ticksInMeasure(numerator, denominator) {
  return Math.round((TICKS_PER_BEAT * 4 * numerator) / denominator);
}

/** 复刻 TickCounter：算 preMeasure 之前累计的 tick 数。 */
function tickPrefixAt(timeSigs, measurePrefix) {
  let tick = 0;
  let measure = 0;
  let numerator = 4;
  let denominator = 4;
  for (const ts of timeSigs) {
    if (ts.measurePosition >= measurePrefix) break;
    tick += (ts.measurePosition - measure) * ticksInMeasure(numerator, denominator);
    measure = ts.measurePosition;
    numerator = ts.numerator;
    denominator = ts.denominator;
  }
  tick += (measurePrefix - measure) * ticksInMeasure(numerator, denominator);
  return tick;
}

function detectVsqxVersion(text) {
  if (/xmlns=["']http:\/\/www\.yamaha\.co\.jp\/vocaloid\/schema\/vsq4\/["']/.test(text)) return TAGS.v4;
  if (/xmlns=["']http:\/\/www\.yamaha\.co\.jp\/vocaloid\/schema\/vsq3\/["']/.test(text)) return TAGS.v3;
  return null;
}

function parseVsqx(bytes, t) {
  const text = decodeXmlBytes(bytes);
  const tags = detectVsqxVersion(text);
  if (!tags) {
    throw new Error(t(
      '不是 VOCALOID3/4 的 VSQX 工程（未找到 vsq3 / vsq4 命名空间）',
      'Not a VOCALOID3/4 VSQX project (no vsq3/vsq4 namespace)',
    ));
  }

  const root = parseXml(text);
  const master = child(root, 'masterTrack');
  if (!master) {
    throw new Error(t('VSQX 缺少 masterTrack', 'VSQX is missing masterTrack'));
  }
  const warnings = [];

  const preMeasure = numberOf(master, tags.preMeasure) || 0;

  const timeSigRaw = children(master, tags.timeSig)
    .map((node) => ({
      measurePosition: numberOf(node, tags.posMes),
      numerator: numberOf(node, tags.nume),
      denominator: numberOf(node, tags.denomi),
    }))
    .filter((e) => e.measurePosition !== null && e.numerator && e.denominator)
    .sort((a, b) => a.measurePosition - b.measurePosition);

  const timeSignature = timeSigRaw.length
    ? { numerator: timeSigRaw[0].numerator, denominator: timeSigRaw[0].denominator }
    : { numerator: 4, denominator: 4 };
  if (timeSigRaw.length > 1) {
    warnings.push(t(
      `工程内有 ${timeSigRaw.length} 处拍号设置，SXSEditor 只支持全局拍号，已使用 ${timeSignature.numerator}/${timeSignature.denominator}`,
      `${timeSigRaw.length} time signatures found; SXSEditor supports one global meter, using ${timeSignature.numerator}/${timeSignature.denominator}`,
    ));
  }

  const tickPrefix = tickPrefixAt(timeSigRaw, preMeasure);

  const tempoRaw = children(master, tags.tempo)
    .map((node) => ({
      pos: numberOf(node, tags.posTick),
      bpm: numberOf(node, tags.bpm),
    }))
    .filter((e) => e.pos !== null && e.bpm !== null)
    .sort((a, b) => a.pos - b.pos);

  let initialTempo = tempoRaw[0];
  for (const event of tempoRaw) {
    if (event.pos - tickPrefix <= 0) initialTempo = event;
  }
  const bpm = initialTempo ? initialTempo.bpm / 100 : 120;
  if (tempoRaw.length > 1) {
    warnings.push(t(
      `工程内有 ${tempoRaw.length} 处变速，SXSEditor 只支持全局 BPM，已使用 ${bpm}`,
      `${tempoRaw.length} tempo changes found; SXSEditor supports one global BPM, using ${bpm}`,
    ));
  }

  const tracks = [];
  for (const [index, trackNode] of children(root, tags.vsTrack).entries()) {
    const trackName = textOf(trackNode, tags.trackName) || `Track ${index + 1}`;
    const parts = [];

    for (const partNode of children(trackNode, tags.part)) {
      const partPos = numberOf(partNode, tags.posTick);
      if (partPos === null) continue;
      const partStart = partPos - tickPrefix;
      const playTime = sumPlayTime(partNode);

      const notes = children(partNode, tags.note).map((noteNode) => {
        const start = numberOf(noteNode, tags.posTick) || 0;
        return {
          startBeat: (partStart + start) / TICKS_PER_BEAT,
          durationBeat: (numberOf(noteNode, tags.duration) || 0) / TICKS_PER_BEAT,
          pitch: numberOf(noteNode, tags.noteNum),
          lyric: textOf(noteNode, tags.lyric),
        };
      }).filter((note) => note.pitch !== null);

      const pit = [];
      const pbs = [];
      for (const ctrl of children(partNode, tags.mCtrl)) {
        const valueNode = child(ctrl, tags.ctrlValue);
        if (!valueNode) continue;
        const name = valueNode.attrs.id;
        const pos = numberOf(ctrl, tags.posTick);
        const value = Number(textOf(valueNode));
        if (pos === null || !Number.isFinite(value)) continue;
        if (name === tags.pit) pit.push({ pos, value });
        else if (name === tags.pbs) pbs.push({ pos, value });
      }

      parts.push({
        name: textOf(partNode, 'partName') || textOf(partNode, tags.trackName) || trackName,
        startBeat: partStart / TICKS_PER_BEAT,
        durationBeat: Math.max(playTime / TICKS_PER_BEAT, 0),
        notes,
        pitchOffsets: pitchOffsets(pit, pbs, partStart),
      });
    }

    if (parts.some((part) => part.notes.length)) tracks.push({ name: trackName, parts });
  }

  return { format: 'vsqx', bpm, timeSignature, tracks, warnings };
}

// ---------------------------------------------------------------------------
// .vpr（ZIP 内的 Project/sequence.json）

function findSequenceEntry(files) {
  const preferred = ['Project/sequence.json', 'project/sequence.json'];
  for (const name of preferred) if (files.has(name)) return name;
  for (const name of files.keys()) {
    if (/sequence\.json$/i.test(name)) return name;
  }
  return null;
}

function parseVpr(bytes, t) {
  if (!isZip(bytes)) {
    throw new Error(t(
      '不是 VOCALOID5/6 的 VPR 工程（应为 ZIP 容器）',
      'Not a VOCALOID5/6 VPR project (expected a ZIP container)',
    ));
  }
  const files = readZip(bytes);
  const entry = findSequenceEntry(files);
  if (!entry) {
    throw new Error(t(
      'VPR 包内没有 Project/sequence.json',
      'The VPR archive has no Project/sequence.json',
    ));
  }

  let raw;
  try {
    raw = JSON.parse(files.get(entry).toString('utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(t(`VPR 的 sequence.json 不是合法 JSON：${err.message}`, `VPR sequence.json is not valid JSON: ${err.message}`));
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.tracks)) {
    throw new Error(t('VPR 的 sequence.json 缺少 tracks', 'VPR sequence.json has no tracks'));
  }

  const warnings = [];
  const master = raw.masterTrack || {};
  const tempoEvents = Array.isArray(master.tempo && master.tempo.events)
    ? master.tempo.events.filter((e) => e && Number.isFinite(Number(e.value))).sort((a, b) => a.pos - b.pos)
    : [];
  const tempoAtZero = tempoEvents.filter((e) => e.pos <= 0).pop() || tempoEvents[0];
  const bpm = tempoAtZero ? Number(tempoAtZero.value) / 100 : 120;
  if (tempoEvents.length > 1) {
    warnings.push(t(
      `工程内有 ${tempoEvents.length} 处变速，SXSEditor 只支持全局 BPM，已使用 ${bpm}`,
      `${tempoEvents.length} tempo changes found; SXSEditor supports one global BPM, using ${bpm}`,
    ));
  }

  const timeSigEvents = Array.isArray(master.timeSig && master.timeSig.events)
    ? master.timeSig.events
      .filter((e) => e && Number.isFinite(Number(e.numer)) && Number.isFinite(Number(e.denom)))
      .sort((a, b) => (Number(a.bar) || 0) - (Number(b.bar) || 0))
    : [];
  const meter = timeSigEvents[0];
  const timeSignature = meter
    ? { numerator: Number(meter.numer), denominator: Number(meter.denom) }
    : { numerator: 4, denominator: 4 };
  if (timeSigEvents.length > 1) {
    warnings.push(t(
      `工程内有 ${timeSigEvents.length} 处拍号设置，SXSEditor 只支持全局拍号，已使用 ${timeSignature.numerator}/${timeSignature.denominator}`,
      `${timeSigEvents.length} time signatures found; SXSEditor supports one global meter, using ${timeSignature.numerator}/${timeSignature.denominator}`,
    ));
  }

  const tracks = [];
  (Array.isArray(raw.tracks) ? raw.tracks : []).forEach((track, index) => {
    if (!track || typeof track !== 'object') return;
    const name = String(track.name || `Track ${index + 1}`);
    const parts = [];

    for (const part of Array.isArray(track.parts) ? track.parts : []) {
      if (!part || typeof part !== 'object') continue;
      const partStart = Number(part.pos) || 0;

      const notes = (Array.isArray(part.notes) ? part.notes : []).map((note) => ({
        startBeat: (partStart + (Number(note.pos) || 0)) / TICKS_PER_BEAT,
        durationBeat: (Number(note.duration) || 0) / TICKS_PER_BEAT,
        pitch: Number(note.number),
        lyric: note.lyric,
      })).filter((note) => Number.isFinite(note.pitch));

      const controllers = Array.isArray(part.controllers) ? part.controllers : [];
      const controllerEvents = (controllerName) => {
        const controller = controllers.find((c) => c && c.name === controllerName);
        return Array.isArray(controller && controller.events)
          ? controller.events
            .filter((e) => e && Number.isFinite(Number(e.pos)) && Number.isFinite(Number(e.value)))
            .map((e) => ({ pos: Number(e.pos), value: Number(e.value) }))
          : [];
      };

      parts.push({
        name: part.name || part.styleName || name,
        startBeat: partStart / TICKS_PER_BEAT,
        durationBeat: Math.max((Number(part.duration) || 0) / TICKS_PER_BEAT, 0),
        notes,
        pitchOffsets: pitchOffsets(controllerEvents('pitchBend'), controllerEvents('pitchBendSens'), partStart),
      });
    }

    if (parts.some((part) => part.notes.length)) {
      const colorValue = Number(track.color);
      tracks.push({ name, color: colorValue ? normalizeColor(colorValue) : undefined, parts });
    }
  });

  return { format: 'vpr', bpm, timeSignature, tracks, warnings };
}

module.exports = { parseVsqx, parseVpr, decodeXmlBytes };
