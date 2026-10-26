"""자율 프로젝트: 아이디어 한 줄에서 완료된 산출물까지.

사장님이 원한 형태는 이렇다.

    아이디어를 던진다 → 의도를 파악한다 → 계획을 세운다
    → 착수 승인을 **한 번** 받는다
    → 그 뒤로는 결과가 나올 때까지 자율로 돈다
    → 각 부서가 1차 검토, 오케스트레이터가 2차 검토, 둘 다 통과해야 완료

그리고 "상한 없이 계속 돌았으면 좋겠다" 고 했다.

## 왜 무제한이 위험한가, 그리고 무엇으로 대신하는가

횟수 상한은 잘못된 도구다. 30회짜리 일에 20회 상한을 걸면 다 된 일을
죽이고, 애초에 수렴하지 않는 일에는 20회를 낭비한다. 상한이 답을 모른다.

진짜 위험은 횟수가 아니라 **진전이 없는데 계속 도는 것**이다. 그리고 그건
관측할 수 있다. 그래서 횟수 대신 진전을 본다:

  · 같은 지적이 반복되면      — 리뷰어가 같은 말을 3번째 하면 모델은 그 지적을
                                이해하지 못하는 것이다. 더 돌아도 안 고쳐진다
  · 점수가 3회 연속 안 오르면 — 나아지지 않는 반복이다
  · 상위 모델 쿼터가 마르면   — 남은 건 더 약한 모델이다. 계속 돌수록 리뷰어가
                                나빠져서 통과 판정이 무의미해진다
  · 하루 호출 예산의 절반     — 라우터는 맹비서와 **공유**한다. 한쪽이 다 쓰면
                                다른 쪽이 굶는다
  · 50 스텝 (안전망)          — 위 넷이 전부 실패했을 때만 걸리는 마지막 그물

이 다섯 중 무엇에 걸려도 **실패가 아니라 일시정지**다. 상태·산출물·지금까지의
리뷰가 그대로 남고, 사장님이 판단해서 이어가거나 접는다. 그리고 멈추는 순간
텔레그램으로 알린다 — 화면을 안 보고 있을 때 도는 물건이므로, 멈췄는데
아무도 모르면 멈춘 게 아니라 사라진 것이다.

즉 상한은 없다. 진전이 있는 한 계속 돈다.
"""
from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
import uuid
from datetime import date
from pathlib import Path
from typing import Any

try:                     # 평평하게 부를 때 — server.py 의 `import projects`
    import disk_guard
except ImportError:      # 패키지로 부를 때 — `from shared_memory import projects`
    from shared_memory import disk_guard

STORE_DIR = Path(__file__).resolve().parent / "store"
STORE_DIR.mkdir(parents=True, exist_ok=True)
FILE = STORE_DIR / "projects.json"

# 쓰기는 전부 "읽고 → 고치고 → 통째로 저장" 이다. 실행기 스레드가 update 를
# 하는 사이 화면이 remove 를 하면, 늦게 저장한 쪽이 먼저 저장한 쪽을 덮는다 —
# 휴지통으로 보낸 프로젝트가 다시 살아나는 식이다. 한 프로세스 안의 경쟁이라
# 잠금 하나로 충분하다(실행기는 server.py 의 스레드다).
_LOCK = threading.RLock()

# ── 상태 ────────────────────────────────────────────────────────────────
#
#   intake ──► planning ──► awaiting_approval ──► running ──► done
#                                   │                │
#                                   │                ├─► paused  (진전 없음)
#                                   └────────────────┴─► cancelled
#
STATUSES = ("intake", "planning", "awaiting_approval",
            "running", "paused", "done", "cancelled")

# 한 산출물이 도는 단계.
PHASES = ("draft", "review1", "review2")

