/**
 * 英语音素时长统计表懒加载与查表模块。
 *
 * 数据源：src/inference/en_phoneme_durations.json
 * 由 build_en_phoneme_duration_stats.py 从 MFA-aligned LJSpeech 生成。
 *
 * 查表回退链（精度从高到低）：
 *   trigram_full (prev|curr|next|pos|stress)  → 最精确，但稀疏
 *   trigram      (prev|curr|next)
 *   bigram       (prev|curr)
 *   unigram      (curr)                       → 最鲁棒，总有命中
 *
 * 极短音符（innerFrames < phonemeCount）不查表，由 preprocessing.js 的元音优先策略处理。
 */

const path = require('path');
const fs = require('fs');

// ANSI 颜色码（用于终端日志区分级别）
const COLOR = {
    yellow: msg => `\x1b[33m${msg}\x1b[0m`,
    red:    msg => `\x1b[31m${msg}\x1b[0m`,
    green:  msg => `\x1b[32m${msg}\x1b[0m`,
};

let _cache = null;        // 已解析的 JSON 对象
let _loading = null;      // 正在进行的加载 Promise

/**
 * 查找 en_phoneme_durations.json 的实际路径。
 * 兼容开发环境（src/inference/）和打包环境（.webpack/main/）。
 * @returns {string|null} 找到的路径，或 null
 */
function _findStatsPath() {
    // 候选路径（与 textProcessing.js 的 phone_set.json 加载策略一致）：
    // 1. __dirname/en_phoneme_durations.json
    //    - 开发: src/inference/pipeline/en_phoneme_durations.json (不存在)
    //    - 打包: .webpack/main/en_phoneme_durations.json          (命中，CopyPlugin 复制到此)
    // 2. __dirname/../en_phoneme_durations.json
    //    - 开发: src/inference/en_phoneme_durations.json           (命中)
    //    - 打包: .webpack/en_phoneme_durations.json               (不存在)
    // 3. __dirname/../../inference/en_phoneme_durations.json
    //    - 开发: src/inference/en_phoneme_durations.json           (重复，兜底)
    // 4. __dirname/../../../src/inference/en_phoneme_durations.json
    //    - 开发: ../../src/inference/en_phoneme_durations.json     (兜底)
    const searchPaths = [
        path.join(__dirname, 'en_phoneme_durations.json'),
        path.join(__dirname, '..', 'en_phoneme_durations.json'),
        path.join(__dirname, '..', '..', 'inference', 'en_phoneme_durations.json'),
        path.join(__dirname, '..', '..', '..', 'src', 'inference', 'en_phoneme_durations.json'),
    ];
    // Fallback paths for packaged Electron app (asar / unpacked)
    try {
        if (process.resourcesPath) {
            searchPaths.push(path.join(process.resourcesPath, 'app.asar', '.webpack', 'main', 'en_phoneme_durations.json'));
            searchPaths.push(path.join(process.resourcesPath, 'app', '.webpack', 'main', 'en_phoneme_durations.json'));
        }
    } catch (_) {}
    // Fallback: require.main.path (non-webpack / CLI mode)
    try {
        if (require.main && require.main.path) {
            searchPaths.push(path.join(require.main.path, 'inference', 'en_phoneme_durations.json'));
            searchPaths.push(path.join(require.main.path, 'src', 'inference', 'en_phoneme_durations.json'));
        }
    } catch (_) {}
    for (const p of searchPaths) {
        try {
            if (fs.existsSync(p)) return p;
        } catch (_) { /* ignore */ }
    }
    return null;
}

/**
 * 懒加载时长统计 JSON。首次调用时读取文件，后续返回缓存。
 * 开发环境和打包环境都能正常工作（自动搜索候选路径）。
 * @returns {Promise<Object>} 统计表对象
 */
