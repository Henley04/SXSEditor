const path = require('node:path');
const fs = require('node:fs');

// Side effect: apply float16 patch on module load
require('./float16Patch');

const { SAMPLE_RATE, HOP_SIZE, MEL_DIM, EMBED_DIM, COND_DIM, ONNX_MODEL_FILES, SIFIGAN_STATS_FILE, CFG_STRENGTH, CFG_RESCALE, DEFAULT_DIFF_STEPS, SEGMENT_OVERLAP_SEC, MAX_SAFE_FRAMES, NPU_STATIC_SEQ_LEN } = require('./constants');
const { getMainWindowWebContents, classifyDevice, enumerateDMLDevices, detectBestGPU, createSessionWithValidation, WebNNSessionProxy, DUMMY_TEST_INPUTS_FP32, DUMMY_TEST_INPUTS_FP16 } = require('./modelLoader');
const { buildSessionOptions } = require('../shared/ortOptions');
const { TextProcessing } = require('./textProcessing');
const { Preprocessing } = require('./preprocessing');
const { Diffusion } = require('./diffusion');
const { DEFAULT_SOLVER } = require('./samplers');
const { wsolaCrossfadeMel } = require('./wsola');
const { Postprocessing, parseWavBuffer, resampleLinear, extractMelSpectrogram, isVramOOMError } = require('./postprocessing');
const { AudioSegmentation } = require('./audioSegmentation');
const { createFloatTensor, outputToFloat32, normalizePeakTo, gpuDrainAdaptive, gpuDrainLong, markGpuOom, throwIfCancelled, cancelledError } = require('./utils');
const { requestModelLoad, requestSynthesis } = require('./webnnIpc');
const { getEffectiveVocoderChunkFrames } = require('../../main/gpuInfo');

/**
 * Read diagnosticMode flag lazily from settings. Returns false if settings
 * cannot be loaded (e.g. running outside Electron main process, in tests).
 * Used to gate [DiffusionDiag] / [VocoderDiag] statistical console.log
 * blocks; NaN/Inf fatal console.error is always-on regardless of this flag.
 * @returns {boolean}
 */
function _readDiagnosticMode() {
    try {
        const { loadSettings } = require('../../main/settings');
        return loadSettings().diagnosticMode === true;
    } catch (_) {
        return false;
    }
}

// Mel frame rate (Hz) = sample_rate / hop_size; used for chunk time calculation
const MEL_FRAME_RATE = SAMPLE_RATE / HOP_SIZE;

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

// Module-level dynamic release flag for diffStep-before-vocoder.
// Set to true when a vocoder inference throws isVramOOMError; the next
// _maybeUnloadDiffStepBeforeVocoder call will then return true (release)
// regardless of the user setting, and the flag is cleared after that
// segment completes. This avoids imposing the 1-3s/segment reload tax on
// all users while still recovering from rare OOM events.
let _dynamicReleaseDiffStepNextSegment = false;

class OnnxSVSPipeline {
    constructor(modelDir, options = {}) {
        this.baseModelDir = modelDir; // Base dir before precision subdir (for shared models)
        this._modelPrecision = options.modelPrecision || null;
        this.modelDir = this._resolveModelDir(modelDir, options.modelPrecision);
        this.languageOverride = options.languageOverride || null; // 'ja' for Japanese
        this._japaneseVocalization = options.japaneseVocalization || 'hybrid';
        this.jpModelDir = this._resolveJpModelDir(modelDir, options.modelPrecision);
        this.sessions = {};
        this.sessionEPs = {};
        // ===== Three-tier precision separation =====
        // SVS 模型按精度管理分为三类（见 modelManager.js 的 BASE_SVS_MODEL_FILES /
        // DIFF_STEP_MODEL_FILES / VOCODER_MODEL_FILES）：
        //   1. baseModelsIsFP16: 7 个基础模型共用（probe preflow 检测）
        //      - note_text_encoder / note_pitch_encoder / note_type_encoder / f0_encoder
        //      - preflow / cond_emb / mel_transform
        //   2. diffStepIsFP16: diff_step 独立精度（W16A32 回退 FP32 时与 base 不同）
        //   3. vocoderIsFP16: vocoder 独立精度（由 vocoder 文件类型/大小检测）
        // 三者互不影响，分别跟踪。`isFP16` 为 `baseModelsIsFP16` 的历史别名，
        // 保留以兼容外部引用（cli.js / webnn / tests 等）。
        this.isFP16 = false; // 基础模型精度（历史字段名，等同 baseModelsIsFP16）
        this.diffStepIsFP16 = false; // diff_step 独立精度（可能与 isFP16 不同，如 W16A32 回退到 FP32 时）
        this.vocoderIsFP16 = false; // vocoder 独立精度（由 vocoder 文件类型/大小检测，与 isFP16 解耦）
        // QDIT 量化 diff_step（int8 新模型）签名标志：x/diffusion_step/x_mask(bool)。
        // 供 svsWorker snapshot / 渲染进程弹窗提示使用。
        this.diffStepIsQDIT = false; // 当前 diff_step 是否为 QDIT 新模型
        this.diffStepLegacyInt8Incompatible = false; // int8 目录下检测到旧模型（cond≠1024）时置 true
        this.gpuDeviceName = '';
        this.dmlDeviceId = undefined;
        this.initialized = false;
        this.userDeviceId = options.deviceId;
        this.preferredDeviceType = options.preferredDeviceType || null;
        this.inferenceProvider = options.inferenceProvider || 'ortnode';
        this.webnnDeviceType = null; // 'npu' | 'gpu'，仅当 useWebNN 时有效
        this.useWebNN = false;
        // int8 与 int8-npu 均为静态形状模型：QDIT 量化版本维度固定为 NPU_STATIC_SEQ_LEN，
        // 因此分段长度必须固定（禁用动态分块与动态序列），否则 diffstep 会因输入维度不匹配报错。
        this.useStaticShapes = options.modelPrecision === 'int8' || options.modelPrecision === 'int8-npu';
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
        // 分片级 LRU 缓存：长音频多 segment 合成时，未改动 segment 直接复用缓存音频，
        // 只对改动 segment 重算 diffusion+vocoder。与 _synthCacheMap 独立（粒度更细），
        // 在 _synthCacheMap MISS 后才查询，命中即跳过该 segment 的推理。
        this._segCacheMap = null;                // Map<key, {audio, size}>，按插入顺序天然 LRU
        this._segCacheMaxEntries = 32;           // 单 segment ≤30s≈2.88MB，32 条 ≈ 92MB
        this._segCacheMaxBytes = 300 * 1024 * 1024; // 最大缓存字节数（300MB）
        this._segCacheBytes = 0;                 // 当前分片缓存占用字节数
        // Streaming chunk cache. Entries are committed immediately after each
        // diffusion+vocoder chunk, so cancellation does not discard completed work.
        this._chunkCacheMap = null;              // Map<key, {audio, mel, ranges, size}>
        this._chunkCacheMaxEntries = 128;
        this._chunkCacheMaxBytes = 384 * 1024 * 1024;
        this._chunkCacheBytes = 0;
        // One-entry whole-stream cache: avoids repeating region preparation, encoders,
        // diffusion and vocoder work on immediate replay. Chunk copies are retained so
        // cached playback preserves the same streaming timing/event contract.
        this._multiStreamResultCache = null;
        this._initPromise = null;
        // 合成串行化锁：防止连续两次 synthesize() 调用并发。
        // 场景：合成 A 完成 → _recreateHeavySessionsAfterSynthesis() 释放 diffStep/vocoder
        // 并开始 reload；合成 B 启动 → ensureAllModelsLoaded() 发现 diffStep 缺失也尝试 reload。
        // 两个 reload 并发加载同一大模型（diffStep 846MB）→ 显存翻倍 → OOM。
        // _synthPromise 将 synthesize 串行化，B 等 A 完全结束（含 session 重建）才启动。
        this._synthPromise = null;

        // Initialize sub-modules
        this._textProcessing = new TextProcessing({ japaneseVocalization: this._japaneseVocalization });
        this.phone2idx = this._textProcessing.phone2idx;
        this.enG2pDict = this._textProcessing.enG2pDict;
        this._preprocessing = new Preprocessing(this._textProcessing);
        this._diffusion = new Diffusion();
        this._postprocessing = new Postprocessing();
        this._audioSegmentation = new AudioSegmentation();
    }

    /**
     * 基础模型精度（baseModelsIsFP16）的读写访问器。
     * 内部与 `this.isFP16` 保持同步 —— `isFP16` 是历史字段名，保留以兼容外部
     * 引用（cli.js / webnn/index.js / tests）；新代码推荐使用 `baseModelsIsFP16`
     * 以明确语义：该标志只代表 7 个基础模型（probe preflow）的精度，与
     * diffStepIsFP16 / vocoderIsFP16 相互独立。
     */
    get baseModelsIsFP16() {
        return this.isFP16;
    }

