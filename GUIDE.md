# 명테크 Agent Studio — 실행 가이드

> 버전 1.3 · 최종 수정 2026-06-26

---

## 목차

1. [시스템 개요](#1-시스템-개요)
2. [컴포넌트 구조](#2-컴포넌트-구조)
3. [설치 및 사전 요건](#3-설치-및-사전-요건)
4. [실행 방법](#4-실행-방법)
5. [UI 사용 방법](#5-ui-사용-방법)
6. [에이전트 구성](#6-에이전트-구성)
7. [동작 흐름](#7-동작-흐름)
8. [API 레퍼런스](#8-api-레퍼런스)
9. [트러블슈팅](#9-트러블슈팅)
10. [START.bat / STOP.bat 가이드](#10-startbat--stopbat-가이드)

---

## 1. 시스템 개요

명테크 Agent Studio는 **로컬 LLM(Ollama) 기반 멀티-에이전트 오케스트레이션 시스템**입니다.  
사장님(디렉터)이 지시를 내리면 AI 팀(5개 부서, 12명 에이전트)이 분업하여 태스크를 처리합니다.

```
디렉터(사람)
    ↓ 지시
Agent Studio UI (http://localhost:5174)
    ↓ REST API
API 서버 — server.py (http://localhost:9000)
    ↓ 태스크 큐
에이전트 디스패처 — bridge/agent_dispatcher.py
    ↓ LLM 호출
Ollama (http://localhost:11434) → qwen2.5:7b
    ↓ 결과
공유 메모리 → UI 실시간 피드
```

### 핵심 특징

| 특징 | 설명 |
|------|------|
| **로컬 실행** | 인터넷 없이 Ollama로 완전 로컬 동작 |
| **멀티-에이전트** | 5개 부서 12명 에이전트가 병렬 처리 |
| **실시간 피드** | SSE(Server-Sent Events)로 에이전트 활동 실시간 확인 |
| **파일 기반 큐** | Redis 없이 JSON 파일로 태스크 큐 운영 |
| **Telegram 연동** | 봇으로 모바일에서 지시 및 결과 수신 가능 |

---

## 2. 컴포넌트 구조

```
D:\myung-tech-workspace\
│
├── server.py                  ← API 서버 (포트 9000)
├── run.py                     ← 통합 런처 CLI
├── telegram_gateway.py        ← Telegram 봇 게이트웨이
│
├── bridge\
│   ├── agent_dispatcher.py    ← 태스크 큐 → LLM 처리 엔진
│   ├── orchestration_bridge.py ← 부서 상태 집계 (bridge_state.json 생성)
│   └── bridge_daemon.py       ← 브릿지 자동 갱신 데몬
│
├── orchestrator\
│   └── graphs\nodes.py        ← LangGraph 에이전트 노드
│
├── departments\
│   ├── orchestration_dept\    ← 오케스트레이션부 (마스터 AI)
│   ├── research_dept\         ← 학술연구팀
│   ├── finance_dept\          ← 금융투자팀
│   ├── dev_dept\              ← 개발부
│   └── content_dept\          ← 콘텐츠/디자인팀
│       ├── department_manifest.json   ← 부서 설정
│       └── agents\
│           └── *.json         ← 에이전트 프로필 (SOUL)
│
├── shared_memory\
│   ├── task_queue.py          ← 태스크 큐 관리
│   ├── message_broker.py      ← SSE 이벤트 발행/구독
│   └── tasks\                 ← 태스크 JSON 파일 저장소
│       └── task-*.json
│
├── virtual-office\            ← React UI (Vite)
│   ├── src\
│   │   ├── App.tsx            ← 메인 화면
│   │   ├── components\
│   │   │   ├── BrainCanvas.tsx     ← 뇌 네트워크 시각화
│   │   │   ├── AgentTeamModal.tsx  ← 팀 관리
│   │   │   ├── KnowledgeTab.tsx    ← 지식베이스 탭 (트리 + 문서 뷰어)
│   │   │   ├── ProjectsTab.tsx     ← 프로젝트 목록·산출물
│   │   │   ├── NotesTab.tsx        ← 할 일 (프로젝트 탭 안의 한 칸)
│   │   │   ├── MemoryModal.tsx     ← 지식 네트워크
│   │   │   ├── ModelModal.tsx      ← AI 모델 선택
│   │   │   └── ManageModal.tsx     ← 관리 대시보드
│   │   └── styles\hermes.css
│   └── vite.config.ts         ← /api → localhost:9000 프록시
│
├── START.bat                  ← 원클릭 전체 시작
├── STOP.bat                   ← 원클릭 전체 종료
└── STATUS.bat                 ← 실행 상태 확인
```

---

## 3. 설치 및 사전 요건

### 필수 소프트웨어

| 소프트웨어 | 버전 | 확인 명령 |
|-----------|------|----------|
| Python | 3.11+ | `python --version` |
| Node.js | 18+ | `node --version` |
| Ollama | 최신 | `ollama --version` |

### 필수 모델 설치

```powershell
# 에이전트용 메인 모델
ollama pull qwen2.5:7b      # 4.7 GB — 모든 에이전트에서 사용

# (선택) 경량 모델 — 저사양 PC
ollama pull qwen2.5:3b      # 2.0 GB
```

### Python 패키지 설치

```powershell
cd D:\myung-tech-workspace
pip install -r requirements.txt
```

### Node 패키지 설치

```powershell
cd D:\myung-tech-workspace\virtual-office
npm install
```

---

## 4. 실행 방법

### 방법 A — 원클릭 (권장)

`D:\myung-tech-workspace\START.bat` 더블클릭

> START.bat이 실행하는 것:
> 1. API 서버 (포트 9000)
> 2. 에이전트 디스패처
> 3. Vite 개발 서버 (포트 5174)
> 4. 6초 후 브라우저 자동 오픈

### 방법 B — 수동 실행 (3개 터미널)

**터미널 1 — API 서버**
```powershell
cd D:\myung-tech-workspace
python server.py
# 출력: [server] 에이전트 12명 로드됨
```

**터미널 2 — 에이전트 디스패처**
```powershell
cd D:\myung-tech-workspace
python run.py dispatch daemon
# 출력: [dispatcher] 백엔드: Ollama (http://localhost:11434)
# 출력: [dispatcher] Daemon started.
```

**터미널 3 — UI 개발 서버**
```powershell
cd D:\myung-tech-workspace\virtual-office
npm run dev
# 출력: Local: http://localhost:5174/
```

**브라우저 접속**: http://localhost:5174

### 서비스 포트 정리

| 서비스 | 포트 | 역할 |
|--------|------|------|
| API 서버 | 9000 | 에이전트 관리, 태스크 처리, SSE 스트림 |
| Vite UI | 5174 | Agent Studio 웹 인터페이스 |
| Ollama | 11434 | 로컬 LLM 추론 엔진 |

---

## 5. UI 사용 방법

### 화면 구성

```
┌──────────────────────────────────────────────────────────────┐
│ ☰  [M] 명테크 AGENT STUDIO   ●서버 ●AI모델 ●지식베이스        │
│                              [✋ 사장님 차례 N] [🔔] [⠿ 메뉴] │
├──────────────────────────────────────────────────────────────┤
│ 💬 메인 │ 🏢 사무실 │ 🤖 에이전트 │ 🚀 프로젝트 │ 🧬 지식베이스 │
├───────────────┬──────────────────────────────────────────────┤
│ 태스크 현황    │                                              │
│  대기/처리중/  │          채팅 (맹비서 · 부서)                 │
│  완료/실패     │                                              │
│               │                                              │
│ 지금 막힌 것   │  [📊 시장 트렌드] [✍️ 콘텐츠] [💰 현황]        │
│  결재 N건 →   ├──────────────────────────────────────────────┤
│               │  ┌────────────────────────────────────────┐  │
│ 에이전트 활동  │  │ 입력창 (쓰는 만큼 늘어남, 상한 8줄)       │  │
│  부서 5개      │  │ [＋] 🤖 맹비서                     [↑] │  │
│  (눌러서 사무실)│  └────────────────────────────────────────┘  │
└───────────────┴──────────────────────────────────────────────┘
```

### 탭 다섯

| 탭 | 무엇을 보나 |
|----|-------------|
| 💬 **메인** | 맹비서·부서와의 대화. 왼쪽에 태스크 현황·막힌 것·에이전트 활동 |
| 🏢 **사무실** | 2D 사무실. 에이전트들이 주고받는 말이 그대로 보입니다 |
| 🤖 **에이전트** | 에이전트 12명의 설정과 실시간 연산 로그 |
| 🚀 **프로젝트** | 결재함 · 배운 것 · 칸반 · **할 일** · 프로젝트 목록 |
| 🧬 **지식베이스** | 위키 390건을 폴더로 뒤지고 논문처럼 읽습니다 |

> 프로젝트 탭은 전에 '프로젝트' 와 'CEO 룸' 두 탭이었습니다. CEO 룸에
> 있던 것(결재함·교훈·KPI·칸반)이 전부 프로젝트에 딸린 것이라,
> "승인하려면 탭을 옮기고 무엇을 승인하는지 보려면 돌아오는" 왕복을
> 없애려고 합쳤습니다. 지식베이스 탭은 전에 '노트' 탭이었고, 거기 있던
> 할 일 목록은 프로젝트 탭의 결재함 아래로 옮겼습니다.

### 상단 메뉴 (⠿)

| 항목 | 기능 |
|------|------|
| 📊 시스템 현황판 | 서버·모델·클러스터 상태 |
| 🧬 지식 네트워크 | 지식 그래프 시각화 · 문서 주입 |
| 🤖 LLM 모델 | 오케스트레이션 부서가 쓸 Ollama 모델 선택 |
| ✨ 새 대화 | 맹비서와 새 세션을 엽니다 |
| 🗂 대화 기록 | 지난 세션 목록 |
| ⚙️ 관리 탭 | 대시보드 · 내 서비스 · 연동 |

머리말의 점 세 개(●서버 ●AI 모델 ●지식 베이스)는 각각 백엔드·Ollama·
위키 경로가 살아 있는지 봅니다. **FreeLLMAPI 라우터**는 여기가 아니라
관리 탭 대시보드의 패널에서 봅니다 — 부서 다섯 중 넷이 그 라우터를
타는데 머리말의 "AI 모델" 점은 Ollama 만 보기 때문입니다.

### 채팅 사용법

**직접 지시하기**
1. 입력창에 지시를 씁니다. 기본 상대는 **맹비서**입니다.
2. `Enter` 전송 · `Shift+Enter` 줄바꿈
3. 여러 줄을 쓰면 입력창이 따라 늘어나고, 8줄쯤에서 안쪽 스크롤로 바뀝니다.

**＋ 메뉴 — 상대와 명령**

입력창 왼쪽 `＋` 를 누르면 두 묶음이 나옵니다.

| 묶음 | 항목 |
|------|------|
| 대화 상대 | 🤖 맹비서(기본) · 오케스트레이션 · 학술연구 · 금융투자 · 개발 · 콘텐츠 |
| 빠른 명령 | `/현황`(myungtech-status) · `/결재`(myungtech-approvals) · 위키에서 찾기(wiki-prompts) |

빠른 명령은 **맹비서가 실제로 가진 스킬**에 붙은 것만 넣었습니다. 지금
누구와 말하는 중인지는 `＋` 오른쪽에 늘 적혀 있습니다.

**퀵 액션 칩**
- `📊 시장 트렌드 리포트 요청` — 금융·리서치팀
- `✍️ 콘텐츠 기획안 작성` — 콘텐츠팀
- `💰 매출·채널 현황 보고` — 금융팀

**부서 선택 가이드**

| 부서 | 적합한 지시 |
|------|------------|
| 🧠 오케스트레이션 | "오늘 할 일 정리해줘", 복합 태스크 자동 분배 |
| 🔬 학술연구 | "논문 조사해줘", "데이터 분석해줘", 크롤링 |
| 📈 금융투자 | "포트폴리오 분석", "시장 동향 보고", 백테스팅 |
| ⚙️ 개발 | "코드 작성해줘", "버그 수정", 자동화 스크립트 |
| ✍️ 콘텐츠 | "블로그 글 써줘", "SNS 기획안", 카드뉴스 |

### 에이전트가 무엇을 하고 있는지

메인 탭 하단에 있던 **실시간 활동 피드는 뺐습니다.** 같은 내용을 세
군데에서 보여 주고 있었기 때문입니다. 지금은 보고 싶은 깊이에 따라
자리가 다릅니다.

| 보고 싶은 것 | 어디 |
|--------------|------|
| 어느 부서가 지금 바쁜가 | 메인 탭 왼쪽 **에이전트 활동** (눌러서 사무실로) |
| 에이전트들이 주고받는 말 | 🏢 **사무실** 탭 |
| 호출·토큰·지연 같은 연산 로그 | 🤖 **에이전트** 탭 |
| 어느 공급자로 나갔나 | ⚙️ 관리 탭 → **FreeLLMAPI 라우터** 패널 |

### 지식베이스 탭

왼쪽이 폴더, 가운데가 문서, 오른쪽이 목차입니다.

- **폴더** — 개념 · 인물·조직 · 비교 · 부서 산출물 · 논문 · 논문 전문 ·
  읽을 거리 · 기타 메모 · 용어 · 원문 PDF
- **점 색** — 청록은 사람이 정리한 노드, 보라는 arXiv 논문, 호박은
  AI 가 만들어 결재를 통과한 산출물. 근거의 무게가 다릅니다.
- **제목 검색**은 즉시 걸러내고, **본문 검색**은 서버가 본문을 훑습니다.
- 문서 안의 `[[위키링크]]` 와 아래쪽 **연결된 지식** 꼬리표를 눌러
  옮겨 다닐 수 있습니다. 문서가 없는 링크는 눌리지 않게 회색입니다.
- PDF 는 브라우저 내장 뷰어로 엽니다.
- 사이드바 맨 아래 **위키 로컬 최신 변경**은 파일 시스템의 수정 시각
  입니다 — 깃허브 동기화 시각이 아닙니다. 둘은 실제로 다릅니다.

#### 문서에 무엇이 들어 있나

**논문**(references, 227건) — 서지 정보 · **초록 전문** · 핵심(저자가 쓴
기여 문단과 결론). 전에는 초록이 800자에서 문장 중간에 잘려 있었습니다
(187건 중 178건). 지금은 평균 1283자이고 201건에 핵심이 붙어 있습니다.

**논문 전문**(raw/papers, 21건) — arXiv 논문은 **ar5iv**(LaTeX 원본
HTML)에서 뽑습니다. PDF 추출과 비교하면:

| 논문 | PDF | ar5iv |
|---|---|---|
| Attention Is All You Need | 표줄 0 · 제목 1 | 표줄 **57** · 제목 31 · 수식 126 |
| BERT | 표줄 0 · 제목 1 | 표줄 **87** · 제목 48 |
| GPT-3 | 표줄 0 · 제목 1 | 표줄 **651** · 제목 58 |

PDF 경로는 표를 전부 잃고 본문이 한 덩어리가 됩니다. 각 문서의
프런트매터 `extraction:` 에 어느 쪽으로 만들었는지 적혀 있습니다.

> **수식은 조판되지 않습니다.** `$...$` 안의 LaTeX 소스가 고정폭 글씨로
> 보입니다. KaTeX 를 들이면 의존성 하나와 번들 270KB 가 모든 화면에
> 얹히는데, 수식이 있는 문서는 390건 중 54건(14%)뿐입니다.

**인물**(entities, 20건) — 한 줄 요약 · 기본 정보 · 위키에 있는 논문 ·
연결된 지식. 경력·수상 같은 전기는 자동으로 채우지 않습니다. 근거가
없는 노드는 `## 더 채울 것` 으로 표시돼 있습니다(현재 2건).

---

## 6. 에이전트 구성

### 부서별 에이전트

> **이름은 `virtual-office/src/api.ts` 의 `deptLabels` 가 정본입니다.**
> 접미사는 `~부` 로 통일했습니다 — 서버 id 가 전부 `_dept`(부서)입니다.
> 전에는 같은 부서가 자리마다 네 가지 이름으로 나왔습니다(학술연구부 /
> 학술연구팀 / 연구실 / 학술연구부). 화면에서 부서 이름을 쓸 때는
> 하드코딩하지 말고 `deptLabels[id]` 를 읽으세요.
>
> 사무실의 **방** 이름('개발실', 'CEO실 · 회의실')은 장소 이름이라
> 부서명과 다를 수 있습니다 — 그 방에는 실제로 CEO 책상과 회의 테이블이
> 함께 있습니다.

**🧠 오케스트레이션부** (1명)
| ID | 이름 | 역할 | 레벨 |
|----|------|------|------|
| orch_master_01 | 김효율 모더레이터 | Master Orchestrator | 5 |

**🔬 학술연구팀** (3명)
| ID | 이름 | 역할 |
|----|------|------|
| res_pm_01 | 박연구 | Project Manager |
| res_crawler_01 | 크롤러 | Web Crawler |
| res_worker_01 | 리서처 | Research Worker |

**📈 금융투자팀** (2명)
| ID | 이름 | 역할 |
|----|------|------|
| fin_pm_01 | 이재무 | Project Manager |
| fin_worker_01 | 분석가 | Financial Analyst |

**⚙️ 개발부** (3명)
| ID | 이름 | 역할 |
|----|------|------|
| dev_pm_01 | 김아키텍트 | Project Manager |
| dev_coder_01 | 코더 | Coder |
| dev_qa_01 | QA | QA Engineer |

**✍️ 콘텐츠팀** (3명)
| ID | 이름 | 역할 |
|----|------|------|
| con_pm_01 | 크리에이터장 | Project Manager |
| con_designer_01 | 디자이너 | Designer |
| con_worker_01 | 작가 | Content Writer |

### 에이전트 JSON 수정

에이전트 성격/역할을 수정하려면 해당 JSON 파일을 편집합니다.

```
departments\research_dept\agents\PM_agent.json
```

```json
{
  "agent_id": "res_pm_01",
  "character_name": "박연구",
  "role": "Project Manager",
  "level": 3,
  "preferred_model": "qwen2.5:7b",
  "base_prompt": "너는 학술연구팀 PM이다. ...",
  "persona": "꼼꼼한 연구자이자 ...",
  "status": "Idle"
}
```

> ⚠️ 저장 시 반드시 **UTF-8 (BOM 없음)** 인코딩으로 저장할 것.  
> VS Code: 우측 하단 인코딩 클릭 → "UTF-8" 선택

---

## 7. 동작 흐름

### 전체 아키텍처 흐름

```
[1] 사용자 입력
    브라우저 채팅창 또는 Telegram 메시지
        ↓
[2] API 서버 (server.py :9000)
    POST /api/workflow/run
    → task_queue에 태스크 파일 생성
    → shared_memory/tasks/task-xxxx.json
        ↓
[3] 에이전트 디스패처 (agent_dispatcher.py)
    3초마다 큐 폴링
    → pending 태스크 발견
    → Ollama API 호출 (http://localhost:11434/v1/chat/completions)
    → 에이전트 SOUL(base_prompt) + 태스크를 LLM에 전달
    → 결과를 task 파일에 기록 (status: done)
    → message_broker.publish_event() 호출
        ↓
[4] 메시지 브로커 (message_broker.py)
    → 결과를 shared_memory/*.json 이벤트 파일로 저장
    → SSE 스트림으로 브라우저에 푸시
        ↓
[5] UI 실시간 업데이트
    사무실 탭 · 에이전트 탭이 /api/events 를 읽어 새 이벤트를 붙인다
    (메인 탭의 실시간 피드는 뺐다 — 같은 것을 세 군데서 보여 주고 있었다)
```

### 운영 사이클은 없습니다 (2026-10-21 제거)

전에는 **🚀 운영 시작** 버튼이 `POST /api/cycle/run_once` 로 분석 →
작전 검토 → 실행 3단계를 한 번에 돌렸습니다. 그 경로를 들어냈습니다.

이유는 하나입니다 — **근거 조회·검토·방법 절을 전부 우회했습니다.**
오케스트레이터가 상황을 "분석" 한 뒤 바로 부서에 태스크를 뿌리는데,
그 분석은 위키에서 아무것도 읽지 않고 모델이 지어낸 것이었습니다.
자세한 사유는 `RAISE_COMPLIANCE.md` 의 "운영 사이클을 들어낸 이유" 절에
있습니다.

지금 일을 시키는 길은 둘입니다.

| 길 | 어디 | 무엇을 거치나 |
|----|------|---------------|
| **프로젝트** | 🚀 프로젝트 탭 → 새 프로젝트 | 계획 → 위키 근거 조회 → 심사(반려/통과) → 결재 |
| **대화** | 💬 메인 탭 → `＋` 로 부서 선택 | 부서 에이전트가 직접 답합니다 |

`GET /api/cycle/status` 는 남아 있습니다. 화면 여섯 곳이 그 **모양**을
읽고 있어서 이름을 유지했을 뿐, 지금 돌려주는 것은 사이클 깃발이 아니라
실제 활동(진행 중인 프로젝트·태스크)입니다.

### 태스크 파일 생명주기

```
task-xxxx.json 생성
    status: "pending"
        ↓ 디스패처가 픽업
    status: "in_progress"
        ↓ LLM 처리 완료
    status: "done" / "failed"
```

---

## 8. API 레퍼런스

베이스 URL: `http://localhost:9000`

### 헬스체크

```
GET /api/health

응답: {"status": "ok", "redis": "n/a", "vllm": "ollama", "server": "myung-tech-api"}
```

### 에이전트 목록

```
GET /api/agents

응답: {
  "total": 12,
  "agents": [
    {"agent_id": "orch_master_01", "character_name": "김효율 모더레이터", "status": "Idle", ...}
  ]
}
```

### 워크플로우 실행

```
POST /api/workflow/run
Content-Type: application/json

{
  "department": "research_dept",
  "task": "최신 강화학습 논문 3편 요약해줘"
}

응답: {"result": "논문 요약: ...", "message": "처리 완료"}
```

### 활동 상태

`run_once` · `stop` 은 제거했습니다(2026-10-21). 위 "운영 사이클은
없습니다" 절 참고.

```
GET  /api/cycle/status     ← 이름만 남았고, 실제로는 '지금 돌고 있는 것'

상태 응답: {
  "running": false,
  "status": "waiting",       // waiting | running
  "projects_running": 0,
  "projects_waiting": 1,
  "tasks_busy": 0,
  "approvals_pending": 2,
  "cycle_count": 0,
  "logs": ["[00:51:32] 사이클 #3 시작", ...]
}
```

### SSE 이벤트 스트림

```
GET /api/events/stream

→ text/event-stream (무한 스트림)
→ 이벤트 타입: new_event
→ 데이터 형식:
{
  "event_id": "evt-xxxx",
  "sender": "research_dept",
  "target": "finance_dept",
  "payload": "논문 파싱 완료, 전략 연동 준비",
  "timestamp": "2026-06-26T00:51:56Z"
}
```

### 터미널 명령 실행

```
POST /api/term/run
Content-Type: application/json

{"cmd": "ls departments"}

응답: {"output": "content_dept\ndev_dept\n...", "code": 0}
```

---

## 9. 트러블슈팅

### ❌ 에이전트 피드가 "미연결" 표시

```
원인: server.py가 실행 중이지 않거나 포트 9000 충돌
확인: netstat -ano | findstr :9000
해결: python server.py 재실행
```

### ❌ 디스패처 "unknown url type" 오류

```
원인: OLLAMA_HOST 환경변수가 "0.0.0.0" (http:// 없음)
확인: $env:OLLAMA_HOST
해결: 코드 자동 보정됨 (bridge/agent_dispatcher.py 수정 완료)
      또는: $env:OLLAMA_HOST = "http://localhost:11434"
```

### ❌ 에이전트 0명 로드됨

```
원인 A: UTF-8 BOM 인코딩 문제 (PowerShell로 저장 시 발생)
확인: python -c "import json; json.loads(open('departments/.../PM_agent.json', encoding='utf-8').read())"
해결: VS Code에서 UTF-8 (BOM 없음)으로 다시 저장

원인 B: departments/ 경로 문제
확인: python -c "from pathlib import Path; print(list((Path('D:/myung-tech-workspace/departments')).iterdir()))"
```

### ❌ 태스크가 계속 실패

```
원인 A: Ollama 미실행
확인: curl http://localhost:11434/api/tags
해결: Ollama 앱 실행 또는 올라마 서비스 시작

원인 B: 모델 미설치
확인: ollama list
해결: ollama pull qwen2.5:7b

원인 C: 큐에 오래된 실패 태스크 누적
해결: del D:\myung-tech-workspace\shared_memory\tasks\*.json
```

### ❌ UI에서 "빈 폴더에요" 표시 (사이드바)

```
원인: 서버 재시작 후 React 앱이 에이전트 목록을 캐싱
해결: 브라우저 새로고침 (F5) — 15초마다 자동 갱신됨
```

### ❌ ConnectionAbortedError / ConnectionResetError (서버 로그)

```
원인: 브라우저가 SSE 연결을 끊을 때 발생하는 정상 현상
해결: 무시해도 됨. 에러가 아닌 정상 동작
```

---

## 10. START.bat / STOP.bat 가이드

### START.bat — 전체 시작

`D:\myung-tech-workspace\START.bat` 더블클릭

```
실행 순서:
  [1/3] API 서버 (mt-server 창)
  [2/3] 에이전트 디스패처 (mt-dispatch 창)
  [3/3] Vite UI (mt-vite 창)
  → 6초 후 http://localhost:5174 자동 오픈
```

각 서비스는 별도 cmd 창으로 실행되므로 로그를 개별 확인할 수 있습니다.

### STOP.bat — 전체 종료

`D:\myung-tech-workspace\STOP.bat` 더블클릭

```
종료 순서:
  1. 창 제목으로 mt-server, mt-dispatch, mt-vite 프로세스 종료
  2. 포트 9000, 5174 잔여 프로세스 강제 종료
```

### STATUS.bat — 상태 확인

`D:\myung-tech-workspace\STATUS.bat` 더블클릭

```
확인 항목:
  - mt-server, mt-dispatch, mt-vite 창 실행 여부
  - 포트 9000, 5174 Listen 상태
  - /api/health 응답 확인
  - 서버 로그 마지막 5줄
```

### 수동 재시작이 필요한 경우

서버만 재시작:
```powershell
cd D:\myung-tech-workspace
python server.py
```

디스패처만 재시작:
```powershell
cd D:\myung-tech-workspace
python run.py dispatch daemon
```

큐 초기화 후 재시작:
```powershell
del D:\myung-tech-workspace\shared_memory\tasks\*.json
python run.py dispatch daemon
```

---

## 부록 — 자주 쓰는 명령어

```powershell
# 전체 상태 확인
curl http://localhost:9000/api/health
curl http://localhost:9000/api/agents
curl http://localhost:9000/api/cycle/status

# FreeLLMAPI 라우터 (모델 수 · 공급자 상태 · 오늘 사용량)
curl http://localhost:9000/api/router/status

# 지식베이스 (폴더 트리 · 로컬 수정 시각)
curl http://localhost:9000/api/knowledge/tree

# 구글 캘린더
curl http://localhost:9000/api/calendar/status

# 태스크 큐 초기화
del D:\myung-tech-workspace\shared_memory\tasks\*.json

# Ollama 모델 목록
ollama list

# Ollama 모델 추가
ollama pull qwen2.5:7b
ollama pull qwen2.5:3b

# 에이전트 로드 테스트
python -c "import sys; sys.path.insert(0,'D:/myung-tech-workspace'); import server; print([a['agent_id'] for a in server._load_all_agents()])"
```

---

*명테크 Agent Studio v1.3 — 개인 데스크톱 AI 팀 운영 시스템*
