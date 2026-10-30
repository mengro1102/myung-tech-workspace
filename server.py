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

import hashlib
import hmac
import json
import mimetypes
import os
import sys
import time
import subprocess
import threading
import uuid
import socketserver
import io              # 맹비서 .env 에서 키를 읽는다
import urllib.error    # 중계 중 HTTPError 를 가려내려면 필요하다
import urllib.parse    # 세션 id 를 경로에 넣을 때 따옴표 처리
import urllib.request
try:
    import psutil as _psutil
    HAS_PSUTIL = True
except ImportError:
    HAS_PSUTIL = False
from http.server import BaseHTTPRequestHandler, HTTPServer

def _activity() -> dict:
    """지금 **실제로** 뭐가 돌고 있나. 화면의 `cycleStatus` 자리에 들어간다.

    `status` 값은 기존 소비자들이 읽던 것과 같은 모양으로 둔다 — 여섯 군데가
    `!== 'stopped'` 로 "살아 있나" 를 판정하고 있어서, 모양을 바꾸면 그 여섯을
    한꺼번에 고쳐야 한다. 뜻만 바꾼다: **사장님이 버튼을 눌렀나 → 정말로
    일이 돌고 있나.**

    'waiting' 을 따로 두는 이유: 사람을 기다리는 것과 기계가 일하는 것은
    사장님이 할 일이 다르다. 전자는 사장님 차례고 후자는 기다리면 된다.
    """
    try:
        rows = projects.load()
        running = [p for p in rows if p.get("status") == "running"]
        paused = [p for p in rows if p.get("status") == "paused"]
        tasks = task_queue.list_tasks()
        # 정체된 것은 "도는 중" 으로 세지 않는다. 세면 화면이 거짓말한다 —
        # 실측: 10시간 넘게 in_progress 로 박혀 있던 태스크 하나 때문에
        # 헤더가 "일하는 중 1" 이라고 말하고 있었다(화면에서 부서에 물어본
        # 질의가 끝나지 않은 것. 사이클과는 무관했다).
        # 여기서는 읽기만 한다. 폴링이 상태를 바꾸면 창을 열어 둔 것만으로
        # 데이터가 바뀐다.
        busy = [t for t in tasks
                if t.get("status") == "in_progress" and not task_queue.is_stale(t)]
        stuck = task_queue.stale(tasks)
        pending_appr = [a for a in workspace_store.load("approvals")
                        if a.get("status") == "pending"]

        if running or busy:
            status = "executing"
        elif paused or pending_appr:
            status = "waiting"          # 사람 차례
        else:
            status = "stopped"

        return {
            "status": status,
            "running": bool(running or busy),
            "projects_running": len(running),
            "projects_waiting": len(paused),
            "tasks_busy": len(busy),
            "tasks_stale": len(stuck),      # 숨기지 않는다 — 치워야 할 것이다
            "approvals_pending": len(pending_appr),
            # 옛 소비자들이 읽던 칸. 사이클이 없으니 늘 0 이지만, 키가
            # 사라지면 화면이 undefined 를 읽는다.
            "cycle_count": 0,
            "last_cycle": None,
            "logs": [],
        }
    except Exception as e:  # noqa: BLE001
        # 활동을 모르는 것과 활동이 없는 것은 다르다. 섞지 않는다.
        return {"status": "stopped", "running": False, "error": f"조회 실패: {e}",
                "cycle_count": 0, "last_cycle": None, "logs": []}


# ── 맹비서(hermes) API 중계 ──────────────────────────────────────────
#
# 키는 맹비서 .env 에만 있다. 브라우저에 내려보내지 않는다 — 내려보내면
# 화면을 여는 누구나 에이전트를 실행할 수 있다.
# 이 블록은 `from pathlib import Path` 보다 앞에 있다. 문자열로 둔다 —
# 여기서 Path 를 쓰면 임포트 순서에 묶여 서버가 아예 안 뜬다(겪었다).
HERMES_DIR = r"D:\AI_Workspace\hermes"
ASSISTANT_BASE = "http://127.0.0.1:8642"

# 대화는 길다(디스코드 실측 27초). 목록·히스토리는 짧다. 같은 값을 쓰면
# 한쪽이 반드시 틀린다 — 짧으면 멀쩡한 답을 끊고, 길면 죽은 게이트웨이를
# 하염없이 기다린다.
ASSISTANT_TIMEOUT_READ = 20
# 라우터(auto:hermes)가 무료 모델을 고르는데, 고른 모델이 느리면 한참
# 걸린다. 180초로는 지식베이스 문서를 읽고 답하는 질문이 실제로 끊겼다
# (2026-10-25 실측 — 게이트웨이는 멀쩡한데 타임아웃).
#
# 400초로 둔다. 더 길게 잡으면 브라우저가 먼저 포기하고, 사장님은 화면이
# 멈춘 것으로 본다.
ASSISTANT_TIMEOUT_CHAT = 400


def _assistant_key() -> str:
    """맹비서 API 키. 환경변수 먼저, 없으면 hermes/.env."""
    v = os.environ.get("API_SERVER_KEY", "").strip()
    if v:
        return v
    try:
        for ln in io.open(os.path.join(HERMES_DIR, ".env"),
                          encoding="utf-8", errors="replace"):
            t = ln.strip()
            if t.startswith("API_SERVER_KEY=") and not t.startswith("#"):
                return t.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def _assistant_call(method: str, path: str, payload: dict | None = None,
                    timeout: int = ASSISTANT_TIMEOUT_READ) -> tuple[int, dict]:
    """(HTTP 상태, 본문). 예외를 올리지 않는다 — 화면이 사유를 받아야 한다."""
    key = _assistant_key()
    if not key:
        return 503, {"error": "맹비서 API 키가 없습니다 — hermes/.env 의 "
                              "API_SERVER_KEY 를 확인하십시오."}
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    req = urllib.request.Request(
        ASSISTANT_BASE + path, data=data, method=method,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {key}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            body = r.read().decode("utf-8", "replace")
            try:
                return r.status, json.loads(body) if body else {}
            except json.JSONDecodeError:
                return r.status, {"raw": body[:2000]}
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:500]
        # 맹비서가 보낸 **진짜 사유**를 꺼내 준다. 전에는 "거절했습니다(400)"
        # 만 올려서, 화면이 "세션을 만들지 못했습니다" 라고만 말했다 —
        # 실제 사유는 "제목이 이미 쓰이고 있다" 였고 그걸 알 길이 없었다.
        why = ""
        try:
            inner = json.loads(detail)
            why = (((inner or {}).get("error") or {}).get("message")
                   or (inner or {}).get("message") or "")
        except Exception:  # noqa: BLE001
            pass
        return e.code, {"error": why or f"맹비서가 거절했습니다 ({e.code})",
                        "detail": detail}
    except Exception as e:  # noqa: BLE001
        # **사유를 구분한다.** 전에는 무엇이 터지든 "게이트웨이가 꺼져
        # 있을 수 있습니다" 라고 했다. 그런데 실제로 가장 흔한 것은
        # 타임아웃이고(라우터가 느린 무료 모델을 고른 경우), 그때
        # 게이트웨이는 멀쩡하다 — 사장님이 멀쩡한 것을 재시작하러 간다.
        txt = str(e)
        if isinstance(e, TimeoutError) or "timed out" in txt.lower():
            return 504, {
                "error": f"맹비서가 {ASSISTANT_TIMEOUT_CHAT}초 안에 답하지 못했습니다",
                "hint": "게이트웨이는 살아 있습니다. 무료 모델 라우터가 느린 "
                        "모델을 골랐을 수 있습니다 — 잠시 뒤 다시 물어보시거나 "
                        "질문을 짧게 나눠 주십시오."}
        return 503, {"error": f"맹비서에 닿지 못했습니다: {txt}",
                     "hint": "게이트웨이가 꺼져 있을 수 있습니다 — "
                             "1. 전체 시작.bat"}


def _disk_block() -> dict:
    """/api/system/stats 에 더할 볼륨 목록."""
    try:
        c = disk_guard.check()
        return {
            # 작업 볼륨만, 빠듯한 순. [0] 이 우리 일을 먼저 막을 볼륨이다.
            "volumes": c["volumes"],
            # 윈도우가 사는 볼륨. 우리가 쓰지 않으므로 칸을 따로 둔다 —
            # 섞으면 늘 92% 인 C: 가 작업 볼륨 경고를 덮어 버린다.
            "disk_system": c.get("system"),
            "disk_level": c["level"],
            "disk_notes": c["notes"],
            "disk_thresholds": c["thresholds"],
        }
    except Exception as e:
        return {"volumes": [], "disk_level": "unknown",
                "disk_notes": [f"디스크 조회 실패: {e}"]}


def _disk_health() -> dict:
    """/api/health 에 더할 한 줄 판정. 맹비서가 이걸 읽는다."""
    try:
        c = disk_guard.check()
        tight = c["volumes"][0] if c["volumes"] else None
        return {
            "ok": c["ok"],
            "level": c["level"],
            "summary": disk_guard.summary_md(),
            "tightest": tight,              # 가장 빠듯한 **작업** 볼륨
            "system": c.get("system"),      # 윈도우가 사는 볼륨
            "notes": c["notes"],
        }
    except Exception as e:
        # "조회 못 함" 과 "여유 있음" 을 섞지 않는다 — verify 에서 배운 것.
        return {"ok": True, "level": "unknown",
                "summary": f"디스크를 조회하지 못했습니다 ({e}) — 여유가 있다는 뜻이 아닙니다.",
                "tightest": None, "notes": []}


class ThreadingHTTPServer(socketserver.ThreadingMixIn, HTTPServer):
    daemon_threads = True
from pathlib import Path
from datetime import datetime, timedelta, timezone
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
# 한 번의 동의로 세 가지를 모두 받는다. 예전에는 analytics 읽기 하나뿐이었는데,
# 그 상태로 업로드 기능을 붙이자 "자동 연결" 을 끝낸 사람이 첫 업로드에서
# 403(insufficientPermissions)을 만나고 동의부터 다시 해야 했다.
#   yt-analytics.readonly  지표 읽기
#   youtube.upload         영상 올리기
#   youtube.force-ssl      제목·설명·공개범위 수정 (videos.update)
YT_SCOPE = " ".join([
    "https://www.googleapis.com/auth/yt-analytics.readonly",
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.force-ssl",
])
_yt_oauth: dict = {"state": "", "code": "", "error": "", "started_at": 0.0}

# ── 구글 캘린더 ──────────────────────────────────────────────────
#
# **같은 OAuth 클라이언트와 같은 리다이렉트를 쓴다.** 유튜브 연결이 이미
# 돼 있다는 것은 구글 콘솔에 클라이언트가 있고 리다이렉트 URI 가 등록돼
# 있다는 뜻이다. 캘린더용을 새로 만들면 사장님이 콘솔에서 클라이언트를
# 하나 더 만들고 URI 를 또 등록해야 한다. 두 흐름이 동시에 돌 일은 없으니
# 포트를 나눌 이유도 없다.
#
# 다만 **유튜브 동의에 범위를 얹지는 않는다.** 범위를 더하면 기존 동의가
# 무효가 되어 되던 유튜브 연결이 끊긴다. 동의와 refresh_token 을 따로
# 받아 따로 저장한다.
#
# 읽기만 받는다. 카드에 적힌 일(일정을 읽어 마감일과 맞추기)에 쓰기는
# 필요 없고, 지금 필요 없는 권한을 받아 두면 나중에 버그 하나가 사장님
# 달력을 고칠 수 있게 된다.
CAL_SCOPE = "https://www.googleapis.com/auth/calendar.readonly"
_cal_oauth: dict = {"state": "", "code": "", "error": "", "started_at": 0.0}


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


def _yt_catch_code(timeout: int = 180, box: dict | None = None) -> None:
    """리다이렉트를 한 번만 받고 닫는 아주 작은 서버.

    구글이 브라우저를 이 주소로 되돌려 보낼 때 쿼리에 code 가 실려 온다.
    사람이 로그인하는 동안만 살아 있으면 되므로 스레드 하나로 충분하다.

    `box` 로 **어느 흐름의 상태에 쓸지**를 받는다(기본은 유튜브). 캘린더가
    같은 포트·같은 리다이렉트를 쓰기 때문에 필요하다 — 구글 콘솔에 URI 를
    또 등록하지 않으려고 그렇게 했다. 둘이 동시에 돌 일은 없다.
    """
    import http.server

    state = _yt_oauth if box is None else box

    class _Once(http.server.BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802
            q = parse_qs(urlparse(self.path).query)
            state["code"] = (q.get("code") or [""])[0]
            state["error"] = (q.get("error") or [""])[0]
            ok = bool(state["code"]) and (q.get("state") or [""])[0] == state["state"]
            if not ok and not state["error"]:
                state["error"] = "state 불일치 — 다시 시도하세요"
            msg = ("연결되었습니다. 이 창을 닫고 명테크로 돌아가세요."
                   if ok else f"실패: {state['error'] or '알 수 없는 오류'}")
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
        state["error"] = f"포트 {YT_OAUTH_PORT} 를 열 수 없습니다: {e}"
        return
    srv.timeout = timeout
    srv.handle_request()      # 딱 한 번
    srv.server_close()


def _yt_exchange(code: str, client_id: str, client_secret: str) -> dict:
    """인가 코드를 refresh_token 으로 바꾼다."""
    # urllib 은 최상위에서 임포트한다. 여기 지역 임포트를 두면 `urllib` 이
    # 함수 전체의 지역 이름이 되어, 그 앞에서 쓰는 곳이 UnboundLocalError 로 죽는다(겪었다).
    # urllib 은 최상위에서 임포트한다. 여기 지역 임포트를 두면 `urllib` 이
    # 함수 전체의 지역 이름이 되어, 그 앞에서 쓰는 곳이 UnboundLocalError 로 죽는다(겪었다).
    data = urllib.parse.urlencode({
        "code": code, "client_id": client_id, "client_secret": client_secret,
        "redirect_uri": YT_REDIRECT_URI, "grant_type": "authorization_code",
    }).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token", data=data,
                                 method="POST")
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def _google_access_token(refresh: str) -> str:
    """refresh_token → access_token. 한 시간짜리라 저장하지 않고 그때그때 받는다."""
    data = urllib.parse.urlencode({
        "client_id": _env_get("YOUTUBE_OAUTH_CLIENT_ID"),
        "client_secret": _env_get("YOUTUBE_OAUTH_CLIENT_SECRET"),
        "refresh_token": refresh,
        "grant_type": "refresh_token",
    }).encode()
    req = urllib.request.Request("https://oauth2.googleapis.com/token",
                                 data=data, method="POST")
    with urllib.request.urlopen(req, timeout=20) as r:
        return (json.loads(r.read().decode("utf-8")) or {}).get("access_token", "")


