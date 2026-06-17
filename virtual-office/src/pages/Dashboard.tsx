import { useEffect, useRef, useState, useCallback } from 'react';
import { api, AgentSummary, EventRecord, deptLabels, deptColors } from '../api';
import '../styles/dashboard.css';

/* ── helpers ── */
function parsePayload(p: string): string {
  try {
    const o = JSON.parse(p);
    if (typeof o === 'object' && o !== null) {
      const v = o.message ?? o.result ?? o.task ?? o.content ?? o.summary;
      if (typeof v === 'string') return v.slice(0, 140);
    }
  } catch { /* */ }
  return p.slice(0, 140);
}

function deptShort(id: string): string {
  if (id.includes('orch'))     return '오케스트레이션';
  if (id.includes('research')) return '학술연구';
  if (id.includes('finance'))  return '금융투자';
  if (id.includes('dev'))      return '개발';
  if (id.includes('content'))  return '콘텐츠';
  return id.replace('_dept', '');
}

function deptColor(id: string): string {
  return deptColors[id] ?? '#6b7280';
}

type InputMode = 'text' | 'file' | 'image';

interface LogEntry {
  ts: string;
  level: 'info' | 'success' | 'error' | 'warn';
  msg: string;
}

/* ═══════════════════════════════════════════════════════════
   Main Dashboard
═══════════════════════════════════════════════════════════ */
export default function Dashboard() {
  const [health,  setHealth]  = useState<{ status: string; redis: string; vllm: string } | null>(null);
  const [agents,  setAgents]  = useState<AgentSummary[]>([]);
  const [events,  setEvents]  = useState<EventRecord[]>([]);

  /* workflow state */
  const [inputMode,   setInputMode]   = useState<InputMode>('text');
  const [taskText,    setTaskText]    = useState('');
  const [deptTarget,  setDeptTarget]  = useState('orchestration_dept');
  const [imageUrl,    setImageUrl]    = useState('');
  const [attachedFile, setAttachedFile] = useState<File | null>(null);
  const [filePreview,  setFilePreview]  = useState<string | null>(null);
  const [running,     setRunning]     = useState(false);
  const [logs,        setLogs]        = useState<LogEntry[]>([]);
  const fileInputRef  = useRef<HTMLInputElement>(null);
  const logEndRef     = useRef<HTMLDivElement>(null);

  /* ── initial load ── */
  useEffect(() => {
    api.health().then(setHealth);
    api.listAgents().then(d => setAgents(d?.agents ?? []));
    api.listEvents().then(d => setEvents((d?.events ?? []).slice(-40).reverse()));
  }, []);

  /* ── SSE ── */
  useEffect(() => {
    const es = new EventSource('/api/events/stream');
    es.addEventListener('new_event', (e: MessageEvent) => {
      try {
        const rec = JSON.parse(e.data) as EventRecord;
        setEvents(prev => [rec, ...prev].slice(0, 40));
      } catch { /* */ }
    });
    es.addEventListener('agent_state_change', (e: MessageEvent) => {
      try {
        const d = JSON.parse(e.data) as { agent_id: string; status: string };
        setAgents(prev => prev.map(a => a.agent_id === d.agent_id ? { ...a, status: d.status } : a));
      } catch { /* */ }
    });
    return () => es.close();
  }, []);

  /* ── log auto-scroll ── */
  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  /* ── file attach ── */
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setAttachedFile(file);
    if (file.type.startsWith('image/')) {
      const reader = new FileReader();
      reader.onload = ev => setFilePreview(ev.target?.result as string);
      reader.readAsDataURL(file);
    } else {
      setFilePreview(null);
    }
  };

  const addLog = useCallback((level: LogEntry['level'], msg: string) => {
    const ts = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setLogs(prev => [...prev, { ts, level, msg }]);
  }, []);

  /* ── workflow run ── */
  const handleRun = async () => {
    const task = inputMode === 'text' ? taskText
      : inputMode === 'image' ? `[이미지 분석 요청] ${imageUrl}\n\n${taskText}`
      : attachedFile ? `[파일 첨부: ${attachedFile.name}]\n\n${taskText}` : taskText;

    if (!task.trim()) return;
    setRunning(true);
    addLog('info', `워크플로우 시작 → 부서: ${deptShort(deptTarget)}`);
    addLog('info', `태스크: ${task.slice(0, 80)}${task.length > 80 ? '...' : ''}`);

    try {
      const res = await fetch('/api/workflow/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ department: deptTarget, task }),
      });
      if (res.ok) {
        const d = await res.json();
        if (d.ok) {
          addLog('success', '✅ 워크플로우가 시작되었습니다. 에이전트 통신 흐름을 확인하세요.');
        } else {
          addLog('error', `❌ 실패: ${JSON.stringify(d).slice(0, 120)}`);
        }
      } else {
        addLog('warn', `⚠️ API 응답 오류: HTTP ${res.status}`);
      }
    } catch (err: any) {
      addLog('error', `❌ 연결 오류: ${err.message}`);
    } finally {
      setRunning(false);
    }
  };

  const activeAgents = agents.filter(a => a.status !== 'Idle').length;

  return (
    <div className="db-root">

      {/* ── Stat strip ── */}
      <div className="db-stat-strip">
        <StatPill
          label="시스템"
          value={health?.status === 'healthy' ? '정상' : health ? '점검' : '연결중'}
          dot={health?.status === 'healthy' ? '#10b981' : '#ef4444'}
          sub={`Redis ${health?.redis ?? '—'} · vLLM ${health?.vllm ?? '—'}`}
        />
        <StatPill
          label="에이전트"
          value={`${agents.length}명 활성`}
          dot={activeAgents > 0 ? '#f59e0b' : '#6b7280'}
          sub={`${activeAgents}명 작업 중 · ${agents.length - activeAgents}명 대기`}
        />
        <StatPill
          label="이벤트"
          value={`${events.length}건`}
          dot="#3b82f6"
          sub="에이전트 간 통신 누적"
        />
        <StatPill
          label="추론 모델"
          value="Qwen 2.5-14B"
          dot={health?.vllm === 'ok' ? '#10b981' : '#ef4444'}
          sub="vLLM 로컬 추론 서버"
        />
      </div>

      {/* ── Main 3-column layout ── */}
      <div className="db-main">

        {/* ═══ Col 1: 통신 흐름 ═══ */}
        <section className="db-col db-flow-col">
          <div className="db-col-header">
            <span className="db-col-title">에이전트 통신 흐름</span>
            <span className="live-tag">LIVE</span>
          </div>
          <div className="db-flow-list">
            {events.length === 0 && (
              <div className="db-empty">SSE 연결 대기 중 — 워크플로우 실행 시 이곳에 에이전트 간 통신이 표시됩니다.</div>
            )}
            {events.map(ev => (
              <FlowItem key={ev.event_id} ev={ev} />
            ))}
          </div>
        </section>

        {/* ═══ Col 2: 워크플로우 실행 ═══ */}
        <section className="db-col db-exec-col">
          <div className="db-col-header">
            <span className="db-col-title">워크플로우 실행</span>
            <span className="db-multimodal-hint">멀티모달 입력 지원</span>
          </div>

          {/* Input mode tabs */}
          <div className="db-mode-tabs">
            {(['text', 'file', 'image'] as InputMode[]).map(m => (
              <button
                key={m}
                className={`db-mode-tab ${inputMode === m ? 'active' : ''}`}
                onClick={() => setInputMode(m)}
              >
                {m === 'text' ? '✏️ 텍스트' : m === 'file' ? '📎 파일 첨부' : '🖼️ 이미지'}
              </button>
            ))}
          </div>

          {/* Input area */}
          <div className="db-input-area">
            {inputMode === 'file' && (
              <div
                className="db-file-drop"
                onClick={() => fileInputRef.current?.click()}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".pdf,.txt,.md,.csv,.png,.jpg,.jpeg,.webp"
                  style={{ display: 'none' }}
                  onChange={handleFileChange}
                />
                {attachedFile ? (
                  <div className="db-file-attached">
                    {filePreview
                      ? <img src={filePreview} alt="preview" className="db-file-preview-img" />
                      : <span className="db-file-icon">📄</span>
                    }
                    <span className="db-file-name">{attachedFile.name}</span>
                    <button className="db-file-remove" onClick={e => { e.stopPropagation(); setAttachedFile(null); setFilePreview(null); }}>✕</button>
                  </div>
                ) : (
                  <div className="db-file-placeholder">
                    <span style={{ fontSize: 28 }}>📎</span>
                    <span>파일을 클릭하여 첨부</span>
                    <span style={{ fontSize: 11, color: '#374151' }}>PDF · TXT · MD · CSV · 이미지</span>
                  </div>
                )}
              </div>
            )}

            {inputMode === 'image' && (
              <input
                className="db-url-input"
                placeholder="이미지 URL을 입력하세요..."
                value={imageUrl}
                onChange={e => setImageUrl(e.target.value)}
              />
            )}

            <textarea
              className="db-task-input"
              rows={inputMode === 'text' ? 6 : 3}
              placeholder={
                inputMode === 'text'
                  ? '오케스트레이터에게 전달할 태스크를 입력하세요...\n예) "비트코인 최근 트렌드를 분석하고 투자 보고서를 작성해줘"'
                  : inputMode === 'file'
                  ? '첨부 파일에 대한 지시사항을 입력하세요...\n예) "이 PDF의 핵심 내용을 요약하고 인사이트를 도출해줘"'
                  : '이미지에 대한 분석 요청을 입력하세요...\n예) "이 차트를 분석하고 투자 시사점을 정리해줘"'
              }
              value={taskText}
              onChange={e => setTaskText(e.target.value)}
              onKeyDown={e => { if (e.ctrlKey && e.key === 'Enter') handleRun(); }}
            />
          </div>

          {/* Department selector + run */}
          <div className="db-exec-footer">
            <div className="db-dept-select-wrap">
              <label className="db-dept-label">대상 부서</label>
              <select
                className="db-dept-select"
                value={deptTarget}
                onChange={e => setDeptTarget(e.target.value)}
              >
                <option value="orchestration_dept">🧠 오케스트레이션 (자동 배분)</option>
                <option value="research_dept">🔬 학술연구부</option>
                <option value="finance_dept">📈 금융투자부</option>
                <option value="dev_dept">⚙️ 개발팀</option>
                <option value="content_dept">✍️ 콘텐츠생산부</option>
              </select>
            </div>
            <button
              className={`db-run-btn ${running ? 'running' : ''}`}
              onClick={handleRun}
              disabled={running || (!taskText.trim() && !attachedFile && !imageUrl.trim())}
              title="Ctrl+Enter"
            >
              {running ? (
                <><span className="db-spinner" />실행 중...</>
              ) : (
                <>▶ 워크플로우 실행</>
              )}
            </button>
          </div>

          {/* Execution log */}
          {logs.length > 0 && (
            <div className="db-exec-log">
              <div className="db-exec-log-title">실행 로그</div>
              <div className="db-exec-log-body">
                {logs.map((l, i) => (
                  <div key={i} className={`db-log-line db-log-${l.level}`}>
                    <span className="db-log-ts">{l.ts}</span>
                    <span>{l.msg}</span>
                  </div>
                ))}
                <div ref={logEndRef} />
              </div>
            </div>
          )}
        </section>

        {/* ═══ Col 3: 에이전트 상태 ═══ */}
        <section className="db-col db-agents-col">
          <div className="db-col-header">
            <span className="db-col-title">에이전트 상태</span>
            <span className="db-agent-count">{agents.length}명</span>
          </div>
          <div className="db-agent-list">
            {agents.map(a => {
              const color = deptColor(a.department);
              const active = a.status !== 'Idle';
              return (
                <div key={a.agent_id} className="db-agent-row">
                  <span className="db-agent-dot" style={{ background: active ? color : '#374151' }} />
                  <span className="db-agent-name">{a.character_name}</span>
                  <span className="db-agent-dept" style={{ color }}>{deptShort(a.department).slice(0, 4)}</span>
                  <span className={`db-agent-badge ${active ? 'active' : 'idle'}`}
                    style={active ? { borderColor: color + '50', color, background: color + '15' } : {}}>
                    {a.status}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

      </div>
    </div>
  );
}

/* ── Sub-components ── */

function StatPill({ label, value, dot, sub }: { label: string; value: string; dot: string; sub: string }) {
  return (
    <div className="db-stat-pill">
      <div className="db-stat-pill-left">
        <span className="db-stat-dot" style={{ background: dot }} />
        <span className="db-stat-label">{label}</span>
      </div>
      <span className="db-stat-value">{value}</span>
      <span className="db-stat-sub">{sub}</span>
    </div>
  );
}

function FlowItem({ ev }: { ev: EventRecord }) {
  const fromColor = deptColor(ev.sender);
  const toColor   = deptColor(ev.target);
  const text      = parsePayload(ev.payload);
  return (
    <div className="db-flow-item" style={{ borderLeftColor: fromColor }}>
      <div className="db-flow-route">
        <span className="db-flow-tag" style={{ color: fromColor, borderColor: fromColor + '50', background: fromColor + '12' }}>
          {deptShort(ev.sender)}
        </span>
        <span className="db-flow-arrow">→</span>
        <span className="db-flow-tag" style={{ color: toColor, borderColor: toColor + '50', background: toColor + '12' }}>
          {deptShort(ev.target)}
        </span>
        <span className="db-flow-time">
          {new Date(ev.timestamp).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
        </span>
      </div>
      <p className="db-flow-text">{text}</p>
    </div>
  );
}
