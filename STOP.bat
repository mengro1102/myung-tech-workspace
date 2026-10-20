@echo off
setlocal
title myung-tech Agent Studio - STOP

REM  Windows-native counterpart of START.bat. The WSL version is kept as
REM  STOP.bat.bak. Ollama is NOT stopped here - it is shared with
REM  Mengbiseo; use the Mengbiseo desktop folder to release VRAM.

echo.
echo  ==========================================
echo   myung-tech Agent Studio  STOP
echo  ==========================================
echo.

set "WS=D:\myung-tech-workspace"

REM  Tell the watchdog to stand down. Without this it revives everything
REM  5 minutes later and the studio looks like it refuses to stay off.
if not exist "%WS%\logs" mkdir "%WS%\logs" 2>nul
echo stopped-by-user > "%WS%\logs\watchdog.stop"

echo  [1/3] Closing service windows...
REM  서비스는 이제 창 없이 뜬다(runbg.vbs). 창 제목이 없으니 제목으로는
REM  찾을 수 없다 - 명령줄로 찾아 죽인다. 제목 방식도 남겨 둔다: 예전
REM  방식으로 띄운 것이 아직 떠 있을 수 있다.
for %%W in (mt-server mt-dispatch mt-vite mt-telegram) do (
    taskkill /FI "WINDOWTITLE eq %%W*" /T /F > nul 2>&1
)
REM  명령줄로 찾아 끝낸다. 자세한 사정은 kill-by-cmdline.ps1 머리말에.
powershell -NoProfile -ExecutionPolicy Bypass -File "%WS%\scripts\kill-by-cmdline.ps1" -Patterns "server.py;dispatch daemon;telegram_gateway.py"
REM  Vite 는 node 로 돈다. 명령줄에 vite 가 안 보이는 경우가 있어 포트로
REM  주인을 찾는 편이 확실하다.
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":5174 " ^| findstr LISTENING') do (
    taskkill /PID %%a /T /F > nul 2>&1
)
echo         done.

echo.
echo  [2/3] Stopping any dispatcher daemon left behind...
REM  The daemon polls forever, so a stray one keeps draining the queue after
REM  a stop. Match it by command line rather than window title.
powershell -NoProfile -ExecutionPolicy Bypass -File "%WS%\scripts\kill-by-cmdline.ps1" -Patterns "dispatch daemon;dispatch"
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
REM  A parent launcher sets MT_NOPAUSE=1 to skip this pause.
if not "%MT_NOPAUSE%"=="1" pause
