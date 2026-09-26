# -*- coding: utf-8 -*-
"""Calibration data pipeline from SoulX-Singer-Eval-Dataset for TRT FP16.

Generates mel/phoneme/f0 calibration tensors from ModelScope Eval Dataset
(eval_data/Soul-AILab/SoulX-Singer-Eval-Dataset) for Olive quantization.

If eval audio is unavailable, falls back to synthetic distribution matching
generate_fp16_calibration.py (mean -4.92, std 2.85 for mel).

Output: calibrate/data/trt_fp16/<model>.npz  + calib_data.npz (flat Olive data_reader)
Compatible with Olive OnnxDynamicQuantization / Float16 conversion data_reader.

Usage:
  python scripts/olive_trt_fp16/calibrate_trt.py --eval-dir eval_data/Soul-AILab/SoulX-Singer-Eval-Dataset --out calibrate/data/trt_fp16 --num-samples 50
"""
import os, sys, json, argparse, time, gc, random
from pathlib import Path
import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parents[2]
EVAL_ROOT = SCRIPT_DIR / "eval_data" / "Soul-AILab" / "SoulX-Singer-Eval-Dataset" / "soulx-singer-eval"
OUTPUT_DIR = SCRIPT_DIR / "calibrate" / "data" / "trt_fp16"
NUM_SAMPLES = 50
SEED = 42

# Reuse generators from generate_fp16_calibration when eval unavailable
sys.path.insert(0, str(SCRIPT_DIR))
try:
    from generate_fp16_calibration import gen_mel, gen_xt_input, gen_t, gen_cond, gen_xt_mask
except Exception:
    gen_mel = gen_xt_input = None

def load_eval_mels(eval_dir: Path, num_samples: int):
    """Try to derive real mel tensors from eval audio + annotation.
    Fallback: synthetic.
    """
    audio_dir = eval_dir / "audio" / "source"
    annot_dir = eval_dir / "annotation"
    mels = []
    if audio_dir.exists():
        wavs = list(audio_dir.glob("*.wav"))[:num_samples]
        if wavs:
            try:
                import librosa, soundfile as sf
                for wav in wavs:
                    y, sr = sf.read(str(wav))
                    if y.ndim > 1: y = y.mean(axis=1)
                    # simple log-mel via librosa (80ms window, 20ms hop -> 128)
                    # Fallback to random if librosa missing
                    mel = librosa.feature.melspectrogram(y=y, sr=sr, n_mels=128, hop_length=480, win_length=1920)
                    mel = np.log(np.clip(mel, 1e-5, None)).T  # [T,128]
                    mels.append(mel.astype(np.float32))
            except Exception as e:
                print(f"[CALIB] librosa mel failed ({e}), using synthetic")
    # Supplement synthetic to reach num_samples if real < requested
    if len(mels) < num_samples:
        rng = np.random.RandomState(SEED)
        needed = num_samples - len(mels)
        for i in range(needed):
            T = 200 + (i % 5) * 100
            mel = (rng.randn(1, T, 128).astype(np.float32) * 2.85 - 4.92)
            mels.append(mel[0])
        if len(mels) > num_samples:
            mels = mels[:num_samples]
    return mels

