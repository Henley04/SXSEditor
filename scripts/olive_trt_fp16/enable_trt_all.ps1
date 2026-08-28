# enable_trt_all.ps1 — copy trt_fp16 to fp16 for drop-in WinML TRTRTX, enable all non-preprocess
# Usage: powershell -ExecutionPolicy Bypass -File scripts\olive_trt_fp16\enable_trt_all.ps1
# Requires: onnx_models\trt_fp16\*.onnx already built via export_trt_fp16_dynamo.py
$ErrorActionPreference = "Stop"
$root = Resolve-Path "$PSScriptRoot\..\.."
$src = Join-Path $root "onnx_models\trt_fp16"
$dst = Join-Path $root "onnx_models\fp16"
if (!(Test-Path $src)) { Write-Error " Missing $src — run export_trt_fp16_dynamo.py first"; exit 1 }
Write-Host "Copying TRT FP16 $src -> $dst (compatible, not overwriting FP32 root)"
Copy-Item -Force "$src\*.onnx" $dst -ErrorAction SilentlyContinue
Copy-Item -Force "$src\*.onnx.data" $dst -ErrorAction SilentlyContinue
if (Test-Path "$src\JP") {
  New-Item -ItemType Directory -Force -Path "$dst\JP" | Out-Null
  Copy-Item -Force "$src\JP\*.onnx" "$dst\JP" -ErrorAction SilentlyContinue
  Copy-Item -Force "$src\JP\*.onnx.data" "$dst\JP" -ErrorAction SilentlyContinue
}
Write-Host "Copied. Verifying..."
Get-ChildItem "$dst\*.onnx" | ForEach-Object { Write-Host "  $($_.Name) $([math]::Round($_.Length/1MB,1))MB" }
Write-Host ""
Write-Host "To run all TRTRTX (except preprocess) in next npm start, set env:"
Write-Host '  $env:SXS_WINML_ALL_TRTRTX="1"; npm start'
Write-Host "Or add SXS_WINML_ALL_TRTRTX=1 to your shell profile."
Write-Host "To revert to preflow-only (stable): remove env and xcopy fp16 true backup."
