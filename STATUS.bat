@echo off

echo.
echo  ==========================================
echo   myung-tech Agent Studio  STATUS
echo  ==========================================
echo.

echo  [ Windows windows ]
tasklist /FI "WINDOWTITLE eq mt-server*"   2>nul | findstr "cmd.exe" > nul && echo   mt-server  : running || echo   mt-server  : stopped
tasklist /FI "WINDOWTITLE eq mt-dispatch*" 2>nul | findstr "cmd.exe" > nul && echo   mt-dispatch: running || echo   mt-dispatch: stopped
tasklist /FI "WINDOWTITLE eq mt-vite*"     2>nul | findstr "cmd.exe" > nul && echo   mt-vite    : running || echo   mt-vite    : stopped

echo.
echo  [ Ports ]
netstat -ano 2>nul | findstr ":9000 " | findstr "LISTENING" > nul && echo   9000 (API) : OPEN || echo   9000 (API) : CLOSED
netstat -ano 2>nul | findstr ":5174 " | findstr "LISTENING" > nul && echo   5174 (UI)  : OPEN || echo   5174 (UI)  : CLOSED

echo.
echo  [ HTTP check ]
powershell -NoProfile -Command "try{(Invoke-WebRequest 'http://localhost:9000/api/health' -TimeoutSec 3 -UseBasicParsing).StatusCode}catch{'no response'}" 2>nul
powershell -NoProfile -Command "try{(Invoke-WebRequest 'http://localhost:5174' -TimeoutSec 3 -UseBasicParsing).StatusCode}catch{'no response'}" 2>nul

echo.
echo  [ Last 5 lines: server.log ]
if exist "D:\myung-tech-workspace\logs\server.log" (
    powershell -NoProfile -Command "Get-Content 'D:\myung-tech-workspace\logs\server.log' -Tail 5"
) else (
    echo   no log yet
)

echo.
echo  START.bat = start  ^|  STOP.bat = stop
echo.
pause
