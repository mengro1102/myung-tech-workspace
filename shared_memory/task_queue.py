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

try:                     # 평평하게 부를 때 — server.py 의 `import projects`
    import disk_guard
except ImportError:      # 패키지로 부를 때 — `from shared_memory import projects`
    from shared_memory import disk_guard

TASKS_DIR = Path(__file__).resolve().parent / "tasks"

TaskStatus = Literal["pending", "in_progress", "done", "failed"]

# 이보다 오래 in_progress 인 태스크는 "도는 중" 으로 세지 않는다.
# project_runner 의 INFLIGHT_STALE(900초)은 **단계** 하나 기준이고,
# 태스크는 더 큰 단위라 두 배를 준다. 추정이므로 사유에 임계값을 적는다.
STALE_SECS = 1800


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
    _tp = _task_path(task_id)
    with disk_guard.writing(_tp):
        _tp.write_text(json.dumps(task, ensure_ascii=False, indent=2), encoding="utf-8")
    return task


def _age(task: dict) -> float:
    """마지막으로 움직인 뒤 몇 초. 시각을 못 읽으면 0 — 모르는 것을
    "오래됐다" 로 바꿔 말하지 않는다."""
    from datetime import datetime, timezone
    raw = task.get("updated_at") or task.get("created_at") or ""
    try:
        t = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        if t.tzinfo is None:
            t = t.replace(tzinfo=timezone.utc)
        return max(0.0, (datetime.now(timezone.utc) - t).total_seconds())
    except Exception:  # noqa: BLE001
        return 0.0


def is_stale(task: dict) -> bool:
    """도는 중이라고 적혀 있지만 실제로는 멈춘 것."""
    return task.get("status") == "in_progress" and _age(task) > STALE_SECS


def stale(tasks: list[dict] | None = None) -> list[dict]:
    """정체된 태스크 목록. **읽기만 한다** — 폴링이 상태를 바꾸면 안 된다."""
    return [t for t in (tasks if tasks is not None else list_tasks()) if is_stale(t)]


def sweep_stale() -> list[str]:
    """정체된 것을 사유와 함께 failed 로 내린다. 쓰기이므로 디스패처만 부른다.

    사유를 반드시 적는다. 조용히 내리면 사장님은 "되긴 했나" 를 알 수 없고,
    그건 고치려던 문제(화면이 거짓말하는 것)와 같은 종류다.
    """
    done: list[str] = []
    for t in stale():
        # 키는 `task_id` 다. 한때 `id` 로 읽어 None 을 보고 "고아라서
        # 못 고친다" 고 잘못 진단한 적이 있다 — 둘 다 본다.
        tid = t.get("task_id") or t.get("id")
        if not tid:
            continue
        mins = int(STALE_SECS // 60)
        update_status(tid, "failed",
                      f"{mins}분 넘게 응답이 없어 정체로 판정했습니다 "
                      f"(기준 STALE_SECS={STALE_SECS}초). 실제로는 끝났을 수도 "
                      f"있으니 결과가 필요하면 다시 시키십시오.")
        done.append(str(tid))
    return done


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


def insert(task: dict) -> bool:
    """휴지통에서 되살릴 때 쓴다. 같은 id 가 이미 있으면 덮지 않는다.

    되살리기는 '없던 것을 되돌리는' 일이지 '덮어쓰는' 일이 아니다. 같은
    id 가 살아 있다면 그쪽이 더 최신이므로 건드리지 않는다.
    """
    tid = str(task.get("task_id") or "").strip()
    if not tid:
        return False
    path = _task_path(tid)
    if path.exists():
        return False
    TASKS_DIR.mkdir(parents=True, exist_ok=True)
    with disk_guard.writing(path):
        path.write_text(json.dumps(task, ensure_ascii=False, indent=2),
                        encoding="utf-8")
    return True


def delete_task(task_id: str) -> bool:
    path = _task_path(task_id)
    if path.exists():
        try:
            path.unlink()
            return True
        except Exception:
            return False
    return False


if __name__ == "__main__":
    t = enqueue("orchestrator", "research_dept", "RL 논문 요약 후 핵심 알고리즘 추출", priority=8)
    print(json.dumps(t, ensure_ascii=False, indent=2))
    print("pending:", len(list_tasks("pending")))
