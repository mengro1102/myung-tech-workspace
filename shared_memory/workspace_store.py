"""할 일 · 등록 서비스 · 승인 큐를 담는 작은 저장소.

셋 다 UI 의 React state 뿐이라 새로고침 한 번에 사라졌다. 브라우저
localStorage 로 옮겨 "적은 것이 남는" 최소한은 맞췄지만, 그래서는 에이전트가
읽을 수 없다. 태스크 보드가 "에이전트가 자동으로 쌓기도 함"이라고 말하려면,
등록한 서비스를 에이전트가 알게 하려면, 결재를 에이전트가 올리려면 서버에
있어야 한다.

DB 를 들일 만한 양이 아니다. 태스크 큐(shared_memory/tasks)와 같은 방식으로
JSON 파일 하나에 담는다. 쓰기는 원자적으로(임시 파일 → 교체) 한다 — 서버와
디스패처가 동시에 건드리기 때문이다.
"""
from __future__ import annotations

import json
import os
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

STORE_DIR = Path(__file__).resolve().parent / "store"
STORE_DIR.mkdir(parents=True, exist_ok=True)

# 컬렉션마다 파일 하나. 이름을 화이트리스트로 두어 경로 이탈을 원천 차단한다.
COLLECTIONS = ("tasks", "services", "approvals")


def _path(collection: str) -> Path:
    if collection not in COLLECTIONS:
        raise ValueError(f"알 수 없는 컬렉션: {collection}")
    return STORE_DIR / f"{collection}.json"


def load(collection: str) -> list[dict]:
    try:
        data = json.loads(_path(collection).read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except FileNotFoundError:
        return []
    except Exception:
        # 파일이 깨졌으면 빈 목록으로 시작한다. 여기서 예외를 올리면 화면 전체가
        # 죽는데, 잃는 것은 메모 몇 줄이다.
        return []


def _save(collection: str, rows: list[dict]) -> None:
    target = _path(collection)
    # 같은 디렉터리에 임시 파일을 만들어 교체해야 os.replace 가 원자적이다.
    fd, tmp = tempfile.mkstemp(dir=str(STORE_DIR), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(rows, f, ensure_ascii=False, indent=2)
        os.replace(tmp, target)
    except Exception:
        Path(tmp).unlink(missing_ok=True)
        raise


def add(collection: str, item: dict) -> dict:
    """id 와 created_at 을 붙여 추가하고, 만들어진 항목을 돌려준다."""
    row = dict(item)
    row.setdefault("id", uuid.uuid4().hex[:12])
    row.setdefault("created_at", time.time())
    rows = load(collection)
    rows.append(row)
    _save(collection, rows)
    return row


def update(collection: str, item_id: str, patch: dict) -> dict | None:
    rows = load(collection)
    for row in rows:
        if row.get("id") == item_id:
            row.update(patch)
            row["updated_at"] = time.time()
            _save(collection, rows)
            return row
    return None


def remove(collection: str, item_id: str) -> bool:
    rows = load(collection)
    kept = [r for r in rows if r.get("id") != item_id]
    if len(kept) == len(rows):
        return False
    _save(collection, kept)
    return True


# ── 에이전트가 쓰는 입구 ────────────────────────────────────────────────

def add_task(text: str, source: str = "agent", department: str = "") -> dict:
    """에이전트가 할 일을 쌓는다. 화면의 태스크 보드에 그대로 뜬다."""
    return add("tasks", {"text": text, "done": False,
                         "source": source, "department": department})


def request_approval(label: str, department: str = "", detail: str = "") -> dict:
    """결재를 올린다. 사람이 승인/거절할 때까지 pending 으로 남는다."""
    return add("approvals", {"label": label, "department": department,
                             "detail": detail, "status": "pending"})


def services_brief(limit: int = 8, budget: int = 800) -> str:
    """등록된 서비스를 프롬프트에 넣을 한 덩어리로 만든다. 없으면 빈 문자열."""
    rows = load("services")[:limit]
    if not rows:
        return ""
    lines = []
    for r in rows:
        bits = [str(r.get("name") or "").strip()]
        for key, label in (("url", ""), ("github", "github: "), ("desc", "")):
            v = str(r.get(key) or "").strip()
            if v:
                bits.append(f"{label}{v}")
        line = " · ".join(b for b in bits if b)
        if line:
            lines.append(f"- {line}")
    if not lines:
        return ""
    block = "\n".join(lines)
    if len(block) > budget:
        block = block[:budget].rsplit("\n", 1)[0] + "\n- …"
    return "우리가 운영 중인 서비스:\n" + block


def as_dict() -> dict[str, Any]:
    return {c: load(c) for c in COLLECTIONS}
