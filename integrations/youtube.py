"""YouTube — 채널·영상 조회(읽기)와 업로드(쓰기).

읽기는 두 갈래다.

  · **Data API v3** (API 키) — 공개 데이터. 채널 구독자·조회수, 영상 목록,
    영상별 조회수·좋아요·댓글 수. 남의 채널도 볼 수 있다.
  · **Analytics API** (OAuth) — 내 채널의 비공개 지표. 시청 지속 시간,
    트래픽 소스, 구독 증감. 내 채널만.

둘을 나눈 이유는 구글이 나눠 놨기 때문이다. API 키로는 비공개 지표를 못
본다. 그래서 연동 카드도 둘이다.

쓰기는 업로드 하나다. 공개 행위이고 되돌리기 어려우므로 **반드시 결재를
거친다** — 에이전트는 제안만 하고, 사장님이 승인한 순간에만 올라간다.
그마저도 기본값은 비공개(private)다. 실수로 세상에 나가는 것보다 실수로
비공개로 올라가는 편이 낫다.
"""
from __future__ import annotations

import json
import mimetypes
import os
import urllib.error
import urllib.request
from pathlib import Path

from . import base
from .base import Action, Integration, Probe, env, http, register, require

DATA_API = "https://www.googleapis.com/youtube/v3"
ANALYTICS_API = "https://youtubeanalytics.googleapis.com/v2/reports"
UPLOAD_API = "https://www.googleapis.com/upload/youtube/v3/videos"
TOKEN_URL = "https://oauth2.googleapis.com/token"

WORKSPACE = base.ROOT / "workspace"


# ── OAuth: refresh_token → access_token ─────────────────────────────────
def access_token() -> str:
    """저장해 둔 refresh_token 으로 access_token 을 받는다.

    access_token 은 한 시간이면 만료된다. 저장해 두고 재사용하는 대신 필요할
    때마다 새로 받는다 — 만료 시각을 관리하는 코드가 늘어나는 것보다
    호출 한 번이 싸다.
    """
    cid, secret, refresh = require(
        "YOUTUBE_OAUTH_CLIENT_ID", "YOUTUBE_OAUTH_CLIENT_SECRET",
        "YOUTUBE_OAUTH_REFRESH_TOKEN")
    got = base.form_post(TOKEN_URL, {
        "client_id": cid, "client_secret": secret,
        "refresh_token": refresh, "grant_type": "refresh_token",
    }, label="구글 OAuth")
    token = got.get("access_token")
    if not token:
        raise base.IntegrationError(
            "access_token 을 받지 못했습니다. 구글에서 권한을 취소했거나 "
            "refresh_token 이 만료됐을 수 있습니다 — 연동 탭에서 다시 연결하세요.")
    return token


def _auth() -> dict:
    return {"Authorization": f"Bearer {access_token()}"}


# ══ 읽기 1: Data API (공개 데이터) ══════════════════════════════════════
def channel_stats(channel_id: str = "") -> dict:
    """채널 한 개의 공개 통계."""
    key, = require("YOUTUBE_API_KEY")
    cid = channel_id or env("YOUTUBE_CHANNEL_ID")
    if not cid:
        raise base.NotConfigured(["YOUTUBE_CHANNEL_ID"])
    got = http(f"{DATA_API}/channels", params={
        "part": "snippet,statistics", "id": cid, "key": key,
    }, label="YouTube Data API")
    items = got.get("items") or []
    if not items:
        raise base.IntegrationError(
            f"채널을 찾지 못했습니다 (id={cid}). Channel ID 가 맞는지 확인하세요 — "
            "@handle 이 아니라 UC 로 시작하는 24자입니다.")
    it = items[0]
    st = it.get("statistics", {})
    sn = it.get("snippet", {})
    return {
        "id": cid,
        "title": sn.get("title", ""),
        "published_at": sn.get("publishedAt", "")[:10],
        "subscribers": int(st.get("subscriberCount") or 0),
        "views": int(st.get("viewCount") or 0),
        "videos": int(st.get("videoCount") or 0),
        "hidden_subscribers": bool(st.get("hiddenSubscriberCount")),
    }


