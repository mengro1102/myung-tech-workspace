#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""명테크를 켜고 끄고 다시 띄운다 — 맹비서가 디스코드에서 부르는 창구.

## 왜 bat 을 직접 주지 않는가

맹비서에게 "bat 아무거나 실행" 을 주면 **그 디스코드 채널이 곧 PC 셸**이
된다. 모델이 경로를 조립하게 두면 더 나쁘다 — 지어낸 경로를 실행하거나,
외부에서 읽은 글에 섞인 지시를 그대로 수행할 수 있다(위키 references/ 는
매일 arXiv 에서 긁어 온다).

그래서 **인자를 받지 않는 고정 4개**만 둔다. 맹비서는 이 스크립트에
`start|stop|restart|status` 중 하나를 넘길 뿐이고, 어떤 bat 이 어디 있는지는
여기에만 적혀 있다.

## 맹비서는 자기를 켤 수 없다

꺼져 있으면 디스코드 메시지를 못 받는다. 그래서 이 스크립트는 **명테크만**
다룬다. 맹비서 자신은 `실행\\1. 전체 시작.bat` 이나 작업 스케줄러가 띄운다.

## 되돌릴 수 있는 정도

| 명령 | 되돌림 | 승인 |
|------|--------|------|
| status | 읽기만 | 불필요 |
| start | 이미 떠 있으면 아무 일 없음 | 불필요 |
| stop | 다시 start 하면 복구. **진행 중인 태스크는 끊긴다** | 필요 |
| restart | stop+start | 필요 |

승인은 hermes 의 `approvals.mode: smart` 가 판정한다. 여기서는 **무엇이
끊기는지 미리 알려 주는 것**까지만 한다 — 사람이 판단할 재료를 준다.
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

API = "http://127.0.0.1:9000"
MT = Path(r"D:\myung-tech-workspace")

# 고정 경로. 모델이 조립하지 않는다.
START_BAT = MT / "START.bat"
RUN_BAT = Path(r"D:\AI_Workspace\실행")

TIMEOUT = 180


def _api(path: str, timeout: int = 8):
    with urllib.request.urlopen(API + path, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _alive(timeout: int = 6) -> bool:
    try:
        _api("/api/health", timeout=timeout)
        return True
    except Exception:  # noqa: BLE001
        return False


def _pids() -> list[str]:
    """server.py 를 돌리는 파이썬 프로세스. 끊기 전에 무엇을 끊는지 안다."""
    try:
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | "
             "Where-Object { $_.CommandLine -like '*server.py*' -or "
             "$_.CommandLine -like '*dispatch daemon*' } | "
             "ForEach-Object { $_.ProcessId }"],
            capture_output=True, text=True, timeout=30, errors="replace")
        return [x for x in r.stdout.split() if x.isdigit()]
    except Exception:  # noqa: BLE001
        return []


def _busy() -> tuple[int, int]:
    """(돌고 있는 태스크, 대기 결재). 끊으면 무엇이 날아가는지."""
    try:
        h = _api("/api/health")
        t = h.get("tasks") or {}
        running = int(t.get("in_progress") or 0) + int(t.get("pending") or 0)
    except Exception:  # noqa: BLE001
        running = 0
    try:
        rows = _api("/api/store/approvals") or []
        if isinstance(rows, dict):
            rows = rows.get("items") or []
        pending = sum(1 for r in rows
                      if (r or {}).get("status", "pending") == "pending")
    except Exception:  # noqa: BLE001
        pending = 0
    return running, pending


def cmd_status() -> int:
    up = _alive()
    pids = _pids()
    print(f"명테크: {'돌고 있습니다' if up else '꺼져 있습니다'}")
    print(f"  주소      : http://localhost:9000")
    print(f"  프로세스  : {'PID ' + ', '.join(pids) if pids else '없음'}")
    if up:
        running, pending = _busy()
        print(f"  태스크    : 진행·대기 {running}건")
        print(f"  대기 결재 : {pending}건")
    elif pids:
        # 프로세스는 있는데 응답이 없다 — 껐다 켜는 것이 맞다.
        print("  ⚠️ 프로세스는 떠 있는데 응답이 없습니다 — restart 를 권합니다.")
    return 0


def cmd_start() -> int:
    if _alive():
        print("이미 돌고 있습니다. 아무 일도 하지 않았습니다.")
        return cmd_status()
    if not START_BAT.is_file():
        print(f"시작 스크립트를 찾지 못했습니다: {START_BAT}")
        return 1
    print("명테크를 띄웁니다…")
    # 창을 띄우지 않고 뒤에서 돌린다. 디스코드에서 부르는 것이므로
    # 사장님 화면에 cmd 창이 튀어나오면 곤란하다.
    subprocess.Popen(["cmd", "/c", str(START_BAT)], cwd=str(MT),
                     creationflags=0x08000000)  # CREATE_NO_WINDOW
    # 뜰 때까지 기다린다. 바로 status 를 찍으면 늘 "꺼져 있음" 이 나온다.
    import time
    for _ in range(40):
        time.sleep(2)
        if _alive(timeout=3):
            print("떴습니다.")
            return cmd_status()
    print("80초 안에 응답하지 않았습니다. 로그를 보셔야 합니다.")
    return cmd_status()


def cmd_stop(force: bool = False) -> int:
    if not _alive() and not _pids():
        print("이미 꺼져 있습니다.")
        return 0
    running, pending = _busy()
    # **무엇이 끊기는지 먼저 말한다.** 조용히 끄면 사장님은 태스크가
    # 어디로 갔는지 모른다.
    if running and not force:
        print(f"⚠️ 진행·대기 중인 태스크가 {running}건 있습니다. 끊으면 멈춥니다.")
        print("   그래도 끄시려면 `stop --force` 로 다시 불러 주십시오.")
        return 2
    if pending:
        print(f"※ 대기 결재 {pending}건은 그대로 남습니다(디스크에 저장됩니다).")
    pids = _pids()
    if not pids:
        print("프로세스를 찾지 못했습니다.")
        return 1
    subprocess.run(["powershell", "-NoProfile", "-Command",
                    f"Stop-Process -Id {','.join(pids)} -Force"],
                   capture_output=True, timeout=30)
    print(f"껐습니다 (PID {', '.join(pids)}).")
    return 0


def cmd_restart() -> int:
    cmd_stop(force=True)
    import time
    time.sleep(2)
    return cmd_start()


ACTIONS = {"status": cmd_status, "start": cmd_start,
           "stop": cmd_stop, "restart": cmd_restart}


def main() -> int:
    ap = argparse.ArgumentParser(
        description="명테크 제어 — 고정된 네 가지만 합니다.")
    ap.add_argument("action", choices=sorted(ACTIONS))
    ap.add_argument("--force", action="store_true",
                    help="stop: 진행 중인 태스크가 있어도 끕니다")
    a = ap.parse_args()
    try:
        if a.action == "stop":
            return cmd_stop(force=a.force)
        return ACTIONS[a.action]()
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # noqa: BLE001
        print(f"실패: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
