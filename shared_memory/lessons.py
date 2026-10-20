"""막힌 프로젝트에서 교훈을 건져 다음 계획에 먹인다.

`experience.archive()` 는 `status == "done"` 일 때만 작동한다. 통과한 것만
위키에 쌓는다는 그 판단은 **산출물에 대해서는 옳다** — 반려된 초안까지 쌓으면
검색 품질이 떨어져서 쌓지 않느니만 못하다.

그런데 그 규칙이 산출물이 아닌 것까지 같이 버렸다. VLA 프로젝트는 52단계,
검토 20회, 반려 17회를 겪고 위키에 **0건**을 남겼다. 그 반려 사유들이야말로
다음에 같은 주제를 시킬 때 가장 쓸모 있는 자료인데 전부 사라졌다.

그래서 교훈은 산출물과 **다른 통로**로 쌓는다.

  · 산출물 → 위키 raw/projects/ (통과한 것만) ─ experience.py
  · 교훈   → workspace_store "lessons" (막힌 것만) ─ 여기

왜 위키가 아니라 workspace_store 인가. 교훈은 **검색되는 것이 목적이 아니라
계획 단계에 주입되는 것이 목적**이다. 위키에 넣으면 kb_context 가 다른 근거와
섞어서 가져오는데, 그러면 "지난번에 이것 때문에 막혔다" 가 논문 초록 사이에
묻힌다. 계획 프롬프트에 직접 꽂아야 효과가 있다.

## 무엇을 교훈으로 보는가

반려 사유 원문이 아니라 **되풀이된 것**만 본다. 17번 반려 중 15번이 같은
지적이었다면 교훈은 하나다. 같은 지적을 15줄 적어 계획 프롬프트에 넣으면
프롬프트만 길어지고 모델은 더 못 읽는다.
"""
from __future__ import annotations

import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from shared_memory import projects, workspace_store  # noqa: E402

COLL = "lessons"
KEEP = 60               # 교훈이 무한히 쌓이면 주입 후보 고르기가 느려진다
MAX_INJECT = 3          # 계획 프롬프트에 넣을 최대 건수

# 텍스트 정규화는 projects 에서 가져온다 — 직접 만들지 않는다.
#
# 처음엔 여기에 토큰화와 불용어 목록을 따로 뒀다. 그랬더니 같은 지적 셋이
# 하나로 묶이지 않았다 — "구체적 지연 수치를 제시했습니다" 와 "구체적인
# 지연 수치가 들어가 있습니다" 가 다른 지적으로 세어졌다. 조사·어미를 벗기지
# 않았기 때문이다.
#
# 그런데 그건 정체 감지기가 이미 푼 문제다. projects.fingerprint() 는 어간만
# 남기고, SAME_COMPLAINT=0.5 는 실측으로 정한 임계값이다(같은 지적끼리
# 0.57~0.83, 다른 지적끼리 0.14~0.20). 규칙을 두 벌로 가지면 "정체 감지는
# 같은 지적으로 보는데 교훈은 다른 지적으로 세는" 상태가 된다.
_fingerprint = projects.fingerprint
_similarity = projects.similarity
SAME = projects.SAME_COMPLAINT


def _rejections(project: dict) -> list[str]:
    out = []
    for s in project.get("steps") or []:
        if str(s.get("phase", "")).startswith("review") and not s.get("ok"):
            note = " ".join(str(s.get("note") or "").split())
            if note:
                out.append(note)
    return out


def _recurring(notes: list[str], top: int = 3) -> list[str]:
    """되풀이된 지적만 골라낸다.

    지적 원문은 매번 조금씩 다르게 쓰인다(모델이 썼으니). 문장을 그대로 세면
    전부 1회가 되므로 지문끼리 유사도로 묶는다 — 정체 감지기와 같은 자다.
    """
    groups: list[dict] = []
    for n in notes:
        fp = _fingerprint(n)
        if not fp:
            continue
        for g in groups:
            if _similarity(g["fp"], fp) >= SAME:
                g["n"] += 1
                # 가장 짧은 표현을 대표로 — 길수록 그 한 번의 사정이 섞인다
                if len(n) < len(g["text"]):
                    g["text"] = n
                break
        else:
            groups.append({"fp": fp, "text": n, "n": 1})

    groups.sort(key=lambda g: -g["n"])
    out = []
    for g in groups[:top]:
        txt = " ".join(g["text"].split())[:220]
        out.append(f"{txt} (같은 지적 {g['n']}회)" if g["n"] > 1 else txt)
    return out


