@echo off
setlocal

echo.
echo  ==========================================
echo   myung-tech Agent Studio  STOP
echo  ==========================================
echo.

echo  [1/3] Stopping backend (server + dispatcher)...
wsl bash /mnt/d/myung-tech-workspace/scripts/svc.sh stop

echo.
echo  [2/3] Closing UI window...
taskkill /FI "WINDOWTITLE eq mt-vite*" /T /F > nul 2>&1
echo         done.

echo.
echo  [3/3] Releasing ports 9000 and 5174...
for %%P in (9000 5174) do (
    for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":%%P " ^| findstr "LISTENING"') do (
        echo         port %%P ^> killing PID %%a
        taskkill /PID %%a /T /F > nul 2>&1
    )
)
echo         done.

echo.
echo  ==========================================
echo   Stopped. Run START.bat to restart.
echo  ==========================================
echo.
pause
