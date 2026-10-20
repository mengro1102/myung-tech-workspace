#!/usr/bin/env python3
"""자율 프로젝트를 한 스텝씩 굴린다.

디스패처는 태스크 하나에 LLM 호출 하나다. 그래서 "파일을 만들어라" 라고
시키면 만들었다고 답만 하고 끝났다. 프로젝트는 그 위에 얹는 층이다 —
여러 번의 호출을 상태로 이어 붙여서, 초안을 쓰고, 부서가 1차로 보고,
오케스트레이터가 2차로 보고, 통과할 때까지 고친다.

    intake → planning → awaiting_approval → running → done
                              │                │
                              │                └─► paused (진전 없음)
                              └────────────────────► cancelled

착수 승인은 **한 번뿐**이다. 그 뒤로는 결과가 나올 때까지 사람을 부르지
않는다 — 다만 진전이 멈추면 스스로 멈추고 텔레그램으로 알린다.
정지 기준은 shared_memory/projects.py 의 모듈 설명에 있다.

한 번 호출하면 **정확히 한 스텝**만 나아간다. 그래야 서버가 부르든
데몬이 부르든 같은 의미가 되고, 중간에 죽어도 파일에 남은 데까지는
잃지 않는다.

    python bridge/project_runner.py step <prj-id>   # 한 스텝
    python bridge/project_runner.py run  <prj-id>   # 멈출 때까지
    python bridge/project_runner.py daemon          # running 인 것 전부
"""
from __future__ import annotations

import json
import os      # 로컬 대체 모델 이름을 환경변수로 덮어쓸 수 있게 한다
import re
import sys
import time
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
MYUNG_TECH = BASE_DIR.parent
for _p in (str(MYUNG_TECH), str(MYUNG_TECH / "shared_memory")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

import agent_dispatcher as dispatcher          # noqa: E402
from shared_memory import (experience, lessons, notify, projects,  # noqa: E402
                           secrets_guard, workspace_store)

# 데이터 모듈의 것을 그대로 쓴다. 계획을 화면에서 고칠 수 있게 되면서
# 서버도 같은 검증을 해야 했고, 목록이 두 벌이면 한쪽만 빠져나간다.
ORCHESTRATOR = projects.ORCHESTRATOR
KNOWN_DEPTS = projects.KNOWN_DEPTS

PASS_SCORE = 80          # 리뷰어가 이 점수 이상을 줘야 통과
# 프로바이더 기본값(대개 4096 토큰)으로는 한국어 7~8천 자에서 잘린다.
# 실측으로 확인한 값이다 — 실제로 쓴 만큼만 세므로 넉넉히 잡아 손해가 없다.
# 산출물은 계획이 5,000자로 묶어 둔다. 한국어 5,000자는 2,500~3,500토큰이므로
# 6,000 이면 넉넉하다. 전에는 12,000 이었는데, 그 숫자는 "잘림" 을 막으려고
# 키운 것이었다 — 그런데 잘림의 진짜 원인은 종료 사유 오판이었고(finish_reason
# 으로 고침), 과한 max_tokens 는 요청 총량을 키워 라우터가 "prompt too large"
# 로 거절하게 만들었다.
DRAFT_MAX_TOKENS = 6000

# user 프롬프트 총량 상한.
#
# 조각마다 따로 줄이는 것으로는 같은 벽에 또 부딪힌다 — 산출물이 늘면 인계분이
# 다시 자란다. 실측: 근거 12,000 + 직전 초안 4,000 + 지적 + 인계 4,500 이
# 쌓여 20,870자가 됐고, 라우터의 마지막 남은 경로가 크기를 이유로 거절했다.
USER_PROMPT_CHARS = 16000

# 프롬프트에 넣을 근거 자료 분량.
#
# 7,000자였는데 _sources 가 13,404자를 모아 왔다 — 조회한 논문 12편 중 절반이
# 프롬프트에 닿지 못했고, 그러면서 화면에는 "research, 위키 5건" 이라고 적혔다.
# 조회해 놓고 버리는 것은 화면이 거짓말을 하게 만든다.
#
# 초안과 검토가 같은 값을 쓴다. 다르게 자르면 검토자가 못 본 근거로 쓴
# 글이 생긴다.
GROUNDING_CHARS = 8000
POLL_INTERVAL = 5.0

# 라우터가 할당량을 다 썼을 때 돌려주는 말들. 정확한 문구는 프로바이더마다
# 다르므로 넓게 잡는다 — 놓치면 약한 모델로 계속 돌게 된다.
_QUOTA_HINTS = ("429", "quota", "rate limit", "rate_limit",
                "resource_exhausted", "insufficient", "exceeded")

# 위 목록은 **분당 제한**과 **일일 고갈**을 구분하지 못한다. 프로바이더마다
# 문구가 달라 쪼개려 들면 그 목록이 또 하나의 사전이 된다.
#
# 대신 한 번 기다렸다 다시 묻는다. 분당 제한이면 통과하고, 진짜로 바닥났으면
# 같은 오류가 다시 나서 예전처럼 정지한다.
#
# 실제로 겪은 것 — 서베이 2차가 "할당량이 바닥났습니다" 로 세 번 멈췄는데,
# 그때마다 라우터에 시험 호출을 넣으면 바로 통과했다. 프로젝트 둘이 같은
# 무료 체인을 쓰니 요청률이 두 배가 되어 분당 제한에 자주 걸린 것이다.
# 사람이 매번 "이어서 진행" 을 눌러야 했고, 누르면 한두 호출 만에 또 멈췄다.
QUOTA_RETRY_WAIT = 40      # 초. 분당 창이 넘어가기를 기다린다
# 두 번까지. 25초 1회로는 모자랐다 — 재개 직후 두 호출 연속으로 제한에 걸려
# 그대로 다시 멈췄다. 라우터가 무료 체인의 프로바이더를 돌려 쓰므로 연달아
# 막힌 것을 집을 수 있다. 세 번 이상은 두지 않는다. 진짜로 바닥났을 때
# 사람이 알아채는 것이 늦어지고 그동안 러너 루프가 묶인다.
QUOTA_RETRIES = 2


# ── 모델에게서 JSON 을 받아 내기 ────────────────────────────────────────
def _extract_json(text: str) -> dict | None:
    """답변에서 JSON 객체를 꺼낸다.

    작은 모델은 JSON 만 달라고 해도 앞뒤에 설명을 붙이고, 코드 블록으로
    감싸고, 후행 쉼표를 남긴다. 그때마다 스텝을 통째로 버리면 프로젝트가
    진전 없이 예산만 먹는다. 그래서 최대한 건져 본다.
    """
    if not text:
        return None
    fence = re.search(r"```(?:json)?\s*(.+?)```", text, re.S)
    candidates = [fence.group(1)] if fence else []
    start, depth = -1, 0
    for i, ch in enumerate(text):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}" and depth:
            depth -= 1
            if depth == 0 and start >= 0:
                candidates.append(text[start:i + 1])
    for c in candidates:
        for attempt in (c, re.sub(r",\s*([}\]])", r"\1", c)):
            try:
                got = json.loads(attempt)
                if isinstance(got, dict):
                    return got
            except Exception:  # noqa: BLE001
                continue

    # 여기까지 왔다면 JSON 이 깨졌거나 중간에서 잘린 것이다. 실제로 리뷰
    # 응답이 `{"score": 60, "pass": false, "feedbac` 에서 끊긴 적이 있다.
    # 그걸 통째로 버리면 멀쩡한 반려 판정이 0점으로 기록되고, 그 0점이
    # 정체 카운터를 오염시킨다. 필드만이라도 건진다.
    salvage: dict = {}
    m = re.search(r'"score"\s*:\s*([0-9]+)', text)
    if m:
        salvage["score"] = int(m.group(1))
    m = re.search(r'"pass"\s*:\s*(true|false)', text, re.I)
    if m:
        salvage["pass"] = m.group(1).lower() == "true"
    m = re.search(r'"feedback"\s*:\s*"(.*)', text, re.S)
    if m:
        salvage["feedback"] = m.group(1).rstrip('"}} \n')[:1500]
    return salvage or None


# 글 끝에 붙는 장식. 판정 전에 벗긴다.
#
# "2026 LLM 기술 동향 분석" 이 잘림 3연속으로 멈췄는데 초안은 멀쩡했다.
# 이렇게 끝났다 — `*(참고: … 추후 확인 필요 상태로 유지함)*`. 문장도 괄호도
# 닫혀 있고, 마지막 글자가 마크다운 강조 닫기 `*` 였을 뿐이다.
#
# 대가가 컸다. 호출 셋을 버렸고, 프로젝트가 **틀린 이유로** 멈췄으며
# ("분량을 넘겨 잘렸습니다" — 실제로는 1,391자), 잘림 처리의 단계적 축소가
# 상황을 악화시켰다. 잘렸다고 보면 다음 목표 분량을 줄이는데, 원인이 길이가
# 아니므로 짧게 쓸수록 같은 모양으로 또 끝난다(1953 → 1296 → 1391자).
_TAIL_DECOR = "*_~`\"'”’』」》>)]  \t\r\n"


