# Connect AI 벤치마크 — 명테크 "1인 기업 OS" 설계

> 레퍼런스: **Connect AI v2 (P-Reinforce)** by wonseokjung (connect-ai-desktop-v0.4.8, VS Code/Cursor 확장 → 데스크톱 제품화).
> 목적: Connect AI의 검증된 패턴을 명테크(`virtual-office` + Python 백엔드 + GraphRAG)에 이식.
> 작성: 2026-06-25.

---

## 1. Connect AI 핵심 아키텍처 (벤치마크 대상)

| # | 패턴 | 요지 |
|---|---|---|
| A | **P-Reinforce "자율 지식 정원사"** | 원시 데이터(Raw) → 에이전트가 스스로 분석·폴더생성·마크다운 위키화(`00_Raw`/`10_Wiki`/`Skills`) |
| B | **Brain–GitHub 자동 동기화** | 파일 생성 순간 자동 `git add/commit/pull(-X ours)/push`. master는 push 명령 불필요 |
| C | **Brain Pack 주입(⚡)** | Agent University 웹 → 로컬 포트(4825) → 로컬 brain(`~/.connect-ai-brain`)에 지식 주입 → 신경망 확장 |
| D | **동적 모델 감지** | Ollama/LM Studio `v1/models` 자동 감지 → 드롭다운 |
| E | **에이전트 권한(코딩 에이전트)** | 파일 생성·수정·삭제·읽기, 디렉터리 탐색, 터미널 명령 (승인 기반) — 탐색기+터미널+채팅 워크스페이스 |
| F | **agents.ts 페르소나 맵** | `{id,name,role,emoji,color,specialty,tagline,persona,profileImage}`. CEO=오케스트레이터 + 전문가(레오=YouTube 등) |
| G | **Plaza 실시간 광장** | 에이전트 presence + 메시지 피드(Firebase RTDB, 웹+확장 공유). 가상 사무실의 대화 로그 |
| H | **데스크톱 OS 셸** | 시스템 트레이, 별도 "사무실 창", "켤 때 사무실 창 같이 열기", 오늘의 할일, "운영 시작 — AI 팀에게 맡기기" |

---

## 2. 명테크 현황 매핑 (have / partial / gap)

| 패턴 | 명테크 현재 | 상태 |
|---|---|---|
| A 지식 정원사 | `scripts/pipeline_raw_to_md.py` 등 raw→concepts→wiki 파이프라인 (GraphRAG) | 🟢 have (앱 트리거 X) |
| B Git 자동동기화 | GraphRAG는 git repo(GCM). 단기기억 `/api/knowledge/pull` 구현(Phase 1) | 🟡 partial (pull만, 자동 push X) |
| C Brain 주입(⚡) | MemoryModal 단기 탭(GraphRAG 참조) | 🟡 partial (참조 O, 주입 X) |
| D 모델 감지 | `/api/models`(Ollama tags), ModelModal | 🟢 have |
| E 에이전트 FS/터미널 | 없음 (departments는 LLM 호출 위주) | 🔴 gap |
| F 페르소나 맵 | `departments/*/department_manifest.json` + `data/personas.ts` | 🟢 have (스키마 차이) |
| G Plaza 피드 | `shared_memory/message_broker.py` + events SSE + Phaser `OfficeScene` | 🟡 partial (피드 시각화 약함) |
| H 데스크톱 셸 | Electron 앱(단일 창). 트레이/별도 창/오늘의할일/운영시작 일부 | 🟡 partial |

**결론:** 명테크는 Connect AI 패턴의 60~70%를 이미 보유. 벤치마크 = **(B/C) 지식 동기화·주입 완성 + (G/H) 사무실 운영 루프 시각화 + (E) 에이전트 실행 권한** 채우기.

---

## 3. 단계별 구축 로드맵

| Phase | 목표 | 패턴 | 규모 |
|---|---|---|---|
| **1 ✅** | 단기기억 = GraphRAG 실참조 (status/search/pull) | B(읽기)·C(참조) | 완료 |
| **2** | **지식 주입 + Auto-Git-Sync** — "⚡ 주입" 버튼: 텍스트/파일 → GraphRAG `raw/`에 저장 → 파이프라인 → 자동 commit/push | A·B·C | 중 |
| **3** | **운영 루프 시각화** — "운영 시작" → cycle_runner 가동 → 에이전트간 메시지를 사무실 피드(스크린샷2)로 실시간 스트림 + 오늘의 할일 | G·H | 중 |
| **4** | **에이전트 실행 권한** — 탐색기+터미널 워크스페이스, 파일 CRUD·명령 실행(승인 기반) | E | 대 |
| **5** | **장기기억 FT** — SFT/DPO + 로컬GPU/Colab (별도 스펙) | — | 대 |
| **6** | **데스크톱 셸 마감** — 트레이, 별도 사무실 창, 자동시작 옵션 | H | 소~중 |

---

## 4. 설계 원칙 (명테크 적용)

1. **GraphRAG = 단일 brain.** Connect AI의 `~/.connect-ai-brain` 역할을 `mrlee-wiki-graphrag`가 수행. 주입/동기화 모두 이 repo 기준.
2. **로컬 우선·승인 기반.** Ollama/무료모델 우선, 파일/터미널/푸시는 사용자 승인 후.
3. **기존 자산 재사용.** Phaser OfficeScene·message_broker·personas·server.py를 확장(재작성 X).
4. **백엔드는 stdlib http.server 유지**(의존성 0 원칙), 프론트는 React 모듈 확장.

---

## 5. 권장 다음 단계
**Phase 2(지식 주입 + Auto-Git-Sync)** 를 먼저 권장 — Phase 1(단기기억)에 바로 이어지고, Connect AI의 핵심 차별점(B/C)을 완성하며, 명테크 GraphRAG 파이프라인과 직결됨.
