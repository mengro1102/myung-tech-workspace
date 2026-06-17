#!/usr/bin/env python3
"""Bridge Daemon — watchdog으로 departments/ & shared_memory/ 변경을 감지하여
orchestration_bridge.py를 자동 재실행하고 bridge_state.json을 즉시 갱신한다.
"""
from __future__ import annotations

import json
import logging
import sys
import time
from pathlib import Path

from watchdog.events import FileSystemEvent, FileSystemEventHandler
from watchdog.observers import Observer

BASE_DIR = Path(__file__).resolve().parent
WORKSPACE = BASE_DIR.parent
BRIDGE_STATE_PATH = BASE_DIR / "bridge_state.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [bridge-daemon] %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger(__name__)

sys.path.insert(0, str(BASE_DIR))
sys.path.insert(0, str(WORKSPACE / "shared_memory"))


def regenerate() -> None:
    try:
        import importlib
        import orchestration_bridge as ob
        importlib.reload(ob)
        state = ob.build_bridge_state()
        payload = json.dumps(state, ensure_ascii=False, indent=2)
        BRIDGE_STATE_PATH.write_text(payload, encoding="utf-8")
        log.info(
            "bridge_state.json 갱신 — %d개 부서, %d개 이벤트",
            len(state["departments"]),
            len(state["shared_memory_events"]),
        )
    except Exception as exc:
        log.error("재생성 실패: %s", exc)


class _Handler(FileSystemEventHandler):
    _DEBOUNCE = 0.5  # seconds

    def __init__(self) -> None:
        self._last_trigger = 0.0

    def on_any_event(self, event: FileSystemEvent) -> None:
        if event.is_directory:
            return
        src = str(event.src_path)
        # bridge_state.json 자체 변경은 무시 (무한 루프 방지)
        if "bridge_state.json" in src or "__pycache__" in src:
            return
        if not src.endswith(".json") and not src.endswith(".py"):
            return
        now = time.monotonic()
        if now - self._last_trigger < self._DEBOUNCE:
            return
        self._last_trigger = now
        log.info("변경 감지: %s", Path(src).name)
        regenerate()


def main() -> None:
    watch_dirs = [
        WORKSPACE / "departments",
        WORKSPACE / "shared_memory",
    ]

    log.info("명테크 Bridge Daemon 시작")
    log.info("감시 경로: %s", [str(d) for d in watch_dirs])

    regenerate()  # 즉시 초기 생성

    observer = Observer()
    handler = _Handler()
    for d in watch_dirs:
        d.mkdir(parents=True, exist_ok=True)
        observer.schedule(handler, str(d), recursive=True)

    observer.start()
    log.info("watchdog 감시 중 — Ctrl+C로 종료")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        pass
    finally:
        observer.stop()
        observer.join()
        log.info("Bridge Daemon 종료")


if __name__ == "__main__":
    main()