function loadDurationStats() {
    if (_cache) return Promise.resolve(_cache);
    if (_loading) return _loading;

    const jsonPath = _findStatsPath();
    if (!jsonPath) {
        console.warn(COLOR.yellow('[durationStats] Warning: en_phoneme_durations.json not found in any search path; falling back to linear allocation'));
        _cache = { unigram: {}, bigram: {}, trigram: {}, trigram_full: {}, by_stress: {}, by_position: {} };
        return Promise.resolve(_cache);
    }

    _loading = fs.promises.readFile(jsonPath, 'utf-8')
        .then(text => {
            _cache = JSON.parse(text);
            _loading = null;
            const n = Object.keys(_cache.unigram || {}).length;
            console.log(COLOR.green(`[durationStats] Loaded phoneme duration stats: ${n} phonemes (path: ${jsonPath})`));
            return _cache;
        })
        .catch(err => {
            _loading = null;
            // 加载失败不应阻塞推理，返回空表让调用方走 unigram fallback
            console.warn(COLOR.yellow(`[durationStats] Warning: Failed to load en_phoneme_durations.json (${jsonPath}): ${err.message}; falling back to linear allocation`));
            _cache = { unigram: {}, bigram: {}, trigram: {}, trigram_full: {}, by_stress: {}, by_position: {} };
            return _cache;
        });
    return _loading;
}

/**
 * 同步获取已加载的统计表（若未加载返回 null）。
 * 用于不方便写异步的场景；推荐优先用 loadDurationStats。
 */
function getDurationStatsSync() {
    return _cache;
}

/**
 * 同步获取已加载的统计表。若未加载返回空表（让调用方走 unigram fallback），
 * 永不阻塞主线程。
 *
 * 性能审查 (#5) 修复：原实现在 _cache 为 null 且 _loading 为 null 时
 * 会同步 readFileSync + JSON.parse 4MB JSON，阻塞主线程 50-100ms。
 * 实际文件 4MB（非审查报告所称 200MB，但仍不应在 IPC 路径同步解析）。
 * 修复后：严格只读缓存，未加载则返回空表，由异步 preload() 在后台填充。
 * preload() 在 Preprocessing 构造时调用，远早于 IPC 触发 resolveLyricToPhonemes。
 * @returns {Object} 统计表对象（可能为空表）
 */
function loadDurationStatsSync() {
    if (_cache) return _cache;
    // 异步加载正在进行中或尚未开始：返回空表让调用方走 fallback，不阻塞主线程
    if (!_loading) {
        // 异步加载尚未触发：在后台启动一次（不阻塞当前同步调用）
        preload().catch(() => {});
    }
    return { unigram: {}, bigram: {}, trigram: {}, trigram_full: {}, by_stress: {}, by_position: {} };
}

/**
 * 释放已加载的统计表缓存，释放常驻内存。
 * 适用于长时间不进行合成时主动回收内存。
 * 注意：调用后再次合成时会触发异步重新加载（首次合成会有少量延迟）。
 */
function unloadDurationStats() {
    if (_loading) {
        // 正在加载中：不能直接清空，否则加载完成后会重新填充 _cache
        // 将 _cache 置为 null，加载完成时 _loading.then 会重新赋值（这正是我们想要的）
        _cache = null;
        return;
    }
    _cache = null;
}

/**
 * 预加载（可选）：在 SVS pipeline 初始化时调用，避免首次推理时阻塞。
 */
function preload() {
    return loadDurationStats();
}

/**
 * 从音素名提取重音等级。
 * @param {string} phoneName 如 'en_AE1' / 'en_T' / 'jp_a'
 * @returns {string} '0'|'1'|'2' for stressed vowels, 'X' for consonants/unstressed
 */
function extractStress(phoneName) {
    if (!phoneName || !phoneName.startsWith('en_')) return 'X';
    const base = phoneName.slice(3);
    // 元音基名（不含重音）
    const vowelBases = new Set(['AA', 'AE', 'AH', 'AO', 'AW', 'AY', 'EH', 'ER', 'EY', 'IH', 'IY', 'OW', 'OY', 'UH', 'UW']);
    const stressless = base.replace(/[012]$/, '');
    if (!vowelBases.has(stressless)) return 'X';
    const last = base.slice(-1);
    return (last === '0' || last === '1' || last === '2') ? last : '0';
}

