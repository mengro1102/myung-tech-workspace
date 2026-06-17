#!/usr/bin/env bash
# vLLM 기동 스크립트 — WSL2/WDDM 환경의 동적 VRAM 감지 및 안전 기동
set -euo pipefail

WORKSPACE="$HOME/myung-tech-workspace"
VENV="$WORKSPACE/orchestrator/venv"
PYTHON="$VENV/bin/python"
# venv bin을 PATH에 추가 (flashinfer가 ninja를 subprocess로 호출)
export PATH="$VENV/bin:$PATH"
# HuggingFace 오프라인 모드 — 모델이 로컬 캐시에 있으면 네트워크 불필요
export HF_HUB_OFFLINE=1
export TRANSFORMERS_OFFLINE=1
export HF_DATASETS_OFFLINE=1
source "$WORKSPACE/.env" 2>/dev/null || true

PORT="${VLLM_PORT:-8081}"
SWAP_GB="${VLLM_SWAP_SPACE_GB:-4}"

# ── 1. 실시간 VRAM 상태 측정 ──────────────────────────────────────
TOTAL_MB=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')
FREE_MB=$(nvidia-smi --query-gpu=memory.free  --format=csv,noheader,nounits 2>/dev/null | head -1 | tr -d ' ')
USED_MB=$((TOTAL_MB - FREE_MB))

echo "======================================================"
echo " VRAM 상태 (기동 전)"
echo " 전체: ${TOTAL_MB} MiB | 사용: ${USED_MB} MiB | 여유: ${FREE_MB} MiB"
echo "======================================================"

# ── 2. 안전 할당 한도 계산 (여유 VRAM의 85%) ──────────────────────
SAFE_MB=$(echo "$FREE_MB * 85 / 100" | bc)

# gpu_memory_utilization = safe_mb / total_mb  (소수점 2자리)
GPU_UTIL=$(echo "scale=2; $SAFE_MB / $TOTAL_MB" | bc)

echo " 안전 할당 목표: ${SAFE_MB} MiB"
echo " gpu_memory_utilization: ${GPU_UTIL}"

# ── 3. 가용 VRAM에 따른 모델 자동 선택 ───────────────────────────
select_model_and_len() {
    local safe=$1
    # 모델 VRAM 요구량 (AWQ 4bit 기준, weights만)
    # Qwen2.5-14B-AWQ: ~9,200 MiB  (KV 최소 1,500 MiB 확보 필요)
    # Qwen2.5-7B-AWQ:  ~4,600 MiB  (KV 최소 1,000 MiB 확보 필요)
    # Qwen2.5-3B-AWQ:  ~2,000 MiB  (폴백)

    if [ "$safe" -ge 11000 ]; then
        echo "Qwen/Qwen2.5-14B-Instruct-AWQ 4096"
    elif [ "$safe" -ge 6000 ]; then
        echo "Qwen/Qwen2.5-7B-Instruct-AWQ 4096"
    elif [ "$safe" -ge 3500 ]; then
        echo "Qwen/Qwen2.5-3B-Instruct-AWQ 2048"
    else
        echo "ERROR"
    fi
}

SELECTION=$(select_model_and_len "$SAFE_MB")
if [ "$SELECTION" = "ERROR" ]; then
    echo "❌ 여유 VRAM(${SAFE_MB} MiB)이 너무 부족합니다."
    echo "   브라우저·NVIDIA Overlay 종료 후 재시도하세요."
    exit 1
fi

MODEL=$(echo "$SELECTION" | cut -d' ' -f1)
MAX_LEN=$(echo "$SELECTION" | cut -d' ' -f2)

# .env에 명시된 모델이 있으면 우선 (단, SAFE 검사는 통과해야 함)
if [ -n "${VLLM_MODEL:-}" ] && [ "${VLLM_MODEL}" != "Qwen/Qwen2.5-14B-Instruct-AWQ" ] 2>/dev/null; then
    MODEL="$VLLM_MODEL"
fi
MAX_LEN="${VLLM_MAX_MODEL_LEN:-$MAX_LEN}"

echo ""
echo "======================================================"
echo " 선택된 모델:  $MODEL"
echo " max_model_len: $MAX_LEN"
echo " gpu_util:      $GPU_UTIL"
echo " 포트:          $PORT"
echo "======================================================"
echo ""

# ── 4. vLLM 기동 ──────────────────────────────────────────────────
exec "$PYTHON" -m vllm.entrypoints.openai.api_server \
    --model "$MODEL" \
    --port "$PORT" \
    --host 0.0.0.0 \
    --gpu-memory-utilization "$GPU_UTIL" \
    --max-model-len "$MAX_LEN" \
    --no-enable-flashinfer-autotune \
    --no-enable-log-requests \
    --enforce-eager
