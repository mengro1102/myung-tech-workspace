"""사장님에게 알린다 — 디스코드를 먼저, 텔레그램은 예비로.

자율 프로젝트는 사람이 화면을 보고 있지 않을 때 돈다. 멈췄는데 아무도
모르면 멈춘 게 아니라 사라진 것이다 — 그래서 정지·완료·승인 요청은
반드시 밖으로 나가야 한다.

## 왜 디스코드로 옮겼나

사장님 말씀: "명비서 반응은 메인이 텔레그램이라 그런지 텔레그램으로 알림이
울려. 디스코드로는 안 울려. 단, 디스코드로 메시지 보냈을 때는 디스코드로
답변 알림이 울려."

확인해 보니 맹비서 쪽은 **이미 디스코드가 홈 채널**이었다
(`DISCORD_HOME_CHANNEL` 설정, 텔레그램 키는 주석). 텔레그램으로 울리던 것은
**명테크 쪽 알림**, 즉 이 파일이었다 — 명테크 .env 에 `TELEGRAM_CHAT_ID` 가
없어 맹비서 .env 의 텔레그램 채널로 떨어지고 있었다. 그래서 디스코드로 말을
걸면 디스코드가 답하고, 가만히 두면 텔레그램이 울리는 모양이 됐다.

## 알림과 조치는 같은 창에 있어야 한다

이 파일의 예전 주석이 남긴 교훈이다 — 알림은 맹비서 창에 오는데 결재
버튼은 명테크 봇에만 있어서, 알림을 보고 그 자리에서 `/결재` 를 치면
"Unknown command" 가 돌아왔다.

디스코드는 그 조건을 만족한다. 맹비서의 `/skill` 에 결재 스킬이 올라가
있으므로(`skills/myungtech/approvals`), 알림을 받은 그 채널에서 바로
결재할 수 있다.

## 텔레그램을 지우지 않는 이유

디스코드가 막히면(토큰 만료·채널 삭제·장애) 알림이 **조용히 사라진다**.
멈춘 것을 아무도 모르는 상태가 이 파일이 막으려는 바로 그것이다. 그래서
디스코드가 실패할 때만 텔레그램으로 간다 — 평소에는 한 군데만 울린다.
"""
from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

MYUNG_TECH = Path(__file__).resolve().parent.parent
HERMES = Path(r"D:\AI_Workspace\hermes")

TELEGRAM_API = "https://api.telegram.org/bot{}/sendMessage"
DISCORD_API = "https://discord.com/api/v10/channels/{}/messages"

# 디스코드 한 메시지 상한은 2000자다. 넘으면 400 이 돌아오고 알림이 통째로
# 사라지므로, 자르고 잘렸다는 사실을 끝에 적는다.
DISCORD_LIMIT = 1900

# Discord 가 요구하는 형식: `DiscordBot ($url, $version)`.
# 없으면 Cloudflare 가 403 / error code 1010 으로 막는다.
USER_AGENT = "DiscordBot (https://github.com/myeongro/myung-tech, 1.3)"


def _from_env_file(path: Path, key: str) -> str:
    """주석이 아닌 첫 줄의 값. 같은 키가 여러 번 있을 수 있다.

    실제로 hermes/.env 에는 `TELEGRAM_BOT_TOKEN` 이 두 줄 있다 — 하나는
    주석이고 하나는 살아 있다. 주석만 보고 "꺼져 있다" 고 판단하면 틀린다.
    """
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if line.startswith("#") or not line.startswith(f"{key}="):
                continue
            v = line.split("=", 1)[1].strip().strip('"').strip("'")
            if v:
                return v
    except OSError:
        pass
    return ""


def _cred(env_key: str, *sources: tuple[Path, str]) -> str:
    """환경변수 먼저, 없으면 .env 들을 차례로."""
    v = os.environ.get(env_key, "").strip()
    if v:
        return v
    for path, key in sources:
        v = _from_env_file(path, key)
        if v:
            return v
    return ""


def discord_credentials() -> tuple[str, str]:
    """(봇 토큰, 채널 ID). 둘 다 맹비서 .env 에 이미 있다."""
    tok = _cred("DISCORD_BOT_TOKEN",
                (MYUNG_TECH / ".env", "DISCORD_BOT_TOKEN"),
                (HERMES / ".env", "DISCORD_BOT_TOKEN"))
    ch = _cred("DISCORD_CHANNEL_ID",
               (MYUNG_TECH / ".env", "DISCORD_CHANNEL_ID"),
               (HERMES / ".env", "DISCORD_HOME_CHANNEL"))
    return tok, ch


# DM 채널 id 는 한 번 열면 바뀌지 않는다. 알림마다 다시 열면 호출 낭비이고
# 디스코드가 그 호출도 레이트리밋한다.
_DM_CACHE = MYUNG_TECH / "shared_memory" / "store" / "discord_dm.json"


def dm_recipient() -> str:
    """DM 을 받을 사용자 id. 여러 명이면 첫 번째(사장님)."""
    raw_ids = _cred("DISCORD_DM_USER",
                    (MYUNG_TECH / ".env", "DISCORD_DM_USER"),
                    (HERMES / ".env", "DISCORD_ALLOWED_USERS"))
    for part in str(raw_ids).replace(";", ",").split(","):
        p = part.strip()
        if p.isdigit():
            return p
    return ""


