# -*- coding: utf-8 -*-
"""FP16 模型精度检查 + AIMET QuantAnalyzer 逐层敏感度分析。

两个阶段：
  --stage fp16    真实 ONNX FP16 精度：FP32(CPU) 作参考，分别对比
                  FP32(DML) / FP16(CPU, 仅存储降精度) / FP16(DML, 生产真实 FP16 计算)
  --stage aimet   AIMET QuantAnalyzer 对 FP32 图做 16-bit(可选 8-bit) 量化敏感度分析，
                  输出逐层 eval score（SQNR dB）

用法：
  python scripts/fp16_aimet_analysis.py --stage fp16
  python scripts/fp16_aimet_analysis.py --stage aimet --bits 16 --models preflow cond_emb
  python scripts/fp16_aimet_analysis.py --stage aimet --bits 16 --per-layer both

注意：AIMET 的 16-bit 是 int16 仿射量化，不是 IEEE FP16；它给的是“哪些层对低位宽
表示敏感”的排序，真实的 FP16 误差看 --stage fp16。
"""
import argparse
import json
import os
import shutil
import sys
import time

import numpy as np
import onnx
import onnxruntime as ort

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
FP32_DIR = os.path.join(PROJECT_DIR, "onnx_models")
FP16_DIR = os.path.join(FP32_DIR, "fp16")
CALIB_DIR = os.path.join(PROJECT_DIR, "calibrate", "data", "fp16_calib")
TMP_MODEL_DIR = os.path.join(os.environ.get("TEMP", "/tmp"), "aimet_fp16_models")
REPORT_JSON = os.path.join(SCRIPT_DIR, "fp16_aimet_report.json")

# ORT 的 NodeArg.type 是 'tensor(float)' 这种字符串
ORT_TYPES = {
    "tensor(float)": np.float32,
    "tensor(float16)": np.float16,
    "tensor(double)": np.float64,
    "tensor(int64)": np.int64,
    "tensor(int32)": np.int32,
    "tensor(int8)": np.int8,
    "tensor(uint8)": np.uint8,
    "tensor(bool)": np.bool_,
}

MODELS = {
    "note_text_encoder": {"fp32": "note_text_encoder.onnx", "fp16": "note_text_encoder.onnx"},
    "note_pitch_encoder": {"fp32": "note_pitch_encoder.onnx", "fp16": "note_pitch_encoder.onnx"},
    "note_type_encoder": {"fp32": "note_type_encoder.onnx", "fp16": "note_type_encoder.onnx"},
    "f0_encoder": {"fp32": "f0_encoder.onnx", "fp16": "f0_encoder.onnx"},
    "cond_emb": {"fp32": "cond_emb.onnx", "fp16": "cond_emb.onnx"},
    "preflow": {"fp32": "preflow.onnx", "fp16": "preflow.onnx"},
    "mel_transform": {"fp32": "mel_transform.onnx", "fp16": "mel_transform.onnx"},
    "vocoder": {"fp32": "vocoder_dml.onnx", "fp16": "vocoder_dml.onnx"},
    "diff_step": {"fp32": "diff_step_dml.onnx", "fp16": "diff_step_dml.onnx"},
}

# 大模型默认截断序列长度，避免 CPU 上单次前向过慢
SEQ_LIMIT = {"diff_step": 256, "vocoder": 200, "preflow": 512, "cond_emb": 512}


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# ---------------------------------------------------------------- data / io


SEQ_OVERRIDE = {}


