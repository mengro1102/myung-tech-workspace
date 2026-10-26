#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""맹비서 근거 평가 — 모델·프롬프트를 바꿨을 때 좋아졌는지 잰다.

## 왜 필요한가

이 프로젝트에서 고친 것은 전부 **손으로** 확인했다. 질문을 던지고, 답을
읽고, "이번엔 괜찮네" 하고 넘어갔다. 그래서 두 가지가 안 된다:

1. **회귀를 못 잡는다.** 어제 고친 곳이 오늘 다시 깨져도 모른다.
2. **개선을 증명 못 한다.** 라우터에서 `-lite` 를 뺐을 때 정말 좋아졌는지
   "느낌" 말고 숫자로 말할 수 없다.

## 무엇을 재고 무엇을 안 재나

**재는 것**: 날조했나, 도구를 썼나, 없는 것을 있다고 했나, 번호를 바꿔
적었나, 언어가 미끄러졌나. 전부 기계로 판정 가능하다.

**안 재는 것**: 답이 얼마나 좋은가. 그건 사람이 읽어야 한다. 이 눈금은
**"틀리지 않았나"** 만 본다 — 그것이 지금 무너지고 있는 쪽이다.

## 쓰는 법

    python scripts/eval_run.py                 # 20문항 전부
    python scripts/eval_run.py --tag 날조       # 그 꼬리표만
    python scripts/eval_run.py --id g02 g07    # 특정 문항
    python scripts/eval_run.py --compare 이전.json

결과는 `reports/eval-<시각>.json` 에 남는다. `--compare` 로 두 번을
견주면 무엇이 좋아지고 무엇이 나빠졌는지 문항별로 나온다.

**한 번 돌리면 20번의 대화가 일어난다.** 무료 한도를 쓰므로 자주 돌리지
말 것 — 모델이나 프롬프트를 바꾼 뒤에만.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

API = "http://127.0.0.1:9000/api/assistant"
HERE = Path(__file__).resolve().parent
QUESTIONS = HERE / "eval_questions.json"
REPORTS = HERE.parent / "reports"

# 한 문항당 최대 대기. 무료 라우터가 느린 모델을 고르면 오래 걸린다.
TIMEOUT = 420

# "못 찾았다/없다" 로 읽히는 말. expect_refusal 채점에 쓴다.
REFUSAL = (
    "없습니다", "없음", "찾지 못", "못 찾", "확인되지 않", "존재하지 않",
    "할 수 없습니다", "할 수 없", "제가 승인", "불가능", "읽지 못",
    "모르겠", "알 수 없",
)


