const path = require('node:path');
const fs = require('node:fs');

// Side effect: apply float16 patch on module load
require('./float16Patch');

const { SAMPLE_RATE, HOP_SIZE, MEL_DIM, EMBED_DIM, COND_DIM, ONNX_MODEL_FILES, SIFIGAN_STATS_FILE, CFG_STRENGTH, CFG_RESCALE, DEFAULT_DIFF_STEPS, SEGMENT_OVERLAP_SEC, MAX_SAFE_FRAMES, NPU_STATIC_SEQ_LEN } = require('./constants');
const { getMainWindowWebContents, classifyDevice, enumerateDMLDevices, detectBestGPU, createSessionWithValidation, WebNNSessionProxy, DUMMY_TEST_INPUTS_FP32, DUMMY_TEST_INPUTS_FP16 } = require('./modelLoader');
const { TextProcessing } = require('./textProcessing');
const { Preprocessing } = require('./preprocessing');
const { Diffusion } = require('./diffusion');
const { Postprocessing, parseWavBuffer, resampleLinear, extractMelSpectrogram } = require('./postprocessing');
const { AudioSegmentation } = require('./audioSegmentation');
const { createFloatTensor, outputToFloat32, normalizePeakTo, gpuDrain, gpuDrainLong } = require('./utils');
const { requestModelLoad, requestSynthesis } = require('./webnnIpc');
const { getEffectiveVocoderChunkFrames } = require('../../main/gpuInfo');

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
    'int8-npu': path.join('int8', 'optimized_npu'),
};

const SESSION_KEYS = [
    'noteTextEncoder', 'notePitchEncoder', 'noteTypeEncoder',
    'f0Encoder', 'preflow', 'condEmb', 'diffStep', 'vocoder', 'melTransform',
];

class OnnxSVSPipeline {
    constructor(modelDir, options = {}) {
        this.baseModelDir = modelDir; // Base dir before precision subdir (for shared models)
        this._modelPrecision = options.modelPrecision || null;
        this.modelDir = this._resolveModelDir(modelDir, options.modelPrecision);
        this.languageOverride = options.languageOverride || null; // 'ja' for Japanese
        this.jpModelDir = this._resolveJpModelDir(modelDir, options.modelPrecision);
        this.sessions = {};
        this.sessionEPs = {};
        this.isFP16 = false; // 是否为 FP16 精度Model
        this.gpuDeviceName = '';
        this.dmlDeviceId = undefined;
        this.initialized = false;
        this.userDeviceId = options.deviceId;
        this.preferredDeviceType = options.preferredDeviceType || null;
        this.inferenceProvider = options.inferenceProvider || 'ortnode';
        this.webnnDeviceType = null; // 'npu' | 'gpu'，仅当 useWebNN 时有效
        this.useWebNN = false;
        this.useStaticShapes = options.modelPrecision === 'int8-npu';
        this.vocoderType = 'default';            // 'default' | 'sifigan'，_doInit 中从 settings 读取覆盖
        this.sifiganPrecision = 'fp32';          // 'fp32' | 'fp16'，仅 vocoderType='sifigan' 时生效，控制加载哪个 onnx 变体
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
        // 合成串行化锁：防止连续两次 synthesize() 调用并发。
        // 场景：合成 A 完成 → _recreateHeavySessionsAfterSynthesis() 释放 diffStep/vocoder
        // 并开始 reload；合成 B 启动 → ensureAllModelsLoaded() 发现 diffStep 缺失也尝试 reload。
        // 两个 reload 并发加载同一大模型（diffStep 846MB）→ 显存翻倍 → OOM。
        // _synthPromise 将 synthesize 串行化，B 等 A 完全结束（含 session 重建）才启动。
        this._synthPromise = null;

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
        // 实时检查文件存在性：用户可能在 pipeline 创建后才下载 JP 模型，
        // 此时构造时缓存的 _hasJpModelsCached 已过期。同时重新解析 jpModelDir，
        // 因为用户可能在 pipeline 创建后才创建 JP 文件夹。
        if (!this.jpModelDir) {
            this.jpModelDir = this._resolveJpModelDir(this.baseModelDir, this._modelPrecision);
            if (!this.jpModelDir) return false;
        }
        return fs.existsSync(path.join(this.jpModelDir, 'note_text_encoder.onnx')) &&
               fs.existsSync(path.join(this.jpModelDir, 'preflow.onnx')) &&
               fs.existsSync(path.join(this.jpModelDir, 'cond_emb.onnx')) &&
               fs.existsSync(path.join(this.jpModelDir, 'diff_step_dml.onnx'));
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
        const primaryPath = path.join(this.modelDir, modelFile);
        // SiFiGAN 文件不随主模型一起做精度转换，可能仅存在于 baseModelDir（onnx_models/ 根目录）
        // 而非精度子目录（fp16/int8）。当 modelDir 是精度子目录且 sifigan 文件不在其中时，
        // 回退到 baseModelDir 查找，避免 _resolveVocoderFile 误判"模型缺失"触发 default vocoder 回退。
        if (this.baseModelDir && this.modelDir !== this.baseModelDir &&
            (modelFile.startsWith('sifigan_') || modelFile === SIFIGAN_STATS_FILE)) {
            if (!fs.existsSync(primaryPath)) {
                return path.join(this.baseModelDir, modelFile);
            }
        }
        return primaryPath;
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

        console.log(`[OnnxSVSPipeline] Swapping language models: ${oldLang || 'base'} -> ${newLanguage || 'base'}`);

        // 切换语言模型后旧缓存不再适用（不同语言的 phoneme embedding/preflow/cond_emb/diff_step
        // 会产生不同音频），必须清空，否则会命中缓存返回错误语言的音频。
        this.clearSynthCache();

        for (const { key, file } of langModels) {
            // Release old session and delete references BEFORE loading new one.
            // 旧版仅 release 但保留 this.sessions[key] 引用，若后续 createSessionWithValidation
            // 抛错，this.sessions[key] 仍指向已释放的 session，ensureAllModelsLoaded() 检查
            // !this.sessions[key] 为 false 跳过重载，导致下一次合成使用已释放的 session 崩溃。
            if (this.sessions[key] && typeof this.sessions[key].release === 'function') {
                try { this.sessions[key].release(); } catch (_) {}
            }
            delete this.sessions[key];
            delete this.sessionEPs[key];

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
                console.log(`[OnnxSVSPipeline] ${resolvedFile} swapped [${ep}] -> ${modelPath}`);
            } catch (err) {
                console.error(`[OnnxSVSPipeline] Failed to swap ${resolvedFile}:`, err.message);
                throw err;
            }
        }

