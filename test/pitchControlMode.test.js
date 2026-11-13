/**
 * 音高来源（manual / score）的契约。
 *
 * 背景：SoulX-Singer 的 infer() 有 control="score" —— f0 条件整条置 0，音高
 * 只由 note_pitch 提供，F0 曲线交给 diffusion 自己生成。此前管线永远按 MIDI
 * 填一条逐音符恒定的平直 F0，等于把模型按死在一条假曲线上。
 *
 * 这里钉住三件事：
 *   1. 判定规则（显式 > 内容；enabled=false 视为显式 manual）
 *   2. 缓存键必须区分两种模式（否则切模式会命中上一模式的 mel）
 *   3. score 时 f0Encoder 收到的确实全是 0
 */
const { expect } = require('chai');
const {
  PITCH_MODE_AUTO, PITCH_MODE_MANUAL, PITCH_MODE_SCORE,
  normalizePitchMode, resolvePitchMode, isScoreMode,
  fragmentHasPitchContent, fragmentPitchMode,
  pitchCurveBadgeKind, PITCH_BADGE_MIXED,
} = require('../src/shared/pitchControl.js');
const { AudioSegmentation } = require('../src/inference/pipeline/audioSegmentation.js');
const { Preprocessing } = require('../src/inference/pipeline/preprocessing.js');
const { TextProcessing } = require('../src/inference/pipeline/textProcessing.js');

describe('pitchControl 判定', () => {
  it('未知值一律归一为 auto', () => {
    expect(normalizePitchMode(undefined)).to.equal(PITCH_MODE_AUTO);
    expect(normalizePitchMode(null)).to.equal(PITCH_MODE_AUTO);
    expect(normalizePitchMode('')).to.equal(PITCH_MODE_AUTO);
    expect(normalizePitchMode('MELODY')).to.equal(PITCH_MODE_AUTO);
    expect(normalizePitchMode('score')).to.equal(PITCH_MODE_SCORE);
    expect(normalizePitchMode('manual')).to.equal(PITCH_MODE_MANUAL);
  });

  it('未显式选择时按曲线内容判定', () => {
    expect(resolvePitchMode(PITCH_MODE_AUTO, false)).to.equal(PITCH_MODE_SCORE);
    expect(resolvePitchMode(PITCH_MODE_AUTO, true)).to.equal(PITCH_MODE_MANUAL);
    // 显式选择永远优先于内容
    expect(resolvePitchMode(PITCH_MODE_MANUAL, false)).to.equal(PITCH_MODE_MANUAL);
    expect(resolvePitchMode(PITCH_MODE_SCORE, true)).to.equal(PITCH_MODE_SCORE);
  });

  it('isScoreMode 与 resolvePitchMode 一致', () => {
    expect(isScoreMode(PITCH_MODE_AUTO, false)).to.equal(true);
    expect(isScoreMode(PITCH_MODE_AUTO, true)).to.equal(false);
    expect(isScoreMode(PITCH_MODE_SCORE, true)).to.equal(true);
  });
});

describe('fragmentHasPitchContent', () => {
  const noPp = () => false;
  const base = () => ({
    pitchCurve: { enabled: true, anchorPoints: [], brushSegments: [], bakedSegments: [], auto: { enabled: false } },
    notes: [],
    postprocess: null,
  });

  it('空曲线 + auto 关 + 无后处理 = 无内容', () => {
    expect(fragmentHasPitchContent(base(), noPp)).to.equal(false);
  });

  it('手绘锚点 / 笔刷 / 派生段都算内容', () => {
    const a = base(); a.pitchCurve.anchorPoints = [{ time: 1, pitch: 60 }];
    expect(fragmentHasPitchContent(a, noPp)).to.equal(true);
    const b = base(); b.pitchCurve.brushSegments = [{ time: 1, points: [] }];
    expect(fragmentHasPitchContent(b, noPp)).to.equal(true);
    const c = base(); c.pitchCurve.bakedSegments = [{ start: 0, end: 1 }];
    expect(fragmentHasPitchContent(c, noPp)).to.equal(true);
  });

  it('自动层开启算内容', () => {
    const f = base(); f.pitchCurve.auto.enabled = true;
    expect(fragmentHasPitchContent(f, noPp)).to.equal(true);
  });

  it('F0 后处理生效算内容（否则用户开的平滑会被丢掉）', () => {
    expect(fragmentHasPitchContent(base(), () => true)).to.equal(true);
  });

  it('显式关闭曲线按 manual 处理，不退化成 score', () => {
    const f = base(); f.pitchCurve.enabled = false;
    expect(fragmentHasPitchContent(f, noPp)).to.equal(true);
    expect(fragmentPitchMode({ ...f, pitchMode: PITCH_MODE_AUTO }, noPp)).to.equal(PITCH_MODE_MANUAL);
  });

  it('音符颤音算内容（颤音写进 F0，不重新合成就听不到）', () => {
    const f = base(); f.notes = [{ pitch: 60, vibrato: { enabled: true } }];
    expect(fragmentHasPitchContent(f, noPp)).to.equal(true);
  });

  it('显式 score 即使有内容也返回 score', () => {
    const f = base();
    f.pitchCurve.anchorPoints = [{ time: 1, pitch: 60 }];
    expect(fragmentPitchMode({ ...f, pitchMode: PITCH_MODE_SCORE }, noPp)).to.equal(PITCH_MODE_SCORE);
  });
});

