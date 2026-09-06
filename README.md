# 명테크 Agent Studio

로컬 LLM 위에서 도는 1인 기업용 멀티-에이전트 워크스페이스입니다. 지시를 내리면
5개 부서 12명의 AI 에이전트가 나눠 처리하고, 그 과정이 픽셀 오피스 화면에서
움직임으로 보입니다.

- **부서 기반 오케스트레이션** — 태스크가 부서로 들어가고, 부서마다 두뇌(모델)를 고를 수 있습니다.
- **완전 무료 라우팅** — 클라우드 무료 티어(FreeLLMAPI 라우터)를 먼저 쓰고, 없으면 로컬 Ollama 로 내려갑니다.
- **지식베이스(GraphRAG) 연동** — 답변이 위키 문서를 근거로 인용하고, 없으면 없다고 말합니다.
- **에이전트가 올리는 할 일과 결재** — 돈을 쓰거나 되돌리기 어려운 일은 사람 승인을 받고 진행합니다.
- **2D 픽셀 오피스** — 누가 어느 방에서 무엇을 하고 있는지 한눈에 보이고, 직접 걸어 다닐 수도 있습니다.

> **이 소프트웨어에는 인증이 없습니다.** API 서버와 개발 서버 모두 `127.0.0.1`
> 에만 바인드합니다. 네트워크에 노출하지 마세요 — 태스크 큐, 설정 파일, 저장소가
> 전부 무인증으로 열려 있습니다. 바깥에서 써야 한다면 바인드를 바꾸기 전에
> 인증부터 붙여야 합니다.

## 요구 사항

