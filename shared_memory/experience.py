"""완료된 프로젝트를 위키에 쌓아 검색되게 한다 — '축적된 경험'.

에이전트는 매번 백지에서 시작했다. 지난주에 똑같은 기획을 했어도 이번 주에
다시 처음부터 짠다. 산출물은 workspace 에 파일로 남지만 그건 **검색되지
않는다** — 지식베이스(kb_context)가 보는 것은 위키뿐이다.

그래서 완료된 프로젝트를 위키의 raw 레이어에 넣는다. 그 순간부터 다음
질문에서 근거로 딸려 나온다. 이것이 '장기기억' 이라 부르던 것의 실체다.
파인튜닝이 아니라 축적이다 — 사실을 넣는 데는 RAG 가 정확하고, 즉시
반영되고, 틀렸을 때 파일 하나만 지우면 된다.

## 무엇을 쌓는가 — 통과한 것만

프로젝트가 `done` 이 된 것만 쌓는다. 그건 각 산출물이 **부서 1차 검토와
오케스트레이터 2차 검토를 모두 통과했다**는 뜻이다. 검토를 통과하지 못한
초안까지 쌓으면 위키가 쓰레기통이 되고, 그러면 검색 품질이 떨어져서
쌓지 않느니만 못하게 된다.

두 가지를 넣는다.

  · **산출물** — 실제 결과물. 다음에 비슷한 것을 만들 때 참고가 된다
  · **프로젝트 기록** — 의도, 산출물 목록, 몇 번 반려됐고 무엇이 지적됐는지.
    결과보다 이쪽이 더 값질 때가 많다. "이런 걸 만들 때 뭘 놓치는지" 이므로

git 커밋은 하지 않는다. 파일이 놓이는 순간 검색은 되고, 커밋은 위키의
자기 리듬(⬆ 백업 / 일일 자동화)에 맡긴다 — 프로젝트가 끝날 때마다 커밋이
하나씩 쌓이면 히스토리가 프로젝트 로그가 되어 버린다.
"""
from __future__ import annotations

import sys
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

SUBDIR = "projects"          # raw/projects/ 아래에 쌓인다


def _kb():
    """지식베이스 모듈. 없으면 None — 축적 실패로 프로젝트가 죽으면 안 된다."""
    try:
        import knowledge_base as kb
        return kb if kb.available() else None
    except Exception:  # noqa: BLE001
        return None


def _review_history(project: dict) -> list[str]:
    """반려 지적만 시간순으로. 통과 기록은 배울 것이 없다."""
    out = []
    for s in project.get("steps") or []:
        if s.get("phase", "").startswith("review") and not s.get("ok"):
            note = " ".join(str(s.get("note") or "").split())[:200]
            if note:
                out.append(f"- ({s.get('score', 0)}점) {note}")
    return out


def project_record(project: dict) -> str:
    """프로젝트 한 건의 기록 문서 본문."""
    plan = project.get("plan") or {}
    ds = plan.get("deliverables") or []
    steps = project.get("steps") or []
    rejects = _review_history(project)

    lines = [
        f"# {plan.get('title') or project.get('title', '')}",
        "",
        f"**의도** — {project.get('intent') or project.get('idea', '')}",
        "",
        f"처음 아이디어: {project.get('idea', '')}",
        "",
        f"총 {len(steps)}단계로 완료. 산출물 {len(ds)}개가 각각 부서 1차 검토와 "
        "오케스트레이터 2차 검토를 모두 통과했다.",
        "",
        "## 산출물",
    ]
    for i, d in enumerate(ds, 1):
        lines.append(f"{i}. **{d.get('title', '')}** ({d.get('dept', '')}) — {d.get('desc', '')}")

    if plan.get("done_when"):
        lines += ["", "## 완료 조건"]
        lines += [f"- {c}" for c in plan["done_when"]]

    if rejects:
        lines += [
            "", "## 검토에서 지적된 것",
            "",
            "다음에 비슷한 것을 만들 때 미리 챙길 것들이다. 결과물보다 이쪽이 값지다.",
            "",
        ]
        lines += rejects

    if plan.get("risks"):
        lines += ["", "## 미리 알아야 했던 것"]
        lines += [f"- {r}" for r in plan["risks"]]

    return "\n".join(lines)


def archive(project: dict) -> list[str]:
    """완료된 프로젝트를 위키에 쌓는다. 저장된 상대경로 목록을 돌려준다.

    실패해도 예외를 올리지 않는다 — 축적이 안 됐다고 프로젝트가 실패로
    바뀌면 안 된다. 결과물은 이미 결재함에 있다.
    """
    if project.get("status") != "done":
        return []
    kb = _kb()
    if kb is None:
        print("[experience] 지식베이스를 찾지 못해 축적을 건너뜁니다", file=sys.stderr)
        return []

    plan = project.get("plan") or {}
    title = plan.get("title") or project.get("title") or project.get("id", "")
    today = date.today().isoformat()
    saved: list[str] = []

    # 1) 프로젝트 기록
    try:
        saved.append(kb.inject(
            f"프로젝트 {title} ({today})",
            project_record(project),
            source_url=f"myung-tech://project/{project.get('id', '')}",
            subdir=SUBDIR))
    except Exception as exc:  # noqa: BLE001
        print(f"[experience] 기록 저장 실패(무시): {exc}", file=sys.stderr)

    # 2) 산출물 각각
    arts = project.get("artifacts") or {}
    for d in plan.get("deliverables") or []:
        body = arts.get(d.get("id", ""), "")
        if not body or len(body.strip()) < 80:
            continue
        try:
            saved.append(kb.inject(
                f"{title} — {d.get('title', '')}",
                f"> {title} 프로젝트의 산출물. {d.get('dept', '')} 작성, "
                f"1차·2차 검토 통과 ({today}).\n\n" + body,
                source_url=f"myung-tech://project/{project.get('id', '')}/{d.get('id', '')}",
                subdir=SUBDIR))
        except Exception as exc:  # noqa: BLE001
            print(f"[experience] 산출물 저장 실패(무시): {exc}", file=sys.stderr)

    return saved


def stats() -> dict:
    """지금까지 쌓인 양. 합성 탭이 보여 준다."""
    kb = _kb()
    if kb is None:
        return {"available": False, "count": 0}
    try:
        d = kb.KB_PATH / "raw" / SUBDIR
        files = sorted(d.glob("*.md")) if d.exists() else []
        return {
            "available": True,
            "count": len(files),
            "latest": files[-1].stem if files else "",
            "path": f"raw/{SUBDIR}",
        }
    except Exception:  # noqa: BLE001
        return {"available": False, "count": 0}


if __name__ == "__main__":
    import json
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(json.dumps(stats(), ensure_ascii=False, indent=2))
