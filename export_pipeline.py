# -*- coding: utf-8 -*-
"""
Run full FP32 opset 20 ONNX export pipeline. Each step runs in a separate process
to ensure complete memory isolation between steps.

用法: python export_pipeline.py [--model-path PATH] [--output-dir PATH] [--skip-jp]

输出: onnx_models/ 根目录下 9 个 FP32 opset 20 ONNX 模型 + onnx_models/JP/ 下 4 个 JP 模型
"""
import subprocess
import sys
import os
import argparse
import time
import onnx

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUTPUT_DIR = os.path.join(SCRIPT_DIR, 'onnx_models')


def run_step(script, extra_args=None, optional=False):
    """Run a pipeline step in a separate process.

    Args:
        script: script filename
        extra_args: list of additional CLI args
        optional: if True, failure is non-fatal (e.g., JP export without checkpoint)
    """
    cmd = [sys.executable, os.path.join(SCRIPT_DIR, script)]
    if extra_args:
        cmd.extend(extra_args)
    print(f"\n{'='*60}")
    print(f"Running: {script}")
    print(f"{'='*60}")
    t0 = time.time()
    result = subprocess.run(cmd, cwd=SCRIPT_DIR)
    elapsed = time.time() - t0
    if result.returncode != 0:
        msg = f"[{'WARN' if optional else 'FAIL'}] {script} exited with code {result.returncode} in {elapsed:.1f}s"
        if optional:
            print(f"\n{msg} (optional step, continuing)")
        else:
            print(f"\n{msg}")
            sys.exit(result.returncode)
    else:
        print(f"  Completed in {elapsed:.1f}s")


def verify_outputs(output_dir):
    """Verify all expected ONNX files exist and use opset 20."""
    print(f"\n{'='*60}")
    print("Verification: opset 20 + file presence")
    print(f"{'='*60}")

    expected_files = [
        'diff_step_dml.onnx', 'vocoder_dml.onnx',
        'note_text_encoder.onnx', 'note_pitch_encoder.onnx',
        'note_type_encoder.onnx', 'f0_encoder.onnx',
        'preflow.onnx', 'cond_emb.onnx', 'mel_transform.onnx',
    ]
    jp_files = [
        os.path.join('JP', 'note_text_encoder.onnx'),
        os.path.join('JP', 'preflow.onnx'),
        os.path.join('JP', 'cond_emb.onnx'),
        os.path.join('JP', 'diff_step_dml.onnx'),
    ]

    print("\nMain path (onnx_models/):")
    all_ok = True
    for fname in expected_files:
        fpath = os.path.join(output_dir, fname)
        if not os.path.exists(fpath):
            print(f"  [MISS] {fname}")
            all_ok = False
            continue
        size_mb = os.path.getsize(fpath) / 1024 / 1024
        try:
            model = onnx.load(fpath, load_external_data=False)
            opset = model.opset_import[0].version if model.opset_import else '?'
            print(f"  [OK]   {fname:35s} {size_mb:7.1f}MB  opset={opset}")
            if opset != 20:
                print(f"         [WARN] expected opset 20, got {opset}")
                all_ok = False
        except Exception as e:
            print(f"  [ERR]  {fname}: {e}")
            all_ok = False

    print("\nJP path (onnx_models/JP/):")
    jp_ok = True
    for frel in jp_files:
        fpath = os.path.join(output_dir, frel)
        if not os.path.exists(fpath):
            print(f"  [MISS] {frel}")
            jp_ok = False
            continue
        size_mb = os.path.getsize(fpath) / 1024 / 1024
        try:
            model = onnx.load(fpath, load_external_data=False)
            opset = model.opset_import[0].version if model.opset_import else '?'
            print(f"  [OK]   {frel:35s} {size_mb:7.1f}MB  opset={opset}")
            if opset != 20:
                print(f"         [WARN] expected opset 20, got {opset}")
                jp_ok = False
        except Exception as e:
            print(f"  [ERR]  {frel}: {e}")
            jp_ok = False

    return all_ok, jp_ok


def main():
    parser = argparse.ArgumentParser(description='FP32 opset 20 ONNX export pipeline (4 isolated processes)')
    parser.add_argument('--model-path', default=None,
                        help='Base model.pt path (default: SoulX-Singer/pretrained_models/SoulX-Singer/model.pt)')
    parser.add_argument('--output-dir', default=DEFAULT_OUTPUT_DIR,
                        help=f'Output directory (default: {DEFAULT_OUTPUT_DIR})')
    parser.add_argument('--jp-checkpoint', default=None,
                        help='JP LoRA checkpoint path (default: SoulX-Singer/outputs/lora_jp_v3/stage3/stage3_best.pt)')
    parser.add_argument('--skip-jp', action='store_true',
                        help='Skip JP model export')
    args = parser.parse_args()

    print("FP32 opset 20 ONNX Export Pipeline (4 isolated processes)")
    print(f"Output: {args.output_dir}")

    extra = []
    if args.model_path:
        extra.extend(['--model-path', args.model_path])
    extra.extend(['--output-dir', args.output_dir])

    t_total = time.time()
    run_step('export_step1_diffstep.py', extra)
    run_step('export_step2_vocoder.py', extra)
    run_step('export_step3_postprocess.py', ['--output-dir', args.output_dir])

    if not args.skip_jp:
        jp_args = ['--output-dir', os.path.join(args.output_dir, 'JP')]
        if args.model_path:
            jp_args.extend(['--base-model', args.model_path])
        if args.jp_checkpoint:
            jp_args.extend(['--checkpoint', args.jp_checkpoint])
        run_step('export_step4_jp.py', jp_args, optional=True)
    else:
        print("\n[SKIP] JP export (--skip-jp)")

    print(f"\n{'='*60}")
    print(f"Pipeline complete in {time.time() - t_total:.1f}s")
    print(f"{'='*60}")

    main_ok, jp_ok = verify_outputs(args.output_dir)

    print(f"\n{'='*60}")
    print("Summary")
    print(f"{'='*60}")
    print(f"  Main path (9 FP32 opset 20 models): {'PASS' if main_ok else 'FAIL'}")
    print(f"  JP path (4 JP FP32 opset 20 models): {'PASS' if jp_ok else 'FAIL' if not args.skip_jp else 'SKIPPED'}")

    if not main_ok:
        sys.exit(1)


if __name__ == '__main__':
    main()
