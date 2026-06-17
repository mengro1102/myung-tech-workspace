#!/usr/bin/env python3
"""
명테크 Telegram Gateway
──────────────────────
단일 봇으로 오케스트레이터에 연결하는 게이트웨이.

사용법:
  pip install pyTelegramBotAPI
  TELEGRAM_BOT_TOKEN=<token> python telegram_gateway.py

흐름:
  Telegram 메시지
    → orchestration_dept task 생성 (오케스트레이터가 부서 라우팅 판단)
    → agent_dispatcher가 처리
    → 결과 Telegram으로 전송

명령어:
  /start    — 환영 메시지
  /status   — 에이전트 현황
  /dept <부서명> <지시>  — 특정 부서에 직접 지시
  일반 메시지  — 오케스트레이터가 자동 라우팅
"""

from __future__ import annotations

import json
import os
import sys
import time
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "shared_memory"))
sys.path.insert(0, str(ROOT / "bridge"))

import task_queue
import message_broker

try:
    import telebot
except ImportError:
    print("[ERROR] pyTelegramBotAPI가 설치되지 않았습니다.")
    print("  pip install pyTelegramBotAPI")
    sys.exit(1)

# ── 설정 ──────────────────────────────────────────────
TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
if not TOKEN:
    print("[ERROR] TELEGRAM_BOT_TOKEN 환경변수를 설정하세요.")
    print("  export TELEGRAM_BOT_TOKEN=<your_bot_token>   (Linux/Mac)")
    print("  $env:TELEGRAM_BOT_TOKEN='<token>'             (PowerShell)")
    sys.exit(1)

POLL_INTERVAL   = 2.0   # 태스크 완료 대기 폴링 간격(초)
POLL_TIMEOUT    = 360   # 최대 대기 시간(초) — 초과 시 타임아웃 안내
SENDER_ID       = "telegram_gateway"

DEPT_MAP = {
    "리서치": "research_dept",
    "연구":   "research_dept",
    "금융":   "finance_dept",
    "투자":   "finance_dept",
    "개발":   "dev_dept",
    "콘텐츠": "content_dept",
    "오케스": "orchestration_dept",
}

bot = telebot.TeleBot(TOKEN, parse_mode=None)

# ── 오케스트레이터 system prompt (라우팅 판단 포함) ──────
ORCH_SYSTEM = (
    "너는 명테크의 총괄 모더레이터 김효율이다.\n"
    "텔레그램으로 들어온 디렉터의 지시를 받아 처리한다.\n\n"
    "처리 방식:\n"
    "1. 지시 내용을 분석해 어느 부서가 담당해야 하는지 판단한다.\n"
    "   - 리서치/논문/데이터 → research_dept\n"
    "   - 주식/투자/금융 분석 → finance_dept\n"
    "   - 코딩/개발/버그 → dev_dept\n"
    "   - 글쓰기/디자인/콘텐츠 → content_dept\n"
    "   - 복합적이거나 전략적 → 직접 처리\n"
    "2. 응답은 한국어로, 간결하고 실행 가능한 형태로 작성한다.\n"
    "3. 응답 마지막 줄에 반드시 다음 형식을 포함한다:\n"
    "   [ROUTE: <dept_id>] 또는 [ROUTE: self]\n"
    "   (dept_id 예시: research_dept, finance_dept, dev_dept, content_dept)"
)


# ── 헬퍼 ──────────────────────────────────────────────

def _wait_for_task(task_id: str) -> str | None:
    """태스크 완료까지 폴링. 결과 문자열 또는 None(타임아웃) 반환."""
    deadline = time.time() + POLL_TIMEOUT
    while time.time() < deadline:
        t = task_queue.get_task(task_id)
        if t and t["status"] == "done":
            return t.get("result") or "(결과 없음)"
        if t and t["status"] == "failed":
            return f"❌ 처리 실패: {t.get('result', '알 수 없는 오류')}"
        time.sleep(POLL_INTERVAL)
    return None


def _dispatch_and_reply(chat_id: int, instruction: str, target_dept: str = "orchestration_dept"):
    """태스크 생성 → 완료 대기 → Telegram 응답 (별도 스레드에서 실행)."""
    task = task_queue.enqueue(
        sender=SENDER_ID,
        target_dept=target_dept,
        instruction=instruction,
        priority=8,
    )
    task_id = task["task_id"]

    # 처리 중 안내 (즉각 피드백)
    dept_label = {
        "orchestration_dept": "🧠 오케스트레이터",
        "research_dept":      "🔬 리서치팀",
        "finance_dept":       "📈 금융팀",
        "dev_dept":           "⚙️ 개발팀",
        "content_dept":       "✍️ 콘텐츠팀",
    }.get(target_dept, target_dept)

    bot.send_message(chat_id, f"⏳ {dept_label}에 전달 중… (`{task_id}`)", parse_mode="Markdown")

    result = _wait_for_task(task_id)
    if result is None:
        bot.send_message(
            chat_id,
            f"⏰ 응답 시간 초과 ({POLL_TIMEOUT}초)\n"
            f"dispatcher가 실행 중인지 확인하세요.\n"
            f"  `python run.py dispatch daemon`",
            parse_mode="Markdown",
        )
        return

    # 결과 메시지 (4096자 Telegram 제한 처리)
    header = f"*{dept_label} 결과*\n\n"
    body   = result
    full   = header + body
    if len(full) > 4096:
        full = full[:4090] + "\n…(생략)"
    bot.send_message(chat_id, full, parse_mode="Markdown")

    # shared_memory 이벤트에도 기록
    message_broker.publish_event(
        sender=target_dept,
        target="telegram_user",
        payload=f"[TG:{chat_id}] {result[:200]}",
    )


