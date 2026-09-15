import { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense } from 'react';
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom';
import OpsMap         from './components/OpsMap';
// 2D 사무실은 Phaser(minify 후 1.5MB)를 끌고 온다. 정적으로 물리면 메인 탭만
// 볼 사람도 전부 내려받는다. 탭을 열 때만 가져오도록 지연 로드한다.
const OfficeView   = lazy(() => import('./components/OfficeView'));
import AgentFeed       from './components/AgentFeed';
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
const ApprovalBox = lazy(() => import('./components/ApprovalBox'));
import { api, AgentSummary, deptLabels, type ApprovalRow, type ProjectRow } from './api';
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

function loadChatHistory(): ChatMsg[] {
  try {
    const raw = localStorage.getItem(CHAT_HISTORY_KEY);
    if (raw) return JSON.parse(raw) as ChatMsg[];
  } catch { /* ignore */ }
  return [];
}

function saveChatHistory(msgs: ChatMsg[]) {
  try { localStorage.setItem(CHAT_HISTORY_KEY, JSON.stringify(msgs.slice(-100))); } catch { /* ignore */ }
}

const MORNING_BRIEFING = `■ 아침 브리핑

안녕하세요 사장님,

오늘의 핵심 3가지는 다음과 같습니다:
• 팀 상태를 확인하고 오늘의 주요 태스크를 에이전트에게 시작하세요.
• 에이전트 간 통신 흐름을 실시간으로 확인할 수 있습니다.
• 지식 네트워크에 GitHub 리포지토리를 연결하면 에이전트 두뇌가 강화됩니다.

추천 액션: "오늘 할 일을 정리하고 각 부서에 지시해줘" 라고 입력해보세요.`;

const QUICK_CHIPS = [
  { icon: '🚀', label: '운영 시작 — AI 팀에게 오늘 일 시키기', dept: 'orchestration_dept' },
  { icon: '📊', label: '시장 트렌드 리포트 요청',              dept: 'research_dept' },
  { icon: '✍️', label: '콘텐츠 기획안 작성',                  dept: 'content_dept' },
  { icon: '💰', label: '매출·채널 현황 보고',                  dept: 'finance_dept' },
];

function nowStr() {
  return new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
}

