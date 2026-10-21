#!/usr/bin/env python3
"""디스크 여유를 보고, 모자라서 실패한 것을 그렇다고 말한다.

왜 따로 만드는가. 추적 자체는 전에도 있었다 — `/api/system/stats` 가
`disk_percent` 를 돌려주고 에이전트 탭에 게이지로 떴다. 그런데 그 코드는
`psutil.disk_usage(ROOT.anchor)` 였다. ROOT 가 D:\\myung-tech-workspace 이니
**D: 만** 본다. 실측한 상태는 이랬다:

    C:  92.4% 사용 ·  36 GB 남음   ← 안 보던 쪽
    D:  48.0% 사용 · 484 GB 남음   ← 이것만 보던 쪽

차오르는 쪽이 보이지 않는 쪽이었다. C: 에는 세션 임시 폴더, Windows Temp
(4.28 GB), pip 캐시(4.27 GB), Python·Ollama 실행 파일이 산다. 모델 파일은
다행히 D: 다(OLLAMA_MODELS=D:\\Opencode\\Models\\.ollama) — 아니었으면
진작 터졌다.

## 퍼센트를 쓰지 않는 이유

위 두 줄이 그 이유다. 93% 가 930 GB 디스크에선 65 GB 고 476 GB
디스크에선 33 GB 다. 같은 퍼센트 임계값을 두 볼륨에 걸면 **둘 중 하나는
반드시 틀린다**. 그래서 경계선은 여유 GB 로 잡는다. 퍼센트는 사람이
읽기 좋아서 같이 돌려주지만 판정에는 쓰지 않는다.

## 숫자를 보여 주는 것과 실패를 설명하는 것은 다른 기능이다

게이지에 92% 가 떠 있어도, 집필이 디스크 때문에 죽으면 화면에는 그냥
"오류" 로 뜬다. 사장님이 걱정한 건 그 상황이다 — *사유를 모르고 병목*.
그래서 `explain()` 이 있다. 쓰기가 터졌을 때 예외를 넘기면 디스크 탓인지
가려서 사람 말로 돌려준다.

## 원자적 쓰기는 2배를 쓴다

`projects._save` 는 임시 파일에 전부 쓰고 `os.replace` 로 바꿔 끼운다.
안전한 방식이지만 교체 직전에는 **같은 내용이 디스크에 두 벌** 있다.
그래서 `room_for()` 는 요구 용량의 2배 + 여유를 본다. 668 KB 파일에선
무의미한 차이지만, 스냅샷(④)이 들어오면 산출물마다 10 KB 대가 쌓인다.
그때 이 계산이 맞아야 한다.
"""
from __future__ import annotations

import errno
import json
import os
import shutil
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

# ── 경계선 ───────────────────────────────────────────────────────────
# GB 단위. 퍼센트가 아닌 이유는 모듈 설명 참고.
#
# 왜 이 숫자인가. 15 GB 는 "지금 하던 일은 끝낼 수 있지만 큰 작업을
# 새로 시작하면 안 되는" 선이다 — Ollama 모델 하나가 4~8 GB, Windows
# 업데이트가 한 번에 수 GB 를 쓴다. 5 GB 는 "쓰기가 실제로 실패하기
# 시작하는" 선에 가깝다. 추정이고, 실제로 막히는 걸 보면 고쳐야 한다.
LOW_FREE_GB = 15.0
CRIT_FREE_GB = 5.0

# 시스템 볼륨(윈도우·파이썬이 사는 곳)은 평소에도 빠듯하다 — 실측 92.4%.
# 작업 볼륨 기준을 그대로 쓰면 매일 경고가 뜨고, 그러면 아무도 안 읽는다.
# 여기는 "윈도우가 망가지기 시작하는" 선만 본다.
SYSTEM_FREE_GB = 10.0
SYSTEM_CRIT_GB = 3.0

# 원자적 쓰기 여유 배수 — 임시본 + 원본이 함께 있는 순간을 감당한다
ATOMIC_FACTOR = 2

# 자라는 것들을 재는 건 느리다(.git 셋이 286 MB, 재귀 스캔 수십 초).
# 하루 한 번으로 묶는다. 라이브 엔드포인트가 이걸 기다리면 안 된다.
GROWTH_CACHE = HERE / "store" / "disk_growth.json"
GROWTH_TTL = 20 * 3600          # 초. 하루보다 약간 짧게 — 크론과 어긋나도 갱신되게