def load_samples(name, limit=8):
    path = os.path.join(CALIB_DIR, f"{name}_dml.npz" if name in ("diff_step", "vocoder") else f"{name}.npz")
    if not os.path.exists(path):
        return []
    data = np.load(path)
    samples = []
    for i in range(limit):
        prefix = f"sample{i}_input_"
        if f"{prefix}" not in "".join(data.files):
            break
        feeds = {k[len(prefix):]: data[k] for k in data.files if k.startswith(prefix)}
        ref_key = f"sample{i}_output"
        ref = data[ref_key] if ref_key in data.files else None
        lim_override = SEQ_OVERRIDE.get(name)
        if lim_override:
            lim = lim_override
        elif name in SEQ_LIMIT:
            lim = SEQ_LIMIT[name]
        else:
            lim = None
        if lim:
            for k, v in list(feeds.items()):
                if v.ndim >= 2 and v.shape[1] > lim:
                    feeds[k] = v[:, :lim, ...] if v.ndim == 3 else v[:, :lim]
            if ref is not None and ref.ndim >= 2 and ref.shape[1] > lim:
                ref = ref[:, :lim, ...]
        samples.append((feeds, ref))
    return samples


def cast_feeds(session, feeds):
    """按 ONNX 图声明的输入 dtype 转换（fp16 模型要 fp16 输入）。"""
    out = {}
    for inp in session.get_inputs():
        key = inp.name if inp.name in feeds else None
        if key is None:
            # 单输入模型：npz 里键名可能与图输入名不同
            if len(feeds) == 1:
                key = next(iter(feeds))
            else:
                raise KeyError(f"missing feed for input {inp.name}, have {list(feeds)}")
        arr = feeds[key]
        dtype = ORT_TYPES.get(inp.type, np.float32)
        out[inp.name] = np.ascontiguousarray(arr.astype(dtype, copy=False))
    return out


def make_session(path, provider):
    so = ort.SessionOptions()
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    providers = [provider, "CPUExecutionProvider"] if provider != "CPUExecutionProvider" else ["CPUExecutionProvider"]
    return ort.InferenceSession(path, sess_options=so, providers=providers)


def metrics(ref, out):
    ref = np.asarray(ref, dtype=np.float64).reshape(-1)
    out = np.asarray(out, dtype=np.float64).reshape(-1)
    n = min(ref.size, out.size)
    ref, out = ref[:n], out[:n]
    err = ref - out
    sig = float(np.sum(ref ** 2))
    noise = float(np.sum(err ** 2))
    cos = float(np.dot(ref, out) / (np.linalg.norm(ref) * np.linalg.norm(out) + 1e-12))
    return {
        "sqnr_db": float(10 * np.log10((sig + 1e-20) / (noise + 1e-20))),
        "cosine": cos,
        "rel_l2": float(np.sqrt(noise / (sig + 1e-20))),
        "max_abs_err": float(np.max(np.abs(err))),
        "ref_rms": float(np.sqrt(sig / n)),
    }


# ---------------------------------------------------------------- stage: fp16


def stage_fp16(names, out_path):
    report = {}
    for name in names:
        cfg = MODELS[name]
        samples = load_samples(name)
        if not samples:
            log(f"{name}: 无校准数据，跳过")
            continue
        p32 = os.path.join(FP32_DIR, cfg["fp32"])
        p16 = os.path.join(FP16_DIR, cfg["fp16"])
        log(f"{name}: 建会话 fp32(CPU) / fp32(DML) / fp16(CPU) / fp16(DML)")
        s32 = make_session(p32, "CPUExecutionProvider")
        s32d = make_session(p32, "DmlExecutionProvider")
        s16 = make_session(p16, "CPUExecutionProvider")
        s16d = make_session(p16, "DmlExecutionProvider")

        rows = []
        for idx, (feeds, _ref) in enumerate(samples):
            f32 = cast_feeds(s32, feeds)
            ref = s32.run(None, f32)[0]
            entry = {"sample": idx}
            for tag, sess in (("fp32_dml", s32d), ("fp16_cpu", s16), ("fp16_dml", s16d)):
                t0 = time.time()
                out = sess.run(None, cast_feeds(sess, feeds))[0]
                m = metrics(ref, out)
                m["seconds"] = round(time.time() - t0, 3)
                entry[tag] = m
            rows.append(entry)
            log(
                f"  sample{idx}: fp16_cpu {entry['fp16_cpu']['sqnr_db']:.2f}dB / "
                f"fp16_dml {entry['fp16_dml']['sqnr_db']:.2f}dB / "
                f"fp32_dml {entry['fp32_dml']['sqnr_db']:.2f}dB"
            )

        agg = {}
        for tag in ("fp32_dml", "fp16_cpu", "fp16_dml"):
            agg[tag] = {
                "sqnr_db_mean": float(np.mean([r[tag]["sqnr_db"] for r in rows])),
                "sqnr_db_min": float(np.min([r[tag]["sqnr_db"] for r in rows])),
                "cosine_min": float(np.min([r[tag]["cosine"] for r in rows])),
                "rel_l2_mean": float(np.mean([r[tag]["rel_l2"] for r in rows])),
            }
        report[name] = {"aggregate": agg, "samples": rows}
        log(f"{name}: 平均 SQNR fp16_dml={agg['fp16_dml']['sqnr_db_mean']:.2f}dB, "
            f"fp16_cpu={agg['fp16_cpu']['sqnr_db_mean']:.2f}dB")

    merge_write(out_path, "fp16", report)


