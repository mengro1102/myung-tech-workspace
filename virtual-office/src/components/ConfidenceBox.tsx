/**
 * 확신과 공백 — 무엇을 확인했고, 무엇을 믿었고, 무엇을 못 했나.
 *
 * 점수만 있었다. 100점이 떠 있으면 다 된 것처럼 보이는데, 그 100점은
 * "근거와 맞춰 봤다" 가 아니라 "그럴듯하다" 일 수도 있다. 실제로 첫 실전
 * 테스트에서 영상 데이터가 프롬프트에 없는 채로 연구부가 색상 코드와 효과
 * 수치까지 적었고, 리뷰어도 그 영상을 못 봤으니 100점을 줬다. 검토 두
 * 단계가 지어낸 내용을 통과시킨 것이다.
 *
 * 업계는 이걸 **확신 있는 틀린 결과(Confident Wrong Result)** 라고 부르고,
 * 처방은 결과 요약을 셋으로 쪼개는 것이다 — 검증됨 / 가정함 / 못 함.
 *
 * ## 모델에게 묻지 않는다
 *
 * "너는 이걸 확인했니?" 를 모델에게 물으면 모델은 확인했다고 한다. 그 답은
 * 100점과 같은 성질의 것이라 아무것도 보태지 않는다.
 *
 * 그래서 **이미 저장된 사실만으로 계산한다.**
 *
 *   · `source_names`  — 조회한 자료가 실제로 있었는가
 *   · 반려 사유 원문  — 검토자가 근거 부족을 몇 번 지적했는가
 *   · `narrowed.dropped` — 끝내 못 채워 덜어낸 요구
 *   · `cursor` vs 산출물 수 — 손도 못 댄 것이 남았는가
 *
 * 전부 러너가 남긴 기록이다. 그래서 이 패널은 추측하지 않고, 근거를 같이
 * 적어 사장님이 판정을 다시 확인할 수 있게 한다.
 */
import { useMemo } from 'react';
import type { ProjectRow, ProjectStep } from '../api';

/** 검토자가 근거 부족을 지적한 것인지. **반려된** 검토의 사유로 본다. */
const GROUNDING_RE = /근거|출처|실측|지어|추정|확인할 수 없|자료에 없/;

/* 통과한 검토에는 같은 자를 쓸 수 없다.
 *
 * 통과 사유에는 칭찬으로 같은 단어가 나온다 — "근거 자료에 없는 내용을
 * 임의로 지어내지 않았습니다", "모든 수치가 정확히 근거 자료에 기반하고
 * 있으며". GROUNDING_RE 로 재면 이 셋이 전부 "근거 문제" 로 잡힌다.
 *
 * 진짜 신호는 **단서를 달았는가** 다. 실제 사례: "단, 가제의 '3년'이라는
 * 수치는 근거 자료의 혁펜하임 영상 제목('5년')과 불일치하므로" — 90점으로
 * 통과시키면서 적은 말이다. 반려로 세면 0건, 점수로 보면 통과인데,
 * 사실 관계가 어긋난 것을 검토자 스스로 알고 있었다.
 *
 * 그래서 둘을 함께 요구한다 — 단서 표현 + 근거 관련 단어. */
const CAVEAT_RE = /불일치|단,|다만|그러나|하지만|아쉬|미흡|부정확|권장|주의|확인 필요|어긋/;

interface Line { text: string; note?: string }

