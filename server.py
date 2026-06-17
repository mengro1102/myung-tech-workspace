#!/usr/bin/env python3
"""
명테크 Agent Studio — 경량 API 서버 (포트 9000)

엔드포인트:
  GET  /api/health
  GET  /api/agents
  GET  /api/agents/:id
  PATCH /api/agents/:id
  GET  /api/events
  GET  /api/events/stream  (SSE)
  POST /api/workflow/trigger
"""

from __future__ import annotations

import json
import os
import sys
import time
import threading
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
DEPARTMENTS_DIR = ROOT / "departments"
SHARED_MEMORY_DIR = ROOT / "shared_memory"

sys.path.insert(0, str(ROOT / "shared_memory"))
sys.path.insert(0, str(ROOT / "bridge"))

import task_queue
import message_broker

PORT = int(os.environ.get("API_PORT", 9000))


# ── 에이전트 데이터 로드 ──────────────────────────────────────

def _load_all_agents() -> list[dict]:
    agents = []
    for dept_dir in sorted(DEPARTMENTS_DIR.iterdir()):
        if not dept_dir.is_dir():
            continue
        agents_dir = dept_dir / "agents"
        if not agents_dir.exists():
            continue
        manifest_path = dept_dir / "department_manifest.json"
        dept_id = dept_dir.name
        for agent_file in sorted(agents_dir.glob("*.json")):
            try:
                agent = json.loads(agent_file.read_text(encoding="utf-8"))
                agent["department"] = dept_id
                agent["_file"] = str(agent_file)
                if "status" not in agent:
                    agent["status"] = "Idle"
                agents.append(agent)
            except Exception:
                continue
    return agents


def _save_agent(agent: dict) -> bool:
    file_path = agent.get("_file")
    if not file_path:
        return False
    try:
        save = {k: v for k, v in agent.items() if not k.startswith("_")}
        Path(file_path).write_text(
            json.dumps(save, ensure_ascii=False, indent=2), encoding="utf-8"
        )
        return True
    except Exception:
        return False


def _get_agent(agent_id: str) -> dict | None:
    for a in _load_all_agents():
        if a.get("agent_id") == agent_id:
            return a
    return None


# ── SSE 구독자 관리 ───────────────────────────────────────────

_sse_clients: list = []
_sse_lock = threading.Lock()


def _broadcast_event(event: dict):
    data = f"event: new_event\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"
    with _sse_lock:
        dead = []
        for wfile in _sse_clients:
            try:
                wfile.write(data.encode("utf-8"))
                wfile.flush()
            except Exception:
                dead.append(wfile)
        for d in dead:
            _sse_clients.remove(d)


def _event_watcher():
    """shared_memory 이벤트를 감시해서 SSE로 브로드캐스트."""
    seen = set()
    while True:
        try:
            events = message_broker.fetch_events()
            for evt in events:
                eid = evt.get("event_id")
                if eid and eid not in seen:
                    seen.add(eid)
                    _broadcast_event(evt)
        except Exception:
            pass
        time.sleep(1.5)


threading.Thread(target=_event_watcher, daemon=True).start()


# ── HTTP 핸들러 ───────────────────────────────────────────────

