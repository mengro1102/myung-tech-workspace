import { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { useStore } from '../useStore';
const GuideModal = lazy(() => import('./GuideModal'));
import { api, deptColors, deptLabels, type ApprovalRow, type IntegrationStatus, type CalendarEvents, type CalendarStatus, type KbTree, type RouterStatus, type ServiceRow, type TaskRow } from '../api';

interface Props {
  onClose: () => void;
  agentCount: number;
  globalModel: string;
  /** '팀 열기' 를 누르면 팀 화면으로 넘긴다. 예전에는 onClose 만 불러서
   *  창이 닫히기만 하고 아무 데도 가지 않았다. */
  /* onOpenTeam 은 뺐다. '우리 팀' 은 '팀 열기' 버튼 하나였는데,
     에이전트 탭이 같은 것을 더 자세히 보여 준다. 모달 안에서 모달을 또
     여는 길이기도 했다. */
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

interface TaskItem { id: string; text: string; done: boolean; }
interface Approval { id: string; label: string; }

/* ── 자격증명 저장 헬퍼 ── */
async function saveCredentials(service: string, payload: Record<string, string>): Promise<string> {
  try {
    const r = await fetch('/api/config/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (r.ok) return `✅ ${service} 저장 완료`;
    // 예전에는 "❌ 저장 실패" 한 마디였다. 서버는 이유를 말해 주는데(틀린 칸에
    // 넣은 값, 허용되지 않은 키) 화면이 그걸 버렸다.
    const body = await r.json().catch(() => null);
    return `❌ ${service} — ${body?.error ?? '저장 실패'}`;
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
function Field({ label, hint, placeholder, value, onChange, secret, saved }: {
  label: string; hint?: string; placeholder?: string;
  value: string; onChange: (v: string) => void; secret?: boolean;
  /** 서버에 이미 저장된 값의 흔적(끝 4자리·길이). 입력칸이 빈칸으로 열려도
   *  "저장돼 있다" 는 것이 보여야 한다 — 안 보이면 다시 채우려다 엉뚱한 칸에 넣는다. */
  saved?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div style={{ marginTop: 10 }}>
      <label style={{ fontSize: 11, color: 'var(--muted)', display: 'block', marginBottom: 4 }}>{label}</label>
      <div style={{ position: 'relative' }}>
        <input
          className="hm-input font-mono"
          type={secret && !show ? 'password' : 'text'}
          placeholder={saved ? `저장됨 ${saved} — 바꿀 때만 입력` : placeholder}
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
      {saved && !value && (
        <div style={{ fontSize: 10, color: 'var(--green, #0ffd6a)', marginTop: 3 }}>
          ✓ 저장된 값 있음 {saved} · 비워 두고 저장하면 그대로 유지됩니다
        </div>
      )}
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

/** 일정 시각을 짧게. 종일 일정은 시각을 쓰지 않는다 — '오전 12:00' 이
 *  붙으면 자정에 뭔가 있는 것처럼 읽힌다. */
function calWhen(iso: string, allDay?: boolean): string {
  if (!iso) return '';
  const d = new Date(allDay ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return iso;
  const today = new Date();
  const days = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
     - new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime())
    / 86400000);
  const day = days === 0 ? '오늘' : days === 1 ? '내일'
    : `${d.getMonth() + 1}/${d.getDate()}`;
  if (allDay) return `${day} 종일`;
  const h = d.getHours();
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  const ampm = h < 12 ? '오전' : '오후';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${day} ${ampm} ${h12}:${mm}`;
}

/** 몇 분 전인지. 타일과 패널이 같은 말투를 쓰게 한 곳에 둔다. */
function ago(ts?: number): string {
  if (!ts) return '';
  const sec = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (sec < 90) return '방금';
  if (sec < 3600) return `${Math.floor(sec / 60)}분 전`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전`;
  const d = Math.floor(sec / 86400);
  return d < 30 ? `${d}일 전` : `${Math.floor(d / 30)}달 전`;
}

/** FreeLLMAPI 라우터 현황.
 *
 *  화면 위쪽의 "AI 모델" 점은 Ollama 를 본다. 그런데 부서 다섯 중 넷이
 *  `auto:hermes` 로 **이 라우터**를 탄다. 무료 한도를 공급자별로 나눠
 *  쓰는 구조라, 한 곳이 막히면 그 즉시 병목이 되는데 화면 어디에도 그게
 *  없었다.
 *
 *  라우터가 죽었을 때 **빈 칸을 보여 주지 않는다.** 무엇이 안 되는지
 *  적는다 — 빈 칸은 "원래 이런가 보다" 로 읽힌다. */
function RouterPanel({ state }: { state: RouterStatus | null }) {
  if (!state) {
    return (
      <div className="rt-panel">
        <div className="rt-head">🔀 FreeLLMAPI 라우터<span>불러오는 중…</span></div>
      </div>
    );
  }
  const bad = state.providers.filter(p => p.enabled && p.status !== 'healthy');
  return (
    <div className={`rt-panel ${state.ok ? '' : 'down'}`}>
      <div className="rt-head">
        🔀 FreeLLMAPI 라우터
        <span>{state.ok
          ? `포트 ${state.port} · 공급자 ${state.healthy}/${state.providers.length} 정상`
          : (state.reason ?? '응답 없음')}</span>
      </div>

      {state.ok && (
        <>
          <div className="rt-kpis">
            <div className="rt-kpi">
              <b>{state.available}</b>
              <span>지금 쓸 수 있는 모델</span>
            </div>
            <div className="rt-kpi dim">
              <b>{state.total}</b>
              <span>카탈로그 전체</span>
            </div>
            <div className="rt-kpi">
              <b>{state.calls_today}</b>
              <span>오늘 호출 (UTC)</span>
            </div>
          </div>

          <div className="rt-provs">
            {state.providers.map(p => (
              <span key={p.name}
                    className={`rt-prov ${!p.enabled ? 'off' : p.status === 'healthy' ? 'ok' : 'bad'}`}
                    title={p.enabled ? p.status : '꺼져 있습니다'}>
                {p.name}
              </span>
            ))}
          </div>

          {bad.length > 0 && (
            <div className="rt-warn">
              {bad.map(p => p.name).join(' · ')} 가 정상이 아닙니다 —
              이 공급자로 가던 호출이 다른 곳으로 몰립니다.
            </div>
          )}

          {state.today.length > 0 && (
            <div className="rt-today">
              {state.today.map(t => (
                <div key={t.name} className="rt-today-row">
                  <span className="rt-today-n">{t.name}</span>
                  <span className="rt-today-c">{t.calls}회</span>
                  <span className="rt-today-t">
                    입력 {t.in.toLocaleString()} · 출력 {t.out.toLocaleString()} 토큰
                  </span>
                </div>
              ))}
            </div>
          )}

          {state.recent.length > 0 && (
            <div className="rt-recent">
              <span className="rt-recent-label">최근</span>
              {state.recent.slice(0, 6).map((r, i) => (
                <span key={i} className={`rt-dot ${r.status === 'success' ? 'ok' : 'bad'}`}
                      title={`${r.at} · ${r.name} · ${r.status}`} />
              ))}
              <span className="rt-recent-last">
                {state.recent[0].name} · {state.recent[0].at.slice(5, 16)}
              </span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ══════════════════════════════════════════════════════ */
export default function ManageModal({ onClose, agentCount, globalModel }: Props) {
  const [tab,         setTab]         = useState<Tab>('대시보드');
  const [toast,       setToast]       = useState('');
  const [connKeys,    setConnKeys]    = useState<Record<string, boolean>>({});
  const [notifyState, setNotifyState] = useState<{
    primary?: string | null;
    discord?: { ready?: boolean; target?: string | null; dm?: boolean };
    telegram?: { ready?: boolean };
  }>({});
  const [connHints,   setConnHints]   = useState<Record<string, string>>({});
  const [ytOauth,     setYtOauth]     = useState<{ connected: boolean; has_client: boolean } | null>(null);
  const [ytBusy,      setYtBusy]      = useState(false);
  /* 구글 캘린더. 유튜브와 **같은** OAuth 클라이언트를 쓴다 — 서버의
     CAL_SCOPE 주석에 이유를 적었다. 그래서 여기 Client ID/Secret 입력란을
     따로 두지 않는다. */
  const [calState,    setCalState]    = useState<CalendarStatus | null>(null);
  const [calBusy,     setCalBusy]     = useState(false);
  const [calEvents,   setCalEvents]   = useState<CalendarEvents | null>(null);

  /* 연동의 **실제** 상태. 서버가 저장된 키로 한 번 호출해 본 결과다.
   * connKeys(=.env 에 값이 있는가)와 구분해서 쓴다 — 저장과 연결은 다르다. */
  const [integStatus, setIntegStatus] = useState<Record<string, IntegrationStatus>>({});
  const [probing,     setProbing]     = useState('');
  /* 가이드를 열 절. '' 면 닫힘. 카드마다 자기 절로 바로 연다 — 문서 전체를
     열어 주고 찾으라고 하면 결국 다시 물어보게 된다. */
  const [guide,       setGuide]       = useState('');

  /* 라우터와 위키는 모달이 열릴 때 한 번만 받는다. 라우터 조회는
     sqlite 를 읽고 HTTP 를 한 번 치므로, 주기적으로 돌리면 모달을 열어
     둔 동안 계속 두드리게 된다(서버가 20초 캐시를 두지만 그래도). */
  useEffect(() => {
    void api.routerStatus().then(setRouterState);
    void api.knowledgeTree().then(setKbTree);
    void api.calendarStatus().then(st => {
      setCalState(st);
      // 연결돼 있을 때만 일정을 부른다. 아니면 구글을 괜히 두드린다.
      if (st?.connected) void api.calendarEvents().then(setCalEvents);
    });
  }, []);

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

  /* 비즈니스 아이디어 생성은 뺐다.
   *
   * `/api/business/ideas` 로 태스크를 만들어 90초 폴링하던 버튼이었다.
   * 그 경로는 프로젝트 파이프라인(계획 → 근거 → 결재)을 타지 않는다 —
   * **안전장치를 우회해 모델을 돌리는 두 번째 입구**였다. 같은 일을
   * 프로젝트 탭의 '새 프로젝트' 가 근거와 결재를 거쳐서 한다. */

  /* FreeLLMAPI 라우터. 화면의 "AI 모델" 점은 Ollama 를 보는데, 실제로
   * 답을 만드는 것은 대부분 이쪽이다. 무료 한도를 나눠 쓰는 구조라
   * 어느 공급자가 죽었는지가 바로 병목이 된다. */
  const [routerState, setRouterState] = useState<RouterStatus | null>(null);
  /* 지식베이스. 타일에 **로컬** 수정 시각을 띄운다 — 전에는 깃허브
   * 토큰 유무로 '연결됨' 이라고 했는데, 그건 위키가 언제 자랐느냐와
   * 아무 상관이 없다. */
  const [kbTree,      setKbTree]      = useState<KbTree | null>(null);

  /* 서버 저장소. 에이전트도 같은 곳에 쓴다 — 화면에서 지운 할 일이 다시
   * 살아나지 않고, 에이전트가 올린 결재가 여기 뜬다. */
  const taskStore     = useStore<TaskRow>('tasks');
  const serviceStore  = useStore<ServiceRow>('services');
  const approvalStore = useStore<ApprovalRow>('approvals');
  const tasks     = taskStore.items;
  const services  = serviceStore.items;
  const approvals = approvalStore.items;


  // 내 서비스
  const [svcName,     setSvcName]     = useState('');
  const [svcUrl,      setSvcUrl]      = useState('');
  const [svcGithub,   setSvcGithub]   = useState('');
  const [svcDesc,     setSvcDesc]     = useState('');

  // 연동 자격증명
  const [tgToken,     setTgToken]     = useState('');
  const [tgChatId,    setTgChatId]    = useState('');
  const [tgAllowed,   setTgAllowed]   = useState('');
  const [ytKey,       setYtKey]       = useState('');
  const [ytChannel,   setYtChannel]   = useState('');
  const [ytOauthId,   setYtOauthId]   = useState('');
  const [ytOauthSec,  setYtOauthSec]  = useState('');
  const [ppClientId,  setPpClientId]  = useState('');
  const [ppClientSec, setPpClientSec] = useState('');
  const [ppMode,      setPpMode]      = useState<'live'|'sandbox'>('live');
  const [tossKey,     setTossKey]     = useState('');
  const [ghToken,     setGhToken]     = useState('');
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
    fetch('/api/config/load').then(r => r.json()).then(d => { setConnKeys(d.keys ?? {}); setConnHints(d.hints ?? {}); }).catch(() => {});
    fetch('/api/notify/status').then(r => r.json()).then(setNotifyState).catch(() => {});
    api.ytOauthStatus().then(d => d && setYtOauth(d));
    void refreshIntegrations();
  }, [refreshIntegrations]);

  /* YouTube Analytics 연결.
   *
   * 구글은 인가 코드를 브라우저 리다이렉트로 돌려준다. 그래서 세 걸음이다 —
   * 서버가 콜백 받을 자리를 열고 로그인 주소를 주면, 사람이 새 창에서
   * 로그인하고, 우리는 코드가 돌아왔는지 물어본다. */
  /** 구글 캘린더 연결. 유튜브와 같은 흐름이다 — 새 창에서 동의를 마치면
   *  서버가 refresh_token 을 받아 .env 에 넣는다. 3초마다 최대 3분 기다린다. */
  const connectCalendar = async () => {
    setCalBusy(true);
    try {
      const start = await api.calOauthStart();
      if (!start?.ok || !start.auth_url) {
        showToast(`❌ ${start?.error ?? '연결을 시작하지 못했습니다'}`);
        return;
      }
      window.open(start.auth_url, '_blank', 'noopener,width=520,height=680');
      showToast('🔐 새 창에서 구글 로그인을 마쳐 주세요');
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 3000));
        const fin = await api.calOauthFinish();
        if (fin?.ok) {
          showToast('✅ 구글 캘린더 연결됨 — 일정을 읽어 옵니다');
          setCalState(await api.calendarStatus());
          // 바로 일정을 띄운다. 연결만 되고 아무것도 안 보이면 진짜
          // 되는지 알 수 없다.
          setCalEvents(await api.calendarEvents());
          return;
        }
        if (fin && !fin.pending) {
          showToast(`❌ ${fin.error ?? '연결 실패'}`);
          return;
        }
      }
      showToast('❌ 시간 초과 — 다시 시도해 주세요');
    } finally {
      setCalBusy(false);
    }
  };

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
          showToast('✅ YouTube 연결됨 — 지표·업로드 권한을 받았습니다');
          setYtOauth(await api.ytOauthStatus());
          // 카드 배지는 실제 호출 결과(integStatus)를 따른다. 토큰을 받았으면
          // 그 자리에서 한 번 불러 봐야 '연결 확인됨' 으로 바뀐다.
          void refreshIntegrations();
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
    if (msg.startsWith('✅')) {
      for (const setter of [setTgToken, setTgChatId, setYtKey, setYtChannel, setYtOauthId,
                            setYtOauthSec, setPpClientId, setPpClientSec, setTossKey,
                            setGhToken, setHfToken, setTgAllowed]) setter('');
    }
    fetch('/api/config/load').then(r => r.json()).then(d => { setConnKeys(d.keys ?? {}); setConnHints(d.hints ?? {}); }).catch(() => {});
    void refreshIntegrations();
  }, [refreshIntegrations]);

  /* 비즈니스 아이디어 생성 */
  /* 아이디어 응답 파서(parseIdeas)도 함께 뺐다 — 부르는 곳이 사라졌다.
     생성 버튼의 제거 사유는 위 routerState 주석에. */



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
    fetch('/api/config/load').then(r => r.json()).then(d => { setConnKeys(d.keys ?? {}); setConnHints(d.hints ?? {}); }).catch(() => {});
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

  /* "큰 결제 테스트" 버튼이 여기 있었다 — 가짜 ₩250,000 결제 건을 진짜
   * 결재함에 넣는 버튼이다(2026-10-21 제거).
   *
   * 위에 있던 주석은 "아직 에이전트가 결재를 올리는 경로가 없다" 였고
   * 9월엔 맞았다. 지금은 project_runner._finish() 가 파일 저장 제안을
   * 올리고 실제로 대기 건이 있다. 게다가 이 버튼은 kind 를 주지 않아
   * 가짜 건이 **1등급(내부·일괄승인 가능)** 으로 떨어졌다 — 결제처럼
   * 보이는 항목이 가장 낮은 등급에 앉는 셈이었다.
   *
   * 결재함을 시험하려면 테스트_시나리오.md 의 B-4 를 쓰면 된다. 실제
   * 결재 건으로 등급 묶음·일괄승인 건수 확인까지 같은 것을 본다. */

  /* 할 일 추가는 '할 일'(프로젝트 탭) 로 옮겼다. 여기 타일의 숫자는
     그대로 둔다 — 한눈에 몇 건 남았는지는 여기서도 쓸모가 있다. */

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

            {/* 타일 그리드 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 8, marginBottom: 16 }}>
              {[
                { icon: '🏢', label: '명테크', sub: '워크스페이스' },
                { icon: '🤖', label: String(agentCount || 0), sub: '에이전트' },
                { icon: '📋', label: String(tasks.filter(t=>!t.done).length), sub: '열린 할 일' },
                // 전에는 `connKeys.GITHUB_TOKEN` 으로 '연결됨/미연결' 을 띄웠다.
                // 그건 **깃허브 토큰이 있느냐**는 말이지 위키가 언제 자랐느냐가
                // 아니다. 둘은 실제로 다르다 — 수집분 다수가 깃에 올라가 있지
                // 않다. 건수와 로컬 수정 시각을 보여 준다.
                { icon: '🧠',
                  label: kbTree?.available ? `${kbTree.total}건` : '확인 불가',
                  sub: kbTree?.available ? `지식베이스 · ${ago(kbTree.mtime)}` : '지식베이스' },
                { icon: '📦', label: String(services.length), sub: '등록 서비스' },
                { icon: '💳', label: connKeys.PAYPAL_CLIENT_ID ? '연결됨' : '미연결', sub: 'PayPal' },
                // 주 알림 채널은 디스코드다(notify.primary = discord). 전에는
                // 텔레그램만 보여 줘서 화면이 틀린 채널을 보고하고 있었다.
                // 키 유무로 추정하지 않는다 — 디스코드 토큰은 명테크가 아니라
                // hermes 의 .env 에 살아서 connKeys 에 아예 없다. notify 가
                // 실제 준비 상태와 주 채널을 안다.
                // DM 인지 서버 채널인지가 요점이다. 용도를 갈랐다 —
                // DM 은 명테크 알림(착수·완료·정지), 서버 채널은 맹비서 질의 스레드.
                { icon: '💬',
                  label: !notifyState.discord?.ready ? '미연결'
                    : notifyState.discord?.target === 'dm' ? 'DM' : '서버 채널',
                  sub: '디스코드 알림' },
                { icon: '📱', label: notifyState.telegram?.ready ? (notifyState.primary === 'telegram' ? '주 채널' : '보조') : '미연결', sub: '텔레그램' },
                // global_model 은 5개 부서 중 오케스트레이션 하나에만 간다.
                // 나머지 넷은 라우터(auto:hermes)라 이 값을 무시한다.
                { icon: '💻', label: globalModel, sub: '모델 (오케스트만)' },
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

            {/* FreeLLMAPI 라우터 */}
            <RouterPanel state={routerState} />

            {/* 승인 큐 */}
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>✅ 승인 큐 — 에이전트가 중요한 일 전에 결재 요청</span>
                <span style={{
                  marginLeft: 'auto', fontSize: 11, color: 'var(--muted)',
                }}>등급·일괄승인은 프로젝트 탭 결재함에서</span>
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
                          // 결재함과 같은 확인을 둔다 — 여기만 안 물으면
                          // 두 화면이 서로 다른 위험도를 갖게 된다.
                          if (!confirm(`"${a.label}"\n\n거절하면 이 일은 실행되지 않습니다. `
                                       + '계속할까요?')) return;
                          await approvalStore.update(a.id, { status: 'rejected' });
                          showToast('거절했습니다 — 후속 작업은 만들지 않습니다');
                        }}>거절</button>
                      </>
                    )}
                    {/* 이 ✕ 는 **하드 삭제**다(workspace_store.remove 가 행을
                        아예 없앤다). 바로 옆 거절보다 센 동작인데 생김새는
                        제일 약했고, 확인도 없었다. 결재함(ApprovalBox)에는
                        이런 버튼이 아예 없다 — 관리 탭에만 있었다.

                        대기 중인 건은 아예 못 지우게 한다. 지워야 할 이유가
                        있다면 거절이 맞는 동작이고, 거절은 기록이 남는다. */}
                    <button
                      onClick={() => {
                        const pending = (a.status ?? 'pending') === 'pending';
                        if (pending) {
                          showToast('⚠️ 대기 중인 결재는 지울 수 없습니다 — 승인하거나 거절해 주세요');
                          return;
                        }
                        if (!confirm(`"${a.label}" 기록을 목록에서 지웁니다.\n`
                                     + '되돌릴 수 없습니다. 계속할까요?')) return;
                        void approvalStore.remove(a.id);
                      }}
                      style={{ background: 'none', border: 'none', color: 'var(--muted2)',
                               cursor: 'pointer', fontSize: 14 }}
                      title={(a.status ?? 'pending') === 'pending'
                        ? '대기 중인 결재는 지울 수 없습니다'
                        : '기록을 목록에서 지웁니다'}
                      aria-label="결재 기록 삭제"
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
                    {/* 확인 없이 지우고 있었다. 결재 ✕ 와 같은 종류의 구멍이다 —
                        지운 서비스는 에이전트 시스템 프롬프트에서도 빠지므로,
                        다음 답변부터 그 서비스를 모르는 채로 답하게 된다. */}
                    <button
                      onClick={() => {
                        if (!confirm(`"${svc.name}" 을(를) 목록에서 지웁니다.
`
                                     + '에이전트가 더는 이 서비스를 알지 못합니다. 계속할까요?')) return;
                        void serviceStore.remove(svc.id);
                      }}
                      title="서비스 등록 해제"
                      aria-label={`${svc.name} 등록 해제`}
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

            {/* GitHub */}
            <IntegCard icon="🐙" title="GitHub (서비스 레포)" desc="'내 서비스' 에 등록한 레포를 읽고, 결재 승인 후 수정 PR 을 엽니다. 머지는 직접. (위키 동기화는 이 토큰과 무관 — 로컬 git 으로 합니다)"
              status={integStatus.github} saved={!!connKeys.GITHUB_TOKEN}
              onGuide={() => setGuide('github')}
              onProbe={() => void probeOne('github')}
              probing={probing === 'github'}
              onSave={() => save('GitHub', { GITHUB_TOKEN: ghToken })}
              onHelp="https://github.com/settings/tokens"
            >
              <Field label="Personal Access Token" value={ghToken} saved={connHints.GITHUB_TOKEN} onChange={setGhToken} secret
                hint="github_pat_… · Settings → Developer settings → Fine-grained tokens. 고칠 레포는 '내 서비스' 탭에 등록된 것을 씁니다" />
            </IntegCard>

            {/* HuggingFace */}
            <IntegCard icon="🤗" title="HuggingFace (나중 단계)" desc="파인튜닝 모델 업로드용. 지금은 쓰지 않습니다 — 장기기억은 위키 축적으로 먼저 동작합니다. 지금 넣지 않아도 됩니다."
              saved={!!connKeys.HUGGINGFACE_TOKEN}
              onGuide={() => setGuide('huggingface')}
              onSave={() => save('HuggingFace', { HUGGINGFACE_TOKEN: hfToken })}
              onHelp="https://huggingface.co/settings/tokens"
            >
              <Field label="Access Token" placeholder="hf_..." value={hfToken} saved={connHints.HUGGINGFACE_TOKEN} onChange={setHfToken} secret
                hint="huggingface.co/settings/tokens → write 권한" />
            </IntegCard>

            {/* Google Calendar — 전에는 '준비 중' 딱지 한 장이었다(백엔드가
                없었으니 맞는 표시였다). 이제 유튜브와 같은 흐름으로 붙는다.

                Client ID/Secret 입력란을 두지 않는다 — 유튜브 칸에 넣은
                **같은** 구글 클라이언트를 쓴다(서버 CAL_SCOPE 주석 참고).
                여기 또 두면 같은 값을 두 번 넣게 되고, 한쪽만 바꿨을 때
                어느 쪽이 쓰이는지 알 수 없어진다. */}
            <IntegCard icon="📅" title="Google Calendar (일정 읽기)"
              desc="다가오는 일정을 읽어 마감일 판단에 씁니다. 읽기 전용 — 일정을 만들거나 고치지 않습니다."
              saved={!!calState?.connected}
              onGuide={() => setGuide('common')}
              extraActions={
                <button
                  onClick={connectCalendar}
                  disabled={calBusy || !calState?.has_client}
                  title={calState?.has_client
                    ? (calState?.connected ? '다시 연결합니다' : '구글 로그인 창을 엽니다')
                    : '아래 YouTube OAuth 칸에 Client ID/Secret 을 먼저 저장하세요 — 같은 것을 씁니다'}
                  style={{
                    padding: '8px 14px', background: 'rgba(15,253,106,0.1)',
                    border: '1px solid rgba(15,253,106,0.3)', borderRadius: 8,
                    color: 'var(--green)', fontSize: 13,
                    cursor: calBusy || !calState?.has_client ? 'not-allowed' : 'pointer',
                    opacity: calBusy || !calState?.has_client ? 0.5 : 1,
                  }}>
                  {calBusy ? '⏳ 기다리는 중…'
                    : calState?.connected ? '🔁 다시 연결' : '⚡ 자동 연결'}
                </button>
              }
            >
              {!calState?.has_client && (
                <div className="mem-beta-note" style={{ margin: 0 }}>
                  구글 OAuth Client ID/Secret 이 아직 없습니다 — 아래
                  <strong> YouTube Analytics · 업로드 (OAuth)</strong> 칸에 넣으면
                  캘린더도 같은 것을 씁니다. 구글 콘솔에 클라이언트를 또 만들
                  필요는 없습니다.
                </div>
              )}

              {calState?.has_client && !calState?.connected && (
                <div className="mem-beta-note" style={{ margin: 0 }}>
                  ⚡ 자동 연결을 누르면 구글 동의 창이 열립니다. 범위는
                  <strong> 읽기 전용</strong>(calendar.readonly) 하나입니다.
                  구글 클라우드 콘솔에서 <strong>Google Calendar API</strong> 가
                  켜져 있어야 합니다.
                </div>
              )}

              {/* 연결됐는데 조회가 실패하면 **그 이유**를 적는다. 빈 목록을
                  보여 주면 "일정이 없나 보다" 로 읽히는데, 연결이 깨진 것과
                  일정이 없는 것은 전혀 다른 상태다. */}
              {calState?.connected && calEvents && !calEvents.ok && (
                <div className="mem-beta-note" style={{ margin: 0, color: '#F0B96B' }}>
                  ⚠️ {calEvents.error}
                  {/* 403 은 거의 항상 "이 프로젝트에서 Calendar API 가 꺼져
                      있다" 이고, 구글이 **켜러 갈 주소를 오류문에 담아 준다.**
                      그걸 글자로만 두면 사장님이 콘솔에서 그 화면을 찾아
                      헤매게 된다(실제로 그랬다). 눌러서 바로 가게 한다. */}
                  {(() => {
                    const m = calEvents.error?.match(
                      /https:\/\/console\.developers\.google\.com\/\S+/);
                    if (!m) return null;
                    return (
                      <div style={{ marginTop: 8 }}>
                        <a href={m[0].replace(/[.,)]$/, '')} target="_blank" rel="noreferrer"
                           style={{
                             display: 'inline-block', padding: '7px 13px',
                             background: 'rgba(245,158,11,0.15)',
                             border: '1px solid rgba(245,158,11,0.45)',
                             borderRadius: 8, color: '#F0B96B',
                             fontSize: 12, fontWeight: 700, textDecoration: 'none',
                           }}>
                          ↗ 구글 콘솔에서 Calendar API 켜기
                        </a>
                        <div style={{ marginTop: 6, fontSize: 11, color: 'var(--muted2)' }}>
                          그 화면에서 <b>사용 설정(Enable)</b> 을 누르고 1~2분 뒤
                          아래 <b>🔁 다시 확인</b> 을 누르세요. 다시 로그인할
                          필요는 없습니다 — 연결은 이미 돼 있습니다.
                        </div>
                        <button
                          onClick={async () => { setCalEvents(await api.calendarEvents()); }}
                          style={{
                            marginTop: 8, padding: '6px 12px',
                            background: 'var(--glass-bg)', border: '1px solid var(--border)',
                            borderRadius: 8, color: 'var(--text)',
                            fontSize: 12, cursor: 'pointer',
                          }}>🔁 다시 확인</button>
                      </div>
                    );
                  })()}
                </div>
              )}

              {calEvents?.ok && (
                <div className="cal-list">
                  <div className="cal-list-head">
                    다가오는 일정
                    <span>{calEvents.events.length}건 · {calEvents.calendar}</span>
                  </div>
                  {calEvents.events.length === 0 ? (
                    <div className="cal-empty">앞으로 2주간 잡힌 일정이 없습니다.</div>
                  ) : calEvents.events.slice(0, 6).map(ev => (
                    <div key={ev.id} className="cal-row">
                      <span className="cal-when">{calWhen(ev.start, ev.all_day)}</span>
                      <span className="cal-title">{ev.title}</span>
                      {ev.where && <span className="cal-where">{ev.where}</span>}
                    </div>
                  ))}
                </div>
              )}
            </IntegCard>

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

            {/* YouTube Data API */}
            <IntegCard icon="📺" title="YouTube Data API" desc="내 채널 지표에 더해, 지시문에 영상 링크 · 채널 링크 · @핸들 · '유튜브에서 ~ 찾아' 가 있으면 남의 영상·채널·검색 결과도 조회해 근거로 넣습니다. 비공개 지표와 업로드는 아래 OAuth."
              status={integStatus.youtube_data} saved={!!connKeys.YOUTUBE_API_KEY}
              onGuide={() => setGuide('youtube-data')}
              onProbe={() => void probeOne('youtube_data')}
              probing={probing === 'youtube_data'}
              onSave={() => save('YouTube API', { YOUTUBE_API_KEY: ytKey, YOUTUBE_CHANNEL_ID: ytChannel })}
              onHelp="https://console.cloud.google.com/"
            >
              <Field label="API Key" value={ytKey} saved={connHints.YOUTUBE_API_KEY} onChange={setYtKey} secret
                hint="Cloud Console → YouTube Data API v3 → API 키" />
              <Field label="Channel ID" placeholder="UCxxx..." value={ytChannel} saved={connHints.YOUTUBE_CHANNEL_ID} onChange={setYtChannel} />
            </IntegCard>

            {/* YouTube Analytics OAuth */}
            <IntegCard icon="📊" title="YouTube Analytics · 업로드 (OAuth)" desc="시청 지속률·트래픽·구독 증감 읽기 + 결재 승인 후 영상 업로드·수정. 저장 후 '⚡ 자동 연결'로 구글 로그인."
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
              <Field label="Client ID" value={ytOauthId} saved={connHints.YOUTUBE_OAUTH_CLIENT_ID} onChange={setYtOauthId} secret />
              <Field label="Client Secret" value={ytOauthSec} saved={connHints.YOUTUBE_OAUTH_CLIENT_SECRET} onChange={setYtOauthSec} secret
                hint="Cloud Console에서 승인된 리디렉션 URI에 http://127.0.0.1:5814/yt-oauth-callback 추가" />
            </IntegCard>

            {/* 토스페이먼츠 */}
            <IntegCard icon="🏦" title="토스페이먼츠" desc="키 저장만 됩니다. 조회 기능은 아직 없습니다 — PayPal 과 같은 방식으로 붙일 수 있습니다."
              saved={!!connKeys.TOSS_SECRET_KEY}
              onGuide={() => setGuide('toss')}
              onSave={() => save('토스페이먼츠', { TOSS_SECRET_KEY: tossKey })}
              onHelp="https://docs.tosspayments.com/"
            >
              <Field label="시크릿 키" value={tossKey} saved={connHints.TOSS_SECRET_KEY} onChange={setTossKey} secret
                hint="토스페이먼츠 개발자센터 → API 키 → 시크릿 키(live_sk_... 실거래 / test_sk_... 테스트)" />
            </IntegCard>

            {/* PayPal */}
            <IntegCard icon="💰" title="PayPal (수익 조회)" desc="잔액과 최근 30일 입금·수수료·순수익을 에이전트 분석의 근거로 넣습니다. 읽기 전용 — 송금·환불은 하지 않습니다."
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
              <Field label="Client ID" value={ppClientId} saved={connHints.PAYPAL_CLIENT_ID} onChange={setPpClientId} secret />
              <Field label="Client Secret" value={ppClientSec} saved={connHints.PAYPAL_CLIENT_SECRET} onChange={setPpClientSec} secret />
            </IntegCard>

            {/* 텔레그램 봇 */}
            <IntegCard icon="✈️" title="텔레그램 봇" desc="비서가 텔레그램으로 양방향 명령을 받고 보고합니다. 폰 어디서든 회사를 운영하세요."
              saved={!!connKeys.TELEGRAM_BOT_TOKEN}
              onGuide={() => setGuide('telegram')}
              onSave={() => save('텔레그램 봇', { TELEGRAM_BOT_TOKEN: tgToken, TELEGRAM_CHAT_ID: tgChatId,
                                            TELEGRAM_ALLOWED_USERS: tgAllowed })}
              onHelp="https://core.telegram.org/bots#how-do-i-create-a-bot"
            >
              <Field label="Bot Token" placeholder="123456789:ABCdef..." value={tgToken} saved={connHints.TELEGRAM_BOT_TOKEN} onChange={setTgToken} secret
                hint="@BotFather에서 /newbot으로 발급 (숫자:문자)" />
              <Field label="Chat ID" placeholder="비워두면 자동 감지" value={tgChatId} saved={connHints.TELEGRAM_CHAT_ID} onChange={setTgChatId}
                hint="봇한테 메시지 1번 보내고 비운 채 저장하면 자동 입력" />
              {/* 이 칸이 비어 있으면 텔레그램에서 아무도 결재를 누를 수 없다.
                  봇 토큰이 새더라도 남이 업로드·PR 을 승인하지 못해야 하므로,
                  기본값은 '아무도' 다. */}
              <Field label="결재 허용 사용자 ID (쉼표로 여러 명)" placeholder="예: 8791756428"
                value={tgAllowed} saved={connHints.TELEGRAM_ALLOWED_USERS} onChange={setTgAllowed}
                hint="봇에게 아무 메시지나 보내면 본인 ID 를 알려줍니다. 비우면 결재 버튼이 아무에게도 동작하지 않습니다" />
            </IntegCard>

          </div>
        )}


      </div>
    </div>
  );
}
