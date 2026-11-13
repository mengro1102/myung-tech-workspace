#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""검색 품질을 **재는** 장치.

    python kb_eval.py                 # 전부 돌려 점수표
    python kb_eval.py --baseline      # 지금 점수를 기준선으로 저장
    python kb_eval.py --check         # 기준선보다 나빠지면 1 로 끝낸다
    python kb_eval.py --only 대기질   # 질의 일부만

## 왜 있나

2026-11-12 에 검색 결함 네 개를 고쳤다 — 불용어, 문서빈도, 조사 분리,
길이 희석. 고친 방법은 **질의 여덟 개를 손으로 돌려 보는 것**이었다.
그 방식에는 두 가지 문제가 있다.

  1. 여덟 개를 고치는 동안 나머지 912개 문서에서 무엇이 망가졌는지 모른다.
     실제로 그날 `slm-vs-llm` 이 대기질 질의 3위로 올라온 것을 **우연히**
     봤다. 보지 못한 것이 몇 개인지는 지금도 모른다.
  2. 다음에 누가 가중치를 만지면 좋아진 것인지 나빠진 것인지 **알 수가
     없다.** 그러면 아무도 만지지 않게 되고, 검색은 그 자리에 굳는다.

Qdrant 든 그래프DB 든 넣기 **전에** 이것이 있어야 한다. 바꿨는데 좋아진
줄을 모르면, 바꾼 이유가 "새 기술을 썼다" 밖에 남지 않는다.

## 질의 모음을 어떻게 골랐나

손으로 썼다. 각 항목은 **답이 하나로 정해지는** 질문이고, 정답은 사장님이
보셔도 "그래, 그게 맞지" 하실 것만 넣었다. 애매한 것은 넣지 않았다 —
애매한 정답은 점수를 흔들어서 측정 자체를 망친다.

함정도 일부러 넣었다(`trap` 표시). 2026-11-12 에 실제로 틀렸던 것들이다:
"어떻게"·"논문"·"모델" 같은 흔한 말이 순위를 가로채던 질의,
조사가 붙어 0건이던 질의.

## 재는 것

    hit@1   1위가 정답인 비율
    hit@3   상위 3위 안에 정답이 있는 비율   ← 주 지표
    MRR     정답의 순위 역수 평균 (1위=1.0, 3위=0.33, 없으면 0)

hit@3 을 주 지표로 둔 이유: 맹비서는 경로를 받아 `read_file` 로 읽는다.
상위 몇 개를 열어 보는 것이 정상 동작이므로 1위 고집은 과하다.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

BASELINE = HERE / "kb_eval_baseline.json"

