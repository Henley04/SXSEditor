# -*- coding: utf-8 -*-
"""Build ARPAbet phoneme duration statistics from MFA-aligned LJSpeech.

数据驱动的英文音素时长统计脚本（trigram + position + stress）。

数据源:
  - LJSpeech TextGrid 对齐文件（MFA 输出，phoneme-level）
    下载: https://drive.google.com/drive/folders/1DBRkALpPd6FL9gjHMmMEdHODmkgNIIK4
    解压到: preprocessed_data/LJSpeech/TextGrid/
  - LJSpeech metadata.csv（仅需 transcript，不需要 wav）
    下载: https://keithito.com/LJ-Speech-Dataset/
    放到: raw_data/LJSpeech/metadata.csv
  - librispeech-lexicon.txt（CMU 词典，带重音 0/1/2）
    下载: https://github.com/ming024/FastSpeech2/raw/master/lexicon/librispeech-lexicon.txt
    放到: lexicon/librispeech-lexicon.txt

输出:
  src/inference/en_phoneme_durations.json
  结构:
    {
      "version": 1,
      "source": "LJSpeech + MFA alignment (ming024/FastSpeech2)",
      "total_samples": N,
      "unigram": { "AE1": {"count":N, "mean_ms":M, "std_ms":S, "median_ms":Md}, ... },
      "bigram":  { "T|AE1": {...}, ... },
      "trigram": { "T|AE1|T": {...}, ... },                # 跨词连续 trigram
      "by_stress":     { "0": {"AE": {...}}, "1": {...}, "2": {...} },
      "by_position":   { "initial": {...}, "medial": {...}, "final": {...} },
      "trigram_full":  { "T|AE1|T|medial|1": {...}, ... }  # 完整 trigram + 位置 + 重音
    }

用法:
  python build_en_phoneme_duration_stats.py
  python build_en_phoneme_duration_stats.py --min-samples 10

依赖（可选，推荐）:
  pip install praatio -i https://pypi.tuna.tsinghua.edu.cn/simple
  若未安装 praatio，会自动退回到内置 TextGrid 正则解析器。

参考:
  - ming024/FastSpeech2: https://github.com/ming024/FastSpeech2
  - MFA 文档: https://montreal-forced-aligner.readthedocs.io/
"""

import os
import sys
import re
import json
import argparse
import statistics
from pathlib import Path
from collections import defaultdict


# ============================================================
# 路径默认值
# ============================================================
SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_TEXTGRID_DIR = SCRIPT_DIR / "preprocessed_data" / "LJSpeech" / "TextGrid"
DEFAULT_METADATA = SCRIPT_DIR / "raw_data" / "LJSpeech" / "metadata.csv"
DEFAULT_LEXICON = SCRIPT_DIR / "lexicon" / "librispeech-lexicon.txt"
DEFAULT_OUTPUT = SCRIPT_DIR / "src" / "inference" / "en_phoneme_durations.json"


# ============================================================
# ARPAbet 元音定义
# ============================================================
# ARPAbet 15 个元音基名（不带重音后缀）
VOWEL_BASES = {
    'AA', 'AE', 'AH', 'AO', 'AW', 'AY',
    'EH', 'ER', 'EY',
    'IH', 'IY',
    'OW', 'OY',
    'UH', 'UW',
}

# MFA 输出中常见的非音素 token（静音/停顿/未知）
NON_PHONEME_TOKENS = {'sil', 'sp', 'spn', 'spn', '', ' pau ', 'pau'}


def is_vowel(phoneme):
    """判断 ARPAbet 音素是否为元音（去重音后缀 0/1/2）。"""
    base = re.sub(r'[012]$', '', phoneme)
    return base in VOWEL_BASES


def get_stress(phoneme):
    """提取重音等级 0/1/2，非元音返回 None。无重音标记的元音返回 0。"""
    if not is_vowel(phoneme):
        return None
    if phoneme[-1] in '012':
        return int(phoneme[-1])
    return 0


def is_real_phoneme(token):
    """判断 TextGrid 中的 token 是否为真实 ARPAbet 音素（排除静音/停顿）。"""
    token = token.strip().upper()
    if not token or token.lower() in NON_PHONEME_TOKENS:
        return False
    # ARPAbet 音素都是大写字母
    return bool(re.match(r'^[A-Z]+[012]?$', token))


