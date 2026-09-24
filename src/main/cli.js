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
  winml           Detect Windows ML plugin EPs (experimental)
  models          List onnx_models and mark missing required models
  settings        Dump current settings.json
  init-pipeline   Initialize SVS pipeline (verifies all models load)
  synth           Run a minimal synthesis and print audio stats
                  Options: --out <path.wav>  write WAV file
                           --steps <N>        diffusion steps (default 4)
                           --notes <json>     notes JSON string
                           --bpm <N>          tempo (default 120)
  synth-project   Synthesize a real .sxsproj window (with its singer reference)
                  and print the execution provider actually used.
                  Options: --file <project.sxsproj>   required
                           --out <path.wav>          write WAV file
                           --fragment <N>            fragment index (default 0)
                           --from <sec> --to <sec>   time window (default 0..30s)
                           --duration <sec>          alternative to --to
                           --singer <x.sxssinger>    override fragment's singer
                           --precision fp32|fp16     override modelPrecision
                           --steps <N>               diffusion steps
                           --sampler <name> --cfg <n> --cfg-rescale <n>
                           --cfg-schedule constant|linear|cosine
                           --qdrift                  enable Q-Drift
                           --seed <N>                fix initial noise (required
                                                     for any precision comparison)
                           --dry-run                 only print the parsed plan

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

// Windows ML 插件 EP 诊断（fail-soft：任何失败只打印警告，不影响退出码）
async function cmdWinml() {
  section('Windows ML');
  const winmlCatalog = require('../inference/winml/winmlCatalog');
  const ortBridge = require('../inference/winml/ortBridge');

  log(`platformSupported: ${winmlCatalog.isPlatformSupported()}`);
  const settings = (() => {
    try { return require('./settings').loadSettings() || {}; } catch (_) { return {}; }
  })();
  log(`enabled(settings.winmlEnabled): ${settings.winmlEnabled === true}`);

  if (!winmlCatalog.isPlatformSupported()) {
    log('WinML vendor EPs require Windows 11 24H2+ (build 26100+) on x64/arm64.');
    return 0;
  }

  const bootstrap = winmlCatalog.locateBootstrapDll(settings.winmlBootstrapDllPath);
  log(`bootstrapDll: ${bootstrap || 'NOT FOUND (catalog disabled)'}`);

  const providers = await winmlCatalog.listCompatibleProviders();
  log(`compatible EPs: ${providers.length}`);
  for (const p of providers) {
    log(`  - ${p.name} readyState=${p.readyState}`);
    const r = await winmlCatalog.ensureProviderReady(p.name).catch((e) => ({ ok: false, diagnostic: e.message }));
    if (r.ok && r.libraryPath) {
      try {
        const ok = await ortBridge.ensureBridgeInit();
        if (ok) {
          ortBridge.registerEp(p.name, r.libraryPath);
          log(`    registered <- ${r.libraryPath}`);
        }
      } catch (e) {
        logErr(`    register failed: ${e.message.split('\n')[0]}`);
      }
    } else if (r.diagnostic) {
      logErr(`    ensureReady failed: ${String(r.diagnostic).split('\n')[0].slice(0, 100)}`);
    }
  }

  const devices = ortBridge.listDevices();
  log(`EP devices in bridge env: ${devices.length}`);
  for (const d of devices) {
    log(`  - [${d.index}] ${d.epName} type=${d.deviceType} vendor=${d.vendor || '?'}`);
  }
  return 0;
}

