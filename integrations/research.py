"""서베이용 바깥 조회 — arXiv 전문 검색 · GitHub 공개 저장소 검색.

지금까지 프로젝트의 근거는 **우리 위키 안**이 전부였다. 그래서 "강화학습
서베이" 를 시키면 위키에 있는 211편만 보고 쓴다. 위키는 매일 수집으로 쌓이지만
수집 기준이 좁고(도메인 필터), 들어오는 데 하루가 걸리고, 코드 구현은 아예
들어오지 않는다.

서베이는 그래서는 안 된다. **지금 arXiv 에 무엇이 있는지 직접 묻고**, 그
기법이 실제로 구현돼 있는지 GitHub 에서 확인하는 것이 서베이다.

## 왜 Google Scholar 는 없나

Scholar 에는 공개 API 가 없다. 긁어 오는 것은 이용약관 위반이고, 실제로도
CAPTCHA 로 막혀 안정적으로 되지 않는다. 그래서 여기에 넣지 않았다.

대신 **이미 있는 길이 Scholar 를 담당한다** — 사장님이 Scholar 에 걸어 두신
알림이 메일로 오고, `scripts/scholar_alerts.py` 가 그걸 읽어 arXiv 로 되찾아
위키에 넣는다(새벽 cron). Scholar 가 고른 것이 하루 뒤 위키에서 검색된다.
즉 Scholar 는 **수집 쪽**에 있고, 이 모듈은 **조회 쪽**에 있다.

그 경로가 지금 무엇을 담당하는지는 `scholar_note()` 가 프롬프트에 적어 준다 —
적어 두지 않으면 "Scholar 도 봤다" 고 모델이 쓸 수 있다.

## 설정이 필요 없다

arXiv API 는 키가 없다. GitHub 검색도 비로그인으로 시간당 10회까지 되고,
`GITHUB_TOKEN` 이 있으면 그걸 쓴다(이미 저장돼 있다). 그래서 `required` 가
비어 있고, 사장님이 하실 일이 없다.
"""
from __future__ import annotations

import datetime as _dt
import json
import re
import urllib.error
import urllib.parse
import urllib.request

from .base import Integration, Probe, env, register, truncate

ARXIV_API = "https://export.arxiv.org/api/query"
GH_SEARCH = "https://api.github.com/search/repositories"
UA = "myung-tech-research/1.0 (+https://github.com/)"
TIMEOUT = 25

# 한 번에 가져올 양. 서베이라도 프롬프트에 들어갈 자리가 한정돼 있다.
ARXIV_N = 8
# "최근" 의 범위. 반년으로 잡은 것은, 더 좁히면 주제에 따라 0건이 나오고
# 더 넓히면 "최근" 이라는 말이 무의미해지기 때문이다.
RECENT_DAYS = 180
GH_N = 5

# 이 말이 나오면 바깥을 본다. 비워 두면 모든 프로젝트가 매번 arXiv 를
# 두드리게 되고, 그건 느리기도 하거니와 arXiv 에 폐가 된다.
TRIGGERS = (
    "서베이", "survey", "동향", "최근", "최신", "리뷰", "review",
    "조사", "논문", "paper", "arxiv", "연구", "기술 분석", "트렌드",
    "github", "깃헙", "구현체", "오픈소스", "레퍼런스 구현",
)


def _get(url: str, headers: dict | None = None) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": UA, **(headers or {})})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return r.read().decode("utf-8", errors="replace")


# ── 질의 만들기 ──────────────────────────────────────────────────────
#
# 산출물 설명은 한국어 두세 문장이다. 그걸 그대로 arXiv 에 던지면 0건이 온다 —
# arXiv 는 영어 색인이다. 한국어에서 영어 검색어를 뽑아야 하는데, 여기서
# LLM 을 부르면 조회 한 번에 호출 하나가 더 들고 그만큼 예산이 마른다.
#
# 그래서 지식베이스가 이미 쓰고 있는 한영 대응어 사전을 빌려 쓴다. 사전에
# 없는 말은 못 찾지만, 서베이 주제는 대개 그 사전이 다루는 분야다. 영문
# 약어·고유명사(PPO, GRPO, VLA)는 원문에 그대로 있으므로 같이 뽑는다.
_LATIN = re.compile(r"[A-Za-z][A-Za-z0-9\-]{1,}")

# arXiv 전체 색인에서 아무거나 물어 오는 낱말들. 실측으로 모았다 —
# `critic` 이 "critical Sobolev coefficients" 를, `policy` 가 "public policy" 를
# 끌고 왔다. 분야어처럼 보이지만 단독으로는 변별력이 없다.
_WEAK = {"the", "and", "for", "with", "from", "that", "this",
         "critic", "policy", "value", "model", "models", "method", "methods",
         "advantage", "learning", "deep", "neural", "network", "networks",
         "data", "based", "using", "approach", "system", "systems"}


