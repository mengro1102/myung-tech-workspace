"""에이전트가 제안한 파일을, 사람이 승인해야 디스크에 쓴다.

에이전트는 글만 쓴다. 그래서 코드를 시키면 코드 블록으로 내놓고, 그것을 사람이
손으로 옮겨 붙여야 했다. 그 왕복을 없애되 자율 실행은 주지 않는다 —
`[파일] 경로` 다음의 코드 블록을 **제안**으로 받아 승인 큐에 올리고, 사장님이
승인을 누른 순간에만 쓴다.

파일이 실제로 생기거나, 큐에 남아 있거나, 둘 중 하나뿐이다. "만들었습니다"라고
말만 하는 상태가 사라진다.

쓰기 범위는 workspace/ 안으로 제한한다. 여기는 산출물이 떨어지는 곳이고,
저장소 코드나 설정은 사람이 직접 고치는 편이 맞다.
"""
from __future__ import annotations

import re
from pathlib import Path

WORKSPACE_ROOT = (Path(__file__).resolve().parent.parent / "workspace").resolve()

FILE_MARK = "[파일]"
# ```lang 다음 줄부터 ``` 앞까지. lang 은 있어도 없어도 된다.
_FENCE = re.compile(r"^```[^\n]*\n(.*?)^```", re.S | re.M)
MAX_BYTES = 256 * 1024


class ProposalError(ValueError):
    """제안이 규칙을 벗어났다. 메시지를 그대로 사람에게 보여 준다."""


def clean_rel(rel: str) -> str:
    """모델이 적어 준 경로를 다듬는다.

    백틱으로 감싸 오는 일이 흔하다(`tests/test_hello.py`). 화면과 디스크
    양쪽에 그대로 새지 않게 여기서 한 번만 정리한다.

    앞의 `/` 는 떼어 상대경로로 본다 — "/etc/passwd" 는 거부가 아니라
    workspace/etc/passwd 가 된다. 어차피 workspace 밖으로는 못 나가므로
    안전하고, 모델이 절대경로를 적었다고 제안 전체를 버릴 이유는 없다.
    """
    rel = (rel or "").strip().strip("`").strip().replace("\\", "/").lstrip("/")
    # 프롬프트가 "workspace 기준 상대경로"라고 일러 줘도 모델은 workspace/ 를
    # 붙여 쓴다. 그대로 두면 workspace/workspace/... 가 된다. 한 겹만 벗긴다.
    if rel.lower().startswith("workspace/"):
        rel = rel[len("workspace/"):]
    return rel


def safe_path(rel: str) -> Path:
    """workspace 안으로 해석한다. 벗어나면 거부.

    `..` 뿐 아니라 절대경로와 드라이브 문자도 막아야 한다 — resolve() 후
    workspace 아래인지 다시 확인하는 것이 유일하게 믿을 만한 방법이다.
    """
    rel = clean_rel(rel)
    if not rel:
        raise ProposalError("경로가 비어 있습니다")
    p = (WORKSPACE_ROOT / rel).resolve()
    if p != WORKSPACE_ROOT and WORKSPACE_ROOT not in p.parents:
        raise ProposalError(f"workspace 밖으로 나가는 경로입니다: {rel}")
    if p.is_dir():
        raise ProposalError(f"디렉터리입니다: {rel}")
    return p


def harvest(result: str, limit: int = 3) -> list[dict]:
    """답변에서 `[파일] 경로` + 바로 뒤 코드 블록을 꺼낸다.

    모델이 표시를 굵게 쓰거나 목록 기호를 붙이는 일이 흔해 앞쪽 장식은 걷어낸다.
    코드 블록이 뒤따르지 않는 표시는 버린다 — 경로만 있고 내용이 없으면 쓸 수
    없다.
    """
    out: list[dict] = []
    lines = result.splitlines(keepends=True)
    offsets, pos = [], 0
    for ln in lines:
        offsets.append(pos)
        pos += len(ln)

    for i, raw in enumerate(lines):
        line = raw.strip().lstrip("-*•> ").replace("**", "").strip()
        if not line.startswith(FILE_MARK):
            continue
        rel = clean_rel(line[len(FILE_MARK):].strip(" :：-—"))
        if not rel:
            continue
        try:
            safe_path(rel)          # 못 쓸 경로면 제안 자체를 만들지 않는다
        except ProposalError:
            continue
        m = _FENCE.search(result, offsets[i] + len(raw))
        if not m:
            continue
        body = m.group(1)
        if len(body.encode("utf-8")) > MAX_BYTES:
            continue
        out.append({"path": rel, "content": body})
        if len(out) >= limit:
            break
    return out


def write(rel: str, content: str) -> str:
    """승인된 제안을 실제로 쓴다. workspace 기준 상대경로를 돌려준다."""
    p = safe_path(rel)
    data = content.encode("utf-8")
    if len(data) > MAX_BYTES:
        raise ProposalError(f"파일이 너무 큽니다({len(data)} bytes, 한도 {MAX_BYTES})")
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return str(p.relative_to(WORKSPACE_ROOT)).replace("\\", "/")
