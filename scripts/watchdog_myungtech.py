#!/usr/bin/env python3
"""명테크가 죽었는지 보고, 죽었으면 되살린다.

맹비서에는 5분마다 도는 워치독이 있는데 명테크에는 없었다. 그래서 서버가
죽으면 자율 프로젝트가 조용히 멈추고, 화면은 "백엔드 미연결"만 띄운 채
아무도 모르는 상태로 남았다. 실제로 오늘 서버·디스패처·UI 가 모두 꺼진 채
발견됐다.

작업 스케줄러가 5분마다 부른다. 살아 있으면 아무 말도 하지 않고, 되살렸을
때만 텔레그램으로 알린다 — 조용한 경보는 읽히지 않는다.

    python scripts/watchdog_myungtech.py          # 점검하고 필요하면 되살림
    python scripts/watchdog_myungtech.py --check  # 상태만 보고 아무것도 안 함
"""
from __future__ import annotations

import argparse
import json
import socket
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOG = ROOT / "logs" / "watchdog.log"
STATE = ROOT / "logs" / "watchdog.state.json"

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

# (표시명, 포트, 창 제목, 실행 명령)
SERVICES = [
    ("API 서버", 9000, "mt-server", f'cd /d {ROOT} && python server.py'),
    ("UI", 5174, "mt-vite", f'cd /d {ROOT}\\virtual-office && npm run dev'),
]
# 디스패처는 포트를 쓰지 않는다. 프로세스 명령줄로 찾는다.
DISPATCH_TITLE = "mt-dispatch"
DISPATCH_CMD = f'cd /d {ROOT} && python run.py dispatch daemon'
DISPATCH_MATCH = "dispatch daemon"

# 같은 서비스를 계속 되살리기만 하면 고쳐지지 않는다. 연속 실패가 이만큼
# 쌓이면 되살리기를 멈추고 사람을 부른다 — 맹비서 supervisor 와 같은 규칙.
GIVE_UP_AFTER = 6


def log(msg: str) -> None:
    LOG.parent.mkdir(parents=True, exist_ok=True)
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] {msg}"
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except OSError:
        pass
    print(line)


def port_open(port: int, host: str = "127.0.0.1") -> bool:
    """127.0.0.1 로 본다. localhost 는 ::1 이 먼저라 IPv4 바인드를 못 찾는다."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1.5)
        return s.connect_ex((host, port)) == 0


def dispatcher_alive() -> bool:
    try:
        out = subprocess.run(
            ["wmic", "process", "where", "name='python.exe'", "get", "commandline"],
            capture_output=True, text=True, timeout=20, errors="replace").stdout
    except Exception:  # noqa: BLE001
        return True      # 확인할 수 없으면 건드리지 않는다
    return DISPATCH_MATCH in (out or "")


def start(title: str, command: str) -> None:
    """START.BAT 과 같은 모양으로 띄운다 — 창 제목이 같아야 STOP.BAT 이 끈다."""
    subprocess.Popen(f'start "{title}" /min cmd /c "{command}"',
                     shell=True, cwd=str(ROOT))


def load_state() -> dict:
    try:
        return json.loads(STATE.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def save_state(d: dict) -> None:
    try:
        STATE.parent.mkdir(parents=True, exist_ok=True)
        STATE.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass


def notify(text: str) -> None:
    try:
        sys.path.insert(0, str(ROOT))
        from shared_memory import notify as n
        n.send(text, quiet=True)
    except Exception as exc:  # noqa: BLE001
        log(f"알림 실패(무시): {exc}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="상태만 보고 되살리지 않는다")
    args = ap.parse_args()

    state = load_state()
    fails = dict(state.get("fails") or {})
    down: list[str] = []
    revived: list[str] = []
    gave_up: list[str] = []

    checks = [(name, port_open(port), title, cmd) for name, port, title, cmd in SERVICES]
    checks.append(("디스패처", dispatcher_alive(), DISPATCH_TITLE, DISPATCH_CMD))

    for name, alive, title, cmd in checks:
        if alive:
            fails.pop(name, None)
            continue
        down.append(name)
        n = int(fails.get(name, 0)) + 1
        fails[name] = n
        if args.check:
            continue
        if n > GIVE_UP_AFTER:
            gave_up.append(name)
            continue
        log(f"{name} 정지 감지 — 재시작 (연속 {n}회)")
        start(title, cmd)
        revived.append(name)

    save_state({"fails": fails, "at": time.time()})

    if args.check:
        print("정지:", ", ".join(down) if down else "없음")
        return 0

    if gave_up:
        notify("🔴 [명테크] 되살리기 포기\n\n"
               + ", ".join(gave_up)
               + f"\n{GIVE_UP_AFTER}회 연속으로 다시 죽었습니다. 재시작으로 고쳐질 문제가 "
                 "아닙니다. logs/watchdog.log 를 보세요.")
    elif revived:
        # 살아난 것을 확인하고 알린다. 띄우자마자 알리면 실패해도 성공처럼 보인다.
        time.sleep(12)
        still = [n for n, _, _, _ in checks if n in revived and not _alive(n)]
        ok = [n for n in revived if n not in still]
        msg = "🔄 [명테크] 재시작"
        if ok:
            msg += "\n\n되살림: " + ", ".join(ok)
        if still:
            msg += "\n아직 죽어 있음: " + ", ".join(still)
        notify(msg)
    return 0


def _alive(name: str) -> bool:
    for n, port, _, _ in SERVICES:
        if n == name:
            return port_open(port)
    return dispatcher_alive()


if __name__ == "__main__":
    raise SystemExit(main())
