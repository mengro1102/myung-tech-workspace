/**
 * 심사 이력 — 어디서 뭘 만들었고, 누가 평가했고, 왜 그 점수인지.
 *
 * 진행 기록은 42 단계짜리 평면 목록이었다. 프롬프트와 평가 의견이 다 들어
 * 있지만, 그걸 읽어서 "어느 산출물이 막혔고 왜 막혔는지" 를 사람이 직접
 * 재구성해야 했다. 중간 개입형이라면 그 재구성을 화면이 해 줘야 한다.
 *
 * 단계에는 산출물 id 가 없다. 대신 순서가 규칙을 따른다 — 초안·1차·2차가
 * 한 산출물에 대해 반복되다가, 2차를 통과하면 다음 산출물로 넘어간다.
 * 그 규칙으로 되짚어 귀속시킨다.
 */
import { useMemo, useState } from 'react';
import { deptLabels, type ProjectRow, type ProjectStep } from '../api';

interface Bucket {
  id: string;
  title: string;
  dept: string;
  drafts: ProjectStep[];
  reviews: ProjectStep[];
  truncated: number;
  passed: boolean;
}

/** 점수 추이가 말해 주는 것. 다음에 무엇을 할지가 여기서 갈린다. */
function trend(scores: number[]): { label: string; cls: string; why: string } {
  const real = scores.filter(s => s >= 0);
  if (real.length === 0) return { label: '평가 전', cls: 'off', why: '아직 검토를 받지 않았습니다.' };
  if (real.length === 1) return { label: '1회', cls: 'off', why: '한 번만 평가받았습니다.' };
  const best = Math.max(...real);
  const last = real[real.length - 1];
  const firstHalf = real.slice(0, Math.ceil(real.length / 2));
  const lastHalf = real.slice(Math.ceil(real.length / 2));
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  const gain = avg(lastHalf) - avg(firstHalf);

  if (last >= 80) return { label: '통과선', cls: 'ok', why: '기준을 넘었습니다.' };
  if (gain > 8) return {
    label: '오르는 중', cls: 'up',
    why: `평균이 ${gain.toFixed(0)}점 올랐습니다. 더 돌리면 통과할 여지가 있습니다.`,
  };
  if (gain < -8) return {
    label: '내려감', cls: 'down',
    why: `평균이 ${Math.abs(gain).toFixed(0)}점 내려갔습니다. 요구가 서로 부딪히고 있을 수 있습니다.`,
  };
  return {
    label: '정체', cls: 'flat',
    why: `${real.length}회를 돌았는데 최고 ${best}점에서 더 오르지 않습니다. `
       + '같은 지적이 반복된다면 요구를 좁히거나 근거를 더 주어야 합니다.',
  };
}

