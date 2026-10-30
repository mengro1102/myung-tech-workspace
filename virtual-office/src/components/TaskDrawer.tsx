import { useEffect, useState } from 'react';
import { deptLabels } from '../api';

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

/* 아이콘·색만 들고, **이름은 `deptLabels`(정본)를 읽는다.**
   전에는 여기도 자기 이름표를 갖고 있어서 같은 부서가 'CEO실'·'학술연구팀'
   으로 나왔다 — 정본(학술연구부)과도, 사무실 칩과도 달랐다.
   studio_ui·cycle_runner 는 부서가 아니라 여기서만 쓰는 발신자라 남긴다. */
const DEPT_META: Record<string, { icon: string; label?: string; color: string }> = {
  orchestration_dept: { icon: '🧠', color: '#0ffd6a' },
  research_dept:      { icon: '🔬', color: '#60a5fa' },
  finance_dept:       { icon: '📈', color: '#f59e0b' },
  dev_dept:           { icon: '⚙️', color: '#a78bfa' },
  content_dept:       { icon: '✍️', color: '#f472b6' },
  studio_ui:          { icon: '👤', label: '사장님',        color: '#94a3b8' },
  cycle_runner:       { icon: '🔄', label: '오케스트레이터', color: '#0ffd6a' },
};

const STATUS_META: Record<string, { label: string; color: string; bg: string }> = {
  pending:     { label: '대기 중',  color: '#f59e0b', bg: 'rgba(245,158,11,0.1)' },
  in_progress: { label: '처리 중', color: '#60a5fa', bg: 'rgba(96,165,250,0.1)' },
  done:        { label: '완료',    color: '#0ffd6a', bg: 'rgba(15,253,106,0.1)' },
  failed:      { label: '실패',    color: '#ef4444', bg: 'rgba(239,68,68,0.1)'  },
};

function deptOf(id: string) {
  const m = DEPT_META[id];
  // 이름은 정본 우선. DEPT_META 의 label 은 부서가 아닌 발신자
  // (사장님·오케스트레이터)에만 남아 있다.
  if (m) return { ...m, label: m.label ?? deptLabels[id] ?? id };
  return { icon: '🤖', label: deptLabels[id] ?? id, color: '#64748b' };
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
  onOverride,
}: {
  taskId: string | null;
  onClose: () => void;
  /** 진행 중인 태스크에 사장님이 명령을 끼워 넣는다(CEO 개입).
   *
   *  `CeoOverrideModal` 은 다 만들어져 있었는데 **여는 길이 없었다** —
   *  `setOverrideTask` 를 태스크로 호출하는 코드가 한 줄도 없어서 화면에서
   *  절대 열리지 않는 죽은 기능이었다. 이 서랍이 그 자리다. 여기는 버튼이
   *  ✕ 하나뿐이라, 태스크를 보다가 방향이 틀린 걸 알아도 할 수 있는 게
   *  없었다. */
  onOverride?: (task: Task) => void;
}) {
  const [task,   setTask]   = useState<Task | null>(null);
  const [trashing, setTrashing] = useState(false);
  const [trashErr, setTrashErr] = useState('');
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

  /** 휴지통으로. 바로 지우지 않는 이유는 파일 위 주석에. */
  const toTrash = async () => {
    if (!task || trashing) return;
    setTrashing(true);
    setTrashErr('');
    try {
      const r = await fetch('/api/trash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ kind: 'agent_task', id: task.task_id }] }),
      }).then(x => x.json());
      if (r?.moved?.length || r?.ok) {
        onClose();
        window.dispatchEvent(new CustomEvent('trash:changed'));
      } else {
        setTrashErr(r?.error ?? '옮기지 못했습니다');
      }
    } catch (e: any) {
      setTrashErr(e?.message ?? '서버에 닿지 못했습니다');
    } finally {
      setTrashing(false);
    }
  };

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

            {/* 개입 — **진행 중일 때만** 보여 준다. 끝난 태스크에 명령을
                끼워 넣는 것은 의미가 없고, 눌러 놓고 아무 일도 안 일어나는
                버튼을 또 만들게 된다. */}
            {onOverride && (task.status === 'in_progress' || task.status === 'pending') && (
              <button className="td-override" onClick={() => onOverride(task)}>
                👔 개입하기 — 이 태스크에 지시를 끼워 넣습니다
              </button>
            )}

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

            {/* 치우기 — 끝난 것만.

                돌고 있는 태스크를 지우면 부서는 계속 일하는데 기록만
                사라진다. 그래서 완료·실패만 받는다. 바로 지우지 않고
                휴지통으로 보낸다 — 되돌릴 수 있고, 맹비서가 디스코드로
                알려 사장님이 본인이 한 일인지 보실 수 있다. */}
            {(task.status === 'done' || task.status === 'failed') && (
              <div className="td-trash-row">
                <button className="td-trash-btn" onClick={toTrash} disabled={trashing}>
                  {trashing ? '옮기는 중…' : '🗑 휴지통으로'}
                </button>
                <span className="td-trash-hint">
                  되돌릴 수 있습니다. 디스코드로 알림이 갑니다.
                </span>
                {trashErr && <span className="td-trash-err">{trashErr}</span>}
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
