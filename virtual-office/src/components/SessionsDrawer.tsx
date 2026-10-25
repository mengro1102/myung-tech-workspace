/** 대화 기록 — 보고 · 이어가고 · 이름 바꾸고 · 지운다.
 *
 *  ## 왜 따로 떼어냈나
 *
 *  전에는 App.tsx 안의 20줄짜리 목록이었다. 할 수 있는 일은 **누르면
 *  이어가기** 하나뿐 — 쌓인 대화를 솎아낼 방법이 없었다. 하루 쓰면
 *  "대시보드 · 10-24 22:13" 이 스무 줄이고, 그중 어느 것이 무슨 대화였는지
 *  알 길이 없다. 제목도 만들 때 한 번 정하면 끝이었다.
 *
 *  ## 설계에서 고민한 것
 *
 *  **1. 출처를 섞지 않는다.** 맹비서 세션 목록에는 텔레그램·디스코드
 *  대화가 같이 선다. 한 목록에 두면 웹에서 실수로 텔레그램 대화를 지울 수
 *  있다 — 그쪽은 명테크가 만든 것이 아니고, 지우면 사장님 휴대폰의 기록이
 *  사라진다. 그래서 기본은 **대시보드만**이고 전체 보기는 따로 고른다.
 *
 *  **2. 삭제는 두 번 누른다.** 되돌릴 수 없다(맹비서가 state.db 행을
 *  지운다). 브라우저 `confirm()` 은 쓰지 않는다 — 어느 대화를 지우는지
 *  보이지 않고, 모양이 앱과 어긋난다. 그 자리에서 "지웁니다 / 취소" 가
 *  뜨게 한다.
 *
 *  **3. 지금 보는 대화를 지우면 화면을 비운다.** 안 그러면 없는 세션에
 *  말을 걸어 404 가 난다.
 *
 *  **4. 미리보기를 적는다.** 제목이 다 비슷하므로 `preview` 가 어느
 *  대화였는지 알아볼 유일한 단서다.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, type AssistantSession } from '../api';

type Props = {
  /** 지금 화면이 붙어 있는 세션. 목록에서 표시하고, 지울 때 비운다. */
  currentSid: string;
  onOpen: (sid: string) => void;
  /** 새 대화를 만들었다 / 지금 대화가 사라졌다 를 App 에 알린다. */
  onNew: (sid: string) => void;
  onCurrentDeleted: () => void;
  notify: (kind: 'info' | 'success' | 'warning' | 'error', msg: string) => void;
  onClose: () => void;
};

/** 출처 필터. 빈 문자열은 전체다. */
const SOURCES: { key: string; label: string }[] = [
  { key: 'api_server', label: '🖥 대시보드' },
  { key: 'discord', label: '💬 디스코드' },
  { key: 'telegram', label: '📱 텔레그램' },
  { key: '', label: '전체' },
];

function srcLabel(src?: string): string {
  const hit = SOURCES.find(x => x.key && x.key === src);
  if (hit) return hit.label;
  if (src === 'cli') return '⌨ CLI';
  return src ? `· ${src}` : '· ?';
}

/** 맹비서는 epoch 초를 준다. "3분 전" 이 "1761..." 보다 읽힌다. */
function ago(ts?: number): string {
  if (!ts) return '';
  const sec = Math.max(0, Date.now() / 1000 - (ts > 1e12 ? ts / 1000 : ts));
  if (sec < 60) return '방금';
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  const d = Math.floor(h / 24);
  return d < 30 ? `${d}일 전` : `${Math.floor(d / 30)}달 전`;
}