# ============================================================
# 1. TextGrid 解析
# ============================================================
# 优先使用 praatio（pip install praatio），失败回退到内置正则解析器。

_PRAATIO_OK = False
try:
    from praatio.textgrid import TextGrid
    _PRAATIO_OK = True
except ImportError:
    pass


def parse_textgrid_praatio(path):
    """用 praatio 解析 TextGrid。返回 (phones, words):
    phones: [(start, end, label), ...]
    words:  [(start, end, label), ...]  (可能为空)
    """
    tg = TextGrid.open(path)
    phones = []
    words = []
    for tier in tg.tiers:
        name = tier.name.lower()
        if name in ('phones', 'phonemes', 'phone'):
            for interval in tier.entries:
                start, end, label = interval.start, interval.end, interval.label
                phones.append((float(start), float(end), label))
        elif name in ('words', 'word'):
            for interval in tier.entries:
                start, end, label = interval.start, interval.end, interval.label
                words.append((float(start), float(end), label))
    return phones, words


# 内置正则解析器（处理 long & short 两种 Praat 格式）
_TIER_LONG = re.compile(
    r'class\s*=\s*"IntervalTier"\s*\n\s*name\s*=\s*"([^"]+)"\s*\n'
    r'\s*xmin\s*=\s*([\d.eE+-]+)\s*\n\s*xmax\s*=\s*([\d.eE+-]+)\s*\n'
    r'\s*intervals:\s*size\s*=\s*(\d+)\s*\n(.*?)(?=\s*item\s*\[|\Z)',
    re.DOTALL,
)
_TIER_SHORT = re.compile(
    r'"IntervalTier"\s+"([^"]+)"\s+([\d.eE+-]+)\s+([\d.eE+-]+)\s+(\d+)\s*\n'
    r'(.*?)(?="IntervalTier"|"TextTier"|\Z)',
    re.DOTALL,
)
_INTERVAL_LONG = re.compile(
    r'intervals\s*\[(\d+)\]\s*:\s*\n\s*xmin\s*=\s*([\d.eE+-]+)\s*\n'
    r'\s*xmax\s*=\s*([\d.eE+-]+)\s*\n\s*text\s*=\s*"(.*?)"',
    re.DOTALL,
)
# Short format interval: "<start> <end> \"<text>\"" (无 index)
# 用空捕获组占位让 group 索引与 _INTERVAL_LONG 一致（group2=start, group3=end, group4=text）
_INTERVAL_SHORT = re.compile(
    r'()([\d.eE+-]+)\s+([\d.eE+-]+)\s+"(.*?)"',
    re.DOTALL,
)


def parse_textgrid_builtin(path):
    """内置简化 TextGrid 解析器。返回 (phones, words)。"""
    with open(path, 'r', encoding='utf-8') as f:
        content = f.read()

    phones = []
    words = []
    target_phones = {'phones', 'phonemes', 'phone'}
    target_words = {'words', 'word'}

    for tier_pat in [_TIER_LONG, _TIER_SHORT]:
        for m in tier_pat.finditer(content):
            tier_name = m.group(1).lower()
            intervals_text = m.group(5)
            collected = []
            for int_pat in [_INTERVAL_LONG, _INTERVAL_SHORT]:
                for im in int_pat.finditer(intervals_text):
                    start = float(im.group(2))
                    end = float(im.group(3))
                    label = im.group(4).strip()
                    collected.append((start, end, label))
                if collected:
                    break
            if tier_name in target_phones:
                phones.extend(collected)
            elif tier_name in target_words:
                words.extend(collected)
        if phones or words:
            break

    return phones, words


def parse_textgrid(path):
    """统一入口。返回 (phones, words)。"""
    if _PRAATIO_OK:
        try:
            return parse_textgrid_praatio(path)
        except Exception as e:
            print(f"  [WARN] praatio parse failed for {path.name}: {e}, falling back to builtin")
    return parse_textgrid_builtin(path)


# ============================================================
# 2. 词典 / metadata 加载
# ============================================================
def load_lexicon(path):
    """加载 CMU 词典（librispeech-lexicon.txt 格式）。

    每行: WORD  PHONEME1 PHONEME2 ...
    一个词有多个发音时取第一个；忽略变体标记 (2) 等。
    返回: {word_lower: [phoneme, ...]}
    """
    lexicon = {}
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith(';'):
                continue
            parts = line.split(None, 1)
            if len(parts) < 2:
                continue
            word = parts[0].lower()
            # 去掉变体标记，如 "the(2)" -> "the"
            word = re.sub(r'\(\d+\)$', '', word)
            phones = parts[1].split()
            if word not in lexicon:
                lexicon[word] = phones
    return lexicon


