@echo off
setlocal

echo.
echo  ==========================================
echo   myung-tech Agent Studio  STOP
echo  ==========================================
echo.

echo  [1/3] Stopping backend (WSL systemd)...
wsl bash -c "systemctl --user stop myungtech-server myungtech-dispatcher 2>/dev/null; pkill -f '[t]elegram_gateway' 2>/dev/null; echo ok"
echo        done.

echo  [2/3] Closing UI window...
taskkill /FI "WINDOWTITLE eq mt-vite*" /T /F > nul 2>&1
echo        done.

echo  [3/3] Releasing ports 9000 and 5174...
for %%P in (9000 5174) do (
    for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":%%P " ^| findstr "LISTENING"') do (
        echo        port %%P ^> killing PID %%a
        taskkill /PID %%a /T /F > nul 2>&1
    )
)
echo        done.

echo.
echo  ==========================================
echo   Stopped. Run START.bat to restart.
echo  ==========================================
echo.
pause
