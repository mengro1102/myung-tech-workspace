"""휴지통 — 대시보드에서 지운 것은 여기로 온다. 영구 삭제는 맹비서만 한다.

## 왜 이렇게 나눴나

사장님 요구 두 가지가 서로 당긴다.

  · "삭제된 컨텐츠는 명테크 서버에도 기록이 남지 않아야 한다"
  · "대시보드에서 지우면 휴지통으로 가고, 맹비서가 디스코드로 알린다.
     본인이 한 게 아니면 알아챌 수 있어야 한다"

대시보드는 터널로 밖에서도 열린다. 접속 키가 새면 남이 지울 수 있다.
그 자리에서 바로 지워지면 사장님은 **무엇이 사라졌는지도 모른 채** 잃는다.
그래서 대시보드의 삭제는 되돌릴 수 있는 이동이고, 되돌릴 수 없는 일
(영구 삭제)은 사장님 본인 메신저 계정으로만 닿는 맹비서를 거친다.
열쇠가 하나 새도 다른 하나가 막는다.

## 영구 삭제는 정말로 지운다

프로젝트 하나가 남기는 흔적을 실측으로 전부 찾았다.

  | 어디                                     | 무엇                 |
  |------------------------------------------|----------------------|
  | store/projects.json                      | 기록 본체            |
  | store/approvals.json (+ *.bak*)          | 그 프로젝트의 결재   |
  | store/lessons.json                       | 거기서 뽑은 교훈     |
  | shared_memory/evt-*.json                 | 활동 이벤트          |
  | store/archive/<pid>/                     | 프롬프트 전문 보관   |
  | workspace/projects/<pid>/                | 저장된 산출물 파일   |
  | 위키 raw/projects/*.md (+ 임베딩 캐시)   | 완료 시 쌓인 경험    |

휴지통 기록 자신도 지운다 — "무엇을 지웠다" 는 묘비를 남기지 않는다.
그 기록은 맹비서가 보낸 디스코드 메시지가 대신한다(사장님 쪽에 남는다).

**위키는 git 저장소다.** 이미 커밋된 내용은 히스토리에 남는다. 작업 사본은
지우고, 그 사실을 영구 삭제 결과에 적는다. 히스토리까지 고쳐 쓰는 일은
되돌릴 수 없고 원격 저장소에도 영향을 주므로 여기서 하지 않는다.
"""
from __future__ import annotations

import hmac
import json
import os
import secrets
import shutil
import sys
import tempfile
import threading
import time
import uuid
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
for _p in (str(HERE), str(ROOT)):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import projects                     # noqa: E402
import workspace_store as ws        # noqa: E402
import disk_guard                   # noqa: E402

STORE_DIR = ws.STORE_DIR
FILE = STORE_DIR / "trash.json"
# 프로젝트와 함께 옮긴 이벤트 파일이 놓이는 곳. trash/<휴지통 id>/events/
DIR = STORE_DIR / "trash"
TOKEN_FILE = STORE_DIR / ".purge_token"
EVENTS_DIR = HERE                   # message_broker 가 evt-*.json 을 여기 쓴다
WORKSPACE = ROOT / "workspace"

# 노트 = 사장님이 쓴 것(notes) + 에이전트가 올린 것(tasks).
COLL = {"note": "notes", "task": "tasks"}
KIND_KO = {"project": "프로젝트", "note": "노트", "task": "에이전트 노트"}

_LOCK = threading.RLock()


