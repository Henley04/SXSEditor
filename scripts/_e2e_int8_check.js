/**
 * INT8 端到端推理自检（Node 直跑，不依赖 Electron 渲染进程）。
 *
 * 用法：
 *   node scripts/_e2e_int8_check.js [precision] [modelDir]
 * 例：
 *   node scripts/_e2e_int8_check.js int8
 *   node scripts/_e2e_int8_check.js fp16 onnx_models
 *
 * 检查项：
 *   1. init() 是否成功、实际加载的 diff_step 文件
 *   2. 三个精度标志 / EP 分配
 *   3. 合成 4 个音符，输出时长、RMS、峰值、NaN/Inf
 */
const path = require('node:path');
const { OnnxSVSPipeline, SAMPLE_RATE } = require('../src/inference/pipeline');

function stats(audio) {
    let peak = 0, sum = 0, nan = 0;
    for (let i = 0; i < audio.length; i++) {
        const v = audio[i];
        if (!Number.isFinite(v)) { nan++; continue; }
        const s = Math.abs(v);
        if (s > peak) peak = s;
        sum += v * v;
    }
    return {
        samples: audio.length,
        durationSec: +(audio.length / SAMPLE_RATE).toFixed(2),
        peak: +peak.toFixed(4),
        rms: +Math.sqrt(sum / Math.max(1, audio.length)).toFixed(5),
        nonFinite: nan,
    };
}

(async () => {
    const precision = process.argv[2] || 'int8';
    const modelDir = process.argv[3] || path.join(__dirname, '..', 'onnx_models');

    const p = new OnnxSVSPipeline(modelDir, {
        modelPrecision: precision,
        deviceId: 0,
        inferenceProvider: 'ortnode',
        onLoadProgress: (pct) => { if (pct % 25 === 0) console.log(`  [load ${pct}%]`); },
    });

    const t0 = Date.now();
    try {
        await p.init();
    } catch (e) {
        console.error('!! init FAILED:', e && e.message);
        process.exit(2);
    }
    console.log(`init OK in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log('modelDir       :', p.modelDir);
    console.log('diff_step file :', await p._resolveDiffStepFile().catch(() => '?'));
    console.log('vocoder file   :', p._resolvedVocoderFile || '?');
    console.log('flags          :', JSON.stringify({
        baseIsFP16: p.isFP16,
        diffStepIsFP16: p.diffStepIsFP16,
        diffStepIsQDIT: p.diffStepIsQDIT,
        legacyInt8Incompatible: p.diffStepLegacyInt8Incompatible,
        vocoderIsFP16: p.vocoderIsFP16,
        vocoderIsW16A32: p.vocoderIsW16A32,
        useStaticShapes: p.useStaticShapes,
        gpu: p.gpuDeviceName,
        eps: p.sessionEPs,
    }));

    // 4 个中文字符音符，120 BPM，各 1 拍
    const sylls = ['啊', '喔', '嗯', '呀'];
    const notes = sylls.map((lyric, i) => ({
        pitch: 60 + [0, 2, 4, 2][i],
        start: i, duration: 1, lyric, noteType: 'lyric',
    }));

    const t1 = Date.now();
    try {
        const audio = await p.synthesize(notes, 120, {});
        const s = stats(audio);
        console.log(`synthesize OK in ${((Date.now() - t1) / 1000).toFixed(1)}s`, JSON.stringify(s));
        if (s.nonFinite > 0 || s.peak === 0) {
            console.log('!! 输出异常（NaN 或全零）');
            process.exit(3);
        }
        console.log('RESULT: PASS');
    } catch (e) {
        console.error(`synthesize FAILED in ${((Date.now() - t1) / 1000).toFixed(1)}s:`, e && e.message);
        process.exit(4);
    }
})();