/* ═══════════════════════════════════════════════════════════ */
function MainScreen() {
  const [agents,      setAgents]      = useState<AgentSummary[]>([]);
  const [messages,    setMessages]    = useState<ChatMsg[]>(() => {
    const saved = loadChatHistory();
    return saved.length > 0 ? saved : [{
      id: 'init', role: 'assistant', sender: '명테크 AI',
      text: MORNING_BRIEFING, ts: nowStr(),
    }];
  });
  const [input,       setInput]       = useState('');
  const [dept,        setDept]        = useState('orchestration_dept');
  const [running,     setRunning]     = useState(false);
  const [cycleStatus, setCycleStatus] = useState<string>('stopped');
  const [showSidebar, setShowSidebar] = useState(true);
  const [liveOpen,    setLiveOpen]    = useState(true);
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
  const [toasts,       setToasts]     = useState<ToastItem[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [recentNotif,  setRecentNotif] = useState<Notification | null>(null);
  const notifRef = useRef<HTMLDivElement>(null);
  const recentNotifTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [hiddenTasks,  setHiddenTasks] = useState<Set<string>>(new Set());
  const [showTeam,    setShowTeam]    = useState(false);
  const [showMemory,  setShowMemory]  = useState(false);
  const [showModel,   setShowModel]   = useState(false);
  const [showManage,  setShowManage]  = useState(false);
  const [activeTab,   setActiveTab]   = useState<'main' | 'office' | 'ceo' | 'agents' | 'projects' | 'notes'>('main');
  // CEO 룸 KPI 용. 결재·프로젝트는 태스크 큐와 다른 컬렉션이라, 이걸 세지
  // 않으면 프로젝트가 셋 돌아가는 중에도 대시보드가 전부 0 으로 보인다.
  const [ceoApprovals, setCeoApprovals] = useState<ApprovalRow[]>([]);
  const [ceoProjectList, setCeoProjectList] = useState<ProjectRow[]>([]);
  /* 카드를 눌렀을 때 '그것' 이 열리게 하는 표식. 예전에는 결재 카드는 아무
   * 반응이 없었고, 프로젝트 카드는 셋 다 똑같이 프로젝트 탭만 열어서 어느
   * 카드를 눌러도 같은 화면이 나왔다. */
  const [focusApproval, setFocusApproval] = useState<string | null>(null);
  const [focusProject, setFocusProject] = useState<string | null>(null);
  const [approvalOpen, setApprovalOpen] = useState(true);   // 결재함은 펼친 채 시작
  const [overrideTask, setOverrideTask] = useState<TaskItem | null>(null);
  const [showGridMenu, setShowGridMenu] = useState(false);
  const gridMenuRef = useRef<HTMLDivElement>(null);
  /* 공통 두뇌. 예전에는 여기 하드코딩된 값이 전부라 새로고침하면 사라졌고
   * 추론에는 아무 영향도 없었다. 이제 서버(runtime_config.json)에서 읽고,
   * 바꾸면 서버에 저장한다 — 디스패처가 같은 파일을 본다. */
  const [globalModel, setGlobalModelState] = useState('');
  useEffect(() => {
    api.getGlobalModel().then(d => { if (d?.global_model) setGlobalModelState(d.global_model); });
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
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
      fetch('/api/cycle/status').then(r => r.json()).then(d => setCycleStatus(d.status)).catch(() => {});
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
          setNotifications(prev => { if (prev.some(x => x.id === n.id)) return prev; return [n, ...prev].slice(0, 50); });
          setRecentNotif(n);
          if (recentNotifTimerRef.current) clearTimeout(recentNotifTimerRef.current);
          recentNotifTimerRef.current = setTimeout(() => setRecentNotif(null), 5000);
        } else if (isDone) {
          const n: Notification = { id: `notif-${e.event_id}`, type: 'success', message: `사이클 완료 — ${e.sender}`, time: new Date(e.timestamp ?? Date.now()), read: false, link: () => setActiveTab('ceo') };
          setNotifications(prev => { if (prev.some(x => x.id === n.id)) return prev; return [n, ...prev].slice(0, 50); });
          setRecentNotif(n);
          if (recentNotifTimerRef.current) clearTimeout(recentNotifTimerRef.current);
          recentNotifTimerRef.current = setTimeout(() => setRecentNotif(null), 5000);
        } else if (isWarn) {
          const n: Notification = { id: `notif-${e.event_id}`, type: 'warning', message: `[${e.sender}] ${p.slice(0, 70)}`, time: new Date(e.timestamp ?? Date.now()), read: false };
          setNotifications(prev => { if (prev.some(x => x.id === n.id)) return prev; return [n, ...prev].slice(0, 50); });
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
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages]);

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
      if (hiddenTasks.has(t.task_id)) continue;
      out.push({
        key: `t-${t.task_id}`, col: t.status, kind: '태스크', icon: '📋',
        title: t.instruction,
        sub: t.status === 'failed' ? (t.result ?? undefined) : undefined,
        meta: deptLabels[t.target_dept] ?? t.target_dept,
        onOpen: () => setDrawerTaskId(t.task_id),
      });
    }
    return out;
  }, [ceoApprovals, ceoProjectList, taskList, hiddenTasks]);

  const ceoCount = useMemo(() => ({
    pending: ceoCards.filter(c => c.col === 'pending').length,
    in_progress: ceoCards.filter(c => c.col === 'in_progress').length,
    done: ceoCards.filter(c => c.col === 'done').length,
    failed: ceoCards.filter(c => c.col === 'failed').length,
  }), [ceoCards]);

  useEffect(() => {
    if (activeTab !== 'ceo') return;          // 안 보는 화면을 폴링하지 않는다
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
        setMessages(prev => {
          const briefing = { id: Date.now().toString(), role: 'assistant' as const, sender: '명테크 AI', text: MORNING_BRIEFING, ts: nowStr() };
          return cmd === 'new-chat' ? [briefing] : [...prev, briefing];
        });
      }
    });
  }, []);

  const pushMsg = useCallback((msg: Omit<ChatMsg, 'id' | 'ts'>) => {
    setMessages(prev => [...prev, { ...msg, id: Date.now().toString(), ts: nowStr() }]);
  }, []);

  const pushToast = useCallback((type: ToastItem['type'], message: string) => {
    setToasts(prev => [...prev.slice(-4), { id: Date.now().toString(), type, message }]);
  }, []);

  const pushNotif = useCallback((type: Notification['type'], message: string, link?: () => void) => {
    const n: Notification = { id: Date.now().toString(), type, message, time: new Date(), read: false, link };
    setNotifications(prev => [n, ...prev].slice(0, 50));
    setRecentNotif(n);
    if (recentNotifTimerRef.current) clearTimeout(recentNotifTimerRef.current);
    recentNotifTimerRef.current = setTimeout(() => setRecentNotif(null), 5000);
  }, []);

  const send = async (text: string, targetDept: string) => {
    if (!text.trim() || running) return;
    setInput('');
    pushMsg({ role: 'user', sender: '사장님', text });
    setRunning(true);

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
        setToasts(prev => [...prev.slice(-4), { id: Date.now().toString(), type: 'success' as const, message: `✅ ${deptLabels[targetDept] ?? targetDept} 태스크 완료` }]);
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

        <button
          className="hs-start-btn"
          style={cycleStatus === 'stopped' ? {} : { background: '#ef4444' }}
          onClick={async () => {
            if (cycleStatus !== 'stopped') {
              await fetch('/api/cycle/stop', { method: 'POST' });
              setCycleStatus('stopped');
              pushMsg({ role: 'assistant', sender: '명테크 AI', text: '⏹ 24시간 에이전틱 사이클이 중지됐습니다.' });
              pushNotif('warning', '운영 사이클이 중지됐습니다');
            } else {
              const r = await fetch('/api/cycle/run_once', { method: 'POST' });
              const d = await r.json().catch(() => ({}));
              setCycleStatus(d.status ?? 'analyzing');
              pushMsg({ role: 'assistant', sender: '명테크 AI', text: '🚀 사이클 시작 — 분석 → 작전 검토 → 실행 순서로 진행됩니다.\n\n디스패처가 실행 중이어야 에이전트가 실제로 동작합니다.\n(WSL: python3 run.py dispatch daemon)' });
              pushNotif('success', '🚀 운영 사이클 시작 — 분석 중', () => setActiveTab('ceo'));
            }
          }}
        >
          {cycleStatus === 'stopped' ? '🚀 운영 시작' : cycleStatus === 'analyzing' ? '📊 분석 중…' : cycleStatus === 'strategizing' ? '🎯 작전 검토…' : cycleStatus === 'executing' ? '⚡ 실행 중…' : '⏹ 중지'}
        </button>

        {/* ── 알림 벨 ── */}
        <NotificationBell
          notifications={notifications}
          open={showNotifications}
          onToggle={() => setShowNotifications(v => !v)}
          onRead={id => setNotifications(prev => prev.map(n => n.id === id ? { ...n, read: true } : n))}
          onReadAll={() => setNotifications(prev => prev.map(n => ({ ...n, read: true })))}
          onRemove={id => setNotifications(prev => prev.filter(n => n.id !== id))}
          onClearAll={() => setNotifications([])}
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
                    icon: '📊', label: '시스템 현황판', active: showSidebar,
                    bg: 'rgba(139,92,246,0.15)', color: '#8B5CF6',
                    action: () => setShowSidebar(v => !v),
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
                    action: () => {
                      const fresh: ChatMsg[] = [{ id: Date.now().toString(), role: 'assistant', sender: '명테크 AI', text: MORNING_BRIEFING, ts: nowStr() }];
                      setMessages(fresh);
                      saveChatHistory(fresh);
                      pushNotif('info', '새 대화를 시작했습니다');
                    },
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
        <button className={`hs-tab ${activeTab === 'notes' ? 'active' : ''}`} onClick={() => setActiveTab('notes')}>
          📝 노트
        </button>
        <button className={`hs-tab ${activeTab === 'ceo' ? 'active' : ''}`} onClick={() => setActiveTab('ceo')}>
          👔 CEO 룸
        </button>
      </div>

      {/* ── Notes Tab ── */}
      {activeTab === 'notes' && (
        <Suspense fallback={<div className="hs-lazy-fallback">
          <div className="hs-lazy-spinner" /> 노트 불러오는 중…
        </div>}>
          <NotesTab />
        </Suspense>
      )}

      {/* ── Projects Tab ── */}
      {activeTab === 'projects' && (
        <Suspense fallback={<div className="hs-lazy-fallback">
          <div className="hs-lazy-spinner" /> 프로젝트 불러오는 중…
        </div>}>
          <ProjectsTab focusId={focusProject} onFocused={() => setFocusProject(null)} />
        </Suspense>
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

      {/* ── CEO 룸 탭 ── */}
      {activeTab === 'ceo' && (
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
            {hiddenTasks.size > 0 && (
              <button className="ceo-new-btn" style={{ background: 'rgba(148,163,184,0.15)', color: '#94A3B8', border: '1px solid rgba(148,163,184,0.3)' }}
                onClick={() => setHiddenTasks(new Set())}>
                👁 숨김 {hiddenTasks.size}개 표시
              </button>
            )}
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
            ] as [string, boolean, string, string][]).map(([label, ok, okTxt, errTxt]) => (
              <div key={label} className="hs-status-row">
                <span className={`hs-dot ${ok ? 'green' : 'red'}`} />
                <span className="hs-status-label">{label}</span>
                <span className={`hs-status-badge ${ok ? 'ok' : 'err'}`}>{ok ? okTxt : errTxt}</span>
              </div>
            ))}
            <div className="hs-status-row">
              <span className={`hs-dot ${cycleStatus !== 'stopped' ? 'amber' : 'gray'}`} />
              <span className="hs-status-label">사이클</span>
              <span className={`hs-status-badge ${cycleStatus !== 'stopped' ? 'run' : 'idle'}`}>
                {cycleStatus === 'stopped' ? '대기' : cycleStatus === 'analyzing' ? '분석중' : cycleStatus === 'strategizing' ? '작전중' : cycleStatus === 'executing' ? '실행중' : cycleStatus}
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
              <button key={status} className={`hs-task-stat hs-task-stat-btn`}
                onClick={() => {
                  const t = taskList.find(t => t.status === status);
                  if (t) setDrawerTaskId(t.task_id);
                }}>
                <span className={`hs-task-stat-num ${cls}`}>{num}</span>
                <span className="hs-task-stat-lbl">{lbl}</span>
              </button>
            ))}
          </div>

          {/* 최근 태스크 미니 리스트 */}
          {taskList.length > 0 && (
            <div className="hs-task-mini-list">
              {taskList.slice(0, 5).map(t => {
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

          {/* 상태보고 */}
          <div className="hs-sidebar-section-title">상태보고</div>
          <div className="hs-dept-list">
            {([
              ['orchestration_dept', '🧠', '오케스트레이션'],
              ['research_dept',      '🔬', '학술연구'],
              ['finance_dept',       '📈', '금융투자'],
              ['dev_dept',           '⚙️', '개발'],
              ['content_dept',       '✍️', '콘텐츠생산'],
            ] as [string, string, string][]).map(([d, icon, label]) => {
              const cnt    = agents.filter(a => a.department === d).length;
              const active = agents.filter(a => a.department === d && a.status !== 'Idle').length;
              return (
                <button
                  key={d}
                  className="hs-dept-card"
                  onClick={() => { setDept(d); send(`${label}팀 현재 상태와 진행 중인 태스크를 보고해줘.`, d); }}
                  title={`${label}팀 상태보고 요청`}
                >
                  <span className="hs-dept-icon">{icon}</span>
                  <span className="hs-dept-name">{label}</span>
                  <span className={`hs-dept-count ${active > 0 ? 'active' : ''}`}>{cnt}</span>
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
          {/* 실시간 활동 — 중앙 상단이 비어 있던 자리.
              부서 이벤트가 흐르므로 시스템이 살아 있는지 첫 화면에서 보인다. */}
          <section className={`hs-live ${liveOpen ? '' : 'collapsed'}`}>
            <div className="hs-live-head">
              <span className={`hs-live-pulse ${activeAgents > 0 || running ? '' : 'idle'}`} />
              <b>실시간 활동</b>
              <span>부서 간 상호작용 · 지식베이스 조회</span>
              <button
                className="hs-live-toggle"
                onClick={() => setLiveOpen(v => !v)}
                aria-expanded={liveOpen}
              >
                {liveOpen ? '접기' : '펼치기'}
              </button>
            </div>
            {liveOpen && (
              <div className="hs-live-body">
                <AgentFeed compact />
              </div>
            )}
          </section>

          {/* Chat section */}
          <div className="hs-chat-section">
            <div className="hs-chat-area">
              {messages.map(m => (
                <div key={m.id} className={`hs-msg ${m.role}`}>
                  <div className="hs-msg-avatar">
                    {m.role === 'assistant' ? '🤖' : '👤'}
                  </div>
                  <div className="hs-msg-body">
                    <div className="hs-msg-sender">{m.sender} · {m.ts}</div>
                    <div style={{ whiteSpace: 'pre-line' }}>{m.text}</div>
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


          {/* Chat input */}
          <div className="hs-input-bar">
            {/* 인라인 스타일이던 것을 클래스로 옮겼다. 좁은 화면에서 줄어들지도
                줄바꿈되지도 않아 전송 버튼을 화면 밖으로 밀어냈다. */}
            <select
              className="hs-dept-select"
              aria-label="지시할 부서 선택"
              value={dept}
              onChange={e => setDept(e.target.value)}
            >
              <option value="orchestration_dept">🧠 오케스트레이션</option>
              <option value="research_dept">🔬 학술연구</option>
              <option value="finance_dept">📈 금융투자</option>
              <option value="dev_dept">⚙️ 개발</option>
              <option value="content_dept">✍️ 콘텐츠</option>
            </select>

            {/* 인라인 flex 를 제거했다 — 클래스에 이미 flex:1 이 있고, 인라인이
                우선하는 바람에 모바일에서 줄바꿈(flex-basis:100%)이 먹지 않았다. */}
            <div className="hs-textarea-wrap">
              <textarea
                ref={textareaRef}
                className="hs-textarea"
                rows={1}
                placeholder="에이전트에게 무엇이든... (Enter 전송 · Shift+Enter 줄바꿈)"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
              />
            </div>

            <button
              className="hs-send-btn"
              onClick={() => send(input, dept)}
              disabled={running || !input.trim()}
            >↑</button>
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
      {showManage && (
        <ManageModal
          onClose={() => setShowManage(false)}
          agentCount={agents.length}
          globalModel={globalModel}
          onOpenTeam={() => { setShowManage(false); setShowTeam(true); }}
        />
      )}

      {/* Task Drawer */}
      <TaskDrawer taskId={drawerTaskId} onClose={() => setDrawerTaskId(null)} />

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