def merge_write(path, section, payload):
    data = {}
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception:
            data = {}
    data.setdefault("meta", {"generated": time.strftime("%Y-%m-%d %H:%M:%S"), "host": sys.platform})
    data.setdefault(section, {})
    if isinstance(payload, dict) and payload and all(isinstance(v, dict) for v in payload.values()):
        data[section].update(payload)
    else:
        data[section] = payload
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, ensure_ascii=False)
    log(f"写入 {path} [{section}]")


# -------------------------------------------------------------- stage: aimet


class _Forward:
    """AIMET 读取 .func/.args 并调用 func(session, *args)。"""

    def __init__(self, dataset):
        self.dataset = dataset
        self.func = self._run
        self.args = (dataset,)

    def __call__(self, session, dataset):
        return self._run(session, dataset)

    def _run(self, session, args):
        # AIMET 调用形式是 func(session, args_tuple)，这里解包出数据集
        dataset = args[0] if isinstance(args, tuple) else args
        for feeds, _ in dataset:
            session.run(None, cast_feeds(session, feeds))


def prepare_model_copy(path):
    """onnx 1.21 拒绝多硬链接的外部数据文件；复制到临时目录绕开。"""
    base = os.path.basename(path)
    os.makedirs(TMP_MODEL_DIR, exist_ok=True)
    dst = os.path.join(TMP_MODEL_DIR, base)
    data_name = base + ".data"
    src_data = path + ".data"
    for src, name in ((path, base), (src_data, data_name)):
        if not os.path.exists(src):
            continue
        target = os.path.join(TMP_MODEL_DIR, name)
        if os.path.exists(target) and os.path.getsize(target) == os.path.getsize(src):
            continue
        log(f"  复制 {os.path.basename(src)} → {TMP_MODEL_DIR}")
        shutil.copy2(src, target)
    return dst


