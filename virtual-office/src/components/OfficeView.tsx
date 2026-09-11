import { useState, useEffect, useRef } from 'react';
import PixelOffice from './PixelOffice';
import AgentChat from './AgentChat';
import { deptColor, deptTint } from '../deptTheme';
import { api, type DialogueEntry } from '../api';

interface Agent {
  agent_id: string;
  character_name: string;
  role: string;
  department?: string;
  status?: string;
  level?: number;
}
interface FeedEvent {
  event_id: string;
  sender: string;
  target: string;
  payload: string;
  timestamp?: string;
}

interface Props {
  agents: Agent[];
  cycleStatus: string;
  taskSummary: { pending: number; in_progress: number; done: number; failed: number };
  onDeptChat: (dept: string, msg: string) => void;
}

const DEPT_META: Record<string, { icon: string; label: string; color: string; bg: string; room: string }> = {
  // 색은 deptTheme.ts 가 기준 — 사무실 방 색과 같다.
  orchestration_dept: { icon: '🧠', label: 'CEO실',     color: deptColor('orchestration_dept'), bg: deptTint('orchestration_dept', 0.08), room: 'CEO·오케스트레이션' },
  research_dept:      { icon: '🔬', label: '연구실',    color: deptColor('research_dept'),      bg: deptTint('research_dept', 0.08),      room: '학술연구팀' },
  finance_dept:       { icon: '📈', label: '금융실',    color: deptColor('finance_dept'),       bg: deptTint('finance_dept', 0.08),       room: '금융투자팀' },
  dev_dept:           { icon: '⚙️', label: '개발실',    color: deptColor('dev_dept'),           bg: deptTint('dev_dept', 0.08),           room: '개발팀' },
  content_dept:       { icon: '✍️', label: '콘텐츠실', color: deptColor('content_dept'),       bg: deptTint('content_dept', 0.08),       room: '콘텐츠생산팀' },
};

const ROLE_EMOJI: Record<string, string> = {
  'Master Orchestrator': '👑', 'Project Manager': '📋',
  'Software Engineer': '💻', 'QA Engineer': '🔎',
  'Visual Designer': '🎨', 'Content Writer': '✏️',
  'Financial Analyst': '📊', 'Research Crawler': '🌐', 'Data Engineer': '🗄️',
};

function initials(name: string) { return name.slice(0, 1); }

function cleanPayload(raw: string): string {
  let s = raw.trim().replace(/^\[task-[^\]]+\]\s*/g, '');
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
    .split('\n').map(l => l.trim()).find(l => l.length > 2) ?? s.slice(0, 100);
}

