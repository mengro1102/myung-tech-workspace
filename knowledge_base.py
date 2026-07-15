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
NODE_DIRS = ("concepts", "entities", "comparisons")
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


def list_nodes(category: str | None = None) -> list[str]:
    """노드 slug 목록 (예: 'concepts/transformer'). category로 한 종류만 조회 가능."""
    _require()
    cats = (category,) if category else NODE_DIRS
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
    for cat in NODE_DIRS:
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
    slug = re.sub(r"[^a-z0-9\-]+", "-", title.lower()).strip("-")[:60] or "note"
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
