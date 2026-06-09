const path = require('node:path');
const fs = require('node:fs');

// Side effect: apply float16 patch on module load
require('./float16Patch');

const { SAMPLE_RATE, HOP_SIZE, MEL_DIM, EMBED_DIM, COND_DIM, ONNX_MODEL_FILES, CFG_STRENGTH, CFG_RESCALE, DEFAULT_DIFF_STEPS, SEGMENT_OVERLAP_SEC } = require('./constants');
const { getMainWindowWebContents, classifyDevice, isDiscreteGPUByName, enumerateDMLDevices, detectBestGPU, detectBestDevice, selectBestDevice, buildModelDeviceMapping, createSessionWithValidation, WebNNSessionProxy } = require('./modelLoader');
const { TextProcessing } = require('./textProcessing');
const { Preprocessing } = require('./preprocessing');
const { Diffusion } = require('./diffusion');
const { Postprocessing, parseWavBuffer, resampleLinear, extractMelSpectrogram } = require('./postprocessing');
const { AudioSegmentation } = require('./audioSegmentation');
const { createFloatTensor, outputToFloat32 } = require('./utils');

class OnnxSVSPipeline {
    constructor(modelDir, options = {}) {
        this.modelDir = this._resolveModelDir(modelDir, options.modelPrecision);
        this.sessions = {};
        this.sessionEPs = {};
        this.isFP16 = false; // 是否为 FP16 精度Model
        this.gpuDeviceName = '';
        this.dmlDeviceId = undefined;
        this.initialized = false;
        this.userDeviceId = options.deviceId;
        this.preferredDeviceType = options.preferredDeviceType || null;
        this.useWebNN = false;
        this._synthCache = null;
        this._initPromise = null;

        // Initialize sub-modules
        this._textProcessing = new TextProcessing();
        this.phone2idx = this._textProcessing.phone2idx;
        this.enG2pDict = this._textProcessing.enG2pDict;
        this._preprocessing = new Preprocessing(this._textProcessing);
        this._diffusion = new Diffusion();
        this._postprocessing = new Postprocessing();
        this._audioSegmentation = new AudioSegmentation();
    }

    _resolveModelDir(baseDir, modelPrecision) {
        const resolved = path.resolve(baseDir);
        const subdirMap = {
            'int8': 'int8',
            'fp16': 'fp16',
            'int8-npu': path.join('int8', 'optimized_npu'),
        };
        const subdir = subdirMap[modelPrecision];
        if (subdir) {
            const subDir = path.join(resolved, subdir);
            if (fs.existsSync(subDir)) {
                console.log(`[OnnxSVSPipeline] Using ${modelPrecision} Model directory: ${subDir}`);
                return subDir;
            }
            console.warn(`[OnnxSVSPipeline] ${modelPrecision} directory not found: ${subDir}, falling back to default directory`);
        }
        return resolved;
    }

    // Delegate text processing methods
    _englishG2p(word) { return this._textProcessing._englishG2p(word); }
    _lookupPhonemeId(lyric) { return this._textProcessing._lookupPhonemeId(lyric); }
    _charToZhPhoneme(input) { return this._textProcessing._charToZhPhoneme(input); }
    resolveLyricToPhonemes(lyric) { return this._textProcessing.resolveLyricToPhonemes(lyric); }

    // Delegate preprocessing methods
    midiToFreq(pitch) { return this._preprocessing.midiToFreq(pitch); }
    interpolateEnvelope(envelope, beatTime) { return this._preprocessing.interpolateEnvelope(envelope, beatTime); }
    buildF0FrameSequence(notes, bpm, f0Envelope, pitchCurveF0) { return this._preprocessing.buildF0FrameSequence(notes, bpm, f0Envelope, pitchCurveF0); }
    quantizeF0(f0Frames, f0Shift) { return this._preprocessing.quantizeF0(f0Frames, f0Shift); }
    notesToSequences(notes, bpm, f0Envelope, pitchCurveF0, f0Shift) { return this._preprocessing.notesToSequences(notes, bpm, f0Envelope, pitchCurveF0, f0Shift); }
    _buildMel2token(phLocations, tokenCount, totalFrames) { return this._preprocessing._buildMel2token(phLocations, tokenCount, totalFrames); }

    // Delegate diffusion methods
    randomNoise(frameLen, melDim) { return this._diffusion.randomNoise(frameLen, melDim); }

    // Delegate postprocessing methods
    _extractRefMel(refAudioWavBuffer) { return this._postprocessing.extractRefMel(refAudioWavBuffer); }
    _extractRefF0FromWav(wavBuffer) { return this._postprocessing.extractRefF0FromWav(wavBuffer); }
    _extractRefNotePitches(wavBuffer) { return this._postprocessing.extractRefNotePitches(wavBuffer); }

    // Delegate audio segmentation methods
    _fillNoteGaps(notes) { return this._audioSegmentation.fillNoteGaps(notes); }
    _buildVocalSegments(notes, bpm) { return this._audioSegmentation.buildVocalSegments(notes, bpm); }
    _hashArray(arr) { return this._audioSegmentation.hashArray(arr); }
    _computeSynthCacheKey(notes, bpm, options) { return this._audioSegmentation.computeSynthCacheKey(notes, bpm, options, this.interpolateEnvelope.bind(this)); }
    _median(arr) { return this._audioSegmentation.median(arr); }
    clearSynthCache() { this._synthCache = null; }

    async init() {
        if (this.initialized) return true;

        if (this._initPromise) {
            return this._initPromise;
        }

        this._initPromise = this._doInit();
        try {
            return await this._initPromise;
        } finally {
            this._initPromise = null;
        }
    }

