"""같은 프롬프트로 다시 써 보고 얼마나 같은지 잰다 (RAISE / ISPOR ③).

## 왜 필요한가

ISPOR 가 RAISE 의 근거 기반을 감사하며 쓴 8개 축 중 하나가 **반복 실행
일관성**이다. 실측으로 평가 30건 중 10건(33%)만 이걸 시험했다.

우리는 안 했다. 방법 절이 "반복 실행 일관성을 확인하지 않았습니다" 라고
적고 있었는데, 그건 정직하지만 **빈칸이다.** 이 모듈이 그 칸을 채운다.

## 무엇을 재는가

같은 산출물을 같은 조건으로 한 번 더 쓰게 하고, 둘을 견준다. 재는 것은
문장이 같은지가 **아니다** — temperature 0.3 이어도 글은 매번 달라진다.
달라지면 안 되는 것은 **사실 관계**다.

  · 인용한 arXiv 번호가 같은가       ← 가장 중요하다
  · 언급한 저장소·고유명사가 같은가
  · 숫자가 같은가
  · 길이가 비슷한가                  ← 참고용

두 번 써서 **한쪽에만 나온 arXiv 번호**가 있다면, 그건 둘 중 하나가 지어낸
것이거나 근거에서 우연히 집힌 것이다. 어느 쪽이든 그 번호는 믿을 수 없다.

## 점수를 매기지 않는다

"85% 일치하므로 믿을 만함" 같은 판정을 하지 않는다. RAISE 가 오차율 기준을
일부러 두지 않는 것과 같은 이유다 — 몇 퍼센트면 되는지에 대한 합의가 없다.
**무엇이 달랐는지 그대로 보여 주고 판단은 사람이 한다.**
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

# 사실 관계를 담은 조각들. 글투가 달라져도 이것들은 같아야 한다.
ARXIV = re.compile(r"(?:arXiv:)?\[?(\d{4}\.\d{4,5})\]?")
REPO = re.compile(r"\b([A-Za-z0-9][\w.-]{1,38}/[A-Za-z0-9][\w.-]{1,38})\b")
# 소수점이 있거나 세 자리 이상인 수. "3개" 같은 것은 빼고 "68.3%", "2,649회" 를 잡는다.
NUMBER = re.compile(r"\b\d{1,3}(?:,\d{3})+\b|\b\d+\.\d+\b|\b\d{3,}\b")


def _facts(text: str) -> dict[str, set[str]]:
    repos = {r for r in REPO.findall(text or "")
             if not r.lower().endswith((".md", ".py", ".json", ".txt"))}
    return {
        "arxiv": set(ARXIV.findall(text or "")),
        "repo": repos,
        "number": set(NUMBER.findall(text or "")),
    }


def compare(a: str, b: str) -> dict:
    """두 글의 사실 조각을 견준다. 판정하지 않고 차이만 돌려준다."""
    fa, fb = _facts(a), _facts(b)
    out: dict = {
        "chars": [len(a or ""), len(b or "")],
        "kinds": {},
    }
    for kind in ("arxiv", "repo", "number"):
        only_a = sorted(fa[kind] - fb[kind])
        only_b = sorted(fb[kind] - fa[kind])
        both = sorted(fa[kind] & fb[kind])
        out["kinds"][kind] = {
            "both": both, "only_first": only_a, "only_second": only_b,
            # 비율은 참고로만 적는다. 이걸로 합격·불합격을 가르지 않는다.
            "agree": (len(both) / len(fa[kind] | fb[kind])) if (fa[kind] | fb[kind]) else None,
        }
    out["shaky"] = sorted(
        set(out["kinds"]["arxiv"]["only_first"]) | set(out["kinds"]["arxiv"]["only_second"]))
    return out


def _in_sources(p: dict, did: str, ids: list[str]) -> tuple[list[str], list[str]]:
    """흔들린 인용을 '근거에 있던 것' 과 '없던 것' 으로 가른다.

    처음엔 한 번만 나온 arXiv 번호를 모두 "지어냈거나 우연히 집힌 것" 으로
    적었다. 실측해 보니 틀렸다 — `2505.17714`(PPO-BR)는 **실재하고 근거
    자료에도 있었다.** 두 번째 글이 빠뜨린 것뿐이었다.

    둘은 성격이 전혀 다르다.

      근거에 있음  → 한쪽이 **빠뜨린** 것. 글이 덜 꼼꼼했다는 뜻이지
                     사실이 틀린 것은 아니다.
      근거에 없음  → 한쪽이 **지어낸** 것. 이쪽이 진짜 경고다.

    섞어서 경고하면 멀쩡한 인용까지 의심하게 되고, 그러면 경고 자체를
    무시하게 된다.
    """
    src = (p.get("sources_by_d") or {}).get(did) or p.get("sources") or ""
    inside = [i for i in ids if i in src]
    outside = [i for i in ids if i not in src]
    return inside, outside


def run(pid: str, did: str) -> dict:
    """산출물 하나를 같은 조건으로 한 번 더 쓰게 하고 견준다.

    **원본을 건드리지 않는다.** 재생성 결과는 프로젝트의 `consistency` 에만
    저장하고 `artifacts` 는 그대로 둔다 — 시험이 산출물을 바꾸면 시험이
    아니라 재작성이 된다.
    """
    sys.path.insert(0, str(ROOT / "bridge"))
    import project_runner as pr
    from shared_memory import projects

    p = projects.get(pid)
    if p is None:
        return {"error": f"없는 프로젝트: {pid}"}
    d = next((x for x in (p.get("plan") or {}).get("deliverables") or []
              if x.get("id") == did), None)
    if d is None:
        return {"error": f"없는 산출물: {did}"}
    first = (p.get("artifacts") or {}).get(did) or ""
    if not first:
        return {"error": "원본 산출물이 비어 있습니다"}

    # 같은 조건으로 다시 쓴다. cursor 를 그 산출물에 맞춰 두어야
    # _grounding 과 _handoff 가 같은 자료를 집는다.
    probe = dict(p)
    ds = (p.get("plan") or {}).get("deliverables") or []
    probe["cursor"] = next(i for i, x in enumerate(ds) if x.get("id") == did)
    probe["phase"] = "draft"
    probe["last_feedback"] = ""          # 첫 초안과 같은 조건으로

    system, user = pr.draft_prompt(probe, d)
    second, exhausted = pr._ask(probe, d["dept"], system, user,  # noqa: SLF001
                                max_tokens=pr.DRAFT_MAX_TOKENS, allow_local=True)
    if exhausted:
        return {"error": "할당량이 바닥나 재생성하지 못했습니다"}

    second = pr._unwrap(second)          # noqa: SLF001
    res = compare(first, second)
    # 흔들린 인용을 '빠뜨림' 과 '지어냄' 으로 가른다(함수 주석 참고).
    res["missed"], res["invented"] = _in_sources(p, did, res.get("shaky") or [])
    res["at"] = __import__("time").time()
    res["model"] = (probe.get("last_call") or {}).get("model", "")
    res["temperature"] = (probe.get("last_call") or {}).get("temperature")

    store = dict(p.get("consistency") or {})
    store[did] = res
    projects.update(pid, {"consistency": store})
    return res


def summary_md(res: dict) -> str:
    """방법 절에 넣을 한 덩어리."""
    if not res or res.get("error"):
        return ""
    L = ["- **반복 실행 일관성을 시험했습니다.** 같은 조건으로 한 번 더 쓰게 하고 "
         "사실 조각을 견줬습니다 (글투는 매번 다르므로 세지 않습니다)."]
    a = res["kinds"]["arxiv"]
    if a["both"] or a["only_first"] or a["only_second"]:
        L.append(f"  - arXiv 인용: 두 번 다 나온 것 {len(a['both'])}건, "
                 f"한 번만 나온 것 {len(a['only_first']) + len(a['only_second'])}건")
    if res.get("invented"):
        L.append("  - ⚠️ **한 번만 나왔고 근거 자료에도 없는 arXiv 번호** — "
                 "지어낸 것일 수 있습니다. 그대로 믿지 마세요: "
                 + ", ".join(f"`{x}`" for x in res["invented"][:8]))
    if res.get("missed"):
        L.append("  - 한 번만 나왔으나 **근거 자료에는 있던** 번호 — 한쪽 글이 "
                 "빠뜨린 것입니다(사실이 틀린 것은 아닙니다): "
                 + ", ".join(f"`{x}`" for x in res["missed"][:8]))
    r = res["kinds"]["repo"]
    if r["only_first"] or r["only_second"]:
        L.append(f"  - 한 번만 나온 저장소·고유명사 "
                 f"{len(r['only_first']) + len(r['only_second'])}건")
    L.append(f"  - 분량: {res['chars'][0]:,}자 / {res['chars'][1]:,}자")
    return "\n".join(L)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    if len(sys.argv) < 3:
        raise SystemExit("사용: python consistency.py <pid> <did>")
    import json
    out = run(sys.argv[1], sys.argv[2])
    print(json.dumps(out, ensure_ascii=False, indent=2)[:1800])
    print()
    print(summary_md(out))
