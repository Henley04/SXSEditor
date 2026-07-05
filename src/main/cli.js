/**
 * SXSEditor CLI 调试入口
 *
 * 设计目标：为 agent 提供轻量命令行调试能力，验证关键功能并输出日志。
 * 不追求用 CLI 完成所有 GUI 操作，只做"功能验证 + 日志输出"。
 *
 * 用法：
 *   npx electron . --cli <command> [options]
 *   或打包后：SXSEditor.exe --cli <command> [options]
 *
 * 命令：
 *   help            显示帮助
 *   version         输出构建信息
 *   info            输出应用/运行时/路径信息
 *   gpu             执行 GPU/DML 设备检测
 *   models          列出 onnx_models 目录，标记缺失的必需模型
 *   settings        输出当前 settings.json
 *   init-pipeline   初始化 SVS 管线（验证全部模型可加载），输出耗时
 *   synth           运行一次最小合成，输出音频统计（不写文件）
 *                   可选：--out <path.wav> 写入 WAV 文件
 *
 * 退出码：0=成功，1=运行时错误，2=参数错误
 */

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const HELP_TEXT = `SXSEditor CLI (agent debug helper)

Usage:
  electron . --cli <command> [options]

Commands:
  help            Show this help
  version         Print build info
  info            Print app/runtime/path info
  gpu             Detect GPU / DirectML devices
  models          List onnx_models and mark missing required models
  settings        Dump current settings.json
  init-pipeline   Initialize SVS pipeline (verifies all models load)
  synth           Run a minimal synthesis and print audio stats
                  Options: --out <path.wav>  write WAV file
                           --steps <N>        diffusion steps (default 4)
                           --notes <json>     notes JSON string
                           --bpm <N>          tempo (default 120)

Exit codes: 0=ok, 1=error, 2=bad args`;

// ---------- 日志工具 ----------

