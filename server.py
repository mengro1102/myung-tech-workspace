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

# 런타임 설정. UI 에서 고른 '공통 두뇌'가 여기 적히고, 디스패처가 이 파일을
# 읽는다. 예전에는 UI 의 React state 에만 있어서 새로고침하면 사라졌고 추론에는
# 아무 영향이 없었다 — 고를 수는 있는데 아무 데도 반영되지 않는 장식이었다.
RUNTIME_CONFIG = ROOT / "runtime_config.json"
DEFAULT_GLOBAL_MODEL = "qwen2.5:7b"


# ── YouTube Analytics OAuth ─────────────────────────────────────────────
#
# '자동 연결' 버튼은 onClick 조차 없었다. 구글은 인가 코드를 브라우저 리다이렉트로
# 돌려주므로, 그 코드를 받을 자리가 이쪽에 있어야 한다. 로컬 루프백을 리다이렉트
# URI 로 쓰는 것은 구글이 데스크톱 앱에 권장하는 방식이다.
#
# 받은 refresh_token 만 .env 에 남긴다. access_token 은 한 시간이면 만료되므로
# 저장할 이유가 없다.
YT_OAUTH_PORT = 5814
YT_REDIRECT_URI = f"http://127.0.0.1:{YT_OAUTH_PORT}/yt-oauth-callback"
YT_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly"
_yt_oauth: dict = {"state": "", "code": "", "error": "", "started_at": 0.0}


def _env_get(key: str) -> str:
    if not ENV_FILE.exists():
        return ""
    for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        if line.startswith(f"{key}=") and not line.startswith("#"):
            return line.split("=", 1)[1].strip().strip('"')
    return ""


