"""GitHub — 등록된 서비스 레포를 읽고, 고칠 때는 PR 로 올린다.

'내 서비스' 탭에 레포를 등록해 두었지만(`mengro1102.github.io`) 아무도 읽지
않았다. 등록이 곧 연계는 아니었다.

여기서 읽기는 파일 목록과 내용, 쓰기는 **PR 생성뿐**이다. 기본 브랜치에
직접 push 하는 경로는 넣지 않았다. 이유는 둘이다.

  · 되돌리기. PR 은 닫으면 끝이고 push 는 히스토리에 남는다.
  · 확인. GitHub Pages 는 push 하는 순간 세상에 나간다. 사람이 diff 를
    보고 머지하는 단계가 하나 있어야 한다.

결재 승인은 "PR 을 만들어도 좋다" 까지다. 머지는 사장님이 GitHub 에서 한다.
"""
from __future__ import annotations

import base64

from . import base
from .base import Action, Integration, Probe, env, http, register, require, truncate

API = "https://api.github.com"


def _auth() -> dict:
    token, = require("GITHUB_TOKEN")
    return {"Authorization": f"Bearer {token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "myung-tech"}


def whoami() -> dict:
    return http(f"{API}/user", headers=_auth(), label="GitHub")


def repo(full_name: str) -> dict:
    return http(f"{API}/repos/{full_name}", headers=_auth(), label="GitHub")


def read_file(full_name: str, path: str, ref: str = "") -> str:
    """레포의 파일 하나를 문자열로."""
    params = {"ref": ref} if ref else None
    got = http(f"{API}/repos/{full_name}/contents/{path}", headers=_auth(),
               params=params, label="GitHub")
    if got.get("encoding") != "base64" or "content" not in got:
        raise base.IntegrationError(f"{path} 를 텍스트로 읽지 못했습니다 (디렉터리이거나 이진 파일).")
    return base64.b64decode(got["content"]).decode("utf-8", errors="replace")


def list_files(full_name: str, path: str = "", ref: str = "") -> list[dict]:
    params = {"ref": ref} if ref else None
    got = http(f"{API}/repos/{full_name}/contents/{path}", headers=_auth(),
               params=params, label="GitHub")
    if isinstance(got, dict):
        got = [got]
    return [{"name": e.get("name"), "path": e.get("path"),
             "type": e.get("type"), "size": e.get("size", 0)} for e in got]


# ── 쓰기: PR ────────────────────────────────────────────────────────────
def open_pr(args: dict) -> str:
    """브랜치를 만들어 파일을 쓰고 PR 을 연다. 결재 승인 뒤에만 불린다.

    args:
      repo    "owner/name"
      branch  새 브랜치 이름 (없으면 자동)
      title   PR 제목
      body    PR 설명
      files   [{"path": "...", "content": "..."}]
    """
    full = str(args.get("repo") or "").strip()
    files = args.get("files") or []
    if not full or "/" not in full:
        raise base.IntegrationError("repo 를 owner/name 형태로 지정하세요.")
    if not files:
        raise base.IntegrationError("바꿀 파일이 없습니다.")

    info = repo(full)
    base_branch = info.get("default_branch") or "main"
    head_sha = http(f"{API}/repos/{full}/git/ref/heads/{base_branch}",
                    headers=_auth(), label="GitHub")["object"]["sha"]

    import time
    branch = str(args.get("branch") or f"myung-tech/{int(time.time())}").strip()
    branch = branch.replace(" ", "-")[:60]
    http(f"{API}/repos/{full}/git/refs", method="POST", headers=_auth(),
         json_body={"ref": f"refs/heads/{branch}", "sha": head_sha}, label="GitHub")

    written = []
    for f in files:
        path = str(f.get("path") or "").strip().lstrip("/")
        content = str(f.get("content") or "")
        if not path:
            continue
        # 이미 있는 파일이면 sha 를 줘야 덮어쓸 수 있다.
        sha = ""
        try:
            cur = http(f"{API}/repos/{full}/contents/{path}", headers=_auth(),
                       params={"ref": branch}, label="GitHub")
            sha = cur.get("sha", "") if isinstance(cur, dict) else ""
        except base.IntegrationError:
            sha = ""      # 새 파일
        payload = {
            "message": f"{args.get('title') or '명테크 자동 수정'} — {path}",
            "content": base64.b64encode(content.encode("utf-8")).decode(),
            "branch": branch,
        }
        if sha:
            payload["sha"] = sha
        http(f"{API}/repos/{full}/contents/{path}", method="PUT",
             headers=_auth(), json_body=payload, label="GitHub")
        written.append(path)

    pr = http(f"{API}/repos/{full}/pulls", method="POST", headers=_auth(), json_body={
        "title": str(args.get("title") or "명테크 자동 수정")[:200],
        "head": branch, "base": base_branch,
        "body": (str(args.get("body") or "") +
                 "\n\n---\n명테크 에이전트가 제안하고 사장님이 결재 승인한 변경입니다. "
                 "머지 전에 diff 를 확인하세요."),
    }, label="GitHub")
    return (f"PR 생성 완료 — {pr.get('html_url', '')} "
            f"(브랜치 {branch}, 파일 {len(written)}개: {', '.join(written[:5])})")


# ── probe / context ─────────────────────────────────────────────────────
def probe() -> Probe:
    try:
        me = whoami()
    except base.NotConfigured as exc:
        return Probe(False, "아직 설정하지 않았습니다", exc.missing)
    login = me.get("login", "?")
    # 등록된 서비스의 레포에 실제로 닿는지까지 본다. 토큰이 있어도 그 레포에
    # 권한이 없으면 PR 을 못 만든다 — 그건 승인 누른 뒤가 아니라 지금 알아야 한다.
    repos = registered_repos()
    if not repos:
        return Probe(True, f"{login} 으로 연결됨 — '내 서비스' 에 등록된 레포 없음")
    reachable, denied = [], []
    for full in repos[:5]:
        try:
            repo(full)
            reachable.append(full)
        except base.IntegrationError:
            denied.append(full)
    detail = f"{login} 으로 연결됨 — 접근 가능 {len(reachable)}개"
    if denied:
        detail += f", 권한 없음: {', '.join(denied)}"
    return Probe(not denied or bool(reachable), detail)


def registered_repos() -> list[str]:
    """'내 서비스' 에 등록된 owner/repo 목록."""
    try:
        import sys
        root = str(base.ROOT)
        if root not in sys.path:
            sys.path.insert(0, root)
        from shared_memory import workspace_store
        out = []
        for s in workspace_store.load("services"):
            g = str(s.get("github") or "").strip()
            if "/" in g:
                out.append(g)
        return out
    except Exception:  # noqa: BLE001
        return []


def context(_query: str = "") -> str:
    repos = registered_repos()
    if not repos:
        return ""
    lines = ["[등록된 서비스 레포 — 실제 구조]"]
    for full in repos[:3]:
        try:
            info = repo(full)
            top = list_files(full)
        except base.IntegrationError as exc:
            lines.append(f"  {full}: 읽지 못함 ({exc})")
            continue
        names = ", ".join(e["name"] for e in top[:20] if e["name"])
        lines.append(f"  {full} (기본 브랜치 {info.get('default_branch')}, "
                     f"{info.get('language') or '언어 미상'})")
        lines.append(f"    최상위: {names}")
    return truncate("\n".join(lines), 1200)


register(Integration(
    name="github",
    label="GitHub (서비스 레포)",
    icon="🐙",
    required=["GITHUB_TOKEN"],
    probe=probe,
    context=context,
    actions={
        "pr": Action(
            id="pr",
            label="GitHub PR 생성",
            run=open_pr,
            schema={"repo": "owner/name (필수)", "title": "PR 제목",
                    "body": "PR 설명", "branch": "브랜치 이름(선택)",
                    "files": '[{"path": "...", "content": "..."}] (필수)'},
        ),
    },
    docs="github",
))
