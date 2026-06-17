import { useEffect, useState } from 'react';
import { api, AgentSummary, AgentDetail, deptLabels, deptColors, avatarFor } from '../api';
import { AGENT_PERSONAS } from '../data/personas';
import '../styles/hub.css';

const DEPT_ORDER = [
  'orchestration_dept',
  'research_dept',
  'finance_dept',
  'dev_dept',
  'content_dept',
];

const DEPT_ICONS: Record<string, string> = {
  orchestration_dept: '🧠',
  research_dept:      '🔬',
  finance_dept:       '📈',
  dev_dept:           '⚙️',
  content_dept:       '✍️',
};

export default function AgentHub() {
  const [agents,   setAgents]   = useState<AgentSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail,   setDetail]   = useState<AgentDetail | null>(null);
  const [saving,   setSaving]   = useState(false);
  const [toast,    setToast]    = useState<string | null>(null);
  const [filter,   setFilter]   = useState<string>('all');
  const [query,    setQuery]    = useState('');

  const reload = () => api.listAgents().then(d => setAgents(d?.agents ?? []));
  useEffect(() => { reload(); }, []);

  /* ── select agent ── */
  const selectAgent = async (id: string) => {
    if (selected === id) { setSelected(null); setDetail(null); return; }
    setSelected(id);
    setDetail(null);
    const d = await api.getAgent(id);
    if (d) setDetail({ ...d, avatar: avatarFor(d) });
  };

  /* ── save ── */
  const handleSave = async () => {
    if (!detail) return;
    setSaving(true);
    const res = await api.updateAgent(detail.agent_id, {
      character_name:      detail.character_name,
      role:                detail.role,
      base_prompt:         detail.base_prompt,
      persona:             detail.persona,
      telegram_bot_token:  detail.telegram_bot_token,
      level:               detail.level,
    });
    setSaving(false);
    showToast(res?.ok ? `✅ ${detail.character_name} 저장 완료` : '❌ 저장 실패');
    if (res?.ok) reload();
  };

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2500);
  };

  /* ── filter + search ── */
  const visible = agents.filter(a => {
    const inDept   = filter === 'all' || a.department === filter;
    const inSearch = !query || a.character_name.toLowerCase().includes(query.toLowerCase())
      || a.role.toLowerCase().includes(query.toLowerCase());
    return inDept && inSearch;
  });

  /* grouped for rendering */
  const grouped: { deptId: string; items: AgentSummary[] }[] = filter === 'all'
    ? DEPT_ORDER
        .map(d => ({ deptId: d, items: visible.filter(a => a.department === d) }))
        .filter(g => g.items.length > 0)
    : [{ deptId: filter, items: visible }];

  const persona   = selected ? AGENT_PERSONAS[selected] : null;
  const deptColor = detail ? (deptColors[detail.department] ?? '#10b981') : '#10b981';

  return (
    <div className="hub-root">
      {toast && <div className="hub-toast">{toast}</div>}

      {/* ── Header ── */}
      <div className="hub-header">
        <h1 className="hub-title">에이전트 허브</h1>
        <span className="hub-subtitle">{agents.length}명 등록</span>

        {/* Dept filter tabs */}
        <div className="hub-filters">
          <button
            className={`hub-filter-btn ${filter === 'all' ? 'active' : ''}`}
            onClick={() => setFilter('all')}
          >
            전체 {agents.length}
          </button>
          {DEPT_ORDER.map(d => {
            const count = agents.filter(a => a.department === d).length;
            if (!count) return null;
            const color = deptColors[d];
            return (
              <button
                key={d}
                className={`hub-filter-btn ${filter === d ? 'active' : ''}`}
                style={filter === d
                  ? { borderColor: color, color, background: color + '18' }
                  : {}}
                onClick={() => setFilter(d)}
              >
                {DEPT_ICONS[d]} {deptLabels[d]} {count}
              </button>
            );
          })}
        </div>

        {/* Search */}
        <div className="hub-search-wrap">
          <span className="hub-search-icon">🔍</span>
          <input
            className="hub-search"
            placeholder="이름 / 역할 검색…"
            value={query}
            onChange={e => setQuery(e.target.value)}
          />
        </div>
      </div>

      {/* ── Body ── */}
      <div className="hub-body">

        {/* Cards grid */}
        <div className="hub-grid-wrap">
          <div className="hub-grid">
            {grouped.length === 0 && (
              <div className="hub-empty">검색 결과가 없습니다.</div>
            )}

            {grouped.map(({ deptId, items }) => (
              <>
                {/* Dept group header */}
                {filter === 'all' && (
                  <div key={`hdr-${deptId}`} className="hub-dept-group-hdr">
                    <span className="hub-dept-group-label" style={{ color: deptColors[deptId] }}>
                      {DEPT_ICONS[deptId]} {deptLabels[deptId]}
                    </span>
                    <span className="hub-dept-group-line" />
                    <span style={{ fontSize: 10, color: '#374151' }}>{items.length}명</span>
                  </div>
                )}

                {items.map(a => {
                  const color = deptColors[a.department] ?? '#6b7280';
                  const p     = AGENT_PERSONAS[a.agent_id];
                  const isActive = a.status !== 'Idle';
                  return (
                    <div
                      key={a.agent_id}
                      className={`hub-agent-card ${selected === a.agent_id ? 'selected' : ''}`}
                      style={{
                        '--card-color': color,
                        ...(selected === a.agent_id
                          ? { borderColor: color + '80', boxShadow: `0 0 0 1px ${color}20, 0 6px 24px ${color}12` }
                          : {}),
                      } as React.CSSProperties}
                      onClick={() => selectAgent(a.agent_id)}
                    >
                      {/* Card top */}
                      <div className="hub-card-top">
                        <div className="hub-avatar-wrap">
                          <img
                            src={avatarFor(a)}
                            alt={a.character_name}
                            className="hub-avatar"
                            style={{ borderColor: color + '70' }}
                            onError={e => {
                              (e.currentTarget as HTMLImageElement).style.display = 'none';
                            }}
                          />
                          <span
                            className={`hub-avatar-status ${isActive ? 'active' : ''}`}
                            style={isActive ? { background: color } : {}}
                          />
                        </div>
                        <div className="hub-card-info">
                          <p className="hub-card-name">{a.character_name}</p>
                          <p className="hub-card-role">{a.role}</p>
                          <span
                            className="hub-dept-badge"
                            style={{ color, borderColor: color + '50', background: color + '12' }}
                          >
                            {deptLabels[a.department] ?? a.department}
                          </span>
                        </div>
                      </div>

                      {/* Persona snippet */}
                      {p && <p className="hub-card-persona">{p.persona.slice(0, 65)}…</p>}

                      {/* Skills */}
                      {p?.skills && (
                        <div className="hub-card-skills">
                          {p.skills.slice(0, 3).map(s => (
                            <span
                              key={s}
                              className="hub-skill-tag"
                              style={{ color, borderColor: color + '40' }}
                            >
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            ))}
          </div>
        </div>

        {/* ── Detail / Edit panel ── */}
        <div className={`hub-detail ${selected ? 'open' : ''}`}>
          {detail ? (
            <div className="hub-detail-scroll">

              {/* Header */}
              <div className="hub-detail-header">
                <img
                  src={detail.avatar}
                  alt={detail.character_name}
                  className="hub-detail-avatar"
                  style={{ borderColor: deptColor + '80' }}
                  onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                />
                <div className="hub-detail-meta-wrap">
                  <h3 className="hub-detail-name">{detail.character_name}</h3>
                  <p className="hub-detail-role-text">
                    {deptLabels[detail.department]} · {detail.role}
                  </p>
                  <p className="hub-detail-id-text">
                    {detail.agent_id} · Lv.{detail.level ?? 1}
                  </p>
                </div>
                <button className="hub-close-btn" onClick={() => { setSelected(null); setDetail(null); }}>✕</button>
              </div>

              {/* Status */}
              <div className="hub-status-bar">
                <span className="hub-status-dot"
                  style={{ background: detail.status !== 'Idle' ? deptColor : '#374151' }} />
                <span className="hub-status-label">{detail.status ?? 'Idle'}</span>
              </div>

              {/* Persona preview */}
              {persona && (
                <div className="hub-persona-preview" style={{ borderLeftColor: deptColor }}>
                  <p className="hub-persona-text">"{persona.persona}"</p>
                  <div className="hub-skills-row">
                    {persona.skills.map(s => (
                      <span
                        key={s}
                        className="hub-skill-tag"
                        style={{ color: deptColor, borderColor: deptColor + '40' }}
                      >
                        {s}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {/* Edit fields */}
              <div className="hub-fields">
                <Field label="캐릭터 이름">
                  <input
                    className="hub-input"
                    value={detail.character_name}
                    onChange={e => setDetail({ ...detail, character_name: e.target.value })}
                  />
                </Field>

                <Field label="직무 / 역할">
                  <input
                    className="hub-input"
                    value={detail.role}
                    onChange={e => setDetail({ ...detail, role: e.target.value })}
                  />
                </Field>

                <Field label="페르소나 (한 줄)">
                  <input
                    className="hub-input"
                    value={detail.persona ?? ''}
                    onChange={e => setDetail({ ...detail, persona: e.target.value })}
                    placeholder="이 에이전트의 성격과 역할을 한 문장으로"
                  />
                </Field>

                <Field label="시스템 프롬프트 (SOUL)">
                  <textarea
                    className="hub-textarea"
                    rows={8}
                    value={detail.base_prompt ?? ''}
                    onChange={e => setDetail({ ...detail, base_prompt: e.target.value })}
                    placeholder="에이전트에게 부여할 상세 역할, 행동 지침, 제약 조건..."
                  />
                </Field>

                <Field label="텔레그램 봇 토큰">
                  <input
                    className="hub-input font-mono"
                    value={detail.telegram_bot_token ?? ''}
                    onChange={e => setDetail({ ...detail, telegram_bot_token: e.target.value })}
                    placeholder="123456789:ABCdef..."
                  />
                  <p className="hub-field-hint">이 에이전트를 텔레그램 봇으로 외부 연결합니다.</p>
                </Field>
              </div>

              {/* Actions */}
              <div className="hub-actions">
                <button
                  className="hub-save-btn"
                  onClick={handleSave}
                  disabled={saving}
                  style={{ background: `linear-gradient(135deg, ${deptColor}cc, ${deptColor})` }}
                >
                  {saving
                    ? <><span style={{ fontSize: 13 }}>⏳</span> 저장 중…</>
                    : <><span style={{ fontSize: 13 }}>💾</span> 저장</>
                  }
                </button>
              </div>

            </div>
          ) : selected ? (
            <div className="hub-detail-loading">로딩 중…</div>
          ) : null}
        </div>

      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="hub-field">
      <label className="hub-field-label">{label}</label>
      {children}
    </div>
  );
}
