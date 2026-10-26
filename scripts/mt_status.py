#!/usr/bin/env python3
"""명테크 현황을 명령줄에서 본다 — 맹비서가 "뭐 돌고 있어?" 에 답하는 입구.

## 왜 생겼나

사장님이 디스코드에서 **"현재 어떤 프로젝트도 가동중인지 확인"** 이라고
물으셨는데, 맹비서는 **Hermes 프로세스와 크론**을 답했다. 명테크 프로젝트는
0건 가동 중이고 태스크가 1건 돌고 있었는데 그 얘기는 하지 않았다.

맹비서가 거짓을 말한 게 아니다 — **명테크를 들여다볼 도구가 없었다.** 결재
스킬(`mt_approvals.py`)만 있어서 "프로젝트" 를 "프로세스" 로 읽고 자기가 가진
`process: list` 를 돌린 것이다. 도구가 없으면 있는 도구로 답하게 된다.

## 결정은 이 스크립트가 한다

`mt_approvals.py` 와 같은 원칙이다. 스킬은 LLM 이 읽는 지시문이라, 거기서
API 호출을 조립하게 두면 없는 엔드포인트를 지어내거나 숫자를 잘못 읽는다.
**LLM 은 어떤 하위 명령을 부를지만 고르고, 사실은 전부 여기서 만든다.**

실제로 같은 대화에서 맹비서가 `0 3 * * *` 를 "03:00 UTC(한국 12:00)" 로
읽었다. 저장된 값에 `+09:00` 이 붙어 있었는데 추론으로 덮어쓴 것이다.
그래서 이 스크립트는 **시각을 전부 한국 시간 문자열로 미리 바꿔서** 낸다.

    python mt_status.py                 한눈에 (기본)
    python mt_status.py projects        프로젝트만, 자세히
    python mt_status.py project <id>    한 건 — 산출물·검토·막힌 이유
    python mt_status.py tasks           태스크 큐
    python mt_status.py lessons         배운 것 (막힌 프로젝트의 교훈)
    python mt_status.py health          서비스 상태
    python mt_status.py growth          상한 없이 자라는 것들
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

for _s in (sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

API = "http://127.0.0.1:9000"

# 부서 코드 → 사람이 읽는 이름. 화면(deptLabels)과 같은 말을 써야
# 사장님이 두 곳을 같은 것으로 읽는다.
DEPT_KO = {
    "orchestration_dept": "오케스트레이션부", "research_dept": "학술연구부",
    "finance_dept": "금융투자부", "dev_dept": "개발부",
    "content_dept": "콘텐츠생산부",
}

STATUS = {
    "intake": "접수", "planning": "계획 수립 중",
    "awaiting_approval": "착수 승인 대기", "running": "진행 중",
    "paused": "멈춤", "done": "완료", "cancelled": "접음",
}
PHASE = {"draft": "초안", "review1": "1차 검토", "review2": "2차 검토",
         "plan": "계획", "narrow": "범위 좁히기"}


def call(path: str, timeout: int = 30):
    req = urllib.request.Request(API + path)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def when(ts) -> str:
    """시각은 **한국 시간 문자열로 바꿔서** 낸다.

    LLM 에게 숫자나 ISO 문자열을 주면 타임존을 추론한다. 실제로 맹비서가
    `+09:00` 이 붙은 값을 UTC 로 읽어 "한국 시간 12:00" 이라고 답한 적이
    있다. 추론할 거리를 주지 않는 것이 유일하게 믿을 만한 방법이다.
    """
    try:
        f = float(ts or 0)
    except (TypeError, ValueError):
        return "?"
    if f <= 0:
        return "?"
    return time.strftime("%Y-%m-%d %H:%M", time.localtime(f)) + " (한국 시간)"


def ago(ts) -> str:
    try:
        d = time.time() - float(ts or 0)
    except (TypeError, ValueError):
        return ""
    if d < 0 or float(ts or 0) <= 0:
        return ""
    if d < 90:
        return "방금"
    if d < 3600:
        return f"{int(d // 60)}분 전"
    if d < 86400:
        return f"{int(d // 3600)}시간 전"
    return f"{int(d // 86400)}일 전"


def _projects() -> list[dict]:
    return call("/api/projects").get("projects", [])


def cmd_overview() -> int:
    try:
        h = call("/api/health", timeout=20)
        # 디스크가 빠듯하면 묻기 전에 말한다. 사장님 우려가 바로 이것이었다 —
        # 사유를 모르고 병목을 보는 상황. 정상일 때는 조용하다.
        _d = h.get("disk") or {}
        if _d.get("level") in ("low", "critical"):
            print(f"  ⚠️ {_d.get('summary', '디스크 여유 부족')}")
        elif _d.get("level") == "unknown":
            print(f"  ⚠️ {_d.get('summary', '디스크를 조회하지 못했습니다')}")
    except Exception as exc:  # noqa: BLE001
        print(f"명테크 서버에 연결하지 못했습니다: {exc}")
        print("PC 에서 D:\\AI_Workspace\\실행\\1. 전체 시작.bat 이 떠 있어야 합니다.")
        return 1

    ps = _projects()
    live = [p for p in ps if p.get("status") in ("running", "planning", "intake")]
    waiting = [p for p in ps if p.get("status") in ("awaiting_approval", "paused")]
    tasks = call("/api/tasks/list?limit=100").get("tasks", [])
    t_run = [t for t in tasks if t.get("status") == "in_progress"]
    t_pend = [t for t in tasks if t.get("status") == "pending"]
    appr = [a for a in call("/api/store/approvals").get("items", [])
            if (a.get("status") or "pending") == "pending"]

    print("■ 명테크 현황")
    print(f"  서버 {'정상' if h.get('server', {}).get('ok') else '이상'}"
          f" · AI 모델 {'정상' if h.get('vllm', {}).get('ok') else '이상'}"
          f" · 지식베이스 {'정상' if h.get('knowledge_base', {}).get('ok') else '이상'}")
    print()
    print(f"  지금 돌고 있는 프로젝트: {len(live)}건")
    for p in live:
        inf = p.get("inflight") or {}
        extra = f" — {PHASE.get(inf.get('phase', ''), inf.get('phase', ''))} 중" if inf else ""
        print(f"    · {p.get('title', '')[:40]} ({p.get('progress', '-')}){extra}")
    if not live:
        print("    (없음)")

    print(f"  사람을 기다리는 프로젝트: {len(waiting)}건")
    for p in waiting:
        why = p.get("pause_reason") or STATUS.get(p.get("status", ""), "")
        print(f"    · {p.get('title', '')[:40]} — {str(why)[:60]}")
    if not waiting:
        print("    (없음)")

    print(f"  대기 중인 결재: {len(appr)}건"
          + ("  → /결재 로 보실 수 있습니다" if appr else ""))
    print(f"  태스크: 진행 중 {len(t_run)} · 대기 {len(t_pend)} · 전체 {len(tasks)}")
    print()
    print(f"  완료된 프로젝트: {len([p for p in ps if p.get('status') == 'done'])}건"
          f" / 전체 {len(ps)}건")
    return 0


def cmd_projects() -> int:
    ps = _projects()
    if not ps:
        print("프로젝트가 없습니다.")
        return 0
    order = {"running": 0, "planning": 0, "intake": 0,
             "awaiting_approval": 1, "paused": 2, "done": 3, "cancelled": 4}
    for p in sorted(ps, key=lambda x: (order.get(x.get("status", ""), 9),
                                       -(x.get("updated_at") or 0))):
        inf = p.get("inflight") or {}
        print(f"[{p.get('id')}] {p.get('title', '')}")
        print(f"   상태 {STATUS.get(p.get('status', ''), p.get('status', ''))}"
              f" · 산출물 {p.get('progress', '-')}"
              f" · {p.get('step_count') or len(p.get('steps') or [])}스텝"
              f" · 마지막 {ago(p.get('updated_at'))}")
        if inf:
            print(f"   지금: {PHASE.get(inf.get('phase', ''), inf.get('phase', ''))}"
                  f" — {inf.get('deliverable', '')[:40]}")
        if p.get("pause_reason"):
            print(f"   멈춘 이유: {p['pause_reason'][:120]}")
        if p.get("steer"):
            print(f"   걸린 지시: {p['steer'][:90]}")
        print()
    return 0


def cmd_project(pid: str) -> int:
    ps = _projects()
    hit = [p for p in ps if p.get("id") == pid or p.get("id", "").endswith(pid)
           or pid in (p.get("title") or "")]
    if not hit:
        print(f"'{pid}' 에 맞는 프로젝트가 없습니다. `projects` 로 목록을 보세요.")
        return 1
    p = call(f"/api/projects/{hit[0]['id']}").get("project") or hit[0]
    plan = p.get("plan") or {}
    arts = p.get("artifacts") or {}
    steps = p.get("steps") or []
    revs = [s for s in steps if str(s.get("phase", "")).startswith("review")]

    print(f"[{p.get('id')}] {plan.get('title') or p.get('title', '')}")
    print(f"  상태 {STATUS.get(p.get('status', ''), p.get('status', ''))}"
          f" · 산출물 {p.get('progress', '-')} · {len(steps)}스텝"
          f" · 검토 {len(revs)}회(통과 {len([s for s in revs if s.get('ok')])})")
    print(f"  만든 때 {when(p.get('created_at'))} · 마지막 {when(p.get('updated_at'))}")
    if p.get("intent"):
        print(f"  의도: {p['intent'][:160]}")
    if p.get("pause_reason"):
        print(f"  멈춘 이유: {p['pause_reason']}")
    if p.get("source_names"):
        print(f"  조회한 자료: {', '.join(str(x) for x in p['source_names'][:6])}")
    print()
    for d in plan.get("deliverables") or []:
        body = arts.get(d.get("id", ""), "")
        print(f"  {'✓' if body else '·'} {d.get('title', '')}"
              f"  [{d.get('dept', '')}]  {len(body):,}자")
    nw = p.get("narrowed") or {}
    if nw:
        print()
        print("  ⚠️ 범위에서 덜어낸 것 — 요구했으나 못 채운 것입니다:")
        for did, v in nw.items():
            for x in (v.get("dropped") or [])[:5]:
                print(f"    - {x}")
    if revs:
        print()
        print("  최근 검토:")
        for s in revs[-3:]:
            print(f"    {s.get('n')}. {PHASE.get(s.get('phase', ''), s.get('phase', ''))}"
                  f" {'통과' if s.get('ok') else '반려'} {s.get('score', -1)}점"
                  f" — {' '.join(str(s.get('note') or '').split())[:90]}")
    return 0


def cmd_tasks() -> int:
    tasks = call("/api/tasks/list?limit=100").get("tasks", [])
    if not tasks:
        print("태스크가 없습니다.")
        return 0
    live = [t for t in tasks if t.get("status") in ("in_progress", "pending")]
    print(f"태스크 {len(tasks)}건 · 아직 안 끝난 것 {len(live)}건")
    print()
    for t in live or tasks[:8]:
        print(f"  [{t.get('status')}] {t.get('target_dept', '')}"
              f" — {' '.join(str(t.get('instruction') or '').split())[:80]}")
    return 0


def cmd_lessons() -> int:
    d = call("/api/lessons")
    rows = d.get("items", [])
    st = d.get("stats", {})
    if not rows:
        print("아직 교훈이 없습니다. 프로젝트가 진전 없이 멈추면 그때 쌓입니다.")
        return 0
    print(f"배운 것 {len(rows)}건 · 반려 {st.get('rejections', 0)}회분")
    print("비슷한 주제로 새 프로젝트를 시작하면 이 내용이 계획에 들어갑니다.")
    print()
    for r in rows:
        print(f"  [{r.get('title', '')}] {r.get('steps', 0)}단계 · 반려 {r.get('rejections', 0)}회")
        for t in (r.get("recurring") or [])[:2]:
            print(f"    · {' '.join(str(t).split())[:110]}")
        for x in (r.get("dropped") or [])[:2]:
            print(f"    못 채움: {x[:90]}")
        print()
    return 0


def _disk_lines(h: dict) -> str:
    """디스크를 사람이 읽을 줄로. 모델이 계산할 것을 남기지 않는다.

    퍼센트만 주면 모델이 "92% 니까 위험" 이라고 말한다. 실측에서 C: 는
    92.4% 인데 36 GB 남아 있었고 D: 는 48% 인데 484 GB 남아 있었다 —
    퍼센트로는 어느 쪽이 급한지 판단할 수 없다. 그래서 여유 GB 와 판정을
    문자열로 박아 보낸다.
    """
    d = h.get("disk") or {}
    if not d:
        return "  디스크: 정보 없음 (서버가 오래된 버전일 수 있습니다)"
    ko = {"ok": "여유 있음", "low": "빠듯함", "critical": "위험",
          "unknown": "조회 못 함"}
    out = [f"  디스크: {ko.get(d.get('level'), d.get('level'))}  (작업 볼륨 기준)"]
    tight = d.get("tightest") or {}
    if tight.get("free_gb") is not None:
        who = " · ".join(tight.get("used_by") or [])
        out.append(f"    작업 볼륨: {tight['mount']} 여유 "
                   f"{tight['free_gb']} GB (전체 {tight['total_gb']} GB 중 "
                   f"{tight['percent']}% 사용) — {who}")
    # 시스템 볼륨은 따로. 명테크가 쓰지 않는 볼륨을 "가장 빠듯한 볼륨" 으로
    # 앞세우면 경보가 엉뚱한 곳을 가리키고, 사람은 경보를 무시하게 된다.
    sysv = d.get("system") or {}
    if sysv.get("free_gb") is not None:
        out.append(f"    시스템 볼륨: {sysv['mount']} 여유 {sysv['free_gb']} GB "
                   f"({sysv['percent']}% 사용) — 윈도우가 사는 곳. "
                   f"명테크는 여기에 쓰지 않습니다")
    for n in (d.get("notes") or []):
        out.append(f"    ⚠️ {n}")
    if d.get("level") == "unknown":
        out.append("    (조회 실패입니다. 여유가 있다는 뜻이 아닙니다)")
    return "\n".join(out)


def cmd_growth() -> int:
    """상한 없이 자라는 것들. 백업이 git 커밋 방식이라 `.git` 이 자란다.

    서버를 거치지 않는다 — 읽기 전용이고, 서버가 내려가 있을 때야말로
    "뭐가 디스크를 먹고 있나" 를 물을 때다.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from shared_memory import disk_guard
    g = disk_guard.growth()
    print(f"  자라는 것 합계: {g['total_mb']} MB   (기준 시각 {g['at']}"
          + (", 캐시된 값" if g.get("cached") else "") + ")")
    for i in g["items"]:
        print(f"    {i['label']:<18} {i['mb']:>9} MB")
    print()
    print("  백업이 git 커밋·푸시 방식이라 백업 폴더 대신 .git 이 자랍니다.")
    print("  하루 1커밋이라 급하지는 않지만 상한이 없습니다.")
    return 0