# ── 명령어 핸들러 ──────────────────────────────────────

@bot.message_handler(commands=["start", "help"])
def handle_start(msg):
    text = (
        "👋 *명테크 Agent Studio*에 오신 것을 환영합니다!\n\n"
        "저는 총괄 모더레이터 *김효율*입니다.\n"
        "메시지를 보내시면 적절한 부서에 라우팅하여 처리합니다.\n\n"
        "📌 *직접 지시 명령어*\n"
        "`/dept 리서치 <지시>` — 리서치팀 직접 지시\n"
        "`/dept 금융 <지시>`   — 금융팀 직접 지시\n"
        "`/dept 개발 <지시>`   — 개발팀 직접 지시\n"
        "`/dept 콘텐츠 <지시>` — 콘텐츠팀 직접 지시\n\n"
        "`/status`             — 시스템 현황\n\n"
        "또는 자유롭게 지시사항을 입력하면 자동으로 담당 부서를 찾아드립니다."
    )
    bot.send_message(msg.chat.id, text, parse_mode="Markdown")


@bot.message_handler(commands=["status"])
def handle_status(msg):
    bridge_path = ROOT / "bridge" / "bridge_state.json"
    if not bridge_path.exists():
        bot.send_message(msg.chat.id, "⚠️ bridge_state.json 없음. `python run.py bridge` 실행 필요.")
        return

    state = json.loads(bridge_path.read_text(encoding="utf-8"))
    depts = state.get("departments", [])
    tasks = state.get("task_queue", [])

    from collections import Counter
    status_count = Counter(t.get("status") for t in tasks)

    lines = ["*🏢 명테크 시스템 현황*\n"]
    for d in depts:
        icon = "🟢" if d["status"] == "Ready" else "🔴"
        lines.append(f"{icon} {d['name']} — `{d['assigned_brain'].split('/')[-1]}`")

    if tasks:
        lines.append(f"\n*📋 태스크 큐*: {dict(status_count)}")
    else:
        lines.append("\n*📋 태스크 큐*: 비어 있음")

    bot.send_message(msg.chat.id, "\n".join(lines), parse_mode="Markdown")


@bot.message_handler(commands=["dept"])
def handle_dept(msg):
    parts = msg.text.split(maxsplit=2)
    if len(parts) < 3:
        bot.send_message(msg.chat.id, "사용법: `/dept <부서> <지시>`\n예: `/dept 리서치 최신 RAG 논문 요약`", parse_mode="Markdown")
        return

    dept_key    = parts[1]
    instruction = parts[2]
    target      = DEPT_MAP.get(dept_key, "orchestration_dept")

    if target == "orchestration_dept" and dept_key not in DEPT_MAP:
        bot.send_message(msg.chat.id, f"❓ 알 수 없는 부서: `{dept_key}`\n리서치/금융/개발/콘텐츠 중 하나를 입력하세요.", parse_mode="Markdown")
        return

    threading.Thread(
        target=_dispatch_and_reply,
        args=(msg.chat.id, instruction, target),
        daemon=True,
    ).start()


@bot.message_handler(func=lambda m: True)
def handle_text(msg):
    """일반 텍스트 → 오케스트레이터 라우팅."""
    instruction = (
        f"{ORCH_SYSTEM}\n\n"
        f"디렉터 지시: {msg.text}"
    )
    threading.Thread(
        target=_dispatch_and_reply,
        args=(msg.chat.id, instruction, "orchestration_dept"),
        daemon=True,
    ).start()


# ── 진입점 ─────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 50)
    print("  명테크 Telegram Gateway 시작")
    print("  봇 토큰 확인 중…")

    try:
        me = bot.get_me()
        print(f"  봇 이름  : {me.first_name}")
        print(f"  봇 username: @{me.username}")
    except Exception as e:
        print(f"  [ERROR] 봇 연결 실패: {e}")
        sys.exit(1)

    print("  dispatcher도 함께 실행하세요:")
    print("    python run.py dispatch daemon")
    print("=" * 50)
    print("  대기 중… (Ctrl+C로 종료)\n")

    bot.infinity_polling(timeout=30, long_polling_timeout=20)
