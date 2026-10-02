@echo off
rem ===========================================================================
rem  Start What Happened Here? 2.0 - safe to double-click at any time.
rem
rem    * server already running  -> just open the browser tab
rem    * server not running      -> start it (run.bat) and open when ready
rem ===========================================================================
setlocal
cd /d "%~dp0"
set "PORT=8000"

rem --- is the server already up? --------------------------------------------
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { $null = Invoke-WebRequest 'http://127.0.0.1:%PORT%/api/config' -UseBasicParsing -TimeoutSec 2; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
    echo Server already running - opening http://127.0.0.1:%PORT%
    start "" "http://127.0.0.1:%PORT%"
    ping -n 4 127.0.0.1 >nul
    exit /b 0
)

rem --- otherwise start the server (it opens the browser when ready) ---------
call "%~dp0run.bat" %PORT%
