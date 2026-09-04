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
import subprocess
import threading
import uuid
import socketserver
try:
    import psutil as _psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False
from http.server import BaseHTTPRequestHandler, HTTPServer

class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True
from pathlib import Path
from datetime import datetime, timezone
from urllib.parse import urlparse, parse_qs

ROOT = Path(__file__).resolve().parent
DEPARTMENTS_DIR  = ROOT / "departments"
SHARED_MEMORY_DIR = ROOT / "shared_memory"
ENV_FILE         = ROOT / ".env"

sys.path.insert(0, str(ROOT / "shared_memory"))
sys.path.insert(0, str(ROOT / "bridge"))
sys.path.insert(0, str(ROOT / "orchestrator"))

import task_queue
import message_broker
from cycle_runner import runner as cycle_runner

# 단기기억 = GraphRAG 지식베이스 참조 (knowledge_base.py, repo 루트). import 실패해도 서버는 떠야 하므로 guard.
try:
    import knowledge_base
except Exception:  # noqa: BLE001
    knowledge_base = None

# 장기기억 FT (Phase 5) — 데이터셋 빌드 + Colab 노트북 생성.
try:
    import longterm
except Exception:  # noqa: BLE001
    longterm = None

def _detect_ollama_host() -> str:
    """환경변수 > localhost > WSL gateway IP 순서로 Ollama 엔드포인트 자동 감지."""
    candidates = []
    env_host = os.environ.get("OLLAMA_HOST") or os.environ.get("OLLAMA_BASE_URL")
    if env_host:
        candidates.append(env_host)
    candidates += ["http://localhost:11434"]
    # WSL2 Windows 호스트 IP 자동 감지
    try:
        with open("/etc/resolv.conf", encoding="utf-8") as f:
            for line in f:
                if line.startswith("nameserver"):
                    win_ip = line.split()[1].strip()
                    candidates.append(f"http://{win_ip}:11434")
                    break
    except OSError:
        pass
    import urllib.request as _ur2
    for host in candidates:
        try:
            _ur2.urlopen(f"{host}/api/tags", timeout=2).close()
            print(f"[server] Ollama 감지됨 → {host}")
            return host
        except Exception:
            continue
    print(f"[server] Ollama 미감지 — 기본값 사용: {candidates[0]}")
    return candidates[0]

OLLAMA_HOST = _detect_ollama_host()

PORT = int(os.environ.get("API_PORT", 9000))

# ── Ollama 상태 프로브 캐시 ───────────────────────────────────
# Ollama가 내려가 있으면 연결 시도가 TCP 타임아웃까지 수 초 블로킹된다. /api/health는
# UI가 10초마다 폴링하므로 매 요청 프로브하면 응답이 계속 느려진다. 성공은 짧게,
# 실패는 조금 더 길게 캐시해 실패 시 반복 대기를 피한다.
_OLLAMA_CACHE = {"at": 0.0, "ok": False, "err": ""}
_OLLAMA_TTL_OK = 5.0
_OLLAMA_TTL_ERR = 15.0
_ollama_cache_lock = threading.Lock()


def _probe_ollama_cached() -> tuple[bool, str]:
    """(ok, error) 반환. TTL 안이면 캐시된 값을 즉시 반환."""
    import urllib.request as _ur

    now = time.time()
    with _ollama_cache_lock:
        ttl = _OLLAMA_TTL_OK if _OLLAMA_CACHE["ok"] else _OLLAMA_TTL_ERR
        if _OLLAMA_CACHE["at"] and (now - _OLLAMA_CACHE["at"]) < ttl:
            return _OLLAMA_CACHE["ok"], _OLLAMA_CACHE["err"]

    ok, err = False, ""
    try:
        with _ur.urlopen(f"{OLLAMA_HOST}/api/tags", timeout=2) as r:
            ok = r.status == 200
    except Exception as e:  # noqa: BLE001
        err = str(e)[:80]

    with _ollama_cache_lock:
        _OLLAMA_CACHE.update(at=time.time(), ok=ok, err=err)
    return ok, err


