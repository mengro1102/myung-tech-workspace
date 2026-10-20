/**
 * 고칠 수 있는 계획 — 착수 전에 사장님이 직접 손본다.
 *
 * 지금까지 할 수 있는 것은 전체 승인 아니면 전체 거절뿐이었다.
 *
 * VLA 사태가 정확히 여기서 시작됐다. 계획에 "OS 커널 스케줄링 지연 실측치"
 * 가 완료 조건으로 들어갔는데 그런 자료는 애초에 없었다. 52단계·검토 20회·
 * 반려 17회를 겪고 멈출 때까지 **아무도 그 한 줄을 지울 수 없었다.**
 *
 * 교훈 축적(lessons.py)은 다음번을 돕는다. 이 화면은 이번을 돕는다.
 *
 * ## 왜 추가는 못 하게 하나
 *
 * 산출물을 지우고 고치는 것은 범위를 좁히는 쪽이라, 러너가 잡은 의도와
 * 어긋나지 않는다. 그런데 새로 추가하면 그건 계획 수립이지 수정이 아니다 —
 * 부서 배정도 근거 자료 조회도 그 산출물을 염두에 두고 이뤄지지 않았으므로,
 * 추가된 것만 맨손으로 실행된다. 범위를 넓히는 쪽은 새 프로젝트로 받는
 * 편이 정직하다. 그래서 "지우기" 는 있고 "추가" 는 없다.
 */
import { useEffect, useState } from 'react';
import { api, deptLabels, type Deliverable, type ProjectRow } from '../api';

const DEPTS = ['research_dept', 'dev_dept', 'content_dept',
  'finance_dept', 'orchestration_dept'];

interface Props {
  p: ProjectRow;
  /** 저장이 끝나면 목록을 다시 읽게 한다. */
  onSaved: () => void;
}

