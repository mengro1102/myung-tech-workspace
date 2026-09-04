@echo off
setlocal EnableDelayedExpansion
title myung-tech Agent Studio - START

set "WS=D:\myung-tech-workspace"

REM  The previous version started the backend inside WSL
REM  (wsl bash /mnt/d/.../scripts/svc.sh start). From WSL it cannot reach the
REM  Windows-side Ollama (localhost:11434) or the FreeLLMAPI router
REM  (127.0.0.1:3001), so every task failed with Errno 111 - that is exactly
REM  what the 14 failed tasks were. Now everything runs natively on Windows.
REM  START.bat.bak is a copy of this file, kept as a rollback point.

echo.
echo  ==========================================
echo   myung-tech Agent Studio  START
echo  ==========================================
echo.

echo  [1/5] Ollama (port 11434)...
REM  Ollama is the last-resort backend: when the router is down every
REM  department falls back to it. Health-checking it at the end was not
REM  enough - if it is not running the fallback does not exist. Start it.
curl -s -o nul --max-time 3 http://localhost:11434/api/version && (
    echo         already running - skipped.
) || (
    if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" (
        start "mt-ollama" /min "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve
        echo         launched.
    ) else (
        echo         ollama.exe not found - local fallback unavailable.
    )
)

echo.
echo  [2/5] API server (port 9000)...
netstat -ano | findstr ":9000 " | findstr LISTENING > nul && (
    echo         already running - skipped.
) || (
    start "mt-server" /min cmd /c "cd /d %WS% && python server.py"
    echo         launched.
)

echo.
echo  [3/5] Agent dispatcher (daemon)...
REM  Without this nobody drains the task queue, so the 2D office and the live
REM  feed stay empty. Running it as a daemon is what makes the screen move.
tasklist /FI "WINDOWTITLE eq mt-dispatch*" 2>nul | findstr "cmd.exe" > nul && (
    echo         already running - skipped.
) || (
    start "mt-dispatch" /min cmd /c "cd /d %WS% && python run.py dispatch daemon"
    echo         launched.
)

echo.
echo  [4/5] UI dev server (port 5174)...
netstat -ano | findstr ":5174 " | findstr LISTENING > nul && (
    echo         already running - skipped.
) || (
    start "mt-vite" /min cmd /c "cd /d %WS%\virtual-office && npm run dev"
    echo         launched.
)

echo.
echo  [5/5] Waiting for services...
timeout /t 8 /nobreak > nul

echo.
REM  API and UI bind IPv4 loopback only. On Windows "localhost" can resolve
REM  to ::1 first, so checks against it report 000 even when both are up.
echo  --- health check ---
curl -s -o nul -w "  API    (9000) : HTTP %%{http_code}\n" http://127.0.0.1:9000/api/health
curl -s -o nul -w "  UI     (5174) : HTTP %%{http_code}\n" http://127.0.0.1:5174/
curl -s -o nul -w "  Ollama (11434): HTTP %%{http_code}\n" http://localhost:11434/api/version
curl -s -o nul -w "  Router (3001) : HTTP %%{http_code}\n" http://127.0.0.1:3001/

echo.
echo  Opening browser...
start "" "http://127.0.0.1:5174"

echo.
echo  ==========================================
echo   UI   : http://127.0.0.1:5174
echo   API  : http://127.0.0.1:9000  (this PC only - no auth)
echo   Stop : run STOP.bat
echo  ==========================================
echo.
echo  Router (3001) is shared with Mengbiseo. If it is down, departments
echo  fall back to local Ollama automatically.
echo.
pause
