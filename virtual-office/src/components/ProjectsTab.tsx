/* 자율 프로젝트 화면.
 *
 * 이 화면이 답해야 하는 질문은 셋뿐이다.
 *   1. 지금 뭘 하고 있나
 *   2. 내가 해야 할 일이 있나        ← 착수 승인, 정지 해제
 *   3. 왜 멈췄나                     ← 멈춘 이유를 숨기지 않는다
 *
 * 그래서 목록은 상태와 진행만 보여 주고, 나머지는 하나를 골랐을 때 편다.
 * 내가 해야 할 일이 있는 프로젝트는 목록 맨 위로 올린다 — 내려가서 찾게
 * 하면 승인을 기다리는 프로젝트가 며칠씩 방치된다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, deptLabels, type DialogueEntry, type ProjectRow, type ProjectStatus } from '../api';
import AgentChat from './AgentChat';

const STATUS_LABEL: Record<ProjectStatus, string> = {
  intake:            '접수',
  planning:          '계획 세우는 중',
  awaiting_approval: '착수 승인 대기',
  running:           '자율 실행 중',
  paused:            '일시정지',
  done:              '완료',
  cancelled:         '접음',
};

/* 사람이 손대야 하는 상태를 위로. 그 다음은 최근 순. */
const URGENCY: Record<ProjectStatus, number> = {
  awaiting_approval: 0, paused: 1, running: 2,
  planning: 3, intake: 4, done: 5, cancelled: 6,
};

const PHASE_LABEL: Record<string, string> = {
  plan: '계획', draft: '초안', review1: '1차 검토', review2: '2차 검토',
};

