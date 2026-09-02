#!/usr/bin/env python3
"""
Myung-Tech launcher.

Usage:
  python run.py bridge          — regenerate bridge_state.json once
  python run.py daemon          — start bridge daemon (auto-regen on file change)
  python run.py dispatch        — process pending tasks once (requires OPENROUTER_API_KEY)
  python run.py dispatch daemon — process tasks continuously
  python run.py parse           — convert latest file in preprocessing/ to markdown
  python run.py status          — print current bridge state summary
"""

import json
import os
import sys

try:            # cp949 콘솔에서 한글 print 가 죽지 않게
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "bridge"))
sys.path.insert(0, str(ROOT / "shared_memory"))


def cmd_bridge():
    import orchestration_bridge
    state = orchestration_bridge.build_bridge_state()
    payload = json.dumps(state, ensure_ascii=False, indent=2)
    orchestration_bridge.BRIDGE_STATE_PATH.write_text(payload, encoding="utf-8")
    print(f"bridge_state.json written → {orchestration_bridge.BRIDGE_STATE_PATH}")


def cmd_daemon():
    import bridge_daemon
    bridge_daemon.run()


def cmd_dispatch(mode="once"):
    import agent_dispatcher as ad
    # 백엔드는 부서 등급에 따라 작업마다 정해진다(라우터 → Ollama → OpenRouter).
    # 여기서는 어느 쪽이 준비됐는지만 알려준다.
    router_ready = bool(ad._router_key()) and ad._router_alive()
    print(f"[dispatcher] 라우터: {'사용 가능 ' + ad.ROUTER_BASE_URL if router_ready else '없음 → 로컬로 대체'}")
    print(f"[dispatcher] Ollama: {ad.OLLAMA_BASE_URL}")
    if mode == "daemon":
        ad.run_daemon()
    else:
        n = ad.run_once()
        print(f"{n} task(s) dispatched.")


def cmd_parse():
    import subprocess
    venv_python = ROOT / "preprocessing" / "venv" / "bin" / "python"
    if not venv_python.exists():
        venv_python = ROOT / "preprocessing" / "venv" / "Scripts" / "python.exe"
    python = str(venv_python) if venv_python.exists() else sys.executable
    result = subprocess.run(
        [python, str(ROOT / "preprocessing" / "parse_data.py")],
        capture_output=True, text=True
    )
    if result.stdout:
        print(result.stdout.strip())
    if result.stderr:
        print(result.stderr.strip(), file=sys.stderr)
    sys.exit(result.returncode)


def cmd_status():
    path = ROOT / "bridge" / "bridge_state.json"
    if not path.exists():
        print("bridge_state.json not found — run: python run.py bridge")
        sys.exit(1)
    state = json.loads(path.read_text(encoding="utf-8"))
    print(f"Generated : {state.get('generated_at')}")
    print(f"Workspace : {state.get('workspace')}")
    print(f"\nDepartments ({len(state.get('departments', []))}):")
    for d in state.get("departments", []):
        print(f"  [{d['status']:10}] {d['name']} — {d['assigned_brain']}")
    tasks = state.get("task_queue", [])
    if tasks:
        from collections import Counter
        counts = Counter(t["status"] for t in tasks)
        print(f"\nTask Queue: {dict(counts)}")
    events = state.get("shared_memory_events", [])
    print(f"\nShared Memory Events: {len(events)}")


COMMANDS = {
    "bridge": lambda: cmd_bridge(),
    "daemon": lambda: cmd_daemon(),
    "dispatch": lambda: cmd_dispatch("once"),
    "dispatch daemon": lambda: cmd_dispatch("daemon"),
    "parse": lambda: cmd_parse(),
    "status": lambda: cmd_status(),
}

if __name__ == "__main__":
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        sys.exit(0)

    key = " ".join(args[:2])
    fn = COMMANDS.get(key) or COMMANDS.get(args[0])
    if fn is None:
        print(f"Unknown command: {' '.join(args)}\n{__doc__}")
        sys.exit(1)
    fn()
