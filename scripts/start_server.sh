#!/bin/bash
# 명테크 API 서버 기동 래퍼 — Ollama 호스트 자동 감지 후 server.py 실행
# systemd 유닛(myungtech-server.service)에서 호출

WORKSPACE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$WORKSPACE_DIR"

# .env 로드 (있으면) — CRLF 제거 후 로드
[ -f "$WORKSPACE_DIR/.env" ] && set -a && source <(tr -d '\r' < "$WORKSPACE_DIR/.env") && set +a

# Ollama 자동 감지: 환경변수 → localhost → WSL gateway IP
if [ -z "$OLLAMA_HOST" ] || ! curl -sf --max-time 2 "$OLLAMA_HOST/api/tags" &>/dev/null; then
    if curl -sf --max-time 2 "http://localhost:11434/api/tags" &>/dev/null; then
        export OLLAMA_HOST="http://localhost:11434"
    else
        WIN_IP=$(grep nameserver /etc/resolv.conf | awk '{print $2}' | head -1)
        if [ -n "$WIN_IP" ] && curl -sf --max-time 2 "http://${WIN_IP}:11434/api/tags" &>/dev/null; then
            export OLLAMA_HOST="http://${WIN_IP}:11434"
        fi
    fi
fi
export OLLAMA_BASE_URL="$OLLAMA_HOST"
echo "[start_server] OLLAMA_HOST=$OLLAMA_HOST"

exec python3 -u "$WORKSPACE_DIR/server.py"