function timeAgo(ts: number): string {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

export default function ProjectsTab() {
  const [rows, setRows]       = useState<ProjectRow[]>([]);
  const [openId, setOpenId]   = useState<string | null>(null);
  const [detail, setDetail]   = useState<ProjectRow | null>(null);
  const [idea, setIdea]       = useState('');
  const [busy, setBusy]       = useState(false);
  const [err, setErr]         = useState('');
  const [loaded, setLoaded]   = useState(false);
  const openRef               = useRef<string | null>(null);
  openRef.current = openId;

  const refresh = useCallback(async () => {
    // safeJson 은 백엔드에 닿지 못하면 null 을 준다. 그때 조용히 빈 목록을
    // 보여 주면 "프로젝트가 없다" 와 "서버가 꺼져 있다" 가 같아 보인다.
    const r = await api.listProjects();
    if (!r) { setErr('백엔드에 연결하지 못했습니다 (127.0.0.1:9000)'); setLoaded(true); return; }
    setErr('');
    setRows([...(r.projects ?? [])].sort(
      (a, b) => (URGENCY[a.status] - URGENCY[b.status]) || (b.created_at - a.created_at)));
    setLoaded(true);
    const id = openRef.current;
    if (id) {
      const d = await api.getProject(id);
      if (d?.project) setDetail(d.project);
    }
  }, []);

  /* 자율 실행은 몇 분 단위로 돈다. 화면을 보고 있는 동안은 따라가야 하지만
     4초보다 자주 물어 봐야 할 이유는 없다 — 한 스텝이 그보다 오래 걸린다. */
  useEffect(() => {
    void refresh();
    const t = setInterval(() => { void refresh(); }, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  async function create() {
    const text = idea.trim();
    if (!text || busy) return;
    setBusy(true); setErr('');
    const r = await api.createProject(text);
    setBusy(false);
    if (!r) { setErr('백엔드에 연결하지 못했습니다'); return; }
    if (r.error) { setErr(r.error); return; }
    setIdea('');
    void refresh();
  }

  async function act(id: string, action: 'approve' | 'resume' | 'cancel') {
    setBusy(true); setErr('');
    const r = await api.projectAction(id, action);
    setBusy(false);
    if (!r) { setErr('백엔드에 연결하지 못했습니다'); return; }
    if (r.error) { setErr(r.error); return; }
    void refresh();
  }

  function toggle(id: string) {
    if (openId === id) { setOpenId(null); setDetail(null); return; }
    setOpenId(id); setDetail(null);
    void api.getProject(id).then(d => { if (d?.project) setDetail(d.project); });
  }

  return (
    <div className="pj-wrap">
      {/* ── 아이디어 던지기 ── */}
      <section className="pj-new">
        <h2 className="pj-h">새 프로젝트</h2>
        <p className="pj-sub">
          아이디어를 한 줄로 던지면 오케스트레이터가 의도를 읽고 계획을 세웁니다.
          착수 승인은 <strong>한 번</strong>만 받고, 그 뒤로는 결과가 나올 때까지
          자율로 진행합니다.
        </p>
        <div className="pj-new-row">
          <textarea
            className="pj-input"
            rows={2}
            value={idea}
            placeholder="예) 맹비서에 매일 아침 위키 변경사항을 요약해 보내는 기능을 붙이고 싶다"
            onChange={e => setIdea(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void create(); }
            }}
          />
          <button className="pj-btn pj-btn-primary" disabled={busy || !idea.trim()}
                  onClick={() => void create()}>
            {busy ? '…' : '시작'}
          </button>
        </div>
        {err && <div className="pj-err">{err}</div>}
      </section>

      {/* ── 목록 ── */}
      <section className="pj-list">
        <h2 className="pj-h">
          진행 중인 프로젝트
          {rows.length > 0 && <span className="pj-count">{rows.length}</span>}
        </h2>

        {err && loaded && <div className="pj-err">{err}</div>}
        {!loaded && <div className="pj-empty">불러오는 중…</div>}
        {loaded && rows.length === 0 && (
          <div className="pj-empty">아직 없습니다. 위에 아이디어를 한 줄 적어 보세요.</div>
        )}

        {rows.map(p => {
          const open = openId === p.id;
          const needsMe = p.status === 'awaiting_approval' || p.status === 'paused';
          return (
            <article key={p.id} className={`pj-card ${p.status} ${needsMe ? 'needs-me' : ''}`}>
              <button className="pj-card-head" onClick={() => toggle(p.id)}
                      aria-expanded={open}>
                <span className={`pj-dot ${p.status}`} aria-hidden="true" />
                <span className="pj-title">{p.title}</span>
                <span className="pj-status">{STATUS_LABEL[p.status]}</span>
                <span className="pj-meta">
                  {p.progress} · {p.step_count ?? 0}스텝 · {timeAgo(p.created_at)}
                </span>
                <span className={`pj-caret ${open ? 'open' : ''}`} aria-hidden="true">▾</span>
              </button>

              {/* 멈춘 이유는 접혀 있어도 보인다 — 이걸 숨기면 왜 안 도는지 모른다. */}
              {p.pause_reason && (
                <p className="pj-pause">{p.pause_reason}</p>
              )}

              {needsMe && (
                <div className="pj-actions">
                  {p.status === 'awaiting_approval' && (
                    <button className="pj-btn pj-btn-primary" disabled={busy}
                            onClick={() => void act(p.id, 'approve')}>
                      착수 승인
                    </button>
                  )}
                  {p.status === 'paused' && (
                    <button className="pj-btn pj-btn-primary" disabled={busy}
                            onClick={() => void act(p.id, 'resume')}>
                      이어서 진행
                    </button>
                  )}
                  <button className="pj-btn" disabled={busy}
                          onClick={() => void act(p.id, 'cancel')}>
                    접기
                  </button>
                </div>
              )}

              {open && (
                <div className="pj-detail">
                  {!detail && <div className="pj-empty">불러오는 중…</div>}
                  {detail && detail.id === p.id && <Detail p={detail} />}
                </div>
              )}
            </article>
          );
        })}
      </section>
    </div>
  );
}

/* 이 프로젝트에서 에이전트들이 주고받은 말. 진행 기록(steps)이 '무슨 일이
   있었나' 라면 이쪽은 '누가 누구에게 뭐라고 했나' 다. */
function DialogueBlock({ pid }: { pid: string }) {
  const [rows, setRows] = useState<DialogueEntry[] | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.dialogue(300, pid).then(r => { if (alive && r?.dialogue) setRows(r.dialogue); });
    void load();
    const t = setInterval(load, 5000);
    return () => { alive = false; clearInterval(t); };
  }, [pid]);
  if (!rows || rows.length === 0) return null;
  return (
    <div className="pj-block">
      <h3 className="pj-h3">
        에이전트 대화
        <span className="pj-budget">{rows.length}마디{rows[0]?.restored ? ' · 단계 기록에서 복원' : ''}</span>
      </h3>
      <div className="pj-dialogue"><AgentChat entries={rows} /></div>
    </div>
  );
}

function Detail({ p }: { p: ProjectRow }) {
  const ds = p.plan?.deliverables ?? [];
  const steps = p.steps ?? [];
  return (
    <>
      {p.intent && (
        <div className="pj-block">
          <h3 className="pj-h3">읽어 낸 의도</h3>
          <p className="pj-text">{p.intent}</p>
        </div>
      )}

      {ds.length > 0 && (
        <div className="pj-block">
          <h3 className="pj-h3">산출물</h3>
          <ol className="pj-deliv">
            {ds.map((d, i) => {
              const state = i < p.cursor ? 'done' : i === p.cursor ? 'now' : 'todo';
              return (
                <li key={d.id} className={`pj-deliv-item ${state}`}>
                  <span className="pj-deliv-mark" aria-hidden="true">
                    {state === 'done' ? '✓' : state === 'now' ? '●' : '○'}
                  </span>
                  <span className="pj-deliv-title">{d.title}</span>
                  <span className="pj-deliv-dept">{deptLabels[d.dept] ?? d.dept}</span>
                  {state === 'now' && p.status === 'running' && (
                    <span className="pj-deliv-phase">{PHASE_LABEL[p.phase] ?? p.phase}</span>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {p.plan?.done_when && p.plan.done_when.length > 0 && (
        <div className="pj-block">
          <h3 className="pj-h3">완료 조건</h3>
          <ul className="pj-text pj-ul">
            {p.plan.done_when.map((c, i) => <li key={i}>{c}</li>)}
          </ul>
        </div>
      )}

      <DialogueBlock pid={p.id} />

      {steps.length > 0 && (
        <div className="pj-block">
          <h3 className="pj-h3">
            진행 기록
            <span className="pj-budget">오늘 남은 호출 {p.budget_left}회</span>
          </h3>
          {/* 최근 것이 위로. 아래로 스크롤해서 최신을 찾게 하면 안 된다. */}
          <ol className="pj-steps">
            {[...steps].reverse().map(s => (
              <li key={s.n} className={`pj-step ${s.ok ? 'ok' : 'no'}`}>
                <span className="pj-step-n">{s.n}</span>
                <span className="pj-step-phase">{PHASE_LABEL[s.phase] ?? s.phase}</span>
                <span className="pj-step-dept">{deptLabels[s.dept] ?? s.dept}</span>
                {s.score >= 0 && <span className="pj-step-score">{s.score}점</span>}
                <span className="pj-step-note">{s.note}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {p.status === 'done' && (
        <p className="pj-done-note">
          모든 산출물이 부서 1차·오케스트레이터 2차 검토를 통과했습니다.
          결재함에 파일 저장 제안으로 올라가 있습니다 — 승인하면 workspace 에 쓰입니다.
        </p>
      )}
    </>
  );
}
