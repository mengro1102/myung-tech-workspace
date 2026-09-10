#!/usr/bin/env python3
"""
Shared knowledge base accessor — Myung-Tech ↔ mrlee-wiki-graphrag.

명테크 멀티에이전트 프레임워크가 GraphRAG 지식베이스(`mrlee-wiki-graphrag`)를
**경로 참조**로 사용하기 위한 가벼운 접근 모듈. 외부 의존성 없음(표준 라이브러리만).

- 지식베이스는 별도 위치(D:\\AI_Workspace\\mrlee-wiki-graphrag)에 있고, 자체 GitHub
  repo로 PC2/모바일과 동기화된다. 이 모듈은 그 폴더를 **복사하지 않고 참조**한다.
- 경로는 환경변수 `GRAPHRAG_KB_PATH`로 재정의 가능(미설정 시 기본 경로 사용) —
  프레임워크의 기존 `os.environ.get(...)` 설정 관례를 따른다.

사용 예 (각 부서 에이전트에서):
    from knowledge_base import KB_PATH, list_nodes, read_node, search
    for slug in list_nodes("concepts"):
        ...
    text = read_node("concepts/transformer")
    hits = search("attention")

GraphRAG 검색 (그래프 순회 기반):
    from knowledge_base import retrieve, build_context
    for doc in retrieve("PPO와 GRPO 차이", hops=1, include_body=False):
        print(doc["slug"], doc["score"], doc["why"])
    prompt_ctx = build_context("PPO와 GRPO 차이")

retrieve() 는 어휘 검색으로 씨앗 노드를 찾은 뒤 graph/graph.json 의
related/wikilink 엣지를 따라 이웃까지 확장한다. 어휘 검색만으로는 놓치는
"직접 언급되지 않았지만 구조적으로 연결된" 문서를 끌어온다.
그래프가 없거나 낡았으면 조용히 씨앗(어휘 검색)만으로 동작한다.
"""
from __future__ import annotations

import os
from pathlib import Path

# 기본 위치 우선순위:
# 1. 환경변수 GRAPHRAG_KB_PATH
# 2. 워크스페이스 내 로컬 KB (스크립트 위치 기준)
# 3. 레거시 절대 경로 (D:\AI_Workspace\mrlee-wiki-graphrag)
_SCRIPT_DIR = Path(__file__).resolve().parent
_LOCAL_KB   = _SCRIPT_DIR / "knowledge_base"
_LEGACY_KB  = r"D:\AI_Workspace\mrlee-wiki-graphrag"

def _resolve_kb_path() -> Path:
    env = (os.environ.get("GRAPHRAG_KB_PATH") or "").strip()
    if env:
        return Path(env)
    # 우선순위 탐색 (모든 플랫폼 공통)
    candidates = [
        Path(r"D:\AI_Workspace\mrlee-wiki-graphrag"),          # Windows 직접 접근
        Path("/mnt/d/AI_Workspace/mrlee-wiki-graphrag"),       # WSL → Windows 원본 KB
        _LOCAL_KB,                                              # 워크스페이스 내 로컬 KB
        Path("/mnt/d/myung-tech-workspace/knowledge_base"),    # WSL → 로컬 KB
    ]
    for p in candidates:
        try:
            if p.is_dir() and (p / "SCHEMA.md").exists():
                return p
        except Exception:
            pass
    return Path(_LEGACY_KB)

KB_PATH = _resolve_kb_path()

# 그래프의 주요 진입점(노드 카테고리 + 스키마/인덱스/로그).
# 사람이 정리한 노드. 위키의 본체다.
NODE_DIRS = ("concepts", "entities", "comparisons")

# 명테크가 쌓은 것. 검토를 통과한 프로젝트의 기록과 산출물이 여기 들어간다
# (shared_memory/experience.py). 큐레이션된 노드와 섞지 않고 따로 두되,
# **검색에는 함께 넣는다** — 넣지 않으면 쌓아도 아무도 못 읽는다.
EXPERIENCE_DIRS = ("raw/projects",)