def _calendar_events(days: int = 14, limit: int = 20) -> dict:
    """다가오는 일정. 연결돼 있지 않으면 **왜** 안 되는지 적어 돌려준다.

    빈 목록을 돌려주면 화면이 "일정 없음" 이라고 말한다 — 연결이 끊긴
    것과 일정이 없는 것은 완전히 다른 상태인데, 둘을 같게 보이게 된다.
    """
    refresh = _env_get("GOOGLE_CALENDAR_REFRESH_TOKEN")
    if not refresh:
        return {"ok": False, "connected": False, "events": [],
                "error": "구글 캘린더가 아직 연결되지 않았습니다"}
    try:
        token = _google_access_token(refresh)
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "connected": True, "events": [],
                "error": f"토큰 갱신 실패: {e}"}
    if not token:
        return {"ok": False, "connected": True, "events": [],
                "error": "access_token 을 받지 못했습니다 — 다시 연결해 주세요"}

    now = datetime.now(timezone.utc)
    q = urllib.parse.urlencode({
        "timeMin": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "timeMax": (now + timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "singleEvents": "true",          # 반복 일정을 날짜별로 펼친다
        "orderBy": "startTime",          # singleEvents 없이는 쓸 수 없는 옵션이다
        "maxResults": str(limit),
    })
    req = urllib.request.Request(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events?" + q,
        headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            data = json.loads(r.read().decode("utf-8")) or {}
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = (json.loads(e.read().decode("utf-8")) or {}) \
                .get("error", {}).get("message", "")
        except Exception:                 # noqa: BLE001
            pass
        # 403 은 대개 "이 프로젝트에서 Calendar API 가 꺼져 있다" 다.
        # 그냥 403 이라고만 하면 어디를 손봐야 하는지 알 수 없다.
        hint = (" — 구글 클라우드 콘솔에서 Google Calendar API 를 켜야 합니다"
                if e.code == 403 else "")
        return {"ok": False, "connected": True, "events": [],
                "error": f"캘린더 조회 실패 ({e.code}) {detail}{hint}".strip()}
    except Exception as e:                # noqa: BLE001
        return {"ok": False, "connected": True, "events": [],
                "error": f"캘린더 조회 실패: {e}"}

    out = []
    for it in data.get("items") or []:
        start = it.get("start") or {}
        end = it.get("end") or {}
        out.append({
            "id": it.get("id", ""),
            "title": it.get("summary") or "(제목 없음)",
            # dateTime 은 시각이 있는 일정, date 는 종일 일정이다. 둘을
            # 구분해서 넘긴다 — 화면이 "오전 10:00" 과 "종일" 을 다르게 쓴다.
            "start": start.get("dateTime") or start.get("date") or "",
            "end": end.get("dateTime") or end.get("date") or "",
            "all_day": not start.get("dateTime"),
            "where": it.get("location") or "",
            "link": it.get("htmlLink") or "",
        })
    return {"ok": True, "connected": True, "events": out,
            "calendar": data.get("summary") or "기본 캘린더"}


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
        # urllib 은 최상위에서 임포트한다. 여기 지역 임포트를 두면 `urllib` 이
        # 함수 전체의 지역 이름이 되어, 그 앞에서 쓰는 곳이 UnboundLocalError 로 죽는다(겪었다).
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
    # 결재를 누를 수 있는 텔레그램 사용자 id 목록(쉼표). 비어 있으면 아무도
    # 못 누른다 — 봇 토큰이 새도 남이 업로드를 승인할 수 없어야 한다.
    "TELEGRAM_ALLOWED_USERS",
    "YOUTUBE_API_KEY", "YOUTUBE_CHANNEL_ID",
    "YOUTUBE_OAUTH_CLIENT_ID", "YOUTUBE_OAUTH_CLIENT_SECRET",
    # PAYPAL_MODE 가 빠져 있었다. UI 는 이 셋을 함께 보내므로 PayPal 저장이
    # 통째로 400 으로 거부되고 있었다 — 화면에는 저장 실패 이유가 안 보였다.
    "PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "PAYPAL_MODE",
    "TOSS_SECRET_KEY",
    "GITHUB_TOKEN", "HUGGINGFACE_TOKEN",
    # OAuth 왕복으로 받은 refresh_token. 서버가 직접 쓴다.
    "YOUTUBE_OAUTH_REFRESH_TOKEN",
    "GOOGLE_CALENDAR_REFRESH_TOKEN",
}

def _check_credential(key: str, value: str) -> str:
    """값이 그 칸에 들어갈 모양인지. 틀렸으면 사람이 읽을 이유, 맞으면 빈 문자열.

    YouTube Data API 카드의 'API Key' 와 'Channel ID' 칸에 OAuth 클라이언트 ID 와
    보안 비밀번호가 들어가, 잘 되던 키를 덮어쓴 일이 있었다. 두 카드가 나란히
    있고 입력칸이 늘 빈칸으로 보이니 둘 다 채워야 하는 줄 알게 된다. 모양이
    뚜렷한 값은 저장 전에 걸러서, 틀린 칸에 넣었다고 바로 알려 준다.
    """
    import re as _re
    v = value.strip()
    if key == "YOUTUBE_API_KEY" and not v.startswith("AIza"):
        if v.endswith(".apps.googleusercontent.com"):
            return ("이건 OAuth 클라이언트 ID 입니다. 아래 'YouTube Analytics · 업로드' "
                    "카드의 Client ID 칸에 넣으세요. API 키는 AIza 로 시작합니다.")
        return "YouTube API 키는 AIza 로 시작하는 39자입니다."
    if key == "YOUTUBE_CHANNEL_ID" and not _re.fullmatch(r"UC[\w-]{22}", v):
        if v.startswith("GOCSPX-"):
            return ("이건 OAuth 보안 비밀번호입니다. 아래 'YouTube Analytics · 업로드' "
                    "카드의 Client Secret 칸에 넣으세요.")
        return "채널 ID 는 UC 로 시작하는 24자입니다(@핸들이 아닙니다)."
    if key == "YOUTUBE_OAUTH_CLIENT_ID" and not v.endswith(".apps.googleusercontent.com"):
        return "OAuth 클라이언트 ID 는 .apps.googleusercontent.com 으로 끝납니다."
    if key == "YOUTUBE_OAUTH_CLIENT_SECRET" and (
            v.endswith(".apps.googleusercontent.com") or v.startswith("AIza")):
        return "보안 비밀번호 칸에 다른 값(클라이언트 ID 또는 API 키)이 들어갔습니다."
    if key == "GITHUB_TOKEN" and not v.startswith(("github_pat_", "ghp_")):
        return "GitHub 토큰은 github_pat_ (또는 ghp_) 로 시작합니다."
    if key == "PAYPAL_MODE" and v not in ("sandbox", "live"):
        return "PayPal 모드는 sandbox 또는 live 입니다."
    if key == "TELEGRAM_BOT_TOKEN" and not _re.fullmatch(r"\d+:[\w-]{30,}", v):
        return "텔레그램 봇 토큰은 '숫자:문자열' 모양입니다."
    return ""


def _mask(value: str) -> str:
    """저장된 값의 흔적만. 화면에 '들어 있다' 는 사실과 어느 값인지만 보인다."""
    v = value.strip()
    return f"…{v[-4:]} ({len(v)}자)" if len(v) > 8 else f"({len(v)}자)"


sys.path.insert(0, str(ROOT / "shared_memory"))
sys.path.insert(0, str(ROOT / "bridge"))
sys.path.insert(0, str(ROOT / "orchestrator"))

import task_queue
import message_broker
import workspace_store
import approval_tiers
import disk_guard
import notify
import file_proposals
import projects
import trash
# 영구 삭제 열쇠를 미리 만들어 둔다. 맹비서 스크립트가 이 파일을 읽어 쓴다.
try:
    trash.purge_token()
except OSError as _tok_exc:
    print(f"[server] 휴지통 열쇠를 만들지 못했습니다: {_tok_exc}", file=sys.stderr)
try:
    import integrations
except Exception as _integ_exc:  # noqa: BLE001
    integrations = None
    print(f'[server] 연동 모듈 로드 실패: {_integ_exc}', file=sys.stderr)

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
    import urllib.request as _ur2   # 별칭이라 urllib 을 가리지 않는다
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

# 빌드된 화면. 있으면 이 서버가 같이 내보낸다(없으면 API 전용으로 동작).
UI_DIR = ROOT / "virtual-office" / "dist"

# 윈도우는 레지스트리에서 MIME 을 읽는데, 거기서 .js 가 text/plain 으로 잡혀
# 있는 PC 가 흔하다. 그러면 브라우저가 모듈 실행을 거부해 흰 화면만 뜬다.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/css", ".css")
mimetypes.add_type("image/svg+xml", ".svg")

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
    import urllib.request as _ur   # 별칭이라 urllib 을 가리지 않는다

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

# 대화창 첨부. 맹비서가 read_file 로 읽을 수 있는 자리.
UPLOAD_DIR = WORKSPACE_ROOT / "uploads"
# 읽기 **전에** 거절할 크기. base64 로 오므로 실제 파일은 이것의 3/4 쯤이다.
UPLOAD_MAX_BODY = 34 * 1024 * 1024            # ≈ 25MB 파일
# 맹비서가 읽을 수 있는 것만. 실행 가능한 것은 받지 않는다 — 맹비서에게는
# 터미널이 있어서, 실행 파일을 그 손 닿는 곳에 두면 안 된다.
UPLOAD_EXT = {".pdf", ".md", ".txt", ".csv", ".json", ".png", ".jpg",
              ".jpeg", ".webp", ".gif", ".docx", ".xlsx", ".html"}
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


# 이벤트는 파일 하나씩 쌓인다. 지우는 사람이 없으면 무한정 늘고, 아래 감시
# 루프가 1.5초마다 그 전부를 스캔하므로 쌓일수록 느려진다(실측 274개·1.2MB).
# 화면은 최근 50건만 쓰므로 그보다 넉넉히 남긴다.
EVENT_KEEP = 400


def _event_watcher():
    """shared_memory 이벤트를 감시해서 SSE로 브로드캐스트."""
    seen: set[str] = set()
    last_prune = ""
    try:
        n = message_broker.prune_events(EVENT_KEEP)
        if n:
            print(f"[events] 시작 정리: 오래된 이벤트 {n}건 삭제")
    except Exception:  # noqa: BLE001
        pass
    while True:
        try:
            today = datetime.now().strftime("%Y-%m-%d")
            if today != last_prune:
                last_prune = today
                n = message_broker.prune_events(EVENT_KEEP)
                if n:
                    print(f"[events] 일일 정리: 오래된 이벤트 {n}건 삭제")
                # 지운 파일의 id 는 seen 에 영원히 남는다. 하루에 한 번
                # 지금 있는 것만 남겨 메모리가 계속 늘지 않게 한다.
                if len(seen) > EVENT_KEEP * 2:
                    seen = {e.get("event_id") for e in message_broker.fetch_events()
                            if e.get("event_id")}
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


def _briefing() -> str:
    """지금 무엇이 막혀 있고 무엇이 돌고 있는지. 사실만 쓴다.

    예전 브리핑은 하드코딩이라 항상 같은 말을 했다. 사장님이 첫 화면에서
    처음 읽는 글이 거짓이면, 그 아래 숫자도 믿을 수 없게 된다.
    """
    from collections import Counter
    now = datetime.now()
    hour = now.hour
    greet = ("새벽입니다" if hour < 6 else "좋은 아침입니다" if hour < 12
             else "좋은 오후입니다" if hour < 18 else "저녁입니다")

    lines = [f"■ 브리핑 · {now:%m월 %d일 %H:%M}", "", f"{greet}, 사장님."]

    # ── 막힌 것부터. 사장님이 아니면 아무도 못 푸는 일이다.
    blocked: list[str] = []
    try:
        appr = [a for a in workspace_store.load("approvals")
                if (a.get("status") or "pending") == "pending"]
    except Exception:  # noqa: BLE001
        appr = []
    if appr:
        kinds: dict[str, int] = {}
        for a in appr:
            k = {"file": "파일 저장", "action": "외부 실행",
                 "project": "프로젝트 착수"}.get(a.get("kind") or "", "결재")
            kinds[k] = kinds.get(k, 0) + 1
        detail = ", ".join(f"{k} {v}건" for k, v in kinds.items())
        blocked.append(f"결재 {len(appr)}건이 승인을 기다립니다 ({detail}). "
                       "프로젝트 탭 결재함에서 처리하실 수 있습니다.")

    paused, running, done_today = [], [], 0
    try:
        for p in projects.load():
            st = p.get("status")
            if st == "paused":
                paused.append(p)
            elif st in ("running", "intake", "planning"):
                running.append(p)
            elif st == "done" and (now.timestamp() - float(p.get("updated_at") or 0)) < 86400:
                done_today += 1
    except Exception:  # noqa: BLE001
        pass

    for p in paused:
        blocked.append(f"{p.get('title', '프로젝트')} 가 멈췄습니다 — "
                       f"{(p.get('pause_reason') or '이유 미기록')[:90]}")

    if blocked:
        lines += ["", "[ 지금 막힌 것 ]"] + [f"• {b}" for b in blocked]
    else:
        lines += ["", "막혀 있는 일은 없습니다."]

    # ── 돌고 있는 것
    moving = []
    if running:
        moving += [f"{p.get('title', '')} ({p.get('progress', '')})" for p in running]
    try:
        # task_queue 에는 summary() 가 없다 — 목록에서 직접 센다.
        tq = Counter(t.get("status") for t in task_queue.list_tasks())
        if tq.get("in_progress"):
            moving.append(f"태스크 {tq['in_progress']}건 처리 중")
    except Exception:  # noqa: BLE001
        pass
    if moving:
        lines += ["", "[ 돌고 있는 것 ]"] + [f"• {m}" for m in moving]

    # ── 어제오늘 끝난 것
    finished = []
    if done_today:
        finished.append(f"프로젝트 {done_today}건 완료")
    try:
        # task_queue 에는 summary() 가 없다 — 목록에서 직접 센다.
        tq = Counter(t.get("status") for t in task_queue.list_tasks())
        if tq.get("done"):
            finished.append(f"태스크 {tq['done']}건 완료")
        if tq.get("failed"):
            finished.append(f"태스크 {tq['failed']}건 실패")
    except Exception:  # noqa: BLE001
        pass
    if finished:
        lines += ["", "[ 최근 결과 ]", "• " + " · ".join(finished)]

    # ── 시스템에 문제가 있으면 그것부터 알아야 한다
    warns = []
    ok, err = _probe_ollama_cached()
    if not ok:
        warns.append(f"AI 모델에 닿지 않습니다 ({err or OLLAMA_HOST})")
    if knowledge_base is not None and not knowledge_base.available():
        warns.append(f"지식 베이스 경로를 찾지 못합니다 ({knowledge_base.KB_PATH})")
    if warns:
        lines += ["", "[ 점검 필요 ]"] + [f"• {w}" for w in warns]

    # ── 다음 한 걸음. 상황에 따라 다르게 권한다.
    if appr:
        nxt = "프로젝트 탭에서 결재부터 처리하시면 막힌 일이 풀립니다."
    elif paused:
        nxt = "멈춘 프로젝트의 심사 이력을 보시면 왜 막혔는지 나옵니다."
    elif running:
        nxt = "돌고 있는 것이 있으니 결과를 기다리시면 됩니다."
    else:
        nxt = '프로젝트 탭에 아이디어를 한 줄 던지면 오케스트레이터가 계획을 세웁니다.'
    lines += ["", f"→ 다음 한 걸음: {nxt}"]
    return "\n".join(lines)



def _dept_activity() -> dict[str, dict]:
    """부서마다 지금 무엇을 하고 있나. {dept: {tasks, project, label}}

    에이전트 개인이 무엇을 하는지는 시스템이 모른다 — 일은 부서로 간다.
    아는 만큼만 말하고 지어내지 않는다.
    """
    out: dict[str, dict] = {}

    try:
        for t in task_queue.list_tasks():
            if t.get("status") != "in_progress":
                continue
            d = t.get("target_dept") or ""
            if not d:
                continue
            e = out.setdefault(d, {"tasks": 0, "project": "", "label": ""})
            e["tasks"] += 1
    except Exception:  # noqa: BLE001
        pass

    try:
        for p in projects.load():
            if p.get("status") not in ("running", "intake", "planning"):
                continue
            ds = (p.get("plan") or {}).get("deliverables") or []
            cur = int(p.get("cursor", 0))
            phase = p.get("phase") or ""
            # 지금 만들고 있는 산출물의 부서. 2차 검토는 오케스트레이터가 본다.
            if phase == "review2":
                d = "orchestration_dept"
            elif cur < len(ds):
                d = ds[cur].get("dept") or ""
            else:
                d = ""
            if not d:
                continue
            e = out.setdefault(d, {"tasks": 0, "project": "", "label": ""})
            e["project"] = p.get("title") or ""
            e["label"] = {"draft": "초안 작성", "review1": "1차 검토",
                          "review2": "2차 검토", "plan": "계획 수립",
                          "narrow": "범위 조정"}.get(phase, phase)
    except Exception:  # noqa: BLE001
        pass

    return out


# ── 지식베이스 탐색 (지식베이스 탭) ─────────────────────────────
#
# 지금까지 화면이 위키를 보는 창구는 셋이었다: 카테고리별 slug 목록
# (/api/knowledge/nodes), 본문 한 건(/api/knowledge/read), 텍스트 검색
# (/api/knowledge/search). 목록은 slug 뿐이라 **제목도 날짜도 없었다** —
# `references/2coool-2nd-workshop-on-the-challenge-of-out-of-label-haz…`
# 같은 줄 227개를 보여 주는 것이 전부였다. 그걸로는 탐구가 안 된다.
#
# 아래 셋이 모자란 부분을 메운다:
#
#   _kb_tree   폴더 → 파일. 제목·로컬 수정시각·크기·출처를 함께 준다.
#   _kb_doc    본문 + 프런트매터 + 이웃 노드. 뷰어 한 화면 분량.
#   _kb_file   그림·PDF. md 안의 `![](../assets/…)` 가 실제로 보이려면
#              바이트를 내줄 곳이 필요하다(216건이 그렇게 걸려 있다).
#
# ## 수정시각은 로컬 것을 준다
#
# "깃허브 동기화 시점이 아닌 **로컬** 업데이트 시점" 을 봐야 한다.
# 그래서 git log 가 아니라 `st_mtime` 을 쓴다. 둘은 실제로 다르다 —
# 깃에 올리지 않은 수집분이 references 227건 중 다수다.


# 트리에 올리는 폴더. 순서가 화면 순서다 — 사람이 정리한 것이 먼저,
# 기계가 모은 것이 나중. (경로, 화면 이름, 한 줄 설명).
KB_TREE_DIRS = [
    ("concepts",     "개념",        "사람이 정리한 개념 노드"),
    ("entities",     "인물·조직",   "사람·회사·모델 노드"),
    ("comparisons",  "비교",        "둘 이상을 견주어 정리한 노드"),
    ("raw/projects", "부서 산출물", "에이전트가 만들어 결재를 통과한 것"),
    ("references",   "논문",        "arXiv 에서 모은 참조"),
    ("raw/papers",   "논문 전문",   "PDF 에서 뽑은 본문과 그림"),
    ("raw/articles", "읽을 거리",   "밖에서 주입한 글"),
    ("raw",          "기타 메모",   "분류 전 메모"),
    ("glossary",     "용어",        "용어 정리"),
]

# 내줄 확장자. 화이트리스트인 이유: KB_PATH 아래에는 md·그림 말고도
# scripts/*.py 와 graph.json·임베딩이 있다. 경로 이탈만 막고 전부 내주면
# 수집 스크립트와 그래프 전체가 브라우저로 흘러 나간다.
KB_FILE_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
    ".pdf": "application/pdf",
}