def record(project: dict, reason: str = "") -> dict | None:
    """막힌 프로젝트에서 교훈 한 건을 남긴다.

    실패해도 예외를 올리지 않는다 — 교훈을 못 남겼다고 정지 처리가
    깨지면 안 된다. 같은 프로젝트는 한 번만 남긴다(이어가기로 또 막힐 수
    있으므로 기존 행을 갱신한다).
    """
    try:
        pid = project.get("id") or ""
        plan = project.get("plan") or {}
        rejects = _rejections(project)
        recur = _recurring(rejects)
        narrowed = project.get("narrowed") or {}
        dropped = [x for v in narrowed.values() for x in (v.get("dropped") or [])]

        # 배울 것이 없으면 남기지 않는다. 결재 대기로 멈춘 것, 계획 파싱이
        # 실패한 것은 교훈이 아니라 사고다.
        if not recur and not dropped:
            return None

        row = {
            "project_id": pid,
            "title": plan.get("title") or project.get("title") or "",
            "idea": str(project.get("idea") or "")[:400],
            "intent": str(project.get("intent") or "")[:300],
            "status": project.get("status") or "",
            "reason": str(reason or project.get("pause_reason") or "")[:300],
            "steps": len(project.get("steps") or []),
            "rejections": len(rejects),
            "recurring": recur,
            "dropped": dropped[:6],
            "topic": _fingerprint(
                f"{plan.get('title', '')} {project.get('idea', '')} "
                f"{project.get('intent', '')}"),
            "at": datetime.now().isoformat(timespec="seconds"),
        }

        for old in workspace_store.load(COLL):
            if old.get("project_id") == pid:
                return workspace_store.update(COLL, old["id"], row)

        new = workspace_store.add(COLL, row)
        _prune()
        return new
    except Exception as exc:  # noqa: BLE001
        print(f"[lessons] 교훈 저장 실패(무시): {exc}", file=sys.stderr)
        return None


def _prune() -> None:
    rows = workspace_store.load(COLL)
    if len(rows) <= KEEP:
        return
    rows.sort(key=lambda r: r.get("at") or "")
    for r in rows[:len(rows) - KEEP]:
        workspace_store.remove(COLL, r["id"])


def relevant(idea: str, limit: int = MAX_INJECT) -> list[dict]:
    """이 아이디어와 주제가 겹치는 교훈. 겹침이 약하면 빈 목록.

    지적끼리 비교할 때보다 문턱을 낮춘다(0.5 → 0.22). 비교 대상이 다르다 —
    지적 두 줄은 같은 길이의 문장이지만, 여기서는 한 줄 아이디어와 프로젝트
    제목·의도를 합친 것을 견준다. 자카드는 한쪽이 길면 값이 낮게 나오므로
    같은 문턱을 쓰면 같은 주제도 안 걸린다.
    """
    want = _fingerprint(idea)
    if not want:
        return []
    scored = []
    for r in workspace_store.load(COLL):
        topic = r.get("topic") or ""
        sim = _similarity(want, topic)
        hit = len(set(want.split()) & set(topic.split()))
        if sim >= 0.22 or hit >= 3:
            scored.append((sim, hit, r))
    scored.sort(key=lambda x: (-x[0], -x[1], x[2].get("at") or ""))
    return [r for _, _, r in scored[:limit]]


def brief(idea: str, limit: int = MAX_INJECT) -> str:
    """계획 프롬프트에 꽂을 블록. 겹치는 교훈이 없으면 빈 문자열.

    문구를 고를 때 조심한 것: "하지 마세요" 라고만 쓰면 모델이 그 주제를
    통째로 피한다. 실제로 필요한 것은 **같은 함정을 피하되 일은 하는 것**이라
        "이번에는 ~로 바꿔 잡으세요" 까지 적어 준다.
    """
    rows = relevant(idea, limit)
    if not rows:
        return ""
    out = ["[지난번에 막힌 기록 — 같은 함정을 반복하지 마세요]", ""]
    for r in rows:
        head = f"· \"{r.get('title', '')}\" — {r.get('steps', 0)}단계 진행 후 중단"
        if r.get("rejections"):
            head += f", 검토 반려 {r['rejections']}회"
        out.append(head)
        for t in (r.get("recurring") or [])[:2]:
            out.append(f"    반려 사유: {t}")
        for d in (r.get("dropped") or [])[:2]:
            out.append(f"    끝내 못 채운 요구: {d}")
        out.append("")
    out += [
        "위 사유의 대부분은 **근거 자료에 없는 것을 요구한 계획** 때문입니다.",
        "이번 계획에서는 실측치·벤치마크 수치·특정 제품의 사양처럼 자료가",
        "없으면 쓸 수 없는 것을 완료 조건에 넣지 마세요. 대신 \"가정을 명시한",
        "추정\", \"측정 방법의 설계\" 처럼 자료 없이도 완결되는 형태로 잡으세요.",
        "",
    ]
    return "\n".join(out)


def stats() -> dict:
    rows = workspace_store.load(COLL)
    return {
        "count": len(rows),
        "latest": max((r.get("at") or "" for r in rows), default=""),
        "rejections": sum(int(r.get("rejections") or 0) for r in rows),
    }


if __name__ == "__main__":
    import json
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if len(sys.argv) > 1 and sys.argv[1] == "brief":
        print(brief(" ".join(sys.argv[2:]) or "VLA 제어 지연"))
    else:
        print(json.dumps(stats(), ensure_ascii=False, indent=2))
