@echo off
setlocal
title myung-tech Agent Studio - STATUS

REM  Windows-native, matching START.bat / STOP.bat / RESTART.bat.
REM
REM  The old version asked `wsl bash .../svc.sh status`, which runs pgrep
REM  inside WSL. Since the services moved to Windows it could not see them
REM  and reported "inactive" for everything while the studio was running -
REM  a status screen that is wrong is worse than none. STATUS.bat.wsl.bak
REM  keeps the old file.

echo.
echo  ==========================================
echo   myung-tech Agent Studio  STATUS
echo  ==========================================
echo.

echo  [ Processes ]
REM  Match on the command line, not the window title: a service started from
REM  a terminal (or by the watchdog) has no matching title but is running.
wmic process where "name='python.exe'" get commandline 2>nul | findstr /C:"server.py" > nul && echo         mt-server             : running || echo         mt-server             : stopped
wmic process where "name='python.exe'" get commandline 2>nul | findstr /C:"dispatch daemon" > nul && echo         mt-dispatch           : running || echo         mt-dispatch           : stopped
wmic process where "name='python.exe'" get commandline 2>nul | findstr /C:"telegram_gateway.py" > nul && echo         mt-telegram           : running || echo         mt-telegram           : stopped
REM  Vite by port, not by window title: npm spawns node as a child, so the
REM  title check said "stopped" while 5174 was serving the UI.
netstat -ano 2>nul | findstr ":5174 " | findstr "LISTENING" > nul && echo         mt-vite               : running || echo         mt-vite               : stopped

echo.
echo  [ Ports ]
netstat -ano 2>nul | findstr ":9000 " | findstr "LISTENING" > nul && echo         9000 (API)             : OPEN || echo         9000 (API)             : CLOSED
netstat -ano 2>nul | findstr ":5174 " | findstr "LISTENING" > nul && echo         5174 (UI)              : OPEN || echo         5174 (UI)              : CLOSED
netstat -ano 2>nul | findstr ":3001 " | findstr "LISTENING" > nul && echo         3001 (router)          : OPEN || echo         3001 (router)          : CLOSED
netstat -ano 2>nul | findstr ":11434 " | findstr "LISTENING" > nul && echo         11434 (Ollama)         : OPEN || echo         11434 (Ollama)         : CLOSED

echo.
echo  [ Service health ]
powershell -NoProfile -Command "try{$h=Invoke-RestMethod 'http://127.0.0.1:9000/api/health' -TimeoutSec 10; ('        server   : {0}' -f $h.server.ok); ('        AI model : {0}  {1}' -f $h.vllm.ok, $h.vllm.host); ('        KB       : {0}  {1}' -f $h.knowledge_base.ok, $h.knowledge_base.path); ('        tasks    : pending {0} / running {1} / done {2} / failed {3}' -f $h.tasks.pending, $h.tasks.in_progress, $h.tasks.done, $h.tasks.failed)}catch{'        API no response'}" 2>nul

echo.
echo  [ Watchdog ]
REM  Registered as a scheduled task; it revives dead services every 5 minutes.
schtasks /query /tn "MyungTech-Watchdog" /fo list 2>nul | findstr /C:"Status" /C:"Next Run" /C:"상태" /C:"다음 실행"
if errorlevel 1 echo         not registered

echo.
echo  [ Last 5 watchdog lines ]
powershell -NoProfile -Command "$p='D:\myung-tech-workspace\logs\watchdog.log'; if(Test-Path $p){Get-Content $p -Tail 5 | ForEach-Object {'        ' + $_}}else{'        no log yet'}" 2>nul

echo.
echo  START = start  ^|  RESTART = restart  ^|  STOP = stop
echo.
pause