def _truncated(text: str, finish: str = "") -> bool:
    """출력이 도중에 끊겼는가.

    `finish` 는 프로바이더가 알려 준 종료 사유다. 있으면 그것만 믿는다 —
    "length" 는 max_tokens 에 걸렸다는 뜻이고, "stop" 은 모델이 할 말을 다
    했다는 뜻이다. 아래 휴리스틱은 그 값을 못 받았을 때의 폴백이다.

    코드 블록을 열고 닫지 않았거나, 문장 부호 없이 갑자기 끝나면 잘린 것이다.
    잘린 초안을 그냥 리뷰에 넘기면 리뷰어는 '코드가 미완성'이라고 반려하고,
    다시 써도 같은 자리에서 또 잘린다 — 정체 판정에 걸릴 때까지 예산만 태운다.

    끝의 장식(마크다운 강조·닫는 따옴표·괄호)은 벗기고 본다. 진짜로 끊긴
    글은 단어 중간에서 멈추므로 벗겨도 여전히 걸린다.
    """
    if finish == "length":
        return True
    if finish == "stop":
        # 모델이 스스로 끝냈다. 코드 블록이 안 닫혔으면 글이 이상한 것이지
        # 잘린 것이 아니다 — 그건 검토자가 지적할 일이고, 잘림 처리(분량
        # 축소)로 대응하면 같은 자리에서 더 짧게 또 이상해진다.
        return False
    if not text:
        return False
    if text.count("```") % 2 == 1:
        return True
    tail = text.rstrip().rstrip(_TAIL_DECOR)
    if not tail:
        return False      # 장식뿐인 글은 잘림이 아니라 빈 글이다
    return not tail.endswith((".", "!", "?", "다", "요", ":", "…", "." ))


def _score(raw) -> int:
    try:
        return max(0, min(100, int(float(raw))))
    except Exception:  # noqa: BLE001
        return 0


# ── LLM 호출 (예산 차감 포함) ───────────────────────────────────────────
def _backend_for(dept: str, prefer_cloud: bool) -> tuple[str, str]:
    """어떤 모델로 물을 것인가.

    DEPT_TIER 는 오케스트레이터를 로컬(qwen2.5:7b)로 묶어 뒀다. 평소 조율에는
    맞는 선택이지만 프로젝트에서는 그 부서가 **계획을 세우고 2차 검토로 최종
    통과를 판정한다.** 가장 중요한 판단에 가장 약한 모델을 쓰는 셈이 된다 —
    약한 리뷰어는 나쁜 산출물을 통과시키고, 그러면 검토 단계 자체가 장식이 된다.
    그래서 그 두 자리에서만 라우터로 올린다. 초안은 원래 티어를 따른다.
    """
    if prefer_cloud and dispatcher._router_key() and dispatcher._router_alive():  # noqa: SLF001
        return "router", dispatcher.ROUTER_MODEL
    return dispatcher.choose_backend(dept)


def _local_draft_model() -> tuple[str, str]:
    """라우터가 막혔을 때 초안을 맡길 로컬 모델.

    `choose_backend` 가 주는 것은 qwen2.5:7b 다 — 조율용으로는 맞지만 근거
    자료 16,000자를 읽고 서베이 한 절을 쓰기에는 약하다.

    이 PC 에는 `qwen2.5-kb` 가 있다. `num_ctx 65536`, `temperature 0.3` 으로
    맞춰 둔 모델이라 긴 근거를 읽히기에 알맞다(7b 계열의 기본 32k 보다 넓고,
    낮은 온도는 지어내기를 줄인다). 없으면 기본값으로 떨어진다.
    """
    want = os.environ.get("MT_LOCAL_DRAFT_MODEL", "qwen2.5-kb:latest")
    try:
        import urllib.request as _ur
        with _ur.urlopen(f"{dispatcher.OLLAMA_BASE_URL}/api/tags", timeout=5) as r:
            names = {m.get("name") for m in json.loads(r.read()).get("models", [])}
        if want in names:
            return "ollama", want
    except Exception:  # noqa: BLE001
        pass
    return dispatcher.choose_backend("orchestration_dept")


def _ask(p: dict, dept: str, system: str, user: str,
         prefer_cloud: bool = False, max_tokens: int = 0,
         allow_local: bool = False) -> tuple[str, bool]:
    """(본문, 할당량_소진). 호출 하나를 예산에서 뺀다.

    `allow_local` 이면 라우터가 막혔을 때 로컬 모델로 한 번 더 시도한다.
    **초안에만 준다.** 계획 수립과 2차 검토까지 로컬로 떨어뜨리면 "가장
    중요한 판단에 가장 약한 모델" 이 되어 _backend_for 의 주석이 경고한
    상태가 된다 — 검토가 장식이 되면 근거 강제도 함께 무너진다.
    """
    backend, model = _backend_for(dept, prefer_cloud)

    # 호출 직전에 "지금 무엇을 하려는 중" 을 디스크에 적는다.
    #
    # 단계 기록은 호출이 끝난 뒤에 남는다. 그래서 1만 자짜리 초안을 쓰다
    # 서버가 내려가면 그 호출은 흔적도 없이 사라진다 — 예산은 깎였는데
    # 기록이 없으니, 다시 띄웠을 때 왜 호출 수가 줄었는지 설명되지 않는다.
    #
    # 프로세스가 죽는 경우라 except/finally 로는 못 잡는다. 살아남는 자리는
    # 디스크뿐이고, 다음 스텝이 이 표시를 보고 뒤처리한다(_sweep_inflight).
    started = time.time()
    cur = projects.current(p) or {}
    projects.update(p["id"], {
        "budget": projects.spend(p),
        "inflight": {
            "phase": p.get("phase") or "",
            "dept": dept,
            "deliverable": cur.get("title", ""),
            "model": f"{backend}/{model}",
            "at": time.time(),
        },
    })
    p["budget"] = projects.spend(p)
    msgs = [{"role": "system", "content": system},
            {"role": "user", "content": user}]
    try:
        try:
            out = dispatcher.call_llm(backend, model, msgs, max_tokens=max_tokens)
        except Exception as first:  # noqa: BLE001
            if not any(h in str(first).lower() for h in _QUOTA_HINTS):
                raise
            # 분당 제한일 수 있다. 한 번만 기다렸다 다시 묻는다.
            _emit(p["id"], dept,
                  f"요청 제한에 걸려 {QUOTA_RETRY_WAIT}초 뒤 다시 시도합니다")
            for _ in range(QUOTA_RETRIES):
                time.sleep(QUOTA_RETRY_WAIT)
                try:
                    out = dispatcher.call_llm(backend, model, msgs,
                                              max_tokens=max_tokens)
                    break
                except Exception as again:  # noqa: BLE001
                    if not any(h in str(again).lower() for h in _QUOTA_HINTS):
                        raise
                    last = again
            else:
                raise last

        # 자격증명이 섞여 나왔으면 여기서 가린다. 이 자리를 고른 이유는
        # 모델 출력이 반드시 지나가는 유일한 문이기 때문이다 — 산출물·검토
        # 기록·사무실 이벤트·텔레그램 알림이 모두 이 반환값에서 갈라진다.
        # 넷을 따로 막으면 다섯 번째 통로가 생길 때 또 빠진다.
        #
        # 모델이 .env 를 읽을 수는 없다. 그런데 근거 자료로 설정 조각이나
        # 로그가 들어가면 거기 있던 실제 키를 그대로 베껴 쓴다.
        if secrets_guard.found(out):
            out = secrets_guard.mask(out)
            _emit(p["id"], dept, "출력에서 자격증명으로 보이는 값을 가렸습니다")
        projects.update(p["id"], {
            "inflight": None,
            # 다음 _log 가 집어 갈 소요 시간. 반환값에 끼워 넣지 않는 것은
            # _ask 를 부르는 자리가 여럿이고 전부 (본문, 소진) 두 값을
            # 기대하기 때문이다 — 세 값으로 바꾸면 전부 고쳐야 한다.
            "last_secs": round(time.time() - float(started), 1),
        })
        p["last_secs"] = round(time.time() - float(started), 1)
        # 프로바이더가 알려 준 종료 사유. _truncated 가 추측 대신 이걸 본다.
        p["last_finish"] = getattr(dispatcher, "LAST_FINISH", "")
        return out, False
    except Exception as exc:  # noqa: BLE001
        # 예외로 끝난 것은 죽은 것이 아니다 — 표시를 지워야 다음 스텝이
        # "중간에 끊겼다" 고 오해하지 않는다.
        projects.update(p["id"], {"inflight": None})
        msg = str(exc).lower()
        if any(h in msg for h in _QUOTA_HINTS):
            # 라우터가 언제 풀리는지 알려 주면 그대로 전한다. "할당량이
            # 바닥났습니다" 만으로는 사람이 언제 다시 눌러야 할지 모른다.
            m = re.search(r"reset\s*~?\s*(\d+)\s*m", msg)
            p["quota_note"] = (f"약 {m.group(1)}분 뒤 풀립니다" if m
                               else "잠시 뒤 다시 시도할 수 있습니다")

            # 마지막 보루 — 로컬 모델. 라우터 호출이 아니므로 무료 체인의
            # 분당 제한과 무관하고 할당량도 쓰지 않는다. 느릴 뿐이다.
            #
            # 멈추는 것과 견주면 분명하다. 멈추면 사람이 와서 눌러야 하고,
            # 로컬로 쓰면 느리게나마 간다. 품질이 떨어지는 것은 근거 강제와
            # 2단 검토가 걸러 낸다 — 약한 초안은 반려되지 통과되지 않는다.
            if allow_local and backend != "ollama":
                lb, lm = _local_draft_model()
                if lb == "ollama":
                    _emit(p["id"], dept,
                          f"라우터가 막혀 로컬 모델({lm})로 이어 갑니다 "
                          f"— {p['quota_note']}")
                    try:
                        out = dispatcher.call_llm(lb, lm, msgs,
                                                  max_tokens=max_tokens)
                        projects.update(p["id"], {"inflight": None})
                        p["last_secs"] = round(time.time() - float(started), 1)
                        p["last_finish"] = getattr(dispatcher, "LAST_FINISH", "")
                        p["used_local"] = True
                        return secrets_guard.mask(out), False
                    except Exception as loc:  # noqa: BLE001
                        print(f"[project] 로컬 대체도 실패: {loc}", file=sys.stderr)
            return "", True
        raise


