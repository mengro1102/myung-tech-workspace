#!/bin/bash
# 명테크 Agent Studio — 전체 프로세스 종료

WORKSPACE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$WORKSPACE_DIR/.pids"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo "명테크 인프라 종료 중..."

if [ ! -f "$PID_FILE" ]; then
    echo "PID 파일 없음. 수동으로 프로세스를 종료해주세요."
    exit 0
fi

while IFS='=' read -r name pid; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        kill "$pid"
        echo -e "${GREEN}[✓]${NC} $name 종료됨 (PID: $pid)"
    else
        echo -e "${RED}[!]${NC} $name 이미 종료됨 (PID: $pid)"
    fi
done < "$PID_FILE"

rm -f "$PID_FILE"
echo ""
echo "모든 프로세스 종료 완료."
echo ""
