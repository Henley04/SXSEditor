const { expect } = require('chai');
const { describe, it, beforeEach, afterEach } = require('mocha');
const sinon = require('sinon');
const path = require('node:path');

// ---------------------------------------------------------------------------
// Stub the native addon module BEFORE requiring anything that loads it.
// sxs-ort-bridge is a file: dependency; tests must never touch real native code.
const addonCalls = { run: [], created: [], released: [] };
let fakeSessionCounter = 1;
const fakeAddon = {
    init() { return { apiVersion: 27 }; },
    registerEp(name) { fakeAddon.registered = fakeAddon.registered || []; fakeAddon.registered.push(name); return true; },
    listDevices() { return fakeAddon.devices || []; },
    createSession(modelPath, indices, providerOptions) {
        addonCalls.created.push({ modelPath, indices, providerOptions });
        return BigInt(fakeSessionCounter++);
    },
    sessionInfo(id) {
        return {
            inputs: [
                { name: 'xt_input', type: 'float16', dims: [1, -1, 128] },
                { name: 't', type: 'float16', dims: [1] },
                { name: 'cond', type: 'float16', dims: [1, -1, 1024] },
                { name: 'xt_mask', type: 'float16', dims: [1, -1] },
            ],
            outputs: [{ name: 'flow_pred', type: 'float16', dims: [1, -1, 128] }],
        };
    },
    run(id, feeds) {
        addonCalls.run.push({ id: id.toString(), keys: Object.keys(feeds), feeds });
        const firstKey = Object.keys(feeds)[0];
        const d = feeds[firstKey];
        // echo back an fp16 buffer shaped like flow_pred
        const len = d.dims[1] * 128;
        return {
            flow_pred: { type: 'float16', data: new Uint16Array(len).buffer, dims: [1, d.dims[1], 128] },
        };
    },
    releaseSession(id) { addonCalls.released.push(id.toString()); },
    disposeAll() {},
};
const Module = require('module');
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
    if (id === 'sxs-ort-bridge') return fakeAddon;
    return origRequire.apply(this, arguments);
};
// loader 的显式 mock 注入口（loadAddon 优先读取）
globalThis.__SXS_ORT_BRIDGE_MOCK__ = fakeAddon;

const ortBridge = require('../src/inference/winml/ortBridge');