export default function PlanEditor({ p, onSaved }: Props) {
  const [open, setOpen] = useState(false);
  const [ds, setDs] = useState<Deliverable[]>([]);
  const [dw, setDw] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  // 계획의 **내용**으로 비교한다. 객체 동일성으로 보면 안 된다.
  //
  // 처음엔 `[open, p.plan]` 이었다. 그런데 목록은 주기적으로 다시 읽히고,
  // 그때마다 JSON 에서 새 객체가 만들어진다 — 내용이 똑같아도 동일성은
  // 달라진다. 그래서 **편집하는 도중에 효과가 다시 돌아 입력이 되돌려졌다.**
  // 산출물을 빼고 저장을 눌렀는데 아무 요청도 나가지 않았다(dirty 가 false 로
  // 돌아가 있었다). 고치지 않으면 이 화면은 쓸 수가 없다.
  const planKey = JSON.stringify([p.plan?.deliverables ?? [], p.plan?.done_when ?? []]);
  useEffect(() => {
    if (!open) return;
    const plan = JSON.parse(planKey) as [Deliverable[], string[]];
    setDs(plan[0].map(d => ({ ...d })));
    setDw([...plan[1]]);
    // 여기서 메시지를 지우지 않는다.
    //
    // 저장이 성공하면 계획이 바뀌고 → planKey 가 바뀌고 → 이 효과가 돌아
    // 방금 세운 "계획을 고쳤습니다" 를 지워 버렸다. 저장했는데 화면에
    // 아무 변화가 없는 것처럼 보이고, 사장님이 받을 확인은 그 한 줄뿐이다.
    //
    // 묵은 메시지를 치우는 일은 여는 순간에만 하면 된다(아래 효과).
  }, [open, planKey]);

  // 열 때만 메시지를 비운다. 지난번에 띄운 오류가 남아 있으면 안 되지만,
  // 그건 여닫을 때의 문제이지 계획이 바뀔 때의 문제가 아니다.
  useEffect(() => { if (open) setMsg(''); }, [open]);

  const orig = p.plan?.deliverables ?? [];
  const removed = orig.filter(o => !ds.some(d => d.id === o.id));
  const dirty = removed.length > 0
    || ds.some(d => {
      const o = orig.find(x => x.id === d.id);
      return !o || o.title !== d.title || o.desc !== d.desc || o.dept !== d.dept;
    })
    || JSON.stringify(dw) !== JSON.stringify(p.plan?.done_when ?? []);

  function setD(id: string, patch: Partial<Deliverable>) {
    setDs(prev => prev.map(d => (d.id === id ? { ...d, ...patch } : d)));
  }

  async function save() {
    if (ds.length === 0) { setMsg('산출물이 하나도 남지 않았습니다.'); return; }
    setBusy(true);
    setMsg('');
    const r = await api.revisePlan(p.id, {
      deliverables: ds,
      done_when: dw.filter(c => c.trim()),
    });
    setBusy(false);
    if (!r?.ok) { setMsg(r?.error ?? '저장하지 못했습니다.'); return; }
    // onSaved() 가 목록을 다시 읽으면 planKey 가 바뀌어 위 효과가 돌고
    // setMsg('') 로 이 메시지를 지운다. 그래서 순서를 바꾼다 — 먼저 읽게
    // 하고, 메시지는 그다음에 세운다.
    setMsg('계획을 고쳤습니다. 이제 착수 승인을 누르시면 이 내용으로 시작합니다.');
    onSaved();
  }

  if (!open) {
    return (
      <div className="pj-plan-edit closed">
        <button className="pj-btn" onClick={() => setOpen(true)}>
          ✏️ 계획 고치기
        </button>
        <span className="pj-plan-why">
          없는 자료를 요구하는 완료 조건은 여기서 지우는 편이 쌉니다 — 승인하고
          나면 진전이 멈출 때까지 사람을 부르지 않습니다.
        </span>
      </div>
    );
  }

  return (
    <div className="pj-plan-edit">
      <div className="pj-plan-head">
        <b>계획 고치기</b>
        <span className="pj-plan-note">
          제목·설명·부서를 고치거나 산출물을 지울 수 있습니다. 추가는 새
          프로젝트로 받습니다 — 추가된 것만 근거 자료 없이 실행되기 때문입니다.
        </span>
      </div>

      <ol className="pj-plan-list">
        {ds.map((d, i) => (
          <li key={d.id} className="pj-plan-item">
            <div className="pj-plan-row">
              <span className="pj-plan-n">{i + 1}</span>
              <input className="pj-plan-input" value={d.title} maxLength={80}
                aria-label={`산출물 ${i + 1} 제목`}
                onChange={e => setD(d.id, { title: e.target.value })} />
              <select className="pj-plan-sel" value={d.dept}
                aria-label={`산출물 ${i + 1} 담당 부서`}
                onChange={e => setD(d.id, { dept: e.target.value })}>
                {DEPTS.map(x => (
                  <option key={x} value={x}>{deptLabels[x] ?? x}</option>
                ))}
              </select>
              <button className="pj-plan-del" title="이 산출물을 뺍니다"
                onClick={() => setDs(prev => prev.filter(x => x.id !== d.id))}>
                빼기
              </button>
            </div>
            <textarea className="pj-plan-area" value={d.desc} rows={3} maxLength={600}
              aria-label={`산출물 ${i + 1} 설명`}
              placeholder="무엇을 어디까지 적어야 하는지"
              onChange={e => setD(d.id, { desc: e.target.value })} />
          </li>
        ))}
      </ol>

      {removed.length > 0 && (
        <p className="pj-plan-removed">
          뺄 산출물 {removed.length}개 — {removed.map(d => d.title).join(' · ')}
        </p>
      )}

      <div className="pj-plan-head">
        <b>완료 조건</b>
        <span className="pj-plan-note">
          자료 없이는 채울 수 없는 조건(실측치·벤치마크 수치·특정 제품 사양)을
          여기 두면 검토가 끝없이 반려합니다. 비우면 그 줄은 사라집니다.
        </span>
      </div>
      <ul className="pj-plan-dw">
        {dw.map((c, i) => (
          <li key={i}>
            <input className="pj-plan-input" value={c} maxLength={200}
              aria-label={`완료 조건 ${i + 1}`}
              onChange={e => setDw(prev => prev.map((x, j) => (j === i ? e.target.value : x)))} />
          </li>
        ))}
      </ul>

      {msg && <p className="pj-plan-msg">{msg}</p>}

      <div className="pj-plan-actions">
        <button className="pj-btn" onClick={() => setOpen(false)} disabled={busy}>
          닫기
        </button>
        <button className="pj-btn pj-btn-primary" onClick={() => void save()}
          disabled={busy || !dirty}>
          {busy ? '저장 중…' : dirty ? '계획 저장' : '고친 것이 없습니다'}
        </button>
      </div>
    </div>
  );
}