def _env_set(key: str, value: str) -> None:
    lines = []
    if ENV_FILE.exists():
        lines = [l for l in ENV_FILE.read_text(encoding="utf-8").splitlines()
                 if not l.startswith(f"{key}=")]
    lines.append(f'{key}="{value}"')
    ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _yt_catch_code(timeout: int = 180) -> None:
    """리다이렉트를 한 번만 받고 닫는 아주 작은 서버.

    구글이 브라우저를 이 주소로 되돌려 보낼 때 쿼리에 code 가 실려 온다.
    사람이 로그인하는 동안만 살아 있으면 되므로 스레드 하나로 충분하다.
    """
    import http.server

    class _Once(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            q = parse_qs(urlparse(self.path).query)
            _yt_oauth["code"] = (q.get("code") or [""])[0]
            _yt_oauth["error"] = (q.get("error") or [""])[0]
            ok = bool(_yt_oauth["code"]) and (q.get("state") or [""])[0] == _yt_oauth["state"]
            if not ok and not _yt_oauth["error"]:
                _yt_oauth["error"] = "state 불일치 — 다시 시도하세요"
            msg = ("연결되었습니다. 이 창을 닫고 명테크로 돌아가세요."
                   if ok else f"실패: {_yt_oauth['error'] or '알 수 없는 오류'}")
            body = f"<meta charset='utf-8'><body style='font-family:sans-serif'>{msg}</body>"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(body.encode("utf-8"))

        def log_message(self, *a):  # 콘솔을 더럽히지 않는다
            pass

    try:
        srv = http.server.HTTPServer(("127.0.0.1", YT_OAUTH_PORT), _Once)
    except OSError as e:  # 포트가 이미 물려 있다
        _yt_oauth["error"] = f"포트 {YT_OAUTH_PORT} 를 열 수 없습니다: {e}"
        return
    srv.timeout = timeout
    srv.handle_request()      # 딱 한 번
    srv.server_close()


def _yt_exchange(code: str, client_id: str, client_secret: str) -> dict:
    """인가 코드를 refresh_token 으로 바꾼다."""
    import urllib.parse
    import urllib.request
    data = urllib.parse.urlencode({
        "code": code, "client_id": client_id, "client_secret": client_secret,
        "redirect_uri": YT_REDIRECT_URI, "grant_type": "authorization_code",
    }).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data,
                                 method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def _approval_followup(row: dict) -> dict:
    """승인/거절의 결과를 원래 부서에게 돌려준다.

    승인이면 태스크를 새로 만들어 큐에 넣는다 — 결재를 올린 그 부서가, 자기가
    올렸던 안건을 이번에는 '허락받았다'는 전제로 다시 받는다. 거절이면 태스크는
    만들지 않고 이벤트만 남긴다(같은 일을 다시 시도하지 않도록).
    """
    dept = row.get("department") or "orchestration_dept"
    label = str(row.get("label") or "").strip()
    approved = row.get("status") == "approved"
    verdict = "승인" if approved else "거절"

    # 바깥으로 나가는 행위(업로드·PR·수정). 여기가 실제 호출이 일어나는
    # 유일한 자리다 — 에이전트는 제안만 했고, 이 승인이 방아쇠다.
    if row.get("kind") == "action":
        if not approved:
            return {"queued": False, "reason": "거절 — 실행하지 않았습니다"}
        if integrations is None:
            return {"queued": False, "reason": "연동 모듈을 불러오지 못했습니다"}
        try:
            out = integrations.run_action(row.get("integration", ""),
                                          row.get("action", ""),
                                          row.get("action_args") or {})
        except Exception as e:  # noqa: BLE001
            # 실패를 조용히 삼키면 '승인했는데 아무 일도 안 일어남' 이 된다.
            workspace_store.update("approvals", row["id"], {"result": f"실패: {e}"})
            return {"queued": False, "reason": f"실행 실패: {e}"}
        workspace_store.update("approvals", row["id"], {"result": out})
        try:
            message_broker.publish_event(sender="studio_ui", target=dept,
                                         payload=f"실행 완료 — {out[:160]}")
        except Exception:  # noqa: BLE001
            pass
        return {"queued": False, "ran": out}

    # 프로젝트 착수 승인. 이 승인 하나로 자율 실행이 시작되고, 그 뒤로는
    # 결과가 나올 때까지 사람을 다시 부르지 않는다 — 진전이 멈출 때만 부른다.
    if row.get("kind") == "project":
        pid = row.get("project_id") or ""
        if not approved:
            projects.update(pid, {"status": "cancelled",
                                  "pause_reason": "사장님이 착수를 거절했습니다"})
            return {"queued": False, "reason": "거절 — 프로젝트를 접었습니다"}
        try:
            import project_runner
            project_runner.approve(pid)
        except Exception as e:  # noqa: BLE001
            return {"queued": False, "reason": f"착수 실패: {e}"}
        return {"queued": True, "project_id": pid, "autonomous": True}

    # 파일 제안은 승인 순간에 디스크로 간다. 후속 태스크를 만들지는 않는다 —
    # 파일이 생긴 것으로 그 안건은 끝이다.
    if row.get("kind") == "file":
        if not approved:
            return {"queued": False, "reason": "거절 — 파일을 쓰지 않았습니다"}
        try:
            written = file_proposals.write(row.get("file_path", ""),
                                           row.get("file_content", ""))
        except Exception as e:  # noqa: BLE001
            return {"queued": False, "reason": f"파일 저장 실패: {e}"}
        try:
            message_broker.publish_event(
                sender="studio_ui", target=dept,
                payload=f"파일 저장됨 — workspace/{written}")
        except Exception:  # noqa: BLE001
            pass
        return {"queued": False, "wrote": f"workspace/{written}"}

    try:
        message_broker.publish_event(
            sender="studio_ui", target=dept,
            payload=f"결재 {verdict} — {label[:160]}")
    except Exception:  # noqa: BLE001
        pass

    if not approved:
        return {"queued": False, "reason": "거절 — 후속 태스크를 만들지 않습니다"}

    detail = str(row.get("detail") or "").strip()
    instruction = (
        f"[결재 승인됨] 아래 안건이 사장님 승인을 받았습니다. 이제 실행 단계를 진행하세요.\n\n"
        f"승인된 안건: {label}\n"
        + (f"원래 요청 맥락: {detail}\n" if detail else "")
        + "\n승인 범위를 넘는 새 지출이나 공개가 필요하면 다시 결재를 올리세요."
    )
    try:
        task = task_queue.enqueue(sender="studio_ui", target_dept=dept,
                                  instruction=instruction, priority=9)
        workspace_store.update("approvals", row["id"], {"task_id": task["task_id"]})
        return {"queued": True, "task_id": task["task_id"], "department": dept}
    except Exception as e:  # noqa: BLE001
        return {"queued": False, "reason": str(e)}


def _ollama_models() -> list[dict]:
    """Ollama 에 실제로 설치된 모델 목록. 실패하면 빈 목록."""
    try:
        import urllib.request
        with urllib.request.urlopen(f"{OLLAMA_HOST}/api/tags", timeout=5) as r:
            return json.loads(r.read().decode()).get("models", [])
    except Exception:
        return []


def _runtime_config() -> dict:
    try:
        return json.loads(RUNTIME_CONFIG.read_text(encoding="utf-8"))
    except Exception:
        return {}


def _save_runtime_config(patch: dict) -> dict:
    cfg = _runtime_config()
    cfg.update(patch)
    RUNTIME_CONFIG.write_text(
        json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    return cfg


# UI 연동 탭에서 저장할 수 있는 키. 여기 없는 이름은 거부한다.
ALLOWED_ENV_KEYS = {
    "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID",
    "YOUTUBE_API_KEY", "YOUTUBE_CHANNEL_ID",
    "YOUTUBE_OAUTH_CLIENT_ID", "YOUTUBE_OAUTH_CLIENT_SECRET",
    # PAYPAL_MODE 가 빠져 있었다. UI 는 이 셋을 함께 보내므로 PayPal 저장이
    # 통째로 400 으로 거부되고 있었다 — 화면에는 저장 실패 이유가 안 보였다.
    "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_MODE",
    "TOSS_SECRET_KEY",
    "GITHUB_TOKEN", "HUGGINGFACE_TOKEN",
    # OAuth 왕복으로 받은 refresh_token. 서버가 직접 쓴다.
    "YOUTUBE_OAUTH_REFRESH_TOKEN",
}

sys.path.insert(0, str(ROOT / "shared_memory"))
sys.path.insert(0, str(ROOT / "bridge"))
sys.path.insert(0, str(ROOT / "orchestrator"))

import task_queue
import message_broker
import workspace_store
import file_proposals
import projects
try:
    import integrations
except Exception as _integ_exc:  # noqa: BLE001
    integrations = None
    print(f'[server] 연동 모듈 로드 실패: {_integ_exc}', file=sys.stderr)
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

# 이 서버에는 인증이 없다. 태스크 큐, 워크스페이스 파일 쓰기·삭제, .env 저장까지
# 전부 무인증인데 0.0.0.0 에 바인드하고 있었다 — 같은 네트워크의 누구나 손댈 수
# 있었다는 뜻이다. 이 PC 에서만 쓰므로 루프백에 고정한다. 바깥에 열어야 할 일이
# 생기면 그때는 바인드만 바꿀 게 아니라 인증부터 붙여야 한다.
BIND_HOST = "127.0.0.1"

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
    """위키 백업: add → commit → pull → push. 단계별 결과 리스트를 돌려준다.

    예전에는 pull 에 `-X ours` 가 붙어 있었다. 충돌이 나면 원격 쪽 변경을 말없이
    버린다는 뜻이다. 위키는 PC2 와 수집 크론도 커밋하는 저장소라, 다른 데서 쓴
    글이 이 버튼 한 번에 조용히 사라질 수 있었다. 충돌은 조용히 이기는 것보다
    시끄럽게 멈추는 편이 낫다 — 그냥 pull 하고, 충돌하면 그 단계에서 실패로
    보고한다(로컬 커밋은 이미 되어 있으니 잃는 것은 없다).
    """
    steps = []
    plan = [
        ["add", "-A"],
        ["commit", "-m", message],
        ["pull", "--no-rebase", "--no-edit", "origin", "main"],
        ["push", "origin", "HEAD"],
    ]
    for args in plan:
        ok, out = _kb_git(*args, timeout=120)
        steps.append({"cmd": "git " + " ".join(args), "ok": ok, "out": out[:300]})
        # pull 이 충돌로 멈췄으면 push 로 넘어가지 않는다. 반쯤 병합된 상태를
        # 원격에 밀어 넣는 것이 가장 나쁘다.
        if not ok and args[0] == "pull" and "CONFLICT" in out.upper():
            steps.append({"cmd": "git push origin HEAD", "ok": False,
                          "out": "충돌 때문에 건너뜀 — 저장소에서 직접 해결하세요."})
            break
    return steps


# ── Phase 4: 에이전트 워크스페이스 (FS/터미널) ────────────────
# 에이전트 산출물(SFT 데이터셋·Colab 노트북)이 떨어지는 곳.
WORKSPACE_ROOT = (ROOT / "workspace").resolve()
WORKSPACE_ROOT.mkdir(parents=True, exist_ok=True)
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


def _project_runner_loop():
    """자율 프로젝트를 한 스텝씩 굴린다.

    별도 프로세스로 두지 않는 이유: 프로젝트는 계획 → 초안 → 검토가
    파일 하나에 이어져 있고 스텝 사이에 상태가 남는다. 프로세스가 하나 더
    늘면 START/STOP 배치와 상태 확인에 항목이 하나 더 붙는데, 얻는 것이
    없다 — LLM 호출은 어차피 네트워크 대기라 GIL 을 쥐고 있지 않는다.

    한 바퀴에 프로젝트마다 딱 한 스텝만 나아간다. 그래야 프로젝트가 여럿일
    때 하나가 나머지를 굶기지 않는다.
    """
    import project_runner
    while True:
        try:
            moved = project_runner.run_once_all()
        except Exception as exc:  # noqa: BLE001
            print(f"[projects] 루프 오류(계속 진행): {exc}", file=sys.stderr)
            moved = 0
        time.sleep(1.0 if moved else 5.0)


threading.Thread(target=_project_runner_loop, daemon=True).start()


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
                # "/" 는 윈도우에서 현재 작업 디렉터리의 드라이브 루트로 풀린다 —
                # 어디서 띄우느냐에 따라 C: 가 되기도 D: 가 되기도 한다. 이 시스템이
                # 사는 드라이브를 명시한다.
                disk = _psutil.disk_usage(str(ROOT.anchor))
                net = _psutil.net_io_counters()
                _json_resp(self, 200, {
                    "cpu_percent": cpu,
                    "mem_percent": mem.percent,
                    "mem_used_gb": round(mem.used / 1024**3, 2),
                    "mem_total_gb": round(mem.total / 1024**3, 2),
                    "disk_percent": disk.percent,
                    "disk_mount": ROOT.anchor,
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

        # ── GET /api/store/<collection>  (할 일 · 등록 서비스 · 승인 큐)
        #    브라우저에만 있던 것들을 서버로 올렸다. 에이전트도 같은 파일을 읽고
        #    쓴다 — 그래야 "에이전트가 할 일을 쌓는다"가 말이 된다.
        # 가이드 원문. 화면에서 바로 열 수 있어야 한다 — 문서가 있어도
        # 찾지 못하면 "물어보고 등록하는 절차" 가 그대로 남는다.
        elif path == "/api/docs/integrations":
            doc = ROOT / "docs" / "INTEGRATIONS.md"
            try:
                _json_resp(self, 200, {"markdown": doc.read_text(encoding="utf-8")})
            except OSError as e:
                _json_resp(self, 404, {"error": f"문서를 읽지 못했습니다: {e}"})

        elif path == "/api/integrations":
            # 각 연동을 **실제로 한 번 호출해 본다.** 키가 저장돼 있다는 것과
            # 그 키로 호출이 되더라는 것은 다르다 — 예전 화면은 전자를
            # "연결됨" 이라고 불렀다.
            if integrations is None:
                _json_resp(self, 200, {"integrations": [],
                                       "error": "연동 모듈을 불러오지 못했습니다"})
            else:
                _json_resp(self, 200, {"integrations": integrations.status_all()})

        elif path == "/api/projects":
            rows = []
            for p in projects.load():
                # 목록에는 본문을 싣지 않는다. 산출물이 수만 자라 화면이 굳는다.
                rows.append({k: v for k, v in p.items()
                             if k not in ("artifacts", "steps")}
                            | {"progress": projects.progress(p),
                               "step_count": len(p.get("steps") or []),
                               "budget_left": projects.budget_left(p)})
            _json_resp(self, 200, {"projects": rows})

        elif path.startswith("/api/projects/"):
            pid = path.split("/api/projects/")[1]
            p = projects.get(pid)
            if p is None:
                _json_resp(self, 404, {"error": f"없는 프로젝트: {pid}"})
                return
            _json_resp(self, 200, {"project": p | {
                "progress": projects.progress(p),
                "budget_left": projects.budget_left(p)}})

        elif path.startswith("/api/store/"):
            collection = path.split("/api/store/")[1]
            if collection not in workspace_store.COLLECTIONS:
                _json_resp(self, 404, {"error": f"알 수 없는 컬렉션: {collection}"})
                return
            _json_resp(self, 200, {"items": workspace_store.load(collection)})

        # ── GET /api/youtube/oauth/status
        elif path == "/api/youtube/oauth/status":
            _json_resp(self, 200, {
                "connected": bool(_env_get("YOUTUBE_OAUTH_REFRESH_TOKEN")),
                "has_client": bool(_env_get("YOUTUBE_OAUTH_CLIENT_ID")
                                   and _env_get("YOUTUBE_OAUTH_CLIENT_SECRET")),
                "redirect_uri": YT_REDIRECT_URI,
                "pending": bool(_yt_oauth["state"]) and not _yt_oauth["code"],
                "error": _yt_oauth["error"],
            })

        # ── GET /api/config/model  (공통 두뇌 — 디스패처와 공유하는 단일 출처)
        elif path == "/api/config/model":
            cfg = _runtime_config()
            _json_resp(self, 200, {
                "global_model": cfg.get("global_model", DEFAULT_GLOBAL_MODEL),
                "default": DEFAULT_GLOBAL_MODEL,
            })

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

        # ── GET /api/models  (Ollama 설치 모델 목록)
        elif path == "/api/models":
            models = [{"id": m["name"], "size": m.get("size", 0)}
                      for m in _ollama_models()]
            _json_resp(self, 200, {"models": models})

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



        else:
            _json_resp(self, 404, {"error": "Not found"})

    def do_PUT(self):
        """PATCH 대신 PUT 을 쓴다 — do_PATCH 는 이미 에이전트 수정에 쓰고 있다."""
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        if path.startswith("/api/store/"):
            rest = path.split("/api/store/")[1].split("/")
            if len(rest) != 2 or rest[0] not in workspace_store.COLLECTIONS:
                _json_resp(self, 404, {"error": "Not found"})
                return
            patch = self._read_body()
            row = workspace_store.update(rest[0], rest[1], patch)
            if row is None:
                _json_resp(self, 404, {"ok": False, "error": "항목이 없습니다"})
                return
            out = {"ok": True, "item": row}
            # 결재는 상태만 바뀌고 끝나면 결재가 아니다. 승인하면 올린 부서에게
            # "허락받았으니 진행하라"고 되돌려 준다.
            if rest[0] == "approvals" and patch.get("status") in ("approved", "rejected"):
                out["followup"] = _approval_followup(row)
            _json_resp(self, 200, out)
        else:
            _json_resp(self, 404, {"error": "Not found"})

    def do_DELETE(self):
        # do_DELETE 가 클래스 안에 두 번 정의돼 있었다. 파이썬은 뒤엣것으로
        # 덮어쓰므로 에이전트 삭제만 살아 있고 태스크 삭제는 죽어 있었다 —
        # UI 의 태스크 삭제 버튼이 조용히 아무 일도 하지 않은 이유다. 합친다.
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")

        if path.startswith("/api/store/"):
            rest = path.split("/api/store/")[1].split("/")
            if len(rest) != 2 or rest[0] not in workspace_store.COLLECTIONS:
                _json_resp(self, 404, {"error": "Not found"})
                return
            _json_resp(self, 200, {"ok": workspace_store.remove(rest[0], rest[1])})

        elif path.startswith("/api/projects/"):
            pid = path.split("/api/projects/")[1]
            _json_resp(self, 200, {"ok": projects.remove(pid)})

        elif path.startswith("/api/tasks/"):
            task_id = path.split("/api/tasks/")[1]
            ok = task_queue.delete_task(task_id) if hasattr(task_queue, "delete_task") else False
            _json_resp(self, 200, {"ok": ok, "task_id": task_id})

        elif path.startswith("/api/agents/"):
            agent_id = path.split("/api/agents/")[1]
            agent = _get_agent(agent_id)
            if not agent:
                _json_resp(self, 404, {"error": "Agent not found"})
                return
            try:
                Path(agent["_file"]).unlink()
                _json_resp(self, 200, {"ok": True, "deleted": agent_id})
            except Exception as e:  # noqa: BLE001
                _json_resp(self, 500, {"error": str(e)})

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

        # ── POST /api/store/<collection>  {…}  (항목 추가)
        elif path.startswith("/api/integrations/") and path.endswith("/probe"):
            name = path.split("/api/integrations/")[1].rsplit("/probe", 1)[0]
            integ = integrations.get(name) if integrations else None
            if integ is None:
                _json_resp(self, 404, {"error": f"알 수 없는 연동: {name}"})
                return
            _json_resp(self, 200, {"ok": True, "status": integ.status()})

        elif path == "/api/projects":
            body = self._read_body()
            idea = str(body.get("idea") or "").strip()
            if not idea:
                _json_resp(self, 400, {"error": "아이디어를 적어 주세요"})
                return
            # 계획 수립은 LLM 호출이라 수십 초가 걸린다. 여기서 기다리면 화면이
            # 멈추므로 만들어만 두고 돌려준다 — 러너 스레드가 집어 간다.
            _json_resp(self, 200, {"ok": True,
                                   "project": projects.create(idea, str(body.get("title") or ""))})

        elif path.startswith("/api/projects/"):
            rest = path.split("/api/projects/")[1]
            pid, _, action = rest.partition("/")
            if projects.get(pid) is None:
                _json_resp(self, 404, {"error": f"없는 프로젝트: {pid}"})
                return
            try:
                import project_runner
            except Exception as e:  # noqa: BLE001
                _json_resp(self, 500, {"error": f"러너를 불러오지 못했습니다: {e}"})
                return
            if action == "approve":
                _json_resp(self, 200, {"ok": True, "project": project_runner.approve(pid)})
            elif action == "resume":
                _json_resp(self, 200, {"ok": True, "project": project_runner.resume(pid)})
            elif action == "cancel":
                _json_resp(self, 200, {"ok": True, "project": projects.update(
                    pid, {"status": "cancelled", "pause_reason": "사장님이 중단했습니다"})})
            else:
                _json_resp(self, 404, {"error": f"알 수 없는 동작: {action}"})

        elif path.startswith("/api/store/"):
            collection = path.split("/api/store/")[1]
            if collection not in workspace_store.COLLECTIONS:
                _json_resp(self, 404, {"error": f"알 수 없는 컬렉션: {collection}"})
                return
            body = self._read_body()
            try:
                _json_resp(self, 200, {"ok": True, "item": workspace_store.add(collection, body)})
            except Exception as e:  # noqa: BLE001
                _json_resp(self, 400, {"ok": False, "error": str(e)})

        # ── POST /api/youtube/oauth/start  → 구글 로그인 주소를 돌려준다
        elif path == "/api/youtube/oauth/start":
            client_id = _env_get("YOUTUBE_OAUTH_CLIENT_ID")
            if not client_id or not _env_get("YOUTUBE_OAUTH_CLIENT_SECRET"):
                _json_resp(self, 400, {
                    "ok": False,
                    "error": "Client ID/Secret 을 먼저 저장하세요.",
                })
                return
            import urllib.parse
            _yt_oauth.update({"state": uuid.uuid4().hex, "code": "", "error": "",
                              "started_at": time.time()})
            threading.Thread(target=_yt_catch_code, daemon=True).start()
            auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
                "client_id": client_id,
                "redirect_uri": YT_REDIRECT_URI,
                "response_type": "code",
                "scope": YT_SCOPE,
                "access_type": "offline",
                "prompt": "consent",          # refresh_token 을 확실히 받으려면 필요
                "state": _yt_oauth["state"],
            })
            _json_resp(self, 200, {"ok": True, "auth_url": auth_url,
                                   "redirect_uri": YT_REDIRECT_URI})

        # ── POST /api/youtube/oauth/finish  (콜백을 받았는지 확인 후 토큰 교환)
        elif path == "/api/youtube/oauth/finish":
            if _yt_oauth["error"]:
                _json_resp(self, 400, {"ok": False, "error": _yt_oauth["error"]})
                return
            if not _yt_oauth["code"]:
                _json_resp(self, 202, {"ok": False, "pending": True,
                                       "error": "아직 구글에서 돌아오지 않았습니다."})
                return
            try:
                tok = _yt_exchange(_yt_oauth["code"],
                                   _env_get("YOUTUBE_OAUTH_CLIENT_ID"),
                                   _env_get("YOUTUBE_OAUTH_CLIENT_SECRET"))
            except Exception as e:  # noqa: BLE001
                _json_resp(self, 400, {"ok": False, "error": f"토큰 교환 실패: {e}"})
                return
            refresh = tok.get("refresh_token")
            if not refresh:
                _json_resp(self, 400, {
                    "ok": False,
                    "error": "refresh_token 이 오지 않았습니다. 구글 계정의 앱 권한을 지우고 다시 시도하세요.",
                })
                return
            _env_set("YOUTUBE_OAUTH_REFRESH_TOKEN", refresh)
            _yt_oauth.update({"state": "", "code": "", "error": ""})
            _json_resp(self, 200, {"ok": True, "connected": True})

        # ── POST /api/config/model  {model}
        elif path == "/api/config/model":
            body = self._read_body()
            model = (body.get("model") or "").strip()
            if not model:
                _json_resp(self, 400, {"ok": False, "error": "model 필요"})
                return
            # 설치돼 있지 않은 모델을 고르면 첫 추론에서야 404 로 터진다.
            # 고르는 자리에서 막는 편이 낫다.
            installed = [m.get("name") for m in _ollama_models()]
            if installed and model not in installed:
                _json_resp(self, 400, {
                    "ok": False,
                    "error": f"Ollama 에 설치되지 않은 모델입니다: {model}",
                })
                return
            cfg = _save_runtime_config({"global_model": model})
            _json_resp(self, 200, {"ok": True, "global_model": cfg["global_model"]})

        # ── POST /api/config/save  (.env 저장 — 허용된 키만)
        elif path == "/api/config/save":
            body = self._read_body()
            # 예전에는 받은 키를 그대로 .env 에 썼다. .env 는 게이트웨이와
            # 디스패처가 읽으므로, 임의 키를 넣을 수 있다는 것은 남의 API 키를
            # 덮어쓰거나 다른 프로세스의 동작을 바꿀 수 있다는 뜻이다.
            unknown = [k for k in body if k not in ALLOWED_ENV_KEYS]
            if unknown:
                _json_resp(self, 400, {
                    "ok": False,
                    "error": f"허용되지 않은 설정 키: {', '.join(sorted(unknown))}",
                })
                return
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

# ── 진입점 ────────────────────────────────────────────────────

if __name__ == "__main__":
    server = ThreadingHTTPServer((BIND_HOST, PORT), Handler)
    print(f"[server] 명테크 API 서버 시작 → http://localhost:{PORT}/api/health")
    print(f"[server] 바인드 {BIND_HOST}:{PORT} (이 PC 전용)")
    print(f"[server] 에이전트 {len(_load_all_agents())}명 로드됨")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[server] 종료됨")