def _emit(pid: str, dept: str, text: str) -> None:
    try:
        dispatcher.emit(dept, "studio_ui", f"[{pid}] {text}")
    except Exception:  # noqa: BLE001
        pass


def _log(p: dict, phase: str, dept: str, ok: bool, note: str,
         score: int = -1, trunc: bool = False, dead: bool = False,
         secs: float = 0.0) -> list[dict]:
    steps = list(p.get("steps") or [])
    row = {"n": len(steps) + 1, "phase": phase, "dept": dept,
           "ok": ok, "score": score, "note": note[:400], "at": time.time()}
    # 잘림은 품질 실패가 아니라 길이 실패다. 표시해 두면 안전망 계산과
    # 화면이 둘을 구분할 수 있다.
    if trunc:
        row["trunc"] = True
    if dead:
        row["dead"] = True
    # 소요 시간. "왜 이렇게 오래 걸리지" 와 "어느 단계가 비싼가" 는 이것
    # 없이는 답할 수 없는 질문이고, 체크포인트가 시작 시각을 이미 적어 두므로
    # 끝날 때 빼기만 하면 된다.
    # 인자로 주지 않으면 직전 _ask 가 적어 둔 값을 집어 간다. _log 호출부가
    # 일곱 군데라 전부 고치는 대신 여기서 한 번 읽는다 — 한 스텝은 호출
    # 하나로 끝나므로 "직전 호출" 이 곧 "이 단계" 다.
    if secs <= 0:
        secs = float(p.get("last_secs") or 0)
    if secs > 0:
        row["secs"] = round(secs, 1)
        p.pop("last_secs", None)      # 다음 단계가 같은 값을 다시 쓰지 않게
    steps.append(row)
    return steps


def _pause(p: dict, reason: str) -> dict:
    """실패가 아니라 일시정지다. 지금까지의 산출물과 리뷰는 그대로 남는다."""
    projects.update(p["id"], {"status": "paused", "pause_reason": reason})

    # 여기가 교훈이 생기는 순간이다. experience.archive() 는 done 일 때만
    # 작동하므로, 막힌 프로젝트의 반려 사유는 그동안 전부 버려졌다 —
    # VLA 프로젝트가 52단계·반려 17회를 겪고 위키에 0건을 남긴 것이 그 결과다.
    # 되풀이된 지적만 골라 다음 계획 수립에 먹인다.
    kept = lessons.record(dict(projects.get(p["id"]) or p), reason)
    if kept:
        _emit(p["id"], ORCHESTRATOR,
              f"교훈 기록 — 되풀이된 지적 {len(kept.get('recurring') or [])}건")
    notify.send(
        f"⏸ [명테크] 프로젝트 일시정지\n\n"
        f"{p.get('title', '')}\n"
        f"진행 {projects.progress(p)} · {len(p.get('steps') or [])}스텝\n\n"
        f"멈춘 이유: {reason}\n\n"
        f"대시보드에서 이어가거나 접을 수 있습니다.")
    _emit(p["id"], ORCHESTRATOR, f"일시정지 — {reason[:120]}")
    return projects.get(p["id"]) or p


# ── 1단계: 의도 파악 + 계획 ─────────────────────────────────────────────
# ── 근거 자료 · 부서 간 인계 · 누가 누구에게 ────────────────────────────
#
# 첫 실전 테스트에서 드러난 것 셋.
#
#   1. 러너가 아무것도 조회하지 않았다. "이 영상처럼 기획해 줘" 에 링크가
#      있었는데 영상 데이터가 프롬프트에 없었다. 연구부는 영상을 보지 않고
#      "색상 코드와 효과 수치까지" 적었고, 리뷰어도 영상을 못 봤으니 100점을
#      줬다. 검토 두 단계가 지어낸 내용을 통과시킨 것이다.
#   2. 부서가 서로의 결과를 받지 않았다. 콘텐츠부는 연구부의 분석을 보지
#      못한 채 시나리오를 썼다 — 부서 간 데이터 교환이 실제로는 없었다.
#   3. 사무실에 아무것도 안 보였다. 이벤트의 받는 쪽이 전부 studio_ui 라
#      어떤 캐릭터에게도 말풍선이 뜨지 않았다.

def _roster(dept: str) -> list[dict]:
    out = []
    for f in sorted((MYUNG_TECH / "departments" / dept / "agents").glob("*.json")):
        try:
            a = json.loads(f.read_text(encoding="utf-8-sig"))
        except Exception:  # noqa: BLE001
            continue
        full = str(a.get("character_name") or "").strip()
        if full:
            # 사무실 캐릭터는 이름의 첫 단어로 불린다(PixelOffice). 거기에 맞춘다.
            out.append({"name": full.split(" ")[0], "role": str(a.get("role") or "")})
    return out


def _who(dept: str, kind: str) -> str:
    """kind: maker(쓰는 사람) · reviewer(부서 검토) · lead(총괄)."""
    r = _roster(dept)
    if not r:
        return dept.replace("_dept", "")
    prefs = {
        "maker": None,
        "reviewer": ("QA Engineer", "Project Manager"),
        "lead": ("Master Orchestrator", "Project Manager"),
    }[kind]
    if prefs is None:
        # 글·코드·분석을 실제로 만드는 역할을 먼저. 파일 순서대로 고르면 콘텐츠부의
        # 시나리오를 디자이너가 쓰게 된다.
        for key in ("Writer", "Software Engineer", "Analyst", "Data Engineer",
                    "Crawler", "Designer"):
            for a in r:
                if key in a["role"]:
                    return a["name"]
        for a in r:
            if a["role"] not in ("Project Manager", "QA Engineer", "Master Orchestrator"):
                return a["name"]
        return r[0]["name"]
    for want in prefs:
        for a in r:
            if a["role"] == want:
                return a["name"]
    return r[0]["name"]


def _say(pid: str, from_dept: str, from_kind: str, to_dept: str, to_kind: str,
         text: str, *, kind: str = "", detail: str = "",
         score: int | None = None) -> None:
    """에이전트 사이에 오간 한 마디. 두 곳에 남긴다.

      · 이벤트 — 사무실 말풍선용 짧은 한 줄 ('[pid] 말한 사람 → 들은 사람: 내용')
      · 프로젝트의 대화 기록 — 전문(detail)까지. 말풍선은 몇 초 뒤 사라지고
        두 줄에서 잘리므로, 관리자가 누가 누구에게 무엇을 말했는지 끝까지
        읽으려면 따로 남아 있어야 한다.
    """
    speaker, listener = _who(from_dept, from_kind), _who(to_dept, to_kind)
    try:
        dispatcher.emit(from_dept, to_dept, f"[{pid}] {speaker} → {listener}: {text}")
    except Exception:  # noqa: BLE001
        pass
    try:
        cur = projects.get(pid) or {}
        log = list(cur.get("dialogue") or [])
        log.append({"at": time.time(), "from": speaker, "from_dept": from_dept,
                    "to": listener, "to_dept": to_dept, "kind": kind or "say",
                    "text": text[:200], "detail": (detail or text)[:3000],
                    "score": score})
        projects.update(pid, {"dialogue": log[-300:]})
    except Exception as exc:  # noqa: BLE001
        print(f"[project] 대화 기록 실패(무시): {exc}", file=sys.stderr)


_WRAPPED = re.compile(
    r"^\s*(?:\*\*)?\[파일\](?:\*\*)?[^\n]*\n+```([\w+-]*)[ \t]*\n(.*)\n```\s*$", re.S)


def _unwrap(text: str) -> str:
    """산출물 전체를 감싼 '[파일] 경로' + 코드 블록 포장을 벗긴다.

    디스패처의 시스템 프롬프트에는 "파일로 남길 것은 [파일] 경로 + 코드 블록"
    이라는 약속이 있고, 프로젝트 초안도 같은 프롬프트를 쓴다. 그래서 기획서
    전체가 ```markdown 한 덩어리로 들어왔다 — 화면에서는 제목·표가 렌더링되지
    않고, 승인하면 파일에도 포장째 저장됐다. 프로젝트 산출물은 완료되면 어차피
    파일이 되므로 포장이 필요 없다.

    문서(markdown/md/무표시)는 본문만 남기고, 코드는 코드 블록으로 남긴다.
    """
    t = (text or "").strip()
    m = _WRAPPED.match(t)
    if not m:
        lines = t.splitlines()
        if lines and lines[0].strip().strip("*").startswith("[파일]"):
            t = "\n".join(lines[1:]).strip()
        return t
    lang, inner = m.group(1).lower(), m.group(2).strip()
    if lang in ("", "markdown", "md"):
        return inner
    return f"```{lang}\n{inner}\n```"


