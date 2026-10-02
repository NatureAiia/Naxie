@echo off
rem graphify-hook.cmd - resilient wrapper for the Claude PreToolUse hooks.
rem Tries the known interpreter first, then anything called python on PATH,
rem and ALWAYS exits 0 so a missing/broken graphify install can never
rem block a tool call. Usage: graphify-hook.cmd search|read
setlocal
set "SUB=%~1"
if "%SUB%"=="" set "SUB=search"
if exist "C:\Users\Admin\miniconda3\python.exe" (
  "C:\Users\Admin\miniconda3\python.exe" -m graphify hook-guard %SUB% 2>nul
  exit /b 0
)
where python >nul 2>&1
if %ERRORLEVEL%==0 (
  python -m graphify hook-guard %SUB% 2>nul
)
exit /b 0
