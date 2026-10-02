@echo off
setlocal
cd /d "%~dp0"
set "PORT=%~1"
if "%PORT%"=="" set "PORT=8000"

set "PY=python"
if "%WHH_VENV%"=="1" goto :build
python -c "import numpy, scipy, soundfile, librosa, matplotlib, tensorflow, fastapi, uvicorn" >nul 2>nul
if not errorlevel 1 goto :ready

:build
if not exist ".venv\Scripts\python.exe" (
    echo [setup] Creating virtual environment in .venv ...
    where python >nul 2>nul
    if errorlevel 1 (
        echo error: Python was not found on PATH. Install Python 3.10+ first.
        exit /b 1
    )
    python -m venv .venv
    if errorlevel 1 exit /b 1
)
set "PY=%CD%\.venv\Scripts\python.exe"

if not exist ".venv\.installed" (
    echo [setup] Installing dependencies - first run only, a few minutes ...
    "%PY%" -m pip install --upgrade pip >nul
    "%PY%" -m pip install -r requirements.txt
    if errorlevel 1 exit /b 1
    echo ok> ".venv\.installed"
)
:ready

echo Starting What Happened Here? 2.0 on http://127.0.0.1:%PORT%
echo   (press Ctrl+C to stop)
start "whh-open-ui" /b "%PY%" open_ui.py %PORT%
"%PY%" server.py %PORT%
exit /b %errorlevel%