def _split_notes(text: str) -> tuple[str, str, str]:
    """초안 끝의 [한마디]·[인계] 줄을 떼어 낸다 → (본문, 한마디, 인계).

    그대로 두면 산출물 파일에 동료에게 한 말이 섞인다. 떼어 낸 두 줄은
    에이전트가 **자기 말로** 쓴 것이라, 대화 기록에 그대로 쓴다 — 시스템이
    지어 붙이는 "초안 제출 — 제목" 보다 무엇에 집중했는지가 드러난다.
    """
    body, memo, hand = [], [], []
    for line in text.splitlines():
        t = line.strip().lstrip("-*•> ").replace("**", "").strip()
        if t.startswith("[한마디]"):
            memo.append(t[len("[한마디]"):].strip(" :：-—"))
            continue
        if t.startswith("[인계]"):
            hand.append(t[len("[인계]"):].strip(" :：-—"))
            continue
        body.append(line)
    return "\n".join(body).rstrip(), " ".join(memo).strip(), " ".join(hand).strip()


def _plan_brief(plan: dict) -> str:
    lines = [f"의도: {plan.get('intent', '')}", "", "배분:"]
    for i, d in enumerate(plan.get("deliverables") or [], 1):
        lines.append(f"{i}. {d['title']} — {_who(d['dept'], 'maker')} ({d['dept']})")
    return "\n".join(lines)


def dialogue_of(p: dict) -> list[dict]:
    """프로젝트의 대화 기록.

    기록 기능이 생기기 전에 돈 프로젝트는 단계 기록(steps)으로 되살린다. 검토
    의견은 steps 에 300자까지 남아 있어 내용이 완전히 사라지지는 않았다.
    review2 단계의 dept 는 검토자(오케스트레이터)라, 누구에게 한 말인지는
    직전 초안의 부서로 거슬러 찾는다.
    """
    if p.get("dialogue"):
        return list(p["dialogue"])
    out: list[dict] = []
    maker_dept = ""
    first = (projects.deliverables(p) or [{"dept": ORCHESTRATOR}])[0]["dept"]
    for st in p.get("steps") or []:
        dept, ph = st.get("dept", ""), st.get("phase", "")
        ok, sc, note = bool(st.get("ok")), st.get("score", -1), st.get("note", "")
        sc_txt = f"({sc}점)" if isinstance(sc, int) and sc >= 0 else ""
        if ph == "plan":
            row = (ORCHESTRATOR, "lead", first, "maker", "plan",
                   f"착수 회의 — {note}", p.get("intent") or note)
        elif ph == "draft":
            maker_dept = dept
            row = (dept, "maker", dept, "reviewer", "submit" if ok else "retry",
                   note if ok else f"다시 씁니다 — {note}", note)
        elif ph == "review1":
            row = (dept, "reviewer", ORCHESTRATOR if ok else dept,
                   "lead" if ok else "maker", "pass" if ok else "reject",
                   ("1차 통과" if ok else "반려") + sc_txt, note)
        elif ph == "review2":
            tgt = maker_dept or first
            row = (ORCHESTRATOR, "lead", tgt, "maker", "pass" if ok else "reject",
                   ("최종 통과" if ok else "반려") + sc_txt, note)
        else:
            continue
        fd, fk, td, tk, kind, text, detail = row
        out.append({"at": st.get("at", 0), "from": _who(fd, fk), "from_dept": fd,
                    "to": _who(td, tk), "to_dept": td, "kind": kind,
                    "text": text[:200], "detail": detail,
                    "score": sc if isinstance(sc, int) and sc >= 0 else None,
                    "restored": True})
    return out


def _sources(p: dict, d: dict | None = None) -> str:
    """근거 자료. 아이디어에 담긴 링크·채널·검색 + 위키.

    **산출물마다 따로 조회한다.** 산출물이 주어지면 그 제목+설명으로 묻고,
    없으면(계획 단계) 아이디어로 묻는다.

    왜 나눴나 — 실제 프로젝트에서 드러났다. "강화학습 서베이" 의 계획이
    정책 최적화 / 모방학습·세계모델 / 로봇 제어 셋으로 나뉘었는데, 아이디어
    한 줄로 조회하니 `ppo`, `grpo`, `actor-critic` 만 걸렸다. 2·3번 산출물의
    주제에는 근거가 **한 건도** 없었다. 코퍼스에는 다 있는데 가장 센 주제가
    나머지를 덮은 것이다. 그 상태로 쓰면 검토자가 "근거 자료에 없는 내용"
    으로 반려하고, VLA 프로젝트가 겪은 재작업 고리로 들어간다.

    지켜야 할 불변식 — **초안을 쓴 사람과 검토하는 사람이 같은 자료를 봐야**
    검토가 지어낸 것을 잡을 수 있다. 그래서 캐시를 산출물 단위로 두고
    초안과 검토가 같은 키로 읽는다. 산출물이 다르면 자료가 다른 것은 맞다 —
    다른 주제를 쓰고 있으니까.

    스텝마다 다시 묻지는 않는다. 위키 조회는 LLM 호출이 아니라 할당량과는
    무관하지만, 같은 산출물 안에서 자료가 바뀌면 위 불변식이 깨진다.
    """
    key = (d or {}).get("id") or ""
    if key:
        cached = (p.get("sources_by_d") or {}).get(key)
        if cached is not None:
            return cached
    elif "sources" in p:
        return p.get("sources") or ""

    pid = p["id"]
    # 산출물이 있으면 그 주제로 묻는다. 제목만으로는 너무 짧아 어휘 매칭이
    # 헛돌므로 설명까지 붙인다.
    idea = (f"{d['title']} {d.get('desc', '')}" if d else p.get("idea", ""))
    parts: list[str] = []
    names: list[str] = []
    integ = getattr(dispatcher, "integrations", None)
    if integ is not None:
        try:
            # 서베이에는 arXiv 논문 여러 편과 GitHub 저장소가 함께 들어온다.
            # 3500자로는 논문 서너 편에서 잘려, 조회해 놓고 버리게 된다.
            live, used = integ.context_block(idea, budget=7000)
            if live:
                parts.append(live)
                names += used
        except Exception as exc:  # noqa: BLE001
            print(f"[project] 연동 조회 실패(무시): {exc}", file=sys.stderr)
    try:
        kb_block, paths = dispatcher.kb_context(idea)
        if kb_block:
            # 2500자로 자르던 것을 늘렸다. kb_context 가 11,898자를 돌려줬는데
            # 2,500자만 쓰면 다섯 문서 중 앞 한두 개만 들어간다 — 나머지는
            # 조회해 놓고 버리는 셈이고, "위키 5건" 이라고 적히지만 실제로
            # 모델이 본 것은 두 건이다. 화면이 거짓말을 하게 된다.
            parts.append(kb_block[:7000])
            names.append(f"위키 {len(paths)}건")
    except Exception as exc:  # noqa: BLE001
        print(f"[project] 위키 조회 실패(무시): {exc}", file=sys.stderr)
    text = "\n\n".join(parts)

    if key:
        by_d = dict(p.get("sources_by_d") or {})
        by_d[key] = text
        seen = list(p.get("source_names") or [])
        for n in names:
            tag = f"{(d or {}).get('title', '')[:20]}: {n}"
            if tag not in seen:
                seen.append(tag)
        projects.update(pid, {"sources_by_d": by_d, "source_names": seen})
        p["sources_by_d"] = by_d
        p["source_names"] = seen
    else:
        projects.update(pid, {"sources": text, "source_names": names})
        p["sources"] = text

    if names:
        who = f" — {d['title']}" if d else ""
        _say(pid, "research_dept", "maker",
             (d or {}).get("dept") or ORCHESTRATOR, "lead",
             f"자료 조회 완료{who} — " + ", ".join(names), kind="research",
             detail=f"조회한 자료{who}: " + ", ".join(names) + "\n\n" + text[:1200])
    return text


def _grounding(p: dict, limit: int = 3500, d: dict | None = None) -> str:
    src = _sources(p, d)
    if not src:
        return ("\n\n[근거 자료]\n조회된 외부 자료가 없습니다. 구체적 수치·사실을 쓸 때는 "
                "추측임을 밝히세요.")
    return ("\n\n[근거 자료 — 실제로 조회한 데이터. 여기 없는 수치·사실을 지어내지 마세요]\n"
            + src[:limit])


def _handoff(p: dict, budget: int = 4500) -> str:
    """앞 단계에서 검토를 통과한 산출물. 부서가 서로의 결과를 이어받게 한다."""
    ds = projects.deliverables(p)
    cur = int(p.get("cursor", 0))
    arts = p.get("artifacts") or {}
    chunks, used = [], 0
    for d in ds[:cur]:
        body = arts.get(d["id"], "")
        if not body:
            continue
        piece = body[:1800]
        if used + len(piece) > budget:
            break
        chunks.append(f"### {d['title']} ({d['dept']} 작성, 검토 통과)\n{piece}")
        used += len(piece)
    if not chunks:
        return ""
    return ("\n\n[앞 부서가 넘겨준 산출물 — 이 내용과 어긋나지 않게 이어받아 쓰세요]\n"
            + "\n\n".join(chunks))


GROUNDING_RULE = (
    "제출물의 구체적 수치·색상 코드·시간·인용·조회수 같은 사실이 [근거 자료]에 없으면 "
    "지어낸 것으로 보고 반드시 반려하세요. 근거 자료가 없는 주제라면 추측임을 밝혔는지 "
    "보세요. 그럴듯함은 통과 사유가 아닙니다.\n\n")


