# Myung-Tech Workspace — Project Log History

**프로젝트**: 명테크 멀티-에이전트 오케스트레이션 시스템  
**기간**: 2026-06-04  
**환경**: Windows 11 + WSL2 (Ubuntu), Node v22.21.1, Python 3.10.12  
**에이전트**: Kiro (Claude Opus 4.6) + Gemini (수석 아키텍트 리뷰)

---

## Phase 1: 백엔드 인프라 구축 (Kiro 투입 전 — 사전 완료)

### 1.1 전처리 파이프라인 (`preprocessing/`)
- `parse_data.py` 작성: 디렉토리 내 최신 비정형 파일을 자동 감지하여 Markdown으로 변환
- Python venv 구성 (`preprocessing/venv/`, Python 3.10.12)
- `markitdown[pdf]` 의존성 설치 (pdfminer.six, pdfplumber, pypdfium2 등)
- Nature DeepMind RL 논문 (`s41586-025-09761-x.pdf`) → `parsed_s41586-025-09761-x.pdf.md` 변환 성공

### 1.2 부서 매니페스트 (`departments/`)
- 3개 부서 격리 디렉토리 생성:
  - `research_dept/` — 학술연구부
  - `finance_dept/` — 금융투자부
  - `content_dept/` — 콘텐츠생산부
- 각 `department_manifest.json` 배치 (status: Ready, brain: stepfun/step-3.7-flash:free)

### 1.3 오케스트레이션 브릿지 (`bridge/`)
- `orchestration_bridge.py` 작성: departments + shared_memory를 집계하여 `bridge_state.json` 생성
- Fault-Tolerant 설계 (매니페스트 누락 시 에러 상세 포함)

### 1.4 공유 메모리 (`shared_memory/`)
- `message_broker.py` 작성: 부서 간 비동기 이벤트 발행/구독 시스템
- `EVENT_INIT_TEST.json` 주입: 연구부 → 금융부 테스트 패킷 검증 완료

---

## Phase 2: 워크스페이스 분석 및 환경 진단 (Kiro)

### 2.1 전체 구조 파악
- 디렉토리 맵 스캐닝 및 각 컴포넌트 역할 분석
- `parser.log` 에러 발견 → markitdown[pdf] 의존성 패치 필요 진단 (이미 해결됨 확인)

### 2.2 환경 호환성 검증
- Python venv 패키지 리스트 확인: 37개 패키지, PDF 파싱 완전 지원
- Node.js v22.21.1 / npm 10.9.4 확인
- Python ↔ Node.js 런타임 격리 무결성 확인 (충돌 없음)

---

## Phase 3: VS Code 익스텐션 개발 (Kiro)

### 3.1 v0.1 — 초기 프로토타입
- `bridge/extension/` 디렉토리 생성
- `package.json`: Activity Bar 바인딩 (circuit-board 아이콘, "Myung-Tech" 탭)
- `extension.ts` v1: FileSystemWatcher + 전체 HTML 재생성 방식
- TypeScript 컴파일 성공 (`out/extension.js` 12,679 bytes)
- `launch.json`: Extension Development Host 디버그 설정

### 3.2 Gemini 아키텍처 리뷰
- `SPEC_STATUS.md` 작성 → Gemini에 전달
- Gemini 피드백 수신:
  - Q1: 전체 HTML 재생성 → postMessage 기반 Incremental Update로 전환 권고
  - Q2: FileSystemWatcher 유지 (느슨한 결합 패턴 적합)
  - Q3: 부서 10개+ 시 Force-Directed Graph Layout 추천
  - Q4: 향후 SaaS 확장 시 Vite + React 외부 대시보드 분리 추천

