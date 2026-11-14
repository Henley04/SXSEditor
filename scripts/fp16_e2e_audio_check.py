# -*- coding: utf-8 -*-
"""FP16 vs FP32 端到端（32 步扩散 + 声码器）音频级精度对比。

复用 verify_e2e_dml_precision.py 的 diffusion_loop / run_vocoder / create_dml_session，
用真实校准数据里的 cond embedding 与 prompt mel，固定种子，只切换模型精度。

用法：
  python scripts/fp16_e2e_audio_check.py --steps 32 --cfg 3.0 --target-len 200
"""
import argparse
import json
import os
import sys
import time

import numpy as np

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(SCRIPT_DIR)
sys.path.insert(0, SCRIPT_DIR)

from verify_e2e_dml_precision import create_dml_session, diffusion_loop  # noqa: E402


def run_vocoder(sess, mel_np):
    """按会话真实签名喂数据（fp16 版 vocoder 的输入名 mel、输出名 output）。"""
    inp = sess.get_inputs()[0]
    dtype = np.float16 if "float16" in inp.type else np.float32
    out_name = sess.get_outputs()[0].name
    return sess.run([out_name], {inp.name: mel_np.astype(dtype)})[0].astype(np.float32)

FP32 = os.path.join(PROJECT_DIR, "onnx_models")
FP16 = os.path.join(FP32, "fp16")
CALIB = os.path.join(PROJECT_DIR, "calibrate", "data", "fp16_calib")
OUT_JSON = os.path.join(SCRIPT_DIR, "fp16_e2e_audio_report.json")
OUT_NPZ = os.path.join(SCRIPT_DIR, "fp16_e2e_audio.npz")


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def snr_db(ref, cand):
    ref = np.asarray(ref, dtype=np.float64).reshape(-1)
    cand = np.asarray(cand, dtype=np.float64).reshape(-1)
    n = min(ref.size, cand.size)
    ref, cand = ref[:n], cand[:n]
    err = ref - cand
    return float(10 * np.log10((np.sum(ref ** 2) + 1e-20) / (np.sum(err ** 2) + 1e-20)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--steps", type=int, default=32)
    ap.add_argument("--cfg", type=float, default=3.0)
    ap.add_argument("--rescale", type=float, default=0.75)
    ap.add_argument("--target-len", type=int, default=200)
    ap.add_argument("--prompt-len", type=int, default=30)
    args = ap.parse_args()

    cond_npz = np.load(os.path.join(CALIB, "cond_emb.npz"))
    voc_npz = np.load(os.path.join(CALIB, "vocoder_dml.npz"))
    total = args.prompt_len + args.target_len
    cond = cond_npz["sample0_output"][:, :total].astype(np.float32)
    mel_src = voc_npz["sample0_input_mel"]
    prompt_mel = mel_src[:, : args.prompt_len].astype(np.float32)
    log(f"cond={cond.shape} prompt={prompt_mel.shape} steps={args.steps} cfg={args.cfg}")

    s32d = create_dml_session(os.path.join(FP32, "diff_step_dml.onnx"))
    s16d = create_dml_session(os.path.join(FP16, "diff_step_dml.onnx"))
    v32 = create_dml_session(os.path.join(FP32, "vocoder_dml.onnx"))
    v16 = create_dml_session(os.path.join(FP16, "vocoder_dml.onnx"))
    log("4 个 DML 会话就绪")

    t0 = time.time()
    mel32 = diffusion_loop(s32d, False, prompt_mel, args.target_len, cond,
                           n_steps=args.steps, cfg_strength=args.cfg, cfg_rescale=args.rescale)
    log(f"FP32 扩散完成 {time.time() - t0:.1f}s")
    t0 = time.time()
    mel16 = diffusion_loop(s16d, True, prompt_mel, args.target_len, cond,
                           n_steps=args.steps, cfg_strength=args.cfg, cfg_rescale=args.rescale)
    log(f"FP16 扩散完成 {time.time() - t0:.1f}s")

    # 对照组：同样的 FP32 管线，只换随机种子，量化“采样本身的可变性”
    import numpy as _np
    _orig_seed = _np.random.seed
    _np.random.seed = lambda _s: _orig_seed(123)
    try:
        mel32_alt = diffusion_loop(s32d, False, prompt_mel, args.target_len, cond,
                                   n_steps=args.steps, cfg_strength=args.cfg, cfg_rescale=args.rescale)
    finally:
        _np.random.seed = _orig_seed
    log(f"FP32 对照种子完成，mel 与 seed42 的 SQNR = {snr_db(mel32, mel32_alt):.2f} dB")

    m32 = mel32.reshape(1, -1, 128).astype(np.float32)
    m16 = mel16.reshape(1, -1, 128).astype(np.float32)
    a32 = run_vocoder(v32, m32)
    a16 = run_vocoder(v16, m16)
    a_mix16 = run_vocoder(v16, m32)   # 只换声码器
    a_mix32 = run_vocoder(v32, m16)  # 只换扩散
    a_seed = run_vocoder(v32, mel32_alt.reshape(1, -1, 128).astype(np.float32))
    log("声码器完成")

    res = {
        "steps": args.steps, "cfg": args.cfg, "rescale": args.rescale,
        "target_len": args.target_len, "prompt_len": args.prompt_len,
        "mel": {
            "snr_db": snr_db(mel32, mel16),
            "max_abs_err": float(np.max(np.abs(mel32 - mel16))),
            "ref_std": float(np.std(mel32)),
        },
        "audio": {
            "snr_db_full_fp16": snr_db(a32, a16),
            "snr_db_vocoder_only": snr_db(a32, a_mix16),
            "snr_db_diffstep_only": snr_db(a32, a_mix32),
            "rms_ref": float(np.sqrt(np.mean(a32.astype(np.float64) ** 2))),
            "peak_ref": float(np.max(np.abs(a32))),
            "snr_db_seed_control": snr_db(a32, a_seed),
            "mel_snr_db_seed_control": snr_db(mel32, mel32_alt),
        },
    }
    log(json.dumps(res, indent=2, ensure_ascii=False))
    with open(OUT_JSON, "w", encoding="utf-8") as fh:
        json.dump(res, fh, indent=2, ensure_ascii=False)
    np.savez(OUT_NPZ, mel_fp32=mel32, mel_fp16=mel16, mel_fp32_altseed=mel32_alt,
             audio_fp32=a32, audio_fp16=a16, audio_voc16_only=a_mix16,
             audio_diff16_only=a_mix32, audio_seed_control=a_seed, prompt_mel=prompt_mel, cond=cond)
    log(f"写入 {OUT_JSON} / {OUT_NPZ}")


if __name__ == "__main__":
    main()