PLAN_SYSTEM = """당신은 명테크의 오케스트레이터입니다. 사장님이 던진 아이디어 한 줄을
받아서, 실제로 만들 수 있는 계획으로 바꾸는 것이 당신의 일입니다.

사용할 수 있는 부서:
- research_dept : 조사, 자료 정리, 시장·기술 분석
- dev_dept      : 코드, 스크립트, 기술 설계
- content_dept  : 글, 기획서, 카피, 문서
- finance_dept  : 비용, 수익 추정, 예산

중요한 제약: 에이전트는 **글만 씁니다.** 파일을 만들거나 명령을 실행하거나
외부 API 를 부를 수 없습니다. 그러므로 모든 산출물은 "텍스트로 적어 낼 수
있는 것"이어야 합니다. 예: 스크립트 전문, 기획서, 조사 보고서, 예산표.
"서버에 배포한다", "계정을 만든다" 같은 것은 산출물이 될 수 없습니다.

산출물은 2~5개로 쪼개세요. **하나가 한국어 5000자 안에 완결될 수 있는 크기**여야
합니다. 그보다 크면 글이 중간에서 끊기고, 끊긴 글은 검토를 통과하지 못합니다.
'설계서와 코드와 운영 가이드' 처럼 성격이 다른 셋을 한 산출물에 묶지 마세요.

아래 JSON 만 출력하세요. 설명을 덧붙이지 마세요.

{
  "intent": "사장님이 진짜 원하는 것을 한두 문장으로",
  "title": "프로젝트 이름 (20자 이내)",
  "deliverables": [
    {"id": "d1", "title": "산출물 이름", "dept": "dev_dept",
     "desc": "무엇을 어디까지 적어야 하는지 구체적으로"}
  ],
  "done_when": ["완료로 인정할 조건", "..."],
  "risks": ["미리 알아야 할 것"]
}"""


def _do_plan(p: dict) -> dict:
    pid = p["id"]
    projects.update(pid, {"status": "planning"})
    _emit(pid, ORCHESTRATOR, "의도 파악 및 계획 수립 시작")

    # 지난번에 같은 주제로 막혔다면 그 사유를 계획 단계에 꽂는다. 반려
    # 사유를 아는 상태에서 계획을 세우면 같은 완료 조건을 다시 쓰지 않는다 —
    # 재작업이 이 시스템의 최대 낭비였으므로, 가장 앞단에서 막는 것이 싸다.
    past = lessons.brief(f"{p['idea']} {p.get('title', '')}")
    if past:
        _emit(pid, ORCHESTRATOR, "지난 실패 기록을 계획에 반영합니다")

    raw, exhausted = _ask(p, ORCHESTRATOR, PLAN_SYSTEM,
                          f"사장님의 아이디어:\n\n{p['idea']}\n\n" + past + _grounding(p),
                          prefer_cloud=True)
    if exhausted:
        return _pause(p, "계획 수립 단계에서 상위 모델 할당량이 바닥났습니다." + (f" ({p['quota_note']})" if p.get("quota_note") else ""))

    plan = _extract_json(raw)
    if not plan or not plan.get("deliverables"):
        steps = _log(p, "plan", ORCHESTRATOR, False, "계획 JSON 파싱 실패")
        projects.update(pid, {"steps": steps})
        return _pause(p, "계획을 구조화된 형태로 받지 못했습니다. "
                         "아이디어를 조금 더 구체적으로 적어 주시면 다시 시도합니다.")

    # 모르는 부서를 지어내면 조용히 오케스트레이터로 돌린다.
    ds = []
    for i, d in enumerate(plan.get("deliverables") or []):
        if not isinstance(d, dict):
            continue
        ds.append(projects.sanitize_deliverable(d, f"d{i + 1}"))
    if not ds:
        return _pause(p, "계획에 유효한 산출물이 없습니다.")
    plan["deliverables"] = ds[:5]

    steps = _log(p, "plan", ORCHESTRATOR, True,
                 f"산출물 {len(plan['deliverables'])}개")
    projects.update(pid, {
        "plan": plan,
        "intent": str(plan.get("intent") or "")[:400],
        "title": str(plan.get("title") or p["title"])[:80],
        "status": "awaiting_approval",
        "steps": steps,
    })

    # 착수 승인은 여기 한 번뿐이다. 승인 큐에 올리고 텔레그램으로 알린다.
    row = workspace_store.request_approval(
        f"프로젝트 착수: {plan.get('title') or p['title']}",
        department=ORCHESTRATOR,
        detail=(f"의도: {plan.get('intent', '')}\n\n산출물:\n" +
                "\n".join(f"{i + 1}. {d['title']} ({d['dept']})"
                          for i, d in enumerate(plan["deliverables"]))))
    workspace_store.update("approvals", row["id"],
                           {"kind": "project", "project_id": pid})

    notify.send(
        f"📋 [명테크] 프로젝트 착수 승인 요청\n\n"
        f"{plan.get('title') or p['title']}\n\n"
        f"의도: {plan.get('intent', '')}\n\n"
        f"산출물 {len(plan['deliverables'])}개:\n" +
        "\n".join(f"  {i + 1}. {d['title']} ({d['dept']})"
                  for i, d in enumerate(plan["deliverables"])) +
        "\n\n승인하면 결과가 나올 때까지 자율로 진행합니다.")
    _emit(pid, ORCHESTRATOR, "착수 승인 대기")
    # '회의' 가 들어가면 사무실에서 사람들이 회의실로 모인다. 실제로 계획이
    # 나온 순간에만 모이게 한다.
    _say(pid, ORCHESTRATOR, "lead", plan["deliverables"][0]["dept"], "maker",
         f"착수 회의 — 산출물 {len(plan['deliverables'])}개 배분, 사장님 승인 대기",
         kind="plan", detail=_plan_brief(plan))
    return projects.get(pid) or p


# ── 2단계: 초안 ─────────────────────────────────────────────────────────
def _do_draft(p: dict) -> dict:
    pid = p["id"]
    d = projects.current(p)
    if d is None:
        return _finish(p)

    plan = p.get("plan") or {}
    prev = p.get("artifacts", {}).get(d["id"], "")
    feedback = p.get("last_feedback", "")

    system = dispatcher._system_prompt(  # noqa: SLF001
        d["dept"].replace("_dept", " 부서"), False, d["dept"])
    system += ("\n\n지금은 자율 프로젝트의 산출물을 작성하는 중입니다. "
               "완성된 산출물 본문만 쓰세요. 인사말·메타 설명·'다음은 …입니다' 같은 "
               "머리말을 붙이지 마세요.")

    user = (f"프로젝트: {plan.get('title', p['title'])}\n"
            f"의도: {p.get('intent', '')}\n"
            f"완료 조건: {'; '.join(str(x) for x in (plan.get('done_when') or []))}\n\n"
            f"작성할 산출물: {d['title']}\n{d['desc']}\n")
    # 사장님 지시는 검토 지적보다 **위**에 둔다. 검토자는 원래 계획을
    # 기준으로 말하는데, 사장님의 지시는 그 기준 자체를 바꾸는 것이다.
    # 아래에 두면 모델이 둘을 같은 무게로 읽고, 부딪히면 검토 쪽을 따른다.
    steer = p.get("steer", "")
    if steer:
        user += (f"\n[사장님 지시 — 가장 높은 우선순위]\n{steer}\n"
                 "아래 검토 지적과 부딪히면 **이 지시를 따르세요.** 검토자는 "
                 "원래 계획을 기준으로 말한 것이고, 이 지시가 그 기준을 바꿉니다.\n")

    if prev and feedback:
        user += (f"\n[직전 초안]\n{prev[:4000]}\n\n"
                 f"[검토 지적 — 이것을 반드시 고치세요]\n{feedback}\n\n"
                 "지적된 부분을 고쳐서 **전체를 다시** 써 주세요. "
                 "'수정했습니다' 같은 말 없이 본문만.")

    # 초안과 검토가 **같은 양**을 봐야 한다. 다르게 자르면 "검토자는 못 본
    # 근거로 쓴 글" 이 생기고, 그건 근거 강제가 통하지 않는 구멍이다.
    user += _grounding(p, GROUNDING_CHARS, d) + _handoff(p)
    # 총량 상한. 넘치면 **뒤를** 자른다 — 앞쪽에 요구사항과 사장님 지시가
    # 있고, 뒤쪽은 인계분(이미 통과한 다른 산출물)이라 잘려도 손해가 가장 적다.
    if len(user) > USER_PROMPT_CHARS:
        user = user[:USER_PROMPT_CHARS] + "\n\n…(분량 상한으로 뒷부분 생략)"
    system += ("\n\n[근거 자료]에 없는 구체적 수치·색상 코드·시간·조회수·인용을 지어내지 "
               "마세요. 모르는 것은 '확인 필요' 라고 적으세요.")
    system += ("\n\n본문을 다 쓴 뒤 **맨 끝에 두 줄**을 덧붙이세요. 본문과 분리되어 동료에게 "
               "대화로 전달되고, 산출물에는 들어가지 않습니다.\n"
               "[한마디] 검토자에게 — 무엇에 집중했고 어디를 봐 달라는지 한두 문장\n"
               "[인계] 다음 담당자에게 — 이어받을 때 꼭 알아야 할 것 한두 문장")
    system += ("\n\n이 산출물은 완료되면 자동으로 파일이 됩니다. [파일] 표시를 쓰거나 "
               "본문 전체를 코드 블록으로 감싸지 마세요 — 문서는 마크다운 본문 그대로, "
               "코드는 코드 블록으로 쓰세요.")

    _emit(pid, d["dept"], f"초안 작성 — {d['title']}")
    # 초안만 로컬 대체를 허용한다(위 _ask 의 docstring 참고).
    out, exhausted = _ask(p, d["dept"], system, user,
                          max_tokens=DRAFT_MAX_TOKENS, allow_local=True)
    if exhausted:
        return _pause(p, "초안 작성 중 상위 모델 할당량이 바닥났습니다." + (f" ({p['quota_note']})" if p.get("quota_note") else ""))

    out, memo, handoff_note = _split_notes(out)
    out = _unwrap(out)
    notes = dict(p.get("notes") or {})
    notes[d["id"]] = {"memo": memo, "handoff": handoff_note}
    projects.update(pid, {"notes": notes})
    p["notes"] = notes

    if _truncated(out, p.get("last_finish", "")):
        # 리뷰어에게 물어볼 것도 없다. 원인이 분명하므로 바로 되먹인다.
        # 이 되먹임은 리뷰가 아니므로 점수 정체 카운터를 건드리지 않는다 —
        # 대신 길이 전용 카운터를 올린다.
        stall = projects.note_truncation(p)
        n = int(stall.get("truncate", 1))
        # 숫자 없이 "줄여라" 라고만 하면 모델이 몇백 자씩 깎는다. 실측으로
        # 7003 → 6696 → 6140 → 5989 → 5770 을 지나 다섯 번째에야 통과했다.
        # 매번 확실히 줄어드는 목표치를 준다.
        target = max(1500, int(len(out) * (0.7 ** n)))
        arts = dict(p.get("artifacts") or {})
        arts[d["id"]] = out
        steps = _log(p, "draft", d["dept"], False,
                     f"{d['title']} 출력이 잘림 ({len(out)}자, {n}번째)", trunc=True)
        projects.update(pid, {
            "artifacts": arts, "steps": steps, "phase": "draft", "stall": stall,
            "last_feedback": (
                f"직전 초안이 {len(out)}자에서 중간에 끊겼습니다({n}번째). 한 번에 낼 수 "
                f"있는 양을 넘었습니다.\n\n**{target}자 안에서 끝까지 완결된 글**을 "
                "쓰세요. 분량을 맞추는 방법은 내용을 덜어 내는 것입니다 — 설명과 "
                "예시를 줄이고 결론과 근거만, 코드는 동작에 필요한 부분만 남기세요. "
                "끊기느니 짧은 편이 낫습니다."),
        })
        _emit(pid, d["dept"],
              f"초안 잘림 {n}번째 — {target}자로 줄여 재작성 ({len(out)}자)")
        return projects.get(pid) or p

    arts = dict(p.get("artifacts") or {})
    arts[d["id"]] = out
    steps = _log(p, "draft", d["dept"], True, f"{d['title']} ({len(out)}자)")
    # 완결된 초안이 나왔으니 길이 카운터를 비운다. 안 비우면 다음 산출물이
    # 앞 산출물의 잘림을 물려받아 억울하게 멈춘다.
    projects.update(pid, {"artifacts": arts, "steps": steps, "phase": "review1",
                          "stall": projects.note_truncation(p, reset=True)})
    _say(pid, d["dept"], "maker", d["dept"], "reviewer",
         memo or f"초안 제출 — {d['title']}", kind="submit",
         detail=(memo + "\n\n" if memo else "") + f"「{d['title']}」 초안 {len(out)}자를 제출합니다.")
    return projects.get(pid) or p


