"""사람이 표본을 검증한다 — ISPOR ⑤, RAISE 2(사람의 감독).

## 왜 필요한가

명테크의 검토는 **모델끼리** 한다. 부서 1차도 오케스트레이터 2차도 모델이고,
사람의 눈은 착수 승인과 파일 저장 결재 두 지점에만 있다. 방법 절이 그걸
그대로 적고 있었다 — "검토는 사람이 하지 않았습니다".

ISPOR 가 RAISE 의 근거 기반을 감사하며 쓴 8개 축 중 하나가 **인간 또는
벤치마크 기준(human reference standard)** 이다. 실측으로 평가 30건 중
23건(77%)이 이걸 뒀다. 우리는 0이었다.

## 역할을 나눈다

산출물의 주장은 이런 모양이다.

    * **논문에서 제안됨**: PS-PPO (출처: `arXiv:2606.29758`).
      최종 결과를 대부분 결정하는 중간 접두사를 샘플링하여 …

여기서 물어야 할 것은 둘이다.

  1. **그 논문이 실재하는가** — 기계가 할 수 있다(arXiv API).
  2. **그 논문이 정말 그 말을 하는가** — 기계가 못 한다.

2번이 사람의 몫이다. 모델에게 "이거 맞아?" 를 물으면 맞다고 한다 — 그 답은
점수와 같은 성질이라 아무것도 보태지 않는다. 그래서 이 모듈은 **1번을 자동으로
확인해 실제 제목·초록을 나란히 놓고, 2번만 사람에게 묻는다.**

## 표본이다 — 전수가 아니다

인용이 25건인 산출물도 있다. 전부 확인하시게 하면 아무도 안 한다. 기본
5건을 고르되 **무작위가 아니라**:

  · 일관성 시험에서 흔들린 것 먼저 — 가장 의심스러운 것
  · 근거 자료에 없던 것 — 지어냈을 가능성
  · 그다음은 등장 순서대로

표본이라는 사실은 방법 절에 그대로 적는다. "5건 중 5건 확인" 이 "모두
사실" 을 뜻하지 않는다는 것을 숨기면 안 된다.
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

ARXIV_API = "https://export.arxiv.org/api/query"
UA = "myung-tech-verify/1.0"
SAMPLE = 5                 # 기본 표본 크기
# arXiv 조회 재시도.
#
# 표본 5건 중 2건이 "(찾지 못함)" 으로 나왔는데, 사유는 `HTTP 429` 와
# `read operation timed out` 이었다 — **둘 다 실재하는 논문이다.** 조회
# 실패가 "논문 없음" 과 똑같이 보이면 사장님이 멀쩡한 논문을 "지어냈다" 고
# 표시하게 된다. 사람에게 판단을 맡기는 기능에서 그건 치명적이다 — 사람의
# 판단이 기계의 실패를 그대로 물려받고, 검증 장치가 오히려 잘못된 확신을
# 만든다.
LOOKUP_RETRIES = 2
LOOKUP_WAIT = 20           # 초. 429 는 기다리면 풀린다 — 짧게 잡으면 재시도도 같이 막힌다
CONTEXT_BEFORE = 220       # 주장 문맥으로 앞에서 가져올 글자 수
CONTEXT_AFTER = 120

CITE = re.compile(r"(?:arXiv:)?\[?(\d{4}\.\d{4,5})(?:v\d+)?\]?")

# 받아 둔 논문. 제목과 초록은 바뀌지 않으므로 다시 물을 이유가 없다.
#
# arXiv 가 이 IP 를 막은 적이 있다 — `Rate exceeded` (HTTP 429). 인용 25건을
# 전수 대조하며 쓴 할당량 때문이었는데, 캐시가 없으면 사장님이 검증 화면을
# 여실 때마다 같은 일이 난다.
#
# **실패는 캐시하지 않는다.** 저장하면 "조회 못 함" 이 영구히 굳는다 —
# 임베딩 캐시에서 해시를 성공 전에 적었다가 211건이 영원히 0건으로 남을
# 뻔한 것과 같은 함정이다.
CACHE = Path(__file__).resolve().parent / "store" / "arxiv_cache.json"

VERDICT = {
    "ok": "논문이 그 말을 한다",
    "wrong": "논문이 그 말을 하지 않는다",
    "unsure": "판단 보류",
}


def _cache_path() -> Path:
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    return CACHE


def _cache_load() -> dict:
    try:
        return json.loads(_cache_path().read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def _cache_put(aid: str, rec: dict) -> None:
    # 성공한 것만. 실패를 저장하면 영구히 굳는다(CACHE 주석 참고).
    if rec.get("found") is None:
        return
    try:
        d = _cache_load()
        d[aid] = rec
        tmp = _cache_path().with_suffix(".tmp")
        tmp.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
        tmp.replace(_cache_path())
    except OSError:
        pass


def _arxiv(aid: str) -> dict:
    """arXiv 에서 제목·초록을 받아 온다.

    `found` 는 셋이다 — True(있음) / False(arXiv 에 없음) / **None(조회 못 함)**.
    세 번째를 두 번째와 섞으면 안 된다(LOOKUP_RETRIES 주석 참고).
    """
    hit = _cache_load().get(aid)
    if hit is not None:
        return {**hit, "cached": True}

    url = f"{ARXIV_API}?id_list={aid}"
    last = ""
    xml = ""
    for attempt in range(LOOKUP_RETRIES + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                xml = r.read().decode("utf-8", errors="replace")
            break
        except (urllib.error.URLError, OSError, TimeoutError) as exc:
            last = str(exc)[:120]
            if attempt < LOOKUP_RETRIES:
                time.sleep(LOOKUP_WAIT * (attempt + 1))
    else:
        # 조회 못 한 것이지 논문이 없는 것이 아니다.
        return {"found": None, "error": last}
    if not xml:
        return {"found": None, "error": last or "빈 응답"}

    entry = re.search(r"<entry>(.*?)</entry>", xml, re.S)
    if not entry:
        _cache_put(aid, {"found": False})
        return {"found": False}

    def pick(tag: str) -> str:
        m = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", entry.group(1), re.S)
        return " ".join(re.sub(r"<[^>]+>", "", m.group(1)).split()) if m else ""

    title = pick("title")
    if not title:
        _cache_put(aid, {"found": False})
        return {"found": False}
    # arXiv 는 없는 id 에 "Error" 제목을 돌려준다. 다만 제목에 Error 가
    # 들어간 진짜 논문도 있으므로("Error Analysis of …") 앞부분만 본다.
    if title.strip().lower().startswith("error"):
        _cache_put(aid, {"found": False})
        return {"found": False}
    rec = {
        "found": True,
        "title": title,
        "summary": pick("summary")[:900],
        "published": pick("published")[:10],
        "url": f"https://arxiv.org/abs/{aid}",
    }
    _cache_put(aid, rec)
    return rec


def extract_claims(body: str, limit: int = SAMPLE,
                   prefer: list[str] | None = None) -> list[dict]:
    """산출물에서 사람이 확인할 주장을 뽑는다.

    `prefer` 에 든 arXiv 번호를 앞세운다 — 일관성 시험에서 흔들렸거나 근거
    자료에 없던 것들이다. 무작위로 고르면 가장 의심스러운 것을 놓친다.
    """
    seen: dict[str, dict] = {}
    for m in CITE.finditer(body or ""):
        aid = m.group(1)
        if aid in seen:
            continue
        s = max(0, m.start() - CONTEXT_BEFORE)
        e = min(len(body), m.end() + CONTEXT_AFTER)
        seen[aid] = {
            "id": aid,
            # 주장은 문맥째로 보여 준다. 번호만 보여 주면 "이 논문이 무슨
            # 말을 한다고 적혀 있는지" 를 사람이 찾아 올라가야 한다.
            "claim": "…" + " ".join(body[s:e].split()) + "…",
        }
    order = [a for a in (prefer or []) if a in seen] + \
            [a for a in seen if a not in (prefer or [])]
    return [seen[a] for a in order[:limit]]


def build(p: dict, did: str, limit: int = SAMPLE) -> dict:
    """검증 화면이 쓸 자료 — 주장과 실제 논문을 나란히.

    arXiv 조회는 한 건당 3초를 쉰다(그쪽 안내대로). 5건이면 15초쯤 걸린다.
    """
    body = (p.get("artifacts") or {}).get(did) or ""
    if not body:
        return {"error": "산출물이 비어 있습니다", "claims": []}

    # 의심스러운 것 먼저. 일관성 시험 결과가 있으면 그걸 쓴다.
    cons = (p.get("consistency") or {}).get(did) or {}
    prefer = list(cons.get("invented") or []) + list(cons.get("missed") or [])

    src = (p.get("sources_by_d") or {}).get(did) or p.get("sources") or ""
    claims = extract_claims(body, limit=limit, prefer=prefer)

    done = ((p.get("verified") or {}).get(did) or {}).get("claims") or {}
    for c in claims:
        c["paper"] = _arxiv(c["id"])
        # 근거 자료에 있었는지 — 사람이 "이건 어디서 왔나" 를 가늠하는 데 쓴다.
        c["in_sources"] = c["id"] in src
        prev = done.get(c["id"]) or {}
        c["verdict"] = prev.get("verdict") or ""
        c["note"] = prev.get("note") or ""
        # 캐시에서 나왔으면 쉴 이유가 없다 — arXiv 를 부르지 않았다.
        if not (c["paper"] or {}).get("cached"):
            # arXiv 안내는 3초이지만 여러 건을 연달아 물으면 429 가 난다.
            # 사람이 기다리는 화면이라 느린 것보다 틀린 것이 나쁘다.
            time.sleep(6)

    total = len(set(CITE.findall(body)))
    return {
        "claims": claims,
        "total_cites": total,
        "sampled": len(claims),
        # 표본이라는 사실을 데이터에 박아 둔다. 화면이 빠뜨려도 방법 절은 적는다.
        "is_sample": total > len(claims),
    }


def record(pid: str, did: str, verdicts: dict, who: str = "사장님") -> dict:
    """사람의 판정을 저장한다. 누가 언제 했는지와 함께.

    `decided_by` 와 같은 발상이다 — 검증했다는 주장만 있고 누가 했는지가
    없으면, 사후에 "이건 사람이 본 것인가" 를 물을 수 없다.
    """
    from shared_memory import projects
    p = projects.get(pid)
    if p is None:
        return {"error": f"없는 프로젝트: {pid}"}

    store = dict(p.get("verified") or {})
    cur = dict(store.get(did) or {})
    claims = dict(cur.get("claims") or {})
    for aid, v in (verdicts or {}).items():
        verdict = (v or {}).get("verdict") if isinstance(v, dict) else v
        if verdict not in VERDICT:
            continue
        claims[str(aid)] = {
            "verdict": verdict,
            "note": str((v or {}).get("note") or "")[:300] if isinstance(v, dict) else "",
            "at": time.time(),
            "by": who,
        }
    cur["claims"] = claims
    cur["at"] = time.time()
    cur["by"] = who
    store[did] = cur
    projects.update(pid, {"verified": store})
    return summary(p | {"verified": store}, did)


def summary(p: dict, did: str) -> dict:
    """판정 집계. 판정하지 않고 세기만 한다."""
    cur = (p.get("verified") or {}).get(did) or {}
    claims = cur.get("claims") or {}
    counts = {k: 0 for k in VERDICT}
    for v in claims.values():
        if v.get("verdict") in counts:
            counts[v["verdict"]] += 1
    body = (p.get("artifacts") or {}).get(did) or ""
    return {
        "checked": len(claims),
        "total_cites": len(set(CITE.findall(body))),
        "counts": counts,
        "by": cur.get("by") or "",
        "at": cur.get("at") or 0,
        "wrong_ids": sorted(a for a, v in claims.items() if v.get("verdict") == "wrong"),
        "unsure_ids": sorted(a for a, v in claims.items() if v.get("verdict") == "unsure"),
    }


def summary_md(p: dict, did: str) -> str:
    """방법 절에 넣을 한 덩어리. 없으면 빈 문자열."""
    s = summary(p, did)
    if not s["checked"]:
        return ""
    c = s["counts"]
    L = [f"- **사람이 표본을 검증했습니다** — 인용 {s['total_cites']}건 중 "
         f"{s['checked']}건을 {s['by'] or '사람'}이 직접 확인했습니다 "
         f"({time.strftime('%Y-%m-%d %H:%M', time.localtime(s['at']))} 한국 시간)."]
    L.append(f"  - 논문이 그 말을 한다 {c['ok']} · 하지 않는다 {c['wrong']} · "
             f"판단 보류 {c['unsure']}")
    if s["wrong_ids"]:
        L.append("  - ⚠️ **사람이 틀렸다고 본 인용** — 이 부분은 믿지 마세요: "
                 + ", ".join(f"`{x}`" for x in s["wrong_ids"]))
    if s["unsure_ids"]:
        L.append("  - 판단 보류: " + ", ".join(f"`{x}`" for x in s["unsure_ids"])
                 + " — arXiv 조회가 실패한 건이 섞여 있을 수 있습니다. "
                   "조회 실패는 '논문 없음' 이 아닙니다.")
    if s["total_cites"] > s["checked"]:
        L.append(f"  - **표본입니다.** 나머지 {s['total_cites'] - s['checked']}건은 "
                 "확인되지 않았습니다 — 확인한 것이 다 맞았다고 전체가 맞는 것은 "
                 "아닙니다.")
    return "\n".join(L)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    from shared_memory import projects
    if len(sys.argv) < 3:
        raise SystemExit("사용: python verify.py <pid> <did>")
    proj = projects.get(sys.argv[1])
    if proj is None:
        raise SystemExit("프로젝트를 찾지 못했습니다.")
    out = build(proj, sys.argv[2])
    for c in out.get("claims", []):
        pap = c.get("paper") or {}
        print(f"── arXiv:{c['id']}  "
              f"{'근거 자료에 있음' if c['in_sources'] else '근거 자료에 없음'}")
        print(f"   문서의 주장: {c['claim'][:200]}")
        print(f"   실제 논문  : {pap.get('title', '(찾지 못함)')[:90]}")
        print()
    print(json.dumps({k: v for k, v in out.items() if k != "claims"},
                     ensure_ascii=False))
