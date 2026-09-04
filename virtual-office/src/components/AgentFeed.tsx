import { useEffect, useRef, useState } from 'react';
import { deptLabels, deptColors } from '../api';

/* Phase 3 — 운영 루프 시각화: 에이전트간 메시지 실시간 피드.
 * 백엔드 SSE `/api/events/stream`(message_broker) 구독.
 * cycle_runner / departments 가 emit 하는 sender→target 메시지를 흐르게 표시. */

interface FeedEvent {
  event_id: string;
  sender: string;
  target: string;
  payload: string;
  timestamp: string;
}

function cleanPayload(raw: string): string {
  let s = raw.trim().replace(/^\[task-[^\]]+\]\s*/g, '');
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      const stripMd = (t: string) => t.replace(/#{1,4}\s+/g,'').replace(/\*\*/g,'').replace(/\*/g,'').replace(/`/g,'').replace(/\n/g,' ').trim();
      if (obj.type === 'cycle_complete') {
        const summary = stripMd(obj.analysis ?? '').split(/\.(?:\s|$)/).map((x: string) => x.trim()).find((x: string) => x.length > 15) ?? '';
        return `사이클 ${obj.cycle ?? ''} 완료 — ${summary.slice(0, 55)}`;
      }
      if (obj.type) return `[${obj.type}]`;
    } catch { /* not JSON */ }
  }
  s = s.replace(/#{1,4}\s+/g,'').replace(/\*\*/g,'').replace(/\*/g,'').replace(/`/g,'');
  const firstLine = s.split('\n').map(l => l.replace(/^(?:\d+[.)]\s*|[-*•]\s*)/, '').trim()).find(l => l.length > 2) ?? s;
  return firstLine.slice(0, 55) + (firstLine.length > 55 ? '…' : '');
}

const ICONS: Record<string, string> = {
  orchestration_dept: '🧠', research_dept: '🔬', finance_dept: '📈',
  dev_dept: '⚙️', content_dept: '✍️', cycle_runner: '🔄', orchestrator: '🧠',
  studio_ui: '🖥️',
};
const SPECIAL: Record<string, string> = { cycle_runner: '오케스트레이터', studio_ui: '스튜디오' };
const labelOf  = (id: string) => deptLabels[id] ?? SPECIAL[id] ?? id;
const iconOf   = (id: string) => ICONS[id] ?? '🤖';
const colorOf  = (id: string) => deptColors[id] ?? '#94a3b8';

/** 이벤트 문구로 종류를 판별한다. 디스패처가 내는 말머리가 고정돼 있어
 *  이 정도 규칙으로 충분하고, 이벤트 스키마를 바꾸지 않아도 된다. */
function kindOf(payload: string): string {
  const p = payload || '';
  if (p.startsWith('실패') || p.includes('오류')) return 'kind-fail';
  if (p.startsWith('완료')) return 'kind-done';
  if (p.startsWith('지식베이스')) return 'kind-kb';
  if (p.startsWith('작업 접수') || p.startsWith('추론 시작')) return 'kind-start';
  return '';
}

export default function AgentFeed({ compact }: { compact?: boolean }) {
  const [events, setEvents]   = useState<FeedEvent[]>([]);
  const [live,   setLive]     = useState(false);
  const [open,   setOpen]     = useState(true);
  const endRef                = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let es: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      try {
        es = new EventSource('/api/events/stream');
        es.onopen = () => setLive(true);
        es.onerror = () => {
          setLive(false);
          es?.close();
          retryTimer = setTimeout(connect, 5000);
        };
        const onEvt = (e: MessageEvent) => {
          try {
            const data = JSON.parse(e.data) as FeedEvent;
            if (!data || !data.sender) return;
            setEvents(prev => [...prev.slice(-80), data]);
          } catch { /* heartbeat 등 무시 */ }
        };
        es.addEventListener('new_event', onEvt as EventListener);
      } catch {
        setLive(false);
        retryTimer = setTimeout(connect, 5000);
      }
    };

    connect();
    return () => {
      es?.close();
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, []);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [events]);

  // compact 모드: 사이드바용 축약 피드
  if (compact) {
    return (
      <div className="af-compact">
        <div className="af-compact-status">
          <span className={`af-dot ${live ? 'live' : ''}`} />
          <span className="af-compact-status-label" style={{ color: live ? '#0ffd6a' : '#64748b' }}>
            {live ? 'LIVE' : '미연결'}
          </span>
          <span className="af-compact-status-count">{events.length}건</span>
        </div>
        <div className="af-compact-list">
          {events.length === 0
            ? <div className="af-compact-empty">{live ? '대기 중…' : '포트 9000 확인'}</div>
            : events.slice(-6).reverse().map((ev, i) => (
              <div key={`${ev.event_id}-${i}`} className="af-compact-row">
                <span className="af-compact-who" style={{ color: colorOf(ev.sender) }}>
                  {iconOf(ev.sender)}
                </span>
                <span className="af-compact-arrow">→</span>
                <span className="af-compact-who" style={{ color: colorOf(ev.target) }}>
                  {iconOf(ev.target)}
                </span>
                <span className="af-compact-text">{cleanPayload(ev.payload)}</span>
              </div>
            ))
          }
        </div>
      </div>
    );
  }

  return (
    <div className="af-panel">
      <div className="af-header" onClick={() => setOpen(o => !o)}>
        <span className={`af-dot ${live ? 'live' : ''}`} />
        <span className="af-title">에이전트 활동 피드</span>
        <span className="af-count">{events.length}</span>
        <span className="af-toggle">{open ? '▾' : '▸'}</span>
      </div>

      {open && (
        <div className="af-body">
          {events.length === 0 ? (
            <div className="af-empty">
              {live ? '대기 중 — "🚀 운영 시작"을 누르면 에이전트 상호작용이 흐릅니다.'
                    : '백엔드(server.py) 미연결 — 포트 9000 확인'}
            </div>
          ) : events.map(ev => (
            // 이벤트 종류를 문구에서 뽑아 색으로 구분한다. 목록을 훑을 때
            // 완료/실패/지식베이스 조회가 한눈에 갈리는 편이 훨씬 빠르다.
            <div key={ev.event_id} className={`af-row ${kindOf(ev.payload)}`}>
              <span className="af-who" style={{ color: colorOf(ev.sender) }}>
                {iconOf(ev.sender)} {labelOf(ev.sender)}
              </span>
              <span className="af-arrow">→</span>
              <span className="af-who" style={{ color: colorOf(ev.target) }}>
                {iconOf(ev.target)} {labelOf(ev.target)}
              </span>
              <span className="af-text">{ev.payload}</span>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}
