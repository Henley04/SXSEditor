$gpus = Get-CimInstance Win32_VideoController
foreach ($gpu in $gpus) {
    Write-Output "$($gpu.Name)|$($gpu.AdapterRAM)"
}
