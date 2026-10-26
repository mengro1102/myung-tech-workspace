#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""맹비서가 명테크 **휴지통**을 다루는 창구.

## 왜 맹비서만 영구 삭제를 하나

대시보드는 터널로 밖에서도 열린다. 접속 키가 새면 남이 지울 수 있다.
그래서 대시보드의 삭제는 휴지통으로 옮기기까지만이고, 옮기면 맹비서가
디스코드로 알린다. **되돌릴 수 없는 일은 사장님 메신저 계정 → 맹비서 →
이 스크립트** 로만 닿는다.

서버는 세 겹으로 막는다:
  1. 이 PC 에서 직접 온 요청이어야 하고
  2. 이 PC 의 파일에만 있는 열쇠(shared_memory/store/.purge_token)를 내야 하고
  3. **사장님 디스코드 DM 으로만 간 확인 코드**를 내야 한다.

3번이 있는 이유: 맹비서는 명테크 웹 대화창으로도 말을 듣는다. 그 창은
대시보드 접속 키로 열리므로, 키가 새면 남이 웹 창에서 "비워줘" 를 시킬 수
있다. 코드는 스크립트 출력에도 서버 응답에도 없다 — 맹비서도 모른다.

## 사용

    python mt_trash.py list
    python mt_trash.py restore <id>... | --all
    python mt_trash.py purge   <id>... | --all                 # 대상 확정 + 코드를 DM 으로
    python mt_trash.py purge   <id>... | --all --code 123456   # 사장님이 불러 준 코드로 지운다

