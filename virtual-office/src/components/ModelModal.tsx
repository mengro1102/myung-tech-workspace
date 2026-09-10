import { useState, useEffect } from 'react';

interface Props {
  onClose: () => void;
  globalModel: string;
  onGlobalModelChange: (m: string) => void;
}

interface OllamaModel { id: string; size: number; }

function fmtBytes(b: number): string {
  if (!b) return '—';
  const gb = b / 1024 / 1024 / 1024;
  return gb >= 1 ? `${gb.toFixed(1)}GB` : `${(b / 1024 / 1024).toFixed(0)}MB`;
}

const PERSONALITIES = [
  { id: 'calm',       label: '😌 차분함',  desc: '논리적, 침착한 응답' },
  { id: 'balanced',  label: '⚖️ 균형',    desc: '중립적, 균형 잡힌 관점' },
  { id: 'creative',  label: '✨ 창의적',  desc: '아이디어 중심, 발산적 사고' },
  { id: 'sharp',     label: '🎯 간결함',  desc: '핵심만, 짧고 명확하게' },
];

export default function ModelModal({ onClose, globalModel, onGlobalModelChange }: Props) {
  const [search,      setSearch]      = useState('');
  const [personality, setPersonality] = useState('balanced');
  const [tab,         setTab]         = useState<'models' | 'personality'>('models');
  const [models,      setModels]      = useState<OllamaModel[]>([]);
  const [loading,     setLoading]     = useState(true);

  useEffect(() => {
    fetch('/api/models')
      .then(r => r.json())
      .then(d => {
        if (d.models?.length) setModels(d.models);
        else setModels([{ id: globalModel, size: 0 }]);
      })
      .catch(() => setModels([{ id: globalModel, size: 0 }]))
      .finally(() => setLoading(false));
  }, []);

  const filtered = models.filter(m =>
    !search || m.id.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="hm-backdrop" onClick={onClose}>
      <div className="hm-panel" style={{ maxWidth: 560 }} onClick={e => e.stopPropagation()}>
        <div className="hm-header">
          <span className="hm-title">🤖 AI 모델 선택</span>
          <button className="hm-close" onClick={onClose}>✕</button>
        </div>

        {/* 현재 선택된 모델 */}
        <div style={{ padding: '12px 20px', background: 'rgba(15,253,106,0.04)', borderBottom: '1px solid var(--border)' }}>
          <div style={{ fontSize: 10, color: 'var(--muted)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>현재 공통 두뇌</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--green)' }}>{globalModel}</span>
            <span style={{
              fontSize: 10, padding: '2px 8px', borderRadius: 10,
              background: 'var(--green-dk)', border: '1px solid var(--green)',
              color: 'var(--green)'
            }}>사용 중</span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4 }}>
            Ollama via Windows host · GPU 가속 (RTX 3090)
          </div>
        </div>

        {/* 탭 */}
        <div className="mem-tabs">
          <button className={`mem-tab ${tab === 'models' ? 'active' : ''}`} onClick={() => setTab('models')}>
            📦 로컬 모델
          </button>
          <button className={`mem-tab ${tab === 'personality' ? 'active' : ''}`} onClick={() => setTab('personality')}>
            🧠 성격
          </button>
        </div>

        {tab === 'models' && (
          <div className="mem-content">
            {/* 검색 */}
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              <input
                className="hm-input"
                style={{ flex: 1 }}
                placeholder="qwen, llama, gemma..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              <button
                className="hm-save-btn"
                style={{ margin: 0, padding: '6px 14px', fontSize: 12 }}
                onClick={() => setSearch('')}
              >
                검색
              </button>
            </div>

            {/* 모델 목록 */}
            {loading ? (
              <div style={{ textAlign: 'center', color: 'var(--muted)', padding: 24 }}>Ollama 모델 목록 로딩 중…</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {filtered.length === 0 && (
                  <div className="mem-beta-note">설치된 모델이 없거나 Ollama에 연결할 수 없습니다.<br/>WSL: <code>ollama pull qwen2.5:3b</code></div>
                )}
                {filtered.map(m => (
                  <div
                    key={m.id}
                    style={{
                      display: 'flex', alignItems: 'center', gap: 10,
                      padding: '10px 14px',
                      background: globalModel === m.id ? 'var(--green-dk)' : 'var(--bg3)',
                      border: `1px solid ${globalModel === m.id ? 'var(--green)' : 'var(--border)'}`,
                      borderRadius: 10,
                    }}
                  >
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{m.id}</div>
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--muted)', marginRight: 8 }}>{fmtBytes(m.size)}</span>
                    <button
                      style={{
                        padding: '5px 14px',
                        background: globalModel === m.id ? 'var(--green)' : 'transparent',
                        border: `1px solid ${globalModel === m.id ? 'var(--green)' : 'rgba(15,253,106,0.4)'}`,
                        borderRadius: 6,
                        color: globalModel === m.id ? '#000' : 'var(--green)',
                        fontSize: 12, fontWeight: 700, cursor: 'pointer',
                      }}
                      onClick={() => onGlobalModelChange(m.id)}
                    >
                      {globalModel === m.id ? '사용 중' : '사용'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* 'AI 합성소' 카드가 여기 있었다. cursor:pointer 와 → 화살표까지
                붙어 눌리는 것처럼 보였지만 onClick 이 없어 아무 일도 일어나지
                않았다. 누를 수 있어 보이는데 반응이 없는 것은, 없는 것보다
                나쁘다 — 사용자는 자기가 뭘 잘못했는지 찾게 된다.
                기억을 어떻게 합쳐 쓰는지는 🧬 지식 네트워크 → 합성 탭에서
                실제 상태로 보여 준다. */}
          </div>
        )}

        {tab === 'personality' && (
          <div className="mem-content">
            <p className="mem-hint">에이전트가 응답할 때 기본적으로 취하는 태도를 설정합니다.</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {PERSONALITIES.map(p => (
                <button
                  key={p.id}
                  onClick={() => setPersonality(p.id)}
                  style={{
                    padding: '14px 16px',
                    background: personality === p.id ? 'var(--green-dk)' : 'var(--bg3)',
                    border: `1px solid ${personality === p.id ? 'var(--green)' : 'var(--border)'}`,
                    borderRadius: 10,
                    color: personality === p.id ? 'var(--green)' : 'var(--text)',
                    fontSize: 13, fontWeight: 600, cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.15s',
                  }}
                >
                  <div>{p.label}</div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 4, fontWeight: 400 }}>{p.desc}</div>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
