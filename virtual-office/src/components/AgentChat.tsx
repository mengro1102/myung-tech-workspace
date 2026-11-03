/* 에이전트 사이에 오간 말.
 *
 * 사무실 캔버스의 말풍선은 두 줄에서 잘리고 몇 초 뒤 사라진다. 누가 누구에게
 * 무엇을 말했는지 끝까지 읽으려면 여기가 필요하다. 한 줄은 요약이고, 누르면
 * 검토 의견·인계 메모 전문이 펼쳐진다.
 *
 * 여기 나오는 말은 모두 실제 작업 단계에서 나온 것이다 — 잡담을 지어 넣지
 * 않는다. 검토 의견은 리뷰어 모델이 쓴 전문이고, 한마디·인계는 작성자가
 * 초안 끝에 직접 쓴 두 줄이다.
 */
import { useState } from 'react';
import { deptColors, type DialogueEntry } from '../api';

const KIND: Record<string, { label: string; cls: string }> = {
  plan:     { label: '착수 회의', cls: 'lead' },
  research: { label: '자료 조회', cls: 'info' },
  approve:  { label: '착수 승인', cls: 'lead' },
  submit:   { label: '제출',     cls: 'info' },
  retry:    { label: '다시 씀',   cls: 'muted' },
  pass:     { label: '통과',     cls: 'ok' },
  reject:   { label: '반려',     cls: 'no' },
  handoff:  { label: '인계',     cls: 'hand' },
  continue: { label: '이어서',   cls: 'muted' },
  brief:    { label: '브리핑',   cls: 'lead' },
  say:      { label: '',        cls: 'muted' },
};

/** YYYY-MM-DD HH:mm (24시간). toLocaleString 은 로캘에 따라 '오전 1:05' 처럼
 *  나와 정렬도 안 되고 폭도 들쭉날쭉하다. 직접 만든다. */
function stamp(at: number): string {
  if (!at) return '';
  const d = new Date(at * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} `
       + `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export default function AgentChat({ entries, showProject = false, emptyText, max = 40 }: {
  entries: DialogueEntry[];
  /** 여러 프로젝트가 섞여 있을 때 어느 프로젝트의 말인지 보인다 */
  showProject?: boolean;
  emptyText?: string;
  /** 한 번에 그리는 최대 줄 수. 넘치면 최근 것만 그리고 버튼을 둔다. */
  max?: number;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [all, setAll] = useState(false);

  if (entries.length === 0) {
    return <div className="ac-empty">{emptyText ?? '아직 오간 말이 없습니다.'}</div>;
  }

  /* 오래된 것이 위, 최근 것이 아래다(목록을 받는 쪽이 아래로 스크롤한다).
   * 그래서 자를 때는 **꼬리**를 남긴다 — 활동 피드와 반대다.
   *
   * key 에 쓰는 i 는 **자르기 전 전체 배열에서의 자리**다. 잘린 배열의 인덱스로
   * 만들면 새 말이 한 줄 들어올 때마다 start 가 1 밀려 모든 key 가 바뀐다.
   * 그러면 React 가 전부 다시 그리고, 펼쳐 둔 '전문 보기'(open 이 key 로 기억한다)가
   * 접힌다. 절대 위치는 새 말이 들어와도 그대로다. */
  const start = all ? 0 : Math.max(0, entries.length - max);
  const hidden = start;

  let lastProject = '';
  return (
    <div className="ac-list">
      {hidden > 0 && (
        <button className="ac-more-btn" onClick={() => setAll(true)}>
          이전 {hidden}건 보기
        </button>
      )}
      {entries.slice(start).map((e, j) => {
        const i = start + j;
        const key = `${e.at}-${e.from}-${i}`;
        const k = KIND[e.kind] ?? KIND.say;
        const color = deptColors[e.from_dept] ?? '#94a3b8';
        const self = e.from === e.to;
        const expandable = !!e.detail && e.detail.trim() !== e.text.trim();
        const isOpen = !!open[key];
        // j===0 은 잘린 뒤의 첫 줄이다. 앞이 잘려 lastProject 를 모르므로
        // 어느 프로젝트 말인지 반드시 보여 준다.
        const projHeader = showProject && !!e.project_id
          && (j === 0 || e.project_id !== lastProject);
        if (showProject && e.project_id) lastProject = e.project_id;
        return (
          <div key={key}>
            {projHeader && (
              <div className="ac-project">📁 {e.project_title || e.project_id}</div>
            )}
            <div className={`ac-row ${k.cls}`}>
              <div className="ac-avatar" style={{ background: color }} aria-hidden="true">
                {e.from.slice(0, 1)}
              </div>
              <div className="ac-body">
                <div className="ac-head">
                  <span className="ac-from" style={{ color }}>{e.from}</span>
                  {!self && <>
                    <span className="ac-arrow" aria-label="에게">→</span>
                    <span className="ac-to">{e.to}</span>
                  </>}
                  {k.label && (
                    <span className={`ac-chip ${k.cls}`}>
                      {k.label}{e.score != null ? ` ${e.score}점` : ''}
                    </span>
                  )}
                  <span className="ac-time">{stamp(e.at)}</span>
                </div>
                {expandable ? (
                  <button className={`ac-bubble ${isOpen ? 'open' : ''}`}
                          aria-expanded={isOpen}
                          onClick={() => setOpen(o => ({ ...o, [key]: !o[key] }))}>
                    {isOpen ? e.detail : e.text}
                    <span className="ac-more">{isOpen ? '접기' : '전문 보기'}</span>
                  </button>
                ) : (
                  <div className="ac-bubble static">{e.text}</div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