def _dm_channel(tok: str) -> tuple[str, str]:
    """(DM 채널 id, 실패 사유). 캐시 → 없으면 디스코드에 연다.

    실패해도 예외를 올리지 않는다 — 알림이 안 갔다고 프로젝트가 죽으면 안
    된다. 대신 사유를 돌려주어 호출하는 쪽이 서버 채널로 내려가게 한다.
    """
    uid = dm_recipient()
    if not uid:
        return "", "DM 받을 사용자 id 가 없습니다 (DISCORD_ALLOWED_USERS)"

    try:
        if _DM_CACHE.exists():
            cached = json.loads(_DM_CACHE.read_text(encoding="utf-8"))
            if cached.get("user") == uid and cached.get("channel"):
                return str(cached["channel"]), ""
    except Exception:  # noqa: BLE001
        pass                      # 캐시가 깨졌으면 다시 연다

    try:
        req = urllib.request.Request(
            "https://discord.com/api/v10/users/@me/channels",
            data=json.dumps({"recipient_id": uid}).encode("utf-8"),
            headers={"Content-Type": "application/json",
                     "User-Agent": USER_AGENT,
                     "Authorization": f"Bot {tok}"},
            method="POST")
        with urllib.request.urlopen(req, timeout=15) as r:
            ch = str((json.loads(r.read().decode("utf-8")) or {}).get("id") or "")
    except Exception as e:  # noqa: BLE001
        return "", f"DM 채널을 열지 못했습니다: {e}"
    if not ch:
        return "", "DM 채널 id 를 받지 못했습니다"

    try:
        _DM_CACHE.parent.mkdir(parents=True, exist_ok=True)
        _DM_CACHE.write_text(json.dumps({"user": uid, "channel": ch},
                                        ensure_ascii=False), encoding="utf-8")
    except OSError:
        pass                      # 캐시를 못 써도 이번 발송은 된다
    return ch, ""


def credentials() -> tuple[str, str]:
    """(텔레그램 토큰, 채널). 이제는 예비 경로다."""
    tok = _cred("TELEGRAM_BOT_TOKEN",
                (MYUNG_TECH / ".env", "TELEGRAM_BOT_TOKEN"),
                (HERMES / ".env", "TELEGRAM_BOT_TOKEN"))
    chat = _cred("TELEGRAM_CHAT_ID",
                 (MYUNG_TECH / ".env", "TELEGRAM_CHAT_ID"),
                 (HERMES / ".env", "TELEGRAM_HOME_CHANNEL"))
    return (tok, chat) if (tok and chat) else ("", "")


def _post(url: str, payload: dict, headers: dict) -> tuple[bool, str]:
    try:
        # Discord 는 Cloudflare 뒤에 있고, urllib 기본 User-Agent
        # (`Python-urllib/3.11`)는 "브라우저 무결성 검사" 에 걸려 **HTTP 403
        # error code 1010** 으로 거절된다. 실측으로 확인했다 — 알림이
        # 조용히 텔레그램으로 넘어가고 있었다.
        #
        # Discord 문서가 요구하는 형식은 `DiscordBot ($url, $version)` 이다.
        # 텔레그램에는 없어도 되지만 붙여서 해로울 것이 없으므로 공통으로 둔다.
        req = urllib.request.Request(
            url, data=json.dumps(payload).encode("utf-8"),
            headers={"Content-Type": "application/json",
                     "User-Agent": USER_AGENT, **headers}, method="POST")
        with urllib.request.urlopen(req, timeout=15) as r:
            return 200 <= r.status < 300, ""
    except urllib.error.HTTPError as exc:
        return False, f"HTTP {exc.code}: {exc.read().decode('utf-8', 'replace')[:160]}"
    except Exception as exc:  # noqa: BLE001
        return False, str(exc)[:160]


def _send_discord(text: str) -> tuple[bool, str]:
    """DM 으로 보낸다. 안 되면 서버 채널로.

    사장님이 정리하신 용도 경계:

      DM        — 명테크의 전체적인 인터랙션(착수 승인·완료·정지)
      서버 채널 — 맹비서에게 질의하고 **스레드로** 답을 받는 자리

    전에는 DISCORD_HOME_CHANNEL(서버 채널)로만 보냈다. 그래서 결재 알림이
    맹비서 질의 스레드들 사이에 섞여 쌓였다 — 알림은 조치가 필요하고 질의
    스레드는 주제별로 모여 있어야 하니, 성격이 다른 둘을 한 자리에 두면
    양쪽 다 쓰기 나빠진다.

    서버 채널을 **버리지는 않는다.** DM 이 막혀 있으면(봇과 DM 차단, 공통
    서버 없음) 알림이 통째로 사라진다. 내려갈 때는 폴백임을 밝힌다.
    """
    tok, ch = discord_credentials()
    if not tok:
        return False, "디스코드 토큰이 없습니다"
    body = text if len(text) <= DISCORD_LIMIT else (
        text[:DISCORD_LIMIT] + "\n\n…(길어서 잘림 — 대시보드에서 전체를 보세요)")

    dm, why = _dm_channel(tok)
    if dm:
        ok, err = _post(DISCORD_API.format(dm), {"content": body},
                        {"Authorization": f"Bot {tok}"})
        if ok:
            return True, ""
        why = f"DM 발송 실패({err})"

    if not ch:
        return False, f"{why}; 서버 채널도 없습니다"
    ok, err = _post(
        DISCORD_API.format(ch),
        {"content": f"⚠️ DM 으로 보내지 못해 이 채널로 보냅니다 — {why}\n"
                    f"(이 채널은 맹비서 질의용입니다)\n\n{body}"[:DISCORD_LIMIT]},
        {"Authorization": f"Bot {tok}"})
    return ok, "" if ok else f"{why}; 서버 채널도 실패({err})"