# 이 시스템이 실제로 쓰는 경로들. 볼륨은 여기서 끌어낸다 —
# 드라이브 문자를 박아 두면 경로가 옮겨졌을 때 조용히 틀린 볼륨을 본다.
# 작업 볼륨 — 이 시스템이 **실제로 쓰는** 경로들. 여기가 차면 우리 쓰기가
# 실패한다. 드라이브 문자를 박지 않는 이유는 경로가 옮겨졌을 때 조용히
# 틀린 볼륨을 보게 되기 때문이다.
#
# %TEMP% 는 여기 없다. 전에 "임시 폴더" 로 넣었다가 뺐다 — 명테크는
# 임시 파일조차 `tempfile.mkstemp(dir=STORE_DIR)` 로 작업 볼륨에 만든다.
# 쓰지도 않는 볼륨을 "가장 빠듯한 볼륨" 으로 세우면 경보가 엉뚱한 곳을
# 가리키고, 사람은 경보를 무시하게 된다.
WATCHED = [
    ("명테크", ROOT),
    ("지식베이스", Path(r"D:\AI_Workspace\mrlee-wiki-graphrag")),
    ("hermes", Path(r"D:\AI_Workspace\hermes")),
]

# 시스템 볼륨 — 윈도우가 사는 곳. 우리가 쓰지는 않지만 0 이 되면 전부
# 멈춘다. 멈추는 방식이 달라서 칸을 따로 둔다.
#
# `sys.executable` 을 쓰면 안 된다. 어느 인터프리터가 이 코드를 돌리느냐에
# 따라 답이 달라진다 — 실측에서 셸의 python 은 D: 의 venv 였고 서버는
# C: 의 Python311 이었다. 같은 코드가 프로세스마다 다른 볼륨을 "시스템"
# 이라고 말하면 그건 측정이 아니다. 윈도우 위치는 고정이다.
SYSTEM_PATH = Path(os.environ.get("SystemRoot")
                   or os.environ.get("SystemDrive", "C:") + "\\")

# 상한 없이 자라는 것들. 이름은 사람이 읽을 것이고, 경로는 없으면 건너뛴다.
GROWERS = [
    ("명테크 .git", ROOT / ".git"),
    ("지식베이스 .git", Path(r"D:\AI_Workspace\mrlee-wiki-graphrag\.git")),
    ("hermes .git", Path(r"D:\AI_Workspace\hermes\.git")),
    ("저장소(store)", HERE / "store"),
    ("임베딩 캐시", Path(r"D:\AI_Workspace\mrlee-wiki-graphrag\.embed_cache.json")),
]


def _gb(n: int | float) -> float:
    return round(n / 1024 ** 3, 2)


def _anchor(p: Path) -> str:
    """경로가 사는 볼륨. 경로가 아직 없으면 조상으로 올라가 찾는다."""
    try:
        return str(Path(p).resolve().anchor) or str(Path(p).anchor)
    except Exception:
        return str(Path(p).anchor)


# ── 볼륨 ─────────────────────────────────────────────────────────────

def system_volume() -> dict | None:
    """시스템 볼륨 한 칸. 작업 볼륨과 같으면 None — 따로 보여 줄 것이 없다.

    같은 볼륨인 경우가 실제로 있다(파이썬을 D: 에 깔았거나 단일 드라이브
    PC). 그때 두 번 세면 같은 디스크를 두 번 경고하게 된다.
    """
    mount = _anchor(SYSTEM_PATH)
    if not mount or mount in {_anchor(p) for _, p in WATCHED}:
        return None
    try:
        u = shutil.disk_usage(mount)
    except OSError:
        return {"mount": mount, "used_by": ["윈도우·파이썬"], "error": "조회 못 함",
                "free_gb": None, "total_gb": None, "percent": None,
                "level": "unknown", "role": "system"}
    free = _gb(u.free)
    return {
        "mount": mount,
        "used_by": ["윈도우·파이썬"],
        "free_gb": free,
        "total_gb": _gb(u.total),
        "used_gb": _gb(u.used),
        "percent": round(100 * u.used / u.total, 1) if u.total else None,
        "level": ("critical" if free <= SYSTEM_CRIT_GB else
                  "low" if free <= SYSTEM_FREE_GB else "ok"),
        "error": "",
        "role": "system",
    }


