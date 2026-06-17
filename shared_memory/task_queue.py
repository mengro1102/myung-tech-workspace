#!/usr/bin/env python3
"""
Task Queue: persistent file-based queue for department tasks.

Tasks are stored as JSON files under shared_memory/tasks/.
Status lifecycle: pending → in_progress → done | failed
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

TASKS_DIR = Path(__file__).resolve().parent / "tasks"

TaskStatus = Literal["pending", "in_progress", "done", "failed"]


def _now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _task_path(task_id: str) -> Path:
    return TASKS_DIR / f"{task_id}.json"


def enqueue(
    sender: str,
    target_dept: str,
    instruction: str,
    priority: int = 5,
) -> dict:
    """Create a new pending task and persist it."""
    TASKS_DIR.mkdir(parents=True, exist_ok=True)
    task_id = f"task-{uuid.uuid4().hex[:10]}"
    task = {
        "task_id": task_id,
        "sender": sender,
        "target_dept": target_dept,
        "instruction": instruction,
        "priority": priority,
        "status": "pending",
        "result": None,
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    }
    _task_path(task_id).write_text(
        json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return task


def update_status(task_id: str, status: TaskStatus, result: str | None = None) -> dict | None:
    path = _task_path(task_id)
    if not path.exists():
        return None
    task = json.loads(path.read_text(encoding="utf-8"))
    task["status"] = status
    task["updated_at"] = _now_iso()
    if result is not None:
        task["result"] = result
    path.write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")
    return task


def list_tasks(status: TaskStatus | None = None) -> list[dict]:
    if not TASKS_DIR.exists():
        return []
    tasks = []
    for p in sorted(TASKS_DIR.glob("task-*.json"), key=lambda x: x.stat().st_mtime):
        try:
            t = json.loads(p.read_text(encoding="utf-8"))
            if status is None or t.get("status") == status:
                tasks.append(t)
        except Exception:
            continue
    return tasks


def get_task(task_id: str) -> dict | None:
    path = _task_path(task_id)
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


if __name__ == "__main__":
    t = enqueue("orchestrator", "research_dept", "RL 논문 요약 후 핵심 알고리즘 추출", priority=8)
    print(json.dumps(t, ensure_ascii=False, indent=2))
    print("pending:", len(list_tasks("pending")))
