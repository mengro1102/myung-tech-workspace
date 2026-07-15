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
│   ├── orchestration_dept\    ← 오케스트레이션팀 (마스터 AI)
│   ├── research_dept\         ← 학술연구팀
│   ├── finance_dept\          ← 금융투자팀
│   ├── dev_dept\              ← 개발팀
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
│   │   │   ├── AgentFeed.tsx       ← 실시간 에이전트 피드
│   │   │   ├── AgentTeamModal.tsx  ← 팀 관리
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
┌─────────────────────────────────────────────────────┐
│ [M] 명테크 AGENT STUDIO    [🚀 운영 시작] [📁][🖥][🧬][🤖][+][⚙️] │
├──────────┬──────────────────────────────────────────┤
│ 📁 탐색기 │         뇌 네트워크 시각화 (260px)          │
│          ├──────────────────────────────────────────┤
│ workspace│                                          │
│ 🧠 오케스│          채팅 영역 (메시지 표시)            │
│ 🔬 학술연│                                          │
│ 📈 금융투│ [🚀 운영 시작] [📊 시장 트렌드] [✍️ 콘텐츠] [💰 현황]│
│ ⚙️ 개발  ├──────────────────────────────────────────┤
│ ✍️ 콘텐츠│ 에이전트 활동 피드 (실시간)               │
│          ├──────────────────────────────────────────┤
│ ● 상태   │ [오케스트레이션 ▾] [입력창] [↑]           │
└──────────┴──────────────────────────────────────────┘
```

### 상단 툴바 버튼

| 버튼 | 기능 |
|------|------|
| 🚀 **운영 시작** | 전체 에이전트 사이클 1회 실행. 분석→작전→실행 3단계 자동 진행 |
| ⏹ **중지** (빨간색) | 실행 중일 때 사이클 중지 |
| 📁 | 왼쪽 파일 탐색기 패널 토글 |
| 🖥 | 하단 터미널 패널 토글 |
| 🧬 | 지식 네트워크 모달 (PDF/문서 업로드) |
| 🤖 | AI 모델 선택 모달 |
| ＋ | 새 대화 시작 (채팅 초기화) |
| ⚙️ | 관리 대시보드 |

### 채팅 사용법

**직접 지시하기**
1. 하단 드롭다운에서 부서 선택 (기본: 오케스트레이션)
2. 입력창에 지시 입력
3. `Enter` 또는 `↑` 버튼으로 전송
4. `Shift+Enter` — 줄바꿈

**퀵 액션 칩 사용하기**
- `🚀 운영 시작 — AI 팀에게 오늘 일 시키기` : 전체 팀에 일일 운영 지시
- `📊 시장 트렌드 리포트 요청` : 금융/리서치팀에 리포트 생성 지시
- `✍️ 콘텐츠 기획안 작성` : 콘텐츠팀에 기획안 작성 지시
- `💰 매출·채널 현황 보고` : 금융팀에 현황 보고 요청

**부서 선택 가이드**

| 부서 | 적합한 지시 |
|------|------------|
| 🧠 오케스트레이션 | "오늘 할 일 정리해줘", 복합 태스크 자동 분배 |
| 🔬 학술연구 | "논문 조사해줘", "데이터 분석해줘", 크롤링 |
| 📈 금융투자 | "포트폴리오 분석", "시장 동향 보고", 백테스팅 |
| ⚙️ 개발 | "코드 작성해줘", "버그 수정", 자동화 스크립트 |
| ✍️ 콘텐츠 | "블로그 글 써줘", "SNS 기획안", 카드뉴스 |

### 에이전트 활동 피드

화면 하단의 **에이전트 활동 피드**는 SSE로 실시간 업데이트됩니다.

```
● 에이전트 활동 피드  [5]

🔬 학술연구부  →  📈 금융투자부   Nature RL 논문 파싱 완료, 전략 백테스팅 연동 준비
🧠 오케스트레이션  →  📊 telegram_user   분석 완료: 오늘 3건 태스크 처리됨
```

- **초록 점 ●** : 백엔드 SSE 실시간 연결됨
- **빨간 점 ●** : 서버 미연결 (server.py 확인 필요)

---

## 6. 에이전트 구성

### 부서별 에이전트

**🧠 오케스트레이션팀** (1명)
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

**⚙️ 개발팀** (3명)
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
    AgentFeed 컴포넌트 (EventSource → /api/events/stream)
    → 에이전트 활동 피드에 새 이벤트 추가
```

### 사이클 자동 실행 흐름 (🚀 운영 시작 클릭 시)

```
🚀 운영 시작 클릭
    ↓
POST /api/cycle/run_once
    ↓
[사이클 #N 시작]
    │
    ├─ [1/3] 분석 단계
    │   └─ 오케스트레이터 AI가 현재 상황 분석
    │       (Ollama qwen2.5:7b 호출)
    │
    ├─ [2/3] 작전 검토 단계
    │   └─ 어떤 부서에 무슨 태스크를 줄지 결정
    │
    └─ [3/3] 실행 단계
        ├─ 학술연구부 태스크 배분
        ├─ 금융투자부 태스크 배분
        └─ 콘텐츠생산부 태스크 배분

    ↓ (각 부서 태스크는 디스패처가 병렬 처리)

✅ 사이클 완료
```

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

### 사이클 제어

```
POST /api/cycle/run_once   ← 사이클 1회 실행
POST /api/cycle/stop       ← 실행 중 사이클 중지
GET  /api/cycle/status     ← 현재 상태 조회

상태 응답: {
  "running": false,
  "status": "idle",     // idle | analyzing | strategizing | executing
  "cycle_count": 3,
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

# 사이클 수동 실행
curl -X POST http://localhost:9000/api/cycle/run_once

# 사이클 중지
curl -X POST http://localhost:9000/api/cycle/stop

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
