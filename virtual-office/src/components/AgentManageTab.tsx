import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { pollInterval } from '../poll';
import { AgentSummary, AgentDetail, deptLabels, api, type DialogueEntry } from '../api';
import { deptColor, deptTint } from '../deptTheme';
import AgentChat from './AgentChat';

/* 픽셀 오피스는 열어 볼 때까지 필요 없다.
 *
 * 사무실을 펼치면 스프라이트를 한 번에 80장 받는다. 에이전트 탭을 그냥
 * 여는 사람(대부분)에게 그 비용을 미리 받을 이유가 없다. 전에는 「사무실」
 * 탭 자체가 lazy 였고, 지금은 탭이 사라졌으니 그 경계를 여기로 옮긴다. */
const PixelOffice = lazy(() => import('./PixelOffice'));

interface Props {
  agents: AgentSummary[];
  /** 픽셀 오피스의 가동 표시. 'stopped' 가 아니면 돌고 있는 것으로 본다. */
  cycleStatus: string;
  onDeploy: () => void;
  onDeptChat: (dept: string, msg: string) => void;
  /** 프로젝트 탭으로. 여기는 보는 곳이고, 일은 저기서 시작한다. */
  onOpenProjects?: () => void;
}

interface FeedEvent {
  event_id: string; sender: string; target: string;
  payload: string; timestamp?: string;
}

interface DiskVolume {
  mount: string;
  used_by: string[];
  free_gb: number | null;
  total_gb: number | null;
  used_gb?: number;
  percent: number | null;
  level: 'ok' | 'low' | 'critical' | 'unknown';
  error?: string;
}

interface SystemStats {
  cpu_percent: number;
  mem_percent: number;
  mem_used_gb: number;
  mem_total_gb: number;
  /** ROOT 가 사는 볼륨 하나뿐이다(= D:). 남겨 두지만 게이지는 volumes 를 쓴다. */
  disk_percent?: number;
  /** **작업** 볼륨만, 빠듯한 쪽부터. volumes[0] 이 우리 일을 먼저 막을 볼륨. */
  volumes?: DiskVolume[];
  /** 윈도우가 사는 볼륨. 명테크는 여기에 쓰지 않으므로 칸이 다르다. */
  disk_system?: DiskVolume | null;
  disk_level?: 'ok' | 'low' | 'critical' | 'unknown';
  disk_notes?: string[];
  error?: string;
}

const DISK_COLOR: Record<string, string> = {
  ok: '#FB923C', low: '#FBBF24', critical: '#F87171', unknown: '#94A3B8',
};

/* 부서 메타.
 *
 * **색은 `deptTheme` 하나만 쓴다.** 전에는 이 파일이 색을 직접 들고 있어서,
 * 같은 학술연구부가 에이전트 탭에서는 청록(#2DD4BF)·사무실 방에서는
 * 파랑(#60a5fa) 이었다. 두 화면이 한 탭으로 합쳐지면 그 불일치가 같은
 * 화면 안에서 나란히 보인다 — 위의 파란 방에 앉은 사람이 아래 카드에서는
 * 청록이 된다. 기준은 사무실 방 색이다(사용자가 가장 오래 보는 화면).
 *
 * 이름도 `deptLabels`(정본) 하나만 쓴다. 'CEO실' 같은 별칭을 부서 이름
 * 자리에 두면 CEO 가 에이전트 부서인 것처럼 읽힌다 — CEO 는 사장님이다. */
const DEPT_META: Record<string, { icon: string; role: string; desc: string }> = {
  orchestration_dept: { icon: '🧠', role: 'Chief Orchestrator',  desc: '전체 에이전트 워크플로우를 조정하고 태스크를 배분합니다.' },
  research_dept:      { icon: '🔬', role: 'Research Specialist', desc: '복잡한 데이터를 분석하고 심층 인사이트를 제공합니다.' },
  dev_dept:           { icon: '⚙️', role: 'System Architect',    desc: '효율적인 코드 구조를 설계하고 자동화 시스템을 구축합니다.' },
  finance_dept:       { icon: '📈', role: 'Market Analyst',      desc: '금융 데이터를 실시간 감시하고 자산 배분 전략을 수립합니다.' },
  content_dept:       { icon: '✍️', role: 'Content Creator',     desc: '고품질 콘텐츠를 기획하고 제작하는 창의적 에이전트입니다.' },
};

