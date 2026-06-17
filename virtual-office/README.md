# 명테크 가상 오피스 (Frontend)

React + Vite + Tailwind + Phaser.js 기반의 Agent ERP 프론트엔드.

## 페이지 구성
- `/` — **대시보드**: 시스템 상태, 부서별 에이전트 현황, 최근 이벤트
- `/agents` — **에이전트 관리**: 페르소나/역할/시스템 프롬프트 편집, 텔레그램 봇 연동, CRUD
- `/office` — **가상 오피스**: Phaser.js RPG 뷰 + 워크플로우 실행 패널

## 실행
```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # dist/ 프로덕션 빌드
```

## 백엔드 연동
- API: `http://localhost:9000` (orchestrator/main.py)
- 모든 호출은 `src/api.ts`의 `api` 객체를 통해 수행
- SSE 실시간 이벤트: `/events/stream`

## 구조
```
src/
├── api.ts          # 통합 API 클라이언트 (타입 정의 포함)
├── App.tsx         # 라우팅 + 사이드바
├── pages/          # Dashboard / AgentManager / VirtualOffice
└── game/           # Phaser 씬 (config / Boot / Office / Hud)
public/assets/      # 픽셀 아트 (connect-ai MIT)
```

## 에셋 크레딧
픽셀 캐릭터/인테리어: [connect-ai](https://github.com/wonseokjung/connect-ai) (MIT)
원본: [Modern Interiors by LimeZu](https://limezu.itch.io/moderninteriors)
