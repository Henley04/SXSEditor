Write-Host "=== vocoder/sifigan files in onnx_models ==="
Get-ChildItem -Path 'onnx_models' -File | Where-Object { $_.Name -match 'vocoder|sifigan' } | ForEach-Object {
    '{0,-45} {1,10:N2} MB' -f $_.Name, ($_.Length / 1MB)
}
