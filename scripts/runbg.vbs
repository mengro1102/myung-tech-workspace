' 명령을 창 없이, 부모와 분리해서 띄운다.
'
'   wscript //nologo runbg.vbs "cmd /c cd /d D:\... && python -u server.py >> logs\x.log 2>&1"
'
' start "제목" /min 으로 띄우면 최소화돼도 작업 표시줄에 남는다. 서비스 넷이
' 늘 자리를 차지하고, 다른 일을 할 때 눈에 걸린다. 여기서는 창 자체를 만들지
' 않는다(0 = 숨김, False = 기다리지 않음).
'
' 대신 창 제목이 없어지므로 STOP 은 제목이 아니라 **명령줄**로 찾아 죽여야
' 한다. STOP.bat / RESTART.bat / watchdog 이 모두 그렇게 바뀌어 있다.
'
' 인자는 통째로 하나다. 안에서 다시 따옴표를 붙이지 않는다 — 붙이면
' "cmd /c ..." 의 /c 뒤가 한 덩어리로 묶여 깨진다.
Dim sh
Set sh = CreateObject("WScript.Shell")
If WScript.Arguments.Count = 0 Then WScript.Quit 1
sh.Run WScript.Arguments(0), 0, False
