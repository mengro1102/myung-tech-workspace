@echo off
setlocal EnableDelayedExpansion

set "WS=D:\myung-tech-workspace"
set "LOGDIR=%WS%\logs"

if not exist "%LOGDIR%"  mkdir "%LOGDIR%"

echo.
echo  ==========================================
echo   myung-tech Agent Studio  START
echo  ==========================================
echo.

echo  [1/2] Starting backend (WSL systemd: server + dispatcher)...
wsl bash -c "systemctl --user start myungtech-server myungtech-dispatcher && systemctl --user is-active myungtech-server myungtech-dispatcher"
echo        done.

echo  [2/2] Starting UI dev server (port 5174)...
start "mt-vite" cmd /k "cd /d %WS%\virtual-office && npm run dev"
echo        done.

echo.
echo  Opening browser in 6 seconds...
timeout /t 6 /nobreak > nul
start "" "http://localhost:5174"

echo.
echo  ==========================================
echo   All services started.
echo   UI  : http://localhost:5174
echo   API : http://localhost:9000
echo   Log : wsl journalctl --user -u myungtech-server -f
echo   Stop: run STOP.bat
echo  ==========================================
echo.
pause
