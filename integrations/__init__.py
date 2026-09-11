"""연동 레지스트리.

이 패키지를 import 하면 각 연동이 스스로 등록된다.

읽기:  context_block(instruction) → 프롬프트에 넣을 '실제 데이터' 블록
쓰기:  harvest(text) → [실행] 제안 목록,  run_action(name, action, args) → 실제 호출
"""
from __future__ import annotations

import json
import re

from . import base  # noqa: F401
from . import github, paypal, youtube, youtube_lookup  # noqa: F401  (import 하는 것만으로 등록된다)
from .base import (Action, Integration, IntegrationError, NotConfigured,  # noqa: F401
                   Probe, all_integrations, env, get, register)

# 에이전트가 바깥 행위를 제안할 때 쓰는 표시. [파일] 과 같은 모양이다.
ACTION_MARK = "[실행]"
_FENCE = re.compile(r"```(?:json)?\s*(.+?)```", re.S)

# 어떤 말이 나오면 어떤 연동의 데이터를 붙일지. 지시문에 단서가 없으면
# 아무것도 붙이지 않는다 — 매번 전부 조회하면 할당량이 순식간에 마른다.
_TRIGGERS: dict[str, tuple[str, ...]] = {
    "youtube_data":  ("유튜브", "youtube", "채널", "영상", "구독자", "조회수", "썸네일"),
    "youtube_oauth": ("유튜브", "youtube", "시청", "지속률", "트래픽", "구독자", "애널리틱스"),
    "paypal":        ("페이팔", "paypal", "수익", "매출", "결제", "정산", "입금"),
    "github":        ("깃헙", "github", "레포", "repo", "웹사이트", "블로그", "배포", "커밋"),
}


def status_all() -> list[dict]:
    """연동 카드가 쓸 현재 상태. 각각 실제로 한 번 호출해 본다."""
    return [i.status() for i in all_integrations()]


def context_block(instruction: str, budget: int = 2500) -> tuple[str, list[str]]:
    """지시문과 관련된 연동의 **실제 데이터**를 모아 한 덩어리로.

    (블록, 사용된 연동 이름들) 을 돌려준다. 관련이 없으면 빈 문자열이다.

    이것이 이 패키지의 핵심이다. 디스패처는 LLM 호출 한 번이고 도구 루프가
    없다. 그러니 에이전트가 API 를 부르게 만들 수는 없다 — 대신 서버가 먼저
    조회해서 사실을 프롬프트에 넣는다. 지식베이스(kb_context)와 같은 방식이다.
    이게 없으면 "채널 분석" 은 채널을 본 적 없는 모델의 추측이다.
    """
    low = (instruction or "").lower()
    blocks, used = [], []
    for integ in all_integrations():
        if integ.context is None:
            continue
        words = _TRIGGERS.get(integ.name, ())
        if words and not any(w in low for w in words):
            continue
        if base.missing_keys(*integ.required):
            continue
        try:
            b = integ.context(instruction)
        except Exception:  # noqa: BLE001
            b = ""        # 조회 실패로 작업이 막히면 안 된다
        if b:
            blocks.append(b)
            used.append(integ.name)
        if sum(len(x) for x in blocks) > budget:
            break
    if not blocks:
        return "", []
    return base.truncate("\n\n".join(blocks), budget), used


# ── 쓰기 제안 수확 ──────────────────────────────────────────────────────
def harvest(text: str, limit: int = 3) -> list[dict]:
    """답변에서 `[실행]` 제안을 꺼낸다.

        [실행] youtube_oauth.upload
        ```json
        {"file": "videos/ep1.mp4", "title": "1화", "privacy": "private"}
        ```

    파일 제안과 같은 모양이다 — 표시 한 줄 + 바로 다음 코드 블록.
    여기서는 **꺼내기만** 한다. 실제 호출은 결재 승인 뒤에 일어난다.
    """
    out: list[dict] = []
    lines = text.splitlines()
    for i, raw in enumerate(lines):
        line = raw.strip().lstrip("-*•> ").replace("**", "").strip()
        if not line.startswith(ACTION_MARK):
            continue
        target = line[len(ACTION_MARK):].strip(" :：`").strip()
        if "." not in target:
            continue
        name, _, action_id = target.partition(".")
        name, action_id = name.strip(), action_id.strip()
        integ = get(name)
        if integ is None or action_id not in integ.actions:
            continue
        m = _FENCE.search("\n".join(lines[i + 1:i + 60]))
        if not m:
            continue
        try:
            args = json.loads(m.group(1))
        except Exception:  # noqa: BLE001
            continue
        if not isinstance(args, dict):
            continue
        out.append({"integration": name, "action": action_id,
                    "label": integ.actions[action_id].label, "args": args})
        if len(out) >= limit:
            break
    return out


def run_action(name: str, action_id: str, args: dict) -> str:
    """승인된 행위를 실제로 실행한다. 사람이 읽을 결과 한 줄을 돌려준다."""
    integ = get(name)
    if integ is None:
        raise IntegrationError(f"알 수 없는 연동: {name}")
    act = integ.actions.get(action_id)
    if act is None:
        raise IntegrationError(f"{integ.label} 에 '{action_id}' 동작이 없습니다.")
    return act.run(args or {})


def action_catalog() -> str:
    """에이전트에게 알려 줄 '지금 실제로 쓸 수 있는 행위' 목록.

    설정이 안 된 연동은 넣지 않는다. 못 쓰는 것을 알려 주면 에이전트가
    그걸 제안하고, 사장님은 승인할 수 없는 결재를 보게 된다.
    """
    lines = []
    for integ in all_integrations():
        if not integ.actions or base.missing_keys(*integ.required):
            continue
        for aid, act in sorted(integ.actions.items()):
            args = ", ".join(f"{k}: {v}" for k, v in act.schema.items())
            lines.append(f"- `{ACTION_MARK} {integ.name}.{aid}` — {act.label}\n"
                         f"    인자: {args}")
    return "\n".join(lines)
