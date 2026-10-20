"""지식베이스 문서를 뜻으로 찾는다 — 한영 사전 땜질을 걷어내기 위해.

`_seed_scores()` 는 slug·제목·태그에 질의어가 **글자 그대로** 들어 있는지만
본다. 질의는 한국어이고 코퍼스는 영어 논문이라, "비동기 제어 지연" 으로
물으면 `async-vla-latency-compensation` 같은 제목에서도 0점이 난다. 0점이
나면 본문 훑기로 떨어지는데 그것도 어휘 매칭이라, 결국 엉뚱한 문서가
딸려 온다.

`knowledge_base._KO_EN` 사전은 그 간극을 손으로 메운 것이다. 작동은 하지만
**사전에 없는 말은 그대로 못 찾는다.** 사전을 키우는 것은 끝이 없고,
키울수록 "왜 이게 안 걸리지" 를 사람이 디버깅하게 된다.

## 무엇을 하고 무엇을 하지 않나

**한다** — 문서 하나당 벡터 하나. 제목·태그·요약을 합친 짧은 텍스트를
임베딩해 두고, 질의 벡터와의 코사인 유사도로 후보를 고른다.

**하지 않는다** — 문단 단위 임베딩. 논문 한 편에서 어느 구간을 실을지는
여전히 어휘로 고른다(`_relevant_slice`). 문단마다 벡터를 만들면 질의
한 번에 수백 번 임베딩해야 하고, 그 지연이 매 조회에 붙는다. 문서 선택이
틀리면 구간 선택은 의미가 없으므로 **앞쪽부터 고친다.**

그래서 `_KO_EN` 사전은 남는다. 구간 선택에서는 아직 쓰인다 — "걷어냈다"
고 말하려면 문단 임베딩까지 가야 하고, 그건 다음 일이다.

## 어떻게 섞나

어휘 매칭을 **밀어내지 않는다.** slug·제목 매치는 저자가 "이 문서의 주제"
라고 선언한 것이라 임베딩보다 강한 신호다. 그래서:

  1. 메타데이터 어휘 매치 → 그대로 둔다 (가장 믿는다)
  2. 남는 자리를 임베딩 상위로 채운다 (recall 을 늘린다)
  3. 둘 다 빈손일 때만 본문 훑기 (예전 폴백)

이렇게 하면 임베딩이 **더해 주기만 하고 뺏지 않는다.** 모델이 없거나
Ollama 가 죽어 있으면 1·3 만 남아 예전과 똑같이 동작한다.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

def _ollama_base() -> str:
    """Ollama 주소. OLLAMA_HOST 를 그대로 믿지 않는다.

    이 PC 에는 `OLLAMA_HOST=0.0.0.0` 이 걸려 있다. 그건 Ollama **서버가 어디에
    바인드할지** 를 정하는 변수이지 클라이언트가 붙을 주소가 아니다. 그대로
    쓰면 urllib 가 "unknown url type: '0.0.0.0/api/embed'" 로 죽고, 이 모듈은
    실패를 조용히 삼키도록 돼 있어 **그냥 임베딩이 꺼진 것처럼 보인다.**

    agent_dispatcher.py 가 같은 함정을 이미 밟고 같은 방식으로 막아 뒀다
    (스킴이 없으면 localhost 로). 같은 규칙을 쓴다.
    """
    raw = (os.environ.get("OLLAMA_BASE_URL")
           or os.environ.get("OLLAMA_HOST") or "").strip().rstrip("/")
    if not raw or not raw.startswith("http"):
        return "http://localhost:11434"
    return raw


OLLAMA = _ollama_base()
MODEL = os.environ.get("KB_EMBED_MODEL", "bge-m3")
TIMEOUT = int(os.environ.get("KB_EMBED_TIMEOUT", "30"))
# 바닥값이지 관련성 판정이 아니다.
#
# 처음엔 0.55 를 "이 위면 관련 있다" 는 문턱으로 뒀다. 측정해 보니 **그런
# 문턱은 없었다.** 같은 코퍼스 211편에서:
#
#     관련 질의  "비동기 제어 지연 보상"   top1 = 0.460
#                "보행 로봇 계단 오르기"   top1 = 0.532
#                "로봇 조작 정책 학습"     top1 = 0.637
#     무관 질의  "식당 메뉴판 디자인"      top1 = 0.448
#                "오늘 점심 뭐 먹지"       top1 = 0.497   <- 관련 질의보다 높다
#                "아파트 전세 계약"        top1 = 0.402
#
# 관련 질의의 최저(0.460)가 무관 질의의 최고(0.497)보다 낮다. 어떤 값을
# 골라도 한쪽이 틀린다. 코사인 유사도는 거리를 재는 것이지 "이 질문에 쓸모
# 있는가" 를 판정하지 않는다.
#
# 그래서 이 모듈은 관련성을 주장하지 않는다. 어휘 매칭이 비워 둔 자리만
# 채우고(= recall 보강), 어휘가 찾은 것은 밀어내지 않는다. 무관한 문서가
# 섞여 드는 것은 하류의 근거 강제가 막는다 — 검토자가 "근거 자료에 없는
# 수치" 를 반려하는 그 장치다.
#
# 아래 값은 "이 밑이면 아무것도 아니다" 는 바닥일 뿐이다.
MIN_SIM = float(os.environ.get("KB_EMBED_MIN_SIM", "0.35"))

CACHE_NAME = ".embed_cache.json"

# 마지막 실패 사유. 조회는 조용히 넘어가지만 진단은 할 수 있어야 한다.
LAST_ERROR = ""


# ── Ollama ───────────────────────────────────────────────────────────

def _post(path: str, payload: dict) -> dict | None:
    try:
        req = urllib.request.Request(
            f"{OLLAMA}{path}", data=json.dumps(payload).encode(),
            headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError) as exc:
        # 조회 경로에서는 조용히 None 이다 — 임베딩을 못 썼다고 조회가 실패하면
        # 안 된다. 어휘 매칭만으로도 예전만큼은 돌아간다.
        #
        # 다만 사유는 남긴다. 처음엔 완전히 삼켰더니 `OLLAMA_HOST=0.0.0.0`
        # 때문에 전부 실패하는 것이 "임베딩이 그냥 꺼져 있다" 로 보였고,
        # 왜 0건인지 알아내는 데 시간이 걸렸다.
        global LAST_ERROR
        LAST_ERROR = f"{type(exc).__name__}: {exc}"
        return None


def available() -> bool:
    """모델이 실제로 응답하는지. 설치만 되고 안 뜨는 경우가 있다."""
    return embed(["확인"]) is not None


def embed(texts: list[str]) -> list[list[float]] | None:
    """여러 텍스트를 한 번에. 실패하면 None."""
    if not texts:
        return []
    d = _post("/api/embed", {"model": MODEL, "input": texts})
    if not d:
        return None
    vecs = d.get("embeddings")
    if not isinstance(vecs, list) or len(vecs) != len(texts):
        return None
    return [[float(x) for x in v] for v in vecs]


def _norm(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def _cos(a: list[float], b: list[float]) -> float:
    """둘 다 정규화돼 있다고 보고 내적만 한다."""
    return sum(x * y for x, y in zip(a, b))


# ── 문서 벡터 캐시 ───────────────────────────────────────────────────
#
# 200편을 매 질의마다 임베딩하면 조회 한 번에 수십 초가 걸린다. 문서가
# 바뀌지 않으면 벡터도 그대로이므로 디스크에 둔다. 바뀐 것만 다시 만든다 —
# 판정은 임베딩에 넣은 텍스트의 해시로 한다(파일 수정시각은 git 체크아웃
# 한 번에 전부 바뀌어 쓸모가 없다).

def _doc_text(slug: str, meta: dict) -> str:
    """임베딩에 넣을 짧은 텍스트. 본문 전체가 아니라 '무엇에 관한 글인가'.

    **슬러그는 넣지 않는다.** 슬러그는 제목을 하이픈으로 바꾼 것이라 거의
    같은 내용이고, 넣으면 같은 말이 두 번 들어가 텍스트가 희석된다.
    실측 — 같은 코퍼스에서 정답 문서의 순위("비동기 제어 지연 보상"):

        제목+슬러그+태그  ->  3위, 18위
        제목만            ->  9위, 10위
        제목+태그         ->  2위,  3위   (채택)

    다른 두 질의에서도 같은 순서였다. 긴 서술형 제목(논문)과 한 단어 제목
    (개념 노트)이 섞인 코퍼스라, 중복으로 길이를 늘리면 긴 쪽이 손해를 본다.
    """
    parts = [
        str(meta.get("title") or slug).replace("-", " "),
        " ".join(str(t) for t in (meta.get("tags") or [])),
        str(meta.get("summary") or meta.get("desc") or "")[:600],
    ]
    return "\n".join(p for p in parts if p.strip())


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]


def _cache_path(kb_path: Path) -> Path:
    return kb_path / CACHE_NAME


def _load_cache(kb_path: Path) -> dict:
    try:
        d = json.loads(_cache_path(kb_path).read_text(encoding="utf-8"))
        return d if isinstance(d, dict) and d.get("model") == MODEL else {"model": MODEL, "docs": {}}
    except Exception:  # noqa: BLE001
        # 모델이 바뀌면 벡터 공간이 달라져 예전 값과 비교할 수 없다.
        return {"model": MODEL, "docs": {}}


def _save_cache(kb_path: Path, cache: dict) -> None:
    try:
        tmp = _cache_path(kb_path).with_suffix(".tmp")
        tmp.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
        tmp.replace(_cache_path(kb_path))
    except OSError:
        pass


def sync(kb_path: Path, nodes: dict[str, dict], *, batch: int = 32,
         verbose: bool = False) -> tuple[int, int]:
    """바뀐 문서만 다시 임베딩한다. (새로 만든 수, 전체 수)."""
    cache = _load_cache(kb_path)
    docs = cache.setdefault("docs", {})

    todo: list[tuple[str, str, str]] = []   # (slug, 텍스트, 해시)
    for slug, meta in nodes.items():
        text = _doc_text(slug, meta)
        if not text.strip():
            continue
        dg = _digest(text)
        # 해시는 **벡터를 저장한 뒤에** 적는다.
        #
        # 처음엔 여기서 미리 적었다. 그랬더니 첫 실행이 통째로 실패한 뒤
        # 다음 실행이 "해시가 같으니 최신" 이라고 판단해 아무것도 하지
        # 않았다 — 211건이 영원히 0건으로 남는다. 실패한 작업이 성공한
        # 것처럼 기록되면, 재시도라는 개념 자체가 사라진다.
        if docs.get(slug, {}).get("d") != dg or not docs.get(slug, {}).get("v"):
            todo.append((slug, text, dg))

    # 모델이 메모리에 없으면 첫 호출에 로딩 시간이 얹힌다. 그 상태에서 32건
    # 짜리 배치를 던지면 타임아웃에 걸려 **전부** 실패한다 — 실측으로 211건이
    # 0건이 됐다. 한 건을 먼저 던져 모델을 올려 두고 시작한다.
    if todo:
        embed([todo[0][1]])

    made = 0
    for i in range(0, len(todo), batch):
        chunk = todo[i:i + batch]
        vecs = embed([t for _, t, _ in chunk])
        if vecs is None:
            if verbose:
                print(f"  임베딩 실패({LAST_ERROR or '사유 미상'}) — "
                      f"{len(todo) - made}건 남기고 중단", file=sys.stderr)
            break
        for (slug, _, dg), v in zip(chunk, vecs):
            docs[slug] = {"d": dg, "v": _norm(v)}
            made += 1
        if verbose:
            print(f"  {made}/{len(todo)}")

    # 사라진 문서의 벡터는 버린다. 안 버리면 지운 문서가 계속 검색된다.
    for slug in [s for s in docs if s not in nodes]:
        docs.pop(slug, None)

    _save_cache(kb_path, cache)
    return made, len([s for s in docs if docs[s].get("v")])


def rank(kb_path: Path, query: str, *, limit: int = 6,
         min_sim: float = MIN_SIM) -> dict[str, float]:
    """질의와 뜻이 가까운 문서. 모델이 없거나 캐시가 비면 빈 dict.

    빈 dict 는 "관련 문서 없음" 이 아니라 "임베딩을 쓸 수 없음" 과 같은
    모양이다. 부르는 쪽은 어느 쪽이든 어휘 매칭으로 돌아가면 되므로
    구분할 필요가 없다 — 구분하게 만들면 양쪽에서 처리가 갈린다.
    """
    cache = _load_cache(kb_path)
    docs = {s: d for s, d in (cache.get("docs") or {}).items() if d.get("v")}
    if not docs:
        return {}
    qv = embed([query])
    if not qv:
        return {}
    q = _norm(qv[0])
    hits = []
    for slug, d in docs.items():
        v = d.get("v") or []
        if len(v) != len(q):
            continue          # 모델이 바뀐 뒤 남은 벡터
        s = _cos(q, v)
        if s >= min_sim:
            hits.append((s, slug))
    hits.sort(reverse=True)
    return {slug: round(s, 4) for s, slug in hits[:limit]}


def stats(kb_path: Path) -> dict:
    cache = _load_cache(kb_path)
    docs = cache.get("docs") or {}
    withv = [s for s in docs if docs[s].get("v")]
    return {
        "model": cache.get("model") or MODEL,
        "cached": len(withv),
        "stale": len(docs) - len(withv),
        "dim": len(docs[withv[0]]["v"]) if withv else 0,
        "min_sim": MIN_SIM,
        "path": str(_cache_path(kb_path)),
    }


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    import knowledge_base as kb

    if not kb.available():
        raise SystemExit("지식베이스를 찾지 못했습니다.")
    kbp = kb.KB_PATH
    cmd = sys.argv[1] if len(sys.argv) > 1 else "stats"

    if cmd == "sync":
        nodes = dict(kb.load_graph().get("nodes") or {})
        nodes.update(kb._experience_nodes())  # noqa: SLF001
        print(f"문서 {len(nodes)}건 · 모델 {MODEL}")
        made, total = sync(kbp, nodes, verbose=True)
        print(f"새로 만든 벡터 {made}건 · 캐시 {total}건")
        print(json.dumps(stats(kbp), ensure_ascii=False, indent=2))
    elif cmd == "ask":
        q = " ".join(sys.argv[2:]) or "비동기 제어 지연 보상"
        print(f"질의: {q}\n")
        for slug, s in rank(kbp, q, limit=8).items():
            print(f"  {s:.3f}  {slug}")
    else:
        print(json.dumps(stats(kbp), ensure_ascii=False, indent=2))
        print(f"\nollama 응답: {'예' if available() else '아니오'}")
