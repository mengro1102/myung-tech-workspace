@echo off
setlocal EnableDelayedExpansion

set "WS=D:\myung-tech-workspace"

echo.
echo  ==========================================
echo   myung-tech Agent Studio  START
echo  ==========================================
echo.

echo  [1/2] Starting backend (server + dispatcher)...
wsl bash /mnt/d/myung-tech-workspace/scripts/svc.sh start

echo.
echo  [2/2] Starting UI dev server (port 5174)...
tasklist /FI "WINDOWTITLE eq mt-vite*" 2>nul | findstr "cmd.exe" > nul && (
    echo         already running - skipped.
) || (
    start "mt-vite" cmd /k "cd /d %WS%\virtual-office && npm run dev"
    echo         launched.
)

echo.
echo  Opening browser in 6 seconds...
timeout /t 6 /nobreak > nul
start "" "http://localhost:5174"

echo.
echo  ==========================================
echo   All services started.
echo   UI  : http://localhost:5174
echo   API : http://localhost:9000
echo   Stop: run STOP.bat
echo  ==========================================
echo.
pause