# ── 단기기억(GraphRAG) 헬퍼 ──────────────────────────────────
def _kb_git(*args, timeout=30):
    """GraphRAG KB repo 안에서 git 실행. (ok, output) 반환."""
    if knowledge_base is None:
        return False, "knowledge_base module unavailable"
    try:
        r = subprocess.run(
            ["git", "-C", str(knowledge_base.KB_PATH), *args],
            capture_output=True, text=True, timeout=timeout,
        )
        return r.returncode == 0, (r.stdout or r.stderr).strip()
    except Exception as e:  # noqa: BLE001
        return False, str(e)


def _kb_status_payload() -> dict:
    """단기기억 참조 상태(경로·노드수·git 브랜치/최근 커밋)."""
    if knowledge_base is None:
        return {"available": False, "error": "knowledge_base module unavailable"}
    kb_ok = knowledge_base.available()
    nodes = knowledge_base.list_nodes() if kb_ok else []
    by = {"concepts": 0, "entities": 0, "comparisons": 0}
    for n in nodes:
        cat = n.split("/", 1)[0]
        if cat in by:
            by[cat] += 1
    branch_ok, branch = _kb_git("rev-parse", "--abbrev-ref", "HEAD")
    commit_ok, commit = _kb_git("log", "-1", "--format=%h · %ci · %s")
    return {
        "path": str(knowledge_base.KB_PATH),
        "available": kb_ok,
        "is_git": branch_ok,
        "branch": branch if branch_ok else None,
        "last_commit": commit if commit_ok else None,
        "total_nodes": len(nodes),
        "by_category": by,
    }


def _kb_sync(message: str = "brain inject"):
    """Auto-Git-Sync: add → commit → pull(-X ours) → push. 단계별 결과 리스트 반환.
    (Connect AI _safeGitAutoSync 벤치마크. 충돌 시 로컬 우선.)"""
    steps = []
    plan = [
        ["add", "-A"],
        ["commit", "-m", message],
        ["pull", "--no-edit", "-X", "ours", "origin", "main"],
        ["push", "origin", "HEAD"],
    ]
    for args in plan:
        ok, out = _kb_git(*args, timeout=120)
        steps.append({"cmd": "git " + " ".join(args), "ok": ok, "out": out[:300]})
    return steps


# ── Phase 4: 에이전트 워크스페이스 (FS/터미널) ────────────────
# 모든 파일·명령은 이 루트로 제한(경로 이탈 방지). 터미널 실행은 옵트인.
WORKSPACE_ROOT = (ROOT / "workspace").resolve()
WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
ALLOW_EXEC = os.environ.get("MYUNGTECH_ALLOW_EXEC", "") in ("1", "true", "True")


