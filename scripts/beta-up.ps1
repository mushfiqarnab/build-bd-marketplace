<#
  scripts/beta-up.ps1 - start (or verify) the Build-BD beta on this PC.

    powershell -ExecutionPolicy Bypass -File scripts\beta-up.ps1
    powershell -ExecutionPolicy Bypass -File scripts\beta-up.ps1 -Probe   # also run the live QA probe

  Idempotent: anything already running is left alone. Starts
    1. the API server  (node --env-file=.env.beta server.js, hidden, log -> logs\server.log)
    2. the ngrok tunnel (reserved domain read from STORAGE_LOCAL_PUBLIC_URL in .env.beta)
  then waits until the PUBLIC URL reports ready (MongoDB + Redis + indexes).
#>
param([switch]$Probe)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

function Fail($msg) { Write-Host "[FAIL] $msg" -ForegroundColor Red; exit 1 }
function Ok($msg)   { Write-Host "[ OK ] $msg" -ForegroundColor Green }
function Info($msg) { Write-Host "[....] $msg" }

if (-not (Test-Path '.env.beta')) { Fail '.env.beta not found in the project folder.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue))  { Fail 'Node.js is not installed or not on PATH.' }
if (-not (Get-Command ngrok -ErrorAction SilentlyContinue)) { Fail 'ngrok is not installed or not on PATH.' }

# Read the public URL (and port) from .env.beta without printing any secret.
$envLines = Get-Content '.env.beta'
$publicUrl = ($envLines | Where-Object { $_ -match '^STORAGE_LOCAL_PUBLIC_URL=' }) -replace '^STORAGE_LOCAL_PUBLIC_URL=', ''
$port = ($envLines | Where-Object { $_ -match '^PORT=' }) -replace '^PORT=', ''
if (-not $port) { $port = '5000' }
if (-not $publicUrl) { Fail 'STORAGE_LOCAL_PUBLIC_URL is missing from .env.beta.' }
$domain = ([Uri]$publicUrl).Host
New-Item -ItemType Directory -Force -Path 'logs' | Out-Null

# 1. API server
$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
  Ok "API server already running on port $port (PID $($listening[0].OwningProcess))"
} else {
  Info "Starting API server on port $port ..."
  Start-Process -FilePath 'node' -ArgumentList '--env-file=.env.beta', 'server.js' `
    -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput 'logs\server.log' -RedirectStandardError 'logs\server-error.log'
  $deadline = (Get-Date).AddSeconds(45)
  do {
    Start-Sleep -Milliseconds 500
    $listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
  } until ($listening -or (Get-Date) -gt $deadline)
  if (-not $listening) { Fail "Server did not start. See logs\server-error.log" }
  Ok "API server started (PID $($listening[0].OwningProcess))"
}

# 2. ngrok tunnel
$tunnelUp = $false
try {
  $tunnels = Invoke-RestMethod -Uri 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 3
  $tunnelUp = [bool]($tunnels.tunnels | Where-Object { $_.public_url -eq "https://$domain" })
} catch { }
if ($tunnelUp) {
  Ok "ngrok tunnel already up: https://$domain"
} else {
  Info "Starting ngrok tunnel for $domain ..."
  Start-Process -FilePath 'ngrok' -ArgumentList 'http', "--domain=$domain", $port -WindowStyle Hidden
}

# 3. Wait for the PUBLIC URL to report ready (includes the index gate).
$deadline = (Get-Date).AddSeconds(90)
$ready = $null
do {
  Start-Sleep -Seconds 2
  try { $ready = Invoke-RestMethod -Uri "$publicUrl/health/readiness" -TimeoutSec 8 -Headers @{ 'User-Agent' = 'BuildBD-beta-up' } } catch { $ready = $null }
} until (($ready -and $ready.status -eq 'ready') -or (Get-Date) -gt $deadline)

if (-not ($ready -and $ready.status -eq 'ready')) { Fail "Public URL is not ready yet: $publicUrl/health/readiness" }
Ok "Beta is LIVE: $publicUrl  (mongodb=$($ready.checks.mongodb), redis=$($ready.checks.redis), indexes=$($ready.checks.indexes))"
Write-Host ''
Write-Host 'Login codes for testers:  node scripts\otp-relay.js --watch'

if ($Probe) {
  Write-Host ''
  node scripts\qa\live-probe.js $publicUrl
  exit $LASTEXITCODE
}
