import { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense } from 'react';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import OpsMap         from './components/OpsMap';
// 2D 사무실은 Phaser(minify 후 1.5MB)를 끌고 온다. 정적으로 물리면 메인 탭만
// 볼 사람도 전부 내려받는다. 탭을 열 때만 가져오도록 지연 로드한다.
const OfficeView   = lazy(() => import('./components/OfficeView'));
import AgentTeamModal  from './components/AgentTeamModal';
import MemoryModal     from './components/MemoryModal';
import ModelModal      from './components/ModelModal';
import ManageModal     from './components/ManageModal';
import TaskDrawer      from './components/TaskDrawer';
import ToastContainer, { ToastItem } from './components/Toast';
import AgentManageTab  from './components/AgentManageTab';
import CeoOverrideModal from './components/CeoOverrideModal';
import NotificationBell, { Notification } from './components/NotificationBell';
const VirtualOffice = lazy(() => import('./pages/VirtualOffice'));
const ProjectsTab = lazy(() => import('./components/ProjectsTab'));
const NotesTab = lazy(() => import('./components/NotesTab'));
const KnowledgeTab = lazy(() => import('./components/KnowledgeTab'));
/* 맹비서의 얼굴. 얼굴이 필요한 곳은 전부 이것을 쓴다 — 이모지를
   각자 박아 두면 한 인격이 창마다 다른 얼굴로 보인다. */
import AssistantFace from './components/AssistantFace';
/* 대화 기록 서랍. 열 때까지 필요 없으므로 lazy 다. */
const SessionsDrawer = lazy(() => import('./components/SessionsDrawer'));
/* 채팅 말풍선의 마크다운. 프로젝트 탭 산출물 보기와 **같은 렌더러**를 쓴다 —
   두 벌을 두면 같은 글이 화면마다 다르게 보인다. */
const Markdown = lazy(() => import('./components/GuideModal')
  .then(m => ({ default: m.Markdown })));
const ApprovalBox = lazy(() => import('./components/ApprovalBox'));
const LessonsBox = lazy(() => import('./components/LessonsBox'));
import { api, AgentSummary, deptLabels, type ApprovalRow,
         type ProjectRow } from './api';
import './styles/hermes.css';

/* ── types ── */
interface ChatMsg {
  id:     string;
  role:   'user' | 'assistant';
  sender: string;
  text:   string;
  ts:     string;
}

interface TaskItem {
  task_id: string;
  instruction: string;
  status: 'pending' | 'in_progress' | 'done' | 'failed';
  target_dept: string;
  updated_at: string;
  /** 실패 시 사유, 완료 시 결과. 디스패처가 `[backend/model] 오류` 형태로 남긴다. */
  result?: string | null;
}

interface HealthStatus {
  server:         { ok: boolean };
  vllm:           { ok: boolean; error?: string };
  knowledge_base: { ok: boolean; path?: string; error?: string };
  workspace:      { ok: boolean };
}

const CHAT_HISTORY_KEY = 'myungtech_chat_history_v2';
/** 보내지 않은 입력. 새로고침에도 남는다 — 긴 지시를 쓰다가 F5 를 누르면
 *  그대로 사라지던 것을 막는다(탭 전환에는 원래도 살아남았다). */
const DRAFT_KEY = 'myungtech_draft_v1';

type TabId = 'main' | 'office' | 'agents' | 'projects' | 'knowledge';

/** 주소창의 `#projects` ↔ 탭.
 *
 *  전에는 URL 이 늘 `/` 라서 셋이 안 됐다 — 새로고침하면 메인으로
 *  튕기고(실측), 뒤로가기가 앱을 나가고, 탭을 가리키는 링크를 줄 수 없었다.
 *
 *  라우터를 들이지 않고 해시를 쓴다. `react-router-dom` 이 설치돼 있지만
 *  이 화면은 쓰지 않고, 경로 체계를 바꾸면 서버의 `_serve_ui` 폴백과
 *  터널 설정까지 같이 봐야 한다. 해시는 서버가 아예 보지 않는다. */
const TABS: readonly TabId[] = ['main', 'office', 'agents', 'projects', 'knowledge'];

function TAB_FROM_HASH(): TabId {
  // **첫 조각만 본다.** 지식베이스가 열어 둔 문서를
  // `#knowledge/concepts/ppo.md` 로 적으므로, 해시 전체를 탭 이름과
  // 비교하면 못 찾아서 메인으로 떨어진다 — 문서를 읽다 새로고침하면
  // 그대로 튕기는 것이 그 때문이었다.
  const h = window.location.hash.replace(/^#\/?/, '').split('/')[0] as TabId;
  return TABS.includes(h) ? h : 'main';
}

/** 브리핑의 발신자 이름.
 *
 *  브리핑은 **맹비서가 쓴 글이 아니다.** 명테크 서버가 `/api/briefing`
 *  으로 만든 상태 요약이다. 전에는 "명테크 AI" 라는 이름을 붙여 둬서,
 *  한 대화창에 AI 가 둘 있는 것처럼 보였다(사장님 지적).
 *
 *  이름만 "맹비서" 로 바꾸면 **맹비서가 쓰지 않은 글을 맹비서가 말한
 *  것처럼** 보이게 된다. 그래서 사람 인격에서 빼고 시스템 공지로 둔다.
 *  대화 상대는 맹비서 하나다. */
const BRIEFING_SENDER = '브리핑';

function loadChatHistory(): ChatMsg[] {
  try {
    const raw = localStorage.getItem(CHAT_HISTORY_KEY);
    if (raw) {
      const rows = JSON.parse(raw) as ChatMsg[];
      // 저장된 기록의 id 를 다시 매긴다.
      //
      // 예전 id 는 `Date.now()` 라 같은 밀리초의 두 줄이 겹쳐 있다. 그대로
      // 복원하면 새로고침할 때마다 "Encountered two children with the same
      // key" 가 난다 — 실제로 `1792646077002` 가 계속 찍혔다. 코드를 고쳐도
      // **이미 저장된 기록**은 그대로이므로 불러오는 자리에서 손봐야 한다.
      // 옛 이름을 바꿔 준다.
      //
      // 브리핑의 발신자가 "명테크 AI" 였다. 코드를 고쳐도 **이미 저장된
      // 기록**은 그대로라, 새로고침하면 옛 이름이 계속 보인다 — id 때와
      // 같은 이유다. 불러오는 자리에서 손본다.
      return rows.map((m, i) => ({
        ...m,
        id: `h-${i}`,
        sender: m.sender === '명테크 AI' ? BRIEFING_SENDER : m.sender,
      }));
    }
  } catch { /* ignore */ }
  return [];
}

function saveChatHistory(msgs: ChatMsg[]) {
  try { localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(msgs.slice(-100))); } catch { /* ignore */ }
}

/* 브리핑은 서버가 실제 상태로 만든다(GET /api/briefing).
 *
 * 예전에는 여기에 고정 문구가 있었다. 항상 "오전 02:20" 이고, 항상 같은 세
 * 줄이고, "GitHub 리포지토리를 연결하면" 이라고 권하는데 이미 연결돼 있었다.
 * 첫 화면에서 처음 읽는 글이 거짓이면 그 아래 숫자도 믿을 수 없게 된다.
 *
 * 아래 문구는 서버에 닿지 못했을 때만 쓴다 — 그때는 아무 말도 하지 않는 편이
 * 낫다. 없는 사실을 지어내느니 연결이 안 됐다고 말한다. */
const BRIEFING_OFFLINE = `■ 브리핑

백엔드에 닿지 못해 지금 상태를 읽을 수 없습니다.
START.bat 이 떠 있는지 확인해 주세요.`;

async function fetchBriefing(): Promise<string> {
  try {
    const r = await fetch('/api/briefing');
    if (!r.ok) return BRIEFING_OFFLINE;
    const d = await r.json();
    return (d.text as string) || BRIEFING_OFFLINE;
  } catch {
    return BRIEFING_OFFLINE;
  }
}

const QUICK_CHIPS = [
  { icon: '📊', label: '시장 트렌드 리포트 요청',              dept: 'research_dept' },
  { icon: '✍️', label: '콘텐츠 기획안 작성',                  dept: 'content_dept' },
  { icon: '💰', label: '매출·채널 현황 보고',                  dept: 'finance_dept' },
];

