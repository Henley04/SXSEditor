#!/usr/bin/env bash
set -euo pipefail
: "${SXSEDITOR_REPO:?}" "${QDIT_REPO:?}" "${SOULX_MODEL_DIR:?}" "${SOULX_EVAL_DIR:?}" "${OUTPUT_DIR:?}"
mkdir -p "$OUTPUT_DIR"
python scripts/quantize_export.py --sxs "$SXSEDITOR_REPO" --qdit "$QDIT_REPO" --model "$SOULX_MODEL_DIR" --eval "$SOULX_EVAL_DIR" --out "$OUTPUT_DIR" --calib "${CALIBRATION_SAMPLES:-128}"
python scripts/validate.py --fp32 "$SOULX_MODEL_DIR" --int8 "$OUTPUT_DIR" --eval "$SOULX_EVAL_DIR" --out "$OUTPUT_DIR/metrics.json"
python scripts/olive_dml.py --input "$OUTPUT_DIR/onnx" --output "$OUTPUT_DIR/onnx_dml"
python scripts/integrate_sxseditor.py --repo "$SXSEDITOR_REPO" --model-dir "$OUTPUT_DIR/onnx_dml"
python scripts/upload_modelscope.py --model-dir "$OUTPUT_DIR" --model-id "${MODELSCOPE_MODEL_ID:?}"
