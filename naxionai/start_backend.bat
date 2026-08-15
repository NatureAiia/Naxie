@echo off
echo ================================================
echo  NAXIONAI -- Backend Launcher
echo ================================================
echo.

:: Force ALL build/temp/rust paths to D: drive
set TEMP=D:\tmp
set TMP=D:\tmp
set PIP_CACHE_DIR=D:\pip-cache
mkdir D:\tmp 2>nul

echo [1/3] Activating virtual environment...
call "d:\KASHIRI BRIGHTON\BUSINESS\AiiA\NAXIONAI\backend\venv\Scripts\activate.bat"
echo Done.

echo [2/3] Checking for missing packages...
"d:\KASHIRI BRIGHTON\BUSINESS\AiiA\NAXIONAI\backend\venv\Scripts\pip.exe" install --no-cache-dir --only-binary=:all: -q -r "d:\KASHIRI BRIGHTON\BUSINESS\AiiA\NAXIONAI\backend\requirements.txt"
echo Done.

echo [3/3] Starting FastAPI backend on port 8000...
echo.
cd /d "d:\KASHIRI BRIGHTON\BUSINESS\AiiA\NAXIONAI\backend"
"d:\KASHIRI BRIGHTON\BUSINESS\AiiA\NAXIONAI\backend\venv\Scripts\uvicorn.exe" main:app --host 0.0.0.0 --port 8000 --reload
