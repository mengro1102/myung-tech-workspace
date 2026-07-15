import { useEffect, useState } from 'react';
import { api, AgentDetail, AgentSummary, deptColors, deptLabels } from '../api';

const OLLAMA_MODELS = [
  'qwen2.5:3b',
  'qwen2.5:7b',
  'qwen2.5:14b',
  'qwen2.5-coder:7b',
  'llama3.2:3b',
  'llama3.1:8b',
  'gemma3:4b',
  'mistral:7b',
];

interface Props {
  onClose: () => void;
  globalModel: string;
  onGlobalModelChange: (m: string) => void;
}

function deptIcon(dept: string) {
  if (dept.includes('orch'))     return '🧠';
  if (dept.includes('research')) return '🔬';
  if (dept.includes('finance'))  return '📈';
  if (dept.includes('dev'))      return '⚙️';
  if (dept.includes('content'))  return '✍️';
  return '🤖';
}

export default function AgentTeamModal({ onClose, globalModel, onGlobalModelChange }: Props) {
  const [agents,   setAgents]   = useState<AgentSummary[]>([]);
  const [selected, setSelected] = useState<AgentDetail | null>(null);
  const [saving,   setSaving]   = useState(false);
  const [toast,    setToast]    = useState('');

  useEffect(() => {
    api.listAgents().then(d => setAgents(d?.agents ?? []));
  }, []);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  };

  const openDetail = async (id: string) => {
    const d = await api.getAgent(id);
    if (d) setSelected(d);
  };

  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    const res = await api.updateAgent(selected.agent_id, {
      character_name:  selected.character_name,
      role:            selected.role,
      base_prompt:     selected.base_prompt,
      persona:         selected.persona,
      preferred_model: selected.preferred_model,
    });
    setSaving(false);
    showToast(res?.ok ? `✅ ${selected.character_name} 저장 완료` : '❌ 저장 실패');
    if (res?.ok) api.listAgents().then(d => setAgents(d?.agents ?? []));
  };

  return (
    <div className="hm-backdrop" onClick={onClose}>
      <div className="hm-panel" onClick={e => e.stopPropagation()}>
        {toast && <div className="hm-toast">{toast}</div>}

        <div className="hm-header">
          <span className="hm-title">내 AI 팀</span>
          <button className="hm-close" onClick={onClose}>✕</button>
        </div>

        {/* pixel office preview */}
        <div className="hm-office-preview">
          <img src="/assets/floor.png"     className="hm-office-floor" alt="" />
          <img src="/assets/furniture.png" className="hm-office-furniture" alt="" />
          <div className="hm-office-label">
            {agents.filter(a => a.status !== 'Idle').length > 0
              ? `${agents.filter(a => a.status !== 'Idle').length}명 작업 중`
              : '전원 대기 중'}
          </div>
          <button className="hm-office-expand">↗ 크게 보기</button>
        </div>

        {/* global model selector */}
        <div className="hm-global-model">
          <span className="hm-global-label">⚡ 공통 두뇌</span>
          <select
            className="hm-model-select"
            value={globalModel}
            onChange={e => onGlobalModelChange(e.target.value)}
          >
            {OLLAMA_MODELS.map(m => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </div>

        {/* agent grid */}
        <div className="hm-agent-grid">
          {agents.map(a => {
            const color = deptColors[a.department] ?? '#10b981';
            const active = a.status !== 'Idle';
            const hasCustom = false; // TODO: read preferred_model from detail
            return (
              <button
                key={a.agent_id}
                className={`hm-agent-card ${selected?.agent_id === a.agent_id ? 'selected' : ''}`}
                style={{ borderColor: selected?.agent_id === a.agent_id ? color : undefined }}
                onClick={() => openDetail(a.agent_id)}
              >
                <div className="hm-agent-icon" style={{ background: color + '22', borderColor: color + '55' }}>
                  {deptIcon(a.department)}
                </div>
                <div className="hm-agent-info">
                  <span className="hm-agent-name">{a.character_name}</span>
                  <span className="hm-agent-brain" style={{ color: hasCustom ? '#f59e0b' : '#10b981' }}>
                    {active ? '🟢' : '⚪'} {hasCustom ? '전용 두뇌' : '공통 두뇌'}
                  </span>
                </div>
              </button>
            );
          })}
        </div>

        {/* detail panel */}
        {selected && (
          <div className="hm-detail">
            <div className="hm-detail-title">{selected.character_name} 설정</div>
            <label className="hm-field-label">전용 두뇌 모델 (비우면 공통 두뇌 사용)</label>
            <select
              className="hm-model-select"
              value={selected.preferred_model ?? ''}
              onChange={e => setSelected({ ...selected, preferred_model: e.target.value || undefined })}
            >
              <option value="">공통 두뇌 ({globalModel})</option>
              {OLLAMA_MODELS.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>

            <label className="hm-field-label" style={{ marginTop: 10 }}>페르소나</label>
            <input
              className="hm-input"
              value={selected.persona ?? ''}
              onChange={e => setSelected({ ...selected, persona: e.target.value })}
              placeholder="이 에이전트의 성격과 역할"
            />

            <label className="hm-field-label" style={{ marginTop: 10 }}>시스템 프롬프트 (SOUL)</label>
            <textarea
              className="hm-textarea"
              rows={5}
              value={selected.base_prompt ?? ''}
              onChange={e => setSelected({ ...selected, base_prompt: e.target.value })}
            />

            <button
              className="hm-save-btn"
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? '저장 중…' : '💾 저장'}
            </button>
          </div>
        )}

        <div className="hm-footer-hint">
          카드 클릭 = 에이전트 설정 · 공통 두뇌 = 전체 에이전트 기본 모델
        </div>
      </div>
    </div>
  );
}
