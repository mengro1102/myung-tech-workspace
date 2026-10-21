/**
 * 표본 검증 — 사람이 "이 논문이 정말 그 말을 하는가" 를 판정한다.
 *
 * 명테크의 검토는 **모델끼리** 한다. 부서 1차도 오케스트레이터 2차도 모델이고,
 * 사람의 눈은 착수 승인과 파일 저장 결재 두 지점에만 있었다. 방법 절이 그걸
 * 그대로 적고 있었다 — "검토는 사람이 하지 않았습니다".
 *
 * ISPOR 가 RAISE 의 근거 기반을 감사하며 쓴 8개 축 중 하나가 **인간 기준**이다
 * (평가 30건 중 23건이 이걸 뒀는데 우리는 0이었다). 이 화면이 그 칸이다.
 *
 * ## 역할을 나눈다
 *
 * 물어야 할 것은 둘인데 성격이 다르다.
 *
 *   1. 그 논문이 실재하는가 — **기계가 한다**(arXiv 조회, 결과는 캐시)
 *   2. 그 논문이 정말 그 말을 하는가 — **사람이 한다**
 *
 * 2번을 모델에게 물으면 맞다고 한다. 그 답은 점수와 같은 성질이라 아무것도
 * 보태지 않는다. 그래서 이 화면은 실제 제목을 나란히 놓고 **2번만** 묻는다.
 *
 * ## 조회 실패를 '없음' 과 섞지 않는다
 *
 * 처음 만들었을 때 표본 5건 중 2건이 "(찾지 못함)" 으로 나왔는데, 사유는
 * arXiv 의 429 와 타임아웃이었다 — **둘 다 실재하는 논문이다.** 조회 실패가
 * "논문 없음" 과 똑같이 보이면 사장님이 멀쩡한 논문을 "지어냈다" 고 표시하게
 * 된다. 사람에게 판단을 맡기는 기능에서 그건 치명적이다 — 사람의 판단이
 * 기계의 실패를 그대로 물려받는다.
 *
 * 그래서 상태가 셋이다: 있음 · arXiv 에 없음 · **조회 못 함**.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type VerifyClaim, type VerifySummary } from '../api';

interface Props {
  pid: string;
  did: string;
  onSaved?: () => void;
}

type Verdict = 'ok' | 'wrong' | 'unsure';

const CHOICE: { key: Verdict; label: string; cls: string; hint: string }[] = [
  { key: 'ok', label: '맞음', cls: 'ok',
    hint: '논문이 실제로 그 말을 합니다' },
  { key: 'wrong', label: '틀림', cls: 'no',
    hint: '논문이 그 말을 하지 않습니다 — 이 부분은 믿지 않습니다' },
  { key: 'unsure', label: '보류', cls: 'hold',
    hint: '판단하지 않습니다 — 조회가 실패했거나 확인할 수 없습니다' },
];

export default function VerifyBox({ pid, did, onSaved }: Props) {
  const [claims, setClaims] = useState<VerifyClaim[] | null>(null);
  const [meta, setMeta] = useState<{ total: number; sampled: number } | null>(null);
  const [sum, setSum] = useState<VerifySummary | null>(null);
  const [picked, setPicked] = useState<Record<string, Verdict>>({});
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(async () => {
    setMsg('arXiv 에서 실제 논문을 받아 오는 중… (처음 한 번은 느립니다)');
    const r = await api.verifyClaims(pid, did);
    setMsg(r?.error ?? '');
    setClaims(r?.claims ?? []);
    setMeta({ total: r?.total_cites ?? 0, sampled: r?.sampled ?? 0 });
    setSum(r?.summary ?? null);
    // 이미 판정한 것은 선택 상태로 되살린다.
    const prev: Record<string, Verdict> = {};
    for (const c of r?.claims ?? []) {
      if (c.verdict) prev[c.id] = c.verdict as Verdict;
    }
    setPicked(prev);
  }, [pid, did]);

  useEffect(() => { void load(); }, [load]);

  async function save() {
    const verdicts: Record<string, { verdict: Verdict }> = {};
    for (const [id, v] of Object.entries(picked)) verdicts[id] = { verdict: v };
    if (Object.keys(verdicts).length === 0) {
      setMsg('판정한 항목이 없습니다.');
      return;
    }
    setBusy(true);
    const r = await api.saveVerdicts(pid, did, verdicts);
    setBusy(false);
    if (r?.error) { setMsg(r.error); return; }
    setSum(r ?? null);
    setMsg('기록했습니다. 방법 절에 함께 적힙니다.');
    onSaved?.();
  }

  if (claims === null) {
    return <div className="pj-verify"><p className="pj-methods-wait">{msg || '불러오는 중…'}</p></div>;
  }

  return (
    <div className="pj-verify">
      <div className="pj-verify-head">
        <b>✋ 표본 검증</b>
        <span className="pj-verify-note">
          기계가 실제 논문을 찾아 두었습니다. 사장님은 <strong>그 논문이 정말
          문서의 말을 하는지</strong>만 봐 주시면 됩니다 — 모델에게 물으면
          맞다고 하므로 이 판단은 사람만 할 수 있습니다.
        </span>
        {meta && meta.total > meta.sampled && (
          <span className="pj-verify-sample">
            인용 {meta.total}건 중 {meta.sampled}건 표본
            {' '}— 의심스러운 것부터 골랐습니다
          </span>
        )}
      </div>

      {claims.length === 0 && (
        <p className="pj-methods-wait">확인할 인용이 없습니다.</p>
      )}

      {claims.map(c => {
        const found = c.paper?.found;
        return (
          <div key={c.id} className="pj-verify-card">
            <div className="pj-verify-top">
              <a href={c.paper?.url || `https://arxiv.org/abs/${c.id}`}>arXiv:{c.id}</a>
              {/* 세 상태를 섞지 않는다 — 조회 실패는 '없음' 이 아니다. */}
              {found === true && <span className="tag ok">실재 확인</span>}
              {found === false && <span className="tag no">arXiv 에 없음</span>}
              {found == null && (
                <span className="tag hold" title={c.paper?.error || ''}>
                  조회 못 함 — 없다는 뜻이 아닙니다
                </span>
              )}
              {!c.in_sources && (
                <span className="tag warn">근거 자료에 없던 인용</span>
              )}
            </div>

            <p className="pj-verify-claim"><b>문서의 주장</b> {c.claim}</p>
            <p className="pj-verify-real">
              <b>실제 논문</b>{' '}
              {found === true
                ? c.paper?.title
                : found === false
                  ? '— arXiv 에서 이 번호를 찾지 못했습니다.'
                  : '— 조회하지 못했습니다. 이 건은 「보류」로 두세요.'}
            </p>
            {found === true && c.paper?.summary && (
              <p className="pj-verify-abs">{c.paper.summary.slice(0, 420)}…</p>
            )}

            <div className="pj-verify-pick">
              {CHOICE.map(ch => (
                <button key={ch.key} title={ch.hint}
                  className={`pj-btn ${picked[c.id] === ch.key ? 'on ' + ch.cls : ''}`}
                  onClick={() => setPicked(v => ({ ...v, [c.id]: ch.key }))}>
                  {ch.label}
                </button>
              ))}
            </div>
          </div>
        );
      })}

      {msg && <p className="pj-verify-msg">{msg}</p>}

      {sum && sum.checked > 0 && (
        <p className="pj-verify-sum">
          기록됨: 맞음 {sum.counts.ok} · 틀림 {sum.counts.wrong} ·
          보류 {sum.counts.unsure}
          {sum.by ? ` · ${sum.by}` : ''}
        </p>
      )}

      <div className="pj-verify-actions">
        <button className="pj-btn" onClick={() => void load()} disabled={busy}>
          다시 불러오기
        </button>
        <button className="pj-btn pj-btn-primary" onClick={() => void save()}
          disabled={busy || Object.keys(picked).length === 0}>
          {busy ? '기록 중…' : '판정 기록'}
        </button>
      </div>
    </div>
  );
}
