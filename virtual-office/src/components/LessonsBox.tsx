/**
 * 배운 것 — 막힌 프로젝트에서 건진 교훈.
 *
 * 교훈은 `shared_memory/lessons.py` 가 조용히 쌓고 있었다. 프로젝트가 멈출
 * 때마다 반려 사유를 되풀이 단위로 묶어 남기고, 같은 주제를 다시 시키면
 * 계획 프롬프트에 꽂는다. 지금 2건이 쌓여 있고 그 안에 반려 19회분이 들어
 * 있다.
 *
 * **그런데 볼 수 있는 화면이 없었다.**
 *
 * 그건 두 가지로 나쁘다. 하나는 사장님이 "이 시스템이 배우고 있다" 를 확인할
 * 길이 없다는 것 — 작동하는지 알 수 없는 기능은 믿을 근거가 없다. 다른 하나는
 * 교훈이 **다음 계획을 바꾼다**는 것이다. 계획이 왜 그렇게 나왔는지 설명하는
 * 입력이 화면에 없으면, 그게 업계가 말하는 **숨은 자율성**이다.
 *
 * 그래서 CEO 룸에 둔다. 결재함 옆이 맞는 자리다 — 둘 다 "사람이 알아야
 * 움직임을 이해할 수 있는 것" 이다.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type LessonRow } from '../api';

interface Props {
  open: boolean;
  onToggle: () => void;
}

export default function LessonsBox({ open, onToggle }: Props) {
  const [rows, setRows] = useState<LessonRow[]>([]);
  const [stats, setStats] = useState<{ count: number; rejections: number } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await api.listLessons();
    if (r?.items) setRows(r.items);
    if (r?.stats) setStats(r.stats);
  }, []);

  useEffect(() => { void load(); }, [load]);

  return (
    <div className="ceo-lessons">
      <div className="ceo-sec-head">
        <button className="ceo-sec-title as-toggle" onClick={onToggle}
          title={open ? '접기' : '펼치기'}>
          <span className="ceo-sec-chev">{open ? '▾' : '▸'}</span>
          🧠 배운 것
          <span className="ceo-sec-count">
            {rows.length
              ? `${rows.length}건 · 반려 ${stats?.rejections ?? 0}회분`
              : '아직 없음'}
          </span>
        </button>
      </div>

      {open && (rows.length === 0 ? (
        <div className="ceo-appr-empty">
          아직 없습니다. 프로젝트가 진전 없이 멈추면 그때 반려 사유를 묶어
          여기 남기고, <strong>같은 주제를 다시 시킬 때 계획에 넣습니다.</strong>
          완료된 프로젝트는 교훈이 아니라 위키에 산출물로 쌓입니다.
        </div>
      ) : (
        <>
          <p className="ceo-lesson-why">
            막힌 프로젝트에서 건진 것입니다. 비슷한 주제로 새 프로젝트를 시작하면
            이 내용이 <strong>계획 단계 프롬프트에 들어갑니다</strong> — 계획이 왜
            그렇게 나왔는지 설명하는 입력입니다.
          </p>
          <div className="ceo-lesson-list">
            {rows.map(r => {
              const isOpen = expanded === r.id;
              return (
                <div key={r.id} className="ceo-lesson-card">
                  <button className="ceo-lesson-head"
                    aria-expanded={isOpen}
                    onClick={() => setExpanded(isOpen ? null : r.id)}>
                    <span className="ceo-lesson-title">{r.title || '(제목 없음)'}</span>
                    <span className="ceo-lesson-meta">
                      {r.steps}단계 · 반려 {r.rejections}회
                    </span>
                    <span className="ceo-lesson-chev">{isOpen ? '▴' : '▾'}</span>
                  </button>

                  {/* 되풀이된 지적. 접혀 있어도 첫 줄은 보인다 — 무엇 때문에
                      막혔는지가 이 카드의 요점이라 숨기면 카드가 비어 보인다. */}
                  {(r.recurring ?? []).slice(0, isOpen ? 99 : 1).map((t, i) => (
                    <p key={i} className="ceo-lesson-item">· {t}</p>
                  ))}

                  {isOpen && (
                    <>
                      {(r.dropped ?? []).length > 0 && (
                        <div className="ceo-lesson-dropped">
                          <b>끝내 못 채운 요구</b>
                          {(r.dropped ?? []).map((d, i) => <p key={i}>· {d}</p>)}
                        </div>
                      )}
                      {r.reason && (
                        <p className="ceo-lesson-reason">멈춘 이유: {r.reason}</p>
                      )}
                      {r.idea && (
                        <p className="ceo-lesson-idea">원래 요청: {r.idea}</p>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </>
      ))}
    </div>
  );
}