export default function SessionsDrawer({
  currentSid, onOpen, onNew, onCurrentDeleted, notify, onClose,
}: Props) {
  const [rows, setRows] = useState<AssistantSession[]>([]);
  const [busy, setBusy] = useState(true);
  const [err, setErr] = useState('');
  const [filter, setFilter] = useState('api_server');
  const [q, setQ] = useState('');
  /** 휴지통을 한 번 누른 세션. 두 번째 누름이 실제 삭제다. */
  const [confirmId, setConfirmId] = useState('');
  /** 이름을 고치는 중인 세션과 입력값. */
  const [editId, setEditId] = useState('');
  const [draft, setDraft] = useState('');
  const [acting, setActing] = useState('');
  const editRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async (src: string) => {
    setBusy(true);
    setErr('');
    const r = await api.assistantSessions(src || undefined, 200);
    setBusy(false);
    if (r?.error) { setErr(r.error); setRows([]); return; }
    setRows(r?.data ?? []);
  }, []);

  useEffect(() => { void load(filter); }, [filter, load]);

  // 이름 칸이 뜨면 바로 커서를 둔다 — 안 하면 한 번 더 눌러야 한다.
  useEffect(() => { if (editId) editRef.current?.select(); }, [editId]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(r =>
      (r.title ?? '').toLowerCase().includes(needle)
      || (r.preview ?? '').toLowerCase().includes(needle));
  }, [rows, q]);

  const makeNew = async () => {
    setActing('new');
    // 제목에 시각을 붙인다 — 맹비서가 **중복 제목을 400 으로 거절**한다.
    // 초까지 넣는다. 분까지만 넣었다가 연달아 두 번 누르면 실패했다.
    const now = new Date();
    const p2 = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getMonth() + 1}/${now.getDate()} `
      + `${p2(now.getHours())}:${p2(now.getMinutes())}:${p2(now.getSeconds())}`;
    const r = await api.assistantNewSession(`대시보드 · ${stamp}`);
    setActing('');
    const sid = r?.session?.id ?? '';
    if (!sid) {
      notify('warning', `새 대화를 만들지 못했습니다 — ${r?.error ?? '맹비서 응답 없음'}`);
      return;
    }
    onNew(sid);
    notify('success', '새 대화를 시작했습니다');
    onClose();
  };

  const doDelete = async (sv: AssistantSession) => {
    setActing(sv.id);
    const r = await api.assistantDeleteSession(sv.id);
    setActing('');
    setConfirmId('');
    if (r?.error || r?.deleted === false) {
      notify('error', `지우지 못했습니다 — ${r?.error ?? '맹비서가 거절했습니다'}`);
      return;
    }
    setRows(prev => prev.filter(x => x.id !== sv.id));
    // 지금 보던 대화를 지웠으면 화면을 비운다. 안 비우면 없는 세션에
    // 말을 걸어 404 가 난다.
    if (sv.id === currentSid) onCurrentDeleted();
    notify('info', `대화를 지웠습니다 — ${sv.title || sv.id}`);
  };

  const doRename = async (sv: AssistantSession) => {
    const title = draft.trim();
    if (!title || title === (sv.title ?? '')) { setEditId(''); return; }
    setActing(sv.id);
    const r = await api.assistantRenameSession(sv.id, title);
    setActing('');
    if (r?.error) {
      // 맹비서가 준 사유를 그대로 적는다. "이미 쓰이는 제목" 을 우리가
      // 추측해 쓰면 다른 이유로 실패한 경우를 가린다.
      notify('error', `이름을 바꾸지 못했습니다 — ${r.error}`);
      return;
    }
    setRows(prev => prev.map(x => (x.id === sv.id ? { ...x, title } : x)));
    setEditId('');
  };

  return (
    <div className="hm-backdrop" onClick={onClose}>
      <div className="hm-panel sess-panel" onClick={e => e.stopPropagation()}>
        <div className="hm-header">
          <span className="hm-title">🗂 대화 기록</span>
          <span className="hm-subtitle">
            {busy ? '…'
              : `${shown.length}건${q.trim() && shown.length !== rows.length ? ` / ${rows.length}` : ''}`}
          </span>
          <button className="hm-close" onClick={onClose} aria-label="닫기">✕</button>
        </div>

        <div className="sess-bar">
          <div className="sess-chips" role="tablist" aria-label="출처">
            {SOURCES.map(sx => (
              <button key={sx.key || 'all'} role="tab"
                      aria-selected={filter === sx.key}
                      className={`sess-chip ${filter === sx.key ? 'on' : ''}`}
                      onClick={() => { setFilter(sx.key); setConfirmId(''); setEditId(''); }}>
                {sx.label}
              </button>
            ))}
          </div>
          <div className="sess-actions">
            <input className="sess-search" value={q} placeholder="제목·내용 찾기"
                   onChange={e => setQ(e.target.value)} />
            <button className="sess-new" onClick={() => void makeNew()}
                    disabled={acting === 'new'}>
              {acting === 'new' ? '만드는 중…' : '✨ 새 대화'}
            </button>
          </div>
        </div>

        <div className="sess-note">
          누르면 그 자리에서 이어집니다. 이름은 ✎ 로 바꾸고, 🗑 는 두 번
          눌러야 지워집니다 — 되돌릴 수 없습니다.
          {filter !== 'api_server' && (
            <strong> 대시보드 밖의 대화는 휴대폰·디스코드의 기록입니다.</strong>
          )}
        </div>

        <div className="sess-list">
          {busy && <div className="sess-empty">불러오는 중…</div>}
          {!busy && err && (
            <div className="sess-empty err">
              {err}
              <button className="sess-retry" onClick={() => void load(filter)}>
                다시 시도
              </button>
            </div>
          )}
          {!busy && !err && shown.length === 0 && (
            <div className="sess-empty">
              {q.trim() ? '찾는 대화가 없습니다.'
                : filter === 'api_server'
                  ? '대시보드 대화가 없습니다. ✨ 새 대화로 시작하십시오.'
                  : '이 출처의 대화가 없습니다.'}
            </div>
          )}

          {shown.map(sv => {
            const live = sv.id === currentSid;
            const editing = editId === sv.id;
            const asking = confirmId === sv.id;
            return (
              <div key={sv.id} className={`sess-row ${live ? 'active' : ''}`}>
                <button className="sess-main"
                        onClick={() => { if (!editing) { onOpen(sv.id); onClose(); } }}
                        disabled={editing}>
                  <span className="sess-line1">
                    <span className="sess-src">{srcLabel(sv.source)}</span>
                    {editing ? (
                      <input ref={editRef} className="sess-edit" value={draft}
                             onChange={e => setDraft(e.target.value)}
                             onClick={e => e.stopPropagation()}
                             onKeyDown={e => {
                               if (e.key === 'Enter') void doRename(sv);
                               // Escape 는 패널까지 닫히지 않게 막는다 —
                               // 이름만 고치다 말았는데 목록이 사라지면 당황한다.
                               if (e.key === 'Escape') { e.stopPropagation(); setEditId(''); }
                             }} />
                    ) : (
                      <span className="sess-title">{sv.title || '(제목 없음)'}</span>
                    )}
                    {live && <span className="sess-live">지금 보는 대화</span>}
                  </span>
                  {sv.preview && !editing && (
                    <span className="sess-preview">{sv.preview}</span>
                  )}
                  <span className="sess-meta">
                    {sv.message_count ?? 0}개
                    {sv.last_active ? ` · ${ago(sv.last_active)}` : ''}
                    {sv.model ? ` · ${sv.model}` : ''}
                  </span>
                </button>

                <div className="sess-btns">
                  {editing ? (
                    <>
                      <button className="sess-ico ok" title="저장"
                              disabled={acting === sv.id}
                              onClick={() => void doRename(sv)}>✓</button>
                      <button className="sess-ico" title="취소"
                              onClick={() => setEditId('')}>✕</button>
                    </>
                  ) : asking ? (
                    <>
                      <button className="sess-ico danger wide" title="되돌릴 수 없습니다"
                              disabled={acting === sv.id}
                              onClick={() => void doDelete(sv)}>
                        {acting === sv.id ? '…' : '지웁니다'}
                      </button>
                      <button className="sess-ico" title="취소"
                              onClick={() => setConfirmId('')}>✕</button>
                    </>
                  ) : (
                    <>
                      <button className="sess-ico" title="이름 바꾸기"
                              onClick={() => { setDraft(sv.title ?? ''); setEditId(sv.id); setConfirmId(''); }}>
                        ✎
                      </button>
                      <button className="sess-ico danger" title="지우기"
                              onClick={() => { setConfirmId(sv.id); setEditId(''); }}>
                        🗑
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