# (질의, 정답 slug 중 하나라도 맞으면 됨, 비고)
CASES: list[tuple[str, tuple[str, ...], str]] = [
    # ── 사람 ─────────────────────────────────────────────────────────
    ("서튼이 누구야", ("sutton-richard",), "trap: 조사 '이' — 11-12 에 0건이었다"),
    ("리처드 서튼", ("sutton-richard",), ""),
    ("힌턴은 무슨 연구를 했어", ("hinton-geoffrey",), "trap: 조사 '은'"),
    ("벤지오", ("bengio-yoshua",), ""),
    # ── 개념 (한국어로 물음) ─────────────────────────────────────────
    ("역전파가 뭐야", ("backpropagation",), "trap: 조사 '가' — 11-12 에 0건이었다"),
    ("딥러닝이란 무엇인가", ("deep-learning",), ""),
    ("온톨로지가 뭐야", ("knowledge-graph-construction", "ontology"),
     "별칭으로만 걸린다"),
    ("어텐션 메커니즘 설명해줘", ("attention", "self-attention", "transformer"), ""),
    ("강화학습 기초", ("rl", "rl-finite-mdps", "rl-bandits"), ""),
    ("지식그래프는 어떻게 만들어", ("knowledge-graph-construction",),
     "trap: '어떻게' 가 순위를 가로채던 질의"),
    ("임베딩이 뭔지 알려줘", ("embedding", "text-embedding", "bge-m3"), ""),
    ("벡터 데이터베이스", ("vector-database", "vector-db", "rag"), ""),
    ("파인튜닝과 프롬프팅 차이", ("fine-tuning", "prompt-engineering"), ""),
    ("컨텍스트 윈도우 한계", ("context-window",), ""),
    # ── 대기질 (사장님 본업) ─────────────────────────────────────────
    ("대기질 모델에서 배출량 자료는 어떻게 만드나",
     ("cmaq-io-architecture", "cmaq-model", "smoke-model"),
     "trap: 11-12 에 faq-context-window 가 1위였다"),
    ("씨맥 모델이 뭐야", ("cmaq-model",), "별칭 '씨맥'"),
    ("기상자료 전처리", ("mcip",), "별칭"),
    ("PM2.5 예측 모델", ("cleanair-model",), "별칭"),
    # ── 비교 ─────────────────────────────────────────────────────────
    ("PPO와 GRPO 차이", ("ppo", "grpo"), "trap: '차이' 는 불용어여야 한다"),
    ("작은 모델과 큰 모델 비교", ("slm-vs-llm",), "trap: '모델' 이 흔한 말"),
    # ── LLM 운용 ─────────────────────────────────────────────────────
    ("LLM 에이전트는 무엇을 하나", ("llm-agent",), ""),
    ("LLM 평가 방법", ("llm-evaluation",), ""),
    ("RAG 구조", ("rag", "retrieval-augmented-generation"), ""),
    ("환각 줄이는 방법", ("hallucination", "llm-evaluation"), ""),
    ("양자화", ("quantization",), ""),
    # ── 다중 홉: 답이 **그래프 구조에만** 있는 질의 ───────────────────
    #
    # 위의 25건은 전부 단일 홉이다 — 한 문서 안에 답이 있고, 어휘나
    # 임베딩으로 그 문서를 집으면 끝난다. 그래서 그 25건으로는 **그래프가
    # 기여하는지 알 수 없다.** 실제로 2026-11-13 에 홉수를 1→3 으로
    # 바꿔 봤더니 좋아진 것 0건·나빠진 것 0건이었다. 그래프를 들고
    # 있으면서 그것이 아무 일도 하지 않는지조차 모르고 있었던 것이다.
    #
    # 아래 다섯 건은 답이 **두 노드의 관계**에 있다. 한 문서를 집어서는
    # 답할 수 없고, 그래프를 타야 한다. GraphRAG 가 RAG 보다 나은지는
    # 이 종류의 질의에서만 드러난다 — 그래서 측정 대상에 넣는다.
    ("서튼과 바르토가 같이 쓴 책", ("sutton-rl-book",),
     "multi-hop: 두 저자의 공통 이웃"),
    ("힌턴이 쓴 논문이 다루는 개념", ("distillation", "backpropagation", "bert"),
     "multi-hop: authored-by → related"),
    ("트랜스포머 논문을 인용한 자율주행 연구",
     ("bev-perception", "end-to-end-autonomous-driving", "autonomous-driving"),
     "multi-hop: cites 역방향"),
    ("PPO 와 대조되는 방법", ("grpo", "grpo-vs-ppo"),
     "multi-hop: contrasts-with"),
    ("온톨로지를 자동으로 만드는 논문과 그 상위 개념",
     ("rag", "knowledge-graph-construction"),
     "multi-hop: source → related"),
]


def run_one(query: str, gold: tuple[str, ...], limit: int = 8):
    import knowledge_base as kb
    t0 = time.perf_counter()
    rows = kb.retrieve(query, hops=1, limit=limit, include_body=False)
    dt = time.perf_counter() - t0
    slugs = [str(r.get("slug") or "") for r in rows]
    rank = 0
    for i, s in enumerate(slugs, 1):
        if s in gold:
            rank = i
            break
    return rank, slugs, dt


