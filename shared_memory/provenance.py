"""산출물마다 '방법' 절을 붙인다 — RAISE 준수의 알맹이.

## 왜 이것인가

체계적 문헌고찰(systematic review)이 믿기는 이유는 결론이 옳아 보여서가
아니다. **검색식·선별 기준·추출 절차가 공개돼 남이 재현할 수 있기** 때문이다.
결론을 못 믿겠으면 절차를 따라가 직접 확인할 수 있다.

명테크에 필요한 것도 그것이다. 모델 내부를 설명하는 XAI 가 아니라, **절차를
재현 가능하게 만드는 것**. 산출물 끝에 "이건 이렇게 나왔습니다" 를 붙이면,
읽는 사람이 결론을 믿을지 말지를 **스스로 판단할 재료**를 갖는다.

## RAISE 가 요구하는 넷

공식 페이지에서 확인한 것(2025, Cochrane·Campbell·JBI·CEE 공동):

  1. AI 사용을 **공개**할 것
  2. **사람의 감독**이 있을 것
  3. **최종 내용의 책임**은 사람에게 있을 것
  4. AI 를 쓰는 **이유를 정당화**하고 방법론적 엄밀성을 해치지 않음을 보일 것

**오차율 기준은 일부러 두지 않는다** — Cochrane 이 "현재 합의가 없다" 고
명시한다. 사람만으로 할 때의 기준선조차 정의돼 있지 않다는 이유다. 그래서
이 모듈도 "몇 점 이상이면 믿을 만하다" 를 주장하지 않는다. **사실만 적고
판단은 사람에게 남긴다.** 그게 RAISE 3번(책임은 사람)의 뜻이기도 하다.

## ISPOR 의 8개 축

RAISE 의 근거 기반을 감사한 분석(ISPOR Europe 2026)이 쓴 투명성 축이다.
RAISE 자체가 아니라 **벤더 소속 저자의 학회 초록**이고, 저자들은 "이것들이
현재 요구되지 **않는다**" 고 비판하며 제안한 것이다. 그래도 가장 실행
가능한 목록이라 이 모듈이 따른다.

  ① 전체 프롬프트 공개    → 지문·길이 + **전문 보관**(shared_memory/archive.py)
  ② temperature 보고      → 단계마다 기록
  ③ 반복 실행 일관성      → **아직 못 함.** 안 한 것을 안 했다고 적는다
  ④ 코드·데이터 공개      → 조회한 근거 자료 목록과 분량
  ⑤ 인간/벤치마크 기준    → 2단 검토가 **모델끼리**임을 분명히 적는다
  ⑥ 사전 등록             → 착수 승인 시점의 계획 지문
  ⑦ 저자 전문성           → 해당 없음(사람 저자가 아니다)
  ⑧ 성숙도                → 검토 통과 여부·반려 횟수

③과 ⑤를 **못 했다고 적는 것**이 이 모듈에서 가장 중요한 부분이다. 빠진 것을
적지 않으면 방법 절이 오히려 신뢰를 과장하는 장치가 된다.
"""
from __future__ import annotations

import hashlib
import json
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# 근거 부족을 지적한 검토인지. ConfidenceBox 와 같은 자를 쓴다 — 규칙이
# 두 벌이면 화면과 문서가 다른 말을 하게 된다.
GROUNDING_WORDS = ("근거", "출처", "실측", "지어", "추정", "확인할 수 없", "자료에 없")
CAVEAT_WORDS = ("불일치", "단,", "다만", "그러나", "하지만", "아쉬", "미흡",
                "부정확", "권장", "주의", "확인 필요", "어긋")


def plan_digest(plan: dict) -> str:
    """착수 승인 시점의 계획 지문 — 사전 등록에 해당한다.

    승인 뒤에 계획이 바뀌면 지문이 달라지므로, "승인받은 그 계획대로
    만들어졌는가" 를 뒤에서 확인할 수 있다. 계획 수정은 착수 전에만
    허용되므로(projects.revise_plan), 지문이 다르면 그 자체가 신호다.
    """
    core = {
        "deliverables": [{k: d.get(k) for k in ("id", "title", "dept", "desc")}
                         for d in (plan.get("deliverables") or [])],
        "done_when": list(plan.get("done_when") or []),
    }
    blob = json.dumps(core, ensure_ascii=False, sort_keys=True)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:12]


