import { useEffect, useState } from 'react';
import PixelOffice from '../components/PixelOffice';
import { api, AgentSummary, AgentDetail, EventRecord, deptColors, deptLabels, avatarFor } from '../api';
import { AGENT_PERSONAS, PersonaData } from '../data/personas';
import '../styles/office.css';

/* ══════════════════════════════════════════════════
   World constants
══════════════════════════════════════════════════ */
/* Dept metadata — 오른쪽 부서 개요·상세 카드에서만 쓴다. */
const DEPT_META = [
  { id: 'research_dept',      hex: '#2ecc71', label: '학술연구부'    },
  { id: 'finance_dept',       hex: '#3b82f6', label: '금융투자부'    },
  { id: 'orchestration_dept', hex: '#f59e0b', label: '오케스트레이션' },
  { id: 'dev_dept',           hex: '#ef4444', label: '개발팀'        },
  { id: 'content_dept',       hex: '#a855f7', label: '콘텐츠생산부'  },
] as const;

/* Agent positions + intuitive names (성 + 역할 keyword) */
const AGENT_POS: Record<string, {
  x: number; y: number; dept: string; mgr: boolean;
  kname: string;   /* 김개발 스타일 */
  role:  string;   /* 상세 역할 */
}> = {
  orch_master_01:  { x: 750,  y: 200, dept: 'orchestration_dept', mgr: true,  kname: '명총괄',  role: 'CEO · 총괄 오케스트레이터'  },
  res_pm_01:       { x: 145,  y: 140, dept: 'research_dept',      mgr: true,  kname: '이연구',  role: '학술연구부 팀장'            },
  res_worker_01:   { x: 78,   y: 310, dept: 'research_dept',      mgr: false, kname: '박데이터', role: '데이터 엔지니어'           },
  res_crawler_01:  { x: 210,  y: 310, dept: 'research_dept',      mgr: false, kname: '김탐색',  role: '크롤러 개발자'              },
  fin_pm_01:       { x: 435,  y: 140, dept: 'finance_dept',       mgr: true,  kname: '최투자',  role: '금융투자부 팀장'            },
  fin_worker_01:   { x: 435,  y: 310, dept: 'finance_dept',       mgr: false, kname: '윤분석',  role: '투자 분석가'               },
  dev_pm_01:       { x: 1020, y: 140, dept: 'dev_dept',           mgr: true,  kname: '장개발',  role: '개발팀 팀장'               },
  dev_coder_01:    { x: 940,  y: 310, dept: 'dev_dept',           mgr: false, kname: '신코딩',  role: '소프트웨어 엔지니어'        },
  dev_qa_01:       { x: 1100, y: 310, dept: 'dev_dept',           mgr: false, kname: '오품질',  role: 'QA 엔지니어'               },
  con_pm_01:       { x: 1330, y: 140, dept: 'content_dept',       mgr: true,  kname: '한콘텐츠', role: '콘텐츠생산부 팀장'        },
  con_designer_01: { x: 1248, y: 310, dept: 'content_dept',       mgr: false, kname: '임디자인', role: 'UI/UX 디자이너'           },
  con_worker_01:   { x: 1432, y: 310, dept: 'content_dept',       mgr: false, kname: '강작가',  role: '콘텐츠 작가'               },
};

