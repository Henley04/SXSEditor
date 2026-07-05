# GPU 信息查询
Write-Host "=== Win32_VideoController ==="
Get-CimInstance Win32_VideoController | ForEach-Object {
    $vramGB = [math]::Round($_.AdapterRAM / 1GB, 2)
    Write-Host ("Name: {0} | VRAM(GB): {1} | Driver: {2}" -f $_.Name, $vramGB, $_.DriverVersion)
}

Write-Host ""
Write-Host "=== nvidia-smi (if available) ==="
$nv = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if ($nv) {
    & nvidia-smi --query-gpu=name,memory.total,memory.used,memory.free --format=csv,noheader
} else {
    Write-Host "nvidia-smi not found"
}

Write-Host ""
Write-Host "=== GPU Performance Counter (if available) ==="
try {
    $counters = (Get-Counter -ListSet "GPU Adapter Memory(*)" -ErrorAction Stop).Paths
    Write-Host "Available counters:"
    $counters | ForEach-Object { Write-Host "  $_" }
    $samples = Get-Counter "\GPU Adapter Memory(*)\Dedicated Usage" -ErrorAction Stop
    $samples.CounterSamples | ForEach-Object {
        Write-Host ("  {0}: {1} MB" -f $_.InstanceName, [math]::Round($_.CookedValue / 1MB, 1))
    }
} catch {
    Write-Host "GPU counter failed: $($_.Exception.Message)"
}
