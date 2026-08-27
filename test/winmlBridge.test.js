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
    createSession(modelPath, indices) {
        addonCalls.created.push({ modelPath, indices });
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
