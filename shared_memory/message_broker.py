#!/usr/bin/env python3
"""
Shared Memory Message Broker:
- publish_event: persists event as JSON file under shared_memory/
- fetch_events: scans shared_memory/ for event JSON files and returns them
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

SHARED_MEMORY_DIR = Path(__file__).resolve().parent


def _generate_event_id() -> str:
    return f"evt-{uuid.uuid4().hex[:8]}-{int(datetime.now(timezone.utc).timestamp())}"


def publish_event(sender: str, target: str, payload: str) -> dict:
    SHARED_MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    event = {
        "event_id": _generate_event_id(),
        "sender": sender,
        "target": target,
        "payload": payload,
        "timestamp": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    out_path = SHARED_MEMORY_DIR / f"{event['event_id']}.json"
    try:
        out_path.write_text(json.dumps(event, ensure_ascii=False, indent=2), encoding="utf-8")
        return {"ok": True, "path": str(out_path), "event_id": event["event_id"]}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


def fetch_events() -> list[dict]:
    events: list[dict] = []
    if not SHARED_MEMORY_DIR.exists() or not SHARED_MEMORY_DIR.is_dir():
        return events
    for item in sorted(SHARED_MEMORY_DIR.iterdir(), key=lambda p: p.stat().st_mtime if p.exists() else 0):
        if not item.is_file() or item.suffix.lower() != ".json":
            continue
        if item.name == "message_broker.json":
            continue
        try:
            data = json.loads(item.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                events.append(data)
        except Exception:
            continue
    return events


def purge_events(contains: str) -> int:
    """payload 에 이 문자열이 든 이벤트 파일을 지운다. 지운 개수를 돌려준다.

    프로젝트를 지워도 그 프로젝트의 이벤트는 남아 있어서, 실시간 활동에
    "없는 프로젝트가 멈췄습니다" 가 계속 떴다. 지운 것은 화면에서도 사라져야 한다.
    """
    if not contains or not SHARED_MEMORY_DIR.is_dir():
        return 0
    n = 0
    for item in SHARED_MEMORY_DIR.glob("evt-*.json"):
        try:
            data = json.loads(item.read_text(encoding="utf-8"))
        except Exception:
            continue
        if contains in str(data.get("payload") or ""):
            try:
                item.unlink()
                n += 1
            except OSError:
                pass
    return n


def prune_events(keep: int = 400) -> int:
    """오래된 이벤트 파일을 줄인다. 지운 개수.

    이벤트를 파일 하나씩 쌓는 구조라 지우는 사람이 없으면 무한정 늘어난다
    (실측 274개 · 1.2MB). 화면은 최근 50건만 쓰므로 그보다 넉넉히 남긴다.
    """
    if not SHARED_MEMORY_DIR.is_dir():
        return 0
    files = sorted(SHARED_MEMORY_DIR.glob("evt-*.json"),
                   key=lambda p: p.stat().st_mtime if p.exists() else 0)
    n = 0
    for f in files[:-keep] if len(files) > keep else []:
        try:
            f.unlink()
            n += 1
        except OSError:
            pass
    return n


if __name__ == "__main__":
    # simple self-test: publish and then fetch
    pub = publish_event("orchestrator", "bridge", "broker self-test heartbeat")
    print(json.dumps({"published": pub, "fetched_count": len(fetch_events())}, ensure_ascii=False, indent=2))
