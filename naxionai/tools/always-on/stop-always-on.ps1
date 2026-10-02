# stop-always-on.ps1 - stops the always-on watchdog AND the server it runs.
# Safe: only kills the port-7470 owner if its command line points at this
# repo's server (never a Vite dev server or unrelated process).

$root     = "D:\Aiia\Systems\NaxionAI-Powered-by-Neuroworks\naxionai"
$stateDir = Join-Path $root "server\.neuroworks"
$lockFile = Join-Path $stateDir "always-on.lock"
$port     = 7470

# 1. Kill the watchdog so it doesn't respawn the server.
if (Test-Path $lockFile) {
    $watchPid = (Get-Content $lockFile -ErrorAction SilentlyContinue | Select-Object -First 1)
    if ($watchPid -match '^\d+$') {
        $wp = Get-Process -Id ([int]$watchPid) -ErrorAction SilentlyContinue
        if ($wp -and $wp.ProcessName -like "powershell*") {
            Stop-Process -Id $wp.Id -Force -Confirm:$false
            Write-Host "watchdog (pid $($wp.Id)) stopped"
        }
    }
    Remove-Item $lockFile -Force -Confirm:$false -ErrorAction SilentlyContinue
}

# 2. Kill the supervised server tree (npm -> node tsx) if it owns the port.
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
foreach ($c in ($conns | Select-Object -Unique OwningProcess)) {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($c.OwningProcess)" -ErrorAction SilentlyContinue
    if ($proc -and $proc.CommandLine -match [regex]::Escape("naxionai\server")) {
        # Kill the whole tree: parents first is unreliable, so take children too.
        $kids = Get-CimInstance Win32_Process -Filter "ParentProcessId=$($proc.ProcessId)" -ErrorAction SilentlyContinue
        foreach ($k in $kids) { Stop-Process -Id $k.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue }
        Stop-Process -Id $proc.ProcessId -Force -Confirm:$false -ErrorAction SilentlyContinue
        Write-Host "server (pid $($proc.ProcessId)) stopped"
    } elseif ($proc) {
        Write-Host "port $port owner (pid $($proc.ProcessId), $($proc.Name)) is NOT the always-on server - left alone"
    }
}
Write-Host "done"