def volumes() -> list[dict]:
    """감시 대상 경로들이 걸친 볼륨 전부. 중복은 합치고, 쓰는 쪽을 적는다.

    한 볼륨에 여러 경로가 살면(D: 에 명테크·위키·hermes 가 다 산다) 한 줄로
    묶고 `used_by` 에 이름을 모은다. 같은 디스크를 세 번 세는 건 경고를
    세 번 띄우는 것과 같고, 그러면 결국 무시하게 된다.
    """
    seen: dict[str, dict] = {}
    for label, path in WATCHED:
        mount = _anchor(path)
        if not mount:
            continue
        if mount in seen:
            if label not in seen[mount]["used_by"]:
                seen[mount]["used_by"].append(label)
            continue
        try:
            u = shutil.disk_usage(mount)
        except OSError:
            # 볼륨이 사라졌거나(외장) 권한이 없다. 없는 척하지 않고 적는다.
            seen[mount] = {
                "mount": mount, "used_by": [label], "error": "조회 못 함",
                "free_gb": None, "total_gb": None, "percent": None,
                "level": "unknown", "role": "work",
            }
            continue
        free = _gb(u.free)
        seen[mount] = {
            "mount": mount,
            "used_by": [label],
            "free_gb": free,
            "total_gb": _gb(u.total),
            "used_gb": _gb(u.used),
            "percent": round(100 * u.used / u.total, 1) if u.total else None,
            "level": level_for(free),
            "error": "",
            "role": "work",          # 우리가 실제로 쓰는 볼륨
        }
    # 빠듯한 쪽이 먼저. summary_md 가 volumes[0] 을 "가장 빠듯한 쪽" 으로
    # 읽으므로 순서가 뜻을 가진다. 조회 못 한 볼륨은 뒤로 — 숫자가 없어서
    # 비교가 안 되는 것이지 안전해서가 아니다.
    return sorted(seen.values(),
                  key=lambda v: (v["free_gb"] is None, v["free_gb"] or 0))


def level_for(free_gb: float | None) -> str:
    if free_gb is None:
        return "unknown"
    if free_gb <= CRIT_FREE_GB:
        return "critical"
    if free_gb <= LOW_FREE_GB:
        return "low"
    return "ok"


def check() -> dict:
    """한 줄 판정 + 사람이 읽을 메모. UI·health·맹비서가 같이 쓴다.

    `volumes` 의 첫 칸은 **가장 빠듯한 작업 볼륨**이다 — 시스템 볼륨이
    아니다. 우리 일을 막는 것이 무엇인지가 먼저여야 한다.
    """
    vols = volumes()
    sysv = system_volume()
    worst = "ok"
    order = {"ok": 0, "unknown": 1, "low": 2, "critical": 3}
    notes: list[str] = []
    for v in vols:
        if order[v["level"]] > order[worst]:
            worst = v["level"]
        who = " · ".join(v["used_by"])
        if v["level"] == "critical":
            notes.append(f"{v['mount']} 여유 {v['free_gb']} GB — 쓰기가 실패할 수 있습니다 ({who})")
        elif v["level"] == "low":
            notes.append(f"{v['mount']} 여유 {v['free_gb']} GB — 큰 작업은 미루십시오 ({who})")
        elif v["level"] == "unknown":
            notes.append(f"{v['mount']} 조회 못 함 — 없다는 뜻이 아닙니다 ({who})")
    # 시스템 볼륨은 판정에 섞지 않는다. 섞으면 "C: 가 92% 라 위험" 이
    # 작업 볼륨 경고를 덮어 버리고, 정작 D: 가 차는 날에 묻힌다.
    if sysv:
        if sysv["level"] == "critical":
            notes.append(
                f"{sysv['mount']} 여유 {sysv['free_gb']} GB — 윈도우·파이썬이 사는 "
                f"볼륨입니다. 명테크가 쓰지는 않지만 이 정도면 전체가 멈출 수 있습니다")
        elif sysv["level"] == "low":
            notes.append(
                f"{sysv['mount']} 여유 {sysv['free_gb']} GB — 윈도우가 사는 볼륨입니다. "
                f"명테크 작업은 D: 에서 도니 당장 막히지는 않습니다")
        elif sysv["level"] == "unknown":
            notes.append(f"{sysv['mount']} 조회 못 함 (시스템 볼륨)")

    return {
        "level": worst,                      # 작업 볼륨 기준
        "ok": worst in ("ok", "unknown"),
        "volumes": vols,                     # 작업 볼륨만, 빠듯한 순
        "system": sysv,                      # 시스템 볼륨 한 칸 (없을 수 있음)
        "notes": notes,
        "thresholds": {
            "low_free_gb": LOW_FREE_GB, "critical_free_gb": CRIT_FREE_GB,
            "system_low_gb": SYSTEM_FREE_GB, "system_critical_gb": SYSTEM_CRIT_GB,
        },
    }


