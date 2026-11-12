#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""맹비서가 위키를 **뜻으로** 찾는 창구.

    python D:/myung-tech-workspace/wiki_find.py "대기질 배출량 어떻게 만드나"
    echo "대기질 배출량 어떻게 만드나" | python D:/myung-tech-workspace/wiki_find.py -

## 왜 따로 있나

`knowledge_base.retrieve()` 는 본문을 통째로 실어 돌려준다 — 명테크
에이전트가 프롬프트에 넣을 용도라서다. 맹비서에게 그대로 주면 한 질의에
수만 자가 쏟아진다. 여기서는 **어디를 펴 볼지만** 알려 주고, 읽는 것은
`read_file` 에 맡긴다.

## 인코딩 — 이게 핵심이다

맹비서의 터미널은 Git MSYS bash 를 탄다. 한글 인자가 cp949 를 거치며
깨지는 일이 있다. 2026-11-12 실측에서 "대기질 모델에서 배출량 자료는
어떻게 만드나" 가 깨진 채 들어가 `faq-context-window` 를 1등으로 물고
나왔다 — **검색이 틀린 게 아니라 질문이 이미 틀려 있었다.**

그래서 ① 깨진 꼴을 되돌려 보고 ② 그래도 안 되면 표준입력을 받는다.
되돌리기가 성공하면 **그 사실을 찍는다** — 조용히 고치면 다음에 또 모른다.
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass


def unmangle(q: str) -> tuple[str, bool]:
    """UTF-8 바이트가 cp949 로 읽힌 꼴이면 되돌린다.

    되돌리기는 **왕복이 맞을 때만** 받아들인다. 멀쩡한 한국어를 건드려
    망가뜨리는 쪽이 훨씬 나쁘기 때문이다.
    """
    if not q or "\ufffd" in q:
        return q, False          # 이미 정보가 날아간 것 — 되돌릴 수 없다
    for enc in ("cp949", "latin-1"):
        try:
            fixed = q.encode(enc).decode("utf-8")
        except (UnicodeEncodeError, UnicodeDecodeError):
            continue
        if fixed == q:
            continue
        # 고친 쪽에 한글이 늘었을 때만 인정한다
        def han(s: str) -> int:
            return sum(1 for c in s if "\uac00" <= c <= "\ud7a3")
        if han(fixed) > han(q):
            return fixed, True
    return q, False


def main() -> int:
    args = [a for a in sys.argv[1:] if a != "-"]
    if "-" in sys.argv[1:] or not args:
        query = sys.stdin.read().strip()
    else:
        query = " ".join(args).strip()

    if not query:
        print('쓰는 법: python wiki_find.py "찾을 말"')
        return 2

    query, fixed = unmangle(query)
    if fixed:
        print(f"※ 인자가 깨져 들어와 되돌렸습니다 → {query}")

    import knowledge_base as kb

    try:
        rows = kb.retrieve(query, hops=1)
    except Exception as exc:  # noqa: BLE001
        print(f"검색이 실패했습니다: {type(exc).__name__}: {exc}")
        return 1

    if not rows:
        print(f'"{query}" — 위키에서 0건입니다. 정말 없는 것으로 보셔도 됩니다.')
        return 0

    print(f'"{query}" — {len(rows)}건')
    for r in rows[:12]:
        slug = str(r.get("slug") or "")[:38]
        path = str(r.get("path") or "")
        why = str(r.get("why") or "")[:26]
        print(f"  {r.get('score', 0):5.2f} h{r.get('hop', 0)}  {slug:<38s} {path:<48s} {why}")
    print()
    print("※ 점수만 보고 답하지 마십시오. 경로를 read_file 로 **읽고** 답합니다.")
    print("※ '뜻이 가까움(임베딩)' 은 질의어가 본문에 없을 수도 있습니다.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