describe('合成缓存键必须区分 manual / score', () => {
  const seg = new AudioSegmentation();
  const notes = [{ lyric: 'a', pitch: 60, start: 0, duration: 2 }];
  const baseOpts = { nSteps: 32, cfg: 3.0, cfgRescale: 0.7 };

  it('两种模式都无曲线时，键仍然不同', () => {
    const manual = seg.computeMelCacheKey(notes, 120, { ...baseOpts, pitchControl: 'manual', pitchCurveF0: null });
    const score = seg.computeMelCacheKey(notes, 120, { ...baseOpts, pitchControl: 'score', pitchCurveF0: null });
    expect(manual).to.not.equal(score);
    expect(seg.computeSynthCacheKey(notes, 120, { ...baseOpts, pitchControl: 'score' }))
      .to.not.equal(seg.computeSynthCacheKey(notes, 120, { ...baseOpts, pitchControl: 'manual' }));
  });

  it('缺省 pitchControl 视为 manual（旧调用方行为不变）', () => {
    expect(seg.computeMelCacheKey(notes, 120, baseOpts))
      .to.equal(seg.computeMelCacheKey(notes, 120, { ...baseOpts, pitchControl: 'manual' }));
  });

  it('段级键同样区分', () => {
    const a = seg.computeSegmentMelKey(notes, 120, { ...baseOpts, pitchControl: 'manual' }, 4, 0, 10);
    const b = seg.computeSegmentMelKey(notes, 120, { ...baseOpts, pitchControl: 'score' }, 4, 0, 10);
    expect(a).to.not.equal(b);
  });
});

describe('runEncoder 在 score 模式下把 f0 条件清零', () => {
  const ort = require('onnxruntime-node');
  const EMBED_DIM = 512;
  const COND_DIM = 256;

  function makeSessions(capture) {
    const emb = (n) => new ort.Tensor('float32', new Float32Array(n * EMBED_DIM), [1, n, EMBED_DIM]);
    const mk = (key) => ({
      run: async (feeds) => ({ [key]: emb(feeds.input_ids.dims[1]) }),
    });
    return {
      noteTextEncoder: mk('embeddings'),
      notePitchEncoder: {
        run: async (feeds) => {
          capture.pitch = Array.from(feeds.input_ids.data, (v) => Number(v));
          return { embeddings: emb(feeds.input_ids.dims[1]) };
        },
      },
      noteTypeEncoder: mk('embeddings'),
      f0Encoder: {
        run: async (feeds) => {
          capture.f0 = Array.from(feeds.input_ids.data, (v) => Number(v));
          return { embeddings: emb(feeds.input_ids.dims[1]) };
        },
      },
      preflow: {
        run: async (feeds) => ({
          processed_features: new ort.Tensor('float32', feeds.features.data, feeds.features.dims),
        }),
      },
      condEmb: {
        run: async (feeds) => ({
          cond_embedding: new ort.Tensor('float32', new Float32Array(feeds.cond_code.dims[1] * COND_DIM), [1, feeds.cond_code.dims[1], COND_DIM]),
        }),
      },
    };
  }

  function makeSequences(voicedF0) {
    const tokenCount = 3;
    const totalFrames = 4;
    return {
      tokenCount,
      noteTextSeq: Int32Array.from([0, 6, 7]),
      notePitchSeq: Int32Array.from([0, 60, 62]),
      noteTypeSeq: Int32Array.from([1, 2, 2]),
      f0Ids: Int32Array.from(voicedF0),
      mel2token: Int32Array.from([0, 1, 2, 2]),
    };
  }

  it('score：f0 输入全 0，note_pitch 条件照常保留', async () => {
    const capture = {};
    const prep = new Preprocessing(new TextProcessing());
    const seq = makeSequences([17, 18, 19, 20]);
    await prep.runEncoder(makeSessions(capture), seq, seq.tokenCount, 4, false, 0, false, true);
    expect(capture.f0).to.deep.equal([0, 0, 0, 0]);
    // score 对应官方 control="score"：只给 note_pitch，f0 全 0
    expect(capture.pitch).to.deep.equal([0, 60, 62]);
    // sequences.f0Ids 不能被就地改写：SiFiGAN vocoder 还要用真实 f0
    expect(Array.from(seq.f0Ids)).to.deep.equal([17, 18, 19, 20]);
    expect(Array.from(seq.notePitchSeq)).to.deep.equal([0, 60, 62]);
  });

  it('manual：f0 输入按曲线原样下发，note_pitch 条件全 0（对齐官方 melody）', async () => {
    const capture = {};
    const prep = new Preprocessing(new TextProcessing());
    const seq = makeSequences([17, 18, 19, 20]);
    await prep.runEncoder(makeSessions(capture), seq, seq.tokenCount, 4, false, 0, false, false);
    expect(capture.f0).to.deep.equal([17, 18, 19, 20]);
    // manual 对应官方 control="melody"：gt_note_pitch/pt_note_pitch 置 None（全 0），
    // 只保留 F0；此前无条件下发 note_pitch 会造成 note_pitch + F0 双条件。
    expect(capture.pitch).to.deep.equal([0, 0, 0]);
    // 只清送入 encoder 的局部数组，不改写上游序列：autoShift 中位数与分块
    // 边界 F0 斜率仍要读 notePitchSeq。
    expect(Array.from(seq.notePitchSeq)).to.deep.equal([0, 60, 62]);
  });
});

