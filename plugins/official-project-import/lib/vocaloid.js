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
const { parseWav, sliceWav } = require('./wav.js');
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
// .vpr（ZIP 内的 Project/sequence.json + Project/Audio/*.wav）

function findSequenceEntry(files) {
  const preferred = ['Project/sequence.json', 'project/sequence.json'];
  for (const name of preferred) if (files.has(name)) return name;
  for (const name of files.keys()) {
    if (/sequence\.json$/i.test(name)) return name;
  }
  return null;
}

/**
 * `.vpr` 里什么都可能躺：工程 JSON、伴奏 WAV、封面图、缩略图。
 *
 * 解压是有选择的 —— 按需解压不只是省内存，更是"带伴奏的工程必须能打开"：
 * 伴奏动辄几十 MB，无差别解压会被单条目/总体积上限连坐成"文件打不开"。
 * 这里放行两类：工程 JSON（32MB 够任何真实工程）与音频素材（单条 128MB、
 * 合计 192MB，够一首十分钟的 44.1k/16bit 立体声伴奏）。图片之类直接跳过。
 */
const AUDIO_ENTRY_RE = /\.(wav|wave|mp3|ogg|m4a|aac|flac|aif|aiff)$/i;
const MAX_PROJECT_JSON_BYTES = 32 * 1024 * 1024;
const MAX_AUDIO_ENTRY_BYTES = 128 * 1024 * 1024;
const MAX_AUDIO_TOTAL_BYTES = 192 * 1024 * 1024;

function isProjectEntry(name) {
  return /\.json$/i.test(name) || /(^|\/)sequence\b/i.test(name);
}

/** 素材体积的人类可读形式，只用于告警，不需要精确。 */
function megabyteText(bytes) {
  return `${Math.max(1, Math.round(bytes / 1024 / 1024))} MB`;
}

/**
 * 构造带预算的 accept 谓词。
 *
 * 超额音频不抛异常而是跳过：少一条伴奏总好过整份工程打不开，调用方会用
 * `skipped` 里的条目给出准确告警。音频合计预算必须在这里累计，不能交给
 * readZip 的总量上限 —— 那是抛错语义，一次超限就把整个导入判死刑。
 */
function makeVprEntryFilter() {
  let audioBytes = 0;
  return (name, size) => {
    if (isProjectEntry(name)) return size <= MAX_PROJECT_JSON_BYTES;
    if (!AUDIO_ENTRY_RE.test(name)) return false;
    if (size > MAX_AUDIO_ENTRY_BYTES) return false;
    if (audioBytes + size > MAX_AUDIO_TOTAL_BYTES) return false;
    audioBytes += size;
    return true;
  };
}

/** 按文件名找音频条目：优先 `Project/Audio/`，其次包内任意同名（大小写不敏感）。 */
function findAudioEntry(files, wanted) {
  const name = String(wanted || '');
  if (!name) return null;
  if (files.has(`Project/Audio/${name}`)) return `Project/Audio/${name}`;
  const lower = name.toLowerCase();
  for (const key of files.keys()) {
    if (key.slice(key.lastIndexOf('/') + 1).toLowerCase() === lower) return key;
  }
  return null;
}

/**
 * 轨道音量 → 线性增益。
 *
 * VOCALOID 的定点约定与速度一致（value/100 = BPM），音量同理是 0.01 dB。
 * 宿主的伴奏音量是 0–1 的线性增益、界面按百分比显示，所以这里换算后夹到
 * [0,1]：源工程里推高的增益（> 0dB）会被压回 1，用户要更响可以再推。
 */
function trackVolumeGain(track) {
  const events = Array.isArray(track && track.volume && track.volume.events) ? track.volume.events : [];
  let value = null;
  for (const ev of events) {
    const number = Number(ev && ev.value);
    if (!Number.isFinite(number)) continue;
    if ((Number(ev.pos) || 0) <= 0) value = number;
  }
  if (value === null) {
    const first = events.find((ev) => Number.isFinite(Number(ev && ev.value)));
    if (first) value = Number(first.value);
  }
  if (value === null) return 1;
  const gain = Math.pow(10, (value / 100) / 20);
  if (!Number.isFinite(gain)) return 1;
  // 低于 -80dB 一律按静音处理：VOCALOID 用很大的负数表示 -∞（拉到底的推子），
  // 换算出来是 1e-50 这种"数学上不是 0、听感上已经是 0"的值，不如直接归零。
  if (gain < 1e-4) return 0;
  return Math.min(1, gain);
}