id 는 목록의 `trs-…` 또는 프로젝트 id(`prj-…`). **번호(1, 2, 3)는 받지
않는다** — 목록을 본 뒤에 휴지통이 바뀌면 번호가 다른 것을 가리킨다.
"""
from __future__ import annotations

import argparse
import json
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

API = "http://127.0.0.1:9000"
TOKEN_FILE = Path(__file__).resolve().parent.parent / "shared_memory" / "store" / ".purge_token"


def _call(method: str, path: str, body: dict | None = None,
          headers: dict | None = None, timeout: int = 60) -> tuple[int, dict]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method,
                                 headers={"Content-Type": "application/json",
                                          **(headers or {})})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8", "replace"))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode("utf-8", "replace"))
        except Exception:  # noqa: BLE001
            return e.code, {"error": f"HTTP {e.code}"}


def _when(ts: float | None) -> str:
    return time.strftime("%m/%d %H:%M", time.localtime(ts)) if ts else "?"


def _items() -> list[dict]:
    st, d = _call("GET", "/api/trash")
    if st != 200:
        raise SystemExit(f"휴지통을 읽지 못했습니다: {d.get('error') or st}")
    return d.get("items") or []


def _resolve(items: list[dict], ids: list[str], all_: bool) -> list[dict]:
    if all_:
        return items
    want = set(ids)
    hit = [i for i in items if i["id"] in want or (i.get("ref") or "") in want]
    found = {i["id"] for i in hit} | {i.get("ref") for i in hit}
    for x in ids:
        if x not in found:
            print(f"  ⚠ 휴지통에 없습니다: {x}")
    return hit


def _line(i: dict) -> str:
    ln = i.get("linked") or {}
    extra = []
    if i["kind"] == "project":
        if ln.get("approvals"):
            extra.append(f"결재 {ln['approvals']}")
        if ln.get("lessons"):
            extra.append(f"교훈 {ln['lessons']}")
        if ln.get("events"):
            extra.append(f"활동 {ln['events']}")
    tail = f"  [{', '.join(extra)}]" if extra else ""
    return (f"  {i['id']}  {i['kind_ko']} 「{i['title']}」\n"
            f"      지운 때 {_when(i.get('deleted_at'))} · 경로 {i.get('origin') or '?'}{tail}")


def cmd_list() -> int:
    items = _items()
    if not items:
        print("휴지통이 비어 있습니다.")
        return 0
    print(f"휴지통 {len(items)}건 (최근 순)")
    for i in items:
        print(_line(i))
    print()
    print("되살리기: 대시보드 프로젝트 탭 맨 아래 🗑 휴지통, 또는 저에게 \"되살려줘\".")
    print("영구 삭제: 지울 것을 말씀해 주시면 무엇이 지워지는지 먼저 보여 드립니다.")
    return 0


def cmd_restore(ids: list[str], all_: bool) -> int:
    hit = _resolve(_items(), ids, all_)
    if not hit:
        print("되살릴 것이 없습니다.")
        return 1
    st, d = _call("POST", "/api/trash/restore",
                  {"all": True} if all_ else {"ids": [i["id"] for i in hit]})
    for i in d.get("restored") or []:
        print(f"  ↩ 되살림: {i['kind_ko']} 「{i['title']}」")
    for f in d.get("failed") or []:
        print(f"  ⚠ {f}")
    if any(i["kind"] == "project" for i in d.get("restored") or []):
        print("  (돌던 프로젝트는 '일시정지' 로 돌아옵니다 — 이어 가려면 프로젝트 탭에서 '그대로 이어서')")
    return 0 if st == 200 and d.get("ok") else 1


def cmd_purge(ids: list[str], all_: bool, code: str) -> int:
    hit = _resolve(_items(), ids, all_)
    if not hit:
        print("지울 것이 없습니다.")
        return 1
    try:
        token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        print("영구 삭제 열쇠 파일이 없습니다 — 명테크 서버를 한 번 재시작하면 만들어집니다.")
        return 1
    # 「전부」 도 지금 본 id 들로 보낸다. 서버가 코드를 이 목록에 묶는다.
    body = {"ids": [i["id"] for i in hit]}
    if code:
        body["code"] = code
    st, d = _call("POST", "/api/trash/purge", body,
                  headers={"X-MT-Purge-Token": token}, timeout=120)
    if st == 403:
        print(f"영구 삭제가 막혔습니다: {d.get('error')}")
        return 1
    if d.get("challenge"):
        print(f"영구 삭제 대상 {len(d.get('targets') or [])}건 — **되돌릴 수 없습니다**")
        for i in d.get("targets") or []:
            print(_line(i))
        print()
        print("프로젝트는 기록·결재·교훈·활동 이벤트·프롬프트 보관·산출물 파일·")
        print("위키 raw/projects 의 경험 문서까지 함께 지웁니다.")
        if d.get("sent"):
            print()
            print("🔐 사장님 디스코드 DM 으로 **6자리 확인 코드**를 보냈습니다 (10분 유효).")
            print("   코드를 불러 주시면 지웁니다. 코드는 저(맹비서)도 모릅니다.")
            return 3
        print()
        print("확인 코드를 보내지 못했습니다(디스코드·텔레그램 모두 실패) — 지우지 않았습니다.")
        return 1
    if st != 200:
        print(f"영구 삭제하지 못했습니다: {d.get('error') or st}")
        return 1
    reps = d.get("purged") or []
    print(f"🔥 영구 삭제 {len(reps)}건")
    wiki_left = False
    for r in reps:
        print(f"  · {r['kind_ko']} 「{r['title']}」")
        bits = []
        for k, ko in (("approvals", "결재"), ("lessons", "교훈"), ("events", "활동"),
                      ("backup_rows", "백업 행")):
            if r.get(k):
                bits.append(f"{ko} {r[k]}")
        if r.get("folders"):
            bits.append("폴더 " + ", ".join(r["folders"]))
        if r.get("wiki"):
            bits.append(f"위키 문서 {len(r['wiki'])}")
            wiki_left = True
        if bits:
            print("      함께 지움: " + " · ".join(bits))
    if wiki_left:
        print()
        print("  참고: 위키는 git 저장소라 **이미 커밋된 내용은 히스토리에 남습니다.**")
        print("  작업 사본은 지웠고, 다음 백업 커밋에서 '삭제' 로 기록됩니다.")
    print("휴지통 기록도 함께 지웠습니다 — 명테크 서버에는 남지 않습니다.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="명테크 휴지통")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="휴지통 목록")
    for name in ("restore", "purge"):
        sp = sub.add_parser(name)
        sp.add_argument("ids", nargs="*", help="trs-… 또는 prj-…")
        sp.add_argument("--all", action="store_true", help="전부")
        if name == "purge":
            sp.add_argument("--code", default="",
                            help="사장님이 디스코드 DM 에서 받아 불러 준 6자리 코드")
    a = ap.parse_args()
    try:
        if a.cmd == "list":
            return cmd_list()
        if not a.ids and not a.all:
            print("무엇을 할지 id 를 주거나 --all 을 붙이세요.")
            return 2
        if a.cmd == "restore":
            return cmd_restore(a.ids, a.all)
        return cmd_purge(a.ids, a.all, a.code.strip())
    except urllib.error.URLError as exc:
        print(f"명테크 서버에 닿지 못했습니다: {exc.reason}")
        print("`/명테크켜줘` 로 켜실 수 있습니다.")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
