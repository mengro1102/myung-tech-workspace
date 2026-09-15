@echo off
setlocal EnableDelayedExpansion
title myung-tech Agent Studio - REMOTE ACCESS

REM  Opens the studio from outside this PC, over Tailscale.
REM
REM  Two modes, both free and both on a real HTTPS address that Tailscale
REM  issues for you (https://<machine>.<tailnet>.ts.net) - no domain to buy.
REM
REM    serve  (default)  tailnet only. Reachable from any country, any
REM                      network, but only from devices signed into the same
REM                      Tailscale account. The network IS the login, so no
REM                      password is needed.
REM
REM    funnel (REMOTE.bat funnel)  the whole public internet. Same address,
REM                      opens in any browser with no client installed. That
REM                      is the only way to use a borrowed PC - and it means
REM                      anyone who guesses the URL lands on our door, so
REM                      this script refuses to start it until
REM                      MYUNGTECH_ACCESS_KEY is set in .env.
REM
REM  Either way `tailscale` connects to 127.0.0.1:9000 from THIS machine, so
REM  the server keeps its loopback bind and no firewall port is opened.

set "WS=D:\myung-tech-workspace"
set "TS=%ProgramFiles%\Tailscale\tailscale.exe"
if not exist "%TS%" set "TS=%ProgramFiles(x86)%\Tailscale\tailscale.exe"

set "MODE=%~1"
if /i "%MODE%"=="" set "MODE=serve"
if /i not "%MODE%"=="serve" if /i not "%MODE%"=="funnel" (
    echo  Usage: REMOTE.bat [serve^|funnel]
    pause
    exit /b 1
)

echo.
echo  ==========================================
echo   myung-tech  REMOTE ACCESS  ^(%MODE%^)
echo  ==========================================
echo.

echo  [1/6] Tailscale installed?
if not exist "%TS%" (
    echo         NOT installed.
    echo.
    echo         1. https://tailscale.com/download/windows  ^-^> install
    echo         2. Sign in ^(a Gmail account is fine - it puts you on the
    echo            free Personal plan^)
    echo         3. Install Tailscale on the phone too, same account
    echo         4. Run this file again
    echo.
    pause
    exit /b 1
)
echo         found.

echo.
echo  [2/6] Signed in?
"%TS%" status > nul 2>&1
if errorlevel 1 (
    echo         NOT signed in.  Run once:   "%TS%" up
    echo.
    pause
    exit /b 1
)
echo         yes.

echo.
echo  [3/6] Access key ^(only required for funnel^)
findstr /b /c:"MYUNGTECH_ACCESS_KEY=" "%WS%\.env" > nul 2>&1
if errorlevel 1 (
    if /i "%MODE%"=="funnel" (
        echo         MISSING - refusing to publish.
        echo.
        echo         funnel puts this on the public internet, and this server
        echo         approves YouTube uploads and can rewrite .env. Add a line
        echo         to %WS%\.env first:
        echo.
        echo             MYUNGTECH_ACCESS_KEY="a-long-passphrase"
        echo.
        echo         then RESTART.bat, then run this again.
        echo.
        pause
        exit /b 1
    )
    echo         not set - fine for serve ^(tailnet only^).
) else (
    echo         set.
)

echo.
echo  [4/6] Is the built screen up to date?
REM  Port 9000 serves virtual-office\dist, NOT the live Vite dev server. If
REM  the UI source changed after the last build, the phone would quietly show
REM  an old screen - the kind of bug that wastes an afternoon.
powershell -NoProfile -Command ^
  "$src = Get-ChildItem '%WS%\virtual-office\src' -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1;" ^
  "$dist = Get-Item '%WS%\virtual-office\dist\index.html' -ErrorAction SilentlyContinue;" ^
  "if (-not $dist) { exit 2 } elseif ($src -and $src.LastWriteTime -gt $dist.LastWriteTime) { exit 2 } else { exit 0 }"
if errorlevel 2 (
    echo         stale - rebuilding...
    pushd "%WS%\virtual-office"
    call npm run build
    popd
) else (
    echo         up to date.
)

echo.
echo  [5/6] Is the API server running?
netstat -ano 2>nul | findstr ":9000 " | findstr LISTENING > nul
if errorlevel 1 (
    echo         port 9000 is closed - run START.bat first.
    echo.
    pause
    exit /b 1
)
echo         listening.

echo.
echo  [6/6] Publishing ^(%MODE%^)...
REM  Idempotent: re-running just re-states the same mapping. Public port must
REM  be 443/8443/10000 for funnel; 443 maps to our local 9000.
REM
REM  The first run almost always stops here with "Serve is not enabled on your
REM  tailnet" - Serve and Funnel are tailnet policy capabilities that are off
REM  by default. Tailscale prints a one-click consent link with the node id in
REM  it; that link IS the fix, so show it rather than a generic message.
"%TS%" %MODE% --bg --https=443 localhost:9000
if errorlevel 1 (
    echo.
    echo         FAILED - read the message just above.
    echo.
    echo         "%MODE% is not enabled on your tailnet"
    echo             ^-^> open the https://login.tailscale.com/f/... link it
    echo                printed, approve, then run this file again.
    echo.
    echo         "cannot provision TLS cert" / certificate errors
    echo             ^-^> admin console ^-^> DNS ^-^> turn on MagicDNS and
    echo                HTTPS Certificates, then run this file again.
    echo.
    pause
    exit /b 1
)

echo.
echo  ==========================================
echo   Address:
echo  ==========================================
"%TS%" %MODE% status
echo.
if /i "%MODE%"=="funnel" (
    echo   PUBLIC. Anyone with the URL reaches the login page.
    echo   Stop sharing:   "%TS%" funnel reset
) else (
    echo   Tailnet only. Turn Tailscale on the phone and open the URL.
    echo   Stop sharing:   "%TS%" serve reset
)
echo.
echo   This PC must stay awake - sleep means no access.
echo.
pause
