"""YouTube — **남의** 채널·영상을 조회해 에이전트의 근거로 넣는다.

youtube.py 는 내 채널만 봤다. 그런데 YouTube 를 연결한 목적의 절반은 다른
콘텐츠를 참고하는 것이다 — "이 영상 분석해 줘", "이 채널 어떻게 운영하나",
"유튜브에서 ○○ 영상 찾아 줘". 링크를 줘도 에이전트는 그 영상을 볼 수 없었다.

지시문에서 이런 것을 찾으면 서버가 먼저 조회해 프롬프트에 넣는다.

  · 영상 링크(youtube.com/watch · youtu.be · shorts · live)
      → 제목 · 채널 · 길이 · 조회/좋아요/댓글 · 태그 · 설명 · 챕터 · 인기 댓글 · 자막 언어
  · 채널 링크나 @핸들
      → 구독자 · 영상 수 · 최근 영상
  · "유튜브에서 ~ 찾아/검색" 같은 말
      → 검색 결과 상위 영상과 각각의 지표

## 자막 원문은 없다

자막 다운로드(captions.download)는 **그 영상의 편집 권한이 있는 사람만** 할 수
있다(API 문서). 남의 영상 자막을 긁어 오는 비공식 방법들은 YouTube 약관의 스크래핑
금지에 걸리므로 넣지 않았다. 대신 어떤 언어 자막이 있는지, 설명과 챕터, 인기 댓글을
넣는다 — 영상의 뼈대는 대개 거기서 드러난다.

## 할당량

하루 10,000 단위. 영상·채널 조회는 1단위, 댓글 1단위, 자막 목록 50단위,
**검색은 100단위**다. 그래서 검색은 지시문이 분명히 검색을 요구할 때만 하고,
한 지시문에 한 번만 한다.
"""
from __future__ import annotations

import re

from . import base
from .base import Integration, Probe, env, http, register, truncate

DATA_API = "https://www.googleapis.com/youtube/v3"

_VIDEO_RE = re.compile(
    r"(?:youtube\.com/(?:watch\?(?:[^\s]*?&)?v=|shorts/|live/|embed/)|youtu\.be/)"
    r"([A-Za-z0-9_-]{11})")
_CHANNEL_ID_RE = re.compile(r"youtube\.com/channel/(UC[\w-]{22})")
_HANDLE_URL_RE = re.compile(r"youtube\.com/@([\w.\-가-힣]{3,30})")
# 링크 없이 쓴 @핸들은 이메일과 헷갈린다. 앞이 공백·줄머리일 때만, 그리고
# 지시문에 유튜브 이야기가 있을 때만 핸들로 본다.
_HANDLE_BARE_RE = re.compile(r"(?:^|\s)@([\w.\-가-힣]{3,30})")

_YT_WORDS = ("유튜브", "youtube", "채널", "영상")
_SEARCH_WORDS = ("검색", "찾아", "찾기", "찾아줘", "관련 영상", "추천 영상", "레퍼런스")
_STRIP_WORDS = ("유튜브에서", "유튜브", "youtube", "검색해줘", "검색해", "검색", "찾아줘",
                "찾아서", "찾아", "찾기", "관련", "영상들", "영상", "좀", "해줘", "해 줘",
                "주세요", "줘", "을", "를", "레퍼런스")

MAX_VIDEOS = 3
MAX_CHANNELS = 2


def _key() -> str:
    k = env("YOUTUBE_API_KEY")
    if not k:
        raise base.NotConfigured(["YOUTUBE_API_KEY"])
    return k


