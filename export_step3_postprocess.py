# -*- coding: utf-8 -*-
"""Step 3: Post-process FP32 ONNX models (STFT replacement, onnxsim, etc.)."""
import argparse, os
from export_shared import postprocess_onnx, DEFAULT_OUTPUT_DIR, clear_memory

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', default=DEFAULT_OUTPUT_DIR)
    args = parser.parse_args()

    print("Step 3: Post-process FP32 ONNX")

    diff_step_fp32 = os.path.join(args.output_dir, 'diff_step_fp32.onnx')
    vocoder_fp32 = os.path.join(args.output_dir, 'vocoder_fp32.onnx')
    diff_step_pp = os.path.join(args.output_dir, 'diff_step_fp32_pp.onnx')
    vocoder_pp = os.path.join(args.output_dir, 'vocoder_fp32_pp.onnx')

    postprocess_onnx(diff_step_fp32, diff_step_pp)
    clear_memory()
    postprocess_onnx(vocoder_fp32, vocoder_pp)
    clear_memory()

    print("  Done.")

if __name__ == '__main__':
    main()