def recent_videos(channel_id: str = "", limit: int = 10) -> list[dict]:
    """최근 영상과 각각의 공개 지표.

    search.list 는 한 번에 100 유닛을 먹는다(하루 할당량 10,000). 그래서
    playlistItems 로 업로드 재생목록을 읽는다 — 1 유닛이다. 채널 ID 의
    UC 를 UU 로 바꾸면 그 채널의 업로드 재생목록이 된다.
    """
    key, = require("YOUTUBE_API_KEY")
    cid = channel_id or env("YOUTUBE_CHANNEL_ID")
    if not cid:
        raise base.NotConfigured(["YOUTUBE_CHANNEL_ID"])
    uploads = "UU" + cid[2:] if cid.startswith("UC") else cid
    try:
        got = http(f"{DATA_API}/playlistItems", params={
            "part": "snippet,contentDetails", "playlistId": uploads,
            "maxResults": max(1, min(50, limit)), "key": key,
        }, label="YouTube Data API")
    except base.IntegrationError as exc:
        # 영상을 한 번도 올리지 않은 채널은 업로드 재생목록 자체가 없어서
        # 404 가 온다. 그건 오류가 아니라 "아직 없음" 이다.
        if "404" in str(exc):
            return []
        raise
    ids, meta = [], {}
    for it in got.get("items") or []:
        vid = (it.get("contentDetails") or {}).get("videoId")
        if not vid:
            continue
        ids.append(vid)
        sn = it.get("snippet") or {}
        meta[vid] = {"id": vid, "title": sn.get("title", ""),
                     "published_at": (sn.get("publishedAt") or "")[:10]}
    if not ids:
        return []
    stats = http(f"{DATA_API}/videos", params={
        "part": "statistics", "id": ",".join(ids), "key": key,
    }, label="YouTube Data API")
    for it in stats.get("items") or []:
        s = it.get("statistics", {})
        meta.get(it["id"], {}).update({
            "views": int(s.get("viewCount") or 0),
            "likes": int(s.get("likeCount") or 0),
            "comments": int(s.get("commentCount") or 0),
        })
    return [meta[i] for i in ids if i in meta]


# ══ 읽기 2: Analytics API (내 채널 비공개 지표) ═════════════════════════
def analytics(days: int = 28) -> dict:
    """최근 N일의 핵심 지표. OAuth 가 있어야 한다."""
    from datetime import date, timedelta
    end = date.today()
    start = end - timedelta(days=days)
    got = http(ANALYTICS_API, headers=_auth(), params={
        "ids": "channel==MINE",
        "startDate": start.isoformat(), "endDate": end.isoformat(),
        "metrics": ("views,estimatedMinutesWatched,averageViewDuration,"
                    "subscribersGained,subscribersLost"),
    }, label="YouTube Analytics")
    rows = got.get("rows") or []
    cols = [h.get("name") for h in (got.get("columnHeaders") or [])]
    if not rows:
        return {"period": f"{start} ~ {end}", "note": "해당 기간에 데이터가 없습니다"}
    out = dict(zip(cols, rows[0]))
    return {
        "period": f"{start} ~ {end}",
        "views": int(out.get("views") or 0),
        "minutes_watched": int(out.get("estimatedMinutesWatched") or 0),
        "avg_view_seconds": int(out.get("averageViewDuration") or 0),
        "subscribers_gained": int(out.get("subscribersGained") or 0),
        "subscribers_lost": int(out.get("subscribersLost") or 0),
    }


def traffic_sources(days: int = 28, limit: int = 6) -> list[dict]:
    from datetime import date, timedelta
    end = date.today()
    start = end - timedelta(days=days)
    got = http(ANALYTICS_API, headers=_auth(), params={
        "ids": "channel==MINE",
        "startDate": start.isoformat(), "endDate": end.isoformat(),
        "metrics": "views", "dimensions": "insightTrafficSourceType",
        "sort": "-views", "maxResults": limit,
    }, label="YouTube Analytics")
    return [{"source": r[0], "views": int(r[1])} for r in (got.get("rows") or [])]


