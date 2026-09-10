"""연동의 공통 바닥.

지금까지 연동 탭은 키를 `.env` 에 **저장만** 했다. 저장된 키를 읽어 실제로
API 를 부르는 코드가 한 줄도 없었는데 화면에는 "연결됨" 이라고 떴다.
그래서 "YouTube + PayPal 분석" 버튼은 채널 데이터를 본 적 없는 모델에게
텍스트로 "분석해줘" 라고 시키고 있었다 — 그 분석은 추측이다.

이 패키지가 그 사이를 메운다. 규칙은 셋이다.

  1. **저장과 연결은 다르다.** 키가 있다는 것과 그 키로 실제 호출이
     되더라는 것은 별개다. `probe()` 가 진짜 호출을 한 번 해 보고,
     그 결과만 "연결 확인됨" 이 된다.
  2. **읽기는 컨텍스트로 주입한다.** 디스패처는 LLM 호출 한 번이고 도구
     루프가 없다. 그러니 에이전트가 API 를 부르게 만들 수는 없다. 대신
     서버가 먼저 조회해서 사실을 프롬프트에 넣는다 — 지식베이스(kb_context)
     와 같은 방식이다.
  3. **쓰기는 결재를 거친다.** 업로드·PR·수정처럼 밖으로 나가거나 되돌리기
     어려운 일은 에이전트가 제안만 하고, 사장님이 승인한 순간에만 실행된다.
     파일 제안(`[파일]`)에서 이미 검증된 경로를 그대로 쓴다.

키는 명테크 `.env` 한 곳에서만 읽는다. 서버의 `_env_get` 과 같은 파일이다.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".env"

DEFAULT_TIMEOUT = 20


# ── 오류 ────────────────────────────────────────────────────────────────
class IntegrationError(Exception):
    """연동이 실패했다. 메시지는 사람이 읽을 한 줄이어야 한다."""


class NotConfigured(IntegrationError):
    """필요한 키가 없다. 실패가 아니라 '아직 설정 안 함' 이다."""

    def __init__(self, missing: list[str]):
        self.missing = missing
        super().__init__("설정이 필요합니다: " + ", ".join(missing))


# ── 자격증명 ────────────────────────────────────────────────────────────
def env(key: str, default: str = "") -> str:
    """명테크 .env 에서 읽는다. 서버의 _env_get 과 같은 파일을 본다."""
    try:
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line.startswith("#") or not line.startswith(f"{key}="):
                continue
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return default


def require(*keys: str) -> list[str]:
    """주어진 키들의 값을 순서대로. 하나라도 비면 NotConfigured."""
    missing = [k for k in keys if not env(k)]
    if missing:
        raise NotConfigured(missing)
    return [env(k) for k in keys]


def missing_keys(*keys: str) -> list[str]:
    return [k for k in keys if not env(k)]


# ── HTTP ────────────────────────────────────────────────────────────────
def http(url: str, *, method: str = "GET", headers: dict | None = None,
         params: dict | None = None, json_body: Any = None,
         data: bytes | None = None, timeout: int = DEFAULT_TIMEOUT,
         label: str = "") -> Any:
    """JSON 을 돌려주는 HTTP 한 번.

    실패는 IntegrationError 로 통일한다. 화면과 에이전트 프롬프트에 그대로
    들어갈 문장이므로, 스택 트레이스가 아니라 **무엇이 왜 안 됐는지**를
    한 줄로 남긴다.
    """
    if params:
        url += ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    body = data
    hdrs = dict(headers or {})
    if json_body is not None:
        body = json.dumps(json_body).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    tag = label or urllib.parse.urlsplit(url).netloc
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:400]
        # 프로바이더마다 오류 모양이 다르다. 사람이 읽을 한 줄만 뽑는다.
        try:
            j = json.loads(detail)
            msg = (j.get("error", {}).get("message") if isinstance(j.get("error"), dict)
                   else j.get("error_description") or j.get("message") or j.get("error"))
            detail = str(msg or detail)[:300]
        except Exception:  # noqa: BLE001
            detail = detail[:300]
        raise IntegrationError(f"{tag} HTTP {exc.code}: {detail}") from exc
    except urllib.error.URLError as exc:
        raise IntegrationError(f"{tag} 연결 실패: {exc.reason}") from exc
    except TimeoutError as exc:
        raise IntegrationError(f"{tag} 응답 없음 ({timeout}초 초과)") from exc
    if not raw:
        return {}
    try:
        return json.loads(raw.decode("utf-8"))
    except Exception:  # noqa: BLE001
        return {"_raw": raw.decode("utf-8", errors="replace")[:2000]}


def form_post(url: str, fields: dict, *, headers: dict | None = None,
              timeout: int = DEFAULT_TIMEOUT, label: str = "") -> Any:
    """application/x-www-form-urlencoded POST. OAuth 토큰 교환에 쓴다."""
    hdrs = dict(headers or {})
    hdrs.setdefault("Content-Type", "application/x-www-form-urlencoded")
    return http(url, method="POST", headers=hdrs,
                data=urllib.parse.urlencode(fields).encode(), timeout=timeout, label=label)


# ── 연동 기술 ───────────────────────────────────────────────────────────
@dataclass
class Probe:
    """실제로 한 번 불러 본 결과."""
    ok: bool
    detail: str                      # 사람이 읽을 한 줄
    missing: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        state = "ok" if self.ok else ("unset" if self.missing else "error")
        return {"ok": self.ok, "state": state,
                "detail": self.detail, "missing": self.missing}


@dataclass
class Action:
    """승인을 받아야 실행되는 바깥 행위."""
    id: str
    label: str                       # 결재함에 뜰 한 줄
    run: Callable[[dict], str]       # 승인 시 실행. 사람이 읽을 결과 문자열 반환
    schema: dict = field(default_factory=dict)   # 필요한 인자 설명


@dataclass
class Integration:
    name: str
    label: str
    icon: str
    required: list[str]              # 없으면 아무것도 못 하는 키
    optional: list[str] = field(default_factory=list)
    probe: Callable[[], Probe] = None            # type: ignore[assignment]
    context: Callable[[str], str] | None = None  # 읽기 → 프롬프트 블록
    actions: dict[str, Action] = field(default_factory=dict)
    docs: str = ""                   # Guidance 문서의 앵커

    def status(self) -> dict:
        miss = missing_keys(*self.required)
        if miss:
            # 키가 없으면 호출해 볼 것도 없다. '실패' 가 아니라 '미설정' 이다.
            p = Probe(False, "아직 설정하지 않았습니다", miss)
        else:
            try:
                p = self.probe()
            except NotConfigured as exc:
                p = Probe(False, "아직 설정하지 않았습니다", exc.missing)
            except IntegrationError as exc:
                p = Probe(False, str(exc))
            except Exception as exc:  # noqa: BLE001
                p = Probe(False, f"예상치 못한 오류: {exc}")
        return {"name": self.name, "label": self.label, "icon": self.icon,
                "required": self.required, "optional": self.optional,
                "docs": self.docs, "actions": sorted(self.actions),
                **p.as_dict()}


_REGISTRY: dict[str, Integration] = {}


def register(integ: Integration) -> Integration:
    _REGISTRY[integ.name] = integ
    return integ


def get(name: str) -> Integration | None:
    return _REGISTRY.get(name)


def all_integrations() -> list[Integration]:
    return list(_REGISTRY.values())


def truncate(text: str, limit: int) -> str:
    text = text.strip()
    return text if len(text) <= limit else text[:limit].rsplit("\n", 1)[0] + "\n…"
