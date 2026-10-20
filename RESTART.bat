@echo off
setlocal
title myung-tech Agent Studio - RESTART

REM  Windows-native, matching START.bat / STOP.bat.
REM
REM  The previous version called `wsl bash .../scripts/svc.sh restart` and was
REM  left behind when the other scripts moved off WSL. Two things went wrong
REM  with it: svc.sh looks for the processes with pgrep INSIDE WSL, so it
REM  never saw the Windows-side ones and always reported "not running"; and
REM  what it then started lived in WSL, where localhost:11434 (Ollama) and
REM  127.0.0.1:3001 (router) are unreachable - the Errno 111 task failures
REM  START.bat warns about. RESTART.bat.wsl.bak keeps the old file.
REM
REM  Restarts the backend only. The UI dev server (mt-vite) hot-reloads and
REM  the browser tab survives, so leaving it alone is less disruptive.
REM  Ollama is shared with Mengbiseo and is never touched here.

set "WS=D:\myung-tech-workspace"

echo.
echo  ==========================================
echo   myung-tech Agent Studio  RESTART
echo  ==========================================
echo.

REM  A restart is a deliberate start - clear the watchdog stand-down flag.
del /q "%WS%\logs\watchdog.stop" 2>nul

echo  [1/4] Closing backend windows...
REM  창 없이 뜨므로 제목으로는 못 찾는다. 명령줄로 찾아 죽인다.
for %%W in (mt-server mt-dispatch mt-telegram) do (
    taskkill /FI "WINDOWTITLE eq %%W*" /T /F > nul 2>&1
)
REM  명령줄로 찾아 끝낸다. 자세한 사정은 kill-by-cmdline.ps1 머리말에.
powershell -NoProfile -ExecutionPolicy Bypass -File "%WS%\scripts\kill-by-cmdline.ps1" -Patterns "server.py;telegram_gateway.py"

REM  The daemon polls forever, so a stray one keeps draining the queue and
REM  spending quota alongside the new one. Match it by command line, not by
REM  window title - a daemon started from a terminal has no matching title.
powershell -NoProfile -ExecutionPolicy Bypass -File "%WS%\scripts\kill-by-cmdline.ps1" -Patterns "dispatch daemon;dispatch"
echo         done.

echo.
echo  [2/4] Waiting for ports to be released...
REM  Without this the new server can lose the race for 9000 and exit at once.
REM  ping, not `timeout`: timeout aborts with "Input redirection is not
REM  supported" when this runs from a script or scheduled task instead of a
REM  console - and then it does not wait at all, which is the whole point.
ping -n 4 127.0.0.1 > nul

echo.
echo  [3/4] Starting backend...
wscript //nologo "%WS%\scripts\runbg.vbs" "cmd /c cd /d %WS% && python -u server.py >> logs\server.log 2>&1"
wscript //nologo "%WS%\scripts\runbg.vbs" "cmd /c cd /d %WS% && python -u run.py dispatch daemon >> logs\dispatch.log 2>&1"
REM  -u + 로그 리다이렉트: 예전에는 창에만 찍혀서, 게이트웨이가 죽으면
REM  이유가 아무 데도 남지 않았다. 버퍼링을 끄지 않으면 로그가 비어 보인다.
if not exist "%WS%\logs" mkdir "%WS%\logs"
REM  --- Myung-Tech's own Telegram bot: OFF by design ---
REM  The boss works in the Mengbiseo window, which now has /결재 through
REM  the myungtech-approvals skill. Running a second bot here meant two
REM  notifications for one event and approvals split across two chats.
REM  Nothing is deleted: telegram_gateway.py still works. To bring it
REM  back, remove the REM from the start line below.
REM start "mt-telegram" /min cmd /c "cd /d %WS% && python -u telegram_gateway.py >> logs\telegram.log 2>&1"
ping -n 9 127.0.0.1 > nul
echo         launched.

echo.
echo  [4/4] Verifying...
REM  127.0.0.1, not localhost: on Windows localhost can resolve to ::1 first
REM  and the check reports failure even though the service is up on IPv4.
powershell -NoProfile -Command "try{$h=Invoke-RestMethod 'http://127.0.0.1:9000/api/health' -TimeoutSec 10; ('        server {0} / AI model {1} / KB {2}' -f $h.server.ok, $h.vllm.ok, $h.knowledge_base.ok)}catch{'        API no response - see the mt-server window'}" 2>nul

powershell -NoProfile -Command "if (Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | Where-Object { $_.CommandLine -like '*dispatch daemon*' }) { exit 0 } else { exit 1 }" && (
    echo         dispatcher running
) || (
    echo         dispatcher NOT running - see the mt-dispatch window
)

echo.
echo  ==========================================
echo   Restarted.  ^(UI window is left untouched^)
echo  ==========================================
echo.
REM  A parent launcher sets MT_NOPAUSE=1 to skip this pause.
if not "%MT_NOPAUSE%"=="1" pause
