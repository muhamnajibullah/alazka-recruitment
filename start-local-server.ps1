# Starts the local PHP backend from the project root.
# Prefer XAMPP PHP because it usually includes pdo_mysql for this project database.
$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$phpCandidates = @(
  "C:\xampp\php\php.exe",
  "C:\laragon\bin\php\php-8.2.0-Win32-vs16-x64\php.exe",
  "php"
)

$phpPath = $null
foreach ($candidate in $phpCandidates) {
  try {
    $command = Get-Command $candidate -ErrorAction Stop
    $phpPath = $command.Source
    break
  } catch {
    continue
  }
}

if (-not $phpPath) {
  throw "PHP was not found. Install XAMPP/Laragon or add PHP to PATH."
}

$modules = & $phpPath -m
if ($modules -notcontains "pdo_mysql") {
  throw "Selected PHP does not have pdo_mysql enabled: $phpPath"
}

$existingServer = Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue
if ($existingServer) {
  Write-Host "PHP server already running at http://127.0.0.1:8000"
  return
}

Start-Process -FilePath $phpPath `
  -ArgumentList "-S 127.0.0.1:8000 -t `"$projectRoot`"" `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden

Start-Sleep -Seconds 1
Write-Host "PHP server started at http://127.0.0.1:8000"
Write-Host "Open http://127.0.0.1:8000/admin_dashboard.html or keep using Live Server on port 5500."