# ══ 쓰기: 업로드 (결재 필수) ════════════════════════════════════════════
def upload_video(args: dict) -> str:
    """영상을 올린다. **결재 승인 뒤에만 불린다.**

    기본 공개 범위는 private 다. 에이전트가 public 을 제안해도 사장님이
    그 값을 보고 승인한 것이 아니면 올리지 않는다 — 승인 화면에 뜬 문장과
    실제 동작이 달라지는 순간 결재는 의미를 잃는다.
    """
    token = access_token()
    rel = str(args.get("file") or "").strip()
    if not rel:
        raise base.IntegrationError("올릴 파일 경로가 없습니다 (workspace 기준 상대경로).")
    path = (WORKSPACE / rel).resolve()
    if not str(path).startswith(str(WORKSPACE.resolve())):
        raise base.IntegrationError(f"workspace 밖의 경로는 올릴 수 없습니다: {rel}")
    if not path.exists():
        raise base.IntegrationError(f"파일이 없습니다: workspace/{rel}")

    privacy = str(args.get("privacy") or "private").lower()
    if privacy not in ("private", "unlisted", "public"):
        privacy = "private"
    meta = {
        "snippet": {
            "title": str(args.get("title") or path.stem)[:100],
            "description": str(args.get("description") or "")[:5000],
            "tags": [t for t in (args.get("tags") or []) if isinstance(t, str)][:20],
        },
        "status": {"privacyStatus": privacy, "selfDeclaredMadeForKids": False},
    }

    size = path.stat().st_size
    mime = mimetypes.guess_type(path.name)[0] or "video/*"

    # 1) 재개 가능 업로드 세션을 연다.
    start = urllib.request.Request(
        UPLOAD_API + "?uploadType=resumable&part=snippet,status",
        data=json.dumps(meta).encode("utf-8"),
        headers={"Authorization": f"Bearer {token}",
                 "Content-Type": "application/json; charset=UTF-8",
                 "X-Upload-Content-Length": str(size),
                 "X-Upload-Content-Type": mime},
        method="POST")
    try:
        with urllib.request.urlopen(start, timeout=60) as r:
            session = r.headers.get("Location")
    except urllib.error.HTTPError as exc:
        raise base.IntegrationError(
            f"업로드 세션 생성 실패 HTTP {exc.code}: "
            f"{exc.read().decode('utf-8', 'replace')[:300]}") from exc
    if not session:
        raise base.IntegrationError("업로드 세션 주소를 받지 못했습니다.")

    # 2) 본문을 한 번에 올린다. 재개 로직은 넣지 않는다 — 끊기면 다시 결재를
    #    올리는 편이, 반쯤 올라간 상태를 관리하는 것보다 안전하다.
    body = path.read_bytes()
    put = urllib.request.Request(
        session, data=body, method="PUT",
        headers={"Content-Type": mime, "Content-Length": str(size)})
    try:
        with urllib.request.urlopen(put, timeout=1800) as r:
            got = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise base.IntegrationError(
            f"업로드 실패 HTTP {exc.code}: "
            f"{exc.read().decode('utf-8', 'replace')[:300]}") from exc

    vid = got.get("id", "")
    return (f"업로드 완료 — https://youtu.be/{vid} "
            f"(공개 범위: {privacy}, {size / 1048576:.1f}MB)")


def update_video(args: dict) -> str:
    """제목·설명·공개범위를 고친다. 결재 승인 뒤에만 불린다."""
    token = access_token()
    vid = str(args.get("video_id") or "").strip()
    if not vid:
        raise base.IntegrationError("video_id 가 없습니다.")
    snippet: dict = {}
    for k in ("title", "description"):
        if args.get(k) is not None:
            snippet[k] = str(args[k])[:5000]
    parts, payload = [], {"id": vid}
    if snippet:
        # snippet 을 고칠 때 categoryId 는 필수다. 기존 값을 가져와 채운다.
        key = env("YOUTUBE_API_KEY")
        cur = http(f"{DATA_API}/videos", params={"part": "snippet", "id": vid, "key": key},
                   label="YouTube Data API") if key else {}
        old = ((cur.get("items") or [{}])[0].get("snippet") or {})
        snippet.setdefault("title", old.get("title", ""))
        snippet["categoryId"] = old.get("categoryId", "22")
        payload["snippet"] = snippet
        parts.append("snippet")
    if args.get("privacy"):
        payload["status"] = {"privacyStatus": str(args["privacy"])}
        parts.append("status")
    if not parts:
        raise base.IntegrationError("바꿀 항목이 없습니다.")
    http(f"{DATA_API}/videos", method="PUT", headers=_auth(),
         params={"part": ",".join(parts)}, json_body=payload,
         label="YouTube Data API")
    return f"영상 수정 완료 — https://youtu.be/{vid} ({', '.join(parts)})"


# ══ probe / context ════════════════════════════════════════════════════
def probe_data() -> Probe:
    try:
        st = channel_stats()
    except base.NotConfigured as exc:
        return Probe(False, "아직 설정하지 않았습니다", exc.missing)
    subs = "비공개" if st["hidden_subscribers"] else f"{st['subscribers']:,}명"
    return Probe(True, f"{st['title']} — 구독 {subs} · 영상 {st['videos']:,}개 "
                       f"· 총 조회 {st['views']:,}회")


def probe_oauth() -> Probe:
    try:
        a = analytics(7)
    except base.NotConfigured as exc:
        return Probe(False, "아직 설정하지 않았습니다", exc.missing)
    if a.get("note"):
        return Probe(True, f"연결됨 — 최근 7일 데이터 없음")
    return Probe(True, f"최근 7일 조회 {a['views']:,}회 · "
                       f"시청 {a['minutes_watched']:,}분 · "
                       f"구독 +{a['subscribers_gained']}/-{a['subscribers_lost']}")


