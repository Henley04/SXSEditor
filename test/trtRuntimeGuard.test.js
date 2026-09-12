const { expect } = require('chai');

const { isTrtEngineFailure } = require('../src/inference/winml/ortBridge');
const winmlProvider = require('../src/inference/winml/winmlProvider');
const { Postprocessing, guardMelFinite } = require('../src/inference/pipeline/postprocessing');
const { Diffusion } = require('../src/inference/pipeline/diffusion');
const { MEL_DIM, HOP_SIZE, VOCODER_CHUNK_FRAMES, COND_DIM } = require('../src/inference/pipeline/constants');

/** 构造最小 16bit PCM 单声道 WAV Buffer。 */
function makeWav(samples, sampleRate = 24000) {
    const dataSize = samples.length * 2;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);   // PCM
    buf.writeUInt16LE(1, 22);   // mono
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < samples.length; i++) {
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]))), 44 + i * 2);
    }
    return buf;
}

function sineSamples(n, sampleRate) {
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 20000;
    return out;
}

describe('TRT-RTX 运行期故障守卫', () => {
    describe('ortBridge.isTrtEngineFailure', () => {
        it('识别 setInputShape 失败（mel_transform 真实报错）', () => {
            const msg = "Non-zero status code returned while running NvTensorRTRTXExecutionProvider_8323682756688077556_0 node. " +
                "Name:'NvTensorRTRTXExecutionProvider_NvTensorRTRTXExecutionProvider_8323682756688077556_0_0' " +
                "Status Message: NvTensorRTRTX EP failed to call nvinfer1::IExecutionContext::setInputShape() for input 'waveform'";
            expect(isTrtEngineFailure(msg)).to.equal(true);
            expect(isTrtEngineFailure(new Error(msg))).to.equal(true);
        });

        it('识别 execution context enqueue failed（vocoder 真实报错）', () => {
            const msg = "Non-zero status code returned while running NvTensorRTRTXExecutionProvider_18338873900416343650_0 node. " +
                "Status Message: NvTensorRTRTX EP execution context enqueue failed.";
            expect(isTrtEngineFailure(msg)).to.equal(true);
        });

        it('不吞掉其他错误（显存 OOM / DML device removed / 普通异常）', () => {
            expect(isTrtEngineFailure('Vocoder OOM on single-chunk inference: out of memory')).to.equal(false);
            expect(isTrtEngineFailure('DmlCommandRecorder Exception(1) 887a0006')).to.equal(false);
            expect(isTrtEngineFailure(new Error('boom'))).to.equal(false);
            expect(isTrtEngineFailure()).to.equal(false);
        });
    });

    describe('winmlProvider 运行期黑名单', () => {
        beforeEach(() => winmlProvider.__resetForTest());
        afterEach(() => winmlProvider.__resetForTest());

        it('报告失败后该模型被拉黑，reset 后恢复', () => {
            expect(winmlProvider.isRuntimeBlocked('C:/models/fp16/vocoder_dml.onnx')).to.equal(false);
            expect(winmlProvider.reportRuntimeFailure('C:/models/fp16/vocoder_dml.onnx', 'enqueue failed')).to.equal(true);
            expect(winmlProvider.isRuntimeBlocked('C:/models/fp16/vocoder_dml.onnx')).to.equal(true);
            // 不同路径、同名文件同样命中
            expect(winmlProvider.isRuntimeBlocked('vocoder_dml.onnx')).to.equal(true);
            winmlProvider.__resetForTest();
            expect(winmlProvider.isRuntimeBlocked('vocoder_dml.onnx')).to.equal(false);
        });

        it('非法路径不会误拉黑', () => {
            expect(winmlProvider.reportRuntimeFailure('', 'x')).to.equal(false);
            expect(winmlProvider.reportRuntimeFailure(null, 'x')).to.equal(false);
        });
    });

    describe('guardMelFinite', () => {
        it('干净的 mel 原样返回（不产生拷贝）', () => {
            const mel = new Float32Array(128).fill(0.25);
            expect(guardMelFinite(mel, 1, 'default')).to.equal(mel);
        });

        it('零星 NaN/Inf 就地补 0，且不污染原始数组', () => {
            const mel = new Float32Array(VOCODER_CHUNK_FRAMES * MEL_DIM);
            mel.fill(0.3);
            mel[10] = NaN;
            mel[20] = Infinity;
            const patched = guardMelFinite(mel, VOCODER_CHUNK_FRAMES, 'default');
            expect(Number.isNaN(mel[10])).to.equal(true);      // 上游 xt.data 不能被改写
            expect(Number.isFinite(patched[10])).to.equal(true);
            expect(patched[10]).to.equal(0);
            expect(patched[20]).to.equal(0);
        });

        it('整体损坏时抛出可读错误（不再掩盖成 enqueue failed）', () => {
            const mel = new Float32Array(450 * MEL_DIM).fill(NaN);
            expect(() => guardMelFinite(mel, 450, 'default')).to.throw(/non-finite/);
        });
    });

    describe('runVocoderChunked 对 NaN mel 的拦截', () => {
        function makeSessions() {
            const runCalls = [];
            return {
                runCalls,
                vocoder: {
                    async run(inputs) {
                        const vocSeqLen = inputs.mel.dims[1];
                        runCalls.push({ vocSeqLen });
                        const data = new Float32Array(vocSeqLen * HOP_SIZE);
                        data.fill(0.5);
                        return { waveform: { type: 'float32', data } };
                    },
                },
            };
        }

        it('扩散产出全 NaN 时在送进 GPU 前失败，vocoder 一次都不跑', async () => {
            const pp = new Postprocessing();
            const sessions = makeSessions();
            const frames = 450;
            const mel = new Float32Array(frames * MEL_DIM).fill(NaN);
            let threw = null;
            try {
                await pp.runVocoderChunked(sessions, mel, frames, false, false, 'default', null, false);
            } catch (e) { threw = e; }
            expect(threw).to.be.instanceOf(Error);
            expect(threw.message).to.match(/non-finite/);
            expect(sessions.runCalls).to.have.lengthOf(0);
        });

        it('零星 NaN 被修复后可正常合成（不误杀）', async () => {
            const pp = new Postprocessing();
            const sessions = makeSessions();
            const frames = VOCODER_CHUNK_FRAMES;
            const mel = new Float32Array(frames * MEL_DIM).fill(0.2);
            mel[7] = NaN;
            const out = await pp.runVocoderChunked(sessions, mel, frames, false, false, 'default', null, false);
            expect(sessions.runCalls).to.have.lengthOf(1);
            expect(out.length).to.equal(frames * HOP_SIZE);
            for (let i = 0; i < out.length; i += 1024) {
                expect(Number.isFinite(out[i])).to.equal(true);
            }
        });
    });

    describe('Diffusion 产出 NaN 时对 vendor-EP diff_step 的拉黑', () => {
        function makeDiffStep({ modelPath, provider, fill }) {
            return {
                provider,
                modelPath,
                inputNames: ['xt_input', 't', 'cond', 'xt_mask'],
                outputNames: ['flow_pred'],
                inputMetadata: [
                    { name: 'xt_input', type: 'float32', shape: [1, -1, MEL_DIM] },
                    { name: 't', type: 'float32', shape: [-1] },
                    { name: 'cond', type: 'float32', shape: [-1, -1, COND_DIM] },
                    { name: 'xt_mask', type: 'float32', shape: [-1, -1] },
                ],
                async run(inputs) {
                    const seqLen = inputs.xt_input.dims[1];
                    const data = new Float32Array(seqLen * MEL_DIM);
                    data.fill(fill === undefined ? 0.5 : fill);
                    return { flow_pred: { type: 'float32', data, dims: [1, seqLen, MEL_DIM], dispose() {} } };
                },
            };
        }

        async function runLoop(diffusion, diffStep) {
            const frames = 40;
            const ptFrames = 10;
            const xt = diffusion.randomNoise(frames, MEL_DIM);
            await diffusion.runDiffusionLoop(
                { diffStep }, xt, frames, new Float32Array(ptFrames * MEL_DIM).fill(0.1), ptFrames,
                new Float32Array((ptFrames + frames) * COND_DIM).fill(0.1), 2, 0, 0.6, false,
                () => {}, 0, 100, false, 'euler'
            );
            return xt;
        }

        beforeEach(() => winmlProvider.__resetForTest());
        afterEach(() => winmlProvider.__resetForTest());

        it('WinML diff_step 产出 NaN 后被拉黑，下次加载跳过 vendor EP', async () => {
            const diffusion = new Diffusion();
            const path = 'C:/models/fp16/diff_step_dml.onnx';
            const xt = await runLoop(diffusion, makeDiffStep({ modelPath: path, provider: 'windowsml', fill: NaN }));
            expect(Number.isNaN(xt.data[0])).to.equal(true);
            expect(winmlProvider.isRuntimeBlocked(path)).to.equal(true);
        });

        it('原生（非 vendor EP）会话不会被误拉黑', async () => {
            const diffusion = new Diffusion();
            const path = 'C:/models/fp16/diff_step_dml.onnx';
            const xt = await runLoop(diffusion, makeDiffStep({ modelPath: path, provider: undefined, fill: NaN }));
            expect(Number.isNaN(xt.data[0])).to.equal(true);
            expect(winmlProvider.isRuntimeBlocked(path)).to.equal(false);
        });

        it('输出正常时不会拉黑任何模型', async () => {
            const diffusion = new Diffusion();
            const path = 'C:/models/fp16/diff_step_dml.onnx';
            const xt = await runLoop(diffusion, makeDiffStep({ modelPath: path, provider: 'windowsml', fill: 0.5 }));
            expect(Number.isFinite(xt.data[0])).to.equal(true);
            expect(winmlProvider.isRuntimeBlocked(path)).to.equal(false);
        });
    });

    describe('Postprocessing.extractRefMelOnnx 形状与失败记忆', () => {
        function makeSession({ rank = 2, failOnce = false } = {}) {
            const calls = [];
            return {
                calls,
                inputNames: ['waveform'],
                outputNames: ['mel_spectrogram'],
                inputMetadata: [{
                    name: 'waveform',
                    type: 'float32',
                    shape: rank === 3 ? [1, 1, -1] : [1, -1],
                }],
                async run(feeds) {
                    calls.push(Array.from(feeds.waveform.dims));
                    if (failOnce) {
                        throw new Error(
                            "NvTensorRTRTX EP failed to call nvinfer1::IExecutionContext::setInputShape() for input 'waveform'");
                    }
                    const n = Math.max(1, Math.floor(feeds.waveform.dims[feeds.waveform.dims.length - 1] / HOP_SIZE));
                    const data = new Float32Array(n * MEL_DIM).fill(0.5);
                    return { mel_spectrogram: { type: 'float32', data, dims: [1, n, MEL_DIM] } };
                },
            };
        }

        it('按 session 元数据选择 2D/3D 输入形状', async () => {
            const pp = new Postprocessing();
            const wav = makeWav(sineSamples(4800));

            const s2d = makeSession({ rank: 2 });
            const r2 = await pp.extractRefMelOnnx({ melTransform: s2d }, wav, false, false);
            expect(s2d.calls[0]).to.deep.equal([1, 4800]);
            expect(r2.frames).to.be.greaterThan(0);

            const s3d = makeSession({ rank: 3 });
            await pp.extractRefMelOnnx({ melTransform: s3d }, wav, false, false);
            expect(s3d.calls[0]).to.deep.equal([1, 1, 4800]);
        });

        it('同一会话失败过一次后直接回落，不再重复跑 GPU', async () => {
            const pp = new Postprocessing();
            const wav = makeWav(sineSamples(4800));
            const session = makeSession({ failOnce: true });
            const sessions = { melTransform: session };

            await pp.extractRefMelOnnx(sessions, wav, false, false).then(
                () => { throw new Error('expected first call to reject'); },
                (err) => { expect(err.message).to.match(/setInputShape/); });

            await pp.extractRefMelOnnx(sessions, wav, false, false).then(
                () => { throw new Error('expected second call to reject'); },
                (err) => { expect(err.message).to.match(/JS fallback/); });

            // 第一次真实调用 + 后续全部短路：不应再有第二次 GPU run
            expect(session.calls).to.have.lengthOf(1);
        });
    });
});