def _post(path: str, payload: dict, timeout: int):
    req = urllib.request.Request(
        API + path, data=json.dumps(payload).encode("utf-8"),
        method="POST", headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _get(path: str, timeout: int = 20):
    with urllib.request.urlopen(API + path, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def ask(q: dict, n: int, total: int) -> dict:
    """한 문항을 던지고, 답과 **도구 호출 기록**을 받아 온다."""
    title = f"eval {q['id']} {time.strftime('%m%d-%H%M%S')}"
    made = _post("/sessions", {"title": title}, 30)
    sid = ((made or {}).get("session") or {}).get("id", "")
    if not sid:
        return {"id": q["id"], "error": f"세션 생성 실패: {made}"}

    print(f"  [{n}/{total}] {q['id']} … ", end="", flush=True)
    t0 = time.time()
    try:
        _post(f"/sessions/{sid}/chat", {"message": q["ask"]}, TIMEOUT)
    except Exception as exc:  # noqa: BLE001
        print(f"실패 ({str(exc)[:40]})")
        return {"id": q["id"], "error": str(exc)[:200], "sec": time.time() - t0}

    rows = (_get(f"/sessions/{sid}/messages") or {}).get("data") or []
    tools, text = [], ""
    for m in rows:
        for t in (m.get("tool_calls") or []):
            nm = (t.get("function") or {}).get("name")
            if nm:
                tools.append(nm)
        if (m.get("role") == "assistant" and not m.get("tool_calls")
                and str(m.get("content") or "").strip()):
            text = str(m["content"])
    sec = time.time() - t0
    print(f"{sec:.0f}초")
    return {"id": q["id"], "sec": round(sec, 1), "tools": tools,
            "answer": text, "session": sid}


def grade(q: dict, r: dict) -> dict:
    """감점식. 만점 100 에서 어긴 조항마다 깎는다."""
    if r.get("error"):
        return {**r, "score": 0, "fails": [f"호출 실패: {r['error'][:60]}"]}

    a = (r.get("answer") or "")
    low = a.lower()
    tools = r.get("tools") or []
    fails: list[str] = []
    score = 100

    if not a.strip():
        return {**r, "score": 0, "fails": ["빈 답"]}

    for s in q.get("must_include", []):
        if s.lower() not in low:
            fails.append(f"빠짐: {s!r}")
            score -= 25

    for s in q.get("must_not_include", []):
        if s.lower() in low:
            fails.append(f"날조/금지어: {s!r}")
            score -= 40

    want = q.get("must_call") or []
    # must_call 은 **하나라도** 부르면 통과다. 같은 일을 여러 도구로 할 수
    # 있기 때문이다(execute_code 로도, terminal 로도 스크립트를 돌린다).
    if want and not any(w in tools for w in want):
        fails.append(f"도구 미사용 (하나는 필요: {', '.join(want)})")
        score -= 35

    for w in q.get("must_not_call", []):
        if w in tools:
            fails.append(f"쓰면 안 되는 도구: {w}")
            score -= 25

    if q.get("expect_refusal"):
        if not any(k in a for k in REFUSAL):
            fails.append("없다고 말해야 하는데 답을 지어냄")
            score -= 50

    # 문장 붕괴 — 한글 자모가 홀로 뜨거나 CJK 가 아닌 한자가 섞인 경우
    if re.search(r"[ㄱ-ㅎㅏ-ㅣ]{2,}", a):
        fails.append("문장 붕괴(한글 자모 노출)")
        score -= 15

    return {**r, "score": max(0, score), "fails": fails}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", help="이 꼬리표가 붙은 문항만")
    ap.add_argument("--id", nargs="*", help="이 id(접두 일치)만")
    ap.add_argument("--compare", help="이전 결과 json 과 견준다")
    ap.add_argument("--note", default="", help="이번 실행에 붙일 메모(모델 이름 등)")
    a = ap.parse_args()

    data = json.loads(QUESTIONS.read_text(encoding="utf-8"))
    qs = data["questions"]
    if a.tag:
        qs = [q for q in qs if a.tag in (q.get("tags") or [])]
    if a.id:
        qs = [q for q in qs if any(q["id"].startswith(p) for p in a.id)]
    if not qs:
        print("해당하는 문항이 없습니다.")
        return 1

    print(f"맹비서 근거 평가 — {len(qs)}문항"
          + (f" · {a.note}" if a.note else ""))
    print("한 문항에 최대 7분. 무료 한도를 쓰므로 자주 돌리지 마십시오.\n")

    out = []
    for i, q in enumerate(qs, 1):
        out.append(grade(q, ask(q, i, len(qs))))

    total = sum(r["score"] for r in out) / len(out)
    print(f"\n{'─' * 62}")
    print(f"총점 {total:.1f} / 100   ({len(qs)}문항)")
    print(f"{'─' * 62}")
    for r in sorted(out, key=lambda x: x["score"]):
        mark = "✅" if r["score"] >= 90 else ("⚠️ " if r["score"] >= 60 else "🔴")
        print(f"{mark} {r['score']:3d}  {r['id']:<26} {r.get('sec', 0):>5.0f}초")
        for f in r.get("fails", []):
            print(f"         └ {f}")

    REPORTS.mkdir(exist_ok=True)
    path = REPORTS / f"eval-{time.strftime('%Y%m%d-%H%M%S')}.json"
    path.write_text(json.dumps(
        {"when": time.strftime("%Y-%m-%d %H:%M:%S"), "note": a.note,
         "total": round(total, 1), "results": out},
        ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n기록: {path}")

    if a.compare:
        prev = json.loads(Path(a.compare).read_text(encoding="utf-8"))
        pm = {r["id"]: r["score"] for r in prev["results"]}
        print(f"\n이전({prev.get('note') or prev['when']}) 대비: "
              f"{prev['total']} → {total:.1f}")
        for r in out:
            if r["id"] in pm and pm[r["id"]] != r["score"]:
                d = r["score"] - pm[r["id"]]
                print(f"  {'↑' if d > 0 else '↓'} {r['id']:<26} "
                      f"{pm[r['id']]} → {r['score']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