def main() -> int:
    ap = argparse.ArgumentParser(description="검색 품질 측정")
    ap.add_argument("--baseline", action="store_true", help="지금 점수를 기준선으로 저장")
    ap.add_argument("--check", action="store_true", help="기준선보다 나빠지면 실패")
    ap.add_argument("--only", default=None, help="질의에 이 말이 든 것만")
    ap.add_argument("--verbose", "-v", action="store_true", help="상위 3개를 같이 찍는다")
    a = ap.parse_args()

    cases = [c for c in CASES if not a.only or a.only in c[0]]
    if not cases:
        print(f"'{a.only}' 에 맞는 질의가 없습니다.")
        return 2

    print(f"질의 {len(cases)}건\n")
    print(f"  {'순위':<5s} {'질의':<34s} {'정답':<30s} 비고")
    print("  " + "-" * 94)
    ranks, times, misses = [], [], []
    for query, gold, note in cases:
        rank, slugs, dt = run_one(query, gold)
        ranks.append(rank)
        times.append(dt)
        mark = str(rank) if rank else "✗"
        hit = next((s for s in slugs if s in gold), "")
        print(f"  {mark:<5s} {query[:33]:<34s} {(hit or '—')[:29]:<30s} {note[:28]}")
        if not rank:
            misses.append((query, gold, slugs[:3]))
        elif a.verbose:
            print(f"        상위3: {', '.join(slugs[:3])}")

    n = len(ranks)
    hit1 = sum(1 for r in ranks if r == 1) / n
    hit3 = sum(1 for r in ranks if 1 <= r <= 3) / n
    mrr = sum((1.0 / r) if r else 0.0 for r in ranks) / n
    print()

    # ── 집단을 나눠 찍는다 ───────────────────────────────────────────
    #
    # 단일 홉 25건과 다중 홉 5건을 합쳐서 한 숫자로 내면 서로를 가린다.
    # 다중 홉이 전부 망가져도 25건이 떠받쳐 합계는 괜찮아 보이고, 그러면
    # **그래프가 아무 일도 안 하는 것을 모른 채** 지나간다. 실제로
    # 2026-11-13 까지 그 상태였다.
    groups = {"단일 홉": [], "다중 홉": []}
    for (q, gold, note), r in zip(cases, ranks):
        groups["다중 홉" if note.startswith("multi-hop") else "단일 홉"].append(r)
    for name, rs in groups.items():
        if not rs:
            continue
        m = len(rs)
        print(f"  {name} {m:2d}건   hit@1 {sum(1 for r in rs if r == 1)/m*100:5.1f}%"
              f"   hit@3 {sum(1 for r in rs if 1 <= r <= 3)/m*100:5.1f}%"
              f"   MRR {sum((1.0/r) if r else 0.0 for r in rs)/m:.3f}")
    print("  " + "-" * 60)
    print(f"  전체   {n:2d}건   hit@1 {hit1*100:5.1f}%   hit@3 {hit3*100:5.1f}%"
          f"   MRR {mrr:.3f}   질의당 {sum(times)/n*1000:.0f} ms")

    if misses:
        print(f"\n  놓친 질의 {len(misses)}건:")
        for q, gold, top3 in misses:
            print(f"    · {q}")
            print(f"      정답 {'/'.join(gold)}  ←  나온 것 {', '.join(top3) or '(0건)'}")

    score = {"hit1": round(hit1, 4), "hit3": round(hit3, 4), "mrr": round(mrr, 4), "n": n}
    # 집단별로도 저장한다. 합계만 보면 한쪽이 망가져도 다른 쪽이 떠받쳐
    # 통과한다 — 그것을 막는 것이 이 기준선의 존재 이유다.
    for _nm, _rs in groups.items():
        if not _rs:
            continue
        _m = len(_rs)
        score[_nm] = {
            "n": _m,
            "hit3": round(sum(1 for r in _rs if 1 <= r <= 3) / _m, 4),
            "mrr": round(sum((1.0 / r) if r else 0.0 for r in _rs) / _m, 4),
        }

    if a.baseline:
        BASELINE.write_text(json.dumps(score, ensure_ascii=False, indent=2), encoding="utf-8")
        print(f"\n기준선을 저장했습니다 → {BASELINE.name}")
        return 0

    if a.check:
        if not BASELINE.exists():
            print("\n기준선이 없습니다. `--baseline` 으로 먼저 저장하십시오.")
            return 2
        base = json.loads(BASELINE.read_text(encoding="utf-8"))
        print(f"\n  기준선: hit@3 {base['hit3']*100:.1f}% · MRR {base['mrr']:.3f}"
              f"  (질의 {base['n']}건)")
        for _nm in ("단일 홉", "다중 홉"):
            _b = base.get(_nm)
            if _b:
                print(f"          {_nm} {_b['n']}건 hit@3 {_b['hit3']*100:.1f}%"
                      f" · MRR {_b['mrr']:.3f}")
        # hit@3 이 주 지표. 질의를 더 넣어 n 이 달라졌으면 비율로만 본다.
        worse = []
        if hit3 < base["hit3"] - 1e-9:
            worse.append(f"hit@3 {base['hit3']*100:.1f}% → {hit3*100:.1f}%")
        if mrr < base["mrr"] - 0.005:
            worse.append(f"MRR {base['mrr']:.3f} → {mrr:.3f}")
        # 집단별도 본다. 다중 홉 5건이 전부 망가져도 단일 홉 25건이
        # 떠받쳐 합계는 2%p 밖에 안 움직인다 — 그러면 통과해 버린다.
        for _nm, _rs in groups.items():
            _b = base.get(_nm)
            if not _b or not _rs:
                continue
            _m = len(_rs)
            _h3 = sum(1 for r in _rs if 1 <= r <= 3) / _m
            _mr = sum((1.0 / r) if r else 0.0 for r in _rs) / _m
            if _h3 < _b["hit3"] - 1e-9:
                worse.append(f"{_nm} hit@3 {_b['hit3']*100:.1f}% → {_h3*100:.1f}%")
            if _mr < _b["mrr"] - 0.005:
                worse.append(f"{_nm} MRR {_b['mrr']:.3f} → {_mr:.3f}")
        if worse:
            print("\n  🔴 나빠졌습니다: " + " · ".join(worse))
            print("  고친 것을 되돌리거나, 왜 이 손실이 받아들일 만한지 적으십시오.")
            return 1
        print("\n  ✅ 기준선 이상입니다.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
