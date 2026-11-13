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
    print(f"  hit@1 {hit1*100:5.1f}%   hit@3 {hit3*100:5.1f}%   MRR {mrr:.3f}"
          f"   질의당 {sum(times)/n*1000:.0f} ms")

    if misses:
        print(f"\n  놓친 질의 {len(misses)}건:")
        for q, gold, top3 in misses:
            print(f"    · {q}")
            print(f"      정답 {'/'.join(gold)}  ←  나온 것 {', '.join(top3) or '(0건)'}")

    score = {"hit1": round(hit1, 4), "hit3": round(hit3, 4), "mrr": round(mrr, 4), "n": n}

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
        # hit@3 이 주 지표. 질의를 더 넣어 n 이 달라졌으면 비율로만 본다.
        worse = []
        if hit3 < base["hit3"] - 1e-9:
            worse.append(f"hit@3 {base['hit3']*100:.1f}% → {hit3*100:.1f}%")
        if mrr < base["mrr"] - 0.005:
            worse.append(f"MRR {base['mrr']:.3f} → {mrr:.3f}")
        if worse:
            print("\n  🔴 나빠졌습니다: " + " · ".join(worse))
            print("  고친 것을 되돌리거나, 왜 이 손실이 받아들일 만한지 적으십시오.")
            return 1
        print("\n  ✅ 기준선 이상입니다.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
