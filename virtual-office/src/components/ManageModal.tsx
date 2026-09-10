import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { useStore } from '../useStore';
const GuideModal = lazy(() => import('./GuideModal'));
import { api, deptColors, deptLabels, type ApprovalRow, type IntegrationStatus, type ServiceRow, type TaskRow } from '../api';

interface Props {
  onClose: () => void;
  agentCount: number;
  globalModel: string;
  /** '팀 열기' 를 누르면 팀 화면으로 넘긴다. 예전에는 onClose 만 불러서
   *  창이 닫히기만 하고 아무 데도 가지 않았다. */
  onOpenTeam: () => void;
}

/* MCP 탭을 뺐다.
 *
 * 명테크에 MCP 를 붙이려면 맹비서(Hermes)가 이미 가진 것을 통째로 다시 만들어야
 * 한다 — MCP 클라이언트, 도구 스키마 변환, 그리고 무엇보다 도구 호출 루프.
 * 명테크 디스패처는 단발 LLM 호출 하나가 전부다. 절반만 지은 MCP 는 없는 것보다
 * 나쁘다(눌러도 아무 일이 없는 버튼이 정확히 그 결과였다).
 *
 * 도구가 필요한 일은 맹비서에게 시킨다. 명테크는 부서 단위의 사고와 산출에
 * 집중한다. */
const TABS = ['대시보드', '내 서비스', '연동'] as const;
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
/* 저장과 연결은 다르다.
 *
 * 예전에는 "키가 .env 에 비어 있지 않음" 을 그대로 '연결됨' 이라고 불렀다.
 * 그래서 오타가 난 키도, 권한이 없는 토큰도, 만료된 자격증명도 전부 초록색
 * 이었다. 실제로 한 번 불러 본 결과만 '연결 확인됨' 이 된다. */
const BADGE = {
  ok:    { text: '연결 확인됨', fg: '#0ffd6a', bg: 'rgba(15,253,106,0.1)',  bd: 'rgba(15,253,106,0.3)' },
  saved: { text: '저장됨',      fg: '#fbbf24', bg: 'rgba(251,191,36,0.1)',  bd: 'rgba(251,191,36,0.3)' },
  error: { text: '연결 실패',   fg: '#ef4444', bg: 'rgba(239,68,68,0.1)',   bd: 'rgba(239,68,68,0.3)' },
  unset: { text: '미설정',      fg: 'var(--muted)', bg: 'transparent',      bd: 'var(--border)' },
} as const;

