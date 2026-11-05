<#
.SYNOPSIS
  按顺序试听一个文件夹里的所有音频文件，边播边打印文件名。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File tools\audition.ps1 -Path 'D:\Downloads\sfx'

.NOTES
  下载来的音效丢进一个文件夹就行，wav/mp3/m4a/ogg/flac/wma 都能放。
  听完把中意的文件名填到 profile 的 cordis.patch.yml：
      config:
        sound: 'D:\Downloads\sfx\中意的.wav'
#>
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [int]$Volume = 85,
  [int]$GapMs = 700
)

$extensions = '^\.(wav|mp3|m4a|ogg|oga|flac|wma|aif|aiff)$'
$files = @(Get-ChildItem -LiteralPath $Path -File | Where-Object { $_.Extension -match $extensions } | Sort-Object Name)

if ($files.Count -eq 0) {
  Write-Host "没有找到音频文件: $Path" -ForegroundColor Yellow
  exit 1
}

Add-Type -AssemblyName PresentationCore

Write-Host "共 $($files.Count) 个文件，音量 $Volume（wav 走 SoundPlayer，音量跟系统；其他格式走 WMP）" -ForegroundColor Cyan
$index = 0
foreach ($file in $files) {
  $index++
  Write-Host ("[{0}/{1}] {2}" -f $index, $files.Count, $file.Name) -ForegroundColor Green
  if ($file.Extension -ieq '.wav') {
    (New-Object System.Media.SoundPlayer $file.FullName).PlaySync()
  } else {
    $media = New-Object -ComObject WMPlayer.OCX
    $media.settings.volume = $Volume
    $media.URL = $file.FullName
    $media.controls.play()
    Start-Sleep -Milliseconds 3500
    $media.controls.stop()
    $media.close()
  }
  Start-Sleep -Milliseconds $GapMs
}
Write-Host '试听结束' -ForegroundColor Cyan