def cmd_health() -> int:
    # 주소를 맨 앞에 적는다. 전에는 "서버: 정상" 이라고만 해서, 디스코드에서
    # 보신 사장님이 **어디로 들어가야 하는지 알 수 없었다.**
    print(f"  주소: http://localhost:9000")
    h = call("/api/health")
    for k, ko in (("server", "서버"), ("vllm", "AI 모델"),
                  ("knowledge_base", "지식베이스"), ("workspace", "작업 폴더")):
        v = h.get(k) or {}
        print(f"  {ko}: {'정상' if v.get('ok') else '이상'}"
              + (f"  {v.get('error') or v.get('host') or v.get('path') or ''}"))
    print(_disk_lines(h))
    t = h.get("tasks") or {}
    if t:
        print(f"  태스크: {t}")
    return 0


TAILSCALE = r"C:\Program Files\Tailscale\tailscale.exe"


def _probe(url: str, timeout: int = 6) -> tuple[bool, str]:
    """그 주소가 실제로 응답하나. 추측하지 않고 두드려 본다."""
    try:
        req = urllib.request.Request(url, method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return True, f"HTTP {r.status}"
    except urllib.error.HTTPError as e:
        # 404 여도 서버는 살아 있다. 200 만 성공으로 보면 "죽었다" 고
        # 잘못 말하게 된다.
        return True, f"HTTP {e.code}"
    except Exception as e:                                  # noqa: BLE001
        return False, str(e)[:70]


def _tailscale_serve() -> tuple[str, str]:
    """(밖에서 쓸 주소, 설명). serve 설정을 **읽어서** 답한다.

    `tailscale serve` 가 있어야 밖에서 닿는다. 명테크 서버는
    `127.0.0.1:9000` 에만 바인드하므로, serve 프록시가 없으면 테일넷
    주소로 열어도 아무것도 안 뜬다 — 주소만 알려 주면 사장님이 안 되는
    주소를 들고 헤매게 된다.
    """
    import subprocess
    try:
        out = subprocess.run([TAILSCALE, "serve", "status"],
                             capture_output=True, text=True, timeout=15,
                             errors="replace").stdout
    except Exception as e:                                  # noqa: BLE001
        return "", f"tailscale 조회 실패: {str(e)[:60]}"
    host = ""
    for line in out.splitlines():
        line = line.strip()
        if line.startswith("https://"):
            host = line.split()[0]
            break
    if not host:
        return "", "serve 설정이 없습니다 — 밖에서는 열리지 않습니다"
    # 9000 으로 프록시되고 있는지까지 본다. 다른 포트면 명테크가 아니다.
    if ":9000" not in out:
        return host, "serve 는 있으나 9000(명테크)로 가지 않습니다"
    public = "(인터넷 공개)" if "Funnel on" in out else "(내 기기에서만)"
    return host, public


def cmd_agents() -> int:
    """부서별 에이전트와 지금 무엇을 하고 있나.

    사장님이 디스코드에서 "서브 에이전트들 상태" 를 물으실 수 있는데,
    그걸 답할 하위 명령이 없었다 — 화면에는 "에이전트 12" 라고 떠 있는데
    맹비서는 그 숫자조차 꺼낼 길이 없었다.
    """
    rows = call("/api/agents")
    if isinstance(rows, dict):
        rows = rows.get("agents") or rows.get("items") or []
    if not rows:
        print("에이전트가 없습니다.")
        return 0

    by_dept: dict[str, list] = {}
    for r in rows:
        by_dept.setdefault(r.get("department") or "(소속 없음)", []).append(r)

    busy = [r for r in rows if (r.get("status") or "").lower() not in ("idle", "")]
    print(f"에이전트 {len(rows)}명 · 일하는 중 {len(busy)}명")
    print()
    for dept in sorted(by_dept):
        ags = by_dept[dept]
        print(f"  [{DEPT_KO.get(dept, dept)}] {len(ags)}명")
        for a in ags:
            st = a.get("status") or "?"
            # 쉬는 중은 한 줄로 짧게. 일하는 중만 무엇을 하는지 적는다 —
            # 12명을 전부 길게 적으면 정작 움직이는 것이 안 보인다.
            mark = "·" if st.lower() == "idle" else "▶"
            name = a.get("character_name") or a.get("agent_id")
            line = f"    {mark} {name} ({a.get('role') or '?'}) — {st}"
            doing = (a.get("doing") or "").strip()
            if doing and st.lower() != "idle":
                line += f"\n        {doing[:110]}"
            print(line)
        print()
    return 0


def cmd_dashboard() -> int:
    """명테크 화면을 어디서 열고, 지금 열리나."""
    print("명테크 대시보드")
    print()

    local = "http://localhost:9000"
    ok, detail = _probe(local + "/api/health")
    print(f"  집 안(이 PC)   : {local}")
    print(f"    상태         : {'열립니다' if ok else '안 열립니다'}  ({detail})")

    host, note = _tailscale_serve()
    if host:
        # 밖에서는 **루트(/)** 를 두드린다. `/api/health` 는 로그인을 요구해
        # 401 이 돌아오는데(의도된 동작이다), 그걸 그대로 적으면 사장님은
        # 고장난 줄 아신다. 로그인 화면이 뜨는 것이 정상이다.
        ok2, detail2 = _probe(host + "/", timeout=12)
        print(f"  밖에서        : {host}  {note}")
        print(f"    상태         : {'열립니다' if ok2 else '안 열립니다'}  ({detail2})")
        if ok2:
            print("    ※ 밖에서는 로그인 화면이 먼저 뜹니다 (집 안에서는 바로 들어갑니다)")
    else:
        print(f"  밖에서        : {note}")

    # 서버 프로세스가 진짜로 떠 있나. HTTP 가 되면 떠 있는 것이지만,
    # 안 될 때 "꺼졌는지 / 떠 있는데 막혔는지" 를 구분해야 한다.
    try:
        import subprocess
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command",
             "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | "
             "Where-Object { $_.CommandLine -like '*server.py*' } | "
             "ForEach-Object { $_.ProcessId }"],
            capture_output=True, text=True, timeout=25, errors="replace")
        pids = [x for x in r.stdout.split() if x.isdigit()]
        print(f"  서버 프로세스 : {'PID ' + ', '.join(pids) if pids else '없음'}")
    except Exception as e:                                  # noqa: BLE001
        print(f"  서버 프로세스 : 조회 못 함 ({str(e)[:50]})")

    # 맹비서(게이트웨이)와 이어져 있나. 화면은 떠도 이게 끊기면 채팅이
    # 안 된다 — 사장님 눈에는 "대시보드가 고장" 으로 보인다.
    try:
        h = call("/api/assistant/health", timeout=10)
        print(f"  맹비서 연결   : {'정상' if h.get('ok') else '끊김'}"
              f"  {h.get('error') or h.get('platform') or ''}")
    except Exception as e:                                  # noqa: BLE001
        print(f"  맹비서 연결   : 조회 못 함 ({str(e)[:50]})")

    if not ok:
        print()
        print("  → PC 에서 D:\AI_Workspace\실행\1. 전체 시작.bat 을 띄우십시오.")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(add_help=True)
    ap.add_argument("cmd", nargs="?", default="overview",
                    choices=["overview", "projects", "project", "tasks",
                             "lessons", "health", "growth", "dashboard",
                             "agents"])
    ap.add_argument("arg", nargs="?", default="")
    a = ap.parse_args()
    try:
        if a.cmd == "overview":
            return cmd_overview()
        if a.cmd == "projects":
            return cmd_projects()
        if a.cmd == "project":
            if not a.arg:
                print("프로젝트 id 가 필요합니다. 예: project prj-926fe682")
                return 1
            return cmd_project(a.arg)
        if a.cmd == "tasks":
            return cmd_tasks()
        if a.cmd == "lessons":
            return cmd_lessons()
        if a.cmd == "growth":
            return cmd_growth()
        if a.cmd == "dashboard":
            return cmd_dashboard()
        if a.cmd == "agents":
            return cmd_agents()
        return cmd_health()
    except urllib.error.URLError as exc:
        print(f"명테크 서버에 연결하지 못했습니다: {exc.reason}")
        print("PC 에서 D:\\AI_Workspace\\실행\\1. 전체 시작.bat 이 떠 있어야 합니다.")
        return 1
    except Exception as exc:  # noqa: BLE001
        print(f"조회 실패: {exc}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
