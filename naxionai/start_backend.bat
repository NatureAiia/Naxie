@echo off
echo ================================================
echo  NAXIONAI -- Backend Launcher
echo ================================================
echo.

:: CONDA_ENV_NAME must match an existing `conda env list` entry.
set CONDA_ENV_NAME=Neuroworks_NaxionAI
set BACKEND_DIR=%~dp0backend

echo [1/2] Checking for missing packages in conda env %CONDA_ENV_NAME%...
call conda run -n %CONDA_ENV_NAME% pip install -q -r "%BACKEND_DIR%\requirements.txt"
echo Done.

echo [2/2] Starting FastAPI backend on port 8000...
echo.
cd /d "%BACKEND_DIR%"
call conda run --no-capture-output -n %CONDA_ENV_NAME% python main.py