function build(p: ProjectRow, steps: ProjectStep[]) {
  const names = p.source_names ?? [];
  const ds = p.plan?.deliverables ?? [];
  const narrowed = p.narrowed ?? {};
  const cursor = p.cursor ?? 0;

  const verified: Line[] = [];
  const assumed: Line[] = [];
  const missing: Line[] = [];

  // ── 검증됨 ── 조회된 자료가 있었던 것만. 자료가 없으면 검증은 불가능하다.
  if (names.length > 0) {
    verified.push({
      text: `근거 자료 ${names.length}종을 실제로 조회했습니다`,
      note: names.join(' · '),
    });
  }

  const reviews = steps.filter(s => (s.phase ?? '').startsWith('review'));
  const passed = reviews.filter(s => s.ok);
  const grounding = reviews.filter(s => !s.ok && GROUNDING_RE.test(s.note ?? ''));

  if (passed.length > 0 && names.length > 0) {
    verified.push({
      text: `검토 ${passed.length}건이 근거 자료를 옆에 두고 통과시켰습니다`,
      note: '부서 1차 · 오케스트레이터 2차 두 단계를 모두 통과한 것만 셉니다.',
    });
  }
  if (grounding.length > 0) {
    verified.push({
      text: `근거 없는 서술을 ${grounding.length}번 반려해 걷어냈습니다`,
      note: '검토자가 "자료에 없는 수치" 로 되돌려 보낸 횟수입니다. '
        + '많을수록 걸러진 양이 많다는 뜻입니다.',
    });
  }

  // ── 가정함 ──
  //
  // 가장 날카로운 신호를 먼저 본다: **통과시키면서 근거 문제를 적은 검토**.
  // 이 프로젝트에서 실제로 나왔다 — 2차 검토가 "가제의 '3년' 이라는 수치는
  // 근거 자료의 혁펜하임 영상 제목('5년')과 불일치" 라고 적고도 90점으로
  // 통과시켰다. 점수만 보면 통과이고, 반려 횟수로 세면 0건이다. 업계가
  // "확신 있는 틀린 결과" 라고 부르는 것의 표본이라 따로 세운다.
  const flaggedPass = passed.filter(s => {
    const n = s.note ?? '';
    return CAVEAT_RE.test(n) && GROUNDING_RE.test(n);
  });
  for (const s of flaggedPass) {
    assumed.push({
      text: '통과시키면서 근거 문제를 함께 적은 검토가 있습니다'
        + (s.score != null ? ` (${s.score}점)` : ''),
      note: (s.note ?? '').slice(0, 220),
    });
  }

  if (names.length === 0) {
    assumed.push({
      text: '조회된 외부 자료가 없습니다 — 이 산출물의 사실 관계는 확인되지 않았습니다',
      note: '검토자도 같은 자료 없이 읽었으므로, 점수는 "그럴듯함" 에 대한 '
        + '평가입니다. 수치와 고유명사는 그대로 쓰지 마세요.',
    });
  } else if (passed.length > 0 && grounding.length === 0 && flaggedPass.length === 0) {
    assumed.push({
      text: '근거 부족으로 반려된 적이 없습니다 — 걸러진 것이 없다는 뜻일 수도 있습니다',
      note: '자료가 있었고 한 번도 지적이 없었다면, 검토자가 대조를 '
        + '느슨하게 했을 가능성이 남습니다. 수치는 한 번 짚어 보시는 편이 좋습니다.',
    });
  }

  // ── 못 함 ── 덜어낸 요구와 손대지 않은 산출물.
  for (const [did, nw] of Object.entries(narrowed)) {
    const title = ds.find(d => d.id === did)?.title ?? did;
    for (const x of nw.dropped ?? []) {
      missing.push({ text: x, note: `${title} — ${nw.why || '근거가 없어 범위에서 뺐습니다'}` });
    }
  }
  // cursor 는 "몇 번째 산출물을 작업 중인가" 다. 그보다 뒤는 아직 통과하지
  // 못한 것이고, 그중 첫 번째가 지금 붙들려 있는 것이다. 완료된 프로젝트는
  // cursor 가 끝까지 가 있으므로 이 줄이 비게 된다.
  if (p.status !== 'done') {
    ds.slice(cursor).forEach((d, i) => {
      missing.push({
        text: d.title,
        note: i === 0 ? '지금 작업 중 — 아직 검토를 통과하지 못했습니다'
          : '아직 착수하지 않았습니다',
      });
    });
  }

  return { verified, assumed, missing };
}

interface Props { p: ProjectRow; steps: ProjectStep[] }

export default function ConfidenceBox({ p, steps }: Props) {
  const { verified, assumed, missing } = useMemo(() => build(p, steps), [p, steps]);
  const total = verified.length + assumed.length + missing.length;
  if (total === 0) return null;

  const cols: { key: string; title: string; hint: string; rows: Line[] }[] = [
    { key: 'ok', title: '검증됨', hint: '자료와 맞춰 본 것', rows: verified },
    { key: 'assume', title: '가정함', hint: '맞춰 볼 자료가 없던 것', rows: assumed },
    { key: 'gap', title: '못 함', hint: '끝내 채우지 못한 것', rows: missing },
  ];

  return (
    <div className="pj-block conf">
      <h3 className="pj-h3">
        확신과 공백
        <span className="conf-sub">점수가 가리는 것을 나눠 적습니다</span>
      </h3>
      <div className="conf-grid">
        {cols.map(c => (
          <div key={c.key} className={`conf-col ${c.key}`}>
            <div className="conf-col-head">
              <b>{c.title}</b>
              <span className="conf-n">{c.rows.length}</span>
              <span className="conf-hint">{c.hint}</span>
            </div>
            {c.rows.length === 0 ? (
              <p className="conf-none">없음</p>
            ) : (
              <ul className="conf-list">
                {c.rows.map((r, i) => (
                  <li key={i}>
                    {r.text}
                    {r.note && <span className="conf-note">{r.note}</span>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
      <p className="conf-basis">
        이 표는 모델에게 묻지 않고, 러너가 남긴 기록(조회한 자료 목록 · 반려
        사유 원문 · 덜어낸 요구)만으로 계산합니다. 모델에게 "확인했니" 를
        물으면 점수와 같은 성질의 답이 돌아올 뿐입니다.
      </p>
    </div>
  );
}
