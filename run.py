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
    import agent_dispatcher
    key = os.environ.get("OPENROUTER_API_KEY", "")
    if agent_dispatcher.USE_OLLAMA:
        print(f"[dispatcher] 백엔드: Ollama ({agent_dispatcher.OLLAMA_BASE_URL})")
    else:
        if not key:
            print("[FATAL] OPENROUTER_API_KEY not set.", file=sys.stderr)
            sys.exit(1)
        print(f"[dispatcher] 백엔드: OpenRouter")
    if mode == "daemon":
        agent_dispatcher.run_daemon(key)
    else:
        n = agent_dispatcher.run_once(key)
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
