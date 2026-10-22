#!/usr/bin/env node
/**
 * 宣传片素材生成器 —— 跑一次**真实** SVS 推理，产出宣传片用的音频与指标。
 *
 * 这不是模拟数据：脚本调用应用自身的 OnnxSVSPipeline（src/inference/pipeline），
 * 加载 onnx_models/ 下的真实 SoulX-Singer ONNX 模型，完成
 * note_text/pitch/type/f0 编码 → preflow → cond_emb → 扩散去噪 → vocoder 的
 * 完整推理链，并把真实耗时、真实采样率、真实峰值写进 metrics.json。
 *
 * 用法：
 *   node scripts/intro-video-assets.js [--steps N] [--out-dir intro-video/public]
 *
 * 依赖：onnx_models/ 下 9 个 SVS 模型齐全（见 scripts 同目录 README 或
 * `electron . --cli models`）。
 */

const path = require('node:path');
const fs = require('node:fs');

const REPO_ROOT = path.join(__dirname, '..');

/**
 * 宣传片里出现的样例乐句。中文歌词由 textProcessing 的 pinyin-pro 路径
 * 转成 zh_* 音素，因此这里直接写汉字即可。
 */
const SAMPLE_SONG = {
  title: '月光落在窗前',
  bpm: 96,
  notes: [
    { pitch: 60, start: 0.0, duration: 1.0, lyric: '月' },
    { pitch: 62, start: 1.0, duration: 0.5, lyric: '光' },
    { pitch: 64, start: 1.5, duration: 0.5, lyric: '落' },
    { pitch: 62, start: 2.0, duration: 1.0, lyric: '在' },
    { pitch: 67, start: 3.0, duration: 1.0, lyric: '窗' },
    { pitch: 64, start: 4.0, duration: 0.5, lyric: '前' },
    { pitch: 60, start: 4.5, duration: 1.5, lyric: '了' },
  ],
};

function parseArgs(argv) {
  const opts = { steps: 32, outDir: path.join(REPO_ROOT, 'intro-video', 'public'), seed: 20250923 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--steps') opts.steps = Number(argv[++i]);
    else if (argv[i] === '--out-dir') opts.outDir = argv[++i];
    else if (argv[i] === '--seed') opts.seed = Number(argv[++i]);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv);
  const { OnnxSVSPipeline, SAMPLE_RATE } = require(path.join(REPO_ROOT, 'src', 'inference', 'pipeline'));
  const { encodeWav } = require(path.join(REPO_ROOT, 'src', 'audio', 'wavEncoder'));

  const modelDir = path.join(REPO_ROOT, 'onnx_models') + path.sep;

  // 缺模型就提前退出，别让用户等 8 秒加载后才发现。
  const required = ['note_text_encoder.onnx', 'note_pitch_encoder.onnx', 'note_type_encoder.onnx',
    'f0_encoder.onnx', 'preflow.onnx', 'cond_emb.onnx', 'diff_step_dml.onnx',
    'vocoder_dml.onnx', 'mel_transform.onnx'];
  const missing = required.filter((f) => !fs.existsSync(path.join(modelDir, f)));
  if (missing.length) {
    console.error('[intro-assets] 缺少模型文件，请先下载到 onnx_models/:');
    missing.forEach((m) => console.error('  - ' + m));
    process.exit(2);
  }

  console.log('[intro-assets] modelDir :', modelDir);
  console.log('[intro-assets] steps    :', opts.steps);
  console.log('[intro-assets] notes    :', SAMPLE_SONG.notes.length);

  const pipeline = new OnnxSVSPipeline(modelDir, {
    deviceId: 0,
    deviceMode: 'cpu',
    modelPrecision: 'fp32',
  });

  const tInit0 = Date.now();
  await pipeline.init();
  const initMs = Date.now() - tInit0;
  console.log(`[intro-assets] 模型加载 ${initMs} ms（9 个 ONNX 模型）`);

  const tSynth0 = Date.now();
  let lastProgress = -1;
  const audio = await pipeline.synthesize(SAMPLE_SONG.notes, SAMPLE_SONG.bpm, {
    nSteps: opts.steps,
    seed: opts.seed,
    onProgress: (p) => {
      if (p !== lastProgress) { lastProgress = p; process.stdout.write(`\r[intro-assets] 推理 ${p}%   `); }
    },
  });
  const synthMs = Date.now() - tSynth0;
  process.stdout.write('\n');

  // ---- 真实统计（全部来自这次推理的实际输出）----
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < audio.length; i++) {
    const v = audio[i];
    const a = Math.abs(v);
    if (a > peak) peak = a;
    sumSq += v * v;
  }
  const rms = Math.sqrt(sumSq / audio.length);
  const durationSec = audio.length / SAMPLE_RATE;
  const rtf = durationSec > 0 ? (synthMs / 1000) / durationSec : 0;

  const wavBuf = encodeWav(audio, SAMPLE_RATE);

  fs.mkdirSync(opts.outDir, { recursive: true });
  const wavPath = path.join(opts.outDir, 'sample.wav');
  fs.writeFileSync(wavPath, wavBuf);

  const metrics = {
    generatedAt: new Date().toISOString(),
    modelRepo: 'syxppp/SoulX-Singer-onnx-directml (fp32)',
    executionProvider: 'CPU (ONNX Runtime, Linux)',
    pipeline: {
      modelsLoaded: 9,
      initMs,
      synthMs,
      diffusionSteps: opts.steps,
      seed: opts.seed,
      sampler: 'stork2',
    },
    song: {
      title: SAMPLE_SONG.title,
      bpm: SAMPLE_SONG.bpm,
      noteCount: SAMPLE_SONG.notes.length,
      lyrics: SAMPLE_SONG.notes.map((n) => n.lyric).join(''),
      pitches: SAMPLE_SONG.notes.map((n) => n.pitch),
    },
    audio: {
      sampleRate: SAMPLE_RATE,
      samples: audio.length,
      durationSec: Number(durationSec.toFixed(3)),
      peak: Number(peak.toFixed(5)),
      rms: Number(rms.toFixed(5)),
      bytes: wavBuf.length,
    },
    realtimeFactor: Number(rtf.toFixed(2)),
  };

  const metricsPath = path.join(opts.outDir, 'metrics.json');
  fs.writeFileSync(metricsPath, JSON.stringify(metrics, null, 2));

  console.log('[intro-assets] ---- 真实推理结果 ----');
  console.log(`  推理耗时   : ${synthMs} ms`);
  console.log(`  音频时长   : ${durationSec.toFixed(3)} s @ ${SAMPLE_RATE} Hz`);
  console.log(`  采样点数   : ${audio.length}`);
  console.log(`  峰值/RMS   : ${peak.toFixed(5)} / ${rms.toFixed(5)}`);
  console.log(`  RTF        : ${rtf.toFixed(2)}x（生成 1 秒音频需要 ${rtf.toFixed(2)} 秒）`);
  console.log(`  WAV        : ${wavPath} (${(wavBuf.length / 1024).toFixed(1)} KB)`);
  console.log(`  metrics    : ${metricsPath}`);

  await pipeline.dispose();
}

main().catch((e) => {
  console.error('[intro-assets] FAIL', e.stack || e.message);
  process.exit(1);
});
