# 명테크 연동 가이드

각 연동마다 **무엇이 필요한지 · 어디서 발급하는지 · 명테크가 그걸로 무엇을 하는지 ·
됐는지 어떻게 확인하는지** 를 적는다.

이 문서가 없어서 매번 물어보고 진행해야 했다. 앞으로는 이 문서만 보고 끝까지
갈 수 있어야 한다. 화면과 어긋나는 곳이 있으면 그건 문서의 잘못이다 — 고쳐 주기 바란다.

---

## 공통 — 어떻게 동작하는가

**저장과 연결은 다르다.**

- `💾 저장` 은 값을 `D:\myung-tech-workspace\.env` 에 넣을 뿐이다. → 배지 **저장됨**
- `🔌 연결 확인` 은 그 값으로 **실제 호출을 한 번** 해 본다. → 성공해야 배지 **연결 확인됨**

배지가 "저장됨" 에 머물러 있으면 아직 아무것도 검증되지 않은 것이다.
"연결 실패" 면 그 자리에 이유가 그대로 뜬다 — 그 문장이 다음에 할 일을 알려 준다.

**읽기는 자동으로, 쓰기는 결재로.**

| | 어떻게 |
|---|---|
| **읽기** | 지시문에 관련 단어가 나오면 서버가 먼저 조회해서 **실제 수치**를 프롬프트에 넣는다. 에이전트는 그 값을 근거로 답한다 |
| **쓰기** | 에이전트는 `[실행]` 으로 제안만 한다. 결재함에 뜨고, **사장님이 승인한 순간에만** 실제 호출이 일어난다 |

트리거 단어(이게 없으면 조회하지 않는다 — 매번 다 부르면 할당량이 마른다):

| 연동 | 단어 |
|---|---|
| YouTube | 유튜브, youtube, 채널, 영상, 구독자, 조회수, 썸네일 |
| YouTube Analytics | 위 + 시청, 지속률, 트래픽, 애널리틱스 |
| PayPal | 페이팔, paypal, 수익, 매출, 결제, 정산, 입금 |
| GitHub | 깃헙, github, 레포, repo, 웹사이트, 블로그, 배포, 커밋 |

---

<a id="youtube-data"></a>
## 📺 YouTube Data API — 채널·영상 공개 지표

**넣을 값 2개**

| 키 | 무엇 |
|---|---|
| `YOUTUBE_API_KEY` | Google Cloud 의 API 키 |
| `YOUTUBE_CHANNEL_ID` | `UC` 로 시작하는 24자. **`@핸들`이 아니다** |

**발급 절차**

