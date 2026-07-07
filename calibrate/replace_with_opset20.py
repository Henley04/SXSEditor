# -*- coding: utf-8 -*-
"""Replace original models with opset20 versions."""
import os
import shutil

PROJECT_DIR = r'd:\Document\electron\SXSEditor'

REPLACEMENTS = [
    # W16A32 (fp16/)
    (r'onnx_models\fp16\diff_step_dml_opset20.onnx', r'onnx_models\fp16\diff_step_dml.onnx'),
    (r'onnx_models\fp16\vocoder_dml_opset20.onnx', r'onnx_models\fp16\vocoder_dml.onnx'),
    # Production
    (r'onnx_models\diff_step_dml_opset20.onnx', r'onnx_models\diff_step_dml.onnx'),
    (r'onnx_models\vocoder_dml_opset20.onnx', r'onnx_models\vocoder_dml.onnx'),
    (r'onnx_models\preflow_opset20.onnx', r'onnx_models\preflow.onnx'),
    (r'onnx_models\mel_transform_opset20.onnx', r'onnx_models\mel_transform.onnx'),
    (r'onnx_models\cond_emb_opset20.onnx', r'onnx_models\cond_emb.onnx'),
    (r'onnx_models\f0_encoder_opset20.onnx', r'onnx_models\f0_encoder.onnx'),
    (r'onnx_models\note_pitch_encoder_opset20.onnx', r'onnx_models\note_pitch_encoder.onnx'),
    (r'onnx_models\note_text_encoder_opset20.onnx', r'onnx_models\note_text_encoder.onnx'),
    (r'onnx_models\note_type_encoder_opset20.onnx', r'onnx_models\note_type_encoder.onnx'),
]

for src_rel, dst_rel in REPLACEMENTS:
    src = os.path.join(PROJECT_DIR, src_rel)
    dst = os.path.join(PROJECT_DIR, dst_rel)
    if not os.path.exists(src):
        print(f"SKIP (src not found): {src_rel}")
        continue
    # Backup original (rename to .bak)
    bak = dst + '.bak'
    if os.path.exists(bak):
        os.remove(bak)
    if os.path.exists(dst):
        shutil.move(dst, bak)
    # Copy opset20 to original name
    shutil.copy2(src, dst)
    # Also handle external data
    src_data = src + '.data'
    dst_data = dst + '.data'
    if os.path.exists(src_data):
        if os.path.exists(dst_data):
            os.remove(dst_data)
        shutil.copy2(src_data, dst_data)
    # Remove the opset20 file (now redundant)
    os.remove(src)
    if os.path.exists(src_data):
        os.remove(src_data)
    print(f"OK: {os.path.basename(dst)} (backup: {os.path.basename(bak)})")

print("\nDone. Original models backed up as .bak, opset20 versions now active.")