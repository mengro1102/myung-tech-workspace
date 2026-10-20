<#
  명령줄로 프로세스를 찾아 끝낸다.

  왜 이 파일이 생겼나. STOP.bat 과 RESTART.bat 은 이렇게 찾고 있었다.

      for /f "tokens=2 delims=," %%a in ('wmic process ... get processid^,commandline
                                          /format:csv ^| findstr /C:"server.py"') do
          taskkill /PID %%a /T /F > nul 2>&1

  `wmic /format:csv` 는 열을 **알파벳 순으로** 내보낸다 — Node, CommandLine,
  ProcessId. 그래서 `tokens=2` 가 집는 것은 PID 가 아니라 **명령줄**이었고,
  실제로 실행된 것은 `taskkill /PID python  -u server.py` 였다. 실패는
  `> nul 2>&1` 에 삼켜졌고, 배치는 그다음 줄에서 "done." 을 찍었다.

  창 제목으로도 못 찾는다 — 작업 표시줄에 cmd 가 뜨는 게 불편하다는 말씀에
  따라 runbg.vbs 로 창 없이 띄우도록 바꿨고, 창이 없으면 제목도 없다.

  두 경로가 다 죽어 있었으므로 **종료와 재시작이 아무것도 끝내지 못한 채
  성공 배너를 찍고 있었다.** cmd 창을 못 보시는 상황에서는 이게 보이지 않는다.

  CIM 으로 바꾼다. 맹비서 쪽 gw-control.ps1 과 stack_status.py 가 같은 일에
  이미 쓰는 방식이다 — "프로세스의 신분은 PID 파일이나 창 제목이 아니라
  명령줄" 이라는 같은 결론에 두 번 도달했다.

  용례:
      powershell -NoProfile -ExecutionPolicy Bypass -File kill-by-cmdline.ps1 ^
          -Patterns "server.py;dispatch daemon" -Exe python.exe
#>
param(
    # 세미콜론으로 구분한 패턴 목록. 배열이 아니라 문자열 하나를 받는다.
    #
    # 처음엔 [string[]] 로 두고 cmd 에서 -Patterns "a","b" 로 불렀다. 그러면
    # powershell -File 은 그걸 배열이 아니라 **문자열 하나** "a,b" 로 받는다.
    # 그래서 -like "*a,b*" 가 되어 아무것도 안 걸렸고, 스크립트는 "nothing to
    # kill" 을 찍었다 — 고치려던 버그와 똑같이 조용히 실패한 것이다.
    # 공백으로 띄우면 두 번째 값이 다음 위치 매개변수(-Exe)로 흘러 들어간다.
    # 구분자를 직접 정하는 쪽만이 cmd·PowerShell 양쪽에서 같게 동작한다.
    [Parameter(Mandatory = $true)][string]$Patterns,
    [string]$Exe = 'python.exe',
    # 이 스크립트 자신과 호출한 배치가 걸리는 것을 막는다.
    [string]$Keep = ''
)

$patList = $Patterns -split ';' | Where-Object { $_.Trim() -ne '' } | ForEach-Object { $_.Trim() }
$keepIds = @()
if ($Keep) { $keepIds = $Keep -split ';' | ForEach-Object { [int]$_ } }

$ErrorActionPreference = 'Stop'
$me = $PID
$killed = @()

try {
    $procs = Get-CimInstance Win32_Process -Filter "Name='$Exe'" -ErrorAction Stop
} catch {
    Write-Output "        could not read process list: $($_.Exception.Message)"
    exit 1
}

foreach ($p in $procs) {
    if ($p.ProcessId -eq $me -or $keepIds -contains $p.ProcessId) { continue }
    $cmd = $p.CommandLine
    if (-not $cmd) { continue }
    foreach ($pat in $patList) {
        if ($cmd -like "*$pat*") {
            try {
                Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop
                $killed += "$($p.ProcessId) ($pat)"
            } catch {
                # 이미 없는 것은 실패가 아니다. 파이썬 런처(python.exe ->
                # 실제 인터프리터)가 쌍으로 뜨므로, 부모를 끝내면 자식은
                # 목록에 남아 있어도 이 줄에 닿을 때 이미 사라져 있다.
                # 그걸 "kill failed" 로 찍으면 멀쩡한 재시작이 고장처럼 보인다.
                #
                # 그 외의 실패는 삼키지 않는다 — 삼켰던 것이 이 버그의
                # 수명을 늘렸다(머리말 참고).
                if ($_.Exception.Message -notmatch 'Cannot find a process') {
                    Write-Output "        PID $($p.ProcessId) kill failed: $($_.Exception.Message)"
                }
            }
            break
        }
    }
}

if ($killed.Count -eq 0) {
    Write-Output "        nothing to kill."
} else {
    Write-Output ("        killed: " + ($killed -join ', '))
}
