const path = require('node:path');
const fs = require('node:fs');
const { pinyin } = require('pinyin-pro');

// Japanese hiragana/katakana → phoneme mapping
const JP_HIRAGANA_MAP = {
    'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o',
    'か': 'k a', 'き': 'k i', 'く': 'k u', 'け': 'k e', 'こ': 'k o',
    'さ': 's a', 'し': 'sh i', 'す': 's u', 'せ': 's e', 'そ': 's o',
    'た': 't a', 'ち': 'ch i', 'つ': 'ts u', 'て': 't e', 'と': 't o',
    'な': 'n a', 'に': 'ny i', 'ぬ': 'n u', 'ね': 'n e', 'の': 'n o',
    'は': 'h a', 'ひ': 'hy i', 'ふ': 'f u', 'へ': 'h e', 'ほ': 'h o',
    'ま': 'm a', 'み': 'my i', 'む': 'm u', 'め': 'm e', 'も': 'm o',
    'や': 'y a', 'ゆ': 'y u', 'よ': 'y o',
    'ら': 'r a', 'り': 'ry i', 'る': 'r u', 'れ': 'r e', 'ろ': 'r o',
    'わ': 'w a', 'を': 'o', 'ん': 'n',
    'が': 'g a', 'ぎ': 'gy i', 'ぐ': 'g u', 'げ': 'g e', 'ご': 'g o',
    'ざ': 'z a', 'じ': 'j i', 'ず': 'z u', 'ぜ': 'z e', 'ぞ': 'z o',
    'だ': 'd a', 'ぢ': 'j i', 'づ': 'z u', 'で': 'd e', 'ど': 'd o',
    'ば': 'b a', 'び': 'by i', 'ぶ': 'b u', 'べ': 'b e', 'ぼ': 'b o',
    'ぱ': 'p a', 'ぴ': 'py i', 'ぷ': 'p u', 'ぺ': 'p e', 'ぽ': 'p o',
    'きゃ': 'ky a', 'きゅ': 'ky u', 'きょ': 'ky o',
    'しゃ': 'sh a', 'しゅ': 'sh u', 'しょ': 'sh o',
    'ちゃ': 'ch a', 'ちゅ': 'ch u', 'ちょ': 'ch o',
    'にゃ': 'ny a', 'にゅ': 'ny u', 'にょ': 'ny o',
    'ひゃ': 'hy a', 'ひゅ': 'hy u', 'ひょ': 'hy o',
    'みゃ': 'my a', 'みゅ': 'my u', 'みょ': 'my o',
    'りゃ': 'ry a', 'りゅ': 'ry u', 'りょ': 'ry o',
    'ぎゃ': 'gy a', 'ぎゅ': 'gy u', 'ぎょ': 'gy o',
    'じゃ': 'j a', 'じゅ': 'j u', 'じょ': 'j o',
    'びゃ': 'by a', 'びゅ': 'by u', 'びょ': 'by o',
    'ぴゃ': 'py a', 'ぴゅ': 'py u', 'ぴょ': 'py o',
    'てゃ': 't a', 'てゅ': 't u', 'てょ': 't o',
    'でゃ': 'd a', 'でゅ': 'd u', 'でょ': 'd o',
    'っ': 'cl',
};

const JP_KATAKANA_MAP = {};
for (const [hira, ph] of Object.entries(JP_HIRAGANA_MAP)) {
    const kata = String.fromCharCode(hira.charCodeAt(0) + 0x60);
    JP_KATAKANA_MAP[kata] = ph;
}

const JP_KANJI_DICT = {
    '愛': 'a i', '雨': 'a m e', '空': 's o r a', '花': 'h a n a',
    '風': 'k a z e', '月': 'ts u k i', '星': 'h o sh i', '雪': 'y u k i',
    '海': 'u m i', '山': 'y a m a', '川': 'k a w a', '森': 'm o r i',
    '光': 'h i k a r i', '音': 'o t o', '声': 'k o e', '梦': 'y u m e',
    '心': 'k o k o r o', '恋': 'k o i', '涙': 'n a m i d a',
    '歌': 'u t a', '飛': 't o b u', '歩': 'a r u k u',
    '走': 'h a sh i r u', '泳': 'o y o g u', '読': 'y o m u',
    '食': 't a b e r u', '飲': 'n o m u', '見': 'm i r u', '聞': 'k i k u',
    '帰': 'k a e r u', '行': 'i k u', '来': 'k u r u', '立': 't a ts u',
    '入': 'h a i r u', '出': 'd e r u', '上': 'u e', '下': 's h i t a',
    '大': 'o o', '小': 'ch i i s a', '長': 'n a g a i', '強': 'ts u y o i',
    '春': 'h a r u', '夏': 'n a ts u', '秋': 'a k i', '冬': 'f u y u',
    '朝': 'a s a', '昼': 'h i r u', '夜': 'y o r u',
    '今': 'i m a', '私': 'w a t a sh i', '君': 'k i m i',
    '一': 'i ch i', '二': 'n i', '三': 's a n', '四': 'y o n',
    '五': 'g o', '六': 'r o k u', '七': 'n a n a', '八': 'h a ch i',
    '九': 'ky u', '十': 'j u',
};

