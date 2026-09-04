import { useState, useEffect, useCallback } from 'react';

interface Props {
  onClose: () => void;
  agentCount: number;
  globalModel: string;
  /** '팀 열기' 를 누르면 팀 화면으로 넘긴다. 예전에는 onClose 만 불러서
   *  창이 닫히기만 하고 아무 데도 가지 않았다. */
  onOpenTeam: () => void;
}

const TABS = ['대시보드', '내 서비스', '연동', 'MCP'] as const;
type Tab = typeof TABS[number];

interface Idea { title: string; value: string; difficulty: string; revenue: string; step: string; }
interface TaskItem { id: string; text: string; done: boolean; }
interface Approval { id: string; label: string; }

/* ── 자격증명 저장 헬퍼 ── */
async function saveCredentials(service: string, payload: Record<string, string>): Promise<string> {
  try {
    const r = await fetch('/api/config/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return r.ok ? `✅ ${service} 저장 완료` : `❌ 저장 실패`;
  } catch { return '❌ 서버 미연결'; }
}

/* ── 상태 배지 ── */
function StatusBadge({ connected }: { connected: boolean }) {
  return (
    <span style={{
      fontSize: 10, padding: '2px 8px', borderRadius: 8,
      background: connected ? 'rgba(15,253,106,0.1)' : 'rgba(239,68,68,0.1)',
      border: `1px solid ${connected ? 'rgba(15,253,106,0.3)' : 'rgba(239,68,68,0.3)'}`,
      color: connected ? '#0ffd6a' : '#ef4444',
    }}>{connected ? '연결됨' : '미설정'}</span>
  );
}

/* ── 입력 필드 ── */
function Field({ label, hint, placeholder, value, onChange, secret }: {
  label: string; hint?: string; placeholder?: string;
  value: string; onChange: (v: string) => void; secret?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ marginTop: 10 }}>
      <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>{label}</label>
      <div style={{ position: 'relative' }}>
        <input
          className="hm-input font-mono"
          type={secret && !show ? 'password' : 'text'}
          placeholder={placeholder}
          value={value}
          onChange={e => onChange(e.target.value)}
          style={{ paddingRight: secret ? 36 : undefined }}
        />
        {secret && (
          <button onClick={() => setShow(v => !v)} style={{
            position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)',
            background: 'none', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14,
          }}>{show ? '🙈' : '👁'}</button>
        )}
      </div>
      {hint && <div style={{ fontSize: 10, color: 'var(--muted2)', marginTop: 3 }}>{hint}</div>}
    </div>
  );
}