/**
 * 只留标量/浅对象，供源工程结构快照使用。
 *
 * 复用 collectVprMeta 的 smallMeta（函数声明会提升）：快照要能穿过宿主文档校验
 * 的 ext 预算，所以绝不能把整份 part 或原始 WAV 字节塞进去。
 */
function shallowScalars(value, omit = []) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [key, item] of Object.entries(value).slice(0, 24)) {
    if (omit.includes(key)) continue;
    const kept = compactMeta(item);
    if (kept !== undefined) out[key] = kept;
  }
  return out;
}

/** 音频 part 的结构快照：宿主模型里没有独立字段的键都在这里带回。 */
function audioPartSnapshot(part) {
  const wav = part && part.wav && typeof part.wav === 'object' ? part.wav : {};
  const region = part && part.region && typeof part.region === 'object' ? part.region : null;
  return {
    part: shallowScalars(part, ['wav', 'region']),
    wav: shallowScalars(wav),
    region: region
      ? {
        begin: Number(region.begin) || 0,
        ...(Number.isFinite(Number(region.end)) ? { end: Number(region.end) } : {}),
      }
      : null,
  };
}

/**
 * 音频轨 → 宿主的伴奏轨。
 *
 * 一个 part 就是一段音频素材：`part.pos`（tick）决定它在时间线上的位置，
 * `part.wav.name` 指向包内 `Project/Audio/` 下的文件，`part.region`
 * （毫秒）记录用了源文件的哪一段 —— 宿主没有"裁剪偏移"概念，所以按 region
 * 把音频切好再交出去，否则伴奏会整体平移。
 *
 * 轨道名、`wav.name` / `originalName`、`region`、轨道 `type` 等源结构一并通过
 * `vpr` 快照交给 score.js 挂到伴奏轨的 ext 上，写回时才能原样重建。
 */
function collectVprAccompaniments(raw, files, skipped, warnings, t) {
  const out = [];
  const tracks = Array.isArray(raw.tracks) ? raw.tracks : [];
  let seq = 0;

  for (const track of tracks) {
    if (!track || typeof track !== 'object') continue;
    const parts = Array.isArray(track.parts) ? track.parts : [];
    for (const part of parts) {
      const wav = part && part.wav;
      if (!wav || typeof wav !== 'object' || !wav.name) continue;

      const wanted = String(wav.name);
      const displayName = String(part.name || wav.originalName || track.name || wanted);
      const entry = findAudioEntry(files, wanted);
      if (!entry) {
        const dropped = skipped.find((item) => item.name.toLowerCase().endsWith(wanted.toLowerCase()));
        if (dropped) {
          // 两种情况都会落到这里：单条超限，或累计超出音频预算。上限值按触发的那条给，
          // 否则用户会拿着一句"超过单条上限"去看一个其实合规的单条文件。
          const limit = dropped.size > MAX_AUDIO_ENTRY_BYTES ? MAX_AUDIO_ENTRY_BYTES : MAX_AUDIO_TOTAL_BYTES;
          warnings.push(t(
            `伴奏「${displayName}」有 ${megabyteText(dropped.size)}，超过音频上限 ${megabyteText(limit)}，已跳过；其余轨道照常导入。`,
            `The backing track "${displayName}" is ${megabyteText(dropped.size)}, over the ${megabyteText(limit)} audio limit; it was skipped, other tracks were imported.`,
          ));
        } else {
          warnings.push(t(
            `工程内含伴奏「${displayName}」，但包内找不到对应的音频文件（${wanted}），已跳过。`,
            `The project references the backing track "${displayName}" but the archive has no ${wanted}; it was skipped.`,
          ));
        }
        continue;
      }

      const source = files.get(entry);
      const info = parseWav(source);
      const region = part.region && typeof part.region === 'object' ? part.region : null;
      let audio = source;
      if (info.ok && region) {
        const beginMs = Number(region.begin) || 0;
        const endMs = Number(region.end);
        const fullMs = info.duration * 1000;
        const usableEnd = Number.isFinite(endMs) ? Math.min(endMs, fullMs) : fullMs;
        if (beginMs > 0 || usableEnd < fullMs - 1) {
          audio = sliceWav(source, info, beginMs, usableEnd);
          if (beginMs > 0) {
            warnings.push(t(
              `伴奏「${displayName}」在源工程里从 ${(beginMs / 1000).toFixed(2)}s 处截取，已按截取后的音频导入。`,
              `The backing track "${displayName}" starts at ${(beginMs / 1000).toFixed(2)}s in the source file; the trimmed audio was imported.`,
            ));
          }
        }
      }
      const sliced = audio === source ? info : parseWav(audio);
      if (!info.ok) {
        warnings.push(t(
          `伴奏「${displayName}」不是标准 WAV（可能是压缩格式），已按原样交给宿主解码。`,
          `The backing track "${displayName}" is not a plain WAV (possibly compressed); the raw file was handed to the host for decoding.`,
        ));
      }

      seq++;
      out.push({
        id: `import-accompaniment-${seq}`,
        trackName: displayName.slice(0, 60),
        startBeat: (Number(part.pos) || 0) / TICKS_PER_BEAT,
        mute: track.isMuted === true,
        volume: trackVolumeGain(track),
        audioFileName: String(wav.originalName || wanted).slice(0, 120),
        duration: sliced.ok ? sliced.duration : null,
        sampleRate: sliced.ok ? sliced.sampleRate : null,
        channels: sliced.ok ? sliced.channels : null,
        wavBuffer: audio,
        vpr: {
          track: shallowScalars(track, ['parts']),
          ...audioPartSnapshot(part),
        },
      });
    }
  }
  return out;
}