class TextProcessing {
    constructor() {
        this.phone2idx = {};
        this.enG2pDict = {};
        this._loadPhoneSet();
        this._loadEnG2pDict();
    }

    _loadPhoneSet() {
        const searchPaths = [
            path.join(__dirname, 'phone_set.json'),
            path.join(__dirname, '..', 'phone_set.json'),
            path.join(__dirname, '..', '..', 'inference', 'phone_set.json'),
            path.join(__dirname, '..', '..', '..', 'src', 'inference', 'phone_set.json'),
        ];
        for (const phoneSetPath of searchPaths) {
            try {
                if (fs.existsSync(phoneSetPath)) {
                    const phoneList = JSON.parse(fs.readFileSync(phoneSetPath, 'utf-8'));
                    for (let i = 0; i < phoneList.length; i++) {
                        this.phone2idx[phoneList[i]] = i;
                    }
                    console.log(`[OnnxSVSPipeline] Phoneme vocabulary loaded: ${phoneList.length} phonemes (path: ${phoneSetPath})`);
                    return;
                }
            } catch (e) {
                console.warn(`[OnnxSVSPipeline] Failed to load phoneme vocabulary (${phoneSetPath}):`, e.message);
            }
        }
        console.error('[OnnxSVSPipeline] Failed to load phoneme vocabulary: phone_set.json not found in any search path');
    }

    _loadEnG2pDict() {
        const searchPaths = [
            path.join(__dirname, 'en_g2p_dict.json'),
            path.join(__dirname, '..', 'en_g2p_dict.json'),
            path.join(__dirname, '..', '..', 'inference', 'en_g2p_dict.json'),
            path.join(__dirname, '..', '..', '..', 'src', 'inference', 'en_g2p_dict.json'),
        ];
        for (const dictPath of searchPaths) {
            try {
                if (fs.existsSync(dictPath)) {
                    this.enG2pDict = JSON.parse(fs.readFileSync(dictPath, 'utf-8'));
                    console.log(`[OnnxSVSPipeline] English G2P dictionary loaded (CMUdict): ${Object.keys(this.enG2pDict).length} words (path: ${dictPath})`);
                    return;
                }
            } catch (e) {
                console.warn(`[OnnxSVSPipeline] Failed to load English G2P dictionary (${dictPath}):`, e.message);
            }
        }
        console.error('[OnnxSVSPipeline] Failed to load English G2P dictionary: en_g2p_dict.json not found in any search path');
    }

    _englishG2p(word) {
        const lower = word.toLowerCase();
        if (this.enG2pDict[lower]) {
            return this.enG2pDict[lower];
        }
        const dictSize = Object.keys(this.enG2pDict).length;
        if (dictSize === 0) {
            console.warn(`[OnnxSVSPipeline] English G2P dictionary is empty! Word "${word}" cannot be resolved.`);
        } else {
            console.warn(`[OnnxSVSPipeline] English word "${word}" not in CMUdict (${dictSize} entries), using letter-level fallback`);
        }
        const letterMap = {
            a: 'EY1', b: 'B IY1', c: 'S IY1', d: 'D IY1', e: 'IY1',
            f: 'EH1 F', g: 'JH IY1', h: 'EY1 CH', i: 'AY1', j: 'JH EY1',
            k: 'K EY1', l: 'EH1 L', m: 'EH1 M', n: 'EH1 N', o: 'OW1',
            p: 'P IY1', q: 'K Y UW1', r: 'AA1 R', s: 'EH1 S', t: 'T IY1',
            u: 'Y UW1', v: 'V IY1', w: 'D AH1 B AH0 L Y UW0', x: 'EH1 K S',
            y: 'W AY1', z: 'Z IY1',
        };
        const phonemes = [];
        for (const ch of lower) {
            if (letterMap[ch]) {
                phonemes.push(...letterMap[ch].split(' '));
            }
        }
        return phonemes.length > 0 ? phonemes.join(' ') : null;
    }

    _lookupPhonemeId(lyric) {
        if (!lyric || lyric.trim().length === 0) {
            return this.phone2idx['<SP>'] || 1;
        }
        const trimmed = lyric.trim();

        // Ensure vocabulary is loaded (lazy reload if empty)
        if (Object.keys(this.phone2idx).length === 0) {
            console.warn('[OnnxSVSPipeline] Phoneme vocabulary is empty, attempting reload...');
            this._loadPhoneSet();
        }

        if (this.phone2idx[trimmed] !== undefined) {
            return this.phone2idx[trimmed];
        }
        if (this.phone2idx['zh_' + trimmed] !== undefined) {
            return this.phone2idx['zh_' + trimmed];
        }
        if (this.phone2idx['en_' + trimmed] !== undefined) {
            return this.phone2idx['en_' + trimmed];
        }
        if (this.phone2idx['yue_' + trimmed] !== undefined) {
            return this.phone2idx['yue_' + trimmed];
        }
        if (this.phone2idx['jp_' + trimmed] !== undefined) {
            return this.phone2idx['jp_' + trimmed];
        }
        const zhPhoneme = this._charToZhPhoneme(trimmed);
        if (zhPhoneme && this.phone2idx[zhPhoneme] !== undefined) {
            return this.phone2idx[zhPhoneme];
        }
        const vocabSize = Object.keys(this.phone2idx).length;
        console.warn(`[OnnxSVSPipeline] Unknown phoneme: "${trimmed}"${zhPhoneme ? ` (converted: ${zhPhoneme})` : ''} [vocab=${vocabSize}], Using <UNK>`);
        return this.phone2idx['<UNK>'] || 3;
    }

