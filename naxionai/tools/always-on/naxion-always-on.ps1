# neuroworks-always-on.ps1 - keeps the NeuroWorks server (live chat + agents)
# running at http://127.0.0.1:7470 at all times.
#
# Behaviour:
#   - Launched hidden at logon by neuroworks-always-on.vbs (Startup folder).
#   - Restores the D: vault subst mapping first (same logic as mount-vault.bat)
#     so the server never boots without its vault.
#   - Runs the server in production single-port mode (SERVE_WEB=1, port 7470):
#     one process serves both the API and the built web UI, so chat lives at
#     the same URL the dev stack used.
#   - If the server process exits, it is restarted after a 10s backoff.
#   - If ANYTHING else already listens on 7470 (e.g. you started `pnpm dev`
#     manually), the watchdog idles and re-checks every 30s - it never fights
#     for the port. Stop your dev stack and it takes over within 30s.
#   - Singleton: a lock file with the watchdog PID prevents double watchdogs.
#
# Stop everything: tools\always-on\stop-always-on.ps1

$root      = "D:\Aiia\Systems\NaxionAI-Powered-by-Neuroworks\naxionai"
$serverDir = Join-Path $root "server"
$stateDir  = Join-Path $serverDir ".neuroworks"
$logFile   = Join-Path $stateDir "always-on.log"
$lockFile  = Join-Path $stateDir "always-on.lock"
$port      = 7470

function Write-Log([string]$msg) {
    try {
        if ((Test-Path $logFile) -and ((Get-Item $logFile).Length -gt 2MB)) {
            Clear-Content $logFile
        }
        "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File -FilePath $logFile -Append -Encoding utf8
    } catch {}
}

# ── Singleton guard ────────────────────────────────────────────────────
if (Test-Path $lockFile) {
    $oldPid = (Get-Content $lockFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($oldPid -match '^\d+$') {
        $existing = Get-Process -Id ([int]$oldPid) -ErrorAction SilentlyContinue
        if ($existing -and $existing.ProcessName -like "powershell*") {
            exit 0
        }
    }
}
$PID | Set-Content $lockFile -Encoding ascii

# ── Vault mount (mirror of Startup\mount-vault.bat) ────────────────────
if (-not (Test-Path "C:\vault-root")) { New-Item -ItemType Directory -Force "C:\vault-root" | Out-Null }
if (-not (Test-Path "D:\")) { subst D: "C:\vault-root" 2>$null | Out-Null }

Write-Log "watchdog started (pid $PID)"

# ── Supervision loop ───────────────────────────────────────────────────
$env:NAXION_PORT = "$port"
$env:SERVE_WEB       = "1"

while ($true) {
    $busy = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($busy) {
        Start-Sleep -Seconds 30
        continue
    }

    Write-Log "port $port free - starting neuroworks server (SERVE_WEB=1)"
    try {
        $p = Start-Process -FilePath "C:\Program Files\nodejs\npm.cmd" `
            -ArgumentList "start" `
            -WorkingDirectory $serverDir `
            -WindowStyle Hidden `
            -PassThru `
            -RedirectStandardOutput (Join-Path $stateDir "always-on.server.out.log") `
            -RedirectStandardError  (Join-Path $stateDir "always-on.server.err.log")
        $p.WaitForExit()
        Write-Log "server exited (code $($p.ExitCode)) - restart in 10s"
    } catch {
        Write-Log "failed to start server: $($_.Exception.Message) - retry in 10s"
    }
    Start-Sleep -Seconds 10
}
