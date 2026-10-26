#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""맹비서가 명테크에 **일을 맡기는** 창구.

## 왜 필요한가

사장님이 이해하신 구조는 "맹비서 → 오케스트레이터 → 각 부서" 였다. 맞는
그림인데, **맹비서 쪽 연결이 없었다.** 맹비서에게는 명테크에 일을 넘기는
스킬도 스크립트도 없었고, 메뉴의 "`~ 부서에 ~ 시켜줘`" 는 근거 없는
문장이었다. 명테크 대화창에서 부서를 직접 고르는 것이 유일한 길이었다.

## 무엇을 만드나 — 태스크가 아니라 **프로젝트**

명테크에는 일을 넣는 길이 둘 있다(실측):

| 경로 | 무슨 일이 일어나나 |
|---|---|
| `/api/workflow/trigger` (태스크) | **한 부서**가 받는다. 나눠지지 않는다 |
| `POST /api/projects` (프로젝트) | 오케스트레이터가 계획을 세우고 **산출물마다 부서를 배정**한다 |

"오케스트레이터가 부서에 나눈다" 는 두 번째뿐이다. 그래서 프로젝트를
만든다.

## 안전

프로젝트는 만들어지기만 하고 **바로 돌지 않는다.** 계획이 서면 결재함에
「착수 승인」이 올라오고, 사장님이 승인해야 부서가 움직인다. 맹비서가
멋대로 무료 한도를 태우거나 파일을 쓰는 일은 없다.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

API = "http://127.0.0.1:9000"


def _post(path: str, body: dict, timeout: int = 30) -> tuple[int, dict]:
    req = urllib.request.Request(
        API + path, data=json.dumps(body).encode("utf-8"), method="POST",
        headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8", "replace"))
        except Exception:  # noqa: BLE001
            return e.code, {"error": f"HTTP {e.code}"}


def cmd_project(idea: str, title: str = "") -> int:
    st, d = _post("/api/projects", {"idea": idea, "title": title})
    if st != 200 or not d.get("ok"):
        # 서버가 준 사유를 그대로. "읽을 수 없는 입력" 같은 것이 여기 온다.
        print(f"맡기지 못했습니다: {d.get('error') or f'HTTP {st}'}")
        return 1
    p = d.get("project") or {}
    print("명테크에 프로젝트로 맡겼습니다.")
    print(f"  id    : {p.get('id')}")
    print(f"  제목  : {p.get('title') or '(계획 중에 정해집니다)'}")
    print()
    print("  다음 순서:")
    print("    1. 오케스트레이터가 계획을 세웁니다 (수십 초)")
    print("    2. 산출물마다 맡을 부서가 정해집니다")
    print("    3. **결재함에 「착수 승인」이 올라옵니다** — 승인하셔야 부서가 움직입니다")
    print()
    print("  진행은 `/현황` 또는 명테크 프로젝트 탭에서 보실 수 있습니다.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="명테크에 일을 맡긴다 (프로젝트로).")
    sub = ap.add_subparsers(dest="cmd", required=True)
    pp = sub.add_parser("project", help="아이디어를 프로젝트로 맡긴다")
    pp.add_argument("idea", help="무엇을 원하는지 한두 문장")
    pp.add_argument("--title", default="", help="제목(없으면 계획 중에 정해짐)")
    a = ap.parse_args()
    try:
        if a.cmd == "project":
            return cmd_project(a.idea.strip(), a.title.strip())
    except urllib.error.URLError as exc:
        print(f"명테크 서버에 닿지 못했습니다: {exc.reason}")
        print("`/명테크켜줘` 로 켜실 수 있습니다.")
        return 1
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