# ── 3단계: 1차 검토(부서) · 2차 검토(오케스트레이터) ────────────────────
REVIEW_SYSTEM = """당신은 검토자입니다. 산출물이 요구를 충족하는지 냉정하게 봅니다.

점수는 실제 품질을 반영해야 합니다. 통과시키려고 후하게 주지 마세요.
반대로 흠을 만들어 내지도 마세요 — 요구를 충족했으면 통과입니다.

지적은 **구체적으로** 쓰세요. "더 자세히" 같은 말은 도움이 되지 않습니다.
무엇이 빠졌고 무엇을 어떻게 바꿔야 하는지 적으세요.

아래 JSON 만 출력하세요.

{"score": 0-100, "pass": true/false, "feedback": "고쳐야 할 것을 구체적으로"}"""


def _do_review(p: dict, level: int) -> dict:
    """level 1 = 부서 자체 검토, level 2 = 오케스트레이터 최종 검토."""
    pid = p["id"]
    d = projects.current(p)
    if d is None:
        return _finish(p)

    plan = p.get("plan") or {}
    body = p.get("artifacts", {}).get(d["id"], "")
    reviewer = d["dept"] if level == 1 else ORCHESTRATOR
    label = "1차 검토" if level == 1 else "2차 검토"

    extra = ("당신은 이 산출물을 만든 부서의 검토 담당입니다. "
             "요구사항 충족과 내부 완결성을 봅니다."
             if level == 1 else
             "당신은 오케스트레이터입니다. 부서 검토를 통과한 산출물을 최종으로 봅니다. "
             "프로젝트 전체 의도에 맞는지, 다른 산출물과 어긋나지 않는지, "
             "사장님에게 그대로 내놓을 수 있는지를 봅니다.")

    user = (f"프로젝트 의도: {p.get('intent', '')}\n"
            f"완료 조건: {'; '.join(str(x) for x in (plan.get('done_when') or []))}\n\n"
            f"산출물: {d['title']}\n요구: {d['desc']}\n\n")

    # 범위를 좁힌 산출물이면 무엇을 일부러 뺐는지 알려 준다. 완료 조건은
    # 프로젝트 전체 기준이라 그대로 남아 있어서, 말해 주지 않으면 검토자가
    # 덜어낸 항목을 계속 요구한다 — 실제로 좁힌 뒤에도 20·45·30점으로
    # 반려됐고 사유가 전부 "덜어낸 바로 그것이 없다" 였다.
    # 검토자가 사장님 지시를 모르면, 지시대로 바꾼 것을 "계획과 다르다" 며
    # 반려한다. 그러면 방향 전환이 반려 사유를 하나 더 만드는 셈이 된다.
    steer = p.get("steer", "")
    if steer:
        user += (f"[사장님 지시 — 이 프로젝트의 방향이 바뀌었습니다]\n{steer}\n"
                 "원래 계획과 이 지시가 어긋나는 부분은 **지시 쪽이 맞습니다.** "
                 "계획대로가 아니라는 이유로 감점하지 마세요.\n\n")

    nw = (p.get("narrowed") or {}).get(d["id"])
    if nw and nw.get("dropped"):
        user += ("[덜어낸 요구 — 이 산출물에서는 요구하지 않습니다]\n"
                 + "\n".join(f"- {x}" for x in nw["dropped"])
                 + "\n위 항목이 없다는 이유로 감점하지 마세요. "
                   "근거가 없어 일부러 뺀 것입니다.\n\n")

    user += f"--- 제출된 내용 ---\n{body[:6000]}\n--- 끝 ---"
    # 검토자는 초안을 쓴 사람과 **같은 자료**를 봐야 한다. 같은 산출물 키로,
    # 같은 분량으로 읽는다.
    user += _grounding(p, GROUNDING_CHARS, d)
    _emit(pid, reviewer, f"{label} — {d['title']}")
    out, exhausted = _ask(p, reviewer, GROUNDING_RULE + REVIEW_SYSTEM + "\n\n" + extra, user,
                          prefer_cloud=(level == 2))
    if exhausted:
        return _pause(p, f"{label} 중 상위 모델 할당량이 바닥났습니다."
                      + (f" ({p['quota_note']})" if p.get("quota_note") else ""))

    got = _extract_json(out) or {}
    score = _score(got.get("score"))
    feedback = str(got.get("feedback") or out)[:1500]
    passed = bool(got.get("pass")) and score >= PASS_SCORE
    if not got:
        # 판정을 못 읽었으면 통과로 치지 않는다. 통과는 명시적이어야 한다.
        passed, feedback = False, f"검토 결과를 구조화해서 읽지 못했습니다: {out[:300]}"

    stall = projects.note_review(p, passed, score, feedback)
    steps = _log(p, f"review{level}", reviewer, passed,
                 feedback[:300], score)
    patch = {"steps": steps, "stall": stall, "last_feedback": "" if passed else feedback}
    p = {**p, "steps": steps, "stall": stall}

    if passed:
        if level == 1:
            patch["phase"] = "review2"
            projects.update(pid, patch)
            _emit(pid, reviewer, f"1차 통과 ({score}점)")
            _say(pid, d["dept"], "reviewer", ORCHESTRATOR, "lead",
                 f"1차 통과({score}점) — 최종 검토 부탁드립니다",
                 kind="pass", detail=feedback, score=score)
            return projects.get(pid) or p
        # 2차까지 통과 — 이 산출물은 끝났다.
        patch["phase"] = "draft"
        patch["cursor"] = int(p.get("cursor", 0)) + 1
        projects.update(pid, patch)
        _emit(pid, reviewer, f"2차 통과 ({score}점) — {d['title']} 완료")
        after = projects.get(pid) or p
        _say(pid, ORCHESTRATOR, "lead", d["dept"], "maker",
             f"최종 통과({score}점) — {d['title']}",
             kind="pass", detail=feedback, score=score)
        nxt = projects.current(after)
        if nxt is not None:
            # 부서 간 인계. 다음 부서는 _handoff() 로 이 산출물을 실제로 받는다.
            note = ((after.get("notes") or {}).get(d["id"]) or {}).get("handoff", "")
            same = _who(d["dept"], "maker") == _who(nxt["dept"], "maker")
            # 같은 사람이 다음 산출물도 맡으면 "강작가 → 강작가" 가 된다. 자기에게
            # 인계하는 대화는 어색하므로 '이어서 쓴다' 로 말한다.
            msg = (f"(이어서) '{nxt['title']}' 작성을 시작합니다" if same
                   else note or f"📦 {d['title']} 전달 — 이어서 '{nxt['title']}' 부탁합니다")
            _say(pid, d["dept"], "maker", nxt["dept"], "maker", msg,
                 kind="continue" if same else "handoff",
                 detail=(note + "\n\n" if note else "")
                 + f"넘기는 것: 「{d['title']}」(검토 통과본)\n다음: 「{nxt['title']}」")
        if projects.current(after) is None:
            return _finish(after)
        return after

    # 반려 — 초안부터 다시.
    patch["phase"] = "draft"
    projects.update(pid, patch)
    _emit(pid, reviewer, f"{label} 반려 ({score}점) — {feedback[:100]}")
    _say(pid, d["dept"] if level == 1 else ORCHESTRATOR,
         "reviewer" if level == 1 else "lead", d["dept"], "maker",
         f"반려({score}점) — {' '.join(feedback.split())[:70]}",
         kind="reject", detail=feedback, score=score)
    return projects.get(pid) or p


