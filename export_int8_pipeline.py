# -*- coding: utf-8 -*-
"""
Run full INT8 export pipeline. Each step runs in a separate process
to ensure complete memory isolation between steps.

用法: python export_int8_pipeline.py [--model-path PATH] [--output-dir PATH]
"""
import subprocess
import sys
import os
import argparse
import time

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DEFAULT_OUTPUT_DIR = os.path.join(SCRIPT_DIR, 'onnx_models', 'int8', 'from_pytorch')

def run_step(script, extra_args=None):
    """Run a pipeline step in a separate process."""
    cmd = [sys.executable, os.path.join(SCRIPT_DIR, script)]
    if extra_args:
        cmd.extend(extra_args)
    print(f"\n{'='*60}")
    print(f"Running: {script}")
    print(f"{'='*60}")
    t0 = time.time()
    result = subprocess.run(cmd, cwd=SCRIPT_DIR)
    if result.returncode != 0:
        print(f"\n[FAIL] {script} exited with code {result.returncode}")
        sys.exit(result.returncode)
    print(f"  Completed in {time.time() - t0:.1f}s")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model-path', default=None)
    parser.add_argument('--output-dir', default=DEFAULT_OUTPUT_DIR)
    args = parser.parse_args()

    extra = []
    if args.model_path:
        extra.extend(['--model-path', args.model_path])
    extra.extend(['--output-dir', args.output_dir])

    print("INT8 ONNX Export Pipeline (4 isolated processes)")
    print(f"Output: {args.output_dir}")

    t_total = time.time()
    run_step('export_step1_diffstep.py', extra)
    run_step('export_step2_vocoder.py', extra)
    run_step('export_step3_postprocess.py', ['--output-dir', args.output_dir])
    run_step('export_step4_quantize.py', ['--output-dir', args.output_dir])

    print(f"\n{'='*60}")
    print(f"Pipeline complete in {time.time() - t_total:.1f}s")
    print(f"{'='*60}")

if __name__ == '__main__':
    main()
