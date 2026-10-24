/**
 * RMVPE 端到端测试：真实模型 + 真实 detector 代码，跑合成音频并对照真值。
 *
 * 用法（Electron 运行时，验证 native ORT 在 Electron ABI 下可用）：
 *   xvfb-run -a npx electron test/e2e/rmvpeE2E.js
 * 或纯 Node（CI 里没有显示环境时）：
 *   node test/e2e/rmvpeE2E.js
 *
 * 退出码 0 = 全部通过。每个模型的详细指标以 JSON 打印。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { RmvpePitchDetector } = require('../../src/inference/rmvpePitchDetector');

const SR = 24000;
const NOTES = [60, 62, 64, 62, 67, 64, 60];
const BPM = 96;
const TOL_CENTS = 12; // 中位误差上限；fp32 实测 ~2.6，w8 ~2.6

function midiToHz(m) {
  return 440 * Math.pow(2, (m - 69) / 12);
}

/** 生成带首尾静音的和声合成旋律，返回 { audio, truth(t) }。 */
function synthMelody({ sampleRate = SR, bpm = BPM, notes = NOTES, lead = 0.5, tail = 0.5 } = {}) {
  const beat = 60 / bpm;
  const total = lead + tail + beat * notes.length;
  const n = Math.floor(total * sampleRate);
  const audio = new Float32Array(n);
  for (let i = 0; i < notes.length; i++) {
    const f = midiToHz(notes[i]);
    const s0 = Math.floor((lead + i * beat) * sampleRate);
    const s1 = Math.min(n, Math.floor((lead + (i + 1) * beat) * sampleRate));
    for (let j = s0; j < s1; j++) {
      const t = (j - s0) / sampleRate;
      const env = Math.min(1, t / 0.02, (beat - t) / 0.02);
      let s = 0;
      for (let h = 1; h <= 5; h++) s += Math.pow(0.6, h - 1) * Math.sin(2 * Math.PI * f * h * t);
      audio[j] = 0.25 * Math.max(0.01, env) * s;
    }
  }
  const truth = (t) => {
    const idx = Math.floor((t - lead) / beat);
    return idx >= 0 && idx < notes.length ? midiToHz(notes[idx]) : 0;
  };
  return { audio, truth, lead, tail, beat };
}

function percentile(arr, p) {
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((a.length - 1) * p))];
}

async function evaluate(label, modelPath, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rmvpe-e2e-'));
  fs.mkdirSync(path.join(dir, 'preprocess'), { recursive: true });
  fs.copyFileSync(modelPath, path.join(dir, 'preprocess', 'rmvpe_model.onnx'));

  const detector = new RmvpePitchDetector(dir);
  const t0 = Date.now();
  await detector.init();
  const initMs = Date.now() - t0;

  const { audio, truth, lead, beat, tail } = synthMelody(opts.audio || {});
  const end = lead + beat * (opts.audio?.notes?.length || NOTES.length); // 最后一个音符结束
  const GUARD = 0.06; // 起音/收尾 60ms 内的帧不参与判定（包络与检测器都有延迟）
  const t1 = Date.now();
  const frames = await detector.extractF0(audio, SR);
  const inferMs = Date.now() - t1;
  detector.dispose();

  // 有声/静音区间（按输出帧网格判定）
  const step = 0.02; // TARGET_HOP 480 / 24000
  const errs = [];
  let silenceFrames = 0;
  let silenceFalsePositive = 0;
  let thirtyHz = 0;
  let nan = 0;
  let voiced = 0;

  for (let i = 0; i < frames.length; i++) {
    const t = i * step;
    const f0 = frames[i].f0;
    if (!Number.isFinite(f0)) { nan++; continue; }
    if (f0 > 0 && Math.abs(f0 - 30) < 0.5) thirtyHz++;

    if (t < lead - GUARD || t > end + tail - GUARD) {
      // 明确的静音区：必须输出 0
      silenceFrames++;
      if (f0 > 0) silenceFalsePositive++;
    } else if (t > lead + GUARD && t < end - GUARD && f0 > 0) {
      // 音符切换点 ±40ms 内不计误差：任何检测器都会落在前一/后一个音上
      const phase = ((t - lead) % beat + beat) % beat;
      const nearBoundary = phase < 0.04 || phase > beat - 0.04;
      if (!nearBoundary) {
        voiced++;
        errs.push(Math.abs(1200 * Math.log2(f0 / truth(t))));
      }
    }
  }

  const median = errs.length ? percentile(errs, 0.5) : Infinity;
  const p95 = errs.length ? percentile(errs, 0.95) : Infinity;
  const result = {
    label,
    modelMB: +(fs.statSync(modelPath).size / 1048576).toFixed(1),
    initMs,
    inferMs,
    frames: frames.length,
    voicedFrames: voiced,
    silenceFrames,
    silenceFalsePositive,
    thirtyHzFrames: thirtyHz,
    nanFrames: nan,
    medianCents: +median.toFixed(2),
    p95Cents: +p95.toFixed(2),
    pass: median <= TOL_CENTS && silenceFalsePositive === 0 && nan === 0 && thirtyHz === 0 && voiced > 0,
  };
  fs.rmSync(dir, { recursive: true, force: true });
  return result;
}

async function main() {
  const args = process.argv.slice(2);
  const models = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--model' && args[i + 1]) {
      const [label, file] = args[i + 1].split('=');
      models.push({ label, file });
      i++;
    }
  }
  if (models.length === 0) {
    const base = path.join(__dirname, '..', '..', 'onnx_models', 'preprocess', 'rmvpe_model.onnx');
    models.push({ label: 'local', file: base });
  }

  const runtimeLabel = process.versions.electron
    ? `electron ${process.versions.electron}`
    : `node ${process.versions.node}`;
  console.log(`[rmvpe-e2e] runtime=${runtimeLabel} ` +
    `ort=${require('onnxruntime-node').version || 'n/a'}`);

  const results = [];
  for (const m of models) {
    if (!fs.existsSync(m.file)) {
      results.push({ label: m.label, pass: false, error: 'model file missing' });
      continue;
    }
    const r = await evaluate(m.label, m.file);
    r.runtime = process.versions.electron ? 'electron' : 'node';
    results.push(r);
    console.log(`[rmvpe-e2e] ${JSON.stringify(r)}`);
  }

  const failed = results.filter(r => !r.pass);
  console.log(`[rmvpe-e2e] ${results.length - failed.length}/${results.length} passed`);
  return failed.length === 0 ? 0 : 1;
}

if (process.versions.electron) {
  const { app } = require('electron');
  app.disableHardwareAcceleration();
  app.whenReady().then(async () => {
    let code = 1;
    try {
      code = await main();
    } catch (e) {
      console.error('[rmvpe-e2e] fatal:', e);
      code = 1;
    }
    app.exit(code);
  });
} else {
  main().then((code) => process.exit(code)).catch((e) => {
    console.error('[rmvpe-e2e] fatal:', e);
    process.exit(1);
  });
}
