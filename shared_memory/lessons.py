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

# 그중 성공 사례에 내줄 최대 자리. 나머지는 막힌 기록 몫이다.
#
# 성공이 세 자리를 다 차지하면 14회 반려를 한 번에 풀었던 그 경고가
# 프롬프트에서 사라진다. 막힌 기록이 더 비싸게 산 정보다.
MAX_SUCCESS_INJECT = 1

# 뜻으로 찾을 때의 경계선. 실측(질의 9개 · 교훈 3건 · 6/6 정답):
#
#   맞아야 할 것 최저   0.492   "모방학습·행동복제 관련 문헌을 정리"
#   무관한 것 최고      0.366   "회계 장부 마감 절차 문서화"
#
# 간격 +0.126, 겹침 없음. 중간인 0.43 을 쓴다 — 양쪽 0.06 여백.
#
# kb_embed.MIN_SIM 주석에는 "임계값으로 관련성을 가를 수 없다" 고 적어
# 뒀는데 모순이 아니다. **비교 대상이 다르다** — 위키 노드는 짧은 조각이라
# 주제가 섞이지만, 교훈은 제목·아이디어·의도를 합친 긴 덩어리라 또렷하다.
EMBED_MIN = 0.43

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


def record_success(project: dict) -> dict | None:
    """반려 0회로 끝난 프로젝트의 **모양**을 남긴다.

    아무 성공이나 남기지 않는다 — 반려가 한 번이라도 있었으면 평범한
    완료고, 배울 것은 "무엇이 달라서 한 번도 안 막혔나" 뿐이다.

    산출물 '내용' 은 넣지 않는다. 넣으면 다음 계획이 지난 프로젝트를
    베낀다. 건수·반려 수·시간 같은 **모양**만 남긴다.
    """
    try:
        pid = project.get("id") or ""
        plan = project.get("plan") or {}
        rejects = _rejections(project)
        if rejects:
            return None                     # 평범한 완료 — 배울 것이 없다
        ds = plan.get("deliverables") or []
        if not ds:
            return None
        steps = project.get("steps") or []
        mins = round(sum(float(s.get("secs") or 0) for s in steps) / 60, 1)

        row = {
            "kind": "success",
            "project_id": pid,
            "title": plan.get("title") or project.get("title") or "",
            "idea": str(project.get("idea") or "")[:400],
            "intent": str(project.get("intent") or "")[:300],
            "status": "done",
            "deliverables": len(ds),
            "steps": len(steps),
            "rejections": 0,
            "minutes": mins,
            "recurring": [],
            "dropped": [],
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
        print(f"[lessons] 성공 교훈 저장 실패(무시): {exc}", file=sys.stderr)
        return None


def _prune() -> None:
    rows = workspace_store.load(COLL)
    if len(rows) <= KEEP:
        return
    rows.sort(key=lambda r: r.get("at") or "")
    for r in rows[:len(rows) - KEEP]:
        workspace_store.remove(COLL, r["id"])


def _lesson_text(row: dict) -> str:
    """임베딩에 넣을 교훈 본문. 지문이 아니라 원문을 쓴다 — 지문은 토큰만
    추려 둔 것이라 뜻이 깎여 있다."""
    return (f"{row.get('title', '')} {row.get('idea', '')} "
            f"{row.get('intent', '')}")[:1200]


def _by_meaning(idea: str, rows: list[dict], limit: int) -> list[dict] | None:
    """뜻으로 고른다(bge-m3, 다국어). 쓸 수 없으면 None.

    None 과 빈 목록을 가르는 것이 중요하다 — 호출하는 쪽이 "관련 교훈 없음"
    과 "뜻으로 못 찾음" 을 구분해야 어휘 비교로 내려갈 수 있다. 섞으면
    Ollama 가 내려간 날 교훈이 통째로 사라지고 아무도 모른다.
    """
    if not idea or not rows:
        return None
    try:
        import kb_embed
        vecs = kb_embed.embed([idea] + [_lesson_text(r) for r in rows])
        if not vecs or len(vecs) != len(rows) + 1:
            return None
        q = kb_embed._norm(vecs[0])                       # noqa: SLF001
        scored = []
        for r, v in zip(rows, vecs[1:]):
            sim = kb_embed._cos(q, kb_embed._norm(v))     # noqa: SLF001
            if sim >= EMBED_MIN:
                scored.append((sim, r))
        scored.sort(key=lambda x: -x[0])
        return [r for _, r in scored[:limit]]
    except Exception as exc:  # noqa: BLE001
        print(f"[lessons] 뜻으로 찾기 실패 — 어휘 비교로 내려갑니다: {exc}",
              file=sys.stderr)
        return None


def relevant(idea: str, limit: int = MAX_INJECT) -> list[dict]:
    """이 아이디어와 주제가 겹치는 교훈. 겹침이 약하면 빈 목록.

    지적끼리 비교할 때보다 문턱을 낮춘다(0.5 → 0.22). 비교 대상이 다르다 —
    지적 두 줄은 같은 길이의 문장이지만, 여기서는 한 줄 아이디어와 프로젝트
    제목·의도를 합친 것을 견준다. 자카드는 한쪽이 길면 값이 낮게 나오므로
    같은 문턱을 쓰면 같은 주제도 안 걸린다.
    """
    rows_all = workspace_store.load(COLL)

    # 뜻으로 먼저 찾는다. 한국어가 기본이므로 영어 제목·전문용어로 저장된
    # 교훈도 걸려야 한다 — 어휘 비교로는 "강화학습" ↔ "RL Survey" 가
    # 0.000 이었다. bge-m3 는 다국어라 표 없이 이어 준다.
    by_meaning = _by_meaning(idea, rows_all, limit)
    if by_meaning is not None:
        return by_meaning

    # 여기부터는 내리막길 — 임베딩을 못 쓸 때만 온다.
    want = _fingerprint(idea)
    if not want:
        return []
    scored = []
    for r in workspace_store.load(COLL):
        topic = r.get("topic") or ""
        sim = _similarity(want, topic)
        hit = len(set(want.split()) & set(topic.split()))
        # 이 길의 한계를 적어 둔다 — **영어 제목·intent 가 지문을 채우면
        # 한국어 재진술로 못 찾는다.** 실측: "RL Survey: Policy, Imitation,
        # World Model, Robot" 교훈의 지문은 `action advantage arxiv behavior
        # clon critic diffusion dreamer ...` 라서 "강화학습 서베이를 다시
        # 쓴다…" 와 유사도 **0.000** 이다.
        #
        # 그래서 위에서 임베딩을 먼저 쓴다. 여기는 임베딩이 죽었을 때의
        # 예비 경로이고, 그때는 이 한계를 안고 간다 — 교훈이 아예 안 걸리는
        # 것보다는 낫다.
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
    # 막힌 기록을 먼저 채우고, 남은 자리에만 성공 사례를 넣는다.
    # 순서를 바꾸면 더 비싸게 산 정보가 밀려난다.
    picked = relevant(idea, limit)
    stalls = [r for r in picked if r.get("kind") != "success"]
    wins = [r for r in picked if r.get("kind") == "success"][:MAX_SUCCESS_INJECT]
    room = max(0, limit - len(stalls))
    wins = wins[:room]
    if not stalls and not wins:
        return ""

    out: list[str] = []
    if wins:
        out += ["[깨끗하게 끝난 모양 — 참고만 하세요, 베끼지 마세요]", ""]
        for w in wins:
            out.append(f"· \"{w.get('title', '')}\" — 산출물 "
                       f"{w.get('deliverables', 0)}개 · 검토 반려 0회 · "
                       f"{w.get('minutes', 0)}분")
        out += ["",
                "산출물을 적게 잡고 완료 조건을 자료만으로 채울 수 있게 "
                "두면 이렇게 끝납니다. 주제가 다르면 모양도 달라야 하니 "
                "건수를 그대로 따라 하지는 마세요.", ""]

    rows = stalls
    if not rows:
        return "\n".join(out)
    out += ["[지난번에 막힌 기록 — 같은 함정을 반복하지 마세요]", ""]
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