def load_metadata(path):
    """加载 LJSpeech metadata.csv。返回 {file_id: normalized_text}。

    格式: id|original_text|normalized_text
    """
    metadata = {}
    with open(path, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.rstrip('\n')
            if not line:
                continue
            parts = line.split('|')
            if len(parts) >= 3:
                metadata[parts[0]] = parts[2]
            elif len(parts) >= 2:
                metadata[parts[0]] = parts[1]
    return metadata


# ============================================================
# 3. 音素位置标注
# ============================================================
def annotate_positions(phones, words):
    """根据 words tier 给每个 phone 标注词内位置 initial/medial/final。

    phones: [(start, end, label), ...]  过滤掉非音素后
    words:  [(start, end, label), ...]  可能空

    策略：按音素中点归属词，再按词内音素索引判断 initial/medial/final。
    比 5ms 时间戳容差更稳健（MFA 输出中音素边界与词边界可能不完全对齐）。

    返回: [(start, end, label, position), ...]
    若没有 words tier，全部标为 medial。
    """
    if not words:
        return [(s, e, l, 'medial') for s, e, l in phones]

    sorted_words = sorted(words, key=lambda x: x[0])

    # 为每个词收集归属音素（按音素中点）
    word_to_phone_idxs = defaultdict(list)
    phone_to_word_idx = {}

    for phone_idx, (s, e, _label) in enumerate(phones):
        mid = (s + e) / 2
        for word_idx, (ws, we, _wlabel) in enumerate(sorted_words):
            if ws <= mid < we:
                word_to_phone_idxs[word_idx].append(phone_idx)
                phone_to_word_idx[phone_idx] = word_idx
                break
        else:
            # 不在任何词区间内（如跨静音段的孤立音素）
            phone_to_word_idx[phone_idx] = None

    result = []
    for phone_idx, (s, e, label) in enumerate(phones):
        wid = phone_to_word_idx[phone_idx]
        if wid is None:
            position = 'medial'
        else:
            phones_in_word = word_to_phone_idxs[wid]
            if len(phones_in_word) <= 1:
                position = 'medial'  # 单音素词，既首既末，标为 medial
            elif phone_idx == phones_in_word[0]:
                position = 'initial'
            elif phone_idx == phones_in_word[-1]:
                position = 'final'
            else:
                position = 'medial'
        result.append((s, e, label, position))
    return result


# ============================================================
# 4. 样本收集
# ============================================================
def collect_samples(textgrid_dir, metadata, lexicon):
    """遍历所有 TextGrid，返回样本列表。"""
    samples = []
    tg_files = sorted(Path(textgrid_dir).glob('*.TextGrid'))
    if not tg_files:
        tg_files = sorted(Path(textgrid_dir).glob('*.textgrid'))

    print(f"[INFO] Found {len(tg_files)} TextGrid files in {textgrid_dir}")

    skipped = 0
    for i, tg_path in enumerate(tg_files):
        file_id = tg_path.stem
        if file_id not in metadata:
            skipped += 1
            continue

        phones_raw, words = parse_textgrid(tg_path)
        if not phones_raw:
            skipped += 1
            continue

        # 过滤非音素 token
        phones_filtered = [(s, e, l) for s, e, l in phones_raw if is_real_phoneme(l)]
        if not phones_filtered:
            skipped += 1
            continue

        # 标注位置
        phones_annotated = annotate_positions(phones_filtered, words)

        # 构造样本
        n = len(phones_annotated)
        for idx, (start, end, phone, position) in enumerate(phones_annotated):
            duration = end - start
            if duration <= 0 or duration > 2.0:  # 过滤异常时长
                continue

            phone_norm = phone.strip().upper()
            stress = get_stress(phone_norm)

            prev_phone = phones_annotated[idx - 1][2].strip().upper() if idx > 0 else '<S>'
            next_phone = phones_annotated[idx + 1][2].strip().upper() if idx < n - 1 else '<E>'

            samples.append({
                'phone': phone_norm,
                'duration_s': duration,
                'stress': stress,
                'position': position,
                'prev': prev_phone,
                'next': next_phone,
                'file_id': file_id,
            })

        if (i + 1) % 1000 == 0:
            print(f"  Processed {i + 1}/{len(tg_files)} files, samples so far: {len(samples)}")

    print(f"[INFO] Total samples: {len(samples)}, skipped files: {skipped}")
    return samples


# ============================================================
# 5. 统计聚合
# ============================================================
def _agg(durations_sec):
    """对一个时长样本列表（秒）聚合统计。"""
    if not durations_sec:
        return None
    durations_ms = [d * 1000.0 for d in durations_sec]
    return {
        'count': len(durations_ms),
        'mean_ms': round(statistics.mean(durations_ms), 2),
        'std_ms': round(statistics.stdev(durations_ms), 2) if len(durations_ms) > 1 else 0.0,
        'median_ms': round(statistics.median(durations_ms), 2),
    }


def compute_statistics(samples, min_samples):
    """按 unigram/bigram/trigram/by_stress/by_position/trigram_full 聚合。"""
    unigram = defaultdict(list)
    bigram = defaultdict(list)
    trigram = defaultdict(list)
    by_stress = defaultdict(lambda: defaultdict(list))
    by_position = defaultdict(lambda: defaultdict(list))
    trigram_full = defaultdict(list)

    for s in samples:
        phone = s['phone']
        dur = s['duration_s']
        prev = s['prev']
        nxt = s['next']
        stress = s['stress']
        pos = s['position']

        unigram[phone].append(dur)
        bigram[f"{prev}|{phone}"].append(dur)
        trigram[f"{prev}|{phone}|{nxt}"].append(dur)

        if stress is not None:
            by_stress[str(stress)][phone].append(dur)
        by_position[pos][phone].append(dur)

        stress_str = str(stress) if stress is not None else 'X'
        full_key = f"{prev}|{phone}|{nxt}|{pos}|{stress_str}"
        trigram_full[full_key].append(dur)

    def filter_low(d):
        return {k: v for k, v in d.items() if v and v.get('count', 0) >= min_samples}

    unigram_f = filter_low({k: _agg(v) for k, v in unigram.items()})
    bigram_f = filter_low({k: _agg(v) for k, v in bigram.items()})
    trigram_f = filter_low({k: _agg(v) for k, v in trigram.items()})
    trigram_full_f = filter_low({k: _agg(v) for k, v in trigram_full.items()})
    by_stress_f = {sk: filter_low({k: _agg(v) for k, v in d.items()}) for sk, d in by_stress.items()}
    by_position_f = {pk: filter_low({k: _agg(v) for k, v in d.items()}) for pk, d in by_position.items()}

    return {
        'unigram': unigram_f,
        'bigram': bigram_f,
        'trigram': trigram_f,
        'by_stress': by_stress_f,
        'by_position': by_position_f,
        'trigram_full': trigram_full_f,
    }


# ============================================================
# 6. 主入口
# ============================================================
def print_data_source_help():
    print("=" * 60)
    print("数据源准备说明")
    print("=" * 60)
    print()
    print("1. 下载 LJSpeech TextGrid 对齐文件 (~50MB)：")
    print("   https://drive.google.com/drive/folders/1DBRkALpPd6FL9gjHMmMEdHODmkgNIIK4")
    print("   解压到: preprocessed_data/LJSpeech/TextGrid/")
    print()
    print("   国内镜像备选（非官方）：尝试 ghproxy 加速或自行搜索 LJSpeech MFA TextGrid")
    print()
    print("2. 下载 LJSpeech metadata.csv（不需要 wav 音频）：")
    print("   https://keithito.com/LJ-Speech-Dataset/")
    print("   放到: raw_data/LJSpeech/metadata.csv")
    print()
    print("3. 下载 librispeech-lexicon.txt：")
    print("   https://github.com/ming024/FastSpeech2/raw/master/lexicon/librispeech-lexicon.txt")
    print("   放到: lexicon/librispeech-lexicon.txt")
    print()
    print("4. (可选) 安装 praatio 提升解析稳健性：")
    print("   pip install praatio -i https://pypi.tuna.tsinghua.edu.cn/simple")
    print()


def main():
    parser = argparse.ArgumentParser(
        description='Build ARPAbet phoneme duration statistics from MFA-aligned LJSpeech.'
    )
    parser.add_argument('--textgrid-dir', default=str(DEFAULT_TEXTGRID_DIR),
                        help=f'Path to LJSpeech TextGrid directory (default: {DEFAULT_TEXTGRID_DIR})')
    parser.add_argument('--metadata', default=str(DEFAULT_METADATA),
                        help=f'Path to LJSpeech metadata.csv (default: {DEFAULT_METADATA})')
    parser.add_argument('--lexicon', default=str(DEFAULT_LEXICON),
                        help=f'Path to librispeech-lexicon.txt (default: {DEFAULT_LEXICON})')
    parser.add_argument('--output', default=str(DEFAULT_OUTPUT),
                        help=f'Output JSON path (default: {DEFAULT_OUTPUT})')
    parser.add_argument('--min-samples', type=int, default=5,
                        help='Minimum samples per key (default: 5, low-freq keys dropped)')
    args = parser.parse_args()

    print(f"[INFO] Parser backend: {'praatio' if _PRAATIO_OK else 'builtin-regex'}")
    print()

    # 检查路径
    missing = []
    for label, path in [('TextGrid', args.textgrid_dir),
                        ('metadata', args.metadata),
                        ('lexicon', args.lexicon)]:
        if not os.path.exists(path):
            missing.append((label, path))

    if missing:
        for label, path in missing:
            print(f"[ERROR] {label} not found: {path}")
        print()
        print_data_source_help()
        sys.exit(1)

    print(f"[INFO] Loading lexicon from {args.lexicon}")
    lexicon = load_lexicon(args.lexicon)
    print(f"[INFO] Lexicon entries: {len(lexicon)}")

    print(f"[INFO] Loading metadata from {args.metadata}")
    metadata = load_metadata(args.metadata)
    print(f"[INFO] Metadata entries: {len(metadata)}")

    print(f"[INFO] Collecting samples from {args.textgrid_dir}")
    samples = collect_samples(args.textgrid_dir, metadata, lexicon)
    if not samples:
        print("[ERROR] No samples collected. Check TextGrid files and parsing.")
        sys.exit(1)

    print(f"[INFO] Computing statistics (min_samples={args.min_samples})")
    stats = compute_statistics(samples, args.min_samples)

    output_data = {
        'version': 1,
        'description': 'ARPAbet phoneme duration statistics from MFA-aligned LJSpeech',
        'source': 'LJSpeech + MFA alignment (ming024/FastSpeech2)',
        'parser_backend': 'praatio' if _PRAATIO_OK else 'builtin-regex',
        'total_samples': len(samples),
        'min_samples_per_key': args.min_samples,
        'phoneme_count': len(stats['unigram']),
        'trigram_keys': len(stats['trigram']),
        'trigram_full_keys': len(stats['trigram_full']),
        **stats,
    }

    os.makedirs(os.path.dirname(args.output), exist_ok=True)
    with open(args.output, 'w', encoding='utf-8') as f:
        json.dump(output_data, f, ensure_ascii=False, indent=2)

    print()
    print(f"[OK] Output: {args.output}")
    print(f"     total samples:  {len(samples)}")
    print(f"     phonemes:       {len(stats['unigram'])}")
    print(f"     bigram keys:    {len(stats['bigram'])}")
    print(f"     trigram keys:   {len(stats['trigram'])}")
    print(f"     trigram_full:   {len(stats['trigram_full'])}")
    print()

    # Top 10 unigram 概览
    print("Top 15 phonemes by sample count:")
    sorted_uni = sorted(stats['unigram'].items(), key=lambda x: -x[1]['count'])
    print(f"  {'phone':<6} {'count':>8} {'mean_ms':>10} {'std_ms':>8} {'median_ms':>10}")
    for phone, s in sorted_uni[:15]:
        print(f"  {phone:<6} {s['count']:>8} {s['mean_ms']:>10.1f} {s['std_ms']:>8.1f} {s['median_ms']:>10.1f}")

    # 元音 vs 辅音时长对比
    print()
    print("Vowel vs consonant (mean ms):")
    vowel_means = [s['mean_ms'] for p, s in stats['unigram'].items() if is_vowel(p)]
    cons_means = [s['mean_ms'] for p, s in stats['unigram'].items() if not is_vowel(p)]
    if vowel_means:
        print(f"  vowels:      avg={statistics.mean(vowel_means):.1f}ms (n_phonemes={len(vowel_means)})")
    if cons_means:
        print(f"  consonants:  avg={statistics.mean(cons_means):.1f}ms (n_phonemes={len(cons_means)})")


if __name__ == '__main__':
    main()
