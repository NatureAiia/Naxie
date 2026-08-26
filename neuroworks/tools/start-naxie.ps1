# Starts Naxie's dev stack in a visible terminal window: activates the
# NaxionAI conda env (pnpm/node live there on this machine), then runs
# `pnpm run dev` from neuroworks/ (server on :7471, web on :7470 - Vite
# auto-opens the browser to /naxie once it's up).
#
# Meant to be launched via a shortcut in the Windows Startup folder
# (shell:startup) so it runs at login. One-time prerequisite: `conda init
# powershell` must have been run previously so `conda activate` works in a
# fresh, non-interactive PowerShell session - otherwise this warns and still
# attempts pnpm dev in case pnpm is reachable on the system PATH anyway.

$repoRoot = "D:\Aiia\Systems\NaxionAI-Powered-by-Neuroworks"

Set-Location $repoRoot

try {
    conda activate NaxionAI
} catch {
    Write-Warning "conda activate NaxionAI failed - is 'conda init powershell' set up? Continuing in case pnpm is on system PATH anyway."
}

Set-Location (Join-Path $repoRoot "neuroworks")
pnpm run dev
