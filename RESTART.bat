@echo off
setlocal

echo.
echo  ==========================================
echo   myung-tech Agent Studio  RESTART
echo  ==========================================
echo.

echo  [1/2] Restarting backend (server + dispatcher)...
wsl bash /mnt/d/myung-tech-workspace/scripts/svc.sh restart

echo.
echo  [2/2] Verifying API health...
powershell -NoProfile -Command "try{$h=Invoke-RestMethod 'http://127.0.0.1:9000/api/health' -TimeoutSec 10; ('        server {0} / AI model {1} / KB {2}' -f $h.server.ok, $h.vllm.ok, $h.knowledge_base.ok)}catch{'        API no response'}" 2>nul

echo.
echo  ==========================================
echo   Restarted. (UI window is left untouched)
echo  ==========================================
echo.
pause