def _send_telegram(text: str) -> tuple[bool, str]:
    tok, chat = credentials()
    if not (tok and chat):
        return False, "텔레그램 토큰 또는 채널이 없습니다"
    return _post(TELEGRAM_API.format(tok),
                 {"chat_id": chat, "text": text[:3900],
                  "disable_web_page_preview": True}, {})


def send(text: str, quiet: bool = False) -> bool:
    """디스코드로 보낸다. 실패하면 텔레그램으로 한 번 더.

    평소에는 **한 군데만** 울린다. 두 곳 모두로 보내면 같은 알림이 두 번
    오고, 그러면 사장님이 둘 다 무시하게 된다.

    설정이 없거나 실패해도 예외를 올리지 않는다 — 알림이 안 갔다고
    프로젝트가 죽어서는 안 된다.
    """
    # 바깥 서버다. _ask 에서 한 번 가렸지만 정지 사유·예산 경고처럼
    # _ask 를 거치지 않는 문구도 여기로 온다. 나가는 문에서 한 번 더 본다 —
    # 두 번 가려도 손해가 없다.
    try:
        from shared_memory import secrets_guard
        text = secrets_guard.mask(text)
    except Exception:  # noqa: BLE001
        pass

    ok, why = _send_discord(text)
    if ok:
        return True

    # 폴백 메시지는 **자기가 폴백임을 밝힌다.**
    #
    # 전에는 그냥 같은 내용을 텔레그램으로 보냈다. 그래서 디스코드가
    # HTTP 403(Cloudflare, User-Agent 누락)으로 막혀 있던 동안 사장님은
    # 평범한 명테크 알림을 텔레그램에서 받았고, **"디스코드로 설정했는데 왜
    # 텔레그램으로 오나" 로 두 번 물으셨다.** 설정 문제처럼 보인 것이다.
    #
    # 한 줄만 붙이면 그 질문이 사라진다 — 어디가 막혔는지가 메시지에 있다.
    tg_ok, tg_why = _send_telegram(
        f"⚠️ 디스코드로 보내지 못해 여기로 보냅니다 — {why}\n"
        f"(디스코드가 정상이면 이 알림은 디스코드로만 갑니다)\n\n" + text)
    if not quiet:
        # 실패를 삼키지 않는다. 알림이 안 가는 것을 모르는 상태가 가장 나쁘다.
        where = "텔레그램으로 대신 보냈습니다" if tg_ok else f"텔레그램도 실패({tg_why})"
        print(f"[notify] 디스코드 실패({why}) — {where}", file=sys.stderr)
    return tg_ok


def status() -> dict:
    """어디로 나가는지. 진단과 설정 화면이 쓴다 — 토큰 값은 숨긴다."""
    dtok, dch = discord_credentials()
    ttok, tchat = credentials()

    # 캐시된 DM 채널만 본다 — status() 는 진단용이라 디스코드에 호출을 날리지
    # 않는다. 한 번도 안 열었으면 "channel" 로 보이고, 첫 발송 때 열린다.
    _dm = ""
    try:
        if _DM_CACHE.exists():
            _c = json.loads(_DM_CACHE.read_text(encoding="utf-8"))
            if _c.get("user") == dm_recipient():
                _dm = str(_c.get("channel") or "")
    except Exception:  # noqa: BLE001
        pass

    return {
        "primary": ("discord" if (dtok and (dch or _dm))
                    else ("telegram" if (ttok and tchat) else "없음")),
        # **어디로** 가는지가 요점이다. 전에는 서버 채널만 적어서, 화면이
        # "준비됨" 이라고 해도 DM 인지 채널인지 알 수 없었다.
        "discord": {
            "ready": bool(dtok and (dch or _dm)),
            "target": "dm" if _dm else ("channel" if dch else None),
            "dm": bool(_dm),
            "channel": dch or "",          # DM 이 막혔을 때 내려갈 자리
        },
        "telegram": {"ready": bool(ttok and tchat), "chat": tchat or ""},
    }


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    print(json.dumps(status(), ensure_ascii=False, indent=2))
    if len(sys.argv) > 1 and sys.argv[1] == "test":
        msg = " ".join(sys.argv[2:]) or "[명테크] 알림 경로 시험입니다."
        print("보냄:", send(msg))