    _charToZhPhoneme(input) {
        const match = input.match(/^([\u4e00-\u9fff])([1-5])$/);
        const char = match ? match[1] : input;
        const overrideTone = match ? match[2] : null;

        if (!/[\u4e00-\u9fff]/.test(char)) {
            return null;
        }
        try {
            const py = pinyin(char, { toneType: 'num', type: 'array' });
            if (py && py.length > 0 && py[0]) {
                let syllable = py[0];
                if (overrideTone) {
                    syllable = syllable.replace(/\d$/, overrideTone);
                }
                return 'zh_' + syllable;
            }
        } catch (e) {
            console.warn(`[OnnxSVSPipeline] Pinyin conversion failed ("${input}"):`, e.message);
        }
        return null;
    }

    resolveLyricToPhonemes(lyric) {
        if (!lyric || lyric.trim().length === 0) return [{ name: '<SP>', display: 'SP' }];
        let trimmed = lyric.trim();
        if (trimmed === '<SP>' || trimmed === '<AP>') return [{ name: '<SP>', display: 'SP' }];

        // Handle <jp> prefix: force Japanese G2P for kanji etc.
        let forceJp = false;
        if (trimmed.startsWith('<jp>')) {
            forceJp = true;
            trimmed = trimmed.slice(4).trim();
        }

        if (trimmed.startsWith('jp_')) {
            return [{ name: trimmed, display: trimmed.slice(3) }];
        }

        if (forceJp || this._isJapanese(trimmed)) {
            const phonemes = this._japaneseG2p(trimmed);
            if (phonemes) {
                return phonemes.split(' ').filter(s => s).map(ph => {
                    const name = 'jp_' + ph;
                    return { name, display: ph };
                });
            }
        }

        if (trimmed.startsWith('en_') && trimmed.includes('-')) {
            return trimmed.slice(3).split('-').map(s => {
                const name = 'en_' + s.trim();
                return { name, display: s.trim() };
            });
        }

        if (/^[a-zA-Z]+$/.test(trimmed) && !trimmed.startsWith('en_') && !trimmed.startsWith('zh_') && !trimmed.startsWith('yue_') && !trimmed.startsWith('jp_')) {
            const g2pResult = this._englishG2p(trimmed);
            if (g2pResult) {
                return g2pResult.split(' ').map(ph => {
                    const name = 'en_' + ph.trim();
                    return { name, display: ph.trim() };
                });
            }
            return [{ name: trimmed, display: trimmed }];
        }

        const zhPhoneme = this._charToZhPhoneme(trimmed);
        if (zhPhoneme) {
            const display = trimmed.charAt(0) + (trimmed.length > 1 && /[1-5]/.test(trimmed.charAt(1)) ? trimmed.charAt(1) : '');
            return [{ name: zhPhoneme, display }];
        }

        return [{ name: trimmed, display: trimmed }];
    }

    _isJapanese(text) {
        // Only detect hiragana/katakana as Japanese, NOT CJK kanji (shared with Chinese)
        return /[ぁ-ゟァ-ヿ]/.test(text);
    }

    _japaneseG2p(text) {
        const result = [];
        let i = 0;
        while (i < text.length) {
            const ch = text[i];
            if (ch === 'ー' || ch === '〜') { i++; continue; }

            if (i + 1 < text.length) {
                const combo = ch + text[i + 1];
                if (JP_HIRAGANA_MAP[combo] || JP_KATAKANA_MAP[combo]) {
                    const ph = JP_HIRAGANA_MAP[combo] || JP_KATAKANA_MAP[combo];
                    result.push(...ph.split(' '));
                    i += 2;
                    continue;
                }
            }

            const ph = JP_HIRAGANA_MAP[ch] || JP_KATAKANA_MAP[ch];
            if (ph) { result.push(...ph.split(' ')); i++; continue; }

            if (/[一-鿿]/.test(ch)) {
                let found = false;
                for (let len = Math.min(4, text.length - i); len >= 2; len--) {
                    const compound = text.substring(i, i + len);
                    if (JP_KANJI_DICT[compound]) {
                        result.push(...JP_KANJI_DICT[compound].split(' '));
                        i += len;
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    const kanjiPh = JP_KANJI_DICT[ch];
                    if (kanjiPh) { result.push(...kanjiPh.split(' ')); }
                    else { result.push('pau'); }
                    i++;
                }
                continue;
            }

            if (/[a-zA-Z]/.test(ch)) { result.push(ch.toLowerCase()); i++; continue; }
            i++;
        }
        return result.join(' ');
    }
}

module.exports = { TextProcessing };
