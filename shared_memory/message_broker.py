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


if __name__ == "__main__":
    # simple self-test: publish and then fetch
    pub = publish_event("orchestrator", "bridge", "broker self-test heartbeat")
    print(json.dumps({"published": pub, "fetched_count": len(fetch_events())}, ensure_ascii=False, indent=2))