function nowStr() {
  return new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

/** 말풍선 본문. 조판 · 접기 · 복사를 맡는다.
 *
 *  전에는 `<div style={{whiteSpace:'pre-line'}}>{text}</div>` 한 줄이었다.
 *  그래서 셋이 한꺼번에 문제였다:
 *
 *    · 에이전트가 쓴 `### 제목`·`**굵게**`·`- 목록` 이 날글자로 보였다
 *      (실측: 렌더된 strong/ul/h3 가 0개)
 *    · 2,540자 답변이 2,022px 이라 채팅 영역(644px)의 3.1배를 덮었다
 *    · 4,000자 보고서를 옮기려면 손으로 드래그해야 했다
 *
 *  **사용자 말풍선은 조판하지 않는다.** 내가 친 `**강조**` 가 굵게 바뀌면,
 *  보낸 글과 보이는 글이 달라진다. */
const LONG_CHARS = 700;        // 이 아래는 접지 않는다 — 짧은 답까지 접으면 성가시다
const FOLD_PX = 420;           // 접었을 때 보여 주는 높이. 대략 12~14줄

function ChatBody({ text, role }: { text: string; role: ChatMsg['role'] }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const long = text.length > LONG_CHARS;

  const copy = async () => {
    try {
      // **원문(마크다운)을 복사한다.** 조판된 글자를 복사하면 붙여 넣는
      // 곳에서 제목·목록 구조가 사라진다.
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  // 사용자가 친 글은 그대로. 대기 문구(⏳)도 조판할 것이 없다.
  const plain = role === 'user' || text.startsWith('⏳');

  return (
    <div className={`hs-msg-content ${long && !open ? 'folded' : ''}`}>
      <div className="hs-msg-text">
        {plain
          ? <div style={{ whiteSpace: 'pre-line' }}>{text}</div>
          : <Suspense fallback={<div style={{ whiteSpace: 'pre-line' }}>{text}</div>}>
              <Markdown src={text} />
            </Suspense>}
      </div>

      {long && !open && <div className="hs-msg-fade" />}

      <div className="hs-msg-tools">
        {long && (
          <button className="hs-msg-tool" onClick={() => setOpen(v => !v)}>
            {open ? '▴ 접기' : `▾ 전체 보기 (${text.length.toLocaleString()}자)`}
          </button>
        )}
        <button className="hs-msg-tool" onClick={() => void copy()}
                title="원문(마크다운)을 복사합니다">
          {copied ? '✓ 복사됨' : '⧉ 복사'}
        </button>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════ */
function MainScreen() {
  const [agents,      setAgents]      = useState<AgentSummary[]>([]);
  const [messages,    setMessages]    = useState<ChatMsg[]>(() => {
    const saved = loadChatHistory();
    return saved.length > 0 ? saved : [{
      id: 'init', role: 'assistant', sender: BRIEFING_SENDER,
      text: '■ 브리핑\n\n지금 상태를 읽고 있습니다…', ts: nowStr(),
    }];
  });
  // 새로고침에도 남는다. 보낼 때 지운다(send 안쪽).
  const [input, setInput] = useState(() => {
    try { return localStorage.getItem(DRAFT_KEY) ?? ''; } catch { return ''; }
  });
  useEffect(() => {
    try {
      if (input) localStorage.setItem(DRAFT_KEY, input);
      else localStorage.removeItem(DRAFT_KEY);
    } catch { /* 사생활 보호 모드에서는 저장이 막힌다 — 그래도 입력은 된다 */ }
  }, [input]);
  // 맹비서 세션. 메인 채팅이 여기로 간다 — 전에는 /api/workflow/run 으로
  // 부서 태스크를 큐에 넣었고, 그 경로는 근거·검토·방법 절을 우회했다.
  const [assistantSid, setAssistantSid] = useState<string>('');
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [assistantUp, setAssistantUp] = useState<boolean | null>(null);
  // 기본 대화 상대는 맹비서다. 부서는 "일을 시키는" 쪽이라 성격이 다르다.
  const [dept,        setDept]        = useState('assistant');
  const [running,     setRunning]     = useState(false);
  // 이름은 cycleStatus 그대로다 — 사무실·OpsMap·PixelOffice 등 여섯 곳이
  // 이 문자열을 받아 '살아 있나' 를 판정한다. 뜻만 바뀌었다: 사장님이
  // 버튼을 눌렀나 → **정말로 일이 돌고 있나**.
  const [cycleStatus, setCycleStatus] = useState<string>('stopped');
  const [activity, setActivity] = useState<{
    projects_running?: number; projects_waiting?: number;
    tasks_busy?: number; approvals_pending?: number;
  }>({});
  const [showSidebar, setShowSidebar] = useState(true);
  const [taskSummary, setTaskSummary] = useState({ pending: 0, in_progress: 0, done: 0, failed: 0 });
  /* 태스크는 목록 하나만 받아 와서 화면 두 곳이 같은 답을 하게 한다.
   * 예전에는 사이드바가 /tasks/summary(전체), CEO 룸이 /tasks/list(상위 20건)
   * 을 따로 세서 서로 다른 숫자를 보여 줬고, 어느 쪽이 맞는지 알 수 없었다. */
  const refreshTasks = useCallback(() => {
    fetch('/api/tasks/list?limit=200').then(r => r.json()).then(d => {
      const rows: TaskItem[] = d.tasks ?? [];
      setTaskList(rows);
      setTaskSummary({
        pending:     rows.filter(t => t.status === 'pending').length,
        in_progress: rows.filter(t => t.status === 'in_progress').length,
        done:        rows.filter(t => t.status === 'done').length,
        failed:      rows.filter(t => t.status === 'failed').length,
      });
    }).catch(() => {});
  }, []);
  const [backendOk,   setBackendOk]   = useState(false);
  const [healthDetail, setHealthDetail] = useState<HealthStatus | null>(null);
  const [taskList,     setTaskList]   = useState<TaskItem[]>([]);
  const [drawerTaskId, setDrawerTaskId] = useState<string | null>(null);
  /* 태스크 현황에서 고른 상태. null 이면 전부.

     전에는 숫자를 누르면 그 상태의 **첫 태스크 하나**를 열었다. 둘이
     잘못이었다 — 0건이면 find 가 undefined 라 아무 일도 안 일어났고
     (지금 대기 0 · 처리중 0 이라 넷 중 둘이 죽은 버튼이었다), 10건일 때
     그중 하나를 임의로 여는 것도 "10건" 을 누른 사람이 기대하는 동작이
     아니다. 바로 아래 미니 리스트의 필터로 쓴다. */
  const [taskFilter, setTaskFilter] = useState<string | null>(null);
  const [toasts,       setToasts]     = useState<ToastItem[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  /* 알림의 읽음·삭제는 서버에 남긴다.
   *
   * 알림 자체는 이벤트에서 매번 다시 만들어진다. 읽음·삭제가 React 상태에만
   * 있으면 새로고침할 때마다 되살아난다 — 실제로 "모두 읽음·모두 삭제" 를
   * 눌러도 새로고침하면 그대로 돌아왔다.
   *
   * localStorage 에 두면 폰과 PC 가 각자 다른 상태를 갖는다. 밖에서 폰으로
   * 읽은 알림이 PC 에서 다시 안 읽음으로 뜨면 같은 문제가 된다. */
  const notifSeenRef = useRef<{ read: string[]; dismissed: string[] }>({ read: [], dismissed: [] });
  const [notifSeen, setNotifSeen] = useState<{ read: Set<string>; dismissed: Set<string> }>(
    { read: new Set(), dismissed: new Set() });

  const saveNotifSeen = useCallback((next: { read: string[]; dismissed: string[] }) => {
    // 무한정 쌓이지 않게 최근 것만 남긴다. 오래된 알림은 어차피 목록에서
    // 밀려나므로 그 id 를 계속 들고 있을 이유가 없다.
    const trim = (a: string[]) => a.slice(-300);
    const body = { read: trim(next.read), dismissed: trim(next.dismissed) };
    notifSeenRef.current = body;
    setNotifSeen({ read: new Set(body.read), dismissed: new Set(body.dismissed) });
    void api.storeUpdate('notif_state', 'state', body).then(r => {
      // 행이 아직 없으면 만든다. 서버에 없는 걸 PUT 하면 404 가 온다.
      if (!r?.ok) void api.storeAdd('notif_state', { id: 'state', ...body });
    });
  }, []);

  useEffect(() => {
    void api.storeList<{ id: string; read?: string[]; dismissed?: string[] }>('notif_state')
      .then(r => {
        const row = (r?.items ?? []).find(x => x.id === 'state');
        const body = { read: row?.read ?? [], dismissed: row?.dismissed ?? [] };
        notifSeenRef.current = body;
        setNotifSeen({ read: new Set(body.read), dismissed: new Set(body.dismissed) });
      });
  }, []);
  const [showNotifications, setShowNotifications] = useState(false);
  const [recentNotif,  setRecentNotif] = useState<Notification | null>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const recentNotifTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [showTeam,    setShowTeam]    = useState(false);
  const [showMemory,  setShowMemory]  = useState(false);
  const [showModel,   setShowModel]   = useState(false);
  const [showManage,  setShowManage]  = useState(false);
  const [activeTab,   setActiveTab]   = useState<TabId>(TAB_FROM_HASH);
  // CEO 룸 KPI 용. 결재·프로젝트는 태스크 큐와 다른 컬렉션이라, 이걸 세지
  // 않으면 프로젝트가 셋 돌아가는 중에도 대시보드가 전부 0 으로 보인다.
  const [ceoApprovals, setCeoApprovals] = useState<ApprovalRow[]>([]);

  /* 브라우저 탭 제목에 결재 대기 건수를 띄운다.
   *
   * 제목이 "명테크 Agent Studio v1.3" 로 **고정**이었다. 결재 2건이
   * 사장님을 기다리고 있어도 탭에서는 보이지 않는다 — 다른 창을 보고
   * 있으면 알 길이 없다. 버전 번호는 탭에서 할 일이 없으므로 뺐다
   * (index.html 의 제목도 같이 줄였다).
   *
   * 지금 어느 탭을 보고 있는지도 붙인다. 명테크를 두 창 띄워 두면
   * 제목이 같아서 구분이 안 됐다. */
  /* 탭 ↔ 주소창을 맞춘다.
   *
   *  `replaceState` 가 아니라 `hash` 대입을 쓴다 — 히스토리에 쌓여야
   *  **뒤로가기가 이전 탭으로** 간다. 그게 이 수정의 절반이다.
   *  첫 렌더에서는 건드리지 않는다(주소에 이미 그 탭이 들어 있다). */
  const hashSynced = useRef(false);
  useEffect(() => {
    if (!hashSynced.current) { hashSynced.current = true; return; }
    if (TAB_FROM_HASH() !== activeTab) window.location.hash = activeTab;
  }, [activeTab]);

  /* 뒤로/앞으로 버튼. 주소가 바뀌면 탭도 따라간다. */
  useEffect(() => {
    const onHash = () => setActiveTab(TAB_FROM_HASH());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  useEffect(() => {
    const n = ceoApprovals.length;
    const where = ({ main: '메인', office: '사무실', agents: '에이전트',
                     projects: '프로젝트', knowledge: '지식베이스' } as const)[activeTab];
    document.title = `${n > 0 ? `(${n}) ` : ''}명테크 · ${where}`;
  }, [ceoApprovals.length, activeTab]);
  const [ceoProjectList, setCeoProjectList] = useState<ProjectRow[]>([]);
  /* 카드를 눌렀을 때 '그것' 이 열리게 하는 표식. 예전에는 결재 카드는 아무
   * 반응이 없었고, 프로젝트 카드는 셋 다 똑같이 프로젝트 탭만 열어서 어느
   * 카드를 눌러도 같은 화면이 나왔다. */
  const [focusApproval, setFocusApproval] = useState<string | null>(null);
  const [focusProject, setFocusProject] = useState<string | null>(null);
  const [approvalOpen, setApprovalOpen] = useState(true);   // 결재함은 펼친 채 시작
  // 배운 것은 접은 채 시작한다 — 지금 막고 있는 일이 아니라 배경이다.
  const [lessonsOpen, setLessonsOpen] = useState(false);
  const [overrideTask, setOverrideTask] = useState<TaskItem | null>(null);
  const [showGridMenu, setShowGridMenu] = useState(false);

  /* Escape 로 닫는다.
   *
   * 모달 여섯 개(관리·지식 네트워크·LLM 모델·팀·CEO 개입·가이드)와 태스크
   * 상세·알림·메뉴 **어느 것도** Escape 를 받지 않았다. 노트 에디터만
   * 처리하고 있었다(NotesTab). 열고 나면 ✕ 를 찾아 누르는 수밖에 없었는데,
   * 모달이 화면을 덮는 동안 ✕ 는 구석에 있고 크기도 작다.
   *
   * 각 모달을 고치는 대신 여기 한 곳에서 받는다 — 모달 상태가 전부 이
   * 컴포넌트에 있으므로, 여섯 파일을 건드릴 이유가 없다.
   *
   * **덮인 순서의 역순으로 하나씩** 닫는다. 한 번에 다 닫으면, 관리 탭에서
   * 가이드를 열어 둔 사람이 Escape 한 번에 둘 다 잃는다. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // 글을 쓰는 중이면 그쪽이 먼저다(노트 에디터가 자기 Escape 를 쓴다).
      const el = document.activeElement as HTMLElement | null;
      if (el && /^(INPUT|TEXTAREA)$/.test(el.tagName)) return;

      if (showGridMenu)           { setShowGridMenu(false); return; }
      if (showNotifications)      { setShowNotifications(false); return; }
      if (drawerTaskId)           { setDrawerTaskId(null); return; }
      if (overrideTask)           { setOverrideTask(null); return; }
      if (showModel)              { setShowModel(false); return; }
      if (showMemory)             { setShowMemory(false); return; }
      if (showTeam)               { setShowTeam(false); return; }
      if (showManage)             { setShowManage(false); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showGridMenu, showNotifications, drawerTaskId, overrideTask,
      showModel, showMemory, showTeam, showManage]);
  const gridMenuRef = useRef<HTMLDivElement>(null);
  /* 공통 두뇌. 예전에는 여기 하드코딩된 값이 전부라 새로고침하면 사라졌고
   * 추론에는 아무 영향도 없었다. 이제 서버(runtime_config.json)에서 읽고,
   * 바꾸면 서버에 저장한다 — 디스패처가 같은 파일을 본다. */
  const [globalModel, setGlobalModelState] = useState('');
  useEffect(() => {
    api.getGlobalModel().then(d => { if (d?.global_model) setGlobalModelState(d.global_model); });
  }, []);

  /* 자리만 잡아 둔 브리핑을 진짜 내용으로 바꾼다. 사장님이 이미 대화를
   * 하고 계셨다면 건드리지 않는다 — 읽던 자리가 밀리면 안 된다. */
  useEffect(() => {
    let stop = false;
    void fetchBriefing().then(text => {
      if (stop) return;
      setMessages(prev => {
        // 전에는 `prev.length === 1 && id === 'init'` 일 때만 썼다. 즉
        // **대화 기록이 비었을 때만** 새 브리핑이 들어갔다. 한 번이라도
        // 쓰고 나면 localStorage 에 기록이 남으므로 그 뒤로는 영원히 옛
        // 브리핑을 본다 — 오후 7시 45분에 "새벽입니다" 를 읽었고, 그 아래
        // [지금 막힌 것] 숫자도 16시간 전 것이었다(실측).
        //
        // 브리핑은 대화가 아니라 현황판이다. 맨 앞 브리핑만 새것으로
        // 갈아 끼우고 주고받은 말은 그대로 둔다.
        const i = prev.findIndex(m => m.role === 'assistant'
                                   && m.text.startsWith('■ 브리핑'));
        if (i < 0) return [{ id: uid('b'), role: 'assistant' as const,
                             sender: BRIEFING_SENDER, text, ts: nowStr() }, ...prev];
        const next = [...prev];
        next[i] = { ...next[i], text, ts: nowStr() };
        return next;
      });
    });
    return () => { stop = true; };
  }, []);
  const setGlobalModel = useCallback(async (model: string) => {
    const prev = globalModel;
    setGlobalModelState(model);           // 낙관적 반영
    const r = await api.setGlobalModel(model);
    if (!r?.ok) {
      setGlobalModelState(prev);
      pushNotif('error', `공통 두뇌 변경 실패${r?.error ? ` — ${r.error}` : ''}`);
      return;
    }
    pushNotif('info', `공통 두뇌를 ${model} 로 바꿨습니다`);
  }, [globalModel]);
  const [time,        setTime]        = useState(nowStr());
  const [sidebarW,    setSidebarW]    = useState(220);   // 사이드바 너비 (px)
  const [isMobile,    setIsMobile]    = useState(() => window.innerWidth < 768);
  const navigate = useNavigate();
  const chatEndRef = useRef<HTMLDivElement>(null);
  // 스크롤 컨테이너. 끝 표시(높이 0)의 위치에 기대지 않고 직접 내린다 —
  // scrollIntoView({block:'nearest'}) 는 "이미 가깝다" 고 보고 긴 답에서
  // 안 움직였다.
  const chatBoxRef = useRef<HTMLDivElement>(null);
  // 사장님이 위로 올려 읽는 중이면 끌어내리지 않는다. 긴 답을 읽는 도중에
  // 화면이 튀면 그게 더 나쁘다.
  const chatAtBottom = useRef(true);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // `+` 메뉴. 부서 선택기가 입력줄을 늘 차지하던 것을 여기로 옮겼다.
  const [plusOpen, setPlusOpen] = useState(false);

  /** 쓰는 만큼 늘리고, 상한을 넘으면 안에서 스크롤한다.
   *
   *  `height='auto'` 로 **먼저 되돌려야** 한다 — 그러지 않으면 scrollHeight 가
   *  현재 높이에 갇혀 줄어들지 않는다(지웠는데 커진 채로 남는다).
   *
   *  상한 전에는 overflow 를 숨긴다. 켜 두면 한 줄짜리에도 가느다란 바가
   *  깜빡인다. */
  const growTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    const MAX = 200;                 // 약 8줄. 그 이상은 읽기도 쓰기도 불편하다
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX)}px`;
    el.style.overflowY = el.scrollHeight > MAX ? 'auto' : 'hidden';
  }, []);

  useEffect(() => { growTextarea(); }, [input, growTextarea]);
  const sidebarResizeRef = useRef<{ dragging: boolean; startX: number; startW: number }>({ dragging: false, startX: 0, startW: 220 });

  // 뷰포트 변화 감지 — matchMedia로 신뢰성 보장
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = (e: MediaQueryListEvent | MediaQueryList) => {
      setIsMobile(e.matches);
      if (e.matches) setShowSidebar(false);
    };
    onChange(mq); // 초기 상태 적용
    mq.addEventListener('change', onChange as (e: MediaQueryListEvent) => void);
    return () => mq.removeEventListener('change', onChange as (e: MediaQueryListEvent) => void);
  }, []);

  // 사이드바 드래그 리사이즈
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const r = sidebarResizeRef.current;
      if (!r.dragging) return;
      const delta = e.clientX - r.startX;
      const next  = Math.min(360, Math.max(140, r.startW + delta));
      setSidebarW(next);
    };
    const onUp = () => { sidebarResizeRef.current.dragging = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, []);

  const onResizeHandleDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    sidebarResizeRef.current = { dragging: true, startX: e.clientX, startW: sidebarW };
    document.body.style.cursor     = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [sidebarW]);

  useEffect(() => {
    const fetchAgents = () => api.listAgents().then(d => setAgents(d?.agents ?? [])).catch(() => {});
    const fetchHealth = () =>
      fetch('/api/health').then(r => r.json()).then(d => {
        setBackendOk(d.server?.ok ?? false);
        setHealthDetail(d as HealthStatus);
        // KB 오류 알림 (최초 1회)
        if (d.knowledge_base && !d.knowledge_base.ok && d.knowledge_base.error) {
          setNotifications(prev => {
            if (prev.some(n => n.id === 'kb-err')) return prev;
            const n: Notification = { id: 'kb-err', type: 'warning', message: `지식 네트워크: ${d.knowledge_base.error.slice(0, 60)}`, time: new Date(), read: false };
            setRecentNotif(n);
            if (recentNotifTimerRef.current) clearTimeout(recentNotifTimerRef.current);
            recentNotifTimerRef.current = setTimeout(() => setRecentNotif(null), 5000);
            return [n, ...prev];
          });
        }
      }).catch(() => { setBackendOk(false); setHealthDetail(null); });
    fetchAgents(); fetchHealth(); refreshTasks();
    const t  = setInterval(() => setTime(nowStr()), 30000);
    const ag = setInterval(fetchAgents, 15000);
    const hc = setInterval(fetchHealth, 10000);
    const ts = setInterval(refreshTasks, 8000);
    const cs = setInterval(() => {
      fetch('/api/cycle/status')
        .then(r => r.json())
        .then(d => { setCycleStatus(d.status); setActivity(d); })
        .catch(() => {});
    }, 5000);
    return () => { clearInterval(t); clearInterval(ag); clearInterval(hc); clearInterval(ts); clearInterval(cs); };
  }, [refreshTasks]);

  // 채팅 히스토리 localStorage 저장
  useEffect(() => { saveChatHistory(messages); }, [messages]);

  // 그리드 메뉴 외부 클릭 닫기
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (gridMenuRef.current && !gridMenuRef.current.contains(e.target as Node)) {
        setShowGridMenu(false);
      }
    };
    if (showGridMenu) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showGridMenu]);

  // 이벤트 폴링 → 알림 변환
  useEffect(() => {
    const seenIds = new Set<string>();
    const poll = () => fetch('/api/events').then(r => r.json()).then((d: { events?: Array<{ event_id: string; sender: string; target: string; payload: string; timestamp?: string }> }) => {
      const events = d.events ?? [];
      const newEvents = events.filter(e => e.event_id && !seenIds.has(e.event_id));
      newEvents.forEach(e => seenIds.add(e.event_id));
      if (newEvents.length === 0) return;
      // 중요 이벤트만 알림으로 변환
      newEvents.forEach(e => {
        const p = e.payload ?? '';
        const isError = p.toLowerCase().includes('error') || p.toLowerCase().includes('fail') || p.includes('오류') || p.includes('실패');
        const isDone = p.includes('cycle_complete') || p.includes('완료') || (p.startsWith('{') && (() => { try { return JSON.parse(p).type === 'cycle_complete'; } catch { return false; } })());
        const isWarn = p.includes('이상') || p.includes('감지') || p.includes('대기');
        if (isError) {
          const msg = p.replace(/#{1,4}\s+/g, '').replace(/\*\*/g, '').replace(/\n/g, ' ').slice(0, 80);
          const n: Notification = { id: `notif-${e.event_id}`, type: 'error', message: `[${e.sender}] ${msg}`, time: new Date(e.timestamp ?? Date.now()), read: false };
          setNotifications(prev => {
            if (notifSeenRef.current.dismissed.includes(n.id)) return prev;   // 지운 것은 다시 만들지 않는다
            if (prev.some(x => x.id === n.id)) return prev;
            const row = notifSeenRef.current.read.includes(n.id) ? { ...n, read: true } : n;
            return [row, ...prev].slice(0, 50);
          });
          setRecentNotif(n);
          if (recentNotifTimerRef.current) clearTimeout(recentNotifTimerRef.current);
          recentNotifTimerRef.current = setTimeout(() => setRecentNotif(null), 5000);
        } else if (isDone) {
          const n: Notification = { id: `notif-${e.event_id}`, type: 'success', message: `${e.sender} 보고`, time: new Date(e.timestamp ?? Date.now()), read: false, link: () => setActiveTab('projects') };
          setNotifications(prev => {
            if (notifSeenRef.current.dismissed.includes(n.id)) return prev;   // 지운 것은 다시 만들지 않는다
            if (prev.some(x => x.id === n.id)) return prev;
            const row = notifSeenRef.current.read.includes(n.id) ? { ...n, read: true } : n;
            return [row, ...prev].slice(0, 50);
          });
          setRecentNotif(n);
          if (recentNotifTimerRef.current) clearTimeout(recentNotifTimerRef.current);
          recentNotifTimerRef.current = setTimeout(() => setRecentNotif(null), 5000);
        } else if (isWarn) {
          const n: Notification = { id: `notif-${e.event_id}`, type: 'warning', message: `[${e.sender}] ${p.slice(0, 70)}`, time: new Date(e.timestamp ?? Date.now()), read: false };
          setNotifications(prev => {
            if (notifSeenRef.current.dismissed.includes(n.id)) return prev;   // 지운 것은 다시 만들지 않는다
            if (prev.some(x => x.id === n.id)) return prev;
            const row = notifSeenRef.current.read.includes(n.id) ? { ...n, read: true } : n;
            return [row, ...prev].slice(0, 50);
          });
          setRecentNotif(n);
          if (recentNotifTimerRef.current) clearTimeout(recentNotifTimerRef.current);
          recentNotifTimerRef.current = setTimeout(() => setRecentNotif(null), 5000);
        }
      });
    }).catch(() => {});
    poll();
    const t = setInterval(poll, 5000);
    return () => clearInterval(t);
  }, []);

  // 알림 패널 외부 클릭 닫기
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node))
        setShowNotifications(false);
    };
    if (showNotifications) document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showNotifications]);

  useEffect(() => {
    const box = chatBoxRef.current;
    if (!box) return;
    if (!chatAtBottom.current) return;      // 올려 읽는 중이면 그대로 둔다
    // 레이아웃이 끝난 뒤에 내려야 한다 — 같은 틱에 하면 방금 들어온 긴
    // 메시지의 높이가 아직 반영되지 않아 중간에서 멈춘다.
    const id = requestAnimationFrame(() => {
      box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(id);
  }, [messages, running]);

  // 트레이 메뉴 명령 처리 (Phase 6 — 데스크톱 셸)
  /* 현황판에 올릴 카드. 프로젝트·결재·태스크를 한 자로 잰다.
   *
   * 셋은 생김새가 달라도 사장님이 묻는 것은 같다 — 지금 어디에 무엇이
   * 걸려 있나. 그래서 같은 네 칸에 넣는다. 태스크만 보던 시절에는 네 칸이
   * 늘 비어 있었고, 정작 막힌 결재와 멈춘 프로젝트는 아무 칸에도 없었다. */
  const ceoCards = useMemo(() => {
    type Card = {
      key: string; col: 'pending' | 'in_progress' | 'done' | 'failed';
      kind: '결재' | '프로젝트' | '태스크';
      icon: string; title: string; sub?: string; meta?: string;
      onOpen?: () => void;
    };
    const out: Card[] = [];

    // 결재는 전부 '대기' 다. 사람이 누르기 전에는 한 발도 못 나간다.
    for (const a of ceoApprovals) {
      out.push({
        key: `a-${a.id}`, col: 'pending', kind: '결재', icon: '🗂️',
        onOpen: () => { setApprovalOpen(true); setFocusApproval(a.id); },
        title: a.kind === 'file' && a.file_path
          ? (a.file_path.split('/').pop() || a.label) : a.label,
        sub: a.kind === 'action' ? `${a.integration}.${a.action} — 승인하면 즉시 실행`
          : a.file_path ? `workspace/${a.file_path}` : undefined,
        meta: deptLabels[a.department ?? ''] ?? a.department,
      });
    }

    for (const p of ceoProjectList) {
      const col = p.status === 'done' ? 'done'
        : p.status === 'paused' || p.status === 'cancelled' ? 'failed'
        : p.status === 'awaiting_approval' ? 'pending'
        : 'in_progress';
      out.push({
        key: `p-${p.id}`, col, kind: '프로젝트', icon: '🚀',
        title: p.title || p.idea?.slice(0, 50) || p.id,
        // 멈춘 이유는 카드에서 바로 읽혀야 한다. 열어 봐야 알면 현황판이 아니다.
        sub: p.status === 'paused' ? p.pause_reason
          : p.status === 'cancelled' ? '취소됨' : undefined,
        meta: p.progress,
        onOpen: () => { setFocusProject(p.id); setActiveTab('projects'); },
      });
    }

    for (const t of taskList) {
      out.push({
        key: `t-${t.task_id}`, col: t.status, kind: '태스크', icon: '📋',
        title: t.instruction,
        sub: t.status === 'failed' ? (t.result ?? undefined) : undefined,
        meta: deptLabels[t.target_dept] ?? t.target_dept,
        onOpen: () => setDrawerTaskId(t.task_id),
      });
    }
    return out;
  }, [ceoApprovals, ceoProjectList, taskList]);

  const ceoCount = useMemo(() => ({
    pending: ceoCards.filter(c => c.col === 'pending').length,
    in_progress: ceoCards.filter(c => c.col === 'in_progress').length,
    done: ceoCards.filter(c => c.col === 'done').length,
    failed: ceoCards.filter(c => c.col === 'failed').length,
  }), [ceoCards]);

  useEffect(() => {
    // 결재는 사이드바의 "지금 막힌 것" 도 쓴다. 결재함이 있는 탭에서만
    // 받아 오면 메인 화면에서는 늘 0 으로 보여, 브리핑이 "결재 1건" 이라고
    // 말하는데 바로 옆 사이드바는 "막혀 있는 일 없음" 이라고 하는 상태가 된다.
    //
    // 전에는 'ceo' 였다. 그 탭을 프로젝트에 합쳤으니 여기도 따라와야 한다 —
    // 안 바꾸면 조건이 `!== 'main'` 으로 줄어들어, 정작 결재함이 있는
    // 프로젝트 탭에서 결재가 갱신되지 않는다.
    if (activeTab !== 'projects' && activeTab !== 'main') return;
    let stop = false;
    const tick = async () => {
      const [a, p] = await Promise.all([
        api.storeList<ApprovalRow>('approvals'), api.listProjects()]);
      if (stop) return;
      setCeoApprovals((a?.items ?? []).filter(
        r => (r.status ?? 'pending') === 'pending'));
      setCeoProjectList(p?.projects ?? []);
    };
    void tick();
    const t = setInterval(() => { void tick(); }, 15000);
    return () => { stop = true; clearInterval(t); };
  }, [activeTab]);

  useEffect(() => {
    const ea = (window as any).electronAPI;
    if (!ea?.onMenuCommand) return;
    ea.onMenuCommand((_e: any, cmd: string) => {
      if (cmd === 'new-chat' || cmd === 'briefing') {
        void fetchBriefing().then(text => setMessages(prev => {
          const briefing = { id: uid('b'), role: 'assistant' as const,
                             sender: BRIEFING_SENDER, text, ts: nowStr() };
          return cmd === 'new-chat' ? [briefing] : [...prev, briefing];
        }));
      }
    });
  }, []);

  // id 가 `Date.now()` 였다. 같은 밀리초에 두 줄이 들어가면 겹친다 —
  // 실제로 "Encountered two children with the same key" 가 났다. 사용자 줄과
  // 대기 줄("⏳ 생각하는 중…")을 연달아 넣으므로 흔하게 난다.
  //
  // React 는 key 가 겹치면 엉뚱한 줄을 재사용하거나 빠뜨린다. "보냈는데
  // 안 보인다" 가 거기서 나온다. 시각 뒤에 증가하는 번호를 붙인다.
  const msgSeq = useRef(0);
  /** 목록 key 용 유일 id. 토스트·알림·브리핑도 같은 충돌을 겪으므로 함께 쓴다. */
  const uid = useCallback((p = 'x') => `${p}-${Date.now()}-${msgSeq.current++}`, []);
  const pushMsg = useCallback((msg: Omit<ChatMsg, 'id' | 'ts'>) => {
    const id = uid('m');
    setMessages(prev => [...prev, { ...msg, id, ts: nowStr() }]);
  }, []);

  const pushToast = useCallback((type: ToastItem['type'], message: string) => {
    setToasts(prev => [...prev.slice(-4), { id: uid('t'), type, message }]);
  }, []);

  const pushNotif = useCallback((type: Notification['type'], message: string, link?: () => void) => {
    const n: Notification = { id: uid('n'), type, message, time: new Date(), read: false, link };
    setNotifications(prev => [n, ...prev].slice(0, 50));
    setRecentNotif(n);
    if (recentNotifTimerRef.current) clearTimeout(recentNotifTimerRef.current);
    recentNotifTimerRef.current = setTimeout(() => setRecentNotif(null), 5000);
  }, []);

  // 맹비서가 살아 있나. 꺼져 있으면 채팅이 왜 안 되는지 화면에서 바로
  // 보여야 한다 — 말없이 실패하면 사장님은 네트워크를 의심하게 된다.
  useEffect(() => {
    let alive = true;
    void api.assistantHealth().then(r => { if (alive) setAssistantUp(!!r?.ok); });
    return () => { alive = false; };
  }, []);

  /** 세션 하나를 화면으로 불러온다. 이것이 '이어가기' 의 알맹이다. */
  const openSession = useCallback(async (sid: string) => {
    setAssistantSid(sid);
    setSessionsOpen(false);
    const r = await api.assistantMessages(sid);
    const rows = r?.data ?? r?.messages ?? [];
    if (!rows.length) {
      setMessages([{ id: 'empty', role: 'assistant', sender: '맹비서',
                     text: '이 대화에는 아직 기록이 없습니다.', ts: nowStr() }]);
      return;
    }

    // 도구 호출과 그 결과도 메시지로 쌓인다(스키마에 tool_calls·tool_name·
    // tool_call_id 가 있다). 그대로 그렸더니 이런 것이 맹비서의 말인 양 떴다:
    //
    //   {"total_count": 0, "error": "Search failed: rg: regex parse error..."}
    //
    // 사람이 읽을 대화만 남긴다. content 가 빈 턴(도구만 부른 턴)도 뺀다 —
    // 빈 말풍선이 남는다.
    const talk = rows.filter(m =>
      (m.role === 'user' || m.role === 'assistant')
      && String(m.content ?? '').trim().length > 0);
    const hidden = rows.length - talk.length;

    const shown: ChatMsg[] = talk.map((m, i) => ({
      id: `s-${sid}-${i}`,
      role: (m.role === 'user' ? 'user' : 'assistant') as ChatMsg['role'],
      sender: m.role === 'user' ? '사장님' : '맹비서',
      text: String(m.content ?? ''),
      ts: nowStr(),
    }));

    // 숨긴 건수를 적는다. 조용히 빼면 "대화가 중간에 비었다" 로 보인다.
    if (hidden > 0) {
      shown.unshift({
        id: `s-${sid}-note`, role: 'assistant', sender: '맹비서',
        text: `(도구 호출·결과 ${hidden}건은 접었습니다 — 대화만 보여 드립니다)`,
        ts: nowStr(),
      });
    }
    setMessages(shown);
  }, []);

  const send = async (text: string, targetDept: string) => {
    if (!text.trim() || running) return;
    setInput('');
    pushMsg({ role: 'user', sender: '사장님', text });
    setRunning(true);

    // 맹비서와 대화 — 기본 경로.
    //
    // 부서를 고르면 예전처럼 태스크를 넣는다. 둘은 다른 행위다 — "맹비서에게
    // 묻는 것" 과 "학술연구부에 일을 시키는 것" 을 한쪽으로 합치면 다른
    // 쪽이 할 수 있던 일이 사라진다.
    if (targetDept === 'assistant') {
      pushMsg({ role: 'assistant', sender: '맹비서', text: '⏳ 생각하는 중…' });
      try {
        let sid = assistantSid;
        if (!sid) {
          const made = await api.assistantNewSession(`대시보드 · ${nowStr()}`);
          sid = made?.session?.id ?? '';
          if (sid) setAssistantSid(sid);
        }
        if (!sid) throw new Error('세션을 만들지 못했습니다');
        const r = await api.assistantChat(sid, text);
        // 맹비서는 message 를 {role, content} 객체로 준다. 그대로
        // 넣으면 React 가 죽는다(겪었다) — content 를 꺼낸다.
        const raw = r?.message;
        const said = typeof raw === 'string' ? raw : (raw?.content ?? '');
        const reply = said
          ?? (r?.error ? `⚠️ ${r.error}${r.hint ? `\n\n${r.hint}` : ''}` : '');
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = {
            ...copy[copy.length - 1],
            text: reply || '⚠️ 빈 응답이 왔습니다 — 게이트웨이 로그를 확인하십시오.',
          };
          return copy;
        });
      } catch (e) {
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = {
            ...copy[copy.length - 1],
            text: `⚠️ 맹비서에 닿지 못했습니다: ${e instanceof Error ? e.message : String(e)}`
                  + '\n\n게이트웨이가 꺼져 있을 수 있습니다 — `1. 전체 시작.bat`',
          };
          return copy;
        });
      } finally {
        setRunning(false);
      }
      return;
    }

    const deptName = deptLabels[targetDept] ?? targetDept;
    pushMsg({ role: 'assistant', sender: deptName, text: `⏳ ${deptName}에 지시를 전달하는 중...` });

    try {
      const res = await fetch('/api/workflow/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ department: targetDept, task: text }),
      });
      if (res.ok) {
        const data = await res.json();
        const resultText = data.result ?? data.message ?? '✅ 처리가 완료되었습니다. 에이전트가 태스크를 수행 중입니다.';
        setMessages(prev => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          copy[copy.length - 1] = { ...last, text: resultText };
          return copy;
        });
        setToasts(prev => [...prev.slice(-4), { id: uid('t'), type: 'success' as const, message: `✅ ${deptLabels[targetDept] ?? targetDept} 태스크 완료` }]);
        pushNotif('success', `✅ ${deptLabels[targetDept] ?? targetDept} 응답 완료`, () => setActiveTab('main'));
        // 태스크 목록 새로고침
        refreshTasks();
      } else {
        setMessages(prev => {
          const copy = [...prev];
          copy[copy.length - 1] = { ...copy[copy.length - 1], text: `⚠️ API 오류: HTTP ${res.status}` };
          return copy;
        });
      }
    } catch (err: any) {
      setMessages(prev => {
        const copy = [...prev];
        copy[copy.length - 1] = {
          ...copy[copy.length - 1],
          text: `❌ 연결 실패: ${err.message}\n\n서버가 실행 중인지 확인하세요 (python3 server.py)`,
        };
        return copy;
      });
    } finally {
      setRunning(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send(input, dept);
    }
  };

  const handleChip = (chip: typeof QUICK_CHIPS[0]) => {
    setDept(chip.dept);
    send(chip.label, chip.dept);
  };

  const activeAgents = agents.filter(a => a.status !== 'Idle').length;

  return (
    <div className="hs-root">
      {/* ── Top Bar ── */}
      <header className="hs-topbar">
        {/* 모바일 햄버거 버튼 */}
        <button
          className="hs-burger-btn"
          title="메뉴"
          onClick={() => setShowSidebar(v => !v)}
        >☰</button>

        {/* 로고는 어느 화면에서든 메인으로 돌아오는 길이다. 다른 앱이 다
            그렇게 동작하므로 눌러도 아무 일이 없으면 고장으로 읽힌다. */}
        <button className="hs-logo" onClick={() => setActiveTab('main')}
          title="메인으로">
          <div className="hs-logo-icon">M</div>
          <div>
            <div className="hs-logo-text">명테크</div>
            <div className="hs-logo-sub">AGENT STUDIO</div>
          </div>
        </button>
        {/* toLocaleTimeString('ko-KR') 이 이미 오전/오후를 붙여 준다.
            앞에 '오전' 을 또 쓰고 있어서 "오전 오후 6:24" 가 됐다. */}
        <span className="hs-time">{time}</span>

        {/* 서비스 상태.
            예전에는 상태가 나빠도 점 색만 바뀌어 알아채기 어려웠다. 정상일 때는
            조용히 두고(작은 점), 문제가 생기면 무엇이 잘못됐는지 글자로 말한다. */}
        <div className="hs-service-status">
          {([
            ['서버',      backendOk,                                 '연결됨',  '#2DD4BF',
             '백엔드(9000)에 연결할 수 없습니다'],
            ['AI 모델',   healthDetail?.vllm?.ok ?? false,           '정상',    '#8B5CF6',
             healthDetail?.vllm?.error || 'Ollama(11434) 응답 없음'],
            ['지식 베이스', healthDetail?.knowledge_base?.ok ?? false, '동기화',  '#FB923C',
             healthDetail?.knowledge_base?.error || '위키 경로를 찾을 수 없습니다'],
          ] as [string, boolean, string, string, string][]).map(([label, ok, okTxt, color, errTxt]) => (
            <div
              key={label}
              className={`hs-svc-item ${ok ? '' : 'down'}`}
              title={ok ? `${label}: ${okTxt}` : `${label}: ${errTxt}`}
            >
              <span
                className="hs-svc-dot"
                style={ok
                  ? { background: color, boxShadow: `0 0 6px ${color}` }
                  : undefined}
              />
              <span className="hs-svc-label">{label}</span>
              {!ok && <span className="hs-svc-err">점검 필요</span>}
            </div>
          ))}
        </div>

        {/* 전에는 "🚀 운영 시작" 이 여기 있었다 — 누르면 1시간 주기로
            하드코딩된 프롬프트가 돌며 근거 조회·검토·방법 절을 **전부
            우회한** 산출물을 쏟아 냈다(2026-10-21 제거). 헤더에서 가장
            눈에 띄는 자리라 비워 두지 않고, 지금 무슨 일이 있는지 말하고
            그 일이 있는 탭으로 보내는 버튼으로 바꿨다. */}
        <button
          className="hs-start-btn"
          style={cycleStatus === 'waiting' ? { background: '#f59e0b' }
               : cycleStatus === 'executing' ? { background: '#14b8a6' } : {}}
          title={cycleStatus === 'executing' ? '진행 중인 일을 봅니다'
               : cycleStatus === 'waiting' ? '사장님 손이 필요한 것을 봅니다'
               : '새 프로젝트를 시작합니다'}
          onClick={() => {
            // 사람을 기다리는 것이 있으면 그쪽이 먼저다 — 기계는 기다리면
            // 되지만 사장님이 멈춰 있으면 아무것도 진행되지 않는다.
            if (cycleStatus === 'waiting' && (activity.approvals_pending ?? 0) > 0
                && (activity.projects_waiting ?? 0) === 0) {
              setActiveTab('projects');
            } else {
              setActiveTab('projects');
            }
          }}
        >
          {cycleStatus === 'executing'
            ? `⚡ 일하는 중 ${(activity.projects_running ?? 0) + (activity.tasks_busy ?? 0)}`
            : cycleStatus === 'waiting'
            ? `✋ 사장님 차례 ${(activity.projects_waiting ?? 0) + (activity.approvals_pending ?? 0)}`
            : '＋ 새 프로젝트'}
        </button>

        {/* ── 알림 벨 ── */}
        <NotificationBell
          notifications={notifications}
          open={showNotifications}
          onToggle={() => setShowNotifications(v => !v)}
          onRead={id => {
            setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n));
            saveNotifSeen({ read: [...notifSeenRef.current.read, id],
                            dismissed: notifSeenRef.current.dismissed });
          }}
          onReadAll={() => {
            setNotifications(prev => prev.map(n => ({ ...n, read: true })));
            saveNotifSeen({ read: [...notifSeenRef.current.read, ...notifications.map(n => n.id)],
                            dismissed: notifSeenRef.current.dismissed });
          }}
          onRemove={id => {
            setNotifications(prev => prev.filter(n => n.id !== id));
            saveNotifSeen({ read: notifSeenRef.current.read,
                            dismissed: [...notifSeenRef.current.dismissed, id] });
          }}
          onClearAll={() => {
            saveNotifSeen({ read: notifSeenRef.current.read,
                            dismissed: [...notifSeenRef.current.dismissed,
                                        ...notifications.map(n => n.id)] });
            setNotifications([]);
          }}
          containerRef={notifRef}
        />

        {/* ── 9-dot 그리드 메뉴 ── */}
        <div style={{ position: 'relative' }} ref={gridMenuRef}>
          <button
            className={`hs-grid-menu-btn ${showGridMenu ? 'open' : ''}`}
            onClick={() => setShowGridMenu(v => !v)}
            title="메뉴"
          >
            <span className="hs-grid-dots">
              {Array.from({ length: 9 }).map((_, i) => (
                <span key={i} className="hs-grid-dot" />
              ))}
            </span>
          </button>

          {showGridMenu && (
            <div className="hs-grid-dropdown">
              <div className="hs-grid-dropdown-title">명테크 메뉴</div>
              <div className="hs-grid-items">
                {[
                  {
                    /* 현황판은 **메인 탭에만** 그려진다. 그런데 이 항목은
                       다섯 탭 어디서나 눌렸고, 나머지 넷에서는 보이지 않는
                       상태만 뒤집었다 — 프로젝트 탭에서 눌러 꺼 놓고
                       메인으로 돌아오면 현황판이 사라져 있었다(실측).

                       "아무 일도 안 일어나는 버튼" 을 만드느니, 누르면
                       **보여 주러 간다.** 다른 탭에서 누르면 메인으로
                       옮기고 현황판을 켠다. 메인에서는 예전처럼 토글이다. */
                    icon: '📊', label: '시스템 현황판',
                    active: showSidebar && activeTab === 'main',
                    bg: 'rgba(139,92,246,0.15)', color: '#8B5CF6',
                    action: () => {
                      if (activeTab !== 'main') {
                        setActiveTab('main');
                        setShowSidebar(true);
                        return;
                      }
                      setShowSidebar(v => !v);
                    },
                  },
                  {
                    icon: '🧬', label: '지식 네트워크', active: false,
                    bg: 'rgba(251,146,60,0.15)', color: '#FB923C',
                    action: () => setShowMemory(true),
                  },
                  {
                    icon: '🤖', label: 'LLM 모델', active: false,
                    bg: 'rgba(96,165,250,0.15)', color: '#60A5FA',
                    action: () => setShowModel(true),
                  },
                  {
                    icon: '✨', label: '새 대화', active: false,
                    bg: 'rgba(167,243,208,0.15)', color: '#6EE7B7',
                    // 전에는 localStorage 한 칸을 비울 뿐이라 '새 대화' 가 무엇인지
                    // 모호했다 — 이어갈 것도, 돌아갈 것도 없었다. 이제 맹비서 세션을
                    // 실제로 만든다. 그 세션은 디스코드·텔레그램 대화와 같은 목록에 선다.
                    action: () => {
                      void (async () => {
                        // 제목에 **초까지** 넣는다. 맹비서가 중복 제목을 400
                        // 으로 거절하므로, 분까지만 넣으면 연달아 두 번
                        // 누를 때 두 번째가 조용히 실패한다.
                        const r = await api.assistantNewSession(
                          `대시보드 · ${new Date().toLocaleString('ko-KR', { hour12: false })}`);
                        const sid = r?.session?.id ?? '';
                        if (!sid) {
                          pushNotif('warning',
                            `새 대화를 만들지 못했습니다 — ${r?.error ?? '맹비서 응답 없음'}`);
                          return;
                        }
                        setAssistantSid(sid);
                        setMessages([{ id: 'init', role: 'assistant', sender: '맹비서',
                                       text: '새 대화를 시작했습니다. 무엇을 도와드릴까요?',
                                       ts: nowStr() }]);
                        pushNotif('info', '새 대화를 시작했습니다');
                      })();
                    },
                  },
                  {
                    // 서랍이 자기 목록을 스스로 불러온다(출처 필터가 있어서
                    // 어느 목록을 받을지는 서랍이 안다). 그래서 여기서
                    // loadSessions 를 부르지 않는다 — 부르면 같은 요청이
                    // 두 번 나가고, 하나는 필터가 다른 결과를 덮어쓴다.
                    icon: '🗂', label: '대화 기록', active: sessionsOpen,
                    bg: 'rgba(96,165,250,0.15)', color: '#60A5FA',
                    action: () => setSessionsOpen(true),
                  },
                  {
                    icon: '⚙️', label: '관리 탭', active: false,
                    bg: 'rgba(148,163,184,0.15)', color: '#94A3B8',
                    action: () => setShowManage(true),
                  },
                ].map(item => (
                  <button
                    key={item.label}
                    className="hs-grid-item"
                    style={item.active ? { background: item.bg, borderColor: item.color + '55' } : {}}
                    onClick={() => { item.action(); setShowGridMenu(false); }}
                  >
                    <span className="hs-grid-item-icon" style={{ background: item.bg }}>
                      {item.icon}
                    </span>
                    <span className="hs-grid-item-label" style={item.active ? { color: item.color } : {}}>
                      {item.label}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </header>

      {/* ── Tab Bar ── */}
      <div className="hs-tabs">
        <button className={`hs-tab ${activeTab === 'main' ? 'active' : ''}`} onClick={() => setActiveTab('main')}>
          💬 메인
        </button>
        <button className={`hs-tab ${activeTab === 'office' ? 'active' : ''}`} onClick={() => setActiveTab('office')}>
          🏢 사무실
        </button>
        <button className={`hs-tab ${activeTab === 'agents' ? 'active' : ''}`} onClick={() => setActiveTab('agents')}>
          🤖 에이전트
        </button>
        <button className={`hs-tab ${activeTab === 'projects' ? 'active' : ''}`} onClick={() => setActiveTab('projects')}>
          🚀 프로젝트
        </button>
        {/* 전에는 '📝 노트' 였다 — 사장님 할 일 체크리스트. 그건 프로젝트
            탭의 결재함 옆으로 옮겼다(둘 다 사람만 할 수 있는 일이다).
            이 자리는 위키를 뒤지는 곳이 된다. */}
        <button className={`hs-tab ${activeTab === 'knowledge' ? 'active' : ''}`} onClick={() => setActiveTab('knowledge')}>
          🧬 지식베이스
        </button>
      </div>

      {/* ── Knowledge Tab — 위키를 IDE 처럼 뒤지고 논문처럼 읽는다 ── */}
      {activeTab === 'knowledge' && (
        <Suspense fallback={<div className="hs-lazy-fallback">
          <div className="hs-lazy-spinner" /> 지식베이스 불러오는 중…
        </div>}>
          <KnowledgeTab />
        </Suspense>
      )}

      {/* ── Projects Tab — 결재·교훈·칸반 + 프로젝트 목록 ──
          전에는 'CEO 룸' 이라는 별도 탭이었다. 거기 있던 것은 전부
          프로젝트에 딸린 것이다 — 결재는 프로젝트가 올린 제안이고,
          교훈은 막힌 프로젝트에서 뽑은 것이고, KPI·칸반은 프로젝트
          상태 집계다. 따로 두면 "승인하려면 탭을 옮기고, 무엇을
          승인하는지 보려면 다시 돌아오는" 왕복이 생긴다.
          사장님만 할 수 있는 일(결재)이 먼저 보이도록 위에 둔다.

          스크롤은 `.pj-page` 하나만 가진다. 결재함(.ceo-room)과 목록(.pj-wrap)이
          각자 overflow-y:auto 를 들고 있어서, 그냥 나란히 두면 스크롤바가 둘
          생기고 높이도 반씩 나눠 가진다. */}
      {activeTab === 'projects' && (
        <div className="pj-page">
        <div className="ceo-room">
          {/* KPI. 현황판과 같은 ceoCards 에서 센다 — 예전에는 KPI 가 태스크
              큐만, 현황판은 셋을 다 세서 같은 화면에 '완료 1' 과 '완료 02' 가
              나란히 떴다. 대시보드가 스스로 어긋나면 어느 쪽도 못 믿는다. */}
          <div className="ceo-kpi-bar">
            {/* 결재가 제일 왼쪽이다 — 사장님만 할 수 있는 유일한 일이라서. */}
            <div className="ceo-kpi-item">
              <span className="ceo-kpi-label">결재 대기</span>
              <span className={`ceo-kpi-value ${ceoCount.pending ? 'red' : 'aqua'}`}>
                {ceoCount.pending}
              </span>
            </div>
            <div className="ceo-kpi-sep" />
            <div className="ceo-kpi-item">
              <span className="ceo-kpi-label">진행 중</span>
              <span className="ceo-kpi-value purple">{ceoCount.in_progress}</span>
            </div>
            <div className="ceo-kpi-sep" />
            <div className="ceo-kpi-item">
              <span className="ceo-kpi-label">완료</span>
              <span className="ceo-kpi-value aqua">{ceoCount.done}</span>
            </div>
            <div className="ceo-kpi-sep" />
            <div className="ceo-kpi-item">
              <span className="ceo-kpi-label">중단</span>
              <span className={`ceo-kpi-value ${ceoCount.failed ? 'amber' : 'aqua'}`}>
                {ceoCount.failed}
              </span>
            </div>
            <div className="ceo-kpi-sep" />
            <div className="ceo-kpi-item">
              <span className="ceo-kpi-label">에이전트</span>
              <span className="ceo-kpi-value purple">{agents.length}</span>
            </div>
            <button
              className="ceo-new-btn"
              onClick={() => { setActiveTab('main'); setTimeout(() => textareaRef.current?.focus(), 100); }}
            >
              ⚡ 새 지시사항
            </button>
          </div>

          {/* 결재함 + 진행 중인 프로젝트. 칸반은 태스크 큐만 보므로
              프로젝트 탭에서 시킨 일은 여기서만 보인다. */}
          <Suspense fallback={<div className="ceo-appr-empty">결재함 불러오는 중…</div>}>
            <ApprovalBox
              open={approvalOpen}
              onToggle={() => setApprovalOpen(v => !v)}
              focusId={focusApproval}
              onFocused={() => setFocusApproval(null)}
              onOpenProjects={() => setActiveTab('projects')} />
          </Suspense>

          {/* 배운 것. 결재함 바로 아래가 맞는 자리다 — 둘 다 "사람이 알아야
              이 시스템의 움직임을 이해할 수 있는 것" 이다. 교훈은 다음 계획을
              바꾸므로, 보이지 않으면 그게 숨은 자율성이다. */}
          <Suspense fallback={null}>
            <LessonsBox open={lessonsOpen}
                        onToggle={() => setLessonsOpen(v => !v)} />
          </Suspense>

        </div>

        {/* 할 일 — 전에는 '노트' 탭이었다. 사람만 할 수 있는 일(토큰 발급,
            계정 로그인, 결재 판단)이 쌓이는 곳이라, 결재함과 같은 성질이다.
            탭을 따로 두면 "내가 뭘 해야 하더라" 를 보려고 또 옮겨야 한다. */}
        <Suspense fallback={<div className="hs-lazy-fallback">
          <div className="hs-lazy-spinner" /> 할 일 불러오는 중…
        </div>}>
          <NotesTab />
        </Suspense>

        <Suspense fallback={<div className="hs-lazy-fallback">
          <div className="hs-lazy-spinner" /> 프로젝트 불러오는 중…
        </div>}>
          <ProjectsTab focusId={focusProject} onFocused={() => setFocusProject(null)} />
        </Suspense>

        {/* 칸반 — 맨 아래다. 전에는 결재함 바로 밑이었는데, 완료 열에
            18장이 쌓이자 그리드가 네 열을 모두 같은 높이로 늘려 이 한
            덩어리가 1974px 이 됐다(실측). 그 아래의 할 일·프로젝트
            목록이 세 화면 밑으로 밀려서, 사장님이 매번 한참 내려야 했다.

            손대는 것(결재·할 일·프로젝트)이 위에, 훑는 것(칸반)이 아래다.
            열마다 스크롤도 줬다 — hermes.css 의 .ceo-col-scroll 주석 참고. */}
          {/* 현황판. 결재·프로젝트·태스크를 한 자로 잰다 — 셋은 생김새가
              달라도 사장님이 묻는 것은 같다: 지금 어디에 무엇이 걸려 있나. */}
          <div className="ceo-kanban">
            {([
              { col: 'pending',     label: '대기',   dot: '#f59e0b',
                hint: '사람이 눌러야 다음으로 갑니다' },
              { col: 'in_progress', label: '진행 중', dot: '#8B5CF6',
                hint: '지금 돌고 있습니다' },
              { col: 'done',        label: '완료',   dot: '#2DD4BF',
                hint: '끝났습니다' },
              { col: 'failed',      label: '중단',   dot: '#ef4444',
                hint: '점수를 못 올렸거나 취소된 것' },
            ] as const).map(c => {
              const cards = ceoCards.filter(x => x.col === c.col);
              return (
                <div key={c.col} className="ceo-col">
                  <div className="ceo-col-header">
                    <span className="ceo-col-title">
                      <span className="ceo-col-dot" style={{ background: c.dot }} />
                      {c.label}
                    </span>
                    <span className="ceo-col-count">{cards.length.toString().padStart(2, '0')}</span>
                  </div>
                  <div className="ceo-col-scroll">
                    {cards.length === 0 ? (
                      <div className="ceo-task-empty">{c.hint}</div>
                    ) : cards.map(x => (
                      <div key={x.key}
                        className={`ceo-task-card ${x.onOpen ? 'clickable' : ''}`}
                        onClick={x.onOpen}>
                        <div className="ceo-card-top">
                          <span className={`ceo-card-kind k-${x.kind}`}>{x.icon} {x.kind}</span>
                          {x.meta && <span className="ceo-card-meta">{x.meta}</span>}
                        </div>
                        <div className="ceo-card-title">{x.title}</div>
                        {/* 멈춘 이유·실패 사유는 카드에서 바로 읽혀야 한다.
                            열어 봐야 알면 현황판이 아니다. */}
                        {x.sub && <div className="ceo-card-sub" title={x.sub}>{x.sub}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Office Tab ── */}
      {activeTab === 'office' && (
        <Suspense fallback={<div className="hs-lazy-fallback">
          <span className="hs-lazy-spinner" />
          2D 사무실을 불러오는 중…
        </div>}>
        <OfficeView
          agents={agents}
          cycleStatus={cycleStatus}
          taskSummary={taskSummary}
          onDeptChat={(d, msg) => {
            setActiveTab('main');
            setDept(d);
            setTimeout(() => send(msg, d), 100);
          }}
        />
        </Suspense>
      )}


      {/* ── 에이전트 관리 탭 ── */}
      {activeTab === 'agents' && (
        <AgentManageTab
          agents={agents}
          onDeploy={() => setShowTeam(true)}
          onDeptChat={(d, msg) => { setActiveTab('main'); setDept(d); setTimeout(() => send(msg, d), 100); }}
        />
      )}

      {/* ── Body (메인 탭) ── */}
      {activeTab === 'main' && <div className="hs-body">
        {/* 모바일 사이드바 backdrop */}
        {showSidebar && isMobile && (
          <div className="hs-sidebar-backdrop" onClick={() => setShowSidebar(false)} />
        )}

        {/* ── Sidebar: 시스템 현황판 ── */}
        {showSidebar && <aside
          className="hs-sidebar"
          style={isMobile ? {} : { width: sidebarW, minWidth: sidebarW, maxWidth: sidebarW }}
        >
          <div className="hs-sidebar-title">📊 시스템 현황</div>

          {/* 서비스 헬스 */}
          <div className="hs-status-section">
            {([
              ['백엔드',   backendOk,                  '연결됨', '미연결'],
              ['AI 모델',  healthDetail?.vllm?.ok ?? false, '정상',   healthDetail?.vllm?.error ? 'Ollama 미연결' : '확인 중'],
              ['지식 베이스', healthDetail?.knowledge_base?.ok ?? false, '동기화됨', '경로 오류'],
              // 맹비서를 넣는다. 메인 채팅의 **기본 상대**인데 이 줄만
              // 없었다 — 게이트웨이가 꺼져 있어도 현황판은 전부 초록이라,
              // 사장님은 메시지를 보내고 나서야 안 된다는 걸 알았다(실측).
              ['맹비서', assistantUp === true, '연결됨',
               assistantUp === null ? '확인 중' : '꺼짐'],
            ] as [string, boolean, string, string][]).map(([label, ok, okTxt, errTxt]) => (
              <div key={label} className="hs-status-row">
                <span className={`hs-dot ${ok ? 'green' : 'red'}`} />
                <span className="hs-status-label">{label}</span>
                <span className={`hs-status-badge ${ok ? 'ok' : 'err'}`}>{ok ? okTxt : errTxt}</span>
              </div>
            ))}
            <div className="hs-status-row">
              <span className={`hs-dot ${cycleStatus !== 'stopped' ? 'amber' : 'gray'}`} />
              <span className="hs-status-label">활동</span>
              <span className={`hs-status-badge ${cycleStatus !== 'stopped' ? 'run' : 'idle'}`}>
                {cycleStatus === 'stopped' ? '대기'
                  : cycleStatus === 'executing' ? '진행중'
                  : cycleStatus === 'waiting' ? '사장님 차례' : cycleStatus}
              </span>
            </div>
            <div className="hs-status-row">
              <span className={`hs-dot ${activeAgents > 0 ? 'amber' : 'gray'}`} />
              <span className="hs-status-label">에이전트</span>
              <span className="hs-status-badge idle">{agents.length}명 · {activeAgents > 0 ? `${activeAgents}명 활성` : '대기'}</span>
            </div>
          </div>

          {/* 태스크 현황 — 숫자 배지 */}
          <div className="hs-sidebar-section-title">태스크 현황</div>
          <div className="hs-task-stats">
            {([
              ['amber', taskSummary.pending,     '대기',   'pending'],
              ['green', taskSummary.in_progress, '처리중', 'in_progress'],
              ['muted', taskSummary.done,        '완료',   'done'],
              ['red',   taskSummary.failed,      '실패',   'failed'],
            ] as [string, number, string, string][]).map(([cls, num, lbl, status]) => (
              <button key={status}
                className={`hs-task-stat hs-task-stat-btn${taskFilter === status ? ' on' : ''}`}
                disabled={num === 0}
                aria-pressed={taskFilter === status}
                title={num === 0 ? `${lbl} 중인 태스크가 없습니다`
                  : taskFilter === status ? '눌러서 전체로' : `${lbl} ${num}건만 보기`}
                onClick={() => setTaskFilter(f => (f === status ? null : status))}>
                <span className={`hs-task-stat-num ${cls}`}>{num}</span>
                <span className="hs-task-stat-lbl">{lbl}</span>
              </button>
            ))}
          </div>

          {/* 최근 태스크 미니 리스트. 위 숫자를 누르면 여기가 걸러진다.
              고른 상태가 있을 때는 5건으로 자르지 않는다 — "완료 18건" 을
              눌렀는데 5건만 나오면 숫자가 틀린 것처럼 보인다. */}
          {taskList.length > 0 && (
            <div className="hs-task-mini-list">
              {taskFilter && (
                <button className="hs-task-filter-note" onClick={() => setTaskFilter(null)}>
                  <span>
                    {taskFilter === 'pending' ? '대기' : taskFilter === 'in_progress' ? '처리중'
                      : taskFilter === 'done' ? '완료' : '실패'}
                    {' '}{taskList.filter(t => t.status === taskFilter).length}건만 보는 중
                  </span>
                  <b>✕ 전체</b>
                </button>
              )}
              {(taskFilter
                ? taskList.filter(t => t.status === taskFilter)
                : taskList.slice(0, 5)
              ).map(t => {
                const statusColor = t.status === 'done' ? '#0ffd6a' : t.status === 'failed' ? '#ef4444' : t.status === 'in_progress' ? '#60a5fa' : '#f59e0b';
                const deptIcons: Record<string, string> = { orchestration_dept: '🧠', research_dept: '🔬', finance_dept: '📈', dev_dept: '⚙️', content_dept: '✍️' };
                return (
                  <button key={t.task_id} className="hs-task-mini-item" onClick={() => setDrawerTaskId(t.task_id)}>
                    <span className="hs-task-mini-dot" style={{ background: statusColor }} />
                    <span className="hs-task-mini-icon">{deptIcons[t.target_dept] ?? '📋'}</span>
                    <span className="hs-task-mini-text">{t.instruction.slice(0, 30)}{t.instruction.length > 30 ? '…' : ''}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* 지금 막힌 것 — 사장님이 아니면 아무도 못 푸는 일.
              자세한 현황은 프로젝트 탭의 결재함이 맡는다. 여기까지 숫자를
              늘어놓으면 같은 것을 두 군데서 세게 되고, 어긋나면 둘 다 못 믿는다. */}
          <div className="hs-sidebar-section-title">지금 막힌 것</div>
          <button className={`hs-blocked ${ceoApprovals.length ? 'on' : ''}`}
            onClick={() => setActiveTab('projects')}
            title="프로젝트 탭의 결재함으로">
            {ceoApprovals.length > 0 ? (
              <>
                <span className="hs-blocked-n">{ceoApprovals.length}</span>
                <span className="hs-blocked-t">결재 대기<br /><b>눌러서 처리 →</b></span>
              </>
            ) : (
              <span className="hs-blocked-t none">막혀 있는 일 없음</span>
            )}
          </button>

          {/* 전에는 '상태보고' 였고, 누르면 그 부서에 **상태보고를 시켰다**
              — 호출 하나를 쓰고 답을 기다려야 했다. 사장님이 원하신 것은
              "지금 누가 무엇을 하고 있나" 를 보는 것이지 보고서를 받는 게
              아니다. 이름을 사실대로 바꾸고, 누르면 사무실 탭으로 보낸다. */}
          <div className="hs-sidebar-section-title">에이전트 활동</div>
          <div className="hs-dept-list">
            {/* 아이콘만 여기서 들고, **이름은 `deptLabels`(정본)** 를 읽는다.
                전에는 접미사 없는 이름('학술연구')을 따로 적어 둬서, 같은
                부서가 사이드바에서는 '학술연구', 사무실·에이전트 탭에서는
                '학술연구부' 로 나왔다. */}
            {([
              ['orchestration_dept', '🧠'],
              ['research_dept',      '🔬'],
              ['finance_dept',       '📈'],
              ['dev_dept',           '⚙️'],
              ['content_dept',       '✍️'],
            ] as [string, string][]).map(([d, icon]) => {
              const label = deptLabels[d] ?? d;
              const mine   = agents.filter(a => a.department === d);
              const busy   = mine.find(a => a.status !== 'Idle');
              // 숫자만 있으면 무엇의 개수인지 알 수 없었다(인원? 태스크?).
              // 일하는 중이면 무엇을 하는지까지 쓴다.
              return (
                <button
                  key={d}
                  className={`hs-dept-card ${busy ? 'busy' : ''}`}
                  onClick={() => setActiveTab('office')}
                  title={busy ? `${label}팀 — ${busy.doing || '작업 중'}` : `${label}팀 — 대기 중. 눌러서 사무실로`}
                >
                  <span className="hs-dept-icon">{icon}</span>
                  <span className="hs-dept-name">
                    {label}
                    {busy?.doing && <span className="hs-dept-doing">{busy.doing}</span>}
                  </span>
                  <span className={`hs-dept-count ${busy ? 'active' : ''}`}>
                    {mine.length}<span className="hs-dept-unit">명</span>
                  </span>
                </button>
              );
            })}
          </div>

          {/* 활동 피드는 중앙 상단으로 옮겼다. 여기 두면 같은 화면에 같은 피드가
              둘 뜨고(태블릿 폭에서 특히 눈에 띈다), 사이드바는 좁아 읽기도 어렵다.
              사이드바는 '상태와 할 일', 중앙은 '지금 일어나는 일'로 나눈다. */}
        </aside>}

        {/* 사이드바 드래그 핸들 — 데스크톱 전용 */}
        {showSidebar && !isMobile && (
          <div
            className="hs-sidebar-resize-handle"
            onMouseDown={onResizeHandleDown}
            title="드래그하여 사이드바 크기 조정"
          />
        )}

        {/* ── Center ── */}
        <main className="hs-center">
          {/* '실시간 활동' 을 여기서 들어냈다 (2026-10-22).
              에이전트 활동이 세 군데에 있었다 — 메인(여기)·사무실(에이전트
              대화)·에이전트(실시간 연산 로그). 같은 것을 세 번 보여 주면
              어느 것도 제대로 안 보게 된다. 메인의 일은 **대화**지 감시가
              아니므로 여기를 뺐다.
              확인한 것: 사무실(OfficeView)과 에이전트(AgentManageTab)는
              각자 `/api/events` 를 폴링한다 — AgentFeed 를 쓰지 않는다.
              그래서 여기를 빼도 기능이 사라지지 않고, AgentFeed 는 고아가
              되어 함께 지웠다(git 에 남아 있다). SSE 엔드포인트
              `/api/events/stream` 은 pages/VirtualOffice.tsx 가 쓰므로 둔다. */}

          {/* Chat section */}
          <div className="hs-chat-section">
            <div className="hs-chat-area" ref={chatBoxRef}
                 onScroll={e => {
                   const el = e.currentTarget;
                   // 바닥에서 80px 안쪽이면 "따라가도 되는 상태" 로 본다.
                   // 0 으로 잡으면 부드러운 스크롤 도중에 어긋나 꺼진다.
                   chatAtBottom.current =
                     el.scrollHeight - el.scrollTop - el.clientHeight < 80;
                 }}>
              {messages.map(m => (
                <div key={m.id} className={`hs-msg ${m.role}`}>
                  <div className="hs-msg-avatar">
                    {/* 맹비서는 디스코드 봇의 실제 아바타를 쓴다 — 같은 인격이
                        창마다 다른 얼굴로 보이면 안 된다. 출처와 갱신 방법은
                        public/assets/assistant/SOURCE.md.
                        onError 로 이모지로 되돌린다 — 파일이 없을 때 깨진
                        이미지 아이콘이 남는 것보다 낫다. */}
                    {m.role === 'assistant'
                      ? (m.sender === BRIEFING_SENDER ? '📋' : <AssistantFace />)
                      : '👤'}
                  </div>
                  <div className="hs-msg-body">
                    <div className="hs-msg-sender">{m.sender} · {m.ts}</div>
                    <ChatBody text={m.text} role={m.role} />
                  </div>
                </div>
              ))}
              {running && (
                <div className="hs-msg assistant">
                  <div className="hs-msg-avatar">⏳</div>
                  <div className="hs-msg-body" style={{ color: '#64748b' }}>에이전트가 처리 중입니다…</div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
          </div>

          {/* Quick chips */}
          <div className="hs-chips">
            {QUICK_CHIPS.map(c => (
              <button key={c.label} className="hs-chip" onClick={() => handleChip(c)} disabled={running}>
                {c.icon} {c.label}
              </button>
            ))}
          </div>


          {/* Chat input — 쓰는 만큼 늘고, 도구는 `+` 하나로 모았다. */}
          <div className="hs-composer">
            <textarea
              ref={textareaRef}
              className="hs-composer-text"
              rows={1}
              placeholder={dept === 'assistant'
                ? (assistantUp === false
                    ? '맹비서가 꺼져 있습니다 — 1. 전체 시작.bat 을 실행해 주세요'
                    : '맹비서에게 무엇이든… (Enter 전송 · Shift+Enter 줄바꿈)')
                : `${deptLabels[dept] ?? dept}에 지시… (Enter 전송 · Shift+Enter 줄바꿈)`}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
            />

            <div className="hs-composer-bar">
              {/* `+` — 대화 상대와 빠른 명령. 되는 것만 넣는다. */}
              <div className="hs-plus-wrap">
                <button className={`hs-plus ${plusOpen ? 'open' : ''}`}
                        aria-label="도구와 대화 상대"
                        aria-expanded={plusOpen}
                        onClick={() => setPlusOpen(v => !v)}>
                  {plusOpen ? '✕' : '＋'}
                </button>

                {plusOpen && (
                  <>
                    <div className="hs-plus-backdrop" onClick={() => setPlusOpen(false)} />
                    <div className="hs-plus-menu" role="menu">
                      <div className="hs-plus-head">대화 상대</div>
                      {([['assistant', '', '맹비서', '세션이 이어집니다'],
                         ['orchestration_dept', '🧠', '오케스트레이션', '부서에 일을 시킵니다'],
                         ['research_dept', '🔬', '학술연구', ''],
                         ['finance_dept', '📈', '금융투자', ''],
                         ['dev_dept', '⚙️', '개발', ''],
                         ['content_dept', '✍️', '콘텐츠', '']] as const).map(
                        ([id, icon, name, hint]) => (
                          <button key={id} className={`hs-plus-item ${dept === id ? 'on' : ''}`}
                                  onClick={() => { setDept(id); setPlusOpen(false); }}>
                            {/* 맹비서만 얼굴을 쓴다. 부서는 역할 아이콘이 맞다 —
                                사람이 아니라 기능이기 때문이다. */}
                            <span className="hs-plus-ico">
                              {id === 'assistant' ? <AssistantFace size={17} /> : icon}
                            </span>
                            <span className="hs-plus-name">{name}</span>
                            {hint && <span className="hs-plus-hint">{hint}</span>}
                            {dept === id && <span className="hs-plus-check">✓</span>}
                          </button>
                        ))}

                      <div className="hs-plus-sep" />
                      <div className="hs-plus-head">
                        빠른 명령 <span>맹비서 스킬</span>
                      </div>
                      {/* 맹비서가 실제로 가진 스킬에 붙은 것만 넣는다.
                          없는 명령을 넣으면 눌렀을 때 아무 일도 안 일어난다. */}
                      {([['/현황', '📊', '명테크 현황', 'myungtech-status'],
                         ['/결재', '📋', '결재 대기 보기', 'myungtech-approvals'],
                         ['위키에서 찾아줘: ', '🧬', '위키에서 찾기', 'wiki-prompts']] as const).map(
                        ([text, icon, name, skill]) => (
                          <button key={text} className="hs-plus-item"
                                  onClick={() => {
                                    setDept('assistant');       // 스킬은 맹비서의 것이다
                                    setInput(prev => prev ? `${text}${prev}` : text);
                                    setPlusOpen(false);
                                    setTimeout(() => textareaRef.current?.focus(), 0);
                                  }}>
                            <span className="hs-plus-ico">{icon}</span>
                            <span className="hs-plus-name">{name}</span>
                            <span className="hs-plus-hint">{skill}</span>
                          </button>
                        ))}
                    </div>
                  </>
                )}
              </div>

              {/* 지금 누구와 말하는지는 늘 보여야 한다 — `+` 안에 숨기면
                  부서에 지시하던 중인 것을 잊는다. */}
              <span className="hs-composer-who">
                {dept === 'assistant'
                  ? <><AssistantFace size={15} /> 맹비서</>
                  : `${deptLabels[dept] ?? dept}`}
              </span>

              {/* 이름이 없어서 보조 기술에는 "버튼" 으로만 읽혔다 —
                  화면의 아이콘 버튼 중 유일하게 이름이 없었다. */}
              <button
                className="hs-send-btn"
                aria-label="보내기"
                title={running ? '답을 기다리는 중입니다' : '보내기 (Enter)'}
                onClick={() => send(input, dept)}
                disabled={running || !input.trim()}
              >↑</button>
            </div>
          </div>
        </main>
      </div>}

      {/* CEO Override Modal */}
      {overrideTask && (
        <CeoOverrideModal
          task={{ id: overrideTask.task_id, title: overrideTask.instruction, dept: overrideTask.target_dept, status: overrideTask.status }}
          onClose={() => setOverrideTask(null)}
          onInject={async (taskId, command) => {
            await send(`[CEO 개입] 태스크 ${taskId}: ${command}`, overrideTask.target_dept);
          }}
        />
      )}

      {/* Modals */}
      {showTeam && (
        <AgentTeamModal
          onClose={() => setShowTeam(false)}
          globalModel={globalModel}
          onGlobalModelChange={setGlobalModel}
        />
      )}
      {showMemory && (
        <MemoryModal onClose={() => setShowMemory(false)} />
      )}
      {showModel && (
        <ModelModal
          onClose={() => setShowModel(false)}
          globalModel={globalModel}
          onGlobalModelChange={setGlobalModel}
        />
      )}
      {/* 대화 기록 — 세션함. 전에는 '새 대화' 가 localStorage 를 비울 뿐이라
          돌아갈 곳이 없었다. 이제 맹비서 세션을 열고 이어간다. */}
      {sessionsOpen && (
        <Suspense fallback={null}>
          <SessionsDrawer
            currentSid={assistantSid}
            onOpen={sid => void openSession(sid)}
            onNew={sid => {
              setAssistantSid(sid);
              setMessages([{ id: 'init', role: 'assistant', sender: '맹비서',
                             text: '새 대화를 시작했습니다. 무엇을 도와드릴까요?',
                             ts: nowStr() }]);
            }}
            onCurrentDeleted={() => {
              // 지금 보던 대화를 지웠다. 세션 id 를 비워야 다음 질문이
              // **새 세션을 만든다** — 안 비우면 없는 세션에 말을 걸어
              // 404 가 나고, 사장님은 맹비서가 죽은 줄 안다.
              setAssistantSid('');
              setMessages([{ id: 'gone', role: 'assistant', sender: '맹비서',
                             text: '이 대화를 지웠습니다. 말을 거시면 새 대화가 시작됩니다.',
                             ts: nowStr() }]);
            }}
            notify={pushNotif}
            onClose={() => setSessionsOpen(false)}
          />
        </Suspense>
      )}

      {showManage && (
        <ManageModal
          onClose={() => setShowManage(false)}
          agentCount={agents.length}
          globalModel={globalModel}
        />
      )}

      {/* Task Drawer */}
      <TaskDrawer taskId={drawerTaskId} onClose={() => setDrawerTaskId(null)}
        onOverride={t => {
          // 서랍을 닫고 개입 모달을 연다. 둘을 겹쳐 두면 Escape 한 번에
          // 어느 쪽이 닫히는지 사장님이 알 수 없다.
          setDrawerTaskId(null);
          setOverrideTask({
            task_id: t.task_id, instruction: t.instruction,
            target_dept: t.target_dept, status: t.status,
          } as TaskItem);
        }} />

      {/* 상단 우측 실시간 알림 토스트 */}
      {recentNotif && (
        <div className="nb-toast-wrap">
          <div className={`nb-toast nb-toast-${recentNotif.type}`} onClick={() => { recentNotif.link?.(); setRecentNotif(null); setShowNotifications(true); }}>
            <span className="nb-toast-icon">
              {{ info: 'ℹ', success: '✓', warning: '⚠', error: '✕' }[recentNotif.type]}
            </span>
            <span className="nb-toast-msg">{recentNotif.message}</span>
            <button className="nb-toast-close" onClick={e => { e.stopPropagation(); setRecentNotif(null); }}>✕</button>
          </div>
        </div>
      )}

      {/* Toast (기존 — 내부 시스템용 유지) */}
      <ToastContainer toasts={toasts} onDismiss={id => setToasts(prev => prev.filter(t => t.id !== id))} />
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════ */

export default function App() {
  return (
    <Routes>
      <Route path="/"      element={<MainScreen />} />
      <Route path="/office" element={<OfficeWrapper />} />
      <Route path="*"      element={<MainScreen />} />
    </Routes>
  );
}

function OfficeWrapper() {
  const navigate = useNavigate();
  return (
    <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', background: '#050508' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '8px 16px',
        background: '#0a0a12',
        borderBottom: '1px solid rgba(255,255,255,0.07)',
      }}>
        <button
          onClick={() => navigate('/')}
          style={{
            background: 'none', border: '1px solid rgba(255,255,255,0.12)',
            borderRadius: 6, color: '#64748b', fontSize: 12,
            padding: '4px 10px', cursor: 'pointer',
          }}
        >← 돌아가기</button>
        <span style={{ fontSize: 12, color: '#64748b' }}>가상 오피스</span>
      </div>
      {/* minHeight: 0 이 없으면 flex 아이템이 내용 높이 밑으로 줄어들지 않는다.
          안쪽 height:100% 가 갈 곳을 잃어 오피스가 화면 밖으로 자랐다. */}
      <div style={{ flex: 1, minHeight: 0 }}>
        <Suspense fallback={<div className="hs-lazy-fallback"><span className="hs-lazy-spinner" />가상 오피스를 불러오는 중…</div>}>
          <VirtualOffice />
        </Suspense>
      </div>
    </div>
  );
}
