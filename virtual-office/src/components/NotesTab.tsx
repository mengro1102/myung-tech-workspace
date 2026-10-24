/**
 * 할 일 — 사장님이 해야 할 일을 스레드 카드로 쌓고, 체크하고, 지운다.
 *
 * 전에는 '노트' 탭이었다. 지금은 **프로젝트 탭 안의 한 칸**이다 — 결재함
 * 바로 아래. 둘 다 사람만 할 수 있는 일이고, 탭을 나눠 두면 "내가 뭘 해야
 * 하더라" 를 보려고 매번 옮겨야 했다. 그 자리는 지식베이스 탭이 받았다.
 *
 * 프로젝트 목록과 역할이 다르다. 프로젝트는 에이전트가 돌리는 일이고, 여기는
 * 사람만 할 수 있는 일(토큰 발급, 계정 로그인, 결재 판단)이 쌓이는 곳이다.
 * 그동안 그런 항목은 대화 기록 속에 흩어져 있어서 "내가 뭘 해야 하더라"를
 * 매번 다시 물어야 했다.
 *
 * 저장은 workspace_store 의 notes 컬렉션. 태스크·서비스·결재와 같은 그릇을
 * 쓰므로 백엔드에 새로 만든 것은 컬렉션 이름 하나뿐이다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type StoreItem } from '../api';
import { Markdown } from './GuideModal';

interface Note extends StoreItem {
  title?: string;
  body?: string;
  done?: boolean;
  pinned?: boolean;
  tag?: string;
}

/** 에이전트가 `workspace_store.add_task()` 로 올리는 한 줄짜리 일.
 *  전에는 관리 탭의 '태스크 보드' 에만 떴다. */
interface AgentTask extends StoreItem {
  text?: string;
  done?: boolean;
  source?: string;        // 'user' 또는 부서 id
  department?: string;
}

type Filter = 'todo' | 'done' | 'all';

/** 카드 머리에 다는 꼬리표. 색으로 구분해 훑을 때 눈이 먼저 잡도록. */
const TAGS = ['입력', '계정', '결재', '확인', '기타'] as const;

/** 부서 id → 사람이 읽는 이름. 에이전트 태스크에 누가 올렸는지 붙인다. */
const DEPT: Record<string, string> = {
  orchestration_dept: '오케스트레이션',
  research_dept: '학술연구',
  finance_dept: '금융투자',
  dev_dept: '개발',
  content_dept: '콘텐츠',
};

