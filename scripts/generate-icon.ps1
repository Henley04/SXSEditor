# Generates a multi-resolution Windows ICO from assets/SXS.png
# Sizes: 256, 128, 64, 48, 32, 16 (PNG-embedded, Vista+ compatible)
# Usage: powershell -ExecutionPolicy Bypass -File scripts/generate-icon.ps1

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$src  = Join-Path $root 'assets\SXS.png'
$out  = Join-Path $root 'assets\SXS.ico'

if (-not (Test-Path $src)) {
  Write-Error "Source PNG not found: $src"
  exit 1
}

Add-Type -AssemblyName System.Drawing

$sizes = @(256, 128, 64, 48, 32, 16)
$srcImg = [System.Drawing.Image]::FromFile($src)

$pngEntries = New-Object System.Collections.ArrayList
foreach ($size in $sizes) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($srcImg, 0, 0, $size, $size)
  $g.Dispose()

  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  [void]$pngEntries.Add($ms.ToArray())
  $ms.Dispose()
}
$srcImg.Dispose()

$fs     = [System.IO.File]::Create($out)
$writer = New-Object System.IO.BinaryWriter $fs

# ICONDIR header
$writer.Write([uint16]0)                          # reserved
$writer.Write([uint16]1)                          # type = ICO
$writer.Write([uint16]$pngEntries.Count)          # image count

# ICONDIRENTRY for each size
$headerSize = 6 + 16 * $pngEntries.Count
$offset = $headerSize
for ($i = 0; $i -lt $pngEntries.Count; $i++) {
  $size  = $sizes[$i]
  $bytes = $pngEntries[$i]
  $dim   = if ($size -eq 256) { 0 } else { $size }
  $writer.Write([byte]$dim)                       # width
  $writer.Write([byte]$dim)                       # height
  $writer.Write([byte]0)                          # color count
  $writer.Write([byte]0)                          # reserved
  $writer.Write([uint16]1)                        # planes
  $writer.Write([uint16]32)                       # bits per pixel
  $writer.Write([uint32]$bytes.Length)            # size of image data
  $writer.Write([uint32]$offset)                  # offset to image data
  $offset += $bytes.Length
}

# Image data
foreach ($bytes in $pngEntries) {
  $writer.Write($bytes)
}

$writer.Flush()
$writer.Close()
$fs.Close()

$info = Get-Item -Path $out
Write-Host "Generated $($info.FullName) ($($info.Length) bytes, $($sizes.Count) resolutions)"