/**
 * 裸音素名（去 en_ 前缀），用于查表。
 * @param {string} phoneName 如 'en_AE1'
 * @returns {string} 'AE1'
 */
function barePhone(phoneName) {
    if (!phoneName) return '';
    if (phoneName.startsWith('en_')) return phoneName.slice(3);
    return phoneName;
}

/**
 * 查询某个音素在上下文中的相对时长权重（比例，无量纲）。
 *
 * @param {Object} stats 已加载的统计表
 * @param {string} currPhone 当前音素裸名（如 'AE1'）
 * @param {string} prevPhone 前一音素裸名（如 'T'），无则 '<S>'
 * @param {string} nextPhone 后一音素裸名（如 'T'），无则 '<E>'
 * @param {string} position 词内位置 'initial'|'medial'|'final'
 * @returns {number} 时长比例（>0），查不到返回 unigram 均值，再查不到返回 1.0
 */
function lookupWeight(stats, currPhone, prevPhone, nextPhone, position) {
    if (!stats || !currPhone) return 1.0;

    const stress = extractStress('en_' + currPhone);

    // 1. trigram_full: prev|curr|next|pos|stress
    if (stats.trigram_full) {
        const key = `${prevPhone}|${currPhone}|${nextPhone}|${position}|${stress}`;
        const e = stats.trigram_full[key];
        if (e && e.mean_ms > 0) return e.mean_ms;
    }

    // 2. trigram: prev|curr|next
    if (stats.trigram) {
        const key = `${prevPhone}|${currPhone}|${nextPhone}`;
        const e = stats.trigram[key];
        if (e && e.mean_ms > 0) return e.mean_ms;
    }

    // 3. bigram: prev|curr
    if (stats.bigram) {
        const key = `${prevPhone}|${currPhone}`;
        const e = stats.bigram[key];
        if (e && e.mean_ms > 0) return e.mean_ms;
    }

    // 4. unigram: curr
    if (stats.unigram) {
        const e = stats.unigram[currPhone];
        if (e && e.mean_ms > 0) return e.mean_ms;
    }

    // 兜底
    return 1.0;
}

/**
 * 批量计算一组音素的时长权重，归一化为比例数组（和为 1）。
 *
 * @param {Object} stats 已加载的统计表
 * @param {string[]} phoneNames 音素名数组（如 ['en_T', 'en_AE1', 'en_T', '<SEP>']）
 * @param {string} position 词内位置 'initial'|'medial'|'final'（整个 note 视为一个词内片段）
 * @returns {number[]} 归一化比例数组，长度 == phoneNames.length
 */
function computeNormalizedRatios(stats, phoneNames, position) {
    if (!stats || !phoneNames || phoneNames.length === 0) return [];

    // <SEP> / <BOW> / <EOW> 等特殊 token 给最小权重
    const SPECIAL_TOKENS = new Set(['<SEP>', '<BOW>', '<EOW>', '<PAD>']);

    const n = phoneNames.length;
    const weights = new Array(n);
    let hasReal = false;

    for (let i = 0; i < n; i++) {
        const name = phoneNames[i];
        if (SPECIAL_TOKENS.has(name)) {
            weights[i] = 0.1; // 特殊 token 占最小帧数
            continue;
        }
        const curr = barePhone(name);
        // 上下文：note 内相邻音素；首尾用 <S>/<E> 表示
        const prev = i > 0 ? barePhone(phoneNames[i - 1]) : '<S>';
        const next = i < n - 1 ? barePhone(phoneNames[i + 1]) : '<E>';
        weights[i] = lookupWeight(stats, curr, prev, next, position);
        hasReal = true;
    }

    if (!hasReal) {
        // 全是特殊 token，均分
        return new Array(n).fill(1 / n);
    }

    // 归一化
    const sum = weights.reduce((s, v) => s + v, 0);
    if (sum <= 0) return new Array(n).fill(1 / n);
    return weights.map(w => w / sum);
}

module.exports = {
    loadDurationStats,
    loadDurationStatsSync,
    getDurationStatsSync,
    preload,
    unloadDurationStats,
    extractStress,
    barePhone,
    lookupWeight,
    computeNormalizedRatios,
};