/* Dept colors (for React UI only) */
/* ══════════════════════════════════════════════════
   Main Component
══════════════════════════════════════════════════ */
export default function VirtualOffice() {
  const [agents,      setAgents]      = useState<AgentSummary[]>([]);
  const [events,      setEvents]      = useState<EventRecord[]>([]);
  const [selectedId,  setSelectedId]  = useState<string | null>(null);
  const [agentDetail, setAgentDetail] = useState<AgentDetail | null>(null);

  useEffect(() => {
    api.listAgents().then(d => setAgents(d?.agents ?? []));
    api.listEvents().then(d => setEvents((d?.events ?? []).slice(-30).reverse()));
  }, []);

  useEffect(() => {
    const es = new EventSource('/api/events/stream');
    es.addEventListener('new_event', (e: MessageEvent) => {
      // 초기 목록에 이미 있는 이벤트가 SSE 로 한 번 더 오면 같은 key 가 둘이
      // 된다. React 가 경고를 쏟고 행이 겹치거나 사라진다.
      try {
        const ev = JSON.parse(e.data) as EventRecord;
        setEvents(p => p.some(x => x.event_id === ev.event_id)
          ? p
          : [ev, ...p].slice(0, 30));
      } catch {}
    });
    es.addEventListener('agent_state_change', (e: MessageEvent) => {
      try {
        const d = JSON.parse(e.data) as { agent_id: string; status: string };
        setAgents(p => p.map(a => a.agent_id === d.agent_id ? { ...a, status: d.status } : a));
      } catch {}
    });
    return () => es.close();
  }, []);

  useEffect(() => {
    const h = async (e: Event) => {
      const { agentId } = (e as CustomEvent<{ agentId: string }>).detail;
      setSelectedId(agentId);
      setAgentDetail(await api.getAgent(agentId));
    };
    window.addEventListener('vo:npc-click', h);
    return () => window.removeEventListener('vo:npc-click', h);
  }, []);

  /* 오피스 렌더러.
   *
   * 여기는 Phaser 씬이었다. 사무실 탭이 쓰는 PixelOffice 와 별개 렌더러라
   * 같은 화면에 두 그림체가 섞여 나왔고, phaser 청크만 1.5MB 였다. 조작
   * 캐릭터와 NPC 클릭이 Phaser 를 쓸 이유였는데 둘 다 PixelOffice 로 옮겼다. */

  return (
    <div className="vo-root">

      {/* Left: events */}
      <div className="vo-left">
        <div className="vo-left-hdr">
          <span className="vo-left-title">최근 이벤트</span>
          <span className="live-tag">LIVE</span>
        </div>
        <div className="vo-events-list">
          {events.length === 0 && <div className="vo-events-empty">에이전트 활동 대기 중…</div>}
          {events.map(ev => <EventRow key={ev.event_id} ev={ev} />)}
        </div>
      </div>

      {/* Right: agent bar + explore */}
      <div className="vo-right">
        <div className="vo-agent-bar">
          {selectedId && agentDetail ? (
            <AgentDetailCard
              agent={agentDetail}
              persona={AGENT_PERSONAS[selectedId]}
              agents={agents}
              onClose={() => { setSelectedId(null); setAgentDetail(null); }}
            />
          ) : (
            <DeptOverview agents={agents} />
          )}
        </div>
        <div className="vo-explore">
          <div className="vo-phaser-wrap">
            <PixelOffice
              playable
              agents={agents}
              cycleStatus="running"
              recentMessages={[]}
              onAgentClick={async (agentId) => {
                setSelectedId(agentId);
                setAgentDetail(await api.getAgent(agentId));
              }}
            />
          </div>
          <div className="vo-explore-hint">
            🕹 WASD / 방향키 이동 &nbsp;·&nbsp; 에이전트 클릭 시 정보 확인
          </div>
        </div>
      </div>

    </div>
  );
}