# 프런트매터에서 꺼내 쓰는 열쇠. 전부 파싱하지 않는다 — references 의
# `sources.authors` 는 저자 10여 명이 중첩 리스트로 들어와 있어서,
# 300건 넘는 트리를 돌릴 때 그걸 다 담으면 응답이 수 MB 가 된다.
_KB_FRONT_KEYS = ("title", "description", "type", "created", "updated", "slug")


def _kb_front(path, *, head_bytes: int = 4096) -> dict:
    """프런트매터에서 스칼라 몇 개만 꺼낸다.

    YAML 파서를 쓰지 않는다. 트리 한 번에 300건 넘게 돌아야 하는데
    (references 227 + concepts 55 + …) 거기서 PyYAML 을 300번 부르면
    눈에 보이게 느려지고, `yaml` 이 없는 환경에서도 트리는 떠야 한다.

    `head_bytes` 만 읽는다. 프런트매터는 파일 맨 앞에 있고 논문 본문은
    수십 KB 라 전부 읽을 이유가 없다.
    """
    out: dict = {}
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            if fh.readline().strip() != "---":
                return out
            head = fh.read(head_bytes)
    except OSError:
        return out
    for line in head.split("\n"):
        if line.strip() == "---":
            break
        # 들여쓰기·리스트 항목은 중첩 값이다. 스칼라만 본다.
        if not line or line[0] in (" ", "\t", "-"):
            continue
        key, sep, val = line.partition(":")
        if not sep or key.strip() not in _KB_FRONT_KEYS:
            continue
        val = val.strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("'", '"'):
            val = val[1:-1]
        if val:
            out[key.strip()] = val
    return out


def _kb_title(path, rel: str) -> str:
    """화면에 걸 이름. 프런트매터 title → 첫 `# 제목` → 파일명 순."""
    front = _kb_front(path, head_bytes=2048)
    if front.get("title"):
        return front["title"]
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            for _ in range(40):                    # 앞머리만 본다
                line = fh.readline()
                if not line:
                    break
                if line.startswith("# "):
                    return line[2:].strip()
    except OSError:
        pass
    return rel.rsplit("/", 1)[-1][:-3] if rel.endswith(".md") else rel


def _kb_tree() -> dict:
    """폴더 → 파일 목록. 제목·로컬 수정시각·크기·출처를 함께 준다."""
    if knowledge_base is None or not knowledge_base.available():
        return {"available": False, "folders": [], "total": 0, "mtime": 0,
                "error": "지식베이스 경로를 찾지 못했습니다"}

    root = knowledge_base.KB_PATH
    folders: list[dict] = []
    seen: set[str] = set()          # 'raw' 가 하위 폴더 파일을 또 세지 않도록

    for rel, label, hint in KB_TREE_DIRS:
        d = root / rel
        if not d.is_dir():
            continue
        files = []
        # 재귀하지 않는다 — 폴더 하나가 화면의 한 묶음이다.
        for p in sorted(d.glob("*.md")):
            r = rel + "/" + p.name
            if r in seen:
                continue
            seen.add(r)
            try:
                st = p.stat()
            except OSError:
                continue
            files.append({
                "path": r, "name": p.name, "title": _kb_title(p, r),
                "size": st.st_size, "mtime": int(st.st_mtime),
                "origin": knowledge_base.origin_of(r),
            })
        if not files:
            continue
        folders.append({
            "path": rel, "label": label, "hint": hint, "count": len(files),
            # 폴더의 시각 = 가장 최근 파일. "이 묶음이 언제 자랐나" 가 궁금한 것이다.
            "mtime": max(f["mtime"] for f in files),
            "files": files,
        })

    # PDF 는 md 가 아니라 따로 묶는다. 뷰어는 브라우저 내장 PDF 뷰어로 넘긴다.
    pdf_dir = root / "raw/pdfs"
    if pdf_dir.is_dir():
        pdfs = []
        for p in sorted(pdf_dir.glob("*.pdf")):
            try:
                st = p.stat()
            except OSError:
                continue
            pdfs.append({"path": "raw/pdfs/" + p.name, "name": p.name,
                         "title": p.stem, "size": st.st_size,
                         "mtime": int(st.st_mtime), "origin": "reference",
                         "kind": "pdf"})
        if pdfs:
            folders.append({"path": "raw/pdfs", "label": "원문 PDF",
                            "hint": "내려받은 논문 원본", "count": len(pdfs),
                            "mtime": max(f["mtime"] for f in pdfs),
                            "files": pdfs})

    return {
        "available": True,
        "root": str(root),
        "folders": folders,
        "total": sum(f["count"] for f in folders),
        # 위키 전체의 **로컬** 최신 변경. 깃 동기화 시각과 다르다.
        "mtime": max((f["mtime"] for f in folders), default=0),
        "now": int(time.time()),
    }