def context_data(query: str = "") -> str:
    """에이전트 프롬프트에 넣을 사실 블록. 실패하면 빈 문자열.

    지시문이 **남의** 영상·채널을 가리키면 내 채널 데이터는 붙이지 않는다.
    둘이 같이 들어가면 모델이 그 영상을 내 것으로 착각한다 — "이 영상 조회수가
    왜 0 이지?" 같은 엉뚱한 답이 나온다. '내 채널' 이라고 분명히 말한 경우만 예외.
    """
    try:
        from .youtube_lookup import parse
        want = parse(query)
        others = want["videos"] or want["channel_ids"] or want["handles"] or want["query"]
        if others and not any(w in query for w in ("내 채널", "우리 채널", "제 채널")):
            return ""
    except Exception:  # noqa: BLE001
        pass
    try:
        st = channel_stats()
    except base.IntegrationError:
        return ""
    # 영상 목록은 없어도 채널 사실은 쓸모가 있다. 하나가 실패했다고 전부
    # 버리면, 영상 0개인 채널에서는 아무 데이터도 프롬프트에 안 들어간다.
    try:
        vids = recent_videos(limit=8)
    except base.IntegrationError:
        vids = []
    subs = "비공개" if st["hidden_subscribers"] else f"{st['subscribers']:,}"
    lines = [f"[내 YouTube 채널 — 실제 데이터]",
             f"채널: {st['title']} (개설 {st['published_at']})",
             f"구독자 {subs} · 총 조회 {st['views']:,} · 영상 {st['videos']:,}개"]
    if not vids:
        lines.append("아직 올린 영상이 없습니다.")
    else:
        lines.append("최근 영상:")
        for v in vids:
            lines.append(f"  · {v['published_at']} {v['title'][:50]} — "
                         f"조회 {v.get('views', 0):,} 좋아요 {v.get('likes', 0):,} "
                         f"댓글 {v.get('comments', 0):,}")
    return "\n".join(lines)


def context_analytics(query: str = "") -> str:
    # 남의 영상·채널·검색을 물을 때 내 지표를 붙이면 모델이 섞어 읽는다.
    # context_data 와 같은 규칙.
    try:
        from .youtube_lookup import parse
        want = parse(query)
        others = want["videos"] or want["channel_ids"] or want["handles"] or want["query"]
        if others and not any(w in query for w in ("내 채널", "우리 채널", "제 채널")):
            return ""
    except Exception:  # noqa: BLE001
        pass
    try:
        a = analytics(28)
        src = traffic_sources(28)
    except base.IntegrationError:
        return ""
    if a.get("note"):
        return ""
    lines = [f"[내 채널 YouTube Analytics — 최근 28일 실제 지표]",
             f"기간: {a['period']}",
             f"조회 {a['views']:,} · 시청 {a['minutes_watched']:,}분 · "
             f"평균 시청 {a['avg_view_seconds']}초",
             f"구독 +{a['subscribers_gained']} / -{a['subscribers_lost']} "
             f"(순 {a['subscribers_gained'] - a['subscribers_lost']:+})"]
    if src:
        lines.append("트래픽 출처: " + ", ".join(f"{s['source']} {s['views']:,}" for s in src))
    return "\n".join(lines)


# ══ 등록 ════════════════════════════════════════════════════════════════
register(Integration(
    name="youtube_data",
    label="YouTube Data API",
    icon="📺",
    required=["YOUTUBE_API_KEY", "YOUTUBE_CHANNEL_ID"],
    probe=probe_data,
    context=context_data,
    docs="youtube-data",
))

register(Integration(
    name="youtube_oauth",
    label="YouTube Analytics · 업로드 (OAuth)",
    icon="📊",
    required=["YOUTUBE_OAUTH_CLIENT_ID", "YOUTUBE_OAUTH_CLIENT_SECRET",
              "YOUTUBE_OAUTH_REFRESH_TOKEN"],
    probe=probe_oauth,
    context=context_analytics,
    actions={
        "upload": Action(
            id="upload",
            label="YouTube 영상 업로드",
            run=upload_video,
            schema={"file": "workspace 기준 상대경로 (필수)",
                    "title": "제목", "description": "설명",
                    "tags": "태그 배열",
                    "privacy": "private(기본) | unlisted | public"},
        ),
        "update": Action(
            id="update",
            label="YouTube 영상 수정",
            run=update_video,
            schema={"video_id": "영상 ID (필수)", "title": "새 제목",
                    "description": "새 설명", "privacy": "공개 범위"},
        ),
    },
    docs="youtube-oauth",
))