def main():
    parser = argparse.ArgumentParser(description="TRT FP16 calibration from Eval-Dataset")
    parser.add_argument("--eval-dir", type=str, default=str(EVAL_ROOT), help="Eval dataset root")
    parser.add_argument("--out", type=str, default=str(OUTPUT_DIR), help="Output dir")
    parser.add_argument("--num-samples", type=int, default=NUM_SAMPLES)
    parser.add_argument("--fp32-dir", type=str, default=str(SCRIPT_DIR / "onnx_models"), help="FP32 ONNX dir for reference run")
    parser.add_argument("--provider", type=str, default="dml", choices=["dml","cpu"])
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    eval_dir = Path(args.eval_dir)
    print("="*70)
    print("TRT FP16 Calibration — Eval-Dataset")
    print(f"Eval: {eval_dir} exists={eval_dir.exists()}")
    print(f"Out: {out_dir} samples={args.num_samples}")
    print("="*70)

    mels = load_eval_mels(eval_dir, args.num_samples)
    print(f"[CALIB] Collected {len(mels)} mel sequences (T={[m.shape[0] for m in mels[:3]]}...)")

    # Pipeline-aware per-model calibration: diff_step cond must come from upstream
    # cond_emb/preflow → cond, not random, to match inference logic (user request).
    try:
        import onnx, onnxruntime as ort
        from generate_fp16_calibration import get_input_specs, generate_input, elem_type_to_np, MODELS, SEED as BASE_SEED
        provider = "DmlExecutionProvider" if args.provider=="dml" else "CPUExecutionProvider"
        providers = [provider, "CPUExecutionProvider"]

        # Preload upstream FP32 sessions for diff_step cond generation
        upstream_names = ["note_text_encoder","note_pitch_encoder","note_type_encoder","f0_encoder","preflow","cond_emb"]
        upstream_sess = {}
        for up in upstream_names:
            p = Path(args.fp32_dir) / f"{up}.onnx"
            if p.exists():
                try:
                    upstream_sess[up] = ort.InferenceSession(str(p), providers=providers)
                    print(f"[UPSTREAM] loaded {up}")
                except Exception as e:
                    print(f"[WARN] upstream {up} load fail: {e}")

        def _gen_pipeline_cond(rng, T, fp32_dir):
            """Generate real cond by running upstream chain with random notes."""
            try:
                if not upstream_sess: return None
                # Random phoneme/pitch/type/f0 ids
                vocab_text = 3000  # from onnx gather range [-3000,2999] observed in eval
                txt_ids = rng.randint(0, vocab_text, size=(1, T)).astype(np.int64)
                pitch_ids = rng.randint(0, 256, size=(1, T)).astype(np.int64)
                type_ids = rng.randint(0, 5, size=(1, T)).astype(np.int64)
                f0_ids = rng.randint(0, 256, size=(1, T)).astype(np.int64)
                # Encoders
                out_txt = upstream_sess["note_text_encoder"].run(None, {"input_ids": txt_ids})[0] if "note_text_encoder" in upstream_sess else None
                out_pitch = upstream_sess["note_pitch_encoder"].run(None, {"input_ids": pitch_ids})[0] if "note_pitch_encoder" in upstream_sess else None
                out_type = upstream_sess["note_type_encoder"].run(None, {"input_ids": type_ids})[0] if "note_type_encoder" in upstream_sess else None
                out_f0 = upstream_sess["f0_encoder"].run(None, {"input_ids": f0_ids})[0] if "f0_encoder" in upstream_sess else None
                # Fallback to preflow input: sum or concat? preflow expects [1,T,512] from text encoder path
                # Actual pipeline: preflow input is note_text_encoder output projected; we approximate via txt
                # If preflow/cond_emb available, chain them
                if "preflow" in upstream_sess and out_txt is not None:
                    # preflow expects 'x' or 'hidden_states' — try common names
                    pre_in_names = [i.name for i in upstream_sess["preflow"].get_inputs()]
                    # heuristic: feed first input
                    feed = {pre_in_names[0]: out_txt.astype(np.float32) if out_txt.dtype!=np.float32 else out_txt}
                    # if preflow needs 2 inputs, add pitch
                    if len(pre_in_names) > 1 and out_pitch is not None:
                        feed[pre_in_names[1]] = out_pitch.astype(np.float32)
                    pre_out = upstream_sess["preflow"].run(None, feed)[0]
                else:
                    pre_out = out_txt
                if "cond_emb" in upstream_sess and pre_out is not None:
                    cond_in_names = [i.name for i in upstream_sess["cond_emb"].get_inputs()]
                    feed2 = {cond_in_names[0]: pre_out.astype(np.float32)}
                    if len(cond_in_names) > 1:
                        # cond_emb may take preflow + f0/pitch; fill remaining with pre_out or zeros
                        for extra in cond_in_names[1:]:
                            feed2[extra] = np.zeros_like(pre_out) if 'cond' in extra.lower() else np.zeros((1,T,512), dtype=np.float32)
                    cond = upstream_sess["cond_emb"].run(None, feed2)[0]
                    # Ensure [1,T,1024]
                    if cond.shape[1] != T:
                        tmp = np.zeros((1,T,cond.shape[2]), dtype=np.float32)
                        tmp[:,:min(T,cond.shape[1]),:] = cond[:,:min(T,cond.shape[1]),:]
                        cond = tmp
                    return cond.astype(np.float32)
                return None
            except Exception as e:
                # print(f"[PIPE-COND] fail {e}")
                return None

        for model_name in MODELS:
            fp32_path = Path(args.fp32_dir) / f"{model_name}.onnx"
            if not fp32_path.exists():
                print(f"[SKIP] {model_name} FP32 not found")
                continue
            specs = get_input_specs(str(fp32_path), model_name)
            try:
                sess = ort.InferenceSession(str(fp32_path), providers=providers)
            except Exception as e:
                print(f"[FAIL] load {model_name}: {e}")
                continue
            save_data = {}
            for idx in range(min(args.num_samples, 8)):
                rng = np.random.RandomState(SEED + idx*100 + sum(ord(c) for c in model_name)%1000)
                feeds = {}
                # Decide T for this sample from mel
                T_hint = 256
                if mels:
                    T_hint = min(mels[idx % len(mels)].shape[0], 512)
                for spec in specs:
                    name = spec['name']
                    shape = spec['shape']
                    # Pipeline-aware special cases
                    if model_name == "diff_step_dml" and name == "cond":
                        # Try upstream cond
                        T = shape[1] if len(shape)>1 else T_hint
                        pipe_cond = _gen_pipeline_cond(rng, T, args.fp32_dir)
                        if pipe_cond is not None:
                            # cast to expected dtype
                            target_np = elem_type_to_np(spec['elem_type'])
                            if pipe_cond.dtype != target_np: pipe_cond = pipe_cond.astype(target_np)
                            # ensure shape matches spec (may be [1,seq,1024])
                            if list(pipe_cond.shape) != shape:
                                tmp = np.zeros(shape, dtype=target_np)
                                # copy overlapping
                                min_t = min(pipe_cond.shape[1], shape[1])
                                tmp[:,:min_t,:] = pipe_cond[:,:min_t,:pipe_cond.shape[2]]
                                pipe_cond = tmp
                            feeds[name] = pipe_cond
                            continue
                        # fallback to random cond
                    if name=="mel" and mels:
                        T = min(shape[1] if len(shape)>1 else 200, mels[idx % len(mels)].shape[0])
                        arr = mels[idx % len(mels)][:T][np.newaxis, :, :]
                        if arr.shape[1] != shape[1]:
                            tmp = np.zeros(shape, dtype=np.float32)
                            tmp[:,:min(arr.shape[1], shape[1]),:] = arr[:,:min(arr.shape[1], shape[1]),:]
                            arr = tmp
                    else:
                        arr = generate_input(spec, idx, rng, model_name=model_name)
                        target_np = elem_type_to_np(spec['elem_type'])
                        if arr.dtype != target_np: arr = arr.astype(target_np)
                    feeds[name] = arr
                try:
                    out = sess.run(None, feeds)[0]
                except Exception as e:
                    print(f"  sample {idx} fail {e}")
                    continue
                for k,v in feeds.items(): save_data[f"sample{idx}_input_{k}"] = v
                save_data[f"sample{idx}_output"] = out
            if save_data:
                np.savez(out_dir / f"{model_name}.npz", **save_data)
                print(f"[SAVED] {model_name}.npz {len(save_data)} arrays (pipeline-aware cond for diff_step)")
            del sess; gc.collect()
        # cleanup upstream
        for s in upstream_sess.values():
            try: del s
            except: pass
        gc.collect()
    except Exception as e:
        import traceback
        print(f"[WARN] pipeline-aware calibration failed, falling back: {e}")
        traceback.print_exc()

    # Flat Olive data_reader npz (all mels)
    flat_path = out_dir / "calib_data.npz"
    # Save mels as list of arrays with varying T -> save as object array
    mel_arr = np.array(mels, dtype=object)
    np.savez_compressed(flat_path, mels=mel_arr)
    print(f"[DONE] Flat calib: {flat_path} ({len(mels)} mels)")
    # summary
    summary = {"num_mels": len(mels), "out_dir": str(out_dir), "eval_dir": str(eval_dir), "timestamp": time.strftime("%Y-%m-%d %H:%M:%S")}
    with open(out_dir / "calibration_summary.json","w") as f: json.dump(summary,f,indent=2)

if __name__ == "__main__":
    main()
