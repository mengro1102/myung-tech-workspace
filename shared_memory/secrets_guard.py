"""자격증명이 산출물·로그·알림으로 새는 것을 막고, 민감한 파일명을 거부한다.

보호가 한 겹뿐이었다 — 결재 게이트. 승인하는 순간 전체 권한으로 실행된다.
쓰기 경로는 `file_proposals.safe_path()` 가 workspace 안으로 가두고 있으니
거기는 이미 괜찮다. 남은 구멍은 둘이다.

**① workspace 안의 민감 파일명.** `workspace/.env` 는 workspace 안이므로
경로 검사를 통과한다. 그런데 그걸 쓰게 두면 나중에 누가 그 파일을 읽어
설정으로 쓸 때 에이전트가 적은 값이 섞인다. 이름만으로 거부하는 쪽이 싸다.

**② 출력에 섞인 자격증명.** 이게 더 실질적이다. 에이전트에게 "설정 파일을
예시로 적어 줘" 를 시키면 모델은 `.env` 를 읽을 수 없으므로 보통 더미를
적는다. 그러나 근거 자료로 로그나 설정 조각이 들어가면 **거기 있던 실제
키를 그대로 베껴 쓴다.** 그 산출물은 위키에 축적되고, 결재함에 보이고,
텔레그램 알림으로 바깥 서버를 한 번 거쳐 간다.

## 어디까지 가리는가

과하게 가리면 쓸모가 없어진다 — 긴 base64 문자열을 전부 지우면 코드 산출물이
깨진다. 그래서 **접두사가 분명한 것**과 **키 이름 뒤에 붙은 것** 둘만 본다.
무작위로 길고 엔트로피 높은 문자열은 건드리지 않는다.
"""
from __future__ import annotations

import re

MASK = "***가려짐***"

# 접두사만으로 자격증명임이 분명한 것들. 여기 있는 것은 문맥을 안 봐도 된다.
_PREFIXED = [
    # OpenRouter / OpenAI 계열
    re.compile(r"\bsk-(?:or-v1-|proj-|ant-)?[A-Za-z0-9_\-]{20,}"),
    # GitHub (classic / fine-grained / oauth / server / refresh)
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{30,}"),
    # Telegram 봇 토큰 — 숫자:문자 꼴
    re.compile(r"\b\d{8,12}:[A-Za-z0-9_\-]{30,}"),
    # Discord 봇 토큰
    re.compile(r"\b[MNO][A-Za-z0-9_\-]{23,}\.[A-Za-z0-9_\-]{6}\.[A-Za-z0-9_\-]{27,}"),
    # AWS
    re.compile(r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    # Google API
    re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b"),
    # Slack
    re.compile(r"\bxox[baprs]-[0-9A-Za-z\-]{10,}"),
    # PEM 블록 전체
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----",
               re.S),
]

# "키 이름 = 값" 꼴. 값 자체로는 평범해 보여도 이름이 비밀이라고 말해 준다.
# 앱 비밀번호 16자처럼 생김만으로는 못 가리는 것이 여기 걸린다.
_SECRET_KEY = (
    r"(?:API[_-]?KEY|SECRET(?:[_-]?KEY)?|ACCESS[_-]?KEY|PRIVATE[_-]?KEY"
    r"|APP[_-]?PASSWORD|PASSWORD|PASSWD|TOKEN|AUTH[_-]?TOKEN|BEARER"
    r"|CLIENT[_-]?SECRET|REFRESH[_-]?TOKEN|CREDENTIAL)"
)
# 둘로 나눈다 — 따옴표가 있으면 공백을 허용해야 하고, 없으면 허용하면 안 된다.
#
# 처음엔 하나로 두고 값에서 공백을 뺐다. 그랬더니 Gmail 앱 비밀번호가
# 안 걸렸다 — 구글은 그걸 "abcd efgh ijkl mnop" 처럼 네 덩어리로 보여 주고
# 사장님도 그대로 적어 두셨다. 공백이 든 비밀번호가 실제로 쓰이고 있다.
_NAME = rf'([\"\']?\w*{_SECRET_KEY}\w*[\"\']?\s*[:=]\s*)'
_ASSIGNED_Q = re.compile(rf'(?i){_NAME}([\"\'])([^\"\'\r\n]{{6,}})\2')
_ASSIGNED_B = re.compile(rf'(?i){_NAME}()([^\s\"\'\r\n,;}}\)\]]{{6,}})')

# 여기 적힌 것은 가리지 않는다 — 가려 봐야 아무 비밀도 지키지 못하고,
# 설정 예시 산출물만 못 읽게 된다.
_PLACEHOLDER = re.compile(
    r"(?i)^(?:x{3,}|[*]{3,}|[.]{3,}|<.*>|여기에.*|your[_ -]?.*|"
    r"changeme|placeholder|dummy|example|sample|test|todo|none|null|true|false|"
    r"발급받은.*|입력.*|채워.*)$")