export default function ReviewHistory({ p }: { p: ProjectRow }) {
  const [open, setOpen] = useState<string | null>(null);

  const buckets = useMemo<Bucket[]>(() => {
    const ds = p.plan?.deliverables ?? [];
    if (!ds.length) return [];
    const out: Bucket[] = ds.map(d => ({
      id: d.id, title: d.title, dept: d.dept,
      drafts: [], reviews: [], truncated: 0, passed: false,
    }));
    let i = 0;                       // 지금 어느 산출물을 만들고 있나
    for (const s of p.steps ?? []) {
      if (s.phase === 'plan') continue;
      const b = out[Math.min(i, out.length - 1)];
      if (!b) break;
      if (s.phase === 'draft') {
        b.drafts.push(s);
        // 잘림은 품질 문제가 아니라 분량 문제다. 따로 센다 — 예산을 이쪽이
        // 다 먹고 있는데 점수 얘기만 보면 원인을 놓친다.
        if ((s.note ?? '').includes('잘림')) b.truncated += 1;
      } else {
        b.reviews.push(s);
        if (s.phase === 'review2' && s.ok) { b.passed = true; i += 1; }
      }
    }
    return out;
  }, [p]);

  if (!buckets.length) return null;

  const steps = p.steps ?? [];
  const totalTrunc = buckets.reduce((n, b) => n + b.truncated, 0);
  const passedCount = buckets.filter(b => b.passed).length;

  return (
    <div className="pj-block">
      <h3 className="pj-h3">
        심사 이력
        <span className="rh-sum">
          {steps.length}단계 · 통과 {passedCount}/{buckets.length}{" "}
          {totalTrunc > 0 && (
            <span className="rh-waste">
              · 출력 잘림 {totalTrunc}회
              ({Math.round(totalTrunc / steps.length * 100)}%)
            </span>
          )}
        </span>
      </h3>

      {/* 잘림이 많으면 점수 이야기보다 이게 먼저다. 모델이 분량을 못 맞춰
          같은 초안을 다시 쓰는 것이고, 그만큼 예산이 사라진다. */}
      {totalTrunc >= 3 && (
        <div className="rh-alert">
          초안이 <b>{totalTrunc}회</b> 분량 초과로 잘려 다시 쓰였습니다. 품질과
          무관하게 예산을 먹는 반복이라, 요구 분량을 줄이거나 산출물을 쪼개면
          같은 예산으로 더 나아갑니다.
        </div>
      )}

      <div className="rh-list">
        {buckets.map(b => {
          const scores = b.reviews.map(r => r.score);
          const t = trend(scores);
          const lastReject = [...b.reviews].reverse().find(r => !r.ok);
          const state = b.passed ? { label: '통과', cls: 'ok' }
            : b.reviews.length ? { label: '반려', cls: 'no' }
            : b.drafts.length ? { label: '작성 중', cls: 'now' }
            : { label: '미착수', cls: 'off' };
          const isOpen = open === b.id;

          return (
            <div key={b.id} className={`rh-card ${state.cls}`}>
              <button className="rh-head" onClick={() => setOpen(isOpen ? null : b.id)}>
                <span className={`rh-state ${state.cls}`}>{state.label}</span>
                <span className="rh-title">{b.title}</span>
                <span className="rh-dept">{deptLabels[b.dept] ?? b.dept}</span>
                <span className="rh-chev">{isOpen ? '▾' : '▸'}</span>
              </button>

              <div className="rh-meta">
                초안 {b.drafts.length}회
                {b.truncated > 0 && <span className="rh-waste"> (잘림 {b.truncated})</span>}
                {' · '}검토 {b.reviews.length}회
                {scores.filter(s => s >= 0).length > 0 &&
                  <> · 최고 {Math.max(...scores.filter(s => s >= 0))}점</>}
                <span className={`rh-trend ${t.cls}`}>{t.label}</span>
              </div>

              {/* 점수 띠 — 오르는지 진동하는지 한눈에. 1차와 2차를 구분한다,
                  2차는 오케스트레이터라 기준이 다르다. */}
              {b.reviews.length > 0 && (
                <div className="rh-bar">
                  {b.reviews.map((r, i) => (
                    <span key={i}
                      className={`rh-dot ${r.ok ? 'ok' : 'no'} ${r.phase === 'review2' ? 'second' : ''}`}
                      title={`${r.phase === 'review2' ? '2차 오케스트레이션' : `1차 ${deptLabels[r.dept] ?? r.dept}`} — ${r.score}점`}>
                      {r.score >= 0 ? r.score : '—'}
                    </span>
                  ))}
                </div>
              )}

              <div className="rh-why">{t.why}</div>

              {isOpen && (
                <div className="rh-detail">
                  {lastReject && (
                    <>
                      <div className="rh-detail-h">
                        마지막 반려 —{' '}
                        {lastReject.phase === 'review2'
                          ? '2차 오케스트레이션' : `1차 ${deptLabels[lastReject.dept] ?? lastReject.dept}`}
                        {' '}{lastReject.score}점
                      </div>
                      <pre className="rh-note">{lastReject.note}</pre>
                    </>
                  )}
                  <div className="rh-detail-h">검토 전체</div>
                  <ol className="rh-reviews">
                    {b.reviews.map((r, i) => (
                      <li key={i} className={r.ok ? 'ok' : 'no'}>
                        <span className="rh-rv-who">
                          {r.phase === 'review2' ? '2차' : '1차'}
                        </span>
                        <span className="rh-rv-score">{r.score >= 0 ? `${r.score}점` : '—'}</span>
                        <span className="rh-rv-note">{r.note}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