# 검색·검색씨앗이 훑는 범위.
SEARCH_DIRS = NODE_DIRS + EXPERIENCE_DIRS
GRAPH_PATH = KB_PATH / "graph" / "graph.json"
SCHEMA_PATH = KB_PATH / "SCHEMA.md"
INDEX_PATH = KB_PATH / "index.md"
LOG_PATH = KB_PATH / "log.md"


def available() -> bool:
    """지식베이스가 실제로 참조 가능한 위치에 존재하는지."""
    return KB_PATH.is_dir() and SCHEMA_PATH.exists()


def _require() -> None:
    if not KB_PATH.is_dir():
        raise FileNotFoundError(
            f"GraphRAG knowledge base not found at {KB_PATH}. "
            f"Set GRAPHRAG_KB_PATH or clone mrlee-wiki-graphrag there."
        )


def list_nodes(category: str | None = None, *, experience: bool = True) -> list[str]:
    """노드 slug 목록 (예: 'concepts/transformer'). category로 한 종류만 조회 가능.

    experience=False 면 사람이 정리한 노드만. 위키 자체의 통계를 낼 때처럼
    "큐레이션된 것" 과 "쌓인 것" 을 구분해야 하는 자리에서 쓴다.
    """
    _require()
    cats = (category,) if category else (SEARCH_DIRS if experience else NODE_DIRS)
    out: list[str] = []
    for cat in cats:
        d = KB_PATH / cat
        if d.is_dir():
            out += [f"{cat}/{p.stem}" for p in sorted(d.glob("*.md"))]
    return out


def read_node(slug_or_relpath: str) -> str:
    """노드 본문 읽기. 'concepts/transformer' 또는 'concepts/transformer.md' 모두 허용."""
    _require()
    rel = slug_or_relpath if slug_or_relpath.endswith(".md") else slug_or_relpath + ".md"
    f = (KB_PATH / rel).resolve()
    if KB_PATH.resolve() not in f.parents:           # 경로 이탈 방지
        raise ValueError(f"path escapes knowledge base: {slug_or_relpath}")
    return f.read_text(encoding="utf-8")


def search(pattern: str, *, limit: int = 50) -> list[tuple[str, str]]:
    """노드 본문 단순 텍스트 검색. (relpath, 매칭 라인) 튜플 목록 반환.

    어휘 기반 1차 검색(시맨틱/벡터 검색은 향후 확장 항목 — 리뷰 리포트 P3 참조).
    """
    _require()
    needle = pattern.lower()
    hits: list[tuple[str, str]] = []
    for cat in SEARCH_DIRS:
        for p in (KB_PATH / cat).glob("*.md"):
            try:
                for line in p.read_text(encoding="utf-8").splitlines():
                    if needle in line.lower():
                        hits.append((f"{cat}/{p.stem}", line.strip()))
                        if len(hits) >= limit:
                            return hits
            except OSError:
                continue
    return hits


# ---------------------------------------------------------------------------
# GraphRAG — 그래프 순회 기반 검색
# ---------------------------------------------------------------------------
# 어휘 검색은 질의어가 본문에 그대로 있는 문서만 찾는다. 그래서 "PPO와 GRPO 차이"를
# 물으면 comparisons/grpo-vs-ppo.md 는 찾아도, 그 비교가 전제하는 actor-critic·
# value-function 은 놓친다. graph.json 의 엣지를 한두 홉 따라가면 그 전제들이 딸려온다.
# 이것이 이 저장소를 GraphRAG "자료원"이 아니라 실제 GraphRAG 로 쓰는 부분이다.

_GRAPH_CACHE: dict | None = None
_GRAPH_MTIME: float | None = None

# 홉 거리에 따른 점수 감쇠. 2홉까지만 의미 있게 본다.
_HOP_DECAY = 0.45
# 엣지 종류별 가중치 — frontmatter related 는 저자가 명시적으로 건 링크라
# 본문 [[wikilink]] 보다 신뢰도가 높다.
_EDGE_WEIGHT = {"related": 1.0, "wikilink": 0.8}


