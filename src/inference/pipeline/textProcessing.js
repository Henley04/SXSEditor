const path = require('node:path');
const fs = require('node:fs');
const { pinyin } = require('pinyin-pro');

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
        const trimmed = lyric.trim();
        if (trimmed === '<SP>' || trimmed === '<AP>') return [{ name: '<SP>', display: 'SP' }];

        if (trimmed.startsWith('en_') && trimmed.includes('-')) {
            return trimmed.slice(3).split('-').map(s => {
                const name = 'en_' + s.trim();
                return { name, display: s.trim() };
            });
        }

        if (/^[a-zA-Z]+$/.test(trimmed) && !trimmed.startsWith('en_') && !trimmed.startsWith('zh_') && !trimmed.startsWith('yue_')) {
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
}

module.exports = { TextProcessing };
