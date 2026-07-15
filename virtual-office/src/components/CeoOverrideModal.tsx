import { useState, useEffect, useRef } from 'react';

interface TaskItem {
  id: string;
  title: string;
  dept?: string;
  status?: string;
}

interface Props {
  task: TaskItem;
  onClose: () => void;
  onInject: (taskId: string, command: string) => Promise<void> | void;
}

interface FeedEvent {
  event_id: string; sender: string; target: string;
  payload: string; timestamp?: string;
}

function fmtTime(ts?: string) {
  if (!ts) return new Date().toLocaleTimeString('ko-KR', { hour12: false });
  return new Date(ts).toLocaleTimeString('ko-KR', { hour12: false });
}

function cleanPayload(raw: string): string {
  let s = raw.trim().replace(/^\[task-[^\]]+\]\s*/g, '');
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      if (obj.type) return `[${obj.type}] ${obj.analysis?.slice(0, 60) ?? ''}`;
    } catch { /* */ }
  }
  return s.replace(/#{1,4}\s+/g, '').replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '')
    .split('\n').find(l => l.trim().length > 2)?.trim().slice(0, 120) ?? s.slice(0, 120);
}

export default function CeoOverrideModal({ task, onClose, onInject }: Props) {
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [cmd,  setCmd]  = useState('');
  const [sending, setSending] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => fetch('/api/events').then(r => r.json())
      .then(d => setFeed((d.events ?? []).slice(-40).reverse())).catch(() => {});
    load();
    const t = setInterval(load, 2000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [feed]);

  const handleInject = async () => {
    if (!cmd.trim() || sending) return;
    setSending(true);
    try { await onInject(task.id, cmd.trim()); }
    finally { setSending(false); onClose(); }
  };

  const handleRetry = async () => {
    setSending(true);
    try { await onInject(task.id, `RETRY: ${task.title}`); }
    finally { setSending(false); onClose(); }
  };

  return (
    <div className="ceo-modal-bg" onClick={onClose}>
      <div className="ceo-modal" onClick={e => e.stopPropagation()}>

        {/* ── 헤더 ── */}
        <div className="ceo-modal-header">
          <div className="ceo-modal-title-row">
            <span className="ceo-modal-icon">⚠</span>
            <div>
              <h3 className="ceo-modal-title">CEO 개입 오버라이드</h3>
              <p className="ceo-modal-subtitle">
                태스크 <span className="ceo-modal-id">#{task.id.slice(-8)}</span> — {task.title}
              </p>
            </div>
          </div>
          <button className="ceo-modal-close" onClick={onClose}>✕</button>
        </div>

        {/* ── 본문: 왼쪽 로그 | 오른쪽 명령 입력 ── */}
        <div className="ceo-modal-body">

          {/* 왼쪽: 읽기 전용 스트림 */}
          <div className="ceo-modal-stream">
            <div className="ceo-stream-header">
              <span className="ceo-stream-title">읽기 전용 스트림</span>
              <span className="ceo-stream-status">
                <span className="ceo-stream-dot" />
                실시간
              </span>
            </div>
            <div className="ceo-stream-log" ref={logRef}>
              {feed.length === 0 && (
                <div className="ceo-stream-empty">에이전트 활동 대기 중...</div>
              )}
              {feed.map((e, i) => (
                <div key={e.event_id ?? i} className="ceo-stream-row">
                  <span className="ceo-stream-time">[{fmtTime(e.timestamp)}]</span>
                  <span className="ceo-stream-sender">{e.sender}</span>
                  <span className="ceo-stream-arrow">→</span>
                  <span className="ceo-stream-msg">{cleanPayload(e.payload)}</span>
                </div>
              ))}
            </div>
          </div>

          {/* 오른쪽: 명령 주입 인터페이스 */}
          <div className="ceo-modal-cmd">
            <div className="ceo-cmd-header">
              <span className="ceo-cmd-title">명령 주입 인터페이스</span>
              <span className="ceo-cmd-badge">CEO OVERRIDE</span>
            </div>

            <div className="ceo-cmd-info">
              <div className="ceo-cmd-info-row">
                <span className="ceo-cmd-info-label">태스크 ID</span>
                <span className="ceo-cmd-info-val" style={{ fontFamily: 'JetBrains Mono, monospace' }}>
                  {task.id.slice(-16)}
                </span>
              </div>
              <div className="ceo-cmd-info-row">
                <span className="ceo-cmd-info-label">상태</span>
                <span className="ceo-cmd-info-val" style={{ color: '#f59e0b' }}>{task.status ?? 'pending'}</span>
              </div>
              <div className="ceo-cmd-info-row">
                <span className="ceo-cmd-info-label">부서</span>
                <span className="ceo-cmd-info-val">{task.dept ?? '—'}</span>
              </div>
            </div>

            <div className="ceo-cmd-label">CEO 명령 입력:</div>
            <textarea
              className="ceo-cmd-textarea"
              value={cmd}
              onChange={e => setCmd(e.target.value)}
              placeholder="오버라이드 명령을 입력하세요&#10;예: 이 태스크를 즉시 중단하고 연구팀 방향으로 재배분&#10;&#10;명령은 오케스트레이터를 통해 해당 에이전트에게 직접 전달됩니다."
              rows={8}
            />
            <div className="ceo-cmd-hint">
              Shift+Enter 줄바꿈 · Enter 주입
            </div>
          </div>
        </div>

        {/* ── 하단 액션 ── */}
        <div className="ceo-modal-footer">
          <div className="ceo-footer-left">
            <button className="ceo-btn-secondary" onClick={handleRetry} disabled={sending}>
              🔄 노드 재시도
            </button>
            <button className="ceo-btn-danger" disabled={sending}
              onClick={async () => { await onInject(task.id, 'BYPASS: 안전 우회 명령 실행'); onClose(); }}>
              ⚡ 안전 우회
            </button>
          </div>
          <div className="ceo-footer-right">
            <button className="ceo-btn-ghost" onClick={onClose}>취소</button>
            <button className="ceo-btn-primary" onClick={handleInject} disabled={!cmd.trim() || sending}>
              {sending ? '주입 중...' : '주입 및 재개 ▶'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
