'use strict';
/**
 * 播放缓存签名（renderer/audioSignature.js）的行为测试。
 *
 * 背景：主窗口按 Play 时只看 `state.currentAudioData` 非空就续播，于是
 * 「分片被拖到另一个歌手」「改了音符/音高」「换了音色文件」之后听到的仍是
 * 改动前的音频。签名是这条判定的唯一依据，因此每一个会影响人声音频的输入
 * 都必须在这里被证明"改了签名就会变"—— 少覆盖一个字段，就是一类静默 bug。
 *
 * 反向要求同样重要：不影响人声音频的输入（伴奏、分片数组顺序）不能让签名变，
 * 否则每次导伴奏都要把整首重推一遍。
 */
const { expect } = require('chai');

let sig;
before(async () => {
  sig = await import('../src/renderer/audioSignature.js');
});

/** 最小可用的分片/轨道构造器。 */
function makeSinger(id, extra = {}) {
  return { id, name: id, color: '#fff', backend: { type: 'sxs' }, ...extra };
}

function makeFragment(id, singerId, notes, extra = {}) {
  return {
    id,
    singerId,
    startTime: 0,
    duration: 4,
    notes,
    pitchMode: 'manual',
    ...extra,
  };
}

function makeNote(start, pitch, lyric = 'a', extra = {}) {
  return { start, pitch, duration: 1, lyric, ...extra };
}

const BPM = 120;
const OPTS = {
  nSteps: 32,
  cfg: 3,
  cfgRescale: 0.7,
  diffStepChunk: false,
  diffStepChunkFrames: 500,
  diffStepOverlapFrames: 50,
  cfgScheduleMode: 'linear',
  cfgStrengthStart: null,
  cfgScheduleKeyframes: null,
  dynamicThresholdEnabled: false,
  dynamicThresholdPercentile: 0.995,
};

function project(fragments, singers, overrides = {}) {
  return sig.computeProjectSignature({
    fragments,
    singers,
    bpm: BPM,
    autoShift: false,
    inferenceOpts: OPTS,
    ...overrides,
  });
}

describe('audioSignature — 换歌手必须改变签名', () => {
  it('同一分片挂到不同歌手轨道，签名不同', () => {
    const a = makeSinger('singer-a');
    const b = makeSinger('singer-b');
    const f = makeFragment('f1', 'singer-a', [makeNote(0, 440)]);

    const before = project([f], [a, b]);
    const moved = { ...f, singerId: 'singer-b' };
    const after = project([moved], [a, b]);

    expect(after).to.not.equal(before);
  });

  it('两个歌手的 id 相同但参考音频不同，签名不同（换音色文件）', () => {
    const base = makeSinger('s1', { wavBuffer: new Uint8Array([1, 2, 3]).buffer });
    const other = makeSinger('s1', { wavBuffer: new Uint8Array([1, 2, 4]).buffer });
    const f = makeFragment('f1', 's1', [makeNote(0, 440)]);

    const before = project([f], [base]);
    const after = project([f], [other]);
    expect(after).to.not.equal(before);
  });

  it('同长度、同格式但内容不同的参考音频也能区分（旧实现只比 byteLength）', () => {
    const wavA = new Uint8Array(64 * 1024);
    const wavB = new Uint8Array(64 * 1024);
    // 改在采样点覆盖到的位置上 —— 哈希与主进程一致地按步长抽样（>2000 元素），
    // 未落在采样网格上的单点改动本来就检测不到，这里验证的是"同长度也能区分"。
    wavA[1024] = 7;
    wavB[1024] = 9;
    const sA = makeSinger('s1', { wavBuffer: wavA.buffer });
    const sB = makeSinger('s1', { wavBuffer: wavB.buffer });
    const f = makeFragment('f1', 's1', [makeNote(0, 440)]);

    expect(project([f], [sA])).to.not.equal(project([f], [sB]));
  });

  it('插件后端变化（音色后端换 SXS INFERENCE ↔ 内置）改变签名', () => {
    const plugin = makeSinger('s1', {
      backend: { type: 'plugin', pluginId: 'p1', kindId: 'k1', voiceId: 'v1', params: {} },
    });
    const builtin = makeSinger('s1', { backend: { type: 'sxs' } });
    const f = makeFragment('f1', 's1', [makeNote(0, 440)]);

    expect(project([f], [plugin])).to.not.equal(project([f], [builtin]));
  });

  it('插件参数变化改变签名（同一后端、不同 voice 参数）', () => {
    const p1 = makeSinger('s1', { backend: { type: 'plugin', pluginId: 'p', kindId: 'k', voiceId: 'v', params: { power: 0.5 } } });
    const p2 = makeSinger('s1', { backend: { type: 'plugin', pluginId: 'p', kindId: 'k', voiceId: 'v', params: { power: 0.9 } } });
    const f = makeFragment('f1', 's1', [makeNote(0, 440)]);

    expect(project([f], [p1])).to.not.equal(project([f], [p2]));
  });
});