def _kb_doc(rel: str) -> dict:
    """본문 + 프런트매터 + 이웃. 뷰어 한 화면에 필요한 것을 한 번에 준다."""
    if knowledge_base is None or not knowledge_base.available():
        return {"error": "지식베이스 경로를 찾지 못했습니다"}

    root = knowledge_base.KB_PATH.resolve()
    f = (knowledge_base.KB_PATH / rel).resolve()
    # 경로 이탈 방지. `?path=../../.env` 가 그대로 들어온다고 보고 짠다.
    if not f.is_relative_to(root) or not f.is_file():
        return {"error": "문서를 찾지 못했습니다: " + rel}
    if f.suffix.lower() != ".md":
        return {"error": "md 파일만 읽습니다: " + rel}
    try:
        text = f.read_text(encoding="utf-8", errors="replace")
        st = f.stat()
    except OSError as e:
        return {"error": "읽기 실패: " + str(e)}

    # graph.json 의 키는 **맨 이름**이다 — `concepts/actor-critic` 이 아니라
    # `actor-critic`. 경로째로 넘기면 이웃이 늘 0개로 나온다(실제로 그랬다).
    node_id = rel.rsplit("/", 1)[-1]
    if node_id.endswith(".md"):
        node_id = node_id[:-3]

    neighbors: list[dict] = []
    try:
        # 그래프에 있는 노드면 이웃을 붙인다. references 처럼 그래프에 없는
        # 것도 많으므로 실패를 오류로 올리지 않는다 — 본문은 보여야 한다.
        gnodes = (knowledge_base.load_graph() or {}).get("nodes") or {}
        if not isinstance(gnodes, dict):
            gnodes = dict(gnodes)
        for sl, (hops, why) in (knowledge_base.neighbors(node_id, hops=1) or {}).items():
            meta = gnodes.get(sl) or {}
            neighbors.append({
                "slug": sl,
                "title": meta.get("title") or sl,
                # 뷰어가 눌러서 이동하려면 경로가 필요하다. 그래프에 없는
                # 이웃(dangling 위키링크)은 path 가 빈 값이고, 화면은 그걸
                # 눌리지 않는 회색 꼬리표로 보여 준다.
                "path": meta.get("path") or "",
                "hops": hops, "why": why,
            })
        neighbors.sort(key=lambda n: (not n["path"], n["title"]))
        neighbors = neighbors[:24]
    except Exception:                              # noqa: BLE001
        neighbors = []

    return {
        "path": rel, "title": _kb_title(f, rel),
        # 디스크 절대 경로. 화면이 "이 문서에 대해 맹비서에게 묻기" 를 할 때
        # 본문을 전부 프롬프트에 붙이지 않고 **경로만** 넘긴다 — 맹비서는
        # read_file 과 지식 그래프를 스스로 쓸 수 있으므로, 붙여 넣는 쪽이
        # 토큰만 쓰고 이웃 노드를 못 보게 만든다.
        #
        # 위키 루트 밖은 위에서 이미 막았다(is_relative_to). 그래서 여기서
        # 나가는 경로는 항상 위키 안이다.
        "abs_path": str(f),
        "front": _kb_front(f, head_bytes=8192),
        "text": text, "size": st.st_size, "mtime": int(st.st_mtime),
        "origin": knowledge_base.origin_of(rel),
        "neighbors": neighbors,
    }


def _kb_file(handler, rel: str) -> None:
    """그림·PDF 바이트를 내준다.

    md 안의 그림은 `![](../assets/papers/bert-pre-training/p003_fig001.jpeg)`
    처럼 **상대 경로**로 걸려 있다(216건). 뷰어가 문서 폴더 기준으로 풀어서
    이 엔드포인트로 부른다.

    확장자 화이트리스트를 거친다 — KB_FILE_TYPES 주석에 이유를 적었다.
    """
    if knowledge_base is None or not knowledge_base.available():
        _json_resp(handler, 404, {"error": "지식베이스 경로를 찾지 못했습니다"})
        return
    root = knowledge_base.KB_PATH.resolve()
    f = (knowledge_base.KB_PATH / rel).resolve()
    if not f.is_relative_to(root) or not f.is_file():
        _json_resp(handler, 404, {"error": "파일이 없습니다: " + rel})
        return
    ctype = KB_FILE_TYPES.get(f.suffix.lower())
    if not ctype:
        _json_resp(handler, 403, {"error": "내줄 수 없는 형식입니다: " + f.suffix})
        return
    try:
        body = f.read_bytes()
    except OSError as e:
        _json_resp(handler, 500, {"error": "읽기 실패: " + str(e)})
        return
    handler.send_response(200)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Content-Length", str(len(body)))
    # 수집물은 덮어쓰지 않으므로 내용이 바뀌면 경로도 사실상 바뀐다. 그림
    # 수백 장을 문서를 옮길 때마다 다시 받지 않도록 짧게 캐시한다.
    handler.send_header("Cache-Control", "public, max-age=3600")
    handler.end_headers()
    handler.wfile.write(body)


# ── FreeLLMAPI 라우터 현황 ──────────────────────────────────────
#
# 화면의 "AI 모델" 점은 Ollama 를 본다. 그런데 **실제로 답을 만드는 것은
# 대부분 라우터**다(freellmapi, 포트 3001). 무료 한도를 나눠 쓰는 구조라
# 어느 공급자가 죽었는지·오늘 얼마나 썼는지가 바로 병목이 되는데, 그게
# 화면 어디에도 없었다.
#
# 재료는 맹비서 쪽 `stack_status.py` 가 전부 갖고 있다. 새로 세지 않고
# 그걸 부른다 — 같은 숫자를 두 군데서 세면 어긋나고, 어긋나면 둘 다 못
# 믿게 된다.

_ROUTER_CACHE: dict = {"at": 0.0, "data": None}
_ROUTER_TTL = 20.0          # 화면이 10초마다 불러도 라우터는 20초에 한 번만


def _stack_status():
    """맹비서의 stack_status 모듈. 없으면 None.

    **실패해도 서버는 떠야 한다.** 맹비서가 꺼져 있거나 경로가 바뀌었다고
    명테크가 같이 죽으면 안 된다.
    """
    try:
        if HERMES_DIR not in sys.path:
            sys.path.append(HERMES_DIR)
        import stack_status                      # noqa: PLC0415
        return stack_status
    except Exception:                            # noqa: BLE001
        return None


def _router_status() -> dict:
    now = time.time()
    if _ROUTER_CACHE["data"] is not None and now - _ROUTER_CACHE["at"] < _ROUTER_TTL:
        return _ROUTER_CACHE["data"]

    ss = _stack_status()
    if ss is None:
        out = {"ok": False, "reason": "맹비서의 stack_status 를 불러오지 못했습니다",
               "providers": [], "recent": [], "today": []}
        _ROUTER_CACHE.update(at=now, data=out)
        return out

    up = False
    try:
        up = bool(ss.port_open(ss.ROUTER_PORT))
    except Exception:                            # noqa: BLE001
        pass

    avail, total = -1, -1
    try:
        avail, total = ss.router_models()
    except Exception:                            # noqa: BLE001
        pass

    providers = []
    try:
        for plat, status, enabled in ss.key_health():
            providers.append({"name": plat, "status": status, "enabled": bool(enabled)})
    except Exception:                            # noqa: BLE001
        pass

    today = []
    try:
        for plat, n, tin, tout in ss.usage_today():
            today.append({"name": plat, "calls": n,
                          "in": int(tin or 0), "out": int(tout or 0)})
    except Exception:                            # noqa: BLE001
        pass

    recent = []
    try:
        for ts, plat, status in ss.recent_upstreams(10):
            recent.append({"at": ts, "name": plat, "status": status})
    except Exception:                            # noqa: BLE001
        pass

    out = {
        # 포트가 열렸고 모델 목록을 받았을 때만 ok. 포트만 보고 ok 라 하면
        # 키가 만료돼 401 이 나는 상태를 "정상" 이라고 말하게 된다.
        "ok": up and avail >= 0,
        "up": up,
        "available": avail, "total": total,
        "providers": providers,
        "healthy": sum(1 for p in providers if p["status"] == "healthy" and p["enabled"]),
        "today": today,
        "calls_today": sum(t["calls"] for t in today),
        "recent": recent,
        "port": getattr(ss, "ROUTER_PORT", 3001),
    }
    if not up:
        out["reason"] = f"라우터가 포트 {out['port']} 에서 응답하지 않습니다"
    elif avail < 0:
        out["reason"] = "라우터는 떠 있는데 모델 목록을 못 받았습니다 (키 확인)"
    _ROUTER_CACHE.update(at=now, data=out)
    return out


def _qs_int(qs: dict, key: str, default: int, *,
            lo: int = 0, hi: int = 10_000) -> int:
    """쿼리 파라미터를 정수로. 못 읽으면 기본값, 범위 밖이면 범위 안으로.

    전에는 `int((qs.get("limit") or ["20"])[0])` 였다. `?limit=abc` 가
    ValueError 를 던지고, do_GET 에 최상위 예외 처리가 없어서 **연결이
    그대로 끊겼다** — 브라우저에는 `TypeError: Failed to fetch`, curl 에는
    HTTP 000 으로 나왔다. 화면은 빈 칸이 되고 이유는 어디에도 안 남는다.

    거절하지 않고 상식적인 값으로 받는다. `limit=abc` 는 공격이라기보다
    오타이고, 그때 400 을 돌려주는 것보다 기본값으로 20건을 주는 편이
    쓰는 사람에게 낫다.
    """
    v = (qs.get(key) or [""])[0]
    try:
        n = int(str(v).strip())
    except (TypeError, ValueError):
        return default
    return max(lo, min(n, hi))


