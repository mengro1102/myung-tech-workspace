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
import shutil
import subprocess
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
import workspace_store

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

# 로컬 모델은 세 군데에서 정해졌다 — 여기 하드코딩, UI 의 '공통 두뇌', 그리고
# 에이전트 파일의 preferred_model. 그런데 앞의 둘은 서로 몰랐고 UI 쪽은 React
# state 에만 있어 새로고침하면 사라졌다. 고를 수는 있는데 추론에는 아무 영향이
# 없는 장식이었다.
#
# 이제 출처는 하나다: server.py 와 공유하는 runtime_config.json.
# 우선순위는 부서 소속 에이전트의 preferred_model → 공통 두뇌 → 기본값.
# 매번 파일을 읽는다. 데몬을 재시작하지 않아도 UI 에서 바꾼 값이 바로 먹는다.
FALLBACK_LOCAL_MODEL = "qwen2.5:7b"
RUNTIME_CONFIG = MYUNG_TECH_WORKSPACE / "runtime_config.json"


def global_model() -> str:
    """UI '공통 두뇌'로 고른 모델."""
    try:
        cfg = json.loads(RUNTIME_CONFIG.read_text(encoding="utf-8"))
        return (cfg.get("global_model") or "").strip() or FALLBACK_LOCAL_MODEL
    except Exception:
        return FALLBACK_LOCAL_MODEL


def dept_local_model(dept_id: str) -> str:
    """부서에 쓸 로컬 모델.

    태스크는 에이전트가 아니라 부서로 들어온다. 그래서 에이전트 개인에게
    모델을 붙일 자리가 없다 — 부서 안에 전용 두뇌를 지정해 둔 에이전트가
    있으면 그 부서 전체가 그 모델을 쓰는 것으로 해석한다. 파일 이름 순으로
    처음 발견한 것을 쓴다(같은 입력이면 같은 결과가 나오도록).
    """
    agents_dir = MYUNG_TECH_WORKSPACE / "departments" / dept_id / "agents"
    try:
        for f in sorted(agents_dir.glob("*.json")):
            data = json.loads(f.read_text(encoding="utf-8-sig"))
            picked = (data.get("preferred_model") or "").strip()
            if picked:
                return picked
    except Exception:
        pass
    return global_model()

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


# 로컬 백엔드는 "언제나 있다"는 전제로 마지막 폴백에 놓여 있다. 그런데 실제로는
# Ollama 가 꺼져 있으면 그 폴백이 없는 것과 같다 — 2026-06-29 의 실패 기록이
# 전부 이 경우였다(Connection refused). 그래서 부르기 전에 살아 있는지 보고,
# 죽어 있으면 직접 띄운다.
_OLLAMA_EXE_HINTS = [
    Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe",
    Path(r"C:\Program Files\Ollama\ollama.exe"),
]
_ollama_start_attempted = False


def _ollama_alive(timeout: float = 3.0) -> bool:
    try:
        with urllib.request.urlopen(f"{OLLAMA_BASE_URL}/api/tags", timeout=timeout) as r:
            return r.status == 200
    except Exception:
        return False


def _ollama_exe() -> str | None:
    found = shutil.which("ollama")
    if found:
        return found
    for p in _OLLAMA_EXE_HINTS:
        if p.is_file():
            return str(p)
    return None


