"""
把 conds_long/*.pt（官方管线预构建的条件张量）导出成 Node 校准脚本可直接读取的裸二进制。

输出（qdrift/conds_bin/）:
  <item>_prompt.bin  : Float32 (1, pl, 128)   prompt mel
  <item>_cond.bin    : Float32 (1, pl+tl, 1024) 已过 cond_emb 投影的条件
  <item>.json        : { item, index, language, prompt_len, target_len, seconds }
"""
import os, json, argparse
import numpy as np
import torch

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", default=os.path.join(ROOT, "qdrift/conds_long"))
    ap.add_argument("--out", default=os.path.join(ROOT, "qdrift/conds_bin"))
    ap.add_argument("--tags", default="nat")
    args = ap.parse_args()
    os.makedirs(args.out, exist_ok=True)

    pts = sorted(f for f in os.listdir(args.src)
                 if f.endswith(".pt") and any(f.startswith(t) for t in args.tags.split(",")))
    manifest = []
    for f in pts:
        d = torch.load(os.path.join(args.src, f), weights_only=False)
        stem = os.path.splitext(f)[0]
        prompt = d["prompt"].float().numpy().astype(np.float32)
        cond = d["cond"].float().numpy().astype(np.float32)
        prompt.tofile(os.path.join(args.out, f"{stem}_prompt.bin"))
        cond.tofile(os.path.join(args.out, f"{stem}_cond.bin"))
        meta = {
            "item": stem,
            "index": d.get("index", stem),
            "language": d.get("language", ""),
            "prompt_len": int(d["prompt_len"]),
            "target_len": int(d["target_len"]),
            "seconds": round(int(d["target_len"]) * 0.02, 3),
            "prompt_shape": list(prompt.shape),
            "cond_shape": list(cond.shape),
            "concat": int(d.get("concat", 1)),
        }
        json.dump(meta, open(os.path.join(args.out, f"{stem}.json"), "w", encoding="utf-8"),
                  ensure_ascii=False, indent=2)
        manifest.append(meta)
        print(f"  {stem}: pl={meta['prompt_len']} tl={meta['target_len']} "
              f"({meta['seconds']}s) cond={tuple(cond.shape)}", flush=True)

    json.dump(manifest, open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=2)
    print(f"[done] {len(manifest)} items -> {args.out}")


if __name__ == "__main__":
    main()