# 값이 자격증명처럼 생겼는지. 이게 없으면 코드 산출물이 깨진다 —
# `password: Optional[str] = None` 의 "Optional[str]" 이 13자라 길이만으로는
# 통과해 버린다. 함수 시그니처를 가려 놓으면 코드가 못 읽게 된다.
_CODEISH = re.compile(r"[\[\]()<>{}]|^(?:str|int|bool|float|bytes|Any|None)")


def _looks_secret(val: str) -> bool:
    v = val.strip().strip("\"'")
    if len(v) < 6 or _PLACEHOLDER.match(v) or _CODEISH.search(v):
        return False
    # 자격증명은 숫자가 섞이거나 충분히 길다. 영문 소문자 한 단어는 아니다.
    return any(c.isdigit() for c in v) or len(v) >= 12


def _assigned_sub(m: re.Match) -> str:
    if not _looks_secret(m.group(3)):
        return m.group(0)
    q = m.group(2)
    return f"{m.group(1)}{q}{MASK}{q}"


def mask(text: str) -> str:
    """자격증명으로 보이는 부분만 가린다. 그 외는 한 글자도 바꾸지 않는다."""
    if not text:
        return text
    out = text
    for pat in _PREFIXED:
        out = pat.sub(MASK, out)
    out = _ASSIGNED_Q.sub(_assigned_sub, out)
    out = _ASSIGNED_B.sub(_assigned_sub, out)
    return out


def found(text: str) -> bool:
    """가릴 것이 있었는지. 로그에 남기려면 이걸 쓴다 — 값은 찍지 않는다."""
    return bool(text) and mask(text) != text


# ── 민감한 파일명 ────────────────────────────────────────────────────
#
# workspace 안이어도 이 이름으로는 쓰지 못한다. 경로 검사(workspace 밖 차단)와
# 별개의 층이다 — 같은 층에 두면 "안쪽이니 괜찮다" 는 한 번의 판단에 둘이
# 함께 걸린다.
_DENY_NAME = re.compile(r"(?i)^(?:\.env.*|\.git.*|.*\.pem|.*\.key|.*\.pfx|.*\.p12"
                        r"|id_[rde]sa.*|\.npmrc|\.netrc|_netrc|\.htpasswd"
                        r"|credentials?(?:\.\w+)?|secrets?(?:\.\w+)?"
                        r"|service[_-]account.*\.json|token\.json)$")
_DENY_DIR = {".git", ".ssh", ".gnupg", "node_modules", "__pycache__", ".venv"}


def check_name(rel: str) -> str:
    """쓰면 안 되는 이름이면 사유를, 괜찮으면 빈 문자열을 돌려준다."""
    parts = [x for x in (rel or "").replace("\\", "/").split("/") if x]
    if not parts:
        return "경로가 비어 있습니다"
    for d in parts[:-1]:
        if d.lower() in _DENY_DIR:
            return f"쓰기 금지 디렉터리입니다: {d}/"
    if _DENY_NAME.match(parts[-1]):
        return f"자격증명이 담기는 이름이라 쓸 수 없습니다: {parts[-1]}"
    return ""


if __name__ == "__main__":
    import sys
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    samples = [
        'OPENROUTER_API_KEY="sk-or-v1-abcdef0123456789abcdef0123456789abcdef"',
        'TELEGRAM_BOT_TOKEN=8319472011:AAFkq2_mXnRzLpQ7vVbYc1dEf3GhIjKlMnO',
        'GMAIL_APP_PASSWORD="abcd efgh ijkl mnop"',
        'API_KEY=<your-key-here>',
        'PASSWORD=여기에 입력하세요',
        'DEBUG=true',
        'timeout = 30',
        'def hash_password(password: str) -> str:',
        'base64 = "dGhpcyBpcyBqdXN0IGEgbG9uZyBzdHJpbmcgbm90IGEgc2VjcmV0"',
        'def login(password: Optional[str] = None) -> bool:',
        'token: str = field(default_factory=str)',
        '  "api_key": "4f8b2c9d1e7a6035",',
        'MYUNGTECH_ACCESS_KEY=Mtech-7038',
    ]
    print("── 마스킹 ──")
    for t in samples:
        r = mask(t)
        print(f"  {'가림  ' if r != t else '그대로'} {r}")
    print("\n── 파일명 ──")
    for n in ["report.md", ".env", ".env.local", "src/.git/config", "key.pem",
              "credentials.json", "notes/secret.txt", "data/tokens.py"]:
        why = check_name(n)
        print(f"  {'거부  ' if why else '허용  '} {n:<22} {why}")