    async _doInit() {
        console.log('[OnnxSVSPipeline] Initializing (ONNX Runtime + DirectML)...');
        console.log('[OnnxSVSPipeline] Model directory:', this.modelDir);

        let gpuInfo;
        try {
            console.log('[OnnxSVSPipeline] Detecting GPU...');
            gpuInfo = await detectBestGPU(this.modelDir);
            console.log('[OnnxSVSPipeline] GPU detection done');
        } catch (e) {
            console.error('[OnnxSVSPipeline] GPU detection failed:', e.message);
            gpuInfo = { deviceId: undefined, name: '', devices: [] };
        }
        this.allDevices = gpuInfo.devices || [];

        // 检查是否选择 NPU (WebNN)
        const isNpuRequested = this.preferredDeviceType === 'npu' || this.userDeviceId === 'npu';
        if (isNpuRequested) {
            try {
                const { detectNPUAvailability } = require('../../main/webnnIpc');
                const npuResult = await detectNPUAvailability();
                if (npuResult.npuAvailable) {
                    this.useWebNN = true;
                    this.gpuDeviceName = 'NPU (WebNN)';
                    console.log('[OnnxSVSPipeline] NPU available, using WebNN inference engine');
                } else {
                    console.warn(`[OnnxSVSPipeline] NPU not available (${npuResult.details}), falling back to DML/CPU`);
                }
            } catch (e) {
                console.warn('[OnnxSVSPipeline] NPU detection failed, falling back to DML/CPU:', e.message);
            }
        }

        if (!this.useWebNN) {
            if (this.userDeviceId !== undefined && this.userDeviceId !== null) {
                this.dmlDeviceId = this.userDeviceId;
                const selectedDevice = this.allDevices.find(d => d.dxgiAdapterNumber === this.userDeviceId);
                this.gpuDeviceName = selectedDevice ? `${selectedDevice.name}${selectedDevice.vram ? ` (${selectedDevice.vram})` : ''}` : `deviceId=${this.userDeviceId}`;
                console.log(`[OnnxSVSPipeline] Using user-specified device: ${this.gpuDeviceName} (deviceId=${this.dmlDeviceId})`);
            } else {
                this.dmlDeviceId = gpuInfo.deviceId;
                this.gpuDeviceName = gpuInfo.name || '无 GPU (仅 CPU)';
                console.log(`[OnnxSVSPipeline] GPU device (auto): ${this.gpuDeviceName}${this.dmlDeviceId !== undefined ? ` (deviceId=${this.dmlDeviceId})` : ''}`);
            }
        }

        const resolvedModelFiles = [...ONNX_MODEL_FILES];
        const dmlIdx = resolvedModelFiles.indexOf('diff_step_dml.onnx');
        if (dmlIdx >= 0) {
            const dmlPath = path.join(this.modelDir, 'diff_step_dml.onnx');
            let dmlExists = false;
            try { await fs.promises.access(dmlPath); dmlExists = true; } catch (_) {}
            if (!dmlExists) {
                resolvedModelFiles[dmlIdx] = 'diff_step.onnx';
                console.log('[OnnxSVSPipeline] diff_step_dml.onnx not found, using diff_step.onnx');
            }
        }
        const vocDmlIdx = resolvedModelFiles.indexOf('vocoder_dml.onnx');
        if (vocDmlIdx >= 0) {
            const vocDmlPath = path.join(this.modelDir, 'vocoder_dml.onnx');
            let vocDmlExists = false;
            try { await fs.promises.access(vocDmlPath); vocDmlExists = true; } catch (_) {}
            if (!vocDmlExists) {
                resolvedModelFiles[vocDmlIdx] = 'vocoder.onnx';
                console.log('[OnnxSVSPipeline] vocoder_dml.onnx not found, using vocoder.onnx');
            }
        }

        for (const modelFile of resolvedModelFiles) {
            const filePath = path.join(this.modelDir, modelFile);
            let stats;
            try {
                stats = await fs.promises.stat(filePath);
            } catch (_) {
                throw new Error(`Model文件不存在: ${filePath}`);
            }
            console.log(`[OnnxSVSPipeline] ${modelFile}: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
        }

        const sessionKeys = [
            'noteTextEncoder',
            'notePitchEncoder',
            'noteTypeEncoder',
            'f0Encoder',
            'preflow',
            'condEmb',
            'diffStep',
            'vocoder',
            'melTransform',
        ];

        // 检测Model精度：通过检查第一个浮点输入Model的输入类型
        try {
            const probeModelPath = path.join(this.modelDir, resolvedModelFiles[4]); // preflow
            const probeSession = await require('onnxruntime-node').InferenceSession.create(probeModelPath, { executionProviders: ['cpu'] });
            const probeInputType = probeSession.inputMetadata[0]?.type;
            this.isFP16 = probeInputType === 'float16';
            await probeSession.release();
            console.log(`[OnnxSVSPipeline] Model precision: ${this.isFP16 ? 'FP16 (half precision)' : 'FP32 (full precision)'}`);
        } catch (e) {
            console.warn('[OnnxSVSPipeline] Precision detection failed, defaulting to FP32:', e.message);
            this.isFP16 = false;
        }

        if (this.useWebNN) {
            // WebNN Model加载：Using非 DML Model文件，通过 IPC 加载到渲染进程
            const { ipcMain } = require('electron');

            const webnnModelFiles = [...resolvedModelFiles];
            const loadedSessions = [];

            // Helper: load a single model via WebNN IPC
            const loadOneWebnnModel = (modelFile, modelId) => new Promise((resolve, reject) => {
                const wc = getMainWindowWebContents();
                if (!wc) { resolve({ success: false, error: 'No renderer window' }); return; }

                const requestId = `svs-webnn-load-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                const timeout = setTimeout(() => resolve({ success: false, error: 'Load timeout' }), 180000);

                ipcMain.handleOnce(`webnn:loadModel:response:${requestId}`, (_, res) => {
                    clearTimeout(timeout);
                    resolve(res);
                });

                wc.send('webnn:loadModel:request', {
                    requestId,
                    modelId,
                    modelPath: path.join(this.modelDir, modelFile),
                    options: { deviceType: 'npu' },
                });
            });

            // Helper: unload a WebNN model
            const unloadWebnnModel = (modelId) => {
                try {
                    const wc = getMainWindowWebContents();
                    if (wc) {
                        const reqId = `svs-webnn-unload-${Date.now()}`;
                        ipcMain.handleOnce(`webnn:unloadModel:response:${reqId}`, () => {});
                        wc.send('webnn:unloadModel:request', { requestId: reqId, modelId });
                    }
                } catch (_) {}
            };

            try {
                // Probe: load the first model to verify NPU actually works
                const probeFile = webnnModelFiles[0];
                const probeKey = sessionKeys[0];
                console.log(`[OnnxSVSPipeline] WebNN probe: loading ${probeFile}...`);
                const probeResult = await loadOneWebnnModel(probeFile, probeKey);

                if (!probeResult.success) {
                    throw new Error(`WebNN 探测失败: ${probeResult.error}`);
                }

                // Check if NPU was actually used (not silently fallen back to GPU/WASM)
                const probeEp = probeResult.ep || '';
                if (!probeEp.includes('npu')) {
                    // Model loaded but not on NPU — clean up and fall back to DML
                    unloadWebnnModel(probeKey);
                    console.warn(`[OnnxSVSPipeline] WebNN probe: NPU not usable, actually using ${probeEp}, falling back to DML/CPU`);
                    // Cache the failure so next init skips NPU detection entirely
                    try {
                        const { markNPUUnavailable } = require('../../main/webnnIpc');
                        markNPUUnavailable(`WebNN probe: NPU not usable, fell back to ${probeEp}`);
                    } catch (_) {}
                    this.useWebNN = false;
                    return await this._doInitFallback(gpuInfo, resolvedModelFiles, sessionKeys);
                }

                // NPU confirmed working — load remaining models in parallel
                this.sessions[probeKey] = new WebNNSessionProxy(probeKey);
                this.sessionEPs[probeKey] = probeEp;
                loadedSessions.push(probeKey);
                console.log(`[OnnxSVSPipeline] ${probeFile} loaded via WebNN-NPU [${probeEp}]`);

                const remainingIndices = [];
                for (let i = 1; i < webnnModelFiles.length; i++) remainingIndices.push(i);

                // Load models sequentially to reduce peak WASM memory pressure
                const loadResults = [];
                for (const i of remainingIndices) {
                    const modelFile = webnnModelFiles[i];
                    const modelId = sessionKeys[i];
                    const result = await loadOneWebnnModel(modelFile, modelId);
                    loadResults.push({ i, modelFile, modelId, result });
                }

                for (const { i, modelFile, modelId, result } of loadResults) {
                    if (result.success) {
                        this.sessions[modelId] = new WebNNSessionProxy(modelId);
                        this.sessionEPs[modelId] = result.ep || 'webnn-npu';
                        loadedSessions.push(modelId);
                        console.log(`[OnnxSVSPipeline] ${modelFile} loaded via WebNN [${result.ep}]`);
                    } else {
                        throw new Error(`WebNN 加载 ${modelFile} 失败: ${result.error}`);
                    }
                }

                const webnnCount = Object.values(this.sessionEPs).filter(e => String(e).startsWith('webnn')).length;
                console.log(`[OnnxSVSPipeline] WebNN init complete: ${webnnCount}  model(s) using WebNN`);
            } catch (err) {
                console.error('[OnnxSVSPipeline] WebNN init failed:', err.message);
                // 卸载loaded的 WebNN Model
                for (const key of loadedSessions) {
                    unloadWebnnModel(key);
                    delete this.sessions[key];
                    delete this.sessionEPs[key];
                }
                this.useWebNN = false;
                // falling back to DML/CPU
                return await this._doInitFallback(gpuInfo, resolvedModelFiles, sessionKeys);
            }
        } else {
            // DML/CPU Model加载
            const loadedSessions = [];
            try {
                for (let i = 0; i < resolvedModelFiles.length; i++) {
                    const modelPath = path.join(this.modelDir, resolvedModelFiles[i]);
                    const { session, ep } = await createSessionWithValidation(modelPath, sessionKeys[i], this.gpuDeviceName, this.dmlDeviceId, this.isFP16);
                    this.sessions[sessionKeys[i]] = session;
                    this.sessionEPs[sessionKeys[i]] = ep;
                    loadedSessions.push(sessionKeys[i]);
                }

                const dmlCount = Object.values(this.sessionEPs).filter(e => e === 'dml').length;
                const cpuCount = Object.values(this.sessionEPs).filter(e => e === 'cpu').length;
                console.log(`[OnnxSVSPipeline] Init complete: ${dmlCount}  model(s) using DML, ${cpuCount}  model(s) using CPU`);
            } catch (err) {
                console.error('[OnnxSVSPipeline] ONNX Runtime init failed:', err.message);
                for (const key of loadedSessions) {
                    if (this.sessions[key] && typeof this.sessions[key].release === 'function') {
                        try { this.sessions[key].release(); } catch (_) {}
                    }
                    delete this.sessions[key];
                    delete this.sessionEPs[key];
                }
                throw err;
            }
        }