const DEPT_ORDER = ['orchestration_dept', 'research_dept', 'dev_dept', 'finance_dept', 'content_dept'];

/** 부서 이름. 정본에 없으면 id 를 그대로 — 조용히 빈 칸을 남기면
 *  "부서가 사라졌다" 로 읽힌다. */
function deptName(id: string): string {
  return deptLabels[id] ?? id;
}

function fmtTime(ts?: string) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

function cleanPayload(raw: string): string {
  const s = raw.trim().replace(/^\[task-[^\]]+\]\s*/g, '');
  if (s.startsWith('{')) {
    try {
      const obj = JSON.parse(s);
      if (obj.type === 'cycle_complete') {
        const txt = (obj.analysis ?? '').replace(/#{1,4}\s+/g, '').replace(/\*\*/g, '').replace(/\n/g, ' ').trim();
        return `사이클 완료 — ${txt.slice(0, 80)}`;
      }
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
    } catch {
      setError('서버 연결 오류');
    } finally {
      setSaving(false);
    }
  };

  const deptId = agent.department ?? 'orchestration_dept';
  const meta = DEPT_META[deptId] ?? DEPT_META['orchestration_dept'];
  const color = deptColor(deptId);

  return (
    <div className="pem-bg" onClick={() => onClose()}>
      <div className="pem-modal" onClick={e => e.stopPropagation()}>
        <div className="pem-header" style={{ borderBottomColor: deptTint(deptId, 0.4) }}>
          <div className="pem-avatar" style={{ background: deptTint(deptId, 0.08), borderColor: deptTint(deptId, 0.4) }}>
            <span style={{ fontSize: 22 }}>{meta.icon}</span>
          </div>
          <div>
            <div className="pem-title">에이전트 페르소나 편집</div>
            <div className="pem-sub" style={{ color }}>{meta.role}</div>
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
            style={{ background: color }}>
            {saving ? '저장 중...' : '변경사항 저장'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════
   에이전트 탭 — 「사무실」을 여기로 합쳤다.
   ═══════════════════════════════════════════════════════════════════

   전에는 탭이 둘이었다. 「사무실」은 픽셀 캔버스 + 부서 칩 + 대화/운영
   피드, 「에이전트」는 부서 카드 + 같은 운영 피드 + 성능 게이지. 둘 다
   `/api/events` 를 따로 폴링하고, 둘 다 "어느 부서가 일하는가" 를 보여
   주고, 부서 이름과 색이 서로 달랐다. **같은 질문에 두 화면이 서로 다른
   답을 하고 있었다.**

   한 화면은 한 질문에 답한다. 이 화면의 질문은 "누가 무엇을 하고 있나"
   하나다. 그래서:

   · 부서를 하나 고르면 **카드가 펼쳐지고 + 아래 피드가 그 부서로
     걸린다.** 고르는 동작 하나가 화면 전체를 설명한다.
   · 사무실은 같은 것을 **다르게 보는 방식**이라 접어 둔다(기본 접힘).
     픽셀 오피스에서 사람을 누르면 그 부서가 선택된다 — 캔버스가
     카드로 들어가는 또 하나의 입구다.
   · 처음엔 요약 한 줄만 보인다. 자세한 것은 고른 다음에.

   **없앤 것 하나.** 사무실의 「이 에이전트에게 직접 지시」 모달은
   사람 이름을 띄워 놓고 실제로는 `onDeptChat(그 사람의 부서, …)` 를
   불렀다 — 이름은 장식이고 말은 부서로 갔다. 서버는 애초에 부서
   단위로만 지시를 받는다. 그래서 지시 입력칸을 **부서 카드 안**으로
   옮겼다. 할 수 없는 일을 할 수 있는 것처럼 보이지 않게. */
export default function AgentManageTab({ agents, cycleStatus, onDeploy, onDeptChat, onOpenProjects }: Props) {
  const [feed, setFeed] = useState<FeedEvent[]>([]);
  const [dialogue, setDialogue] = useState<DialogueEntry[]>([]);
  const [stats, setStats] = useState<SystemStats | null>(null);
  const [editAgent, setEditAgent] = useState<AgentDetail | null>(null);

  /** 고른 부서. null 이면 전부. 카드 펼침과 피드 필터가 **같은 값**이다. */
  const [pickedDept, setPickedDept] = useState<string | null>(null);
  /** 사무실 펼침. 기본 접힘 — 스프라이트 80장은 열어 볼 때만 받는다. */
  const [showOffice, setShowOffice] = useState(false);
  /** 아래 패널. 기본은 에이전트 대화 — 운영 피드는 시스템 로그에 가깝다. */
  const [panel, setPanel] = useState<'chat' | 'feed'>('chat');
  /** 성능 게이지. 평소엔 접어 둔다 — 경고는 접혀 있어도 보인다. */
  const [showPerf, setShowPerf] = useState(false);
  /** 부서 카드 안의 지시 입력. */
  const [deptMsg, setDeptMsg] = useState('');
  /** 오케스트레이터 명령줄(사무실 하단). */
  const [cmdInput, setCmdInput] = useState('');

  const chatScrollRef = useRef<HTMLDivElement>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const deptGridRef = useRef<HTMLDivElement>(null);

  const activeCount = agents.filter(a => a.status !== 'Idle').length;
  const idleCount   = agents.filter(a => a.status === 'Idle').length;

  useEffect(() => {
    const load = () => fetch('/api/events').then(r => r.json())
      .then(d => setFeed((d.events ?? []).slice(-40).reverse())).catch(() => {});
    load();
    const t = pollInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const load = () => api.dialogue(80).then(r => { if (r?.dialogue) setDialogue(r.dialogue); });
    void load();
    const t = pollInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const loadStats = () => fetch('/api/system/stats').then(r => r.json())
      .then(d => setStats(d)).catch(() => {});
    loadStats();
    const t = pollInterval(loadStats, 5000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [feed]);

  // 새 말이 오면 맨 아래(가장 최근)로. 대화는 위에서 아래로 읽는다.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el && panel === 'chat') el.scrollTop = el.scrollHeight;
  }, [dialogue.length, panel]);

  // 부서를 바꾸면 쓰던 지시문은 버린다 — 연구실에 쓰던 말이 금융부로
  // 따라가면 엉뚱한 곳에 전송된다.
  useEffect(() => { setDeptMsg(''); }, [pickedDept]);

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

  /** 보낸 쪽의 부서. 부서 id 가 그대로 오기도 하고 사람 이름이 오기도 한다. */
  const deptOfSender = (s: string) => {
    if (DEPT_META[s]) return s;
    const a = agents.find(x => x.agent_id === s || x.character_name === s);
    return a?.department ?? 'orchestration_dept';
  };
  const senderLabel = (s: string) => {
    if (DEPT_META[s]) return deptName(s);
    const a = agents.find(x => x.agent_id === s || x.character_name === s);
    return a?.character_name ?? s;
  };

  /** 고른 부서만. 주고받은 쪽 어느 하나라도 걸리면 보인다. */
  const shownDialogue = pickedDept
    ? dialogue.filter(d => d.from_dept === pickedDept || d.to_dept === pickedDept)
    : dialogue;
  const shownFeed = pickedDept
    ? feed.filter(e => deptOfSender(e.sender) === pickedDept || deptOfSender(e.target) === pickedDept)
    : feed;

  /** 부서를 고른다. 캔버스에서 눌렀을 때는 카드까지 끌어다 보여 준다. */
  const pickDept = (deptId: string, scroll = false) => {
    setPickedDept(prev => (prev === deptId ? null : deptId));
    if (scroll) {
      setTimeout(() => deptGridRef.current
        ?.querySelector(`[data-dept="${deptId}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);
    }
  };

  const sendDeptMsg = () => {
    if (!pickedDept || !deptMsg.trim()) return;
    onDeptChat(pickedDept, deptMsg.trim());
    setDeptMsg('');
  };

  const sendCmd = () => {
    if (!cmdInput.trim()) return;
    onDeptChat('orchestration_dept', cmdInput.trim());
    setCmdInput('');
  };

  const agentGaugeValue = agents.length > 0 ? Math.round(activeCount / agents.length * 100) : 0;

  // 서버가 빠듯한 쪽부터 정렬해 보내므로 [0] 이 가장 급한 볼륨이다.
  // 정렬을 여기서 다시 하지 않는다 — 두 곳에서 정렬하면 한쪽만 고치고
  // 화면과 맹비서가 다른 볼륨을 가리키게 된다.
  const tightDisk = stats?.volumes?.[0] ?? null;
  const sysDisk = stats?.disk_system ?? null;
  const diskNotes = stats?.disk_notes ?? [];
  /** 접혀 있어도 꼭 보여야 하는 경고. 디스크가 빠듯하면 일이 멈춘다. */
  const diskAlarm = (tightDisk && (tightDisk.level === 'critical' || tightDisk.level === 'low'))
    ? `${tightDisk.mount.replace(/[\\/]+$/, '')} ${Math.round(tightDisk.percent ?? 0)}%`
    : null;

  /* 한 줄 요약. 숫자를 늘어놓지 않고 **지금 상태**를 한국말로 말한다. */
  const summary = agents.length === 0
    ? '배포된 에이전트가 없습니다'
    : activeCount === 0
      ? `${agents.length}명 · 전원 대기`
      : `${agents.length}명 · ${activeCount}명 작업 중`;

  const recentFeed = feed.slice(0, 5);

  // 중요 이벤트 (실패·오류 키워드)
  const isCritical = (e: FeedEvent) =>
    e.payload.toLowerCase().includes('fail') ||
    e.payload.toLowerCase().includes('error') ||
    e.payload.includes('이상') ||
    e.payload.includes('오류');

  return (
    <div className="am-root">
      <div className="am-bg-deco" />

      {/* ══ 머리: 한 줄로 끝낸다 ══ */}
      <section className="am-header">
        <div>
          <h2 className="am-title">에이전트</h2>
          <p className="am-subtitle">{summary}</p>
        </div>
        <div className="am-badges">
          {activeCount > 0 && (
            <div className="am-badge">
              <span className="am-badge-dot" style={{ background: '#2DD4BF', boxShadow: '0 0 8px #2DD4BF' }} />
              활성 {activeCount}
            </div>
          )}
          {idleCount > 0 && (
            <div className="am-badge">
              <span className="am-badge-dot" style={{ background: '#94A3B8' }} />
              대기 {idleCount}
            </div>
          )}
          {diskAlarm && (
            <button className="am-badge am-badge-warn" onClick={() => setShowPerf(true)}
                    title="클러스터 성능 펼치기">
              ⚠️ 디스크 {diskAlarm}
            </button>
          )}
          <button className={`am-office-btn ${showOffice ? 'on' : ''}`}
                  onClick={() => setShowOffice(v => !v)}
                  aria-expanded={showOffice}>
            🏢 사무실 {showOffice ? '접기' : '보기'}
          </button>
          <button className="am-deploy-btn" onClick={onDeploy}>
            ＋ 신규 배포
          </button>
        </div>
      </section>

      {/* ══ 사무실 — 같은 것을 다르게 보는 방식 ══

          기본은 접힘이다. 보고 싶을 때만 펼친다. 캔버스에서 사람을 누르면
          그 부서가 선택되고 아래 카드로 끌어다 준다 — 모달을 띄우지
          않는다. 사무실은 보는 곳이고, 손대는 곳은 아래 카드다. */}
      {showOffice && (
        <section className="am-office">
          <div className="ov-pixel-panel">
            <div className="ov-pixel-viewport">
              <div className="ov-dot-grid" />
              <div className="ov-canvas-inner">
                <Suspense fallback={<div className="am-office-loading">2D 사무실을 불러오는 중…</div>}>
                  <PixelOffice
                    agents={agents}
                    cycleStatus={cycleStatus}
                    recentMessages={recentFeed.map(e => ({ sender: e.sender, target: e.target, payload: e.payload }))}
                    onAgentClick={(agentId) => {
                      const a = agents.find(x => x.agent_id === agentId);
                      if (a?.department) pickDept(a.department, true);
                    }}
                  />
                </Suspense>
              </div>

              {/* 일하는 부서만 말풍선 */}
              <div className="ov-dept-overlay">
                {DEPT_ORDER.map(deptId => {
                  const deptAgents = agents.filter(a => a.department === deptId);
                  if (!deptAgents.some(a => a.status !== 'Idle')) return null;
                  const color = deptColor(deptId);
                  const recentMsg = recentFeed.find(e => deptOfSender(e.sender) === deptId);
                  return (
                    <div key={deptId} className="ov-dept-bubble">
                      <div className="ov-dept-bubble-msg" style={{ borderColor: color }}>
                        <span style={{ fontSize: 11, fontFamily: 'JetBrains Mono, monospace', color }}>
                          {recentMsg ? cleanPayload(recentMsg.payload).slice(0, 40) : `${deptName(deptId)} 작업 중`}
                        </span>
                      </div>
                      <div className="ov-dept-bubble-tag"
                           style={{ background: deptTint(deptId, 0.12), borderColor: deptTint(deptId, 0.3), color }}>
                        {DEPT_META[deptId].icon} {deptName(deptId)}
                      </div>
                    </div>
                  );
                })}
              </div>

              <div className="ov-status-overlay">
                <div className="ov-status-dot-row">
                  <div className={`ov-status-dot ${cycleStatus !== 'stopped' ? 'active' : ''}`} />
                  <span style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 11, color: cycleStatus !== 'stopped' ? '#2DD4BF' : '#64748B', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                    {cycleStatus !== 'stopped' ? '오피스_렌더링_활성' : '오피스_대기_중'}
                  </span>
                </div>
                <div style={{ fontFamily: 'JetBrains Mono, monospace', fontSize: 10, color: '#64748B' }}>
                  에이전트: {String(agents.length).padStart(2, '0')} | 활성: {String(activeCount).padStart(2, '0')} | 이벤트: {feed.length}
                </div>
              </div>
            </div>

            {/* 오케스트레이터 명령줄.

                전에는 "모든 에이전트에게 명령 전송..." 이라고 적혀 있었다.
                실제로는 `onDeptChat('orchestration_dept', …)` 한 곳으로만
                간다 — 받는 사람을 틀리게 적어 둔 입력칸이었다. */}
            <div className="ov-terminal-bar">
              <span className="ov-terminal-prompt">&gt;</span>
              <input
                className="ov-terminal-input"
                value={cmdInput}
                onChange={e => setCmdInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendCmd()}
                placeholder="오케스트레이터에게 지시… (엔터로 전송, 대화창이 열립니다)"
              />
              <div className="ov-terminal-cursor" />
            </div>
          </div>
        </section>
      )}

      {/* ══ 부서 카드 — 고르면 펼쳐지고, 아래 피드가 같이 걸린다 ══ */}
      <div className="am-grid" ref={deptGridRef}>
        {DEPT_ORDER.map(deptId => {
          const meta = DEPT_META[deptId];
          const color = deptColor(deptId);
          const deptAgents = agents.filter(a => a.department === deptId);
          const busy = deptAgents.find(a => a.status !== 'Idle');
          const open = pickedDept === deptId;
          return (
            <div key={deptId} data-dept={deptId}
              className={`am-card ${busy ? 'am-card-active' : ''} ${open ? 'am-card-open' : ''}`}
              style={{ '--card-color': color, '--card-border': deptTint(deptId, 0.4) } as React.CSSProperties}>
              <div className="am-card-glow" style={{ background: color }} />

              {/* 접힌 상태에서 보이는 전부. 이름 · 인원 · 지금 무엇을 하는가. */}
              <button className="am-card-head" onClick={() => pickDept(deptId)}
                      aria-expanded={open}>
                <span className="am-card-ico" style={{ background: deptTint(deptId, 0.1), borderColor: deptTint(deptId, 0.4) }}>
                  {meta.icon}
                </span>
                <span className="am-card-headtext">
                  <span className="am-card-name">{deptName(deptId)}</span>
                  <span className="am-card-line">
                    {deptAgents.length}명
                    {busy
                      ? <> · <span style={{ color }}>{busy.doing || '작업 중'}</span></>
                      : <> · 대기</>}
                  </span>
                </span>
                {busy && <span className="am-card-live" style={{ background: color }} />}
                <span className={`am-card-caret ${open ? 'on' : ''}`} aria-hidden="true">▾</span>
              </button>

              {/* 고른 다음에 나오는 것 */}
              {open && (
                <div className="am-card-detail">
                  <div className="am-card-role" style={{ color }}>{meta.role}</div>
                  <p className="am-card-desc">{meta.desc}</p>

                  <div className="am-team-label">팀원 {deptAgents.length}명 — 누르면 페르소나 편집</div>
                  <div className="am-team-list">
                    {deptAgents.length === 0
                      ? <span className="am-chip-empty">에이전트 없음</span>
                      : deptAgents.map(a => (
                        <div key={a.agent_id} className="am-team-member-wrap">
                          <button className="am-team-member"
                            style={{
                              borderColor: a.status !== 'Idle' ? color : 'rgba(255,255,255,0.1)',
                              color: a.status !== 'Idle' ? color : '#94A3B8',
                            }}
                            onClick={() => openPersona(a.agent_id)}
                            title={`${a.character_name} — 클릭하여 편집`}>
                            <span className="am-member-name">{a.character_name}</span>
                            <span className="am-member-role">{a.role.split(' ')[0]}</span>
                            {a.status !== 'Idle' && <span className="am-chip-live" style={{ background: color }} />}
                          </button>
                          <button className="am-member-del"
                            title="에이전트 제거"
                            onClick={async e => {
                              e.stopPropagation();
                              if (!confirm(`"${a.character_name}" 에이전트를 제거하시겠습니까?`)) return;
                              // **응답을 본다.** 전에는 결과를 버리고 무조건 행을
                              // 숨겼다 — 500 이 와도 지워진 것처럼 보였다. 실패를
                              // 성공처럼 보이게 하는 것이 제일 나쁘다.
                              const row = e.currentTarget.closest('.am-team-member-wrap') as HTMLElement | null;
                              let ok = false;
                              try {
                                const r = await fetch(`/api/agents/${a.agent_id}`, { method: 'DELETE' });
                                ok = r.ok;
                                if (!ok) {
                                  const d = await r.json().catch(() => null);
                                  alert(`제거하지 못했습니다 (${r.status})`
                                        + (d?.error ? ` — ${d.error}` : ''));
                                }
                              } catch {
                                alert('제거하지 못했습니다 — 서버에 닿지 못했습니다');
                              }
                              if (!ok) return;
                              // 성공했을 때만 숨긴다. 머릿수 배지는 상위가 들고
                              // 있어 여기서 못 고치므로 새로고침해야 맞는다.
                              row?.style.setProperty('display', 'none');
                            }}>✕</button>
                        </div>
                      ))
                    }
                  </div>

                  {/* 이 부서에 지시.

                      사무실의 「이 에이전트에게 직접 지시」 를 여기로 옮겼다.
                      그쪽은 사람 이름을 띄워 놓고 실제로는 그 사람의 **부서**
                      로 보냈다. 서버가 부서 단위로만 받으므로, 받는 단위를
                      화면에도 그대로 적는다. */}
                  <div className="am-card-say">
                    <input
                      className="am-say-input"
                      value={deptMsg}
                      onChange={e => setDeptMsg(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendDeptMsg()}
                      placeholder={`${deptName(deptId)}에 지시…`}
                    />
                    <button className="am-say-send" onClick={sendDeptMsg}
                            disabled={!deptMsg.trim()} style={{ background: color }}>
                      전송
                    </button>
                  </div>
                  <div className="am-card-hint">
                    전송하면 대화창이 열립니다 — 맹비서가 그 부서로 넘깁니다.
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ══ 주고받은 말 — 고른 부서만 ══ */}
      <section className="am-talk">
        <div className="am-talk-head">
          <div className="ov-panel-tabs" role="tablist">
            <button role="tab" aria-selected={panel === 'chat'}
                    className={`ov-panel-tab ${panel === 'chat' ? 'active' : ''}`}
                    onClick={() => setPanel('chat')}>
              💬 에이전트 대화{shownDialogue.length > 0 && <span className="ov-panel-count">{shownDialogue.length}</span>}
            </button>
            <button role="tab" aria-selected={panel === 'feed'}
                    className={`ov-panel-tab ${panel === 'feed' ? 'active' : ''}`}
                    onClick={() => setPanel('feed')}>
              ◉ 운영 피드
            </button>
          </div>
          <button className="am-talk-go" onClick={() => onOpenProjects?.()}>
            프로젝트에서 일 시키기 →
          </button>
        </div>

        {/* 무엇을 걸러 보고 있는지 **화면에 적는다.** 걸러 놓은 것을 잊으면
            "대화가 없다" 로 읽힌다. */}
        {pickedDept && (
          <div className="am-filter-note">
            {deptName(pickedDept)} 것만 보고 있습니다
            <button className="am-filter-clear" onClick={() => setPickedDept(null)}>전체 보기</button>
          </div>
        )}

        {/* 조용하면 조용하다고 말한다.

            전에는 닷새 전 대화를 띄워 놓고 그 아래에 "새 데이터 스트림
            대기 중..." 이라고 적었다. 지난 기록이 방금 일처럼 읽힌다.
            스크롤 **밖에** 둔다 — 안에 넣으면 맨 아래로 밀려 안 보인다. */}
        {panel === 'chat' && (() => {
          const last = shownDialogue[shownDialogue.length - 1];
          if (!last?.at) return null;
          const ms = last.at > 1e12 ? last.at : last.at * 1000;
          if ((Date.now() - ms) / 60000 < 60) return null;
          const when = new Date(ms).toLocaleString('ko-KR',
            { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
          return (
            <div className="ov-stale-note">
              지난 기록입니다 — 마지막 활동 {when}. 지금은 조용합니다.
            </div>
          );
        })()}

        {panel === 'chat' && (
          <div className="am-talk-body ov-chat" ref={chatScrollRef}>
            <AgentChat entries={shownDialogue} showProject
              emptyText={pickedDept
                ? `${deptName(pickedDept)}가 주고받은 말이 아직 없습니다.`
                : '프로젝트가 돌면 에이전트끼리 주고받는 말이 여기 쌓입니다 — 제출 · 검토 · 반려 · 인계.'} />
          </div>
        )}

        {panel === 'feed' && (
          <div className="am-talk-body am-log-body" ref={logRef}>
            {shownFeed.length === 0 && (
              <div className="am-log-empty">
                {pickedDept
                  ? `${deptName(pickedDept)} 활동 기록이 아직 없습니다.`
                  : '에이전트 활동을 기다리는 중...'}
              </div>
            )}
            {shownFeed.slice(0, 40).map(e => {
              const dept = deptOfSender(e.sender);
              const color = deptColor(dept);
              const cleaned = cleanPayload(e.payload);
              if (isCritical(e)) {
                return (
                  <div key={e.event_id} className="ov-msg-critical">
                    <div className="ov-msg-critical-header">
                      <span style={{ color: '#EF4444', fontWeight: 700, fontSize: 10 }}>[중요_보고]</span>
                      <span style={{ color: '#475569', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>[{fmtTime(e.timestamp)}]</span>
                    </div>
                    <div style={{ fontSize: 12, color: '#CBD5E1', lineHeight: 1.5 }}>
                      <span style={{ color, fontWeight: 700 }}>{senderLabel(e.sender)}</span>에서 이상 감지: {cleaned}
                    </div>
                  </div>
                );
              }
              return (
                <div key={e.event_id} className="am-log-row">
                  <span className="am-log-time">[{fmtTime(e.timestamp)}]</span>
                  <span className="am-log-text" style={{ color }}>{senderLabel(e.sender)}</span>
                  <span className="am-log-arrow">→</span>
                  <span className="am-log-msg">{cleaned}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ══ 클러스터 성능 — 평소엔 접어 둔다 ══

          숫자 다섯 줄이 늘 펼쳐져 있을 이유가 없다. 다만 **경고는
          접혀 있어도 나온다** — 디스크가 차면 일이 멈추니까. */}
      <section className="am-perf-sec">
        <button className="am-perf-toggle" onClick={() => setShowPerf(v => !v)}
                aria-expanded={showPerf}>
          <span>클러스터 성능</span>
          <span className="am-perf-peek">
            {stats
              ? `CPU ${Math.round(stats.cpu_percent)}% · 메모리 ${Math.round(stats.mem_percent)}%${tightDisk?.percent != null ? ` · 디스크 ${Math.round(tightDisk.percent)}%` : ''}`
              : '서버 연결 대기 중…'}
          </span>
          <span className={`am-card-caret ${showPerf ? 'on' : ''}`} aria-hidden="true">▾</span>
        </button>

        {(diskNotes.length > 0 || (tightDisk && tightDisk.level === 'unknown')) && (
          <div className="am-disk-warn">
            {diskNotes.map((n, i) => (
              <div key={i} className="am-disk-warn-row">⚠️ {n}</div>
            ))}
            {tightDisk && tightDisk.level === 'unknown' && (
              <div className="am-disk-warn-row">
                ⚠️ {tightDisk.mount} 조회 못 함 — 여유가 있다는 뜻이 아닙니다
              </div>
            )}
          </div>
        )}

        {showPerf && (
          <div className="am-perf-bars">
            {[
              { label: 'CPU 부하', value: stats?.cpu_percent ?? 0, color: '#8B5CF6', suffix: '%' },
              { label: '메모리', value: stats?.mem_percent ?? 0, color: '#2DD4BF',
                sub: stats ? `${stats.mem_used_gb}GB / ${stats.mem_total_gb}GB` : '' },
              // 가장 빠듯한 볼륨을 그린다. 전에는 D: 만 봤고, 그래서 C: 가
              // 92.4% 일 때 게이지는 48% 를 가리켰다 — 안심시키는 숫자였다.
              {
                label: tightDisk ? `디스크 ${tightDisk.mount.replace(/[\\/]+$/, '')}` : '디스크',
                value: tightDisk?.percent ?? stats?.disk_percent ?? 0,
                color: DISK_COLOR[tightDisk?.level ?? 'ok'] ?? '#FB923C',
                suffix: '%',
                sub: tightDisk?.free_gb != null ? `${tightDisk.free_gb}GB 남음` : '',
              },
              // 시스템 볼륨은 따로 칸을 준다. 게이지 하나에 섞으면 늘 92% 인
              // C: 가 작업 볼륨을 가려 버린다 — 바로 그게 처음의 버그였다.
              ...(sysDisk && sysDisk.percent != null ? [{
                label: `시스템 ${sysDisk.mount.replace(/[\\/]+$/, '')} (명테크 미사용)`,
                value: sysDisk.percent,
                color: DISK_COLOR[sysDisk.level] ?? '#94A3B8',
                suffix: '%',
                sub: sysDisk.free_gb != null ? `${sysDisk.free_gb}GB 남음` : '',
              }] : []),
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
            <button className="am-optimize-btn"
              onClick={() => fetch('/api/system/stats').then(r => r.json()).then(d => setStats(d)).catch(() => {})}>
              🔄 새로고침
            </button>
          </div>
        )}
      </section>

      {/* 페르소나 편집 모달 */}
      {editAgent && (
        <PersonaEditModal
          agent={editAgent}
          onClose={() => setEditAgent(null)}
        />
      )}
    </div>
  );
}