def load_graph(*, force: bool = False) -> dict:
    """graph/graph.json 로드 (mtime 기반 캐시). 없으면 빈 그래프를 돌려준다."""
    global _GRAPH_CACHE, _GRAPH_MTIME
    try:
        mtime = GRAPH_PATH.stat().st_mtime
    except OSError:
        return {"nodes": {}, "edges": []}
    if force or _GRAPH_CACHE is None or _GRAPH_MTIME != mtime:
        import json
        try:
            _GRAPH_CACHE = json.loads(GRAPH_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"nodes": {}, "edges": []}
        _GRAPH_MTIME = mtime
    return _GRAPH_CACHE


def graph_available() -> bool:
    """그래프를 실제로 순회할 수 있는지."""
    return bool(load_graph().get("nodes"))


def _tokenize(text: str) -> list[str]:
    import re
    raw = [t for t in re.split(r"[^0-9A-Za-z가-힣_.-]+", text.lower()) if t]
    # 한국어는 조사가 붙어 'ppo와'·'grpo의' 처럼 나온다. 원 토큰을 그대로 두되
    # 안에 든 라틴/숫자 덩어리를 따로 떼어내지 않으면 slug 'ppo' 와 매칭되지 않는다.
    out: list[str] = []
    for t in raw:
        out.append(t)
        for part in re.findall(r"[0-9A-Za-z_.-]{2,}", t):
            if part != t:
                out.append(part)
        for part in re.findall(r"[가-힣]{2,}", t):
            if part != t:
                out.append(part)
    return out


def _adjacency() -> dict[str, list[tuple[str, str]]]:
    """무방향 인접 리스트 {slug: [(이웃, 엣지종류), ...]}."""
    g = load_graph()
    adj: dict[str, list[tuple[str, str]]] = {}
    for e in g.get("edges", []):
        src, dst, kind = e.get("src"), e.get("dst"), e.get("type", "related")
        if not src or not dst:
            continue
        adj.setdefault(src, []).append((dst, kind))
        adj.setdefault(dst, []).append((src, kind))   # 역방향도 문맥이다
    return adj


def neighbors(slug: str, *, hops: int = 1) -> dict[str, tuple[int, str]]:
    """slug 에서 hops 이내 이웃. {이웃slug: (홉수, 엣지종류)} (자기 자신 제외)."""
    adj = _adjacency()
    seen: dict[str, tuple[int, str]] = {}
    frontier = [slug]
    for depth in range(1, max(1, hops) + 1):
        nxt: list[str] = []
        for node in frontier:
            for nb, kind in adj.get(node, []):
                if nb == slug or nb in seen:
                    continue
                seen[nb] = (depth, kind)
                nxt.append(nb)
        frontier = nxt
        if not frontier:
            break
    return seen


_EXP_CACHE: dict[str, dict] | None = None
_EXP_MTIME: float | None = None


def _experience_nodes() -> dict[str, dict]:
    """축적본을 graph.json 노드와 같은 모양으로. {slug: {title, path, type}}

    그래프 파일에는 넣지 않는다. graph.json 은 위키 파이프라인의 산출물이라
    다음 재생성 때 우리가 끼워 넣은 것이 사라진다. 여기서만 들고 있는다.
    """
    global _EXP_CACHE, _EXP_MTIME
    dirs = [KB_PATH / d for d in EXPERIENCE_DIRS]
    mtime = 0.0
    for d in dirs:
        try:
            mtime = max(mtime, d.stat().st_mtime)
        except OSError:
            continue
    if _EXP_CACHE is not None and _EXP_MTIME == mtime:
        return _EXP_CACHE

    out: dict[str, dict] = {}
    for cat, d in zip(EXPERIENCE_DIRS, dirs):
        if not d.is_dir():
            continue
        for p in sorted(d.glob("*.md")):
            title = p.stem.replace("-", " ")
            try:
                head = p.read_text(encoding="utf-8")[:400]
                for line in head.splitlines():
                    if line.startswith("title:"):
                        title = line.split(":", 1)[1].strip() or title
                        break
            except OSError:
                pass
            out[p.stem] = {"title": title, "path": f"{cat}/{p.name}",
                           "type": "experience", "tags": ["축적", "프로젝트"]}
    _EXP_CACHE, _EXP_MTIME = out, mtime
    return out