def room_for(path: str | Path, need_bytes: int) -> dict:
    """이만큼 쓸 자리가 있나. 원자적 쓰기를 셈해 2배로 본다.

    `ok=False` 일 때 쓰기를 막는 용도가 아니다 — 막으면 사장님은 또
    사유를 모른다. **미리 말해 주는** 용도다. 실제로 터지면 `explain()`
    이 받는다.
    """
    mount = _anchor(path)
    try:
        free = shutil.disk_usage(mount).free
    except OSError as e:
        return {"ok": True, "mount": mount, "unknown": True, "why": f"조회 못 함: {e}"}
    want = need_bytes * ATOMIC_FACTOR
    ok = free > want + CRIT_FREE_GB * 1024 ** 3
    return {
        "ok": ok,
        "mount": mount,
        "free_gb": _gb(free),
        "need_gb": _gb(want),
        "unknown": False,
        "why": "" if ok else (
            f"{mount} 여유 {_gb(free)} GB — 이 쓰기에 "
            f"{_gb(want)} GB(원자적 쓰기라 2배)가 필요합니다"
        ),
    }


# ── 실패 귀속 ────────────────────────────────────────────────────────
# 여기가 이 모듈에서 가장 값진 부분이다. 숫자는 전에도 있었다.

# ERROR_DISK_FULL. 파이썬이 윈도우 오류를 errno 로 옮길 때 28(ENOSPC)로
# 맞춰 주는 경우가 많지만 항상은 아니다 — winerror 를 따로 본다.
_WIN_DISK_FULL = 112
_WIN_HANDLE_DISK_FULL = 39     # ERROR_HANDLE_DISK_FULL


def is_disk_full(exc: BaseException) -> bool:
    """이 예외가 '자리 없음' 인가.

    errno 28 하나만 보면 윈도우에서 놓친다. 반대로 winerror 만 보면
    POSIX 에서 놓친다. 둘 다 본다.
    """
    if not isinstance(exc, OSError):
        return False
    if exc.errno == errno.ENOSPC:
        return True
    return getattr(exc, "winerror", None) in (_WIN_DISK_FULL, _WIN_HANDLE_DISK_FULL)


def explain(exc: BaseException, path: str | Path | None = None) -> str:
    """터진 예외를 사람 말로. 디스크가 아니면 빈 문자열을 돌려준다.

    빈 문자열인 것이 중요하다. 아무 실패에나 "디스크일 수도 있습니다" 를
    붙이면 진짜 디스크 실패가 묻힌다 — 일관성 시험에서 빠뜨림과 지어냄을
    가른 것과 같은 이유다.
    """
    if not is_disk_full(exc):
        return ""
    mount = _anchor(path) if path else "?"
    try:
        free = _gb(shutil.disk_usage(mount).free) if mount != "?" else None
    except OSError:
        free = None
    where = f"{mount} " if mount != "?" else ""

    # 여유가 충분한데 ENOSPC 가 났다면 볼륨 용량 문제가 아니다 —
    # 할당량, 파일 크기 상한, 또는 쓰기가 생각한 볼륨이 아닌 곳으로 간
    # 경우다. "꽉 찼습니다 (여유 483 GB)" 처럼 자기모순인 말을 하면
    # 사장님은 엉뚱한 곳을 비우게 된다. 가려서 말한다.
    if free is not None and free > LOW_FREE_GB:
        return (
            f"쓸 자리가 없다는 오류가 났습니다 — 그런데 {where}여유는 "
            f"{free} GB 입니다. 볼륨 용량이 아니라 할당량·파일 크기 상한이거나, "
            f"쓰기가 다른 볼륨으로 간 경우입니다. 경로를 확인하십시오."
        )

    tail = f"(현재 여유 {free} GB) " if free is not None else ""
    return (
        f"디스크가 꽉 찼습니다 — {where}에 쓸 자리가 없어 실패했습니다. {tail}"
        f"공간을 비우고 다시 시도하십시오."
    )


