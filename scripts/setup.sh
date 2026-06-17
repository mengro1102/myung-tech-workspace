#!/bin/bash
# ══════════════════════════════════════════════════════════════
#  명테크 Agent Studio — WSL Ubuntu 원액션 인프라 셋업
#  사용법: bash setup.sh
# ══════════════════════════════════════════════════════════════

set -e

WORKSPACE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$WORKSPACE_DIR/.env"
LOG_DIR="$WORKSPACE_DIR/logs"
OLLAMA_MODEL="qwen2.5-coder:7b"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }
info() { echo -e "${CYAN}[→]${NC} $1"; }

echo ""
echo "══════════════════════════════════════════════"
echo "   명테크 Agent Studio — 인프라 셋업"
echo "══════════════════════════════════════════════"
echo ""

# ── 1. 환경변수 확인 ─────────────────────────────────────────
info "환경변수 확인 중..."

if [ -f "$ENV_FILE" ]; then
    source "$ENV_FILE"
    log ".env 파일 로드됨"
fi

if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
    echo ""
    warn "TELEGRAM_BOT_TOKEN이 설정되지 않았습니다."
    read -p "  Telegram Bot Token 입력 (건너뛰려면 Enter): " input_token
    if [ -n "$input_token" ]; then
        TELEGRAM_BOT_TOKEN="$input_token"
        echo "TELEGRAM_BOT_TOKEN=\"$input_token\"" >> "$ENV_FILE"
        log "토큰 저장됨 → $ENV_FILE"
    else
        warn "토큰 없이 계속합니다. Telegram 게이트웨이는 비활성화됩니다."
    fi
fi

# ── 2. Python 확인 ────────────────────────────────────────────
info "Python 확인 중..."
if ! command -v python3 &>/dev/null; then
    warn "Python3 없음. 설치 중..."
    sudo apt-get update -qq && sudo apt-get install -y python3 python3-pip
fi
PYTHON_VER=$(python3 --version 2>&1)
log "$PYTHON_VER 확인됨"

# ── 3. Python 패키지 설치 ─────────────────────────────────────
info "Python 패키지 확인 중..."
python3 -c "import telebot" 2>/dev/null || {
    warn "pyTelegramBotAPI 없음. 설치 중..."
    pip3 install pyTelegramBotAPI -q
    log "pyTelegramBotAPI 설치 완료"
}
log "Python 패키지 OK"

# ── 4. Ollama 확인 및 설치 ────────────────────────────────────
info "Ollama 확인 중..."
if ! command -v ollama &>/dev/null; then
    warn "Ollama 없음. 설치 중... (시간이 걸릴 수 있습니다)"
    curl -fsSL https://ollama.com/install.sh | sh
    log "Ollama 설치 완료"
else
    log "Ollama 이미 설치됨"
fi

# ── 5. Ollama 서버 시작 ───────────────────────────────────────
info "Ollama 서버 확인 중..."
if ! curl -s http://localhost:11434/api/tags &>/dev/null; then
    warn "Ollama 서버 미실행. 시작 중..."
    mkdir -p "$LOG_DIR"
    ollama serve > "$LOG_DIR/ollama.log" 2>&1 &
    OLLAMA_PID=$!
    sleep 3
    if curl -s http://localhost:11434/api/tags &>/dev/null; then
        log "Ollama 서버 시작됨 (PID: $OLLAMA_PID)"
    else
        err "Ollama 서버 시작 실패. $LOG_DIR/ollama.log 확인하세요."
    fi
else
    log "Ollama 서버 이미 실행 중"
fi

# ── 6. 모델 확인 및 pull ──────────────────────────────────────
info "모델 확인 중: $OLLAMA_MODEL"
if ollama list 2>/dev/null | grep -q "${OLLAMA_MODEL%:*}"; then
    log "모델 이미 존재함: $OLLAMA_MODEL"
else
    warn "모델 없음. 다운로드 중... (4.7GB, 시간이 걸립니다)"
    ollama pull "$OLLAMA_MODEL"
    log "모델 다운로드 완료: $OLLAMA_MODEL"
fi

# ── 7. 로그 디렉토리 ──────────────────────────────────────────
mkdir -p "$LOG_DIR"

# ── 8. PID 파일 정리 ─────────────────────────────────────────
PID_FILE="$WORKSPACE_DIR/.pids"
> "$PID_FILE"

# ── 9. API 서버 시작 ─────────────────────────────────────────
info "API 서버 시작 중 (포트 9000)..."
python3 "$WORKSPACE_DIR/server.py" > "$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!
echo "server=$SERVER_PID" >> "$PID_FILE"
sleep 1
if kill -0 $SERVER_PID 2>/dev/null; then
    log "API 서버 시작됨 (PID: $SERVER_PID)"
else
    err "API 서버 시작 실패. $LOG_DIR/server.log 확인하세요."
fi

# ── 10. Dispatcher 시작 ───────────────────────────────────────
info "Agent Dispatcher 시작 중..."
cd "$WORKSPACE_DIR"
python3 run.py dispatch daemon > "$LOG_DIR/dispatcher.log" 2>&1 &
DISPATCHER_PID=$!
echo "dispatcher=$DISPATCHER_PID" >> "$PID_FILE"
sleep 1
if kill -0 $DISPATCHER_PID 2>/dev/null; then
    log "Agent Dispatcher 시작됨 (PID: $DISPATCHER_PID)"
else
    err "Dispatcher 시작 실패. $LOG_DIR/dispatcher.log 확인하세요."
fi

# ── 10. Telegram Gateway 시작 ────────────────────────────────
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
    info "Telegram Gateway 시작 중..."
    export TELEGRAM_BOT_TOKEN
    python3 "$WORKSPACE_DIR/telegram_gateway.py" > "$LOG_DIR/telegram.log" 2>&1 &
    TELEGRAM_PID=$!
    echo "telegram=$TELEGRAM_PID" >> "$PID_FILE"
    sleep 2
    if kill -0 $TELEGRAM_PID 2>/dev/null; then
        log "Telegram Gateway 시작됨 (PID: $TELEGRAM_PID)"
    else
        err "Telegram Gateway 시작 실패. $LOG_DIR/telegram.log 확인하세요."
    fi
else
    warn "TELEGRAM_BOT_TOKEN 없음 — Telegram Gateway 건너뜀"
fi

# ── 완료 ─────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════"
echo -e "  ${GREEN}명테크 인프라 셋업 완료!${NC}"
echo "══════════════════════════════════════════════"
echo ""
echo "  로그 위치:  $LOG_DIR/"
echo "  PID 파일:   $PID_FILE"
echo ""
echo "  실시간 로그 확인:"
echo "    tail -f $LOG_DIR/dispatcher.log"
echo "    tail -f $LOG_DIR/telegram.log"
echo ""
echo "  종료하려면:"
echo "    bash $WORKSPACE_DIR/scripts/stop.sh"
echo ""
