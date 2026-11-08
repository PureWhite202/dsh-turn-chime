param(
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Format = 'png',
    [int]$MaxEdge = 0
)

# Fallback capture path: used only when the C# helper cannot be compiled
# (no csc.exe / AV blocked the build). Full-screen only, ~1.5s per call.
# Output contract matches build/dshtool-capture.exe: one JSON line on stdout.

$ErrorActionPreference = 'Stop'

try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class NativeDpi {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[NativeDpi]::SetProcessDPIAware() | Out-Null

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap($vs.Width, $vs.Height)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($vs.Left, $vs.Top, 0, 0, $bmp.Size)
$g.Dispose()

if ($MaxEdge -gt 0) {
    $longEdge = [Math]::Max($bmp.Width, $bmp.Height)
    if ($longEdge -gt $MaxEdge) {
        $ratio = $MaxEdge / [double]$longEdge
        $nw = [int][Math]::Round($bmp.Width * $ratio)
        $nh = [int][Math]::Round($bmp.Height * $ratio)
        $scaled = New-Object System.Drawing.Bitmap($nw, $nh)
        $sg = [System.Drawing.Graphics]::FromImage($scaled)
        $sg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $sg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $sg.DrawImage($bmp, 0, 0, $nw, $nh)
        $sg.Dispose()
        $bmp.Dispose()
        $bmp = $scaled
    }
}

$sum = 0.0
$count = 0
$min = 255.0
$max = 0.0
$step = [int][Math]::Max(1, [Math]::Min($bmp.Width, $bmp.Height) / 200)
for ($y = 0; $y -lt $bmp.Height; $y += $step) {
    for ($x = 0; $x -lt $bmp.Width; $x += $step) {
        $p = $bmp.GetPixel($x, $y)
        $v = ($p.R + $p.G + $p.B) / 3.0
        $sum += $v
        $count++
        if ($v -lt $min) { $min = $v }
        if ($v -gt $max) { $max = $v }
    }
}
$mean = 0.0
if ($count -gt 0) { $mean = $sum / $count }
$uniform = 0.5
if (($max - $min) -lt 4) { $uniform = 1.0 }

if ($Format -eq 'jpeg') {
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Jpeg)
} else {
    $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
}

$escapedPath = $Out.Replace('\', '\\').Replace('"', '\"')
$inv = [System.Globalization.CultureInfo]::InvariantCulture
$json = '{"ok":true,"mode":"screen","path":"' + $escapedPath + '"' +
        ',"width":' + $bmp.Width +
        ',"height":' + $bmp.Height +
        ',"bounds":{"x":' + $vs.Left + ',"y":' + $vs.Top + ',"width":' + $vs.Width + ',"height":' + $vs.Height + '}' +
        ',"mean":' + $mean.ToString('F2', $inv) +
        ',"uniform":' + $uniform.ToString('F2', $inv) +
        ',"warnings":["POWERSHELL_FALLBACK"]}'

$bmp.Dispose()
Write-Output $json