# ── 저장 ────────────────────────────────────────────────────────────────
def load() -> list[dict]:
    try:
        data = json.loads(FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except FileNotFoundError:
        return []
    # 깨진 휴지통을 빈 것으로 보면 안 된다 — 다음 저장이 덮어써서 되살릴
    # 길이 사라진다. 다른 저장소와 달리 여기서는 예외를 그대로 올린다.


def _save(rows: list[dict]) -> None:
    fd, tmp = tempfile.mkstemp(dir=str(STORE_DIR), suffix=".tmp")
    try:
        with disk_guard.writing(FILE):
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(rows, f, ensure_ascii=False, indent=2)
            os.replace(tmp, FILE)
    except Exception:
        Path(tmp).unlink(missing_ok=True)
        raise


def _summary(e: dict) -> dict:
    """화면·스크립트에 내보내는 모양. 본문(payload)은 빼고 건수만."""
    pl = e.get("payload") or {}
    return {
        "id": e["id"], "kind": e["kind"], "kind_ko": KIND_KO.get(e["kind"], e["kind"]),
        "ref": e.get("ref"), "title": e.get("title", ""),
        "deleted_at": e.get("deleted_at"), "origin": e.get("origin", ""),
        "linked": {"approvals": len(pl.get("approvals") or []),
                   "lessons": len(pl.get("lessons") or []),
                   "events": len(e.get("event_files") or [])},
    }


def listing() -> list[dict]:
    rows = sorted(load(), key=lambda e: e.get("deleted_at") or 0, reverse=True)
    return [_summary(e) for e in rows]


# ── 프로젝트에 딸린 것 찾기 ─────────────────────────────────────────────
def _mentions(row: dict, needle: str) -> bool:
    # 프로젝트 id 는 무작위 8자리라 다른 것과 우연히 겹치지 않는다. 필드
    # 이름을 하나하나 맞추는 것(project_id · file_path · label)보다 통째로
    # 찾는 쪽이 새 필드가 생겨도 놓치지 않는다.
    return needle in json.dumps(row, ensure_ascii=False)


def _pull_linked(collection: str, pid: str) -> list[dict]:
    rows = [r for r in ws.load(collection) if _mentions(r, pid)]
    for r in rows:
        ws.remove(collection, r.get("id", ""))
    return rows


def _event_files(pid: str) -> list[Path]:
    out = []
    for f in EVENTS_DIR.glob("evt-*.json"):
        try:
            if pid in f.read_text(encoding="utf-8", errors="replace"):
                out.append(f)
        except OSError:
            continue
    return out


def _clean_title(s: str) -> str:
    return " ".join(str(s or "").split())[:80] or "(제목 없음)"


# ── 휴지통으로 ──────────────────────────────────────────────────────────
def move(items: list[dict], origin: str) -> tuple[list[dict], list[str]]:
    """[{kind, id}] 를 휴지통으로 옮긴다. (옮긴 것 요약, 못 찾은 것)."""
    moved: list[dict] = []
    missing: list[str] = []
    with _LOCK:
        rows = load()
        for it in items:
            kind, ref = str(it.get("kind") or ""), str(it.get("id") or "")
            if not ref or kind not in ("project", *COLL):
                missing.append(f"{kind}:{ref}")
                continue
            tid = "trs-" + uuid.uuid4().hex[:10]
            entry = {"id": tid, "kind": kind, "ref": ref,
                     "deleted_at": time.time(), "origin": origin}
            if kind == "project":
                rec = projects.get(ref)
                if not rec or not projects.remove(ref):
                    missing.append(f"{kind}:{ref}")
                    continue
                entry["title"] = _clean_title(rec.get("title") or rec.get("idea"))
                entry["payload"] = {
                    "record": rec,
                    # 결재를 남겨 두면 지운 프로젝트의 파일 저장을 승인할 수
                    # 있게 된다. 교훈은 다음 계획을 바꾼다. 같이 옮긴다.
                    "approvals": _pull_linked("approvals", ref),
                    "lessons": _pull_linked("lessons", ref),
                }
                dest = DIR / tid / "events"
                names = []
                for f in _event_files(ref):
                    dest.mkdir(parents=True, exist_ok=True)
                    try:
                        shutil.move(str(f), str(dest / f.name))
                        names.append(f.name)
                    except OSError:
                        pass
                entry["event_files"] = names
            else:
                coll = COLL[kind]
                rec = next((r for r in ws.load(coll) if r.get("id") == ref), None)
                if not rec or not ws.remove(coll, ref):
                    missing.append(f"{kind}:{ref}")
                    continue
                entry["title"] = _clean_title(rec.get("title") or rec.get("text"))
                entry["payload"] = {"record": rec}
            rows.append(entry)
            moved.append(_summary(entry))
        if moved:
            _save(rows)
    if moved:
        _queue_notice("trash", moved, origin)
    return moved, missing


# ── 되살리기 ────────────────────────────────────────────────────────────
_LIVE = ("running", "planning", "intake")


def restore(ids: list[str] | None) -> tuple[list[dict], list[str]]:
    """휴지통 id 들을 제자리로. None 이면 전부. (되살린 것, 실패 사유)."""
    done: list[dict] = []
    fails: list[str] = []
    with _LOCK:
        rows = load()
        want = set(ids) if ids is not None else {e["id"] for e in rows}
        keep: list[dict] = []
        for e in rows:
            if e["id"] not in want:
                keep.append(e)
                continue
            pl = e.get("payload") or {}
            rec = dict(pl.get("record") or {})
            if e["kind"] == "project":
                # 돌던 프로젝트를 그대로 넣으면 실행기가 곧바로 이어 돌린다.
                # 되살리는 것과 다시 시키는 것은 다른 결정이다 — 멈춰 둔다.
                if rec.get("status") in _LIVE:
                    rec["status"] = "paused"
                    rec["pause_reason"] = ("휴지통에서 되살렸습니다. 이어 가려면 "
                                           "'그대로 이어서' 를 누르세요.")
                if not projects.insert(rec):
                    fails.append(f"{e['id']}: 같은 id 의 프로젝트가 이미 있습니다")
                    keep.append(e)
                    continue
                for coll in ("approvals", "lessons"):
                    have = {r.get("id") for r in ws.load(coll)}
                    for r in pl.get(coll) or []:
                        if r.get("id") not in have:
                            ws.add(coll, r)
                src = DIR / e["id"] / "events"
                for name in e.get("event_files") or []:
                    try:
                        shutil.move(str(src / name), str(EVENTS_DIR / name))
                    except OSError:
                        pass
                shutil.rmtree(DIR / e["id"], ignore_errors=True)
            else:
                coll = COLL[e["kind"]]
                if any(r.get("id") == rec.get("id") for r in ws.load(coll)):
                    fails.append(f"{e['id']}: 이미 제자리에 있습니다")
                    continue          # 이미 있으면 휴지통 쪽 사본은 버린다
                ws.add(coll, rec)
            done.append(_summary(e))
        if len(keep) != len(rows):
            _save(keep)
    return done, fails


# ── 영구 삭제 ───────────────────────────────────────────────────────────
def purge_token() -> str:
    """영구 삭제 열쇠. 이 PC 의 파일에만 있다 — 대시보드(브라우저)는 못 읽는다."""
    try:
        t = TOKEN_FILE.read_text(encoding="utf-8").strip()
        if len(t) >= 32:
            return t
    except OSError:
        pass
    t = secrets.token_urlsafe(32)
    TOKEN_FILE.write_text(t, encoding="utf-8")
    return t


def token_ok(given: str) -> bool:
    return bool(given) and hmac.compare_digest(given.strip(), purge_token())


def _scrub_backups(needle: str) -> int:
    """store 의 *.bak* JSON 목록에서 이 id 가 든 행을 뺀다."""
    n = 0
    for f in STORE_DIR.glob("*.bak*"):
        try:
            rows = json.loads(f.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            continue
        if not isinstance(rows, list):
            continue
        kept = [r for r in rows if not (isinstance(r, dict) and _mentions(r, needle))]
        if len(kept) != len(rows):
            f.write_text(json.dumps(kept, ensure_ascii=False, indent=2), encoding="utf-8")
            n += len(rows) - len(kept)
    return n


def _kb_path() -> Path | None:
    try:
        import knowledge_base as _kb       # ROOT/knowledge_base.py
        p = Path(_kb.KB_PATH)
        return p if p.is_dir() else None
    except Exception:  # noqa: BLE001
        return None


def _scrub_wiki(pid: str) -> list[str]:
    """완료 때 위키 raw/projects 에 쌓인 경험 파일과 그 임베딩을 지운다."""
    kb = _kb_path()
    if kb is None:
        return []
    folder = kb / "raw" / "projects"
    mark = f"myung-tech://project/{pid}"
    gone: list[str] = []
    for f in folder.glob("*.md") if folder.is_dir() else []:
        try:
            head = f.read_text(encoding="utf-8", errors="replace")[:1200]
        except OSError:
            continue
        # 산출물은 `.../<pid>/d1` 처럼 뒤가 붙는다. 다른 id 의 접두어와
        # 겹치지 않도록 바로 뒤 글자까지 본다.
        if mark + "\n" in head or mark + "/" in head:
            try:
                f.unlink()
                gone.append(f.stem)
            except OSError:
                pass
    if gone:
        cache = kb / ".embed_cache.json"
        try:
            d = json.loads(cache.read_text(encoding="utf-8"))
            docs = d.get("docs") or {}
            for stem in gone:
                docs.pop(stem, None)
            cache.write_text(json.dumps(d, ensure_ascii=False), encoding="utf-8")
        except Exception:  # noqa: BLE001
            pass
    return gone


def _purge_one(e: dict) -> dict:
    rep: dict = {"id": e["id"], "kind_ko": KIND_KO.get(e["kind"], e["kind"]),
                 "title": e.get("title", "")}
    ref = e.get("ref") or ""
    pl = e.get("payload") or {}
    if e["kind"] == "project" and ref:
        # 휴지통에 들어온 뒤에 실행기가 늦게 남긴 것까지 다시 훑는다.
        projects.remove(ref)
        rep["approvals"] = len(_pull_linked("approvals", ref)) + len(pl.get("approvals") or [])
        rep["lessons"] = len(_pull_linked("lessons", ref)) + len(pl.get("lessons") or [])
        late = _event_files(ref)
        for f in late:
            f.unlink(missing_ok=True)
        rep["events"] = len(e.get("event_files") or []) + len(late)
        rep["folders"] = []
        for d in (STORE_DIR / "archive" / ref, WORKSPACE / "projects" / ref):
            if d.is_dir():
                shutil.rmtree(d, ignore_errors=True)
                rep["folders"].append(str(d.relative_to(ROOT)).replace("\\", "/"))
        rep["backup_rows"] = _scrub_backups(ref)
        rep["wiki"] = _scrub_wiki(ref)
    elif ref:
        rep["backup_rows"] = _scrub_backups(ref)
    shutil.rmtree(DIR / e["id"], ignore_errors=True)
    return rep


def purge(ids: list[str], origin: str = "맹비서") -> list[dict]:
    """휴지통 id 들을 영구 삭제. 되돌릴 수 없다. 확인 코드는 confirm() 이 본다."""
    with _LOCK:
        rows = load()
        want = set(ids)
        gone = [e for e in rows if e["id"] in want]
        if not gone:
            return []
        reps = [_purge_one(e) for e in gone]
        _save([e for e in rows if e["id"] not in want])
    _queue_notice("purge", reps, origin)
    return reps


# ── 영구 삭제 확인 코드 ─────────────────────────────────────────────────
# 열쇠 파일만으로는 부족하다. 맹비서는 **명테크 웹 대화창**으로도 말을 듣는데,
# 그 창은 대시보드 접속 키로 열린다. 키가 새면 남이 웹 창에서 "휴지통 비워줘"
# 를 시킬 수 있다 — 대시보드 삭제를 휴지통으로 막아 둔 의미가 사라진다.
#
# 그래서 코드를 **디스코드 DM(사장님 계정)으로만** 보낸다. 스크립트 출력에도,
# 서버 응답에도 코드는 없다. 사장님이 DM 을 보고 맹비서에게 코드를 말해야
# 지워진다. 웹 창에 들어온 남은 그 DM 을 볼 수 없다.
CODE_TTL = 600
CODE_TRIES = 5
_challenge: dict | None = None
_clock = threading.Lock()


def challenge(ids: list[str] | None) -> tuple[list[dict], bool]:
    """대상을 정하고 확인 코드를 DM 으로 보낸다. (대상 요약, 보냈나)."""
    global _challenge
    rows = load()
    want = set(ids) if ids is not None else {e["id"] for e in rows}
    targets = [e for e in rows if e["id"] in want]
    if not targets:
        return [], False
    code = f"{secrets.randbelow(1_000_000):06d}"
    with _clock:
        # 「전부」 도 **지금 이 목록**으로 못 박는다. 코드를 받는 사이 새로
        # 들어온 것까지 지워지면 사장님이 본 목록과 지운 목록이 달라진다.
        _challenge = {"code": code, "ids": sorted(e["id"] for e in targets),
                      "until": time.time() + CODE_TTL, "tries": 0}
    lines = [f"· {KIND_KO.get(e['kind'], e['kind'])} 「{e.get('title', '')}」"
             for e in targets[:15]]
    if len(targets) > 15:
        lines.append(f"· …외 {len(targets) - 15}건")
    text = "\n".join([
        f"🔐 영구 삭제 확인 코드: **{code}**  ({CODE_TTL // 60}분 유효)",
        f"대상 {len(targets)}건 — 되돌릴 수 없습니다",
        *lines,
        "",
        "직접 요청하신 게 맞으면 맹비서에게 이 코드를 말씀해 주세요.",
        "요청하신 적이 없다면 무시하세요 — 코드 없이는 지워지지 않습니다.",
    ])
    try:
        import notify
        sent = bool(notify.send(text))
    except Exception:  # noqa: BLE001
        sent = False
    if not sent:
        with _clock:
            _challenge = None       # 못 보낸 코드는 아무도 모른다 — 남겨 둘 이유가 없다
    return [_summary(e) for e in targets], sent


def confirm(code: str, ids: list[str] | None, origin: str = "맹비서") -> tuple[list[dict], str]:
    """코드가 맞으면 지운다. (지운 것, 실패 사유)."""
    global _challenge
    with _clock:
        ch = _challenge
        if not ch or time.time() > ch["until"]:
            _challenge = None
            return [], "유효한 확인 코드가 없습니다 — 다시 요청해 주세요."
        ch["tries"] += 1
        if ch["tries"] > CODE_TRIES:
            _challenge = None
            return [], "코드를 너무 여러 번 틀렸습니다 — 다시 요청해 주세요."
        if not hmac.compare_digest(str(code).strip(), ch["code"]):
            return [], f"코드가 맞지 않습니다 ({CODE_TRIES - ch['tries']}번 남음)."
        if ids is not None and sorted(set(ids)) != ch["ids"]:
            return [], "코드를 받은 대상과 지금 대상이 다릅니다 — 다시 요청해 주세요."
        _challenge = None
        target = ch["ids"]
    return purge(target, origin), ""


# ── 알림 ────────────────────────────────────────────────────────────────
# 한 건씩 지울 때마다 DM 이 한 통씩 오면 알림을 끄게 된다. 몇 초 모아서
# 한 통으로 보낸다.
_NOTICE_DELAY = 4.0
_pending: dict[str, list] = {"trash": [], "purge": []}
_timer: threading.Timer | None = None
_nlock = threading.Lock()


def _queue_notice(kind: str, items: list[dict], origin: str) -> None:
    global _timer
    with _nlock:
        _pending[kind].extend((origin, it) for it in items)
        if _timer is None:
            _timer = threading.Timer(_NOTICE_DELAY, _flush)
            _timer.daemon = True
            _timer.start()


def flush_now() -> None:
    """기다리지 않고 보낸다. 스크립트처럼 곧 끝나는 프로세스에서 쓴다."""
    global _timer
    with _nlock:
        if _timer is not None:
            _timer.cancel()
    _flush()


def _fmt_time(ts: float | None = None) -> str:
    return time.strftime("%m/%d %H:%M", time.localtime(ts or time.time()))


def _flush() -> None:
    global _timer
    with _nlock:
        batch = {k: list(v) for k, v in _pending.items()}
        for v in _pending.values():
            v.clear()
        _timer = None
    for kind, rows in batch.items():
        if not rows:
            continue
        try:
            import notify
            notify.send(notice_text(kind, rows))
        except Exception as exc:  # noqa: BLE001
            # 제목은 로그에 남기지 않는다 — 지운 것의 흔적이 된다.
            print(f"[trash] 알림 실패: {type(exc).__name__}", file=sys.stderr, flush=True)


def notice_text(kind: str, rows: list[tuple[str, dict]]) -> str:
    origins = sorted({o for o, _ in rows})
    lines = [f"· {it.get('kind_ko')} 「{it.get('title', '')}」" for _, it in rows[:15]]
    if len(rows) > 15:
        lines.append(f"· …외 {len(rows) - 15}건")
    if kind == "trash":
        return "\n".join([
            f"🗑 명테크 대시보드에서 {len(rows)}건이 휴지통으로 옮겨졌습니다",
            *lines,
            f"시각 {_fmt_time()} · 경로: {', '.join(origins)}",
            "",
            "본인이 하신 게 아니라면 접속 키가 샜을 수 있습니다 — 명테크 .env 의 "
            "MYUNGTECH_ACCESS_KEY 를 바꾸고 `/명테크재시작` 하세요.",
            "되살리기: 프로젝트 탭 맨 아래 🗑 휴지통",
            "영구 삭제: `/휴지통` 으로 목록을 보고, 지울 것을 말씀해 주세요.",
        ])
    return "\n".join([
        f"🔥 휴지통에서 {len(rows)}건을 영구 삭제했습니다 (되돌릴 수 없음)",
        *lines,
        f"시각 {_fmt_time()} · 요청: {', '.join(origins)}",
    ])