def _score_meta(terms: list[str], slug: str, meta: dict) -> float:
    """slug·제목·태그 매칭 점수. 그래프 노드와 축적본에 같은 자를 댄다."""
    title = str(meta.get("title") or slug).lower()
    tags = " ".join(str(t) for t in (meta.get("tags") or [])).lower()
    slug_l = slug.lower()
    s = 0.0
    for t in terms:
        if t in slug_l:
            s += 3.0
        if t in title:
            s += 2.5
        if t in tags:
            s += 1.5
    return s


def _seed_scores(query: str, *, max_seeds: int = 6) -> dict[str, float]:
    """어휘 매칭으로 씨앗 노드와 점수를 뽑는다.

    slug·제목 매치를 태그보다 높게 본다 — 저자가 그 문서의 주제라고 선언한 것이라서다.
    제목·태그로 아무것도 못 찾을 때만 본문까지 훑는다(느리므로 폴백).
    """
    terms = [t for t in _tokenize(query) if len(t) >= 2]
    if not terms:
        return {}
    scores: dict[str, float] = {}

    # 사람이 정리한 노드 + 우리가 쌓은 경험. 같은 자로 잰다.
    for pool in (load_graph().get("nodes") or {}, _experience_nodes()):
        for slug, meta in pool.items():
            s = _score_meta(terms, slug, meta)
            if s:
                scores[slug] = max(scores.get(slug, 0.0), s)

    if not scores:
        # 제목·태그로 못 찾으면 본문까지 훑는다. search() 는 구절을 통째로
        # 찾으므로 여러 단어짜리 질의는 늘 0건이 된다 — 낱말로 나눠 던진다.
        for t in terms:
            for relpath, _line in search(t, limit=12):
                key = relpath.split("/")[-1]
                scores[key] = scores.get(key, 0.0) + 1.0
    return dict(sorted(scores.items(), key=lambda kv: -kv[1])[:max_seeds])


def retrieve(
    query: str,
    *,
    hops: int = 1,
    limit: int = 8,
    include_body: bool = True,
    max_chars: int = 4000,
) -> list[dict]:
    """GraphRAG 검색 — 씨앗(어휘) 노드에서 그래프로 확장한 뒤 점수순 문서 목록.

    반환 항목: {slug, path, title, type, score, hop, why, body?}
    `why` 는 이 문서가 왜 선택됐는지에 대한 사람이 읽을 수 있는 사유(근거 추적용).
    그래프가 없으면 씨앗만 돌려주므로, 어휘 검색으로 자연히 열화된다.
    """
    _require()
    seeds = _seed_scores(query)
    if not seeds:
        return []

    nodes = dict(load_graph().get("nodes") or {})
    # 축적본은 그래프에 없으므로 여기서 합쳐 둔다. 엣지가 없어 늘 0홉이다.
    for slug, meta in _experience_nodes().items():
        nodes.setdefault(slug, meta)
    scored: dict[str, dict] = {
        slug: {"score": base, "hop": 0, "why": "질의어 직접 매치"}
        for slug, base in seeds.items()
    }

    if graph_available() and hops > 0:
        for slug, base in seeds.items():
            src_title = (nodes.get(slug) or {}).get("title", slug)
            for nb, (depth, kind) in neighbors(slug, hops=hops).items():
                gain = base * (_HOP_DECAY ** depth) * _EDGE_WEIGHT.get(kind, 0.8)
                cur = scored.get(nb)
                if cur is None or gain > cur["score"]:
                    scored[nb] = {
                        "score": gain,
                        "hop": depth,
                        "why": f"{src_title} 에서 {depth}홉 ({kind})",
                    }

    out: list[dict] = []
    for slug, info in sorted(scored.items(), key=lambda kv: -kv[1]["score"])[:limit]:
        meta = nodes.get(slug) or {}
        rel = meta.get("path") or ""
        if not rel:
            # 본문 폴백으로 잡힌 씨앗은 slug 만 있고 경로가 없다. 그대로 두면
            # 제목만 있고 내용이 빈 문서가 프롬프트에 들어간다.
            for cat in SEARCH_DIRS:
                cand = KB_PATH / cat / f"{slug}.md"
                if cand.exists():
                    rel = f"{cat}/{slug}.md"
                    break
        doc = {
            "slug": slug,
            "path": rel,
            "title": meta.get("title") or slug,
            "type": meta.get("type") or "",
            "score": round(info["score"], 3),
            "hop": info["hop"],
            "why": info["why"],
        }
        if include_body and rel:
            try:
                doc["body"] = read_node(rel)[:max_chars]
            except (OSError, ValueError):
                doc["body"] = ""
        out.append(doc)
    return out


