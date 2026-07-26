#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Generate jpKanjiDict.json from KANJIDIC2.

Reads kanjidic2.xml (expected at %TEMP%/kanjidic2.xml or alongside this script),
extracts all JIS X 0208 kanji (which includes all 2136 Jōyō kanji + Jinmeiyō),
picks the best reading for each kanji, converts kana → phonemes using the same
JP_HIRAGANA_MAP as src/inference/pipeline/textProcessing.js, and writes the
result to src/inference/pipeline/jpKanjiDict.json.

Reading selection strategy (matches the hand-curated JP_KANJI_DICT style):
  1. Prefer the first kunyomi (ja_kun) — usually the most common native reading.
     Strip '.' (okurigana boundary) so the full word form is produced
     (e.g. 'と.ぶ' → 'とぶ' → 't o b u').
     Skip kunyomi starting with '-' (prefix/suffix-only stems).
  2. If no usable kunyomi, use the first onyomi (ja_on, katakana).
  3. If neither, skip the kanji.

The hand-curated entries in textProcessing.js / kanjiGroupUtils.js (the ~50
kanji JP_KANJI_DICT) are merged ON TOP of this generated dict as overrides,
so carefully chosen readings (e.g. '小' → 'ch i i s a', numbers → onyomi)
are preserved.

Usage:
    python scripts/generate_jp_kanji_dict.py [path/to/kanjidic2.xml]

