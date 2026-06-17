#!/usr/bin/env bash
# 명테크 systemd 서비스 설치 스크립트
# 실행: bash scripts/install_services.sh
set -euo pipefail

USER_NAME="$(whoami)"
WORKSPACE="$HOME/myung-tech-workspace"
SYSTEMD_DIR="$HOME/.config/systemd/user"
SERVICE_SRC="$WORKSPACE/scripts/systemd"

mkdir -p "$SYSTEMD_DIR"
chmod +x "$WORKSPACE/scripts/start_vllm.sh"
chmod +x "$WORKSPACE/scripts/start_orchestrator.sh"

# %i → 실제 유저명으로 치환하여 설치
for svc in myungtech-vllm myungtech-orchestrator myungtech-bridge-daemon; do
    sed "s|%i|$USER_NAME|g" "$SERVICE_SRC/${svc}.service" > "$SYSTEMD_DIR/${svc}.service"
    echo "설치: $SYSTEMD_DIR/${svc}.service"
done

systemctl --user daemon-reload

# 부팅 시 자동 시작 (로그인 없이도 실행)
systemctl --user enable myungtech-orchestrator
systemctl --user enable myungtech-bridge-daemon
# vLLM은 GPU 상황에 따라 수동 관리
# systemctl --user enable myungtech-vllm

echo ""
echo "=== 설치 완료 ==="
echo "시작:  systemctl --user start myungtech-orchestrator"
echo "       systemctl --user start myungtech-bridge-daemon"
echo "       systemctl --user start myungtech-vllm"
echo "상태:  systemctl --user status myungtech-orchestrator"
echo "로그:  journalctl --user -u myungtech-orchestrator -f"
echo ""
echo "24/7 가동을 위해 로그인 없이도 실행되도록 linger 활성화:"
echo "  sudo loginctl enable-linger $USER_NAME"