function log(...args) {
  process.stdout.write(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
}

function logErr(...args) {
  process.stderr.write(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
}

function section(title) {
  log(`\n==== ${title} ====`);
}

function fmtBytes(n) {
  if (!n && n !== 0) return 'N/A';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (e) {
    logErr(`[WARN] Failed to read JSON ${filePath}: ${e.message}`);
    return fallback;
  }
}

// ---------- 命令实现 ----------

function cmdHelp() {
  log(HELP_TEXT);
  return 0;
}

function cmdVersion() {
  // webpack 打包后 build-info.json 被 CopyPlugin 复制到 .webpack/main/build-info.json
  // （与 main bundle 同目录），所以用 __dirname 直接定位
  const buildInfoPath = path.join(__dirname, 'build-info.json');
  const buildInfo = readJsonSafe(buildInfoPath, {});
  section('Build Info');
  log(JSON.stringify(buildInfo, null, 2));
  return 0;
}

function cmdInfo() {
  section('App');
  log(`productName : SXSEditor`);
  log(`isPackaged  : ${app.isPackaged}`);
  log(`appPath     : ${app.getAppPath()}`);
  log(`version     : ${app.getVersion()}`);

  section('Runtime');
  log(`node        : ${process.versions.node}`);
  log(`electron    : ${process.versions.electron}`);
  log(`platform    : ${process.platform}`);
  log(`arch        : ${process.arch}`);
  log(`pid         : ${process.pid}`);

  section('Paths');
  log(`userData    : ${app.getPath('userData')}`);
  log(`logs        : ${app.getPath('logs')}`);
  log(`temp        : ${app.getPath('temp')}`);
  log(`home        : ${app.getPath('home')}`);
  return 0;
}

async function cmdGpu() {
  section('GPU / DirectML Detection');
  const { ensureGPUInfo, detectAllHardware } = require('./gpuInfo');
  const { enumerateDMLDevices } = require('../inference/pipeline');

  const t0 = Date.now();
  log('[step] running detectAllHardware()...');
  try {
    const { npuAvailable } = await detectAllHardware();
    log(`NPU available: ${npuAvailable}`);
  } catch (e) {
    logErr(`[FAIL] detectAllHardware: ${e.message}`);
  }

  log('[step] running ensureGPUInfo()...');
  let controllers = [];
  try {
    controllers = await ensureGPUInfo();
    log(`systeminformation controllers: ${controllers.length}`);
    for (const c of controllers) {
      log(`  - ${c.model} | vram=${c.memoryTotal || c.vram || 'N/A'}MB | vendor=${c.vendor || 'N/A'}`);
    }
  } catch (e) {
    logErr(`[FAIL] ensureGPUInfo: ${e.message}`);
  }

  log('[step] running enumerateDMLDevices()...');
  let dmlDevices = [];
  try {
    const { getModelDir } = require('./modelDir');
    dmlDevices = await enumerateDMLDevices(getModelDir(), controllers);
    log(`DML devices: ${dmlDevices.length}`);
    for (const d of dmlDevices) {
      log(`  - idx=${d.dxgiAdapterNumber} name="${d.name}" type=${d.deviceType} vram=${fmtBytes(d.vramBytes)} discrete=${d.isDiscrete} src=${d.source || 'dml'}`);
    }
  } catch (e) {
    logErr(`[FAIL] enumerateDMLDevices: ${e.message}`);
  }
  log(`[done] GPU detection took ${Date.now() - t0}ms`);
  return 0;
}

function cmdModels() {
  const { getModelDir } = require('./modelDir');
  const modelDir = getModelDir();
  section('Models');
  log(`modelDir: ${modelDir}`);

  const { MODEL_FILE_MANIFEST, JP_MODEL_FILE_MANIFEST } = require('../modelManager');
  const { ONNX_MODEL_FILES } = require('../inference/pipeline/constants');

  section('Core models');
  let missing = 0;
  for (const file of ONNX_MODEL_FILES) {
    const p = path.join(modelDir, file);
    const exists = fs.existsSync(p);
    let size = 'N/A';
    if (exists) {
      try { size = fmtBytes(fs.statSync(p).size); } catch (_) {}
    } else {
      missing++;
    }
    log(`  [${exists ? 'OK' : 'MISS'}] ${file}  ${size}`);
  }

  section('Manifest extras (preprocess / basic_pitch / sifigan)');
  for (const item of MODEL_FILE_MANIFEST) {
    if (ONNX_MODEL_FILES.includes(item.filePath)) continue;
    const p = path.join(modelDir, item.filePath);
    const exists = fs.existsSync(p);
    let size = 'N/A';
    if (exists) {
      try { size = fmtBytes(fs.statSync(p).size); } catch (_) {}
    } else if (item.required) {
      missing++;
    }
    const tag = item.required ? (exists ? 'OK' : 'MISS') : (exists ? 'opt' : 'absent');
    log(`  [${tag}] ${item.filePath}  ${size}`);
  }

  // JP 模型目录
  const jpDir = path.join(modelDir, 'JP');
  if (fs.existsSync(jpDir)) {
    section('JP models');
    for (const item of JP_MODEL_FILE_MANIFEST) {
      const p = path.join(jpDir, item.filePath);
      const exists = fs.existsSync(p);
      let size = 'N/A';
      if (exists) {
        try { size = fmtBytes(fs.statSync(p).size); } catch (_) {}
      } else if (item.required) {
        missing++;
      }
      log(`  [${exists ? 'OK' : 'MISS'}] JP/${item.filePath}  ${size}`);
    }
  } else {
    log('\nJP model directory not present (Japanese inference unavailable).');
  }

  log(`\nSummary: ${missing} missing required file(s).`);
  return missing > 0 ? 1 : 0;
}

function cmdSettings() {
  const { loadSettings } = require('./settings');
  section('Settings');
  try {
    const s = loadSettings();
    log(JSON.stringify(s, null, 2));
    return 0;
  } catch (e) {
    logErr(`[FAIL] loadSettings: ${e.message}`);
    return 1;
  }
}

async function cmdInitPipeline() {
  section('SVS Pipeline Init');
  const { OnnxSVSPipeline } = require('../inference/pipeline');
  const { getModelDir } = require('./modelDir');
  const { loadSettings } = require('./settings');

  const settings = loadSettings();
  const modelDir = getModelDir();
  const modelPrecision = settings.modelPrecision || 'fp16';
  log(`modelDir     : ${modelDir}`);
  log(`precision    : ${modelPrecision}`);
  log(`deviceMode   : ${settings.deviceMode || 'smart'}`);
  log(`preferredId  : ${settings.preferredDeviceId ?? 'N/A'}`);
  log(`preferredType: ${settings.preferredDeviceType || 'N/A'}`);

  const t0 = Date.now();
  const pipeline = new OnnxSVSPipeline(modelDir, {
    deviceId: settings.preferredDeviceId ?? settings.deviceId ?? undefined,
    deviceMode: settings.deviceMode || 'smart',
    preferredDeviceType: settings.preferredDeviceType || undefined,
    modelDeviceMapping: settings.modelDeviceMapping || undefined,
    modelPrecision,
  });

  try {
    await pipeline.init();
    const elapsed = Date.now() - t0;
    log(`[OK] pipeline initialized in ${elapsed}ms`);
    log(`useWebNN    : ${pipeline.useWebNN}`);
    log(`gpuDevice   : ${pipeline.gpuDeviceName || 'N/A'}`);
    log(`dmlDeviceId : ${pipeline.dmlDeviceId ?? 'N/A'}`);
    log(`isFP16      : ${pipeline.isFP16}`);
    log(`vocoderType : ${pipeline.vocoderType}`);
    try { pipeline.dispose(); } catch (_) {}
    return 0;
  } catch (e) {
    logErr(`[FAIL] init failed after ${Date.now() - t0}ms: ${e.stack || e.message}`);
    try { pipeline.dispose(); } catch (_) {}
    return 1;
  }
}

async function cmdSynth(opts) {
  section('Synth Test');
  const { OnnxSVSPipeline, SAMPLE_RATE } = require('../inference/pipeline');
  const { getModelDir } = require('./modelDir');
  const { loadSettings } = require('./settings');

  const settings = loadSettings();
  const modelDir = getModelDir();
  const modelPrecision = settings.modelPrecision || 'fp16';
  const steps = opts.steps || 4;
  const bpm = opts.bpm || 120;

  // 默认 2 个音符（中文音素），agent 可通过 --notes 覆盖
  const defaultNotes = [
    { pitch: 60, start: 0, duration: 1, lyric: 'zh_a1' },
    { pitch: 64, start: 1, duration: 1, lyric: 'zh_a4' },
  ];
  const notes = opts.notes || defaultNotes;

  log(`modelDir : ${modelDir}`);
  log(`precision: ${modelPrecision}`);
  log(`bpm      : ${bpm}`);
  log(`steps    : ${steps}`);
  log(`notes    : ${JSON.stringify(notes)}`);

  const pipeline = new OnnxSVSPipeline(modelDir, {
    deviceId: settings.preferredDeviceId ?? settings.deviceId ?? undefined,
    deviceMode: settings.deviceMode || 'smart',
    preferredDeviceType: settings.preferredDeviceType || undefined,
    modelDeviceMapping: settings.modelDeviceMapping || undefined,
    modelPrecision,
  });

  try {
    const tInit = Date.now();
    await pipeline.init();
    log(`[init] ${Date.now() - tInit}ms`);

    const tSynth = Date.now();
    let lastProgress = -1;
    const audio = await pipeline.synthesize(notes, bpm, {
      nSteps: steps,
      onProgress: (p) => {
        if (p !== lastProgress) {
          lastProgress = p;
          log(`[progress] ${p}%`);
        }
      },
    });
    const synthMs = Date.now() - tSynth;

    // 统计
    let peak = 0, sum = 0;
    for (let i = 0; i < audio.length; i++) {
      const v = Math.abs(audio[i]);
      if (v > peak) peak = v;
      sum += audio[i];
    }
    const mean = sum / audio.length;
    const durationSec = audio.length / SAMPLE_RATE;

    log(`\n[OK] synthesis completed in ${synthMs}ms`);
    log(`samples      : ${audio.length}`);
    log(`sampleRate   : ${SAMPLE_RATE}`);
    log(`duration     : ${durationSec.toFixed(3)}s`);
    log(`peak         : ${peak.toFixed(6)}`);
    log(`mean         : ${mean.toFixed(6)}`);
    log(`dtype        : Float32Array`);

    if (opts.out) {
      const { encodeWav } = require('../audio/wavEncoder');
      const wavBuf = encodeWav(audio, SAMPLE_RATE);
      fs.writeFileSync(opts.out, wavBuf);
      log(`\nWAV written: ${opts.out} (${fmtBytes(wavBuf.length)})`);
    }

    try { pipeline.dispose(); } catch (_) {}
    return 0;
  } catch (e) {
    logErr(`[FAIL] synth failed: ${e.stack || e.message}`);
    try { pipeline.dispose(); } catch (_) {}
    return 1;
  }
}

// ---------- 参数解析 ----------

function parseArgs(argv) {
  // argv 是 process.argv.slice(2) 之后的内容
  // 第一个非 --cli 的 token 视为命令
  const cliIdx = argv.indexOf('--cli');
  const rest = cliIdx >= 0 ? argv.slice(cliIdx + 1) : argv;
  if (rest.length === 0) return { command: 'help', opts: {} };

  const command = rest[0];
  const opts = {};
  for (let i = 1; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--out') { opts.out = rest[++i]; continue; }
    if (a === '--steps') { opts.steps = parseInt(rest[++i], 10); continue; }
    if (a === '--bpm') { opts.bpm = parseInt(rest[++i], 10); continue; }
    if (a === '--notes') {
      try { opts.notes = JSON.parse(rest[++i]); }
      catch (e) { throw new Error(`Invalid --notes JSON: ${e.message}`); }
      continue;
    }
    // 未知参数忽略
  }
  return { command, opts };
}

// ---------- 主入口 ----------

async function runCli(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    logErr(`[ARG ERROR] ${e.message}\n`);
    logErr(HELP_TEXT);
    return 2;
  }

  const { command, opts } = parsed;

  try {
    switch (command) {
      case 'help': case '--help': case '-h': return cmdHelp();
      case 'version': return cmdVersion();
      case 'info': return cmdInfo();
      case 'gpu': return await cmdGpu();
      case 'models': return cmdModels();
      case 'settings': return cmdSettings();
      case 'init-pipeline': return await cmdInitPipeline();
      case 'synth': return await cmdSynth(opts);
      default:
        logErr(`Unknown command: ${command}\n`);
        logErr(HELP_TEXT);
        return 2;
    }
  } catch (e) {
    logErr(`[ERROR] ${e.stack || e.message}`);
    return 1;
  }
}

module.exports = { runCli, HELP_TEXT };