def ensure_ollama(wait: float = 25.0) -> bool:
    """Ollama 가 응답할 때까지 보장한다. 기동 시도는 프로세스당 한 번만 한다."""
    global _ollama_start_attempted
    if _ollama_alive():
        return True
    if _ollama_start_attempted:
        return _ollama_alive()
    _ollama_start_attempted = True

    exe = _ollama_exe()
    if not exe:
        print("[dispatcher] Ollama 실행 파일을 찾지 못했습니다.", file=sys.stderr)
        return False
    print(f"[dispatcher] Ollama 가 응답하지 않아 기동합니다: {exe}", file=sys.stderr)
    try:
        # DETACHED_PROCESS. CREATE_NO_WINDOW 와 같이 주면 CreateProcess 가 실패한다.
        flags = 0x00000008 if sys.platform == "win32" else 0
        subprocess.Popen([exe, "serve"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=flags)
    except Exception as exc:
        print(f"[dispatcher] Ollama 기동 실패: {exc}", file=sys.stderr)
        return False

    deadline = time.time() + wait
    while time.time() < deadline:
        if _ollama_alive(timeout=2.0):
            print("[dispatcher] Ollama 준비됨.", file=sys.stderr)
            return True
        time.sleep(1.0)
    print(f"[dispatcher] Ollama 가 {wait:.0f}초 안에 뜨지 않았습니다.", file=sys.stderr)
    return False


def choose_backend(dept_id: str) -> tuple[str, str]:
    """(backend, model) 을 고른다. 라우터가 없으면 조용히 로컬로 내려간다."""
    tier = DEPT_TIER.get(dept_id, "cloud")
    if tier == "cloud" and _router_key() and _router_alive():
        return "router", ROUTER_MODEL
    if OPENROUTER_API_KEY and tier == "cloud":
        manifest = _load_dept_manifest(dept_id)
        return "openrouter", manifest.get("assigned_brain", "qwen/qwen-2.5-7b-instruct:free")
    return "ollama", dept_local_model(dept_id)


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
    # 로컬은 마지막 보루다. 꺼져 있으면 띄우고, 그래도 안 되면 한 번만 다시 시도한다.
    if not ensure_ollama():
        raise RuntimeError(
            f"Ollama({model}) 연결 실패: {OLLAMA_BASE_URL} 이 응답하지 않고 자동 기동도 "
            "되지 않았습니다. `ollama serve` 를 실행한 뒤 다시 시도하세요.")
    try:
        return _post_chat(f"{OLLAMA_BASE_URL}/v1/chat/completions",
                          {"model": model, "messages": messages, "stream": False},
                          {}, f"Ollama({model})")
    except RuntimeError as exc:
        if "연결 실패" not in str(exc):
            raise
        time.sleep(2.0)
        return _post_chat(f"{OLLAMA_BASE_URL}/v1/chat/completions",
                          {"model": model, "messages": messages, "stream": False},
                          {}, f"Ollama({model}, 재시도)")


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


# 에이전트가 화면에 무언가를 남기는 방법.
#
# 키워드로 결과 문장을 훑어 "결제 같아 보이면 결재를 올린다" 식으로 하려다
# 말았다. 산문을 추측하는 방식은 조용히 틀리고, 틀린 것을 알아채기 어렵다.
# 대신 출력 약속을 준다 — 줄 맨 앞에 표시를 달면 그 줄만 꺼내 쓴다.
TODO_MARK = "[할일]"
APPROVAL_MARK = "[결재요청]"


def dept_roster(dept_id: str, budget: int = 900) -> str:
    """부서에 속한 에이전트들의 역할과 지침.

    departments/<dept>/agents/*.json 에는 persona 와 base_prompt 가 잘 적혀
    있는데 아무도 읽지 않았다. 박코드 사원에게는 "항상 실행 가능한 완전한
    코드만, 코드 블록으로 감싸서 제출" 이라는 지침이 있었지만 프롬프트에
    들어간 적이 없다 — 팀 모달에서 페르소나를 고쳐도 아무 일도 일어나지
    않았다는 뜻이다. preferred_model 과 같은 종류의 방치였다.
    """
    agents_dir = MYUNG_TECH_WORKSPACE / "departments" / dept_id / "agents"
    blocks: list[str] = []
    try:
        for f in sorted(agents_dir.glob("*.json")):
            a = json.loads(f.read_text(encoding="utf-8-sig"))
            name = (a.get("character_name") or "").strip()
            role = (a.get("role") or "").strip()
            if not name:
                continue
            head = f"- {name}" + (f" ({role})" if role else "")
            for key in ("persona", "base_prompt"):
                v = " ".join(str(a.get(key) or "").split())
                if v:
                    head += f"\n    {v[:260]}"
            blocks.append(head)
    except Exception:
        return ""
    if not blocks:
        return ""
    out = "\n".join(blocks)
    return out[:budget]


def _system_prompt(dept_name: str, has_kb: bool, dept_id: str = "") -> str:
    base = (f"당신은 명테크의 {dept_name} 소속 AI 에이전트입니다. "
            "주어진 지시를 한국어로 간결하고 구조적으로 수행하세요.")

    # 할 수 있는 일의 경계를 먼저 못 박는다.
    #
    # "workspace 에 hello_agent.py 를 실제로 만들어라" 라고 시켰더니 "파일을
    # 생성했습니다" 라고 답했다. 파일은 어디에도 없었고 태스크는 done 으로
    # 기록됐다. 만들지 않은 것보다 만들었다고 보고하는 쪽이 나쁘다 — 화면의
    # '완료'를 믿을 수 없게 되기 때문이다.
    #
    # 구조상 이 에이전트는 LLM 호출 한 번이 전부다. 그 사실을 모델에게 알려
    # 준다.
    base += (
        "\n\n[할 수 있는 일의 경계]\n"
        "당신은 글만 씁니다. 파일을 만들거나 고칠 수 없고, 명령·스크립트를 실행할 수 없으며, "
        "git·웹·외부 API 를 호출할 수 없습니다. 당신의 답변은 텍스트로 저장될 뿐입니다.\n"
        "- 코드나 설정, 문서를 요청받으면 **본문에 코드 블록으로 전부 적으세요.** "
        "사람이 그대로 가져다 씁니다.\n"
        "- '생성했습니다', '실행했습니다', '커밋했습니다' 처럼 **하지 않은 일을 했다고 쓰지 마세요.** "
        "대신 '아래 내용으로 만드시면 됩니다' 처럼 적으세요.\n"
        "- 파일 경로를 적을 때는 '이 경로에 저장하십시오' 라고 제안으로 쓰세요."
    )

    roster = dept_roster(dept_id) if dept_id else ""
    if roster:
        base += ("\n\n[이 부서의 구성원과 각자의 원칙]\n" + roster +
                 "\n이 원칙들을 답변에 반영하세요.")

    services = workspace_store.services_brief()
    if services:
        base += ("\n\n" + services +
                 "\n답변이 이 서비스들과 관련될 때는 이름을 그대로 쓰세요.")

    base += (
        f"\n\n답변 맨 아래에, 필요할 때만 다음 줄을 덧붙일 수 있습니다.\n"
        f"- 후속으로 사람이 처리해야 할 일이 생기면: `{TODO_MARK} 할 일 한 줄`\n"
        f"- 돈을 쓰거나, 외부에 공개하거나, 되돌리기 어려운 일을 하려면 먼저: "
        f"`{APPROVAL_MARK} 무엇을 왜 하려는지 한 줄`\n"
        "각각 한 줄씩, 필요 없으면 쓰지 마세요. 이 줄들은 사장님 화면의 "
        "태스크 보드와 승인 큐에 그대로 올라갑니다.")
    if has_kb:
        base += (
            "\n\n아래 '지식베이스 검색 결과'는 우리 조직의 위키에서 가져온 실제 문서입니다. "
            "답변에 활용할 때는 반드시 주어진 출처 경로를 그대로 인용하세요. "
            "**검색 결과에 없는 내용을 사실처럼 서술하거나 경로를 지어내지 마세요.** "
            "근거가 부족하면 '위키에 근거 없음'이라고 명시하고 추론임을 밝히세요.")
    return base


def _harvest_marks(result: str) -> list[tuple[str, str]]:
    """결과에서 [할일]·[결재요청] 줄을 꺼낸다. (종류, 내용) 목록.

    모델이 표시를 굵게(**[할일]**) 쓰거나 목록 기호를 붙이는 일이 흔해서
    앞쪽 장식은 걷어내고 본다. 한 종류당 세 줄까지만 받는다 — 모델이
    폭주해도 화면이 잠기지 않게.
    """
    found: list[tuple[str, str]] = []
    counts = {"todo": 0, "approval": 0}
    for raw_line in result.splitlines():
        line = raw_line.strip().lstrip("-*•> ").replace("**", "").strip()
        for mark, kind in ((TODO_MARK, "todo"), (APPROVAL_MARK, "approval")):
            if not line.startswith(mark):
                continue
            text = line[len(mark):].strip(" :：-—").strip()
            if text and counts[kind] < 3:
                counts[kind] += 1
                found.append((kind, text[:200]))
            break
    return found


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

        messages = [{"role": "system", "content": _system_prompt(dept_name, bool(block), dept_id)}]
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

        for kind, text in _harvest_marks(result):
            try:
                if kind == "todo":
                    workspace_store.add_task(text, source=dept_id, department=dept_id)
                    emit(dept_id, "studio_ui", f"할 일 등록 — {text[:120]}")
                else:
                    workspace_store.request_approval(text, department=dept_id,
                                                     detail=task["instruction"][:300])
                    emit(dept_id, "studio_ui", f"결재 요청 — {text[:120]}")
            except Exception as exc:  # noqa: BLE001
                print(f"[dispatcher] 저장소 기록 실패(무시): {exc}", file=sys.stderr)

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