def stage_aimet(names, bits, per_layer, out_path, calib_n, eval_n, results_root):
    from aimet_onnx.quant_analyzer import QuantAnalyzer
    from aimet_onnx.common.defs import QuantScheme

    report = {}
    for name in names:
        cfg = MODELS[name]
        samples = load_samples(name, limit=max(calib_n, eval_n))
        if not samples:
            log(f"{name}: 无校准数据，跳过")
            continue
        calib = samples[:calib_n]
        evalset = samples[-eval_n:] if eval_n > 0 else samples
        p32 = prepare_model_copy(os.path.join(FP32_DIR, cfg["fp32"]))
        log(f"{name}: 载入 fp32 图并构建 QuantSim（W/A {bits}-bit, calib={len(calib)}, eval={len(evalset)}）")
        t0 = time.time()
        model = onnx.load(p32)

        # 参考输出用 FP32 CPU 会话现算一次，不依赖 npz 里 output 的命名
        s32 = make_session(p32, "CPUExecutionProvider")
        refs = [s32.run(None, cast_feeds(s32, f))[0] for f, _ in evalset]

        def eval_cb2(session):
            return float(np.mean([_sqnr_pair(ref, session.run(None, cast_feeds(session, f))[0])
                                  for (f, _), ref in zip(evalset, refs)]))

        qa = QuantAnalyzer(
            model=model,
            dummy_input=cast_feeds(s32, calib[0][0]),
            forward_pass_callback=_Forward(calib),
            eval_callback=eval_cb2,
        )
        sim = qa.create_quantsim_and_encodings(
            quant_scheme=QuantScheme.post_training_tf_enhanced,
            default_param_bw=bits,
            default_activation_bw=bits,
            config_file=None,
        )
        log(f"  QuantSim 就绪（{time.time() - t0:.1f}s），开始敏感度分析")
        entry = {"bits": bits, "calib_samples": len(calib), "eval_samples": len(evalset)}
        fp32_score, w_score, a_score = qa.check_model_sensitivity_to_quantization(sim)
        entry.update({"fp32_sqnr_db": fp32_score, "weight_only_sqnr_db": w_score,
                      "activation_only_sqnr_db": a_score})
        log(f"  FP32 {fp32_score:.2f}dB | W-only {w_score:.2f}dB | A-only {a_score:.2f}dB")
        del s32

        rdir = os.path.join(results_root, f"{name}_{bits}bit")
        if per_layer in ("enable", "both"):
            t1 = time.time()
            enabled = qa.perform_per_layer_analysis_by_enabling_quantizers(sim, results_dir=rdir)
            entry["per_layer_enabled"] = enabled
            log(f"  per-layer(enabled) 完成 {time.time() - t1:.1f}s，{len(enabled)} 层")
        if per_layer in ("disable", "both"):
            t1 = time.time()
            disabled = qa.perform_per_layer_analysis_by_disabling_quantizers(sim, results_dir=rdir)
            entry["per_layer_disabled"] = disabled
            log(f"  per-layer(disabled) 完成 {time.time() - t1:.1f}s，{len(disabled)} 层")
        entry["seconds"] = round(time.time() - t0, 1)
        report[name] = entry
        merge_write(out_path, "aimet", {name: entry})

    if report:
        merge_write(out_path, "aimet", report)


def _sqnr_pair(ref, out):
    ref = np.asarray(ref, dtype=np.float64).reshape(-1)
    out = np.asarray(out, dtype=np.float64).reshape(-1)
    n = min(ref.size, out.size)
    sig = float(np.sum(ref[:n] ** 2))
    noise = float(np.sum((ref[:n] - out[:n]) ** 2))
    return 10 * np.log10((sig + 1e-20) / (noise + 1e-20))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=["fp16", "aimet"], required=True)
    ap.add_argument("--models", nargs="*", default=list(MODELS))
    ap.add_argument("--bits", type=int, default=16)
    ap.add_argument("--per-layer", choices=["none", "enable", "disable", "both"], default="both")
    ap.add_argument("--calib", type=int, default=4)
    ap.add_argument("--eval", type=int, default=2)
    ap.add_argument("--out", default=REPORT_JSON)
    ap.add_argument("--results-root", default=os.path.join(SCRIPT_DIR, "aimet_results"))
    ap.add_argument("--seq-limit", type=int, default=0, help="覆盖默认序列截断长度（0=用内置默认）")
    args = ap.parse_args()

    if args.seq_limit:
        for n in MODELS:
            SEQ_OVERRIDE[n] = args.seq_limit

    names = [n for n in args.models if n in MODELS]
    unknown = [n for n in args.models if n not in MODELS]
    if unknown:
        log(f"忽略未知模型: {unknown}")

    if args.stage == "fp16":
        stage_fp16(names, args.out)
    else:
        stage_aimet(names, args.bits, args.per_layer, args.out, args.calib, args.eval, args.results_root)


if __name__ == "__main__":
    main()
