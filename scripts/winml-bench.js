'use strict';
/**
 * WinML vendor-EP benchmark — compares the current DirectML path against
 * Windows ML plugin EPs (TensorRT-RTX / OpenVINO GPU / NPU) for the main
 * SVS models.
 *
 * Usage:
 *   node scripts/winml-bench.js                     # diff_step + vocoder, len=512
 *   node scripts/winml-bench.js <model.onnx> 512    # single model override
 *
 * Requires: settings.winmlEnabled=true OR SXS_WINML_BENCH=1 (bypasses the
 * opt-in gate), Windows 11 24H2+, and a compatible device. First run downloads
 * EP packages via ExecutionProviderCatalog (can take minutes).
 */

'use strict';

process.env.SXS_WINML_BENCH = process.env.SXS_WINML_BENCH || '1';
if (process.env.SXS_WINML_BENCH === '1') {
    // Bypass the settings gate for benchmarking without touching user config.
    const settingsPath = require.resolve('../src/main/settings.js');
    require.cache[settingsPath] = {
        id: settingsPath,
        filename: settingsPath,
        loaded: true,
        exports: { loadSettings: () => ({ winmlEnabled: true }) },
    };
}

const fs = require('node:fs');
const path = require('node:path');

require('../src/inference/pipeline/float16Patch.js');
const ort = require('onnxruntime-node');
const ortBridge = require('../src/inference/winml/ortBridge');
const catalog = require('../src/inference/winml/winmlCatalog');

const MODELS_DIR = path.join(__dirname, '..', 'onnx_models');

function dimsOf(shape, frames) {
    return shape.map((d) => (Number.isInteger(d) && d > 0 ? d : frames));
}

function makeFeeds(inputMetadata, frames) {
    const feeds = {};
    for (const m of inputMetadata) {
        if (!m.isTensor) continue;
        const dims = dimsOf(m.shape, frames);
        let n = dims.reduce((a, b) => a * b, 1);
        let data;
        switch (m.type) {
            case 'float16': { data = new Uint16Array(n).fill(0x3800); break; }
            case 'float32': { data = new Float32Array(n); for (let i = 0; i < n; i++) data[i] = (i % 97) / 97 - 0.5; break; }
            case 'int64': { data = new BigInt64Array(n); break; }
            case 'int32': { data = new Int32Array(n); break; }
            default: throw new Error(`unsupported feed type ${m.type}`);
        }
        feeds[m.name] = new ort.Tensor(m.type, data, dims);
    }
    return feeds;
}

async function benchStock(modelPath, frames, label, eps) {
    try {
        const t0 = Date.now();
        const session = await ort.InferenceSession.create(modelPath, {
            executionProviders: eps,
            graphOptimizationLevel: 'all',
        });
        const createMs = Date.now() - t0;
        const feeds = makeFeeds(session.inputMetadata, frames);
        await session.run(feeds);
        const runs = [];
        for (let i = 0; i < 5; i++) {
            const t = Date.now();
            await session.run(feeds);
            runs.push(Date.now() - t);
        }
        runs.sort((a, b) => a - b);
        console.log(`${label}: create=${createMs}ms p50=${runs[2]}ms runs=[${runs.join(',')}]`);
        return runs[2];
    } catch (e) {
        console.log(`${label}: FAILED ${(e.message || '').split('\n')[0].slice(0, 100)}`);
        return null;
    }
}

async function main() {
    const targets = process.argv.slice(2);
    const models = targets.length && fs.existsSync(targets[0])
        ? [{ name: path.basename(targets[0]), path: targets[0], frames: parseInt(targets[1] || '512', 10) }]
        : [
            { name: 'diff_step fp16', path: path.join(MODELS_DIR, 'fp16', 'diff_step_dml.onnx'), frames: 512 },
            { name: 'vocoder fp16', path: path.join(MODELS_DIR, 'fp16', 'vocoder_dml.onnx'), frames: 512 },
        ];

    console.log('=== WinML EP availability ===');
    await ortBridge.ensureBridgeInit();
    await catalog.ensureCatalog();
    for (const p of await catalog.listCompatibleProviders()) {
        const r = await catalog.ensureProviderReady(p.name, (f) => process.stdout.write(`\r  ${p.name}: ${Math.round(f * 100)}%   `));
        process.stdout.write('\n');
        if (r.ok && r.libraryPath) {
            try { ortBridge.registerEp(p.name, r.libraryPath); } catch (_) {}
        }
    }
    for (const d of ortBridge.listDevices()) {
        console.log(`  [${d.index}] ${d.epName} (${d.deviceType}, ${d.vendor})`);
    }

    for (const m of models) {
        if (!fs.existsSync(m.path)) { console.log(`skip ${m.name}: model not found`); continue; }
        console.log(`\n=== ${m.name} @ seq=${m.frames} ===`);
        await benchStock(m.path, m.frames, 'dml     ', [{ name: 'dml', deviceId: 0 }, 'cpu']);
        // WinML chain: every registered gpu/npu candidate
        const devices = ortBridge.listDevices();
        const candidates = [];
        const trt = devices.filter((d) => d.epName === 'NvTensorRTRTXExecutionProvider').map((d) => d.index);
        if (trt.length) candidates.push(['trt-rtx ', trt]);
        const ovGpu = devices.filter((d) => d.epName === 'OpenVINOExecutionProvider' && d.deviceType === 'gpu').map((d) => d.index);
        if (ovGpu.length) candidates.push(['ov-gpu  ', ovGpu]);
        const npu = devices.filter((d) => d.epName === 'OpenVINOExecutionProvider' && d.deviceType === 'npu').map((d) => d.index);
        if (npu.length) candidates.push(['ov-npu  ', npu]);
        for (const [label, idx] of candidates) {
            try {
                const t0 = Date.now();
                const s = await ortBridge.createSessionWithEps(m.path, idx);
                const createMs = Date.now() - t0;
                const feeds = makeFeeds(s.inputMetadata, m.frames);
                await s.run(feeds);
                const runs = [];
                for (let i = 0; i < 5; i++) {
                    const t = Date.now();
                    await s.run(feeds);
                    runs.push(Date.now() - t);
                }
                runs.sort((a, b) => a - b);
                console.log(`${label}: create=${createMs}ms p50=${runs[2]}ms runs=[${runs.join(',')}]`);
                s.release();
            } catch (e) {
                console.log(`${label}: FAILED ${(e.message || '').split('\n')[0].slice(0, 100)}`);
            }
        }
    }
    ortBridge.disposeAllSessions();
}

main().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