        return true;
    }

    /**
     * 增量切换 vocoder（仅重载 vocoder session，保留其他 session 不动）
     * 参考 swapLanguageModels 的模式：只释放并重载目标 session，避免整体 pipeline 重建。
     * 用于 settings.vocoderType 变化时最小化重载，避免主模型（encoders/preflow/condEmb/diffStep/melTransform）被重新加载。
     *
     * loadModel 内部已处理 SiFiGAN 加载失败回退默认 vocoder 的逻辑，
     * 因此此处仅依赖 loadModel 的结果；若加载失败则尝试回退到旧 vocoderType 防止 vocoder 空缺。
     *
     * @param {'default'|'sifigan'} newVocoderType
     * @returns {Promise<boolean>} true 表示切换成功；false 表示未切换（类型相同/未初始化）
     */
    async swapVocoder(newVocoderType) {
        if (newVocoderType !== 'default' && newVocoderType !== 'sifigan') return false;
        if (!this.initialized) return false;
        if (newVocoderType === this.vocoderType) return false;

        const oldVocoderType = this.vocoderType;
        console.log(`[OnnxSVSPipeline] Swapping vocoder: ${oldVocoderType} -> ${newVocoderType}`);

        // 释放当前 vocoder session
        if (this.sessions['vocoder'] && typeof this.sessions['vocoder'].release === 'function') {
            try { this.sessions['vocoder'].release(); } catch (_) {}
        }
        delete this.sessions['vocoder'];
        delete this.sessionEPs['vocoder'];

        // 更新 vocoderType 并重新解析文件路径（四级回退）
        this.vocoderType = newVocoderType;
        // 切换 vocoder 类型时同步刷新 sifiganPrecision（避免使用旧缓存值，与 settings.json 保持一致）
        if (newVocoderType === 'sifigan') {
            try {
                const { loadSettings } = require('../../main/settings');
                const settings = loadSettings();
                this.sifiganPrecision = settings.sifiganPrecision === 'fp16' ? 'fp16' : 'fp32';
            } catch (_) { /* 保持默认 fp32 */ }
        }
        await this._resolveVocoderFile();

        // 加载新 vocoder（loadModel 内部处理 sifigan 失败回退默认 vocoder 的逻辑）
        const result = await this.loadModel('vocoder');
        if (!result.success) {
            // 加载失败：回退到旧 vocoderType，避免留下空 vocoder session
            console.error(`[OnnxSVSPipeline] Vocoder swap to ${newVocoderType} failed: ${result.error}, reverting to ${oldVocoderType}`);
            this.vocoderType = oldVocoderType;
            await this._resolveVocoderFile();
            const revertResult = await this.loadModel('vocoder');
            if (!revertResult.success) {
                throw new Error(`Vocoder swap failed and revert also failed: ${revertResult.error}`);
            }
            console.warn(`[OnnxSVSPipeline] Reverted to ${oldVocoderType} vocoder after failed swap`);
            return false;
        }

        // 清空合成缓存（不同 vocoder 会产生不同音频，旧缓存不再适用）
        this.clearSynthCache();

        console.log(`[OnnxSVSPipeline] Vocoder swapped [${result.ep || 'unknown'}] -> ${this._resolvedVocoderFile}`);
        return true;
    }

    /**
     * 增量切换 SiFiGAN 精度（FP16 ↔ FP32），仅重载 vocoder session。
     * 用于 settings.sifiganPrecision 变化且 vocoderType === 'sifigan' 时最小化重载。
     * 若当前 vocoderType !== 'sifigan'，则只更新字段值，不重载（下次 swapVocoder 到 sifigan 时生效）。
     *
     * @param {'fp16'|'fp32'} newPrecision
     * @returns {Promise<boolean>} true 表示已重载 vocoder；false 表示仅更新字段未重载
     */
    async swapSifiganPrecision(newPrecision) {
        if (newPrecision !== 'fp16' && newPrecision !== 'fp32') return false;
        const oldPrecision = this.sifiganPrecision;
        if (newPrecision === oldPrecision) return false;

        this.sifiganPrecision = newPrecision;
        console.log(`[OnnxSVSPipeline] SiFiGAN precision change: ${oldPrecision} -> ${newPrecision}`);

        // 若 pipeline 未初始化或当前非 sifigan，仅更新字段，等下次 init/swapVocoder 时生效
        if (!this.initialized || this.vocoderType !== 'sifigan') {
            console.log('[OnnxSVSPipeline] Pipeline not initialized or vocoderType !== sifigan, precision will apply on next sifigan load');
            return false;
        }

        // 释放当前 vocoder session
        if (this.sessions['vocoder'] && typeof this.sessions['vocoder'].release === 'function') {
            try { this.sessions['vocoder'].release(); } catch (_) {}
        }
        delete this.sessions['vocoder'];
        delete this.sessionEPs['vocoder'];

        await this._resolveVocoderFile();
        const result = await this.loadModel('vocoder');
        if (!result.success) {
            // 加载失败：回退到旧精度
            console.error(`[OnnxSVSPipeline] SiFiGAN precision swap to ${newPrecision} failed: ${result.error}, reverting to ${oldPrecision}`);
            this.sifiganPrecision = oldPrecision;
            await this._resolveVocoderFile();
            const revertResult = await this.loadModel('vocoder');
            if (!revertResult.success) {
                throw new Error(`SiFiGAN precision swap failed and revert also failed: ${revertResult.error}`);
            }
            console.warn(`[OnnxSVSPipeline] Reverted to SiFiGAN precision ${oldPrecision} after failed swap`);
            return false;
        }

        this.clearSynthCache();
        console.log(`[OnnxSVSPipeline] SiFiGAN precision swapped [${result.ep || 'unknown'}] -> ${this._resolvedVocoderFile}`);
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
        // SiFiGAN 的实际精度由 _resolvedVocoderFile 决定（与主模型 isFP16 解耦）：
        // - sifigan_vocoder_dml_fp16.onnx → FP16 模型，期望 FP16 输入
        // - sifigan_vocoder_dml.onnx / sifigan_vocoder.onnx → FP32 模型，期望 FP32 输入
        // 主模型走 fp16 子目录时 this.isFP16=true，但 sifigan 文件未做精度转换（仍为 FP32），
        // 若按 isFP16 选 FP16 dummy 会导致 DML 推理验证失败（Unexpected input data type）。
        const file = this._resolvedVocoderFile || '';
        const isSifiganFp16 = file === 'sifigan_vocoder_dml_fp16.onnx';
        return isSifiganFp16 ? DUMMY_TEST_INPUTS_FP16.sifigan : DUMMY_TEST_INPUTS_FP32.sifigan;
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
        // 关键修复：回退 default vocoder 时必须同步更新 vocoderType，否则后续合成会按 sifigan
        // 模式处理（mel 4× 上采样 + 传 f0），但实际 session 是 default
        // vocoder，导致 mel 形状/输入签名不匹配 + 加载的是 1005MB default 而非 34MB sifigan，
        // 显存压力暴增触发 0x887A0006 OOM。
        if (this.vocoderType === 'sifigan') {
            console.warn('[OnnxSVSPipeline] SiFiGAN fallback to default vocoder: syncing vocoderType sifigan -> default to prevent mode mismatch');
            this.vocoderType = 'default';
        }
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
            return { success: false, error: `SiFiGAN fallback also failed: ${defErr.message}` };
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
    _extractRefMelAsync(refAudioWavBuffer) { return this._postprocessing.extractRefMelAsync(refAudioWavBuffer); }
    _extractRefF0FromWav(wavBuffer) { return this._postprocessing.extractRefF0FromWav(wavBuffer); }
    _extractRefF0FromWavAsync(wavBuffer) { return this._postprocessing.extractRefF0FromWavAsync(wavBuffer); }
    _extractRefNotePitches(wavBuffer) { return this._postprocessing.extractRefNotePitches(wavBuffer); }
    _extractRefNotePitchesAsync(wavBuffer) { return this._postprocessing.extractRefNotePitchesAsync(wavBuffer); }

    // Delegate audio segmentation methods
    _fillNoteGaps(notes) { return this._audioSegmentation.fillNoteGaps(notes); }
    _buildVocalSegments(notes, bpm) { return this._audioSegmentation.buildVocalSegments(notes, bpm); }
    _hashArray(arr) { return this._audioSegmentation.hashArray(arr); }
    _computeSynthCacheKey(notes, bpm, options) { return this._audioSegmentation.computeSynthCacheKey(notes, bpm, options, this.interpolateEnvelope.bind(this)); }
    _median(arr) { return this._audioSegmentation.median(arr); }

    /**
     * 限制 autoShift 的 f0Shift 范围，防止偏移后音高超出模型/vocoder 训练分布。
     * 策略：基于 target pitch 范围动态限制，确保偏移后所有音符落在有效范围内；
     *       同时绝对值兜底不超过 12 半音（±1 octave）。
     * @param {number} f0Shift - 原始计算的半音偏移
     * @param {number[]} targetNotePitches - target 音符的 MIDI pitch 数组
     * @returns {number} 限制后的 f0Shift
     */
    _clampAutoShift(f0Shift, targetNotePitches) {
        if (f0Shift === 0 || !targetNotePitches || targetNotePitches.length === 0) {
            return f0Shift;
        }
        // JP 模式收紧 pitch 范围：JSUT 训练数据全部 pitch=60，PJS/GTSinger 覆盖
        // 约 C3-C5（48-84）。JP 专属的 cond_emb/diff_step/preflow 只在此范围微调，
        // OOD pitch 会导致 cond_embedding 异常 → AdaptiveRMSNorm weight 异常 → 音素错乱。
        // 基础模型覆盖更广（28-88），但 JP 必须收紧到训练分布内。
        const isJp = this.languageOverride === 'ja';
        const MIN_EFFECTIVE_PITCH = isJp ? 48 : 28; // JP: C3 / base: ~E1
        // SiFiGAN 对 f0 敏感（过高导致激励畸变→口齿不清，见 index.js:1574 注释），
        // 上限收紧到 84（~C6），避免 autoShift 将高音推入 SiFiGAN 失真区。
        // 默认 vocoder 上限 88（~E6）。JP 任何 vocoder 都用 84。
        const MAX_EFFECTIVE_PITCH = (isJp || this.vocoderType === 'sifigan') ? 84 : 88;
        let minPitch = targetNotePitches[0];
        let maxPitch = targetNotePitches[0];
        for (const p of targetNotePitches) {
            if (p < minPitch) minPitch = p;
            if (p > maxPitch) maxPitch = p;
        }
        const maxAllowedUp = MAX_EFFECTIVE_PITCH - maxPitch;
        const maxAllowedDown = MIN_EFFECTIVE_PITCH - minPitch; // 负值
        const clampedShift = Math.max(maxAllowedDown, Math.min(maxAllowedUp, f0Shift));
        return Math.max(-12, Math.min(12, clampedShift));
    }

    /**
     * JP 专属 pitch 范围保护：无论 autoShift 还是手动 pitchShift 模式都生效。
     * 根因：JSUT 数据全部 pitch=60，JP 下游模块对其他 pitch OOD。
     * 当 effective pitch (note.pitch + f0Shift) 超出 [48, 84] 时，调整 f0Shift
     * 使其回到训练分布内。返回调整后的 f0Shift。
     */
    _clampJpPitchRange(f0Shift, targetNotePitches) {
        if (!targetNotePitches || targetNotePitches.length === 0) {
            return f0Shift;
        }
        const JP_MIN_PITCH = 48; // C3，JP 训练数据下限
        const JP_MAX_PITCH = 84; // C6，JP 训练数据上限
        let minPitch = targetNotePitches[0];
        let maxPitch = targetNotePitches[0];
        for (const p of targetNotePitches) {
            if (p < minPitch) minPitch = p;
            if (p > maxPitch) maxPitch = p;
        }
        // upper bound: 最大可上移量（保证 maxPitch + shift <= JP_MAX）
        // lower bound: 最大可下移量（保证 minPitch + shift >= JP_MIN）
        const upperBound = JP_MAX_PITCH - maxPitch;
        const lowerBound = JP_MIN_PITCH - minPitch;
        if (lowerBound <= upperBound) {
            // 正常情况：存在合法 shift 区间 [lowerBound, upperBound]
            return Math.max(lowerBound, Math.min(upperBound, f0Shift));
        }
        // 旋律跨度超过 [JP_MIN, JP_MAX]（36 半音），无法用单一 shift 完全修复。
        // 选 shift 使旋律中心对齐到训练范围中心，最小化最坏 OOD 距离。
        const rangeCenter = (JP_MIN_PITCH + JP_MAX_PITCH) / 2;
        const melodyCenter = (minPitch + maxPitch) / 2;
        return Math.round(rangeCenter - melodyCenter);
    }

    /**
     * 计算多 segment 路径中单个 segment 的 f0Shift (B2)。
     * 基于全局 f0Shift，按 segment 中位数相对全局中位数的偏差做调整（上限 ±5 半音），
     * 再用 _clampAutoShift 限制到 vocoder/encoder 有效范围。autoShift 未启用时返回原 f0Shift。
     * @param {number} globalF0Shift - 全局 clamped f0Shift
     * @param {number|null} globalTargetMedian - 全局音符中位数（autoShift 未启用时为 null）
     * @param {Array} segNotes - 该 segment 的音符数组
     * @returns {number} 该 segment 的 f0Shift
     */
    _computeSegF0Shift(globalF0Shift, globalTargetMedian, segNotes) {
        if (globalTargetMedian === null) return globalF0Shift;
        const segPitches = [];
        for (const n of segNotes) {
            if (n.pitch >= 1) segPitches.push(n.pitch);
        }
        if (segPitches.length === 0) return globalF0Shift;
        const segMedian = this._median(segPitches);
        const PER_SEG_CAP = 5; // ±5 半音，相邻段最大差 10，由 crossfade 平滑
        const adj = Math.max(-PER_SEG_CAP, Math.min(PER_SEG_CAP, globalTargetMedian - segMedian));
        if (adj === 0) return globalF0Shift;
        const segShift = this._clampAutoShift(globalF0Shift + adj, segPitches);
        // JP per-seg 也需要收紧到训练 pitch 范围 [48,84]，_clampAutoShift 已通过
        // isJp 判断处理，但额外用 _clampJpPitchRange 兜底（防止 _clampAutoShift
        // 的 ±12 上限放宽了边界 case）。
        const finalShift = this.languageOverride === 'ja'
            ? this._clampJpPitchRange(segShift, segPitches)
            : segShift;
        if (finalShift !== globalF0Shift) {
            console.log(`[OnnxSVSPipeline] per-seg f0Shift: global=${globalF0Shift} segMedian=${segMedian} adj=${adj} → ${finalShift}`);
        }
        return finalShift;
    }
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
                const { parseWavBuffer } = require('./postprocessing');
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
                console.warn('[OnnxSVSPipeline] external F0 extraction failed, falling back to autocorrelation:', e.message);
            }
        }
        // 回退到内置自相关（异步版，避免长音频同步阻塞主线程）
        return this._extractRefF0FromWavAsync(wavBuffer);
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

        const gpuInfo = await this._detectHardware();
        const { resolvedModelFiles, modelStats } = await this._resolveModelFiles();
        const sessionKeys = SESSION_KEYS;
        await this._detectModelPrecision(resolvedModelFiles);

        if (this.useWebNN) {
            await this._loadWebNNModels(gpuInfo, resolvedModelFiles, sessionKeys, modelStats);
        } else {
            await this._loadDMLModels(resolvedModelFiles, sessionKeys, modelStats);
        }

        this.initialized = true;
        return true;
    }

    /**
     * 硬件检测：GPU 探测 + NPU 可用性 + 设备选择
     * 设置 this.allDevices / this.useWebNN / this.dmlDeviceId / this.gpuDeviceName
     * @returns {Promise<Object>} gpuInfo
     */
    async _detectHardware() {
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

        // 检查是否使用 WebNN (ORTWEB)
        const useOrtWeb = this.inferenceProvider === 'ortweb';
        if (useOrtWeb) {
            try {
                const { detectNPUAvailability } = require('../../main/webnnIpc');
                const webnnResult = await detectNPUAvailability();
                const npuAvailable = !!webnnResult.npuAvailable;
                const gpuAvailable = !!webnnResult.gpuAvailable;
                if (npuAvailable || gpuAvailable) {
                    let deviceType = null;
                    const requestedNpu = this.preferredDeviceType === 'npu' || this.userDeviceId === 'npu';
                    const requestedGpu = this.preferredDeviceType === 'webnn-gpu' || this.userDeviceId === 'webnn-gpu';
                    if (requestedNpu && npuAvailable) {
                        deviceType = 'npu';
                    } else if (requestedGpu && gpuAvailable) {
                        deviceType = 'gpu';
                    } else if (npuAvailable) {
                        // auto 或未指定时优先 NPU
                        deviceType = 'npu';
                    } else if (gpuAvailable) {
                        deviceType = 'gpu';
                    }
                    if (deviceType) {
                        this.useWebNN = true;
                        this.webnnDeviceType = deviceType;
                        this.gpuDeviceName = deviceType === 'npu' ? 'NPU (WebNN)' : 'GPU (WebNN)';
                        console.log(`[OnnxSVSPipeline] WebNN ${deviceType.toUpperCase()} available, using ORTWEB inference engine`);
                    }
                } else {
                    console.warn(`[OnnxSVSPipeline] WebNN not available (${webnnResult.details}), falling back to DML/CPU`);
                }
            } catch (e) {
                console.warn('[OnnxSVSPipeline] WebNN detection failed, falling back to DML/CPU:', e.message);
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
                this.gpuDeviceName = gpuInfo.name || 'No GPU (CPU only)';
                console.log(`[OnnxSVSPipeline] GPU device (auto): ${this.gpuDeviceName}${this.dmlDeviceId !== undefined ? ` (deviceId=${this.dmlDeviceId})` : ''}`);
            }
        }
        return gpuInfo;
    }

    /**
     * 解析模型文件路径：DML 变体检查 + SiFiGAN 三级回退 + 文件存在性校验
     * 设置 this.vocoderType / this.sifiganStatsPath / this._resolvedVocoderFile
     * @returns {Promise<{resolvedModelFiles: string[], modelStats: Array}>}
     */
    async _resolveModelFiles() {
        const resolvedModelFiles = [...ONNX_MODEL_FILES];
        const dmlIdx = resolvedModelFiles.indexOf('diff_step_dml.onnx');
        const vocDmlIdx = resolvedModelFiles.indexOf('vocoder_dml.onnx');

        // 读取 vocoderType / sifiganPrecision 设置（SiFiGAN 文件选择依据），复用 main/settings.loadSettings
        let vocoderType = 'default';
        let sifiganPrecision = 'fp32';
        try {
            const { loadSettings } = require('../../main/settings');
            const settings = loadSettings();
            if (settings.vocoderType === 'sifigan') vocoderType = 'sifigan';
            if (settings.sifiganPrecision === 'fp16') sifiganPrecision = 'fp16';
        } catch (e) {
            console.warn('[OnnxSVSPipeline] 读取 vocoderType/sifiganPrecision 设置失败，默认使用 default/fp32:', e.message);
        }
        this.vocoderType = vocoderType;
        this.sifiganPrecision = sifiganPrecision;

        // 检查 diff_step_dml 是否存在（仅 init 阶段需要，vocoder swap 不会触及）
        const dmlExists = await (dmlIdx >= 0
            ? fs.promises.access(path.join(this.modelDir, 'diff_step_dml.onnx')).then(() => true, () => false)
            : Promise.resolve(true));
        if (dmlIdx >= 0 && !dmlExists) {
            resolvedModelFiles[dmlIdx] = 'diff_step.onnx';
            console.log('[OnnxSVSPipeline] diff_step_dml.onnx not found, using diff_step.onnx');
        }

        // 解析 vocoder 文件（四级回退逻辑由 _resolveVocoderFile 集中处理）
        const vocoderFile = await this._resolveVocoderFile();
        if (vocDmlIdx >= 0) {
            resolvedModelFiles[vocDmlIdx] = vocoderFile;
        }

        // 并行检查所有Model文件是否存在并获取大小
        const modelStats = await Promise.all(resolvedModelFiles.map(async (modelFile) => {
            const filePath = this._getModelPath(modelFile);
            try {
                const stats = await fs.promises.stat(filePath);
                return { modelFile, size: stats.size };
            } catch (_) {
                throw new Error(`Model file does not exist: ${filePath}`);
            }
        }));
        for (const { modelFile, size } of modelStats) {
            console.log(`[OnnxSVSPipeline] ${modelFile}: ${(size / 1024 / 1024).toFixed(2)} MB`);
        }

        return { resolvedModelFiles, modelStats };
    }

    /**
     * 解析 vocoder 文件名：根据 this.vocoderType 与文件存在性执行四级回退
     * sifigan_vocoder_dml_fp16 → sifigan_vocoder_dml → sifigan_vocoder → 默认 vocoder_dml → vocoder
     * 设置 this._resolvedVocoderFile / this.sifiganStatsPath / this.sifiganStatsMissing
     *
     * 调用方必须先设置 this.vocoderType（_resolveModelFiles 在 init 时读取 settings，
     * swapVocoder 在切换时直接传入新值）。
     * @returns {Promise<string>} 解析后的 vocoder 文件名
     */
    async _resolveVocoderFile() {
        // 重置状态
        this.sifiganStatsMissing = false;
        this.sifiganStatsPath = null;
        this._resolvedVocoderFile = 'vocoder_dml.onnx';

        // 检查默认 vocoder_dml.onnx 是否存在
        const vocDmlPath = path.join(this.modelDir, 'vocoder_dml.onnx');
        let vocDmlExists = false;
        try { await fs.promises.access(vocDmlPath); vocDmlExists = true; } catch (_) {}

        // SiFiGAN 回退（仅当 vocoderType === 'sifigan' 时尝试）
        // 文件优先级：用户选择的精度变体 → 另一精度变体 → sifigan_vocoder.onnx (FP32 plain) → 默认 vocoder
        // stats 文件缺失时强制回退默认 vocoder，避免输入分布失配导致失真
        let sifiganOnnxResolved = false;
        if (this.vocoderType === 'sifigan') {
            // SiFiGAN 文件可能位于 baseModelDir（onnx_models/ 根目录）而非精度子目录，
            // 通过 _getModelPath 自动兜底查找（sifigan_* 文件走 baseModelDir 回退逻辑）。
            const sifiganFp16Path = this._getModelPath('sifigan_vocoder_dml_fp16.onnx');
            const sifiganDmlPath = this._getModelPath('sifigan_vocoder_dml.onnx');
            const sifiganPlainPath = this._getModelPath('sifigan_vocoder.onnx');
            const sifiganStatsPath = this._getModelPath(SIFIGAN_STATS_FILE);
            const [sifiganFp16Exists, sifiganDmlExists, sifiganPlainExists, sifiganStatsExists] = await Promise.all([
                fs.promises.access(sifiganFp16Path).then(() => true, () => false),
                fs.promises.access(sifiganDmlPath).then(() => true, () => false),
                fs.promises.access(sifiganPlainPath).then(() => true, () => false),
                fs.promises.access(sifiganStatsPath).then(() => true, () => false),
            ]);
            // 辅助函数: 选中某个 sifigan onnx 变体 (stats 必须存在)
            const pickSifigan = (fileName, label) => {
                if (!sifiganStatsExists) {
                    // stats 缺失时强制回退默认 vocoder，避免用户听到失真音频
                    // （SiFiGAN ONNX 内部归一化常量依赖 stats，缺失会导致输入分布严重失配）
                    console.warn('[OnnxSVSPipeline] SiFiGAN onnx 存在但 stats 文件缺失，强制回退默认 vocoder 防止失真');
                    return false;
                }
                this._resolvedVocoderFile = fileName;
                sifiganOnnxResolved = true;
                console.log(`[OnnxSVSPipeline] Using SiFiGAN vocoder: ${fileName} (${label})`);
                return true;
            };

            // 按用户选择的精度优先尝试，缺失时回退到另一精度变体
            const preferFp16 = this.sifiganPrecision === 'fp16';
            const primaryVariant = preferFp16
                ? { exists: sifiganFp16Exists, file: 'sifigan_vocoder_dml_fp16.onnx', label: 'FP16' }
                : { exists: sifiganDmlExists, file: 'sifigan_vocoder_dml.onnx', label: 'FP32' };
            const secondaryVariant = preferFp16
                ? { exists: sifiganDmlExists, file: 'sifigan_vocoder_dml.onnx', label: 'FP32 (fallback, user pref=fp16)' }
                : { exists: sifiganFp16Exists, file: 'sifigan_vocoder_dml_fp16.onnx', label: 'FP16 (fallback, user pref=fp32)' };

            if (primaryVariant.exists) {
                pickSifigan(primaryVariant.file, primaryVariant.label);
            } else if (secondaryVariant.exists) {
                pickSifigan(secondaryVariant.file, secondaryVariant.label);
            } else if (sifiganPlainExists) {
                pickSifigan('sifigan_vocoder.onnx', 'FP32 plain');
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
            // 关键修复：sifigan 模式但 onnx/stats 缺失回退 default 时，必须同步 vocoderType，
            // 否则后续合成按 sifigan 模式处理但实际加载 default vocoder，导致 mel 4× 上采样
            // 错误 + 1005MB default 权重替代 34MB sifigan，显存压力暴增触发 0x887A0006 OOM。
            if (this.vocoderType === 'sifigan') {
                console.warn('[OnnxSVSPipeline] vocoderType=sifigan but SiFiGAN onnx/stats missing, syncing vocoderType -> default to prevent mode mismatch');
                this.vocoderType = 'default';
            }
            if (!vocDmlExists) {
                this._resolvedVocoderFile = 'vocoder.onnx';
                console.log('[OnnxSVSPipeline] vocoder_dml.onnx not found, using vocoder.onnx');
            } else {
                this._resolvedVocoderFile = 'vocoder_dml.onnx';
            }
        }

        return this._resolvedVocoderFile;
    }

    /**
     * 检测模型精度（FP16/FP32/INT8）：通过 preflow probe session 的 I/O 类型 + 量化算子扫描
     * 设置 this.isFP16
     */
    async _detectModelPrecision(resolvedModelFiles) {
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
    }

    /**
     * WebNN 模型加载：NPU 探测 → 并行加载 → Vocoder DML 加载
     * 失败时自动回退到 _doInitFallback
     */
    async _loadWebNNModels(gpuInfo, resolvedModelFiles, sessionKeys, modelStats) {
        const { ipcMain } = require('electron');

        const webnnModelFiles = [...resolvedModelFiles];
        const loadedSessions = [];

        // Vocoder 在 NPU 模式下使用 DML 加载（NPU 不适合 vocoder 的大卷积核）
        const vocoderIdx = sessionKeys.indexOf('vocoder');

        // Helper: load a single model via WebNN IPC
        const loadOneWebnnModel = async (modelFile, modelId, overridePath) => {
            const wc = getMainWindowWebContents();
            if (!wc) return { success: false, error: 'No renderer window' };
            try {
                const res = await requestModelLoad(
                    wc,
                    modelId,
                    overridePath || this._getModelPath(modelFile),
                    { deviceType: this.webnnDeviceType || 'npu' },
                );
                return res || { success: false, error: 'Empty response' };
            } catch (err) {
                return { success: false, error: err.message };
            }
        };

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
                throw new Error(`WebNN probe failed: ${probeResult.error}`);
            }

            // Check if requested WebNN device was actually used (not silently fallen back to another device/WASM)
            const probeEp = probeResult.ep || '';
            const expectedDevice = this.webnnDeviceType || 'npu';
            if (!probeEp.includes(expectedDevice)) {
                // Model loaded but not on expected device — clean up and fall back to DML
                unloadWebnnModel(probeKey);
                console.warn(`[OnnxSVSPipeline] WebNN probe: ${expectedDevice.toUpperCase()} not usable, actually using ${probeEp}, falling back to DML/CPU`);
                // Cache the failure so next init skips WebNN detection entirely
                try {
                    const { markNPUUnavailable } = require('../../main/webnnIpc');
                    markNPUUnavailable(`WebNN probe: ${expectedDevice.toUpperCase()} not usable, fell back to ${probeEp}`);
                } catch (_) {}
                this.useWebNN = false;
                return await this._doInitFallback(gpuInfo, resolvedModelFiles, sessionKeys);
            }

            // WebNN device confirmed working — load remaining models in parallel
            this.sessions[probeKey] = new WebNNSessionProxy(probeKey);
            this.sessionEPs[probeKey] = probeEp;
            loadedSessions.push(probeKey);
            console.log(`[OnnxSVSPipeline] ${probeFile} loaded via WebNN-${(this.webnnDeviceType || 'npu').toUpperCase()} [${probeEp}]`);

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
                    throw new Error(`WebNN load ${modelFile} failed: ${result.error}`);
                }
            }

            // Vocoder 使用 DML 加载（NPU 不适合 vocoder 的大卷积核）
            // 跳过 DML 验证推理，避免 GPU 显存压力导致已加载的 WebNN 会话失效
            await this._loadVocoderViaDML(webnnModelFiles, vocoderIdx, loadedSessions);

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
    }

    /**
     * Vocoder DML 加载（WebNN 路径专用）：跳过验证推理，SiFiGAN 失败时回退默认 vocoder
     */
    async _loadVocoderViaDML(webnnModelFiles, vocoderIdx, loadedSessions) {
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
                    enableMemPattern: false,
                    executionMode: 'sequential',
                });
                return { session, ep: 'dml', vocFile };
            } catch (vocErr) {
                console.warn(`[OnnxSVSPipeline] Vocoder DML load failed (${vocFile}), falling back to CPU: ${vocErr.message}`);
                const session = await ort.InferenceSession.create(vocPath, {
                    executionProviders: ['cpu'],
                    executionMode: 'sequential',
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
                throw new Error(`Vocoder load failed: ${vocErr.message}`);
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
                throw new Error(`Vocoder load failed (SiFiGAN fallback also failed): ${defErr.message}`);
            }
        }
    }

    /**
     * DML/CPU 模型加载：小 Model 并行，大 Model 串行（分区加载）
     */
    async _loadDMLModels(resolvedModelFiles, sessionKeys, modelStats) {
        let loadedSessions = [];
        try {
            const modelSizes = new Map(modelStats.map((s, i) => [i, s.size]));
            loadedSessions = await this._loadModelsPartitioned(resolvedModelFiles, sessionKeys, modelSizes);
            const dmlCount = Object.values(this.sessionEPs).filter(e => e === 'dml').length;
            const cpuCount = Object.values(this.sessionEPs).filter(e => e === 'cpu').length;
            console.log(`[OnnxSVSPipeline] Init complete: ${dmlCount}  model(s) using DML, ${cpuCount}  model(s) using CPU`);
            if (this.sessions['vocoder']) await this._detectVocoderPrecision(this.sessions['vocoder'], this._getModelPath(this._resolvedVocoderFile || 'vocoder_dml.onnx'));
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
            this.gpuDeviceName = gpuInfo.name || 'No GPU (CPU only)';
        }
        console.log(`[OnnxSVSPipeline] Fallback to device: ${this.gpuDeviceName}${this.dmlDeviceId !== undefined ? ` (deviceId=${this.dmlDeviceId})` : ''}`);

        let loadedSessions = [];
        try {
            loadedSessions = await this._loadModelsPartitioned(resolvedModelFiles, sessionKeys);
            const dmlCount = Object.values(this.sessionEPs).filter(e => e === 'dml').length;
            const cpuCount = Object.values(this.sessionEPs).filter(e => e === 'cpu').length;
            console.log(`[OnnxSVSPipeline] Fallback init complete: ${dmlCount}  model(s) using DML, ${cpuCount}  model(s) using CPU`);
            if (this.sessions['vocoder']) await this._detectVocoderPrecision(this.sessions['vocoder'], this._getModelPath(this._resolvedVocoderFile || 'vocoder_dml.onnx'));
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
                    // 关键修复：同步 vocoderType -> default，防止后续合成按 sifigan 模式处理
                    // 但实际 session 是 default vocoder（参见 _loadDefaultVocoderAsFallback 注释）
                    if (this.vocoderType === 'sifigan') {
                        console.warn('[OnnxSVSPipeline] Syncing vocoderType sifigan -> default after SiFiGAN load failure');
                        this.vocoderType = 'default';
                    }
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

            // SiFiGAN 精度按文件名直接判断（与 _getSifiganDummyInputs 一致），避免文件大小阈值
            // 在 MLP 版本（33.7MB）等边界情况下误判 FP32 为 FP16。
            // - sifigan_vocoder_dml_fp16.onnx → FP16
            // - sifigan_vocoder_dml.onnx / sifigan_vocoder.onnx / sifigan_vocoder_dml_mlp.onnx → FP32
            if (isSifigan) {
                const vocFile = path.basename(modelPath);
                this.vocoderIsFP16 = vocFile === 'sifigan_vocoder_dml_fp16.onnx';
                console.log(`[OnnxSVSPipeline] SiFiGAN precision by filename: ${vocFile} -> vocoderIsFP16=${this.vocoderIsFP16}`);
                return;
            }

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

            // inputMetadata unavailable (DML) — detect from model file size (incl. external .data)
            // Default vocoder: FP16 ≈ 495 MB, FP32 ≈ 1004 MB → threshold 700 MB
            // SiFiGAN: FP16 ≈ 23 MB (0.3 graph + 22.7 data), FP32 ≈ 48 MB (0.3 graph + 47.7 data) → threshold 35 MB
            const sizeThresholdMB = isSifigan ? 35 : 700;
            if (modelPath) {
                try {
                    const fs = require('node:fs');
                    const stats = fs.statSync(modelPath);
                    let totalBytes = stats.size;
                    // 累加 external_data 文件大小 (SiFiGAN 使用 external_data 格式)
                    try { totalBytes += fs.statSync(modelPath + '.data').size; } catch (_) {}
                    const totalSizeMB = totalBytes / (1024 * 1024);
                    this.vocoderIsFP16 = totalSizeMB < sizeThresholdMB;
                    console.log(`[OnnxSVSPipeline] Vocoder file size: ${totalSizeMB.toFixed(1)} MB (threshold=${sizeThresholdMB} MB, sifigan=${isSifigan}) -> vocoderIsFP16=${this.vocoderIsFP16}`);
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
                console.log('[OnnxSVSPipeline] Vocoder accepts float16 -> vocoderIsFP16=true');
                return;
            } catch (_) {}

            try {
                const t32 = new ort.Tensor('float32', new Float32Array(PROBE_FRAMES * 128), [1, PROBE_FRAMES, 128]);
                await session.run(buildFeed(t32));
                this.vocoderIsFP16 = false;
                console.log('[OnnxSVSPipeline] Vocoder accepts float32 -> vocoderIsFP16=false');
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

    async _runVocoderChunked(melData, totalFrames, onChunkComplete = null) {
        // Vocoder is loaded via DML (dynamic shapes), never use static shape padding
        // SiFiGAN 双输入：传入 vocoderType、F0 序列、stats 缺失标志；default vocoder 仅用 mel
        const chunkFrames = this._resolveVocoderChunkFrames();

        // 一致性检测：vocoderType 与实际加载的 vocoder 文件必须匹配，否则 mel 处理模式
        // （sifigan 4× 上采样 + f0 输入 vs default 仅 mel）与 session 输入签名不匹配，
        // 会导致音质劣化 + 显存压力错误（sifigan 与 default 使用不同的常驻权重预算）。
        const expectedSifigan = this.vocoderType === 'sifigan';
        const actualIsSifigan = this._resolvedVocoderFile ? this._isSifiganVocoder(this._resolvedVocoderFile) : false;
        if (expectedSifigan !== actualIsSifigan) {
            console.warn(`[OnnxSVSPipeline] WARNING: vocoderType=${this.vocoderType} but loaded vocoder=${this._resolvedVocoderFile} (isSifigan=${actualIsSifigan}). This indicates a fallback occurred. Mel processing may be incorrect.`);
        }

        // 临时释放 diffStep session，让 vocoder 推理独占 GPU 显存。
        // 触发条件：DML 后端 + 用户开启 releaseDiffStepBeforeVocoder + diffStep 当前已加载。
        // 不释放 vocoder（马上要用），不释放 encoders（体积小）。
        // WebNN 路径跳过（diffStep 在渲染进程，与主进程 vocoder 互不抢占显存）。
        const releasedDiffStep = this._maybeUnloadDiffStepBeforeVocoder();
        if (releasedDiffStep) {
            // session.release() 是同步 API，但 DML 后端 GPU 资源回收是异步的，
            // diffStep 权重 + 32 步 diffusion 激活工作区合计 ~3-4GB，普通 gpuDrain(50ms) 远不够。
            // 必须用 gpuDrainLong(~800ms 分 4 轮 setTimeout) 让 DML 资源池完成回收 + V8 GC 跑完，
            // 否则紧接着的 vocoder 推理会因显存未释放而 OOM / 触发 0x887A0006 (TDR 黑屏)。
            console.log('[OnnxSVSPipeline] Waiting for DML to reclaim diffStep VRAM before vocoder...');
            const t0 = performance.now();
            await gpuDrainLong();
            console.log(`[OnnxSVSPipeline] DML drain complete (${(performance.now() - t0).toFixed(0)}ms), starting vocoder inference`);
        }

        try {
            return await this._postprocessing.runVocoderChunked(
                this.sessions, melData, totalFrames, this.vocoderIsFP16 ?? this.isFP16, false,
                this.vocoderType, this._currentF0Hz, this.sifiganStatsMissing, onChunkComplete, chunkFrames
            );
        } finally {
            // Vocoder 推理完成（或抛错）后立即重载 diffStep，保持 session 状态一致：
            // - 多 segment 合成的下一段需要 diffStep
            // - _recreateHeavySessionsAfterSynthesis 期望 diffStep 存在（否则会跳过 release）
            // - 用户关闭 releaseDmlVramAfterSynthesis 时，下次合成依赖 ensureAllModelsLoaded 检测缺失才重载
            //   会让用户感知到"下次合成变慢"，不如在这里主动重载
            if (releasedDiffStep) {
                await this._reloadDiffStepAfterVocoder();
            }
        }
    }

    /**
     * 在 vocoder 推理前临时释放 diffStep session（仅 DML 后端 + 用户开启时）。
     * 目的：腾出 diffStep 模型权重 + diffusion 32 步激活工作区（合计 ~3-4GB）的显存，
     * 避免 vocoder 推理时显存叠加触发 DXGI_ERROR_DEVICE_REMOVED (0x887A0006) / TDR。
     *
     * @returns {boolean} true 表示已释放（调用方需在 vocoder 完成后调用 _reloadDiffStepAfterVocoder）
     */
    _maybeUnloadDiffStepBeforeVocoder() {
        if (this.useWebNN) {
            console.log('[OnnxSVSPipeline] _maybeUnloadDiffStepBeforeVocoder: skip (useWebNN=true)');
            return false; // WebNN: diffStep 在渲染进程，无需释放
        }
        if (!this.sessions.diffStep) {
            console.log('[OnnxSVSPipeline] _maybeUnloadDiffStepBeforeVocoder: skip (sessions.diffStep missing)');
            return false; // 已释放或未加载，跳过
        }
        if (this.sessionEPs.diffStep !== 'dml') {
            console.log(`[OnnxSVSPipeline] _maybeUnloadDiffStepBeforeVocoder: skip (EP=${this.sessionEPs.diffStep}, not 'dml')`);
            return false; // CPU 后端无需释放
        }

        try {
            const { loadSettings } = require('../../main/settings');
            const settings = loadSettings();
            if (settings.releaseDiffStepBeforeVocoder !== true) {
                console.log(`[OnnxSVSPipeline] _maybeUnloadDiffStepBeforeVocoder: skip (settings.releaseDiffStepBeforeVocoder=${settings.releaseDiffStepBeforeVocoder})`);
                return false;
            }
        } catch (e) {
            console.log(`[OnnxSVSPipeline] _maybeUnloadDiffStepBeforeVocoder: skip (settings load failed: ${e.message})`);
            return false;
        }

        console.log('[OnnxSVSPipeline] Temporarily releasing diffStep session before vocoder inference to free VRAM...');
        try {
            if (typeof this.sessions.diffStep.release === 'function') {
                this.sessions.diffStep.release();
            }
        } catch (e) {
            console.warn('[OnnxSVSPipeline] Failed to release diffStep before vocoder:', e.message);
        }
        delete this.sessions.diffStep;
        delete this.sessionEPs.diffStep;
        return true;
    }

    /**
     * Vocoder 推理后重载 diffStep session。
     * 失败时不抛错（避免覆盖 vocoder 的成功结果），仅记录错误；
     * 下次合成时 ensureAllModelsLoaded 会检测缺失并尝试重载。
     */
    async _reloadDiffStepAfterVocoder() {
        if (this.sessions.diffStep) return; // 已重载或并发已加载
        console.log('[OnnxSVSPipeline] Reloading diffStep session after vocoder inference...');
        try {
            const result = await this.loadModel('diffStep');
            if (result.success) {
                console.log(`[OnnxSVSPipeline] diffStep reloaded [${result.ep || 'unknown'}]`);
            } else {
                console.error('[OnnxSVSPipeline] Failed to reload diffStep after vocoder:', result.error);
            }
        } catch (e) {
            console.error('[OnnxSVSPipeline] Exception reloading diffStep after vocoder:', e.message);
        }
    }

    /**
     * 依据当前设置（vocoderChunkMode: smart/manual）解析生效的 vocoder 分片帧数。
     * - smart: 复用启动时基于显存计算并缓存的值（不触发新的 GPU 探测）
     * - manual: 使用用户手动指定的帧数（clamp 到 [256, 2048]）
     *
     * vocoderType='sifigan' 时返回的 user-visible 帧数不再除以上采样倍率。
     * SiFiGAN 模型体积远小于 default vocoder（fp16: 23MB vs 519MB），
     * 虽有 4× mel 上采样但整体资源占用更低，因此可用更长的分片。
     * postprocessing.runVocoderChunked 内部会乘回 4 得到实际 mel 帧数。
     */
    _resolveVocoderChunkFrames() {
        try {
            const { loadSettings } = require('../../main/settings');
            const settings = loadSettings();
            // 传入当前模型精度 + vocoderType，smart 模式下按 vocoderType 使用独立的常驻权重与分档表
            return getEffectiveVocoderChunkFrames(settings.vocoderChunkMode, settings.vocoderChunkFrames, this._modelPrecision, this.vocoderType);
        } catch (e) {
            return 0; // 0 → 回退到 VOCODER_CHUNK_FRAMES 默认值
        }
    }

    async _runDiffusionLoop(xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, onProgress, progressStart, progressRange) {
        return this._diffusion.runDiffusionLoop(this.sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, this.isFP16, onProgress, progressStart, progressRange, this.useStaticShapes);
    }

    async _synthesizeSegment(segmentNotes, bpm, f0Envelope, pitchCurveF0, f0Shift, ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale, npuDiffBatchSize, npuVocoderBatchSize, onProgress, progressStart, progressRange, onChunkAudio = null, segStartBeat = 0) {
        // 多 segment 路径：segmentNotes.start 是相对 segStart，需要传 segStartBeat
        // 让 notesToSequences 正确索引绝对时间的 pitchCurveF0，否则 f0 错位 → 电流声。
        const pitchCurveOffsetSec = (segStartBeat / bpm) * 60;
        const sequences = this.notesToSequences(segmentNotes, bpm, f0Envelope, pitchCurveF0, f0Shift, pitchCurveOffsetSec);
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

        // NPU 静态形状模型限制：totalFramesWithPrompt 不能超过 NPU_STATIC_SEQ_LEN
        if (this.useStaticShapes && ptFrameCount + totalFrames > NPU_STATIC_SEQ_LEN) {
            const maxFrames = NPU_STATIC_SEQ_LEN - Math.min(ptFrameCount, 50);
            if (totalFrames > maxFrames) {
                console.warn(`[OnnxSVSPipeline] NPU frame limit: ${totalFrames} > ${maxFrames}, truncating`);
                sequences.f0Ids = sequences.f0Ids.subarray(0, maxFrames);
                sequences.mel2token = sequences.mel2token.subarray(0, maxFrames);
                totalFrames = maxFrames;
            }
        }

        // WebNN: encoder+diffusion in renderer, vocoder in main process (DML)
        // 渲染进程运行 encoder+diffusion 返回 mel；主进程 DML 运行 vocoder（支持 SiFiGAN 双输入）
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
            // Forward WebNN warnings (e.g. NPU static shape truncation)
            if (result.warnings && result.warnings.length > 0) {
                for (const w of result.warnings) console.warn(`[OnnxSVSPipeline] ${w}`);
            }
            // Cache F0 (Hz, mel frame rate=50Hz) for SiFiGAN dual-input vocoder
            this._currentF0Hz = sequences.f0Hz ? sequences.f0Hz.subarray(0, totalFrames) : null;
            // Vocoder 在主进程 DML 执行（支持 default + SiFiGAN）
            const audioData = await this._runVocoderChunked(result.xtData, totalFrames, onChunkAudio);
            const ms = performance.now() - t0;
            console.log(`[OnnxSVSPipeline] WebNN synthesis: ${totalFrames}frames, ${totalSteps}steps, ${ms.toFixed(0)}ms`);
            onProgress(Math.round(progressStart + progressRange));
            return { audio: audioData, frames: totalFrames };
        }

        const totalFramesWithPrompt = ptFrameCount + totalFrames;

        const combinedCond = await this._runEncoder(sequences, tokenCount, totalFrames, ptFrameCount);

        // GPU 排空点 1：encoder（6 次推理）→ diffusion 切换前等待 DML 回收 encoder 的 GPU 资源
        await gpuDrain();

        const xt = this.randomNoise(totalFrames, MEL_DIM);

        await this._runDiffusionLoop(xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, onProgress, progressStart, progressRange);

        // GPU 排空点 2：diffusion（64 次推理）→ vocoder 切换前等待 DML 回收 diffusion 的 GPU 资源。
        // 这是最关键的排空点：32 步 × 2 次 cond/uncond = 64 次连续 diff_step 推理后，
        // DML 内部资源池累积了大量 transformer 注意力中间张量，不排空直接进 vocoder 会 OOM。
        await gpuDrain();

        // Cache F0 (Hz, mel frame rate=50Hz) for SiFiGAN dual-input vocoder; truncated to totalFrames to match mel after NPU/MAX_SAFE truncation. null when unavailable.
        this._currentF0Hz = sequences.f0Hz ? sequences.f0Hz.subarray(0, totalFrames) : null;

        const audioData = await this._runVocoderChunked(xt.data, totalFrames);

        return { audio: audioData, frames: totalFrames };
    }

    /**
     * 在渲染进程中运行 encoder+diffusion（WebNN 优化路径）
     * Vocoder 由主进程 DML 执行（支持 SiFiGAN 双输入），渲染进程仅返回 mel
     */
    async _runWebNNSynthesis(params, onProgress) {
        const wc = getMainWindowWebContents();
        if (!wc) throw new Error('No renderer window for WebNN synthesis');

        // Vocoder 由主进程 DML 执行（支持 SiFiGAN 双输入），渲染进程仅运行 encoder+diffusion
        const fullParams = {
            ...params,
            isFP16: this.isFP16,
            vocoderIsFP16: this.vocoderIsFP16 ?? this.isFP16,
            useStaticShapes: this.useStaticShapes,
            vocoderChunkFrames: this._resolveVocoderChunkFrames(),
            skipVocoder: true,
        };
        return requestSynthesis(wc, fullParams, onProgress);
    }

    /**
     * 批量合成两个片段（WebNN batch=4: 2 片段 × 2 CFG）
     * @param {number} f0ShiftA - segment A 的 f0Shift（per-segment，B2）
     * @param {number} f0ShiftB - segment B 的 f0Shift（per-segment，B2）
     */
    async _synthesizeSegmentPair(segANotes, segBNotes, bpm, f0Envelope, pitchCurveF0, f0ShiftA, f0ShiftB, ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale, npuDiffBatchSize, npuVocoderBatchSize, onProgress, progressStart, progressRange, segAStartBeat = 0, segBStartBeat = 0) {
        // 多 segment 路径：传 segStartBeat 让 notesToSequences 正确索引绝对 pitchCurveF0
        const offsetA = (segAStartBeat / bpm) * 60;
        const offsetB = (segBStartBeat / bpm) * 60;
        const seqA = this.notesToSequences(segANotes, bpm, f0Envelope, pitchCurveF0, f0ShiftA, offsetA);
        const seqB = this.notesToSequences(segBNotes, bpm, f0Envelope, pitchCurveF0, f0ShiftB, offsetB);

        const framesA = seqA.f0Ids.length;
        const framesB = seqB.f0Ids.length;

        if (framesA === 0 && framesB === 0) return [{ audio: [], frames: 0 }, { audio: [], frames: 0 }];
        if (framesA === 0) return [{ audio: [], frames: 0 }, await this._synthesizeSegment(segBNotes, bpm, f0Envelope, pitchCurveF0, f0ShiftB, ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale, npuDiffBatchSize, npuVocoderBatchSize, onProgress, progressStart, progressRange, null, segBStartBeat)];
        if (framesB === 0) return [await this._synthesizeSegment(segANotes, bpm, f0Envelope, pitchCurveF0, f0ShiftA, ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale, npuDiffBatchSize, npuVocoderBatchSize, onProgress, progressStart, progressRange, null, segAStartBeat), { audio: [], frames: 0 }];

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

        // Vocoder 在主进程 DML 执行（支持 default + SiFiGAN）：各 segment 独立设置 f0Hz
        // Forward WebNN warnings (e.g. NPU static shape truncation) from batch results
        for (const r of results) {
            if (r.warnings && r.warnings.length > 0) {
                for (const w of r.warnings) console.warn(`[OnnxSVSPipeline] ${w}`);
            }
        }
        const audioResults = [];
        for (let si = 0; si < results.length; si++) {
            const r = results[si];
            const seq = si === 0 ? seqA : seqB;
            this._currentF0Hz = seq.f0Hz ? seq.f0Hz.subarray(0, r.totalFrames) : null;
            const audioData = await this._runVocoderChunked(r.xtData, r.totalFrames, null);
            audioResults.push({ audio: audioData, frames: r.totalFrames });
        }
        return audioResults;
    }

    /**
     * 批量 WebNN 合成 IPC 调用（encoder+diffusion），vocoder 由主进程 DML 执行
     */
    async _runWebNNSynthesisBatch(paramsArray, onProgress) {
        const wc = getMainWindowWebContents();
        if (!wc) throw new Error('No renderer window for WebNN batch synthesis');

        // Vocoder 由主进程 DML 执行（支持 SiFiGAN 双输入），渲染进程仅运行 encoder+diffusion
        const fullParams = paramsArray.map(p => ({
            ...p,
            isFP16: this.isFP16,
            vocoderIsFP16: this.vocoderIsFP16 ?? this.isFP16,
            useStaticShapes: this.useStaticShapes,
            vocoderChunkFrames: this._resolveVocoderChunkFrames(),
            skipVocoder: true,
        }));
        return requestSynthesis(wc, fullParams, onProgress, {
            timeoutMessage: 'WebNN batch synthesis timeout',
        });
    }

    async synthesize(notes, bpm, options = {}) {
        // 串行化：防止并发 synthesize() 调用导致的 session 重建竞态（见 _synthPromise 注释）。
        // 复用 _initPromise 模式：await 上一条合成（含 _recreateHeavySessionsAfterSynthesis）
        // 完全结束后再启动本条。
        if (this._synthPromise) {
            try { await this._synthPromise; } catch (_) {}
        }
        this._synthPromise = this._synthesizeImpl(notes, bpm, options);
        try {
            return await this._synthPromise;
        } finally {
            this._synthPromise = null;
        }
    }

    async _synthesizeImpl(notes, bpm, options = {}) {
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
        const onChunkAudio = options.onChunkAudio || null;

        const filledNotes = this._fillNoteGaps(notes);

        const cacheKey = this._computeSynthCacheKey(notes, bpm, options);
        const cachedAudio = this._synthCacheGet(cacheKey);
        if (cachedAudio) {
            onProgress(100);
            return cachedAudio;
        }

        let currentProgress = 0;
        onProgress(currentProgress);

        // targetNotePitches 在 autoShift 与手动 pitchShift 两种模式下都需要：
        // JP pitch 范围保护（_clampJpPitchRange）无论 autoShift 是否启用都生效，
        // 因此提前在外层作用域计算，避免 "targetNotePitches is not defined"。
        const targetNotePitches = [];
        for (const note of filledNotes) {
            if (note.pitch >= 1) targetNotePitches.push(note.pitch);
        }

        let f0Shift = 0;
        if (autoShift && pitchShift === 0) {
            const targetF0 = this.buildF0FrameSequence(filledNotes, bpm, f0Envelope, pitchCurveF0);
            const targetNonZero = [];
            for (let i = 0; i < targetF0.length; i++) {
                if (targetF0[i] > 0) targetNonZero.push(targetF0[i]);
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
                    const refNotePitches = await this._extractRefNotePitchesAsync(refAudioWavBuffer);
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

            // 限制 f0Shift 范围，防止偏移后音高超出模型/vocoder 训练分布导致 OOD。
            // 根因：autoShift 基于全局中位数计算单一 f0Shift，当分片内音高跨度大时，
            //   极端音符偏移后会超出 vocoder f0 有效范围（SiFiGAN 对 f0 敏感，过高
            //   导致激励畸变→口齿不清）或 encoder pitch embedding 训练范围。
            const clampedShift = this._clampAutoShift(f0Shift, targetNotePitches);
            if (clampedShift !== f0Shift) {
                console.log(`[OnnxSVSPipeline] autoShift clamped: ${f0Shift} → ${clampedShift}`);
                f0Shift = clampedShift;
            }
        } else {
            f0Shift = pitchShift;
        }

        // JP pitch 范围保护：无论 autoShift 还是手动 pitchShift 都生效。
        // 根因：JSUT 训练数据全部 pitch=60，JP 专属模块（cond_emb/diff_step/preflow）
        // 只在有限 pitch 范围微调，OOD pitch → cond_embedding 异常 → 音素错乱。
        // 即使 f0Shift=0，如果音符本身超出 [48,84] 也需要 auto-transpose。
        if (this.languageOverride === 'ja' && targetNotePitches && targetNotePitches.length > 0) {
            const jpClamped = this._clampJpPitchRange(f0Shift, targetNotePitches);
            if (jpClamped !== f0Shift) {
                console.log(`[OnnxSVSPipeline] JP pitch range clamped: ${f0Shift} → ${jpClamped} (effective pitch kept in [48,84])`);
                f0Shift = jpClamped;
            }
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
                    const melResult = await this._extractRefMelAsync(refAudioWavBuffer);
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
            let segNotes = seg.notes || filledNotes;

            // 单 note 上下文 padding：单 note 时 fillNoteGaps 不补 rest，导致 token 序列极短
            // （仅 [PAD,BOW,ph,EOW]）、noteTypeSeq 单一、mel2token 无 PAD 静音参考帧。
            // 这对 diffusion/preflow 是 OOD 输入，合成质量差（"意义不明的声音"）。
            // 修复：单 note 时在前后各加 1 拍 rest note，提供 token 多样性与静音参考帧，
            // 合成后截取有效音频。
            let contextPadding = null;
            let pitchCurveOffsetSec = 0;
            if (segNotes.length === 1) {
                const REST_BEATS = 1;
                const originalNote = segNotes[0];
                const restNote = { lyric: '', pitch: 0, start: 0, duration: REST_BEATS };
                const shiftedNote = { ...originalNote, start: REST_BEATS };
                const tailRest = { lyric: '', pitch: 0, start: REST_BEATS + originalNote.duration, duration: REST_BEATS };
                segNotes = [restNote, shiftedNote, tailRest];
                const restFrames = Math.floor((REST_BEATS / bpm) * 60 * SAMPLE_RATE / HOP_SIZE);
                const validFrames = Math.floor((originalNote.duration / bpm) * 60 * SAMPLE_RATE / HOP_SIZE);
                contextPadding = { offsetFrames: restFrames, validFrames };
                // 修复：context padding 将 note 的 start 偏移到 REST_BEATS，需要补偿 pitchCurveOffsetSec
                // 让 notesToSequences 正确索引绝对时间的 pitchCurveF0，否则 f0 错位 → 沙哑声音。
                pitchCurveOffsetSec = ((originalNote.start - REST_BEATS) / bpm) * 60;
                console.log(`[OnnxSVSPipeline] Single-note context padding: +${restFrames} rest frames before/after`);
            }

            const sequences = this.notesToSequences(segNotes, bpm, f0Envelope, pitchCurveF0, f0Shift, pitchCurveOffsetSec);
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
            // GPU 排空点：encoder→diffusion 切换前等待 DML 回收 encoder 的 GPU 资源
            await gpuDrain();
            const xt = this.randomNoise(totalFrames, MEL_DIM);

            await this._runDiffusionLoop(xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, onProgress, 40, 50);

            // GPU 排空点：diffusion（64 次推理）→ vocoder 切换前等待 DML 回收 GPU 资源
            await gpuDrain();

            onProgress(90);
            this._currentF0Hz = sequences.f0Hz ? sequences.f0Hz.subarray(0, totalFrames) : null;
            // 单 segment 路径流式推送：仅在没有 contextPadding 截取时启用，避免 totalSamples 不一致
            const singleSegOnChunk = onChunkAudio && !contextPadding ? onChunkAudio : null;
            let audioData = await this._runVocoderChunked(xt.data, totalFrames, singleSegOnChunk);

            // 单 note 上下文 padding：截取有效音频（丢弃前后 rest padding）
            // 注意：外部 totalFrames 始终是 50Hz 帧数（SVS mel 帧率），
            // 即使 SiFiGAN 内部已 4× 上采样，postprocessing 也已统一回 HOP_SIZE 输出长度，
            // 因此这里固定用 HOP_SIZE（480 samples/帧）计算采样位置。
            if (contextPadding) {
                const startSample = contextPadding.offsetFrames * HOP_SIZE;
                const validSamples = contextPadding.validFrames * HOP_SIZE;
                const endSample = Math.min(startSample + validSamples, audioData.length);
                audioData = audioData.subarray(startSample, endSample);
            }

            const MAX_CACHE_SAMPLES = SAMPLE_RATE * 120; // 2 分钟
            if (audioData.length <= MAX_CACHE_SAMPLES) {
                this._synthCachePut(cacheKey, audioData);
                console.log('[OnnxSVSPipeline] Audio cached (LRU entries=' +
                    (this._synthCacheMap ? this._synthCacheMap.size : 0) + ')');
            }

            onProgress(100);
            // 合成完成后重建重型 DML session，释放内存池，防止连续推理 OOM
            await this._recreateHeavySessionsAfterSynthesis();
            return audioData;
        }

        const totalBeats = filledNotes.length > 0
            ? Math.max(...filledNotes.map(n => n.start + n.duration))
            : 0;
        const totalSamples = Math.floor((totalBeats / bpm) * 60 * SAMPLE_RATE);
        const finalAudio = new Float32Array(totalSamples);
        const weightSum = new Float32Array(totalSamples);

        // Prompt mel 帧数：与单 segment 路径 (index.js:1645) 保持一致，按总帧数 10% 计算，
        // 上限 50 帧、下限 10 帧。旧版多 segment 路径恒为 10 帧，导致长音频（无 ref audio）
        // 扩散 conditioning 信号弱，音色稳定性与发音清晰度下降。
        if (!ptMelData || ptFrameCount === 0) {
            const totalFramesEst = Math.floor(totalSamples / HOP_SIZE);
            ptFrameCount = Math.min(50, Math.max(10, Math.floor(totalFramesEst * 0.1)));
            ptMelData = new Float32Array(ptFrameCount * MEL_DIM);
        }

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

        // Per-segment f0Shift (B2): autoShift 基于全局中位数计算单一 f0Shift，对"主歌低音+
        // 副歌高音"的宽音域片段，单一偏移使主歌偏低/副歌偏高，参考音色匹配度差。
        // 多 segment 路径按各 segment 音符中位数相对全局中位数的偏差调整 f0Shift，使每段
        // 中位数都向参考中位数靠拢。调整量上限 ±5 半音，避免段边界处 f0Shift 跳变过大
        // （相邻段最大差 10 半音，由 SEGMENT_OVERLAP_SEC crossfade 平滑过渡）。
        // 仅在 autoShift 启用且多 segment 时生效；pitchShift 模式（用户指定固定偏移）不改。
        const perSegAutoShift = autoShift && pitchShift === 0 && segments.length > 1;
        const globalNotePitches = perSegAutoShift
            ? filledNotes.filter(n => n.pitch >= 1).map(n => n.pitch)
            : [];
        const globalTargetMedian = globalNotePitches.length > 0 ? this._median(globalNotePitches) : null;

        // 多 segment 路径修复：若 segment 0 的第一个 note 不在 segStartBeat（=0）处开始，
        // 前置一个休止符，使生成的 audio 覆盖从 beat 0 到 endBeat 的完整区间。
        // 否则 segment 0 的 audio 从 notes[0].start 开始但被放置在 finalAudio[0]，
        // 造成左移 firstNoteStart 拍 → 与后续 segment 的 crossfade 时间错位 → 沙哑。
        if (segments.length > 0 && segments[0].notes.length > 0 && segments[0].notes[0].start > 0.01) {
            const firstSeg = segments[0];
            firstSeg.notes.unshift({
                lyric: '',
                pitch: 0,
                start: 0,
                duration: firstSeg.notes[0].start,
            });
            console.log(`[OnnxSVSPipeline] Segment 0 leading rest prepended: ${firstSeg.notes[0].duration.toFixed(2)} beats`);
        }

        while (segIdx < segments.length) {
            // 段间 GPU 排空：让事件循环处理 GC 并给 DML 50ms 时间回收上一段的
            // 中间张量（mel/f0/waveform/transformer 注意力），降低长音频多段合成时
            // VRAM 碎片累积导致的 OOM 风险。旧版 setImmediate(~1ms) 不够 DML 回收。
            // 首次迭代前 yield 无副作用（仅多一次事件循环调度）。
            if (segIdx > 0) {
                await gpuDrain();
            }

            if (useBatch && segIdx + 1 < segments.length) {
                // Pair two segments for batch=4 diffusion
                const segA = segments[segIdx];
                const segB = segments[segIdx + 1];
                const pairProgressStart = 10 + segIdx * progressPerSegment;
                const pairProgressRange = progressPerSegment * 2 * 0.9;

                onProgress(Math.round(pairProgressStart));

                // Per-segment f0Shift (B2): 各 segment 独立计算偏移
                const f0ShiftA = this._computeSegF0Shift(f0Shift, globalTargetMedian, segA.notes);
                const f0ShiftB = this._computeSegF0Shift(f0Shift, globalTargetMedian, segB.notes);

                const pairResult = await this._synthesizeSegmentPair(
                    segA.notes, segB.notes, bpm, f0Envelope, pitchCurveF0, f0ShiftA, f0ShiftB,
                    ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale,
                    npuDiffBatchSize, npuVocoderBatchSize,
                    onProgress, pairProgressStart, pairProgressRange,
                    segA.startBeat, segB.startBeat
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

                // GPU 排空点 3：多 segment 之间等待 DML 回收上段 vocoder 的 GPU 资源
                if (segIdx < segments.length - 1) await gpuDrain();
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

            // Per-segment f0Shift (B2): 该 segment 独立计算偏移
            const segF0Shift = this._computeSegF0Shift(f0Shift, globalTargetMedian, seg.notes);

            const segResult = await this._synthesizeSegment(
                seg.notes, bpm, f0Envelope, pitchCurveF0, segF0Shift,
                ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale,
                npuDiffBatchSize, npuVocoderBatchSize,
                onProgress, segProgressStart, segProgressRange,
                null, seg.startBeat
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
            // GPU 排空点 3：多 segment 之间等待 DML 回收上段 vocoder 的 GPU 资源
            if (segIdx < segments.length - 1) await gpuDrain();
            segIdx++;
        }

        for (let i = 0; i < totalSamples; i++) {
            if (weightSum[i] > 1e-8) {
                finalAudio[i] /= weightSum[i];
            }
        }

        normalizePeakTo(finalAudio, totalSamples);

        // 多 segment 路径修复：截取从 filledNotes[0].start 开始的紧致 buffer，
        // 使返回值语义与单 segment 一致（audioData[0] ↔ notes[0].start 的音频）。
        // 这样主页面 playAll / exportAll 的 startSample 偏移同时兼容两条路径。
        // （segment 0 的前置休止符已确保 crossfade 在 finalAudio 内正确对齐）
        const firstNoteStartSample = Math.floor((filledNotes[0].start / bpm) * 60 * SAMPLE_RATE);
        const audioData = firstNoteStartSample > 0
            ? finalAudio.subarray(firstNoteStartSample)
            : finalAudio;
        const MAX_CACHE_SAMPLES = SAMPLE_RATE * 120;
        if (audioData.length <= MAX_CACHE_SAMPLES) {
            this._synthCachePut(cacheKey, audioData);
            console.log('[OnnxSVSPipeline] Audio cached (LRU entries=' +
                (this._synthCacheMap ? this._synthCacheMap.size : 0) + ')');
        }

        onProgress(100);
        // 合成完成后重建重型 DML session，释放内存池，防止连续推理 OOM
        await this._recreateHeavySessionsAfterSynthesis();
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
            gpuDeviceName: this.gpuDeviceName || 'No GPU (CPU only)',
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
        } else if (modelFile === 'sifigan_vocoder_dml_fp16.onnx' || modelFile === 'sifigan_vocoder_dml.onnx' || modelFile === 'sifigan_vocoder.onnx') {
            // SiFiGAN 回退（与 _resolveVocoderFile 保持一致）:
            // 优先用户选择的精度变体 → 另一精度变体 → sifigan_vocoder.onnx → 默认 vocoder
            // 通过 _getModelPath 兜底 baseModelDir（sifigan 文件不随主模型精度转换）
            const sifiganFp16Path = this._getModelPath('sifigan_vocoder_dml_fp16.onnx');
            const sifiganDmlPath = this._getModelPath('sifigan_vocoder_dml.onnx');
            const sifiganPlainPath = this._getModelPath('sifigan_vocoder.onnx');
            let sifiganFp16Exists = false, sifiganDmlExists = false, sifiganPlainExists = false;
            try { await fs.promises.access(sifiganFp16Path); sifiganFp16Exists = true; } catch (_) {}
            try { await fs.promises.access(sifiganDmlPath); sifiganDmlExists = true; } catch (_) {}
            try { await fs.promises.access(sifiganPlainPath); sifiganPlainExists = true; } catch (_) {}
            const preferFp16 = this.sifiganPrecision === 'fp16';
            if (preferFp16 && sifiganFp16Exists) {
                resolvedFile = 'sifigan_vocoder_dml_fp16.onnx';
            } else if (!preferFp16 && sifiganDmlExists) {
                resolvedFile = 'sifigan_vocoder_dml.onnx';
            } else if (sifiganFp16Exists) {
                resolvedFile = 'sifigan_vocoder_dml_fp16.onnx';
            } else if (sifiganDmlExists) {
                resolvedFile = 'sifigan_vocoder_dml.onnx';
            } else if (sifiganPlainExists) {
                resolvedFile = 'sifigan_vocoder.onnx';
            } else {
                console.warn('[OnnxSVSPipeline] sifigan model missing, falling back to default vocoder');
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

    /**
     * 合成完成后重建重型 DML session，强制释放 DirectML 内存池。
     * DML 后端没有显式的内存池 shrink API，同一个 session 连续推理时
     * 中间张量缓存会累积在 GPU 中。通过 release + reload 最大的两个模型
     * （diffStep、vocoder），让 DML 回收这些内存池，避免第二次推理 OOM。
     */
    async _recreateHeavySessionsAfterSynthesis() {
        // 仅 DML 后端且用户显式开启时才执行；CPU/WebNN 不执行，默认关闭
        if (this.useWebNN) return;
        try {
            const { loadSettings } = require('../../main/settings');
            const settings = loadSettings();
            if (settings.releaseDmlVramAfterSynthesis !== true) return;
        } catch (_) {
            return;
        }

        const heavyKeys = ['diffStep', 'vocoder'];
        let recreated = 0;
        for (const key of heavyKeys) {
            if (!this.sessions[key] || this.sessionEPs[key] !== 'dml') continue;

            console.log(`[OnnxSVSPipeline] Recreating ${key} session to release DML memory pool...`);
            try {
                if (typeof this.sessions[key].release === 'function') {
                    this.sessions[key].release();
                }
            } catch (e) {
                console.warn(`[OnnxSVSPipeline] Failed to release ${key} before recreate:`, e.message);
            }
            delete this.sessions[key];
            delete this.sessionEPs[key];

            try {
                const result = await this.loadModel(key);
                if (result.success) {
                    recreated++;
                    console.log(`[OnnxSVSPipeline] ${key} recreated [${result.ep || 'unknown'}]`);
                } else {
                    console.error(`[OnnxSVSPipeline] Failed to recreate ${key}:`, result.error);
                }
            } catch (e) {
                console.error(`[OnnxSVSPipeline] Exception recreating ${key}:`, e.message);
            }
        }
        if (recreated > 0) {
            console.log(`[OnnxSVSPipeline] Recreated ${recreated} heavy DML session(s) to release VRAM`);
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
        this._synthPromise = null;
        this._synthCache = null;
        this._synthCacheMap = null;
        this._synthCacheBytes = 0;
        this._currentF0Hz = null;
        console.log('[OnnxSVSPipeline] ONNX Runtime sessions released');
    }
}

module.exports = { OnnxSVSPipeline, NativeSVSPipeline: OnnxSVSPipeline, SAMPLE_RATE, enumerateDMLDevices };