def _steps_for(p: dict, did: str) -> list[dict]:
    """이 산출물에 해당하는 단계들.

    단계에는 산출물 id 가 없다. 대신 순서가 규칙을 따른다 — 초안·1차·2차가
    한 산출물에 대해 반복되다가 2차를 통과하면 다음으로 넘어간다. 심사
    이력 화면(ReviewHistory.tsx)이 쓰는 것과 같은 규칙이다.
    """
    ds = (p.get("plan") or {}).get("deliverables") or []
    idx = next((i for i, d in enumerate(ds) if d.get("id") == did), None)
    if idx is None:
        return []
    out, cur = [], 0
    for s in p.get("steps") or []:
        ph = str(s.get("phase") or "")
        if ph in ("plan", "narrow"):
            continue
        if cur == idx:
            out.append(s)
        if ph == "review2" and s.get("ok"):
            cur += 1
            if cur > idx:
                break
    return out


def _calls(steps: list[dict]) -> dict:
    """어떤 모델이 무슨 설정으로 쓰였나."""
    seen: dict[str, dict] = {}
    for s in steps:
        c = s.get("call") or {}
        m = c.get("model")
        if not m:
            continue
        key = f"{c.get('backend', '?')}/{m}@{c.get('temperature', '?')}"
        e = seen.setdefault(key, {"backend": c.get("backend"), "model": m,
                                  "temperature": c.get("temperature"),
                                  "max_tokens": c.get("max_tokens"),
                                  "n": 0, "phases": set(), "fallback": None})
        e["n"] += 1
        e["phases"].add(str(s.get("phase") or ""))
        if c.get("fallback"):
            e["fallback"] = c["fallback"]
    for e in seen.values():
        e["phases"] = sorted(e["phases"])
    return seen


