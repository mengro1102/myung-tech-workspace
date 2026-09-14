/**
 * 노트 탭 — 사장님이 해야 할 일을 스레드 카드로 쌓고, 체크하고, 지운다.
 *
 * 프로젝트 탭과 역할이 다르다. 프로젝트는 에이전트가 돌리는 일이고, 여기는
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

type Filter = 'todo' | 'done' | 'all';

/** 카드 머리에 다는 꼬리표. 색으로 구분해 훑을 때 눈이 먼저 잡도록. */
const TAGS = ['입력', '계정', '결재', '확인', '기타'] as const;

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
    const r = await api.storeList<Note>('notes');
    if (r && Array.isArray(r.items)) setNotes(r.items);
    else setErr('노트를 불러오지 못했습니다 — 백엔드가 떠 있는지 보세요');
    setLoading(false);
  }, []);

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

  return (
    <div className="hs-body nt-wrap">
      <div className="nt-head">
        <div className="nt-title">
          📝 노트
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