def _terms(text: str) -> list[str]:
    """한국어 설명에서 영어 검색어를 뽑는다."""
    out: list[str] = []

    # 1) 원문에 이미 있는 영문 토큰 (PPO, GRPO, DPO, VLA, LLM …)
    #
    # 짧고 흔한 낱말은 뺀다. `critic` 을 넣었더니 arXiv 가 "critical Sobolev
    # coefficients" 를 물어 왔고, `policy` 는 "public policy" 까지 끌고 왔다.
    # 대문자 약어는 길이가 짧아도 남긴다 — PPO·DPO·VLA 가 가장 쓸모 있는
    # 검색어인데 그걸 빼면 질의가 뭉툭해진다.
    for t in _LATIN.findall(text or ""):
        if t.lower() in _WEAK:
            continue
        if t.isupper() and len(t) >= 2:
            out.append(t)                      # 약어
        elif len(t) >= 6:
            out.append(t)                      # 일반 낱말은 충분히 길 때만

    # 2) 한국어 → 영어 대응어. 지식베이스의 사전을 그대로 쓴다 —
    #    두 벌로 갈리면 "위키에서는 찾는데 arXiv 에서는 못 찾는" 상태가 된다.
    try:
        import knowledge_base as kb
        low = (text or "").lower()
        for ko, ens in getattr(kb, "_KO_EN", {}).items():
            if ko in low:
                out += ens
    except Exception:  # noqa: BLE001
        pass

    # 중복을 지우되 순서는 지킨다 — 앞쪽이 더 구체적인 말일 때가 많다.
    seen, uniq = set(), []
    for t in out:
        k = t.lower()
        if k not in seen:
            seen.add(k)
            uniq.append(t)
    return uniq[:6]


# ── arXiv ────────────────────────────────────────────────────────────

def _arxiv_once(expr: str, n: int, sort: str) -> list[dict]:
    url = f"{ARXIV_API}?" + urllib.parse.urlencode({
        "search_query": expr, "start": 0, "max_results": n,
        "sortBy": sort, "sortOrder": "descending",
    })
    try:
        xml = _get(url)
    except (urllib.error.URLError, OSError, TimeoutError):
        return []

    out = []
    for entry in re.findall(r"<entry>(.*?)</entry>", xml, re.S):
        def pick(tag: str) -> str:
            m = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", entry, re.S)
            return " ".join(re.sub(r"<[^>]+>", "", m.group(1)).split()) if m else ""
        aid = pick("id").rsplit("/", 1)[-1]
        out.append({
            "id": aid,
            "title": pick("title"),
            "published": pick("published")[:10],
            "summary": pick("summary")[:700],
            "authors": re.findall(r"<name>(.*?)</name>", entry)[:4],
        })
    return out