function cmdModels() {  const { getModelDir } = require('./modelDir');
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
  const modelPrecision = settings.modelPrecision || 'fp32';
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
  const modelPrecision = settings.modelPrecision || 'fp32';
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

/**
 * 用真实工程文件（.sxsproj）的一个时间窗做合成，并打印实际使用的执行提供者。
 *
 * 目的：在用户自己的歌曲内容上对比 FP32 / FP16（以及不同 EP）的输出差异，
 * 而不是只用评测数据集的条件张量。工程文件自带歌手参考（.sxssinger 里的
 * 参考音频 + f0 + midi），所以音色也是真实的。
 *
 * 与渲染进程 fragment-svs:synthesize 的差异（有意为之，避免把与精度无关的
 * 后处理混进对比）：不做分片 / 流式 / loudnorm / 抗混叠，只取一个时间窗。
 */
async function cmdSynthProject(opts) {
  section('Synth Project');
  if (!opts.file) { logErr('--file <project.sxsproj> is required'); return 2; }
  const { OnnxSVSPipeline, SAMPLE_RATE } = require('../inference/pipeline');
  const { getModelDir } = require('./modelDir');
  const { loadSettings } = require('./settings');

  const settings = loadSettings();
  const modelDir = getModelDir();
  const precision = opts.precision || settings.modelPrecision || 'fp32';
  const steps = opts.steps || 32;

  const proj = JSON.parse(fs.readFileSync(opts.file, 'utf-8'));
  const frags = proj.fragments || [];
  const fragIdx = Number.isInteger(opts.fragment) ? opts.fragment : 0;
  const frag = frags[fragIdx];
  if (!frag) { logErr(`fragment ${fragIdx} not found (project has ${frags.length})`); return 2; }
  const bpm = opts.bpm || (proj.project && proj.project.bpm) || 120;

  // ---- 歌手参考（工程自带；缺失就退化为纯音符合成）----
  const singerMeta = (proj.singers || []).find(s => s.id === frag.singerId) || null;
  const singerPath = opts.singer || (singerMeta && singerMeta.singerFilePath) || null;
  let refAudioWavBuffer = null, refF0Data = null, refMidiNotes = null;
  let singerName = null, singerLanguage = null;
  if (singerPath && fs.existsSync(singerPath)) {
    const sj = JSON.parse(fs.readFileSync(singerPath, 'utf-8'));
    singerName = sj.singerName || path.basename(singerPath);
    singerLanguage = (sj.singerData && sj.singerData.language) || null;
    if (sj.wavBase64) refAudioWavBuffer = Buffer.from(sj.wavBase64, 'base64');
    refF0Data = Array.isArray(sj.f0Data) ? sj.f0Data : null;
    refMidiNotes = Array.isArray(sj.midiNotes) ? sj.midiNotes : null;
    log(`singer     : ${singerName} lang=${singerLanguage} ref=${refAudioWavBuffer ? fmtBytes(refAudioWavBuffer.length) : 'none'} f0=${refF0Data ? refF0Data.length : 0} midi=${refMidiNotes ? refMidiNotes.length : 0}`);
  } else {
    log(`singer     : none (${singerPath || 'no singerFilePath'}) → 无参考音色，只反映音符层面的误差`);
  }

  // ---- 时间窗切片 ----
  // 注意：工程文件里 note.start / note.duration 的单位是「拍」(beat)，不是秒。
  // 之前直接按秒过滤，--duration 30 其实只切到 30 拍（168bpm 下只有 10.7s）。
  const secPerBeat = 60 / bpm;
  const fromSec = Number.isFinite(opts.from) ? opts.from : 0;
  const toSec = Number.isFinite(opts.to) ? opts.to
    : fromSec + (Number.isFinite(opts.duration) ? opts.duration : 30);
  const from = fromSec / secPerBeat;   // 秒 → 拍
  const to = toSec / secPerBeat;       // 秒 → 拍
  const allNotes = frag.notes || [];
  const spanBeats = allNotes.length
    ? Math.max(...allNotes.map(n => n.start + n.duration)) : 0;
  const notes = allNotes
    .filter(n => n.start < to && n.start + n.duration > from)
    .map(n => {
      const s = Math.max(n.start, from);
      const e = Math.min(n.start + n.duration, to);
      return { ...n, start: +(s - from).toFixed(4), duration: +(e - s).toFixed(4) };
    })
    .filter(n => n.duration > 0.02)
    .sort((a, b) => a.start - b.start);

  log(`project    : ${path.basename(opts.file)} fragment[${fragIdx}] ${frag.name || ''}`);
  log(`window     : ${fromSec}s → ${toSec}s  (${(toSec - fromSec).toFixed(2)}s = ${(to - from).toFixed(2)} 拍 @${bpm}bpm)`);
  log(`notes      : ${notes.length} / ${allNotes.length}（全曲 ${(spanBeats * secPerBeat).toFixed(1)}s = ${spanBeats.toFixed(1)} 拍）`);
  log(`bpm        : ${bpm}`);
  log(`precision  : ${precision}`);
  log(`steps      : ${steps}  sampler=${opts.sampler || 'default'}  cfg=${Number.isFinite(opts.cfg) ? opts.cfg : 'default'}  rescale=${Number.isFinite(opts.cfgRescale) ? opts.cfgRescale : 'default'}  schedule=${opts.cfgSchedule || 'default'}  qdrift=${opts.qdrift === true}`);
  if (opts.dryRun) { log('\n[dry-run] 未执行推理'); return 0; }

  // WinML 的 EP 选择读的是 globalThis.__SXS_SETTINGS_SNAPSHOT__（应用里由 svsWorker 注入）。
  // CLI 没有 worker，必须自己注入，否则 isWinmlEnabled() 看不到 winmlEnabled=true，
  // 会静默退化成 DML——那样跑出来的就不是 WinML-TRT-RTX 的数字了。
  globalThis.__SXS_SETTINGS_SNAPSHOT__ = { ...settings };
  if (opts.winmlEp) {
    globalThis.__SXS_SETTINGS_SNAPSHOT__.winmlEnabled = true;
    globalThis.__SXS_SETTINGS_SNAPSHOT__.nativeInferenceBackend = 'winml';
    globalThis.__SXS_SETTINGS_SNAPSHOT__.winmlPreferredEp = opts.winmlEp;
  }
  log(`[ep] 请求: winmlEnabled=${settings.winmlEnabled === true} backend=${settings.nativeInferenceBackend || 'auto'} preferredEp=${opts.winmlEp || settings.winmlPreferredEp || '(智能) NV TRT-RTX 优先'}`);

  const pipeline = new OnnxSVSPipeline(modelDir, {
    deviceId: settings.preferredDeviceId ?? settings.deviceId ?? undefined,
    deviceMode: settings.deviceMode || 'smart',
    preferredDeviceType: settings.preferredDeviceType || undefined,
    modelDeviceMapping: settings.modelDeviceMapping || undefined,
    modelPrecision: precision,
    japaneseVocalization: settings.japaneseVocalization || 'hybrid',
    inferenceProvider: settings.inferenceProvider || 'ortnode',
  });

  try {
    const tInit = Date.now();
    await pipeline.init();
    let eps = pipeline.sessionEPs || {};
    log(`[ep] diffStep=${eps.diffStep || '?'}  vocoder=${eps.vocoder || '?'}`);

    const synthOpts = {
      nSteps: steps,
      refAudioWavBuffer,
      refF0Data,
      refMidiNotes,
      singerId: frag.singerId || null,
      onProgress: (p) => { if (p % 25 === 0) log(`[progress] ${p}%`); },
    };
    if (opts.sampler) synthOpts.sampler = opts.sampler;
    if (Number.isFinite(opts.cfg)) synthOpts.cfg = opts.cfg;
    if (Number.isFinite(opts.cfgRescale)) synthOpts.cfgRescale = opts.cfgRescale;
    if (opts.cfgSchedule) {
      synthOpts.cfgScheduleMode = opts.cfgSchedule;
      synthOpts.cfgStrengthStart = null;
      synthOpts.cfgScheduleKeyframes = null;
    }
    if (opts.qdrift) synthOpts.qdrift = true;
    if (Number.isInteger(opts.seed)) {
        synthOpts.seed = opts.seed;
        log(`seed       : ${opts.seed}（固定初始噪声，用于精度/EP 对比）`);
    }

    const tSynth = Date.now();
    const audio = await pipeline.synthesize(notes, bpm, synthOpts);
    const synthMs = Date.now() - tSynth;

    let peak = 0, sum = 0;
    for (let i = 0; i < audio.length; i++) {
      const v = Math.abs(audio[i]);
      if (v > peak) peak = v;
      sum += audio[i];
    }
    const durationSec = audio.length / SAMPLE_RATE;
    log(`\n[OK] ${synthMs}ms  samples=${audio.length}  ${durationSec.toFixed(3)}s @${SAMPLE_RATE}Hz  peak=${peak.toFixed(4)}  mean=${(sum / audio.length).toFixed(6)}`);
    eps = pipeline.sessionEPs || {};
    log(`[ep] 实际使用: diffStep=${eps.diffStep || '?'}  vocoder=${eps.vocoder || '?'}`);

    if (opts.out) {
      const { encodeWav } = require('../audio/wavEncoder');
      const wavBuf = encodeWav(audio, SAMPLE_RATE);
      fs.mkdirSync(path.dirname(opts.out), { recursive: true });
      fs.writeFileSync(opts.out, wavBuf);
      log(`WAV written: ${opts.out} (${fmtBytes(wavBuf.length)})`);
    }
    if (opts.outF32) {
      // 测量链路必须用 float32：16bit 量化本底在 8-12kHz 就有 ~1-2 dB 的谱差异量级，
      // 会把「FP16 相对 FP32」这种本来就小的差异淹掉。给人听的成品仍用 16bit。
      fs.mkdirSync(path.dirname(opts.outF32), { recursive: true });
      fs.writeFileSync(opts.outF32, encodeWavF32(audio, SAMPLE_RATE));
      log(`WAV(f32) written: ${opts.outF32}`);
    }

    try { pipeline.dispose(); } catch (_) {}
    return 0;
  } catch (e) {
    logErr(`[FAIL] synth-project failed: ${e.stack || e.message}`);
    try { pipeline.dispose(); } catch (_) {}
    return 1;
  }
}

/** 32-bit float WAV 编码（测量用，避免 16bit 量化本底污染谱域对比） */
function encodeWavF32(samples, sampleRate) {
  const n = samples.length;
  const dataBytes = n * 4;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataBytes, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(3, 20);              // WAVE_FORMAT_IEEE_FLOAT
  buf.writeUInt16LE(1, 22);              // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(32, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < n; i++) buf.writeFloatLE(samples[i], 44 + i * 4);
  return buf;
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
    if (a === '--out-f32') { opts.outF32 = rest[++i]; continue; }
    if (a === '--steps') { opts.steps = parseInt(rest[++i], 10); continue; }
    if (a === '--bpm') { opts.bpm = parseInt(rest[++i], 10); continue; }
    // ---- synth-project: 用真实工程做精度/EP 对比 ----
    if (a === '--file') { opts.file = rest[++i]; continue; }
    if (a === '--fragment') { opts.fragment = parseInt(rest[++i], 10); continue; }
    if (a === '--from') { opts.from = parseFloat(rest[++i]); continue; }
    if (a === '--to') { opts.to = parseFloat(rest[++i]); continue; }
    if (a === '--duration') { opts.duration = parseFloat(rest[++i]); continue; }
    if (a === '--singer') { opts.singer = rest[++i]; continue; }
    if (a === '--precision') { opts.precision = rest[++i]; continue; }
    if (a === '--sampler') { opts.sampler = rest[++i]; continue; }
    if (a === '--cfg') { opts.cfg = parseFloat(rest[++i]); continue; }
    if (a === '--cfg-rescale') { opts.cfgRescale = parseFloat(rest[++i]); continue; }
    if (a === '--cfg-schedule') { opts.cfgSchedule = rest[++i]; continue; }
    if (a === '--qdrift') { opts.qdrift = true; continue; }
    if (a === '--seed') { opts.seed = parseInt(rest[++i], 10); continue; }
    if (a === '--winml-ep') { opts.winmlEp = rest[++i]; continue; }
    if (a === '--dry-run') { opts.dryRun = true; continue; }
    if (a === '--language') { opts.language = rest[++i]; continue; }
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
      case 'winml': return await cmdWinml();
      case 'models': return cmdModels();
      case 'settings': return cmdSettings();
      case 'init-pipeline': return await cmdInitPipeline();
      case 'synth': return await cmdSynth(opts);
      case 'synth-project': return await cmdSynthProject(opts);
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
