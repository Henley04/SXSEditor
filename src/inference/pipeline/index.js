const path = require('node:path');
const fs = require('node:fs');

// Side effect: apply float16 patch on module load
require('./float16Patch');

const { SAMPLE_RATE, HOP_SIZE, MEL_DIM, EMBED_DIM, COND_DIM, ONNX_MODEL_FILES, SIFIGAN_STATS_FILE, CFG_STRENGTH, CFG_RESCALE, DEFAULT_DIFF_STEPS, SEGMENT_OVERLAP_SEC, MAX_SAFE_FRAMES } = require('./constants');
const { getMainWindowWebContents, classifyDevice, isDiscreteGPUByName, enumerateDMLDevices, detectBestGPU, detectBestDevice, selectBestDevice, buildModelDeviceMapping, createSessionWithValidation, WebNNSessionProxy, DUMMY_TEST_INPUTS_FP32, DUMMY_TEST_INPUTS_FP16 } = require('./modelLoader');
const { TextProcessing } = require('./textProcessing');
const { Preprocessing } = require('./preprocessing');
const { Diffusion } = require('./diffusion');
const { Postprocessing, parseWavBuffer, resampleLinear, extractMelSpectrogram } = require('./postprocessing');
const { AudioSegmentation } = require('./audioSegmentation');
const { createFloatTensor, outputToFloat32, normalizePeakTo } = require('./utils');

// Module-level constants
// JP-specific models that must be swapped from the JP directory when
// language is 'ja'. cond_emb MUST be included because JP fine-tuning adapts
// it to the JP feature distribution — using the base cond_emb with JP
// preflow+embedding causes severe phoneme corruption.
// diff_step_dml MUST be included (v3+): JP fine-tuning injects LoRA into
// 22 DiffLlama attention layers; merged weights must swap for proper JP
// acoustic modeling. v1/v2 did not include this (DiffLlama was frozen).
// note_pitch_encoder is intentionally NOT included: pitch is a MIDI index
// with no language-specific semantic, so JP shares the base pitch encoder.
const JP_MODEL_FILES = new Set([
  'note_text_encoder.onnx',
  'preflow.onnx',
  'cond_emb.onnx',
  'diff_step_dml.onnx',
]);
const SMALL_MODEL_THRESHOLD = 50 * 1024 * 1024;
const PRECISION_SUBDIR_MAP = {
    'int8': 'int8',
    'fp16': 'fp16',
    'fp8': 'fp8',
    'int8-npu': path.join('int8', 'optimized_npu'),
};
const SESSION_KEYS = [
    'noteTextEncoder', 'notePitchEncoder', 'noteTypeEncoder',
    'f0Encoder', 'preflow', 'condEmb', 'diffStep', 'vocoder', 'melTransform',
];