    set baseModelsIsFP16(value) {
        this.isFP16 = !!value;
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

            // Resolve actual file to load (int8 优先 QDIT diffstep.onnx，
            // 其余处理 diff_step_dml → diff_step fallback)
            let resolvedFile = file;
            if (file === 'diff_step_dml.onnx') {
                resolvedFile = await this._resolveDiffStepFile();
                const dmlPath = this._getModelPath(resolvedFile);
                console.log(`[OnnxSVSPipeline] Loading diff_step from: ${dmlPath}, isFP16=${this.isFP16}, dmlDeviceId=${this.dmlDeviceId}`);
                // Check file size for diagnostic
                try {
                    const stat = await fs.promises.stat(dmlPath);
                    console.log(`[OnnxSVSPipeline] ${resolvedFile} file size: ${(stat.size / 1024 / 1024).toFixed(1)} MB`);
                } catch (_) {}
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
                // diff_step W16A32 回退（与 _loadModelsPartitioned / loadModel 一致）
                if (key === 'diffStep' && this.baseModelDir && this.modelDir !== this.baseModelDir) {
                    console.warn(`[OnnxSVSPipeline] diff_step swap failed, trying FP32 from ${this.baseModelDir}: ${err.message.substring(0, 80)}`);
                    const fp32Path = path.join(this.baseModelDir, resolvedFile);
                    let fp32Exists = false;
                    try { await fs.promises.access(fp32Path); fp32Exists = true; } catch (_) {}
                    if (fp32Exists) {
                        const { session, ep } = await createSessionWithValidation(
                            fp32Path, key, this.gpuDeviceName, this.dmlDeviceId, false, false
                        );
                        this.sessions[key] = session;
                        this.sessionEPs[key] = ep;
                        console.log(`[OnnxSVSPipeline] diff_step FP32 swapped from baseModelDir [${ep}] (W16A32 fallback)`);
                    } else {
                        throw err;
                    }
                } else {
                    console.error(`[OnnxSVSPipeline] Failed to swap ${resolvedFile}:`, err.message);
                    throw err;
                }
            }
            // 语言切换后重新检测 diff_step 精度
            if (key === 'diffStep') this._detectDiffStepPrecision();
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
    _splitLongRestRegions(notes, bpm) { return this._audioSegmentation.splitLongRestRegions(notes, bpm); }
    _hashArray(arr) { return this._audioSegmentation.hashArray(arr); }
    _computeSynthCacheKey(notes, bpm, options) { return this._audioSegmentation.computeSynthCacheKey(notes, bpm, options, this.interpolateEnvelope.bind(this)); }
    _computeSegmentCacheKey(segNotes, bpm, options, segStartBeat, segF0Shift, ptFrameCount) { return this._audioSegmentation.computeSegmentCacheKey(segNotes, bpm, options, segStartBeat, segF0Shift, ptFrameCount); }
    _median(arr) { return this._audioSegmentation.median(arr); }

    /**
     * Diffusion can produce non-zero rest mel even with pitch/F0=0. Vocos then
     * turns that mel into hiss or breath-like noise. Enforce score silence on
     * the final waveform, after vocoder normalization, with short edge fades.
     */
    _silenceNonVocalRegions(audio, notes, bpm, bufferStartBeat = 0) {
        if (!audio || audio.length === 0 || !notes || notes.length === 0) return audio;
        const secondsPerBeat = 60 / bpm;
        const mergeGapSamples = Math.round(0.04 * SAMPLE_RATE);
        const fadeSamples = Math.max(1, Math.round(0.015 * SAMPLE_RATE));
        const intervals = [];
        for (const note of notes) {
            const lyric = String(note.lyric || '').trim();
            // <AP> is audible aspiration even when its score pitch is zero.
            const isRest = lyric !== '<AP>' && (note.pitch <= 0 || note.noteType === 1
                || lyric === '<SP>');
            if (isRest) continue;
            const rawStart = Math.round((note.start - bufferStartBeat) * secondsPerBeat * SAMPLE_RATE);
            const rawEnd = Math.round((note.start + note.duration - bufferStartBeat) * secondsPerBeat * SAMPLE_RATE);
            const start = Math.max(0, rawStart);
            const end = Math.min(audio.length, rawEnd);
            if (end <= start) continue;
            const prev = intervals[intervals.length - 1];
            if (prev && start - prev.end <= mergeGapSamples) {
                prev.end = Math.max(prev.end, end);
                prev.fadeOut = prev.fadeOut || rawEnd < audio.length;
            } else {
                intervals.push({ start, end, fadeIn: rawStart > 0, fadeOut: rawEnd < audio.length });
            }
        }
        let cursor = 0;
        for (const interval of intervals) {
            audio.fill(0, cursor, interval.start);
            const fade = Math.min(fadeSamples, Math.floor((interval.end - interval.start) / 2));
            for (let i = 0; i < fade; i++) {
                if (interval.fadeIn) audio[interval.start + i] *= (i + 1) / fade;
                if (interval.fadeOut) audio[interval.end - fade + i] *= (fade - i) / fade;
            }
            cursor = interval.end;
        }
        audio.fill(0, cursor);
        return audio;
    }

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
        // A full-octave timbre remap often moves the score outside the reference
        // singer's trained register. Keep automatic matching conservative; manual
        // pitchShift remains available for intentional larger transposition.
        return Math.max(-5, Math.min(5, clampedShift));
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

    /**
     * 将音符按自然边界（rest、gap、大音高变化）切分为子段，用于局部 autoShift。
     * 每个子段独立计算 f0Shift，使各段的中位数都向参考中位数靠拢。
     * @param {Array} notes - 已 fillNoteGaps 的音符数组（已排序）
     * @param {number} bpm
     * @returns {Array<{startBeat, endBeat, notes}>} 子段数组
     */
    _buildAutoShiftSegments(notes, bpm) {
        if (!notes || notes.length <= 1) {
            const endBeat = notes && notes.length === 1 ? notes[0].start + notes[0].duration : 0;
            return [{ startBeat: 0, endBeat, notes: notes || [] }];
        }

        const PITCH_CHANGE_THRESHOLD = 7; // 半音，超过则强制分段
        const MIN_SEGMENT_SEC = 4;
        const minSegmentBeats = (MIN_SEGMENT_SEC / 60) * bpm;

        const totalBeats = notes[notes.length - 1].start + notes[notes.length - 1].duration;

        // 收集候选切分点
        const splitPoints = [0];
        for (let i = 0; i < notes.length - 1; i++) {
            const note = notes[i];
            const next = notes[i + 1];
            const noteEnd = note.start + note.duration;

            // 1. rest note 中点切分（休止符持续时间 > 0.5 拍）
            if ((!note.lyric || note.lyric.trim().length === 0) && note.duration > 0.5) {
                splitPoints.push(note.start + note.duration / 2);
                continue;
            }

            // 2. 音符间隔切分（gap > 0.05 拍）
            const gap = next.start - noteEnd;
            if (gap > 0.05) {
                splitPoints.push(noteEnd + gap / 2);
                continue;
            }

            // 3. 大音高变化处强制分段
            if (note.pitch >= 1 && next.pitch >= 1 && Math.abs(next.pitch - note.pitch) >= PITCH_CHANGE_THRESHOLD) {
                splitPoints.push(noteEnd);
            }
        }
        splitPoints.push(totalBeats);
        splitPoints.sort((a, b) => a - b);

        // 去重
        const unique = [];
        for (const p of splitPoints) {
            if (unique.length === 0 || Math.abs(p - unique[unique.length - 1]) > 0.01) {
                unique.push(p);
            }
        }

        // 构建 segments，遵守最小长度
        const segments = [];
        let segStart = 0;
        for (let i = 1; i < unique.length; i++) {
            const segEnd = unique[i];
            if (segEnd - segStart >= minSegmentBeats || i === unique.length - 1) {
                segments.push({ startBeat: segStart, endBeat: segEnd });
                segStart = segEnd;
            }
            // else: 不推进 segStart，合并到下一段
        }
        // 兜底：如果没有任何 segment（全被合并逻辑跳过）
        if (segments.length === 0) {
            segments.push({ startBeat: 0, endBeat: totalBeats });
        }

        // 分配音符到子段
        for (const seg of segments) {
            seg.notes = notes.filter(n => n.start >= seg.startBeat - 0.01 && n.start < seg.endBeat - 0.01);
        }

        return segments;
    }

    /**
     * 对已构建的 sequences 施加局部 autoShift。
     * 按 segShifts 中各子段的 f0Shift 分别偏移对应帧范围的 f0Hz 和 notePitchSeq。
     * 边界处使用短窗口线性渐变，避免 f0 跳变产生可听 artifact。
     *
     * @param {Object} sequences - notesToSequences 返回值（f0Shift=0 构建）
     * @param {Array<{startBeat, endBeat, f0Shift}>} segShifts - 各子段的 shift
     * @param {number} bpm
     */
    _applyLocalF0Shifts(sequences, segShifts, bpm) {
        const { f0Hz, notePitchSeq, mel2token } = sequences;
        if (!segShifts || segShifts.length === 0) return;

        // 如果只有一个子段或所有子段 shift 相同，退化为全局 shift
        if (segShifts.length === 1) {
            const shift = segShifts[0].f0Shift;
            if (shift !== 0) {
                const factor = Math.pow(2, shift / 12);
                for (let i = 0; i < f0Hz.length; i++) {
                    if (f0Hz[i] > 0) f0Hz[i] *= factor;
                }
                sequences.f0Ids = this._preprocessing.quantizeF0(f0Hz, 0);
                for (let t = 0; t < notePitchSeq.length; t++) {
                    if (notePitchSeq[t] > 0) {
                        notePitchSeq[t] = Math.max(0, Math.min(255, notePitchSeq[t] + shift));
                    }
                }
            }
            return;
        }

        const framesPerBeat = (60 / bpm) * (SAMPLE_RATE / HOP_SIZE);
        const FADE_FRAMES = Math.max(2, Math.floor(0.15 * SAMPLE_RATE / HOP_SIZE)); // ~0.15s 渐变

        // 1. 构建逐帧 shift 数组
        const frameShifts = new Float32Array(f0Hz.length);
        for (let i = 0; i < segShifts.length; i++) {
            const seg = segShifts[i];
            const startFrame = Math.max(0, Math.floor(seg.startBeat * framesPerBeat));
            const endFrame = Math.min(f0Hz.length, Math.floor(seg.endBeat * framesPerBeat));
            for (let f = startFrame; f < endFrame; f++) {
                frameShifts[f] = seg.f0Shift;
            }
        }

        // 2. 在子段边界做线性渐变
        for (let i = 1; i < segShifts.length; i++) {
            const boundaryFrame = Math.floor(segShifts[i].startBeat * framesPerBeat);
            const prevShift = segShifts[i - 1].f0Shift;
            const nextShift = segShifts[i].f0Shift;
            if (prevShift === nextShift) continue;
            const fadeStart = Math.max(0, boundaryFrame - FADE_FRAMES);
            const fadeEnd = Math.min(f0Hz.length, boundaryFrame + FADE_FRAMES);
            const fadeLen = fadeEnd - fadeStart;
            for (let f = fadeStart; f < fadeEnd; f++) {
                const t = (f - fadeStart) / fadeLen;
                frameShifts[f] = prevShift * (1 - t) + nextShift * t;
            }
        }

        // 3. 应用逐帧 shift 到 f0Hz
        for (let i = 0; i < f0Hz.length; i++) {
            if (f0Hz[i] > 0 && frameShifts[i] !== 0) {
                f0Hz[i] *= Math.pow(2, frameShifts[i] / 12);
            }
        }

        // 4. 重新量化 f0Ids
        sequences.f0Ids = this._preprocessing.quantizeF0(f0Hz, 0);

        // 5. 应用逐 token shift 到 notePitchSeq
        // 用 mel2token 将帧的 shift 映射到 token，每个 token 取其对应帧的平均 shift
        if (mel2token && notePitchSeq) {
            const tokenShiftSum = new Float64Array(notePitchSeq.length);
            const tokenShiftCount = new Int32Array(notePitchSeq.length);
            for (let f = 0; f < mel2token.length && f < frameShifts.length; f++) {
                const tok = mel2token[f];
                if (tok > 0 && tok < notePitchSeq.length) {
                    tokenShiftSum[tok] += frameShifts[f];
                    tokenShiftCount[tok]++;
                }
            }
            for (let t = 0; t < notePitchSeq.length; t++) {
                if (notePitchSeq[t] > 0 && tokenShiftCount[t] > 0) {
                    const avgShift = Math.round(tokenShiftSum[t] / tokenShiftCount[t]);
                    if (avgShift !== 0) {
                        notePitchSeq[t] = Math.max(0, Math.min(255, notePitchSeq[t] + avgShift));
                    }
                }
            }
        }
    }
    clearSynthCache() {
        // LRU 缓存：清空所有条目
        this._synthCache = null;
        this._synthCacheMap = null;
        this._synthCacheBytes = 0;
        // 同步清空分片级缓存：切换语言/模型后单 segment 的 cond/diff_step/preflow 输出
        // 也会变化，旧分片缓存不再适用，必须一并清空。
        this._segCacheMap = null;
        this._segCacheBytes = 0;
        this._chunkCacheMap = null;
        this._chunkCacheBytes = 0;
        this._multiStreamResultCache = null;
    }

    _chunkCacheGet(key) {
        if (!this._chunkCacheMap || !this._chunkCacheMap.has(key)) return null;
        const entry = this._chunkCacheMap.get(key);
        this._chunkCacheMap.delete(key);
        this._chunkCacheMap.set(key, entry);
        return entry;
    }

    _chunkCachePut(key, entry) {
        if (!entry || !entry.audio || !entry.mel) return;
        if (!this._chunkCacheMap) this._chunkCacheMap = new Map();
        const map = this._chunkCacheMap;
        if (map.has(key)) {
            this._chunkCacheBytes -= map.get(key).size;
            map.delete(key);
        }
        // Cache owns its buffers. This prevents later xt/audio reuse from
        // mutating a completed chunk after cancellation.
        const stored = {
            ...entry,
            audio: entry.audio.slice(),
            mel: entry.mel.slice(),
        };
        stored.size = stored.audio.byteLength + stored.mel.byteLength;
        map.set(key, stored);
        this._chunkCacheBytes += stored.size;
        while (map.size > this._chunkCacheMaxEntries ||
               (this._chunkCacheBytes > this._chunkCacheMaxBytes && map.size > 1)) {
            const oldestKey = map.keys().next().value;
            this._chunkCacheBytes -= map.get(oldestKey).size;
            map.delete(oldestKey);
        }
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
     * 分片级 LRU 写入：与 _synthCachePut 同构，但容量上限更大（segment 粒度更细）。
     * 仅缓存单 segment 的原始音频（crossfade 混合前），混合后的最终音频仍由
     * _synthCachePut 在外层缓存。
     * @param {string} key - _computeSegmentCacheKey 计算的分片键
     * @param {Float32Array} audio - 该 segment 的原始音频（vocoder 输出）
     */
    _segCachePut(key, audio) {
        const MAX_SAMPLES = SAMPLE_RATE * 120; // 单条上限 2 分钟（单 segment 实际 ≤30s）
        if (!audio || audio.length === 0 || audio.length > MAX_SAMPLES) return;

        if (!this._segCacheMap) this._segCacheMap = new Map();
        const map = this._segCacheMap;

        if (map.has(key)) {
            const old = map.get(key);
            this._segCacheBytes -= old.size;
            map.delete(key);
        }

        const size = audio.byteLength;
        map.set(key, { audio, size });
        this._segCacheBytes += size;

        while ((map.size > this._segCacheMaxEntries) ||
               (this._segCacheBytes > this._segCacheMaxBytes && map.size > 1)) {
            const oldestKey = map.keys().next().value;
            const oldest = map.get(oldestKey);
            this._segCacheBytes -= oldest.size;
            map.delete(oldestKey);
        }
    }

    /**
     * 分片级 LRU 读取：命中时提升到最新位置并返回 audio；未命中返回 null。
     * @param {string} key
     * @returns {Float32Array|null}
     */
    _segCacheGet(key) {
        if (!this._segCacheMap || !this._segCacheMap.has(key)) return null;
        const entry = this._segCacheMap.get(key);
        this._segCacheMap.delete(key);
        this._segCacheMap.set(key, entry);
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
     * 解析 diff_step 实际要加载的模型文件名。
     *
     * int8 / int8-npu 精度优先使用 QDIT 量化新模型 diffstep.onnx
     * （cond=1024 + bool mask 签名）。若不存在则回退旧命名
     * diff_step_dml.onnx → diff_step.onnx；此时若加载的是旧 int8 模型
     * （cond=512），由 _detectDiffStepPrecision 检测并置
     * diffStepLegacyInt8Incompatible 标志提示用户更新。
     *
     * 其他精度保持原逻辑：diff_step_dml.onnx → diff_step.onnx。
     * 文件存在性通过 _getModelPath 检查，以兼容 JP 语言目录。
     * @returns {Promise<string>} 解析后的 diff_step 文件名
     */
    async _resolveDiffStepFile() {
        const isInt8 = this._modelPrecision === 'int8' || this._modelPrecision === 'int8-npu';
        if (isInt8) {
            const qditPath = this._getModelPath('diffstep.onnx');
            let qditExists = false;
            try { await fs.promises.access(qditPath); qditExists = true; } catch (_) {}
            if (qditExists) {
                console.log('[OnnxSVSPipeline] int8: using QDIT diffstep.onnx');
                return 'diffstep.onnx';
            }
            console.warn('[OnnxSVSPipeline] int8: diffstep.onnx (QDIT) not found, falling back to diff_step_dml.onnx / diff_step.onnx');
        }
        const dmlPath = this._getModelPath('diff_step_dml.onnx');
        let dmlExists = false;
        try { await fs.promises.access(dmlPath); dmlExists = true; } catch (_) {}
        if (dmlExists) return 'diff_step_dml.onnx';
        console.warn('[OnnxSVSPipeline] diff_step_dml.onnx not found, using diff_step.onnx');
        return 'diff_step.onnx';
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

        // 解析 diff_step 实际文件：int8/int8-npu 优先 QDIT 新模型 diffstep.onnx，
        // 其余按旧逻辑 diff_step_dml.onnx → diff_step.onnx 回退（仅 init 阶段需要，
        // vocoder swap 不会触及）
        if (dmlIdx >= 0) {
            resolvedModelFiles[dmlIdx] = await this._resolveDiffStepFile();
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
     * 检测基础模型精度（FP16/FP32/INT8）：通过 preflow probe session 的 I/O 类型 + 量化算子扫描
     * 设置 this.isFP16（等同 baseModelsIsFP16）。
     *
     * 仅检测基础模型精度 —— diff_step 与 vocoder 的精度分别由
     * `_detectDiffStepPrecision` / `_detectVocoderPrecision` 独立检测，
     * 三者互不影响（参见构造函数中三层精度分离说明）。
     */
    async _detectModelPrecision(resolvedModelFiles) {
        try {
            const probeModelPath = path.join(this.modelDir, resolvedModelFiles[4]); // preflow (~8MB)
            const probeSession = await require('onnxruntime-node').InferenceSession.create(probeModelPath,
                buildSessionOptions({ executionProviders: ['cpu'] }));
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
            console.log(`[OnnxSVSPipeline] Base models precision: ${precisionLabel} (isFP16=${this.isFP16})`);
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
                const session = await ort.InferenceSession.create(vocPath, buildSessionOptions({
                    executionProviders: [dmlOpts, 'cpu'],
                }));
                return { session, ep: 'dml', vocFile };
            } catch (vocErr) {
                console.warn(`[OnnxSVSPipeline] Vocoder DML load failed (${vocFile}), falling back to CPU: ${vocErr.message}`);
                const session = await ort.InferenceSession.create(vocPath, buildSessionOptions({
                    executionProviders: ['cpu'],
                }));
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
            // Flush ORT native debug logs after init complete
            if (typeof globalThis._flushOrtDebugLogs === 'function') {
                globalThis._flushOrtDebugLogs();
            }
            if (this.sessions['vocoder']) await this._detectVocoderPrecision(this.sessions['vocoder'], this._getModelPath(this._resolvedVocoderFile || 'vocoder_dml.onnx'));
            this._detectDiffStepPrecision();
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
            this._detectDiffStepPrecision();
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
                } else if (sessionKeys[i] === 'diffStep' && this.baseModelDir && this.modelDir !== this.baseModelDir) {
                    // W16A32 diff_step (fp16 subdir) 在 onnxruntime-node 1.27.0 上推理失败
                    // 回退到 baseModelDir（根目录）的 FP32 diff_step 模型
                    console.warn(`[OnnxSVSPipeline] diff_step load failed in ${this.modelDir}, trying FP32 from ${this.baseModelDir}: ${loadErr.message.substring(0, 80)}`);
                    const fp32Path = path.join(this.baseModelDir, modelFile);
                    let fp32Exists = false;
                    try { await fs.promises.access(fp32Path); fp32Exists = true; } catch (_) {}
                    if (!fp32Exists) throw loadErr;
                    // FP32 模型用 isFP16=false 创建 dummy 输入
                    const { session, ep } = await createSessionWithValidation(fp32Path, sessionKeys[i], this.gpuDeviceName, this.dmlDeviceId, false, this.useStaticShapes, sifiganDummy);
                    this.sessions[sessionKeys[i]] = session;
                    this.sessionEPs[sessionKeys[i]] = ep;
                    console.log(`[OnnxSVSPipeline] diff_step FP32 loaded from baseModelDir [${ep}] (W16A32 fallback)`);
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

    /**
     * 独立检测 vocoder 模型精度（与基础模型 isFP16 解耦）。
     *
     * vocoder 的精度由文件名/输入类型/文件大小综合判定：
     *   - SiFiGAN: 按文件名（sifigan_vocoder_dml_fp16.onnx → FP16）
     *   - 默认 vocoder: 优先用 mel 输入类型，否则按文件大小阈值推断
     * 失败时回退到基础模型精度（this.isFP16）作为兜底。
     */
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

    /**
     * 独立检测 diff_step 模型精度（与基础模型 isFP16 解耦）。
     *
     * 背景：W16A32 diff_step 模型（fp16 子目录）在 onnxruntime-node 1.27.0 上推理时报
     * "not enough space" 错误，需要回退到根目录的 FP32 模型。此时基础模型 isFP16（来自
     * preflow probe）为 true，但实际加载的 diff_step 是 FP32，需要独立检测以创建正确
     * 类型的张量。
     *
     * 读取 sessions.diffStep.inputMetadata 的 xt_input 类型来设置 diffStepIsFP16。
     * 失败时回退到基础模型精度（this.isFP16）作为兜底。
     *
     * 同时识别 QDIT 量化新模型签名（x/diffusion_step/x_mask bool）：
     * - diffStepIsQDIT = true（int8 新模型，pipeline 已按新签名适配）
     * - diffStepLegacyInt8Incompatible = true（int8 目录下检测到旧版模型：legacy 签名
     *   且 cond 维度 ≠ 1024，即旧 int8 的 512 维 cond，与管线 1024 维 cond 不匹配）。
     *   该标志由 svsWorker snapshot 转发到渲染进程，提示用户更新模型。
     */
    _detectDiffStepPrecision() {
        try {
            const session = this.sessions.diffStep;
            if (!session) {
                this.diffStepIsFP16 = this.isFP16;
                this.diffStepIsQDIT = false;
                this.diffStepLegacyInt8Incompatible = false;
                return;
            }
            const meta = session.inputMetadata || [];
            // inputMetadata 是数组：[{name, type, shape, ...}, ...]
            const has = (n) => meta.some(m => m && m.name === n);
            // QDIT 新模型：x / diffusion_step / x_mask(bool)
            this.diffStepIsQDIT = has('x') && has('diffusion_step') && has('x_mask');

            let dataInputType = null;
            for (const m of meta) {
                if (m.name === 'x' || m.name === 'xt_input') { dataInputType = m.type; break; }
            }
            if (dataInputType) {
                this.diffStepIsFP16 = dataInputType === 'float16';
                console.log(`[OnnxSVSPipeline] diff_step precision: ${dataInputType} (diffStepIsFP16=${this.diffStepIsFP16}, QDIT=${this.diffStepIsQDIT})`);
            } else {
                console.warn('[OnnxSVSPipeline] diff_step x/xt_input metadata not found, defaulting to global isFP16');
                this.diffStepIsFP16 = this.isFP16;
            }

            // 旧 int8 模型检测：legacy 签名 + cond 维度 ≠ COND_DIM(1024)（旧 int8 为 512）。
            // 仅当精度为 int8 / int8-npu 时置不兼容标志，避免误伤 fp32/fp16 目录下的合法 legacy 模型。
            let legacyInt8 = false;
            let condDim = null;
            if (!this.diffStepIsQDIT && (this._modelPrecision === 'int8' || this._modelPrecision === 'int8-npu')) {
                for (const m of meta) {
                    if (m.name === 'cond' && Array.isArray(m.shape) && m.shape.length > 0) {
                        condDim = m.shape[m.shape.length - 1];
                        break;
                    }
                }
                legacyInt8 = typeof condDim === 'number' && condDim !== COND_DIM;
            }
            this.diffStepLegacyInt8Incompatible = legacyInt8;
            if (legacyInt8) {
                console.warn(`[OnnxSVSPipeline] diff_step legacy int8 model detected (cond=${condDim}, expected ${COND_DIM}) — INCOMPATIBLE, please update the model`);
            }
        } catch (e) {
            console.warn('[OnnxSVSPipeline] diff_step precision detection failed:', e.message);
            this.diffStepIsFP16 = this.isFP16;
            this.diffStepIsQDIT = false;
            this.diffStepLegacyInt8Incompatible = false;
        }
    }

    async _extractRefMelOnnx(refAudioWavBuffer) {
        return this._postprocessing.extractRefMelOnnx(this.sessions, refAudioWavBuffer, this.isFP16, this.useStaticShapes);
    }

    async _runEncoder(sequences, tokenCount, totalFrames, ptFrameCount = 0) {
        return this._preprocessing.runEncoder(this.sessions, sequences, tokenCount, totalFrames, this.isFP16, ptFrameCount, this.useStaticShapes);
    }

    async _runDiffStep(xtInputData, tVal, condData, maskData, totalFramesWithPrompt) {
        return this._diffusion.runDiffStep(this.sessions, xtInputData, tVal, condData, maskData, totalFramesWithPrompt, this.diffStepIsFP16, this.useStaticShapes);
    }

    async _runVocoderChunked(melData, totalFrames, onChunkComplete = null) {
        // Vocoder is loaded via DML (dynamic shapes), never use static shape padding
        // SiFiGAN 双输入：传入 vocoderType、F0 序列、stats 缺失标志；default vocoder 仅用 mel
        const chunkFrames = this._resolveVocoderChunkFrames();
        const overlapFramesOverride = this._resolveVocoderOverlapFrames();
        console.log(`[OnnxSVSPipeline] Vocoder EP: ${this.sessionEPs.vocoder || 'unknown'}, vocoderIsFP16=${this.vocoderIsFP16}, isFP16=${this.isFP16}, vocoderType=${this.vocoderType}, resolvedFile=${this._resolvedVocoderFile}`);
        if (this.sessionEPs.vocoder !== 'dml') {
            console.warn(`[OnnxSVSPipeline] WARNING: Vocoder is NOT on DML (EP=${this.sessionEPs.vocoder}), will be slow and may explain low GPU usage!`);
        }
        if (!this.sessions.vocoder) {
            console.error('[OnnxSVSPipeline] CRITICAL: sessions.vocoder is missing! Vocoder inference will throw.');
        }

        // 一致性检测：vocoderType 与实际加载的 vocoder 文件必须匹配，否则 mel 处理模式
        // （sifigan 4× 上采样 + f0 输入 vs default 仅 mel）与 session 输入签名不匹配，
        // 会导致音质劣化 + 显存压力错误（sifigan 与 default 使用不同的常驻权重预算）。
        const expectedSifigan = this.vocoderType === 'sifigan';
        const actualIsSifigan = this._resolvedVocoderFile ? this._isSifiganVocoder(this._resolvedVocoderFile) : false;
        if (expectedSifigan !== actualIsSifigan) {
            console.warn(`[OnnxSVSPipeline] WARNING: vocoderType=${this.vocoderType} but loaded vocoder=${this._resolvedVocoderFile} (isSifigan=${actualIsSifigan}). This indicates a fallback occurred. Mel processing may be incorrect.`);
        }

        // 临时释放 diffStep session，让 vocoder 推理独占 GPU 显存。
        // 触发条件：DML 后端 + (用户开启 releaseDiffStepBeforeVocoder || 上一次 vocoder
        //   抛 isVramOOMError 设置的 _dynamicReleaseDiffStepNextSegment) + diffStep 当前已加载。
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
                this.vocoderType, this._currentF0Hz, this.sifiganStatsMissing, onChunkComplete, chunkFrames, overlapFramesOverride
            );
        } catch (err) {
            // Dynamic OOM recovery: if this is the first OOM in this segment
            // and we did NOT already release diffStep, set the dynamic flag and
            // retry the segment with diffStep released first. After the retry
            // (success or another failure), the finally block clears the flag
            // so behavior reverts to the user setting for the next segment.
            if (isVramOOMError(err) && !releasedDiffStep && !_dynamicReleaseDiffStepNextSegment && this._isDiffStepReleaseEnabled()) {
                console.warn(`[OnnxSVSPipeline] Vocoder OOM caught, retrying segment with diffStep released first: ${err.message}`);
                _dynamicReleaseDiffStepNextSegment = true;
                // 标记 OOM 使下一次自适应 gpuDrain 延长到 200ms（让 DML 资源池恢复），
                // 标志在 gpuDrainAdaptive 内部消费后自动清除。
                markGpuOom();
                // Declare outside try so the finally block can observe it.
                let releasedRetry = false;
                try {
                    releasedRetry = this._maybeUnloadDiffStepBeforeVocoder();
                    if (releasedRetry) {
                        console.log('[OnnxSVSPipeline] Waiting for DML to reclaim diffStep VRAM before vocoder retry...');
                        const r0 = performance.now();
                        await gpuDrainLong();
                        console.log(`[OnnxSVSPipeline] DML drain complete (${(performance.now() - r0).toFixed(0)}ms), starting vocoder retry`);
                    }
                    return await this._postprocessing.runVocoderChunked(
                        this.sessions, melData, totalFrames, this.vocoderIsFP16 ?? this.isFP16, false,
                        this.vocoderType, this._currentF0Hz, this.sifiganStatsMissing, onChunkComplete, chunkFrames, overlapFramesOverride
                    );
                } finally {
                    if (releasedRetry) {
                        await this._reloadDiffStepAfterVocoder();
                    }
                    _dynamicReleaseDiffStepNextSegment = false;
                }
            }
            // Either not an OOM, or already retried: rethrow to caller.
            // If the retry above also threw, we reach here without clearing the
            // dynamic flag — clear it now so the next segment starts clean.
            _dynamicReleaseDiffStepNextSegment = false;
            throw err;
        } finally {
            // Vocoder 推理完成（或抛错）后立即重载 diffStep，保持 session 状态一致：
            // - 多 segment 合成的下一段需要 diffStep
            // - _recreateHeavySessionsAfterSynthesis 期望 diffStep 存在（否则会跳过 release）
            // - 用户关闭 releaseDmlVramAfterSynthesis 时，下次合成依赖 ensureAllModelsLoaded 检测缺失才重载
            //   会让用户感知到"下次合成变慢"，不如在这里主动重载
            if (releasedDiffStep) {
                await this._reloadDiffStepAfterVocoder();
            }
            // Always clear the dynamic flag at the end of a segment (success or
            // failure) so the next segment reverts to the user setting.
            _dynamicReleaseDiffStepNextSegment = false;
        }
    }

    /**
     * 分块流式路径专用：对 mel 片段运行 vocoder 推理。
     * 与 _runVocoderChunked 的区别：
     * 1. 不释放 diffStep（下一个 diffusion chunk 还需要它，释放/重载开销过大）
     * 2. 接受 f0Override 参数（每段 mel 对应不同的 F0 片段）
     * 3. 不做 vocoderType 一致性检测（已在主路径做过，片段路径重复检测浪费）
     */
    async _runVocoderChunkedForSegment(melData, segFrames, f0Override, onChunkComplete) {
        const chunkFrames = this._resolveVocoderChunkFrames();
        const overlapFramesOverride = this._resolveVocoderOverlapFrames();
        return this._postprocessing.runVocoderChunked(
            this.sessions, melData, segFrames, this.vocoderIsFP16 ?? this.isFP16, false,
            this.vocoderType, f0Override, this.sifiganStatsMissing, onChunkComplete, chunkFrames, overlapFramesOverride
        );
    }

    /**
     * 在 vocoder 推理前临时释放 diffStep session（仅 DML 后端 + 用户开启时）。
     * 目的：腾出 diffStep 模型权重 + diffusion 32 步激活工作区（合计 ~3-4GB）的显存，
     * 避免 vocoder 推理时显存叠加触发 DXGI_ERROR_DEVICE_REMOVED (0x887A0006) / TDR。
     *
     * 仅当用户设置 releaseDiffStepBeforeVocoder === true 时允许释放。
     * OOM 重试标志只决定是否立即重试，不得绕过用户关闭的设置。
     *
     * @returns {boolean} true 表示已释放（调用方需在 vocoder 完成后调用 _reloadDiffStepAfterVocoder）
     */
    _isDiffStepReleaseEnabled() {
        try {
            const { loadSettings } = require('../../main/settings');
            return loadSettings().releaseDiffStepBeforeVocoder === true;
        } catch (_) {
            return false;
        }
    }

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

        // The user setting is authoritative, including the OOM retry path.
        if (!this._isDiffStepReleaseEnabled()) {
            console.log('[OnnxSVSPipeline] _maybeUnloadDiffStepBeforeVocoder: skip (disabled by user)');
            return false;
        }
        if (_dynamicReleaseDiffStepNextSegment) {
            console.log('[OnnxSVSPipeline] _maybeUnloadDiffStepBeforeVocoder: OOM retry release');
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
            const result = await this.loadModel('diffStep', { runValidation: false });
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

    /**
     * 读取用户配置的 vocoder 分块重叠帧数（settings.vocoderOverlapFrames，默认 32，范围 8-96）。
     * 返回 0 表示回退到 VOCODER_OVERLAP_FRAMES 常量（32），由 runVocoderChunked 内部处理。
     * 在测试环境（无 Electron settings）下返回 0，保持与既有测试一致的默认行为。
     * @returns {number}
     */
    _resolveVocoderOverlapFrames() {
        try {
            const { loadSettings } = require('../../main/settings');
            const settings = loadSettings();
            const v = settings.vocoderOverlapFrames;
            return (Number.isFinite(v) && v >= 8 && v <= 96) ? Math.floor(v) : 0;
        } catch (e) {
            return 0;
        }
    }

    /**
     * NPU 静态形状模型（int8/int8-npu）逐段长度钳制。
     * 模型输入维度固定为 NPU_STATIC_SEQ_LEN，要求 ptFrameCount + totalFrames <= 2048，
     * 否则 encoder/diffstep 拼接溢出（RangeError: offset is out of bounds）或张量 size 不匹配
     * （Tensor's size(2048) does not match data length(N)）。
     * 策略：先截断 ref prompt（保留要合成的目标音频），再把 target 截到 2048 - ptFrameCount。
     * @param {Object} sequences - { f0Ids, mel2token }（会被原位截断）
     * @param {number} ptFrameCount ref prompt 帧数（可能被截短）
     * @param {Float32Array|null} ptMelData ref prompt mel（可能被截短）
     * @param {number} totalFrames 目标帧数（会被截短）
     * @param {string} tag 日志前缀
     * @returns {{totalFrames:number, ptFrameCount:number, ptMelData:Float32Array|null}}
     */
    _clampStaticShapeFrames(sequences, ptFrameCount, ptMelData, totalFrames, tag = '') {
        const minTarget = 50; // 至少保留 50 帧目标，避免全空
        if (ptFrameCount > NPU_STATIC_SEQ_LEN - minTarget) {
            const newPt = Math.max(0, NPU_STATIC_SEQ_LEN - minTarget);
            if (ptMelData && ptMelData.length > newPt * MEL_DIM) {
                console.warn(`${tag} NPU prompt limit: ${ptFrameCount} -> ${newPt}, trimming ref`);
                ptMelData = ptMelData.subarray(0, newPt * MEL_DIM);
                ptFrameCount = newPt;
            }
        }
        const maxFrames = NPU_STATIC_SEQ_LEN - ptFrameCount;
        if (totalFrames > maxFrames) {
            console.warn(`${tag} NPU frame limit: ${totalFrames} > ${maxFrames}, truncating`);
            sequences.f0Ids = sequences.f0Ids.subarray(0, maxFrames);
            sequences.mel2token = sequences.mel2token.subarray(0, maxFrames);
            totalFrames = maxFrames;
        }
        return { totalFrames, ptFrameCount, ptMelData };
    }

    /**
     * INT8 静态形状（useStaticShapes）模型专用：长片段分段合成。
     *
     * 静态形状模型的 encoder（noteText/Pitch/Type/f0/preflow/condEmb）与 diffstep
     * 输入维度全部固定为 NPU_STATIC_SEQ_LEN=2048。当目标帧数 + prompt 帧数超过 2048 时，
     * encoder 单次前向只能产出前 2048 帧的有效 cond，其余帧为 pad 零 → 下游 diffstep/vocoder
     * 得到不完整的 mel，表现为"杂音/静音"。此前通过 _clampStaticShapeFrames 直接把长片段
     * 截断到 2048-ptFrameCount 帧，导致长片段内容被丢弃。
     *
     * 本方法将目标帧按 (NPU_STATIC_SEQ_LEN - ptFrameCount) 切段，对每一段独立执行
     * encoder（按 mel2token 切片对应 token 区间，重新编号）→ diffstep，逐段拼接出
     * 完整的 mel 输出。vocoder 在调用方对整段拼接后的 mel 一次执行。
     *
     * @param {Object} sequences - 完整序列 { noteTextSeq, notePitchSeq, noteTypeSeq, f0Ids, mel2token, ... }
     * @param {number} totalFrames - 目标帧数（不含 prompt）
     * @param {Float32Array} ptMelData - prompt mel
     * @param {number} ptFrameCount - prompt 帧数
     * @param {number} totalSteps
     * @param {number} cfgStrength
     * @param {number} cfgRescale
     * @param {Function} onProgress
     * @param {number} progressStart
     * @param {number} progressRange
     * @param {AbortSignal} abortSignal
     * @param {string} tag - 日志前缀
     * @returns {Promise<Float32Array|null>} 完整 mel（totalFrames*MEL_DIM）；若无需分段返回 null
     */
    async _synthesizeStaticShapeSegments(sequences, totalFrames, ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale, onProgress, progressStart, progressRange, abortSignal = null, tag = '') {
        // 每窗口(段)目标帧上限：prompt(每窗口复用) + 目标帧 <= NPU_STATIC_SEQ_LEN
        const winCap = NPU_STATIC_SEQ_LEN - ptFrameCount;
        if (winCap <= 0) {
            throw new Error(`${tag} static-shape chunking failed: no room for target (ptFrameCount=${ptFrameCount} >= NPU_STATIC_SEQ_LEN)`);
        }
        if (winCap < 50) {
            console.warn(`${tag} static-shape winCap(${winCap}) < 50, clamping prompt for segmentation`);
            const clamped = this._clampStaticShapeFrames(sequences, ptFrameCount, ptMelData, totalFrames, tag);
            ptFrameCount = clamped.ptFrameCount;
            ptMelData = clamped.ptMelData;
        }
        if (totalFrames <= winCap) return null; // 单窗口即可容纳，回退到常规整段路径

        // 相邻窗口之间的重叠帧数（与 diffstep chunk 路径一致，用于共享噪声 + WSOLA
        // 交叉淡入淡出消除边界不连贯）。默认 50 帧（1s @50Hz）。
        const overlap = Math.max(1, Math.min(winCap - 1, Math.floor(
            (this._currentDiffStepChunkOpts && this._currentDiffStepChunkOpts.overlapFrames) || 50
        )));
        const advance = winCap - overlap; // 每次窗口起点前进帧数
        if (advance <= 0) throw new Error(`${tag} static-shape overlap(${overlap}) >= winCap(${winCap})`);

        // 窗口规划：每窗口覆盖 [ws, ws+winCap)，相邻窗口重叠 overlap 帧
        const wins = [];
        for (let ws = 0; ws < totalFrames; ws += advance) {
            const segStart = ws;
            const segEnd = Math.min(totalFrames, segStart + winCap);
            wins.push({ segStart, segEnd, segFrames: segEnd - segStart });
            if (segEnd >= totalFrames) break;
        }
        const numSegs = wins.length;
        console.log(`${tag} Static-shape segmented synthesis: totalFrames=${totalFrames}, ptFrameCount=${ptFrameCount}, winCap=${winCap}, overlap=${overlap}, segments=${numSegs}`);

        const melOut = new Float32Array(totalFrames * MEL_DIM);
        const mel2tokenFull = sequences.mel2token;
        const noteTextSeq = sequences.noteTextSeq;
        const notePitchSeq = sequences.notePitchSeq;
        const noteTypeSeq = sequences.noteTypeSeq;
        const f0IdsFull = sequences.f0Ids;
        const samplerName = this._currentSamplerName || DEFAULT_SOLVER;
        const cfgScheduleOpts = this._currentCfgScheduleOpts || null;
        const dynamicThresholdOpts = this._currentDynamicThresholdOpts || null;
        const perSeg = (progressRange || 0) / numSegs;

        // 单一全局噪声场：所有窗口从同一个噪声张量切片取噪 → 相邻窗口的重叠区共享
        // 相同的初始噪声，再由 WSOLA 交叉淡化拼合，从根本上保证长片段拼接连贯（否则各窗口
        // 独立取噪会在边界产生相位不连续 → DML vocoder 放大为可听杂音）。
        const noiseFull = this.randomNoise(totalFrames, MEL_DIM);

        for (let w = 0; w < numSegs; w++) {
            throwIfCancelled(abortSignal);
            const { segStart, segEnd, segFrames } = wins[w];

            // 该窗口覆盖的 token 区间（mel2token 为 [0, tokenCount-1] 的绝对 token 下标）
            const tokenLo = Math.max(0, mel2tokenFull[segStart] | 0);
            const tokenHi = Math.max(tokenLo, (mel2tokenFull[segEnd - 1] | 0));
            const subTokenCount = tokenHi - tokenLo + 1;

            const subSequences = {
                noteTextSeq: noteTextSeq.subarray(tokenLo, tokenLo + subTokenCount),
                notePitchSeq: notePitchSeq.subarray(tokenLo, tokenLo + subTokenCount),
                noteTypeSeq: noteTypeSeq.subarray(tokenLo, tokenLo + subTokenCount),
                f0Ids: f0IdsFull.subarray(segStart, segEnd),
                mel2token: Int32Array.from(mel2tokenFull.subarray(segStart, segEnd), (v) => (v | 0) - tokenLo),
                tokenCount: subTokenCount,
            };

            // 窗口内 encoder：只对该窗口 token/帧范围编码，输出该窗口 cond（含复用的 prompt 头）
            const segCond = await this._runEncoder(subSequences, subTokenCount, segFrames, ptFrameCount);
            await gpuDrainAdaptive();

            // 从全局噪声场提取本窗口噪声（复制），保持与相邻窗口重叠区一致
            const chunkNoise = new Float32Array(segFrames * MEL_DIM);
            chunkNoise.set(noiseFull.subarray(segStart * MEL_DIM, segEnd * MEL_DIM));
            const subXt = { data: chunkNoise, dims: [1, segFrames, MEL_DIM] };

            await this._diffusion.runDiffusionLoop(
                this.sessions, subXt, segFrames, ptMelData, ptFrameCount, segCond,
                totalSteps, cfgStrength, cfgRescale, this.diffStepIsFP16,
                onProgress, progressStart + w * perSeg, perSeg, this.useStaticShapes,
                samplerName, cfgScheduleOpts, dynamicThresholdOpts, abortSignal
            );

            // 提交到 melOut：首窗口整段 memcpy，后续窗口对重叠区做 WSOLA 交叉淡入淡出。
            if (w === 0) {
                melOut.set(subXt.data, 0);
            } else {
                const realOv = Math.min(overlap, segFrames);
                if (realOv > 0) {
                    const prevTailMel = melOut.subarray(segStart * MEL_DIM, (segStart + realOv) * MEL_DIM);
                    const currHeadMel = subXt.data.subarray(0, realOv * MEL_DIM);
                    const xf = wsolaCrossfadeMel(prevTailMel, currHeadMel, realOv, MEL_DIM);
                    melOut.set(xf, segStart * MEL_DIM);
                }
                // 非重叠区 memcpy
                const nonOvLen = (segFrames - realOv) * MEL_DIM;
                if (nonOvLen > 0) {
                    melOut.set(subXt.data.subarray(realOv * MEL_DIM, realOv * MEL_DIM + nonOvLen), (segStart + realOv) * MEL_DIM);
                }
            }
            await gpuDrainAdaptive();
        }

        console.log(`${tag} Static-shape segmented synthesis complete: ${numSegs} segments, ${totalFrames} frames`);
        return melOut;
    }

    async _runDiffusionLoop(xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, onProgress, progressStart, progressRange, onChunkMel = null, abortSignal = null) {
        throwIfCancelled(abortSignal);
        const samplerName = this._currentSamplerName || DEFAULT_SOLVER;
        // Task 15: pass per-frame F0 curve to chunked diffusion for F0-aware
        // boundary selection. Set by _synthesizeSegment / synthesizeMultiStreaming
        // / _synthesizeImpl from sequences.f0Hz. null = no F0 info → fallback.
        const pitchCurveF0 = this._currentPitchCurveF0 || null;
        // Task 11: CFG schedule opts (set by synthesize / synthesizeMultiStreaming)
        const cfgScheduleOpts = this._currentCfgScheduleOpts || null;
        const dynamicThresholdOpts = this._currentDynamicThresholdOpts || null;
        const _suppressChunkLog = !!this._suppressChunkDiffLog;
        if (!_suppressChunkLog) {
            console.log(`[OnnxSVSPipeline] Diffusion start: totalFrames=${totalFrames}, ptFrameCount=${ptFrameCount}, totalSteps=${totalSteps}, sampler=${samplerName}, isFP16=${this.isFP16}, diffStepIsFP16=${this.diffStepIsFP16}, ep=${this.sessionEPs.diffStep || 'unknown'}`);
            console.log(`[OnnxSVSPipeline] Session diffStep: type=${this.sessions.diffStep?.constructor?.name}, ep=${this.sessionEPs.diffStep}`);
        }
        // 分块扩散推理（仅预览路径启用，useStaticShapes 路径跳过）
        const chunkOpts = this._currentDiffStepChunkOpts;
        // 与 _planChunks 的 safeChunk = Math.max(50, chunkFrames) 保持一致，
        // 避免进入 runDiffusionLoopChunked 后 _planChunks 返回 null 再回退。
        const _safeChunk = Math.max(50, Math.floor(chunkOpts?.chunkFrames || 0));
        if (chunkOpts && chunkOpts.enabled && !this.useStaticShapes && chunkOpts.chunkFrames > 0 && totalFrames > _safeChunk) {
            if (!_suppressChunkLog) console.log(`[OnnxSVSPipeline] Using chunked diffusion: chunkFrames=${chunkOpts.chunkFrames}, overlapFrames=${chunkOpts.overlapFrames}, streaming=${!!onChunkMel}`);
            return this._diffusion.runDiffusionLoopChunked(this.sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, this.diffStepIsFP16, onProgress, progressStart, progressRange, this.useStaticShapes, chunkOpts.chunkFrames, chunkOpts.overlapFrames, onChunkMel, samplerName, pitchCurveF0, cfgScheduleOpts, dynamicThresholdOpts, abortSignal);
        }
        return this._diffusion.runDiffusionLoop(this.sessions, xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, this.diffStepIsFP16, onProgress, progressStart, progressRange, this.useStaticShapes, samplerName, cfgScheduleOpts, dynamicThresholdOpts, abortSignal, _suppressChunkLog);
    }

    async _synthesizeSegment(segmentNotes, bpm, f0Envelope, pitchCurveF0, f0Shift, ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale, npuDiffBatchSize, npuVocoderBatchSize, onProgress, progressStart, progressRange, onChunkAudio = null, segStartBeat = 0, abortSignal = null) {
        throwIfCancelled(abortSignal);
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

        // NPU 静态形状模型限制：ptFrameCount+totalFrames 不得超过 NPU_STATIC_SEQ_LEN。
        // 大 ref prompt（>50 帧）时按 Math.min(ptFrameCount,50) 预留 target 会不足预留，
        // 导致 diffstep 拼接 offset overflow；统一用实际 ptFrameCount 预留 target 帧。
        // 启用 INT8 静态形状分段合成时不做整段钳制（避免长片段被丢弃到 2048 帧），
        // 由 _synthesizeStaticShapeSegments 逐段处理 2048 限制。
        const _staticSegChunkEnabled = this.useStaticShapes &&
            (this._currentDiffStepChunkOpts && this._currentDiffStepChunkOpts.enabled === true);
        if (this.useStaticShapes && !_staticSegChunkEnabled && ptFrameCount + totalFrames > NPU_STATIC_SEQ_LEN) {
            const clamped = this._clampStaticShapeFrames(sequences, ptFrameCount, ptMelData, totalFrames, '[Segment]');
            totalFrames = clamped.totalFrames;
            ptFrameCount = clamped.ptFrameCount;
            ptMelData = clamped.ptMelData;
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
                cfgScheduleOpts: this._currentCfgScheduleOpts,
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

        // INT8 静态形状 + 分段合成：逐段 encoder+diffstep 直接产出整段 mel，不整段编码。
        let xt;
        if (_staticSegChunkEnabled) {
            const segMel = await this._synthesizeStaticShapeSegments(
                sequences, totalFrames, ptMelData, ptFrameCount,
                totalSteps, cfgStrength, cfgRescale,
                onProgress, progressStart, progressRange, abortSignal, '[Segment]'
            );
            if (segMel) {
                xt = { data: segMel, dims: [1, totalFrames, MEL_DIM] };
                // Task 15: per-frame F0 curve for vocoder boundary selection
                this._currentPitchCurveF0 = sequences.f0Hz ? sequences.f0Hz.subarray(0, totalFrames) : null;
            }
        }
        if (!xt) {
            const combinedCond = await this._runEncoder(sequences, tokenCount, totalFrames, ptFrameCount);

            // GPU 排空点 1：encoder（6 次推理）→ diffusion 切换前等待 DML 回收 encoder 的 GPU 资源
            await gpuDrainAdaptive();

            xt = this.randomNoise(totalFrames, MEL_DIM);

            // Task 15: per-frame F0 curve for F0-aware chunked diffusion boundary
            // selection. Slice to totalFrames to match the segment's frame range.
            this._currentPitchCurveF0 = sequences.f0Hz ? sequences.f0Hz.subarray(0, totalFrames) : null;

            await this._runDiffusionLoop(xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, onProgress, progressStart, progressRange, null, abortSignal);
        }

        // 诊断：扩散输出（vocoder 输入 mel）统计 - 检查是否包含 NaN/异常值
        // NaN/Inf 致命错误 console.error 始终输出；统计采样 console.log 受 diagnosticMode 控制
        {
            const xtLen = xt.data.length;
            let xtNaN = 0, xtInf = 0;
            for (let i = 0; i < xtLen; i++) {
                const v = xt.data[i];
                if (Number.isNaN(v)) { xtNaN++; continue; }
                if (!Number.isFinite(v)) { xtInf++; }
            }
            if (xtNaN > 0 || xtInf > 0) {
                console.error(`[DiffusionDiag] DIFFUSION OUTPUT HAS NaN/Inf! This will cause vocoder explosion!`);
            }
            if (_readDiagnosticMode()) {
                let xtMin = Infinity, xtMax = -Infinity, xtSum = 0, xtSumSq = 0;
                for (let i = 0; i < xtLen; i++) {
                    const v = xt.data[i];
                    if (Number.isNaN(v) || !Number.isFinite(v)) continue;
                    if (v < xtMin) xtMin = v;
                    if (v > xtMax) xtMax = v;
                    xtSum += v;
                    xtSumSq += v * v;
                }
                const xtMean = xtSum / xtLen;
                const xtStd = Math.sqrt(Math.max(0, xtSumSq / xtLen - xtMean * xtMean));
                console.log(`[DiffusionDiag] OUTPUT xt (vocoder input): frames=${totalFrames}, len=${xtLen}, NaN=${xtNaN}, Inf=${xtInf}, min=${xtMin.toFixed(6)}, max=${xtMax.toFixed(6)}, mean=${xtMean.toFixed(6)}, std=${xtStd.toFixed(6)}`);
            }
        }

        // GPU 排空点 2：diffusion（64 次推理）→ vocoder 切换前等待 DML 回收 diffusion 的 GPU 资源。
        // 这是最关键的排空点：32 步 × 2 次 cond/uncond = 64 次连续 diff_step 推理后，
        // DML 内部资源池累积了大量 transformer 注意力中间张量，不排空直接进 vocoder 会 OOM。
        await gpuDrainAdaptive();

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
            baseModelsIsFP16: this.baseModelsIsFP16,
            diffStepIsFP16: this.diffStepIsFP16,
            vocoderIsFP16: this.vocoderIsFP16 ?? this.isFP16,
            useStaticShapes: this.useStaticShapes,
            vocoderChunkFrames: this._resolveVocoderChunkFrames(),
            cfgScheduleOpts: this._currentCfgScheduleOpts || null,
            dynamicThresholdOpts: this._currentDynamicThresholdOpts || null,
            skipVocoder: true,
        };
        return requestSynthesis(wc, fullParams, onProgress);
    }

    /**
     * 批量合成两个片段（WebNN batch=4: 2 片段 × 2 CFG）
     * @param {number} f0ShiftA - segment A 的 f0Shift（per-segment，B2）
     * @param {number} f0ShiftB - segment B 的 f0Shift（per-segment，B2）
     */
    async _synthesizeSegmentPair(segANotes, segBNotes, bpm, f0Envelope, pitchCurveF0, f0ShiftA, f0ShiftB, ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale, npuDiffBatchSize, npuVocoderBatchSize, onProgress, progressStart, progressRange, segAStartBeat = 0, segBStartBeat = 0, abortSignal = null) {
        throwIfCancelled(abortSignal);
        // 多 segment 路径：传 segStartBeat 让 notesToSequences 正确索引绝对 pitchCurveF0
        const offsetA = (segAStartBeat / bpm) * 60;
        const offsetB = (segBStartBeat / bpm) * 60;
        const seqA = this.notesToSequences(segANotes, bpm, f0Envelope, pitchCurveF0, f0ShiftA, offsetA);
        const seqB = this.notesToSequences(segBNotes, bpm, f0Envelope, pitchCurveF0, f0ShiftB, offsetB);

        const framesA = seqA.f0Ids.length;
        const framesB = seqB.f0Ids.length;

        if (framesA === 0 && framesB === 0) return [{ audio: [], frames: 0 }, { audio: [], frames: 0 }];
        if (framesA === 0) return [{ audio: [], frames: 0 }, await this._synthesizeSegment(segBNotes, bpm, f0Envelope, pitchCurveF0, f0ShiftB, ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale, npuDiffBatchSize, npuVocoderBatchSize, onProgress, progressStart, progressRange, null, segBStartBeat, abortSignal)];
        if (framesB === 0) return [await this._synthesizeSegment(segANotes, bpm, f0Envelope, pitchCurveF0, f0ShiftA, ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale, npuDiffBatchSize, npuVocoderBatchSize, onProgress, progressStart, progressRange, null, segAStartBeat, abortSignal), { audio: [], frames: 0 }];

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
                cfgScheduleOpts: this._currentCfgScheduleOpts,
                dynamicThresholdOpts: this._currentDynamicThresholdOpts,
            },
            {
                sequences: seqB, tokenCount: seqB.tokenCount, totalFrames: framesB,
                ptMelData, ptFrameCount,
                totalSteps, cfgStrength, cfgRescale,
                npuDiffBatchSize, npuVocoderBatchSize,
                cfgScheduleOpts: this._currentCfgScheduleOpts,
                dynamicThresholdOpts: this._currentDynamicThresholdOpts,
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
            baseModelsIsFP16: this.baseModelsIsFP16,
            diffStepIsFP16: this.diffStepIsFP16,
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

    /**
     * 多分片时间交错流式合成（主页面 Play All 启用 diffStep 分块时使用）。
     *
     * 将所有分片的 diffusion chunk 按全局时间顺序交错推理：
     *   T1chunk1 → T2chunk1 → T1chunk2 → T2chunk2 → ...
     * 而非逐分片推理完再推理下一个，使首音频延迟与分片数量无关。
     *
     * 流程：
     * 1. 逐分片准备（encoder + 初始化噪声 + 分块规划）
     * 2. 合并所有分片的 chunk 到全局时间队列，按时间排序
     * 3. 按时间顺序执行：diffusion chunk → vocoder → 流式推送
     * 4. 混合所有分片音频到最终输出
     *
     * @param {Array} fragments - 分片规格数组 [{notes, startTimeBeat, durationBeats, options}]
     * @param {number} bpm
     * @param {Object} options - {onProgress, onChunkAudio}
     * @returns {Promise<Float32Array>} 混合后的完整音频
     */
    async synthesizeMultiStreaming(fragments, bpm, options = {}) {
        if (!this.initialized) {
            await this.init();
        }
        await this.ensureAllModelsLoaded();
        this._currentF0Hz = null;
        // Task 15: reset per-frame F0 curve for F0-aware chunked diffusion.
        this._currentPitchCurveF0 = null;
        const onProgress = options.onProgress || (() => {});
        const onChunkAudio = options.onChunkAudio || null;
        const abortSignal = options.abortSignal || null;
        throwIfCancelled(abortSignal);

        if (!fragments || fragments.length === 0) {
            return new Float32Array(0);
        }

        // 检查是否启用分块（从第一个分片的 options 读取，所有分片共用）
        // 校验所有 fragment 的 chunk 选项一致：若不一致，静默回退到第一个 fragment 的选项
        // 并记录 warning，避免后续 fragment 的差异化配置被无声忽略。
        const firstOpts = fragments[0].options || {};
        const chunkEnabled = firstOpts.diffStepChunk === true;
        const chunkFrames = firstOpts.diffStepChunkFrames || 500;
        const overlapFrames = firstOpts.diffStepOverlapFrames !== undefined ? firstOpts.diffStepOverlapFrames : 50;
        const totalSteps = firstOpts.nSteps || DEFAULT_DIFF_STEPS;
        const cfgStrength = firstOpts.cfg !== undefined ? firstOpts.cfg : CFG_STRENGTH;
        const cfgRescale = firstOpts.cfgRescale !== undefined ? firstOpts.cfgRescale : CFG_RESCALE;
        if (fragments.length > 1) {
            for (let fi = 1; fi < fragments.length; fi++) {
                const o = fragments[fi].options || {};
                if (o.diffStepChunk !== firstOpts.diffStepChunk ||
                    (o.diffStepChunkFrames || 500) !== chunkFrames ||
                    ((o.diffStepOverlapFrames !== undefined ? o.diffStepOverlapFrames : 50)) !== overlapFrames) {
                    console.warn(`[MultiStream] Fragment ${fi} has inconsistent chunk options; using fragment 0 settings (chunkEnabled=${chunkEnabled}, chunkFrames=${chunkFrames}, overlap=${overlapFrames})`);
                    break;
                }
            }
        }

        // 设置分块选项（供 _runDiffusionLoop 内部判断）
        this._currentDiffStepChunkOpts = {
            enabled: chunkEnabled,
            chunkFrames,
            overlapFrames,
        };
        // 求解器名称（取首片段配置，多片段必须一致）
        this._currentSamplerName = firstOpts.sampler || DEFAULT_SOLVER;
        // Task 11: CFG 强度曲线调度（取首片段配置，多片段必须一致）
        this._currentCfgScheduleOpts = {
            mode: firstOpts.cfgScheduleMode || 'linear',
            cfgStrengthStart: firstOpts.cfgStrengthStart ?? null,
            keyframes: firstOpts.cfgScheduleKeyframes ?? null,
        };
        // Dynamic thresholding (arXiv:2507.08965): per-frame percentile clipping
        this._currentDynamicThresholdOpts = firstOpts.dynamicThresholdEnabled
            ? { enabled: true, percentile: firstOpts.dynamicThresholdPercentile ?? 0.995 }
            : null;

        console.log(`[OnnxSVSPipeline] synthesizeMultiStreaming: ${fragments.length} fragments, chunkEnabled=${chunkEnabled}, chunkFrames=${chunkFrames}`);

        const multiStreamCacheKey = [
            'multi-stream-v2', bpm, totalSteps, cfgStrength, cfgRescale,
            chunkEnabled, chunkFrames, overlapFrames,
            this._currentSamplerName || '',
            JSON.stringify(this._currentCfgScheduleOpts || {}),
            JSON.stringify(this._currentDynamicThresholdOpts || {}),
            this.modelPrecision || '', this.vocoderType || '', this.languageOverride || '',
            ...fragments.map((frag, idx) => [
                idx, frag.startTimeBeat, frag.durationBeats,
                this._computeSynthCacheKey(frag.notes || [], bpm, frag.options || {}),
            ].join(':')),
        ].join('|');
        const fullCached = this._multiStreamResultCache;
        if (fullCached && fullCached.key === multiStreamCacheKey) {
            console.log(`[MultiStream][result-cache] hit chunks=${fullCached.chunks.length}`);
            for (const chunk of fullCached.chunks) {
                throwIfCancelled(abortSignal);
                if (onChunkAudio) onChunkAudio({ ...chunk, audio: chunk.audio.slice(), cached: true });
                // Yield so Electron can deliver chunk events before the invoke reply.
                await new Promise(resolve => setImmediate(resolve));
            }
            onProgress(100);
            return fullCached.audio.slice();
        }
        const emittedChunks = [];

        // ===== Phase 1: split each track fragment into inference-only vocal regions =====
        // Keep the project/MIDI timeline intact, but never feed the centre of a
        // long rest to the model. Every region retains absolute note positions
        // within its source fragment, so Phase 4 naturally leaves the omitted
        // span as digital zero when mixing.
        //
        // NOTE: this must be _splitLongRestRegions(), NOT _buildVocalSegments().
        // buildVocalSegments re-bases note starts to the region origin and also
        // splits >20s audio into 2s-overlapping segments. The streaming path
        // below places every chunk at (fragment.startTimeBeat +
        // firstNoteStartBeat) with pitchCurveOffsetSec=0 and mixes with plain
        // addition — all of which assume absolute note starts and
        // non-overlapping regions. Rebased/overlapping regions made every
        // region mix at the fragment start (all voices piled up early, severe
        // overlap) and double-mixed the 2s overlaps.
        const inferenceRegions = [];
        for (let sourceFragIdx = 0; sourceFragIdx < fragments.length; sourceFragIdx++) {
            const sourceFrag = fragments[sourceFragIdx];
            const timelineNotes = this._fillNoteGaps(sourceFrag.notes);
            if (!timelineNotes || timelineNotes.length === 0) continue;
            const regions = this._splitLongRestRegions(timelineNotes, bpm);
            for (let regionIdx = 0; regionIdx < regions.length; regionIdx++) {
                const region = regions[regionIdx];
                if (!region.notes || region.notes.length === 0) continue;
                inferenceRegions.push({
                    ...sourceFrag,
                    notes: region.notes,
                    sourceFragIdx,
                    regionIdx,
                    regionStartBeat: region.startBeat,
                    regionEndBeat: region.endBeat,
                });
            }
        }

        const prepared = [];
        for (let fi = 0; fi < inferenceRegions.length; fi++) {
            throwIfCancelled(abortSignal);
            const frag = inferenceRegions[fi];
            const fragOpts = frag.options || {};
            // Region notes already include short <SP> rests and the small edge
            // context retained by splitLongRestRegions(). Do not fill gaps
            // again, or the deliberately omitted long-rest centre would be
            // reinserted. Note starts stay absolute (fragment-relative), so
            // firstNoteStartBeat below and pitchCurveOffsetSec=0 remain valid.
            const filledNotes = frag.notes;

            // autoShift F0 计算 —— 局部 autoShift：按子段独立计算 f0Shift
            const autoShift = fragOpts.autoShift || false;
            const pitchShift = fragOpts.pitchShift || 0;
            const refAudioWavBuffer = fragOpts.refAudioWavBuffer || null;
            const pitchCurveF0 = fragOpts.pitchCurveF0 || null;
            const f0Envelope = fragOpts.f0Envelope || null;

            const targetNotePitches = [];
            for (const note of filledNotes) {
                if (note.pitch >= 1) targetNotePitches.push(note.pitch);
            }

            let f0Shift = 0;
            let localSegShifts = null; // 非空时用 _applyLocalF0Shifts 代替全局 f0Shift

            if (autoShift && pitchShift === 0) {
                // 提取参考 F0（所有子段共用）
                let refMedian = null;
                let refMedianPitch = null;
                if (refAudioWavBuffer) {
                    let refF0 = null;
                    try {
                        refF0 = await this._extractRefF0WithFallback(refAudioWavBuffer, fragOpts.refF0Extractor || null);
                    } catch (e) {
                        console.warn(`[MultiStream] Fragment ${fi} ref F0 extraction failed:`, e.message);
                    }
                    if (refF0 && refF0.length > 0) {
                        const refNonZero = [];
                        for (let i = 0; i < refF0.length; i++) {
                            if (refF0[i] > 0) refNonZero.push(refF0[i]);
                        }
                        if (refNonZero.length > 0) {
                            refMedian = this._median(refNonZero);
                        }
                    }
                    if (refMedian === null && targetNotePitches.length > 0) {
                        const refNotePitches = await this._extractRefNotePitchesAsync(refAudioWavBuffer);
                        if (refNotePitches && refNotePitches.length > 0) {
                            refMedianPitch = this._median(refNotePitches);
                        }
                    }
                }
                if (refMedian === null && refMedianPitch === null && targetNotePitches.length > 0) {
                    const refNotePitches = fragOpts.refNotePitches || fragOpts.refMidiNotes || null;
                    if (refNotePitches && refNotePitches.length > 0) {
                        refMedianPitch = this._median(refNotePitches);
                    }
                }

                if (refMedian !== null || refMedianPitch !== null) {
                    // Use one shift for the whole fragment. Reusing the same
                    // short reference median for every local musical phrase
                    // can make adjacent phrases alternate between +12/-12,
                    // which destroys absolute MIDI pitch and weakens speaker
                    // conditioning. Smart segmentation still controls
                    // diffusion chunk boundaries, but never retunes phrases.
                    const targetF0 = this.buildF0FrameSequence(filledNotes, bpm, f0Envelope, pitchCurveF0);
                    const targetNonZero = [];
                    for (let i = 0; i < targetF0.length; i++) {
                        if (targetF0[i] > 0) targetNonZero.push(targetF0[i]);
                    }
                    if (refMedian !== null && targetNonZero.length > 0) {
                        const targetMedian = this._median(targetNonZero);
                        f0Shift = Math.round(Math.log2(refMedian / targetMedian) * 1200 / 100);
                    } else if (refMedianPitch !== null && targetNotePitches.length > 0) {
                        f0Shift = Math.round(refMedianPitch - this._median(targetNotePitches));
                    }
                    f0Shift = this._clampAutoShift(f0Shift, targetNotePitches);
                    console.log(`[MultiStream] Fragment ${fi}: global autoShift=${f0Shift}`);
                }
            } else {
                f0Shift = pitchShift;
            }
            if (this.languageOverride === 'ja' && targetNotePitches.length > 0 && localSegShifts === null) {
                f0Shift = this._clampJpPitchRange(f0Shift, targetNotePitches);
            }

            // Reference mel 提取
            let ptMelData = null;
            let ptFrameCount = 0;
            if (refAudioWavBuffer) {
                try {
                    const melResult = await this._extractRefMelOnnx(refAudioWavBuffer);
                    ptMelData = melResult.data;
                    ptFrameCount = melResult.frames;
                } catch (e) {
                    try {
                        const melResult = await this._extractRefMelAsync(refAudioWavBuffer);
                        ptMelData = melResult.data;
                        ptFrameCount = melResult.frames;
                    } catch (_) {}
                }
            }

            // 不调用 _buildVocalSegments 取 segments[0]：多分片流式路径中每个 fragment
            // 已是独立单元，若 fragment 音符跨度 > 30s（LONG_AUDIO_THRESHOLD_SEC），
            // _buildVocalSegments 会拆分为多段但此处仅取第一段，导致后续段落的音符被
            // 丢弃——表现为"播放到某个时间点后后续全部没声音"。直接使用 filledNotes，
            // 由 chunkPlan 的分块机制处理长片段的扩散推理，MAX_SAFE_FRAMES 仍作为安全上限。
            const segNotes = filledNotes;
            const pitchCurveOffsetSec = 0;
            // 局部 autoShift: 先用 f0Shift=0 构建 sequences，再施加逐帧 shift
            const effectiveF0Shift = localSegShifts ? 0 : f0Shift;
            const sequences = this.notesToSequences(segNotes, bpm, f0Envelope, pitchCurveF0, effectiveF0Shift, pitchCurveOffsetSec);
            if (localSegShifts) {
                this._applyLocalF0Shifts(sequences, localSegShifts, bpm);
            }
            let totalFrames = sequences.f0Ids.length;
            if (totalFrames === 0) {
                console.log(`[MultiStream] Fragment ${fi}: 0 frames, skipping`);
                continue;
            }
            if (totalFrames > MAX_SAFE_FRAMES) {
                sequences.f0Ids = sequences.f0Ids.subarray(0, MAX_SAFE_FRAMES);
                sequences.mel2token = sequences.mel2token.subarray(0, MAX_SAFE_FRAMES);
                totalFrames = MAX_SAFE_FRAMES;
            }
            // 无 ref prompt 时生成合成 prompt 帧（prompt 提高音色/音高稳定性）。
            // 必须先确定 ptFrameCount，再钳制目标帧数，保证 ptFrameCount+totalFrames
            // 恒 <= NPU_STATIC_SEQ_LEN，否则 diffstep 的 xtInputBuf.set 与
            // xtInputTensor.data.set 会因 offset out of bounds 抛 RangeError。
            if (!ptMelData || ptFrameCount === 0) {
                ptFrameCount = Math.min(50, Math.max(10, Math.floor(totalFrames * 0.1)));
                ptMelData = new Float32Array(ptFrameCount * MEL_DIM);
            }
            // NPU 静态形状模型（int8/int8-npu）限制：totalFramesWithPrompt 不能超过
            // NPU_STATIC_SEQ_LEN，否则 encoder/diffstep 固定 [1,2048] 输入维度不匹配。
            // 长片段触发 "Tensor's size(2048) does not match data length(N)"；
            // 大 ref prompt（>50 帧）时若按 Math.min(ptFrameCount,50) 预留 target，
            // 会不足预留导致拼接溢出。因此统一放在 prompt 注入之后，
            // 用实际 ptFrameCount 预留 target 帧。启用静态形状分段合成时跳过整段钳制，
            // 由 _synthesizeStaticShapeSegments 逐段承载 2048 限制。
            if (this.useStaticShapes && !chunkEnabled && ptFrameCount + totalFrames > NPU_STATIC_SEQ_LEN) {
                const clamped = this._clampStaticShapeFrames(sequences, ptFrameCount, ptMelData, totalFrames, '[MultiStream]');
                totalFrames = clamped.totalFrames;
                ptFrameCount = clamped.ptFrameCount;
                ptMelData = clamped.ptMelData;
            }

            // Encoder（动态形状整段编码；静态形状分段合成时逐段编码后直接产出整段 mel）
            let combinedCond = null;
            let xt;
            let segmentedMel = null;
            if (this.useStaticShapes && chunkEnabled) {
                segmentedMel = await this._synthesizeStaticShapeSegments(
                    sequences, totalFrames, ptMelData, ptFrameCount,
                    totalSteps, cfgStrength, cfgRescale,
                    () => {}, 0, 0, abortSignal, '[MultiStream]'
                );
            }
            if (segmentedMel) {
                xt = { data: segmentedMel, dims: [1, totalFrames, MEL_DIM] };
            } else {
                combinedCond = await this._runEncoder(sequences, sequences.tokenCount, totalFrames, ptFrameCount);
                await gpuDrainAdaptive();
                xt = this.randomNoise(totalFrames, MEL_DIM);
            }
            const f0Hz = sequences.f0Hz ? sequences.f0Hz.subarray(0, totalFrames) : null;

            // 分块规划（仅动态形状使用 mel 域分块；静态形状由分段合成处理 2048 限制）
            let chunkPlan = null;
            if (chunkEnabled && !this.useStaticShapes) {
                // Task 15: compute per-frame F0 slope for F0-aware chunk boundary
                // selection (avoids splitting at F0 discontinuities). Matches the
                // f0Slope computation in runDiffusionLoopChunked.
                let f0Slope = null;
                if (f0Hz && f0Hz.length >= 2) {
                    f0Slope = new Float32Array(f0Hz.length);
                    for (let i = 0; i < f0Hz.length - 1; i++) {
                        f0Slope[i] = f0Hz[i + 1] - f0Hz[i];
                    }
                    f0Slope[f0Hz.length - 1] = 0;
                }
                chunkPlan = this._diffusion._planChunks(totalFrames, chunkFrames, overlapFrames, f0Slope);
            }

            // filledNotes[0].start is the first note's start beat within the fragment.
            // notesToSequences generates audio starting from this beat (totalDuration
            // = sum of note durations, NOT including leading silence before the first
            // note). So segAudio[0] corresponds to filledNotes[0].start, not beat 0.
            // firstNoteStartBeat is used to offset the chunk's sampleOffset so that
            // the audio is placed at its correct absolute project position
            // (fragment.startTime + firstNote.start, not fragment.startTime).
            const firstNoteStartBeat = filledNotes[0].start;

            prepared.push({
                fragIdx: frag.sourceFragIdx,
                regionIdx: frag.regionIdx,
                regionStartBeat: frag.regionStartBeat,
                regionEndBeat: frag.regionEndBeat,
                startTimeBeat: frag.startTimeBeat,
                durationBeats: frag.durationBeats,
                firstNoteStartBeat,
                bpm,
                xt,
                combinedCond,
                segmentedMel,
                ptMelData,
                ptFrameCount,
                totalFrames,
                f0Hz,
                sequences,
                chunkPlan,
                // Cache is scoped to the inference region, not the original
                // fragment. Editing a different region will not invalidate this
                // one, while boundary/context changes produce a different key.
                cacheBaseKey: [
                    this._computeSynthCacheKey(filledNotes, bpm, fragOpts),
                    frag.sourceFragIdx, frag.regionIdx,
                    frag.regionStartBeat, frag.regionEndBeat,
                ].join('|'),
                committedFrames: 0,
                filledNotes,
                segAudio: new Float32Array(totalFrames * HOP_SIZE),
            });
            console.log(`[MultiStream] Fragment ${frag.sourceFragIdx} region ${frag.regionIdx} prepared: ${totalFrames} frames, startTime=${frag.startTimeBeat}beat, firstNoteStart=${firstNoteStartBeat}beat, chunks=${chunkPlan ? chunkPlan.specs.length : 0}`);
        }

        if (prepared.length === 0) {
            return new Float32Array(0);
        }

        // 预计算 maxEndBeat / totalSamples（Phase 3 流式推送 + Phase 4 混合都用到）
        const maxEndBeat = Math.max(...prepared.map(p => p.startTimeBeat + p.durationBeats));
        const totalMixedSamples = Math.ceil((maxEndBeat / bpm) * 60 * SAMPLE_RATE);

        // ===== Phase 2: 构建全局时间顺序 chunk 队列 =====
        const globalChunks = [];
        for (let pi = 0; pi < prepared.length; pi++) {
            const p = prepared[pi];
            const fragStartSec = (p.startTimeBeat / bpm) * 60;
            if (p.chunkPlan) {
                for (let ci = 0; ci < p.chunkPlan.specs.length; ci++) {
                    const spec = p.chunkPlan.specs[ci];
                    const chunkGlobalTimeSec = fragStartSec + (spec.chunkStart / MEL_FRAME_RATE);
                    globalChunks.push({ prepIdx: pi, chunkIdx: ci, spec, globalTimeSec: chunkGlobalTimeSec, isChunked: true });
                }
            } else {
                // 无分块：整段作为一个"chunk"
                globalChunks.push({ prepIdx: pi, chunkIdx: 0, spec: { chunkStart: 0, chunkEnd: p.totalFrames, currentChunkFrames: p.totalFrames, isFirst: true, isLast: true }, globalTimeSec: fragStartSec, isChunked: false });
            }
        }
        globalChunks.sort((a, b) => a.globalTimeSec - b.globalTimeSec);

        console.log(`[MultiStream] Global chunk queue: ${globalChunks.length} chunks, time-ordered`);

        // Suppress per-chunk diffusion logs in normal mode; the final
        // [MultiStream] summary line is sufficient. Diagnostic mode
        // still logs every chunk via the suppressDoneLog=false override.
        this._suppressChunkDiffLog = globalChunks.length > 1;

        const emitPreparedChunk = (p, chunkInfo) => {
            if (!onChunkAudio || !chunkInfo || !chunkInfo.audio) return;
            const audio = chunkInfo.audio.slice();
            const fragStartSample = Math.round((p.startTimeBeat / bpm) * 60 * SAMPLE_RATE);
            const relativeStartBeat = ((chunkInfo.sampleOffset - fragStartSample) / SAMPLE_RATE) * (bpm / 60);
            this._silenceNonVocalRegions(audio, p.filledNotes, bpm, relativeStartBeat);
            const safeChunk = { ...chunkInfo, audio };
            emittedChunks.push({ ...safeChunk, audio: audio.slice() });
            onChunkAudio(safeChunk);
        };

        // ===== Phase 3: 按时间顺序执行 =====
        const totalGlobalChunks = globalChunks.length;
        const progressPerChunk = 100 / totalGlobalChunks;

        for (let gi = 0; gi < globalChunks.length; gi++) {
            const gc = globalChunks[gi];
            const p = prepared[gc.prepIdx];
            throwIfCancelled(abortSignal);

            if (gc.isChunked) {
                const expectedCommitted = gc.spec.isLast
                    ? gc.spec.chunkEnd
                    : Math.max(0, gc.spec.chunkEnd - p.chunkPlan.overlap);
                const expectedMelStart = p.committedFrames;
                const chunkCacheKey = [
                    'stream-v1', p.cacheBaseKey, gc.chunkIdx,
                    gc.spec.chunkStart, gc.spec.chunkEnd,
                    expectedMelStart, expectedCommitted,
                    totalSteps, cfgStrength, cfgRescale,
                    this._currentSamplerName || '',
                    JSON.stringify(this._currentCfgScheduleOpts || {}),
                    JSON.stringify(this._currentDynamicThresholdOpts || {}),
                    this.modelPrecision || '', this.vocoderType || '',
                ].join('|');
                const cachedChunk = this._chunkCacheGet(chunkCacheKey);
                if (cachedChunk && cachedChunk.melStart === expectedMelStart &&
                    cachedChunk.melEnd === expectedCommitted) {
                    p.xt.data.set(cachedChunk.mel, cachedChunk.xtStart * MEL_DIM);
                    const segSampleOffset = cachedChunk.melStart * HOP_SIZE;
                    p.segAudio.set(cachedChunk.audio, segSampleOffset);
                    p.committedFrames = cachedChunk.melEnd;
                    if (onChunkAudio) {
                        const fragStartSample = Math.round((p.startTimeBeat / bpm) * 60 * SAMPLE_RATE);
                        const firstNoteOffsetSample = Math.floor((p.firstNoteStartBeat / bpm) * 60 * SAMPLE_RATE);
                        emitPreparedChunk(p, {
                            chunkIndex: gi,
                            sampleOffset: fragStartSample + firstNoteOffsetSample + segSampleOffset,
                            sampleEnd: fragStartSample + firstNoteOffsetSample + segSampleOffset + cachedChunk.audio.length,
                            audio: cachedChunk.audio,
                            totalSamples: totalMixedSamples,
                            isLast: gi === globalChunks.length - 1,
                            cached: true,
                        });
                    }
                    onProgress(Math.min(100, (gi + 1) * progressPerChunk));
                    console.log(`[MultiStream][chunk-cache] hit fragment=${p.fragIdx} region=${p.regionIdx} chunk=${gc.chunkIdx}`);
                    continue;
                }

                // 分块路径：执行 single diffusion chunk
                const ctx = {
                    sessions: this.sessions,
                    xt: p.xt,
                    ptMelData: p.ptMelData,
                    ptFrameCount: p.ptFrameCount,
                    combinedCond: p.combinedCond,
                    totalSteps, cfgStrength, cfgRescale,
                    isFP16: this.diffStepIsFP16,
                    useStaticShapes: this.useStaticShapes,
                    overlap: p.chunkPlan.overlap,
                    // 透传用户选择的推理参数，否则 _runSingleDiffusionChunk → runDiffusionLoop
                    // 会 fallback 到默认值，导致多分片与单片段输出不一致
                    samplerName: this._currentSamplerName,
                    cfgScheduleOpts: this._currentCfgScheduleOpts,
                    dynamicThresholdOpts: this._currentDynamicThresholdOpts,
                    abortSignal,
                    // 逐 chunk 日志静默：多 chunk 流式合成时由 _suppressChunkDiffLog 控制，
                    // diagnosticMode 仍会强制输出（runDiffusionLoop 内部检查）。
                    suppressDoneLog: !!this._suppressChunkDiffLog,
                };
                const { newCommitted } = await this._diffusion._runSingleDiffusionChunk(
                    ctx, gc.spec, onProgress,
                    gi * progressPerChunk, progressPerChunk
                );

                // Vocoder on committed region
                if (newCommitted > p.committedFrames) {
                    const melStart = p.committedFrames;
                    const melEnd = newCommitted;
                    const melLen = melEnd - melStart;
                    const melData = new Float32Array(melLen * MEL_DIM);
                    melData.set(p.xt.data.subarray(melStart * MEL_DIM, melEnd * MEL_DIM));
                    const segF0 = p.f0Hz ? p.f0Hz.subarray(melStart, melEnd) : null;
                    const fragStartSample = Math.round((p.startTimeBeat / bpm) * 60 * SAMPLE_RATE);
                    // segAudio[0] corresponds to filledNotes[0].start (first note's
                    // start within fragment), not beat 0. Add firstNoteOffsetSample
                    // so chunk's sampleOffset reflects the audio's true absolute
                    // project position (fragment.startTime + firstNote.start).
                    const firstNoteOffsetSample = Math.floor((p.firstNoteStartBeat / bpm) * 60 * SAMPLE_RATE);
                    const segSampleOffset = melStart * HOP_SIZE;
                    const isLastGlobalChunk = gi === globalChunks.length - 1;

                    // 透传流式回调：vocoder 内部 chunk 完成时立即推送，
                    // sampleOffset 转换为全局采样位置（fragment 起点 + firstNote 偏移 + diffusion chunk 偏移 + vocoder chunk 偏移）。
                    // 这样大 chunkFrames 下 vocoder 内部分片时也能流式播放，避免等到整个 diffusion chunk 完成。
                    const vocoderOnChunk = onChunkAudio ? (chunkInfo) => {
                        try {
                            emitPreparedChunk(p, {
                                chunkIndex: gi,
                                sampleOffset: fragStartSample + firstNoteOffsetSample + segSampleOffset + chunkInfo.sampleOffset,
                                sampleEnd: fragStartSample + firstNoteOffsetSample + segSampleOffset + chunkInfo.sampleEnd,
                                audio: chunkInfo.audio,
                                totalSamples: totalMixedSamples,
                                isLast: isLastGlobalChunk && chunkInfo.isLast,
                            });
                        } catch (e) {
                            console.warn(`[MultiStream] onChunkAudio error: ${e.message}`);
                        }
                    } : null;

                    const segAudio = await this._runVocoderChunkedForSegment(melData, melLen, segF0, vocoderOnChunk);

                    // 存储到分片音频（用于 Phase 4 混合；流式播放已由 vocoderOnChunk 推送，不重复推送）
                    const copyLen = Math.min(segAudio.length, p.segAudio.length - segSampleOffset);
                    p.segAudio.set(segAudio.subarray(0, copyLen), segSampleOffset);

                    // Commit before the next cancellation check. Store the full
                    // generated mel chunk, including overlap needed by the next
                    // chunk, plus only the newly committed vocoder audio.
                    const xtStart = gc.spec.chunkStart;
                    const xtEnd = gc.spec.chunkEnd;
                    this._chunkCachePut(chunkCacheKey, {
                        melStart,
                        melEnd: newCommitted,
                        xtStart,
                        xtEnd,
                        mel: p.xt.data.slice(xtStart * MEL_DIM, xtEnd * MEL_DIM),
                        audio: segAudio.subarray(0, copyLen),
                    });
                    p.committedFrames = newCommitted;
                }
            } else {
                // 无分块路径：整段 diffusion + vocoder
                // Task 15: set per-fragment F0 curve for F0-aware chunked diffusion.
                this._currentPitchCurveF0 = p.f0Hz || null;
                // 静态形状分段合成：p.xt.data 已是逐段拼接好的完整 mel，无需再扩散。
                if (!p.segmentedMel) {
                    await this._runDiffusionLoop(p.xt, p.totalFrames, p.ptMelData, p.ptFrameCount, p.combinedCond, totalSteps, cfgStrength, cfgRescale, onProgress, gi * progressPerChunk, progressPerChunk, null, abortSignal);
                    await gpuDrainAdaptive();
                }
                const fragStartSample = Math.round((p.startTimeBeat / bpm) * 60 * SAMPLE_RATE);
                // 同分块路径：segAudio[0] 对应 filledNotes[0].start，需加 firstNoteOffsetSample
                const firstNoteOffsetSample = Math.floor((p.firstNoteStartBeat / bpm) * 60 * SAMPLE_RATE);
                const isLastGlobalChunk = gi === globalChunks.length - 1;
                const vocoderOnChunk = onChunkAudio ? (chunkInfo) => {
                    try {
                        emitPreparedChunk(p, {
                            chunkIndex: gi,
                            sampleOffset: fragStartSample + firstNoteOffsetSample + chunkInfo.sampleOffset,
                            sampleEnd: fragStartSample + firstNoteOffsetSample + chunkInfo.sampleEnd,
                            audio: chunkInfo.audio,
                            totalSamples: totalMixedSamples,
                            isLast: isLastGlobalChunk && chunkInfo.isLast,
                        });
                    } catch (e) {
                        console.warn(`[MultiStream] onChunkAudio error: ${e.message}`);
                    }
                } : null;
                const segAudio = await this._runVocoderChunkedForSegment(p.xt.data, p.totalFrames, p.f0Hz, vocoderOnChunk);
                const copyLen = Math.min(segAudio.length, p.segAudio.length);
                p.segAudio.set(segAudio.subarray(0, copyLen), 0);

                p.committedFrames = p.totalFrames;
            }

            onProgress(Math.round((gi + 1) * progressPerChunk));
        }

        // ===== Phase 4: 混合所有分片音频 =====
        const mixedAudio = new Float32Array(totalMixedSamples);
        for (const p of prepared) {
            // Enforce score silence in the stored waveform too. Streaming callbacks
            // are masked independently above because they are emitted before this phase.
            this._silenceNonVocalRegions(p.segAudio, p.filledNotes, bpm, p.firstNoteStartBeat);
            // segAudio[0] 对应 filledNotes[0].start，需加 firstNoteOffsetSample
            // 使音频放置在正确的绝对工程位置 (fragment.startTime + firstNote.start)
            const firstNoteOffsetSample = Math.floor((p.firstNoteStartBeat / bpm) * 60 * SAMPLE_RATE);
            const startSample = Math.round((p.startTimeBeat / bpm) * 60 * SAMPLE_RATE) + firstNoteOffsetSample;
            for (let i = 0; i < p.segAudio.length; i++) {
                const targetIdx = startSample + i;
                if (targetIdx < totalMixedSamples) {
                    mixedAudio[targetIdx] += p.segAudio[i];
                }
            }
        }
        // 多 fragment 叠加后峰值可能超过 1.0（如两个 0.95 峰值片段同时段叠加达 1.9），
        // Int16 转换时会严重削波。统一归一化到 0.95 防止削波。
        normalizePeakTo(mixedAudio, totalMixedSamples);

        this._multiStreamResultCache = {
            key: multiStreamCacheKey,
            audio: mixedAudio.slice(),
            chunks: emittedChunks.map(chunk => ({ ...chunk, audio: chunk.audio.slice() })),
        };
        console.log(`[MultiStream] Complete: ${prepared.length} fragments, ${globalChunks.length} chunks, ${totalMixedSamples} samples`);
        onProgress(100);
        await this._recreateHeavySessionsAfterSynthesis();
        this._suppressChunkDiffLog = false;
        return mixedAudio;
    }

    async _synthesizeImpl(notes, bpm, options = {}) {
        if (!this.initialized) {
            await this.init();
        }
        await this.ensureAllModelsLoaded();
        // Reset per-call F0 cache so a stale F0 from a previous synthesis cannot leak into SiFiGAN vocoder input
        this._currentF0Hz = null;
        // Task 15: reset per-frame F0 curve for F0-aware chunked diffusion.
        this._currentPitchCurveF0 = null;
        const onProgress = options.onProgress || (() => {});
        const abortSignal = options.abortSignal || null;
        throwIfCancelled(abortSignal);
        const f0Envelope = options.f0Envelope || null;
        const pitchCurveF0 = options.pitchCurveF0 || null;
        const refAudioWavBuffer = options.refAudioWavBuffer || null;
        const totalSteps = options.nSteps || DEFAULT_DIFF_STEPS;
        const cfgStrength = options.cfg !== undefined ? options.cfg : CFG_STRENGTH;
        const cfgRescale = options.cfgRescale !== undefined ? options.cfgRescale : CFG_RESCALE;
        const autoShift = options.autoShift || false;
        const pitchShift = options.pitchShift || 0;
        const smartSegmentation = options.smartSegmentation || false;
        const npuDiffBatchSize = options.npuDiffBatchSize || 4;
        const npuVocoderBatchSize = options.npuVocoderBatchSize || 2;
        const onChunkAudio = options.onChunkAudio || null;

        // 求解器名称（透传到 _runDiffusionLoop → diffusion.js）
        this._currentSamplerName = options.sampler || DEFAULT_SOLVER;
        // Task 11: CFG 强度曲线调度（透传到 _runDiffusionLoop → diffusion.js）
        this._currentCfgScheduleOpts = {
            mode: options.cfgScheduleMode || 'linear',
            cfgStrengthStart: options.cfgStrengthStart ?? null,
            keyframes: options.cfgScheduleKeyframes ?? null,
        };
        // Dynamic thresholding (arXiv:2507.08965): per-frame percentile clipping
        // of CFG-predicted mel before rescale. Prevents over-exposure at high CFG.
        this._currentDynamicThresholdOpts = options.dynamicThresholdEnabled
            ? { enabled: true, percentile: options.dynamicThresholdPercentile ?? 0.995 }
            : null;
        this._currentDiffStepChunkOpts = {
            enabled: options.diffStepChunk === true,
            chunkFrames: options.diffStepChunkFrames || 500,
            overlapFrames: options.diffStepOverlapFrames !== undefined ? options.diffStepOverlapFrames : 50,
        };

        const filledNotes = this._fillNoteGaps(notes);

        const cacheKey = this._computeSynthCacheKey(notes, bpm, options);
        const cachedAudio = this._synthCacheGet(cacheKey);
        if (cachedAudio) {
            console.warn(`[OnnxSVSPipeline] >>> CACHE HIT <<< key=${cacheKey.substring(0, 32)}... | Returning CACHED audio, vocoder will NOT run! (Clear cache: switch model or restart app)`);
            onProgress(100);
            return cachedAudio;
        }
        console.log(`[OnnxSVSPipeline] Cache MISS (key=${cacheKey.substring(0, 32)}...), running full synthesis pipeline`);

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

        // 局部 autoShift（smartSegmentation）：在单段路径中按子段独立计算 f0Shift
        // 使各段中位数都向参考中位数靠拢，而非全局单一偏移。
        let localSegShifts = null;
        if (false && smartSegmentation && autoShift && pitchShift === 0 && refAudioWavBuffer) {
            let refMedian = null;
            let refMedianPitch = null;
            try {
                const refF0 = await this._extractRefF0WithFallback(refAudioWavBuffer, options.refF0Extractor || null);
                if (refF0 && refF0.length > 0) {
                    const refNonZero = [];
                    for (let i = 0; i < refF0.length; i++) {
                        if (refF0[i] > 0) refNonZero.push(refF0[i]);
                    }
                    if (refNonZero.length > 0) refMedian = this._median(refNonZero);
                }
            } catch (_) {}
            if (refMedian === null && targetNotePitches.length > 0) {
                try {
                    const refNotePitches = await this._extractRefNotePitchesAsync(refAudioWavBuffer);
                    if (refNotePitches && refNotePitches.length > 0) {
                        refMedianPitch = this._median(refNotePitches);
                    }
                } catch (_) {}
                if (refMedianPitch === null) {
                    const refNotePitches = options.refNotePitches || null;
                    if (refNotePitches && refNotePitches.length > 0) {
                        refMedianPitch = this._median(refNotePitches);
                    }
                }
            }

            if (refMedian !== null || refMedianPitch !== null) {
                const segs = this._buildAutoShiftSegments(filledNotes, bpm);
                if (segs.length > 1) {
                    localSegShifts = [];
                    for (const seg of segs) {
                        const segPitches = seg.notes.filter(n => n.pitch >= 1).map(n => n.pitch);
                        let segShift = 0;
                        if (refMedian !== null) {
                            const segTargetF0 = this.buildF0FrameSequence(seg.notes, bpm, f0Envelope, pitchCurveF0);
                            const segNonZero = [];
                            for (let i = 0; i < segTargetF0.length; i++) {
                                if (segTargetF0[i] > 0) segNonZero.push(segTargetF0[i]);
                            }
                            if (segNonZero.length > 0) {
                                segShift = Math.round(Math.log2(refMedian / this._median(segNonZero)) * 1200 / 100);
                            }
                        } else if (refMedianPitch !== null && segPitches.length > 0) {
                            segShift = Math.round(refMedianPitch - this._median(segPitches));
                        }
                        segShift = this._clampAutoShift(segShift, segPitches);
                        if (this.languageOverride === 'ja' && segPitches.length > 0) {
                            segShift = this._clampJpPitchRange(segShift, segPitches);
                        }
                        localSegShifts.push({ startBeat: seg.startBeat, endBeat: seg.endBeat, f0Shift: segShift });
                    }
                    console.log(`[OnnxSVSPipeline] smartSegmentation: ${localSegShifts.length} segments, shifts=[${localSegShifts.map(s => s.f0Shift).join(', ')}]`);
                }
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
        if (segments.length === 0) {
            onProgress(100);
            return new Float32Array(0);
        }

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

            const effectiveF0Shift = localSegShifts ? 0 : f0Shift;
            const sequences = this.notesToSequences(segNotes, bpm, f0Envelope, pitchCurveF0, effectiveF0Shift, pitchCurveOffsetSec);
            if (localSegShifts) {
                this._applyLocalF0Shifts(sequences, localSegShifts, bpm);
            }
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

            // NPU 静态形状模型限制：ptFrameCount+totalFrames 不得超过 NPU_STATIC_SEQ_LEN。
            // 大 ref prompt（>50 帧）时按 Math.min(ptFrameCount,50) 预留 target 会不足预留，
            // 导致 diffstep 拼接 offset overflow；统一用实际 ptFrameCount 预留 target 帧。
            // 启用静态形状分段合成时跳过整段钳制，由 _synthesizeStaticShapeSegments 逐段承载限制。
            const _staticSegEnabled = this.useStaticShapes &&
                (this._currentDiffStepChunkOpts && this._currentDiffStepChunkOpts.enabled === true);
            if (this.useStaticShapes && !_staticSegEnabled && ptFrameCount + totalFrames > NPU_STATIC_SEQ_LEN) {
                const clamped = this._clampStaticShapeFrames(sequences, ptFrameCount, ptMelData, totalFrames, '[Synthesis]');
                totalFrames = clamped.totalFrames;
                ptFrameCount = clamped.ptFrameCount;
                ptMelData = clamped.ptMelData;
            }

            console.log(`[OnnxSVSPipeline] Synthesis params: frames=${totalFrames}, tokens=${sequences.tokenCount}, steps=${totalSteps}, cfg=${cfgStrength}, f0Shift=${f0Shift}`);

            currentProgress = 30;
            onProgress(currentProgress);

            // INT8 静态形状 + 分段合成：逐段 encoder+diffstep 直接产出整段 mel
            let segMel = null;
            if (_staticSegEnabled) {
                segMel = await this._synthesizeStaticShapeSegments(
                    sequences, totalFrames, ptMelData, ptFrameCount,
                    totalSteps, cfgStrength, cfgRescale,
                    (p) => onProgress(Math.round(40 + p * 0.5)), 40, 50, abortSignal, '[Synthesis]'
                );
            }
            let combinedCond = null;
            let xt;
            if (segMel) {
                xt = { data: segMel, dims: [1, totalFrames, MEL_DIM] };
            } else {
                combinedCond = await this._runEncoder(sequences, sequences.tokenCount, totalFrames, ptFrameCount);
                // GPU 排空点：encoder→diffusion 切换前等待 DML 回收 encoder 的 GPU 资源
                await gpuDrainAdaptive();
                xt = this.randomNoise(totalFrames, MEL_DIM);
            }

            // 提前设置 F0（分块流式路径在 diffusion 期间就需要 F0 片段）
            this._currentF0Hz = sequences.f0Hz ? sequences.f0Hz.subarray(0, totalFrames) : null;
            // Task 15: same per-frame F0 curve drives F0-aware chunked diffusion
            // boundary selection in _runDiffusionLoop → runDiffusionLoopChunked.
            this._currentPitchCurveF0 = this._currentF0Hz;
            // 单 segment 路径流式推送：仅在没有 contextPadding 截取时启用，避免 totalSamples 不一致
            const singleSegOnChunk = onChunkAudio && !contextPadding ? onChunkAudio : null;

            // 检测是否走分块流式路径（diffusion chunk + 即时 vocoder）
            const chunkOpts = this._currentDiffStepChunkOpts;
            // _planChunks 内部用 safeChunk = Math.max(50, chunkFrames)，当 safeChunk >=
            // totalFrames 时返回 null（回退到整段 runDiffusionLoop，不触发 onChunkMel）。
            // 若此处仅检查 totalFrames > chunkFrames，当 chunkFrames < 50 且
            // chunkFrames < totalFrames <= 50 时会进入流式路径但 _planChunks 返回 null，
            // 导致 segmentAudios 为空、audioData 全零（静音）。因此条件必须与
            // _planChunks 的 safeChunk 逻辑一致。
            const safeChunkFrames = Math.max(50, Math.floor(chunkOpts?.chunkFrames || 0));
            const useStreamingChunked = chunkOpts && chunkOpts.enabled && !this.useStaticShapes
                && chunkOpts.chunkFrames > 0 && totalFrames > safeChunkFrames
                && singleSegOnChunk; // 流式推送可用时才走此路径

            if (useStreamingChunked) {
                // ===== 分块流式路径：每 diffusion chunk 完成后立即 vocoder 推送音频 =====
                console.log(`[OnnxSVSPipeline] Streaming chunked diffusion+vocoder: totalFrames=${totalFrames}, chunkFrames=${chunkOpts.chunkFrames}, overlap=${chunkOpts.overlapFrames}`);
                const totalSamplesEst = totalFrames * HOP_SIZE;
                const segmentAudios = []; // {frameStart, audio}

                const onChunkMel = async (chunkInfo) => {
                    const { frameStart, frameEnd, melData, isLast } = chunkInfo;
                    const segFrames = frameEnd - frameStart;
                    const segF0 = this._currentF0Hz ? this._currentF0Hz.subarray(frameStart, frameEnd) : null;
                    const sampleOffsetBase = frameStart * HOP_SIZE;
                    // 包装流式回调：vocoder 内部 sampleOffset 是相对片段的，需加上片段在完整音频中的偏移
                    const wrappedOnChunk = (info) => {
                        singleSegOnChunk({
                            chunkIndex: info.chunkIndex,
                            sampleOffset: info.sampleOffset + sampleOffsetBase,
                            sampleEnd: info.sampleEnd + sampleOffsetBase,
                            audio: info.audio,
                            totalSamples: totalSamplesEst,
                            isLast: isLast && info.isLast,
                        });
                    };
                    const segAudio = await this._runVocoderChunkedForSegment(melData, segFrames, segF0, wrappedOnChunk);
                    segmentAudios.push({ frameStart, audio: segAudio });
                };

                await this._runDiffusionLoop(xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, onProgress, 40, 50, onChunkMel, abortSignal);

                // 拼接各段音频为完整 audioData（用于缓存和返回）
                let audioData = new Float32Array(totalSamplesEst);
                for (const { frameStart, audio } of segmentAudios) {
                    const offset = frameStart * HOP_SIZE;
                    const copyLen = Math.min(audio.length, totalSamplesEst - offset);
                    audioData.set(audio.subarray(0, copyLen), offset);
                }
                // 末尾截断到实际长度（vocoder 可能多输出几个样本）
                if (audioData.length > totalSamplesEst) {
                    audioData = audioData.slice(0, totalSamplesEst);
                }
                console.log(`[OnnxSVSPipeline] Streaming chunked complete: ${segmentAudios.length} segments, ${audioData.length} samples`);

                // 单 note 上下文 padding 截取
                if (contextPadding) {
                    const startSample = contextPadding.offsetFrames * HOP_SIZE;
                    const validSamples = contextPadding.validFrames * HOP_SIZE;
                    const endSample = Math.min(startSample + validSamples, audioData.length);
                    audioData = audioData.slice(startSample, endSample);
                }
                this._silenceNonVocalRegions(audioData, filledNotes, bpm, filledNotes[0]?.start || 0);
                const MAX_CACHE_SAMPLES = SAMPLE_RATE * 120;
                if (audioData.length <= MAX_CACHE_SAMPLES) {
                    this._synthCachePut(cacheKey, audioData);
                }
                onProgress(100);
                await this._recreateHeavySessionsAfterSynthesis();
                return audioData;
            }

            // ===== 常规路径：整段 diffusion → 整段 vocoder =====
            // 静态形状分段合成：xt.data 已是完整 mel，跳过 diffusion。
            if (!segMel) {
                await this._runDiffusionLoop(xt, totalFrames, ptMelData, ptFrameCount, combinedCond, totalSteps, cfgStrength, cfgRescale, onProgress, 40, 50, null, abortSignal);
            }

            // 诊断：扩散输出（vocoder 输入 mel）统计 - 检查是否包含 NaN/异常值
            // NaN/Inf 致命错误 console.error 始终输出；统计采样 console.log 受 diagnosticMode 控制
            {
                const xtLen = xt.data.length;
                let xtNaN = 0, xtInf = 0;
                for (let i = 0; i < xtLen; i++) {
                    const v = xt.data[i];
                    if (Number.isNaN(v)) { xtNaN++; continue; }
                    if (!Number.isFinite(v)) { xtInf++; }
                }
                if (xtNaN > 0 || xtInf > 0) {
                    console.error(`[DiffusionDiag] DIFFUSION OUTPUT HAS NaN/Inf! This will cause vocoder explosion!`);
                }
                if (_readDiagnosticMode()) {
                    let xtMin = Infinity, xtMax = -Infinity, xtSum = 0, xtSumSq = 0;
                    for (let i = 0; i < xtLen; i++) {
                        const v = xt.data[i];
                        if (Number.isNaN(v) || !Number.isFinite(v)) continue;
                        if (v < xtMin) xtMin = v;
                        if (v > xtMax) xtMax = v;
                        xtSum += v;
                        xtSumSq += v * v;
                    }
                    const xtMean = xtSum / xtLen;
                    const xtStd = Math.sqrt(Math.max(0, xtSumSq / xtLen - xtMean * xtMean));
                    console.log(`[DiffusionDiag] OUTPUT xt (vocoder input): frames=${totalFrames}, len=${xtLen}, NaN=${xtNaN}, Inf=${xtInf}, min=${xtMin.toFixed(6)}, max=${xtMax.toFixed(6)}, mean=${xtMean.toFixed(6)}, std=${xtStd.toFixed(6)}`);
                }
            }

            // GPU 排空点：diffusion（64 次推理）→ vocoder 切换前等待 DML 回收 GPU 资源
            await gpuDrainAdaptive();

            onProgress(90);
            let audioData = await this._runVocoderChunked(xt.data, totalFrames, singleSegOnChunk);

            // 单 note 上下文 padding：截取有效音频（丢弃前后 rest padding）
            // 注意：外部 totalFrames 始终是 50Hz 帧数（SVS mel 帧率），
            // 即使 SiFiGAN 内部已 4× 上采样，postprocessing 也已统一回 HOP_SIZE 输出长度，
            // 因此这里固定用 HOP_SIZE（480 samples/帧）计算采样位置。
            if (contextPadding) {
                const startSample = contextPadding.offsetFrames * HOP_SIZE;
                const validSamples = contextPadding.validFrames * HOP_SIZE;
                const endSample = Math.min(startSample + validSamples, audioData.length);
                audioData = audioData.slice(startSample, endSample);
            }

            this._silenceNonVocalRegions(audioData, filledNotes, bpm, filledNotes[0]?.start || 0);
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
        const perSegAutoShift = false; // Preserve absolute MIDI pitch: autoShift is global, never segment-dependent.
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

        // 分片级缓存预计算：长音频编辑时，未改动 segment 的输入（notes/bpm/f0/ref/segF0Shift）
        // 与上次完全相同 → 音频相同，可直接复用缓存跳过 diffusion+vocoder，只重算改动 segment。
        // 此处在前置休止符补齐之后计算键，确保键反映 segment 实际使用的 notes。
        // segF0Shift 与循环内 _computeSegF0Shift 调用使用相同入参，结果一致。
        //
        // 适用范围与优雅降级（结果始终正确，仅命中率下降）：
        //   - 最有效：pitch-only 编辑且 autoShift 关（或全局中位数稳定）→ 仅改动 segment 失效。
        //   - autoShift 开启时，编辑触及全局中位数会使 globalTargetMedian 漂移 → 所有 segment
        //     的 segF0Shift 变化 → _fs 后缀变化 → 全部分片失效（此时输出确实不同，失效正确）。
        //   - 自定义音高曲线（pitchCurveF0 非空）随音符 start/duration 变化 → f0Hash 变化 →
        //     全部分片失效。这两种场景下退化为整曲重算，行为与未引入分片缓存时一致。
        const segCacheKeys = new Array(segments.length);
        const segCachedAudios = new Array(segments.length);
        let segCacheHits = 0;
        for (let i = 0; i < segments.length; i++) {
            const s = segments[i];
            const sF0Shift = this._computeSegF0Shift(f0Shift, globalTargetMedian, s.notes);
            const sKey = this._computeSegmentCacheKey(s.notes, bpm, options, s.startBeat, sF0Shift, ptFrameCount);
            segCacheKeys[i] = sKey;
            const hit = this._segCacheGet(sKey);
            segCachedAudios[i] = hit;
            if (hit) segCacheHits++;
        }
        if (segCacheHits > 0) {
            console.log(`[OnnxSVSPipeline] Segment cache: ${segCacheHits}/${segments.length} hits, skipping synthesis for unchanged segments`);
        }

        while (segIdx < segments.length) {
            // 段间 GPU 排空：让事件循环处理 GC 并给 DML 50ms 时间回收上一段的
            // 中间张量（mel/f0/waveform/transformer 注意力），降低长音频多段合成时
            // VRAM 碎片累积导致的 OOM 风险。旧版 setImmediate(~1ms) 不够 DML 回收。
            // 首次迭代前 yield 无副作用（仅多一次事件循环调度）。
            if (segIdx > 0) {
                await gpuDrainAdaptive();
            }

            if (useBatch && segIdx + 1 < segments.length && !segCachedAudios[segIdx] && !segCachedAudios[segIdx + 1]) {
                // Pair two segments for batch=4 diffusion
                // 仅当两个 segment 均未命中分片缓存时才走 batch 路径；任一命中则落到
                // 下面的单 segment 路径（命中段直接复用缓存，未命中段单独推理）。
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
                    segA.startBeat, segB.startBeat, abortSignal
                );

                // 分片缓存写入：batch 合成的两段都是 miss（见上方条件），结果存入分片缓存
                if (pairResult[0].audio.length > 0) this._segCachePut(segCacheKeys[segIdx], pairResult[0].audio);
                if (pairResult[1].audio.length > 0) this._segCachePut(segCacheKeys[segIdx + 1], pairResult[1].audio);

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
                if (segIdx < segments.length - 1) await gpuDrainAdaptive();
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

            // 分片缓存命中：直接复用上次该 segment 的音频，跳过 diffusion+vocoder。
            // segCachedAudios[segIdx] 在循环前已查表（含 LRU 提升），此处直接取用。
            let segResult;
            const cachedSegAudio = segCachedAudios[segIdx];
            if (cachedSegAudio) {
                console.log(`[OnnxSVSPipeline] >>> SEGMENT CACHE HIT <<< seg=${segIdx} startBeat=${seg.startBeat.toFixed(2)} | skipping diffusion+vocoder for this segment`);
                onProgress(Math.round(segProgressStart + segProgressRange));
                // 下游只消费 segResult.audio（写入 finalAudio），无需 frames；
                // 真实 mel 帧数在 _synthesizeSegment 内部使用，缓存命中路径不涉及。
                segResult = { audio: cachedSegAudio };
            } else {
                segResult = await this._synthesizeSegment(
                    seg.notes, bpm, f0Envelope, pitchCurveF0, segF0Shift,
                    ptMelData, ptFrameCount, totalSteps, cfgStrength, cfgRescale,
                    npuDiffBatchSize, npuVocoderBatchSize,
                    onProgress, segProgressStart, segProgressRange,
                    null, seg.startBeat, abortSignal
                );
                // 分片缓存写入：miss 后重算的结果存入，供后续未改动场景复用
                if (segResult.audio.length > 0) {
                    this._segCachePut(segCacheKeys[segIdx], segResult.audio);
                }
            }

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
            if (segIdx < segments.length - 1) await gpuDrainAdaptive();
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
        this._silenceNonVocalRegions(audioData, filledNotes, bpm, filledNotes[0]?.start || 0);
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
    async loadModel(sessionKey, options = {}) {
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
            // int8 优先 QDIT diffstep.onnx；其余检查 _dml 变体，缺失回退 diff_step.onnx
            resolvedFile = await this._resolveDiffStepFile();
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
                modelPath, sessionKey, this.gpuDeviceName, this.dmlDeviceId, this.isFP16, this.useStaticShapes, sifiganDummy, options.runValidation !== false
            );
            this.sessions[sessionKey] = session;
            this.sessionEPs[sessionKey] = ep;
            console.log(`[OnnxSVSPipeline] Model ${sessionKey} loaded [${ep}]`);
            if (sessionKey === 'diffStep') this._detectDiffStepPrecision();
            return { success: true, ep };
        } catch (err) {
            const fallbackPath = this._getNpuFallbackPath(resolvedFile);
            if (fallbackPath) {
                console.warn(`[OnnxSVSPipeline] ${resolvedFile} NPU load failed, trying fallback: ${err.message.substring(0, 80)}`);
                try {
                    const { session, ep } = await createSessionWithValidation(
                        fallbackPath, sessionKey, this.gpuDeviceName, this.dmlDeviceId, this.isFP16, false, sifiganDummy, options.runValidation !== false
                    );
                    this.sessions[sessionKey] = session;
                    this.sessionEPs[sessionKey] = ep;
                    console.log(`[OnnxSVSPipeline] Model ${sessionKey} loaded from fallback [${ep}]`);
                    if (sessionKey === 'diffStep') this._detectDiffStepPrecision();
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
            // diff_step W16A32 回退：fp16 子目录的 W16A32 模型在 onnxruntime-node 1.27.0 上推理失败，
            // 回退到 baseModelDir（根目录）的 FP32 模型
            if (sessionKey === 'diffStep' && this.baseModelDir && this.modelDir !== this.baseModelDir) {
                console.warn(`[OnnxSVSPipeline] diff_step load failed in ${this.modelDir}, trying FP32 from ${this.baseModelDir}: ${err.message.substring(0, 80)}`);
                const fp32Path = path.join(this.baseModelDir, resolvedFile);
                let fp32Exists = false;
                try { await fs.promises.access(fp32Path); fp32Exists = true; } catch (_) {}
                if (fp32Exists) {
                    try {
                        const { session, ep } = await createSessionWithValidation(
                            fp32Path, sessionKey, this.gpuDeviceName, this.dmlDeviceId, false, this.useStaticShapes, sifiganDummy, options.runValidation !== false
                        );
                        this.sessions[sessionKey] = session;
                        this.sessionEPs[sessionKey] = ep;
                        console.log(`[OnnxSVSPipeline] diff_step FP32 loaded from baseModelDir [${ep}] (W16A32 fallback)`);
                        this._detectDiffStepPrecision();
                        return { success: true, ep };
                    } catch (fp32Err) {
                        console.warn(`[OnnxSVSPipeline] diff_step FP32 fallback also failed: ${fp32Err.message.substring(0, 80)}`);
                        return { success: false, error: fp32Err.message };
                    }
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
        this._segCacheMap = null;
        this._segCacheBytes = 0;
        this._currentF0Hz = null;
        console.log('[OnnxSVSPipeline] ONNX Runtime sessions released');
    }
}

module.exports = { OnnxSVSPipeline, NativeSVSPipeline: OnnxSVSPipeline, SAMPLE_RATE, enumerateDMLDevices };
