# -*- coding: utf-8 -*-
"""Fold a split ONNX model (.onnx + .onnx.data) into one self-contained file.

The app's download manifest (src/modelManager.js) lists `diff_step_dml.onnx`
and `vocoder_dml.onnx` as single files; a split-format upload would leave the
app with a 2 MB graph and no weights.

Naming is preserved (same basename) because the ONNX proto stores the
external-data location as a bare file name.

Usage:
  python tools/embed_external_data.py \
      --input  int8_w8a8_output/diffstep_wo/diff_step_dml.onnx \
      --output .workbuddy/tmp_ms_int8_v2/diff_step_dml.onnx
"""
import argparse
import os
import sys

import onnx


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    args = ap.parse_args()

    src = os.path.abspath(args.input)
    dst = os.path.abspath(args.output)
    if not os.path.exists(src):
        print(f"ERROR: {src} not found", file=sys.stderr)
        return 1

    data = src + ".data"
    src_mb = os.path.getsize(src) / 1e6
    data_mb = os.path.getsize(data) / 1e6 if os.path.exists(data) else 0.0
    print(f"[embed] src {os.path.basename(src)}: {src_mb:.1f} MB"
          + (f" + .data {data_mb:.1f} MB" if data_mb else " (already self-contained)"))

    model = onnx.load(src, load_external_data=True)
    # Drop any lingering external-data references so the file is standalone.
    graphs = _all_graphs(model)
    for g in graphs:
        for tensor in g.initializer:
            if tensor.data_location == onnx.TensorProto.EXTERNAL:
                tensor.data_location = onnx.TensorProto.DEFAULT

    os.makedirs(os.path.dirname(dst), exist_ok=True)
    onnx.save(model, dst, save_as_external_data=False)
    out_mb = os.path.getsize(dst) / 1e6
    print(f"[embed] dst {os.path.basename(dst)}: {out_mb:.1f} MB (single file)")

    # Sanity: reload and check every initializer has inline raw data.
    chk = onnx.load(dst, load_external_data=False)
    external = [t.name for t in chk.graph.initializer
                if t.data_location == onnx.TensorProto.EXTERNAL]
    if external:
        print(f"ERROR: {len(external)} initializer(s) still external, e.g. {external[:3]}",
              file=sys.stderr)
        return 2
    print(f"[embed] verified: {len(chk.graph.initializer)} initializers inline, "
          f"ir_version={chk.ir_version}, opset={chk.opset_import[0].version}")
    return 0


def _all_graphs(model):
    """The main graph plus every subgraph held in a node attribute (If/Loop)."""
    out, stack = [], [model.graph]
    while stack:
        g = stack.pop()
        out.append(g)
        for node in g.node:
            for attr in node.attribute:
                if attr.type == onnx.AttributeProto.GRAPH:
                    stack.append(attr.g)
                elif attr.type == onnx.AttributeProto.GRAPHS:
                    stack.extend(attr.graphs)
    return out


if __name__ == "__main__":
    raise SystemExit(main())
