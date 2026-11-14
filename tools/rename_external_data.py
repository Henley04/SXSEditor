# -*- coding: utf-8 -*-
"""把 ONNX 图的 external data 引用改到新文件名（配合重命名 .data 使用）。

部署 W16A32 vocoder 时，导出工具给的是 `vocoder_w16a32.onnx(.data)`，应用侧
按 `<file>.onnx.data` 找伴生文件，所以需要成对改名成 `vocoder_dml.onnx(.data)`。
只改 graph（93 KB）里的 location 字符串，不动权重数据。

用法:
    python tools/rename_external_data.py onnx_models/fp16/vocoder_dml.onnx vocoder_dml.onnx.data
"""
from __future__ import annotations

import argparse
import os

import onnx


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('model')
    ap.add_argument('location', help='新的 external data 文件名（basename）')
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()

    model = onnx.load(args.model, load_external_data=False)
    changed = 0
    old = set()
    for tensor in model.graph.initializer:
        for entry in tensor.external_data:
            if entry.key == 'location':
                if entry.value != args.location:
                    old.add(entry.value)
                    entry.value = args.location
                    changed += 1
    print(f'{changed} tensor(s) repointed; old locations: {sorted(old) or "-"}')
    if args.dry_run or changed == 0:
        return 0

    data_path = os.path.join(os.path.dirname(os.path.abspath(args.model)), args.location)
    if not os.path.exists(data_path):
        print(f'WARNING: {data_path} does not exist yet')
    onnx.save_model(model, args.model)
    print(f'saved {args.model} ({os.path.getsize(args.model)} bytes)')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
