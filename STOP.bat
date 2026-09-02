@echo off
setlocal
title myung-tech Agent Studio - STOP

REM  Windows-native counterpart of START.bat. The WSL version is kept as
REM  STOP.bat.wsl-bak. Ollama is NOT stopped here - it is shared with
REM  Mengbiseo; use the Mengbiseo desktop folder to release VRAM.

echo.
echo  ==========================================
echo   myung-tech Agent Studio  STOP
echo  ==========================================
echo.

echo  [1/3] Closing service windows...
for %%W in (mt-server mt-dispatch mt-vite) do (
    taskkill /FI "WINDOWTITLE eq %%W*" /T /F > nul 2>&1
)
echo         done.

echo.
echo  [2/3] Stopping any dispatcher daemon left behind...
REM  The daemon polls forever, so a stray one keeps draining the queue after
REM  a stop. Match it by command line rather than window title.
for /f "tokens=2 delims=," %%a in ('wmic process where "name='python.exe'" get processid^,commandline /format:csv 2^>nul ^| findstr "dispatch"') do (
    taskkill /PID %%a /T /F > nul 2>&1
)
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
echo   (Ollama and the router are left running -
echo    they are shared with Mengbiseo.)
echo  ==========================================
echo.
pause