/* ── DeptOverview ── */
function DeptOverview({ agents }: { agents: AgentSummary[] }) {
  const groups = DEPT_META.map(m => ({
    ...m, list: agents.filter(a => a.department === m.id),
  }));
  return (
    <div className="vo-dept-overview">
      {groups.map(dept => {
        const activeCount = dept.list.filter(a => a.status !== 'Idle').length;
        return (
          <div key={dept.id} className="vo-dept-col">
            <div className="vo-dept-col-hdr" style={{ borderBottomColor: dept.hex + '50' }}>
              <span className="vo-dept-col-name" style={{ color: dept.hex }}>{dept.label}</span>
              <span className="vo-dept-col-meta">
                {dept.list.length}명
                {activeCount > 0 && (
                  <span className="vo-dept-col-active" style={{ background: dept.hex }}>활성 {activeCount}</span>
                )}
              </span>
            </div>
            <div className="vo-dept-agents">
              {dept.list.map(a => {
                const pos = AGENT_POS[a.agent_id];
                const active = a.status !== 'Idle';
                return (
                  <div key={a.agent_id} className="vo-dept-agent-row">
                    <span className="vo-dept-agent-dot" style={{ background: active ? dept.hex : '#374151' }} />
                    <div className="vo-dept-agent-info">
                      <span className="vo-dept-agent-name">{pos?.kname ?? a.character_name}</span>
                      <span className="vo-dept-agent-role">{pos?.role ?? a.role}</span>
                    </div>
                    {pos?.mgr && (
                      <span className="vo-dept-agent-pm" style={{ color: dept.hex, borderColor: dept.hex + '50' }}>팀장</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── AgentDetailCard ── */
function AgentDetailCard({ agent, persona, agents, onClose }: {
  agent: AgentDetail; persona: PersonaData | undefined;
  agents: AgentSummary[]; onClose: () => void;
}) {
  const color  = deptColors[agent.department] ?? '#6b7280';
  const live   = agents.find(a => a.agent_id === agent.agent_id);
  const active = live?.status !== 'Idle';
  const pos    = AGENT_POS[agent.agent_id];
  return (
    <div className="vo-detail-card">
      <div className="vo-detail-card-left">
        <img src={avatarFor(agent)} alt="" className="vo-detail-avatar"
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
        <div>
          <div className="vo-detail-card-name">{pos?.kname ?? agent.character_name}</div>
          <div className="vo-detail-card-role" style={{ color }}>{pos?.role ?? agent.role}</div>
          <div className="vo-detail-card-dept" style={{ background: color + '18', color, borderColor: color + '40' }}>
            {deptLabels[agent.department] ?? agent.department}
          </div>
        </div>
      </div>
      <div className="vo-detail-card-mid">
        {persona && <p className="vo-detail-card-persona">{persona.persona.slice(0, 130)}…</p>}
        {persona?.skills && (
          <div className="vo-detail-card-skills">
            {persona.skills.slice(0, 4).map((s: string) => (
              <span key={s} className="vo-skill-chip" style={{ borderColor: color + '50', color }}>{s}</span>
            ))}
          </div>
        )}
      </div>
      <div className="vo-detail-card-right">
        <div className="vo-detail-status-row">
          <span className="vo-detail-status-dot" style={{ background: active ? color : '#374151' }} />
          <span style={{ fontSize: 11, color: '#64748b' }}>{live?.status ?? '—'}</span>
        </div>
        <button className="vo-detail-close-btn" onClick={onClose}>✕ 닫기</button>
      </div>
    </div>
  );
}

/* ── EventRow ── */
function EventRow({ ev }: { ev: EventRecord }) {
  const fromColor = deptColors[ev.sender] ?? '#6b7280';
  const toColor   = deptColors[ev.target]   ?? '#6b7280';
  let text = ev.payload.slice(0, 90);
  try {
    const o = JSON.parse(ev.payload);
    const v = o.message ?? o.result ?? o.task ?? o.content;
    if (typeof v === 'string') text = v.slice(0, 90);
  } catch {}
  const ts = new Date(ev.timestamp).toLocaleTimeString('ko-KR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  return (
    <div className="vo-event-row" style={{ borderLeftColor: fromColor }}>
      <div className="vo-event-route">
        <span className="vo-event-sender" style={{ color: fromColor }}>
          {ev.sender.replace('_dept', '').slice(0, 5).toUpperCase()}
        </span>
        <span className="vo-event-arrow">→</span>
        <span className="vo-event-target" style={{ color: toColor }}>
          {ev.target.replace('_dept', '').slice(0, 5).toUpperCase()}
        </span>
        <span className="vo-event-time">{ts}</span>
      </div>
      <p className="vo-event-text">{text}</p>
    </div>
  );
}
