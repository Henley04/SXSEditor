Write-Host "=== onnx_models/fp16 contents (vocoder/sifigan only) ==="
if (Test-Path 'onnx_models\fp16') {
    Get-ChildItem 'onnx_models\fp16' -File | Where-Object { $_.Name -match 'vocoder|sifigan' } | ForEach-Object {
        Write-Host ('{0} {1:N2} MB' -f $_.FullName, ($_.Length / 1MB))
    }
} else {
    Write-Host 'fp16 dir does not exist'
}
Write-Host ""
Write-Host "=== onnx_models/fp16 full listing ==="
if (Test-Path 'onnx_models\fp16') {
    Get-ChildItem 'onnx_models\fp16' | ForEach-Object { Write-Host $_.Name }
}
