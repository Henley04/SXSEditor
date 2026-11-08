"""INT8 模型探测：用 ORT 读取真实签名 → 造输入 → CPU/DML 实跑

用法：
  python scripts/_probe_int8_models.py [模型目录]
默认目录 onnx_models/int8
"""
import json
import os
import sys
import numpy as np
import onnx
import onnxruntime as ort

BASE = sys.argv[1] if len(sys.argv) > 1 else "onnx_models/int8"

MODELS = [
    "note_text_encoder.onnx",
    "note_pitch_encoder.onnx",
    "note_type_encoder.onnx",
    "f0_encoder.onnx",
    "cond_emb.onnx",
    "mel_transform.onnx",
    "preflow.onnx",
    "diff_step_dml.onnx",
    "vocoder_dml.onnx",
]

NP = {
    "tensor(float)": np.float32,
    "tensor(float16)": np.float16,
    "tensor(double)": np.float64,
    "tensor(int64)": np.int64,
    "tensor(int32)": np.int32,
    "tensor(int8)": np.int8,
    "tensor(uint8)": np.uint8,
    "tensor(bool)": np.bool_,
}


def session(path, provider, opt_level=ort.GraphOptimizationLevel.ORT_ENABLE_ALL):
    so = ort.SessionOptions()
    so.graph_optimization_level = opt_level
    so.log_severity_level = 3
    return ort.InferenceSession(path, so, providers=[provider])


def build_feed(sess, seq=64):
    feed = {}
    for i in sess.get_inputs():
        dims = []
        for idx, d in enumerate(i.shape):
            if isinstance(d, int) and d > 0:
                dims.append(d)
            else:
                # 符号维：按名字猜
                if "wave" in i.name:
                    dims.append(240000)
                elif idx == 0:
                    dims.append(1)
                else:
                    dims.append(seq)
        dt = NP[i.type]
        if dt in (np.float32, np.float16):
            arr = (np.random.randn(*dims) * 0.5).astype(dt)
        elif dt is np.bool_:
            arr = np.ones(dims, dtype=np.bool_)
        elif dt in (np.int64, np.int32):
            arr = np.random.randint(0, 400, size=dims).astype(dt)
        else:
            arr = np.ones(dims, dtype=dt)
        feed[i.name] = arr
    return feed


def inspect_onnx(path):
    m = onnx.load(path, load_external_data=False)
    qdq = sum(1 for n in m.graph.node if n.op_type in
              ("QuantizeLinear", "DequantizeLinear", "DynamicQuantizeLinear"))
    locs, missing = set(), []
    for t in m.graph.initializer:
        if t.data_location == onnx.TensorProto.EXTERNAL:
            for kv in t.external_data:
                if kv.key == "location":
                    p = os.path.join(os.path.dirname(path), kv.value)
                    locs.add(p)
                    if not os.path.exists(p):
                        missing.append(kv.value)
    ext = sum(os.path.getsize(p) for p in locs if os.path.exists(p))
    return {
        "ir_version": m.ir_version,
        "qdq_nodes": qdq,
        "external_files": [os.path.basename(p) for p in locs],
        "external_mb": round(ext / 1e6, 1),
        "external_missing": sorted(set(missing))[:5],
    }


def main():
    print("== ORT", ort.__version__, "providers:", ort.get_available_providers())
    report = []
    for f in MODELS:
        path = os.path.join(BASE, f)
        if not os.path.exists(path):
            print(f"\n!! 缺失 {path}")
            report.append({"file": f, "missing": True})
            continue
        entry = {"file": f, "size_mb": round(os.path.getsize(path) / 1e6, 2)}
        try:
            entry.update(inspect_onnx(path))
        except Exception as e:
            entry["parse_error"] = str(e)

        print(f"\n=== {f}  onnx={entry['size_mb']}MB ext={entry.get('external_mb')}MB "
              f"ir={entry.get('ir_version')} qdq={entry.get('qdq_nodes')} ===")
        if entry.get("external_missing"):
            print("  !! 外部数据缺失:", entry["external_missing"])

        try:
            s = session(path, "CPUExecutionProvider")
            entry["inputs"] = [{"name": i.name, "type": i.type, "shape": i.shape} for i in s.get_inputs()]
            entry["outputs"] = [{"name": o.name, "type": o.type, "shape": o.shape} for o in s.get_outputs()]
            for i in s.get_inputs():
                print(f"  IN  {i.name:20s} {i.type:16s} {i.shape}")
            for o in s.get_outputs():
                print(f"  OUT {o.name:20s} {o.type:16s} {o.shape}")
            s.release() if hasattr(s, "release") else None
            del s
        except Exception as e:
            msg = str(e).split("\n")[0][:250]
            print("  !! 会话创建失败:", msg)
            entry["load_error"] = msg
            report.append(entry)
            continue

        for prov in ("CPUExecutionProvider", "DmlExecutionProvider"):
            if prov not in ort.get_available_providers():
                continue
            try:
                s = session(path, prov)
                feed = build_feed(s)
                outs = s.run(None, feed)
                stats = []
                for a in outs:
                    a = np.asarray(a)
                    stats.append({
                        "shape": list(a.shape),
                        "nan": int(np.isnan(a).sum()) if a.dtype.kind == "f" else 0,
                        "inf": int(np.isinf(a).sum()) if a.dtype.kind == "f" else 0,
                        "absmax": round(float(np.nanmax(np.abs(a))), 4) if a.size else 0.0,
                        "absmean": round(float(np.nanmean(np.abs(a))), 6) if a.size else 0.0,
                    })
                print(f"  [{prov:22s}] OK  {json.dumps(stats)}")
                entry.setdefault("run", {})[prov] = {"ok": True, "out": stats}
            except Exception as e:
                msg = str(e).split("\n")[0][:250]
                print(f"  [{prov:22s}] FAIL {msg}")
                entry.setdefault("run", {})[prov] = {"ok": False, "error": msg}
        report.append(entry)

    out = os.path.join(BASE, "_probe_result.json")
    with open(out, "w", encoding="utf-8") as fp:
        json.dump(report, fp, ensure_ascii=False, indent=2, default=str)
    print("\n结果写入", out)


if __name__ == "__main__":
    main()
