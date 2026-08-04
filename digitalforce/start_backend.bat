@echo off
echo ================================================
echo  NaxionAI -- Backend Launcher
echo ================================================
echo.

cd /d "%~dp0backend"

echo [1/2] Activating conda environment (Neuroworks_NaxionAI)...
call conda activate Neuroworks_NaxionAI
if errorlevel 1 (
    echo Could not activate conda env "Neuroworks_NaxionAI". Create it first with:
    echo   conda create -n Neuroworks_NaxionAI python=3.12
    echo   conda activate Neuroworks_NaxionAI
    echo   pip install -r requirements.txt
    exit /b 1
)
echo Done.

echo [2/2] Starting FastAPI backend on port 8000...
echo (Uses run_server.py, NOT raw uvicorn --reload — it patches the Windows
echo  event loop policy so Playwright/Ghost Browser survives dev auto-reload.)
echo.
python run_server.py
