#!/usr/bin/env python3
"""Agent Dispatcher — 태스크 큐의 pending 작업을 부서 에이전트가 수행한다.

큐에서 작업을 집어 → 지식베이스에서 근거를 찾아 → 부서 두뇌(LLM)로 수행 →
결과를 큐와 공유메모리에 기록한다.

세 가지가 이전과 다르다.

1) **백엔드 우선순위: 라우터 → Ollama → OpenRouter**
   FreeLLMAPI 라우터(맹비서와 공유)를 1순위로 둔다. 무료 프로바이더 체인·
   자동 폴백·사용량 장부를 그대로 물려받는다. 라우터가 없으면 로컬 Ollama 로
   내려가므로, 라우터를 안 띄운 환경에서도 그대로 동작한다.

2) **지식베이스 근거 주입**
   부서가 자기 기억만으로 답하면 위키를 가진 의미가 없다. 지시문으로 GraphRAG 를
   검색해 근거를 프롬프트에 넣고, 출처 경로를 함께 준다 — 경로를 지어내지 않게 하려는 것.

3) **단계별 이벤트 발행**
   예전에는 완료 시점에 한 번만 이벤트를 냈다. 그래서 2D 사무실과 실시간 피드가
   늘 비어 있었다(씬은 이미 SSE 에 연결돼 있는데 보낼 것이 없었다). 이제 접수·조회·
   추론·완료 각 단계를 흘려보내 진행 상황이 화면에서 움직인다.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

# Windows 콘솔 기본 코드페이지(cp949)는 한국어 일부와 em-dash 를 못 찍는다.
# 데몬을 cmd 창에서 띄우면 첫 print 에서 UnicodeEncodeError 로 죽었다(실제로 겪었다).
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

BASE_DIR = Path(__file__).resolve().parent
MYUNG_TECH_WORKSPACE = (BASE_DIR / "..").resolve()

sys.path.insert(0, str(MYUNG_TECH_WORKSPACE / "shared_memory"))
sys.path.insert(0, str(MYUNG_TECH_WORKSPACE))
import task_queue
import message_broker

try:
    import knowledge_base as kb
except Exception:  # 지식베이스가 없어도 디스패처는 돌아야 한다
    kb = None

# ── 백엔드 설정 ──────────────────────────────────────────────────────────────
# 라우터는 맹비서(hermes)와 공유하는 FreeLLMAPI 인스턴스다. 통합 키는 라우터가
# 최초 기동 때 로그에 남기므로 거기서 줍는다. 환경변수가 있으면 그쪽이 우선.
ROUTER_BASE_URL = os.environ.get("MYUNGTECH_ROUTER_URL", "http://127.0.0.1:3001/v1")
ROUTER_MODEL = os.environ.get("MYUNGTECH_ROUTER_MODEL", "auto:hermes")
_ROUTER_KEY_FILES = [
    Path(r"D:\AI_Workspace\freellmapi\server\data\first-run.log"),
    Path(r"D:\AI_Workspace\freellmapi\freellmapi.log"),
]

_ollama_raw = os.environ.get("OLLAMA_BASE_URL") or os.environ.get("OLLAMA_HOST", "http://localhost:11434")
if _ollama_raw and not _ollama_raw.startswith("http"):
    OLLAMA_BASE_URL = "http://localhost:11434"
else:
    OLLAMA_BASE_URL = _ollama_raw or "http://localhost:11434"

OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions"
OPENROUTER_API_KEY = os.environ.get("OPENROUTER_API_KEY", "")

OLLAMA_DEFAULT_MODEL = "qwen2.5:7b"
OLLAMA_MODEL_MAP = {
    "orchestration_dept": "qwen2.5:7b",
    "research_dept":      "qwen2.5:7b",
    "finance_dept":       "qwen2.5:7b",
    "dev_dept":           "qwen2.5:7b",
    "content_dept":       "qwen2.5:7b",
}

# 부서별 두뇌 등급. 완전무료를 유지하면서 성능을 확보하는 배분이다.
#   cloud — 조사·종합·기획처럼 문맥이 길고 판단이 필요한 일 → 라우터 무료 체인
#   local — 분류·요약·라우팅처럼 짧고 반복적인 일 → 로컬(무제한, 쿼터를 아낀다)
# 클라우드 무료 한도가 하루치로 정해져 있어, 전 부서를 클라우드로 두면 금방 소진된다.
DEPT_TIER = {
    "research_dept":      "cloud",
    "dev_dept":           "cloud",
    "content_dept":       "cloud",
    "finance_dept":       "cloud",
    "orchestration_dept": "local",
}

KB_HOPS = 1
KB_LIMIT = 5
KB_BUDGET_CHARS = 8000

POLL_INTERVAL = 3.0
REQUEST_TIMEOUT = 300


def _router_key() -> str:
    env = (os.environ.get("FREELLMAPI_KEY") or "").strip()
    if env:
        return env
    for p in _ROUTER_KEY_FILES:
        try:
            m = re.search(r"freellmapi-[0-9a-f]{32,}", p.read_text(encoding="utf-8"))
            if m:
                return m.group(0)
        except OSError:
            continue
    return ""


def _router_alive() -> bool:
    try:
        req = urllib.request.Request(ROUTER_BASE_URL.rsplit("/v1", 1)[0] + "/")
        with urllib.request.urlopen(req, timeout=3) as r:
            return r.status == 200
    except Exception:
        return False


def choose_backend(dept_id: str) -> tuple[str, str]:
    """(backend, model) 을 고른다. 라우터가 없으면 조용히 로컬로 내려간다."""
    tier = DEPT_TIER.get(dept_id, "cloud")
    if tier == "cloud" and _router_key() and _router_alive():
        return "router", ROUTER_MODEL
    if OPENROUTER_API_KEY and tier == "cloud":
        manifest = _load_dept_manifest(dept_id)
        return "openrouter", manifest.get("assigned_brain", "qwen/qwen-2.5-7b-instruct:free")
    return "ollama", OLLAMA_MODEL_MAP.get(dept_id, OLLAMA_DEFAULT_MODEL)


def _load_dept_manifest(dept_id: str) -> dict:
    path = MYUNG_TECH_WORKSPACE / "departments" / dept_id / "department_manifest.json"
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


# ── LLM 호출 ────────────────────────────────────────────────────────────────
def _post_chat(url: str, body: dict, headers: dict, label: str) -> str:
    req = urllib.request.Request(
        url, data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", **headers}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        content = (data.get("choices") or [{}])[0].get("message", {}).get("content")
        if not content:
            # 사고형 모델이 추론 토큰만 쓰고 본문을 못 낸 경우가 실제로 있다.
            raise RuntimeError(f"{label}: 빈 응답 (모델이 본문을 내지 않음)")
        return content
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:300]
        raise RuntimeError(f"{label} HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise RuntimeError(f"{label} 연결 실패: {exc.reason}") from exc


def call_llm(backend: str, model: str, messages: list[dict]) -> str:
    if backend == "router":
        return _post_chat(f"{ROUTER_BASE_URL}/chat/completions",
                          {"model": model, "messages": messages, "stream": False},
                          {"Authorization": f"Bearer {_router_key()}"},
                          f"라우터({model})")
    if backend == "openrouter":
        return _post_chat(OPENROUTER_CHAT_URL,
                          {"model": model, "messages": messages},
                          {"Authorization": f"Bearer {OPENROUTER_API_KEY}",
                           "HTTP-Referer": "https://myung-tech.internal",
                           "X-Title": "Myung-Tech Orchestration"},
                          f"OpenRouter({model})")
    return _post_chat(f"{OLLAMA_BASE_URL}/v1/chat/completions",
                      {"model": model, "messages": messages, "stream": False},
                      {}, f"Ollama({model})")


# ── 이벤트 ──────────────────────────────────────────────────────────────────
def emit(sender: str, target: str, payload: str) -> None:
    """이벤트 발행은 실패해도 작업을 막지 않는다 — 어디까지나 관측용이다."""
    try:
        message_broker.publish_event(sender=sender, target=target, payload=payload)
    except Exception as exc:
        print(f"[dispatcher] 이벤트 발행 실패(무시): {exc}", file=sys.stderr)


# ── 지식베이스 ──────────────────────────────────────────────────────────────
def kb_context(instruction: str) -> tuple[str, list[str]]:
    """(프롬프트에 넣을 근거 블록, 출처 경로 목록). 실패하면 빈 값으로 넘어간다."""
    if kb is None or not getattr(kb, "available", lambda: False)():
        return "", []
    try:
        docs = kb.retrieve(instruction, hops=KB_HOPS, limit=KB_LIMIT,
                           include_body=False)
        paths = [d["path"] for d in docs if d.get("path")]
        block = kb.build_context(instruction, hops=KB_HOPS, limit=KB_LIMIT,
                                 budget_chars=KB_BUDGET_CHARS)
        return block, paths
    except Exception as exc:
        print(f"[dispatcher] 지식베이스 조회 실패(무시): {exc}", file=sys.stderr)
        return "", []


def _system_prompt(dept_name: str, has_kb: bool) -> str:
    base = (f"당신은 명테크의 {dept_name} 소속 AI 에이전트입니다. "
            "주어진 지시를 한국어로 간결하고 구조적으로 수행하세요.")
    if has_kb:
        base += (
            "\n\n아래 '지식베이스 검색 결과'는 우리 조직의 위키에서 가져온 실제 문서입니다. "
            "답변에 활용할 때는 반드시 주어진 출처 경로를 그대로 인용하세요. "
            "**검색 결과에 없는 내용을 사실처럼 서술하거나 경로를 지어내지 마세요.** "
            "근거가 부족하면 '위키에 근거 없음'이라고 명시하고 추론임을 밝히세요.")
    return base


# ── 작업 수행 ───────────────────────────────────────────────────────────────
def _dispatch_task(task: dict) -> None:
    task_id = task["task_id"]
    dept_id = task["target_dept"]
    requester = task.get("sender", "ceo")

    manifest = _load_dept_manifest(dept_id)
    dept_name = manifest.get("department_name", dept_id)
    backend, model = choose_backend(dept_id)

    task_queue.update_status(task_id, "in_progress")
    emit(dept_id, requester, f"작업 접수 — {task['instruction'][:80]}")
    print(f"[dispatcher] {task_id} → {dept_name} ({model}) via {backend}")

    started = time.time()
    try:
        block, paths = kb_context(task["instruction"])
        if paths:
            emit(dept_id, "knowledge_base",
                 f"지식베이스 조회 — {len(paths)}건 참조: " + ", ".join(paths[:3]))

        messages = [{"role": "system", "content": _system_prompt(dept_name, bool(block))}]
        if block:
            messages.append({"role": "system", "content": block})
        messages.append({"role": "user", "content": task["instruction"]})

        emit(dept_id, requester, f"추론 시작 — {model} ({backend})")
        result = call_llm(backend, model, messages)

        elapsed = time.time() - started
        footer = ""
        if paths:
            footer = "\n\n---\n참조: " + ", ".join(f"`{p}`" for p in paths[:5])
        task_queue.update_status(task_id, "done", result=result + footer)

        emit(dept_id, requester,
             f"완료 ({elapsed:.1f}s) — {result[:220]}{'…' if len(result) > 220 else ''}")
        print(f"[dispatcher] {task_id} done ({elapsed:.1f}s).")
    except Exception as exc:
        # 실패 사유를 사람이 읽을 수 있게 남긴다. UI 가 이 문자열을 그대로 보여준다.
        reason = f"[{backend}/{model}] {exc}"
        task_queue.update_status(task_id, "failed", result=reason)
        emit(dept_id, requester, f"실패 — {reason[:220]}")
        print(f"[dispatcher] {task_id} FAILED: {reason}", file=sys.stderr)


def run_once(api_key: str = "") -> int:
    pending = task_queue.list_tasks("pending")
    pending.sort(key=lambda t: t.get("priority", 5), reverse=True)
    for task in pending:
        _dispatch_task(task)
    return len(pending)


def run_daemon(api_key: str = "") -> None:
    backend_note = "라우터" if (_router_key() and _router_alive()) else "로컬 Ollama"
    print(f"[dispatcher] 데몬 시작 — 기본 백엔드: {backend_note}")
    emit("orchestration_dept", "system", f"디스패처 데몬 시작 ({backend_note})")
    while True:
        try:
            n = run_once()
        except Exception as exc:      # 한 번의 실패로 데몬이 죽으면 안 된다
            print(f"[dispatcher] 루프 오류(계속 진행): {exc}", file=sys.stderr)
            n = 0
        if n == 0:
            time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    # 예전에는 OPENROUTER_API_KEY 가 없으면 여기서 종료했다. 이제 라우터·Ollama
    # 만으로도 완결되므로 그 조건은 없앤다.
    mode = sys.argv[1] if len(sys.argv) > 1 else "once"
    if mode == "daemon":
        run_daemon()
    else:
        print(f"[dispatcher] {run_once()} task(s) processed.")