function parseVpr(bytes, t) {
  if (!isZip(bytes)) {
    throw new Error(t(
      '不是 VOCALOID5/6 的 VPR 工程（应为 ZIP 容器）',
      'Not a VOCALOID5/6 VPR project (expected a ZIP container)',
    ));
  }
  const { files, skipped } = readZip(bytes, {
    accept: makeVprEntryFilter(),
    maxEntrySize: MAX_AUDIO_ENTRY_BYTES,
    maxTotalSize: MAX_PROJECT_JSON_BYTES + MAX_AUDIO_TOTAL_BYTES,
  });
  const entry = findSequenceEntry(files);
  if (!entry) {
    const oversize = skipped.find((item) => isProjectEntry(item.name));
    throw new Error(oversize
      ? t(
        `VPR 的工程文件 ${oversize.name} 有 ${megabyteText(oversize.size)}，超过上限 ${megabyteText(MAX_PROJECT_JSON_BYTES)}`,
        `The VPR project file ${oversize.name} is ${megabyteText(oversize.size)}, over the ${megabyteText(MAX_PROJECT_JSON_BYTES)} limit`,
      )
      : t(
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

  // 音频轨不走 notes 通道：`type: 1` 的轨道没有音符，只有 part.wav + region，
  // 由 collectVprAccompaniments 单独收集成宿主的伴奏轨。
  const accompaniments = collectVprAccompaniments(raw, files, skipped, warnings, t);

  return {
    format: 'vpr',
    bpm,
    timeSignature,
    tracks,
    accompaniments,
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
// 宿主没有等价字段的部分（歌手库、风格、音素、VOCALOID 控制器细节、
// 部分轨道属性）由 collect*Meta 收成精简快照，经 document.ext 带回，
// 写回时合并进容器；带不回来的在 main.js 里逐条告警，绝不静默丢弃。
// SVP 的音符颤音由 lib/svp.js 转译为宿主音符颤音，不属于这里的无等价字段。

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

/**
 * VPR 的控制器（`volume` / `pan` 等）是 `{ events: [{ pos, value }] }`。
 * smallMeta 会把里面的数组整个丢掉，只剩一个空 `{}` —— 写回成空壳等于
 * "看起来保存了，内容其实损坏了"，正是有损写回最该避免的形态。
 * 这里只保留首个事件的标量，体量可控且足以让外部软件读到有效控制器。
 */
function controllerSnapshot(value) {
  const events = value && !Array.isArray(value) && Array.isArray(value.events)
    ? value.events : null;
  if (!events) return undefined;
  const first = events.find((e) => e && typeof e === 'object' && Number.isFinite(Number(e.value)));
  if (!first) return undefined;
  return { events: [{ pos: Number(first.pos) || 0, value: Number(first.value) }] };
}

/** 标量 / 控制器快照 / 空壳过滤三合一的元数据精简。 */
function compactMeta(value) {
  const ctrl = controllerSnapshot(value);
  if (ctrl) return ctrl;
  const kept = smallMeta(value);
  // 空对象写回目标格式后既没有信息又可能被外部软件当成损坏数据，宁可不写。
  if (kept && typeof kept === 'object' && !Array.isArray(kept) && !Object.keys(kept).length) {
    return undefined;
  }
  return kept;
}

function collectVprMeta(raw) {
  const rootExtras = {};
  for (const [key, value] of Object.entries(raw)) {
    if (['version', 'masterTrack', 'tracks'].includes(key)) continue;
    const kept = compactMeta(value);
    if (kept !== undefined) rootExtras[key] = kept;
  }
  const master = raw.masterTrack || {};
  const masterExtras = {};
  for (const [key, value] of Object.entries(master)) {
    if (['tempo', 'timeSig'].includes(key)) continue;
    const kept = compactMeta(value);
    if (kept !== undefined) masterExtras[key] = kept;
  }
  // 人声轨与音频轨分开存：写回时人声轨按 documentToScore 的轨道顺序逐条对齐，
  // 音频轨按伴奏轨重建。混在一起时，源工程里夹在中间的音频轨会把后面人声轨
  // 的元数据顶错位（m.tracks[ti] 取到的是别人的 type / color）。
  const vocalTracks = [];
  const audioTracks = [];
  for (const track of (Array.isArray(raw.tracks) ? raw.tracks : []).slice(0, 64)) {
    const out = {};
    for (const [key, value] of Object.entries(track || {})) {
      // color 必须留下：它能读进宿主 singer.color，写回时也要还原。
      if (['parts', 'name'].includes(key)) continue;
      const kept = compactMeta(value);
      if (kept !== undefined) out[key] = kept;
    }
    const parts = Array.isArray(track && track.parts) ? track.parts : [];
    const audioParts = parts.filter((p) => p && p.wav && typeof p.wav === 'object' && p.wav.name);
    if (audioParts.length) {
      audioTracks.push({ track: out, parts: audioParts.slice(0, 16).map(audioPartSnapshot) });
    } else {
      vocalTracks.push(out);
    }
  }
  return {
    format: 'vpr',
    rootExtras,
    masterExtras,
    version: compactMeta(raw.version) || { major: 5, minor: 0, revision: 0 },
    // tracks 保留为「人声轨元数据」的旧键名，兼容早期版本写进 .sxsproj 的 ext。
    tracks: vocalTracks,
    vocalTracks,
    audioTracks,
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

/** 宿主歌手颜色 `#rrggbb` → VPR 的 0xAARRGGBB；无法识别时返回 undefined。 */
function colorToVprNumber(value) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(value || '').trim());
  if (!m) return undefined;
  return ((0xff000000 | parseInt(m[1], 16)) >>> 0);
}

/** 包内音频文件名：只取 basename，去掉路径分隔符与非法字符，保留扩展名。 */
function safeAudioName(raw, index) {
  let name = String(raw || '').split(/[\\/]/).pop() || '';
  name = name.replace(/[^\w.\-()\u4e00-\u9fa5 ]/g, '_').replace(/^\.+/, '').trim();
  if (!name) name = `accompaniment-${index + 1}.wav`;
  if (!/\.[a-z0-9]{1,5}$/i.test(name)) name += '.wav';
  return name.slice(0, 120);
}

/** 宿主线性增益 → VOCALOID 的 0.01dB 定点；0 用 -100000 表示 -∞。 */
function gainToVprVolume(gain) {
  if (!Number.isFinite(gain) || gain <= 0) return -100000;
  return Math.round(20 * Math.log10(gain) * 100);
}

/**
 * 伴奏轨 → VPR 音频轨（`type: 1`）+ `Project/Audio/` 素材。
 *
 * 源轨道/part 的结构从伴奏轨 ext 的 vpr 快照取回；缺失时（宿主新建的伴奏轨、
 * 跨格式另存、旧版本导入的工程）按当前宿主字段生成一份全新的音频轨。
 * 没有内嵌音频字节的伴奏不会生成引用不存在素材的空轨，由调用方告警。
 *
 * region 需要特别处理：导入时按 region 裁剪过 WAV（宿主没有裁剪偏移概念），
 * 字节已经是裁剪后的片段。若把原 region 原样写回，外部软件会二次裁剪，
 * 伴奏再次平移 —— 因此写回的是「0 → 裁剪后时长」的全长 region。
 */
function encodeVprAccompaniments(score, meta) {
  const audioTracks = [];
  const audioEntries = [];
  const usedNames = new Set();
  const fallback = Array.isArray(meta.audioTracks) ? meta.audioTracks : [];
  const stats = { written: 0, dropped: 0, trimmed: 0, created: 0 };

  const accompaniments = Array.isArray(score.accompaniments) ? score.accompaniments : [];
  accompaniments.forEach((acc, index) => {
    let wav = null;
    if (acc && typeof acc.wavBase64 === 'string' && acc.wavBase64) {
      try {
        wav = Buffer.from(acc.wavBase64, 'base64');
      } catch (_) {
        wav = null;
      }
    }
    if (!wav || !wav.length) {
      stats.dropped += 1;
      return;
    }

    const snap = (acc && acc.vpr && typeof acc.vpr === 'object') ? acc.vpr : null;
    if (!snap) stats.created += 1;
    const fallbackTrack = fallback[index] || {};
    const srcTrack = (snap && snap.track) || fallbackTrack.track || {};
    const srcPart = (snap && snap.part) || (fallbackTrack.parts || [])[0]?.part || {};
    const srcWav = (snap && snap.wav) || (fallbackTrack.parts || [])[0]?.wav || {};
    const srcRegion = (snap && snap.region) || (fallbackTrack.parts || [])[0]?.region || null;

    let wavName = safeAudioName(srcWav.name || acc.audioFileName, index);
    if (usedNames.has(wavName.toLowerCase())) {
      const ext = /(\.[a-z0-9]{1,5})$/i.exec(wavName);
      const stem = ext ? wavName.slice(0, -ext[0].length) : wavName;
      const suffix = ext ? ext[0] : '.wav';
      let seq = 2;
      while (usedNames.has(`${stem}-${seq}${suffix}`.toLowerCase())) seq++;
      wavName = `${stem}-${seq}${suffix}`;
    }
    usedNames.add(wavName.toLowerCase());

    const durationMs = Number.isFinite(acc.audioDuration) && acc.audioDuration > 0
      ? Math.round(acc.audioDuration * 1000)
      : (parseWav(wav).ok ? Math.round(parseWav(wav).duration * 1000) : 0);
    if (srcRegion && Number(srcRegion.begin) > 0) stats.trimmed += 1;

    const part = {
      ...srcPart,
      name: String(acc.trackName || srcPart.name || 'Accompaniment').slice(0, 120),
      pos: Math.round((Number(acc.startTime) || 0) * TICKS_PER_BEAT),
      wav: {
        ...srcWav,
        name: wavName,
        originalName: String(acc.audioFileName || srcWav.originalName || wavName).slice(0, 120),
      },
      region: { begin: 0, ...(durationMs > 0 ? { end: durationMs } : {}) },
    };
    audioTracks.push({
      ...srcTrack,
      type: 1,
      name: String(srcTrack.name || acc.trackName || 'Audio').slice(0, 120),
      isMuted: acc.mute === true,
      volume: { events: [{ pos: 0, value: gainToVprVolume(Number(acc.volume)) }] },
      parts: [part],
    });
    audioEntries.push({ name: `Project/Audio/${wavName}`, data: wav });
    stats.written += 1;
  });

  return { audioTracks, audioEntries, stats };
}

/**
 * @param {object} score documentToScore 的输出
 * @param {object} meta parseVpr 收集、经 document.ext 带回的快照
 * @returns {Buffer} .vpr 文件字节（ZIP 内 Project/sequence.json + Project/Audio/*）
 */
function encodeVpr(score, meta) {
  const m = meta && meta.format === 'vpr' ? meta : {};
  const ts = score.timeSignature;
  const trackMetas = Array.isArray(m.vocalTracks || m.tracks) ? (m.vocalTracks || m.tracks) : [];
  const tracks = (Array.isArray(score.tracks) ? score.tracks : []).map((track, ti) => {
    const trackMeta = trackMetas[ti] || {};
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
    const hostColor = colorToVprNumber(track.color);
    return {
      ...trackMeta,
      name: track.name,
      ...(hostColor !== undefined || trackMeta.color !== undefined
        ? { color: hostColor !== undefined ? hostColor : trackMeta.color }
        : {}),
      parts,
    };
  });

  // 音频轨接在人声轨后面，与解析时的顺序约定一致（音频轨通常排最后）。
  const { audioTracks, audioEntries, stats } = encodeVprAccompaniments(score, m);
  tracks.push(...audioTracks);
  // codec.write 的返回值只有 bytes，统计借 score 这个内部对象回传给 writer 生成告警。
  score.vprWriteStats = stats;

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
    [
      { name: 'Project/sequence.json', data: JSON.stringify(raw, null, 2) },
      ...audioEntries,
    ],
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