def _json_resp(handler, status: int, data: dict | list):
    body = json.dumps(data, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(body)


class Handler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        pass  # 조용하게

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        # ── GET /api/health
        if path == "/api/health":
            _json_resp(self, 200, {
                "status": "ok",
                "redis": "n/a",
                "vllm": "ollama",
                "server": "myung-tech-api",
            })

        # ── GET /api/agents
        elif path == "/api/agents":
            agents = _load_all_agents()
            summary = [{
                "agent_id":       a.get("agent_id"),
                "character_name": a.get("character_name", ""),
                "role":           a.get("role", ""),
                "department":     a.get("department", ""),
                "status":         a.get("status", "Idle"),
            } for a in agents]
            _json_resp(self, 200, {"total": len(summary), "agents": summary})

        # ── GET /api/agents/:id
        elif path.startswith("/api/agents/"):
            agent_id = path.split("/api/agents/")[1]
            agent = _get_agent(agent_id)
            if agent:
                out = {k: v for k, v in agent.items() if not k.startswith("_")}
                _json_resp(self, 200, out)
            else:
                _json_resp(self, 404, {"error": "Agent not found"})

        # ── GET /api/events
        elif path == "/api/events":
            events = message_broker.fetch_events()[-50:]
            _json_resp(self, 200, {"total": len(events), "events": events})

        # ── GET /api/events/stream  (SSE)
        elif path == "/api/events/stream":
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Connection", "keep-alive")
            self._cors()
            self.end_headers()

            # 기존 이벤트 전송
            for evt in message_broker.fetch_events()[-20:]:
                data = f"event: new_event\ndata: {json.dumps(evt, ensure_ascii=False)}\n\n"
                self.wfile.write(data.encode("utf-8"))
            self.wfile.flush()

            with _sse_lock:
                _sse_clients.append(self.wfile)

            # 연결 유지 (heartbeat)
            try:
                while True:
                    time.sleep(15)
                    self.wfile.write(b": heartbeat\n\n")
                    self.wfile.flush()
            except Exception:
                with _sse_lock:
                    if self.wfile in _sse_clients:
                        _sse_clients.remove(self.wfile)

        else:
            _json_resp(self, 404, {"error": "Not found"})

    def do_PATCH(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path.startswith("/api/agents/"):
            agent_id = path.split("/api/agents/")[1]
            agent = _get_agent(agent_id)
            if not agent:
                _json_resp(self, 404, {"error": "Agent not found"})
                return
            updates = self._read_body()
            allowed = {"character_name", "role", "base_prompt", "persona",
                       "telegram_bot_token", "level", "status", "preferred_model"}
            for k, v in updates.items():
                if k in allowed:
                    agent[k] = v
            ok = _save_agent(agent)
            out = {k: v for k, v in agent.items() if not k.startswith("_")}
            _json_resp(self, 200, {"ok": ok, "agent": out})
        else:
            _json_resp(self, 404, {"error": "Not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path == "/api/workflow/trigger":
            body = self._read_body()
            dept_id    = body.get("department_id", "orchestration_dept")
            task_input = body.get("task_input", "")
            if not task_input:
                _json_resp(self, 400, {"error": "task_input required"})
                return

            task = task_queue.enqueue(
                sender="studio_ui",
                target_dept=dept_id,
                instruction=task_input,
                priority=body.get("priority", 7),
            )
            _json_resp(self, 200, {
                "thread_id":       task["task_id"],
                "final_status":    "pending",
                "iteration_count": 0,
                "worker_output":   "",
                "manager_review":  "",
                "latency_ms":      0,
                "event_id":        None,
                "bridge_updated":  False,
            })

        elif path == "/api/agents":
            body = self._read_body()
            agent_id = body.get("agent_id") or f"agent_{uuid.uuid4().hex[:8]}"
            dept_id  = body.get("department", "orchestration_dept")
            dept_dir = DEPARTMENTS_DIR / dept_id / "agents"
            dept_dir.mkdir(parents=True, exist_ok=True)
            agent = {
                "agent_id":       agent_id,
                "character_name": body.get("character_name", "새 에이전트"),
                "role":           body.get("role", "Agent"),
                "level":          body.get("level", 1),
                "base_prompt":    body.get("base_prompt", ""),
                "persona":        body.get("persona", ""),
                "status":         "Idle",
            }
            file_path = dept_dir / f"{agent_id}.json"
            file_path.write_text(json.dumps(agent, ensure_ascii=False, indent=2), encoding="utf-8")
            agent["department"] = dept_id
            _json_resp(self, 200, {"ok": True, "agent": agent})

        else:
            _json_resp(self, 404, {"error": "Not found"})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        if path.startswith("/api/agents/"):
            agent_id = path.split("/api/agents/")[1]
            agent = _get_agent(agent_id)
            if not agent:
                _json_resp(self, 404, {"error": "Agent not found"})
                return
            try:
                Path(agent["_file"]).unlink()
                _json_resp(self, 200, {"ok": True, "deleted": agent_id})
            except Exception as e:
                _json_resp(self, 500, {"error": str(e)})
        else:
            _json_resp(self, 404, {"error": "Not found"})


# ── 진입점 ────────────────────────────────────────────────────

if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[server] 명테크 API 서버 시작 → http://localhost:{PORT}/api/health")
    print(f"[server] 에이전트 {len(_load_all_agents())}명 로드됨")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[server] 종료됨")
