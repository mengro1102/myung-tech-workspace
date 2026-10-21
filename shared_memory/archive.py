#!/usr/bin/env python3
"""모델이 실제로 본 것을 그대로 남긴다 — 프롬프트 전문과 그 안의 근거.

## ④와 ①은 같은 한 가지였다

RAISE 문서에 두 줄로 적어 뒀었다:

    ④ 근거 자료 원문 스냅샷   조회한 arXiv 초록·위키 본문을 산출물과 함께 보관
    ① 전체 프롬프트 보관       지금은 지문·길이만

따로 설계하려다 보니 **프롬프트 전문 안에 근거 블록이 통째로 들어 있다.**
`_sources()` 가 만든 7,000자 블록이 그대로 user 프롬프트에 박힌다. 그러니
프롬프트를 남기면 ④가 함께 풀린다 — 그것도 "조회해 놓고 버린 것" 이 아니라
**모델이 실제로 본 것** 그대로다. 재현에 필요한 것은 후자다.

위키 **원문**(스냅샷이 아니라 그 시점의 파일 전체)은 따로 보관하지 않는다.
위키가 git 저장소이고 매일 03:00 에 커밋되므로 그 시점 상태가 이미
남아 있다 — 같은 것을 두 벌 들고 있을 이유가 없다. 다만 live 조회(arXiv·
GitHub)는 git 에 없으므로, 그 부분은 프롬프트 안의 발췌가 유일한 기록이다.
**그 한계를 방법 절에 적는다.**

## 왜 projects.json 에 넣지 않나

실측: `projects.json` 이 668 KB 이고 폴링마다 전체를 읽고 쓴다. 원자적
교체라 순간 피크는 두 배다. 프롬프트는 호출당 8,781~16,102자(중앙값
10,727)이고 호출 30회면 351 KB — 넣는 순간 1 MB 짜리 파일을 초 단위로
왕복하게 된다.

## 왜 jsonl 인가

호출마다 **덧붙이기만** 한다. JSON 배열이면 매번 전체를 읽고 다시 써야
하고, 그건 위에서 피하려던 바로 그 비용이다. jsonl 은 한 줄 append 로
끝난다.

## 실패해도 집필을 막지 않는다 — 다만 조용하지도 않다

보관은 부수적이다. 디스크가 꽉 차서 보관에 실패했다고 프로젝트를 멈추면
본말이 전도된다. 그렇다고 `except: pass` 로 삼키면 **"방법 절에 프롬프트가
있다" 고 믿는데 실제로는 없는** 상태가 된다 — `_finish()` 에서 고쳤던
것과 같은 결함이다. 그래서 실패를 세어 두고 방법 절이 그 수를 적는다.
"""
from __future__ import annotations

import io
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

try:                     # 평평하게 부를 때 — server.py 의 `import projects`
    import disk_guard
except ImportError:      # 패키지로 부를 때
    from shared_memory import disk_guard

BASE = HERE / "store" / "archive"

# 한 줄(= 호출 하나)의 상한. 프롬프트는 project_runner 가 이미
# USER_PROMPT_CHARS=16000 으로 자르지만, system 과 합치면 더 길어질 수
# 있고 상한이 없으면 어느 날 거대한 줄 하나가 들어온다.
MAX_LINE_CHARS = 60_000

# 프로젝트 하나가 쓸 수 있는 보관 용량. 넘으면 더 적지 않고 **넘었다고
# 적는다** — 조용히 버리면 "있다고 믿는데 없는" 상태가 된다.
MAX_PROJECT_BYTES = 8 * 1024 * 1024      # 8 MB. 실측 351 KB/30호출의 20배가 넘는다


def _dir(pid: str) -> Path:
    # pid 는 서버가 만든 `prj-<hex>` 지만, 경로에 쓰는 값이라 한 번 더 막는다.
    safe = "".join(c for c in str(pid) if c.isalnum() or c in "-_")[:64] or "unknown"
    return BASE / safe


def _prompts_path(pid: str) -> Path:
    return _dir(pid) / "prompts.jsonl"


def _size(pid: str) -> int:
    d = _dir(pid)
    if not d.exists():
        return 0
    return sum(f.stat().st_size for f in d.glob("*") if f.is_file())


def record_call(pid: str, row: dict) -> str:
    """호출 하나의 프롬프트 전문을 덧붙인다. 빈 문자열이면 성공.

    돌려주는 값은 **실패 사유**다 — 성공하면 빈 문자열. 호출하는 쪽이
    세어서 방법 절에 적을 수 있게 하려는 것이고, 예외를 던지지 않는
    이유는 보관 실패로 집필이 멈추면 안 되기 때문이다.
    """
    try:
        line = json.dumps(row, ensure_ascii=False)
    except Exception as e:  # noqa: BLE001
        return f"직렬화 실패: {e}"
    if len(line) > MAX_LINE_CHARS:
        return f"한 줄이 상한({MAX_LINE_CHARS:,}자)을 넘었습니다: {len(line):,}자"
    if _size(pid) + len(line) > MAX_PROJECT_BYTES:
        return (f"보관 용량 상한({MAX_PROJECT_BYTES // 1024 // 1024} MB)을 "
                f"넘어 더 적지 않았습니다")
    path = _prompts_path(pid)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        with disk_guard.writing(path):
            # append 모드 — 전체를 다시 쓰지 않는다. newline="" 로 두어야
            # 윈도우에서 \r\n 이 끼어들지 않는다(한 줄 = 한 레코드가 깨진다).
            with io.open(path, "a", encoding="utf-8", newline="") as f:
                f.write(line + "\n")
    except OSError as e:
        return disk_guard.explain(e, path) or f"쓰기 실패: {e}"
    except Exception as e:  # noqa: BLE001
        return f"쓰기 실패: {e}"
    return ""