describe('winml ortBridge', () => {
    beforeEach(() => {
        addonCalls.run.length = 0;
        addonCalls.created.length = 0;
        addonCalls.released.length = 0;
    });

    afterEach(() => {
        sinon.restore();
    });

    describe('descriptor conversion (__test)', () => {
        it('round-trips float32 tensors', () => {
            const { _tensorFromDescriptor, _descriptorFromTensor } = ortBridge.__test;
            const src = new Float32Array([1.5, -2.25, 3.125]);
            const desc = _descriptorFromTensor({ type: 'float32', data: src, dims: [1, 3] });
            expect(desc.type).to.equal('float32');
            expect(Array.from(desc.dims)).to.deep.equal([1, 3]);
            expect(new Float32Array(desc.data)).to.deep.equal(src);
            const back = _tensorFromDescriptor(desc);
            expect(back.data).to.be.instanceOf(Float32Array);
            expect(Array.from(back.data)).to.deep.equal([1.5, -2.25, 3.125]);
        });

        it('treats float16 as raw Uint16Array bits (Node24-safe)', () => {
            const { _tensorFromDescriptor } = ortBridge.__test;
            const raw = new Uint16Array([0x3800, 0x0000]);
            const t = _tensorFromDescriptor({ type: 'float16', data: raw.buffer, dims: [2] });
            expect(t.data).to.be.instanceOf(Uint16Array);
            expect(Array.from(t.data)).to.deep.equal([0x3800, 0x0000]);
        });

        it('copies subarray views at correct byte offset', () => {
            const { _descriptorFromTensor } = ortBridge.__test;
            const bigBuf = new ArrayBuffer(64);
            const view = new Float32Array(bigBuf, 32, 4); // offset view
            view.set([9, 8, 7, 6]);
            const desc = _descriptorFromTensor({ type: 'float32', data: view, dims: [4] });
            expect(desc.data.byteLength).to.equal(16);
            expect(new Float32Array(desc.data)).to.deep.equal(new Float32Array([9, 8, 7, 6]));
        });

        it('reports float16 numeric corruption using decoded values', () => {
            const { _finiteStats, _fp16ToNumber, _fmtDims } = ortBridge.__test;
            expect(_fp16ToNumber(0x3c00)).to.equal(1);
            expect(_fp16ToNumber(0xc000)).to.equal(-2);
            expect(_fmtDims([1, 8, 128])).to.equal('[1x8x128]');
            const stats = _finiteStats(new Uint16Array([0x0000, 0x3c00, 0x7c00, 0x7e00]), 'float16');
            expect(stats).to.include('zero=1');
            expect(stats).to.include('nan=1');
            expect(stats).to.include('inf=1');
        });

        it('_tensorRtRtxOptions generates diff_step profile with env-overridable seq lens', () => {
            const { _tensorRtRtxOptions } = ortBridge.__test;
            const opts = _tensorRtRtxOptions('C:/models/diff_step_dml.onnx');
            expect(opts.nv_profile_min_shapes).to.equal('xt_input:1x1x128;t:1;cond:1x1x1024;xt_mask:1x1');
            expect(opts.nv_profile_opt_shapes).to.include('xt_input:1x1950x128');
            expect(opts.nv_profile_max_shapes).to.include('xt_input:1x4096x128');
        });

        it('_tensorRtRtxOptions generates preflow profile', () => {
            const { _tensorRtRtxOptions } = ortBridge.__test;
            const opts = _tensorRtRtxOptions('C:/models/preflow.onnx');
            expect(opts.nv_profile_min_shapes).to.equal('features:1x1x512');
            expect(opts.nv_profile_opt_shapes).to.include('features:1x1500x512');
            expect(opts.nv_profile_max_shapes).to.include('features:1x4096x512');
        });

        it('_tensorRtRtxOptions returns empty for non-TRT models', () => {
            const { _tensorRtRtxOptions } = ortBridge.__test;
            const opts = _tensorRtRtxOptions('C:/models/vocoder.onnx');
            expect(Object.keys(opts)).to.deep.equal([]);
        });

        it('_tensorRtRtxOptions respects SXS_TRTRTX_NO_PROFILE=1', () => {
            const { _tensorRtRtxOptions } = ortBridge.__test;
            const saved = process.env.SXS_TRTRTX_NO_PROFILE;
            process.env.SXS_TRTRTX_NO_PROFILE = '1';
            try {
                const opts = _tensorRtRtxOptions('C:/models/diff_step_dml.onnx');
                expect(opts.nv_profile_min_shapes).to.be.undefined;
                expect(opts.nv_profile_opt_shapes).to.be.undefined;
                expect(opts.nv_profile_max_shapes).to.be.undefined;
            } finally {
                if (saved === undefined) delete process.env.SXS_TRTRTX_NO_PROFILE;
                else process.env.SXS_TRTRTX_NO_PROFILE = saved;
            }
        });

        it('_tensorRtRtxOptions respects custom env seq lens', () => {
            const { _tensorRtRtxOptions } = ortBridge.__test;
            const savedOpt = process.env.SXS_TRTRTX_OPT_SEQ;
            const savedMax = process.env.SXS_TRTRTX_MAX_SEQ;
            process.env.SXS_TRTRTX_OPT_SEQ = '2048';
            process.env.SXS_TRTRTX_MAX_SEQ = '8192';
            try {
                const opts = _tensorRtRtxOptions('C:/models/diff_step_dml.onnx');
                expect(opts.nv_profile_opt_shapes).to.include('xt_input:1x2048x128');
                expect(opts.nv_profile_max_shapes).to.include('xt_input:1x8192x128');
            } finally {
                if (savedOpt === undefined) delete process.env.SXS_TRTRTX_OPT_SEQ;
                else process.env.SXS_TRTRTX_OPT_SEQ = savedOpt;
                if (savedMax === undefined) delete process.env.SXS_TRTRTX_MAX_SEQ;
                else process.env.SXS_TRTRTX_MAX_SEQ = savedMax;
            }
        });

        it('validateTRTOutput rejects all-zero output', () => {
            const { validateTRTOutput } = ortBridge.__test;
            const outputs = { flow_pred: { type: 'float32', data: new Float32Array(128), dims: [1, 1, 128] } };
            expect(() => validateTRTOutput(outputs)).to.throw('entirely zero');
        });

        it('validateTRTOutput rejects NaN output', () => {
            const { validateTRTOutput } = ortBridge.__test;
            const nan16 = 0x7e00;
            const outputs = { flow_pred: { type: 'float16', data: new Uint16Array([nan16, nan16, 0x3c00, 0x3c00]), dims: [1, 4] } };
            expect(() => validateTRTOutput(outputs)).to.throw('non-finite');
        });

        it('validateTRTOutput passes non-zero valid output', () => {
            const { validateTRTOutput } = ortBridge.__test;
            const data = new Float32Array(128);
            for (let i = 0; i < 128; i++) data[i] = 0.1 * (i + 1);
            const outputs = { flow_pred: { type: 'float32', data, dims: [1, 1, 128] } };
            expect(() => validateTRTOutput(outputs)).to.not.throw();
        });

        it('validateTRTOutput rejects numerically silent output (rms<1e-8)', () => {
            const { validateTRTOutput } = ortBridge.__test;
            const data = new Float32Array(128).fill(1e-10);
            const outputs = { flow_pred: { type: 'float32', data, dims: [1, 1, 128] } };
            expect(() => validateTRTOutput(outputs)).to.throw('numerically silent');
        });
    });

    describe('WinMLSession', () => {
        it('exposes ORT-compatible metadata from bridge sessionInfo', async () => {
            const session = await ortBridge.createSessionWithEps('C:/fake/model.onnx', [0]);
            expect(session.inputNames).to.deep.equal(['xt_input', 't', 'cond', 'xt_mask']);
            expect(session.outputNames).to.deep.equal(['flow_pred']);
            expect(session.inputMetadata[0]).to.deep.equal({
                name: 'xt_input', isTensor: true, type: 'float16', shape: [1, -1, 128],
            });
        });

        it('converts feeds to descriptors and outputs to typed tensors', async () => {
            const session = await ortBridge.createSessionWithEps('C:/fake/model.onnx', [0]);
            const feeds = {
                xt_input: { type: 'float16', data: new Uint16Array(3 * 128), dims: [1, 3, 128] },
                t: { type: 'float16', data: new Uint16Array(1), dims: [1] },
                cond: { type: 'float16', data: new Uint16Array(3 * 1024), dims: [1, 3, 1024] },
                xt_mask: { type: 'float16', data: new Uint16Array(3), dims: [1, 3] },
            };
            const out = await session.run(feeds);
            expect(addonCalls.run).to.have.lengthOf(1);
            expect(Object.keys(addonCalls.run[0].feeds)).to.deep.equal(Object.keys(feeds));
            expect(out.flow_pred).to.exist;
            expect(out.flow_pred.data).to.be.instanceOf(Uint16Array);
            expect(Array.from(out.flow_pred.dims)).to.deep.equal([1, 3, 128]);
            session.release();
            expect(addonCalls.released).to.have.lengthOf(1);
        });
    });
});

describe('winml provider gating', () => {
    let settingsStub;
    let provider;

    beforeEach(() => {
        provider = require('../src/inference/winml/winmlProvider');
        provider.__resetForTest();
        const settingsMod = require('../src/main/settings.js');
        settingsStub = sinon.stub(settingsMod, 'loadSettings').returns({ winmlEnabled: false });
    });

    afterEach(() => {
        settingsStub.restore();
        provider.__resetForTest();
    });

    it('isWinmlEnabled is false when the opt-in flag is absent', () => {
        expect(provider.isWinmlEnabled()).to.equal(false);
    });

    it('getWinmlCandidates returns empty when disabled', async () => {
        expect(await provider.getWinmlCandidates(false)).to.deep.equal([]);
    });

    it('tryCreateWinMLSession returns null when disabled (fallback path)', async () => {
        const res = await provider.tryCreateWinMLSession('C:/fake/diff_step_dml.onnx', false);
        expect(res).to.equal(null);
    });
});
