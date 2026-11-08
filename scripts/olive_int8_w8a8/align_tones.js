/**
 * Recover the tone digit that GTSinger's phone annotation omits.
 *
 * GTSinger Chinese annotations are syllable phones only ("zh" + "uan"), and the
 * vocabulary keys are tone-suffixed (zh_quan1..4). Feeding a toneless token to
 * the pipeline ends up as <UNK> (see textProcessing._lookupPhonemeId: the tone
 * fallback regex requires [1-5]), which would make the calibration data and the
 * end-to-end audio unrepresentative.
 *
 * The dataset's `txt` column holds the lyric characters, so we walk those
 * characters in order and, for each merged syllable, pick the character whose
 * pinyin base matches — its resolved phoneme (tone included) then replaces the
 * toneless token. Resolution goes through the pipeline's own TextProcessing, so
 * the token is exactly what a real user typing that lyric would produce.
 *
 * Usage:
 *   node scripts/olive_int8_w8a8/align_tones.js [--items <path>] [--dry]
 *
 * Rewrites items.json in place (keeps a .bak) and prints the remaining <UNK>
 * count, which must be 0 for Chinese items.
 */
const fs = require('node:fs');
const path = require('node:path');
const { TextProcessing } = require('../../src/inference/pipeline/textProcessing');

const ROOT = path.resolve(__dirname, '..', '..');

function arg(flag, dflt) {
    const i = process.argv.indexOf(flag);
    return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

const ITEMS = path.resolve(ROOT, arg('--items', 'calibrate/data/gt_int8/items.json'));
const DRY = process.argv.includes('--dry');
const MAX_SKIP = 4;

/** zh_quan4 -> 'quan';  zh_yue4 -> 'yue' (ü folding uses ':') */
function baseOf(token) {
    return String(token).replace(/^zh_/, '').replace(/[1-5]$/, '');
}

function main() {
    const doc = JSON.parse(fs.readFileSync(ITEMS, 'utf8'));
    const tp = new TextProcessing({});
    const unkId = tp.phone2idx['<UNK>'];

    // Silence the phone_set path chatter TextProcessing logs on construction.
    let replaced = 0, kept = 0, slurred = 0, fallback = 0;
    const unresolved = [];
    const report = [];

    /** Any existing tone variant of `base` — last-resort so nothing is <UNK>. */
    const anyTone = (base) => {
        for (const t of ['4', '1', '2', '3', '5']) {
            const key = `zh_${base}${t}`;
            if (tp.phone2idx[key] !== undefined) return key;
        }
        return null;
    };

    for (const item of doc.items) {
        const chars = Array.from(item.text || '').filter((c) => /[\u4e00-\u9fff]/.test(c));
        let ci = 0;
        let lastBase = null;
        let lastPhoneme = null;
        let itemReplaced = 0, itemSlurred = 0, itemFallback = 0;
        const itemUnresolved = [];

        for (const note of item.notes) {
            if (note.noteType !== 'lyric') continue;
            const lyric = note.phoneme;
            const id = tp._lookupPhonemeId(lyric);
            const isUnk = unkId !== undefined && id === unkId;
            if (!isUnk) { kept++; lastBase = baseOf(lyric); lastPhoneme = lyric; continue; }

            if (!String(lyric).startsWith('zh_')) {
                itemUnresolved.push(lyric);
                unresolved.push(`${path.basename(item.item)}:${lyric}`);
                continue;
            }

            const want = baseOf(lyric);
            let fixed = null;

            // A note held over several pitches reuses one character in `txt`.
            if (want === lastBase && lastPhoneme) {
                fixed = lastPhoneme;
                itemSlurred++;
            }
            // Otherwise borrow the tone from the lyric character at the cursor.
            if (!fixed) {
                for (let k = 0; k < MAX_SKIP && ci + k < chars.length; k++) {
                    const cand = tp._charToZhPhoneme(chars[ci + k]);
                    if (!cand) continue;
                    if (baseOf(cand) === want) {
                        fixed = cand;
                        ci += k + 1;
                        itemReplaced++;
                        break;
                    }
                }
            }
            // Last resort: keep the syllable, attach any tone that exists.
            if (!fixed) {
                fixed = anyTone(want);
                if (fixed) { itemFallback++; }
            }

            if (fixed) {
                note.phoneme = fixed;
                replaced++;
                lastBase = baseOf(fixed);
                lastPhoneme = fixed;
            } else {
                itemUnresolved.push(lyric);
                unresolved.push(`${path.basename(item.item)}:${lyric}`);
            }
        }
        slurred += itemSlurred;
        fallback += itemFallback;
        report.push(`  ${item.language.padEnd(8)} chars=${String(chars.length).padStart(3)} ` +
            `fromText=${itemReplaced} slur=${itemSlurred} anyTone=${itemFallback} ` +
            `unresolved=${itemUnresolved.length}` +
            (itemUnresolved.length ? ' [' + [...new Set(itemUnresolved)].slice(0, 6).join(',') + ']' : ''));
    }

    // Re-check the whole file after patching.
    let unkAfter = 0, lyricNotes = 0;
    for (const item of doc.items) {
        for (const note of item.notes) {
            if (note.noteType !== 'lyric') continue;
            lyricNotes++;
            if (tp._lookupPhonemeId(note.phoneme) === unkId) unkAfter++;
        }
    }

    console.log(`[tones] exact=${kept} fromText=${replaced - slurred - fallback} ` +
        `slur=${slurred} anyTone=${fallback} unresolved=${unresolved.length}`);
    report.forEach((l) => console.log(l));
    console.log(`[tones] after patch: ${lyricNotes - unkAfter}/${lyricNotes} lyric notes resolve ` +
        `(${unkAfter} <UNK>)`);

    if (DRY) {
        console.log('[tones] --dry, items.json untouched');
        return;
    }
    if (replaced > 0) {
        fs.copyFileSync(ITEMS, ITEMS + '.bak');
        fs.writeFileSync(ITEMS, JSON.stringify(doc, null, 1));
        console.log(`[tones] wrote ${path.relative(ROOT, ITEMS)} (backup .bak)`);
    } else {
        console.log('[tones] nothing to patch');
    }
}

main();
