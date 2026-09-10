"""사장님에게 텔레그램으로 알린다.

자율 프로젝트는 사람이 화면을 보고 있지 않을 때 돈다. 멈췄는데 아무도
모르면 멈춘 게 아니라 사라진 것이다 — 그래서 정지·완료·승인 요청은
반드시 밖으로 나가야 한다.

토큰을 찾는 순서:
  1. 환경변수
  2. D:\\myung-tech-workspace\\.env          (명테크 전용 봇)
  3. D:\\AI_Workspace\\hermes\\.env          (맹비서 봇 — 이미 검증된 경로)

3번까지 내려가는 이유: 명테크 .env 에는 TELEGRAM_BOT_TOKEN 은 있어도
보낼 채널(TELEGRAM_CHAT_ID)이 없다. 맹비서 쪽은 토큰과 채널이 모두
있고 워치독·자동화 보고가 이미 그 경로로 나가고 있다. 둘 다 사장님
한 사람에게 가므로 굳이 봇을 나눌 이유가 없다.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

MYUNG_TECH = Path(__file__).resolve().parent.parent
HERMES = Path(r"D:\AI_Workspace\hermes")

# (.env 경로, 토큰 키, 채널 키) — 위에서부터 먼저 본다.
SOURCES = [
    (MYUNG_TECH / ".env", "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"),
    (HERMES / ".env", "TELEGRAM_BOT_TOKEN", "TELEGRAM_HOME_CHANNEL"),
]

API = "https://api.telegram.org/bot{}/sendMessage"


def _from_env_file(path: Path, key: str) -> str:
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("#") or not line.startswith(f"{key}="):
                continue
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def credentials() -> tuple[str, str]:
    """(토큰, 채널). 하나라도 비면 ("", "") 를 준다."""
    tok = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if tok and chat:
        return tok, chat
    for path, tok_key, chat_key in SOURCES:
        t = tok or _from_env_file(path, tok_key)
        c = _from_env_file(path, chat_key)
        if t and c:
            return t, c
    return "", ""


def send(text: str, quiet: bool = False) -> bool:
    """보냈으면 True. 설정이 없거나 실패해도 예외를 올리지 않는다 —
    알림이 안 갔다고 프로젝트가 죽어서는 안 된다."""
    token, chat = credentials()
    if not token or not chat:
        if not quiet:
            print("[notify] 텔레그램 설정 없음 — 보내지 않음", file=sys.stderr)
        return False
    body = json.dumps({"chat_id": chat, "text": text[:3900],
                       "disable_web_page_preview": True}).encode()
    req = urllib.request.Request(API.format(token), data=body,
                                 headers={"Content-Type": "application/json"})
    try:
        urllib.request.urlopen(req, timeout=15)
        return True
    except Exception as exc:  # noqa: BLE001
        if not quiet:
            print(f"[notify] 전송 실패: {exc}", file=sys.stderr)
        return False


if __name__ == "__main__":
    msg = " ".join(sys.argv[1:]) or "[명테크] notify 테스트"
    tok, chat = credentials()
    print(f"토큰 {'있음' if tok else '없음'} · 채널 {chat or '없음'}")
    print("전송" if send(msg) else "미전송")
