@echo off

echo.
echo  ==========================================
echo   myung-tech Agent Studio  STATUS
echo  ==========================================
echo.

echo  [ Backend (WSL) ]
wsl bash /mnt/d/myung-tech-workspace/scripts/svc.sh status

echo.
echo  [ UI window ]
tasklist /FI "WINDOWTITLE eq mt-vite*" 2>nul | findstr "cmd.exe" > nul && echo         mt-vite                : running || echo         mt-vite                : stopped

echo.
echo  [ Ports ]
netstat -ano 2>nul | findstr ":9000 " | findstr "LISTENING" > nul && echo         9000 (API)             : OPEN || echo         9000 (API)             : CLOSED
netstat -ano 2>nul | findstr ":5174 " | findstr "LISTENING" > nul && echo         5174 (UI)              : OPEN || echo         5174 (UI)              : CLOSED

echo.
echo  [ Service health ]
powershell -NoProfile -Command "try{$h=Invoke-RestMethod 'http://localhost:9000/api/health' -TimeoutSec 10; ('        server   : {0}' -f $h.server.ok); ('        AI model : {0}  {1}' -f $h.vllm.ok, $h.vllm.host); ('        KB       : {0}  {1}' -f $h.knowledge_base.ok, $h.knowledge_base.path); ('        tasks    : pending {0} / running {1} / done {2} / failed {3}' -f $h.tasks.pending, $h.tasks.in_progress, $h.tasks.done, $h.tasks.failed)}catch{'        API no response'}" 2>nul

echo.
echo  [ Last 5 log lines ]
wsl bash /mnt/d/myung-tech-workspace/scripts/svc.sh logs 5

echo.
echo  START = start  ^|  RESTART = restart  ^|  STOP = stop
echo.
pause
