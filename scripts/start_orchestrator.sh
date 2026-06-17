#!/usr/bin/env bash
# FastAPI 오케스트레이터 기동 스크립트
set -euo pipefail

WORKSPACE="$HOME/myung-tech-workspace"
VENV="$WORKSPACE/orchestrator/venv/bin/python"
PORT="${ORCHESTRATOR_PORT:-9000}"

cd "$WORKSPACE"
exec "$VENV" -m uvicorn orchestrator.main:app \
    --host 0.0.0.0 \
    --port "$PORT" \
    --workers 1 \
    --log-level info
