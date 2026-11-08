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

const {
  parseXml, serializeXml, node, child, children, textOf, numberOf, numberIn,
} = require('./xml.js');
const { isZip, readZip, writeZip } = require('./zip.js');
const { TICKS_PER_BEAT, normalizeColor } = require('./score.js');

const PITCH_MAX = 8191;
const DEFAULT_PBS = 2;
const VSQ4_NS = 'http://www.yamaha.co.jp/vocaloid/schema/vsq4/';

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

  return {
    format: 'vsqx',
    bpm,
    timeSignature,
    tracks,
    warnings,
    meta: {
      format: 'vsqx',
      rootExtras: {
        vender: textOf(root, 'vender'),
        version: textOf(root, 'version'),
        seqName: textOf(master, 'seqName'),
      },
    },
  };
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

  return {
    format: 'vpr',
    bpm,
    timeSignature,
    tracks,
    warnings,
    meta: collectVprMeta(raw),
  };
}

// ---------------------------------------------------------------------------
// 写入
//
// 与 parseVsqx / parseVpr 严格对称：read 认下来的音符、歌词、音高、速度、
// 拍号与分片起点，write 必须能原样吐回去。三种格式共用的反向映射在
// score.js 的 documentToScore —— 这里只负责「把中间谱面编码成容器字节」。
//
// 宿主没有等价字段的部分（歌手库、风格、音素、颤音、部分轨道属性）由
// collect*Meta 收成精简快照，经 document.ext 带回，写回时合并进容器；
// 带不回来的在 main.js 里逐条告警，绝不静默丢弃。

/** 只保留体量可控的标量/浅对象，避免把整份原始工程塞进扩展域。 */
function smallMeta(value) {
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
    return typeof value === 'number' && !Number.isFinite(value) ? null : value;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {};
    for (const [key, item] of Object.entries(value).slice(0, 16)) {
      if (item === null || ['string', 'number', 'boolean'].includes(typeof item)) {
        out[key] = item;
      }
    }
    return out;
  }
  return undefined;
}

function collectVprMeta(raw) {
  const rootExtras = {};
  for (const [key, value] of Object.entries(raw)) {
    if (['version', 'masterTrack', 'tracks'].includes(key)) continue;
    const kept = smallMeta(value);
    if (kept !== undefined) rootExtras[key] = kept;
  }
  const master = raw.masterTrack || {};
  const masterExtras = {};
  for (const [key, value] of Object.entries(master)) {
    if (['tempo', 'timeSig'].includes(key)) continue;
    const kept = smallMeta(value);
    if (kept !== undefined) masterExtras[key] = kept;
  }
  const tracks = (Array.isArray(raw.tracks) ? raw.tracks : []).slice(0, 64).map((track) => {
    const out = {};
    for (const [key, value] of Object.entries(track || {})) {
      if (['parts', 'name', 'color'].includes(key)) continue;
      const kept = smallMeta(value);
      if (kept !== undefined) out[key] = kept;
    }
    return out;
  });
  return {
    format: 'vpr',
    rootExtras,
    masterExtras,
    version: smallMeta(raw.version) || { major: 5, minor: 0, revision: 0 },
    tracks,
  };
}

function clampPit(value) {
  return Math.max(-PITCH_MAX, Math.min(PITCH_MAX, Math.round(value)));
}

/** 相对半音偏移 → PIT 控制器值（PBS 固定为默认灵敏度）。 */
function pitFromSemitones(semitones) {
  return clampPit((Number(semitones) || 0) * PITCH_MAX / DEFAULT_PBS);
}

/** 把 pitchOffsets 整理成按 tick 升序、同位置去重的数据点。 */
function pitEvents(part) {
  const byTick = new Map();
  for (const offset of (Array.isArray(part.pitchOffsets) ? part.pitchOffsets : [])) {
    const tick = Math.round(((Number(offset.beat) || 0) - (Number(part.startBeat) || 0)) * TICKS_PER_BEAT);
    byTick.set(tick, pitFromSemitones(offset.semitones));
  }
  return [...byTick.entries()]
    .map(([pos, value]) => ({ pos, value }))
    .sort((a, b) => a.pos - b.pos);
}

function vsqxNote(note, partStartBeat) {
  return node('note', {}, [
    node('t', {}, [], String(Math.round(((Number(note.startBeat) || 0) - partStartBeat) * TICKS_PER_BEAT))),
    node('dur', {}, [], String(Math.max(1, Math.round((Number(note.durationBeat) || 0) * TICKS_PER_BEAT)))),
    node('n', {}, [], String(Math.round(Number(note.pitch) || 60))),
    node('y', {}, [], String(note.lyric || 'la')),
  ]);
}

/**
 * @param {object} score documentToScore 的输出
 * @param {object} meta parseVsqx 收集、经 document.ext 带回的快照
 * @returns {Buffer} .vsqx 文件字节（UTF-8 XML）
 */
