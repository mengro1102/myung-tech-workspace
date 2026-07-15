# 명테크 GraphRAG 지식베이스 스키마

## 구조

```
knowledge_base/
├── SCHEMA.md          # 이 파일 — 스키마 정의
├── index.md           # 전체 노드 색인
├── log.md             # 변경 이력
├── concepts/          # 개념 노드 (*.md)
├── entities/          # 엔티티 노드 (*.md)
├── comparisons/       # 비교 노드 (*.md)
└── raw/
    └── articles/      # 주입된 원시 지식 (inject API)
```

## 노드 형식

```markdown
---
title: 노드 제목
source_url: https://...
ingested: YYYY-MM-DD
sha256: ...
---

본문 내용
```

## API

- `GET /api/knowledge/nodes` — 노드 목록
- `GET /api/knowledge/search?q=키워드` — 텍스트 검색
- `GET /api/knowledge/read?slug=concepts/foo` — 노드 읽기
- `POST /api/knowledge/inject` — 지식 주입 `{title, content, source_url}`
