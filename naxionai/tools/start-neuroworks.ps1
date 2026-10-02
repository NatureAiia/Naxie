# NeuroWorks single-instance launcher - run by the "NeuroWorks Server" logon
# Scheduled Task. Ends the recurring "127.0.0.1 refused to connect":
#   - IDEMPOTENT: if the API already answers on :7471, exit (no duplicate
#     instance fighting for the port - the root cause of the crashes was 2+
#     `pnpm dev` colliding).
#   - SELF-CLEANING: kill any half-dead clawbot node procs before starting.
#   - RESTART-ON-CRASH: when `pnpm dev` exits, this script exits and the
#     Scheduled Task restart policy relaunches it. No internal spin-loop.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads .ps1 as ANSI,
# so a stray Unicode dash/bullet breaks the parser (learned the hard way).
#
# Status -> .neuroworks\launcher.log ; server stdout -> .neuroworks\devstart.log

$ErrorActionPreference = "Continue"
$repo = "D:\Aiia\Systems\NaxionAI-Powered-by-Neuroworks\naxionai"
$statusLog = Join-Path $repo ".neuroworks\launcher.log"
$devLog    = Join-Path $repo ".neuroworks\devstart.log"
New-Item -ItemType Directory -Force -Path (Split-Path $statusLog) | Out-Null
function Log($m) { try { "$(Get-Date -Format s)  $m" | Out-File -Append -Encoding utf8 $statusLog } catch {} }
Set-Location $repo

function ApiUp {
  try { return (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:7471/api/status").StatusCode -eq 200 }
  catch { return $false }
}

# Resolve pnpm. The Scheduled Task user context has PATH, but pin a fallback.
$pnpm = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
if (-not $pnpm) { $pnpm = Join-Path $env:APPDATA "npm\pnpm.cmd" }

# Wait briefly for the vault drive (mapped by mount-vault.bat at logon).
for ($i = 0; $i -lt 30 -and -not (Test-Path "D:\Main brain"); $i++) { Start-Sleep -Seconds 2 }

if (ApiUp) { Log "already running on :7471 - exiting"; exit 0 }

# Clear half-dead listeners on our ports, but ONLY if the owner is this
# repo's server (same guard as stop-always-on.ps1). A blanket "*naxionai*"
# match would also kill a healthy `pnpm dev` tree or debug session.
foreach ($port in @(7470, 7471)) {
    $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    foreach ($c in ($conns | Select-Object -Unique OwningProcess)) {
        $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
        if ($proc -and $proc.CommandLine -like "*naxionai*server*") {
            Log "clearing stale :$port owner (pid $($proc.ProcessId))"
            $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($proc.ProcessId)" -ErrorAction SilentlyContinue
            foreach ($k in $kids) { Stop-Process -Id $k.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue }
            Stop-Process -Id $proc.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue
        } elseif ($proc) {
            Log "port $port owner (pid $($proc.ProcessId), $($proc.Name)) is not this repo's server - left alone"
        }
    }
}

Log "starting 'pnpm dev' (pnpm: $pnpm)"
& $pnpm dev *>> $devLog
Log "pnpm dev exited (code $LASTEXITCODE) - Scheduled Task will relaunch"
