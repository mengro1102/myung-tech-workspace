import { useState, useEffect, useRef } from 'react';
import { AgentSummary, AgentDetail, deptLabels, api } from '../api';

interface Props {
  agents: AgentSummary[];
  onDeploy: () => void;
  onDeptChat: (dept: string, msg: string) => void;
}

interface FeedEvent {
  event_id: string; sender: string; target: string;
  payload: string; timestamp?: string;
}

interface SystemStats {
  cpu_percent: number;
  mem_percent: number;
  mem_used_gb: number;
  mem_total_gb: number;
  disk_percent?: number;
  error?: string;
}

const DEPT_META: Record<string, { icon: string; color: string; border: string; role: string; desc: string }> = {
  orchestration_dept: { icon: '🧠', color: '#8B5CF6', border: 'rgba(139,92,246,0.4)', role: 'Chief Orchestrator', desc: '전체 에이전트 워크플로우를 조정하고 태스크를 배분합니다.' },
  research_dept:      { icon: '🔬', color: '#2DD4BF', border: 'rgba(45,212,191,0.4)',  role: 'Research Specialist', desc: '복잡한 데이터를 분석하고 심층 인사이트를 제공합니다.' },
  dev_dept:           { icon: '⚙️', color: '#FB923C', border: 'rgba(251,146,60,0.4)',  role: 'System Architect', desc: '효율적인 코드 구조를 설계하고 자동화 시스템을 구축합니다.' },
  finance_dept:       { icon: '📈', color: '#F87171', border: 'rgba(248,113,113,0.4)', role: 'Market Analyst', desc: '금융 데이터를 실시간 감시하고 자산 배분 전략을 수립합니다.' },
  content_dept:       { icon: '✍️', color: '#A78BFA', border: 'rgba(167,139,250,0.4)', role: 'Content Creator', desc: '고품질 콘텐츠를 기획하고 제작하는 창의적 에이전트입니다.' },
};

const DEPT_ORDER = ['orchestration_dept', 'research_dept', 'dev_dept', 'finance_dept', 'content_dept'];

function fmtTime(ts?: string) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function cleanPayload(raw: string): string {
  let s = raw.trim().replace(/^\[task-[^\]]+\]\s*/g, '');
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      if (obj.type) return `[${obj.type}]`;
    } catch { /* */ }
  }
  return s.replace(/#{1,4}\s+/g, '').replace(/\*\*/g, '').replace(/\*/g, '').replace(/`/g, '')
    .split('\n').map(l => l.trim()).find(l => l.length > 2) ?? s.slice(0, 80);
}

