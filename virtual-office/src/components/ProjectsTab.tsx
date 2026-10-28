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
 *
 * ## 새 프로젝트 입력칸을 뺐다
 *
 * 같은 일을 하는 입구가 셋이었다 — 여기, 메인 대화창 ＋ 메뉴의 「명테크에
 * 맡기기」, 디스코드의 `/맡기기`. 셋 다 같은 `POST /api/projects` 를 부른다.
 * 입구는 대화 쪽(⚡ 새 지시사항 → 맡기기 모드)으로 모으고, 이 화면은
 * **보고 고르는 곳**으로 둔다.
 *
 * ## 칸반을 뺐고, 그 일을 필터가 한다
 *
 * 칸반은 같은 프로젝트를 상태별 칸에 한 번 더 그렸다. 위 KPI 숫자를 누르면
 * 이 목록이 그 상태로 걸러진다 — 숫자와 목록이 같은 것을 센다.
 *
 * ## 지우기는 휴지통으로
 *
 * 「선택」 으로 여럿을 고르거나 「전체 선택」 으로 보이는 것을 다 골라
 * 휴지통에 넣는다. 영구 삭제는 여기서 못 한다 — 맹비서(`/휴지통`)만 한다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, deptLabels, type ApprovalRow, type DialogueEntry, type ProjectRow,
         type ProjectStatus, type ArchivedCall } from '../api';
import { useTrashUndo, TrashUndoBar } from './TrashBox';
import { GROUP_LABEL, GROUP_OF, type PjGroup } from './projectGroups';
import ConfidenceBox from './ConfidenceBox';
import VerifyBox from './VerifyBox';
import PlanEditor from './PlanEditor';
import ReviewHistory from './ReviewHistory';
import { Markdown } from './GuideModal';
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

/** CEO 현황판에서 프로젝트 카드를 눌렀을 때, 그 프로젝트가 열린 채로 뜬다.
 *  예전에는 어느 카드를 눌러도 탭만 열려 목록 맨 위부터 다시 찾아야 했다. */
