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
import time
import uuid
from datetime import date
from pathlib import Path
from typing import Any

STORE_DIR = Path(__file__).resolve().parent / "store"
STORE_DIR.mkdir(parents=True, exist_ok=True)
FILE = STORE_DIR / "projects.json"

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
DAILY_CALL_BUDGET = int(os.environ.get("MYUNGTECH_DAILY_CALLS", "300"))
BUDGET_SHARE = 0.5      # 그중 프로젝트가 쓸 수 있는 몫

_WORD = re.compile(r"[0-9A-Za-z가-힣]+")


# ── 파일 입출력 ─────────────────────────────────────────────────────────
def load() -> list[dict]:
    try:
        data = json.loads(FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except FileNotFoundError:
        return []
    except Exception:
        return []


def _save(rows: list[dict]) -> None:
    fd, tmp = tempfile.mkstemp(dir=str(STORE_DIR), suffix=".tmp")
    try:
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
    rows = load()
    for p in rows:
        if p.get("id") == pid:
            p.update(patch)
            p["updated_at"] = time.time()
            _save(rows)
            return p
    return None


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
    rows = load()
    rows.append(row)
    _save(rows)
    return row


def remove(pid: str) -> bool:
    rows = load()
    kept = [p for p in rows if p.get("id") != pid]
    if len(kept) == len(rows):
        return False
    _save(kept)
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


def note_review(p: dict, passed: bool, score: int, feedback: str) -> dict:
    """리뷰 한 번의 결과를 진전 기록에 반영한다. 갱신된 stall 을 돌려준다."""
    stall = dict(p.get("stall") or {"seen": [], "repeat": 0, "no_improve": 0, "best": -1})
    if passed:
        # 통과했으면 정체가 아니다. 다음 산출물을 위해 깨끗이 비운다.
        return {"seen": [], "repeat": 0, "no_improve": 0, "best": -1}

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


def stop_reason(p: dict, top_model_exhausted: bool = False) -> str:
    """지금 멈춰야 하는가. 멈춰야 하면 사람이 읽을 이유, 아니면 빈 문자열.

    횟수가 아니라 진전을 본다 — 모듈 설명 참고.
    """
    stall = p.get("stall") or {}
    steps = len(p.get("steps") or [])

    if int(stall.get("repeat", 0)) >= REPEAT_LIMIT:
        return (f"같은 지적이 {stall['repeat']}번 반복됐습니다. "
                "모델이 이 지적을 이해하지 못하는 상태라 더 돌려도 고쳐지지 않습니다.")
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
    if steps >= STEP_SAFETY_NET:
        return (f"{STEP_SAFETY_NET}단계에 도달했습니다. 진전 판정에 걸리지 않고 "
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