function fmtTs(ts?: string) {
  if (!ts) return '';
  return new Date(ts).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export default function OfficeView({ agents, cycleStatus, taskSummary, onDeptChat }: Props) {
  const [feed, setFeed]             = useState<FeedEvent[]>([]);
  const [activeAgent, setActiveAgent] = useState<Agent | null>(null);
  const [agentModal,  setAgentModal] = useState(false);
  const [chatInput,   setChatInput]  = useState('');
  const [cmdInput,    setCmdInput]   = useState('');
  const feedScrollRef = useRef<HTMLDivElement>(null);
  /* 오른쪽 패널. 기본은 에이전트 대화 — 사무실에서 보고 싶은 것은 '누가 누구와
     무엇을 주고받는가' 이고, 운영 피드는 시스템 로그에 가깝다. */
  const [panel,    setPanel]    = useState<'chat' | 'feed'>('chat');
  const [dialogue, setDialogue] = useState<DialogueEntry[]>([]);
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const feedEndRef    = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const load = () => fetch('/api/events').then(r => r.json())
      .then(d => setFeed((d.events ?? []).slice(-40).reverse())).catch(() => {});
    load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const el = feedScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [feed]);

  useEffect(() => {
    const load = () => api.dialogue(80).then(r => { if (r?.dialogue) setDialogue(r.dialogue); });
    void load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, []);

  // 새 말이 오면 맨 아래(가장 최근)로. 대화는 위에서 아래로 읽는다.
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el && panel === 'chat') el.scrollTop = el.scrollHeight;
  }, [dialogue.length, panel]);

  const senderLabel = (s: string) => {
    const meta = DEPT_META[s];
    if (meta) return meta.room;
    const a = agents.find(x => x.agent_id === s || x.character_name === s);
    return a?.character_name ?? s;
  };

  const deptOfSender = (s: string) => {
    if (DEPT_META[s]) return s;
    const a = agents.find(x => x.agent_id === s || x.character_name === s);
    return a?.department ?? 'orchestration_dept';
  };

  const sendCmd = () => {
    if (!cmdInput.trim()) return;
    onDeptChat('orchestration_dept', cmdInput.trim());
    setCmdInput('');
  };

  const activeCount = agents.filter(a => a.status !== 'Idle').length;
  const recentFeed = feed.slice(0, 5);

  // 중요 이벤트 (failed 태스크 관련 키워드)
  const isCritical = (e: FeedEvent) =>
    e.payload.toLowerCase().includes('fail') ||
    e.payload.toLowerCase().includes('error') ||
    e.payload.includes('이상') ||
    e.payload.includes('오류');

  return (
    <div className="ov-root">

      {/* ══ 왼쪽: 라이브 가상 사무실 뷰포트 (3/5) ══ */}
      <div className="ov-left">
        {/* 픽셀 오피스 뷰포트 (glass 패널) */}
        <div className="ov-pixel-panel">
          {/* 픽셀 캔버스 */}
          <div className="ov-pixel-viewport">
            {/* 점 격자 오버레이 */}
            <div className="ov-dot-grid" />

            {/* 메인 캔버스 */}
            <div className="ov-canvas-inner">
              <PixelOffice
                agents={agents}
                cycleStatus={cycleStatus}
                recentMessages={recentFeed.map(e => ({ sender: e.sender, target: e.target, payload: e.payload }))}
                onAgentClick={(agentId) => {
                  const a = agents.find(x => x.agent_id === agentId);
                  if (a) { setActiveAgent(a); setAgentModal(true); }
                }}
              />
            </div>

            {/* 활성 에이전트 부서 배지 오버레이 */}
            <div className="ov-dept-overlay">
              {['orchestration_dept','research_dept','dev_dept','finance_dept','content_dept'].map(deptId => {
                const meta = DEPT_META[deptId];
                const deptAgents = agents.filter(a => a.department === deptId);
                const hasActive = deptAgents.some(a => a.status !== 'Idle');
                if (!hasActive) return null;
                const recentMsg = recentFeed.find(e => deptOfSender(e.sender) === deptId);
                return (
                  <div key={deptId} className="ov-dept-bubble">
                    <div className="ov-dept-bubble-msg" style={{ borderColor: meta.color }}>
                      <span style={{ fontSize: 11, fontFamily: 'JetBrains Mono, monospace', color: meta.color }}>
                        {recentMsg ? cleanPayload(recentMsg.payload).slice(0, 40) : `${meta.room} 작업 중`}
                      </span>
                    </div>
                    <div className="ov-dept-bubble-tag" style={{ background: `${meta.color}20`, borderColor: `${meta.color}50`, color: meta.color }}>
                      {meta.icon} {meta.label}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 하단 왼쪽 상태 오버레이 */}
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

          {/* 터미널 명령 입력 (하단) */}
          <div className="ov-terminal-bar">
            <span className="ov-terminal-prompt">&gt;</span>
            <input
              className="ov-terminal-input"
              value={cmdInput}
              onChange={e => setCmdInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendCmd()}
              placeholder="모든 에이전트에게 명령 전송..."
            />
            <div className="ov-terminal-cursor" />
          </div>
        </div>

        {/* 부서 빠른 접속 바 */}
        <div className="ov-dept-bar">
          {['orchestration_dept','research_dept','dev_dept','finance_dept','content_dept'].map(deptId => {
            const meta = DEPT_META[deptId];
            const deptAgents = agents.filter(a => a.department === deptId);
            const hasActive = deptAgents.some(a => a.status !== 'Idle');
            return (
              <button key={deptId} className={`ov-dept-chip ${hasActive ? 'active' : ''}`}
                style={{ '--dept-color': meta.color } as React.CSSProperties}
                onClick={() => onDeptChat(deptId, `${meta.room} 현재 상태 보고해줘`)}>
                {meta.icon} {meta.label}
                {hasActive && <span className="ov-dept-dot" style={{ background: meta.color }} />}
              </button>
            );
          })}
        </div>
      </div>

      {/* ══ 오른쪽: 실시간 운영 피드 (2/5) ══ */}
      <div className="ov-right">
        {/* 헤더 */}
        <div className="ov-right-header">
          <div className="ov-panel-tabs" role="tablist">
            <button role="tab" aria-selected={panel === 'chat'}
                    className={`ov-panel-tab ${panel === 'chat' ? 'active' : ''}`}
                    onClick={() => setPanel('chat')}>
              💬 에이전트 대화{dialogue.length > 0 && <span className="ov-panel-count">{dialogue.length}</span>}
            </button>
            <button role="tab" aria-selected={panel === 'feed'}
                    className={`ov-panel-tab ${panel === 'feed' ? 'active' : ''}`}
                    onClick={() => setPanel('feed')}>
              ◉ 운영 피드
            </button>
          </div>
          {panel === 'feed' && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="ov-feed-action-btn" onClick={() => setFeed([])}>삭제</button>
            </div>
          )}
        </div>

        {/* 에이전트 대화 */}
        {panel === 'chat' && (
          <div className="ov-feed ov-chat" ref={chatScrollRef}>
            <AgentChat entries={dialogue} showProject
              emptyText="프로젝트가 돌면 에이전트끼리 주고받는 말이 여기 쌓입니다 — 제출 · 검토 · 반려 · 인계." />
          </div>
        )}

        {/* 피드 */}
        <div className="ov-feed" ref={feedScrollRef}
             style={{ display: panel === 'feed' ? undefined : 'none' }}>
          {feed.length === 0 && (
            <div className="ov-feed-empty">
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <div className="ov-status-dot" style={{ width: 8, height: 8 }} />
                <span style={{ fontSize: 10, color: '#2DD4BF', fontFamily: 'JetBrains Mono, monospace', textTransform: 'uppercase' }}>
                  새 데이터 스트림 대기 중...
                </span>
              </div>
              <div style={{ fontSize: 11, color: '#475569' }}>운영을 시작하면 에이전트 활동이 여기에 표시됩니다</div>
            </div>
          )}

          {feed.slice(0, 40).map(e => {
            const dept = deptOfSender(e.sender);
            const meta = DEPT_META[dept] ?? DEPT_META['orchestration_dept'];
            const cleaned = cleanPayload(e.payload);
            const critical = isCritical(e);

            if (critical) {
              return (
                <div key={e.event_id} className="ov-msg-critical">
                  <div className="ov-msg-critical-header">
                    <span style={{ color: '#EF4444', fontWeight: 700, fontSize: 10 }}>[중요_보고]</span>
                    <span style={{ color: '#475569', fontSize: 10, fontFamily: 'JetBrains Mono, monospace' }}>[{fmtTs(e.timestamp)}]</span>
                  </div>
                  <div style={{ fontSize: 12, color: '#CBD5E1', lineHeight: 1.5 }}>
                    에이전트 <span style={{ color: meta.color, fontWeight: 700 }}>{senderLabel(e.sender)}</span>에서 이상 감지: {cleaned}
                  </div>
                  <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
                    {/* 결재를 받아 처리하는 백엔드가 아직 없다. 눌러도 아무
                        일이 없느니, 아직 없다고 말하는 편이 낫다. */}
                    <button className="ov-critical-btn primary" disabled
                            title="결재 처리 백엔드가 아직 없습니다">승인</button>
                    <button className="ov-critical-btn ghost" disabled
                            title="작업 중단 API 가 아직 없습니다">중단</button>
                  </div>
                </div>
              );
            }

            return (
              <div key={e.event_id} className="ov-log-row">
                <span className="ov-log-time" style={{ fontFamily: 'JetBrains Mono, monospace' }}>[{fmtTs(e.timestamp)}]</span>
                <div>
                  <span className="ov-log-sender" style={{ color: meta.color }}>[{senderLabel(e.sender)}]</span>
                  <span className="ov-log-text">: {cleaned}</span>
                </div>
              </div>
            );
          })}

          {feed.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 0' }}>
              <div className="ov-status-dot active" style={{ width: 6, height: 6 }} />
              <span style={{ fontSize: 11, color: 'rgba(45,212,191,0.6)', fontFamily: 'JetBrains Mono, monospace', textTransform: 'uppercase', letterSpacing: '0.1em' }}>
                새 데이터 스트림 대기 중...
              </span>
            </div>
          )}
          <div ref={feedEndRef} />
        </div>

        {/* 빠른 액션 버튼 */}
        <div className="ov-quick-actions">
          <button className="ov-quick-btn primary"
            onClick={() => onDeptChat('orchestration_dept', '전체 에이전트 상태 보고해줘')}>
            전체 방송
          </button>
          <button className="ov-quick-btn ghost"
            onClick={() => onDeptChat('orchestration_dept', '현재 진행 중인 작업을 모두 일시 중지해줘')}>
            시스템 정지
          </button>
        </div>
      </div>

      {/* ── 에이전트 상세 모달 ── */}
      {agentModal && activeAgent && (() => {
        const dept = activeAgent.department ?? 'orchestration_dept';
        const meta = DEPT_META[dept] ?? DEPT_META['orchestration_dept'];
        return (
          <div className="office-agent-modal-bg" onClick={() => setAgentModal(false)}>
            <div className="office-agent-modal" onClick={e => e.stopPropagation()}>
              <button className="office-modal-close" onClick={() => setAgentModal(false)}>✕</button>
              <div className="office-modal-header" style={{ borderColor: meta.color + '66' }}>
                <div className="office-modal-avatar" style={{ background: meta.bg, borderColor: meta.color }}>
                  <span style={{ color: meta.color, fontSize: 28, fontWeight: 800 }}>
                    {initials(activeAgent.character_name)}
                  </span>
                </div>
                <div>
                  <div className="office-modal-name">{activeAgent.character_name}</div>
                  <div className="office-modal-role">{ROLE_EMOJI[activeAgent.role] ?? '🤖'} {activeAgent.role}</div>
                  <div className="office-modal-dept" style={{ color: meta.color }}>{meta.icon} {meta.room}</div>
                </div>
              </div>
              <div className="office-modal-status">
                <span className={`office-modal-badge ${activeAgent.status === 'Idle' ? 'idle' : 'active'}`}>
                  {activeAgent.status === 'Idle' ? '● 대기 중' : '▶ 작업 중'}
                </span>
                {activeAgent.level && <span className="office-modal-lv">Lv.{activeAgent.level}</span>}
              </div>
              <div className="office-modal-chat-label">이 에이전트에게 직접 지시:</div>
              <div className="office-modal-input-row">
                <input
                  className="office-modal-input"
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && chatInput.trim()) {
                      onDeptChat(dept, chatInput); setChatInput(''); setAgentModal(false);
                    }
                  }}
                  placeholder={`${activeAgent.character_name.split(' ')[0]}에게 지시...`}
                  autoFocus
                />
                <button className="office-modal-send"
                  onClick={() => { if (chatInput.trim()) { onDeptChat(dept, chatInput); setChatInput(''); setAgentModal(false); } }}>
                  전송
                </button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}
