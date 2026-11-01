# 诊断 / 修复 .sxsproj 与 .sxssinger 的文件关联与图标
#
# 用法（普通 PowerShell 窗口，不需要管理员）：
#   powershell -ExecutionPolicy Bypass -File fix-file-association.ps1            # 只看状态
#   powershell -ExecutionPolicy Bypass -File fix-file-association.ps1 -Repair     # 清陈旧项 + 刷新图标
#
# 说明：Windows 10/11 里 HKCU\...\Explorer\FileExts\<ext>\UserChoice 的优先级
# 高于 Software\Classes，而且带哈希校验，程序自己改不了。一旦这个键指向一个
# 已经不存在的 ProgId，资源管理器就一直画白纸图标 —— 删掉它，系统会回落到
# Software\Classes 的默认关联（也就是应用启动时写的那套）。

param([switch]$Repair, [string]$ExePath = '')

$ErrorActionPreference = 'Continue'
$exts = @(
  @{ Ext = '.sxsproj';   ProgId = 'SXSEditor.Project'; Label = 'SXSEditor 工程'; Icon = 'project.ico' },
  @{ Ext = '.sxssinger'; ProgId = 'SXSEditor.Singer';  Label = 'SXSEditor 歌手'; Icon = 'singer.ico' }
)

function Get-RegValue($path, $name) {
  # 注册表默认值用空字符串作名字；Get-ItemProperty -Name '(default)' 是读不到的
  try { (Get-Item -Path $path -ErrorAction Stop).GetValue($name) }
  catch { $null }
}

function Find-Exe {
  if ($ExePath -and (Test-Path $ExePath)) { return (Resolve-Path $ExePath).Path }
  # 应用启动时写进注册表的命令里就有真实路径，优先用它
  foreach ($p in @('HKCU:\Software\Classes\SXSEditor.Project\shell\open\command',
                   'HKCU:\Software\Classes\SXSEditor.Singer\shell\open\command')) {
    $cmd = Get-RegValue $p ''
    if ($cmd -and $cmd -match '^"([^"]+\.exe)"') { if (Test-Path $Matches[1]) { return $Matches[1] } }
  }
  foreach ($guess in @(
      "$env:ProgramFiles\SXSEditor\SXSEditor.exe",
      "${env:ProgramFiles(x86)}\SXSEditor\SXSEditor.exe",
      "$env:LOCALAPPDATA\Programs\SXSEditor\SXSEditor.exe")) {
    if (Test-Path $guess) { return $guess }
  }
  return $null
}

Write-Host "== 当前关联状态 ==" -ForegroundColor Cyan
foreach ($t in $exts) {
  $ext = $t.Ext
  $classesDefault = Get-RegValue "HKCU:\Software\Classes\$ext" ''
  $userChoice     = Get-RegValue "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$ext\UserChoice" 'ProgId'
  $icon           = Get-RegValue "HKCU:\Software\Classes\$($t.ProgId)\DefaultIcon" ''
  $cmd            = Get-RegValue "HKCU:\Software\Classes\$($t.ProgId)\shell\open\command" ''

  Write-Host ""
  Write-Host "$ext ($($t.Label))"
  Write-Host "  Classes 默认值 : $classesDefault"
  Write-Host "  UserChoice     : $(if ($userChoice) { $userChoice + '   <-- 优先级最高' } else { '(无)' })"
  Write-Host "  DefaultIcon    : $icon"
  if ($icon) {
    $iconFile = ($icon -split ',')[0]
    if (Test-Path $iconFile) { Write-Host "  图标文件       : 存在" -ForegroundColor Green }
    else { Write-Host "  图标文件       : 缺失 -> $iconFile" -ForegroundColor Red }
  }
  Write-Host "  打开命令       : $cmd"
}

if (-not $Repair) {
  Write-Host ""
  Write-Host "只做了检查。加上 -Repair 可清理陈旧 UserChoice 并刷新图标缓存。" -ForegroundColor Yellow
  return
}

Write-Host ""
Write-Host "== 清理 ==" -ForegroundColor Cyan
foreach ($t in $exts) {
  $key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FileExts\$($t.Ext)\UserChoice"
  if (Test-Path $key) {
    Remove-Item $key -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  已删除 UserChoice: $($t.Ext)"
  }
}

$exe = Find-Exe
if (-not $exe) {
  Write-Host "找不到 SXSEditor.exe。用 -ExePath 'C:\...\SXSEditor.exe' 指定后再跑一次。" -ForegroundColor Yellow
  return
}
Write-Host "可执行文件: $exe"
$appDir = Split-Path $exe -Parent

Write-Host ""
Write-Host "== 重写关联 ==" -ForegroundColor Cyan
foreach ($t in $exts) {
  $progKey = "HKCU:\Software\Classes\$($t.ProgId)"
  New-Item -Path $progKey -Force | Out-Null
  New-Item -Path "$progKey\shell\open\command" -Force | Out-Null
  Set-ItemProperty -Path $progKey -Name '' -Value $t.Label
  Set-ItemProperty -Path "$progKey\shell\open\command" -Name '' -Value "`"$exe`" `"%1`""

  $iconFile = Join-Path $appDir "resources\fileicons\$($t.Icon)"
  if (-not (Test-Path $iconFile)) {
    $iconFile = Join-Path $appDir "resources\assets\fileicons\$($t.Icon)"
  }
  if (Test-Path $iconFile) {
    New-Item -Path "$progKey\DefaultIcon" -Force | Out-Null
    Set-ItemProperty -Path "$progKey\DefaultIcon" -Name '' -Value "$iconFile,0"
    Write-Host "  $($t.Ext) 图标: $iconFile" -ForegroundColor Green
  } else {
    Write-Host "  $($t.Ext) 图标文件缺失（resources\fileicons\$($t.Icon)），先重装一次应用" -ForegroundColor Red
  }

  $extKey = "HKCU:\Software\Classes\$($t.Ext)"
  New-Item -Path $extKey -Force | Out-Null
  Set-ItemProperty -Path $extKey -Name '' -Value $t.ProgId
  New-Item -Path "$extKey\OpenWithProgids" -Force | Out-Null
  Set-ItemProperty -Path "$extKey\OpenWithProgids" -Name $t.ProgId -Value '' -Type None
  Write-Host "  $($t.Ext) -> $($t.ProgId)"
}

Write-Host ""
Write-Host "刷新图标缓存…"
ie4uinit.exe -show
Start-Sleep -Milliseconds 500
Stop-Process -Name explorer -Force -ErrorAction SilentlyContinue   # 资源管理器会自动重启
Write-Host "完成。若图标仍是空白，注销后重新登录一次再刷新。" -ForegroundColor Green
