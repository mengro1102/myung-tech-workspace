#!/usr/bin/env bash
set -e
WS="$HOME/myung-tech-workspace"
WIN="/mnt/d/myung-tech-workspace"

mkdir -p "$WS/departments/orchestration_dept/agents"
mkdir -p "$WS/departments/dev_dept/agents"

cp "$WIN/departments/orchestration_dept/department_manifest.json" "$WS/departments/orchestration_dept/"
cp "$WIN/departments/orchestration_dept/agents/Master_agent.json" "$WS/departments/orchestration_dept/agents/"
cp "$WIN/departments/dev_dept/department_manifest.json" "$WS/departments/dev_dept/"
cp "$WIN/departments/dev_dept/agents/"*.json "$WS/departments/dev_dept/agents/"
cp "$WIN/departments/research_dept/agents/Crawler_agent.json" "$WS/departments/research_dept/agents/"
cp "$WIN/departments/content_dept/agents/Designer_agent.json" "$WS/departments/content_dept/agents/"
cp "$WIN/departments/research_dept/department_manifest.json" "$WS/departments/research_dept/"
cp "$WIN/departments/finance_dept/department_manifest.json" "$WS/departments/finance_dept/"
cp "$WIN/departments/content_dept/department_manifest.json" "$WS/departments/content_dept/"
cp "$WIN/orchestrator/graphs/nodes.py" "$WS/orchestrator/graphs/nodes.py"
cp "$WIN/scripts/start_vllm.sh" "$WS/scripts/start_vllm.sh"
chmod +x "$WS/scripts/start_vllm.sh"

echo "=== 동기화 완료 ==="
ls "$WS/departments/"
echo "에이전트 JSON 수: $(find "$WS/departments" -name '*.json' -path '*/agents/*' | wc -l)"
find "$WS/departments" -name '*.json' -path '*/agents/*' | sort