# ── 완료 ────────────────────────────────────────────────────────────────
def _finish(p: dict) -> dict:
    pid = p["id"]
    plan = p.get("plan") or {}
    projects.update(pid, {"status": "done", "phase": "draft", "pause_reason": ""})

    # 산출물을 파일 제안으로 올린다. 승인해야 디스크에 쓰인다 — 자율 실행이
    # 사람 모르게 파일을 만드는 일은 없어야 한다.
    for d in projects.deliverables(p):
        body = _unwrap(p.get("artifacts", {}).get(d["id"], ""))
        if not body:
            continue
        safe = re.sub(r"[^\w가-힣-]+", "_", d["title"]).strip("_")[:40] or d["id"]
        try:
            row = workspace_store.request_approval(
                f"파일 저장: workspace/projects/{pid}/{safe}.md",
                department=d["dept"], detail=f"{plan.get('title', '')} — {d['title']}")
            workspace_store.update("approvals", row["id"], {
                "kind": "file",
                "file_path": f"projects/{pid}/{safe}.md",
                "file_content": body,
            })
        except Exception as exc:  # noqa: BLE001
            print(f"[project] 파일 제안 실패(무시): {exc}", file=sys.stderr)

    # 검토를 통과한 것만 위키에 쌓는다. 그 순간부터 다음 질문에서 근거로
    # 딸려 나온다 — 에이전트가 매번 백지에서 시작하지 않게 하는 유일한 장치다.
    archived: list[str] = []
    try:
        archived = experience.archive(projects.get(pid) or p)
    except Exception as exc:  # noqa: BLE001
        print(f"[project] 경험 축적 실패(무시): {exc}", file=sys.stderr)
    if archived:
        _emit(pid, ORCHESTRATOR, f"위키에 축적 — {len(archived)}건")

    notify.send(
        f"✅ [명테크] 프로젝트 완료\n\n"
        f"{plan.get('title', p['title'])}\n"
        f"산출물 {len(projects.deliverables(p))}개 · {len(p.get('steps') or [])}스텝\n\n"
        f"각 산출물이 부서 1차·오케스트레이터 2차 검토를 모두 통과했습니다.\n"
        f"결재함에 파일 저장 제안으로 올려 뒀습니다."
        + (f"\n위키에 {len(archived)}건을 쌓았습니다 — 다음 질문부터 검색됩니다."
           if archived else ""))
    _emit(pid, ORCHESTRATOR, "프로젝트 완료")
    _say(pid, ORCHESTRATOR, "lead", ORCHESTRATOR, "lead", "전체 브리핑 — 프로젝트 완료",
         kind="brief",
         detail=_plan_brief(plan) + "\n\n모든 산출물이 부서 1차·총괄 2차 검토를 통과했습니다.")
    return projects.get(pid) or p


# ── 한 스텝 ─────────────────────────────────────────────────────────────

# ── 범위 좁히기 ─────────────────────────────────────────────────────────
NARROW_SYSTEM = """너는 오케스트레이터다. 한 산출물이 검토를 여러 번 통과하지
못했다. 담당자를 바꾸거나 더 시키는 것으로는 풀리지 않는 상태다.

**요구 범위를 좁혀서** 통과 가능한 산출물로 다시 정의하라. 규칙은 셋이다.

1. 핵심을 남기고 곁가지를 덜어낸다. 사장님이 이 산출물로 얻으려던 것이
   무엇인지 먼저 생각하고, 그것만 남긴다.
2. 반려 사유가 "근거가 없다" 라면 근거가 필요한 부분을 요구에서 뺀다.
   없는 근거를 지어내게 하는 요구가 애초에 잘못이다.
3. 덜어낸 것을 숨기지 마라. dropped 에 사람이 읽을 문장으로 적는다.

JSON 만 출력한다:
{
  "title": "좁힌 산출물 이름",
  "desc": "무엇을 어디까지 적어야 하는지. 원래보다 분명히 작아야 한다",
  "dropped": ["덜어낸 것 1", "덜어낸 것 2"],
  "why": "왜 이렇게 좁혔는지 한 문장"
}"""


def _reviews_of(p: dict, cursor: int) -> list[dict]:
    """지금 산출물에 달린 검토들. 단계에는 산출물 id 가 없어 순서로 찾는다."""
    i, out = 0, []
    for st in p.get("steps") or []:
        if st.get("phase") == "plan":
            continue
        if st.get("phase") == "draft":
            continue
        if i == cursor:
            out.append(st)
        if st.get("phase") == "review2" and st.get("ok"):
            i += 1
    return out


def _do_narrow(p: dict) -> dict:
    """정체를 만난 산출물의 요구를 좁히고 다시 돌린다."""
    pid = p["id"]
    cursor = int(p.get("cursor", 0))
    ds = list((p.get("plan") or {}).get("deliverables") or [])
    if cursor >= len(ds):
        return _pause(p, "좁힐 산출물을 찾지 못했습니다.")
    d = dict(ds[cursor])

    reviews = _reviews_of(p, cursor)
    fb = "\n\n".join(
        f"[{r.get('score')}점] {r.get('note', '')}" for r in reviews[-4:])
    user = (f"산출물: {d.get('title')}\n"
            f"원래 요구: {d.get('desc')}\n\n"
            f"검토 {len(reviews)}회, 모두 통과 실패. 최근 반려 사유:\n{fb}\n\n"
            f"직전 초안({len((p.get('artifacts') or {}).get(d['id']) or '')}자)은 "
            f"이 요구를 만족시키지 못했다.")

    raw_out, exhausted = _ask(p, ORCHESTRATOR, NARROW_SYSTEM,
                              # 범위를 좁힐 때도 그 산출물의 자료를 봐야 한다.
                              # 다른 자료를 보고 좁히면 '근거가 없어서 뺀다' 는
                              # 판단이 엉뚱한 근거에 기대게 된다.
                              user + _grounding(p, GROUNDING_CHARS, d),
                              prefer_cloud=True)
    if exhausted:
        return _pause(p, "범위를 좁히려는데 상위 모델 할당량이 바닥났습니다." + (f" ({p['quota_note']})" if p.get("quota_note") else ""))

    spec = _extract_json(raw_out)
    if not spec or not spec.get("desc"):
        steps = _log(p, "narrow", ORCHESTRATOR, False, "범위 재정의 파싱 실패")
        projects.update(pid, {"steps": steps})
        return _pause(p, "범위를 좁혀 보려 했지만 오케스트레이터가 구조화된 답을 "
                         "주지 못했습니다. 사장님이 요구를 직접 줄여 주셔야 합니다.")

    dropped = [str(x)[:120] for x in (spec.get("dropped") or []) if str(x).strip()]
    d["title"] = str(spec.get("title") or d["title"])[:80]
    d["desc"] = str(spec["desc"])[:600]
    ds[cursor] = d
    plan = dict(p.get("plan") or {})
    plan["deliverables"] = ds

    # 무엇을 덜어냈는지 프로젝트에 남긴다. 화면이 이걸 읽어 보여 준다.
    narrowed = dict(p.get("narrowed") or {})
    narrowed[d["id"]] = {"dropped": dropped,
                         "why": str(spec.get("why") or "")[:200],
                         "at": time.time()}

    note = f"{d['title']} — 범위 좁힘: " + ("; ".join(dropped) if dropped else "세부 요구 축소")
    steps = _log(p, "narrow", ORCHESTRATOR, True, note)
    projects.update(pid, {
        "plan": plan, "narrowed": narrowed, "steps": steps, "phase": "draft",
        "last_feedback": "",
        # 좁힌 뒤에는 새 출발이다. 안 비우면 좁히자마자 옛 정체로 다시 멈춘다.
        "stall": {"seen": [], "repeat": 0, "no_improve": 0, "best": -1, "truncate": 0},
    })
    _emit(pid, ORCHESTRATOR, note[:180])
    _say(pid, ORCHESTRATOR, "lead", d["dept"], "maker",
         f"요구를 좁혔습니다 — {d['title']}", kind="narrow",
         detail=(spec.get("why") or "")
                + ("\n\n덜어낸 것:\n- " + "\n- ".join(dropped) if dropped else ""))
    notify.send(
        f"✂️ [명테크] 범위를 좁혔습니다\n\n{p.get('title', '')}\n{d['title']}\n\n"
        + (spec.get("why") or "")
        + ("\n\n덜어낸 것:\n- " + "\n- ".join(dropped) if dropped else "")
        + "\n\n시킨 것보다 작아졌습니다. 결과를 받으실 때 확인해 주세요.")
    return projects.get(pid) or p


