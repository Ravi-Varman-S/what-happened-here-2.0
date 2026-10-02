@echo off
setlocal
cd /d "%~dp0"
set "PORT=8000"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $null = Invoke-WebRequest 'http://127.0.0.1:%PORT%/api/config' -UseBasicParsing -TimeoutSec 2; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
    echo Server already running - opening http://127.0.0.1:%PORT%
    start "" "http://127.0.0.1:%PORT%"
    ping -n 4 127.0.0.1 >nul
    exit /b 0
)
call "%~dp0run.bat" %PORT%
