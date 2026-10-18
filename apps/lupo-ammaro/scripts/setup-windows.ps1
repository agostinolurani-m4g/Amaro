$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$ToolsDir = Join-Path $Root ".tools"
$Installer = Join-Path $ToolsDir "vs_buildtools.exe"
$InstallPath = Join-Path $ToolsDir "vsbuild"
$Url = "https://aka.ms/vs/17/release/vs_buildtools.exe"

Write-Host "WattLab: installazione Visual C++ Build Tools (MSVC)"
Write-Host "Serve per compilare Tauri. Puo richiedere alcuni minuti."
Write-Host ""

New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null

if (-not (Test-Path $Installer)) {
  Write-Host "Download installer..."
  Invoke-WebRequest -Uri $Url -OutFile $Installer -UseBasicParsing
}

$CargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path $CargoBin) {
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if ($userPath -notlike "*$CargoBin*") {
    [Environment]::SetEnvironmentVariable("Path", "$CargoBin;$userPath", "User")
    Write-Host "Aggiunto Cargo al PATH utente."
  }
}

$args = @(
  "--installPath", $InstallPath,
  "--add", "Microsoft.VisualStudio.Workload.VCTools",
  "--includeRecommended",
  "--quiet", "--wait", "--norestart"
)

Write-Host "Avvio installazione MSVC (UAC se richiesto)..."
$proc = Start-Process -FilePath $Installer -ArgumentList $args -Wait -PassThru -Verb RunAs

if ($proc.ExitCode -ne 0) {
  Write-Host "Installazione terminata con codice $($proc.ExitCode)."
  Write-Host "Prova manualmente: $Installer"
  exit $proc.ExitCode
}

Write-Host ""
Write-Host "Setup completato. Chiudi e riapri il terminale, poi:"
Write-Host "  npm run tauri:dev"