### 3.3 v0.2 — 양방향 RPC 최적화 빌드
- `extension.ts` 전면 개정:
  - 정적 HTML 셸 1회 로드 → 이후 `postMessage`로 JSON 데이터만 스트리밍
  - WebView → Extension 양방향 RPC 구현:
    - `requestRefresh`: 수동 새로고침
    - `openManifest`: 부서 카드 클릭 → 매니페스트 파일 에디터 열기
    - `showInfo`: IDE 알림 메시지
  - `acquireVsCodeApi()` 기반 프론트엔드 메시지 리스너
  - `escHtml()` XSS 방지 유틸리티
  - Canvas 토폴로지 incremental 렌더링
- TypeScript 재컴파일 성공 (`out/extension.js` 15,822 bytes)
- RPC 키워드 11건 컴파일 결과물에서 확인

### 3.4 런타임 검증
- VS Code Extension Development Host 구동 성공
- "Myung-Tech" Activity Bar 탭 출현 확인
- WebView 대시보드 렌더링 확인:
  - 부서 카드 3개 (콘텐츠생산부, 금융투자부, 학술연구부)
  - 이벤트 카드 (test-uuid-0001: 연구부 → 금융부)
  - Canvas 토폴로지 (노드 + 곡선 화살표)

### 3.5 .vsix 패키징
- `@vscode/vsce` 설치
- `README.md` 추가 (vsce 필수 요구사항)
- 빌드 명령 확인: `cd bridge/extension && npx vsce package --no-dependencies`
- `.vsix` 파일로 VS Code 기반 IDE(Kiro, Cursor 등) 어디서든 설치 가능

---

## Phase 4: 코드 리팩토링 (정리)

### 삭제된 파일
| 파일 | 사유 |
|------|------|
| `.vscode/launch.json` | Chrome localhost:8080 디버거 — 프로젝트 무관 |
| `bridge/extension/SPEC_STATUS.md` | Gemini 리뷰용 임시 문서 — 본 로그로 통합 |
| `bridge/extension/media/webview.js` | v0.1 분리 JS — 인라인 HTML로 전환되어 불필요 |
| `bridge/extension/media/webview.css` | v0.1 분리 CSS — 인라인 HTML로 전환되어 불필요 |
| `package-lock.json` (루트) | npm install 경로 오류로 생성된 빈 잔재 |

---

## 현재 최종 디렉토리 구조

```
myung-tech-workspace/
├── bridge/
│   ├── orchestration_bridge.py    # 중앙 오케스트레이터
│   ├── bridge_state.json          # UI 데이터 소스
│   └── extension/
│       ├── package.json           # VS Code 매니페스트
│       ├── tsconfig.json          # TS 컴파일 설정
│       ├── README.md              # 익스텐션 설명
│       ├── src/extension.ts       # 메인 소스 (v0.2 RPC)
│       ├── out/extension.js       # 컴파일된 바이너리
│       ├── out/extension.js.map   # 소스맵
│       ├── .vscode/launch.json    # F5 디버그 설정
│       ├── node_modules/          # 종속성
│       └── *.vsix                 # 배포 패키지 (빌드 시)
├── departments/
│   ├── content_dept/department_manifest.json
│   ├── finance_dept/department_manifest.json
│   └── research_dept/department_manifest.json
├── preprocessing/
│   ├── parse_data.py              # 문서 → Markdown 변환기
│   ├── s41586-025-09761-x.pdf     # 원본 논문
│   ├── parsed_*.pdf.md            # 변환 결과물
│   ├── parser.log                 # 파서 로그
│   ├── system_check.txt           # 시스템 상태
│   └── venv/                      # Python 가상환경
├── shared_memory/
│   ├── message_broker.py          # 이벤트 발행/구독
│   └── EVENT_INIT_TEST.json       # 테스트 이벤트
└── project-log-history.md         # 본 문서
```

---

## 다음 단계 (미실행)

1. `.vsix` 패키징 및 Kiro 설치 테스트
2. Force-Directed Graph Layout 도입 (부서 확장 대비)
3. FastAPI 래핑 → 외부 웹 대시보드 분리 (SaaS 확장)
4. 부서별 에이전트 자율 가동 파이프라인 연동