# ── 정지 기준 ───────────────────────────────────────────────────────────
REPEAT_LIMIT = 3        # 같은 지적 3번째 → 정지
NO_IMPROVE_LIMIT = 3    # 점수가 3회 연속 안 오름 → 정지
STEP_SAFETY_NET = 50    # 마지막 그물. 여기까지 오면 설계가 잘못된 것이다
# 통과한 산출물마다 더 주는 여유.
#
# 안전망이 단계 수만 세면, 산출물 하나에서 50단계를 맴도는 프로젝트와 넷을
# 통과시키며 50단계를 쓴 프로젝트가 같은 취급을 받는다. 앞은 설계가 잘못된
# 것이고 뒤는 그냥 큰 일이다.
#
# 실제로 겪은 것 — 서베이 2차가 산출물 넷을 모두 쓰고 셋을 통과시킨 뒤,
# 마지막 2차 검토 한 걸음을 남기고 50단계에서 멈췄다. "계획 자체를 다시
# 봐야 합니다" 라는 문구가 무색했다.
#
# 진전이 없으면 기본값 그대로다 — 느슨해지는 것은 실제로 나아가는
# 프로젝트뿐이고, 안전망이 지키려던 경우는 그대로 지킨다.
STEP_PER_DONE = 15
STEP_SAFETY_CAP = 150   # 아무리 통과해도 여기까지. 안 그러면 안전망이 아니다
TRUNCATE_LIMIT = 3      # 연속 잘림 3번 → 분량 문제로 정지
DAILY_CALL_BUDGET = int(os.environ.get("MYUNGTECH_DAILY_CALLS", "300"))
BUDGET_SHARE = 0.5      # 그중 프로젝트가 쓸 수 있는 몫

_WORD = re.compile(r"[0-9A-Za-z가-힣]+")


# ── 파일 입출력 ─────────────────────────────────────────────────────────
# 부서 목록은 여기 한 곳에만 둔다.
#
# 원래는 project_runner 안에 있었다. 그런데 계획을 화면에서 고칠 수 있게
# 하면서 서버도 같은 검증을 해야 했고, 목록을 양쪽에 두면 "UI 로 고친
# 계획만 검증을 빠져나가는" 상태가 된다. 데이터를 다루는 쪽에 둔다.
ORCHESTRATOR = "orchestration_dept"
KNOWN_DEPTS = ("research_dept", "dev_dept", "content_dept",
               "finance_dept", "orchestration_dept")


def sanitize_deliverable(d: dict, fallback_id: str) -> dict:
    """산출물 한 건을 규칙에 맞게 다듬는다. _do_plan 과 같은 자다."""
    dept = d.get("dept") if d.get("dept") in KNOWN_DEPTS else ORCHESTRATOR
    return {
        "id": str(d.get("id") or fallback_id),
        "title": str(d.get("title") or fallback_id)[:80],
        "dept": dept,
        "desc": str(d.get("desc") or "")[:600],
    }


def revise_plan(pid: str, patch: dict) -> tuple[dict | None, str]:
    """착수 전 계획 수정. (프로젝트, 사유) — 사유가 있으면 거절된 것이다.

    **착수 승인 대기일 때만** 받는다. 돌고 있는 프로젝트의 계획을 바꾸면
    cursor 가 가리키는 산출물이 바뀌어, 이미 통과한 것이 다른 것의 자리에
    들어간다. 돌던 것을 고치려면 멈추고 접은 뒤 다시 시작하는 편이 맞다.

    산출물을 **추가하지는 못한다.** 추가는 수정이 아니라 계획 수립이다 —
    러너가 잡은 의도·부서 배정과 어긋난 채로 실행되게 된다. 범위를 넓히는
    쪽은 새 프로젝트로 받는 것이 정직하다.
    """
    p = get(pid)
    if p is None:
        return None, "프로젝트를 찾을 수 없습니다"
    if p.get("status") != "awaiting_approval":
        return p, "착수 승인 대기 중일 때만 계획을 고칠 수 있습니다"

    plan = dict(p.get("plan") or {})
    old = {d["id"]: d for d in (plan.get("deliverables") or [])}

    if "deliverables" in patch:
        incoming = [d for d in (patch.get("deliverables") or []) if isinstance(d, dict)]
        kept = []
        for d in incoming:
            did = str(d.get("id") or "")
            if did not in old:
                continue          # 새로 만든 것은 조용히 버린다
            kept.append(sanitize_deliverable({**old[did], **d}, did))
        if not kept:
            return p, "산출물이 하나도 남지 않습니다"
        plan["deliverables"] = kept[:5]

    if "done_when" in patch:
        dw = [" ".join(str(c).split())[:200]
              for c in (patch.get("done_when") or []) if str(c).strip()]
        plan["done_when"] = dw[:8]

    return update(pid, {"plan": plan}), ""