function StatusBadge({ kind }: { kind: keyof typeof BADGE }) {
  const b = BADGE[kind];
  return (
    <span style={{
      fontSize: 10, padding: '2px 8px', borderRadius: 8, whiteSpace: 'nowrap',
      background: b.bg, border: `1px solid ${b.bd}`, color: b.fg,
    }}>{b.text}</span>
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
function IntegCard({ icon, title, desc, status, saved, children, onSave, onHelp,
                    onProbe, probing, onGuide, extraActions }: {
  icon: string; title: string; desc: string;
  /** 서버가 실제로 호출해 본 결과. 없으면 아직 배선되지 않은 카드다 */
  status?: IntegrationStatus;
  /** 키가 .env 에 있는가 — status 가 없는 카드의 최선 */
  saved: boolean;
  children: React.ReactNode;
  onSave?: () => void; onHelp?: string;
  onProbe?: () => void; probing?: boolean;
  /** 이 카드의 가이드 절을 연다 */
  onGuide?: () => void;
  extraActions?: React.ReactNode;
}) {
  const kind: keyof typeof BADGE =
    status ? (status.state === 'ok' ? 'ok' : status.state === 'error' ? 'error' : 'unset')
           : (saved ? 'saved' : 'unset');
  const ok = kind === 'ok';
  return (
    <div style={{
      background: 'var(--bg3)',
      border: `1px solid ${ok ? 'rgba(15,253,106,0.25)'
                : kind === 'error' ? 'rgba(239,68,68,0.25)' : 'var(--border)'}`,
      borderRadius: 12, padding: 16, marginBottom: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <span style={{ fontSize: 20 }}>{icon}</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text)' }}>{title}</div>
          <div style={{ fontSize: 11, color: 'var(--muted)' }}>{desc}</div>
        </div>
        <StatusBadge kind={kind} />
      </div>

      {/* 진단 한 줄. 성공이면 실제 수치가, 실패면 이유가 그대로 나온다 —
          "연결 실패" 만 보고 무엇을 고쳐야 할지 알 수는 없다. */}
      {status && status.detail && (
        <div style={{
          fontSize: 11, lineHeight: 1.6, marginBottom: 10, padding: '7px 10px',
          borderRadius: 6,
          background: ok ? 'rgba(15,253,106,0.06)'
                    : status.state === 'error' ? 'rgba(239,68,68,0.06)' : 'var(--bg2)',
          color: ok ? 'var(--green, #0ffd6a)'
               : status.state === 'error' ? '#fca5a5' : 'var(--muted)',
        }}>{status.detail}</div>
      )}
      {!status && saved && (
        <div style={{
          fontSize: 11, lineHeight: 1.6, marginBottom: 10, padding: '7px 10px',
          borderRadius: 6, background: 'var(--bg2)', color: 'var(--muted)',
        }}>키는 저장돼 있습니다. 이 항목을 실제로 사용하는 기능은 아직 없습니다.</div>
      )}
      {children}
      <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
        {onSave && (
          <button className="hm-save-btn" style={{ margin: 0 }} onClick={onSave}>💾 저장</button>
        )}
        {onProbe && (
          <button
            onClick={onProbe}
            disabled={probing}
            title="저장된 키로 실제 호출을 한 번 해 봅니다"
            style={{
              padding: '8px 14px', background: 'transparent',
              border: '1px solid var(--border)', borderRadius: 8,
              color: 'var(--muted)', fontSize: 13,
              cursor: probing ? 'wait' : 'pointer',
            }}>{probing ? '확인 중…' : '🔌 연결 확인'}</button>
        )}
        {extraActions}
        {onGuide && (
          <button
            title="발급 절차 · 필요한 권한 · 확인 방법"
            style={{
              padding: '8px 14px', background: 'var(--primary-dk)',
              border: '1px solid rgba(139,92,246,0.35)', borderRadius: 8,
              color: 'var(--primary)', fontSize: 13, cursor: 'pointer',
            }} onClick={onGuide}>📖 가이드</button>
        )}
        {onHelp && (
          <button
            title="발급처(외부 사이트)를 새 탭으로"
            style={{
              padding: '8px 14px', background: 'transparent',
              border: '1px solid var(--border)', borderRadius: 8,
              color: 'var(--muted)', fontSize: 13, cursor: 'pointer',
            }} onClick={() => window.open(onHelp, '_blank')}>↗ 발급처</button>
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
  const [ytOauth,     setYtOauth]     = useState<{ connected: boolean; has_client: boolean } | null>(null);
  const [ytBusy,      setYtBusy]      = useState(false);

  /* 연동의 **실제** 상태. 서버가 저장된 키로 한 번 호출해 본 결과다.
   * connKeys(=.env 에 값이 있는가)와 구분해서 쓴다 — 저장과 연결은 다르다. */
  const [integStatus, setIntegStatus] = useState<Record<string, IntegrationStatus>>({});
  const [probing,     setProbing]     = useState('');
  /* 가이드를 열 절. '' 면 닫힘. 카드마다 자기 절로 바로 연다 — 문서 전체를
     열어 주고 찾으라고 하면 결국 다시 물어보게 된다. */
  const [guide,       setGuide]       = useState('');

  const refreshIntegrations = useCallback(async () => {
    const r = await api.listIntegrations();
    if (!r?.integrations) return;
    setIntegStatus(Object.fromEntries(r.integrations.map(i => [i.name, i])));
  }, []);

  const probeOne = useCallback(async (name: string) => {
    setProbing(name);
    const r = await api.probeIntegration(name);
    setProbing('');
    if (r?.status) {
      setIntegStatus(prev => ({ ...prev, [name]: r.status }));
      showToast(r.status.ok ? `✅ ${r.status.detail}` : `⚠️ ${r.status.detail}`);
    } else {
      showToast('⚠️ 확인하지 못했습니다 — 서버가 떠 있는지 보세요');
    }
  }, []);

  // 비즈니스 아이디어
  const [ideas,       setIdeas]       = useState<Idea[]>([]);
  const [ideaLoading, setIdeaLoading] = useState(false);
  const [ideaCtx,     setIdeaCtx]    = useState('');

  /* 서버 저장소. 에이전트도 같은 곳에 쓴다 — 화면에서 지운 할 일이 다시
   * 살아나지 않고, 에이전트가 올린 결재가 여기 뜬다. */
  const taskStore     = useStore<TaskRow>('tasks');
  const serviceStore  = useStore<ServiceRow>('services');
  const approvalStore = useStore<ApprovalRow>('approvals');
  const tasks     = taskStore.items;
  const services  = serviceStore.items;
  const approvals = approvalStore.items;
  const [taskInput,   setTaskInput]   = useState('');


  // 내 서비스
  const [svcName,     setSvcName]     = useState('');
  const [svcUrl,      setSvcUrl]      = useState('');
  const [svcGithub,   setSvcGithub]   = useState('');
  const [svcDesc,     setSvcDesc]     = useState('');

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
    api.ytOauthStatus().then(d => d && setYtOauth(d));
    void refreshIntegrations();
  }, [refreshIntegrations]);

  /* YouTube Analytics 연결.
   *
   * 구글은 인가 코드를 브라우저 리다이렉트로 돌려준다. 그래서 세 걸음이다 —
   * 서버가 콜백 받을 자리를 열고 로그인 주소를 주면, 사람이 새 창에서
   * 로그인하고, 우리는 코드가 돌아왔는지 물어본다. */
  const connectYouTube = async () => {
    setYtBusy(true);
    try {
      const start = await api.ytOauthStart();
      if (!start?.ok || !start.auth_url) {
        showToast(`❌ ${start?.error ?? '연결을 시작하지 못했습니다'}`);
        return;
      }
      window.open(start.auth_url, '_blank', 'noopener,width=520,height=680');
      showToast('🔐 새 창에서 구글 로그인을 마쳐 주세요');
      // 3초마다 최대 3분. 사람이 로그인하는 데 걸리는 시간이다.
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const fin = await api.ytOauthFinish();
        if (fin?.ok) {
          showToast('✅ YouTube Analytics 연결됨');
          setYtOauth(await api.ytOauthStatus());
          return;
        }
        if (fin && !fin.pending) {
          showToast(`❌ ${fin.error ?? '연결 실패'}`);
          return;
        }
      }
      showToast('❌ 시간 초과 — 다시 시도해 주세요');
    } finally {
      setYtBusy(false);
    }
  };

  const save = useCallback(async (service: string, payload: Record<string, string>) => {
    const msg = await saveCredentials(service, payload);
    showToast(msg);
    fetch('/api/config/load').then(r => r.json()).then(d => setConnKeys(d.keys ?? {})).catch(() => {});
    void refreshIntegrations();
  }, [refreshIntegrations]);

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
  const addService = async () => {
    if (!svcName && !svcUrl) return;
    const ok = await serviceStore.add({ name: svcName, url: svcUrl, github: svcGithub, desc: svcDesc });
    if (!ok) { showToast('❌ 서비스 등록 실패 — 서버 확인'); return; }
    setSvcName(''); setSvcUrl(''); setSvcGithub(''); setSvcDesc('');
    showToast('✅ 서비스 등록됨 — 에이전트가 이제 이 서비스를 압니다');
  };

  /* 승인 큐 — 아직 에이전트가 결재를 올리는 경로가 없다. 이 버튼은 큐가
   * 어떻게 보이는지 확인하는 용도다(이름 그대로 '테스트'). */
  const addSampleApproval = () => {
    approvalStore.add({
      label: `[샘플] 광고 집행 ₩250,000 결제 승인 요청 — ${new Date().toLocaleTimeString('ko-KR')}`,
      status: 'pending',
      department: '',
    });
  };

  /* 태스크 추가 */
  const addTask = async () => {
    if (!taskInput.trim()) return;
    const ok = await taskStore.add({ text: taskInput.trim(), done: false, source: 'user' });
    if (!ok) { showToast('❌ 할 일 저장 실패 — 서버 확인'); return; }
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
      {guide && (
        <Suspense fallback={null}>
          <GuideModal anchor={guide} onClose={() => setGuide('')} />
        </Suspense>
      )}

        {/* 탭 */}
        <div className="mem-tabs" style={{ paddingTop: 8, position: 'sticky', top: 44, background: 'var(--bg2)', zIndex: 9 }}>
          {TABS.map(t => (
            <button key={t} className={`mem-tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
              {t === '대시보드' ? '📊 대시보드' : t === '내 서비스' ? '📦 내 서비스' : '🔗 연동'}
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
                📋 태스크 보드 — 할 일 <span style={{ fontSize: 10, color: 'var(--muted)' }}>(에이전트가 올린 것도 여기 쌓입니다)</span>
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
                <div className="mem-beta-note" style={{ margin: 0 }}>할 일이 없어요 — 위에 추가하거나, 에이전트가 올릴 때까지 기다리세요.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {tasks.map(t => (
                    <div key={t.id} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 10px', background: 'var(--bg3)', borderRadius: 8,
                      border: '1px solid var(--border)',
                    }}>
                      <input type="checkbox" checked={t.done}
                        onChange={() => taskStore.update(t.id, { done: !t.done })}
                        style={{ accentColor: 'var(--green)', cursor: 'pointer' }}
                      />
                      <span style={{ flex: 1, fontSize: 12, color: t.done ? 'var(--muted)' : 'var(--text)', textDecoration: t.done ? 'line-through' : 'none' }}>{t.text}</span>
                      {t.source && t.source !== 'user' && (
                        <span style={{ fontSize: 10, color: 'var(--secondary)', flexShrink: 0 }}>
                          {deptLabels[t.source] ?? t.source}
                        </span>
                      )}
                      <button onClick={() => taskStore.remove(t.id)}
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
                }} onClick={addSampleApproval}>큰 결제 테스트</button>
              </div>
              {approvals.length === 0 ? (
                <div className="mem-beta-note" style={{ margin: 0 }}>
                  대기 중인 승인이 없어요. 에이전트가 돈을 쓰거나 되돌리기 어려운 일을
                  하려 할 때 여기로 올립니다.
                </div>
              ) : approvals.map(a => {
                const done = a.status && a.status !== 'pending';
                return (
                  <div key={a.id} style={{
                    display: 'flex', alignItems: 'center', gap: 8,
                    padding: '8px 12px', background: 'var(--bg3)', borderRadius: 8,
                    marginBottom: 6, fontSize: 12,
                    opacity: done ? 0.55 : 1,
                  }}>
                    <span style={{ flex: 1 }}>
                      {a.kind === 'file' && (
                        <span style={{ color: 'var(--secondary)', marginRight: 6 }}>📄</span>
                      )}
                      {a.department && (
                        <span style={{ color: deptColors[a.department] ?? 'var(--secondary)', marginRight: 6 }}>
                          [{deptLabels[a.department] ?? a.department}]
                        </span>
                      )}
                      {a.label}
                      {done && <span style={{ marginLeft: 6, color: 'var(--muted2)' }}>
                        — {a.status === 'approved' ? '승인함' : '거절함'}
                      </span>}
                      {/* 바깥으로 나가는 행위. 파일 저장과 달리 되돌릴 수
                          없으므로, 승인 전에 무엇이 어디로 나가는지 전부
                          보인다 — 특히 공개 범위. */}
                      {a.kind === 'action' && (
                        <div className="appr-action">
                          <b>{a.integration}.{a.action}</b> — 승인하면 즉시 실행됩니다.
                          {a.action_args?.privacy != null && (
                            <> 공개 범위 <b>{String(a.action_args.privacy)}</b>.</>
                          )}
                          <details>
                            <summary style={{ cursor: 'pointer', marginTop: 4 }}>보낼 내용</summary>
                            <pre>{JSON.stringify(a.action_args ?? {}, null, 2)}</pre>
                          </details>
                        </div>
                      )}
                      {a.result && (
                        <div className={`appr-result ${a.result.startsWith('실패') ? 'fail' : 'ok'}`}>
                          {a.result}
                        </div>
                      )}
                      {a.kind === 'file' && !done && a.file_content && (
                        <details style={{ marginTop: 6 }}>
                          <summary style={{ cursor: 'pointer', fontSize: 11, color: 'var(--muted)' }}>
                            내용 보기 ({a.file_content.split('\n').length}줄)
                          </summary>
                          <pre style={{
                            margin: '6px 0 0', padding: 8, maxHeight: 200, overflow: 'auto',
                            background: 'var(--bg2)', border: '1px solid var(--border)',
                            borderRadius: 6, fontSize: 11, lineHeight: 1.5,
                            fontFamily: 'JetBrains Mono, monospace', whiteSpace: 'pre',
                          }}>{a.file_content}</pre>
                        </details>
                      )}
                    </span>
                    {!done && (
                      <>
                        <button className="hm-approve-btn ok" onClick={async () => {
                          const r = await approvalStore.update(a.id, { status: 'approved' });
                          const f = r?.followup;
                          showToast(
                            f?.ran ? `✅ ${f.ran}`
                            : f?.wrote ? `✅ 저장했습니다 — ${f.wrote}`
                            : f?.queued ? `✅ 승인 — ${deptLabels[f.department ?? ''] ?? '해당 부서'}에 실행 지시를 보냈습니다`
                            : f?.reason ? `⚠️ ${f.reason}`
                            : '✅ 승인했습니다');
                          taskStore.refresh();
                        }}>승인</button>
                        <button className="hm-approve-btn no" onClick={async () => {
                          await approvalStore.update(a.id, { status: 'rejected' });
                          showToast('거절했습니다 — 후속 작업은 만들지 않습니다');
                        }}>거절</button>
                      </>
                    )}
                    <button
                      onClick={() => approvalStore.remove(a.id)}
                      style={{ background: 'none', border: 'none', color: 'var(--muted2)',
                               cursor: 'pointer', fontSize: 14 }}
                      aria-label="승인 항목 삭제"
                    >✕</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ══ 내 서비스 ══ */}
        {tab === '내 서비스' && (
          <div className="mem-content">
            <p className="mem-hint">내가 운영하는 서비스 목록입니다. 등록하면 에이전트의 시스템 프롬프트에 들어가 답변에 반영됩니다. (깃헙 레포를 직접 고치는 연동은 아직 없습니다.)</p>

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
                    <button onClick={() => serviceStore.remove(svc.id)}
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
            <p className="mem-hint" style={{ marginBottom: 10 }}>
              모든 외부 연결을 한 곳에서. <strong>저장</strong>은 값을 넣는 것이고,
              <strong> 연결 확인</strong>은 그 값으로 실제 호출을 해 보는 것입니다 —
              배지가 <em>연결 확인됨</em>이 되어야 에이전트가 그 데이터를 씁니다.
            </p>
            <button
              onClick={() => setGuide('common')}
              style={{
                marginBottom: 14, padding: '9px 14px', width: '100%',
                background: 'var(--primary-dk)', border: '1px solid rgba(139,92,246,0.35)',
                borderRadius: 8, color: 'var(--primary)', fontSize: 12.5,
                fontWeight: 600, cursor: 'pointer',
              }}>📖 연동 가이드 열기 — 발급 절차 · 권한 · 확인 방법</button>

            {/* ⚡ YouTube + PayPal 동시 연결 */}
            <div style={{
              background: 'rgba(15,253,106,0.04)', border: '1px solid rgba(15,253,106,0.2)',
              borderRadius: 12, padding: 14, marginBottom: 16,
            }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--green)', marginBottom: 6 }}>
                ⚡ 자격증명 저장 + 분석 지시
              </div>
              {/* 예전 문구는 "동시 연결하고 분석을 수립합니다" 였다. 실제로는
                  키를 저장하고 LLM 에게 텍스트로 "분석해줘" 라고 시킬 뿐이었고,
                  YouTube API 를 부르지 않아 그 분석은 추측이었다. 이제 연결이
                  확인된 연동은 서버가 먼저 조회해서 실제 수치를 프롬프트에
                  넣는다 — 그러니 '무엇을 근거로 분석하는지'를 그대로 적는다. */}
              <p style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 10, lineHeight: 1.6 }}>
                아래 입력한 키를 저장하고, 연구부와 금융부에 분석을 지시합니다.
                <strong style={{ color: 'var(--text)' }}> 연결 확인된 연동만</strong> 실제 수치가
                근거로 들어갑니다 — 확인되지 않은 것은 추측이 됩니다.
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
                {batchRunning ? '⏳ 에이전트 작업 중...' : '💾 저장하고 분석 지시'}
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
              saved={!!connKeys.TELEGRAM_BOT_TOKEN}
              onGuide={() => setGuide('telegram')}
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
              status={integStatus.youtube_data} saved={!!connKeys.YOUTUBE_API_KEY}
              onGuide={() => setGuide('youtube-data')}
              onProbe={() => void probeOne('youtube_data')}
              probing={probing === 'youtube_data'}
              onSave={() => save('YouTube API', { YOUTUBE_API_KEY: ytKey, YOUTUBE_CHANNEL_ID: ytChannel })}
              onHelp="https://console.cloud.google.com/"
            >
              <Field label="API Key" value={ytKey} onChange={setYtKey} secret
                hint="Cloud Console → YouTube Data API v3 → API 키" />
              <Field label="Channel ID" placeholder="UCxxx..." value={ytChannel} onChange={setYtChannel} />
            </IntegCard>

            {/* YouTube Analytics OAuth */}
            <IntegCard icon="📊" title="YouTube Analytics (OAuth)" desc="시청 지속률·트래픽·구독 증감. 저장 후 '⚡ 자동 연결'로 구글 로그인."
              status={integStatus.youtube_oauth} saved={!!ytOauth?.connected}
              onGuide={() => setGuide('youtube-oauth')}
              onProbe={() => void probeOne('youtube_oauth')}
              probing={probing === 'youtube_oauth'}
              onSave={() => save('YouTube OAuth', { YOUTUBE_OAUTH_CLIENT_ID: ytOauthId, YOUTUBE_OAUTH_CLIENT_SECRET: ytOauthSec })}
              extraActions={
                <button
                  onClick={connectYouTube}
                  disabled={ytBusy || !ytOauth?.has_client}
                  title={ytOauth?.has_client
                    ? '구글 로그인 창을 엽니다'
                    : 'Client ID/Secret 을 먼저 저장하세요'}
                  style={{
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
              status={integStatus.paypal} saved={!!connKeys.PAYPAL_CLIENT_ID}
              onGuide={() => setGuide('paypal')}
              onProbe={() => void probeOne('paypal')}
              probing={probing === 'paypal'}
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
              saved={!!connKeys.TOSS_SECRET_KEY}
              onGuide={() => setGuide('toss')}
              onSave={() => save('토스페이먼츠', { TOSS_SECRET_KEY: tossKey })}
              onHelp="https://docs.tosspayments.com/"
            >
              <Field label="시크릿 키" value={tossKey} onChange={setTossKey} secret
                hint="토스페이먼츠 개발자센터 → API 키 → 시크릿 키(live_sk_... 실거래 / test_sk_... 테스트)" />
            </IntegCard>

            {/* GitHub */}
            <IntegCard icon="🐙" title="GitHub — ⚡ 단기 기억" desc="지식 네트워크(단기 기억)를 GitHub 레포에 버전관리로 동기화. 어디서든 불러오고 사람이 직접 편집도."
              status={integStatus.github} saved={!!connKeys.GITHUB_TOKEN}
              onGuide={() => setGuide('github')}
              onProbe={() => void probeOne('github')}
              probing={probing === 'github'}
              onSave={() => save('GitHub', { GITHUB_TOKEN: ghToken, GITHUB_REPO: ghRepo })}
              onHelp="https://github.com/settings/tokens"
            >
              <Field label="Personal Access Token" value={ghToken} onChange={setGhToken} secret
                hint="github.com/settings/tokens → repo(Contents) 권한" />
              <Field label="지식 저장소" placeholder="owner/repo" value={ghRepo} onChange={setGhRepo} />
            </IntegCard>

            {/* HuggingFace */}
            <IntegCard icon="🤗" title="HuggingFace — 🎯 장기 기억" desc="파인튜닝 모델 & 데이터셋을 HuggingFace Hub에 업로드·로드합니다."
              saved={!!connKeys.HUGGINGFACE_TOKEN}
              onGuide={() => setGuide('huggingface')}
              onSave={() => save('HuggingFace', { HUGGINGFACE_TOKEN: hfToken })}
              onHelp="https://huggingface.co/settings/tokens"
            >
              <Field label="Access Token" placeholder="hf_..." value={hfToken} onChange={setHfToken} secret
                hint="huggingface.co/settings/tokens → write 권한" />
            </IntegCard>
          </div>
        )}


      </div>
    </div>
  );
}
