/**
 * 中文歌词整句上下文消歧（对齐官方预处理 g2pM(sent, tone=True, char_split=False)）。
 *
 * 官方在预处理阶段把一句里的中文单字拼成 sent 一次性转写，多音字（银行 / 音乐 /
 * 长大 / 重复 / 着凉…）由词组上下文定音。App 在运行时逐 note 调
 * pinyin(char, { multiple: true }) 只能按常用度取首读音，于是「银行」会被读成
 * yin2 xing2、「音乐」读成 yin1 le4，与训练时的音素分布不符。
 *
 * 这里把连续的单字中文歌词拼成句子交给 pinyin-pro 整句转写，再按字映射回各
 * note；非单字中文歌词（英文 / 日文 / 音素标注 / 休止 / 连音 / 多字词 / 标点）
 * 作为句子边界，避免跨语种误连。单字段也照常转写一次，结果与逐字一致。
 *
 * 纯函数：pinyinFn 可注入，便于单测；转写失败时对应 note 回退逐字逻辑，不阻断合成。
 */
const { pinyin } = require('pinyin-pro');
const { repairMojibake } = require('../../utils/textEncoding');

// 仅匹配单个 CJK 表意文字：多字词、带声调标注（银2）、音素前缀（zh_/en_）等
// 都不参与整句消歧，保留原有逐字 / 显式标注处理路径。
const CJK_SINGLE = /^[\u4e00-\u9fff]$/;

/**
 * @param {Array<string|null|undefined>} lyrics - 按 note 顺序的原始歌词
 * @param {Function} [pinyinFn] - pinyin-pro 的 pinyin，注入仅用于单测
 * @returns {Map<number, string>} noteIndex → 整句消歧后的带声调拼音（如 'hang2'）
 */
function resolveChineseContextReadings(lyrics, pinyinFn = pinyin) {
    const out = new Map();
    if (!Array.isArray(lyrics)) return out;
    let run = [];
    const flush = () => {
        if (run.length === 0) return;
        const sentence = run.map((r) => r.char).join('');
        try {
            const arr = pinyinFn(sentence, { toneType: 'num', type: 'array' });
            // 段内全是单字汉字，整句转写应等长返回；长度不符则整段放弃，
            // 避免错位把读音贴到错误的 note 上。
            if (Array.isArray(arr) && arr.length === run.length) {
                for (let i = 0; i < run.length; i++) {
                    if (typeof arr[i] === 'string' && arr[i]) out.set(run[i].index, arr[i]);
                }
            }
        } catch (_) { /* 整句转写失败：该段 note 回退逐字逻辑，不阻断合成 */ }
        run = [];
    };
    for (let i = 0; i < lyrics.length; i++) {
        let raw = lyrics[i] == null ? '' : String(lyrics[i]);
        try { raw = repairMojibake(raw); } catch (_) { /* 保持原值 */ }
        if (CJK_SINGLE.test(raw)) {
            run.push({ index: i, char: raw });
        } else {
            flush();
        }
    }
    flush();
    return out;
}

module.exports = { resolveChineseContextReadings, CJK_SINGLE };