def _json_resp(handler, status: int, data: dict | list):
    body = json.dumps(data, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Access-Control-Allow-Origin", "*")
    handler.end_headers()
    handler.wfile.write(body)


# ── 접근 열쇠 ────────────────────────────────────────────────
#
# 이 서버는 결재 승인(유튜브 업로드 포함)·파일 쓰기·.env 저장을 인증 없이
# 받는다. 이 PC 안에서만 쓰는 동안에는 루프백 바인드가 그 방어였다. 밖에서
# 쓰려고 터널을 씌우는 순간 그 방어가 사라지므로, 그때는 열쇠가 필요하다.
#
# MYUNGTECH_ACCESS_KEY 가 비어 있으면 예전과 똑같이 동작한다(무인증·루프백).
# 값이 있으면, **터널을 타고 들어온 요청만** 로그인을 요구한다. 이 PC 에서
# 직접 부르는 요청(워치독·STATUS.bat·텔레그램 게이트웨이·로컬 브라우저)은
# 그대로 통과한다 — 안 그러면 자동화가 전부 401 로 멈춘다.
ACCESS_KEY = (_env_get("MYUNGTECH_ACCESS_KEY")
              or os.environ.get("MYUNGTECH_ACCESS_KEY", "")).strip()
SESSION_TTL = 30 * 24 * 3600          # 폰에서 매번 다시 치게 하면 안 쓰게 된다
_SESSION_SECRET = hashlib.sha256(b"myungtech-session|" + ACCESS_KEY.encode()).digest()

# 무차별 대입 방어. 열쇠는 사람이 외우는 문자열이라 초당 수천 번 시도되면
# 뚫린다. 실패가 쌓이면 잠근다.
_LOGIN_FAILS: dict[str, list] = {}
_LOGIN_MAX = 8
_LOGIN_LOCK = 300.0


def _make_session(now: float | None = None) -> str:
    exp = int((now or time.time()) + SESSION_TTL)
    sig = hmac.new(_SESSION_SECRET, str(exp).encode(), hashlib.sha256).hexdigest()
    return f"{exp}.{sig}"


def _session_valid(token: str) -> bool:
    if not token or "." not in token:
        return False
    exp_s, _, sig = token.partition(".")
    try:
        if int(exp_s) < time.time():
            return False
    except ValueError:
        return False
    want = hmac.new(_SESSION_SECRET, exp_s.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(sig, want)


LOGIN_PAGE = """<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>명테크</title><style>
:root{color-scheme:dark}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b1020;
color:#e8ecf8;font:15px/1.6 system-ui,-apple-system,"Malgun Gothic",sans-serif}
form{width:min(92vw,340px);padding:28px;background:#141a2e;border:1px solid #263152;
border-radius:14px}
h1{margin:0 0 4px;font-size:19px}p{margin:0 0 20px;color:#8f9bc0;font-size:13px}
/* 눈 버튼이 글자 위에 겹치므로 입력칸의 오른쪽을 비워 둔다. 안 비우면
   긴 열쇠의 끝 글자가 아이콘 밑으로 들어가 안 보인다. */
input{width:100%;box-sizing:border-box;padding:12px 46px 12px 12px;font-size:16px;
border-radius:9px;border:1px solid #2f3a5e;background:#0d1224;color:#e8ecf8}
.field{position:relative}
/* 보기/가리기. 버튼이라 Tab 으로 닿고 Enter 로 눌린다 — 아이콘을 div 로
   두면 키보드만 쓰는 사람에게는 없는 것과 같다. */
.eye{position:absolute;top:50%;right:6px;transform:translateY(-50%);
width:34px;height:34px;display:grid;place-items:center;padding:0;margin:0;
border:0;border-radius:8px;background:transparent;color:#8f9bc0;cursor:pointer}
.eye:hover{color:#e8ecf8;background:#1b2340}
.eye:focus-visible{outline:2px solid #5b6cff;outline-offset:1px}
.eye svg{width:19px;height:19px;display:block}
button{width:100%;margin-top:12px;padding:12px;font-size:15px;font-weight:600;
border:0;border-radius:9px;background:#5b6cff;color:#fff;cursor:pointer}
.err{margin-top:12px;color:#ff8f8f;font-size:13px;min-height:1.2em}
</style></head><body>
<form onsubmit="go(event)">
<h1>명테크</h1><p>외부 접속입니다. 접근 열쇠를 넣어 주세요.</p>
<div class="field">
<input id="k" type="password" autocomplete="current-password" autofocus>
<button type="button" class="eye" id="eye" onclick="peek()"
 aria-label="열쇠 보기" aria-pressed="false" title="열쇠 보기">
<svg id="eyeOn" viewBox="0 0 24 24" fill="none" stroke="currentColor"
 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>
</svg>
<svg id="eyeOff" viewBox="0 0 24 24" fill="none" stroke="currentColor"
 stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none">
<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
<path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/>
<path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/><path d="M1 1l22 22"/>
</svg>
</button></div>
<button>들어가기</button><div class="err" id="e"></div></form>
<script>
/* 열쇠 보기/가리기.
 *
 * type 만 바꾸면 **커서가 끝으로 튄다** — 가운데를 고치던 중이면 자리를
 * 잃는다. 그래서 선택 범위를 기억했다가 되돌린다.
 *
 * 누른 뒤 입력칸으로 포커스를 돌려준다. 안 그러면 보이게 해 놓고 다시
 * 칸을 눌러야 해서, 한 번 할 일이 두 번이 된다. */
function peek(){
  var k=document.getElementById('k'), b=document.getElementById('eye');
  var on=k.type==='password';
  var s=k.selectionStart, e=k.selectionEnd;
  k.type=on?'text':'password';
  b.setAttribute('aria-pressed',String(on));
  b.setAttribute('aria-label',on?'열쇠 가리기':'열쇠 보기');
  b.title=on?'열쇠 가리기':'열쇠 보기';
  document.getElementById('eyeOn').style.display=on?'none':'block';
  document.getElementById('eyeOff').style.display=on?'block':'none';
  k.focus();
  try{k.setSelectionRange(s,e);}catch(_){}
}
async function go(ev){
  ev.preventDefault();
  var e=document.getElementById('e'), k=document.getElementById('k');
  var btn=document.querySelector('button[type=submit],form button:not(.eye)');
  e.textContent='';
  if(btn){btn.disabled=true;}
  var msg='';
  try{
    var r=await fetch('/api/auth/login',{method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({key:k.value})});
    var d=await r.json().catch(function(){return {};});
    if(r.ok&&d.ok){location.href='/';return;}
    msg=d.error||'열쇠가 맞지 않습니다';
  }catch(err){
    /* **fetch 자체가 실패한 경우.** 전에는 여기서 예외가 그대로 터져
       화면이 아무 반응 없이 멈췄다 — 사장님은 버튼이 안 눌린 줄 안다.
       폰이 터널 밖으로 나갔거나 PC 가 잠들면 실제로 일어난다. */
    msg='서버에 닿지 못했습니다. 연결을 확인해 주세요.';
  }finally{
    if(btn){btn.disabled=false;}
    /* 실패 화면은 그대로 남는다. 보기를 켜 둔 채였다면 열쇠가 노출된 채
       방치되므로 **어느 실패 경로든** 되돌린다. */
    if(k.type==='text'){peek();}
  }
  e.textContent=msg;
}
</script></body></html>"""


class Handler(BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        pass  # 조용하게

    def _origin(self) -> str:
        """휴지통 알림에 적는 "어디서 지웠나". 본인 행위인지 가리는 단서다."""
        if self._local_direct():
            return "이 PC(직접)"
        h = self.headers
        who = (h.get("X-Forwarded-For") or h.get("Cf-Connecting-Ip")
               or self.client_address[0]).split(",")[0].strip()
        user = h.get("Tailscale-User-Login") or ""
        return f"원격 {who}" + (f" ({user})" if user else "")

    # ── 인증 ──────────────────────────────────────────────
    def _local_direct(self) -> bool:
        """이 PC 에서 직접 온 요청인가.

        터널(tailscale serve/funnel, cloudflared)은 프록시라서 X-Forwarded-*
        를 붙이고 Host 를 바깥 이름으로 준다. 그 흔적이 하나라도 있으면
        바깥에서 온 것으로 본다. 흔적을 지울 수 있는 건 이 PC 안의 프로세스
        뿐인데, 거기까지 들어온 상대는 이미 이 파일을 직접 읽을 수 있다.
        """
        h = self.headers
        if h.get("X-Forwarded-For") or h.get("X-Forwarded-Proto") \
                or h.get("Tailscale-User-Login") or h.get("Cf-Connecting-Ip"):
            return False
        host = (h.get("Host") or "").rsplit(":", 1)[0].strip("[]").lower()
        if host not in ("127.0.0.1", "localhost", "::1", ""):
            return False
        return self.client_address[0] in ("127.0.0.1", "::1")

    def _has_session(self) -> bool:
        raw = self.headers.get("Cookie") or ""
        for part in raw.split(";"):
            k, _, v = part.strip().partition("=")
            if k == "mt_session" and _session_valid(v):
                return True
        return False

    def _serve_login(self) -> None:
        body = LOGIN_PAGE.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _blocked(self, path: str) -> bool:
        """막았으면 True — 호출한 쪽은 즉시 리턴해야 한다."""
        if not ACCESS_KEY:
            return False
        if path.startswith("/api/auth/"):
            return False

        # 정적 자산은 로그인 없이. 그림·글꼴에는 사장님 데이터가 없고,
        # 막으면 **로그인 HTML 이 PNG 자리에 돌아가** 화면이 깨진다
        # (실측: floor_4.png 요청에 4,916B 짜리 로그인 화면이 왔다).
        if path.startswith("/assets/") or path in ("/favicon.ico", "/manifest.webmanifest"):
            return False

        # `/login` 은 **로그인 화면을 준다.** 전에는 "막지 않음" 으로만 두어
        # 그대로 흘러갔고, SPA 껍데기가 나왔다. 그 껍데기는 /api 를 부르다
        # 401 을 받고, 그 401 이 다시 `login: "/login"` 을 가리켜 **제자리를
        # 맴돌았다.** 401 의 안내가 실제로 닿는 곳이 되게 한다.
        #
        # 이미 들어와 있는 사람이 /login 을 치면 앱으로 보낸다 — 들어와
        # 있는데 또 열쇠를 묻는 것은 말이 안 된다.
        if path == "/login":
            if self._local_direct() or self._has_session():
                self.send_response(302)
                self.send_header("Location", "/")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
            else:
                self._serve_login()
            return True

        if self._local_direct() or self._has_session():
            return False
        # **요청한 형식에 맞춰 답한다.**
        #
        # 전에는 /api 가 아니면 무엇이든 로그인 HTML 을 돌려줬다. 그래서
        # `<img>` 나 `<script>` 가 HTML 을 받아 "깨진 파일" 로 보였고,
        # 콘솔에는 디코드 실패만 남아 원인을 알 수 없었다.
        #
        # 화면을 보러 온 요청(주소창 이동)은 Accept 에 text/html 을 담는다.
        # 그 경우에만 로그인 화면을 준다.
        accept = (self.headers.get("Accept") or "")
        wants_page = "text/html" in accept
        if path.startswith("/api"):
            _json_resp(self, 401, {"error": "로그인이 필요합니다", "login": "/login"})
        elif wants_page:
            self._serve_login()
        else:
            _json_resp(self, 401, {"error": "로그인이 필요합니다",
                                   "login": "/login", "path": path[:120]})
        return True

    def _login(self) -> None:
        who = self.headers.get("X-Forwarded-For") or self.client_address[0]
        now = time.time()
        fails = [t for t in _LOGIN_FAILS.get(who, []) if now - t < _LOGIN_LOCK]
        if len(fails) >= _LOGIN_MAX:
            _LOGIN_FAILS[who] = fails
            _json_resp(self, 429, {"ok": False,
                                   "error": "시도가 너무 많습니다. 5분 뒤에 다시."})
            return
        given = str(self._read_body().get("key") or "")
        if not (ACCESS_KEY and hmac.compare_digest(given, ACCESS_KEY)):
            fails.append(now)
            _LOGIN_FAILS[who] = fails
            _json_resp(self, 401, {"ok": False, "error": "열쇠가 맞지 않습니다"})
            return
        _LOGIN_FAILS.pop(who, None)
        # Secure 는 HTTPS 일 때만. 로컬 http 에서 붙이면 브라우저가 쿠키를 버린다.
        secure = "; Secure" if self.headers.get("X-Forwarded-Proto") == "https" else ""
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header(
            "Set-Cookie",
            f"mt_session={_make_session()}; Path=/; Max-Age={SESSION_TTL}; "
            f"HttpOnly; SameSite=Lax{secure}")
        body = json.dumps({"ok": True}).encode("utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _upload(self) -> None:
        import base64
        import re as _re
        size = int(self.headers.get("Content-Length", 0) or 0)
        # 읽기 **전에** 거절한다. 다 읽고 거절하면 메모리가 이미 찬 뒤다.
        if size <= 0:
            _json_resp(self, 400, {"error": "보낸 파일이 없습니다"})
            return
        if size > UPLOAD_MAX_BODY:
            _json_resp(self, 413, {"error": "파일이 너무 큽니다 (25MB 까지)"})
            return
        body = self._read_body()
        name = str(body.get("name") or "").strip()
        data = str(body.get("data") or "")
        ext = Path(name).suffix.lower()
        if ext not in UPLOAD_EXT:
            _json_resp(self, 415, {
                "error": f"받지 않는 형식입니다: {ext or '(확장자 없음)'}",
                "allowed": sorted(UPLOAD_EXT)})
            return
        try:
            raw = base64.b64decode(data.split(",", 1)[-1], validate=True)
        except Exception:  # noqa: BLE001
            _json_resp(self, 400, {"error": "파일을 읽지 못했습니다 (base64)"})
            return

        # 이름을 새로 짓는다. 경로 구분자·`..`·제어문자를 지워 경로 이탈을
        # 막고, 시각을 앞에 붙여 같은 이름이 덮어쓰지 않게 한다.
        stem = _re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", Path(name).stem)
        stem = stem.replace("..", "_").strip(" ._")[:80] or "file"
        UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        dest = (UPLOAD_DIR / f"{time.strftime('%Y%m%d-%H%M%S')}-{stem}{ext}").resolve()
        if not dest.is_relative_to(UPLOAD_DIR.resolve()):
            _json_resp(self, 400, {"error": "파일 이름이 올바르지 않습니다"})
            return
        dest.write_bytes(raw)
        _json_resp(self, 200, {"ok": True, "path": str(dest),
                               "name": dest.name, "size": len(raw),
                               "kind": "image" if ext in (".png", ".jpg", ".jpeg",
                                                          ".webp", ".gif") else "file"})

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

    # ── 예외 가드 ────────────────────────────────────────────────
    #
    # 전에는 do_GET 등에 최상위 예외 처리가 없었다. 어떤 예외든 핸들러를
    # 빠져나가면 응답을 쓰지 않은 채 연결이 닫혀서, 쓰는 쪽에는
    # `TypeError: Failed to fetch`(브라우저) · HTTP 000(curl) 으로 나타나고
    # 화면은 그냥 빈 칸이 된다. 서버가 꺼진 건지, 데이터가 없는 건지,
    # 주소가 틀린 건지 구분할 수가 없다. 로그에도 안 남았다.
    #
    # `?limit=abc` 하나로 재현했지만 그건 눈에 띈 사례일 뿐이다 — 앞으로
    # 어느 경로에서 무슨 예외가 나도 똑같이 조용히 사라진다.
    #
    # 그래서 라우팅 본체를 `_route_*` 로 두고 여기서 감싼다. 라우팅 코드는
    # 한 줄도 바꾸지 않는다.

    def _guard(self, verb: str) -> None:
        try:
            getattr(self, f"_route_{verb}")()
        except (BrokenPipeError, ConnectionResetError):
            # 브라우저가 먼저 끊었다. 우리 잘못이 아니고 쓸 곳도 없다.
            pass
        except Exception:                           # noqa: BLE001
            import traceback
            tb = traceback.format_exc()
            print(f"[server] {verb} {self.path} 처리 중 예외:\n{tb}",
                  file=sys.stderr, flush=True)
            try:
                # 헤더를 이미 보냈으면 또 쓸 수 없다. 그때는 로그만 남는다 —
                # 그래도 **왜 끊겼는지**는 알 수 있다.
                _json_resp(self, 500, {
                    "error": "서버에서 처리하지 못했습니다",
                    "detail": tb.strip().splitlines()[-1][:300],
                    "path": self.path[:200],
                })
            except Exception:                       # noqa: BLE001
                pass

    def do_GET(self):     self._guard("GET")        # noqa: N802,E704
    def do_PUT(self):     self._guard("PUT")        # noqa: N802,E704
    def do_DELETE(self):  self._guard("DELETE")     # noqa: N802,E704
    def do_PATCH(self):   self._guard("PATCH")      # noqa: N802,E704
    def do_POST(self):    self._guard("POST")       # noqa: N802,E704

    def _route_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        if self._blocked(path):
            return

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
                "disk": _disk_health(),
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
            # status 는 파일에 적힌 값이라 아무도 갱신하지 않는다 — 12명이
            # 늘 Idle 이었다. 부서가 실제로 일하는 중이면 Working 으로 본다.
            act = _dept_activity()
            summary = []
            for a in agents:
                dept = a.get("department", "")
                busy = act.get(dept)
                summary.append({
                    "agent_id":       a.get("agent_id"),
                    "character_name": a.get("character_name", ""),
                    "role":           a.get("role", ""),
                    "department":     dept,
                    "status":         "Working" if busy else a.get("status", "Idle"),
                    # 무엇을 하고 있는지까지 준다. "일하는 중" 만으로는
                    # 화면이 또 한 번 "그래서 뭘?" 을 못 답한다.
                    "doing":          (f"{busy['label']} · {busy['project']}"[:60]
                                       if busy and busy.get("project")
                                       else (f"태스크 {busy['tasks']}건" if busy else "")),
                })
            _json_resp(self, 200, {"total": len(summary), "agents": summary,
                                   "dept_activity": act})

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

        # ── GET /api/knowledge/retrieval  (무엇을 어떻게 찾는가)
        #
        # 지식 네트워크 화면이 2026-09-10 이후 멈춰 있었다. 그 뒤로 임베딩이
        # 들어왔고 근거에 이전 AI 출력이 섞이게 됐는데 화면에는 그 말이 없다.
        # 틀린 말은 아니지만 빠진 말이 있는 상태다.
        elif path == "/api/knowledge/retrieval":
            try:
                import knowledge_base as _kb
                import kb_embed as _emb
                counts = {}
                for cat in _kb.SEARCH_DIRS:
                    try:
                        counts[cat] = len(list((_kb.KB_PATH / cat).glob("*.md")))
                    except OSError:
                        counts[cat] = -1          # 모르는 것과 0 을 섞지 않는다
                by_origin: dict[str, int] = {}
                for cat, n in counts.items():
                    if n < 0:
                        continue
                    k = _kb.origin_of(f"{cat}/x.md")
                    by_origin[k] = by_origin.get(k, 0) + n
                try:
                    emb = _emb.stats(_kb.KB_PATH)
                except Exception as e:  # noqa: BLE001
                    emb = {"error": f"조회 실패: {e}"}
                _json_resp(self, 200, {
                    "dirs": counts,
                    "by_origin": by_origin,
                    "origin_ko": _kb.ORIGIN_KO,
                    "embedding": emb,
                    "seats": {"embed": getattr(_kb, "EMBED_SEATS", None),
                              "recent": getattr(_kb, "RECENT_SEATS", None)},
                })
            except Exception as e:  # noqa: BLE001
                _json_resp(self, 500, {"error": f"조회 실패: {e}"})

        # ── GET /api/archive/<pid>[/<did>]  (보관된 프롬프트 전문)
        #
        # ISPOR ① 은 "전체 프롬프트 공개" 다. 보관만 하고 꺼내 볼 수 없으면
        # 절반이다 — 그래서 읽는 길을 둔다. 기본은 목록(전문 제외)이고,
        # ?full=1 일 때만 본문을 싣는다. 호출 하나가 1만 자 넘는 경우가
        # 있어(실측 최대 16,102자) 목록까지 전문을 실으면 응답이 수 MB 가 된다.
        elif path.startswith("/api/archive/"):
            rest = [x for x in path.split("/api/archive/")[1].split("/") if x]
            if not rest:
                _json_resp(self, 400, {"error": "프로젝트 id 가 필요합니다"})
                return
            pid = rest[0]
            did = rest[1] if len(rest) > 1 else ""
            full = (parse_qs(parsed.query).get("full") or ["0"])[0] == "1"
            try:
                import archive as _archive
                rows = [r for r in _archive.calls(pid, did=did) if not r.get("_broken")]
                if not full:
                    rows = [{k: v for k, v in r.items()
                             if k not in ("system", "user")}
                            | {"system_chars": len(r.get("system") or ""),
                               "user_chars": len(r.get("user") or "")}
                            for r in rows]
                _json_resp(self, 200, {"calls": rows,
                                       "stats": _archive.stats(pid),
                                       "full": full})
            except Exception as e:  # noqa: BLE001
                _json_resp(self, 500, {"error": f"보관 조회 실패: {e}"})

        # ── GET /api/assistant/*  (맹비서 중계 — 읽기)
        elif path == "/api/assistant/health":
            st, body = _assistant_call("GET", "/health")
            _json_resp(self, 200 if st == 200 else st,
                       {"ok": st == 200, **body})

        elif path == "/api/assistant/sessions":
            # 출처·개수를 그대로 넘긴다.
            #
            # 전에는 질의를 버려서 맹비서 기본값(limit 50, 모든 출처)만
            # 받았다. 그러면 화면이 "대시보드 대화만 보기" 를 할 수 없고,
            # 50건이 넘으면 오래된 것이 조용히 잘렸다 — 사장님 눈에는
            # 대화가 사라진 것으로 보인다.
            qs = urllib.parse.parse_qs(parsed.query)
            fwd = []
            src = (qs.get("source") or [""])[0].strip()
            # 화이트리스트. 임의 문자열을 그대로 붙이면 맹비서 질의에
            # 아무 값이나 실어 보낼 수 있다.
            if src in ("api_server", "discord", "telegram", "cli", "slack"):
                fwd.append(f"source={urllib.parse.quote(src)}")
            fwd.append(f"limit={_qs_int(qs, 'limit', 100, lo=1, hi=200)}")
            fwd.append(f"offset={_qs_int(qs, 'offset', 0, lo=0, hi=100000)}")
            st, body = _assistant_call(
                "GET", "/api/sessions?" + "&".join(fwd))
            _json_resp(self, st, body)

        elif (path.startswith("/api/assistant/sessions/")
              and path.endswith("/messages")):
            sid = path[len("/api/assistant/sessions/"):-len("/messages")]
            st, body = _assistant_call(
                "GET", f"/api/sessions/{urllib.parse.quote(sid)}/messages")
            _json_resp(self, st, body)

        # ── GET /api/notify/status  (어느 채널이 주인가)
        #
        # 관리 탭이 전에는 /api/config/load 의 키 목록으로 채널을 판단했다.
        # 그 목록에 DISCORD_BOT_TOKEN 이 없고, 애초에 그 토큰은 명테크가
        # 아니라 hermes 의 .env 에 산다 — 키 유무로 추정하면 영원히
        # "미연결" 이라고 말한다. notify 가 이미 정답을 안다.
        elif path == "/api/notify/status":
            try:
                _json_resp(self, 200, notify.status())
            except Exception as e:  # noqa: BLE001
                _json_resp(self, 200, {"error": f"조회 실패: {e}", "primary": None})

        # ── GET /api/cycle/status  (이름은 유지 — 화면 6곳이 이 모양을 읽는다)
        #
        # 전에는 cycle_runner 의 깃발이었다. 그건 사장님이 "운영 시작" 을
        # 눌렀을 때만 참이었고, 사이클을 들어낸 지금은 영원히 'stopped' 다.
        # 같은 자리에 **실제 활동**을 넣는다 — 사무실 탭의 `● LIVE` 가
        # 처음으로 사실을 가리키게 된다.
        elif path == "/api/cycle/status":
            _json_resp(self, 200, _activity())

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
                    # 위의 disk_* 는 ROOT 가 사는 볼륨 하나뿐이다(= D:).
                    # 실측에서 차오르고 있던 쪽은 C: 였고 그게 안 보였다.
                    # 아래가 볼륨 전부를 보여 준다. 위 키는 게이지가 읽고
                    # 있어 그대로 둔다.
                    **_disk_block(),
                })
            else:
                # psutil 이 없어도 디스크는 shutil 로 잴 수 있다. 디스크
                # 정보가 psutil 설치 여부에 묶여 있을 이유가 없다.
                _json_resp(self, 200, {
                    "error": "psutil not installed",
                    "cpu_percent": 0, "mem_percent": 0,
                    **_disk_block(),
                })

        # ── GET /api/tasks/list?status=&limit=20&offset=0
        elif path == "/api/tasks/list":
            qs = parse_qs(parsed.query)
            status_filter = (qs.get("status") or [None])[0]
            limit  = _qs_int(qs, "limit", 20, lo=1, hi=1000)
            offset = _qs_int(qs, "offset", 0, lo=0, hi=100_000)
            all_t  = task_queue.list_tasks(status_filter)
            all_t.sort(key=lambda t: t.get("updated_at", ""), reverse=True)
            total  = len(all_t)
            page   = all_t[offset: offset + limit]

            # 목록에는 답 전문을 싣지 않는다. 18건에 97 KB 였고, 그 거의
            # 전부가 `result` 였다. 화면은 목록의 result 를 쓰지 않는다 —
            # 상세는 TaskDrawer 가 `/api/tasks/<id>` 로 따로 받는다.
            # 자른 건에는 표시를 남겨, 받는 쪽이 전문인지 아닌지 알 수 있게 한다.
            RESULT_PREVIEW = 300
            slim = []
            for row in page:
                r = row.get("result")
                if isinstance(r, str) and len(r) > RESULT_PREVIEW:
                    row = dict(row)
                    row["result"] = r[:RESULT_PREVIEW]
                    row["result_truncated"] = True
                slim.append(row)
            page = slim

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

        # 축적된 경험 — 검토를 통과한 프로젝트가 위키에 몇 건 쌓였는가.
        elif path == "/api/experience":
            try:
                from shared_memory import experience
                _json_resp(self, 200, experience.stats())
            except Exception as e:  # noqa: BLE001
                _json_resp(self, 200, {"available": False, "count": 0, "error": str(e)})

        elif path == "/api/integrations":
            # 각 연동을 **실제로 한 번 호출해 본다.** 키가 저장돼 있다는 것과
            # 그 키로 호출이 되더라는 것은 다르다 — 예전 화면은 전자를
            # "연결됨" 이라고 불렀다.
            if integrations is None:
                _json_resp(self, 200, {"integrations": [],
                                       "error": "연동 모듈을 불러오지 못했습니다"})
            else:
                _json_resp(self, 200, {"integrations": integrations.status_all()})

        # 에이전트 사이에 오간 말. 여러 프로젝트를 시간순으로 합친다.
        # 사무실의 '💬 에이전트 대화' 와 프로젝트 탭이 읽는다.
        elif path == "/api/dialogue":
            q = parse_qs(parsed.query)
            try:
                limit = max(1, min(500, int((q.get("limit") or ["80"])[0])))
            except ValueError:
                limit = 80
            only = (q.get("project") or [""])[0]
            try:
                import project_runner
                rows = []
                for p in projects.load():
                    if only and p.get("id") != only:
                        continue
                    for e in project_runner.dialogue_of(p):
                        rows.append({**e, "project_id": p.get("id"),
                                     "project_title": p.get("title", "")})
                rows.sort(key=lambda e: e.get("at") or 0)
                _json_resp(self, 200, {"dialogue": rows[-limit:]})
            except Exception as e:  # noqa: BLE001
                _json_resp(self, 500, {"error": f"대화 기록을 읽지 못했습니다: {e}"})

        # ── GET /api/trash  (휴지통 목록 — 본문은 싣지 않는다)
        elif path == "/api/trash":
            try:
                _json_resp(self, 200, {"items": trash.listing()})
            except Exception as e:  # noqa: BLE001
                _json_resp(self, 500, {"error": f"휴지통을 읽지 못했습니다: {type(e).__name__}"})

        elif path == "/api/projects":
            rows = []
            for p in projects.load():
                # 목록에는 본문을 싣지 않는다. 산출물이 수만 자라 화면이 굳는다.
                #
                # dialogue·sources_by_d·sources 도 같은 이유로 뺀다. 이 셋이
                # 응답의 **95%** 였다(실측 826KB 중 498KB). 화면은 대화를
                # `/api/dialogue` 로 따로 받고, 나머지 둘은 아예 쓰지 않는다.
                # 전부 필요하면 `/api/projects/<id>` 를 부르면 된다.
                rows.append({k: v for k, v in p.items()
                             if k not in ("artifacts", "steps",
                                          "dialogue", "sources_by_d", "sources")}
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

        # ── GET /api/verify/<pid>/<did>  (사람이 검증할 표본)
        #
        # 명테크의 검토는 모델끼리다. 사람의 눈은 승인 두 지점에만 있었고,
        # ISPOR 의 8개 축 중 "인간 기준" 이 비어 있었다(평가 30건 중 23건이
        # 이걸 뒀는데 우리는 0이었다).
        #
        # 기계가 실제 논문을 찾아 나란히 놓고, **사람은 "이 논문이 정말 그
        # 말을 하는가" 만 판단한다.** 모델에게 물으면 맞다고 하므로 그 답은
        # 점수와 같은 성질이라 아무것도 보태지 않는다.
        elif path.startswith("/api/verify/"):
            rest = path.split("/api/verify/")[1].split("/")
            if len(rest) != 2:
                _json_resp(self, 404, {"error": "Not found"})
                return
            proj = projects.get(rest[0])
            if proj is None:
                _json_resp(self, 404, {"error": f"없는 프로젝트: {rest[0]}"})
                return
            try:
                import verify as _verify
                out = _verify.build(proj, rest[1])
                out["summary"] = _verify.summary(proj, rest[1])
                _json_resp(self, 200, out)
            except Exception as e:  # noqa: BLE001
                _json_resp(self, 500, {"error": str(e), "claims": []})

        # ── GET /api/lessons  (막힌 프로젝트에서 건진 교훈)
        #
        # 교훈은 쌓이고 계획에 주입되는데 **볼 수 있는 화면이 없었다.**
        # 시스템이 배우고 있다는 것을 사장님이 확인할 길이 없으면, 그건
        # 작동하는지 알 수 없는 기능이고 믿을 근거도 없다.
        # ── GET /api/provenance/<pid>/<did>  (산출물의 '방법' 절)
        #
        # RAISE 가 요구하는 공개를 화면에서도 볼 수 있어야 한다. 파일과
        # 위키에는 붙지만, 결재하기 전에 "이게 어떻게 나왔나" 를 보려면
        # 화면에서도 읽혀야 한다.
        elif path.startswith("/api/provenance/"):
            rest = path.split("/api/provenance/")[1].split("/")
            if len(rest) != 2:
                _json_resp(self, 404, {"error": "Not found"})
                return
            pid, did = rest
            proj = projects.get(pid)
            if proj is None:
                _json_resp(self, 404, {"error": f"없는 프로젝트: {pid}"})
                return
            d = next((x for x in (proj.get("plan") or {}).get("deliverables") or []
                      if x.get("id") == did), None)
            if d is None:
                _json_resp(self, 404, {"error": f"없는 산출물: {did}"})
                return
            try:
                import provenance
                _json_resp(self, 200, {"markdown": provenance.methods_section(proj, d)})
            except Exception as e:  # noqa: BLE001
                _json_resp(self, 500, {"error": str(e), "markdown": ""})

        elif path == "/api/lessons":
            try:
                import lessons as _lessons
                rows = sorted(workspace_store.load("lessons"),
                              key=lambda r: r.get("at") or "", reverse=True)
                _json_resp(self, 200, {"items": rows, "stats": _lessons.stats()})
            except Exception as e:  # noqa: BLE001
                _json_resp(self, 500, {"error": str(e), "items": [], "stats": {}})

        elif path.startswith("/api/store/"):
            collection = path.split("/api/store/")[1]
            if collection not in workspace_store.COLLECTIONS:
                _json_resp(self, 404, {"error": f"알 수 없는 컬렉션: {collection}"})
                return
            items = workspace_store.load(collection)
            if collection == "approvals":
                # 등급은 저장하지 않고 읽을 때마다 계산한다. 저장하면 규칙이
                # 바뀌어도 옛 행은 옛 등급을 그대로 들고 있게 된다.
                items = [approval_tiers.annotate(r) for r in items]
            _json_resp(self, 200, {"items": items})

        # ── GET /api/calendar/status
        elif path == "/api/calendar/status":
            _json_resp(self, 200, {
                "connected": bool(_env_get("GOOGLE_CALENDAR_REFRESH_TOKEN")),
                # 유튜브와 **같은 클라이언트**를 쓴다. 따로 만들지 않는 이유는
                # CAL_SCOPE 위의 주석에.
                "has_client": bool(_env_get("YOUTUBE_OAUTH_CLIENT_ID")
                                   and _env_get("YOUTUBE_OAUTH_CLIENT_SECRET")),
                "pending": bool(_cal_oauth["state"]) and not _cal_oauth["code"],
                "error": _cal_oauth["error"],
                "scope": CAL_SCOPE,
            })

        # ── GET /api/calendar/events?days=14
        elif path == "/api/calendar/events":
            days = _qs_int(parse_qs(parsed.query), "days", 14, lo=1, hi=90)
            _json_resp(self, 200, _calendar_events(days=days))

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
            # 값 자체는 보내지 않는다. 끝 4자리와 길이만 — 입력칸이 빈칸으로 열려도
            # "저장돼 있다" 는 것과 "어느 값이 들어 있는지" 는 알 수 있어야 한다.
            hints: dict[str, str] = {}
            if ENV_FILE.exists():
                for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
                    if "=" in line and not line.startswith("#"):
                        k = line.split("=")[0].strip()
                        v = line.split("=", 1)[1].strip().strip('"')
                        keys[k] = bool(v)
                        if v and k in ALLOWED_ENV_KEYS:
                            hints[k] = _mask(v)
            _json_resp(self, 200, {"keys": keys, "hints": hints})

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
        elif path == "/api/briefing":
            _json_resp(self, 200, {"text": _briefing()})

        elif path == "/api/knowledge/read":
            slug = (parse_qs(parsed.query).get("slug") or [""])[0]
            try:
                _json_resp(self, 200, {"slug": slug, "content": knowledge_base.read_node(slug)})
            except Exception as e:
                _json_resp(self, 404, {"error": str(e)})

        # ── GET /api/router/status  (FreeLLMAPI 라우터)
        elif path == "/api/router/status":
            _json_resp(self, 200, _router_status())

        # ── GET /api/knowledge/tree  (지식베이스 탭 사이드바)
        elif path == "/api/knowledge/tree":
            _json_resp(self, 200, _kb_tree())

        # ── GET /api/knowledge/doc?path=concepts/transformer.md  (뷰어)
        elif path == "/api/knowledge/doc":
            rel = (parse_qs(parsed.query).get("path") or [""])[0]
            d = _kb_doc(rel) if rel else {"error": "path 가 없습니다"}
            _json_resp(self, 404 if d.get("error") else 200, d)

        # ── GET /api/knowledge/file?path=raw/assets/…  (그림·PDF)
        elif path == "/api/knowledge/file":
            rel = (parse_qs(parsed.query).get("path") or [""])[0]
            if rel:
                _kb_file(self, rel)
            else:
                _json_resp(self, 400, {"error": "path 가 없습니다"})



        elif not path.startswith("/api"):
            self._serve_ui(path)

        else:
            _json_resp(self, 404, {"error": "Not found"})

    # ── 빌드된 화면 서빙 ──────────────────────────────────────
    #
    # 개발 중에는 Vite(5174)가 화면을, 이 서버(9000)가 API를 맡고 Vite 가
    # /api 를 이쪽으로 넘긴다. 그 구성은 이 PC 안에서만 성립한다 — 밖에서
    # 쓰려면 포트 두 개를 뚫어야 하고, HMR 웹소켓이 터널을 잘 타지 못한다.
    # 빌드본을 이 서버가 같이 내보내면 출처가 하나가 되므로, 터널도 포트
    # 하나만 감싸면 된다. 화면과 API 가 같은 출처라 CORS 도 필요 없다.
    def _serve_ui(self, path: str) -> None:
        if not UI_DIR.is_dir():
            _json_resp(self, 404, {"error": "빌드된 화면이 없습니다 "
                                            "(virtual-office 에서 npm run build)"})
            return

        rel = (path or "/").lstrip("/") or "index.html"
        target = (UI_DIR / rel).resolve()
        # 심볼릭 링크나 ../ 로 dist 밖을 읽지 못하게 막는다.
        if not target.is_relative_to(UI_DIR.resolve()) or not target.is_file():
            # 클라이언트 라우팅: 없는 경로는 화면이 알아서 처리하도록 index 로.
            target = UI_DIR / "index.html"
            rel = "index.html"
            if not target.is_file():
                _json_resp(self, 404, {"error": "index.html 이 없습니다"})
                return

        ctype = mimetypes.guess_type(rel)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in ("application/javascript",
                                                  "application/json"):
            ctype += "; charset=utf-8"
        try:
            body = target.read_bytes()
        except OSError as e:
            _json_resp(self, 500, {"error": f"읽기 실패: {e}"})
            return

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # assets/ 는 파일명에 해시가 붙으므로 길게 캐시해도 안전하다. index.html
        # 은 그 해시를 가리키는 지도라서 캐시되면 옛 화면에 갇힌다.
        if rel.startswith("assets/"):
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _route_PUT(self):
        """PATCH 대신 PUT 을 쓴다 — do_PATCH 는 이미 에이전트 수정에 쓰고 있다."""
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        if self._blocked(path):
            return
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
                # 누가 결정했는지를 남긴다. 이것이 없어서 결재 9건이 왜
                # 승인됐는지 사후에 밝힐 수 없었다 — 승인이 곧 실행인
                # 시스템에서 그건 감사 불가능을 뜻한다.
                row = workspace_store.update(rest[0], rest[1], {
                    "decided_by": str(patch.get("decided_by") or "ui"),
                    "decided_at": time.time(),
                }) or row
                out["item"] = row
                out["followup"] = _approval_followup(row)
            _json_resp(self, 200, out)
        else:
            _json_resp(self, 404, {"error": "Not found"})

    def _route_DELETE(self):
        # do_DELETE 가 클래스 안에 두 번 정의돼 있었다. 파이썬은 뒤엣것으로
        # 덮어쓰므로 에이전트 삭제만 살아 있고 태스크 삭제는 죽어 있었다 —
        # UI 의 태스크 삭제 버튼이 조용히 아무 일도 하지 않은 이유다. 합친다.
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        if self._blocked(path):
            return

        if path.startswith("/api/store/"):
            rest = path.split("/api/store/")[1].split("/")
            if len(rest) != 2 or rest[0] not in workspace_store.COLLECTIONS:
                _json_resp(self, 404, {"error": "Not found"})
                return
            # 노트(사장님 것 · 에이전트 것)는 바로 지우지 않고 휴지통으로.
            # 이 길을 열어 두면 휴지통·알림을 건너뛰고 지울 수 있게 된다.
            kind = {"notes": "note", "tasks": "task"}.get(rest[0])
            if kind:
                moved, _ = trash.move([{"kind": kind, "id": rest[1]}], self._origin())
                _json_resp(self, 200, {"ok": bool(moved), "trashed": True})
                return
            _json_resp(self, 200, {"ok": workspace_store.remove(rest[0], rest[1])})

        elif path.startswith("/api/projects/"):
            # 프로젝트도 휴지통으로. 전에는 여기서 바로 지웠다(기록·이벤트).
            # 이벤트는 휴지통이 같이 옮겨 두었다가 되살릴 때 돌려놓는다.
            pid = path.split("/api/projects/")[1]
            moved, _ = trash.move([{"kind": "project", "id": pid}], self._origin())
            _json_resp(self, 200, {"ok": bool(moved), "trashed": True})

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

        # ── DELETE /api/assistant/sessions/<id>  (대화 삭제)
        #
        # 되돌릴 수 없다 — 맹비서가 state.db 에서 행을 지운다. 그래서
        # 화면 쪽에서 두 번 누르게 만들어 두었다(휴지통 → "지웁니다").
        # 여기서 또 막으면 사장님이 지울 방법이 없어진다.
        elif path.startswith("/api/assistant/sessions/"):
            sid = path[len("/api/assistant/sessions/"):]
            if not sid or "/" in sid:
                _json_resp(self, 400, {"error": "세션 ID 가 올바르지 않습니다"})
                return
            st, body = _assistant_call(
                "DELETE", f"/api/sessions/{urllib.parse.quote(sid)}")
            _json_resp(self, st, body)

        else:
            _json_resp(self, 404, {"error": "Not found"})

    def _route_PATCH(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        if self._blocked(path):
            return

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

        # ── PATCH /api/assistant/sessions/<id>  (제목 변경)
        #
        # 맹비서는 `title` 과 `end_reason` 만 받고 나머지 키는 400 으로
        # 거절한다. 그래서 받은 몸체를 그대로 넘기지 않고 두 키만 고른다 —
        # 화면이 실수로 다른 키를 붙이면 제목 변경 전체가 실패한다.
        #
        # **제목은 유일해야 한다.** 중복이면 맹비서가 400 과 함께 사유를
        # 준다("Title '...' is already in use by session ..."). 그 사유가
        # 화면까지 올라가야 하므로 여기서 삼키지 않는다.
        elif path.startswith("/api/assistant/sessions/"):
            sid = path[len("/api/assistant/sessions/"):]
            if not sid or "/" in sid:
                _json_resp(self, 400, {"error": "세션 ID 가 올바르지 않습니다"})
                return
            body = self._read_body() or {}
            payload = {k: body[k] for k in ("title", "end_reason") if k in body}
            if not payload:
                _json_resp(self, 400,
                           {"error": "바꿀 것이 없습니다 (title 이 필요합니다)"})
                return
            st, out = _assistant_call(
                "PATCH", f"/api/sessions/{urllib.parse.quote(sid)}", payload)
            _json_resp(self, st, out)

        else:
            _json_resp(self, 404, {"error": "Not found"})

    def _route_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path.rstrip("/")
        if self._blocked(path):
            return

        # ── POST /api/auth/login  (접근 열쇠 → 세션 쿠키)
        if path == "/api/auth/login":
            self._login()
            return

        # /api/cycle/start · stop · run_once 는 제거했다 (2026-10-21).
        # 근거 조회·검토·방법 절을 전부 우회하는 경로였다 — 자세한 사유는
        # RAISE_COMPLIANCE.md 의 "운영 사이클을 들어낸 이유" 절.
        # 아래가 POST 사슬의 첫 분기다. elif 로 두면 영원히 안 걸린다.

        # ── POST /api/upload  (대화창 파일 첨부)
        if path == "/api/upload":
            self._upload()
            return

        # ── POST /api/assistant/*  (맹비서 중계 — 쓰기)
        #
        # 메인 채팅이 여기로 온다. 전에는 /api/workflow/run 으로 부서 태스크를
        # 큐에 넣었는데, 그 경로는 근거 조회·검토·방법 절을 전부 우회했다.
        # 맹비서는 자기 세션·히스토리·도구를 갖고 있으므로 대화는 그쪽이 맞다.
        if path == "/api/assistant/sessions":
            body = self._read_body()
            st, out = _assistant_call("POST", "/api/sessions", body or {})
            _json_resp(self, st, out)
            return

        if (path.startswith("/api/assistant/sessions/")
                and path.endswith("/chat")):
            sid = path[len("/api/assistant/sessions/"):-len("/chat")]
            body = self._read_body()
            # 대화는 길다 — 디스코드 실측 27초. 짧게 주면 멀쩡한 답을 끊는다.
            st, out = _assistant_call(
                "POST", f"/api/sessions/{urllib.parse.quote(sid)}/chat",
                body or {}, timeout=ASSISTANT_TIMEOUT_CHAT)
            _json_resp(self, st, out)
            return

        # ── POST /api/business/ideas  (AI 비즈니스 아이디어 생성)
        if path == "/api/business/ideas":
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

        # ── POST /api/trash  {items:[{kind,id}]}  (휴지통으로 — 되돌릴 수 있다)
        #
        # 대시보드의 삭제는 전부 여기로 온다. 옮긴 뒤 맹비서가 디스코드로
        # 알린다 — 사장님이 아닌 누가 지웠으면 그걸로 알아챈다.
        elif path == "/api/trash":
            body = self._read_body()
            items = [i for i in (body.get("items") or []) if isinstance(i, dict)][:500]
            if not items:
                _json_resp(self, 400, {"error": "옮길 것을 골라 주세요"})
                return
            moved, missing = trash.move(items, self._origin())
            _json_resp(self, 200, {"ok": bool(moved), "moved": moved, "missing": missing})

        # ── POST /api/trash/restore  {ids:[…]} 또는 {all:true}
        elif path == "/api/trash/restore":
            body = self._read_body()
            ids = None if body.get("all") is True else [str(x) for x in (body.get("ids") or [])]
            if ids is not None and not ids:
                _json_resp(self, 400, {"error": "되살릴 것을 골라 주세요"})
                return
            done, fails = trash.restore(ids)
            _json_resp(self, 200, {"ok": bool(done), "restored": done, "failed": fails})

        # ── POST /api/trash/purge  (영구 삭제 — 맹비서만)
        #
        # 대시보드는 여기 닿을 수 없다. 두 겹으로 막는다:
        #   1. 이 PC 에서 직접 온 요청만 (터널을 지난 요청은 거절)
        #   2. 이 PC 의 파일에만 있는 열쇠(X-MT-Purge-Token)
        # 접속 키가 새도 브라우저로는 영구 삭제를 못 한다. 영구 삭제는
        # scripts/mt_trash.py 가 하고, 그걸 부르는 것은 맹비서다.
        elif path == "/api/trash/purge":
            if not self._local_direct() or not trash.token_ok(
                    self.headers.get("X-MT-Purge-Token") or ""):
                _json_resp(self, 403, {"error": "영구 삭제는 맹비서를 통해서만 할 수 있습니다 "
                                                "(`/휴지통`)."})
                return
            body = self._read_body()
            ids = None if body.get("all") is True else [str(x) for x in (body.get("ids") or [])]
            if ids is not None and not ids:
                _json_resp(self, 400, {"error": "지울 것을 골라 주세요"})
                return
            code = str(body.get("code") or "").strip()
            if not code:
                # 1단계: 대상을 못 박고 확인 코드를 **디스코드 DM 으로만** 보낸다.
                # 응답에는 코드를 싣지 않는다 — 맹비서도 모르게 하는 것이 요점이다.
                targets, sent = trash.challenge(ids)
                if not targets:
                    _json_resp(self, 404, {"error": "휴지통에 그런 항목이 없습니다"})
                    return
                _json_resp(self, 200, {"ok": False, "challenge": True,
                                       "sent": sent, "targets": targets})
                return
            reps, why = trash.confirm(code, ids)
            if why:
                _json_resp(self, 400, {"error": why})
                return
            _json_resp(self, 200, {"ok": bool(reps), "purged": reps})

        elif path == "/api/projects":
            body = self._read_body()
            idea = str(body.get("idea") or "").strip()
            if not idea:
                _json_resp(self, 400, {"error": "아이디어를 적어 주세요"})
                return
            # 깨진 입력을 여기서 막는다. 통과시키면 계획 수립기가 "못
            # 읽겠다" 고 하는 대신 **조회된 자료로 다른 프로젝트를 지어낸다**
            # — 실제로 그랬고 승인 요청까지 보냈다.
            _why = projects.unreadable(idea)
            if _why:
                _json_resp(self, 400, {"error": _why})
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
            # 착수 전 계획 수정. 승인/거절밖에 못 하던 것을 고칠 수 있게 한다 —
            # VLA 사태는 "없는 자료를 요구하는 완료 조건" 한 줄에서 시작됐고,
            # 52단계를 겪을 때까지 아무도 그 줄을 지울 수 없었다.
            #
            # 검증은 projects.revise_plan() 이 한다. 서버가 따로 규칙을 들면
            # UI 로 고친 계획만 검증을 빠져나가게 된다.
            if action == "plan":
                proj, why = projects.revise_plan(pid, self._read_body())
                if why:
                    _json_resp(self, 400, {"ok": False, "error": why, "project": proj})
                else:
                    _json_resp(self, 200, {"ok": True, "project": proj})
            elif action == "approve":
                _json_resp(self, 200, {"ok": True, "project": project_runner.approve(pid)})
            elif action == "resume":
                # steer 는 방향 전환 지시. 없으면 예전처럼 그냥 이어 간다.
                body = self._read_body() if self.headers.get("Content-Length") else {}
                _json_resp(self, 200, {"ok": True, "project": project_runner.resume(
                    pid, str(body.get("steer") or ""))})
            elif action == "cancel":
                _json_resp(self, 200, {"ok": True, "project": projects.update(
                    pid, {"status": "cancelled", "pause_reason": "사장님이 중단했습니다"})})
            else:
                _json_resp(self, 404, {"error": f"알 수 없는 동작: {action}"})

        # ── POST /api/verify/<pid>/<did>  {verdicts: {id: {verdict, note}}}
        #
        # 누가 언제 판정했는지를 함께 남긴다 — decided_by 와 같은 발상이다.
        # 검증했다는 주장만 있고 누가 했는지가 없으면 사후에 "이건 사람이
        # 본 것인가" 를 물을 수 없다.
        elif path.startswith("/api/verify/"):
            rest = path.split("/api/verify/")[1].split("/")
            if len(rest) != 2:
                _json_resp(self, 404, {"error": "Not found"})
                return
            body = self._read_body()
            try:
                import verify as _verify
                _json_resp(self, 200, _verify.record(
                    rest[0], rest[1], body.get("verdicts") or {},
                    who=str(body.get("who") or "사장님")))
            except Exception as e:  # noqa: BLE001
                _json_resp(self, 500, {"error": str(e)})

        # ── POST /api/consistency/<pid>/<did>  (반복 실행 일관성 시험)
        #
        # 같은 조건으로 한 번 더 쓰게 하고 사실 조각을 견준다. 호출 하나를
        # 쓰므로 사장님이 원할 때만 돈다 — 모든 산출물에 자동으로 돌리면
        # 예산이 두 배가 되고, 그만한 값을 늘 하지는 않는다.
        elif path.startswith("/api/consistency/"):
            rest = path.split("/api/consistency/")[1].split("/")
            if len(rest) != 2:
                _json_resp(self, 404, {"error": "Not found"})
                return
            try:
                import consistency
                _json_resp(self, 200, consistency.run(rest[0], rest[1]))
            except Exception as e:  # noqa: BLE001
                _json_resp(self, 500, {"error": str(e)})

        # ── POST /api/approvals/batch  {ids: [...]}  (2등급까지 일괄 승인)
        #
        # 3등급(바깥으로 나가는 것)은 ids 에 들어와도 거부한다. 화면이 안 보낸다는
        # 것을 믿지 않는다 — 이 끝점은 Tailscale 로 바깥에서도 열리고, 되돌릴 수
        # 없는 행위를 막는 판단은 서버에 있어야 한다.
        elif path == "/api/approvals/batch":
            body = self._read_body()
            ids = [str(x) for x in (body.get("ids") or [])][:50]

            # 사람이 건수를 직접 적어 보내야 한다.
            #
            # 전에는 화면의 `window.confirm` 하나가 유일한 방어막이었다.
            # 그런데 자동화로 띄운 브라우저에서 `confirm` 은 기본으로 true 를
            # 돌려준다 — **사람이 읽고 누르는 것을 전제한 방어가 사람이 없을 때
            # 그냥 통과한다.** 실제로 결재 9건이 그렇게 넘어갔고, 거기에 섞인
            # 프로젝트 착수 결재까지 함께 승인돼 자율 실행이 시작됐다.
            #
            # 숫자를 맞춰 넣는 일은 우연히 일어나지 않는다. 한 건씩 누르는
            # 길은 그대로 두므로 승인 피로를 다시 만들지도 않는다.
            if int(body.get("confirm_count") or -1) != len(ids):
                _json_resp(self, 400, {
                    "ok": False,
                    "error": (f"건수 확인이 맞지 않습니다. {len(ids)}건을 승인하려면 "
                              f"confirm_count 에 {len(ids)} 를 보내세요."),
                    "approved": [], "skipped": [],
                })
                return
            rows = {r["id"]: r for r in workspace_store.load("approvals")}
            done, skipped = [], []
            for i in ids:
                row = rows.get(i)
                # status 가 없는 행은 대기로 본다. 화면이 그렇게 읽기
                # 때문이다(`r.status ?? 'pending'`). 여기서만 다르게 보면
                # 목록에는 대기로 떠 있는데 일괄 승인은 조용히 건너뛴다.
                if row is None or (row.get("status") or "pending") != "pending":
                    skipped.append({"id": i, "why": "대기 중이 아닙니다"})
                    continue
                t = approval_tiers.tier(row)
                if t > approval_tiers.BATCHABLE_MAX:
                    skipped.append({"id": i, "why": "바깥으로 나가는 안건은 "
                                                    "하나씩만 승인할 수 있습니다",
                                    "tier": t, "label": row.get("label", "")})
                    continue
                updated = workspace_store.update("approvals", i, {
                    "status": "approved",
                    "decided_by": "batch",
                    "decided_at": time.time(),
                })
                if updated is None:
                    skipped.append({"id": i, "why": "행을 찾지 못했습니다"})
                    continue
                done.append({"id": i, "label": row.get("label", ""), "tier": t,
                             "followup": _approval_followup(updated)})
            _json_resp(self, 200, {"ok": True, "approved": done, "skipped": skipped})

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

        # ── POST /api/calendar/oauth/start  → 구글 로그인 주소
        elif path == "/api/calendar/oauth/start":
            client_id = _env_get("YOUTUBE_OAUTH_CLIENT_ID")
            if not client_id or not _env_get("YOUTUBE_OAUTH_CLIENT_SECRET"):
                _json_resp(self, 400, {
                    "ok": False,
                    "error": "구글 OAuth Client ID/Secret 을 먼저 저장하세요 "
                             "(유튜브 칸에 넣은 것과 같은 것을 씁니다).",
                })
                return
            _cal_oauth.update({"state": uuid.uuid4().hex, "code": "", "error": "",
                               "started_at": time.time()})
            # 같은 포트·같은 리다이렉트. 수신기에 캘린더 상태함을 넘긴다.
            threading.Thread(target=_yt_catch_code,
                             kwargs={"box": _cal_oauth}, daemon=True).start()
            auth_url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
                "client_id": client_id,
                "redirect_uri": YT_REDIRECT_URI,
                "response_type": "code",
                "scope": CAL_SCOPE,
                "access_type": "offline",
                "prompt": "consent",          # refresh_token 을 확실히 받으려면 필요
                "state": _cal_oauth["state"],
            })
            _json_resp(self, 200, {"ok": True, "auth_url": auth_url,
                                   "redirect_uri": YT_REDIRECT_URI})

        # ── POST /api/calendar/oauth/finish
        elif path == "/api/calendar/oauth/finish":
            if _cal_oauth["error"]:
                _json_resp(self, 400, {"ok": False, "error": _cal_oauth["error"]})
                return
            if not _cal_oauth["code"]:
                _json_resp(self, 202, {"ok": False, "pending": True,
                                       "error": "아직 구글에서 돌아오지 않았습니다."})
                return
            try:
                tok = _yt_exchange(_cal_oauth["code"],
                                   _env_get("YOUTUBE_OAUTH_CLIENT_ID"),
                                   _env_get("YOUTUBE_OAUTH_CLIENT_SECRET"))
            except Exception as e:  # noqa: BLE001
                _json_resp(self, 400, {"ok": False, "error": f"토큰 교환 실패: {e}"})
                return
            refresh = tok.get("refresh_token")
            if not refresh:
                _json_resp(self, 400, {
                    "ok": False,
                    "error": "refresh_token 이 오지 않았습니다. 구글 계정의 앱 권한을 "
                             "지우고 다시 시도하세요.",
                })
                return
            _env_set("GOOGLE_CALENDAR_REFRESH_TOKEN", refresh)
            _cal_oauth.update({"state": "", "code": "", "error": ""})
            _json_resp(self, 200, {"ok": True, "connected": True})

        # ── POST /api/youtube/oauth/start  → 구글 로그인 주소를 돌려준다
        elif path == "/api/youtube/oauth/start":
            client_id = _env_get("YOUTUBE_OAUTH_CLIENT_ID")
            if not client_id or not _env_get("YOUTUBE_OAUTH_CLIENT_SECRET"):
                _json_resp(self, 400, {
                    "ok": False,
                    "error": "Client ID/Secret 을 먼저 저장하세요.",
                })
                return
            # urllib 은 최상위에서 임포트한다. 여기 지역 임포트를 두면 `urllib` 이
            # 함수 전체의 지역 이름이 되어, 그 앞에서 쓰는 곳이 UnboundLocalError 로 죽는다(겪었다).
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
            # 빈칸은 "바꾸지 않음" 이다. 예전에는 빈칸으로 저장을 누르면 그 키의
            # 기존 값이 지워졌다 — 입력칸이 늘 빈칸으로 열리니, 한 칸만 고치려고
            # 저장을 누르면 나머지 칸의 값이 사라졌다.
            given = {k: str(v).strip() for k, v in body.items() if str(v or "").strip()}
            if not given:
                _json_resp(self, 400, {"ok": False, "error": "입력한 값이 없습니다 — 바꿀 칸만 채우고 저장하세요."})
                return
            problems = [f"{k}: {msg}" for k, v in given.items()
                        if (msg := _check_credential(k, v))]
            vals = list(given.values())
            if len(set(vals)) != len(vals):
                problems.append("같은 값이 두 칸에 들어갔습니다 — 각 칸에 맞는 값을 넣으세요.")
            if problems:
                _json_resp(self, 400, {"ok": False, "error": " / ".join(problems)})
                return
            lines: list[str] = []
            if ENV_FILE.exists():
                for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
                    if line.split("=")[0].strip() not in given:
                        lines.append(line)
            for k, v in given.items():
                lines.append(f'{k}="{v}"')
            ENV_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")
            _json_resp(self, 200, {"ok": True, "saved": list(given.keys())})

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