def methods_section(p: dict, d: dict) -> str:
    """산출물 하나의 '방법' 절. 마크다운.

    주장하지 않고 적기만 한다. "믿을 만하다" 는 판정은 읽는 사람 몫이고,
    그게 RAISE 3번(최종 책임은 사람)의 뜻이다.
    """
    did = d.get("id") or ""
    plan = p.get("plan") or {}
    steps = _steps_for(p, did)
    reviews = [s for s in steps if str(s.get("phase") or "").startswith("review")]
    passed = [s for s in reviews if s.get("ok")]
    rejected = [s for s in reviews if not s.get("ok")]
    grounding_rejects = [s for s in rejected
                         if any(w in (s.get("note") or "") for w in GROUNDING_WORDS)]
    flagged_pass = [s for s in passed
                    if any(w in (s.get("note") or "") for w in CAVEAT_WORDS)
                    and any(w in (s.get("note") or "") for w in GROUNDING_WORDS)]
    drafts = [s for s in steps if str(s.get("phase") or "") == "draft"]

    src_names = [n for n in (p.get("source_names") or [])
                 if n.startswith(str(d.get("title", ""))[:20]) or ":" not in n]
    src_text = (p.get("sources_by_d") or {}).get(did) or p.get("sources") or ""
    nw = (p.get("narrowed") or {}).get(did) or {}
    calls = _calls(steps)

    L: list[str] = []
    A = L.append
    A("## 방법 — 이 문서는 이렇게 만들어졌습니다")
    A("")
    A("> 자동 생성된 기록입니다. 결론을 믿을지 판단하실 재료이지, "
      "믿어도 된다는 보증이 아닙니다.")
    A("")

    # ── 1. AI 사용 공개 (RAISE 1)
    A("### 1. 사용한 AI")
    A("")
    if calls:
        A("| 모델 | 단계 | 호출 | temperature | 최대 출력 |")
        A("|---|---|---|---|---|")
        for e in calls.values():
            fb = " *(라우터 막혀 로컬 대체)*" if e.get("fallback") else ""
            A(f"| `{e['backend']}/{e['model']}`{fb} | {', '.join(e['phases'])} | "
              f"{e['n']}회 | {e['temperature']} | {e['max_tokens'] or '기본값'} |")
    else:
        A("기록이 없습니다 — 호출 조건 기록을 도입하기 전에 만들어진 산출물입니다.")
    A("")
    # ① 전체 프롬프트 보관 + ④ 근거 원문 스냅샷.
    # 둘을 따로 만들려다 보니 하나였다 — 근거 블록이 프롬프트 안에 통째로
    # 들어가므로, 전문을 남기면 "모델이 실제로 본 근거" 가 함께 남는다.
    try:
        from shared_memory import archive as _archive
        _arch = _archive.summary_md(p, did)
    except Exception as e:  # noqa: BLE001
        # 보관 모듈을 못 불러온 것과 보관이 없는 것은 다르다. 섞지 않는다.
        _arch = f"- 프롬프트 보관 상태를 확인하지 못했습니다 ({e}) — 없다는 뜻이 아닙니다."
    A("")
    A(_arch)
    A("")
    A(f"프롬프트 지문: "
      + (", ".join(f"`{(s.get('call') or {}).get('prompt', '?')}`"
                   f"({(s.get('call') or {}).get('prompt_chars', 0):,}자)"
                   for s in drafts[-3:]) or "기록 없음"))
    A("")

    # ── 2. 무엇을 근거로 했나 (ISPOR ④)
    A("### 2. 근거 자료")
    A("")
    if src_text:
        A(f"- 조회처: {', '.join(src_names) if src_names else '(이름 기록 없음)'}")
        A(f"- 프롬프트에 실제로 들어간 분량: 약 {len(src_text):,}자")
        A("- 조회는 산출물마다 따로 했습니다. 이 문서의 근거는 이 주제로 "
          "조회한 것이며, 다른 산출물과 다를 수 있습니다.")

        # 근거에 **이전 AI 출력**이 섞였으면 반드시 말한다.
        #
        # 위키 조회는 사람이 쓴 노드(concepts/entities/comparisons), 수집한
        # 논문(references), 그리고 **검토를 통과한 지난 산출물**
        # (raw/projects)을 함께 훑는다. 마지막 것이 섞였는데 "위키 5건"
        # 이라고만 적으면, 읽는 사람은 근거가 전부 외부 자료라고 믿는다.
        # 점수가 높은 문서의 근거가 알고 보니 지난주 문서일 수 있다.
        #
        # 막지 않고 밝히는 이유: 지난 산출물이 다음 질문에서 검색되는 것이
        # 경험 축적 기능의 전부다. 빼면 그 기능이 사라진다.
        _org = (p.get("origins_by_d") or {}).get(did) or {}
        _exp = int(_org.get("experience") or 0)
        if _exp:
            _tot = sum(int(v) for v in _org.values()) or _exp
            A(f"- ⚠️ **그중 {_exp}건은 이전 프로젝트의 산출물입니다** "
              f"(위키 {_tot}건 중). 외부 자료가 아니라 이 시스템이 전에 쓴 "
              f"글이며, 부서·오케스트레이터 검토는 통과했지만 사람이 사실 "
              f"관계를 확인한 것은 아닙니다. 그 부분은 **AI 출력이 AI 출력의 "
              f"근거가 된 것**이므로, 같은 오류가 되풀이될 수 있습니다.")
        elif _org:
            _nd, _rf = int(_org.get("node") or 0), int(_org.get("reference") or 0)
            A(f"- 근거의 출처 종류: 사람이 정리한 노드 {_nd}건 · "
              f"수집한 논문·문헌 {_rf}건 — **이전 산출물은 섞이지 "
              f"않았습니다.**")
        elif "위키" in " ".join(src_names):
            # 이 기능(2026-10-22) 이전에 만들어진 산출물. 조회한 **경로**를
            # 저장하지 않았으므로 되살릴 수 없다. "섞이지 않았다" 고 적으면
            # 거짓이고, 아무 말도 안 하면 섞이지 않은 것처럼 읽힌다 —
            # 조회 실패를 "없음" 과 섞지 않은 것과 같은 이유로 그렇다고 적는다.
            A("- 근거의 **출처 종류는 기록되지 않았습니다.** 이 산출물은 "
              "출처 분류 기능(2026-10-22) 이전에 만들어졌습니다. 위키 조회는 "
              "이전 프로젝트 산출물도 함께 훑으므로, 섞였는지 여부를 지금은 "
              "알 수 없습니다 — 섞이지 않았다는 뜻이 아닙니다.")
    else:
        A("**조회된 외부 자료가 없습니다.** 이 문서의 사실 관계는 확인되지 "
          "않았습니다 — 검토자도 같은 자료 없이 읽었으므로 점수는 "
          "'그럴듯함' 에 대한 평가입니다.")
    A("")

    # ── 3. 사람의 감독과 검토 (RAISE 2, ISPOR ⑤⑧)
    A("### 3. 검토와 감독")
    A("")
    A(f"- 초안 {len(drafts)}회 · 검토 {len(reviews)}회 "
      f"(통과 {len(passed)} / 반려 {len(rejected)})")
    if grounding_rejects:
        A(f"- 그중 **근거 부족으로 반려 {len(grounding_rejects)}회** — "
          "지어낸 서술이 그만큼 걸러졌다는 뜻입니다.")
    if flagged_pass:
        A(f"- ⚠️ **통과시키면서 근거 문제를 함께 적은 검토가 "
          f"{len(flagged_pass)}건** 있습니다. 점수만 보면 통과이지만 "
          "검토자가 어긋남을 알고 있었습니다:")
        for s in flagged_pass[:2]:
            A(f"  - ({s.get('score', '?')}점) {' '.join((s.get('note') or '').split())[:180]}")
    A("")
    A("**검토는 사람이 하지 않았습니다.** 부서 1차와 오케스트레이터 2차 모두 "
      "모델입니다. 사람의 감독은 **착수 승인**과 **파일 저장 결재** 두 지점에만 "
      "있습니다 — 내용을 한 줄씩 확인한 사람은 없습니다.")
    A("")

    # ── 4. 못 한 것 (가장 중요한 절)
    A("### 4. 하지 않은 것")
    A("")
    # 일관성 시험을 돌렸으면 그 결과를, 아니면 안 했다고 적는다.
    # 안 한 것을 적지 않으면 방법 절이 신뢰를 과장하는 장치가 된다.
    cons = (p.get("consistency") or {}).get(did)
    if cons and not cons.get("error"):
        try:
            from shared_memory import consistency as _c
            A(_c.summary_md(cons))
        except Exception:  # noqa: BLE001
            cons = None
    if not cons or cons.get("error"):
        A("- **반복 실행 일관성을 확인하지 않았습니다.** 같은 프롬프트로 다시 "
          "돌렸을 때 같은 결론이 나오는지 시험하지 않았습니다. temperature 를 "
          "낮게 고정했으나 그것이 일관성을 보장하지는 않습니다. "
          "(프로젝트 상세에서 시험을 돌리실 수 있습니다.)")
    # 사람의 표본 검증. 했으면 결과를, 안 했으면 안 했다고 적는다.
    #
    # 이 줄이 ISPOR ⑤(인간 기준)의 칸이다. 검토가 모델끼리라는 사실을
    # 3절에서 이미 적었으므로, 여기서는 "그래서 사람이 무엇을 봤는가" 를
    # 답해야 한다.
    try:
        from shared_memory import verify as _verify
        vmd = _verify.summary_md(p, did)
    except Exception:  # noqa: BLE001
        vmd = ""
    if vmd:
        A(vmd)
    else:
        A("- **사람이 사실 관계를 표본 검증하지 않았습니다.** 인용된 출처가 "
          "실재하는지, 그 논문이 정말 그 말을 하는지는 확인되지 않았습니다. "
          "(산출물에서 '✋ 표본 검증' 으로 하실 수 있습니다.)")
    if nw.get("dropped"):
        A("- **요구했으나 채우지 못하고 범위에서 덜어낸 것이 있습니다:**")
        for x in nw["dropped"][:6]:
            A(f"  - {x}")
        if nw.get("why"):
            A(f"  - 사유: {' '.join(str(nw['why']).split())[:220]}")
    A("")

    # ── 5. 사전 등록과 책임 (RAISE 3·4, ISPOR ⑥)
    A("### 5. 계획과 책임")
    A("")
    A(f"- 착수 승인 시점 계획 지문: `{p.get('plan_digest') or plan_digest(plan)}`")
    A(f"- 지금 계획 지문: `{plan_digest(plan)}`"
      + ("  ⚠️ **승인 시점과 다릅니다**"
         if p.get("plan_digest") and p["plan_digest"] != plan_digest(plan) else ""))
    if plan.get("done_when"):
        A("- 완료 조건:")
        for c in plan["done_when"]:
            A(f"  - {c}")
    A("")
    A("- **최종 내용의 책임은 사람에게 있습니다.** 이 문서는 승인 절차를 "
      "거쳤을 뿐 사실성이 보증된 것이 아닙니다.")
    A("")
    A(f"*생성: {datetime.now().strftime('%Y-%m-%d %H:%M')} · "
      f"프로젝트 `{p.get('id', '')}` · 산출물 `{did}`*")
    return "\n".join(L)


def attach(p: dict, d: dict, body: str) -> str:
    """산출물 본문에 방법 절을 붙인다. 이미 붙어 있으면 그대로."""
    if "## 방법 — 이 문서는 이렇게 만들어졌습니다" in body:
        return body
    return body.rstrip() + "\n\n---\n\n" + methods_section(p, d) + "\n"


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    from shared_memory import projects
    pid = sys.argv[1] if len(sys.argv) > 1 else ""
    proj = projects.get(pid) if pid else (projects.load() or [None])[-1]
    if not proj:
        raise SystemExit("프로젝트를 찾지 못했습니다.")
    for dd in (proj.get("plan") or {}).get("deliverables") or []:
        print("=" * 72)
        print(methods_section(proj, dd))