def _duration(iso: str) -> str:
    """PT1H2M3S → 1:02:03"""
    m = re.fullmatch(r"P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso or "")
    if not m:
        return "?"
    d, h, mi, s = (int(x or 0) for x in m.groups())
    h += d * 24
    return f"{h}:{mi:02d}:{s:02d}" if h else f"{mi}:{s:02d}"


def _chapters(description: str, limit: int = 12) -> list[str]:
    """설명란의 '0:00 제목' 줄 = 챕터. 영상의 목차가 대개 여기 있다."""
    out = []
    for line in description.splitlines():
        m = re.match(r"\s*((?:\d{1,2}:)?\d{1,2}:\d{2})\s*[-–—|·]?\s*(.+)", line)
        if m:
            out.append(f"{m.group(1)} {m.group(2).strip()[:60]}")
            if len(out) >= limit:
                break
    return out if len(out) >= 2 else []


# ── 조회 ────────────────────────────────────────────────────────────────
def video_details(ids: list[str]) -> list[dict]:
    if not ids:
        return []
    got = http(f"{DATA_API}/videos", params={
        "part": "snippet,contentDetails,statistics", "id": ",".join(ids[:50]),
        "key": _key(),
    }, label="YouTube Data API")
    out = []
    for it in got.get("items") or []:
        sn, st = it.get("snippet") or {}, it.get("statistics") or {}
        desc = sn.get("description") or ""
        out.append({
            "id": it["id"],
            "title": sn.get("title", ""),
            "channel": sn.get("channelTitle", ""),
            "channel_id": sn.get("channelId", ""),
            "published_at": (sn.get("publishedAt") or "")[:10],
            "duration": _duration((it.get("contentDetails") or {}).get("duration", "")),
            "views": int(st.get("viewCount") or 0),
            "likes": int(st.get("likeCount") or 0),
            "comments": int(st.get("commentCount") or 0),
            "tags": (sn.get("tags") or [])[:10],
            "description": desc,
            "chapters": _chapters(desc),
        })
    return out


def top_comments(video_id: str, n: int = 5) -> list[str]:
    """인기 댓글. 댓글이 꺼진 영상은 403 이 온다 — 그건 오류가 아니다."""
    try:
        got = http(f"{DATA_API}/commentThreads", params={
            "part": "snippet", "videoId": video_id, "order": "relevance",
            "maxResults": n, "textFormat": "plainText", "key": _key(),
        }, label="YouTube Data API")
    except base.IntegrationError:
        return []
    out = []
    for it in got.get("items") or []:
        c = ((it.get("snippet") or {}).get("topLevelComment") or {}).get("snippet") or {}
        text = " ".join(str(c.get("textDisplay") or "").split())[:160]
        if text:
            out.append(f"({int(c.get('likeCount') or 0):,}👍) {text}")
    return out


def caption_languages(video_id: str) -> list[str]:
    """어떤 언어 자막이 있는지만. 원문은 편집 권한이 있어야 받을 수 있다.

    captions.list 는 OAuth 가 필요하다(50단위). OAuth 가 없거나 거절되면 빈 목록 —
    이것 때문에 조회 전체가 막히면 안 된다.
    """
    try:
        from .youtube import access_token
        token = access_token()
        got = http(f"{DATA_API}/captions", headers={"Authorization": f"Bearer {token}"},
                   params={"part": "snippet", "videoId": video_id},
                   label="YouTube Data API")
    except Exception:  # noqa: BLE001
        return []
    langs = []
    for it in got.get("items") or []:
        sn = it.get("snippet") or {}
        lang = sn.get("language", "")
        if sn.get("trackKind") == "asr":
            lang += "(자동생성)"
        if lang and lang not in langs:
            langs.append(lang)
    return langs


def channel_info(channel_id: str = "", handle: str = "") -> dict | None:
    params = {"part": "snippet,statistics", "key": _key()}
    if channel_id:
        params["id"] = channel_id
    elif handle:
        params["forHandle"] = "@" + handle.lstrip("@")
    else:
        return None
    got = http(f"{DATA_API}/channels", params=params, label="YouTube Data API")
    items = got.get("items") or []
    if not items:
        return None
    it = items[0]
    sn, st = it.get("snippet") or {}, it.get("statistics") or {}
    return {
        "id": it["id"],
        "title": sn.get("title", ""),
        "handle": sn.get("customUrl", ""),
        "published_at": (sn.get("publishedAt") or "")[:10],
        "subscribers": int(st.get("subscriberCount") or 0),
        "hidden_subscribers": bool(st.get("hiddenSubscriberCount")),
        "views": int(st.get("viewCount") or 0),
        "videos": int(st.get("videoCount") or 0),
        "description": (sn.get("description") or "")[:300],
    }


def search(query: str, n: int = 6) -> list[dict]:
    """검색 — 100단위. 결과 id 로 지표를 한 번 더 받는다(1단위)."""
    got = http(f"{DATA_API}/search", params={
        "part": "snippet", "q": query, "type": "video", "maxResults": n,
        "regionCode": "KR", "relevanceLanguage": "ko", "key": _key(),
    }, label="YouTube Data API")
    ids = [((it.get("id") or {}).get("videoId")) for it in got.get("items") or []]
    return video_details([i for i in ids if i])


# ── 지시문 해석 ─────────────────────────────────────────────────────────
def parse(instruction: str) -> dict:
    """지시문에서 영상·채널·검색어를 뽑는다. API 는 부르지 않는다."""
    text = instruction or ""
    low = text.lower()
    videos = list(dict.fromkeys(_VIDEO_RE.findall(text)))[:MAX_VIDEOS]
    channel_ids = list(dict.fromkeys(_CHANNEL_ID_RE.findall(text)))[:MAX_CHANNELS]
    handles = list(dict.fromkeys(_HANDLE_URL_RE.findall(text)))
    if any(w in low for w in _YT_WORDS):
        handles += [h for h in _HANDLE_BARE_RE.findall(text) if h not in handles]
    handles = handles[:MAX_CHANNELS]

    query = ""
    if not videos and any(w in low for w in ("유튜브", "youtube")) \
            and any(w in text for w in _SEARCH_WORDS):
        q = re.sub(r"https?://\S+", " ", text)
        for w in sorted(_STRIP_WORDS, key=len, reverse=True):
            q = q.replace(w, " ")
        query = " ".join(q.split())[:80]
    return {"videos": videos, "channel_ids": channel_ids, "handles": handles,
            "query": query}


def _fmt_video(v: dict, deep: bool) -> list[str]:
    lines = [f"· 「{v['title']}」 — {v['channel']} · {v['published_at']} · {v['duration']}",
             f"  조회 {v['views']:,} · 좋아요 {v['likes']:,} · 댓글 {v['comments']:,}"
             f"  (https://youtu.be/{v['id']})"]
    if not deep:
        return lines
    if v["tags"]:
        lines.append("  태그: " + ", ".join(v["tags"]))
    if v["chapters"]:
        lines.append("  챕터: " + " / ".join(v["chapters"]))
    desc = " ".join(v["description"].split())
    if desc:
        lines.append("  설명: " + desc[:600])
    langs = caption_languages(v["id"])
    if langs:
        lines.append("  자막: " + ", ".join(langs) + " (원문은 제공되지 않음 — 편집 권한 필요)")
    comments = top_comments(v["id"])
    if comments:
        lines.append("  인기 댓글:")
        lines += [f"    - {c}" for c in comments]
    return lines


def context(instruction: str = "") -> str:
    """지시문에 유튜브 대상이 있을 때만 조회한다. 없으면 API 를 부르지 않고 빈 문자열."""
    want = parse(instruction)
    if not (want["videos"] or want["channel_ids"] or want["handles"] or want["query"]):
        return ""
    blocks: list[str] = []
    try:
        if want["videos"]:
            vids = video_details(want["videos"])
            if vids:
                blocks.append("[YouTube 영상 — 실제 데이터]")
                for v in vids:
                    blocks += _fmt_video(v, deep=True)
        for cid in want["channel_ids"]:
            c = channel_info(channel_id=cid)
            if c:
                blocks += _fmt_channel(c)
        for h in want["handles"]:
            c = channel_info(handle=h)
            if c:
                blocks += _fmt_channel(c)
            else:
                blocks.append(f"[@{h}] 이 핸들의 채널을 찾지 못했습니다.")
        if want["query"]:
            found = search(want["query"])
            blocks.append(f"[YouTube 검색 — '{want['query']}' 상위 {len(found)}개]")
            for v in found:
                blocks += _fmt_video(v, deep=False)
    except base.IntegrationError as exc:
        blocks.append(f"(YouTube 조회 실패: {exc})")
    return truncate("\n".join(blocks), 3500) if blocks else ""


def _fmt_channel(c: dict) -> list[str]:
    subs = "비공개" if c["hidden_subscribers"] else f"{c['subscribers']:,}"
    lines = [f"[YouTube 채널 — {c['title']} {c['handle']}]",
             f"구독자 {subs} · 영상 {c['videos']:,}개 · 총 조회 {c['views']:,} · 개설 {c['published_at']}"]
    if c["description"]:
        lines.append("소개: " + " ".join(c["description"].split()))
    try:
        from .youtube import recent_videos
        recent = recent_videos(c["id"], limit=6)
    except base.IntegrationError:
        recent = []
    if recent:
        lines.append("최근 영상:")
        for v in recent:
            lines.append(f"  · {v['published_at']} {v['title'][:50]} — 조회 {v.get('views', 0):,}")
    return lines


def probe() -> Probe:
    # 검색(100단위) 대신 영상 한 건 조회(1단위)로 확인한다.
    got = video_details(["dQw4w9WgXcQ"])
    if not got:
        return Probe(False, "공개 영상 조회에 실패했습니다")
    return Probe(True, "다른 채널·영상 조회 가능 — 링크나 @핸들, '유튜브에서 ~ 찾아' 로 쓰세요")


register(Integration(
    name="youtube_lookup",
    label="YouTube 콘텐츠 조회",
    icon="🔎",
    required=["YOUTUBE_API_KEY"],
    probe=probe,
    context=context,
    docs="youtube-lookup",
))