describe('audioSignature — 内容编辑必须改变签名', () => {
  const singer = makeSinger('s1');

  it('改音高', () => {
    const f1 = makeFragment('f1', 's1', [makeNote(0, 440)]);
    const f2 = makeFragment('f1', 's1', [makeNote(0, 441)]);
    expect(project([f1], [singer])).to.not.equal(project([f2], [singer]));
  });

  it('改歌词', () => {
    const f1 = makeFragment('f1', 's1', [makeNote(0, 440, 'a')]);
    const f2 = makeFragment('f1', 's1', [makeNote(0, 440, 'i')]);
    expect(project([f1], [singer])).to.not.equal(project([f2], [singer]));
  });

  it('改连音标记（MIDI 导入的 noteType=3）', () => {
    const f1 = makeFragment('f1', 's1', [makeNote(0, 440, 'a')]);
    const f2 = makeFragment('f1', 's1', [makeNote(0, 440, 'a', { noteType: 3 })]);
    expect(project([f1], [singer])).to.not.equal(project([f2], [singer]));
  });

  it('改音素时长比例', () => {
    const f1 = makeFragment('f1', 's1', [makeNote(0, 440, 'a')]);
    const f2 = makeFragment('f1', 's1', [
      makeNote(0, 440, 'a', { phonemeAdjustments: [{ durationRatio: 1.4, offsetRatio: 0 }] }),
    ]);
    expect(project([f1], [singer])).to.not.equal(project([f2], [singer]));
  });

  it('改颤音', () => {
    const f1 = makeFragment('f1', 's1', [makeNote(0, 440, 'a')]);
    const f2 = makeFragment('f1', 's1', [
      makeNote(0, 440, 'a', { vibrato: { enabled: true, depth: 20, rate: 5.5, start: 0, length: 0.4, fadeIn: 0.1 } }),
    ]);
    expect(project([f1], [singer])).to.not.equal(project([f2], [singer]));
  });

  it('改分片起点（混音位置变了，必须重混）', () => {
    const f1 = makeFragment('f1', 's1', [makeNote(0, 440)], { startTime: 0 });
    const f2 = makeFragment('f1', 's1', [makeNote(0, 440)], { startTime: 4 });
    expect(project([f1], [singer])).to.not.equal(project([f2], [singer]));
  });

  it('改手绘音高曲线（锚点）改变签名', () => {
    // 锚点字段是 { time, pitch, strength, smoothness }（pitch = MIDI 音高），
    // 不是编辑器视图里的归一化 value。
    const curve = (pitch) => ({
      enabled: true,
      anchorPoints: [{ time: 0, pitch, strength: 100, smoothness: 0 }],
      brushSegments: [],
      bakedSegments: [],
    });
    const f1 = makeFragment('f1', 's1', [makeNote(0, 69)], { startTime: 0, duration: 4, pitchCurve: curve(69) });
    const f2 = makeFragment('f1', 's1', [makeNote(0, 69)], { startTime: 0, duration: 4, pitchCurve: curve(72) });
    expect(project([f1], [singer])).to.not.equal(project([f2], [singer]));
  });

  it('音高来源从 manual 切到 score 改变签名（两条路径的 f0 条件完全不同）', () => {
    const curve = {
      enabled: true,
      anchorPoints: [{ time: 0, pitch: 69, strength: 100, smoothness: 0 }],
      brushSegments: [],
      bakedSegments: [],
    };
    const manual = makeFragment('f1', 's1', [makeNote(0, 69)], { pitchMode: 'manual', pitchCurve: curve });
    const score = makeFragment('f1', 's1', [makeNote(0, 69)], { pitchMode: 'score', pitchCurve: curve });
    expect(project([manual], [singer])).to.not.equal(project([score], [singer]));
  });
});