class OnnxSVSPipeline {
    constructor(modelDir, options = {}) {
        this.baseModelDir = modelDir; // Base dir before precision subdir (for shared models)
        this.modelDir = this._resolveModelDir(modelDir, options.modelPrecision);
        this.languageOverride = options.languageOverride || null; // 'ja' for Japanese
        this.jpModelDir = this._resolveJpModelDir(modelDir, options.modelPrecision);
        this._hasJpModelsCached = this.jpModelDir
            ? fs.existsSync(path.join(this.jpModelDir, 'note_text_encoder.onnx')) &&
              fs.existsSync(path.join(this.jpModelDir, 'preflow.onnx')) &&
              fs.existsSync(path.join(this.jpModelDir, 'cond_emb.onnx')) &&
              fs.existsSync(path.join(this.jpModelDir, 'diff_step_dml.onnx'))
            : false;
        this.sessions = {};
        this.sessionEPs = {};
        this.isFP16 = false; // 是否为 FP16 精度Model
        this.gpuDeviceName = '';
        this.dmlDeviceId = undefined;
        this.initialized = false;
        this.userDeviceId = options.deviceId;
        this.preferredDeviceType = options.preferredDeviceType || null;
        this.useWebNN = false;
        this.useStaticShapes = options.modelPrecision === 'int8-npu';
        this.vocoderType = 'default';            // 'default' | 'sifigan'，_doInit 中从 settings 读取覆盖
        this.sifiganStatsMissing = false;        // SiFiGAN stats 文件缺失标志（运行时兜底归一化用）
        this.sifiganStatsPath = null;            // sifigan_stats.joblib 路径（与 onnx 同目录）
        this._resolvedVocoderFile = null;       // 解析后的 vocoder 文件名（供 _detectVocoderPrecision / loadModel 复用）
        this._currentF0Hz = null;                // 当前推理的 F0 序列（Hz，mel 帧率=50Hz），供 SiFiGAN vocoder 使用；null 表示缺失
        // LRU 缓存：保留最近 N 次合成结果，支持 A/B 比较场景，避免微调单音符时全量重算
        this._synthCache = null;                 // 单条目快速访问指针（指向 _synthCacheMap 中最新条目，兼容旧代码）
        this._synthCacheMap = null;              // Map<key, {audio, size}>，按插入顺序天然 LRU
        this._synthCacheMaxEntries = 4;          // 最大缓存条目数
        this._synthCacheMaxBytes = 200 * 1024 * 1024; // 最大缓存字节数（200MB ≈ 4 分钟音频 × 4 条）
        this._synthCacheBytes = 0;               // 当前缓存占用字节数
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

    /**
     * Detect if notes contain Japanese content.
     * Returns true if any lyric contains Japanese characters or jp_* phonemes.
     */
    static detectJapanese(notes) {
        if (!notes || !Array.isArray(notes)) return false;
        for (const note of notes) {
            const lyric = note.lyric || '';
            if (!lyric) continue;
            // Check for jp_* phonemes
            if (lyric.startsWith('jp_') || lyric.includes('jp_')) return true;
            // Check for hiragana/katakana
            if (/[ぁ-ゟァ-ヿ]/.test(lyric)) return true;
        }
        return false;
    }

    hasJpModels() {
        return this._hasJpModelsCached;
    }

    _resolveModelDir(baseDir, modelPrecision) {
        const resolved = path.resolve(baseDir);
        const subdir = PRECISION_SUBDIR_MAP[modelPrecision];
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

    _resolveJpModelDir(baseDir, modelPrecision) {
        const resolved = path.resolve(baseDir);
        const subdir = PRECISION_SUBDIR_MAP[modelPrecision];
        const jpDir = subdir ? path.join(resolved, subdir, 'JP') : path.join(resolved, 'JP');
        if (fs.existsSync(jpDir)) {
            console.log(`[OnnxSVSPipeline] JP model directory found: ${jpDir}`);
            return jpDir;
        }
        return null;
    }

    /**
     * Get the model path for a specific model file, considering language override.
     * JP models (note_text_encoder, preflow, cond_emb, diff_step_dml) come from
     * jpModelDir when language is 'ja'. All other models (including
     * note_pitch_encoder) come from the base modelDir.
     */
    _getModelPath(modelFile) {
        if (this.languageOverride === 'ja' && this.jpModelDir && JP_MODEL_FILES.has(modelFile)) {
            return path.join(this.jpModelDir, modelFile);
        }
        return path.join(this.modelDir, modelFile);
    }

    /**
     * Incrementally swap only the language-specific models
     * (note_text_encoder, preflow, cond_emb, diff_step_dml).
     * Other models (vocoder, note_pitch_encoder, etc.) stay loaded.
     * Returns true if swap was performed, false if already using the requested language.
     */
    async swapLanguageModels(newLanguage) {
        if (newLanguage === this.languageOverride) return false;
        if (!this.initialized) return false;

        const langModels = [
            { key: 'noteTextEncoder', file: 'note_text_encoder.onnx' },
            { key: 'preflow', file: 'preflow.onnx' },
            { key: 'condEmb', file: 'cond_emb.onnx' },
            { key: 'diffStep', file: 'diff_step_dml.onnx' },
        ];

        const oldLang = this.languageOverride;
        this.languageOverride = newLanguage;

        // Check if JP models exist for new language
        if (newLanguage === 'ja' && !this.hasJpModels()) {
            console.warn('[OnnxSVSPipeline] JP models not found, reverting to base');
            this.languageOverride = oldLang;
            throw new Error('JP_MODELS_MISSING');
        }

        console.log(`[OnnxSVSPipeline] Swapping language models: ${oldLang || 'base'} → ${newLanguage || 'base'}`);

        for (const { key, file } of langModels) {
            // Release old session
            if (this.sessions[key] && typeof this.sessions[key].release === 'function') {
                try { this.sessions[key].release(); } catch (_) {}
            }

            // Resolve actual file to load (handle diff_step_dml → diff_step fallback)
            let resolvedFile = file;
            if (file === 'diff_step_dml.onnx') {
                const dmlPath = this._getModelPath('diff_step_dml.onnx');
                let dmlExists = false;
                try { await fs.promises.access(dmlPath); dmlExists = true; } catch (_) {}
                if (!dmlExists) {
                    // JP 目录缺少 diff_step_dml.onnx，回退到 base 目录的 diff_step.onnx
                    // （适用于 v1/v2 未导出 diff_step 的旧 JP 模型包）
                    resolvedFile = 'diff_step.onnx';
                    console.warn('[OnnxSVSPipeline] JP diff_step_dml.onnx not found, falling back to base diff_step.onnx');
                }
            }

            // Load new model from the updated path
            const modelPath = this._getModelPath(resolvedFile);
            try {
                const { session, ep } = await createSessionWithValidation(
                    modelPath, key, this.gpuDeviceName, this.dmlDeviceId, this.isFP16, false
                );
                this.sessions[key] = session;
                this.sessionEPs[key] = ep;
                console.log(`[OnnxSVSPipeline] ${resolvedFile} swapped [${ep}] → ${modelPath}`);
            } catch (err) {
                console.error(`[OnnxSVSPipeline] Failed to swap ${resolvedFile}:`, err.message);
                throw err;
            }
        }

        return true;
    }

    _getNpuFallbackPath(modelFile) {
        if (!this.useStaticShapes) return null;
        const fallbackDir = path.resolve(this.modelDir, '..');
        const fallbackPath = path.join(fallbackDir, modelFile);
        try {
            if (fs.existsSync(fallbackPath)) return fallbackPath;
        } catch (_) {}
        return null;
    }

    /**
     * 解析默认 vocoder 文件名（vocoder_dml.onnx 优先，缺失时回退 vocoder.onnx）。
     * SiFiGAN 加载失败时用于回退到默认 vocoder。
     * @returns {Promise<string>} 默认 vocoder 文件名
     */
    async _resolveDefaultVocoderFile() {
        try {
            await fs.promises.access(path.join(this.modelDir, 'vocoder_dml.onnx'));
            return 'vocoder_dml.onnx';
        } catch (_) {
            return 'vocoder.onnx';
        }
    }

    /**
     * 判断当前解析的 vocoder 文件是否为 SiFiGAN 变体（用于决定是否传双输入 dummy）。
     * @param {string} vocFile - vocoder 文件名
     * @returns {boolean}
     */
    _isSifiganVocoder(vocFile) {
        return typeof vocFile === 'string' && vocFile.startsWith('sifigan_');
    }

    /**
     * 获取 SiFiGAN 的验证用 dummy 输入（mel + f0 双输入）。
     * sessionKey 在管线中仍为 'vocoder'，故需通过 overrideDummyInputs 传入。
     * @returns {object} SiFiGAN dummy inputs（FP16 或 FP32）
     */
    _getSifiganDummyInputs() {
        return this.isFP16 ? DUMMY_TEST_INPUTS_FP16.sifigan : DUMMY_TEST_INPUTS_FP32.sifigan;
    }

    /**
     * SiFiGAN 加载失败时回退到默认 vocoder（供 loadModel 复用）。
     * 解析默认 vocoder 文件 → 更新 _resolvedVocoderFile → 通过 createSessionWithValidation 加载。
     * @param {string} sessionKey - 会话键（应为 'vocoder'）
     * @returns {Promise<{success: boolean, ep?: string, error?: string}>}
     */
    async _loadDefaultVocoderAsFallback(sessionKey) {
        const defVocFile = await this._resolveDefaultVocoderFile();
        this._resolvedVocoderFile = defVocFile;
        const defVocPath = this._getModelPath(defVocFile);
        try {
            const { session, ep } = await createSessionWithValidation(
                defVocPath, sessionKey, this.gpuDeviceName, this.dmlDeviceId, this.isFP16, this.useStaticShapes
            );
            this.sessions[sessionKey] = session;
            this.sessionEPs[sessionKey] = ep;
            console.log(`[OnnxSVSPipeline] Default vocoder loaded as SiFiGAN fallback [${ep}]`);
            return { success: true, ep };
        } catch (defErr) {
            return { success: false, error: `SiFiGAN fallback 也失败: ${defErr.message}` };
        }
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
    clearSynthCache() {
        // LRU 缓存：清空所有条目
        this._synthCache = null;
        this._synthCacheMap = null;
        this._synthCacheBytes = 0;
    }

    /**
     * LRU 写入：若 key 已存在则更新并移到最新；超出容量时淘汰最旧条目。
     * @param {string} key
     * @param {Float32Array} audio
     */
    _synthCachePut(key, audio) {
        const MAX_SAMPLES = SAMPLE_RATE * 120; // 单条上限 2 分钟
        if (audio.length > MAX_SAMPLES) return; // 超长音频不缓存

        if (!this._synthCacheMap) this._synthCacheMap = new Map();
        const map = this._synthCacheMap;

        // 若已存在，先移除旧条目（稍后重新插入到最新位置）
        if (map.has(key)) {
            const old = map.get(key);
            this._synthCacheBytes -= old.size;
            map.delete(key);
        }

        const size = audio.byteLength;
        map.set(key, { audio, size });
        this._synthCacheBytes += size;

        // 淘汰最旧条目（Map 迭代顺序 = 插入顺序，第一个即最旧）
        while ((map.size > this._synthCacheMaxEntries) ||
               (this._synthCacheBytes > this._synthCacheMaxBytes && map.size > 1)) {
            const oldestKey = map.keys().next().value;
            const oldest = map.get(oldestKey);
            this._synthCacheBytes -= oldest.size;
            map.delete(oldestKey);
        }

        // 更新单条目快速访问指针（指向最新条目）
        this._synthCache = { key, audio };
    }

    /**
     * LRU 读取：命中时把条目移到最新位置，返回 audio；未命中返回 null。
     * @param {string} key
     * @returns {Float32Array|null}
     */
    _synthCacheGet(key) {
        // 单条目快速路径（命中率最高的最近一次合成）
        if (this._synthCache && this._synthCache.key === key) {
            return this._synthCache.audio;
        }
        if (!this._synthCacheMap || !this._synthCacheMap.has(key)) return null;

        // LRU 提升：删除并重新插入到最新位置
        const entry = this._synthCacheMap.get(key);
        this._synthCacheMap.delete(key);
        this._synthCacheMap.set(key, entry);
        this._synthCache = { key, audio: entry.audio };
        return entry.audio;
    }

    /**
     * 使用外部传入的 F0 提取器（如 RMVPE）从参考音频提取 F0 序列。
     * 优先使用外部提取器（精度更高），失败或未提供时回退到内置自相关方法。
     * @param {Buffer|ArrayBuffer} wavBuffer - 参考音频 WAV 数据
     * @param {Function} extractor - async (audioFloat, sampleRate) => Float32Array
     * @returns {Promise<Float32Array|null>}
     */
    async _extractRefF0WithFallback(wavBuffer, extractor) {
        if (extractor) {
            try {
                const { parseWavBuffer, resampleLinear } = require('./postprocessing');
                const { data: audioFloat, sampleRate: srcSr } = parseWavBuffer(wavBuffer);
                // RMVPE 内部会重采样到 16kHz，这里直接传原始采样率
                const f0Array = await extractor(audioFloat, srcSr);
                if (f0Array && f0Array.length > 0) {
                    // 返回值可能是 {time, f0, confidence}[] 或 Float32Array
                    if (f0Array instanceof Float32Array) return f0Array;
                    if (Array.isArray(f0Array) && f0Array.length > 0) {
                        const f0 = new Float32Array(f0Array.length);
                        for (let i = 0; i < f0Array.length; i++) {
                            f0[i] = f0Array[i].f0 || 0;
                        }
                        return f0;
                    }
                }
            } catch (e) {
                console.warn('[OnnxSVSPipeline] 外部 F0 提取失败，回退自相关:', e.message);
            }
        }
        // 回退到内置自相关
        return this._extractRefF0FromWav(wavBuffer);
    }

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
        if (this.languageOverride === 'ja') {
            if (this.jpModelDir) {
                console.log('[OnnxSVSPipeline] Japanese mode: using JP models from', this.jpModelDir);
            } else {
                console.warn('[OnnxSVSPipeline] Japanese requested but JP model directory not found, using base models');
            }
        }

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
        // 并行检查 DML 变体 Model是否存在
        const dmlIdx = resolvedModelFiles.indexOf('diff_step_dml.onnx');
        const vocDmlIdx = resolvedModelFiles.indexOf('vocoder_dml.onnx');

        // 读取 vocoderType 设置（SiFiGAN 三级回退依据），复用 main/settings.loadSettings
        let vocoderType = 'default';
        try {
            const { loadSettings } = require('../../main/settings');
            const settings = loadSettings();
            if (settings.vocoderType === 'sifigan') vocoderType = 'sifigan';
        } catch (e) {
            console.warn('[OnnxSVSPipeline] 读取 vocoderType 设置失败，默认使用 default:', e.message);
        }
        this.vocoderType = vocoderType;

        // SiFiGAN stats 路径与缺失标志初始化
        this.sifiganStatsMissing = false;
        this.sifiganStatsPath = null;
        this._resolvedVocoderFile = 'vocoder_dml.onnx';

        // 并行检查 diff_step_dml 与默认 vocoder_dml 是否存在
        const [dmlExists, vocDmlExists] = await Promise.all([
            dmlIdx >= 0 ? fs.promises.access(path.join(this.modelDir, 'diff_step_dml.onnx')).then(() => true, () => false) : Promise.resolve(true),
            vocDmlIdx >= 0 ? fs.promises.access(path.join(this.modelDir, 'vocoder_dml.onnx')).then(() => true, () => false) : Promise.resolve(true),
        ]);
        if (dmlIdx >= 0 && !dmlExists) {
            resolvedModelFiles[dmlIdx] = 'diff_step.onnx';
            console.log('[OnnxSVSPipeline] diff_step_dml.onnx not found, using diff_step.onnx');
        }

        // Vocoder 路径三级回退：sifigan_vocoder_dml → sifigan_vocoder → 默认 vocoder_dml → vocoder
        let sifiganOnnxResolved = false;
        if (vocoderType === 'sifigan') {
            const sifiganDmlPath = path.join(this.modelDir, 'sifigan_vocoder_dml.onnx');
            const sifiganPlainPath = path.join(this.modelDir, 'sifigan_vocoder.onnx');
            const sifiganStatsPath = path.join(this.modelDir, SIFIGAN_STATS_FILE);
            const [sifiganDmlExists, sifiganPlainExists, sifiganStatsExists] = await Promise.all([
                fs.promises.access(sifiganDmlPath).then(() => true, () => false),
                fs.promises.access(sifiganPlainPath).then(() => true, () => false),
                fs.promises.access(sifiganStatsPath).then(() => true, () => false),
            ]);
            if (sifiganDmlExists) {
                if (!sifiganStatsExists) {
                    // stats 缺失时强制回退默认 vocoder，避免用户听到失真音频
                    // （SiFiGAN ONNX 内部归一化常量依赖 stats，缺失会导致输入分布严重失配）
                    console.warn('[OnnxSVSPipeline] SiFiGAN onnx 存在但 stats 文件缺失，强制回退默认 vocoder 防止失真');
                } else {
                    resolvedModelFiles[vocDmlIdx] = 'sifigan_vocoder_dml.onnx';
                    this._resolvedVocoderFile = 'sifigan_vocoder_dml.onnx';
                    sifiganOnnxResolved = true;
                    console.log('[OnnxSVSPipeline] Using SiFiGAN vocoder: sifigan_vocoder_dml.onnx');
                }
            } else if (sifiganPlainExists) {
                if (!sifiganStatsExists) {
                    console.warn('[OnnxSVSPipeline] SiFiGAN onnx 存在但 stats 文件缺失，强制回退默认 vocoder 防止失真');
                } else {
                    resolvedModelFiles[vocDmlIdx] = 'sifigan_vocoder.onnx';
                    this._resolvedVocoderFile = 'sifigan_vocoder.onnx';
                    sifiganOnnxResolved = true;
                    console.log('[OnnxSVSPipeline] sifigan_vocoder_dml.onnx not found, using sifigan_vocoder.onnx');
                }
            } else {
                console.warn('[OnnxSVSPipeline] sifigan 模型缺失，回退默认 vocoder');
                // 落入默认 vocoder 回退逻辑
            }
            // stats 文件路径与缺失标志（仅 onnx+stats 均存在时 sifiganOnnxResolved=true）
            this.sifiganStatsPath = sifiganStatsPath;
            if (sifiganOnnxResolved) {
                // 走到此分支说明 onnx+stats 均存在，sifiganStatsMissing 始终为 false
                this.sifiganStatsMissing = false;
                console.log('[OnnxSVSPipeline] SiFiGAN stats file found:', SIFIGAN_STATS_FILE);
            }
        }

        // 默认 vocoder 回退（vocoderType=default 或 sifigan 模型均缺失时）
        if (!sifiganOnnxResolved) {
            if (vocDmlIdx >= 0 && !vocDmlExists) {
                resolvedModelFiles[vocDmlIdx] = 'vocoder.onnx';
                this._resolvedVocoderFile = 'vocoder.onnx';
                console.log('[OnnxSVSPipeline] vocoder_dml.onnx not found, using vocoder.onnx');
            } else if (vocDmlIdx >= 0) {
                this._resolvedVocoderFile = 'vocoder_dml.onnx';
            }
        }

        // 并行检查所有Model文件是否存在并获取大小
        const modelStats = await Promise.all(resolvedModelFiles.map(async (modelFile) => {
            const filePath = this._getModelPath(modelFile);
            try {
                const stats = await fs.promises.stat(filePath);
                return { modelFile, size: stats.size };
            } catch (_) {
                throw new Error(`Model文件不存在: ${filePath}`);
            }
        }));
        for (const { modelFile, size } of modelStats) {
            console.log(`[OnnxSVSPipeline] ${modelFile}: ${(size / 1024 / 1024).toFixed(2)} MB`);
        }

        const sessionKeys = SESSION_KEYS;

        // 检测Model精度：通过 probe session 的 I/O 类型 + 单文件量化算子扫描
        try {
            const probeModelPath = path.join(this.modelDir, resolvedModelFiles[4]); // preflow (~8MB)
            const probeSession = await require('onnxruntime-node').InferenceSession.create(probeModelPath, { executionProviders: ['cpu'] });
            const probeInputType = probeSession.inputMetadata[0]?.type;
            this.isFP16 = probeInputType === 'float16';
            await probeSession.release();

            // INT8 检测：仅扫描已读取的 preflow 文件（~8MB），无需读取所有 Model
            // 同一精度变体的所有 Model 统一量化，单文件即可代表整体
            let isINT8 = false;
            try {
                const probeBuf = await fs.promises.readFile(probeModelPath);
                isINT8 = probeBuf.includes('DequantizeLinear') || probeBuf.includes('MatMulInteger');
            } catch (_) {}

            const ioLabel = this.isFP16 ? 'float16' : 'float32';
            const precisionLabel = isINT8
                ? `INT8 (${ioLabel} I/O, INT8 weights)`
                : this.isFP16 ? 'FP16 (half precision)' : 'FP32 (full precision)';
            console.log(`[OnnxSVSPipeline] Model precision: ${precisionLabel}`);
        } catch (e) {
            console.warn('[OnnxSVSPipeline] Precision detection failed, defaulting to FP32:', e.message);
            this.isFP16 = false;
        }

        if (this.useWebNN) {
            // WebNN Model加载：Using非 DML Model文件，通过 IPC 加载到渲染进程
            const { ipcMain } = require('electron');

            const webnnModelFiles = [...resolvedModelFiles];
            const loadedSessions = [];

            // Vocoder 在 NPU 模式下使用 DML 加载（NPU 不适合 vocoder 的大卷积核）
            const vocoderIdx = sessionKeys.indexOf('vocoder');

            // Helper: load a single model via WebNN IPC
            const loadOneWebnnModel = (modelFile, modelId, overridePath) => new Promise((resolve, reject) => {
                const wc = getMainWindowWebContents();
                if (!wc) { resolve({ success: false, error: 'No renderer window' }); return; }

                const ipcTimeout = 180000;

                const requestId = `svs-webnn-load-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                const timeout = setTimeout(() => resolve({ success: false, error: 'Load timeout' }), ipcTimeout);

                ipcMain.handleOnce(`webnn:loadModel:response:${requestId}`, (_, res) => {
                    clearTimeout(timeout);
                    resolve(res);
                });

                wc.send('webnn:loadModel:request', {
                    requestId,
                    modelId,
                    modelPath: overridePath || this._getModelPath(modelFile),
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
                // Skip vocoder — it will be loaded via DML after WebNN models
                // Pre-read next model file during NPU compilation to overlap I/O with compute
                const loadResults = [];
                for (let ri = 0; ri < remainingIndices.length; ri++) {
                    const i = remainingIndices[ri];
                    if (i === vocoderIdx) continue;
                    const modelFile = webnnModelFiles[i];
                    const modelId = sessionKeys[i];

                    // Start pre-reading the next model's file while current one compiles
                    let prefetchPromise = null;
                    for (let ni = ri + 1; ni < remainingIndices.length; ni++) {
                        const nextIdx = remainingIndices[ni];
                        if (nextIdx === vocoderIdx) continue;
                        const nextFile = webnnModelFiles[nextIdx];
                        const nextPath = this._getModelPath(nextFile);
                        const wc = getMainWindowWebContents();
                        if (wc) {
                            prefetchPromise = wc.send('webnn:prefetch:request', { modelPath: nextPath });
                        }
                        break;
                    }

                    const result = await loadOneWebnnModel(modelFile, modelId);
                    loadResults.push({ i, modelFile, modelId, result });

                    // Wait for prefetch to complete (non-blocking, just ensures I/O finishes)
                    if (prefetchPromise) {
                        try { await prefetchPromise; } catch (_) {}
                    }
                }

                for (const { i, modelFile, modelId, result } of loadResults) {
                    if (result.success) {
                        this.sessions[modelId] = new WebNNSessionProxy(modelId);
                        this.sessionEPs[modelId] = result.ep || 'webnn-npu';
                        loadedSessions.push(modelId);
                        console.log(`[OnnxSVSPipeline] ${modelFile} loaded via WebNN [${result.ep}]`);
                    } else {
                        // NPU 模型加载失败，尝试从父目录加载回退模型
                        const fallbackPath = this._getNpuFallbackPath(modelFile);
                        if (fallbackPath) {
                            console.warn(`[OnnxSVSPipeline] ${modelFile} WebNN load failed, trying fallback: ${result.error.substring(0, 80)}`);
                            const fallbackResult = await loadOneWebnnModel(modelFile, modelId, fallbackPath);
                            if (fallbackResult.success) {
                                this.sessions[modelId] = new WebNNSessionProxy(modelId);
                                this.sessionEPs[modelId] = fallbackResult.ep || 'webnn-fallback';
                                loadedSessions.push(modelId);
                                console.log(`[OnnxSVSPipeline] ${modelFile} loaded from fallback via WebNN [${fallbackResult.ep}]`);
                                continue;
                            }
                        }
                        throw new Error(`WebNN 加载 ${modelFile} 失败: ${result.error}`);
                    }
                }

                // Vocoder 使用 DML 加载（NPU 不适合 vocoder 的大卷积核）
                // 跳过 DML 验证推理，避免 GPU 显存压力导致已加载的 WebNN 会话失效
                {
                    const vocoderModelFile = webnnModelFiles[vocoderIdx];
                    const isSifiganVoc = this._isSifiganVocoder(vocoderModelFile);
                    console.log(`[OnnxSVSPipeline] Loading vocoder via DML (skip validation): ${vocoderModelFile}`);

                    // 局部辅助：DML 优先、失败回退 CPU 加载 vocoder（跳过验证推理）
                    const loadVocDmlOrCpu = async (vocFile) => {
                        const ort = require('onnxruntime-node');
                        const vocPath = path.join(this.modelDir, vocFile);
                        const dmlOpts = typeof this.dmlDeviceId === 'number'
                            ? { name: 'dml', deviceId: this.dmlDeviceId }
                            : 'dml';
                        try {
                            const session = await ort.InferenceSession.create(vocPath, {
                                executionProviders: [dmlOpts, 'cpu'],
                            });
                            return { session, ep: 'dml', vocFile };
                        } catch (vocErr) {
                            console.warn(`[OnnxSVSPipeline] Vocoder DML load failed (${vocFile}), falling back to CPU: ${vocErr.message}`);
                            const session = await ort.InferenceSession.create(vocPath, {
                                executionProviders: ['cpu'],
                            });
                            return { session, ep: 'cpu', vocFile };
                        }
                    };

                    try {
                        const { session, ep, vocFile } = await loadVocDmlOrCpu(vocoderModelFile);
                        this.sessions['vocoder'] = session;
                        this.sessionEPs['vocoder'] = ep;
                        await this._detectVocoderPrecision(session, path.join(this.modelDir, vocFile));
                        loadedSessions.push('vocoder');
                        console.log(`[OnnxSVSPipeline] ${vocFile} loaded via ${ep.toUpperCase()} (no validation)`);
                    } catch (vocErr) {
                        // SiFiGAN 加载失败（DML+CPU） → 回退默认 vocoder
                        if (!isSifiganVoc) {
                            throw new Error(`Vocoder 加载失败: ${vocErr.message}`);
                        }
                        console.warn(`[OnnxSVSPipeline] SiFiGAN vocoder load failed on DML/CPU, falling back to default vocoder: ${vocErr.message.substring(0, 80)}`);
                        const defVocFile = await this._resolveDefaultVocoderFile();
                        this._resolvedVocoderFile = defVocFile;
                        try {
                            const { session, ep, vocFile } = await loadVocDmlOrCpu(defVocFile);
                            this.sessions['vocoder'] = session;
                            this.sessionEPs['vocoder'] = ep;
                            await this._detectVocoderPrecision(session, path.join(this.modelDir, vocFile));
                            loadedSessions.push('vocoder');
                            console.log(`[OnnxSVSPipeline] ${vocFile} loaded via ${ep.toUpperCase()} (SiFiGAN fallback, no validation)`);
                        } catch (defErr) {
                            throw new Error(`Vocoder 加载失败 (SiFiGAN fallback 也失败): ${defErr.message}`);
                        }
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
            // DML/CPU Model加载：小Model并行，大Model串行
            let loadedSessions = [];
            try {
                const modelSizes = new Map(modelStats.map((s, i) => [i, s.size]));
                loadedSessions = await this._loadModelsPartitioned(resolvedModelFiles, sessionKeys, modelSizes);
                const dmlCount = Object.values(this.sessionEPs).filter(e => e === 'dml').length;
                const cpuCount = Object.values(this.sessionEPs).filter(e => e === 'cpu').length;
                console.log(`[OnnxSVSPipeline] Init complete: ${dmlCount}  model(s) using DML, ${cpuCount}  model(s) using CPU`);
                if (this.sessions['vocoder']) await this._detectVocoderPrecision(this.sessions['vocoder'], path.join(this.modelDir, this._resolvedVocoderFile || 'vocoder_dml.onnx'));
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

        let loadedSessions = [];
        try {
            loadedSessions = await this._loadModelsPartitioned(resolvedModelFiles, sessionKeys);
            const dmlCount = Object.values(this.sessionEPs).filter(e => e === 'dml').length;
            const cpuCount = Object.values(this.sessionEPs).filter(e => e === 'cpu').length;
            console.log(`[OnnxSVSPipeline] Fallback init complete: ${dmlCount}  model(s) using DML, ${cpuCount}  model(s) using CPU`);
            if (this.sessions['vocoder']) await this._detectVocoderPrecision(this.sessions['vocoder'], path.join(this.modelDir, this._resolvedVocoderFile || 'vocoder_dml.onnx'));
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

    /**
     * Shared model loading: partition by size, load small in parallel, large sequentially.
     * @param {Array} resolvedModelFiles
     * @param {Array} sessionKeys
     * @param {Map<number,number>} [modelSizes] - optional pre-computed sizes from prior stat, keyed by index
     * @returns {string[]} loaded session keys
     */
    async _loadModelsPartitioned(resolvedModelFiles, sessionKeys, modelSizes) {
        const loadedSessions = [];
        const smallIndices = [];
        const largeIndices = [];
        for (let i = 0; i < resolvedModelFiles.length; i++) {
            let size = modelSizes ? (modelSizes.get(i) || 0) : 0;
            if (!size) {
                try { size = (await fs.promises.stat(this._getModelPath(resolvedModelFiles[i]))).size; } catch (_) {}
            }
            if (size < SMALL_MODEL_THRESHOLD) smallIndices.push(i);
            else largeIndices.push(i);
        }

        const loadOne = async (i) => {
            const modelFile = resolvedModelFiles[i];
            const modelPath = this._getModelPath(modelFile);
            // SiFiGAN 双输入 dummy（sessionKey 仍为 'vocoder'，通过 overrideDummyInputs 传入 mel+f0）
            const isSifigan = this._isSifiganVocoder(modelFile);
            const sifiganDummy = isSifigan ? this._getSifiganDummyInputs() : null;
            try {
                const { session, ep } = await createSessionWithValidation(modelPath, sessionKeys[i], this.gpuDeviceName, this.dmlDeviceId, this.isFP16, this.useStaticShapes, sifiganDummy);
                this.sessions[sessionKeys[i]] = session;
                this.sessionEPs[sessionKeys[i]] = ep;
            } catch (loadErr) {
                // SiFiGAN 加载失败 → 回退默认 vocoder（vocoder_dml.onnx → vocoder.onnx）
                if (isSifigan) {
                    console.warn(`[OnnxSVSPipeline] SiFiGAN vocoder load failed, falling back to default vocoder: ${loadErr.message.substring(0, 80)}`);
                    const defVocFile = await this._resolveDefaultVocoderFile();
                    this._resolvedVocoderFile = defVocFile;
                    const defVocPath = this._getModelPath(defVocFile);
                    const { session, ep } = await createSessionWithValidation(defVocPath, sessionKeys[i], this.gpuDeviceName, this.dmlDeviceId, this.isFP16, this.useStaticShapes);
                    this.sessions[sessionKeys[i]] = session;
                    this.sessionEPs[sessionKeys[i]] = ep;
                    console.log(`[OnnxSVSPipeline] Default vocoder loaded as SiFiGAN fallback [${ep}]`);
                    loadedSessions.push(sessionKeys[i]);
                    return;
                }
                const fallbackPath = this._getNpuFallbackPath(modelFile);
                if (fallbackPath) {
                    console.warn(`[OnnxSVSPipeline] ${modelFile} NPU load failed, trying fallback: ${loadErr.message.substring(0, 80)}`);
                    const { session, ep } = await createSessionWithValidation(fallbackPath, sessionKeys[i], this.gpuDeviceName, this.dmlDeviceId, this.isFP16, false, sifiganDummy);
                    this.sessions[sessionKeys[i]] = session;
                    this.sessionEPs[sessionKeys[i]] = ep;
                    console.log(`[OnnxSVSPipeline] ${modelFile} loaded from fallback [${ep}]`);
                } else {
                    throw loadErr;
                }
            }
            loadedSessions.push(sessionKeys[i]);
        };

        if (smallIndices.length > 0) {
            const t0 = performance.now();
            await Promise.all(smallIndices.map(i => loadOne(i)));
            console.log(`[OnnxSVSPipeline] ${smallIndices.length}  small model(s) loaded in parallel (${(performance.now() - t0).toFixed(0)}ms)`);
        }
        for (const i of largeIndices) {
            await loadOne(i);
        }
        return loadedSessions;
    }

    async _detectVocoderPrecision(session, modelPath) {
        try {
            const meta = session.inputMetadata || {};
            const inputNames = session.inputNames || Object.keys(meta);
            console.log(`[OnnxSVSPipeline] Vocoder inputs: [${inputNames.join(', ')}]`);

            // SiFiGAN has two inputs 'mel' and 'f0'; default vocoder only has 'mel'.
            // For precision detection we only inspect 'mel' type (works for both).
            const isSifigan = modelPath && this._isSifiganVocoder(path.basename(modelPath));

            // Try to find 'mel' input metadata
            let melType = null;
            if (meta['mel'] && meta['mel'].type) {
                melType = meta['mel'].type;
            } else if (inputNames.length > 0 && meta[inputNames[0]] && meta[inputNames[0]].type) {
                melType = meta[inputNames[0]].type;
            }

            if (melType) {
                this.vocoderIsFP16 = melType === 'float16';
                console.log(`[OnnxSVSPipeline] Vocoder input type: ${melType} (vocoderIsFP16=${this.vocoderIsFP16})`);
                return;
            }

            // inputMetadata unavailable (DML) — detect from model file size
            // Default vocoder: FP16 ≈ 495 MB, FP32 ≈ 1004 MB → threshold 700 MB
            // SiFiGAN:         FP16 ≈ 300 MB, FP32 ≈ 611 MB → threshold 500 MB
            const sizeThresholdMB = isSifigan ? 500 : 700;
            if (modelPath) {
                try {
                    const fs = require('node:fs');
                    const stats = fs.statSync(modelPath);
                    const sizeMB = stats.size / (1024 * 1024);
                    this.vocoderIsFP16 = sizeMB < sizeThresholdMB;
                    console.log(`[OnnxSVSPipeline] Vocoder file size: ${sizeMB.toFixed(1)} MB (threshold=${sizeThresholdMB} MB, sifigan=${isSifigan}) → vocoderIsFP16=${this.vocoderIsFP16}`);
                    return;
                } catch (_) {}
            }

            // Last resort: probe with valid tensor shape [1, 500, 128]
            // For SiFiGAN, also feed 'f0' input (shape [1, seq, 1]) so session.run() does not fail on missing input.
            console.warn('[OnnxSVSPipeline] Probing vocoder with test inference...');
            const ort = require('onnxruntime-node');
            const PROBE_FRAMES = 500;
            const buildFeed = (melTensor) => {
                if (isSifigan) {
                    const f0Ctor = melTensor.type === 'float16' ? Uint16Array : Float32Array;
                    const f0Tensor = new ort.Tensor(melTensor.type, new f0Ctor(PROBE_FRAMES), [1, PROBE_FRAMES, 1]);
                    return { mel: melTensor, f0: f0Tensor };
                }
                return { mel: melTensor };
            };
            try {
                const t16 = new ort.Tensor('float16', new Uint16Array(PROBE_FRAMES * 128), [1, PROBE_FRAMES, 128]);
                await session.run(buildFeed(t16));
                this.vocoderIsFP16 = true;
                console.log('[OnnxSVSPipeline] Vocoder accepts float16 → vocoderIsFP16=true');
                return;
            } catch (_) {}

            try {
                const t32 = new ort.Tensor('float32', new Float32Array(PROBE_FRAMES * 128), [1, PROBE_FRAMES, 128]);
                await session.run(buildFeed(t32));
                this.vocoderIsFP16 = false;
                console.log('[OnnxSVSPipeline] Vocoder accepts float32 → vocoderIsFP16=false');
                return;
            } catch (_) {}

            console.warn('[OnnxSVSPipeline] All vocoder detection methods failed, defaulting to global precision');
            this.vocoderIsFP16 = this.isFP16;
        } catch (e) {
            console.warn('[OnnxSVSPipeline] Vocoder precision detection failed:', e.message);
            this.vocoderIsFP16 = this.isFP16;
        }
    }

    async _extractRefMelOnnx(refAudioWavBuffer) {
        return this._postprocessing.extractRefMelOnnx(this.sessions, refAudioWavBuffer, this.isFP16, this.useStaticShapes);
    }

    async _runEncoder(sequences, tokenCount, totalFrames, ptFrameCount = 0) {
        return this._preprocessing.runEncoder(this.sessions, sequences, tokenCount, totalFrames, this.isFP16, ptFrameCount, this.useStaticShapes);
    }

    async _runDiffStep(xtInputData, tVal, condData, maskData, totalFramesWithPrompt) {
        return this._diffusion.runDiffStep(this.sessions, xtInputData, tVal, condData, maskData, totalFramesWithPrompt, this.isFP16, this.useStaticShapes);
    }

    async _runVocoderChunked(melData, totalFrames) {
        // Vocoder is loaded via DML (dynamic shapes), never use static shape padding
        // SiFiGAN 双输入：传入 vocoderType、F0 序列、stats 缺失标志；default vocoder 仅用 mel
        return this._postprocessing.runVocoderChunked(
            this.sessions, melData, totalFrames, this.vocoderIsFP16 ?? this.isFP16, false,
            this.vocoderType, this._currentF0Hz, this.sifiganStatsMissing
        );
    }

    async _runDiffusionLoop(xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, onProgress, progressStart, progressRange) {
        return this._diffusion.runDiffusionLoop(this.sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, this.isFP16, onProgress, progressStart, progressRange, this.useStaticShapes);
    }

    async _synthesizeSegment(segmentNotes, bpm, f0Envelope, pitchCurveF0, f0Shift, ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale, npuDiffBatchSize, npuVocoderBatchSize, onProgress, progressStart, progressRange) {
        const sequences = this.notesToSequences(segmentNotes, bpm, f0Envelope, pitchCurveF0, f0Shift);
        let totalFrames = sequences.f0Ids.length;
        const tokenCount = sequences.tokenCount;

        if (totalFrames === 0) {
            return { audio: [], frames: 0 };
        }

        if (totalFrames > MAX_SAFE_FRAMES) {
            console.warn(`[OnnxSVSPipeline] Segment frame count ${totalFrames} exceeds safe limit ${MAX_SAFE_FRAMES}, truncating`);
            sequences.f0Ids = sequences.f0Ids.subarray(0, MAX_SAFE_FRAMES);
            sequences.mel2token = sequences.mel2token.subarray(0, MAX_SAFE_FRAMES);
            totalFrames = MAX_SAFE_FRAMES;
        }

        console.log(`[OnnxSVSPipeline] Segmented synthesis: frames=${totalFrames}, tokens=${tokenCount}, steps=${totalSteps}`);

        // NPU 静态形状模型限制：totalFramesWithPrompt 不能超过 2048
        const NPU_STATIC_SEQ_LEN = 2048;
        if (this.useStaticShapes && ptFrameCount + totalFrames > NPU_STATIC_SEQ_LEN) {
            const maxFrames = NPU_STATIC_SEQ_LEN - Math.min(ptFrameCount, 50);
            if (totalFrames > maxFrames) {
                console.warn(`[OnnxSVSPipeline] NPU frame limit: ${totalFrames} > ${maxFrames}, truncating`);
                sequences.f0Ids = sequences.f0Ids.subarray(0, maxFrames);
                sequences.mel2token = sequences.mel2token.subarray(0, maxFrames);
                totalFrames = maxFrames;
            }
        }

        // WebNN: run entire pipeline in renderer to eliminate per-inference IPC overhead
        if (this.useWebNN) {
            onProgress(Math.round(progressStart));
            const t0 = performance.now();
            // Map WebNN progress (0-100) to segment progress range
            const webnnOnProgress = (p) => {
                onProgress(Math.round(progressStart + (p / 100) * progressRange));
            };
            const result = await this._runWebNNSynthesis({
                sequences, tokenCount, totalFrames,
                ptMelData, ptFrameCount,
                totalSteps, cfgStrength, cfgRescale,
                npuDiffBatchSize, npuVocoderBatchSize,
            }, webnnOnProgress);
            const ms = performance.now() - t0;
            console.log(`[OnnxSVSPipeline] WebNN synthesis: ${totalFrames}frames, ${totalSteps}steps, ${ms.toFixed(0)}ms`);
            onProgress(Math.round(progressStart + progressRange));
            return { audio: result.audioData, frames: totalFrames };
        }

        const totalFramesWithPrompt = ptFrameCount + totalFrames;

        const combinedCond = await this._runEncoder(sequences, tokenCount, totalFrames, ptFrameCount);

        const xt = this.randomNoise(totalFrames, MEL_DIM);

        await this._runDiffusionLoop(xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, onProgress, progressStart, progressRange);

        // Cache F0 (Hz, mel frame rate=50Hz) for SiFiGAN dual-input vocoder; truncated to totalFrames to match mel after NPU/MAX_SAFE truncation. null when unavailable.
        this._currentF0Hz = sequences.f0Hz ? sequences.f0Hz.subarray(0, totalFrames) : null;

        const audioData = await this._runVocoderChunked(xt.data, totalFrames);

        return { audio: audioData, frames: totalFrames };
    }

    /**
     * 在渲染进程中运行完整合成管线（WebNN 优化路径）
     * 单次 IPC 调用，消除逐模型 IPC 开销
     */
    async _runWebNNSynthesis(params, onProgress) {
        const { ipcMain } = require('electron');
        const wc = getMainWindowWebContents();
        if (!wc) throw new Error('No renderer window for WebNN synthesis');

        return new Promise((resolve, reject) => {
            const requestId = `svs-webnn-synth-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const timeout = setTimeout(() => reject(new Error('WebNN synthesis timeout')), 600000);

            // Listen for progress updates from renderer
            const progressHandler = (event, data) => {
                if (onProgress && data && typeof data.progress === 'number') {
                    onProgress(data.progress);
                }
            };
            ipcMain.on(`webnn:progress:${requestId}`, progressHandler);

            ipcMain.handleOnce(`webnn:runSynthesis:response:${requestId}`, (_, result) => {
                clearTimeout(timeout);
                ipcMain.removeListener(`webnn:progress:${requestId}`, progressHandler);
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
                    vocoderIsFP16: this.vocoderIsFP16 ?? this.isFP16,
                    useStaticShapes: this.useStaticShapes,
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
        // Map WebNN progress (0-100) to pair progress range
        const webnnOnProgress = (p) => {
            onProgress(Math.round(progressStart + (p / 100) * progressRange));
        };
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
        ], webnnOnProgress);
        const ms = performance.now() - t0;
        console.log(`[OnnxSVSPipeline] WebNN batch synthesis: ${framesA}+${framesB}frames, ${totalSteps}steps, ${ms.toFixed(0)}ms`);

        onProgress(Math.round(progressStart + progressRange));

        return results.map(r => ({ audio: r.audioData, frames: r.totalFrames }));
    }

    /**
     * 批量 WebNN 合成 IPC 调用
     */
    async _runWebNNSynthesisBatch(paramsArray, onProgress) {
        const { ipcMain } = require('electron');
        const wc = getMainWindowWebContents();
        if (!wc) throw new Error('No renderer window for WebNN batch synthesis');

        return new Promise((resolve, reject) => {
            const requestId = `svs-webnn-batch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            const timeout = setTimeout(() => reject(new Error('WebNN batch synthesis timeout')), 600000);

            // Listen for progress updates from renderer
            const progressHandler = (event, data) => {
                if (onProgress && data && typeof data.progress === 'number') {
                    onProgress(data.progress);
                }
            };
            ipcMain.on(`webnn:progress:${requestId}`, progressHandler);

            ipcMain.handleOnce(`webnn:runSynthesis:response:${requestId}`, (_, result) => {
                clearTimeout(timeout);
                ipcMain.removeListener(`webnn:progress:${requestId}`, progressHandler);
                if (result.error) {
                    reject(new Error(result.error));
                } else {
                    resolve(result);
                }
            });

            wc.send('webnn:runSynthesis:request', {
                requestId,
                params: paramsArray.map(p => ({ ...p, isFP16: this.isFP16, vocoderIsFP16: this.vocoderIsFP16 ?? this.isFP16, useStaticShapes: this.useStaticShapes })),
            });
        });
    }

    async synthesize(notes, bpm, options = {}) {
        if (!this.initialized) {
            await this.init();
        }
        await this.ensureAllModelsLoaded();
        // Reset per-call F0 cache so a stale F0 from a previous synthesis cannot leak into SiFiGAN vocoder input
        this._currentF0Hz = null;
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
        const cachedAudio = this._synthCacheGet(cacheKey);
        if (cachedAudio) {
            onProgress(100);
            return cachedAudio;
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
                    // 优先使用外部 RMVPE 提取器（精度更高），失败回退自相关
                    refF0 = await this._extractRefF0WithFallback(refAudioWavBuffer, options.refF0Extractor || null);
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
            let totalFrames = sequences.f0Ids.length;

            if (totalFrames === 0) {
                return [];
            }

            if (totalFrames > MAX_SAFE_FRAMES) {
                console.warn(`[OnnxSVSPipeline] Frame count ${totalFrames} exceeds safe limit ${MAX_SAFE_FRAMES}, truncating`);
                sequences.f0Ids = sequences.f0Ids.subarray(0, MAX_SAFE_FRAMES);
                sequences.mel2token = sequences.mel2token.subarray(0, MAX_SAFE_FRAMES);
                totalFrames = MAX_SAFE_FRAMES;
            }

            if (!ptMelData || ptFrameCount === 0) {
                ptFrameCount = Math.min(50, Math.max(10, Math.floor(totalFrames * 0.1)));
                ptMelData = new Float32Array(ptFrameCount * MEL_DIM);
            }

            // NPU 静态形状模型限制
            const NPU_STATIC_SEQ_LEN = 2048;
            if (this.useStaticShapes && ptFrameCount + totalFrames > NPU_STATIC_SEQ_LEN) {
                const maxFrames = NPU_STATIC_SEQ_LEN - Math.min(ptFrameCount, 50);
                if (totalFrames > maxFrames) {
                    console.warn(`[OnnxSVSPipeline] NPU frame limit: ${totalFrames} > ${maxFrames}, truncating`);
                    sequences.f0Ids = sequences.f0Ids.subarray(0, maxFrames);
                    sequences.mel2token = sequences.mel2token.subarray(0, maxFrames);
                    totalFrames = maxFrames;
                }
            }

            console.log(`[OnnxSVSPipeline] Synthesis params: frames=${totalFrames}, tokens=${sequences.tokenCount}, steps=${totalSteps}, cfg=${cfgStrength}, f0Shift=${f0Shift}`);

            currentProgress = 30;
            onProgress(currentProgress);

            const combinedCond = await this._runEncoder(sequences, sequences.tokenCount, totalFrames, ptFrameCount);
            const xt = this.randomNoise(totalFrames, MEL_DIM);

            await this._runDiffusionLoop(xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, onProgress, 40, 50);

            onProgress(90);
            // Cache F0 (Hz, mel frame rate=50Hz) for SiFiGAN dual-input vocoder; truncated to totalFrames to match mel. null when unavailable.
            this._currentF0Hz = sequences.f0Hz ? sequences.f0Hz.subarray(0, totalFrames) : null;
            const audioData = await this._runVocoderChunked(xt.data, totalFrames);

            const MAX_CACHE_SAMPLES = SAMPLE_RATE * 120; // 2 分钟
            if (audioData.length <= MAX_CACHE_SAMPLES) {
                this._synthCachePut(cacheKey, audioData);
                console.log('[OnnxSVSPipeline] Audio cached (LRU entries=' +
                    (this._synthCacheMap ? this._synthCacheMap.size : 0) + ')');
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

        normalizePeakTo(finalAudio, totalSamples);

        const audioData = finalAudio;
        const MAX_CACHE_SAMPLES = SAMPLE_RATE * 120;
        if (audioData.length <= MAX_CACHE_SAMPLES) {
            this._synthCachePut(cacheKey, audioData);
            console.log('[OnnxSVSPipeline] Audio cached (LRU entries=' +
                (this._synthCacheMap ? this._synthCacheMap.size : 0) + ')');
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
        const sessionKeys = SESSION_KEYS;
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
            vocoder: this._resolvedVocoderFile || 'vocoder_dml.onnx',
            melTransform: 'mel_transform.onnx',
        };

        const modelFile = sessionKeyToModelFile[sessionKey];
        if (!modelFile) {
            return { success: false, error: `Unknown session key: ${sessionKey}` };
        }

        let resolvedFile = modelFile;
        if (modelFile === 'diff_step_dml.onnx') {
            // 在 JP 模式下检查 jpModelDir，否则检查 modelDir
            const dmlPath = this._getModelPath('diff_step_dml.onnx');
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
        } else if (modelFile === 'sifigan_vocoder_dml.onnx' || modelFile === 'sifigan_vocoder.onnx') {
            // SiFiGAN 三级回退（与 _doInit 阶段保持一致）
            const sifiganDmlPath = path.join(this.modelDir, 'sifigan_vocoder_dml.onnx');
            const sifiganPlainPath = path.join(this.modelDir, 'sifigan_vocoder.onnx');
            let sifiganDmlExists = false, sifiganPlainExists = false;
            try { await fs.promises.access(sifiganDmlPath); sifiganDmlExists = true; } catch (_) {}
            try { await fs.promises.access(sifiganPlainPath); sifiganPlainExists = true; } catch (_) {}
            if (sifiganDmlExists) {
                resolvedFile = 'sifigan_vocoder_dml.onnx';
            } else if (sifiganPlainExists) {
                resolvedFile = 'sifigan_vocoder.onnx';
            } else {
                console.warn('[OnnxSVSPipeline] sifigan 模型缺失，回退默认 vocoder');
                resolvedFile = 'vocoder_dml.onnx';
                const vocDmlPath = path.join(this.modelDir, 'vocoder_dml.onnx');
                let vocDmlExists = false;
                try { await fs.promises.access(vocDmlPath); vocDmlExists = true; } catch (_) {}
                if (!vocDmlExists) {
                    resolvedFile = 'vocoder.onnx';
                }
            }
        }

        const modelPath = this._getModelPath(resolvedFile);
        try {
            await fs.promises.access(modelPath);
        } catch (_) {
            return { success: false, error: `Model file not found: ${resolvedFile}` };
        }

        // SiFiGAN 双输入 dummy（sessionKey 仍为 'vocoder'，通过 overrideDummyInputs 传入 mel+f0）
        const isSifigan = this._isSifiganVocoder(resolvedFile);
        const sifiganDummy = isSifigan ? this._getSifiganDummyInputs() : null;
        try {
            const { session, ep } = await createSessionWithValidation(
                modelPath, sessionKey, this.gpuDeviceName, this.dmlDeviceId, this.isFP16, this.useStaticShapes, sifiganDummy
            );
            this.sessions[sessionKey] = session;
            this.sessionEPs[sessionKey] = ep;
            console.log(`[OnnxSVSPipeline] Model ${sessionKey} loaded [${ep}]`);
            return { success: true, ep };
        } catch (err) {
            const fallbackPath = this._getNpuFallbackPath(resolvedFile);
            if (fallbackPath) {
                console.warn(`[OnnxSVSPipeline] ${resolvedFile} NPU load failed, trying fallback: ${err.message.substring(0, 80)}`);
                try {
                    const { session, ep } = await createSessionWithValidation(
                        fallbackPath, sessionKey, this.gpuDeviceName, this.dmlDeviceId, this.isFP16, false, sifiganDummy
                    );
                    this.sessions[sessionKey] = session;
                    this.sessionEPs[sessionKey] = ep;
                    console.log(`[OnnxSVSPipeline] Model ${sessionKey} loaded from fallback [${ep}]`);
                    return { success: true, ep };
                } catch (fbErr) {
                    // NPU fallback 也失败 — SiFiGAN 回退默认 vocoder
                    if (isSifigan) {
                        console.warn(`[OnnxSVSPipeline] SiFiGAN vocoder load failed (NPU fallback too), falling back to default vocoder: ${fbErr.message.substring(0, 80)}`);
                        return await this._loadDefaultVocoderAsFallback(sessionKey);
                    }
                    return { success: false, error: fbErr.message };
                }
            }
            // 无 NPU fallback — SiFiGAN 回退默认 vocoder
            if (isSifigan) {
                console.warn(`[OnnxSVSPipeline] SiFiGAN vocoder load failed, falling back to default vocoder: ${err.message.substring(0, 80)}`);
                return await this._loadDefaultVocoderAsFallback(sessionKey);
            }
            return { success: false, error: err.message };
        }
    }

    /**
     * 确保所有必需Modelloaded（合成前调用）
     */
    async ensureAllModelsLoaded() {
        const missing = SESSION_KEYS.filter(key => !this.sessions[key]);
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
        this._synthCacheMap = null;
        this._synthCacheBytes = 0;
        this._currentF0Hz = null;
        console.log('[OnnxSVSPipeline] ONNX Runtime sessions released');
    }
}

module.exports = { OnnxSVSPipeline, NativeSVSPipeline: OnnxSVSPipeline, SAMPLE_RATE, enumerateDMLDevices };
