#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Prepare GTSinger note-level inputs for INT8 calibration / validation.

Reads `eval_data/Soul-AILab/SoulX-Singer-Eval-Dataset/metadata.csv`, keeps the
GTSinger rows and converts them to the note objects the Node pipeline consumes
(one note per dataset "phone" entry):

    { pitch, duration(sec), phoneme, noteType, start(sec) }

The pipeline resolves a lyric that is already a phoneme token through
`_lookupPhonemeId()` (direct / zh_ / en_ / jp_ prefixes), so feeding the dataset
phoneme verbatim reproduces the dataset's phonetic content exactly instead of
re-running g2p on text.

Usage:
  python scripts/olive_int8_w8a8/prepare_gtsinger.py --limit 12 --min-notes 20
"""
import argparse
import csv
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CSV_PATH = ROOT / "eval_data" / "Soul-AILab" / "SoulX-Singer-Eval-Dataset" / "metadata.csv"
OUT_DIR = ROOT / "calibrate" / "data" / "gt_int8"
VOCAB_PATH = ROOT / "src" / "inference" / "phone_set.json"

# notes shorter than this are likely alignment artifacts
MIN_NOTE_SEC = 0.05

# GTSinger Chinese annotations are phone-level (initial + final split apart,
# e.g. "m" + "ei" for 美), while the model vocabulary is syllable-level
# (zh_mei3). Merge initial+final back into one syllable per note.
ZH_INITIALS = {
    "b", "p", "m", "f", "d", "t", "n", "l", "g", "k", "h",
    "j", "q", "x", "zh", "ch", "sh", "r", "z", "c", "s", "y", "w",
}
ZH_FINALS = {
    "a", "o", "e", "i", "u", "v", "er",
    "ai", "ei", "ao", "ou", "an", "en", "ang", "eng", "ong",
    "ia", "ie", "iao", "iou", "iu", "ian", "in", "iang", "ing", "iong",
    "ua", "uo", "uai", "uei", "ui", "uan", "uen", "un", "uang", "ueng",
    "ve", "u:e", "ue",
    "v", "van", "vn", "u:an", "u:n",
}
REST_PHONES = {"<SP>", "<AP>", "SP", "sil", "AP", ""}

# GTSinger writes some finals in their full form (iou / uei / uen) while the
# vocabulary uses the contracted pinyin spelling (iu / ui / un). ü is written
# as "v" in the dataset and as "u:" in the vocabulary.
ZH_FINAL_NORMALIZE = {
    "iou": "iu", "uei": "ui", "uen": "un",
    "v": "u:", "ve": "u:e", "van": "u:an", "vn": "u:n",
}
# j / q / x drop the umlaut in pinyin spelling (ju, qu, xu, juan, jun ...)
ZH_JQX_UMlAUT = {"u:": "u", "u:e": "ue", "u:an": "uan", "u:n": "un"}
# zero-initial syllables get a y / w spelling in pinyin
ZH_ZERO_INITIAL = {
    "i": "yi", "ia": "ya", "ie": "ye", "iao": "yao", "iou": "you", "iu": "you",
    "ian": "yan", "in": "yin", "iang": "yang", "ing": "ying", "iong": "yong",
    "u": "wu", "ua": "wa", "uo": "wo", "uai": "wai", "uei": "wei", "ui": "wei",
    "uan": "wan", "uen": "wen", "un": "wen", "uang": "wang", "ueng": "weng",
    "v": "yu", "ve": "yue", "van": "yuan", "vn": "yun", "u:": "yu",
    "u:e": "yue", "u:an": "yuan", "u:n": "yun",
    "er": "er", "e": "e", "a": "a", "o": "o", "ai": "ai", "ei": "ei",
    "ao": "ao", "ou": "ou", "an": "an", "en": "en", "ang": "ang",
    "eng": "eng", "ong": "ong",
}


def _syllable(initial, final):
    """Compose a vocabulary-style pinyin syllable from initial + final."""
    f = ZH_FINAL_NORMALIZE.get(final, final)
    if not initial:
        return ZH_ZERO_INITIAL.get(f, ZH_ZERO_INITIAL.get(final, f))
    if initial in ("j", "q", "x"):
        f = ZH_JQX_UMlAUT.get(f, f)
    return initial + f


def zh_phoneme_sequence(ph_list):
    """Merge phone-level Chinese annotations into syllable-level notes.

    Returns a list of (phoneme_text, weight) where weight is the number of
    original phones consumed (so durations can be summed).
    """
    out = []
    i = 0
    while i < len(ph_list):
        cur = ph_list[i]
        nxt = ph_list[i + 1] if i + 1 < len(ph_list) else None
        if cur in REST_PHONES:
            out.append((cur, 1))
            i += 1
            continue
        if cur in ZH_INITIALS and nxt in ZH_FINALS:
            out.append(("zh_" + _syllable(cur, nxt), 2))
            i += 2
            continue
        if cur in ZH_FINALS:
            # zero-initial syllable (安 / 爱 / 我): pinyin needs y / w spelling
            out.append(("zh_" + _syllable("", cur), 1))
            i += 1
            continue
        out.append(("zh_" + cur, 1))
        i += 1
    return out


def load_vocab():
    import json as _json
    return set(_json.loads(VOCAB_PATH.read_text(encoding="utf-8")))


def resolves(lyric, vocab):
    """Mirror textProcessing._lookupPhonemeId resolution (without <UNK>).

    Runtime needs an *exact* vocabulary key: `zh_quan` (no tone digit) falls
    through to `_nearestToneVariant`, whose regex requires `[1-5]`, so a
    toneless token ends up as <UNK>. Only exact keys / prefixed forms count.
    """
    if not lyric:
        return False
    if lyric in vocab:
        return True
    for prefix in ("zh_", "en_", "yue_", "jp_"):
        if prefix + lyric in vocab:
            return True
    return False


def build_items(limit, min_notes, max_notes, languages, per_lang=0):
    rows = list(csv.DictReader(CSV_PATH.open(encoding="utf-8")))
    items, seen_lang = [], {}
    for r in rows:
        if r.get("dataset") != "GTSinger":
            continue
        lang = r.get("language") or "unknown"
        if languages and lang not in languages:
            continue
        if per_lang and seen_lang.get(lang, 0) >= per_lang:
            continue
        pitches = json.loads(r["ep_pitches"])
        durs = json.loads(r["ep_notedurs"])
        types = json.loads(r["ep_types"]) if r.get("ep_types") else []
        phs = json.loads(r["ph"])
        if not (len(pitches) == len(durs) == len(phs)):
            continue
        if not (min_notes <= len(pitches) <= max_notes):
            continue

        notes, t = [], 0.0
        if lang == "Chinese":
            merged = zh_phoneme_sequence(phs)
            # walk merged syllables while consuming the original phone timeline
            idx = 0
            for lyric, consumed in merged:
                i = idx
                d = sum(float(durs[j]) for j in range(idx, min(idx + consumed, len(durs))))
                p = pitches[i] if i < len(pitches) else 0
                idx += consumed
                if d < MIN_NOTE_SEC:
                    t += d
                    continue
                is_rest = p <= 0 or lyric in REST_PHONES
                notes.append({
                    "pitch": int(p),
                    "duration": round(d, 5),
                    "start": round(t, 5),
                    "phoneme": lyric,
                    "noteType": "rest" if is_rest else "lyric",
                })
                t += d
        else:
            for i, (p, d, ph) in enumerate(zip(pitches, durs, phs)):
                if d < MIN_NOTE_SEC:
                    t += d
                    continue
                is_rest = p <= 0 or ph in REST_PHONES
                notes.append({
                    "pitch": int(p),
                    "duration": round(float(d), 5),
                    "start": round(t, 5),
                    "phoneme": ph,
                    "noteType": "rest" if is_rest else "lyric",
                })
                t += float(d)
        if len(notes) < min_notes:
            continue
        items.append({
            "item": r["item_name"],
            "dataset": r["dataset"],
            "language": r["language"],
            "singer": r["singer"],
            "wav_path": r["wav_path"],
            # GTSinger's phone annotation carries no tone, but the vocabulary
            # keys are tone-suffixed (zh_quan1..4). `text` holds the original
            # lyric characters, which align_tones.js uses to recover the exact
            # tone the pipeline would produce for a real user typing that line.
            "text": (r.get("txt") or "").strip(),
            "duration": round(t, 3),
            "notes": notes,
        })
        seen_lang[lang] = seen_lang.get(lang, 0) + 1
        if len(items) >= limit:
            break
    return items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=12)
    ap.add_argument("--min-notes", type=int, default=15)
    ap.add_argument("--max-notes", type=int, default=80)
    ap.add_argument("--languages", default="Chinese,English")
    ap.add_argument("--per-lang", type=int, default=0,
                    help="max items per language (0 = no per-language cap)")
    ap.add_argument("--out", default=str(OUT_DIR / "items.json"))
    args = ap.parse_args()

    langs = [s for s in args.languages.split(",") if s]
    items = build_items(args.limit, args.min_notes, args.max_notes, langs, args.per_lang)
    if not items:
        raise SystemExit("no GTSinger items matched the filters")

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps({
        "source": str(CSV_PATH),
        "count": len(items),
        "items": items,
    }, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"[prepare] {len(items)} GTSinger items -> {out}")
    vocab = load_vocab()
    for it in items:
        lyric_notes = [n for n in it["notes"] if n["noteType"] == "lyric"]
        ok = sum(1 for n in lyric_notes if resolves(n["phoneme"], vocab))
        cov = 100.0 * ok / max(1, len(lyric_notes))
        print(f"  {it['language']:8s} notes={len(it['notes']):3d} lyric={len(lyric_notes):3d} "
              f"vocab={cov:5.1f}%  dur={it['duration']:6.2f}s  {it['item'][:52]}")


if __name__ == "__main__":
    main()
