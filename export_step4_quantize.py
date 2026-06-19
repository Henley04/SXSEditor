# -*- coding: utf-8 -*-
"""Step 4: Quantize post-processed FP32 ONNX models to INT8 (QDQ format)."""
import argparse, os
import numpy as np
from export_shared import quantize_onnx_model, DEFAULT_OUTPUT_DIR, clear_memory

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output-dir', default=DEFAULT_OUTPUT_DIR)
    args = parser.parse_args()

    print("Step 4: Quantize to INT8 (QDQ format)")

    diff_step_pp = os.path.join(args.output_dir, 'diff_step_fp32_pp.onnx')
    vocoder_pp = os.path.join(args.output_dir, 'vocoder_fp32_pp.onnx')
    diff_step_int8 = os.path.join(args.output_dir, 'diff_step_dml.onnx')
    vocoder_int8 = os.path.join(args.output_dir, 'vocoder_dml.onnx')

    seq_len = 2048
    voc_seq_len = 500

    quantize_onnx_model(diff_step_pp, diff_step_int8, {
        'xt_input': np.random.randn(1, seq_len, 128).astype(np.float32),
        't': np.array([0.5], dtype=np.float32),
        'cond': np.random.randn(1, seq_len, 512).astype(np.float32),
        'xt_mask': np.ones((1, seq_len), dtype=np.float32),
    })
    clear_memory()

    quantize_onnx_model(vocoder_pp, vocoder_int8, {
        'mel': np.random.randn(1, voc_seq_len, 128).astype(np.float32),
    })
    clear_memory()

    print("  Done.")

if __name__ == '__main__':
    main()