| | |
|---|---|
| OS | Windows 10 이상 (배치 스크립트 기준) |
| Python | 3.11 이상 |
| Node.js | 18 이상 |
| [Ollama](https://ollama.com) | 로컬 폴백 두뇌. `ollama pull qwen2.5:7b` |
| GPU | 필수는 아니지만 7B 이상 모델에는 있는 편이 낫습니다 |

선택 사항:

- **FreeLLMAPI 라우터** (`127.0.0.1:3001`) — 클라우드 무료 티어를 묶어 주는 라우터입니다. 없으면 전 부서가 로컬 Ollama 를 씁니다.
- **GraphRAG 위키** — `.env` 의 `GRAPHRAG_KB_PATH` 가 가리키는 저장소. 없으면 지식베이스 없이 동작합니다.

## 실행

```bat
START.bat
```

Ollama → API 서버(9000) → 디스패처 데몬 → UI 개발 서버(5174) 순으로 띄우고
브라우저를 엽니다. 상태만 보려면 `STATUS.bat`, 내리려면 `STOP.bat`,
다시 띄우려면 `RESTART.bat` 입니다.

수동으로 띄운다면:

```bash
pip install psutil
python server.py                 # API :9000
python run.py dispatch daemon    # 태스크를 처리하는 데몬
cd virtual-office && npm install && npm run dev   # UI :5174
```

## 구조

```
server.py              HTTP API (:9000) — 인증 없음, 루프백 전용
run.py                 CLI. `dispatch daemon` 이 태스크를 소비한다
bridge/
  agent_dispatcher.py  태스크 → 백엔드 선택 → LLM 호출 → 결과·이벤트
departments/           부서와 에이전트 정의(JSON)
shared_memory/
  task_queue.py        태스크 큐(파일 기반)
  message_broker.py    부서 간 이벤트
  workspace_store.py   할 일 · 등록 서비스 · 승인 큐
knowledge_base.py      GraphRAG 위키 조회
virtual-office/        React + Vite UI, 캔버스 픽셀 오피스
runtime_config.json    공통 두뇌 등 이 PC 의 선택 (git 에 올리지 않음)
```

### 두뇌를 고르는 순서

1. 부서 등급이 `cloud` 이고 라우터가 살아 있으면 → 라우터(`auto:hermes`)
2. `OPENROUTER_API_KEY` 가 있으면 → OpenRouter
3. 그 외 → 로컬 Ollama

로컬 모델은 **부서 소속 에이전트의 `preferred_model` → 공통 두뇌 → 기본값**
순으로 정해집니다. 공통 두뇌는 UI 의 `LLM 모델` 에서 고르고
`runtime_config.json` 에 저장되며, 디스패처가 매 호출마다 그 파일을 읽으므로
데몬을 다시 띄우지 않아도 바로 반영됩니다.

### 에이전트가 화면에 남기는 것

에이전트는 답변 끝에 다음 줄을 덧붙일 수 있습니다. 디스패처가 그 줄만 꺼내
저장소에 올리고, 화면의 태스크 보드와 승인 큐에 나타납니다.

```
[할일] 썸네일 시안 3개 만들기
[결재요청] 광고 집행 ₩250,000 승인 요청
[파일] scripts/collect.py
```python
(파일 전체 내용)
```
```

`[파일]` 은 **제안**입니다. 승인 큐에 올라가고, 사장님이 승인을 누른 순간에만
`workspace/` 아래에 쓰입니다. 승인 전에는 아무것도 만들어지지 않습니다.

### 에이전트가 할 수 없는 일

에이전트는 **글만 씁니다.** 파일을 직접 만들거나 명령을 실행하거나 git·웹을
호출하지 않습니다 — 디스패처가 하는 일은 LLM 호출 한 번이 전부입니다.

이 사실을 시스템 프롬프트에 명시해 두었습니다. 예전에는 "파일을 만들어라"고
시키면 만들지 않고 "생성했습니다"라고 답했고, 태스크는 done 으로 기록됐습니다.
디스크에는 아무것도 없었습니다. 하지 않은 일을 했다고 보고하면 화면의 '완료'를
믿을 수 없게 됩니다.

산출물을 실제로 남기고 싶으면 `[파일]` 제안 → 승인 경로를 쓰면 됩니다.

## 맹비서(Hermes)와의 경계

둘은 Ollama 와 FreeLLMAPI 라우터를 공유하지만 하는 일이 다릅니다. 어느 쪽을
먼저 켜도 되고, 뒤에 오는 쪽은 이미 떠 있는 것을 건너뜁니다.

| | 맹비서 | 명테크 |
|---|---|---|
| 역할 | 개인 비서 — 텔레그램·디스코드로 대화, 위키 근거 응답 | 1인 기업 — 부서가 나눠 처리하는 작업 |
| 외부 도구(MCP) | **여기서 씁니다** — 도구 루프·툴셋·서브에이전트 | 없습니다. 도구가 필요한 일은 맹비서에게 |
| 파일·명령 실행 | 승인 게이트를 거쳐 수행 | 없습니다 |
| 화면 | 관측 대시보드 (127.0.0.1:9119) | 픽셀 오피스 (127.0.0.1:5174) |

명테크에 MCP 를 붙이지 않은 것은 의도입니다. 붙이려면 맹비서가 이미 가진
것(MCP 클라이언트, 도구 스키마 변환, 도구 호출 루프)을 통째로 다시 만들어야
하는데, 명테크 디스패처는 단발 LLM 호출 하나가 전부입니다. 절반만 지은 도구
연동은 없는 것보다 나쁩니다.

## 설정

`.env` 에 둡니다. UI 의 `관리 → 연동` 에서도 저장할 수 있고, 그때는 허용된
키만 받습니다.

| 키 | 쓰임 |
|---|---|
| `GRAPHRAG_KB_PATH` | 위키 저장소 경로 |
| `OLLAMA_BASE_URL` | 기본 `http://localhost:11434` |
| `OPENROUTER_API_KEY` | 라우터가 없을 때의 클라우드 폴백 |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | 텔레그램 알림 |
| `GITHUB_TOKEN`, `HUGGINGFACE_TOKEN` | 위키 동기화 · 모델 업로드 |

## 라이선스

MIT — [LICENSE](LICENSE) 를 보세요.

오피스 픽셀 아트는 직접 그린 것이 아닙니다. 출처와 조건은
[virtual-office/public/assets/office/ATTRIBUTION.md](virtual-office/public/assets/office/ATTRIBUTION.md)
에 적어 두었습니다 — 가구·바닥·벽은 [pixel-agents](https://github.com/pixel-agents-hq/pixel-agents)(MIT),
캐릭터는 [JIK-A-4 MetroCity](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack)(CC0) 입니다.
