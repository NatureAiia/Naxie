# Starts Naxie's dev stack in a visible terminal window: activates the
# NaxionAI conda env (pnpm/node live there on this machine), then runs
# `pnpm run dev` from neuroworks/ (server on :7471, web on :7470 - Vite
# auto-opens the browser to /naxie once it's up). Also starts the separate
# naxionai/backend (FastAPI/Python) service in its own window - the
# Connectors page's "Personal accounts" Google/Microsoft connect flow
# (NaxiePersonalConnectors.tsx -> lib/naxieApi.ts -> /naxie-api/* -> this
# service, see vite.config.ts's proxy) still depends on it; it has not yet
# been migrated to the native lib/oauth-connectors.ts port, so this stays
# in the boot sequence until that migration happens.
#
# Meant to be launched via a shortcut in the Windows Startup folder
# (shell:startup) so it runs at login. One-time prerequisite: `conda init
# powershell` must have been run previously so `conda activate` works in a
# fresh, non-interactive PowerShell session - otherwise this warns and still
# attempts pnpm dev in case pnpm is reachable on the system PATH anyway.

$repoRoot = "D:\Aiia\Systems\NaxionAI-Powered-by-Neuroworks"

Set-Location $repoRoot

# naxionai/backend runs on the SYSTEM Python (C:\Python314), not the
# NaxionAI conda env - the conda env has no python.exe/packages installed
# (see memory: dev_environment_python). Launched in its own visible window,
# detached, so it doesn't block this script from reaching pnpm dev below.
$naxionaiPython = "C:\Python314\python.exe"
$naxionaiBackend = Join-Path $repoRoot "naxionai\backend"
if (Test-Path $naxionaiPython) {
    Start-Process powershell -ArgumentList "-NoExit", "-Command", "Set-Location '$naxionaiBackend'; & '$naxionaiPython' run_server.py"
} else {
    Write-Warning "System Python not found at $naxionaiPython - naxionai/backend (Google/Microsoft connect) will not start. Adjust the path in start-naxie.ps1 if Python lives elsewhere."
}

try {
    conda activate NaxionAI
} catch {
    Write-Warning "conda activate NaxionAI failed - is 'conda init powershell' set up? Continuing in case pnpm is on system PATH anyway."
}

Set-Location (Join-Path $repoRoot "neuroworks")
pnpm run dev