export default function ProjectsTab({ focusId, onFocused, group = 'all', onGroup }:
    { focusId?: string | null; onFocused?: () => void;
      group?: PjGroup; onGroup?: (g: PjGroup) => void } = {}) {
  const [rows, setRows]       = useState<ProjectRow[]>([]);
  // 고르기. 켜야 체크칸이 나온다 — 늘 보이면 카드를 펼치려다 체크하게 된다.
  const [selecting, setSelecting] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const undo = useTrashUndo();
  const [openId, setOpenId]   = useState<string | null>(null);
  // 방향 전환 입력칸을 연 프로젝트. 한 번에 하나만 연다 — 여럿을 열어
  // 두면 어느 칸이 어느 프로젝트의 것인지 헷갈린다.
  const [steerFor, setSteerFor] = useState<string | null>(null);
  const [steerText, setSteerText] = useState('');
  useEffect(() => {
    if (!focusId) return;
    setOpenId(focusId);
    onFocused?.();
  }, [focusId, onFocused]);

  /* 걸러 둔 상태에서 **안 보이는 프로젝트**를 가리켰을 때 필터를 푼다.
   *
   *  결재 카드의 「이 프로젝트의 산출물 열기」 는 openId 만 세운다. 목록이
   *  「완료」 로 걸려 있는데 그 프로젝트가 멈춘 것이면, 열렸다는 표시만
   *  남고 화면에는 아무 일도 일어나지 않는다 — 눌러도 반응이 없는 버튼이
   *  된다. 거르기는 보조 장치이므로, 가리킨 것이 이긴다. */
  useEffect(() => {
    if (!openId || group === 'all') return;
    const p = rows.find(r => r.id === openId);
    if (p && GROUP_OF[p.status] !== group) onGroup?.('all');
  }, [openId, group, rows, onGroup]);

  /* 결재 카드의 "이 프로젝트의 산출물 열기" 가 보내는 신호.
   *
   *  App → ProjectsTab 으로 prop 을 내리려면 ApprovalBox 까지 세 겹을
   *  지나야 한다. 이 한 번을 위해 세 컴포넌트의 서명을 바꾸는 것은
   *  과하므로 이벤트로 받는다. */
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (!id) return;
      setOpenId(id);
      // 결재함은 화면 위에 있고 프로젝트 카드는 아래에 있다. 열기만 하고
      // 두면 사장님 눈에는 아무 일도 안 일어난 것으로 보인다.
      requestAnimationFrame(() => {
        document.getElementById(`pj-${id}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    };
    window.addEventListener('mt:open-project', onOpen);
    return () => window.removeEventListener('mt:open-project', onOpen);
  }, []);
  const [detail, setDetail]   = useState<ProjectRow | null>(null);
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

  const shown = group === 'all' ? rows : rows.filter(r => GROUP_OF[r.status] === group);
  const counts: Record<PjGroup, number> = {
    all: rows.length,
    live: rows.filter(r => GROUP_OF[r.status] === 'live').length,
    done: rows.filter(r => GROUP_OF[r.status] === 'done').length,
    stopped: rows.filter(r => GROUP_OF[r.status] === 'stopped').length,
  };
  // 걸러서 안 보이게 된 것은 고른 것에서 뺀다. 보이지 않는 것을 지우면
  // 사장님이 무엇을 지웠는지 모르게 된다.
  const visibleSel = shown.filter(r => sel.has(r.id));
  const allOn = shown.length > 0 && visibleSel.length === shown.length;

  function pick(id: string) {
    setSel(prev => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }
  function stopSelecting() { setSelecting(false); setSel(new Set()); }

  async function toTrash() {
    const ids = visibleSel.map(r => r.id);
    if (!ids.length) return;
    const running = visibleSel.filter(r => r.status === 'running' || r.status === 'planning').length;
    if (!window.confirm(
      `프로젝트 ${ids.length}건을 휴지통으로 옮길까요?`
      + (running ? `\n\n돌고 있는 ${running}건은 멈춥니다.` : '')
      + '\n\n딸린 결재·교훈도 함께 옮깁니다. 휴지통에서 되살릴 수 있고,'
      + '\n맹비서가 디스코드로 알려 드립니다.')) return;
    setBusy(true);
    const r = await api.trashMove(ids.map(id => ({ kind: 'project' as const, id })));
    setBusy(false);
    if (!r) { setErr('백엔드에 연결하지 못했습니다'); return; }
    if (!r.ok) { setErr(r.error || '옮기지 못했습니다'); return; }
    if (openId && ids.includes(openId)) { setOpenId(null); setDetail(null); }
    stopSelecting();
    undo.show(r.moved);
    void refresh();
  }

  async function act(id: string, action: 'approve' | 'resume' | 'cancel', steer?: string) {
    setBusy(true); setErr('');
    const r = await api.projectAction(id, action, steer);
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
      {/* ── 목록 ── */}
      <section className="pj-list">
        {/* 예전 제목은 "진행 중인 프로젝트" 였는데 목록에는 완료·중단·취소가
            다 들어 있었다. 셋 다 3건이면 "3건이 돌고 있다" 로 읽힌다. */}
        <h2 className="pj-h">
          프로젝트
          {rows.length > 0 && <span className="pj-count">{rows.length}</span>}
          {/* 두 가지 건수를 나눠 센다. "진행 중" 과 "나를 기다리는 중" 은
              성격이 다르다 — 뒤엣것은 내가 움직이지 않으면 영원히 그대로다.
              같은 줄에 섞으면 급한 쪽이 묻힌다. */}
          {(() => {
            const live = rows.filter(r => r.status === 'running'
              || r.status === 'intake' || r.status === 'planning').length;
            const waits = rows.filter(r => r.status === 'awaiting_approval'
              || r.status === 'paused').length;
            return (
              <>
                <span className={`pj-pill work${live ? '' : ' idle'}`}>
                  {live ? `작업 중 ${live}` : '작업 중 없음'}
                </span>
                {waits > 0 && (
                  <span className="pj-pill wait">응답 대기 {waits}</span>
                )}
              </>
            );
          })()}
        </h2>

        {/* 걸러 보기 + 고르기. KPI 숫자를 눌러도 같은 필터가 걸린다. */}
        <div className="pj-tools">
          <div className="pj-filters" role="group" aria-label="상태로 걸러 보기">
            {(['all', 'live', 'done', 'stopped'] as PjGroup[]).map(g => (
              <button key={g} aria-pressed={group === g}
                      className={`pj-filter ${group === g ? 'on' : ''}`}
                      onClick={() => onGroup?.(g)}>
                {GROUP_LABEL[g]} <span>{counts[g]}</span>
              </button>
            ))}
          </div>
          {rows.length > 0 && (selecting ? (
            <div className="pj-selbar">
              <button className="pj-btn" onClick={() => setSel(allOn
                ? new Set() : new Set(shown.map(r => r.id)))}>
                {allOn ? '선택 해제' : `전체 선택 (${shown.length})`}
              </button>
              <button className="pj-btn pj-btn-danger" disabled={busy || !visibleSel.length}
                      onClick={() => void toTrash()}>
                🗑 휴지통으로{visibleSel.length ? ` (${visibleSel.length})` : ''}
              </button>
              <button className="pj-btn" onClick={stopSelecting}>취소</button>
            </div>
          ) : (
            <button className="pj-btn pj-sel-on" onClick={() => setSelecting(true)}>선택</button>
          ))}
        </div>

        <TrashUndoBar undo={undo} onRestored={() => void refresh()} />

        {err && loaded && <div className="pj-err">{err}</div>}
        {!loaded && <div className="pj-empty">불러오는 중…</div>}
        {loaded && rows.length === 0 && (
          <div className="pj-empty">
            아직 없습니다. 위의 <strong>⚡ 새 지시사항</strong> 이나 디스코드
            {' '}<code>/맡기기</code> 로 맹비서에게 맡기면 여기에 생깁니다.
          </div>
        )}
        {loaded && rows.length > 0 && shown.length === 0 && (
          <div className="pj-empty">「{GROUP_LABEL[group]}」 인 프로젝트가 없습니다.</div>
        )}

        {shown.map(p => {
          const open = openId === p.id;
          const needsMe = p.status === 'awaiting_approval' || p.status === 'paused';
          // id 는 결재 카드에서 "산출물 열기" 로 건너올 때 스크롤 목표가 된다.
          return (
            <article key={p.id} id={`pj-${p.id}`}
                     className={`pj-card ${p.status} ${needsMe ? 'needs-me' : ''} ${sel.has(p.id) ? 'picked' : ''}`}>
              <div className="pj-card-row">
              {/* 체크칸은 머리 버튼 **바깥**이다. 버튼 안에 입력을 넣으면
                  HTML 이 깨지고, 눌렀을 때 카드가 같이 펼쳐진다. */}
              {selecting && (
                <label className="pj-pick">
                  <input type="checkbox" checked={sel.has(p.id)} onChange={() => pick(p.id)}
                         aria-label={`${p.title} 고르기`} />
                  <span aria-hidden="true" />
                </label>
              )}
              <button className="pj-card-head"
                      onClick={() => (selecting ? pick(p.id) : toggle(p.id))}
                      aria-expanded={selecting ? undefined : open}>
                <span className={`pj-dot ${p.status}`} aria-hidden="true" />
                <span className="pj-title">{p.title}</span>
                <span className="pj-status">{STATUS_LABEL[p.status]}</span>
                <span className="pj-meta">
                  {p.progress} · {p.step_count ?? 0}스텝 · {timeAgo(p.created_at)}
                </span>
                <span className={`pj-caret ${open ? 'open' : ''}`} aria-hidden="true">▾</span>
              </button>
              </div>

              {/* 멈춘 이유는 접혀 있어도 보인다 — 이걸 숨기면 왜 안 도는지 모른다. */}
              {p.pause_reason && (
                <p className="pj-pause">{p.pause_reason}</p>
              )}

              {/* 지금 걸려 있는 지시는 접혀 있어도 보인다. 보이지 않으면
                  "왜 계획과 다르게 가지?" 를 설명할 수 없게 된다. */}
              {p.steer && (
                <p className="pj-steer-on">↪ 지시: {p.steer}</p>
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
                    <>
                      <button className="pj-btn pj-btn-primary" disabled={busy}
                              onClick={() => void act(p.id, 'resume')}>
                        그대로 이어서
                      </button>
                      {/* 멈추는 이유는 대개 "같은 지적 3회" 나 "점수 정체" 다.
                          그대로 이어 가면 정체 기록만 비워지고 조건은 그대로라
                          같은 자리에서 다시 막힌다. 방향을 바꿀 길이 있어야 한다. */}
                      <button className="pj-btn" disabled={busy}
                              onClick={() => setSteerFor(steerFor === p.id ? null : p.id)}>
                        {steerFor === p.id ? '방향 전환 닫기' : '↪ 이렇게 바꿔서'}
                      </button>
                    </>
                  )}
                  <button className="pj-btn" disabled={busy}
                          onClick={() => void act(p.id, 'cancel')}>
                    접기
                  </button>
                </div>
              )}

              {steerFor === p.id && (
                <div className="pj-steer">
                  <label className="pj-steer-label" htmlFor={`steer-${p.id}`}>
                    무엇을 바꿔서 이어갈까요
                  </label>
                  <p className="pj-steer-note">
                    이 한 줄은 다음 초안부터 <strong>검토 지적보다 위</strong>에
                    들어갑니다 — 검토자는 원래 계획을 기준으로 말하는데, 이
                    지시가 그 기준을 바꿉니다. 계획 자체는 건드리지 않습니다.
                  </p>
                  <textarea id={`steer-${p.id}`} className="pj-input" rows={2}
                    value={steerText} maxLength={600}
                    placeholder="예) 커널 지연 실측치는 빼고, 측정 방법 설계까지만 적어 주세요"
                    onChange={e => setSteerText(e.target.value)} />
                  <div className="pj-steer-actions">
                    <button className="pj-btn" disabled={busy}
                            onClick={() => { setSteerFor(null); setSteerText(''); }}>
                      취소
                    </button>
                    <button className="pj-btn pj-btn-primary"
                            disabled={busy || !steerText.trim()}
                            onClick={() => {
                              const t = steerText.trim();
                              setSteerFor(null); setSteerText('');
                              void act(p.id, 'resume', t);
                            }}>
                      이 지시로 이어가기
                    </button>
                  </div>
                </div>
              )}

              {open && (
                <div className="pj-detail">
                  {!detail && <div className="pj-empty">불러오는 중…</div>}
                  {detail && detail.id === p.id && (
                    <Detail p={detail} onRefresh={() => {
                      void refresh();
                      void api.getProject(p.id).then(d => {
                        if (d?.project) setDetail(d.project);
                      });
                    }} />
                  )}
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

/* 산출물 하나의 파일 상태. 완료 시 러너가 결재함에 '파일 저장' 제안을 올리고,
   승인해야 workspace 에 쓰인다. 제안의 detail 은 '프로젝트 제목 — 산출물 제목'. */
function findProposal(rows: ApprovalRow[], pid: string, title: string) {
  return rows.find(a => a.kind === 'file'
    && (a.file_path ?? '').includes(`projects/${pid}/`)
    && (a.detail ?? '').endsWith(title));
}

// onRefresh 는 계획을 고친 뒤 목록과 상세를 다시 읽게 한다. 고친 결과가
// 화면에 즉시 반영되지 않으면, 사장님은 저장이 됐는지 알 수 없는 채로
// 착수 승인을 누르게 된다.
function Detail({ p, onRefresh }: { p: ProjectRow; onRefresh: () => void }) {
  /* 산출물을 여기서 바로 읽는다. 예전에는 목록에 제목만 있고 본문을 볼 곳이
     없었다 — 결재함의 '내용 보기' 로 돌아가거나 파일을 찾아 열어야 했다. */
  const [openD,  setOpenD]  = useState<string | null>(null);
  // 방법 절은 산출물마다 따로 받아 둔다. 한 번 받으면 다시 받지 않는다 —
  // 같은 산출물의 방법은 바뀌지 않는다(단계 기록이 확정된 뒤이므로).
  const [methodsFor, setMethodsFor] = useState<string | null>(null);
  // 검증 화면을 연 산출물. 한 번에 하나만 — arXiv 조회가 섞여 있어
  // 여럿을 동시에 열면 요청이 몰린다.
  const [verifyFor, setVerifyFor] = useState<string | null>(null);
  const [methods, setMethods] = useState<Record<string, string>>({});

  // 일관성 시험. 호출 하나를 쓰므로 한 번 묻는다 — 누르는 순간 예산이 준다.
  const [consBusy, setConsBusy] = useState('');
  async function runCons(did: string) {
    if (!window.confirm(
      '같은 조건으로 한 번 더 써서 두 글을 견줍니다.\n'
      + '모델 호출 하나를 쓰고 1~2분 걸립니다.\n\n진행할까요?')) return;
    setConsBusy(did);
    await api.runConsistency(p.id, did);
    setConsBusy('');
    // 방법 절을 다시 받아 결과가 반영되게 한다.
    setMethods(m => { const n = { ...m }; delete n[did]; return n; });
    if (methodsFor === did) {
      const r = await api.provenance(p.id, did);
      setMethods(m => ({ ...m, [did]: r?.markdown || '' }));
    }
    onRefresh();
  }

  // 보관된 프롬프트 전문. 지문은 **대조용 값**이지 사람이 읽을 참조가
  // 아니다 — 실제 글을 열어 볼 자리를 만든다.
  const [promptsFor, setPromptsFor] = useState<string | null>(null);
  const [prompts, setPrompts] = useState<ArchivedCall[]>([]);
  const [promptsBusy, setPromptsBusy] = useState(false);
  const [promptsErr, setPromptsErr] = useState('');
  const [openCall, setOpenCall] = useState<number | null>(null);

  async function showPrompts(did: string) {
    if (promptsFor === did) { setPromptsFor(null); return; }
    setPromptsFor(did); setPrompts([]); setPromptsErr(''); setOpenCall(null);
    setPromptsBusy(true);
    // full=true 로 받는다. 목록만 받으면 또 "길이만 알고 내용은 모르는" 상태다.
    const r = await api.archivedPrompts(p.id, did, true);
    setPromptsBusy(false);
    if (!r || r.error) { setPromptsErr(r?.error || '불러오지 못했습니다'); return; }
    setPrompts(r.calls || []);
  }

  async function showMethods(did: string) {
    if (methodsFor === did) { setMethodsFor(null); return; }
    setMethodsFor(did);
    if (methods[did]) return;
    const r = await api.provenance(p.id, did);
    setMethods(m => ({ ...m, [did]: r?.markdown || '방법 기록을 받지 못했습니다.' }));
  }
  const [copied, setCopied] = useState('');
  const [saving, setSaving] = useState('');
  const [props,  setProps]  = useState<ApprovalRow[]>([]);
  const loadProps = useCallback(() => {
    api.storeList<ApprovalRow>('approvals').then(r => { if (r?.items) setProps(r.items); });
  }, []);
  useEffect(() => { loadProps(); }, [loadProps, p.status]);

  async function copy(id: string, body: string) {
    try { await navigator.clipboard.writeText(body); setCopied(id); setTimeout(() => setCopied(''), 1500); }
    catch { setCopied(''); }
  }

  async function saveFile(row: ApprovalRow) {
    // 결재함에서 '승인' 을 누르는 것과 같다. 서버가 그 순간 파일을 쓴다.
    setSaving(row.id);
    await api.storeUpdate<ApprovalRow>('approvals', row.id, { status: 'approved' });
    setSaving('');
    loadProps();
  }

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

      {/* 착수 전에만 나온다. 고칠 대상(산출물 목록) 바로 위에 두는 것은,
          무엇을 고치는지 보면서 고쳐야 하기 때문이다 — 승인 버튼은 카드
          머리에 있어 목록과 떨어져 있다. */}
      {p.status === 'awaiting_approval' && (p.plan?.deliverables?.length ?? 0) > 0 && (
        <PlanEditor p={p} onSaved={onRefresh} />
      )}

      {ds.length > 0 && (
        <div className="pj-block">
          <h3 className="pj-h3">산출물</h3>
          <ol className="pj-deliv">
            {ds.map((d, i) => {
              const state = i < p.cursor ? 'done' : i === p.cursor ? 'now' : 'todo';
              return (
                <li key={d.id} className="pj-deliv-wrap">
                  {(() => {
                    const body = p.artifacts?.[d.id] ?? '';
                    const open = openD === d.id;
                    const prop = findProposal(props, p.id, d.title);
                    const head = (
                      <>
                        <span className="pj-deliv-mark" aria-hidden="true">
                          {state === 'done' ? '✓' : state === 'now' ? '●' : '○'}
                        </span>
                        <span className="pj-deliv-title">{d.title}</span>
                        <span className="pj-deliv-dept">{deptLabels[d.dept] ?? d.dept}</span>
                        {state === 'now' && p.status === 'running' && (
                          <span className="pj-deliv-phase">{PHASE_LABEL[p.phase] ?? p.phase}</span>
                        )}
                        {body && <span className="pj-deliv-open">{open ? '접기 ▴' : `읽기 ▾ · ${body.length.toLocaleString()}자`}</span>}
                      </>
                    );
                    return (
                      <>
                        {body ? (
                          <button className={`pj-deliv-item ${state} clickable`} aria-expanded={open}
                                  onClick={() => setOpenD(open ? null : d.id)}>{head}</button>
                        ) : (
                          <div className={`pj-deliv-item ${state}`}>{head}</div>
                        )}
                        {open && body && verifyFor === d.id && (
                          <VerifyBox pid={p.id} did={d.id}
                            onSaved={() => {
                              // 방법 절에 결과가 실리므로 다시 받게 한다.
                              setMethods(m => { const n = { ...m }; delete n[d.id]; return n; });
                            }} />
                        )}
                        {open && body && methodsFor === d.id && (
                          <div className="pj-methods">
                            {methods[d.id]
                              ? <Markdown src={methods[d.id]} />
                              : <p className="pj-methods-wait">방법 기록을 불러오는 중…</p>}
                          </div>
                        )}
                        {open && body && (
                          <div className="pj-artifact">
                            <div className="pj-art-bar">
                              <button className="pj-btn" onClick={() => void copy(d.id, body)}>
                                {copied === d.id ? '✓ 복사됨' : '📋 복사'}
                              </button>
                              {/* 결재를 누르기 전에 "이게 어떻게 나왔나" 를 보는
                                  자리다. 감독할 사람에게 판단 재료가 없으면
                                  감독은 형식이 된다. */}
                              <button className="pj-btn" onClick={() => void showMethods(d.id)}>
                                {methodsFor === d.id ? '🔎 방법 닫기' : '🔎 방법 보기'}
                              </button>
                              {/* 지문만 보여 주던 것을 고친 자리. 보관해 두고
                                  열 길이 없으면 ①(전체 프롬프트 공개)은 절반이다. */}
                              <button className="pj-btn" onClick={() => void showPrompts(d.id)}>
                                {promptsFor === d.id ? '📄 프롬프트 닫기' : '📄 프롬프트'}
                              </button>
                              {/* RAISE/ISPOR 가 요구하는 반복 실행 일관성.
                                  안 하면 방법 절이 "확인하지 않았습니다" 로 남는다. */}
                              <button className="pj-btn" disabled={consBusy === d.id}
                                      onClick={() => void runCons(d.id)}>
                                {consBusy === d.id ? '시험 중…' : '🔁 일관성 시험'}
                              </button>
                              {/* 검토가 모델끼리라는 것이 이 시스템의 가장 큰
                                  빈칸이다. 사람이 표본을 보는 자리. */}
                              <button className="pj-btn"
                                      onClick={() => setVerifyFor(
                                        verifyFor === d.id ? null : d.id)}>
                                {verifyFor === d.id ? '✋ 검증 닫기' : '✋ 표본 검증'}
                              </button>
                              {prop?.status === 'approved' ? (
                                <span className="pj-art-file ok">💾 저장됨 · workspace/{prop.file_path}</span>
                              ) : prop?.status === 'pending' ? (
                                <>
                                  <button className="pj-btn pj-btn-primary" disabled={saving === prop.id}
                                          onClick={() => void saveFile(prop)}>
                                    {saving === prop.id ? '저장 중…' : '💾 파일로 저장 (승인)'}
                                  </button>
                                  <span className="pj-art-file">workspace/{prop.file_path}</span>
                                </>
                              ) : prop?.status === 'rejected' ? (
                                <span className="pj-art-file">결재에서 거절됨 — 파일로 저장하지 않았습니다</span>
                              ) : (
                                <span className="pj-art-file">
                                  {p.status === 'done' ? '파일 저장 제안이 결재함에 없습니다' : '완료되면 파일 저장 제안이 결재함에 올라갑니다'}
                                </span>
                              )}
                            </div>
                            {promptsFor === d.id && (
                              <div className="pj-prompts">
                                {promptsBusy && <div className="pj-prompt-note">불러오는 중…</div>}
                                {promptsErr && <div className="pj-prompt-note">⚠️ {promptsErr}</div>}
                                {!promptsBusy && !promptsErr && prompts.length === 0 && (
                                  <div className="pj-prompt-note">
                                    보관된 프롬프트가 없습니다. 2026-10-22 이전에 만든
                                    산출물은 지문과 길이만 남아 있어 되살릴 수 없습니다.
                                  </div>
                                )}
                                {prompts.map((c, i) => (
                                  <div key={i} className="pj-prompt-item">
                                    <button className="pj-prompt-head"
                                            onClick={() => setOpenCall(openCall === i ? null : i)}>
                                      <span className="pj-prompt-phase">
                                        {c.phase === 'draft' ? '초안'
                                          : c.phase === 'review1' ? '1차 검토'
                                          : c.phase === 'review2' ? '2차 검토'
                                          : c.phase === 'plan' ? '계획' : c.phase}
                                      </span>
                                      <span className="pj-prompt-meta">
                                        {c.model} · temp {c.temperature} ·{' '}
                                        {((c.system?.length ?? 0) + (c.user?.length ?? 0)).toLocaleString()}자
                                      </span>
                                      <span className="pj-prompt-caret">{openCall === i ? '▲' : '▼'}</span>
                                    </button>
                                    {openCall === i && (
                                      <div className="pj-prompt-body">
                                        <div className="pj-prompt-label">지시 (system)</div>
                                        <pre className="pj-prompt-pre">{c.system || '(없음)'}</pre>
                                        <div className="pj-prompt-label">
                                          입력 (user) — 조회된 근거가 이 안에 들어 있습니다
                                        </div>
                                        <pre className="pj-prompt-pre">{c.user || '(없음)'}</pre>
                                      </div>
                                    )}
                                  </div>
                                ))}
                              </div>
                            )}
                            <div className="pj-art-body"><Markdown src={body} /></div>
                          </div>
                        )}
                      </>
                    );
                  })()}
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

      {/* 점수 100점이 "근거와 맞춰 봤다" 인지 "그럴듯하다" 인지 화면이
          구분해 주지 않았다. 심사 이력보다 위에 둔다 — 점수를 읽기 전에
          그 점수가 무엇에 대한 것인지 알아야 한다. */}
      <ConfidenceBox p={p} steps={steps} />

      {/* 42단계 평면 목록만으로는 어느 산출물이 왜 막혔는지 사람이
          직접 재구성해야 한다. 그 재구성을 화면이 한다. */}
      <ReviewHistory p={p} />

      {steps.length > 0 && (
        <div className="pj-block">
          <h3 className="pj-h3">
            진행 기록
            <span className="pj-budget">오늘 남은 호출 {p.budget_left}회</span>
          </h3>
          {/* 지금 돌고 있는 호출을 맨 위에 고정한다.
              기록은 호출이 **끝난 뒤** 남으므로, 이 줄이 없으면 2분짜리
              호출이 도는 동안 화면에는 아무것도 나타나지 않는다 — 12단계
              까지만 보이고 13번째는 보이지 않는 채로 돈다. */}
          {p.status === 'running' && p.inflight && (
            <div className="pj-step now" aria-live="polite">
              <span className="pj-step-n" aria-hidden="true">●</span>
              <span className="pj-step-phase">{PHASE_LABEL[p.inflight.phase] ?? p.inflight.phase}</span>
              <span className="pj-step-dept">
                {deptLabels[p.inflight.dept] ?? p.inflight.dept}
              </span>
              <span className="pj-step-note">
                {p.inflight.deliverable || '산출물'} — 응답을 기다리는 중
                <span className="pj-step-model">{p.inflight.model}</span>
              </span>
            </div>
          )}
          {/* 최근 것이 위로. 아래로 스크롤해서 최신을 찾게 하면 안 된다. */}
          <ol className="pj-steps">
            {[...steps].reverse().map(s => (
              <li key={s.n} className={`pj-step ${s.dead ? 'dead' : s.ok ? 'ok' : 'no'}`}>
                <span className="pj-step-n">{s.n}</span>
                <span className="pj-step-phase">{PHASE_LABEL[s.phase] ?? s.phase}</span>
                <span className="pj-step-dept">{deptLabels[s.dept] ?? s.dept}</span>
                {s.score >= 0 && <span className="pj-step-score">{s.score}점</span>}
                {/* 걸린 시간. 분 단위가 넘어가면 초로 쓰면 읽히지 않는다. */}
                {!!s.secs && (
                  <span className="pj-step-secs">
                    {s.secs >= 60 ? `${Math.floor(s.secs / 60)}분 ${Math.round(s.secs % 60)}초`
                      : `${s.secs}초`}
                  </span>
                )}
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
