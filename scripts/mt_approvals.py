#!/usr/bin/env python3
"""명테크 결재를 명령줄에서 처리한다 — 맹비서(텔레그램·디스코드)가 부르는 입구.

명테크 전용 봇(@meng_tech_bot)에는 버튼 결재가 있지만, 사장님은 맹비서 창에서
살고 계신다. 알림을 보고 그 자리에서 조치가 안 되면 알림이 반쪽이다.

맹비서는 스킬(SKILL.md)로 확장한다. 스킬은 LLM 이 읽는 지시문이라, 거기서
API 호출을 직접 조립하게 두면 없는 엔드포인트를 지어내거나 엉뚱한 결재를
승인할 수 있다. 그래서 **결정은 전부 이 스크립트가 하고, LLM 은 어떤
하위 명령을 부를지만 고른다.**

    python mt_approvals.py list             대기 목록 (번호 붙임)
    python mt_approvals.py show 1           내용 전문
    python mt_approvals.py approve 1        승인 — 실제로 실행된다
    python mt_approvals.py reject 1         거절
    python mt_approvals.py approve --all    전부 승인

번호는 list 가 보여 준 순서다. id 를 직접 받기도 한다(앞 4자 이상이면 매칭).
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
KIND = {"file": "📄 파일 저장", "action": "🚀 외부 실행", "project": "📋 프로젝트 착수"}


def call(method: str, path: str, body: dict | None = None, timeout: int = 180):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        API + path, data=data, method=method,
        headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def pending() -> list[dict]:
    return [a for a in call("GET", "/api/store/approvals").get("items", [])
            if a.get("status") == "pending"]


def brief(a: dict) -> str:
    """무엇이 나가는지 한 줄로. 되돌릴 수 없는 값은 반드시 보인다."""
    bits = [KIND.get(a.get("kind"), "결재"), (a.get("label") or "")[:90]]
    args = a.get("action_args") or {}
    if args.get("privacy"):
        bits.append(f"공개범위 {args['privacy']}")
    if args.get("repo"):
        bits.append(f"레포 {args['repo']}")
    if a.get("file_path"):
        bits.append(f"경로 workspace/{a['file_path']}")
    return " · ".join(b for b in bits if b)


def pick(rows: list[dict], token: str) -> dict:
    """번호(1부터) 또는 id 앞자리로 하나 고른다."""
    token = token.strip()
    if token.isdigit():
        i = int(token)
        if not 1 <= i <= len(rows):
            raise SystemExit(f"{i}번은 없습니다. 지금 대기 중인 것은 {len(rows)}건입니다.")
        return rows[i - 1]
    hits = [a for a in rows if a["id"].startswith(token)]
    if len(hits) == 1:
        return hits[0]
    if not hits:
        raise SystemExit(f"'{token}' 에 해당하는 결재가 없습니다.")
    raise SystemExit(f"'{token}' 로 시작하는 결재가 {len(hits)}건입니다. 더 길게 적어 주세요.")


def decide(a: dict, status: str) -> str:
    d = call("PUT", f"/api/store/approvals/{a['id']}", {"status": status})
    f = d.get("followup") or {}
    if status == "rejected":
        return "❌ 거절했습니다 — 실행하지 않았습니다."
    if f.get("ran"):
        return f"✅ 실행 완료 — {f['ran']}"
    if f.get("wrote"):
        return f"✅ 저장 완료 — {f['wrote']}"
    if f.get("queued"):
        return "✅ 승인 — 해당 부서에 실행 지시를 보냈습니다."
    if f.get("reason"):
        return f"⚠️ {f['reason']}"
    return "✅ 승인했습니다."


def main() -> int:
    ap = argparse.ArgumentParser(description="명테크 결재")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="대기 목록")
    p_show = sub.add_parser("show", help="내용 전문")
    p_show.add_argument("which")
    for name in ("approve", "reject"):
        p = sub.add_parser(name, help="승인" if name == "approve" else "거절")
        p.add_argument("which", nargs="?")
        p.add_argument("--all", action="store_true", help="대기 중인 것 전부")
    args = ap.parse_args()

    try:
        rows = pending()
    except urllib.error.URLError as e:
        print(f"⚠️ 명테크 서버에 연결하지 못했습니다 ({API})\n"
              f"   {e}\n"
              f"   PC 에서 START.bat 이 떠 있는지 확인해 주세요.")
        return 1

    if args.cmd == "list":
        if not rows:
            print("✅ 대기 중인 결재가 없습니다.")
            return 0
        print(f"📋 대기 중인 결재 {len(rows)}건\n")
        for i, a in enumerate(rows, 1):
            print(f"{i}. {brief(a)}")
        print("\n승인하려면 번호를 말씀해 주세요. 내용을 먼저 보시려면 '1번 내용'.")
        return 0

    if not rows:
        print("✅ 대기 중인 결재가 없습니다.")
        return 0

    if args.cmd == "show":
        a = pick(rows, args.which)
        print(brief(a) + "\n" + "─" * 40)
        detail = (a.get("detail") or "").strip()
        if detail:
            print(detail[:600] + "\n" + "─" * 40)
        body = a.get("file_content") or json.dumps(
            a.get("action_args") or {}, ensure_ascii=False, indent=2)
        print(body[:2500] if body else "(내용 없음)")
        if body and len(body) > 2500:
            print(f"\n… (전체 {len(body):,}자 중 앞부분)")
        return 0

    status = "approved" if args.cmd == "approve" else "rejected"
    if args.all:
        # 전부 승인은 되돌릴 수 없으므로 무엇을 했는지 한 줄씩 남긴다.
        print(f"{len(rows)}건 처리합니다.\n")
        for a in rows:
            print(f"· {brief(a)}\n  {decide(a, status)}")
        return 0

    if not args.which:
        raise SystemExit("몇 번인지 알려 주세요. (예: approve 1)")
    a = pick(rows, args.which)
    print(brief(a))
    print(decide(a, status))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