/* ── 연동 카드 ── */
function IntegCard({ icon, title, desc, connected, children, onSave, onHelp, extraActions }: {
  icon: string; title: string; desc: string; connected: boolean;
  children: React.ReactNode;
  onSave?: () => void; onHelp?: string;
  extraActions?: React.ReactNode;
}) {
  return (
    <div style={{
      background: 'var(--bg3)', border: `1px solid ${connected ? 'rgba(15,253,106,0.25)' : 'var(--border)'}`,
      borderRadius: 12, padding: 16, marginBottom: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 20 }}>{icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{title}</div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>{desc}</div>
        </div>
        <StatusBadge connected={connected} />
      </div>
      {children}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {onSave && (
          <button className="hm-save-btn" style={{ margin: 0 }} onClick={onSave}>💾 저장</button>
        )}
        {extraActions}
        {onHelp && (
          <button style={{
            padding: '8px 14px', background: 'transparent',
            border: '1px solid var(--border)', borderRadius: 8,
            color: 'var(--muted)', fontSize: 13, cursor: 'pointer',
          }} onClick={() => window.open(onHelp, '_blank')}>📖 도움말</button>
        )}
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════════════ */
export default function ManageModal({ onClose, agentCount, globalModel, onOpenTeam }: Props) {
  const [tab,         setTab]         = useState<Tab>('대시보드');
  const [toast,       setToast]       = useState('');
  const [connKeys,    setConnKeys]    = useState<Record<string, boolean>>({});

  // 비즈니스 아이디어
  const [ideas,       setIdeas]       = useState<Idea[]>([]);
  const [ideaLoading, setIdeaLoading] = useState(false);
  const [ideaCtx,     setIdeaCtx]    = useState('');

  // 태스크 보드
  const [tasks,       setTasks]       = useState<TaskItem[]>([]);
  const [taskInput,   setTaskInput]   = useState('');

  // 승인 큐
  const [approvals]                   = useState<Approval[]>([]);

  // 내 서비스
  const [svcName,     setSvcName]     = useState('');
  const [svcUrl,      setSvcUrl]      = useState('');
  const [svcGithub,   setSvcGithub]   = useState('');
  const [svcDesc,     setSvcDesc]     = useState('');
  const [services,    setServices]    = useState<{name:string;url:string;github:string;desc:string}[]>([]);

  // 연동 자격증명
  const [tgToken,     setTgToken]     = useState('');
  const [tgChatId,    setTgChatId]    = useState('');
  const [ytKey,       setYtKey]       = useState('');
  const [ytChannel,   setYtChannel]   = useState('');
  const [ytOauthId,   setYtOauthId]   = useState('');
  const [ytOauthSec,  setYtOauthSec]  = useState('');
  const [ppClientId,  setPpClientId]  = useState('');
  const [ppClientSec, setPpClientSec] = useState('');
  const [ppMode,      setPpMode]      = useState<'live'|'sandbox'>('live');
  const [tossKey,     setTossKey]     = useState('');
  const [ghToken,     setGhToken]     = useState('');
  const [ghRepo,      setGhRepo]      = useState('');
  const [hfToken,     setHfToken]     = useState('');

  // 병렬 연결 진행 상태
  const [batchRunning, setBatchRunning] = useState(false);
  const [batchStatus,  setBatchStatus]  = useState<string[]>([]);

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  };

  /* 저장된 키 로드 */
  useEffect(() => {
    fetch('/api/config/load').then(r => r.json()).then(d => setConnKeys(d.keys ?? {})).catch(() => {});
  }, []);

  const save = useCallback(async (service: string, payload: Record<string, string>) => {
    const msg = await saveCredentials(service, payload);
    showToast(msg);
    fetch('/api/config/load').then(r => r.json()).then(d => setConnKeys(d.keys ?? {})).catch(() => {});
  }, []);

  /* 비즈니스 아이디어 생성 */
  /* 결과 파싱.
   *
   * 서버가 "### 아이디어 N" + "키: 값" 형식을 요구하므로 그것을 먼저 본다.
   * 모델이 형식을 안 지키는 일은 늘 있으므로, 못 쪼개면 통째로 한 장 보여
   * 준다 — 답을 받아 놓고 빈 화면을 보여 주는 것보다 낫다. */
  const parseIdeas = (raw: string): Idea[] => {
    const strip = (v: string) => v.replace(/\*\*/g, '').replace(/^[-•\s]+/, '').trim();
    const field = (block: string, keys: string[]) => {
      for (const k of keys) {
        const m = block.match(new RegExp(`^\\s*\\**${k}\\**\\s*[:：]\\s*(.+)$`, 'm'));
        if (m) return strip(m[1]);
      }
      return '';
    };
    const blocks = raw
      .split(/^\s*#{1,4}\s*아이디어\s*\d*\s*$/gm)
      .map(b => b.trim())
      .filter(Boolean);
    const parsed = blocks
      .map(b => ({
        title:      field(b, ['제목', '아이디어 제목']),
        value:      field(b, ['가치', '핵심 가치 제안', '핵심 가치']),
        difficulty: field(b, ['난이도', '실행 난이도']) || '보통',
        revenue:    field(b, ['수익', '예상 수익 모델', '수익 모델']),
        step:       field(b, ['첫걸음', '첫 번째 실행 단계', '실행 단계']),
      }))
      .filter(i => i.title);
    if (parsed.length) return parsed.slice(0, 3);

    const lines = raw.split('\n').map(strip).filter(Boolean);
    return [{
      title:      lines[0]?.replace(/^[#\d.)\s]+/, '') || '아이디어',
      value:      lines.slice(1, 5).join(' '),
      difficulty: field(raw, ['난이도', '실행 난이도']) || '보통',
      revenue:    field(raw, ['수익', '예상 수익 모델', '수익 모델']),
      step:       field(raw, ['첫걸음', '첫 번째 실행 단계', '실행 단계']),
    }];
  };

  const generateIdeas = async () => {
    setIdeaLoading(true);
    setIdeas([]);
    try {
      const r = await fetch('/api/business/ideas', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: ideaCtx || '명테크 멀티-에이전트 워크스페이스, YouTube 채널, PayPal 결제' }),
      });
      const d = await r.json();
      if (!d.task_id) {
        setIdeaLoading(false);
        showToast(`❌ 아이디어 생성 요청 실패${d.error ? ` — ${d.error}` : ''}`);
        return;
      }
      // 태스크 결과 폴링 (최대 90초).
      // GET /api/tasks/:id 는 { task, events } 를 돌려준다. 예전에는 td.status /
      // td.result 를 최상위에서 읽어서 영원히 undefined 였다 — 태스크가 done 이
      // 되어도 버튼은 90초 동안 돌다가 아무 말 없이 멈췄다.
      const deadline = Date.now() + 90000;
      const poll = async () => {
        if (Date.now() > deadline) {
          setIdeaLoading(false);
          showToast('❌ 아이디어 생성 시간 초과 (90초)');
          return;
        }
        const tr = await fetch(`/api/tasks/${d.task_id}`).catch(() => null);
        if (!tr) { setTimeout(poll, 3000); return; }
        const body = await tr.json().catch(() => null);
        const td = body?.task ?? body;
        if (!td) { setTimeout(poll, 3000); return; }

        if (td.status === 'done' && td.result) {
          setIdeas(parseIdeas(td.result as string));
          setIdeaLoading(false);
        } else if (td.status === 'failed') {
          showToast(`❌ 아이디어 생성 실패${td.result ? ` — ${String(td.result).slice(0, 80)}` : ''}`);
          setIdeaLoading(false);
        } else {
          setTimeout(poll, 3000);
        }
      };
      poll();
    } catch { setIdeaLoading(false); showToast('❌ 서버 미연결'); }
  };

  /* YouTube + PayPal 동시 연결 */
  const connectBatch = async () => {
    setBatchRunning(true);
    setBatchStatus([]);
    const log = (msg: string) => setBatchStatus(prev => [...prev, msg]);

    log('🔄 YouTube + PayPal 동시 연결 시작...');

    const ytTask = fetch('/api/tasks/batch', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tasks: [
          {
            department: 'research_dept',
            instruction: `YouTube 채널(ID: ${ytChannel || '미설정'})에 대한 비즈니스 분석을 수행해줘. 콘텐츠 전략, 수익화 방안, 성장 기회를 분석해.`,
            priority: 8,
          },
          {
            department: 'finance_dept',
            instruction: `PayPal 결제 시스템(${ppMode} 모드)을 통한 수익 분석 및 매출 최적화 전략을 수립해줘.`,
            priority: 8,
          },
        ],
      }),
    }).then(r => r.json());

    const credSave = Promise.all([
      ytKey && fetch('/api/config/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ YOUTUBE_API_KEY: ytKey, YOUTUBE_CHANNEL_ID: ytChannel }) }),
      ppClientId && fetch('/api/config/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ PAYPAL_CLIENT_ID: ppClientId, PAYPAL_CLIENT_SECRET: ppClientSec, PAYPAL_MODE: ppMode }) }),
    ]);

    const [batchRes] = await Promise.all([ytTask, credSave]);

    if (batchRes.ok) {
      log(`✅ YouTube 분석 태스크 생성 (${batchRes.tasks?.[0]?.task_id?.slice(0,12)}...)`);
      log(`✅ PayPal 분석 태스크 생성 (${batchRes.tasks?.[1]?.task_id?.slice(0,12)}...)`);
      log('💾 자격증명 .env 저장 완료');
      log('⚡ 에이전트가 병렬로 분석 중... (에이전트 피드에서 확인)');
    } else {
      log('❌ 태스크 생성 실패');
    }
    fetch('/api/config/load').then(r => r.json()).then(d => setConnKeys(d.keys ?? {})).catch(() => {});
    setBatchRunning(false);
  };

  /* 서비스 등록 */
  const addService = () => {
    if (!svcName && !svcUrl) return;
    setServices(prev => [...prev, { name: svcName, url: svcUrl, github: svcGithub, desc: svcDesc }]);
    setSvcName(''); setSvcUrl(''); setSvcGithub(''); setSvcDesc('');
    showToast('✅ 서비스 등록됨');
  };

  /* 태스크 추가 */
  const addTask = () => {
    if (!taskInput.trim()) return;
    setTasks(prev => [...prev, { id: Date.now().toString(), text: taskInput, done: false }]);
    setTaskInput('');
  };

  /* ─────────────────────────────────────────────── */
  return (
    <div className="hm-backdrop" onClick={onClose}>
      <div className="hm-panel" style={{ maxWidth: 520, maxHeight: '88vh', overflowY: 'auto' }} onClick={e => e.stopPropagation()}>

        {/* 헤더 */}
        <div className="hm-header" style={{ position: 'sticky', top: 0, background: 'var(--bg2)', zIndex: 10 }}>
          <span style={{ fontSize: 16 }}>📁</span>
          <span className="hm-title">관리</span>
          <button className="hm-close" onClick={onClose}>✕</button>
        </div>

        {toast && <div className="hm-toast">{toast}</div>}

        {/* 탭 */}
        <div className="mem-tabs" style={{ paddingTop: 8, position: 'sticky', top: 44, background: 'var(--bg2)', zIndex: 9 }}>
          {TABS.map(t => (
            <button key={t} className={`mem-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t === '대시보드' ? '📊 대시보드' : t === '내 서비스' ? '📦 내 서비스' : t === '연동' ? '🔗 연동' : '🔌 MCP'}
            </button>
          ))}
        </div>

        {/* ══ 대시보드 ══ */}
        {tab === '대시보드' && (
          <div className="mem-content">

            {/* 비즈니스 리포트 버튼 */}
            <button
              onClick={generateIdeas}
              disabled={ideaLoading}
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
                width: '100%', padding: '14px',
                background: ideaLoading ? 'var(--bg3)' : 'var(--green)',
                border: ideaLoading ? '1px solid var(--border)' : 'none',
                borderRadius: 10, color: ideaLoading ? 'var(--muted)' : '#000',
                fontSize: 14, fontWeight: 800, cursor: ideaLoading ? 'wait' : 'pointer',
                marginBottom: 16, transition: 'all 0.2s',
              }}
            >
              {ideaLoading ? '⏳ AI가 비즈니스 아이디어 분석 중...' : '💎 비즈니스 아이디어 생성'}
            </button>

            {/* 아이디어 컨텍스트 */}
            <input
              className="hm-input"
              placeholder="컨텍스트 (예: YouTube + SaaS, 예상 월수익 100만원)"
              value={ideaCtx}
              onChange={e => setIdeaCtx(e.target.value)}
              style={{ marginBottom: 12 }}
            />

            {/* 아이디어 카드 */}
            {ideas.length > 0 && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 16 }}>
                {ideas.map((idea, i) => (
                  <div key={i} style={{
                    background: 'var(--bg3)', border: '1px solid rgba(15,253,106,0.2)',
                    borderRadius: 10, padding: '12px 14px',
                  }}>
                    <div style={{ fontWeight: 700, fontSize: 13, color: 'var(--green)', marginBottom: 6 }}>
                      {['🥇','🥈','🥉'][i]} {idea.title}
                    </div>
                    {idea.value && <div style={{ fontSize: 12, color: 'var(--text)', marginBottom: 4 }}>{idea.value}</div>}
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                      {idea.difficulty && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.05)', color: 'var(--muted)' }}>난이도: {idea.difficulty}</span>}
                      {idea.revenue && <span style={{ fontSize: 10, padding: '2px 6px', borderRadius: 4, background: 'rgba(255,255,255,0.05)', color: 'var(--muted)' }}>{idea.revenue}</span>}
                    </div>
                    {idea.step && <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 6 }}>▶ {idea.step}</div>}
                  </div>
                ))}
              </div>
            )}

            {/* 타일 그리드 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 16 }}>
              {[
                { icon: '🏢', label: '명테크', sub: '워크스페이스' },
                { icon: '🤖', label: String(agentCount || 0), sub: '에이전트' },
                { icon: '📋', label: String(tasks.filter(t=>!t.done).length), sub: '열린 할 일' },
                // 미연결일 때 '0' 을 띄우면 지식이 0건이라는 뜻으로 읽힌다. 실제로는
                //  GraphRAG 에 82 노드가 있다. 다른 카드처럼 연결 여부만 말한다.
                { icon: '🧠', label: connKeys.GITHUB_TOKEN ? '연결됨' : '미연결', sub: '지식 노트' },
                { icon: '📦', label: String(services.length), sub: '등록 서비스' },
                { icon: '💳', label: connKeys.PAYPAL_CLIENT_ID ? '연결됨' : '미연결', sub: 'PayPal' },
                { icon: '📱', label: connKeys.TELEGRAM_BOT_TOKEN ? '연결됨' : '미연결', sub: '텔레그램' },
                { icon: '💻', label: globalModel, sub: '모델' },
              ].map((tile, i) => (
                <div key={i} style={{
                  background: 'var(--bg3)', border: '1px solid var(--border)',
                  borderRadius: 10, padding: '14px 8px', textAlign: 'center',
                }}>
                  <div style={{ fontSize: 22, marginBottom: 4 }}>{tile.icon}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text)', wordBreak: 'break-all', lineHeight: 1.3 }}>{tile.label}</div>
                  <div style={{ fontSize: 10, color: 'var(--muted)', marginTop: 2 }}>{tile.sub}</div>
                </div>
              ))}
            </div>

            {/* 우리 팀 */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>👥 우리 팀 — {agentCount}명 AI</span>
              <button style={{
                marginLeft: 'auto', padding: '4px 12px',
                background: 'var(--green)', color: '#000',
                border: 'none', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer',
              }} onClick={onOpenTeam}>팀 열기</button>
            </div>

            {/* 태스크 보드 */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>
                📋 태스크 보드 — 할 일 <span style={{ fontSize: 10, color: 'var(--muted)' }}>(에이전트가 자동으로 쌓기도 함)</span>
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                <input
                  className="hm-input"
                  style={{ flex: 1 }}
                  placeholder="할 일 추가 (예: 썸네일 시안 3개 만들기)"
                  value={taskInput}
                  onChange={e => setTaskInput(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && addTask()}
                />
                <button className="hm-save-btn" style={{ margin: 0, padding: '6px 14px', fontSize: 12 }} onClick={addTask}>+ 추가</button>
              </div>
              {tasks.length === 0 ? (
                <div className="mem-beta-note" style={{ margin: 0 }}>할 일이 없어요 — 위에 입력하거나, 에이전트가 자동으로 쌓아요.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {tasks.map(t => (
                    <div key={t.id} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 10px', background: 'var(--bg3)', borderRadius: 8,
                      border: '1px solid var(--border)',
                    }}>
                      <input type="checkbox" checked={t.done}
                        onChange={() => setTasks(prev => prev.map(x => x.id===t.id ? {...x,done:!x.done} : x))}
                        style={{ accentColor: 'var(--green)', cursor: 'pointer' }}
                      />
                      <span style={{ flex: 1, fontSize: 12, color: t.done ? 'var(--muted)' : 'var(--text)', textDecoration: t.done ? 'line-through' : 'none' }}>{t.text}</span>
                      <button onClick={() => setTasks(prev => prev.filter(x => x.id!==t.id))}
                        style={{ background: 'none', border: 'none', color: 'var(--muted2)', cursor: 'pointer', fontSize: 14 }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* 승인 큐 */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>✅ 승인 큐 — 에이전트가 중요한 일 전에 결재 요청</span>
                <button style={{
                  marginLeft: 'auto', padding: '4px 12px',
                  background: 'transparent', border: '1px solid var(--border)',
                  borderRadius: 6, color: 'var(--muted)', fontSize: 11, cursor: 'pointer',
                }}>큰 결제 테스트</button>
              </div>
              {approvals.length === 0 ? (
                <div className="mem-beta-note" style={{ margin: 0 }}>대기 중인 승인이 없어요.</div>
              ) : approvals.map(a => (
                <div key={a.id} style={{ padding: '8px 12px', background: 'var(--bg3)', borderRadius: 8, marginBottom: 6, fontSize: 12 }}>
                  {a.label}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ══ 내 서비스 ══ */}
        {tab === '내 서비스' && (
          <div className="mem-content">
            <p className="mem-hint">등록한 서비스는 에이전트가 인지해서 답변·작업에 활용합니다. 깃헙 레포를 넣으면 에이전트가 그 코드를 읽고 SEO-GEO 같은 가벼운 수정은 직접, 핵심 변경은 결재로 올립니다.</p>

            <Field label="서비스 이름 (예: 내 랜딩 페이지)" value={svcName} onChange={setSvcName} />
            <Field label="웹사이트 주소" placeholder="https://..." value={svcUrl} onChange={setSvcUrl} />
            <Field label="깃헙 레포 owner/repo (선택 — 코드까지 읽게)" placeholder="myname/myrepo" value={svcGithub} onChange={setSvcGithub} />
            <Field label="한 줄 설명 (선택)" value={svcDesc} onChange={setSvcDesc} />

            <button className="hm-save-btn" style={{ width: '100%', marginTop: 14 }} onClick={addService}>+ 등록</button>

            {services.length === 0 ? (
              <div className="mem-beta-note" style={{ marginTop: 14 }}>아직 등록한 서비스가 없어요. 위에 추가하세요.</div>
            ) : (
              <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
                {services.map((svc, i) => (
                  <div key={i} style={{
                    background: 'var(--bg3)', border: '1px solid var(--border)',
                    borderRadius: 10, padding: '10px 14px',
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  }}>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{svc.name || svc.url}</div>
                      {svc.url && <div style={{ fontSize: 11, color: 'var(--muted)' }}>{svc.url}</div>}
                      {svc.github && <div style={{ fontSize: 10, color: 'var(--muted2)' }}>📦 {svc.github}</div>}
                    </div>
                    <button onClick={() => setServices(prev => prev.filter((_, j) => j !== i))}
                      style={{ background: 'none', border: 'none', color: 'var(--muted2)', cursor: 'pointer' }}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ══ 연동 ══ */}
        {tab === '연동' && (
          <div className="mem-content">
            <p className="mem-hint" style={{ marginBottom: 4 }}>모든 외부 연결을 한 곳에서 — 자격증명 입력 후 각 카드의 저장을 누르세요.</p>

            {/* ⚡ YouTube + PayPal 동시 연결 */}
            <div style={{
              background: 'rgba(15,253,106,0.04)', border: '1px solid rgba(15,253,106,0.2)',
              borderRadius: 12, padding: 14, marginBottom: 16,
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--green)', marginBottom: 6 }}>
                ⚡ YouTube + PayPal 동시 연결
              </div>
              <p style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10 }}>
                두 서비스를 한 번에 연결하고, AI 에이전트가 병렬로 채널 분석 + 수익 전략을 즉시 수립합니다.
              </p>
              <button
                onClick={connectBatch}
                disabled={batchRunning}
                style={{
                  width: '100%', padding: '10px',
                  background: batchRunning ? 'var(--bg3)' : 'var(--green)',
                  border: batchRunning ? '1px solid var(--border)' : 'none',
                  borderRadius: 8, color: batchRunning ? 'var(--muted)' : '#000',
                  fontSize: 13, fontWeight: 700, cursor: batchRunning ? 'wait' : 'pointer',
                }}
              >
                {batchRunning ? '⏳ 에이전트 작업 중...' : '🚀 YouTube + PayPal 동시 연결 & 분석 시작'}
              </button>
              {batchStatus.length > 0 && (
                <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {batchStatus.map((s, i) => (
                    <div key={i} style={{ fontSize: 11, color: s.startsWith('✅') ? 'var(--green)' : s.startsWith('❌') ? '#ef4444' : 'var(--muted)' }}>{s}</div>
                  ))}
                </div>
              )}
            </div>

            {/* 텔레그램 봇 */}
            <IntegCard icon="✈️" title="텔레그램 봇" desc="비서가 텔레그램으로 양방향 명령을 받고 보고합니다. 폰 어디서든 회사를 운영하세요."
              connected={!!connKeys.TELEGRAM_BOT_TOKEN}
              onSave={() => save('텔레그램 봇', { TELEGRAM_BOT_TOKEN: tgToken, TELEGRAM_CHAT_ID: tgChatId })}
              onHelp="https://core.telegram.org/bots#how-do-i-create-a-bot"
            >
              <Field label="Bot Token" placeholder="123456789:ABCdef..." value={tgToken} onChange={setTgToken} secret
                hint="@BotFather에서 /newbot으로 발급 (숫자:문자)" />
              <Field label="Chat ID" placeholder="비워두면 자동 감지" value={tgChatId} onChange={setTgChatId}
                hint="봇한테 메시지 1번 보내고 비운 채 저장하면 자동 입력" />
            </IntegCard>

            {/* YouTube Data API */}
            <IntegCard icon="📺" title="YouTube Data API" desc="내 채널 + 경쟁 채널 분석, 댓글 답장 큐. 비공개 데이터는 OAuth 별도."
              connected={!!connKeys.YOUTUBE_API_KEY}
              onSave={() => save('YouTube API', { YOUTUBE_API_KEY: ytKey, YOUTUBE_CHANNEL_ID: ytChannel })}
              onHelp="https://console.cloud.google.com/"
            >
              <Field label="API Key" value={ytKey} onChange={setYtKey} secret
                hint="Cloud Console → YouTube Data API v3 → API 키" />
              <Field label="Channel ID" placeholder="UCxxx..." value={ytChannel} onChange={setYtChannel} />
            </IntegCard>

            {/* YouTube Analytics OAuth */}
            <IntegCard icon="📊" title="YouTube Analytics (OAuth)" desc="시청 지속률·트래픽·구독 증감. 저장 후 '⚡ 자동 연결'로 구글 로그인."
              connected={!!connKeys.YOUTUBE_OAUTH_CLIENT_ID}
              onSave={() => save('YouTube OAuth', { YOUTUBE_OAUTH_CLIENT_ID: ytOauthId, YOUTUBE_OAUTH_CLIENT_SECRET: ytOauthSec })}
              extraActions={
                <button style={{
                  padding: '8px 14px', background: 'rgba(15,253,106,0.1)',
                  border: '1px solid rgba(15,253,106,0.3)', borderRadius: 8,
                  color: 'var(--green)', fontSize: 13, cursor: 'pointer',
                }}>⚡ 자동 연결</button>
              }
            >
              <Field label="Client ID" value={ytOauthId} onChange={setYtOauthId} secret />
              <Field label="Client Secret" value={ytOauthSec} onChange={setYtOauthSec} secret
                hint="Cloud Console에서 승인된 리디렉션 URI에 http://127.0.0.1:5814/yt-oauth-callback 추가" />
            </IntegCard>

            {/* Google Calendar */}
            <div style={{
              background: 'var(--bg3)', border: '1px solid var(--border)',
              borderRadius: 12, padding: 16, marginBottom: 12,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 }}>
                <span style={{ fontSize: 20 }}>📅</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>Google Calendar</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)' }}>비서가 일정을 읽고 task 마감일과 자동 동기화합니다.</div>
                </div>
                <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 8, background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.3)', color: '#f59e0b' }}>준비 중</span>
              </div>
              <div style={{ padding: '10px 12px', border: '1px dashed var(--border)', borderRadius: 8, textAlign: 'center', fontSize: 11, color: 'var(--muted)' }}>
                곧 합류합니다 · 다음 업데이트
              </div>
            </div>

            {/* PayPal */}
            <IntegCard icon="💰" title="PayPal (매출 분석)" desc="결제 거래 분석. 💰 매출 대시보드 + 새 결제 알림에 사용."
              connected={!!connKeys.PAYPAL_CLIENT_ID}
              onSave={() => save('PayPal', { PAYPAL_CLIENT_ID: ppClientId, PAYPAL_CLIENT_SECRET: ppClientSec, PAYPAL_MODE: ppMode })}
              onHelp="https://developer.paypal.com/"
            >
              <div style={{ marginTop: 10 }}>
                <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>모드</label>
                <select value={ppMode} onChange={e => setPpMode(e.target.value as 'live'|'sandbox')} className="hm-input" style={{ width: 'auto' }}>
                  <option value="live">live</option>
                  <option value="sandbox">sandbox</option>
                </select>
                <div style={{ fontSize: 10, color: 'var(--muted2)', marginTop: 3 }}>실제 결제는 live, 테스트는 sandbox</div>
              </div>
              <Field label="Client ID" value={ppClientId} onChange={setPpClientId} secret />
              <Field label="Client Secret" value={ppClientSec} onChange={setPpClientSec} secret />
            </IntegCard>

            {/* 토스페이먼츠 */}
            <IntegCard icon="🏦" title="토스페이먼츠 (매출 분석)" desc="토스 결제 거래(KRW)를 분석. 💰 매출 대시보드 + 자신분석에 PayPal과 합쳐서 보여줍니다."
              connected={!!connKeys.TOSS_SECRET_KEY}
              onSave={() => save('토스페이먼츠', { TOSS_SECRET_KEY: tossKey })}
              onHelp="https://docs.tosspayments.com/"
            >
              <Field label="시크릿 키" value={tossKey} onChange={setTossKey} secret
                hint="토스페이먼츠 개발자센터 → API 키 → 시크릿 키(live_sk_... 실거래 / test_sk_... 테스트)" />
            </IntegCard>

            {/* GitHub */}
            <IntegCard icon="🐙" title="GitHub — ⚡ 단기 기억" desc="지식 네트워크(단기 기억)를 GitHub 레포에 버전관리로 동기화. 어디서든 불러오고 사람이 직접 편집도."
              connected={!!connKeys.GITHUB_TOKEN}
              onSave={() => save('GitHub', { GITHUB_TOKEN: ghToken, GITHUB_REPO: ghRepo })}
              onHelp="https://github.com/settings/tokens"
            >
              <Field label="Personal Access Token" value={ghToken} onChange={setGhToken} secret
                hint="github.com/settings/tokens → repo(Contents) 권한" />
              <Field label="지식 저장소" placeholder="owner/repo" value={ghRepo} onChange={setGhRepo} />
            </IntegCard>

            {/* HuggingFace */}
            <IntegCard icon="🤗" title="HuggingFace — 🎯 장기 기억" desc="파인튜닝 모델 & 데이터셋을 HuggingFace Hub에 업로드·로드합니다."
              connected={!!connKeys.HUGGINGFACE_TOKEN}
              onSave={() => save('HuggingFace', { HUGGINGFACE_TOKEN: hfToken })}
              onHelp="https://huggingface.co/settings/tokens"
            >
              <Field label="Access Token" placeholder="hf_..." value={hfToken} onChange={setHfToken} secret
                hint="huggingface.co/settings/tokens → write 권한" />
            </IntegCard>
          </div>
        )}

        {/* ══ MCP ══ */}
        {tab === 'MCP' && (
          <div className="mem-content">
            <p className="mem-hint">MCP(Model Context Protocol) 서버를 연결하면 에이전트가 외부 도구를 직접 사용할 수 있습니다.</p>
            <div style={{
              background: 'var(--bg3)', border: '1px solid var(--border)',
              borderRadius: 12, padding: 14, marginBottom: 12,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)', marginBottom: 6 }}>연결된 MCP 서버</div>
              <div className="mem-beta-note" style={{ margin: 0 }}>연결된 MCP 서버가 없습니다.</div>
            </div>
            <div style={{
              background: 'var(--bg3)', border: '1px dashed var(--border)',
              borderRadius: 12, padding: 14,
            }}>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>+ 새 MCP 서버 추가</div>
              <Field label="서버 이름" placeholder="my-mcp-server" value="" onChange={() => {}} />
              <Field label="Command" placeholder="npx @modelcontextprotocol/server-filesystem /path" value="" onChange={() => {}} />
              <button className="hm-save-btn" style={{ marginTop: 10 }}>연결</button>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}
