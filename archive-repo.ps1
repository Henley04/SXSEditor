# archive-repo.ps1 - Pack git repo as zip with .docx fake suffix
param(
    [string]$OutputDir = ".."
)

$ErrorActionPreference = "Continue"

# --- Locate repo root ---
$repoRoot = git rev-parse --show-toplevel 2>&1
if (-not $repoRoot) {
    Write-Host "Error: Not inside a git repository." -ForegroundColor Red
    exit 1
}
$repoRoot = (Resolve-Path $repoRoot).Path
Write-Host "Repo root: $repoRoot"

# --- Resolve output dir (relative paths resolved against repo root) ---
if ([System.IO.Path]::IsPathRooted($OutputDir)) {
    $outDirFull = $OutputDir
} else {
    $outDirFull = Join-Path $repoRoot $OutputDir
}
if (-not (Test-Path $outDirFull)) {
    New-Item -ItemType Directory -Path $outDirFull -Force | Out-Null
}
$outDirFull = (Resolve-Path $outDirFull).Path
Write-Host "Output dir: $outDirFull"

# --- Build filename ---
$date = Get-Date -Format "yyyy-MM-dd"
$fileName = "sxseditor-$date.zip.docx"
$outFile = Join-Path $outDirFull $fileName

if (Test-Path $outFile) {
    Remove-Item $outFile -Force
    Write-Host "Removed old file: $fileName"
}

# --- git archive ---
Write-Host "Packing..."
git -C $repoRoot archive --format=zip --output="$outFile" HEAD
if ($LASTEXITCODE -ne 0) {
    Write-Host "Error: git archive failed, exit code: $LASTEXITCODE" -ForegroundColor Red
    exit 1
}

# --- Verify output ---
if (Test-Path $outFile) {
    $size = (Get-Item $outFile).Length
    $sizeMB = [math]::Round($size / 1MB, 2)
    Write-Host ""
    Write-Host "Done!" -ForegroundColor Green
    Write-Host "  File: $outFile"
    Write-Host "  Size: $sizeMB MB"
} else {
    Write-Host "Error: Output file not generated." -ForegroundColor Red
    exit 1
}
