/** 휴지통 — 프로젝트 탭 맨 아래.
 *
 *  ## 왜 바로 지우지 않나
 *
 *  대시보드는 터널로 밖에서도 열린다. 접속 키가 새면 남이 지울 수 있고,
 *  그 자리에서 사라지면 사장님은 무엇을 잃었는지도 모른다. 그래서 여기서의
 *  삭제는 **옮기기**이고, 옮기면 맹비서가 디스코드로 알린다.
 *
 *  ## 영구 삭제 버튼이 없는 이유
 *
 *  일부러 없다. 영구 삭제는 맹비서에게 `/휴지통` 으로 하고, 디스코드 DM 으로
 *  간 6자리 코드를 불러 줘야 된다. 이 화면에 버튼이 있으면 접속 키 하나로
 *  모든 것이 지워진다 — 휴지통을 둔 의미가 없어진다.
 *
 *  ## 되돌리기 띠
 *
 *  지운 직후 몇 초 동안 「되돌리기」 를 띄운다(메일 앱의 그것). 손이 미끄러진
 *  경우를 위해 휴지통까지 내려가게 하지 않는다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type TrashItem } from '../api';
import { TRASH_EVENT, trashChanged } from './trashEvent';

export { TRASH_EVENT, trashChanged };

function when(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
}

/* ── 되돌리기 띠 ─────────────────────────────────────────────────── */
const UNDO_MS = 10_000;

export type TrashUndo = { items: TrashItem[]; show: (items: TrashItem[]) => void;
                          clear: () => void };

export function useTrashUndo(): TrashUndo {
  const [items, setItems] = useState<TrashItem[]>([]);
  const timer = useRef<number | undefined>(undefined);
  const clear = useCallback(() => { window.clearTimeout(timer.current); setItems([]); }, []);
  const show = useCallback((it: TrashItem[]) => {
    window.clearTimeout(timer.current);
    setItems(it);
    trashChanged();
    timer.current = window.setTimeout(() => setItems([]), UNDO_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return { items, show, clear };
}

export function TrashUndoBar({ undo, onRestored }:
    { undo: TrashUndo; onRestored?: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!undo.items.length) return null;
  const n = undo.items.length;
  const label = n === 1 ? `「${undo.items[0].title}」` : `${n}건`;
  return (
    <div className="tr-undo" role="status">
      <span>🗑 {label}을 휴지통으로 옮겼습니다 · 맹비서가 디스코드로 알립니다</span>
      <button disabled={busy} onClick={async () => {
        setBusy(true);
        await api.trashRestore(undo.items.map(i => i.id));
        setBusy(false);
        undo.clear();
        trashChanged();
        onRestored?.();
      }}>되돌리기</button>
    </div>
  );
}

/* ── 휴지통 상자 ─────────────────────────────────────────────────── */
export default function TrashBox() {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    const r = await api.trashList();
    if (r && Array.isArray(r.items)) {
      setItems(r.items);
      // 사라진 것은 고른 것에서도 뺀다(맹비서가 영구 삭제했을 수 있다).
      setSel(prev => new Set([...prev].filter(id => r.items.some(i => i.id === id))));
    }
  }, []);

  useEffect(() => {
    void load();
    const on = () => { void load(); };
    window.addEventListener(TRASH_EVENT, on);
    // 맹비서가 디스코드에서 되살리거나 영구 삭제해도 여기가 따라온다.
    const t = window.setInterval(on, 30_000);
    return () => { window.removeEventListener(TRASH_EVENT, on); window.clearInterval(t); };
  }, [load]);

  const allOn = items.length > 0 && sel.size === items.length;

  async function restore() {
    const ids = [...sel];
    if (!ids.length) return;
    setBusy(true); setMsg('');
    const r = await api.trashRestore(ids);
    setBusy(false);
    if (!r) { setMsg('백엔드에 연결하지 못했습니다'); return; }
    const back = r.restored?.length ?? 0;
    const proj = (r.restored ?? []).some(i => i.kind === 'project');
    setMsg([
      back ? `${back}건을 되살렸습니다.` : '',
      proj ? '돌던 프로젝트는 일시정지로 돌아옵니다.' : '',
      ...(r.failed ?? []),
    ].filter(Boolean).join(' '));
    setSel(new Set());
    trashChanged();
    void load();
  }

  return (
    <section className={`tr-box ${open ? 'open' : ''}`} aria-label="휴지통">
      <button className="tr-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <span className="tr-title">🗑 휴지통</span>
        <span className="tr-count">{items.length ? `${items.length}건` : '비어 있음'}</span>
        <span className="tr-hint">영구 삭제는 맹비서 <code>/휴지통</code></span>
        <span className={`pj-caret ${open ? 'open' : ''}`} aria-hidden="true">▾</span>
      </button>

      {open && (
        <div className="tr-body">
          <p className="tr-note">
            여기서 지운 것은 <strong>되살릴 수 있습니다.</strong> 영구 삭제는 맹비서에게
            {' '}<code>/휴지통</code> 으로 요청하시고, 디스코드 DM 으로 오는
            <strong> 6자리 확인 코드</strong>를 불러 주셔야 됩니다 — 접속 키가 새도
            이 화면으로는 지울 수 없게 하려는 것입니다.
          </p>

          {items.length > 0 && (
            <div className="tr-tools">
              <button className="pj-btn" onClick={() => setSel(allOn
                ? new Set() : new Set(items.map(i => i.id)))}>
                {allOn ? '선택 해제' : `전체 선택 (${items.length})`}
              </button>
              <button className="pj-btn pj-btn-primary" disabled={busy || !sel.size}
                      onClick={() => void restore()}>
                ↩ 되살리기{sel.size ? ` (${sel.size})` : ''}
              </button>
            </div>
          )}
          {msg && <div className="tr-msg" onClick={() => setMsg('')}>{msg}</div>}

          {!items.length ? (
            <div className="pj-empty">휴지통이 비어 있습니다.</div>
          ) : (
            <ul className="tr-list">
              {items.map(i => {
                const ln = i.linked;
                const extra = i.kind === 'project'
                  ? [ln.approvals ? `결재 ${ln.approvals}` : '', ln.lessons ? `교훈 ${ln.lessons}` : '']
                      .filter(Boolean).join(' · ')
                  : '';
                return (
                  <li key={i.id} className={`tr-row ${sel.has(i.id) ? 'picked' : ''}`}>
                    <label className="pj-pick">
                      <input type="checkbox" checked={sel.has(i.id)}
                             onChange={() => setSel(prev => {
                               const n = new Set(prev);
                               if (n.has(i.id)) n.delete(i.id); else n.add(i.id);
                               return n;
                             })}
                             aria-label={`${i.title} 고르기`} />
                      <span aria-hidden="true" />
                    </label>
                    <span className={`tr-kind k-${i.kind}`}>{i.kind_ko}</span>
                    <span className="tr-name" title={i.title}>{i.title}</span>
                    {extra && <span className="tr-extra">{extra}</span>}
                    <span className="tr-when" title={`지운 곳: ${i.origin}`}>
                      {when(i.deleted_at)} · {i.origin}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