class DiskFull(OSError):
    """자리 없음으로 실패한 쓰기.

    OSError 를 물려받는 것이 핵심이다. 호출하는 쪽은 이미 `except OSError`
    나 `except Exception` 으로 받고 있다 — 새 계통의 예외를 만들면 그
    방어선이 조용히 뚫린다. 타입은 그대로 두고 **메시지만** 사람 말로
    바꾼다.
    """


from contextlib import contextmanager  # noqa: E402  (여기서만 쓴다)


@contextmanager
def writing(path: str | Path):
    """쓰기를 감싼다. 자리 없음이면 사유를 적어 다시 던진다.

    이 모듈을 만든 이유가 이것이다. 게이지에 92% 가 떠 있어도 집필이
    디스크 때문에 죽으면 화면에는 "오류" 로 뜬다 — 사장님은 사유를 모른 채
    병목을 본다. 여기를 지나가면 메시지가 "디스크가 꽉 찼습니다" 가 된다.

    디스크가 아닌 실패는 **손대지 않고** 그대로 통과시킨다. 아무 실패에나
    디스크 얘기를 붙이면 진짜 디스크 실패가 묻힌다.
    """
    try:
        yield
    except OSError as e:
        msg = explain(e, path)
        if not msg:
            raise
        new = DiskFull(e.errno or errno.ENOSPC, msg)
        new.filename = getattr(e, "filename", None) or str(path)
        raise new from e


# ── 자라는 것들 ──────────────────────────────────────────────────────

def _size(p: Path) -> int:
    if not p.exists():
        return -1
    if p.is_file():
        return p.stat().st_size
    tot = 0
    for root, _dirs, files in os.walk(p):
        for f in files:
            try:
                tot += os.path.getsize(os.path.join(root, f))
            except OSError:
                pass
    return tot


def growth(refresh: bool = False) -> dict:
    """상한 없이 자라는 것들. 비싸므로 캐시한다.

    백업이 git 커밋·푸시 방식이라 백업 폴더가 안 쌓이는 대신 `.git` 이
    자란다 — 실측 시점에 명테크 137 MB · 위키 128 MB · hermes 22 MB,
    커밋 66·47·51 건. 하루 1커밋이니 D: 에서 당장 위협은 아니지만
    **상한이 없고 보이지 않는다.** 보이게 두는 것이 이 함수의 전부다.
    """
    if not refresh and GROWTH_CACHE.exists():
        try:
            cached = json.loads(GROWTH_CACHE.read_text(encoding="utf-8"))
            if time.time() - cached.get("at_ts", 0) < GROWTH_TTL:
                cached["cached"] = True
                return cached
        except Exception:
            pass

    items = []
    for label, p in GROWERS:
        n = _size(p)
        if n < 0:
            continue
        items.append({"label": label, "path": str(p), "mb": round(n / 1024 ** 2, 1)})
    items.sort(key=lambda d: -d["mb"])
    out = {
        "at_ts": time.time(),
        "at": time.strftime("%Y-%m-%d %H:%M (한국 시간)"),
        "items": items,
        "total_mb": round(sum(i["mb"] for i in items), 1),
        "cached": False,
    }
    try:
        GROWTH_CACHE.parent.mkdir(parents=True, exist_ok=True)
        GROWTH_CACHE.write_text(json.dumps(out, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        # 캐시를 못 써도 수치는 돌려준다. 여기서 디스크가 꽉 찼다면
        # 더더욱 이 함수의 결과가 필요하다.
        pass
    return out


def summary_md() -> str:
    """방법 절·맹비서용 짧은 요약."""
    c = check()
    if c["level"] == "ok" and not c["notes"]:
        best = c["volumes"][0] if c["volumes"] else None
        if best and best.get("free_gb") is not None:
            sysv = c.get("system")
            tail = (f" · 시스템 볼륨 {sysv['mount']} {sysv['free_gb']} GB"
                    if sysv and sysv.get("free_gb") is not None else "")
            return (f"작업 볼륨 여유 충분합니다 "
                    f"({best['mount']} {best['free_gb']} GB){tail}.")
        return "디스크 여유 충분합니다."
    return "⚠️ " + " / ".join(c["notes"])


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd == "growth":
        print(json.dumps(growth("--refresh" in sys.argv), ensure_ascii=False, indent=2))
    elif cmd == "summary":
        print(summary_md())
    else:
        print(json.dumps(check(), ensure_ascii=False, indent=2))
