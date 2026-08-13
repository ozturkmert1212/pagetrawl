<#
  yt-dlp köprüsünü kurar: launcher .bat, native messaging host manifest'i ve
  Chrome'un onu bulmasını sağlayan registry anahtarı.

  Kullanım (normal PowerShell, yönetici gerekmez):
      .\setup-native.ps1 -ExtensionId <chrome://extensions'taki kimlik>

  Kaldırmak için:
      .\setup-native.ps1 -Uninstall
#>

param(
  [string]$ExtensionId,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$HostName = 'com.bozgu.ytdlp'
$Root     = $PSScriptRoot
$NativeDir = Join-Path $Root 'native'
$RegPath  = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"

# --- kaldırma --------------------------------------------------------------

if ($Uninstall) {
  if (Test-Path $RegPath) {
    Remove-Item $RegPath -Force
    Write-Host "Registry anahtari silindi." -ForegroundColor Green
  } else {
    Write-Host "Registry anahtari zaten yok."
  }
  exit 0
}

if (-not $ExtensionId) {
  Write-Host ""
  Write-Host "Eksik parametre: -ExtensionId" -ForegroundColor Yellow
  Write-Host "  1. chrome://extensions adresini ac"
  Write-Host "  2. 'Medya Indirici' kartindaki ID satirini kopyala"
  Write-Host "     (32 harflik, ornek: abcdefghijklmnopabcdefghijklmnop)"
  Write-Host "  3. .\setup-native.ps1 -ExtensionId <o-kimlik>"
  Write-Host ""
  exit 1
}

if ($ExtensionId -notmatch '^[a-p]{32}$') {
  Write-Host "Bu bir Chrome eklenti kimligine benzemiyor: $ExtensionId" -ForegroundColor Red
  Write-Host "32 karakter olmali ve sadece a-p harflerini icermeli."
  exit 1
}

# --- bagimliliklar ---------------------------------------------------------

$python = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
if (-not $python) {
  Write-Host "python.exe PATH'te bulunamadi." -ForegroundColor Red
  exit 1
}

$ytdlp = (Get-Command yt-dlp -ErrorAction SilentlyContinue).Source
if (-not $ytdlp) {
  Write-Host "UYARI: yt-dlp PATH'te yok. 'pip install -U yt-dlp' ile kur." -ForegroundColor Yellow
} else {
  Write-Host "yt-dlp  : $ytdlp" -ForegroundColor Green
}

$ffmpeg = (Get-Command ffmpeg -ErrorAction SilentlyContinue).Source
if (-not $ffmpeg) {
  Write-Host "UYARI: ffmpeg yok. Video+ses birlestirilemez, YouTube'da ~720p tavan olur." -ForegroundColor Yellow
  Write-Host "       Kurmak icin:  winget install Gyan.FFmpeg" -ForegroundColor Yellow
} else {
  Write-Host "ffmpeg  : $ffmpeg" -ForegroundColor Green
}

Write-Host "python  : $python" -ForegroundColor Green

# --- launcher .bat ---------------------------------------------------------
# Chrome, Windows'ta .py dosyasini dogrudan calistiramaz; .bat sarmalayici sart.

$batPath = Join-Path $NativeDir 'ytdlp_host.bat'
$batBody = "@echo off`r`n`"$python`" `"%~dp0ytdlp_host.py`"`r`n"
[System.IO.File]::WriteAllText($batPath, $batBody, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Yazildi : $batPath"

# --- host manifest ---------------------------------------------------------

$manifest = [ordered]@{
  name            = $HostName
  description     = 'yt-dlp koprusu (Medya Indirici)'
  path            = $batPath
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
$manifestPath = Join-Path $NativeDir "$HostName.json"
# DIKKAT: PS 5.1'de -Encoding utf8 BOM ekler; Chrome'un native messaging manifest
# ayristiricisi BOM'a takilir. BOM'suz yazmak icin .NET'i dogrudan cagiriyoruz.
$json = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($manifestPath, $json, (New-Object System.Text.UTF8Encoding $false))
Write-Host "Yazildi : $manifestPath"

# --- registry --------------------------------------------------------------

New-Item -Path $RegPath -Force | Out-Null
Set-ItemProperty -Path $RegPath -Name '(Default)' -Value $manifestPath
Write-Host "Registry: $RegPath" -ForegroundColor Green

Write-Host ""
Write-Host "Kurulum tamam. chrome://extensions sayfasindan eklentiyi yenile (dairesel ok)." -ForegroundColor Cyan
Write-Host "Sonra bir YouTube/Instagram sayfasinda eklentiyi ac; ust barda yt-dlp bolumu cikacak."