If no path is given, the script looks in %TEMP%/kanjidic2.xml first, then
in the script directory.
"""

import sys
import os
import json
import xml.etree.ElementTree as ET

# ---------------------------------------------------------------------------
# JP_HIRAGANA_MAP — mirrors src/inference/pipeline/textProcessing.js exactly.
# Each value is a space-separated phoneme string.
# ---------------------------------------------------------------------------
JP_HIRAGANA_MAP = {
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
}

# Katakana → phoneme map (auto-generated, mirrors textProcessing.js)
# Only single-char hiragana can be converted to katakana via +0x60 offset.
# 2-char yōon combos (e.g. 'きゃ') are skipped — their katakana equivalents
# ('キャ') are built from small kana which the JS code handles via the same
# +0x60 offset on the first char + small ャュョ. We handle katakana yōon
# separately in kana_to_phonemes() below.
JP_KATAKANA_MAP = {}
for _hira, _ph in JP_HIRAGANA_MAP.items():
    if len(_hira) == 1:
        _kata = chr(ord(_hira) + 0x60)
        JP_KATAKANA_MAP[_kata] = _ph

# Build katakana yōon map from hiragana yōon: replace first char with katakana
# and second char (small kana) with its katakana equivalent.
# E.g. 'きゃ' → 'キャ' (キ + ャ)
_HIRA_SMALL_TO_KATA_SMALL = {
    'ゃ': 'ャ', 'ゅ': 'ュ', 'ょ': 'ョ',
}
for _hira, _ph in JP_HIRAGANA_MAP.items():
    if len(_hira) == 2 and _hira[1] in _HIRA_SMALL_TO_KATA_SMALL:
        _kata_first = chr(ord(_hira[0]) + 0x60)
        _kata_second = _HIRA_SMALL_TO_KATA_SMALL[_hira[1]]
        JP_KATAKANA_MAP[_kata_first + _kata_second] = _ph

# Small kana (っ is in the map; small ゃゅょ are part of yōon combos above).
# Small 'ァィゥェォ' (vowel kana) and 'ャュョ' are handled as parts of combos
# in KANJIDIC2 onyomi (e.g. 'シャ' → 'sh a'). We don't need to map them alone.


def kana_to_phonemes(kana_str):
    """Convert a kana string to a space-separated phoneme string.

    Uses greedy longest-match (2-char yōon first, then 1-char).
    Returns None if any character cannot be mapped.
    """
    if not kana_str:
        return None
    result = []
    i = 0
    n = len(kana_str)
    while i < n:
        matched = False
        # Try 2-char yōon combo first
        if i + 1 < n:
            combo = kana_str[i:i + 2]
            if combo in JP_HIRAGANA_MAP:
                result.extend(JP_HIRAGANA_MAP[combo].split(' '))
                i += 2
                matched = True
                continue
            if combo in JP_KATAKANA_MAP:
                result.extend(JP_KATAKANA_MAP[combo].split(' '))
                i += 2
                matched = True
                continue
        # Try single char
        ch = kana_str[i]
        if ch in JP_HIRAGANA_MAP:
            result.extend(JP_HIRAGANA_MAP[ch].split(' '))
            i += 1
            matched = True
            continue
        if ch in JP_KATAKANA_MAP:
            result.extend(JP_KATAKANA_MAP[ch].split(' '))
            i += 1
            matched = True
            continue
        # Unmapped char (e.g. 'ー' long vowel mark, '.', '-')
        # Skip 'ー', '.', '-' silently — they are not phonemes.
        if ch in ('ー', '.', '〜', '-'):
            i += 1
            matched = True
            continue
        # Unknown char — fail
        return None
    if not result:
        return None
    return ' '.join(result)


def pick_best_reading(char_elem):
    """Pick the best kana reading for a kanji from its <reading_meaning> element.

    Returns the kana string (hiragana or katakana), or None if no usable reading.

    Strategy:
      1. Filter kunyomi (ja_kun) to remove prefix/suffix forms (starting '-').
      2. If multi-char kunyomi exist, prefer them over 1-char kunyomi
         (1-char kunyomi like 'え' for 重 are often rare readings).
      3. Pick the FIRST remaining kunyomi (KANJIDIC2 lists common readings
         first), strip '.' (okurigana boundary) to produce the full word form.
      4. If no usable kunyomi, use the first onyomi (ja_on).
    """
    rm = char_elem.find('reading_meaning')
    if rm is None:
        return None

    kun_list = []
    on_list = []
    for rmgroup in rm.findall('rmgroup'):
        for r in rmgroup.findall('reading'):
            r_type = r.get('r_type', '')
            text = (r.text or '').strip()
            if not text:
                continue
            if r_type == 'ja_kun':
                kun_list.append(text)
            elif r_type == 'ja_on':
                on_list.append(text)

    # Filter out prefix/suffix forms (starting with '-')
    usable_kun = [k for k in kun_list if not k.startswith('-')]

    if usable_kun:
        # Prefer multi-char kunyomi over 1-char (rare) kunyomi
        multi_char = [k for k in usable_kun if len(k) > 1]
        candidates = multi_char if multi_char else usable_kun
        # Pick the first candidate (KANJIDIC2 lists common readings first)
        return candidates[0].replace('.', '')

    # Fallback: first onyomi
    if on_list:
        return on_list[0]

    return None


def is_joyo_or_common(char_elem):
    """Return True if the kanji is Jōyō (grade 1-8) or has a frequency ranking.

    KANJIDIC2 <misc> contains:
      <grade>1-8</grade>  → Jōyō kanji taught in school (2136 total)
      <grade>9-10</grade> → Jinmeiyō (name-only kanji)
      <freq>N</freq>      → frequency ranking (top ~2500 most common)
    We include grade 1-8 (all Jōyō) plus any kanji with a frequency ranking
    (covers common kanji that might not be in Jōyō but appear in songs).
    """
    misc = char_elem.find('misc')
    if misc is None:
        return False
    grade_elem = misc.find('grade')
    if grade_elem is not None and grade_elem.text:
        try:
            g = int(grade_elem.text)
            if 1 <= g <= 8:
                return True
        except ValueError:
            pass
    freq_elem = misc.find('freq')
    if freq_elem is not None and freq_elem.text:
        return True
    return False


def main():
    # --- Locate kanjidic2.xml ---
    candidates = []
    if len(sys.argv) > 1:
        candidates.append(sys.argv[1])
    candidates.append(os.path.join(os.environ.get('TEMP', ''), 'kanjidic2.xml'))
    candidates.append(os.path.join(os.path.dirname(__file__), 'kanjidic2.xml'))

    xml_path = None
    for c in candidates:
        if c and os.path.isfile(c):
            xml_path = c
            break
    if xml_path is None:
        print('ERROR: kanjidic2.xml not found. Tried:', file=sys.stderr)
        for c in candidates:
            print('  ', c, file=sys.stderr)
        print('Download from https://www.edrdg.org/pub/Nihongo/kanjidic2.xml.gz',
              file=sys.stderr)
        sys.exit(1)

    print(f'[generate_jp_kanji_dict] Parsing {xml_path} ...')

    # Parse XML iteratively to keep memory low
    # Use iterparse to stream <character> elements.
    context = ET.iterparse(xml_path, events=('start', 'end'))
    context = iter(context)
    _, root = next(context)  # get root element

    generated = {}
    stats = {
        'total_chars': 0,
        'joyo_or_common': 0,
        'with_reading': 0,
        'kunyomi_used': 0,
        'onyomi_used': 0,
        'phoneme_failed': 0,
    }

    for event, elem in context:
        if event != 'end' or elem.tag != 'character':
            continue
        stats['total_chars'] += 1

        literal_elem = elem.find('literal')
        if literal_elem is None or not literal_elem.text:
            elem.clear()
            continue
        kanji = literal_elem.text.strip()

        if not is_joyo_or_common(elem):
            elem.clear()
            continue
        stats['joyo_or_common'] += 1

        reading = pick_best_reading(elem)
        if not reading:
            elem.clear()
            continue
        stats['with_reading'] += 1

        # Determine if kunyomi or onyomi was used (for stats)
        # pick_best_reading returns kunyomi (hiragana) or onyomi (katakana)
        is_kana = any(0x3040 <= ord(c) <= 0x309F for c in reading)  # hiragana
        if is_kana:
            stats['kunyomi_used'] += 1
        else:
            stats['onyomi_used'] += 1

        phonemes = kana_to_phonemes(reading)
        if not phonemes:
            stats['phoneme_failed'] += 1
            elem.clear()
            continue

        generated[kanji] = phonemes
        elem.clear()

    root.clear()

    print(f'[generate_jp_kanji_dict] Parsed {stats["total_chars"]} characters')
    print(f'  Jōyō/common:          {stats["joyo_or_common"]}')
    print(f'  With reading:         {stats["with_reading"]}')
    print(f'  Kunyomi used:         {stats["kunyomi_used"]}')
    print(f'  Onyomi used:          {stats["onyomi_used"]}')
    print(f'  Phoneme conv failed:  {stats["phoneme_failed"]}')
    print(f'  Generated entries:    {len(generated)}')

    # --- Merge with hand-curated overrides (the ~50 kanji JP_KANJI_DICT) ---
    # These override the generated readings because they were carefully chosen
    # for song lyrics (e.g. numbers use onyomi, '小' → 'ch i i s a' truncated form).
    HAND_CURATED_OVERRIDES = {
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
    }

    overrides_applied = 0
    for k, v in HAND_CURATED_OVERRIDES.items():
        if k not in generated or generated[k] != v:
            overrides_applied += 1
        generated[k] = v

    print(f'  Hand-curated overrides applied: {overrides_applied}')
    print(f'  Final entry count: {len(generated)}')

    # --- Write JSON ---
    # Determine output path: src/inference/pipeline/jpKanjiDict.json
    # (relative to this script's location in scripts/)
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(script_dir)
    out_path = os.path.join(project_root, 'src', 'inference', 'pipeline',
                            'jpKanjiDict.json')

    # Sort by unicode codepoint for deterministic output
    sorted_dict = {k: generated[k] for k in sorted(generated.keys())}

    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(sorted_dict, f, ensure_ascii=False, indent=1)
        f.write('\n')

    out_size = os.path.getsize(out_path)
    print(f'[generate_jp_kanji_dict] Wrote {out_path} ({out_size} bytes, '
          f'{len(sorted_dict)} entries)')

    # --- Sanity check: verify a few known kanji ---
    print('[generate_jp_kanji_dict] Sanity check:')
    for k in ['空', '花', '一', '愛', '日', '本', '語', '人', '年', '中']:
        v = sorted_dict.get(k, '<MISSING>')
        print(f'  {k} → {v}')


if __name__ == '__main__':
    main()
