const path = require('node:path');
const fs = require('node:fs');
const { pinyin } = require('pinyin-pro');
const durationStats = require('./durationStats');
const { repairMojibake } = require('../../utils/textEncoding');

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

// Hand-curated kanji → phoneme dictionary (fallback when JSON is unavailable).
// These ~50 entries are also included in jpKanjiDict.json as overrides, but
// kept here as a safety net so the module still works if the JSON file fails
// to load (e.g., missing in a packaged build).
const JP_KANJI_DICT_FALLBACK = {
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

/**
 * Load the full kanji → phoneme dictionary from jpKanjiDict.json.
 *
 * The JSON is generated from KANJIDIC2 (see scripts/generate_jp_kanji_dict.py)
 * and contains ~2600 entries covering all Jōyō kanji (2136) plus other common
 * kanji with frequency rankings. The hand-curated entries in
 * JP_KANJI_DICT_FALLBACK are already merged into the JSON as overrides, so
 * the JSON is the single source of truth when available.
 *
 * Falls back to JP_KANJI_DICT_FALLBACK (~50 entries) if the JSON cannot be
 * loaded, ensuring the module always has a working dictionary.
 */
function _loadJpKanjiDict() {
    const searchPaths = [
        path.join(__dirname, 'jpKanjiDict.json'),
        path.join(__dirname, '..', 'jpKanjiDict.json'),
        path.join(__dirname, '..', 'inference', 'jpKanjiDict.json'),
        path.join(__dirname, '..', 'inference', 'pipeline', 'jpKanjiDict.json'),
        path.join(__dirname, '..', '..', 'src', 'inference', 'pipeline', 'jpKanjiDict.json'),
    ];
    // Packaged Electron app (asar / unpacked)
    try {
        if (process.resourcesPath) {
            searchPaths.push(path.join(process.resourcesPath, 'app.asar', '.webpack', 'main', 'jpKanjiDict.json'));
            searchPaths.push(path.join(process.resourcesPath, 'app', '.webpack', 'main', 'jpKanjiDict.json'));
        }
    } catch (_) {}
    // Non-webpack / CLI mode
    try {
        if (require.main && require.main.path) {
            searchPaths.push(path.join(require.main.path, 'inference', 'pipeline', 'jpKanjiDict.json'));
            searchPaths.push(path.join(require.main.path, 'src', 'inference', 'pipeline', 'jpKanjiDict.json'));
        }
    } catch (_) {}

    for (const dictPath of searchPaths) {
        try {
            if (fs.existsSync(dictPath)) {
                const loaded = JSON.parse(fs.readFileSync(dictPath, 'utf-8'));
                const count = Object.keys(loaded).length;
                console.log(`[TextProcessing] Loaded JP kanji dictionary: ${count} entries (path: ${dictPath})`);
                return loaded;
            }
        } catch (e) {
            console.warn(`[TextProcessing] Failed to load JP kanji dictionary (${dictPath}):`, e.message);
        }
    }
    console.warn('[TextProcessing] jpKanjiDict.json not found — falling back to hardcoded JP_KANJI_DICT_FALLBACK (~50 entries). Run `python scripts/generate_jp_kanji_dict.py` to regenerate.');
    return JP_KANJI_DICT_FALLBACK;
}

const JP_KANJI_DICT = _loadJpKanjiDict();

/**
 * Japanese phoneme → English ARPAbet phoneme mapping table.
 *
 * Design rationale:
 * - Vowels use stress=1 (primary stress) to ensure proper duration allocation
 *   via durationStats. Japanese is mora-timed, so every syllable should get
 *   similar vowel weight — stress=1 achieves this.
 * - jp_a → AA1 (open back unrounded, closest to Japanese /a/ [ä])
 * - jp_i → IY1 (close front unrounded, matches Japanese /i/ [i])
 * - jp_u → UW1 (close back, closest available — Japanese /u/ is [ɯ] unrounded,
 *   but ARPAbet has no pure [ɯ]; UW is the nearest high back vowel)
 * - jp_e → EH1 (open-mid front unrounded, close to Japanese /e/ [e̞])
 * - jp_o → OW1 (close-mid back rounded, closest to Japanese /o/ [o̞];
 *   OW is technically a diphthong [oʊ] but starts at [o])
 *
 * Consonants map 1:1 to nearest ARPAbet:
 * - jp_r → R (Japanese [ɾ] tap vs English [ɹ] approximant — closest available)
 * - jp_f → F (Japanese [ɸ] bilabial vs English [f] labiodental — closest)
 *
 * Affricates map to multi-phoneme sequences:
 * - jp_ts → T S (no single ARPAbet for [ts])
 * - Palatal consonants (ky, gy, etc.) → consonant + Y (palatal glide)
 *
 * っ (cl): maps to T as an approximation of the gemination/stop effect.
 *   In Japanese, っ lengthens the following consonant; since we can't easily
 *   merge across notes, T provides a brief stop consonant. The durationStats
 *   will give it a short duration.
 */
const JP_TO_EN_PHONEME_MAP = {
    // Vowels (stress 1 = primary stress, ensures proper duration)
    'a': ['AA1'],
    'i': ['IY1'],
    'u': ['UW1'],
    'e': ['EH1'],
    'o': ['OW1'],

    // Consonants — 1:1 mapping to nearest ARPAbet
    'k': ['K'],
    's': ['S'],
    'sh': ['SH'],
    'ch': ['CH'],
    't': ['T'],
    'n': ['N'],
    'h': ['HH'],
    'm': ['M'],
    'r': ['R'],
    'w': ['W'],
    'y': ['Y'],
    'g': ['G'],
    'z': ['Z'],
    'd': ['D'],
    'b': ['B'],
    'p': ['P'],
    'f': ['F'],
    'j': ['JH'],

    // Affricate — split into components
    'ts': ['T', 'S'],

    // Gemination marker (っ) — approximate with alveolar stop
    'cl': ['T'],

    // Palatal consonants (yōon) — consonant + palatal glide
    'ky': ['K', 'Y'],
    'gy': ['G', 'Y'],
    'ny': ['N', 'Y'],
    'hy': ['HH', 'Y'],
    'my': ['M', 'Y'],
    'ry': ['R', 'Y'],
    'py': ['P', 'Y'],
    'by': ['B', 'Y'],
};

/**
 * Hybrid mode JP→EN phoneme mapping table.
 *
 * Hybrid mode is an improved variant of en-phonemes that produces more
 * accurate Japanese pronunciation on the base multilingual model. Key
 * differences from JP_TO_EN_PHONEME_MAP:
 *
 * 1. ら行 (r) → L (alveolar lateral [l]) instead of R (approximant [ɹ]).
 *    Japanese /ɾ/ is an alveolar tap; ARPAbet R [ɹ] is a labiodental-ish
 *    approximant and sounds too "American". L [l] is acoustically closer
 *    to the tap and avoids the English r-coloring. This mirrors the
 *    design intent of the Cantonese y_l extension in the hybrid plan.
 *
 * 2. お段 (o) → AO1 (close-mid back rounded, pure vowel) instead of
 *    OW1 (diphthong [oʊ]). Japanese /o/ is a pure monophthong [o̞];
 *    OW introduces an off-glide that sounds Anglicized.
 *
 * 3. り拗音 (ry) → L Y (matching the r→L change for palatalized forms).
 *
 * All other phonemes match JP_TO_EN_PHONEME_MAP. The base model vocabulary
 * already contains en_L, en_AO1, etc., so no vocabulary extension or
 * model retraining is required.
 */
const JP_TO_EN_PHONEME_MAP_HYBRID = {
    // Vowels — AO1 for o (pure vowel, not OW diphthong)
    'a': ['AA1'],
    'i': ['IY1'],
    'u': ['UW1'],
    'e': ['EH1'],
    'o': ['AO1'],

    // Consonants — L for r (closer to Japanese tap [ɾ] than R [ɹ])
    'k': ['K'],
    's': ['S'],
    'sh': ['SH'],
    'ch': ['CH'],
    't': ['T'],
    'n': ['N'],
    'h': ['HH'],
    'm': ['M'],
    'r': ['L'],
    'w': ['W'],
    'y': ['Y'],
    'g': ['G'],
    'z': ['Z'],
    'd': ['D'],
    'b': ['B'],
    'p': ['P'],
    'f': ['F'],
    'j': ['JH'],

    // Affricate — split into components
    'ts': ['T', 'S'],

    // Gemination marker (っ) — approximate with alveolar stop
    'cl': ['T'],

    // Palatal consonants (yōon) — consonant + palatal glide
    'ky': ['K', 'Y'],
    'gy': ['G', 'Y'],
    'ny': ['N', 'Y'],
    'hy': ['HH', 'Y'],
    'my': ['M', 'Y'],
    'ry': ['L', 'Y'],
    'py': ['P', 'Y'],
    'by': ['B', 'Y'],
};

/**
 * Japanese kana → Cantonese (yue_) syllable-level phoneme mapping for hybrid mode.
 *
 * The base multilingual model vocabulary contains yue_ phonemes at the syllable
 * level (e.g. yue_gaa1 = 粤拼 gaa1 = /kaː/). For each Japanese kana, we pick
 * whichever representation — English ARPAbet (phoneme-level) or Cantonese
 * yue_ (syllable-level) — is phonetically closest to the Japanese sound:
 *
 * - Vowels あ/お → yue_aa1 / yue_o1 (pure monophthongs, closer than English
 *   AA /ɑ/ and AO /ɔ/ which have English-specific coloring).
 * - い/う/え → en_IY1/UW1/EH1: Cantonese has no pure /i//u//e/ syllables
 *   (ji1 = /ji/, wu1 = /wu/, no pure e), so ARPAbet stays closer.
 * - か行 (k) → yue_g* (Cantonese g = /k/ unaspirated, matches Japanese k
 *   better than English K = /kʰ/ aspirated).
 * - さ行 (s) → yue_s* for pure /sV/ syllables; し → en_SH+IY1 (Japanese
 *   /ɕi/ is palatalized, English SH /ʃ/ closer than Cantonese /s/);
 *   す → en_S+UW1 (Cantonese lacks /su/).
 * - た行 (t) → yue_d* (Cantonese d = /t/ unaspirated, matches Japanese t);
 *   ち → en_CH+IY1 (Japanese /tɕi/, English CH closer); つ → en_T+S+UW1.
 * - は行 (h) → yue_h* / yue_fu1 (Cantonese h/f match Japanese h/ɸ well).
 * - ま行 (m) → yue_m* for /mV/; み/む → en_M+IY1/UW1 (Cantonese lacks
 *   pure /mi//mu/).
 * - や/よ → yue_jaa1 / yue_jo1 (Cantonese j = /j/); ゆ → en_Y+UW1
 *   (Cantonese jyu1 = /jy/ rounded, not close to Japanese /jɯ/).
 * - ら行 (r→l) → yue_l* (Cantonese l = /l/ closest to Japanese tap /ɾ/);
 *   る → en_L+UW1 (Cantonese lacks pure /lu/).
 * - わ → yue_waa1; を → yue_o1 (same as お).
 * - ぱ行 (p) → yue_paa3 / yue_po3 (Cantonese p = /pʰ/ aspirated, matches
 *   Japanese p); ぴ/ぷ/ぺ → en_P+IY1/UW1/EH1 (Cantonese lacks pure /pi//pu//pe/).
 * - ん → en_N (universal nasal, more flexible than yue_ng4).
 * - が/ざ/だ/ば行 → ARPAbet (Japanese voiced stops /g z d b/ have no
 *   Cantonese equivalent — Cantonese b/d/g are voiceless unaspirated /p t k/).
 * - 拗音 (yōon) → ARPAbet (Japanese palatalized consonants /CjV/ have no
 *   Cantonese equivalent at the syllable level).
 * - 促音 っ → en_T (matches existing hybrid behavior).
 *
 * Cantonese tones are arbitrary (1 high-level / 3 mid-level / 4 low-falling
 * chosen as available) — the SVS model receives F0 from the musical note,
 * so the tone field acts mainly as a vocabulary distinguisher.
 */
const JpKanaToYueSyllableMap = {
    // あ段 — pure vowels where Cantonese has them
    'あ': 'yue_aa1', 'お': 'yue_o1', 'を': 'yue_o1',

    // か行 — Cantonese g unaspirated /k/ matches Japanese k
    'か': 'yue_gaa1', 'く': 'yue_gu1', 'こ': 'yue_go1',

    // さ行 — Cantonese s /s/ matches Japanese s
    'さ': 'yue_saa1', 'せ': 'yue_se1', 'そ': 'yue_so1',

    // た行 — Cantonese d unaspirated /t/ matches Japanese t
    'た': 'yue_daa1', 'て': 'yue_de1', 'と': 'yue_do1',

    // な行 — Cantonese n /n/ matches Japanese n (only low-tone variants exist)
    'な': 'yue_naa4', 'ね': 'yue_ne1', 'の': 'yue_no4',

    // は行 — Cantonese h /h/ and f /f/ match Japanese h /h/ and ɸ
    'は': 'yue_haa1', 'ひ': 'yue_hi1', 'ふ': 'yue_fu1', 'へ': 'yue_he3', 'ほ': 'yue_ho1',

    // ま行 — Cantonese m /m/ matches Japanese m
    'ま': 'yue_maa1', 'め': 'yue_me1', 'も': 'yue_mo1',

    // や行 — Cantonese j /j/ matches Japanese y
    'や': 'yue_jaa1', 'よ': 'yue_jo1',

    // ら行 — Cantonese l /l/ closest to Japanese tap /ɾ/
    'ら': 'yue_laa1', 'り': 'yue_li1', 'れ': 'yue_le4', 'ろ': 'yue_lo1',

    // わ行 — Cantonese w /w/ matches Japanese w
    'わ': 'yue_waa1',

    // ぱ行 — Cantonese p aspirated /pʰ/ matches Japanese p
    'ぱ': 'yue_paa3', 'ぽ': 'yue_po3',
};

// Katakana equivalents (ア↔あ offset 0x60), generated at module load.
const JpKataKanaToYueSyllableMap = {};
for (const [hira, yue] of Object.entries(JpKanaToYueSyllableMap)) {
    const kata = String.fromCharCode(hira.charCodeAt(0) + 0x60);
    JpKataKanaToYueSyllableMap[kata] = yue;
}

/**
 * Japanese mora-timing duration weights for JP→EN mapped phonemes.
 *
 * Japanese is a mora-timed language: each mora (syllable-like unit) receives
 * approximately equal duration. This contrasts with English stress-timing
 * (captured by en_phoneme_durations.json) where stressed vowels are much
 * longer than unstressed ones. Using English stats for Japanese phonemes
 * produces unnatural duration ratios (e.g., AA1 vs AA0 differ enormously in
 * English but Japanese /a/ has no stress contrast).
 *
 * This table assigns each Japanese phoneme a relative weight reflecting its
 * contribution to a mora:
 *   - Vowels (a/i/u/e/o): 1.0 — full mora, the sonority peak
 *   - Single consonants (k/s/t/n/h/m/r/w...): 0.35 — short onset, ~35% of
 *     the following vowel's duration. Matches phonetic measurements of
 *     Japanese consonant-to-vowel duration ratios.
 *   - Palatal consonants (ky/gy/ny/...): 0.45 — consonant + palatal glide,
 *     slightly longer than single consonants due to the /j/ off-glide.
 *   - Affricates (sh/ch/ts): 0.45-0.55 — longer than stops due to the
 *     fricative component.
 *   - Nasal murmur (n before vowel): 0.40 — slightly longer than oral stops.
 *   - 促音 cl (gemination marker): 0.20 — very brief stop; in real Japanese
 *     it lengthens the FOLLOWING consonant, but as a standalone phoneme it
 *     should be short to avoid sounding like a full /t/.
 *   - pau (unknown kanji fallback): 0.5 — neutral.
 *
 * When a Japanese phoneme maps to multiple English phonemes (e.g., ts→T+S,
 * ky→K+Y), the weight is split equally among the components. The resulting
 * component weights are then used by getPhonemeAdjustments() to compute
 * durationRatio, and by _allocateByStats (when extended) for inference.
 *
 * Tuning rationale: weights are derived from Japanese phonetics literature
 * (Han 1962, Sato 1993) showing typical consonant/vowel duration ratios of
 * ~0.35-0.45 for stops and ~0.50 for nasals/liquids in Tokyo Japanese.
 */
const JP_MORA_WEIGHTS = {
    // Vowels — full mora weight (sonority peak)
    'a': 1.0, 'i': 1.0, 'u': 1.0, 'e': 1.0, 'o': 1.0,

    // Single consonants — short onset (~35% of vowel duration)
    'k': 0.35, 'g': 0.35, 's': 0.35, 'z': 0.35,
    't': 0.35, 'd': 0.35, 'h': 0.35, 'b': 0.35,
    'p': 0.35, 'f': 0.35, 'w': 0.35, 'y': 0.35,

    // Voiced/nasal/liquid — slightly longer (~40%)
    'n': 0.40, 'm': 0.40, 'r': 0.40,

    // Voiced affricate /ɟ/ — ~40%
    'j': 0.40,

    // Palatal consonants (yōon) — consonant + /j/ glide, ~45%
    'ky': 0.45, 'gy': 0.45, 'ny': 0.50, 'hy': 0.45,
    'my': 0.50, 'ry': 0.50, 'py': 0.45, 'by': 0.45,

    // Affricates — stop + fricative, longer than pure stops
    'sh': 0.45,  // /ɕ/ — fricative, ~45%
    'ch': 0.50,  // /tɕ/ — affricate, ~50%
    'ts': 0.55,  // /ts/ — affricate, ~55%

    // 促音 (gemination marker) — very brief stop
    'cl': 0.20,

    // Unknown kanji fallback — neutral
    'pau': 0.50,
};

/**
 * Default weight for any Japanese phoneme not explicitly in JP_MORA_WEIGHTS.
 */
const JP_MORA_DEFAULT_WEIGHT = 0.50;

class TextProcessing {
    constructor(options = {}) {
        this.phone2idx = {};
        this.enG2pDict = {};
        this._vocabSize = 0;
        this._dictSize = 0;
        // Japanese vocalization mode:
        // - 'hybrid' (default): improved ARPAbet mapping (L for ら行, AO for お段) on the base model
        // - 'en-phonemes': uses English ARPAbet phonemes (original mapping) on the base multilingual model
        // - 'jp-lora': uses JP LoRA models with jp_ phonemes
        this.japaneseVocalization = options.japaneseVocalization || 'hybrid';
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
        // Fallback paths for packaged Electron app (asar / unpacked)
        try {
            if (process.resourcesPath) {
                searchPaths.push(path.join(process.resourcesPath, 'app.asar', '.webpack', 'main', 'phone_set.json'));
                searchPaths.push(path.join(process.resourcesPath, 'app', '.webpack', 'main', 'phone_set.json'));
            }
        } catch (_) {}
        // Fallback: require.main.path (non-webpack / CLI mode)
        try {
            if (require.main && require.main.path) {
                searchPaths.push(path.join(require.main.path, 'inference', 'phone_set.json'));
                searchPaths.push(path.join(require.main.path, 'src', 'inference', 'phone_set.json'));
            }
        } catch (_) {}

        console.log(`[OnnxSVSPipeline] _loadPhoneSet: __dirname=${__dirname}`);
        for (const phoneSetPath of searchPaths) {
            try {
                const exists = fs.existsSync(phoneSetPath);
                console.log(`[OnnxSVSPipeline]   checking: ${phoneSetPath} → ${exists ? 'FOUND' : 'missing'}`);
                if (exists) {
                    const phoneList = JSON.parse(fs.readFileSync(phoneSetPath, 'utf-8'));
                    for (let i = 0; i < phoneList.length; i++) {
                        this.phone2idx[phoneList[i]] = i;
                    }
                    this._vocabSize = phoneList.length;
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
        // Fallback paths for packaged Electron app (asar / unpacked)
        try {
            if (process.resourcesPath) {
                searchPaths.push(path.join(process.resourcesPath, 'app.asar', '.webpack', 'main', 'en_g2p_dict.json'));
                searchPaths.push(path.join(process.resourcesPath, 'app', '.webpack', 'main', 'en_g2p_dict.json'));
            }
        } catch (_) {}
        // Fallback: require.main.path (non-webpack / CLI mode)
        try {
            if (require.main && require.main.path) {
                searchPaths.push(path.join(require.main.path, 'inference', 'en_g2p_dict.json'));
                searchPaths.push(path.join(require.main.path, 'src', 'inference', 'en_g2p_dict.json'));
            }
        } catch (_) {}
        for (const dictPath of searchPaths) {
            try {
                if (fs.existsSync(dictPath)) {
                    this.enG2pDict = JSON.parse(fs.readFileSync(dictPath, 'utf-8'));
                    this._dictSize = Object.keys(this.enG2pDict).length;
                    console.log(`[OnnxSVSPipeline] English G2P dictionary loaded (CMUdict): ${this._dictSize} words (path: ${dictPath})`);
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
        const dictSize = this._dictSize;
        if (dictSize === 0) {
            console.warn(`[OnnxSVSPipeline] English G2P dictionary is empty! Word "${word}" cannot be resolved.`);
        } else {
            console.warn(`[OnnxSVSPipeline] English word "${word}" not in CMUdict (${dictSize} entries), using letter-level fallback`);
        }
        // 字母→音素映射：基于字母在单词中的常见发音（自然发音规则），
        // 而非字母本身的读音。适用于未登录词（如 hahaha、拟声词）。
        // 元音带主重音 1（SVS 中每个音节通常都有重音）。
        const letterMap = {
            a: 'AE1', b: 'B', c: 'K', d: 'D', e: 'EH1',
            f: 'F', g: 'G', h: 'HH', i: 'IH1', j: 'JH',
            k: 'K', l: 'L', m: 'M', n: 'N', o: 'AA1',
            p: 'P', q: 'K', r: 'R', s: 'S', t: 'T',
            u: 'AH1', v: 'V', w: 'W', x: 'K S', y: 'Y',
            z: 'Z',
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
        const trimmed = repairMojibake(lyric.trim());

        // Ensure vocabulary is loaded (lazy reload if empty)
        if (this._vocabSize === 0) {
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
        const vocabSize = this._vocabSize;
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
                let syllable = py[0].toLowerCase().replace(/ü/g, 'v');
                if (overrideTone) {
                    syllable = syllable.replace(/\d?$/, overrideTone);
                } else if (/0$/.test(syllable)) {
                    // pinyin-pro uses tone 0 for neutral tone; the model
                    // vocabulary follows the standard pinyin convention 5.
                    syllable = syllable.replace(/0$/, '5');
                } else if (!/[1-5]$/.test(syllable)) {
                    syllable += '5';
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
        let trimmed = repairMojibake(lyric.trim());
        if (trimmed === '<SP>') return [{ name: '<SP>', display: 'SP' }];
        if (trimmed === '<AP>') return [{ name: '<AP>', display: 'AP' }];

        // Handle <jp> prefix: force Japanese G2P for kanji etc.
        let forceJp = false;
        if (trimmed.startsWith('<jp>')) {
            forceJp = true;
            trimmed = trimmed.slice(4).trim();
        }

        if (trimmed.startsWith('jp_')) {
            // In en-phonemes / hybrid mode, convert jp_ prefixed phonemes to English phonemes
            if (this.japaneseVocalization === 'en-phonemes' || this.japaneseVocalization === 'hybrid') {
                const jpPhone = trimmed.slice(3);
                return this._japanesePhoneToEnglishPhonemes(jpPhone);
            }
            return [{ name: trimmed, display: trimmed.slice(3) }];
        }

        if (forceJp || this._isJapanese(trimmed)) {
            // In en-phonemes / hybrid mode, convert Japanese kana/kanji to English phonemes
            if (this.japaneseVocalization === 'en-phonemes' || this.japaneseVocalization === 'hybrid') {
                return this._japaneseToEnglishPhonemes(trimmed);
            }
            const phonemes = this._japaneseG2p(trimmed);
            if (phonemes) {
                return phonemes.split(' ').filter(s => s).map(ph => {
                    const name = 'jp_' + ph;
                    return { name, display: ph };
                });
            }
        }

        if (trimmed.startsWith('en_') && trimmed.includes('-')) {
            const phonemes = trimmed.slice(3).split('-').map(s => {
                const name = 'en_' + s.trim();
                return { name, display: s.trim() };
            });
            return this._attachEnglishWeights(phonemes);
        }

        if (/^[a-zA-Z]+$/.test(trimmed) && !trimmed.startsWith('en_') && !trimmed.startsWith('zh_') && !trimmed.startsWith('yue_') && !trimmed.startsWith('jp_')) {
            const g2pResult = this._englishG2p(trimmed);
            if (g2pResult) {
                const phonemes = g2pResult.split(' ').map(ph => {
                    const name = 'en_' + ph.trim();
                    return { name, display: ph.trim() };
                });
                return this._attachEnglishWeights(phonemes);
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

    /**
     * 根据当前模式返回 JP→EN 映射表。
     * hybrid 模式使用改进的映射（L 替代 R、AO 替代 OW），其他模式使用默认表。
     */
    _getJpToEnMap() {
        return this.japaneseVocalization === 'hybrid'
            ? JP_TO_EN_PHONEME_MAP_HYBRID
            : JP_TO_EN_PHONEME_MAP;
    }

    /**
     * 将日文（假名/汉字）转换为英语音素对象数组（en_ 前缀）。
     * 内部先调用 _japaneseG2p 得到日语音素序列（如 'k a'），再逐个查表映射为 ARPAbet。
     * 映射后的音素附带 duration weight（通过 _attachEnglishWeights），用于 UI 时长分配。
     *
     * hybrid 模式：
     *   1) 优先尝试假名→粤语音节级映射（_japaneseKanaToYuePhonemes）。当整段歌词
     *      完全由"有粤语对应音节"的假名组成时，返回 yue_ 音素数组。
     *   2) 否则回退到 ARPAbet 映射（处理汉字、が/ざ/だ/ば行、拗音、促音、ん等）。
     *
     * en-phonemes 模式使用默认 ARPAbet 映射表。
     * 'pau'（未知汉字回退）映射为 <SP>（静音）。
     *
     * @param {string} text - 日文歌词（假名/汉字/混合）
     * @returns {Array<{name:string, display:string, weight?:number}>} 英语音素对象数组
     */
    _japaneseToEnglishPhonemes(text) {
        // hybrid 模式：逐 mora 选择 yue 音节或 ARPAbet 回退。未覆盖的
        // 单个假名不再迫使整段歌词放弃已经可用的 yue 映射。
        if (this.japaneseVocalization === 'hybrid') {
            const yueResult = this._japaneseKanaToYuePhonemes(text);
            if (yueResult) return yueResult;
        }

        const jpPhonemeStr = this._japaneseG2p(text);
        if (!jpPhonemeStr) return [{ name: '<SP>', display: 'SP' }];

        const map = this._getJpToEnMap();
        const jpParts = jpPhonemeStr.split(' ').filter(s => s);
        const enPhonemes = [];
        // Track the JP source phoneme for each EN phoneme, so we can attach
        // mora-based weights (e.g., 'ts' → [T, S] each gets half of ts weight).
        const jpSources = [];
        for (const jpPart of jpParts) {
            if (jpPart === 'pau') {
                // Unknown kanji → silence
                enPhonemes.push({ name: '<SP>', display: 'SP' });
                jpSources.push('pau');
                continue;
            }
            const mapped = map[jpPart];
            if (mapped) {
                for (const enPh of mapped) {
                    enPhonemes.push({ name: 'en_' + enPh, display: enPh });
                    jpSources.push(jpPart);
                }
            } else {
                // Fallback: if no mapping exists, try to use as-is (shouldn't happen normally)
                console.warn(`[TextProcessing] No JP→EN mapping for "${jpPart}", using <UNK>`);
                enPhonemes.push({ name: '<UNK>', display: jpPart });
                jpSources.push(jpPart);
            }
        }
        return this._attachJapaneseWeights(enPhonemes, jpSources, false);
    }

    /**
     * 将纯假名歌词逐 mora 转换为混合 yue/ARPAbet 音素。
     *
     * 有可靠粤语近似的假名使用 yue_ 音节；缺少映射的单个假名、浊音、
     * 拗音、促音和拨音仅对当前 mora 回退到 ARPAbet，不再触发整词回退。
     * 汉字或非假名仍返回 null，由上层完整的 _japaneseG2p 负责词典读音。
     *
     * 長音符号 ー 延长紧邻 mora 的韵核。对于 yue_ 辅音音节，追加对应
     * 的 ARPAbet 元音，而不是复制整个 yue_ 音节；纯元音 yue_ 音节可以
     * 直接重复。若前一 mora 是拨音 ん，则重复 en_N。〜 仅作样式符号忽略。
     *
     * @param {string} text - 日文纯假名歌词
     * @returns {Array<{name:string, display:string, weight?:number}>|null}
     */
    _japaneseKanaToYuePhonemes(text) {
        if (!text || text.length === 0) return null;
        const result = [];
        let lastExtension = null;
        let i = 0;

        const appendArpabetForJp = (jpString, display) => {
            const jpPhones = jpString.split(' ').filter(Boolean);
            for (const jpPhone of jpPhones) {
                const mapped = this._japanesePhoneToEnglishPhonemes(jpPhone);
                for (const phone of mapped) result.push({ ...phone, display });
            }
            const lastJp = jpPhones[jpPhones.length - 1];
            if (lastJp === 'n') {
                lastExtension = { name: 'en_N', display: 'ー', weight: JP_MORA_WEIGHTS.n };
            } else if (['a', 'i', 'u', 'e', 'o'].includes(lastJp)) {
                const vowel = this._japanesePhoneToEnglishPhonemes(lastJp).slice(-1)[0];
                lastExtension = vowel ? { ...vowel, display: 'ー' } : null;
            } else {
                lastExtension = null;
            }
        };

        while (i < text.length) {
            const ch = text[i];
            if (ch === 'ー') {
                if (lastExtension) result.push({ ...lastExtension, display: ch });
                i++;
                continue;
            }
            if (ch === '〜') { i++; continue; }

            let unit = ch;
            let jp = null;
            if (i + 1 < text.length) {
                const combo = ch + text[i + 1];
                jp = JP_HIRAGANA_MAP[combo] || JP_KATAKANA_MAP[combo] || null;
                if (jp) unit = combo;
            }

            const yueName = unit.length === 1
                ? (JpKanaToYueSyllableMap[unit] || JpKataKanaToYueSyllableMap[unit])
                : null;
            if (yueName) {
                result.push({ name: yueName, display: unit, weight: 1.0 });
                const jpString = JP_HIRAGANA_MAP[unit] || JP_KATAKANA_MAP[unit];
                const lastJp = jpString ? jpString.split(' ').pop() : null;
                // Pure-vowel yue tokens already contain no onset and are safe to repeat.
                if (['あ', 'お', 'を', 'ア', 'オ', 'ヲ'].includes(unit)) {
                    lastExtension = { name: yueName, display: 'ー', weight: 1.0 };
                } else if (lastJp) {
                    const vowel = this._japanesePhoneToEnglishPhonemes(lastJp).slice(-1)[0];
                    lastExtension = vowel ? { ...vowel, display: 'ー' } : null;
                }
                i++;
                continue;
            }

            jp = jp || JP_HIRAGANA_MAP[unit] || JP_KATAKANA_MAP[unit];
            if (jp) {
                appendArpabetForJp(jp, unit);
                i += unit.length;
                continue;
            }

            // Preserve dictionary-based handling for kanji and reject arbitrary text.
            return null;
        }
        return result.length > 0 ? result : null;
    }

    /**
     * 将单个日语音素（如 'k', 'a', 'sh', 'ts', 'ky'）转换为英语音素对象数组。
     * 用于 jp_ 前缀歌词的直接映射（如 'jp_k' → en_K）。
     *
     * hybrid 模式使用改进映射表（L 替代 R、AO 替代 OW），en-phonemes 模式使用默认表。
     *
     * @param {string} jpPhone - 日语音素基名（不含 jp_ 前缀）
     * @returns {Array<{name:string, display:string, weight?:number}>} 英语音素对象数组
     */
    _japanesePhoneToEnglishPhonemes(jpPhone) {
        const map = this._getJpToEnMap();
        const mapped = map[jpPhone];
        if (!mapped || mapped.length === 0) {
            console.warn(`[TextProcessing] No JP→EN mapping for jp_${jpPhone}, using <UNK>`);
            return [{ name: '<UNK>', display: jpPhone, weight: JP_MORA_DEFAULT_WEIGHT }];
        }
        const enPhonemes = mapped.map(enPh => ({ name: 'en_' + enPh, display: enPh }));
        // Attach mora-based weights using the JP source phoneme identity.
        const jpSources = new Array(mapped.length).fill(jpPhone);
        return this._attachJapaneseWeights(enPhonemes, jpSources, false);
    }

    /**
     * 给英文音素对象数组附带 duration weight（用于 UI 默认音素时长分配）。
     * weight 是该音素相对时长的无量纲权重，UI 端按 weight 比例分配 durationRatio。
     * 注意：此处是逐 lyric 独立解析，无跨 note 上下文，position 一律按 medial。
     * 这与推理时的 _allocateByStats（使用跨 note trigram 上下文）有精度差异，
     * 但足以让 UI 默认分布呈现"元音长、辅音短"的趋势，避免完全平均分布。
     * @param {Array<{name:string, display:string}>} phonemes
     * @returns {Array} 同一数组，每个对象附带 weight 字段
     */
    _attachEnglishWeights(phonemes) {
        if (!phonemes || phonemes.length === 0) return phonemes;
        const stats = durationStats.loadDurationStatsSync();
        if (!stats || !stats.unigram) return phonemes;
        const SPECIAL = new Set(['<SEP>', '<BOW>', '<EOW>', '<PAD>', '<SP>', '<AP>']);
        for (let i = 0; i < phonemes.length; i++) {
            const name = phonemes[i].name || '';
            if (!name.startsWith('en_') || SPECIAL.has(name)) {
                phonemes[i].weight = 1.0;
                continue;
            }
            const curr = durationStats.barePhone(name);
            const prev = i > 0 ? durationStats.barePhone(phonemes[i - 1].name || '') : '<S>';
            const next = i < phonemes.length - 1 ? durationStats.barePhone(phonemes[i + 1].name || '') : '<E>';
            phonemes[i].weight = durationStats.lookupWeight(stats, curr, prev, next, 'medial');
        }
        return phonemes;
    }

    /**
     * 给日语音素对象数组附带 mora-timing duration weight。
     *
     * 与 _attachEnglishWeights 不同，这里使用 JP_MORA_WEIGHTS 表（基于日语
     * 拍时序 phonetics），而非英文统计表（基于重音时序）。原因：
     *   - 日语每个拍 (mora) 时长基本相等，元音不应因"重音"差异而时长悬殊
     *   - 英文 AA1 vs AA0 时长差可达 3x，对日语 /a/ 毫无意义
     *   - 辅音应明显短于元音（C:V ≈ 0.35），符合日语语音学测量
     *
     * 当 jpSources 为 null（yue 路径）时，每个 yue_ 音节视为一个完整拍，
     * weight = 1.0（拍等长原则）。yue_ 音节本身已包含辅音+元音，无需拆分。
     *
     * 当 jpSources 提供时（ARPAbet 路径），按 JP 源音素查 JP_MORA_WEIGHTS，
     * 若一个 JP 音素映射到多个 EN 音素（如 ts→T+S），权重均分到各分量。
     *
     * @param {Array<{name:string, display:string}>} phonemes 音素对象数组
     * @param {string[]|null} jpSources 每个音素对应的 JP 源音素基名，或 null（yue 路径）
     * @param {boolean} isYue 是否为 yue 音节路径
     * @returns {Array} 同一数组，每个对象附带 weight 字段
     */
    _attachJapaneseWeights(phonemes, jpSources, isYue) {
        if (!phonemes || phonemes.length === 0) return phonemes;
        const SPECIAL = new Set(['<SEP>', '<BOW>', '<EOW>', '<PAD>', '<SP>', '<AP>']);

        if (isYue || !jpSources) {
            // yue_ syllable path: each syllable = 1 mora, equal weight.
            // Special tokens (rare in this path) get reduced weight.
            for (let i = 0; i < phonemes.length; i++) {
                const name = phonemes[i].name || '';
                phonemes[i].weight = SPECIAL.has(name) ? 0.3 : 1.0;
            }
            return phonemes;
        }

        // ARPAbet path: group consecutive phonemes by their JP source, then
        // split the source's mora weight equally among the components.
        // E.g., jpParts = ['k', 'a', 'ts', 'a'] → EN = [K, AA1, T, S, AA1]
        //   jpSources = ['k', 'a', 'ts', 'ts', 'a']
        //   weights   = [0.35, 1.0, 0.275, 0.275, 1.0]  (ts weight 0.55 / 2)
        for (let i = 0; i < phonemes.length; i++) {
            const name = phonemes[i].name || '';
            if (SPECIAL.has(name)) {
                phonemes[i].weight = 0.3;
                continue;
            }
            const jpSrc = jpSources[i] || '';
            const baseWeight = JP_MORA_WEIGHTS[jpSrc] !== undefined
                ? JP_MORA_WEIGHTS[jpSrc]
                : JP_MORA_DEFAULT_WEIGHT;
            // Count how many EN phonemes share this same JP source (consecutive)
            let componentCount = 1;
            for (let k = i + 1; k < phonemes.length && jpSources[k] === jpSrc; k++) {
                componentCount++;
            }
            phonemes[i].weight = baseWeight / componentCount;
        }
        return phonemes;
    }

    _isJapanese(text) {
        // Only detect hiragana/katakana as Japanese, NOT CJK kanji (shared with Chinese)
        return /[ぁ-ゟァ-ヿ]/.test(text);
    }

    _japaneseG2p(text) {
        const result = [];
        // Japanese vowel phonemes — used to handle 長音 (ー) by repeating the
        // preceding vowel. In Japanese, ー doubles the duration of the vowel
        // it follows (e.g., おかあさん → /o k a a s a N/). Previously ー was
        // skipped entirely, which lost the long/short vowel contrast and made
        // words like おばさん (obasan) and おばあさん (obaasan) sound identical.
        const JP_VOWELS = new Set(['a', 'i', 'u', 'e', 'o']);
        let i = 0;
        while (i < text.length) {
            const ch = text[i];
            // 長音 (ー): repeat the last emitted vowel to double its duration.
            // 〜 (wave dash) is a stylistic mark, not phonetic — skip it.
            if (ch === 'ー') {
                const previous = result[result.length - 1];
                if (JP_VOWELS.has(previous) || previous === 'n') result.push(previous);
                i++;
                continue;
            }
            if (ch === '〜') { i++; continue; }

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

module.exports = { TextProcessing, JP_MORA_WEIGHTS, JP_MORA_DEFAULT_WEIGHT };