/* ── 페르소나 편집 모달 ── */
function PersonaEditModal({ agent, onClose }: { agent: AgentDetail; onClose: (updated?: AgentDetail) => void }) {
  const [form, setForm] = useState({
    character_name: agent.character_name ?? '',
    role: agent.role ?? '',
    persona: agent.persona ?? '',
    base_prompt: agent.base_prompt ?? '',
    preferred_model: agent.preferred_model ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const r = await fetch(`/api/agents/${agent.agent_id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const d = await r.json();
      if (d.ok) onClose(d.agent);
      else setError('저장 실패: ' + (d.error ?? '알 수 없는 오류'));
    } catch (e) {
      setError('서버 연결 오류');
    } finally {
      setSaving(false);
    }
  };

  const deptId = agent.department ?? 'orchestration_dept';
  const meta = DEPT_META[deptId] ?? DEPT_META['orchestration_dept'];

  return (
    <div className="pem-bg" onClick={() => onClose()}>
      <div className="pem-modal" onClick={e => e.stopPropagation()}>
        <div className="pem-header" style={{ borderBottomColor: meta.border }}>
          <div className="pem-avatar" style={{ background: `${meta.color}15`, borderColor: meta.border }}>
            <span style={{ fontSize: 22 }}>{meta.icon}</span>
          </div>
          <div>
            <div className="pem-title">에이전트 페르소나 편집</div>
            <div className="pem-sub" style={{ color: meta.color }}>{meta.role}</div>
          </div>
          <button className="pem-close" onClick={() => onClose()}>✕</button>
        </div>

        <div className="pem-body">
          <div className="pem-row">
            <label className="pem-label">이름</label>
            <input className="pem-input" value={form.character_name}
              onChange={e => setForm(f => ({ ...f, character_name: e.target.value }))} />
          </div>
          <div className="pem-row">
            <label className="pem-label">역할</label>
            <input className="pem-input" value={form.role}
              onChange={e => setForm(f => ({ ...f, role: e.target.value }))} />
          </div>
          <div className="pem-row">
            <label className="pem-label">선호 모델</label>
            <input className="pem-input" value={form.preferred_model}
              onChange={e => setForm(f => ({ ...f, preferred_model: e.target.value }))}
              placeholder="예: qwen2.5:3b" />
          </div>
          <div className="pem-row">
            <label className="pem-label">페르소나</label>
            <textarea className="pem-textarea" rows={3} value={form.persona}
              onChange={e => setForm(f => ({ ...f, persona: e.target.value }))}
              placeholder="에이전트의 성격, 말투, 특성을 설명하세요" />
          </div>
          <div className="pem-row">
            <label className="pem-label">기본 프롬프트</label>
            <textarea className="pem-textarea" rows={5} value={form.base_prompt}
              onChange={e => setForm(f => ({ ...f, base_prompt: e.target.value }))}
              placeholder="에이전트가 항상 따르는 시스템 지시사항" />
          </div>
          {error && <div className="pem-error">{error}</div>}
        </div>

        <div className="pem-footer">
          <button className="pem-cancel" onClick={() => onClose()}>취소</button>
          <button className="pem-save" onClick={save} disabled={saving}
            style={{ background: meta.color }}>
            {saving ? '저장 중...' : '변경사항 저장'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function AgentManageTab({ agents, onDeploy, onDeptChat }: Props) {
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [editAgent, setEditAgent] = useState<AgentDetail | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const activeCount = agents.filter(a => a.status !== 'Idle').length;
  const idleCount   = agents.filter(a => a.status === 'Idle').length;

  useEffect(() => {
    const load = () => fetch('/api/events').then(r => r.json())
      .then(d => setFeed((d.events ?? []).slice(-30).reverse())).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const loadStats = () => fetch('/api/system/stats').then(r => r.json())
      .then(d => setStats(d)).catch(() => {});
    loadStats();
    const t = setInterval(loadStats, 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [feed]);

  const openPersona = async (agentId: string) => {
    try {
      const r = await fetch(`/api/agents/${agentId}`);
      const d = await r.json();
      setEditAgent(d.agent ?? d);
    } catch {
      // 상세 없으면 기본값으로 열기
      const a = agents.find(x => x.agent_id === agentId);
      if (a) setEditAgent(a as AgentDetail);
    }
  };

  const agentGaugeValue = agents.length > 0 ? Math.round(activeCount / agents.length * 100) : 0;

  return (
    <div className="am-root">
      <div className="am-bg-deco" />

      {/* 헤더 */}
      <section className="am-header">
        <div>
          <h2 className="am-title">클러스터 에이전트</h2>
          <p className="am-subtitle">자율형 AI 에이전트의 상태와 팀원 구성을 관리합니다.</p>
        </div>
        <div className="am-badges">
          <div className="am-badge">
            <span className="am-badge-dot" style={{ background: '#2DD4BF', boxShadow: '0 0 8px #2DD4BF' }} />
            활성: {activeCount}
          </div>
          <div className="am-badge">
            <span className="am-badge-dot" style={{ background: '#94A3B8' }} />
            대기: {idleCount}
          </div>
          <button className="am-deploy-btn" onClick={onDeploy}>
            ＋ 신규 에이전트 배포
          </button>
        </div>
      </section>

      {/* 에이전트 카드 그리드 */}
      <div className="am-grid">
        {DEPT_ORDER.map(deptId => {
          const meta = DEPT_META[deptId];
          const deptAgents = agents.filter(a => a.department === deptId);
          const hasActive = deptAgents.some(a => a.status !== 'Idle');
          return (
            <div key={deptId} className={`am-card ${hasActive ? 'am-card-active' : ''}`}
              style={{ '--card-color': meta.color, '--card-border': meta.border } as React.CSSProperties}>
              <div className="am-card-glow" style={{ background: meta.color }} />

              <div className="am-card-avatar" style={{ borderColor: meta.border, background: `${meta.color}15` }}>
                <span style={{ fontSize: 32 }}>{meta.icon}</span>
                <span className="am-card-status-badge"
                  style={hasActive
                    ? { background: '#2DD4BF', color: '#003731' }
                    : { background: 'rgba(148,163,184,0.3)', color: '#94A3B8' }}>
                  {hasActive ? 'ONLINE' : 'IDLE'}
                </span>
              </div>

              <h3 className="am-card-name">{deptLabels[deptId] ?? deptId}</h3>
              <span className="am-card-role" style={{ color: meta.color }}>{meta.role}</span>
              <p className="am-card-desc">{meta.desc}</p>

              {/* 팀원 구성 */}
              <div className="am-team-label">팀원 구성 ({deptAgents.length}명)</div>
              <div className="am-team-list">
                {deptAgents.length === 0
                  ? <span className="am-chip-empty">에이전트 없음</span>
                  : deptAgents.map(a => (
                    <div key={a.agent_id} className="am-team-member-wrap">
                      <button className="am-team-member"
                        style={{
                          borderColor: a.status !== 'Idle' ? meta.color : 'rgba(255,255,255,0.1)',
                          color: a.status !== 'Idle' ? meta.color : '#94A3B8',
                        }}
                        onClick={() => openPersona(a.agent_id)}
                        title={`${a.character_name} — 클릭하여 편집`}>
                        <span className="am-member-name">{a.character_name}</span>
                        <span className="am-member-role">{a.role.split(' ')[0]}</span>
                        {a.status !== 'Idle' && <span className="am-chip-live" style={{ background: meta.color }} />}
                      </button>
                      <button className="am-member-del"
                        title="에이전트 제거"
                        onClick={async e => {
                          e.stopPropagation();
                          if (!confirm(`"${a.character_name}" 에이전트를 제거하시겠습니까?`)) return;
                          await fetch(`/api/agents/${a.agent_id}`, { method: 'DELETE' });
                          // 상위에서 agents 목록을 갱신할 수 없으므로 로컬에서 임시 hide
                          (e.currentTarget.closest('.am-team-member-wrap') as HTMLElement)?.style.setProperty('display', 'none');
                        }}>✕</button>
                    </div>
                  ))
                }
              </div>

              <div className="am-card-footer">
                <span className="am-card-count" style={{ color: meta.color }}>{deptAgents.length}명</span>
                <span className="am-card-hint">클릭 시 페르소나 편집</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* 하단: 로그 + 성능 */}
      <section className="am-bottom">
        <div className="am-log-panel">
          <div className="am-log-header">
            <span className="am-log-title">실시간 연산 로그</span>
            <span className="am-log-node">NODE_CLUSTER_01: {feed.length > 0 ? 'STATUS_OK' : 'STANDBY'}</span>
          </div>
          <div className="am-log-body" ref={logRef}>
            {feed.length === 0 && <div className="am-log-empty">에이전트 활동을 기다리는 중...</div>}
            {feed.map(e => {
              const color = DEPT_META[e.sender]?.color ?? '#2DD4BF';
              return (
                <div key={e.event_id} className="am-log-row">
                  <span className="am-log-time">[{fmtTime(e.timestamp)}]</span>
                  <span className="am-log-text" style={{ color }}>{e.sender}</span>
                  <span className="am-log-arrow">→</span>
                  <span className="am-log-msg">{cleanPayload(e.payload)}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div className="am-perf-panel">
          <div className="am-perf-glow" />
          <div>
            <h4 className="am-perf-title">클러스터 성능</h4>
            <p className="am-perf-sub">{stats ? '실시간 시스템 리소스' : '서버 연결 대기 중...'}</p>
          </div>
          <div className="am-perf-bars">
            {[
              { label: 'CPU 부하', value: stats?.cpu_percent ?? 0, color: '#8B5CF6', suffix: '%' },
              { label: '메모리', value: stats?.mem_percent ?? 0, color: '#2DD4BF',
                sub: stats ? `${stats.mem_used_gb}GB / ${stats.mem_total_gb}GB` : '' },
              { label: '디스크', value: stats?.disk_percent ?? 0, color: '#FB923C', suffix: '%' },
              { label: '에이전트 가동률', value: agentGaugeValue, color: '#F87171', suffix: '%' },
            ].map(bar => (
              <div key={bar.label}>
                <div className="am-bar-header">
                  <span className="am-bar-label">{bar.label}{bar.sub ? ` (${bar.sub})` : ''}</span>
                  <span className="am-bar-val" style={{ color: bar.color }}>{Math.round(bar.value)}{bar.suffix ?? '%'}</span>
                </div>
                <div className="am-bar-track">
                  <div className="am-bar-fill" style={{ width: `${bar.value}%`, background: bar.color }} />
                </div>
              </div>
            ))}
          </div>
          <button className="am-optimize-btn"
            onClick={() => fetch('/api/system/stats').then(r => r.json()).then(d => setStats(d)).catch(() => {})}>
            🔄 새로고침
          </button>
        </div>
      </section>

      {/* 페르소나 편집 모달 */}
      {editAgent && (
        <PersonaEditModal
          agent={editAgent}
          onClose={(updated) => {
            setEditAgent(null);
          }}
        />
      )}
    </div>
  );
}
