#!/usr/bin/env python3
"""
Orchestration Bridge: aggregates department manifests and shared memory into
a UI-ready JSON snapshot for IDE/WebView visualization.
"""

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
MYUNG_TECH_WORKSPACE = (BASE_DIR / ".." ).resolve()
DEPARTMENTS_DIR = MYUNG_TECH_WORKSPACE / "departments"
SHARED_MEMORY_DIR = MYUNG_TECH_WORKSPACE / "shared_memory"
MANIFEST_NAME = "department_manifest.json"
BRIDGE_STATE_PATH = BASE_DIR / "bridge_state.json"


def read_json(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            raise ValueError("manifest root is not an object")
        return data
    except Exception as exc:
        return {"status": "Error: Missing/Invalid Manifest", "error": str(exc)}


def load_shared_memory_events() -> list[dict]:
    events = []
    if not SHARED_MEMORY_DIR.exists() or not SHARED_MEMORY_DIR.is_dir():
        return events
    for item in sorted(SHARED_MEMORY_DIR.iterdir(), key=lambda p: p.stat().st_mtime if p.exists() else 0):
        if item.is_file() and item.suffix.lower() == ".json":
            try:
                events.append(json.loads(item.read_text(encoding="utf-8")))
            except Exception:
                continue
    return events


def aggregate_departments() -> list[dict]:
    nodes = []
    if not DEPARTMENTS_DIR.exists() or not DEPARTMENTS_DIR.is_dir():
        return nodes

    for dept_dir in sorted(DEPARTMENTS_DIR.iterdir()):
        if not dept_dir.is_dir():
            continue

        manifest_path = dept_dir / MANIFEST_NAME
        manifest = read_json(manifest_path)

        dept_name = manifest.get("department_name", dept_dir.name)
        status = manifest.get("status", "Unknown")
        brain = manifest.get("assigned_brain", "")
        skills = manifest.get("active_skills", [])
        error_detail = ""
        if "error" in manifest:
            error_detail = manifest["error"]

        nodes.append(
            {
                "id": dept_dir.name,
                "name": dept_name,
                "status": status,
                "assigned_brain": brain,
                "active_skills": skills,
                "manifest_path": str(manifest_path),
                "error_detail": error_detail,
            }
        )

    return nodes


def _native_path(p: Path) -> str:
    """Return platform-native path string (resolves WSL /mnt/X paths on Windows)."""
    s = str(p)
    if sys.platform == "win32":
        return s
    return s


def load_task_queue_summary() -> list[dict]:
    tasks_dir = SHARED_MEMORY_DIR / "tasks"
    if not tasks_dir.is_dir():
        return []
    summary = []
    for p in sorted(tasks_dir.glob("task-*.json"), key=lambda x: x.stat().st_mtime, reverse=True)[:20]:
        try:
            t = json.loads(p.read_text(encoding="utf-8"))
            summary.append({
                "task_id": t.get("task_id"),
                "target_dept": t.get("target_dept"),
                "status": t.get("status"),
                "priority": t.get("priority"),
                "instruction": (t.get("instruction") or "")[:80],
                "updated_at": t.get("updated_at"),
            })
        except Exception:
            continue
    return summary


def build_bridge_state() -> dict:
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "workspace": _native_path(MYUNG_TECH_WORKSPACE),
        "departments": aggregate_departments(),
        "shared_memory_events": load_shared_memory_events(),
        "task_queue": load_task_queue_summary(),
    }


def main() -> int:
    state = build_bridge_state()
    payload = json.dumps(state, ensure_ascii=False, indent=2)

    # UI-Ready JSON Output: stdout
    print(payload)

    # persisted snapshot
    BRIDGE_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    BRIDGE_STATE_PATH.write_text(payload, encoding="utf-8")
    print(str(BRIDGE_STATE_PATH), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
