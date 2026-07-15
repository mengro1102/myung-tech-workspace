#!/bin/bash
# 명테크 Agent Dispatcher 기동 래퍼 — Ollama 호스트 자동 감지 후 dispatch daemon 실행
# systemd 유닛(myungtech-dispatcher.service)에서 호출

WORKSPACE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$WORKSPACE_DIR"

[ -f "$WORKSPACE_DIR/.env" ] && set -a && source <(tr -d '\r' < "$WORKSPACE_DIR/.env") && set +a

if [ -z "$OLLAMA_BASE_URL" ] || ! curl -sf --max-time 2 "$OLLAMA_BASE_URL/api/tags" &>/dev/null; then
    if curl -sf --max-time 2 "http://localhost:11434/api/tags" &>/dev/null; then
        export OLLAMA_BASE_URL="http://localhost:11434"
    else
        WIN_IP=$(grep nameserver /etc/resolv.conf | awk '{print $2}' | head -1)
        if [ -n "$WIN_IP" ] && curl -sf --max-time 2 "http://${WIN_IP}:11434/api/tags" &>/dev/null; then
            export OLLAMA_BASE_URL="http://${WIN_IP}:11434"
        fi
    fi
fi
export OLLAMA_HOST="$OLLAMA_BASE_URL"
echo "[start_dispatcher] OLLAMA_BASE_URL=$OLLAMA_BASE_URL"

exec python3 -u "$WORKSPACE_DIR/run.py" dispatch daemon
