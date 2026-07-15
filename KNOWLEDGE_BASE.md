# 지식베이스 연동 — Myung-Tech ↔ GraphRAG

명테크 멀티에이전트 프레임워크의 **공유 지식베이스**는 별도 저장소
**`mrlee-wiki-graphrag`** (Obsidian 볼트 + GraphRAG 자료원)이며,
명테크는 이를 **복사하지 않고 경로로 참조**한다.

## 위치
| 항목 | 경로 |
|---|---|
| 명테크 프레임워크 | `D:\myung-tech-workspace` (현위치 유지) |
| GraphRAG 지식베이스 | `D:\AI_Workspace\mrlee-wiki-graphrag` (자체 GitHub repo로 동기화) |

> 두 저장소는 독립적이다. 지식베이스 변경은 `mrlee-wiki-graphrag`에서 관리하고
> GitHub로 PC2/모바일과 동기화된다. 명테크는 읽기 참조만 한다.

## 설정
- 경로는 환경변수 **`GRAPHRAG_KB_PATH`** 로 재정의 가능(미설정 시 위 기본 경로).
  프레임워크의 기존 `os.environ.get(...)` 설정 관례를 따른다.

## 사용 (각 부서 에이전트)
```python
from knowledge_base import KB_PATH, available, list_nodes, read_node, search

if available():
    nodes = list_nodes("concepts")        # ['concepts/attention', ...]
    text  = read_node("concepts/transformer")
    hits  = search("attention")           # [(relpath, line), ...]
```

빠른 점검:
```
python knowledge_base.py
```

## 그래프 구조 (참조 시 알아둘 것)
- 노드: `concepts/`(개념) · `entities/`(인물·논문) · `comparisons/`(비교)
- 엣지: 본문 내 `[[wikilink]]` + frontmatter `sources` provenance
- 규약: `SCHEMA.md`(frontmatter·태그·정책), 카탈로그: `index.md`, 작업로그: `log.md`

## 향후 확장(선택)
- 부서 매니페스트(`departments/*/department_manifest.json`)에 KB 사용 권한/스킬 명시
- 어휘 검색 → **시맨틱/벡터 검색**(RTX 3090 로컬 임베딩) 업그레이드
  (참조: `mrlee-wiki-graphrag/reports/2026-06-25-structure-optimization-review.md` P3)
- 헤르메스 에이전트 기반으로 프레임워크 통합 시, 이미 연동된 Hermes Obsidian MCP(27123) 재사용 가능