def build_context(query: str, *, hops: int = 1, limit: int = 6,
                  budget_chars: int = 12000) -> str:
    """retrieve() 결과를 LLM 프롬프트에 바로 넣을 수 있는 문자열로 조립.

    문서마다 출처 경로를 머리에 달아, 모델이 인용할 때 경로를 지어내지 않게 한다.
    """
    docs = retrieve(query, hops=hops, limit=limit, include_body=True,
                    max_chars=max(800, budget_chars // max(1, limit)))
    if not docs:
        return ""
    parts = [f"# 지식베이스 검색 결과 — 질의: {query}", ""]
    used = 0
    for d in docs:
        chunk = (
            f"## {d['title']}\n"
            f"- 출처: `{d['path']}`\n"
            f"- 선택 사유: {d['why']} (score {d['score']})\n\n"
            f"{d.get('body') or ''}\n"
        )
        if used + len(chunk) > budget_chars:
            break
        parts.append(chunk)
        used += len(chunk)
    return "\n".join(parts)


def inject(title: str, content: str, *, source_url: str = "", subdir: str = "articles") -> str:
    """원시 지식을 GraphRAG `raw/` 레이어에 SCHEMA 규약대로 저장. relpath 반환.

    Connect AI의 'Brain 주입'(P-Reinforce raw 레이어)에 해당. 이후 저장소의
    raw→concepts→wiki 파이프라인이 이를 구조화한다(별도 단계).
    """
    import re
    import hashlib
    import datetime
    _require()
    title = (title or "untitled").strip()
    # `[^a-z0-9-]` 로 걸러내면 한글이 통째로 사라져 제목이 무엇이든 "note" 가
    # 된다. 파일명이 곧 문서의 이름인 위키에서 note, note-2, note-3 은 이름이
    # 아니다. \w 는 유니코드를 포함하므로 한글이 살아남는다.
    slug = re.sub(r"[^\w-]+", "-", title, flags=re.UNICODE).strip("-_")[:60].lower() or "note"
    dest_dir = KB_PATH / "raw" / subdir
    dest_dir.mkdir(parents=True, exist_ok=True)
    path = dest_dir / f"{slug}.md"
    i = 2
    while path.exists():
        path = dest_dir / f"{slug}-{i}.md"
        i += 1
    body = (content or "").strip() + "\n"
    sha = hashlib.sha256(body.encode("utf-8")).hexdigest()
    today = datetime.date.today().isoformat()
    front = (
        f"---\ntitle: {title}\nsource_url: {source_url}\n"
        f"ingested: {today}\nsha256: {sha}\n---\n\n"
    )
    path.write_text(front + body, encoding="utf-8")
    return str(path.relative_to(KB_PATH)).replace("\\", "/")


if __name__ == "__main__":
    print(f"KB_PATH = {KB_PATH}")
    print(f"available = {available()}")
    if available():
        nodes = list_nodes()
        print(f"nodes = {len(nodes)} ({sum(1 for n in nodes if n.startswith('concepts'))} concepts, "
              f"{sum(1 for n in nodes if n.startswith('entities'))} entities, "
              f"{sum(1 for n in nodes if n.startswith('comparisons'))} comparisons)")
        g = load_graph()
        print(f"graph = {len(g.get('nodes') or {})} nodes, "
              f"{len(g.get('edges') or [])} edges (available={graph_available()})")
        import sys
        q = " ".join(sys.argv[1:]) or "PPO와 GRPO 차이"
        print()
        print(f"--- retrieve({q!r}, hops=1) ---")
        for d in retrieve(q, hops=1, limit=8, include_body=False):
            print(f"  {d['score']:6.2f} h{d['hop']}  {d['path']:44} {d['why']}")
