"""결재를 되돌릴 수 있는 정도로 세 등급으로 나눈다.

결재함에는 등급이 없었다. 파일 저장과 유튜브 업로드가 **같은 모양의 버튼**
하나로 보였다. 한쪽은 workspace 안에 파일을 하나 쓰는 것이고, 다른 쪽은
공개된 채널에 영상을 올려 되돌릴 수 없는데, 화면은 둘을 구분해 주지 않았다.

그리고 실제로 일어난 일 — 사장님이 결재 11건을 1분 안에 연달아 누르셨다.
여섯 번째쯤이면 누르는 것이 반사가 된다. 그 반사는 안건을 읽고 나오는 것이
아니므로, 같은 줄에 섞인 되돌릴 수 없는 한 건도 똑같은 반사를 받는다.
업계가 **승인 피로(approval fatigue)** 라고 이름 붙인 바로 그것이다.

## 등급

| 등급 | 뜻 | 일괄 승인 |
|---|---|---|
| 1 내부 | 부서에 태스크를 하나 넣는다. 사람이 언제든 지울 수 있다 | 가능 |
| 2 쓰기 | workspace 에 파일을 쓰거나 프로젝트를 시작한다. 파일은 지우면 되고 프로젝트는 중단하면 된다 | 가능 |
| 3 바깥 | 업로드·PR·발송. **바깥으로 나가면 되돌릴 수 없다** | **불가** |

3등급을 일괄에서 뺀 것이 이 모듈의 핵심이다. 등급 색만 입히고 일괄에 같이
넣으면 결국 같은 반사를 받는다 — 색은 반사를 멈추지 못한다. 한 번에 한
건만 누를 수 있어야 비로소 읽게 된다.
"""
from __future__ import annotations

# 바깥으로 나가는 종류. 늘어날 때 여기만 고치면 된다.
OUTWARD = {"action"}
# workspace 안을 바꾸는 종류.
WRITE = {"file", "project"}

TIERS = {
    1: {"name": "내부", "tone": "muted",
        "why": "부서에 태스크를 넣습니다. 언제든 지울 수 있습니다."},
    2: {"name": "쓰기", "tone": "write",
        "why": "workspace 에 쓰거나 프로젝트를 시작합니다. 되돌릴 수 있습니다."},
    3: {"name": "바깥", "tone": "danger",
        "why": "바깥으로 나갑니다. 실행되면 되돌릴 수 없습니다."},
}

BATCHABLE_MAX = 2        # 이 등급까지만 일괄 승인


def tier(row: dict) -> int:
    kind = (row or {}).get("kind") or ""
    if kind in OUTWARD:
        return 3
    if kind in WRITE:
        return 2
    return 1


def annotate(row: dict) -> dict:
    """행에 등급 정보를 붙인 사본. 저장하지 않고 응답에만 쓴다.

    저장하지 않는 이유 — 등급 규칙이 바뀌면 이미 저장된 행은 옛 등급을 그대로
    들고 있게 된다. 규칙은 한 곳(위 표)에만 있고, 읽을 때마다 계산한다.
    """
    t = tier(row)
    meta = TIERS[t]
    out = dict(row)
    out["tier"] = t
    out["tier_name"] = meta["name"]
    out["tier_tone"] = meta["tone"]
    out["tier_why"] = meta["why"]
    out["batchable"] = t <= BATCHABLE_MAX
    return out


def split(rows: list[dict]) -> tuple[list[dict], list[dict]]:
    """(일괄 가능, 개별만). 일괄 승인 화면이 쓴다."""
    ok, no = [], []
    for r in rows:
        (ok if tier(r) <= BATCHABLE_MAX else no).append(r)
    return ok, no