describe('audioSignature — 全局参数与稳定性', () => {
  const singer = makeSinger('s1');
  const f = makeFragment('f1', 's1', [makeNote(0, 440)]);

  it('BPM 改变签名', () => {
    const a = project([f], [singer], { bpm: 120 });
    const b = project([f], [singer], { bpm: 121 });
    expect(a).to.not.equal(b);
  });

  it('扩散步数 / 引导强度改变签名', () => {
    const base = project([f], [singer]);
    expect(project([f], [singer], { inferenceOpts: { ...OPTS, nSteps: 64 } })).to.not.equal(base);
    expect(project([f], [singer], { inferenceOpts: { ...OPTS, cfg: 4.5 } })).to.not.equal(base);
  });

  it('分块开关改变签名（分块会改变合成结果）', () => {
    const base = project([f], [singer]);
    expect(project([f], [singer], { inferenceOpts: { ...OPTS, diffStepChunk: true } })).to.not.equal(base);
  });

  it('切换模型精度改变签名（fp32 → fp16 → int8 是三套不同权重）', () => {
    // 没有这一项时，切精度后按 Play 会命中上一精度算出的音频，听感上
    // "换了精度却毫无变化"，用户会误判成新精度没效果。
    const fp32 = project([f], [singer], { inferenceOpts: { ...OPTS, modelPrecision: 'fp32' } });
    const fp16 = project([f], [singer], { inferenceOpts: { ...OPTS, modelPrecision: 'fp16' } });
    const int8 = project([f], [singer], { inferenceOpts: { ...OPTS, modelPrecision: 'int8' } });
    expect(fp16).to.not.equal(fp32);
    expect(int8).to.not.equal(fp16);
    expect(int8).to.not.equal(fp32);
    // 同一精度必须稳定，否则每次 Play 都会重推
    expect(project([f], [singer], { inferenceOpts: { ...OPTS, modelPrecision: 'int8' } })).to.equal(int8);
  });

  it('自动变调开关改变签名', () => {
    expect(project([f], [singer], { autoShift: true })).to.not.equal(project([f], [singer]));
  });

  it('相同输入得到相同签名（可重复）', () => {
    expect(project([f], [singer])).to.equal(project([{ ...f }], [{ ...singer }]));
  });

  it('分片数组顺序不影响签名（按 startTime 归一）', () => {
    const fa = makeFragment('fa', 's1', [makeNote(0, 440)], { startTime: 0 });
    const fb = makeFragment('fb', 's1', [makeNote(0, 494)], { startTime: 4 });
    expect(project([fa, fb], [singer])).to.equal(project([fb, fa], [singer]));
  });

  it('伴奏轨的变化不影响人声签名（伴奏是独立 source，不该触发重推）', () => {
    const acc = { id: 'acc1', type: 'accompaniment', accompanimentStartTime: 0, accompanimentVolume: 1 };
    const withAcc = project([f], [singer, acc]);
    const withoutAcc = project([f], [singer]);
    expect(withAcc).to.equal(withoutAcc);

    // 音量/起点变化同样不应改变签名
    const movedAcc = { ...acc, accompanimentStartTime: 8, accompanimentVolume: 0.3 };
    expect(project([f], [singer, movedAcc])).to.equal(withoutAcc);
  });

  it('伴奏轨上的分片不计入签名', () => {
    const acc = { id: 'acc1', type: 'accompaniment' };
    const accFragment = makeFragment('facc', 'acc1', [makeNote(0, 440)]);
    expect(project([f, accFragment], [singer, acc])).to.equal(project([f], [singer]));
  });

  it('空分片（无音符）不计入签名', () => {
    const empty = makeFragment('f2', 's1', [], { startTime: 8 });
    expect(project([f, empty], [singer])).to.equal(project([f], [singer]));
  });

  it('未激活的重叠音符被裁剪后不参与签名（改动隐藏音符不触发重推）', () => {
    const hidden = makeNote(0.5, 300, 'a', { inactive: true });
    const f1 = makeFragment('f1', 's1', [makeNote(0, 440), hidden]);
    const f2 = makeFragment('f1', 's1', [makeNote(0, 440), { ...hidden, pitch: 999 }]);
    expect(project([f1], [singer])).to.equal(project([f2], [singer]));
  });
});

describe('audioSignature — 静音 / 独奏', () => {
  const f1 = makeFragment('f1', 's1', [makeNote(0, 440)]);
  const f2 = makeFragment('f2', 's2', [makeNote(0, 494)]);

  it('静音一条轨改变签名（否则按 Play 还会放出被静音那条的人声）', () => {
    const plain = [makeSinger('s1'), makeSinger('s2')];
    const muted = [makeSinger('s1', { mute: true }), makeSinger('s2')];
    expect(project([f1, f2], plain)).to.not.equal(project([f1, f2], muted));
  });

  it('静音前后的两个状态各自稳定，切回去能命中同一签名', () => {
    const plain = [makeSinger('s1'), makeSinger('s2')];
    const muted = [makeSinger('s1', { mute: true }), makeSinger('s2')];
    const a = project([f1, f2], plain);
    const b = project([f1, f2], muted);
    expect(project([f1, f2], plain)).to.equal(a);
    expect(project([f1, f2], muted)).to.equal(b);
    expect(a).to.not.equal(b);
  });

  it('独奏一条轨与只保留那一条轨等价（其余分片被排除）', () => {
    const soloed = [makeSinger('s1', { solo: true }), makeSinger('s2')];
    const onlyOne = [makeSinger('s1')];
    expect(project([f1, f2], soloed)).to.equal(project([f1], onlyOne));
  });

  it('全部静音时签名为"没有可唱分片"（与空工程一致）', () => {
    const allMuted = [makeSinger('s1', { mute: true }), makeSinger('s2', { mute: true })];
    expect(project([f1, f2], allMuted)).to.equal(project([], []));
  });
});