def load() -> list[dict]:
    try:
        data = json.loads(FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except FileNotFoundError:
        return []
    except Exception:
        return []


def _save(rows: list[dict]) -> None:
    # 이 시스템에서 가장 큰 쓰기다(실측 668 KB). 원자적 교체라 교체 직전에는
    # 같은 내용이 두 벌 있다 — 디스크가 빠듯하면 여기가 먼저 터진다.
    # disk_guard.writing 을 지나가면 메시지가 "디스크가 꽉 찼습니다" 가 된다.
    fd, tmp = tempfile.mkstemp(dir=str(STORE_DIR), suffix=".tmp")
    try:
        with disk_guard.writing(FILE):
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(rows, f, ensure_ascii=False, indent=2)
            os.replace(tmp, FILE)
    except Exception:
        Path(tmp).unlink(missing_ok=True)
        raise


def get(pid: str) -> dict | None:
    for p in load():
        if p.get("id") == pid:
            return p
    return None


def update(pid: str, patch: dict) -> dict | None:
    with _LOCK:
        rows = load()
        for p in rows:
            if p.get("id") == pid:
                p.update(patch)
                p["updated_at"] = time.time()
                _save(rows)
                return p
        return None


# 인코딩이 깨진 입력(모지바케)을 가려내는 선. 실측으로 정했다:
#
#   실제 위키 문서 197건 중 최대   0.0109  (mlp-vs-transformer.md)
#   셸이 망가뜨린 아이디어          0.27
#
# 25배 차이라 0.08 이면 양쪽에서 넉넉하다. 한글 비율을 쓰지 않는 이유는
# **영어로만 쓴 멀쩡한 아이디어**도 0 이기 때문이다.
MOJIBAKE_MAX = 0.08
MOJIBAKE_MIN_LEN = 20          # 짧은 글은 비율이 요동쳐 판정하지 않는다


# 이 구역에 있지만 멀쩡한 글에 쓰이는 것들. 세지 않는다.
#
#   ·  가운데점 — "PPO·GRPO·DPO" 처럼 한국어에서 흔하다. 이것 때문에
#      짧은 아이디어가 0.043 까지 올라가 기준 0.08 과 여백이 1.6배밖에
#      안 됐다. 빼야 한다.
#   나머지는 단위·통화·인용부호. 깨진 바이트가 이것들만 모아 나올 일은 없다.
_OK_SYMBOLS = set("·×÷°±©®§¶€£¥¢«»¬" + "\u00ad\u00a0")


def mojibake_ratio(text: str) -> float:
    """깨짐 지표 — latin-1 보충 구역의 **기호** 비율.

    **악센트 문자는 세지 않는다.** `Müller`·`façade`·`Zürich` 는 멀쩡한
    글이고, 실제로 악센트 섞인 영어가 0.051 까지 나왔다. 반면 cp949 를
    latin-1 으로 잘못 읽으면 `¡ ¹ ¿ ¤ ¸ ¼ ½ º` 같은 **기호**가 무더기로
    쏟아진다 — 실측 표본에서 19자 중 17자가 기호였다.
    """
    if not text:
        return 0.0
    n = sum(1 for c in text
            if "\u00a0" <= c <= "\u00ff"
            and not c.isalpha()
            and c not in _OK_SYMBOLS)
    return n / len(text)
def unreadable(text: str) -> str:
    """읽을 수 없는 입력이면 사유를, 아니면 빈 문자열.

    왜 막는가. 계획 수립기는 의미 없는 바이트를 받고도 "못 읽겠다" 고 하지
    않았다 — 조회된 논문을 붙잡고 전혀 다른 프로젝트를 지어냈다(「독일 BSI
    자동 인증 지원 시스템」, 산출물 4개). 그리고 승인 요청을 보냈다.
    사장님이 시키지 않은 사업 계획을 승인할 뻔한 것이다.
    """
    t = (text or "").strip()
    if len(t) < MOJIBAKE_MIN_LEN:
        return ""
    r = mojibake_ratio(t)
    if r > MOJIBAKE_MAX:
        return (f"입력의 글자가 깨져 있습니다 (깨짐 지표 {r:.0%}, 기준 "
                f"{MOJIBAKE_MAX:.0%}). 인코딩이 틀어진 것으로 보입니다 — "
                f"이대로 계획을 세우면 엉뚱한 프로젝트를 지어냅니다. "
                f"UTF-8 로 다시 보내 주십시오.")
    return ""


def create(idea: str, title: str = "") -> dict:
    """아이디어 한 줄로 프로젝트를 연다. 아직 아무것도 시작하지 않는다."""
    row = {
        "id": "prj-" + uuid.uuid4().hex[:8],
        "title": (title or idea).strip()[:80],
        "idea": idea.strip(),
        "status": "intake",
        "intent": "",
        "plan": None,
        "cursor": 0,          # 지금 만들고 있는 산출물 번호
        "phase": "draft",
        "steps": [],          # 지나온 모든 단계의 기록
        "artifacts": {},      # deliverable_id → 본문
        "budget": {"calls": 0, "day": _today()},
        "stall": {"seen": [], "repeat": 0, "no_improve": 0, "best": -1},
        "pause_reason": "",
        "created_at": time.time(),
        "updated_at": time.time(),
    }
    with _LOCK:
        rows = load()
        rows.append(row)
        _save(rows)
    return row


def remove(pid: str) -> bool:
    with _LOCK:
        rows = load()
        kept = [p for p in rows if p.get("id") != pid]
        if len(kept) == len(rows):
            return False
        _save(kept)
        return True


def insert(row: dict) -> bool:
    """휴지통에서 되살린 기록을 그대로 다시 넣는다. 같은 id 가 있으면 False."""
    with _LOCK:
        rows = load()
        if any(p.get("id") == row.get("id") for p in rows):
            return False
        rows.append(row)
        _save(rows)
        return True


# ── 진전 판정 ───────────────────────────────────────────────────────────
def _today() -> str:
    return date.today().isoformat()


# 한국어 조사·어미. 같은 지적을 다른 문장으로 써도 어간은 남는다 —
# "파일이 없을 때" 와 "파일 없음" 은 같은 지적이다.
_SUFFIX = re.compile(
    r"(이라고|습니다|했습니다|있습니다|없습니다|하였습니다|합니다|하세요|해야|하므로|"
    r"하지만|하고|하며|한다|했다|되어|되었|되는|하는|에서|에게|으로|까지|부터|라고|"
    r"들|이|가|은|는|을|를|의|에|로|와|과|도|만)$")

_STOP = {"코드", "내용", "부분", "필요", "추가", "수정", "개선", "확인", "산출물",
         "경우", "때문", "위해", "대해", "그리고", "또한", "하지만", "다음",
         "the", "and", "for", "this", "that", "with", "should", "must"}


def _stem(word: str) -> str:
    w = word.lower()
    if w.isascii():
        for suf in ("ing", "ed", "es", "s"):
            if len(w) > len(suf) + 2 and w.endswith(suf):
                return w[: -len(suf)]
        return w
    # 조사가 겹쳐 붙는 경우가 있다("파일에서는"). 두 번까지 벗긴다.
    for _ in range(2):
        stripped = _SUFFIX.sub("", w)
        # 어간이 2글자 미만이 되면 벗기지 않는다. 한국어 2글자 명사는
        # 끝 글자가 조사와 겹치는 것이 흔하다 — 결과→결, 의도→의, 효과→효.
        # 그걸 벗기면 뜻이 다른 단어들이 한 덩어리가 된다.
        if stripped == w or len(stripped) < 2:
            break
        w = stripped
    return w


def fingerprint(feedback: str) -> str:
    """리뷰 지적의 지문 — 의미가 실린 어간의 집합.

    같은 지적인지 보려는 것이므로 표현의 흔들림은 지워야 한다. 모델은
    같은 말을 매번 다르게 쓴다. 어순·조사·어미·길이를 버리고 어간만 남긴다.
    공백으로 이어 붙인 문자열로 돌려주는 것은 JSON 에 그대로 담기 위해서다.
    """
    words = {_stem(w) for w in _WORD.findall(feedback) if len(w) >= 2}
    words = {w for w in words if len(w) >= 2 and w not in _STOP}
    return " ".join(sorted(words)[:16])


def similarity(a: str, b: str) -> float:
    """두 지문이 얼마나 같은 말인가 (0~1). 자카드 유사도."""
    sa, sb = set(a.split()), set(b.split())
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


# 이 이상 겹치면 "같은 지적"으로 본다. 완전 일치를 요구하면 모델이 문장을
# 조금만 바꿔 써도 새 지적으로 세어 정체를 영원히 못 잡는다. 실측:
# 같은 지적을 달리 쓴 문장끼리 0.57~0.83, 다른 지적끼리 0.14~0.20 이었다.
SAME_COMPLAINT = 0.5


def note_truncation(p: dict, reset: bool = False) -> dict:
    """초안이 잘렸다 / 안 잘렸다를 기록한다.

    리뷰가 아니므로 점수 정체(no_improve)와 섞지 않는다. 길이 문제는 길이
    문제로 세야 "요구를 좁혀라" 와 "산출물을 쪼개라" 를 구분해 말할 수 있다.
    """
    stall = dict(p.get("stall") or {})
    stall["truncate"] = 0 if reset else int(stall.get("truncate", 0)) + 1
    return stall


def note_review(p: dict, passed: bool, score: int, feedback: str) -> dict:
    """리뷰 한 번의 결과를 진전 기록에 반영한다. 갱신된 stall 을 돌려준다."""
    stall = dict(p.get("stall") or {"seen": [], "repeat": 0, "no_improve": 0, "best": -1})
    if passed:
        # 통과했으면 정체가 아니다. 다음 산출물을 위해 깨끗이 비운다.
        return {"seen": [], "repeat": 0, "no_improve": 0, "best": -1, "truncate": 0}

    fp = fingerprint(feedback)
    seen = list(stall.get("seen") or [])
    if fp:
        # 글자가 아니라 뜻이 같은지를 센다. 자기 자신도 한 번으로 친다.
        stall["repeat"] = 1 + sum(1 for old in seen
                                  if similarity(old, fp) >= SAME_COMPLAINT)
        seen.append(fp)
    stall["seen"] = seen[-12:]

    best = int(stall.get("best", -1))
    if score > best:
        stall["best"] = score
        stall["no_improve"] = 0
    else:
        stall["no_improve"] = int(stall.get("no_improve", 0)) + 1
    return stall


def budget_left(p: dict) -> int:
    """오늘 이 프로젝트가 더 쓸 수 있는 LLM 호출 수."""
    b = dict(p.get("budget") or {})
    if b.get("day") != _today():
        return int(DAILY_CALL_BUDGET * BUDGET_SHARE)
    return int(DAILY_CALL_BUDGET * BUDGET_SHARE) - int(b.get("calls", 0))


def spend(p: dict, n: int = 1) -> dict:
    """호출을 예산에서 뺀다. 날짜가 바뀌었으면 새로 시작한다."""
    b = dict(p.get("budget") or {})
    if b.get("day") != _today():
        b = {"day": _today(), "calls": 0}
    b["calls"] = int(b.get("calls", 0)) + n
    return b


def can_narrow(p: dict) -> bool:
    """멈추는 대신 스스로 범위를 좁혀 볼 수 있는가.

    좁히기는 사장님이 시킨 것보다 덜 만드는 일이다. 그래서 **점수가 안 오르거나
    같은 지적이 반복될 때만** 쓴다 — 그 둘은 요구가 과했다는 신호다.
    예산·할당량·안전망·분량 초과는 좁혀도 풀리지 않거나(예산) 이미 그 자체가
    범위 이야기라(분량) 해당하지 않는다.

    그리고 산출물마다 딱 한 번이다. 될 때까지 깎으면 껍데기가 남는다.
    """
    stall = p.get("stall") or {}
    stuck = (int(stall.get("repeat", 0)) >= REPEAT_LIMIT
             or int(stall.get("no_improve", 0)) >= NO_IMPROVE_LIMIT)
    if not stuck:
        return False
    ds = (p.get("plan") or {}).get("deliverables") or []
    cursor = int(p.get("cursor", 0))
    if cursor >= len(ds):
        return False
    return ds[cursor].get("id") not in (p.get("narrowed") or {})


def stop_reason(p: dict, top_model_exhausted: bool = False) -> str:
    """지금 멈춰야 하는가. 멈춰야 하면 사람이 읽을 이유, 아니면 빈 문자열.

    횟수가 아니라 진전을 본다 — 모듈 설명 참고.
    """
    stall = p.get("stall") or {}
    # 잘린 초안은 세지 않는다. 이 그물은 "계획이 잘못됐다" 를 잡으려고 있는데,
    # 길이를 못 맞춰 다시 쓴 횟수까지 세면 엉뚱한 이유로 먼저 걸린다.
    # 잘림도 죽은 호출도 "품질 실패" 가 아니다. 안전망은 "이만큼 돌렸는데도
    # 안 되면 계획이 틀렸다" 를 재는 것이므로, 길이 문제와 프로세스 사고는
    # 빼고 센다 — 넣으면 계획은 멀쩡한데 안전망에 먼저 걸린다.
    steps = sum(1 for s in (p.get("steps") or [])
                if not s.get("trunc") and not s.get("dead"))

    if int(stall.get("repeat", 0)) >= REPEAT_LIMIT:
        return (f"같은 지적이 {stall['repeat']}번 반복됐습니다. "
                "모델이 이 지적을 이해하지 못하는 상태라 더 돌려도 고쳐지지 않습니다.")
    if int(stall.get("truncate", 0)) >= TRUNCATE_LIMIT:
        return (f"초안이 {stall['truncate']}번 연속으로 분량을 넘겨 잘렸습니다. "
                "글이 나쁜 게 아니라 이 산출물 하나에 담으라는 양이 많습니다. "
                "산출물을 쪼개거나 요구 범위를 줄여 다시 시작해 주세요.")
    if int(stall.get("no_improve", 0)) >= NO_IMPROVE_LIMIT:
        return (f"리뷰 점수가 {stall['no_improve']}회 연속 오르지 않았습니다 "
                f"(최고 {stall.get('best', 0)}점). 나아지지 않는 반복입니다.")
    if top_model_exhausted:
        return ("상위 모델의 오늘 할당량이 바닥났습니다. 남은 모델로는 검토 품질을 "
                "믿을 수 없어, 통과 판정에 의미가 없습니다.")
    if budget_left(p) <= 0:
        cap = int(DAILY_CALL_BUDGET * BUDGET_SHARE)
        return (f"오늘 이 프로젝트가 쓸 수 있는 호출 {cap}회를 모두 썼습니다. "
                "라우터는 맹비서와 공유하므로 여기서 멈춥니다. 내일 이어집니다.")
    # 통과한 산출물만큼 여유를 더한다(STEP_PER_DONE 주석 참고).
    done_n = int(p.get("cursor") or 0)
    net = min(STEP_SAFETY_CAP, STEP_SAFETY_NET + done_n * STEP_PER_DONE)
    if steps >= net:
        extra = (f" (산출물 {done_n}개 통과분 {done_n * STEP_PER_DONE}단계 포함)"
                 if done_n else "")
        return (f"{net}단계에 도달했습니다{extra}. 진전 판정에 걸리지 않고 "
                "여기까지 왔다면 계획 자체를 다시 봐야 합니다.")
    return ""


# ── 조회 ────────────────────────────────────────────────────────────────
def deliverables(p: dict) -> list[dict]:
    plan = p.get("plan") or {}
    return list(plan.get("deliverables") or [])


def current(p: dict) -> dict | None:
    ds = deliverables(p)
    i = int(p.get("cursor", 0))
    return ds[i] if 0 <= i < len(ds) else None


def progress(p: dict) -> str:
    ds = deliverables(p)
    if not ds:
        return "-"
    return f"{min(int(p.get('cursor', 0)) + 1, len(ds))}/{len(ds)}"


def as_dict() -> dict[str, Any]:
    return {"projects": load()}