# 이 시간이 지나도록 끝나지 않은 호출은 죽은 것으로 본다. 가장 긴 호출
# (1만 자 초안)이 실측 2~3분이었으므로 넉넉히 잡는다 — 짧게 잡으면 살아
# 있는 호출을 죽었다고 기록하게 된다.
INFLIGHT_STALE = 900     # 15분


def _sweep_inflight(p: dict) -> dict:
    """끝나지 못한 호출을 단계 기록으로 남긴다.

    프로세스가 죽으면 _ask 의 except 도 finally 도 돌지 않는다. 남는 것은
    디스크의 표시뿐이고, 그걸 여기서 거둬 화면에 보이게 한다. 이렇게 해야
    "예산은 깎였는데 기록이 없다" 가 사라진다.
    """
    f = p.get("inflight")
    if not isinstance(f, dict) or not f.get("at"):
        return p
    age = time.time() - float(f.get("at") or 0)
    if age < INFLIGHT_STALE:
        return p          # 아직 돌고 있을 수 있다 — 건드리지 않는다

    what = f.get("deliverable") or "(산출물 미상)"
    note = (f"호출이 끝나지 못했습니다 — {PHASE_KO.get(f.get('phase', ''), f.get('phase', ''))}"
            f" · {what} · {f.get('model', '')}"
            f" ({int(age // 60)}분 전 시작)")
    # trunc 가 아니라 dead 로 표시한다. 둘 다 "품질 실패가 아니다" 라서
    # 안전망 계산에서 빠지는 것은 같지만, 화면이 trunc 를 "출력 잘림 N회"
    # 로 세기 때문이다 — 죽은 호출을 잘림으로 세면 통계가 거짓말을 한다.
    steps = _log(p, f.get("phase") or "draft", f.get("dept") or ORCHESTRATOR,
                 False, note, dead=True)
    _emit(p["id"], f.get("dept") or ORCHESTRATOR, note)
    return projects.update(p["id"], {"steps": steps, "inflight": None}) or p


PHASE_KO = {"draft": "초안", "review1": "1차 검토", "review2": "2차 검토",
            "plan": "계획 수립", "narrow": "범위 좁히기"}


def step(pid: str) -> dict | None:
    """정확히 한 스텝 나아간다. 나아갈 수 없으면 그대로 돌려준다."""
    p = projects.get(pid)
    if p is None:
        return None
    # 지난번 호출이 중간에 죽었으면 먼저 거둔다. 거두지 않으면 표시가
    # 영영 남아, 다음에 진짜로 죽었을 때 구분할 수 없다.
    p = _sweep_inflight(p)
    status = p.get("status")

    if status in ("done", "cancelled", "paused", "awaiting_approval"):
        return p
    if status == "intake":
        return _do_plan(p)
    if status == "planning":
        # 계획 도중 죽었던 것이다. 다시 세운다.
        return _do_plan(p)
    if status != "running":
        return p

    reason = projects.stop_reason(p)
    if reason:
        # 점수 정체라면 멈추기 전에 한 번, 스스로 범위를 좁혀 본다.
        # 예산·할당량·안전망으로 멈추는 것은 좁혀도 풀리지 않으므로 그대로 멈춘다.
        if projects.can_narrow(p):
            return _do_narrow(p)
        return _pause(p, reason)

    phase = p.get("phase") or "draft"
    if phase == "draft":
        return _do_draft(p)
    if phase == "review1":
        return _do_review(p, 1)
    if phase == "review2":
        return _do_review(p, 2)
    return projects.update(pid, {"phase": "draft"}) or p


def _close_approval(pid: str, status: str) -> None:
    """이 프로젝트의 착수 결재 행을 닫는다.

    승인 경로가 둘이다 — 결재함(UI) 과 approve() 직접 호출(CLI·API). 한쪽만
    움직이면 프로젝트는 돌고 있는데 결재함에는 '대기 중'이 남는다. 화면이
    거짓말을 하게 되므로 어느 쪽으로 들어와도 둘 다 닫는다.
    """
    try:
        for row in workspace_store.load("approvals"):
            if row.get("kind") == "project" and row.get("project_id") == pid \
                    and row.get("status") == "pending":
                workspace_store.update("approvals", row["id"], {"status": status})
    except Exception as exc:  # noqa: BLE001
        print(f"[project] 결재행 정리 실패(무시): {exc}", file=sys.stderr)


def approve(pid: str) -> dict | None:
    """착수 승인. 여기서부터 사람을 부르지 않는다."""
    p = projects.get(pid)
    if p is None or p.get("status") != "awaiting_approval":
        return p
    _close_approval(pid, "approved")
    _say(pid, ORCHESTRATOR, "lead",
         (projects.deliverables(p) or [{"dept": ORCHESTRATOR}])[0]["dept"], "maker",
         "사장님 착수 승인 — 시작합시다", kind="approve")
    _emit(pid, ORCHESTRATOR, "착수 승인 — 자율 실행 시작")
    return projects.update(pid, {"status": "running", "phase": "draft",
                                 "cursor": 0, "pause_reason": ""})


def resume(pid: str, steer: str = "") -> dict | None:
    """일시정지를 풀고 이어 간다. 정체 기록을 비워야 즉시 다시 멈추지 않는다.

    `steer` 는 사장님의 방향 전환 지시다. 그냥 이어 가면 조건이 그대로라
    같은 자리에서 다시 막힌다 — 멈추는 이유가 대개 "같은 지적 3회" 나
    "점수 정체" 이기 때문이다. 정체 기록만 비우는 것은 증상만 지우는 것이다.

    지시는 다음 초안부터 프롬프트에 들어간다(_do_draft). 계획은 건드리지
    않는다 — 돌고 있는 중에 산출물 목록을 바꾸면 cursor 가 가리키는 자리가
    어긋나, 이미 통과한 것이 다른 것의 자리에 들어간다.
    """
    p = projects.get(pid)
    if p is None or p.get("status") != "paused":
        return p
    patch = {
        "status": "running", "pause_reason": "",
        "stall": {"seen": [], "repeat": 0, "no_improve": 0, "best": -1},
    }
    steer = " ".join(str(steer or "").split())[:600]
    if steer:
        patch["steer"] = steer
        _emit(pid, ORCHESTRATOR, f"방향 전환 — {steer[:120]}")
        _say(pid, ORCHESTRATOR, "lead",
             (projects.deliverables(p) or [{"dept": ORCHESTRATOR}])[
                 min(int(p.get("cursor", 0)), max(0, len(projects.deliverables(p)) - 1))
             ]["dept"], "maker",
             f"사장님 지시 — {steer[:200]}", kind="approve")
    return projects.update(pid, patch)


def run(pid: str, max_steps: int = 200) -> dict | None:
    """멈출 때까지 돌린다. max_steps 는 이 프로세스가 폭주하지 않게 하는
    것일 뿐, 프로젝트의 상한이 아니다 — 상한은 진전 판정이 정한다."""
    p = projects.get(pid)
    for _ in range(max_steps):
        p = step(pid)
        if p is None or p.get("status") not in ("running", "intake", "planning"):
            return p
    return p


def run_once_all() -> int:
    """running 인 프로젝트를 하나씩 한 스텝 나아가게 한다."""
    n = 0
    for p in projects.load():
        if p.get("status") in ("running", "intake", "planning"):
            try:
                step(p["id"])
                n += 1
            except Exception as exc:  # noqa: BLE001
                print(f"[project] {p['id']} 스텝 실패: {exc}", file=sys.stderr)
                projects.update(p["id"], {"status": "paused",
                                          "pause_reason": f"오류: {exc}"[:300]})
                notify.send(f"⚠️ [명테크] 프로젝트 오류로 정지\n\n"
                            f"{p.get('title', '')}\n{exc}"[:900])
    return n


def daemon() -> None:
    print("[project] 데몬 시작")
    while True:
        if run_once_all() == 0:
            time.sleep(POLL_INTERVAL)


def _print(p: dict | None) -> None:
    if not p:
        print("(없음)")
        return
    print(f"{p['id']}  {p.get('status'):18} {projects.progress(p):>6}  "
          f"{len(p.get('steps') or [])}스텝  {p.get('title', '')}")
    if p.get("pause_reason"):
        print(f"  정지: {p['pause_reason']}")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "list"
    arg = sys.argv[2] if len(sys.argv) > 2 else ""
    if cmd == "new":
        _print(projects.create(arg))
    elif cmd == "step":
        _print(step(arg))
    elif cmd == "run":
        _print(run(arg))
    elif cmd == "approve":
        _print(approve(arg))
    elif cmd == "resume":
        _print(resume(arg))
    elif cmd == "daemon":
        daemon()
    else:
        for row in projects.load():
            _print(row)