def calls(pid: str, *, did: str = "") -> list[dict]:
    """보관된 호출들. 깨진 줄은 건너뛰되 **몇 줄이 깨졌는지 알린다**.

    조용히 건너뛰면 "보관 3건" 이라고 적히는데 실제로는 5건을 적으려다
    2건이 깨진 경우를 구분할 수 없다. 마지막 원소에 `_broken` 을 실어
    보내는 대신, 깨진 줄도 자리만 채워 돌려준다.
    """
    path = _prompts_path(pid)
    if not path.exists():
        return []
    out: list[dict] = []
    try:
        with io.open(path, encoding="utf-8", newline="") as f:
            for raw in f:
                raw = raw.strip()
                if not raw:
                    continue
                try:
                    row = json.loads(raw)
                except Exception:  # noqa: BLE001
                    out.append({"_broken": True})
                    continue
                if did and row.get("did") and row["did"] != did:
                    continue
                out.append(row)
    except OSError:
        return out
    return out


def stats(pid: str) -> dict:
    rows = calls(pid)
    broken = sum(1 for r in rows if r.get("_broken"))
    good = [r for r in rows if not r.get("_broken")]
    return {
        "calls": len(good),
        "broken": broken,
        "bytes": _size(pid),
        "path": str(_dir(pid)),
        "chars": sum(len(r.get("system") or "") + len(r.get("user") or "")
                     for r in good),
    }


def summary_md(p: dict, did: str = "") -> str:
    """방법 절에 넣을 줄. 보관이 없으면 **없다고** 적는다."""
    pid = p.get("id") or ""
    rows = [r for r in calls(pid, did=did) if not r.get("_broken")]
    fails = [f for f in (p.get("archive_fails") or []) if not did or f.get("did") == did]

    if not rows:
        out = ["- **프롬프트 전문이 보관되어 있지 않습니다.** 지문과 길이만 "
               "남아 있어, 같은 입력을 다시 만들어 재현할 수는 없습니다."]
        if fails:
            out.append(f"  - 보관 시도 {len(fails)}회가 실패했습니다: "
                       f"{fails[-1].get('why', '사유 미기록')}")
        return "\n".join(out)

    chars = sum(len(r.get("system") or "") + len(r.get("user") or "") for r in rows)
    out = [f"- **프롬프트 전문 {len(rows)}건을 보관했습니다** (합계 "
           f"{chars:,}자). 모델에게 들어간 글자 그대로이며, 조회된 근거도 "
           f"그 안에 포함되어 있습니다 — 같은 입력으로 다시 돌려 볼 수 "
           f"있습니다."]
    # 위 1절 표의 "호출 N회" 와 숫자가 다를 수 있다. 표는 **끝난 단계**를
    # 세고, 보관은 **보낸 프롬프트**를 센다 — 할당량 재시도로 같은 프롬프트가
    # 두 번 나가면 보관은 2건이다. 모순이 아니라 더 자세한 것인데, 설명이
    # 없으면 모순으로 읽힌다.
    _dig = {r.get("digest") for r in rows if r.get("digest")}
    if len(rows) > len(_dig):
        out.append(f"  - 그중 {len(rows) - len(_dig)}건은 같은 프롬프트의 "
                   f"재시도입니다(할당량·오류). 위 표의 '호출 N회' 는 끝난 "
                   f"단계를 세므로 숫자가 다릅니다.")
    out.append(f"- 보관 위치: `GET /api/archive/{pid}?full=1` "
               f"(파일로는 `shared_memory/store/archive/{pid}/prompts.jsonl`)")
    out.append("- 위키 원문은 따로 보관하지 않습니다. 위키가 git 저장소라 "
               "그 시점 상태가 커밋에 남아 있습니다. 다만 **arXiv·GitHub "
               "live 조회분은 git 에 없으므로, 위 프롬프트 안의 발췌가 "
               "유일한 기록입니다.**")
    if fails:
        out.append(f"- ⚠️ 그 밖에 보관 시도 {len(fails)}회가 실패했습니다 — "
                   f"그만큼은 전문이 없습니다: {fails[-1].get('why', '사유 미기록')}")
    return "\n".join(out)


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    pid = sys.argv[1] if len(sys.argv) > 1 else ""
    if not pid:
        BASE.mkdir(parents=True, exist_ok=True)
        rows = []
        for d in sorted(BASE.iterdir()):
            if d.is_dir():
                rows.append((d.name, stats(d.name)))
        print(json.dumps(dict(rows), ensure_ascii=False, indent=2))
    else:
        print(json.dumps(stats(pid), ensure_ascii=False, indent=2))