function when(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

export default function NotesTab() {
  const [notes, setNotes] = useState<Note[]>([]);
  // 에이전트가 올린 태스크. 관리 탭의 '태스크 보드' 가 유일한 창구였는데,
  // 거기서 빼면서 이리로 왔다 — 둘 다 사람이 해야 끝나는 일이라서.
  const [agentTasks, setAgentTasks] = useState<AgentTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<Filter>('todo');
  const [editing, setEditing] = useState<string | null>(null);   // id, 또는 'new'
  const [draftTitle, setDraftTitle] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [draftTag, setDraftTag] = useState<string>('기타');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [err, setErr] = useState('');
  const titleRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    // 둘을 같이 받는다. 한 번의 화면 갱신으로 둘 다 맞게 하려는 것이다 —
    // 따로 받으면 한쪽만 새로 그려지는 순간이 생긴다.
    const [r, t] = await Promise.all([
      api.storeList<Note>('notes'),
      api.storeList<AgentTask>('tasks'),
    ]);
    if (r && Array.isArray(r.items)) setNotes(r.items);
    else setErr('노트를 불러오지 못했습니다 — 백엔드가 떠 있는지 보세요');
    // 태스크는 실패해도 오류를 띄우지 않는다. 노트는 보여야 한다.
    if (t && Array.isArray(t.items)) setAgentTasks(t.items);
    setLoading(false);
  }, []);

  /** 에이전트 태스크 체크. 낙관적으로 먼저 칠하고, 실패하면 되돌린다 —
   *  한 줄짜리라 왕복을 기다리면 눌린 건지 아닌지 알 수 없다. */
  const toggleTask = useCallback(async (t: AgentTask) => {
    const next = !t.done;
    setAgentTasks(prev => prev.map(x => (x.id === t.id ? { ...x, done: next } : x)));
    const r = await api.storeUpdate<AgentTask>('tasks', t.id, { done: next });
    if (!r) {
      setAgentTasks(prev => prev.map(x => (x.id === t.id ? { ...x, done: !next } : x)));
      setErr('태스크를 바꾸지 못했습니다');
    }
  }, []);

  const removeTask = useCallback(async (t: AgentTask) => {
    // 한 줄짜리라 가볍게 지우게 뒀는데, 이건 **에이전트가 사장님께 올린
    // 요청**이다. 지우면 그 요청은 아무 데도 남지 않는다. 바로 아래 노트
    // 삭제는 묻는데 이것만 안 묻는 것도 앞뒤가 안 맞는다.
    if (!window.confirm(`에이전트가 올린 이 일을 지울까요?

${t.text ?? ''}`)) return;
    const keep = agentTasks;
    setAgentTasks(prev => prev.filter(x => x.id !== t.id));
    const r = await api.storeRemove('tasks', t.id);
    if (!r) { setAgentTasks(keep); setErr('태스크를 지우지 못했습니다'); }
  }, [agentTasks]);

  useEffect(() => { void load(); }, [load]);

  // 편집을 열면 제목으로 커서를 보낸다 — 열어 놓고 다시 클릭하게 하지 않는다.
  useEffect(() => { if (editing) titleRef.current?.focus(); }, [editing]);

  const startNew = () => {
    setDraftTitle(''); setDraftBody(''); setDraftTag('기타'); setEditing('new');
  };

  const startEdit = (n: Note) => {
    setDraftTitle(n.title || ''); setDraftBody(n.body || '');
    setDraftTag(n.tag || '기타'); setEditing(n.id);
  };

  const cancel = () => { setEditing(null); setErr(''); };

  const save = async () => {
    const title = draftTitle.trim();
    if (!title) { setErr('제목을 적어 주세요'); titleRef.current?.focus(); return; }
    setErr('');
    const payload = { title, body: draftBody, tag: draftTag };
    if (editing === 'new') {
      const r = await api.storeAdd<Note>('notes', { ...payload, done: false });
      if (!r?.ok || !r.item) { setErr(r?.error || '저장하지 못했습니다'); return; }
      const made = r.item;
      setNotes(p => [...p, made]);
      setOpen(o => ({ ...o, [made.id]: true }));   // 방금 쓴 것은 펼쳐 둔다
    } else if (editing) {
      const r = await api.storeUpdate<Note>('notes', editing, payload);
      if (!r?.ok) { setErr(r?.error || '저장하지 못했습니다'); return; }
      setNotes(p => p.map(n => (n.id === editing ? { ...n, ...payload } : n)));
    }
    setEditing(null);
  };

  const toggle = async (n: Note) => {
    const next = !n.done;
    setNotes(p => p.map(x => (x.id === n.id ? { ...x, done: next } : x)));   // 먼저 반응
    const r = await api.storeUpdate<Note>('notes', n.id, { done: next });
    if (!r?.ok) {                                                            // 실패하면 되돌린다
      setNotes(p => p.map(x => (x.id === n.id ? { ...x, done: !next } : x)));
      setErr(r?.error || '상태를 바꾸지 못했습니다');
    }
  };

  const pin = async (n: Note) => {
    const next = !n.pinned;
    setNotes(p => p.map(x => (x.id === n.id ? { ...x, pinned: next } : x)));
    const r = await api.storeUpdate<Note>('notes', n.id, { pinned: next });
    if (!r?.ok) setNotes(p => p.map(x => (x.id === n.id ? { ...x, pinned: !next } : x)));
  };

  // 삭제는 되돌릴 수 없으니 제목을 보여 주고 묻는다. 카드 하나 지우자고
  // 모달을 띄우면 번거롭고, 안 물으면 손이 미끄러진다.
  const remove = async (n: Note) => {
    if (!window.confirm(`삭제할까요?\n\n${n.title || '(제목 없음)'}`)) return;
    const keep = notes;
    setNotes(p => p.filter(x => x.id !== n.id));
    const r = await api.storeRemove('notes', n.id);
    if (!r?.ok) { setNotes(keep); setErr('삭제하지 못했습니다'); }
  };

  const clearDone = async () => {
    const done = notes.filter(n => n.done);
    if (!done.length) return;
    if (!window.confirm(`끝난 노트 ${done.length}건을 지울까요?`)) return;
    setNotes(p => p.filter(n => !n.done));
    for (const n of done) await api.storeRemove('notes', n.id);
  };

  const shown = useMemo(() => {
    const rows = notes.filter(n =>
      filter === 'all' ? true : filter === 'done' ? n.done : !n.done);
    // 고정 → 미완료 → 최신순. 끝낸 것은 아래로 가라앉는다.
    return rows.sort((a, b) =>
      Number(b.pinned ?? false) - Number(a.pinned ?? false) ||
      Number(a.done ?? false) - Number(b.done ?? false) ||
      (b.created_at ?? 0) - (a.created_at ?? 0));
  }, [notes, filter]);

  const left = notes.filter(n => !n.done).length;

  // 끝난 태스크는 숨긴다. 에이전트가 계속 쌓으므로, 다 보여 주면 며칠 만에
  // 끝난 것 수십 줄 밑에 새 요청이 묻힌다. 필터가 '끝남'/'전체' 일 때만 편다.
  const openTasks = useMemo(
    () => agentTasks
      .filter(t => (filter === 'todo' ? !t.done : filter === 'done' ? t.done : true))
      .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0)),
    [agentTasks, filter]);

  return (
    <div className="hs-body nt-wrap">
      <div className="nt-head">
        {/* '노트' 라고 부르던 것. 그 이름은 탭 이름이었고, 그 탭은 이제
            없다(지식베이스가 그 자리에 있다). 여기 쌓이는 것은 사람만 할
            수 있는 일이라, 바로 위 결재함과 같은 성질로 읽히게 바꾼다. */}
        <div className="nt-title">
          📋 할 일
          <span className="nt-count">{left ? `남은 일 ${left}` : '다 끝냈습니다'}</span>
        </div>
        <div className="nt-actions">
          {(['todo', 'done', 'all'] as Filter[]).map(f => (
            <button key={f}
              className={`nt-filter ${filter === f ? 'on' : ''}`}
              onClick={() => setFilter(f)}>
              {f === 'todo' ? '할 일' : f === 'done' ? '끝남' : '전체'}
            </button>
          ))}
          {notes.some(n => n.done) && (
            <button className="nt-clear" onClick={clearDone}>끝난 것 비우기</button>
          )}
          <button className="nt-new" onClick={startNew}>+ 새 노트</button>
        </div>
      </div>

      {err && <div className="nt-err" onClick={() => setErr('')}>{err} — 눌러서 닫기</div>}

      {/* 에이전트가 올린 것. 전에는 관리 탭 '태스크 보드' 에만 있었다.
          노트와 한 목록에 섞지 않는다 — 노트는 제목·본문·꼬리표가 있는
          카드고 이건 한 줄짜리라, 섞으면 높이가 들쭉날쭉하고 무엇을 내가
          적었고 무엇이 올라온 것인지 구분이 사라진다.

          올라온 것이 없으면 줄 자체를 그리지 않는다 — 빈 칸이 자리를
          차지하면 다음부터 안 보게 된다. */}
      {openTasks.length > 0 && (
        <section className="nt-agent">
          <div className="nt-agent-head">
            🤖 에이전트가 올린 것
            <span>{openTasks.length}건 · 사장님이 눌러야 끝납니다</span>
          </div>
          {openTasks.map(t => (
            <div key={t.id} className="nt-agent-row">
              <label className="nt-check">
                <input type="checkbox" checked={!!t.done}
                       onChange={() => void toggleTask(t)}
                       aria-label={`${t.text ?? ''} 끝냄으로 표시`} />
                <span aria-hidden="true" />
              </label>
              <span className="nt-agent-text">{t.text}</span>
              {t.source && t.source !== 'user' && (
                <span className="nt-agent-from">{DEPT[t.source] ?? t.source}</span>
              )}
              <span className="nt-agent-when">{when(t.created_at)}</span>
              <button className="nt-agent-x" onClick={() => void removeTask(t)}
                      title="지우기">✕</button>
            </div>
          ))}
        </section>
      )}

      {editing === 'new' && (
        <Editor
          titleRef={titleRef}
          title={draftTitle} body={draftBody} tag={draftTag}
          onTitle={setDraftTitle} onBody={setDraftBody} onTag={setDraftTag}
          onSave={save} onCancel={cancel} />
      )}

      {loading ? (
        <div className="nt-empty">불러오는 중…</div>
      ) : !shown.length ? (
        <div className="nt-empty">
          {filter === 'done' ? '끝낸 노트가 없습니다.'
            : filter === 'todo' ? '할 일이 없습니다. 새 노트로 쌓아 두세요.'
            : '아직 노트가 없습니다.'}
        </div>
      ) : (
        <div className="nt-list">
          {shown.map(n => editing === n.id ? (
            <Editor key={n.id}
              titleRef={titleRef}
              title={draftTitle} body={draftBody} tag={draftTag}
              onTitle={setDraftTitle} onBody={setDraftBody} onTag={setDraftTag}
              onSave={save} onCancel={cancel} />
          ) : (
            <article key={n.id} className={`nt-card ${n.done ? 'done' : ''}`}>
              <div className="nt-card-head">
                {/* 실제 input 은 투명하게 덮어 두고 span 을 칠한다. 이름이
                    없으면 보조 기술에 "체크박스" 로만 읽히므로 제목을 준다. */}
                <label className="nt-check">
                  <input type="checkbox" checked={!!n.done} onChange={() => toggle(n)}
                    aria-label={`${n.title || '제목 없음'} — ${n.done ? '끝냄 취소' : '끝냄 표시'}`} />
                  <span />
                </label>
                <button className="nt-card-title"
                  onClick={() => setOpen(o => ({ ...o, [n.id]: !o[n.id] }))}
                  title={n.body ? '눌러서 내용 펼치기' : ''}>
                  {n.pinned && <span className="nt-pin-mark">📌</span>}
                  <span className={`nt-tag t-${TAGS.indexOf(n.tag as typeof TAGS[number]) + 1}`}>
                    {n.tag || '기타'}
                  </span>
                  {n.title || '(제목 없음)'}
                  {n.body ? <span className="nt-chev">{open[n.id] ? '▾' : '▸'}</span> : null}
                </button>
                <span className="nt-when">{when(n.created_at)}</span>
                <div className="nt-card-tools">
                  <button onClick={() => pin(n)} title={n.pinned ? '고정 해제' : '위로 고정'}>
                    {n.pinned ? '📌' : '📍'}
                  </button>
                  <button onClick={() => startEdit(n)} title="고치기">✏️</button>
                  <button onClick={() => remove(n)} title="삭제">🗑️</button>
                </div>
              </div>
              {open[n.id] && n.body && (
                <div className="nt-card-body"><Markdown src={n.body} /></div>
              )}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function Editor(props: {
  titleRef: React.RefObject<HTMLInputElement>;
  title: string; body: string; tag: string;
  onTitle: (v: string) => void; onBody: (v: string) => void; onTag: (v: string) => void;
  onSave: () => void; onCancel: () => void;
}) {
  const [preview, setPreview] = useState(false);
  return (
    <div className="nt-editor">
      <div className="nt-editor-row">
        <input ref={props.titleRef} className="nt-input" placeholder="제목"
          value={props.title} onChange={e => props.onTitle(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape') props.onCancel(); }} />
        <select className="nt-select" value={props.tag}
          onChange={e => props.onTag(e.target.value)}>
          {TAGS.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {preview ? (
        <div className="nt-preview"><Markdown src={props.body || '_(내용 없음)_'} /></div>
      ) : (
        <textarea className="nt-textarea" rows={7}
          placeholder={'내용 — 마크다운을 씁니다\n\n## 소제목\n- 목록\n- **굵게** · `코드` · [링크](https://…)\n\n| 표 | 됩니다 |\n|---|---|'}
          value={props.body} onChange={e => props.onBody(e.target.value)}
          onKeyDown={e => {
            // Ctrl+Enter 로 저장. 본문이 여러 줄이라 Enter 는 줄바꿈이어야 한다.
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); props.onSave(); }
            if (e.key === 'Escape') props.onCancel();
          }} />
      )}

      <div className="nt-editor-foot">
        <button className="nt-ghost" onClick={() => setPreview(p => !p)}>
          {preview ? '고치기' : '미리보기'}
        </button>
        <span className="nt-hint">Ctrl+Enter 저장 · Esc 취소</span>
        <button className="nt-ghost" onClick={props.onCancel}>취소</button>
        <button className="nt-save" onClick={props.onSave}>저장</button>
      </div>
    </div>
  );
}
