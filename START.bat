@echo off
setlocal EnableDelayedExpansion
title myung-tech Agent Studio - START

set "WS=D:\myung-tech-workspace"

REM  The previous version started the backend inside WSL
REM  (wsl bash /mnt/d/.../scripts/svc.sh start). From WSL it cannot reach the
REM  Windows-side Ollama (localhost:11434) or the FreeLLMAPI router
REM  (127.0.0.1:3001), so every task failed with Errno 111 - that is exactly
REM  what the 14 failed tasks were. Now everything runs natively on Windows.
REM  The old WSL launcher is kept as START.bat.wsl-bak.

echo.
echo  ==========================================
echo   myung-tech Agent Studio  START
echo  ==========================================
echo.

echo  [1/4] API server (port 9000)...
netstat -ano | findstr ":9000 " | findstr LISTENING > nul && (
    echo         already running - skipped.
) || (
    start "mt-server" /min cmd /c "cd /d %WS% && python server.py"
    echo         launched.
)

echo.
echo  [2/4] Agent dispatcher (daemon)...
REM  Without this nobody drains the task queue, so the 2D office and the live
REM  feed stay empty. Running it as a daemon is what makes the screen move.
tasklist /FI "WINDOWTITLE eq mt-dispatch*" 2>nul | findstr "cmd.exe" > nul && (
    echo         already running - skipped.
) || (
    start "mt-dispatch" /min cmd /c "cd /d %WS% && python run.py dispatch daemon"
    echo         launched.
)

echo.
echo  [3/4] UI dev server (port 5174)...
netstat -ano | findstr ":5174 " | findstr LISTENING > nul && (
    echo         already running - skipped.
) || (
    start "mt-vite" /min cmd /c "cd /d %WS%\virtual-office && npm run dev"
    echo         launched.
)

echo.
echo  [4/4] Waiting for services...
timeout /t 8 /nobreak > nul

echo.
echo  --- health check ---
curl -s -o nul -w "  API    (9000) : HTTP %%{http_code}\n" http://localhost:9000/api/health
curl -s -o nul -w "  UI     (5174) : HTTP %%{http_code}\n" http://localhost:5174/
curl -s -o nul -w "  Ollama (11434): HTTP %%{http_code}\n" http://localhost:11434/api/version
curl -s -o nul -w "  Router (3001) : HTTP %%{http_code}\n" http://127.0.0.1:3001/

echo.
echo  Opening browser...
start "" "http://localhost:5174"

echo.
echo  ==========================================
echo   UI   : http://localhost:5174
echo   API  : http://localhost:9000
echo   Stop : run STOP.bat
echo  ==========================================
echo.
echo  Router (3001) is shared with Mengbiseo. If it is down, departments
echo  fall back to local Ollama automatically.
echo.
pause
