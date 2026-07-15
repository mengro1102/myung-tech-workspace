#!/usr/bin/env bash
# 명테크 systemd 서비스 설치 스크립트 (WSL user 서비스)
# 실행: bash scripts/install_services.sh
set -euo pipefail

USER_NAME="$(whoami)"
WORKSPACE="$(cd "$(dirname "$0")/.." && pwd)"
SYSTEMD_DIR="$HOME/.config/systemd/user"
SERVICE_SRC="$WORKSPACE/scripts/systemd"

mkdir -p "$SYSTEMD_DIR"
chmod +x "$WORKSPACE/scripts/start_server.sh" "$WORKSPACE/scripts/start_dispatcher.sh" 2>/dev/null || true

for svc in myungtech-server myungtech-dispatcher; do
    cp "$SERVICE_SRC/${svc}.service" "$SYSTEMD_DIR/${svc}.service"
    echo "설치: $SYSTEMD_DIR/${svc}.service"
done

systemctl --user daemon-reload
systemctl --user enable myungtech-server myungtech-dispatcher

echo ""
echo "=== 설치 완료 ==="
echo "시작:  systemctl --user start myungtech-server myungtech-dispatcher"
echo "상태:  systemctl --user status myungtech-server"
echo "로그:  journalctl --user -u myungtech-server -f"
echo ""
echo "WSL 부팅 시 로그인 없이 자동 실행 (1회만):"
echo "  sudo loginctl enable-linger $USER_NAME"
