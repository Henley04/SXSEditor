#!/usr/bin/env python
"""Merge the individual validation runs into one report source.

Each sweep writes its own `val_*.json`; the Markdown report wants a single
document with every candidate side by side, plus the end-to-end audio results.
This script collects them (skipping any that are missing or failed) and writes
`int8_w8a8_output/validation_gtsinger.json`.

Usage:
  python scripts/olive_int8_w8a8/collect_results.py
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "int8_w8a8_output"

# (source file, label override, model dir for the facts table)
SOURCES = [
    ("val_diffstep_i8.json", "diff_step W8A8 · int8 activations · MinMax"),
    ("val_diffstep_u8.json", "diff_step W8A8 · uint8 activations · MinMax"),
    ("val_diffstep_u8rr.json", "diff_step W8A8 · uint8 act · reduce_range"),
    ("val_diffstep_u8head.json", "diff_step W8A8 · uint8 act · mel-head FP32"),
    ("val_diffstep_wo_dml.json", "diff_step W8A32 · int8 weights · fp32 activations"),
    ("val_vocoder_wo_dml.json", "vocoder W8A32 · all backbone MatMul int8"),
    ("val_vocoder_wo_tail24b.json", "vocoder W8A32 · convnext 24-29 kept FP32"),
]

E2E = [
    ("compare_int8.json", "full INT8 (diff_step W8A8 uint8 + vocoder W8A32)", "e2e/int8"),
    ("int8_diff/compare.json", "diff_step W8A8 uint8 only (FP32 vocoder)", "e2e/int8_diff"),
    ("int8_voc/compare.json", "vocoder W8A32 only (FP32 diff_step)", "e2e/int8_voc"),
    ("compare_int8_wo.json", "full W8A32 (diff_step + vocoder)", "e2e/int8_wo"),
]


def load(path: Path):
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


def main() -> int:
    runs, facts = [], {}
    for fname, label in SOURCES:
        doc = load(OUT / fname)
        if not doc:
            print(f"[collect] skip {fname} (missing)")
            continue
        facts.update(doc.get("facts", {}))
        ok = 0
        for r in doc.get("runs", []):
            if "error" in r:
                print(f"[collect] {fname}: run error {r['error'][:60]}")
                continue
            r = dict(r)
            r["model"] = label
            r["source"] = fname
            runs.append(r)
            ok += 1
        print(f"[collect] {fname}: {ok} run(s)")

    e2e = []
    for fname, label, out_dir in E2E:
        doc = load(OUT / "e2e" / fname)
        if not doc or not doc.get("aggregate"):
            print(f"[collect] skip e2e/{fname}")
            continue
        e2e.append({"model": label, "dir": out_dir, **doc["aggregate"],
                    "items": doc.get("items", [])})
        print(f"[collect] e2e/{fname}: cos={doc['aggregate'].get('cosine_mean')}")

    ref_summary = load(OUT / "e2e" / "fp32" / "summary.json") or {}
    doc = {
        "val_items": [3, 7, 11],
        "facts": facts,
        "runs": runs,
        "e2e": {
            "ref": "e2e/fp32",
            "seed": ref_summary.get("seed"),
            "items": [i.get("index") for i in ref_summary.get("items", [])],
            "results": e2e,
        },
    }
    out = OUT / "validation_gtsinger.json"
    out.write_text(json.dumps(doc, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"[collect] {len(runs)} runs, {len(e2e)} e2e results -> {out.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