describe('pitchCurveBadgeKind（分片卡片徽标）', () => {
  const frag = (extra = {}) => ({
    pitchMode: undefined,
    pitchCurve: {
      enabled: true,
      anchorPoints: [],
      brushSegments: [],
      bakedSegments: [],
      auto: { enabled: false },
    },
    ...extra,
  });

  it('显式 score 优先于残留曲线：VPR 导入后切成 score 必须显示乐谱', () => {
    // 从 VPR/VSQX 导入的分片带着 anchorPoints，用户切成 score 后曲线不再参与推理。
    // 修复前徽标只看内容，永远显示"手动"，与 resolvePitchMode 的结论相反。
    const f = frag({ pitchMode: PITCH_MODE_SCORE });
    f.pitchCurve.anchorPoints = [{ time: 0, pitch: 60 }, { time: 1, pitch: 62 }];
    expect(pitchCurveBadgeKind(f)).to.equal(PITCH_MODE_SCORE);
    expect(fragmentPitchMode(f, () => false)).to.equal(PITCH_MODE_SCORE);
  });

  it('显式 score 且完全没有曲线字段时也要画乐谱', () => {
    expect(pitchCurveBadgeKind({ pitchMode: PITCH_MODE_SCORE })).to.equal(PITCH_MODE_SCORE);
    expect(pitchCurveBadgeKind({ pitchMode: PITCH_MODE_SCORE, pitchCurve: null })).to.equal(PITCH_MODE_SCORE);
  });

  it('自动层 + 手绘 = 混合；只有自动层 = 自动', () => {
    const mixed = frag({ pitchMode: PITCH_MODE_MANUAL });
    mixed.pitchCurve.auto.enabled = true;
    mixed.pitchCurve.anchorPoints = [{ time: 0, pitch: 60 }];
    expect(pitchCurveBadgeKind(mixed)).to.equal(PITCH_BADGE_MIXED);

    const auto = frag({ pitchMode: PITCH_MODE_AUTO });
    auto.pitchCurve.auto.enabled = true;
    expect(pitchCurveBadgeKind(auto)).to.equal(PITCH_MODE_AUTO);
  });

  it('只有手绘 = 手动；显式 manual + 空曲线也画手动（平直 F0，与 score 不同）', () => {
    const drawn = frag({ pitchMode: PITCH_MODE_MANUAL });
    drawn.pitchCurve.anchorPoints = [{ time: 0, pitch: 60 }];
    expect(pitchCurveBadgeKind(drawn)).to.equal(PITCH_MODE_MANUAL);
    expect(pitchCurveBadgeKind(frag({ pitchMode: PITCH_MODE_MANUAL }))).to.equal(PITCH_MODE_MANUAL);
  });

  it('auto + 无任何内容 → 不画徽标（不给旧工程添视觉噪音）', () => {
    expect(pitchCurveBadgeKind(frag())).to.equal(null);
    expect(pitchCurveBadgeKind(null)).to.equal(null);
  });
});