def _safe_ws(rel: str) -> Path:
    """workspace 루트 기준 안전 경로 해석. 이탈 시 ValueError."""
    rel = (rel or "").lstrip("/\\")
    p = (WORKSPACE_ROOT / rel).resolve()
    if p != WORKSPACE_ROOT and WORKSPACE_ROOT not in p.parents:
        raise ValueError("path escapes workspace")
    return p


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
                agent = json.loads(agent_file.read_text(encoding="utf-8-sig"))
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
        raw = self.rfile.read(length)
        # UTF-8 우선, 실패 시 CP949(Windows 한글 curl) → 최후엔 replace
        for enc in ("utf-8", "cp949"):
            try:
                return json.loads(raw.decode(enc))
            except (UnicodeDecodeError, json.JSONDecodeError):
                continue
        try:
            return json.loads(raw.decode("utf-8", errors="replace"))
        except json.JSONDecodeError:
            return {}

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        # ── GET /api/health  (상세 서비스 헬스체크)
        if path == "/api/health":
            # Ollama/vLLM 체크 — 결과를 짧게 캐시한다.
            # Ollama가 내려가 있으면 TCP 타임아웃까지 수 초가 걸려 /api/health 자체가
            # 느려지고(관측: 5.7초) UI 폴링·상태 스크립트가 타임아웃된다.
            vllm_ok, vllm_err = _probe_ollama_cached()

            # KB 경로 체크
            kb_ok, kb_path, kb_err = False, "", ""
            if knowledge_base is not None:
                kb_path = str(knowledge_base.KB_PATH)
                kb_ok = knowledge_base.available()
                if not kb_ok:
                    kb_err = f"경로 없음: {kb_path}"
            else:
                kb_err = "knowledge_base 모듈 불가"

            # 워크스페이스 체크
            ws_ok = WORKSPACE_ROOT.exists()

            # 태스크 통계
            all_tasks = task_queue.list_tasks()
            from collections import Counter as _Counter
            counts = _Counter(t.get("status") for t in all_tasks)

            _json_resp(self, 200, {
                "status": "ok",
                "server": {"ok": True, "version": "1.3"},
                "vllm":   {"ok": vllm_ok, "host": OLLAMA_HOST, "error": vllm_err},
                "knowledge_base": {"ok": kb_ok, "path": kb_path, "error": kb_err},
                "workspace": {"ok": ws_ok, "path": str(WORKSPACE_ROOT)},
                "tasks": {
                    "pending":     counts.get("pending", 0),
                    "in_progress": counts.get("in_progress", 0),
                    "done":        counts.get("done", 0),
                    "failed":      counts.get("failed", 0),
                },
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

        # ── GET /api/cycle/status
        elif path == "/api/cycle/status":
            _json_resp(self, 200, cycle_runner.get_status())

        # ── GET /api/system/stats
        elif path == "/api/system/stats":
            if HAS_PSUTIL:
                cpu = _psutil.cpu_percent(interval=0.1)
                mem = _psutil.virtual_memory()
                disk = _psutil.disk_usage("/")
                net = _psutil.net_io_counters()
                _json_resp(self, 200, {
                    "cpu_percent": cpu,
                    "mem_percent": mem.percent,
                    "mem_used_gb": round(mem.used / 1024**3, 2),
                    "mem_total_gb": round(mem.total / 1024**3, 2),
                    "disk_percent": disk.percent,
                    "disk_used_gb": round(disk.used / 1024**3, 2),
                    "disk_total_gb": round(disk.total / 1024**3, 2),
                    "net_sent_mb": round(net.bytes_sent / 1024**2, 2),
                    "net_recv_mb": round(net.bytes_recv / 1024**2, 2),
                })
            else:
                _json_resp(self, 200, {"error": "psutil not installed", "cpu_percent": 0, "mem_percent": 0})

        # ── GET /api/tasks/list?status=&limit=20&offset=0
        elif path == "/api/tasks/list":
            qs = parse_qs(parsed.query)
            status_filter = (qs.get("status") or [None])[0]
            limit  = int((qs.get("limit")  or ["20"])[0])
            offset = int((qs.get("offset") or ["0"])[0])
            all_t  = task_queue.list_tasks(status_filter)
            all_t.sort(key=lambda t: t.get("updated_at", ""), reverse=True)
            total  = len(all_t)
            page   = all_t[offset: offset + limit]
            _json_resp(self, 200, {"tasks": page, "total": total, "limit": limit, "offset": offset})

        # ── GET /api/tasks/:id
        elif path.startswith("/api/tasks/") and path != "/api/tasks/summary" and path != "/api/tasks/list":
            task_id = path.split("/api/tasks/")[1]
            t = task_queue.get_task(task_id)
            if t:
                # 연관 이벤트 (task_id 필드가 있으면 연결)
                events = message_broker.fetch_events()
                linked = [e for e in events if e.get("task_id") == task_id]
                _json_resp(self, 200, {"task": t, "events": linked})
            else:
                _json_resp(self, 404, {"error": "Task not found"})

        # ── GET /api/tasks/summary
        elif path == "/api/tasks/summary":
            from collections import Counter
            all_tasks = task_queue.list_tasks()
            counts = Counter(t.get("status", "unknown") for t in all_tasks)
            _json_resp(self, 200, {
                "pending":     counts.get("pending", 0),
                "in_progress": counts.get("in_progress", 0),
                "done":        counts.get("done", 0),
                "failed":      counts.get("failed", 0),
                "total":       len(all_tasks),
            })

        # ── GET /api/models  (Ollama 설치 모델 목록)
        elif path == "/api/models":
            try:
                import urllib.request
                url = f"{OLLAMA_HOST}/api/tags"
                with urllib.request.urlopen(url, timeout=5) as r:
                    data = json.loads(r.read().decode())
                models = [
                    {"id": m["name"], "size": m.get("size", 0)}
                    for m in data.get("models", [])
                ]
                _json_resp(self, 200, {"models": models})
            except Exception as e:
                _json_resp(self, 200, {"models": [], "error": str(e)})

        # ── GET /api/knowledge/status  (단기기억 = GraphRAG 참조 상태)
        elif path == "/api/knowledge/status":
            _json_resp(self, 200, _kb_status_payload())

        # ── GET /api/knowledge/nodes?category=concepts
        elif path == "/api/knowledge/nodes":
            cat = (parse_qs(parsed.query).get("category") or [None])[0]
            try:
                _json_resp(self, 200, {"nodes": knowledge_base.list_nodes(cat)})
            except Exception as e:
                _json_resp(self, 200, {"nodes": [], "error": str(e)})

        # ── GET /api/knowledge/search?q=...
        elif path == "/api/knowledge/search":
            q = (parse_qs(parsed.query).get("q") or [""])[0]
            try:
                hits = knowledge_base.search(q) if q else []
                _json_resp(self, 200, {"query": q,
                                       "hits": [{"node": n, "line": ln} for n, ln in hits]})
            except Exception as e:
                _json_resp(self, 200, {"hits": [], "error": str(e)})

        # ── GET /api/knowledge/read?slug=concepts/transformer
        elif path == "/api/knowledge/read":
            slug = (parse_qs(parsed.query).get("slug") or [""])[0]
            try:
                _json_resp(self, 200, {"slug": slug, "content": knowledge_base.read_node(slug)})
            except Exception as e:
                _json_resp(self, 404, {"error": str(e)})

        # ── GET /api/fs/list?path=  (워크스페이스 디렉터리 목록)
        elif path == "/api/fs/list":
            rel = (parse_qs(parsed.query).get("path") or [""])[0]
            try:
                d = _safe_ws(rel)
                if not d.is_dir():
                    _json_resp(self, 404, {"error": "not a directory"})
                    return
                entries = []
                for p in sorted(d.iterdir(), key=lambda x: (x.is_file(), x.name.lower())):
                    entries.append({
                        "name": p.name,
                        "is_dir": p.is_dir(),
                        "size": (p.stat().st_size if p.is_file() else 0),
                        "path": str(p.relative_to(WORKSPACE_ROOT)).replace("\\", "/"),
                    })
                _json_resp(self, 200, {"path": rel, "entries": entries})
            except Exception as e:
                _json_resp(self, 400, {"error": str(e)})

        # ── GET /api/fs/read?path=  (파일 읽기)
        elif path == "/api/fs/read":
            rel = (parse_qs(parsed.query).get("path") or [""])[0]
            try:
                f = _safe_ws(rel)
                if not f.is_file():
                    _json_resp(self, 404, {"error": "not a file"})
                    return
                if f.stat().st_size > 512 * 1024:
                    _json_resp(self, 413, {"error": "file too large (>512KB)"})
                    return
                _json_resp(self, 200, {"path": rel, "content": f.read_text(encoding="utf-8", errors="replace")})
            except Exception as e:
                _json_resp(self, 400, {"error": str(e)})

        else:
            _json_resp(self, 404, {"error": "Not found"})

    def do_DELETE(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        if path.startswith("/api/tasks/"):
            task_id = path.split("/api/tasks/")[1]
            ok = task_queue.delete_task(task_id) if hasattr(task_queue, "delete_task") else False
            _json_resp(self, 200, {"ok": ok, "task_id": task_id})
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

        # ── POST /api/cycle/start
        if path == "/api/cycle/start":
            body     = self._read_body()
            interval = int(body.get("interval", 3600))
            ok = cycle_runner.start(interval=interval)
            _json_resp(self, 200, {"ok": ok, "interval": interval, **cycle_runner.get_status()})

        # ── POST /api/cycle/stop
        elif path == "/api/cycle/stop":
            cycle_runner.stop()
            _json_resp(self, 200, {"ok": True, **cycle_runner.get_status()})

        # ── POST /api/cycle/run_once
        elif path == "/api/cycle/run_once":
            ok = cycle_runner.run_once()
            _json_resp(self, 200, {"ok": ok, **cycle_runner.get_status()})

        # ── POST /api/business/ideas  (AI 비즈니스 아이디어 생성)
        elif path == "/api/business/ideas":
            body = self._read_body()
            context = body.get("context", "명테크 멀티-에이전트 워크스페이스")
            task = task_queue.enqueue(
                sender="studio_ui",
                target_dept="orchestration_dept",
                instruction=(
                    f"우리 비즈니스 컨텍스트: {context}\n\n"
                    "구체적인 비즈니스 아이디어를 3가지 제안해줘.\n"
                    "아래 형식을 그대로 지켜서 쓰고, 형식 밖의 말은 붙이지 마.\n\n"
                    "### 아이디어 1\n"
                    "제목: (한 줄)\n"
                    "가치: (한두 문장)\n"
                    "난이도: 쉬움 / 보통 / 어려움 중 하나만\n"
                    "수익: (수익 모델 한 줄)\n"
                    "첫걸음: (가장 먼저 할 일 한 줄)\n\n"
                    "### 아이디어 2\n(같은 형식)\n\n"
                    "### 아이디어 3\n(같은 형식)\n\n"
                    "한국어로, 실용적으로."
                ),
                priority=9,
            )
            _json_resp(self, 200, {"ok": True, "task_id": task["task_id"]})

        # ── POST /api/tasks/batch  (여러 태스크 동시 실행)
        elif path == "/api/tasks/batch":
            body = self._read_body()
            tasks_in = body.get("tasks", [])
            created = []
            for t in tasks_in:
                task = task_queue.enqueue(
                    sender="studio_ui",
                    target_dept=t.get("department", "orchestration_dept"),
                    instruction=t.get("instruction", ""),
                    priority=t.get("priority", 7),
                )
                created.append({"task_id": task["task_id"], "department": t.get("department")})
            _json_resp(self, 200, {"ok": True, "tasks": created, "count": len(created)})

        # ── GET /api/config/load  (저장된 키 이름 목록 반환 — 값은 마스킹)
        elif path == "/api/config/load":
            keys: dict[str, bool] = {}
            if ENV_FILE.exists():
                for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
                    if "=" in line and not line.startswith("#"):
                        k = line.split("=")[0].strip()
                        v = line.split("=", 1)[1].strip().strip('"')
                        keys[k] = bool(v)
            _json_resp(self, 200, {"keys": keys})

        # ── POST /api/config/save  (.env 저장)
        elif path == "/api/config/save":
            body = self._read_body()
            lines: list[str] = []
            if ENV_FILE.exists():
                existing = ENV_FILE.read_text(encoding="utf-8").splitlines()
                # 이미 있는 키는 덮어쓰기
                keys_to_update = set(body.keys())
                for line in existing:
                    key = line.split("=")[0].strip()
                    if key not in keys_to_update:
                        lines.append(line)
            for k, v in body.items():
                if v:
                    lines.append(f'{k}="{v}"')
            ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
            _json_resp(self, 200, {"ok": True, "saved": list(body.keys())})

        # ── POST /api/workflow/run  (UI 채팅 → 즉시 태스크 + 폴링 결과 반환)
        elif path == "/api/workflow/run":
            body    = self._read_body()
            dept    = body.get("department", "orchestration_dept")
            task_in = body.get("task", "")
            if not task_in:
                _json_resp(self, 400, {"error": "task required"})
                return
            task = task_queue.enqueue(
                sender="studio_ui",
                target_dept=dept,
                instruction=task_in,
                priority=8,
            )
            # 최대 120초 폴링
            task_id = task["task_id"]
            deadline = time.time() + 120
            while time.time() < deadline:
                t = task_queue.get_task(task_id)
                if t and t["status"] == "done":
                    _json_resp(self, 200, {"ok": True, "result": t.get("result", ""), "task_id": task_id})
                    return
                if t and t["status"] == "failed":
                    _json_resp(self, 200, {"ok": False, "result": t.get("result", "실패"), "task_id": task_id})
                    return
                time.sleep(2)
            _json_resp(self, 200, {
                "ok": True,
                "result": "태스크가 큐에 등록되었습니다. 디스패처가 실행 중입니다.",
                "task_id": task_id,
            })

        elif path == "/api/workflow/trigger":
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

        # ── POST /api/knowledge/pull  (깃에서 GraphRAG 단기기억 최신본 참조)
        elif path == "/api/knowledge/pull":
            ok, out = _kb_git("pull", "--ff-only", timeout=60)
            payload = _kb_status_payload()
            payload["pull_ok"] = ok
            payload["pull_output"] = out
            _json_resp(self, 200, payload)

        # ── POST /api/knowledge/inject  (⚡ 지식 주입 → raw/ 저장 → 자동 동기화)
        elif path == "/api/knowledge/inject":
            if knowledge_base is None:
                _json_resp(self, 500, {"ok": False, "error": "knowledge_base unavailable"})
                return
            body = self._read_body()
            title = (body.get("title") or "").strip()
            content = body.get("content") or ""
            if not title and not content.strip():
                _json_resp(self, 400, {"ok": False, "error": "title 또는 content 필요"})
                return
            try:
                rel = knowledge_base.inject(title or "untitled",
                                            content,
                                            source_url=body.get("source_url", ""))
            except Exception as e:  # noqa: BLE001
                _json_resp(self, 500, {"ok": False, "error": str(e)})
                return
            out = {"ok": True, "injected": rel}
            # 기본값: 자동 동기화 ON (Connect AI 패턴). sync=false 로 끌 수 있음.
            if body.get("sync", True):
                out["sync_steps"] = _kb_sync(f"inject: {rel}")
            out["status"] = _kb_status_payload()
            _json_resp(self, 200, out)

        # ── POST /api/knowledge/sync  (⬆ 백업 = git add/commit/pull/push)
        elif path == "/api/knowledge/sync":
            body = self._read_body()
            steps = _kb_sync(body.get("message") or "manual sync")
            _json_resp(self, 200, {"ok": all(s["ok"] for s in steps[2:]),
                                   "steps": steps, "status": _kb_status_payload()})

        # ── POST /api/fs/write  {path, content}  (파일 생성/수정)
        elif path == "/api/fs/write":
            body = self._read_body()
            try:
                f = _safe_ws(body.get("path", ""))
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_text(body.get("content", ""), encoding="utf-8")
                _json_resp(self, 200, {"ok": True,
                                       "path": str(f.relative_to(WORKSPACE_ROOT)).replace("\\", "/")})
            except Exception as e:
                _json_resp(self, 400, {"ok": False, "error": str(e)})

        # ── POST /api/fs/delete  {path}
        elif path == "/api/fs/delete":
            body = self._read_body()
            try:
                f = _safe_ws(body.get("path", ""))
                if f == WORKSPACE_ROOT:
                    raise ValueError("cannot delete workspace root")
                if f.is_dir():
                    import shutil
                    shutil.rmtree(f)
                elif f.exists():
                    f.unlink()
                _json_resp(self, 200, {"ok": True})
            except Exception as e:
                _json_resp(self, 400, {"ok": False, "error": str(e)})

        # ── POST /api/term/run  {cmd}  (터미널 실행 — 옵트인 MYUNGTECH_ALLOW_EXEC=1)
        elif path == "/api/term/run":
            if not ALLOW_EXEC:
                _json_resp(self, 403, {
                    "ok": False,
                    "error": "터미널 실행 비활성화. 켜려면 MYUNGTECH_ALLOW_EXEC=1 설정 후 server.py 재시작.",
                })
                return
            body = self._read_body()
            cmd = (body.get("cmd") or "").strip()
            if not cmd:
                _json_resp(self, 400, {"ok": False, "error": "empty command"})
                return
            try:
                r = subprocess.run(
                    cmd, shell=True, cwd=str(WORKSPACE_ROOT),
                    capture_output=True, text=True, timeout=int(body.get("timeout", 60)),
                )
                out = (r.stdout or "") + (("\n" + r.stderr) if r.stderr else "")
                _json_resp(self, 200, {"ok": r.returncode == 0, "code": r.returncode,
                                       "output": out[-8000:]})
            except subprocess.TimeoutExpired:
                _json_resp(self, 200, {"ok": False, "error": "timeout"})
            except Exception as e:
                _json_resp(self, 200, {"ok": False, "error": str(e)})

        # ── POST /api/longterm/build-dataset  (장기기억: GraphRAG→SFT JSONL)
        elif path == "/api/longterm/build-dataset":
            if longterm is None:
                _json_resp(self, 500, {"ok": False, "error": "longterm module unavailable"})
                return
            body = self._read_body()
            try:
                out = WORKSPACE_ROOT / "training" / "sft_dataset.jsonl"
                res = longterm.build_sft_dataset(out, mode=body.get("mode", "sft"))
                res["ok"] = True
                res["rel"] = "training/sft_dataset.jsonl"
                _json_resp(self, 200, res)
            except Exception as e:
                _json_resp(self, 400, {"ok": False, "error": str(e)})

        # ── POST /api/longterm/colab  (LoRA 파인튜닝 Colab 노트북 생성)
        elif path == "/api/longterm/colab":
            if longterm is None:
                _json_resp(self, 500, {"ok": False, "error": "longterm module unavailable"})
                return
            body = self._read_body()
            try:
                out = WORKSPACE_ROOT / "training" / "finetune_colab.ipynb"
                res = longterm.make_colab_notebook(
                    out,
                    base_model=body.get("base_model") or "unsloth/Qwen2.5-3B-Instruct",
                    hf_repo=body.get("hf_repo") or "username/my-brain-v1",
                    rank=int(body.get("rank", 16)),
                    epochs=int(body.get("epochs", 3)),
                    lr=float(body.get("lr", 2e-4)),
                )
                res["ok"] = True
                res["rel"] = "training/finetune_colab.ipynb"
                _json_resp(self, 200, res)
            except Exception as e:
                _json_resp(self, 400, {"ok": False, "error": str(e)})

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
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"[server] 명테크 API 서버 시작 → http://localhost:{PORT}/api/health")
    print(f"[server] 에이전트 {len(_load_all_agents())}명 로드됨")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[server] 종료됨")
