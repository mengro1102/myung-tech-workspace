import { useEffect, useState } from 'react';

interface Task {
  task_id: string;
  sender: string;
  target_dept: string;
  instruction: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed';
  result: string | null;
  created_at: string;
  updated_at: string;
  priority?: number;
}
interface TaskEvent {
  event_id: string;
  sender: string;
  target: string;
  payload: string;
  timestamp: string;
  task_id?: string;
}

const DEPT_META: Record<string, { icon: string; label: string; color: string }> = {
  orchestration_dept: { icon: '🧠', label: 'CEO실',      color: '#0ffd6a' },
  research_dept:      { icon: '🔬', label: '학술연구팀', color: '#60a5fa' },
  finance_dept:       { icon: '📈', label: '금융투자팀', color: '#f59e0b' },
  dev_dept:           { icon: '⚙️', label: '개발팀',     color: '#a78bfa' },
  content_dept:       { icon: '✍️', label: '콘텐츠팀',  color: '#f472b6' },
  studio_ui:          { icon: '👤', label: '사장님',     color: '#94a3b8' },
  cycle_runner:       { icon: '🔄', label: '오케스트레이터', color: '#0ffd6a' },
};

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  pending:     { label: '대기 중',  color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  in_progress: { label: '처리 중', color: '#60a5fa', bg: 'rgba(96,165,250,0.1)' },
  done:        { label: '완료',    color: '#0ffd6a', bg: 'rgba(15,253,106,0.1)' },
  failed:      { label: '실패',    color: '#ef4444', bg: 'rgba(239,68,68,0.1)'  },
};

function deptOf(id: string) {
  return DEPT_META[id] ?? { icon: '🤖', label: id, color: '#64748b' };
}

function fmtTime(iso: string) {
  try {
    return new Date(iso).toLocaleString('ko-KR', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
}

export default function TaskDrawer({
  taskId,
  onClose,
}: {
  taskId: string | null;
  onClose: () => void;
}) {
  const [task,   setTask]   = useState<Task | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!taskId) { setTask(null); setEvents([]); return; }
    setLoading(true);
    fetch(`/api/tasks/${taskId}`)
      .then(r => r.json())
      .then(d => { setTask(d.task ?? null); setEvents(d.events ?? []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [taskId]);

  if (!taskId) return null;

  const sm = task ? STATUS_META[task.status] ?? STATUS_META.pending : null;

  return (
    <>
      <div className="td-backdrop" onClick={onClose} />
      <div className="td-drawer">
        <div className="td-header">
          <div className="td-header-title">태스크 상세</div>
          <button className="td-close" onClick={onClose}>✕</button>
        </div>

        {loading && <div className="td-loading">불러오는 중…</div>}

        {!loading && task && (
          <>
            {/* 태스크 ID + 상태 */}
            <div className="td-id-row">
              <span className="td-id">{task.task_id}</span>
              {sm && (
                <span className="td-status" style={{ color: sm.color, background: sm.bg }}>
                  {sm.label}
                </span>
              )}
            </div>

            {/* 지시 내용 */}
            <div className="td-section-label">📋 지시 내용</div>
            <div className="td-instruction">{task.instruction}</div>

            {/* 메타 */}
            <div className="td-meta-grid">
              <div className="td-meta-item">
                <span className="td-meta-key">발신</span>
                <span className="td-meta-val" style={{ color: deptOf(task.sender).color }}>
                  {deptOf(task.sender).icon} {deptOf(task.sender).label}
                </span>
              </div>
              <div className="td-meta-item">
                <span className="td-meta-key">수신 부서</span>
                <span className="td-meta-val" style={{ color: deptOf(task.target_dept).color }}>
                  {deptOf(task.target_dept).icon} {deptOf(task.target_dept).label}
                </span>
              </div>
              <div className="td-meta-item">
                <span className="td-meta-key">생성</span>
                <span className="td-meta-val">{fmtTime(task.created_at)}</span>
              </div>
              <div className="td-meta-item">
                <span className="td-meta-key">갱신</span>
                <span className="td-meta-val">{fmtTime(task.updated_at)}</span>
              </div>
            </div>

            {/* 에이전트 타임라인 */}
            {events.length > 0 && (
              <>
                <div className="td-section-label">🔗 에이전트 인터랙션 ({events.length})</div>
                <div className="td-timeline">
                  {events.map(ev => {
                    const from = deptOf(ev.sender);
                    const to   = deptOf(ev.target);
                    const txt  = ev.payload.replace(/\[task-[^\]]+\]\s*/g, '').slice(0, 120);
                    return (
                      <div key={ev.event_id} className="td-timeline-item">
                        <div className="td-tl-who">
                          <span style={{ color: from.color }}>{from.icon} {from.label}</span>
                          <span className="td-tl-arrow">→</span>
                          <span style={{ color: to.color }}>{to.icon} {to.label}</span>
                          <span className="td-tl-time">{fmtTime(ev.timestamp)}</span>
                        </div>
                        <div className="td-tl-text">{txt}</div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {/* 결과물 */}
            {task.result && (
              <>
                <div className="td-section-label">✅ 결과물</div>
                <div className="td-result">{task.result}</div>
              </>
            )}

            {/* 연관 이벤트 없을 때 */}
            {events.length === 0 && (
              <div className="td-empty-events">
                연관 이벤트가 없습니다 — 에이전트 이벤트에 task_id가 연결되면 여기에 표시됩니다.
              </div>
            )}
          </>
        )}

        {!loading && !task && (
          <div className="td-loading">태스크를 찾을 수 없습니다.</div>
        )}
      </div>
    </>
  );
}