def arxiv_search(query: str, n: int = ARXIV_N) -> list[dict]:
    """arXiv 를 **두 번** 묻는다 — 정석 문헌과 최전선.

    처음엔 최신순 한 번만 물었다. 그랬더니 "정책 최적화 서베이" 에 양자 회로와
    타원 방정식 논문이 올라왔다. 짧은 낱말(`critic`, `policy`)이 OR 로 들어가
    아무거나 걸렸고, 최신순이라 그중 어제 올라온 것이 뽑힌 것이다 — 사실상
    arXiv 어제치 덤프를 받은 셈이다.

    실측으로 고른 구성:

        relevance / OR   PPO-BR · Scaf-GRPO · N-GRPO · "Is DPO Superior to PPO"
        submitted / OR   KnowGPO · EliteReplay (2026-10-15, 관련 있음)

    서베이에는 둘 다 필요하다. 정석만 보면 지금 무엇이 바뀌는지 모르고,
    최신만 보면 왜 그렇게 됐는지 모른다. 그래서 반반 섞는다.

    호출이 둘로 늘지만 arXiv API 는 무료이고 LLM 호출이 아니다 — 예산과 무관하다.
    """
    terms = _terms(query)
    if not terms:
        return []
    # all: 로 묶어 OR 로 던진다. AND 로 묶으면 여섯 단어가 모두 들어간 논문만
    # 찾게 되어 거의 늘 0건이거나, 운 좋게 걸려도 2017년 논문이 온다(실측).
    expr = " OR ".join(f'all:"{t}"' for t in terms)
    half = max(2, n // 2)

    # 최신 쪽은 "최신순 정렬" 이 아니라 **최근 구간 안에서 관련도순**으로 묻는다.
    #
    # 최신순 정렬은 "아무 단어나 매치된 것 중 가장 새것" 을 준다. 그래서
    # "모방학습·세계모델 동향" 에 확산 모델 캐싱 논문이 올라왔다 — 어제치
    # arXiv 덤프에서 OR 하나가 걸린 것이다. 날짜로 먼저 좁히고 그 안에서
    # 관련도를 보면 "요즘 이 주제에서 나온 것" 이 된다.
    #
    # arXiv 는 search_query 안에서 submittedDate 범위를 받는다.
    since = (_dt.datetime.now(_dt.timezone.utc)
             - _dt.timedelta(days=RECENT_DAYS)).strftime("%Y%m%d")
    until = _dt.datetime.now(_dt.timezone.utc).strftime("%Y%m%d")
    recent_expr = f"({expr}) AND submittedDate:[{since}0000 TO {until}2359]"

    seen: set[str] = set()
    out: list[dict] = []
    for ex, tag in ((expr, "관련도순"), (recent_expr, f"최근 {RECENT_DAYS}일")):
        for p in _arxiv_once(ex, half, "relevance"):
            key = re.sub(r"v\d+$", "", p["id"])
            if key in seen:
                continue
            seen.add(key)
            p["via"] = tag
            out.append(p)
    return out


# ── GitHub 공개 저장소 ───────────────────────────────────────────────

def github_search(query: str, n: int = GH_N) -> list[dict]:
    """별 많은 순 공개 저장소. 토큰이 있으면 쓰고 없으면 비로그인으로.

    왜 서베이에 코드가 필요한가 — 논문만 읽으면 "제안됐다" 와 "쓰인다" 를
    구분할 수 없다. 구현체가 있고 별이 붙어 있다는 것은 남들이 실제로 돌려
    봤다는 뜻이고, 서베이에서 그건 논문 한 편만큼 값진 사실이다.
    """
    terms = _terms(query)
    if not terms:
        return []
    q = " ".join(terms[:3])
    url = f"{GH_SEARCH}?" + urllib.parse.urlencode({
        "q": q, "sort": "stars", "order": "desc", "per_page": n,
    })
    headers = {"Accept": "application/vnd.github+json"}
    tok = env("GITHUB_TOKEN")
    if tok:
        headers["Authorization"] = f"Bearer {tok}"
    try:
        data = json.loads(_get(url, headers))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return []
    return [{
        "full_name": it.get("full_name", ""),
        "stars": it.get("stargazers_count", 0),
        "desc": (it.get("description") or "")[:200],
        "lang": it.get("language") or "",
        "pushed": (it.get("pushed_at") or "")[:10],
        "url": it.get("html_url", ""),
    } for it in (data.get("items") or [])[:n]]


# ── Scholar 는 여기 없다 ─────────────────────────────────────────────

def scholar_note() -> str:
    """Scholar 를 어떻게 다루는지 프롬프트에 분명히 적는다.

    적어 두지 않으면 모델이 "Google Scholar 를 검색한 결과" 라고 쓴다.
    실제로는 안 봤으므로 그건 지어낸 문장이고, 검토자도 같은 자료를 보니
    잡아내지 못한다 — 근거 강제가 통하지 않는 구멍이 된다.
    """
    return ("Google Scholar 는 공개 API 가 없어 이 조회에 포함되지 않았습니다. "
            "대신 사장님이 Scholar 에 설정하신 알림이 메일로 들어와 매일 "
            "자동으로 위키에 쌓이므로, 지식베이스 쪽 자료에 이미 반영돼 "
            "있습니다. **\"Scholar 를 검색했다\" 고 쓰지 마세요.**")


# ── 프롬프트 블록 ────────────────────────────────────────────────────

def context(query: str = "") -> str:
    low = (query or "").lower()
    if not any(w in low for w in TRIGGERS):
        return ""

    papers = arxiv_search(query)
    repos = github_search(query)
    if not papers and not repos:
        return ""

    parts = ["# 바깥 조회 결과 (서베이용)", ""]

    if papers:
        parts.append(f"## arXiv — 최신순 {len(papers)}건")
        parts.append("")
        for p in papers:
            who = ", ".join(p["authors"]) + (" 외" if len(p["authors"]) >= 4 else "")
            parts.append(f"### {p['title']}")
            parts.append(f"- arXiv:{p['id']} · {p['published']} · {who}"
                         f" · {p.get('via', '')}")
            parts.append(f"- 초록: {p['summary']}")
            parts.append("")

    if repos:
        parts.append(f"## GitHub — 별 많은 순 {len(repos)}건")
        parts.append("")
        for r in repos:
            parts.append(f"- **{r['full_name']}** ★{r['stars']:,} · "
                         f"{r['lang'] or '언어 미상'} · 최근 커밋 {r['pushed']}")
            if r["desc"]:
                parts.append(f"  {r['desc']}")
            parts.append(f"  {r['url']}")
        parts.append("")

    parts.append("---")
    parts.append(scholar_note())
    return "\n".join(parts)


def probe() -> Probe:
    """arXiv 에 실제로 한 번 물어본다. 키가 없는 연동이라 이것이 유일한 확인이다."""
    try:
        got = arxiv_search("reinforcement learning", n=1)
    except Exception as exc:  # noqa: BLE001
        return Probe(False, f"arXiv 조회 실패: {exc}")
    if not got:
        return Probe(False, "arXiv 가 결과를 주지 않았습니다")
    tok = "토큰 있음" if env("GITHUB_TOKEN") else "비로그인(시간당 10회)"
    return Probe(True, f"arXiv 정상 · GitHub 검색 {tok}")


register(Integration(
    name="research",
    label="논문·코드 조회 (arXiv · GitHub)",
    icon="🔬",
    required=[],                     # 키가 필요 없다
    optional=["GITHUB_TOKEN"],       # 있으면 GitHub 검색 한도가 늘어난다
    probe=probe,
    context=context,
    docs="research",
))
