import { useEffect, useRef, useState } from 'react';

interface AgentSummary { agent_id: string; department?: string; status?: string; character_name?: string; }
interface TaskSummary  { pending: number; in_progress: number; done: number; failed: number; }
interface RecentTask   { task_id: string; target_dept: string; instruction: string; status: string; result?: string; }

interface Props {
  agents:       AgentSummary[];
  taskSummary:  TaskSummary;
  selectedDept: string;
  onSelectDept: (d: string) => void;
  cycleStatus:  string;
}

const DEPTS = [
  { id: 'research_dept',      icon: '🔬', label: '학술연구',    short: 'Research' },
  { id: 'finance_dept',       icon: '📈', label: '금융투자',    short: 'Finance'  },
  { id: 'orchestration_dept', icon: '🧠', label: '오케스트레이션', short: 'Orch'  },
  { id: 'dev_dept',           icon: '⚙️', label: '개발',        short: 'Dev'      },
  { id: 'content_dept',       icon: '✍️', label: '콘텐츠생산',  short: 'Content'  },
] as const;

// arc layout: research(TL), finance(BL), orch(C), dev(TR), content(BR)
const POSITIONS: Record<string, { cx: string; cy: string }> = {
  research_dept:      { cx: '18%',  cy: '28%' },
  finance_dept:       { cx: '18%',  cy: '72%' },
  orchestration_dept: { cx: '50%',  cy: '50%' },
  dev_dept:           { cx: '82%',  cy: '28%' },
  content_dept:       { cx: '82%',  cy: '72%' },
};

export default function OpsMap({ agents, taskSummary, selectedDept, onSelectDept, cycleStatus }: Props) {
  const [recentTasks, setRecentTasks] = useState<RecentTask[]>([]);
  const [tick, setTick] = useState(0);
  const svgRef = useRef<SVGSVGElement>(null);

  // Fetch recent tasks
  useEffect(() => {
    const load = () =>
      fetch('/api/events').then(r => r.json()).then(d => {
        const evts: RecentTask[] = (d.events ?? []).slice(-6).reverse().map((e: any) => ({
          task_id:     e.event_id ?? '',
          target_dept: e.sender   ?? '',
          instruction: e.payload  ?? '',
          status:      'done',
        }));
        setRecentTasks(evts);
      }).catch(() => {});
    load();
    const t = setInterval(load, 6000);
    return () => clearInterval(t);
  }, []);

  // Pulse animation tick
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1200);
    return () => clearInterval(t);
  }, []);

  const deptAgents = (id: string) => agents.filter(a => a.department === id);
  const deptActive = (id: string) => deptAgents(id).filter(a => a.status !== 'Idle').length;
  const isRunning  = cycleStatus !== 'stopped';

  // Convert percentage positions to numbers for SVG line drawing
  const pos = (id: string) => {
    const p = POSITIONS[id];
    return { x: parseFloat(p.cx) / 100, y: parseFloat(p.cy) / 100 };
  };

  return (
    <div className="ops-map">
      {/* SVG connection lines */}
      <svg ref={svgRef} className="ops-map-svg" viewBox="0 0 100 100" preserveAspectRatio="none">
        {DEPTS.filter(d => d.id !== 'orchestration_dept').map(d => {
          const from = pos('orchestration_dept');
          const to   = pos(d.id);
          const active = deptActive(d.id) > 0 || isRunning;
          return (
            <line
              key={d.id}
              x1={from.x * 100} y1={from.y * 100}
              x2={to.x   * 100} y2={to.y   * 100}
              className={`ops-line ${active ? 'active' : ''}`}
              strokeDasharray={active ? `${2 + (tick % 3)}` : '2 4'}
            />
          );
        })}
      </svg>

      {/* Department nodes */}
      {DEPTS.map(d => {
        const cnt     = deptAgents(d.id).length;
        const active  = deptActive(d.id);
        const sel     = selectedDept === d.id;
        const isOrch  = d.id === 'orchestration_dept';
        const pulse   = active > 0 || (isOrch && isRunning);

        return (
          <button
            key={d.id}
            className={`ops-node ${sel ? 'selected' : ''} ${pulse ? 'pulsing' : ''} ${isOrch ? 'orch' : ''}`}
            style={{ left: POSITIONS[d.id].cx, top: POSITIONS[d.id].cy }}
            onClick={() => onSelectDept(d.id)}
            title={`${d.label}팀에 지시 — 에이전트 ${cnt}명`}
          >
            <span className="ops-node-icon">{d.icon}</span>
            <span className="ops-node-label">{d.label}</span>
            {cnt > 0 && (
              <span className={`ops-node-count ${active > 0 ? 'active' : ''}`}>
                {active > 0 ? `▶ ${active}명` : `${cnt}명`}
              </span>
            )}
            {pulse && <span className="ops-node-ring" />}
          </button>
        );
      })}

      {/* Task pipeline strip */}
      <div className="ops-pipeline">
        <div className="ops-pipe-item amber">
          <span className="ops-pipe-num">{taskSummary.pending}</span>
          <span className="ops-pipe-lbl">대기</span>
        </div>
        <div className="ops-pipe-arrow">→</div>
        <div className="ops-pipe-item green">
          <span className="ops-pipe-num">{taskSummary.in_progress}</span>
          <span className="ops-pipe-lbl">처리중</span>
        </div>
        <div className="ops-pipe-arrow">→</div>
        <div className="ops-pipe-item muted">
          <span className="ops-pipe-num">{taskSummary.done}</span>
          <span className="ops-pipe-lbl">완료</span>
        </div>
        {taskSummary.failed > 0 && <>
          <div className="ops-pipe-arrow">·</div>
          <div className="ops-pipe-item red">
            <span className="ops-pipe-num">{taskSummary.failed}</span>
            <span className="ops-pipe-lbl">실패</span>
          </div>
        </>}

        {/* Recent events */}
        <div className="ops-pipe-divider" />
        {recentTasks.slice(0, 2).map((t, i) => (
          <div key={i} className="ops-recent-task" title={t.instruction}>
            <span className="ops-recent-dept">{t.target_dept.replace('_dept', '').replace('orchestration', 'orch')}</span>
            <span className="ops-recent-text">{t.instruction.slice(0, 40)}{t.instruction.length > 40 ? '…' : ''}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