1. [Google Cloud Console](https://console.cloud.google.com/) → 프로젝트 만들기(아무 이름)
2. **API 및 서비스 → 라이브러리** → "YouTube Data API v3" 검색 → **사용 설정**
3. **사용자 인증 정보 → 사용자 인증 정보 만들기 → API 키** → 복사
4. (권장) 그 키의 **API 제한**에서 YouTube Data API v3 만 허용
5. Channel ID 는 [youtube.com/account_advanced](https://www.youtube.com/account_advanced) 에서 확인

**명테크가 이걸로 하는 일** — 채널 구독자·총조회·영상 수, 최근 영상 목록과
각 영상의 조회·좋아요·댓글 수를 가져와 프롬프트에 넣는다. 그래서
"채널 성장 전략 짜줘" 가 추측이 아니라 실제 수치를 근거로 나온다.

**확인** — `🔌 연결 확인` → `채널명 — 구독 N명 · 영상 N개 · 총 조회 N회`

**할당량** — 하루 10,000 유닛. 우리가 쓰는 호출은 한 번에 1~3 유닛이라 사실상
문제가 되지 않는다(비싼 `search.list` 를 일부러 피했다).

**막히면**

| 증상 | 원인 |
|---|---|
| `채널을 찾지 못했습니다` | `@핸들` 을 넣었다. `UC…` 24자를 넣어야 한다 |
| `HTTP 403 … has not been used` | 2단계(API 사용 설정)를 안 했다 |
| `HTTP 400 API key not valid` | 키를 잘못 붙여넣었거나 제한에 걸렸다 |

---

<a id="youtube-oauth"></a>
## 📊 YouTube Analytics + 업로드 (OAuth)

API 키로는 **내 채널의 비공개 지표를 볼 수 없고, 업로드도 못 한다.** 그건 OAuth 다.

**넣을 값 2개 + 자동 1개**

| 키 | 무엇 |
|---|---|
| `YOUTUBE_OAUTH_CLIENT_ID` | OAuth 클라이언트 ID |
| `YOUTUBE_OAUTH_CLIENT_SECRET` | 그 비밀키 |
| `YOUTUBE_OAUTH_REFRESH_TOKEN` | **직접 넣지 않는다.** `⚡ 자동 연결` 이 받아서 저장한다 |

**발급 절차**

1. Cloud Console → **API 라이브러리** 에서 두 개를 켠다
   - `YouTube Data API v3` (업로드용)
   - `YouTube Analytics API` (지표용)
2. **OAuth 동의 화면** → 외부 → 앱 이름·이메일만 채우고 저장
3. **테스트 사용자**에 **본인 구글 계정을 반드시 추가한다.** 이걸 빼면 로그인 단계에서 거부된다
4. **사용자 인증 정보 → OAuth 클라이언트 ID → 데스크톱 앱이 아니라 '웹 애플리케이션'**
5. **승인된 리디렉션 URI** 에 정확히 이것을 추가:
   ```
   http://127.0.0.1:5814/yt-oauth-callback
   ```
   `localhost` 가 아니라 `127.0.0.1` 이다 — 윈도우에서 `localhost` 는 `::1`(IPv6)로 먼저
   풀려서 우리 서버가 못 받는다
6. 명테크 연동 탭에 Client ID/Secret 을 넣고 `💾 저장`
7. `⚡ 자동 연결` → 구글 로그인 → 권한 허용 → refresh_token 이 자동 저장된다

**명테크가 이걸로 하는 일**

- 읽기: 최근 28일 조회·시청시간·평균 시청 지속·구독 증감·트래픽 출처
- 쓰기(결재 필요): 영상 **업로드**, 제목·설명·공개범위 **수정**

**업로드는 이렇게 돈다**

1. 올릴 파일을 `D:\myung-tech-workspace\workspace\` 아래에 둔다
2. 에이전트가 제안한다 — `[실행] youtube_oauth.upload` + JSON
3. 결재함에 뜬다. **보낼 내용과 공개 범위가 그대로 보인다**
4. 승인하면 그때 올라간다. 거절하면 아무 일도 없다

> **공개 범위 기본값은 `private` 이다.** 실수로 세상에 나가는 것보다 실수로
> 비공개로 올라가는 편이 낫다. 공개하려면 승인 화면에서 `public` 인지 확인하고 누른다.

**확인** — `🔌 연결 확인` → `최근 7일 조회 N회 · 시청 N분 · 구독 +N/-N`

**막히면**

| 증상 | 원인 |
|---|---|
| `access_token 을 받지 못했습니다` | refresh_token 만료 또는 권한 취소 → `⚡ 자동 연결` 다시 |
| 로그인 화면에서 `앱이 차단됨` | 3단계 테스트 사용자 등록 누락 |
| `redirect_uri_mismatch` | 5단계 URI 가 한 글자라도 다르다 |

---

<a id="paypal"></a>
## 💰 PayPal — 수익 확인 (읽기 전용)

**넣을 값 2~3개**

| 키 | 무엇 |
|---|---|
| `PAYPAL_CLIENT_ID` | 앱의 Client ID |
| `PAYPAL_CLIENT_SECRET` | 그 Secret |
| `PAYPAL_MODE` | `sandbox`(기본) 또는 `live` |

**발급 절차**

1. [PayPal Developer](https://developer.paypal.com/dashboard/) 로그인
2. **Apps & Credentials** → 우상단에서 **Sandbox / Live 를 고른다** (탭이 다르면 키도 다르다)
3. **Create App** → 이름 아무거나 → 만들면 Client ID / Secret 이 나온다
4. 그 앱의 **Features** 에서 **`Transaction Search` 를 체크**한다.
   이걸 안 켜면 인증은 되는데 조회에서 403 이 난다
5. 실계정 매출을 보려면 `PAYPAL_MODE=live` + **비즈니스 계정**이어야 한다

**명테크가 이걸로 하는 일** — 통화별 잔액, 최근 30일 입금 건수·총액·수수료·순수익을
가져와 프롬프트에 넣는다. "이번 달 수익 얼마야" 가 실제 숫자로 답해진다.

> **송금·환불은 일부러 넣지 않았다.** 돈을 움직이는 호출은 결재 한 번 잘못 눌렀을 때
> 되돌릴 수 없다. 그건 PayPal 에서 직접 한다.

**확인** — `🔌 연결 확인` → `live 연결됨 — 잔액 USD 1,234.00`

**막히면**

| 증상 | 원인 |
|---|---|
| `인증은 됐지만 조회 권한이 없습니다` | 4단계 Transaction Search 미체크, 또는 개인 계정 |
| `토큰을 받지 못했습니다` | sandbox 키로 live 를 부르고 있다(또는 반대) |
| 거래가 비어 있다 | PayPal 은 한 번에 **31일**까지만 조회된다. 그 이전은 안 나온다 |

---

<a id="github"></a>
## 🐙 GitHub — 서비스 레포 읽기 + PR 생성

**넣을 값 1개**

| 키 | 무엇 |
|---|---|
| `GITHUB_TOKEN` | Fine-grained personal access token |

**발급 절차**

1. GitHub → 우상단 프로필 → **Settings → Developer settings**
2. **Personal access tokens → Fine-grained tokens → Generate new token**
3. **Repository access** → `Only select repositories` → 고칠 레포만 고른다
   (지금 등록된 것: `mengro1102/mengro1102.github.io`)
4. **Permissions → Repository permissions** 에서 두 개만:
   - `Contents` : **Read and write** (브랜치 만들고 파일 쓰기)
   - `Pull requests` : **Read and write** (PR 열기)
5. 만료일은 짧게. 만료되면 `연결 실패` 로 바로 보인다

**전제** — 관리 → **내 서비스** 탭에 레포를 `owner/repo` 로 등록해 두어야 한다.
등록된 레포만 읽고 고친다.

**명테크가 이걸로 하는 일**

- 읽기: 등록된 레포의 기본 브랜치·언어·최상위 파일 목록을 프롬프트에 넣는다
- 쓰기(결재 필요): 새 브랜치를 만들어 파일을 쓰고 **PR 을 연다**

> **기본 브랜치에 직접 push 하는 경로는 넣지 않았다.** GitHub Pages 는 push 하는
> 순간 세상에 나간다. PR 은 닫으면 끝이고, 머지 전에 diff 를 볼 수 있다.
> **머지는 사장님이 GitHub 에서 직접 한다.**

**확인** — `🔌 연결 확인` → `계정명 으로 연결됨 — 접근 가능 N개`

**막히면**

| 증상 | 원인 |
|---|---|
| `권한 없음: owner/repo` | 3단계에서 그 레포를 선택하지 않았다 |
| `HTTP 403` | 4단계 권한 부족 (Contents 가 Read 만) |
| `'내 서비스' 에 등록된 레포 없음` | 내 서비스 탭에서 `owner/repo` 를 채우지 않았다 |

---

<a id="telegram"></a>
## ✈️ 텔레그램 — 현재 상태

`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` 는 **저장만 된다.** 명테크가 이 값으로
메시지를 보내는 경로는 아직 없다.

다만 알림은 이미 나가고 있다 — `shared_memory/notify.py` 가 명테크 `.env` 에
채널이 없으면 **맹비서(`D:\AI_Workspace\hermes\.env`)의 봇으로 대신 보낸다.**
자율 프로젝트의 착수 요청·완료·정지 알림이 그 경로다.

명테크 전용 봇으로 분리하고 싶으면 여기에 토큰과 `TELEGRAM_CHAT_ID` 를 넣으면 된다.
넣는 순간 notify 가 그쪽을 먼저 쓴다.

---

<a id="toss"></a>
## 🏦 토스페이먼츠 — 현재 상태

`TOSS_SECRET_KEY` 는 **저장만 된다.** 조회 코드는 아직 없다.
PayPal 과 같은 모양으로 붙일 수 있다 — 필요해지면 말해 달라.

---

<a id="huggingface"></a>
## 🤗 HuggingFace — 현재 상태

`HUGGINGFACE_TOKEN` 은 **저장만 된다.** 그리고 지금은 그게 맞다.

장기기억(파인튜닝) 파이프는 `GraphRAG → SFT JSONL → Colab 노트북 생성` 까지만
있고, **학습한 모델을 명테크로 되가져오는 경로가 없다.** 라우터는 무료 클라우드
모델을 부르고 Ollama 는 로컬 GGUF 를 쓰는데, HF 의 LoRA 를 Ollama 로 옮기는
단계가 어디에도 없다.

**대신 축적을 먼저 만들었다.** 검토를 통과한 프로젝트는 완료되는 순간 위키의
`raw/projects/` 에 쌓이고(`shared_memory/experience.py`), 그 순간부터 다음
질문에서 근거로 검색된다. 산출물뿐 아니라 **검토에서 반려된 지적**도 함께
남긴다 — "이런 걸 만들 때 뭘 놓치는지" 가 결과물보다 값질 때가 많아서다.
지금 몇 건이 쌓였는지는 🧬 지식 네트워크 → 합성 탭에서 볼 수 있다.

그리고 지금 노드 수로는 파인튜닝이 도구 선택으로도 틀리다. 파인튜닝은 **문체·형식**을
넣는 데 좋고 **사실**을 넣는 데 나쁘다. 사실은 RAG 가 더 정확하게, 즉시, 공짜로 한다.

→ 순서를 이렇게 잡았다: **RAG 축적을 먼저**(대화·프로젝트 결과를 위키에 쌓기),
데이터가 수천 건이 된 뒤에 파인튜닝 파이프를 끝까지 잇는다.
그때 HF 토큰이 실제로 쓰인다.

---

## 새 연동을 붙이려면

`integrations/` 에 모듈 하나를 만들고 `register(Integration(...))` 하면 끝이다.

```python
register(Integration(
    name="myservice", label="내 서비스", icon="🔧",
    required=["MYSERVICE_TOKEN"],
    probe=probe,            # 실제로 한 번 불러 보고 Probe(ok, detail)
    context=context,        # 프롬프트에 넣을 사실 블록 (읽기)
    actions={"do": Action(id="do", label="…", run=fn, schema={...})},  # 결재 후 실행 (쓰기)
    docs="myservice",       # 이 문서의 앵커
))
```

그리고 두 곳을 챙긴다.

1. `integrations/__init__.py` 의 `_TRIGGERS` — 어떤 단어가 나오면 조회할지
2. `server.py` 의 `ALLOWED_ENV_KEYS` — 넣지 않으면 저장이 400 으로 거부된다
   (실제로 `PAYPAL_MODE` 가 빠져 있어서 PayPal 저장이 통째로 실패하고 있었다)
