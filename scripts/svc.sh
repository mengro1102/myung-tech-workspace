#!/bin/bash
# 명테크 서비스 제어 헬퍼 — Windows 배치(START/STOP/RESTART/STATUS.bat)에서 호출.
#
# 사용법: bash scripts/svc.sh {start|stop|restart|status|logs [N]}
#
# ── 이 파일이 필요한 이유 ────────────────────────────────────────────────
# 1) `wsl bash -c "...$var..."` 로 인라인 스크립트를 넘기면 Windows→WSL 인자 전달
#    과정에서 $ 확장이 유실된다. 스크립트 파일로 두면 bash가 직접 읽으므로 정상 동작.
# 2) 이 WSL에는 dbus-user-session 패키지가 없어 /run/user/<uid>/bus 가 생성되지 않고,
#    그 결과 `systemctl --user` 가 "Failed to connect to bus" 로 실패한다. 따라서
#    systemd 경로와 직접 프로세스 제어 경로를 모두 지원한다(자동 선택).
#       → systemd 경로를 쓰려면:  sudo apt install dbus-user-session
#                                sudo loginctl enable-linger $USER
# ──────────────────────────────────────────────────────────────────────

# WSL은 XDG_RUNTIME_DIR에 후행 슬래시를 붙여 넘기는데, 그러면 systemd가 세션 버스를
# 못 찾는다. 슬래시를 제거해 재설정.
export XDG_RUNTIME_DIR="/run/user/$(id -u)"

WORKSPACE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LOG_DIR="$WORKSPACE_DIR/logs"
SERVICES="myungtech-server myungtech-dispatcher"

# 프로세스 식별 패턴 (systemd 미사용 시) — 대괄호로 pgrep 자기 자신 매칭 방지
PAT_SERVER='[s]erver\.py'
PAT_DISPATCH='run\.py [d]ispatch daemon'

# systemd user 버스를 실제로 쓸 수 있는지
have_systemd() {
    [ -S "$XDG_RUNTIME_DIR/bus" ] && systemctl --user show-environment >/dev/null 2>&1
}

state_of() {  # $1=패턴 → active/inactive
    pgrep -f "$1" >/dev/null 2>&1 && echo active || echo inactive
}

print_state() {
    if have_systemd; then
        for s in $SERVICES; do
            printf '        %-22s : %s\n' "$s" "$(systemctl --user is-active "$s" 2>&1)"
        done
    else
        printf '        %-22s : %s\n' "myungtech-server"     "$(state_of "$PAT_SERVER")"
        printf '        %-22s : %s\n' "myungtech-dispatcher" "$(state_of "$PAT_DISPATCH")"
        echo   "        (systemd 미사용 - 직접 프로세스 모드)"
    fi
}

# 중복 기동 방지: 이미 떠 있으면 건너뛰고, 없을 때만 띄운다.
# 주의) `pgrep ... || setsid ... &` 형태로 쓰면 `A || B` 전체가 백그라운드로 가서
#       검사 자체가 비동기가 되고 두 프로세스가 경쟁 기동된다. if 문으로 분리할 것.
launch_once() {  # $1=패턴  $2=스크립트  $3=로그파일
    if pgrep -f "$1" >/dev/null 2>&1; then
        return 0
    fi
    setsid nohup bash "$WORKSPACE_DIR/scripts/$2" > "$LOG_DIR/$3" 2>&1 < /dev/null &
    # 기동이 pgrep에 잡힐 때까지 잠깐 대기 — 뒤따르는 호출과의 경쟁 방지
    for _ in 1 2 3 4 5 6 7 8 9 10; do
        pgrep -f "$1" >/dev/null 2>&1 && break
        sleep 0.3
    done
}

# 같은 패턴의 프로세스가 2개 이상이면 가장 오래된 것만 남기고 정리
prune_duplicates() {  # $1=패턴
    pids=$(pgrep -f "$1" 2>/dev/null)
    [ -z "$pids" ] && return 0
    count=$(echo "$pids" | wc -l)
    [ "$count" -le 1 ] && return 0
    keep=$(echo "$pids" | head -1)
    for p in $pids; do
        [ "$p" != "$keep" ] && kill "$p" 2>/dev/null
    done
}

# 포트가 실제로 해제될 때까지 대기. 프로세스가 사라져도 소켓 해제가 한 박자 늦어
# "Address already in use"로 재기동이 실패하는 것을 막는다.
wait_port_free() {  # $1=포트  최대 ~5초
    for _ in $(seq 1 20); do
        ss -ltn 2>/dev/null | grep -q ":$1 " || return 0
        sleep 0.25
    done
    return 1
}

api_up() { curl -sf --max-time 3 "http://localhost:9000/api/health" >/dev/null 2>&1; }

do_start() {
    if have_systemd; then
        systemctl --user start $SERVICES
        return
    fi
    mkdir -p "$LOG_DIR"

    wait_port_free 9000 || echo "        [경고] 포트 9000이 아직 사용 중입니다."

    launch_once "$PAT_SERVER"   start_server.sh     server.log
    launch_once "$PAT_DISPATCH" start_dispatcher.sh dispatcher.log
    prune_duplicates "$PAT_SERVER"
    prune_duplicates "$PAT_DISPATCH"

    # server.py는 Ollama 감지에 최대 ~9초. 그 안에 API가 뜨는지 확인하고,
    # 바인드 실패 등으로 죽었으면 한 번 재시도한다.
    for _ in $(seq 1 24); do
        api_up && return 0
        sleep 0.5
    done

    if ! pgrep -f "$PAT_SERVER" >/dev/null 2>&1; then
        echo "        [알림] 서버 기동 실패 - 포트 해제 후 재시도합니다."
        wait_port_free 9000
        launch_once "$PAT_SERVER" start_server.sh server.log
        for _ in $(seq 1 24); do
            api_up && return 0
            sleep 0.5
        done
    fi
}

do_stop() {
    if have_systemd; then
        systemctl --user stop $SERVICES
        return
    fi
    pkill -f "$PAT_SERVER"   2>/dev/null
    pkill -f "$PAT_DISPATCH" 2>/dev/null
    # 실제로 종료될 때까지 대기 (최대 ~5초) — 포트가 늦게 풀려 재기동이 실패하는 것 방지
    for _ in $(seq 1 10); do
        pgrep -f "$PAT_SERVER" >/dev/null 2>&1 || pgrep -f "$PAT_DISPATCH" >/dev/null 2>&1 || break
        sleep 0.5
    done
    pkill -9 -f "$PAT_SERVER"   2>/dev/null
    pkill -9 -f "$PAT_DISPATCH" 2>/dev/null
    wait_port_free 9000
}

case "${1:-status}" in
    start)
        do_start          # API가 응답할 때까지 내부에서 대기
        print_state
        ;;
    stop)
        do_stop
        print_state
        ;;
    restart)
        do_stop
        do_start
        print_state
        ;;
    status)
        print_state
        ;;
    logs)
        n="${2:-5}"
        if have_systemd; then
            journalctl --user -u myungtech-server -n "$n" --no-pager -o cat 2>/dev/null \
                || echo "        (로그 없음)"
        elif [ -f "$LOG_DIR/server.log" ]; then
            tail -n "$n" "$LOG_DIR/server.log"
        else
            echo "        (로그 없음)"
        fi
        ;;
    *)
        echo "사용법: bash scripts/svc.sh {start|stop|restart|status|logs [N]}" >&2
        exit 2
        ;;
esac