        this.initialized = true;
        return true;
    }

    /**
     * DML/CPU 回退初始化（当 WebNN 失败时调用）
     */
    async _doInitFallback(gpuInfo, resolvedModelFiles, sessionKeys) {
        if (this.userDeviceId !== undefined && this.userDeviceId !== null && this.userDeviceId !== 'npu') {
            this.dmlDeviceId = this.userDeviceId;
            const selectedDevice = this.allDevices.find(d => d.dxgiAdapterNumber === this.userDeviceId);
            this.gpuDeviceName = selectedDevice ? `${selectedDevice.name}${selectedDevice.vram ? ` (${selectedDevice.vram})` : ''}` : `deviceId=${this.userDeviceId}`;
        } else {
            this.dmlDeviceId = gpuInfo.deviceId;
            this.gpuDeviceName = gpuInfo.name || '无 GPU (仅 CPU)';
        }
        console.log(`[OnnxSVSPipeline] Fallback to device: ${this.gpuDeviceName}${this.dmlDeviceId !== undefined ? ` (deviceId=${this.dmlDeviceId})` : ''}`);

        const loadedSessions = [];
        try {
            for (let i = 0; i < resolvedModelFiles.length; i++) {
                const modelPath = path.join(this.modelDir, resolvedModelFiles[i]);
                const { session, ep } = await createSessionWithValidation(modelPath, sessionKeys[i], this.gpuDeviceName, this.dmlDeviceId, this.isFP16);
                this.sessions[sessionKeys[i]] = session;
                this.sessionEPs[sessionKeys[i]] = ep;
                loadedSessions.push(sessionKeys[i]);
            }
            const dmlCount = Object.values(this.sessionEPs).filter(e => e === 'dml').length;
            const cpuCount = Object.values(this.sessionEPs).filter(e => e === 'cpu').length;
            console.log(`[OnnxSVSPipeline] Fallback init complete: ${dmlCount}  model(s) using DML, ${cpuCount}  model(s) using CPU`);
        } catch (err) {
            for (const key of loadedSessions) {
                if (this.sessions[key] && typeof this.sessions[key].release === 'function') {
                    try { this.sessions[key].release(); } catch (_) {}
                }
                delete this.sessions[key];
                delete this.sessionEPs[key];
            }
            throw err;
        }
    }

    async _extractRefMelOnnx(refAudioWavBuffer) {
        return this._postprocessing.extractRefMelOnnx(this.sessions, refAudioWavBuffer, this.isFP16);
    }

    async _runEncoder(sequences, tokenCount, totalFrames, ptFrameCount = 0) {
        return this._preprocessing.runEncoder(this.sessions, sequences, tokenCount, totalFrames, this.isFP16, ptFrameCount);
    }

    async _runDiffStep(xtInputData, tVal, condData, maskData, totalFramesWithPrompt) {
        return this._diffusion.runDiffStep(this.sessions, xtInputData, tVal, condData, maskData, totalFramesWithPrompt, this.isFP16);
    }

    async _runVocoderChunked(melData, totalFrames) {
        return this._postprocessing.runVocoderChunked(this.sessions, melData, totalFrames, this.isFP16);
    }

    async _runDiffusionLoop(xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, onProgress, progressStart, progressRange) {
        return this._diffusion.runDiffusionLoop(this.sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, this.isFP16, onProgress, progressStart, progressRange);
    }

    async _synthesizeSegment(segmentNotes, bpm, f0Envelope, pitchCurveF0, f0Shift, ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale, npuDiffBatchSize, npuVocoderBatchSize, onProgress, progressStart, progressRange) {
        const sequences = this.notesToSequences(segmentNotes, bpm, f0Envelope, pitchCurveF0, f0Shift);
        const totalFrames = sequences.f0Ids.length;
        const tokenCount = sequences.tokenCount;

        if (totalFrames === 0) {
            return { audio: [], frames: 0 };
        }

        console.log(`[OnnxSVSPipeline] Segmented synthesis: frames=${totalFrames}, tokens=${tokenCount}, steps=${totalSteps}`);

        // WebNN: run entire pipeline in renderer to eliminate per-inference IPC overhead
        if (this.useWebNN) {
            onProgress(Math.round(progressStart));
            const t0 = performance.now();
            const result = await this._runWebNNSynthesis({
                sequences, tokenCount, totalFrames,
                ptMelData, ptFrameCount,
                totalSteps, cfgStrength, cfgRescale,
                npuDiffBatchSize, npuVocoderBatchSize,
            });
            const ms = performance.now() - t0;
            console.log(`[OnnxSVSPipeline] WebNN synthesis: ${totalFrames}frames, ${totalSteps}steps, ${ms.toFixed(0)}ms`);
            onProgress(Math.round(progressStart + progressRange));
            return { audio: result.audioData, frames: totalFrames };
        }

        const totalFramesWithPrompt = ptFrameCount + totalFrames;

        const combinedCond = await this._runEncoder(sequences, tokenCount, totalFrames, ptFrameCount);

        const xt = this.randomNoise(totalFrames, MEL_DIM);

        await this._runDiffusionLoop(xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, onProgress, progressStart, progressRange);

        const audioData = await this._runVocoderChunked(xt.data, totalFrames);

        return { audio: audioData, frames: totalFrames };
    }

    /**
     * 在渲染进程中运行完整合成管线（WebNN 优化路径）
     * 单次 IPC 调用，消除逐模型 IPC 开销
     */
    async _runWebNNSynthesis(params) {
        const { ipcMain } = require('electron');
        const wc = getMainWindowWebContents();
        if (!wc) throw new Error('No renderer window for WebNN synthesis');

        return new Promise((resolve, reject) => {
            const requestId = `svs-webnn-synth-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const timeout = setTimeout(() => reject(new Error('WebNN synthesis timeout')), 600000);

            ipcMain.handleOnce(`webnn:runSynthesis:response:${requestId}`, (_, result) => {
                clearTimeout(timeout);
                if (result.error) {
                    reject(new Error(result.error));
                } else {
                    resolve(result);
                }
            });

            wc.send('webnn:runSynthesis:request', {
                requestId,
                params: {
                    ...params,
                    isFP16: this.isFP16,
                },
            });
        });
    }

    /**
     * 批量合成两个片段（WebNN batch=4: 2 片段 × 2 CFG）
     */
    async _synthesizeSegmentPair(segANotes, segBNotes, bpm, f0Envelope, pitchCurveF0, f0Shift, ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale, npuDiffBatchSize, npuVocoderBatchSize, onProgress, progressStart, progressRange) {
        const seqA = this.notesToSequences(segANotes, bpm, f0Envelope, pitchCurveF0, f0Shift);
        const seqB = this.notesToSequences(segBNotes, bpm, f0Envelope, pitchCurveF0, f0Shift);

        const framesA = seqA.f0Ids.length;
        const framesB = seqB.f0Ids.length;

        if (framesA === 0 && framesB === 0) return [{ audio: [], frames: 0 }, { audio: [], frames: 0 }];
        if (framesA === 0) return [{ audio: [], frames: 0 }, await this._synthesizeSegment(segBNotes, bpm, f0Envelope, pitchCurveF0, f0Shift, ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale, npuDiffBatchSize, npuVocoderBatchSize, onProgress, progressStart, progressRange)];
        if (framesB === 0) return [await this._synthesizeSegment(segANotes, bpm, f0Envelope, pitchCurveF0, f0Shift, ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale, npuDiffBatchSize, npuVocoderBatchSize, onProgress, progressStart, progressRange), { audio: [], frames: 0 }];

        console.log(`[OnnxSVSPipeline] Batch synthesis: segA=${framesA}frames, segB=${framesB}frames`);

        onProgress(Math.round(progressStart));

        const t0 = performance.now();
        const results = await this._runWebNNSynthesisBatch([
            {
                sequences: seqA, tokenCount: seqA.tokenCount, totalFrames: framesA,
                ptMelData, ptFrameCount,
                totalSteps, cfgStrength, cfgRescale,
                npuDiffBatchSize, npuVocoderBatchSize,
            },
            {
                sequences: seqB, tokenCount: seqB.tokenCount, totalFrames: framesB,
                ptMelData, ptFrameCount,
                totalSteps, cfgStrength, cfgRescale,
                npuDiffBatchSize, npuVocoderBatchSize,
            },
        ]);
        const ms = performance.now() - t0;
        console.log(`[OnnxSVSPipeline] WebNN batch synthesis: ${framesA}+${framesB}frames, ${totalSteps}steps, ${ms.toFixed(0)}ms`);

        onProgress(Math.round(progressStart + progressRange));

        return results.map(r => ({ audio: r.audioData, frames: r.totalFrames }));
    }

    /**
     * 批量 WebNN 合成 IPC 调用
     */
    async _runWebNNSynthesisBatch(paramsArray) {
        const { ipcMain } = require('electron');
        const wc = getMainWindowWebContents();
        if (!wc) throw new Error('No renderer window for WebNN batch synthesis');

        return new Promise((resolve, reject) => {
            const requestId = `svs-webnn-batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const timeout = setTimeout(() => reject(new Error('WebNN batch synthesis timeout')), 600000);

            ipcMain.handleOnce(`webnn:runSynthesis:response:${requestId}`, (_, result) => {
                clearTimeout(timeout);
                if (result.error) {
                    reject(new Error(result.error));
                } else {
                    resolve(result);
                }
            });

            wc.send('webnn:runSynthesis:request', {
                requestId,
                params: paramsArray.map(p => ({ ...p, isFP16: this.isFP16 })),
            });
        });
    }

    async synthesize(notes, bpm, options = {}) {
        if (!this.initialized) {
            await this.init();
        }
        await this.ensureAllModelsLoaded();
        const onProgress = options.onProgress || (() => {});
        const f0Envelope = options.f0Envelope || null;
        const pitchCurveF0 = options.pitchCurveF0 || null;
        const refAudioWavBuffer = options.refAudioWavBuffer || null;
        const totalSteps = options.nSteps || DEFAULT_DIFF_STEPS;
        const cfgStrength = options.cfg || CFG_STRENGTH;
        const cfgRescale = options.cfgRescale !== undefined ? options.cfgRescale : CFG_RESCALE;
        const autoShift = options.autoShift || false;
        const pitchShift = options.pitchShift || 0;
        const npuDiffBatchSize = options.npuDiffBatchSize || 4;
        const npuVocoderBatchSize = options.npuVocoderBatchSize || 2;

        const filledNotes = this._fillNoteGaps(notes);

        const cacheKey = this._computeSynthCacheKey(notes, bpm, options);
        if (this._synthCache && this._synthCache.key === cacheKey) {
            onProgress(100);
            return this._synthCache.audio;
        }

        let currentProgress = 0;
        onProgress(currentProgress);

        let f0Shift = 0;
        if (autoShift && pitchShift === 0) {
            const targetF0 = this.buildF0FrameSequence(filledNotes, bpm, f0Envelope, pitchCurveF0);
            const targetNonZero = [];
            for (let i = 0; i < targetF0.length; i++) {
                if (targetF0[i] > 0) targetNonZero.push(targetF0[i]);
            }
            const targetNotePitches = [];
            for (const note of filledNotes) {
                if (note.pitch >= 1) targetNotePitches.push(note.pitch);
            }

            let refF0 = null;
            if (refAudioWavBuffer) {
                try {
                    refF0 = this._extractRefF0FromWav(refAudioWavBuffer);
                } catch (e) {
                    console.warn('[OnnxSVSPipeline] Reference audio F0 extraction failed:', e.message);
                }
            }

            if (refF0 && refF0.length > 0) {
                const refNonZero = [];
                for (let i = 0; i < refF0.length; i++) {
                    if (refF0[i] > 0) refNonZero.push(refF0[i]);
                }
                if (refNonZero.length > 0 && targetNonZero.length > 0) {
                    const refMedian = this._median(refNonZero);
                    const targetMedian = this._median(targetNonZero);
                    f0Shift = Math.round(Math.log2(refMedian / targetMedian) * 1200 / 100);
                } else if (targetNotePitches.length > 0) {
                    const refNotePitches = this._extractRefNotePitches(refAudioWavBuffer);
                    if (refNotePitches && refNotePitches.length > 0) {
                        const refMedianPitch = this._median(refNotePitches);
                        const targetMedianPitch = this._median(targetNotePitches);
                        f0Shift = Math.round(refMedianPitch - targetMedianPitch);
                    }
                }
            } else if (targetNotePitches.length > 0) {
                const refNotePitches = options.refNotePitches || null;
                if (refNotePitches && refNotePitches.length > 0) {
                    const refMedianPitch = this._median(refNotePitches);
                    const targetMedianPitch = this._median(targetNotePitches);
                    f0Shift = Math.round(refMedianPitch - targetMedianPitch);
                }
            }
        } else {
            f0Shift = pitchShift;
        }

        let ptMelData = null;
        let ptFrameCount = 0;

        if (refAudioWavBuffer) {
            try {
                const melResult = await this._extractRefMelOnnx(refAudioWavBuffer);
                ptMelData = melResult.data;
                ptFrameCount = melResult.frames;
                console.log(`[OnnxSVSPipeline] Reference audio mel: ${ptFrameCount}frames`);
            } catch (err) {
                try {
                    const melResult = this._extractRefMel(refAudioWavBuffer);
                    ptMelData = melResult.data;
                    ptFrameCount = melResult.frames;
                } catch (err2) {
                    // JS fallback also failed, use zero prompt
                }
            }
        }

        const segments = this._buildVocalSegments(filledNotes, bpm);

        if (segments.length === 1) {
            const seg = segments[0];
            const segNotes = seg.notes || filledNotes;
            const sequences = this.notesToSequences(segNotes, bpm, f0Envelope, pitchCurveF0, f0Shift);
            const totalFrames = sequences.f0Ids.length;

            if (totalFrames === 0) {
                return [];
            }

            if (!ptMelData || ptFrameCount === 0) {
                ptFrameCount = Math.min(50, Math.max(10, Math.floor(totalFrames * 0.1)));
                ptMelData = new Float32Array(ptFrameCount * MEL_DIM);
            }

            console.log(`[OnnxSVSPipeline] Synthesis params: frames=${totalFrames}, tokens=${sequences.tokenCount}, steps=${totalSteps}, cfg=${cfgStrength}, f0Shift=${f0Shift}`);

            currentProgress = 30;
            onProgress(currentProgress);

            const combinedCond = await this._runEncoder(sequences, sequences.tokenCount, totalFrames, ptFrameCount);
            const xt = this.randomNoise(totalFrames, MEL_DIM);

            await this._runDiffusionLoop(xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, onProgress, 40, 50);

            onProgress(90);
            const audioData = await this._runVocoderChunked(xt.data, totalFrames);

            const MAX_CACHE_SAMPLES = SAMPLE_RATE * 120; // 2 分钟
            if (audioData.length <= MAX_CACHE_SAMPLES) {
                this._synthCache = { key: cacheKey, audio: audioData };
                console.log('[OnnxSVSPipeline] Audio cached');
            } else {
                this._synthCache = null;
            }

            onProgress(100);
            return audioData;
        }

        if (!ptMelData || ptFrameCount === 0) {
            ptFrameCount = Math.min(50, 10);
            ptMelData = new Float32Array(ptFrameCount * MEL_DIM);
        }

        const totalBeats = filledNotes.length > 0
            ? Math.max(...filledNotes.map(n => n.start + n.duration))
            : 0;
        const totalSamples = Math.floor((totalBeats / bpm) * 60 * SAMPLE_RATE);
        const finalAudio = new Float32Array(totalSamples);
        const weightSum = new Float32Array(totalSamples);

        const overlapBeats = (SEGMENT_OVERLAP_SEC / 60) * bpm;
        const overlapSamples = Math.floor(SEGMENT_OVERLAP_SEC * SAMPLE_RATE);

        const fadeWindow = new Float32Array(overlapSamples);
        for (let i = 0; i < overlapSamples; i++) {
            fadeWindow[i] = 0.5 * (1 - Math.cos(Math.PI * i / overlapSamples));
        }

        const progressPerSegment = 80 / segments.length;

        // WebNN batch=4: pair segments for simultaneous processing
        const useBatch = this.useWebNN && npuDiffBatchSize >= 4 && segments.length > 1;
        let segIdx = 0;

        while (segIdx < segments.length) {
            if (useBatch && segIdx + 1 < segments.length) {
                // Pair two segments for batch=4 diffusion
                const segA = segments[segIdx];
                const segB = segments[segIdx + 1];
                const pairProgressStart = 10 + segIdx * progressPerSegment;
                const pairProgressRange = progressPerSegment * 2 * 0.9;

                onProgress(Math.round(pairProgressStart));

                const pairResult = await this._synthesizeSegmentPair(
                    segA.notes, segB.notes, bpm, f0Envelope, pitchCurveF0, f0Shift,
                    ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale,
                    npuDiffBatchSize, npuVocoderBatchSize,
                    onProgress, pairProgressStart, pairProgressRange
                );

                // Write both segments' audio to finalAudio
                for (let si = 0; si < 2; si++) {
                    const seg = segments[segIdx + si];
                    const segResult = pairResult[si];
                    if (segResult.audio.length === 0) continue;

                    const segStartSample = Math.floor((seg.startBeat / bpm) * 60 * SAMPLE_RATE);
                    const segAudio = segResult.audio;
                    const segSamples = segAudio.length;
                    const hasOverlap = (segIdx + si) > 0 && seg.startBeat < segments[segIdx + si - 1].endBeat;

                    for (let i = 0; i < segSamples; i++) {
                        const outIdx = segStartSample + i;
                        if (outIdx >= totalSamples) break;
                        let w = 1.0;
                        if (hasOverlap && i < overlapSamples) w = fadeWindow[i];
                        if (segIdx + si < segments.length - 1 && seg.endBeat > segments[segIdx + si + 1].startBeat) {
                            const remainingSamples = segSamples - i;
                            if (remainingSamples <= overlapSamples) {
                                w = Math.min(w, 1.0 - fadeWindow[overlapSamples - remainingSamples]);
                            }
                        }
                        finalAudio[outIdx] += segAudio[i] * w;
                        weightSum[outIdx] += w;
                    }
                }

                segIdx += 2;
                continue;
            }

            // Single segment (or last odd segment)
            const seg = segments[segIdx];
            const segProgressStart = 10 + segIdx * progressPerSegment;
            const segProgressRange = progressPerSegment * 0.9;
            const vocoderProgressStart = segProgressStart + segProgressRange;
            const vocoderProgressRange = progressPerSegment * 0.1;

            onProgress(Math.round(segProgressStart));

            const segResult = await this._synthesizeSegment(
                seg.notes, bpm, f0Envelope, pitchCurveF0, f0Shift,
                ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale,
                npuDiffBatchSize, npuVocoderBatchSize,
                onProgress, segProgressStart, segProgressRange
            );

            if (segResult.audio.length === 0) continue;

            const segStartSample = Math.floor((seg.startBeat / bpm) * 60 * SAMPLE_RATE);
            const segAudio = segResult.audio;
            const segSamples = segAudio.length;

            const hasOverlap = segIdx > 0 && seg.startBeat < segments[segIdx - 1].endBeat;

            for (let i = 0; i < segSamples; i++) {
                const outIdx = segStartSample + i;
                if (outIdx >= totalSamples) break;

                let w = 1.0;
                if (hasOverlap && i < overlapSamples) {
                    w = fadeWindow[i];
                }
                if (segIdx < segments.length - 1 && seg.endBeat > segments[segIdx + 1].startBeat) {
                    const remainingSamples = segSamples - i;
                    if (remainingSamples <= overlapSamples) {
                        w = Math.min(w, 1.0 - fadeWindow[overlapSamples - remainingSamples]);
                    }
                }

                finalAudio[outIdx] += segAudio[i] * w;
                weightSum[outIdx] += w;
            }

            onProgress(Math.round(vocoderProgressStart + vocoderProgressRange));
            segIdx++;
        }

        for (let i = 0; i < totalSamples; i++) {
            if (weightSum[i] > 1e-8) {
                finalAudio[i] /= weightSum[i];
            }
        }

        const audioData = finalAudio;
        const MAX_CACHE_SAMPLES = SAMPLE_RATE * 120;
        if (audioData.length <= MAX_CACHE_SAMPLES) {
            this._synthCache = { key: cacheKey, audio: audioData };
                console.log('[OnnxSVSPipeline] Audio cached');
        } else {
            this._synthCache = null;
        }

        onProgress(100);
        return audioData;
    }

    getHardwareInfo() {
        if (!this.initialized) {
            return null;
        }
        const dmlCount = Object.values(this.sessionEPs).filter(e => e === 'dml').length;
        const cpuCount = Object.values(this.sessionEPs).filter(e => e === 'cpu').length;
        const webnnCount = Object.values(this.sessionEPs).filter(e => String(e).startsWith('webnn')).length;
        const totalModels = Object.keys(this.sessionEPs).length;
        return {
            gpuDeviceName: this.gpuDeviceName || '无 GPU (仅 CPU)',
            dmlDeviceId: this.dmlDeviceId,
            dmlModelCount: dmlCount,
            cpuModelCount: cpuCount,
            webnnModelCount: webnnCount,
            totalModels,
            isUsingDML: dmlCount > 0,
            isUsingWebNN: webnnCount > 0,
        };
    }

    /**
     * 检查指定Model是否loaded
     */
    isModelLoaded(sessionKey) {
        return !!(this.sessions[sessionKey] && this.initialized);
    }

    /**
     * 获取所有Model的状态信息
     */
    getModelsStatus() {
        const sessionKeys = [
            'noteTextEncoder',
            'notePitchEncoder',
            'noteTypeEncoder',
            'f0Encoder',
            'preflow',
            'condEmb',
            'diffStep',
            'vocoder',
            'melTransform',
        ];
        return sessionKeys.map(key => ({
            sessionKey: key,
            loaded: !!(this.sessions[key]),
            ep: this.sessionEPs[key] || null,
        }));
    }

    /**
     * 卸载指定Model（释放其 ONNX 会话）
     */
    unloadModel(sessionKey) {
        if (!this.sessions[sessionKey]) {
            return { success: false, error: 'Model not loaded' };
        }
        try {
            if (typeof this.sessions[sessionKey].release === 'function') {
                this.sessions[sessionKey].release();
            }
            delete this.sessions[sessionKey];
            delete this.sessionEPs[sessionKey];
            console.log(`[OnnxSVSPipeline] Model ${sessionKey} unloaded`);
            return { success: true };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    /**
     * 加载指定Model
     */
    async loadModel(sessionKey) {
        if (this.sessions[sessionKey]) {
            return { success: true, alreadyLoaded: true };
        }

        const sessionKeyToModelFile = {
            noteTextEncoder: 'note_text_encoder.onnx',
            notePitchEncoder: 'note_pitch_encoder.onnx',
            noteTypeEncoder: 'note_type_encoder.onnx',
            f0Encoder: 'f0_encoder.onnx',
            preflow: 'preflow.onnx',
            condEmb: 'cond_emb.onnx',
            diffStep: 'diff_step_dml.onnx',
            vocoder: 'vocoder_dml.onnx',
            melTransform: 'mel_transform.onnx',
        };

        const modelFile = sessionKeyToModelFile[sessionKey];
        if (!modelFile) {
            return { success: false, error: `Unknown session key: ${sessionKey}` };
        }

        let resolvedFile = modelFile;
        if (modelFile === 'diff_step_dml.onnx') {
            const dmlPath = path.join(this.modelDir, 'diff_step_dml.onnx');
            let dmlExists = false;
            try { await fs.promises.access(dmlPath); dmlExists = true; } catch (_) {}
            if (!dmlExists) {
                resolvedFile = 'diff_step.onnx';
            }
        }
        if (modelFile === 'vocoder_dml.onnx') {
            const vocDmlPath = path.join(this.modelDir, 'vocoder_dml.onnx');
            let vocDmlExists = false;
            try { await fs.promises.access(vocDmlPath); vocDmlExists = true; } catch (_) {}
            if (!vocDmlExists) {
                resolvedFile = 'vocoder.onnx';
            }
        }

        const modelPath = path.join(this.modelDir, resolvedFile);
        try {
            await fs.promises.access(modelPath);
        } catch (_) {
            return { success: false, error: `Model file not found: ${resolvedFile}` };
        }

        try {
            const { session, ep } = await createSessionWithValidation(
                modelPath, sessionKey, this.gpuDeviceName, this.dmlDeviceId
            );
            this.sessions[sessionKey] = session;
            this.sessionEPs[sessionKey] = ep;
            console.log(`[OnnxSVSPipeline] Model ${sessionKey} loaded [${ep}]`);
            return { success: true, ep };
        } catch (err) {
            return { success: false, error: err.message };
        }
    }

    /**
     * 确保所有必需Modelloaded（合成前调用）
     */
    async ensureAllModelsLoaded() {
        const requiredKeys = [
            'noteTextEncoder', 'notePitchEncoder', 'noteTypeEncoder',
            'f0Encoder', 'preflow', 'condEmb', 'diffStep', 'vocoder', 'melTransform',
        ];
        const missing = requiredKeys.filter(key => !this.sessions[key]);
        if (missing.length === 0) return;

        console.log(`[OnnxSVSPipeline] Need to load ${missing.length} missing model(s): ${missing.join(', ')}`);
        for (const key of missing) {
            const result = await this.loadModel(key);
            if (!result.success) {
                throw new Error(`Failed to load required model ${key}: ${result.error}`);
            }
        }
    }

    dispose() {
        if (this.useWebNN) {
            // 通过 IPC 卸载渲染进程中的 WebNN Model
            try {
                const { ipcMain } = require('electron');
                const wc = getMainWindowWebContents();
                if (wc) {
                    for (const key of Object.keys(this.sessions)) {
                        const reqId = `svs-dispose-webnn-${Date.now()}-${key}`;
                        ipcMain.handleOnce(`webnn:unloadModel:response:${reqId}`, () => {});
                        wc.send('webnn:unloadModel:request', { requestId: reqId, modelId: key });
                    }
                }
            } catch (_) {}
        }
        for (const key of Object.keys(this.sessions)) {
            if (this.sessions[key] && typeof this.sessions[key].release === 'function') {
                try { this.sessions[key].release(); } catch (e) {
                    console.warn(`[OnnxSVSPipeline] Failed to release session (${key}):`, e.message);
                }
            }
        }
        this.sessions = {};
        this.sessionEPs = {};
        this.initialized = false;
        this.useWebNN = false;
        this._initPromise = null;
        this._synthCache = null;
        console.log('[OnnxSVSPipeline] ONNX Runtime sessions released');
    }
}

module.exports = { OnnxSVSPipeline, NativeSVSPipeline: OnnxSVSPipeline, SAMPLE_RATE, enumerateDMLDevices };