function encodeVsqx(score, meta) {
  const m = meta && meta.format === 'vsqx' ? meta : {};
  const extras = m.rootExtras || {};
  const ts = score.timeSignature;

  const masterChildren = [
    node('seqName', {}, [], extras.seqName || 'SXSEditor'),
    // preMeasure 固定为 0：read 会减去它作为前导小节，写回的分片起点已经是
    // 去掉前导后的绝对拍，保留源值会造成二次偏移。
    node('preMeasure', {}, [], '0'),
    node('timeSig', {}, [
      node('m', {}, [], '0'),
      node('nu', {}, [], String(ts.numerator)),
      node('de', {}, [], String(ts.denominator)),
    ]),
    node('tempo', {}, [
      node('t', {}, [], '0'),
      node('v', {}, [], String(Math.round(score.bpm * 100))),
    ]),
  ];

  const tracks = (Array.isArray(score.tracks) ? score.tracks : []).map((track, ti) => {
    const parts = (Array.isArray(track.parts) ? track.parts : []).map((part) => {
      const startBeat = Number(part.startBeat) || 0;
      const childrenList = [
        node('t', {}, [], String(Math.round(startBeat * TICKS_PER_BEAT))),
        node('playTime', {}, [], String(Math.max(1, Math.round((Number(part.durationBeat) || 0) * TICKS_PER_BEAT)))),
        node('name', {}, [], String(part.name || track.name || `Part ${ti + 1}`)),
      ];
      for (const n of (Array.isArray(part.notes) ? part.notes : [])) {
        childrenList.push(vsqxNote(n, startBeat));
      }
      // PBS 灵敏度固定写默认值；PIT 逐点还原音高曲线。
      childrenList.push(node('cc', {}, [
        node('t', {}, [], '0'),
        node('v', { id: 'S' }, [], String(DEFAULT_PBS)),
      ]));
      for (const ev of pitEvents(part)) {
        childrenList.push(node('cc', {}, [
          node('t', {}, [], String(ev.pos)),
          node('v', { id: 'P' }, [], String(ev.value)),
        ]));
      }
      return node('vsPart', {}, childrenList);
    });
    return node('vsTrack', {}, [
      node('tNo', {}, [], String(ti)),
      node('name', {}, [], String(track.name || `Track ${ti + 1}`)),
      ...parts,
    ]);
  });

  const root = node('vsq4', { xmlns: VSQ4_NS }, [
    node('vender', {}, [], extras.vender || 'Yamaha corporation'),
    node('version', {}, [], extras.version || '4.0.0.3'),
    node('masterTrack', {}, masterChildren),
    ...tracks,
  ]);
  return Buffer.from(serializeXml(root), 'utf8');
}

/**
 * @param {object} score documentToScore 的输出
 * @param {object} meta parseVpr 收集、经 document.ext 带回的快照
 * @returns {Buffer} .vpr 文件字节（ZIP 内 Project/sequence.json）
 */
function encodeVpr(score, meta) {
  const m = meta && meta.format === 'vpr' ? meta : {};
  const ts = score.timeSignature;
  const tracks = (Array.isArray(score.tracks) ? score.tracks : []).map((track, ti) => {
    const trackMeta = (m.tracks || [])[ti] || {};
    const parts = (Array.isArray(track.parts) ? track.parts : []).map((part) => {
      const startBeat = Number(part.startBeat) || 0;
      const notes = (Array.isArray(part.notes) ? part.notes : []).map((n) => ({
        pos: Math.round(((Number(n.startBeat) || 0) - startBeat) * TICKS_PER_BEAT),
        duration: Math.max(1, Math.round((Number(n.durationBeat) || 0) * TICKS_PER_BEAT)),
        number: Math.round(Number(n.pitch) || 60),
        lyric: String(n.lyric || 'la'),
      }));
      return {
        ...trackMeta.partDefaults,
        pos: Math.round(startBeat * TICKS_PER_BEAT),
        duration: Math.max(1, Math.round((Number(part.durationBeat) || 0) * TICKS_PER_BEAT)),
        styleName: part.name || trackMeta.styleName || 'No Effect',
        notes,
        controllers: [
          { name: 'pitchBendSens', events: [{ pos: 0, value: DEFAULT_PBS }] },
          { name: 'pitchBend', events: pitEvents(part) },
        ],
      };
    });
    return {
      ...trackMeta,
      name: track.name,
      parts,
    };
  });

  const raw = {
    ...(m.rootExtras || {}),
    version: m.version || { major: 5, minor: 0, revision: 0 },
    masterTrack: {
      ...(m.masterExtras || {}),
      tempo: { events: [{ pos: 0, value: Math.round(score.bpm * 100) }] },
      timeSig: { events: [{ bar: 0, numer: ts.numerator, denom: ts.denominator }] },
    },
    tracks,
  };
  return writeZip(
    [{ name: 'Project/sequence.json', data: JSON.stringify(raw, null, 2) }],
    { method: 'deflate' },
  );
}

module.exports = {
  parseVsqx,
  parseVpr,
  decodeXmlBytes,
  encodeVsqx,
  encodeVpr,
};
