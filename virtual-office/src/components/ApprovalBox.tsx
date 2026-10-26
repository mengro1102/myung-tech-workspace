/**
 * 결재함 — CEO 룸에서 결재와 프로젝트 현황을 본다.
 *
 * 그동안 결재함은 ⚙️ 관리 모달의 대시보드 탭 안에 묻혀 있었다. 에이전트와
 * 봇은 "결재함에 올라가 있습니다" 라고 말하는데 그 이름의 화면이 어디에도
 * 없었으니, 승인하려면 설정 모달을 열어 탭을 옮겨야 한다는 걸 알아야 했다.
 *
 * 그리고 CEO 룸은 태스크 큐만 보고 있었다. 프로젝트 탭에서 시킨 일은 태스크가
 * 아니라 프로젝트라서, 프로젝트가 셋 돌아가는 중에도 KPI 는 전부 0 이었다 —
 * 대시보드가 실제와 어긋나 보이던 이유다.
 *
 * 결재는 정의상 사장님만 할 수 있는 일이고, CEO 룸은 사장님이 결정하는
 * 곳이다. 둘을 여기로 모은다.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { AskContext } from './AskHermes';
import AssistantFace from './AssistantFace';
import { api, type ApprovalRow, type ProjectRow } from '../api';

/* 이 결재를 승인해도 되는지 그 자리에서 맹비서에게 묻는다. 열 때까지
   필요 없으므로 lazy 다. */
const AskHermes = lazy(() => import('./AskHermes'));

const KIND: Record<string, { icon: string; label: string }> = {
  file: { icon: '📄', label: '파일 저장' },
  action: { icon: '🚀', label: '외부 실행' },
  project: { icon: '📋', label: '프로젝트 착수' },
};

/** 묶음 머리글. 서버의 tier 를 그대로 받아 쓴다 — 여기서 다시 판정하지
 *  않는다. 규칙이 두 곳에 있으면 화면과 서버가 다른 말을 하게 된다. */
const TIER_HEAD: Record<number, { title: string; note: string; cls: string }> = {
  3: {
    title: '바깥으로 나갑니다',
    note: '실행되면 되돌릴 수 없습니다. 하나씩 읽고 누르세요 — 일괄 승인에 들어가지 않습니다.',
    cls: 'danger',
  },
  2: {
    title: 'workspace 쓰기 · 프로젝트 착수',
    note: '파일은 지우면 되고 프로젝트는 중단할 수 있습니다.',
    cls: 'write',
  },
  1: {
    title: '내부 처리',
    note: '부서에 태스크를 넣습니다. 언제든 지울 수 있습니다.',
    cls: 'muted',
  },
};

const DEPT: Record<string, string> = {
  orchestration_dept: '오케스트레이션', research_dept: '리서치',
  finance_dept: '재무', dev_dept: '개발', content_dept: '콘텐츠',
};

const PSTATUS: Record<string, { label: string; cls: string }> = {
  intake: { label: '계획 수립', cls: 'now' },
  running: { label: '진행 중', cls: 'now' },
  paused: { label: '멈춤', cls: 'warn' },
  done: { label: '완료', cls: 'ok' },
  cancelled: { label: '취소', cls: 'off' },
};

interface Props {
  /** 접힘/펼침. 기본은 펼쳐진 상태 — 결재는 막힌 일이라 먼저 보여야 한다. */
  open: boolean;
  onToggle: () => void;
  /** 현황판에서 결재 카드를 눌렀을 때 그 항목으로 데려간다. */
  focusId?: string | null;
  onFocused?: () => void;
  onOpenProjects: () => void;
}

export default function ApprovalBox({ open: boxOpen, onToggle, focusId,
                                      onFocused, onOpenProjects }: Props) {
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');
  const [batching, setBatching] = useState(false);
  /* 상담 중인 결재. 패널을 띄우고 맥락을 만든다. */
  const [askRow, setAskRow] = useState<ApprovalRow | null>(null);

  /** 결재 한 건을 맹비서가 판단할 수 있는 맥락으로 바꾼다.
   *
   *  **이미 화면에 있는 것만** 넘긴다. approvals.json 을 읽게 시키면
   *  다른 건까지 읽고, 무엇을 보고 답했는지 사장님이 확인할 수 없다.
   *
   *  인자는 2,000자에서 끊는다. 파일 저장 결재의 file_content 는 수만 자가
   *  될 수 있고, 그대로 보내면 무료 한도를 한 번에 태운다. */
  const askCtx = (a: ApprovalRow): AskContext => {
    const body = a.file_content
      ?? (a.action_args ? JSON.stringify(a.action_args, null, 2) : '');
    const lines = [
      '[사장님 결재 대기 건]',
      `제목: ${a.label}`,
      `등급: ${a.tier ?? 1} (${a.tier_name ?? '내부'})${a.tier_why ? ` — ${a.tier_why}` : ''}`,
      `종류: ${a.kind ?? '기타'}`,
    ];
    if (a.department) lines.push(`요청 부서: ${DEPT[a.department] ?? a.department}`);
    if (a.file_path) lines.push(`쓰려는 파일: workspace/${a.file_path}`);
    if (a.kind === 'action') {
      lines.push(`바깥으로 나가는 호출: ${a.integration}.${a.action}`);
      lines.push('※ 승인하는 순간 되돌릴 수 없습니다.');
    }
    if (a.detail) lines.push(`설명: ${a.detail}`);
    if (body) {
      lines.push('', '[내용]', body.slice(0, 2000)
        + (body.length > 2000 ? `\n… (전체 ${body.length}자 중 앞부분)` : ''));
    }
    lines.push('',
      '이 건을 승인해도 되는지 판단을 도와주십시오. 위험한 점, 확인해야 할',
      '점, 되돌릴 수 있는지를 짚어 주십시오. 필요하면 지식베이스와 프로젝트',
      '기록을 조회하십시오.',
      '',
      '**당신은 승인하거나 거절할 수 없습니다** — 조언만 하십시오. 결정',
      '버튼은 사장님 손에 있습니다.');
    return {
      kind: 'approval',
      label: a.label,
      brief: lines.join('\n'),
      presets: [
        '이 건을 승인해도 괜찮을지 판단을 도와줘',
        '승인하면 되돌릴 수 있는지, 무엇이 바뀌는지 알려줘',
        '승인 전에 내가 확인해야 할 것을 짚어줘',
      ],
    };
  };

  const load = useCallback(async () => {
    const [a, p] = await Promise.all([
      api.storeList<ApprovalRow>('approvals'),
      api.listProjects(),
    ]);
    if (a?.items) setRows(a.items);
    if (p?.projects) setProjects(p.projects);
  }, []);

  useEffect(() => {
    void load();
    // 결재는 에이전트가 올린다 — 화면을 열어 둔 채로도 새 건이 생긴다.
    const t = setInterval(() => { void load(); }, 15000);
    return () => clearInterval(t);
  }, [load]);

  const pending = rows.filter(r => (r.status ?? 'pending') === 'pending');

  // 최근에 처리된 것 — 누가 결정했는지와 함께.
  //
  // 결재 9건이 승인 주체 기록 없이 승인된 일이 있었다. 추적했으나 밝히지
  // 못했다 — 기록이 없었기 때문이다. 이제 남기고, 남긴 것을 **보여 준다.**
  // 기록만 하고 화면에 없으면 사후에 누가 들여다볼 일이 생기지 않는다.
  const recent = rows
    .filter(r => (r.status ?? 'pending') !== 'pending' && r.decided_at)
    .sort((a, b) => (b.decided_at ?? 0) - (a.decided_at ?? 0))
    .slice(0, 5);

  const WHO: Record<string, string> = {
    ui: '화면에서 하나씩', batch: '화면에서 일괄', cli: '명령줄',
    telegram: '텔레그램', runner: '러너 자동', api: 'API 직접',
  };

  // 등급이 높은 것(되돌릴 수 없는 것)부터. 아래로 내려갈수록 가벼워진다.
  // tier 가 없으면(옛 서버) 1 로 본다 — 화면이 비는 것보다 낫다.
  const groups = [3, 2, 1]
    .map(t => ({ tier: t, rows: pending.filter(r => (r.tier ?? 1) === t) }))
    .filter(g => g.rows.length > 0);
  const batchable = pending.filter(r => r.batchable ?? ((r.tier ?? 1) <= 2));

  async function approveAll() {
    if (batchable.length === 0) return;
    const outward = pending.length - batchable.length;
    if (!window.confirm(
      `${batchable.length}건을 한 번에 승인합니다.\n\n`
      + batchable.slice(0, 8).map(r => `· ${r.label}`).join('\n')
      + (batchable.length > 8 ? `\n· … 외 ${batchable.length - 8}건` : '')
      + (outward
        ? `\n\n바깥으로 나가는 ${outward}건은 제외됩니다 — 하나씩 확인하세요.`
        : '')
      + '\n\n진행할까요?')) return;
    // `confirm` 만으로는 자동화 브라우저를 막지 못한다 — 자동화로 띄운
    // 페이지에서 `confirm` 은 기본으로 true 를 돌려준다. 실제로 결재 9건이
    // 그렇게 넘어갔고, 거기 섞인 프로젝트 착수 결재까지 승인돼 자율 실행이
    // 시작됐다. 사람이 읽고 누르는 것을 전제한 방어가 사람이 없을 때 그냥
    // 통과한 것이다. 그래서 **건수를 직접 적게** 한다 — 숫자를 맞춰 넣는
    // 일은 우연히 일어나지 않는다. 서버도 같은 수를 받아 대조한다.
    const typed = window.prompt(
      `확인을 위해 승인할 건수를 숫자로 입력하세요: ${batchable.length}`);
    if (String(typed ?? '').trim() !== String(batchable.length)) {
      setMsg('건수가 맞지 않아 취소했습니다. 한 건씩 승인하셔도 됩니다.');
      return;
    }
    setBatching(true);
    setMsg('');
    const r = await api.batchApprove(batchable.map(x => x.id));
    setBatching(false);
    if (!r?.ok) {
      setMsg(r?.error ?? '일괄 승인에 실패했습니다. 백엔드가 떠 있는지 보세요.');
      return;
    }
    const skipped = (r.skipped ?? []).length;
    setMsg(`${(r.approved ?? []).length}건 승인했습니다.`
      + (skipped ? ` ${skipped}건은 건너뛰었습니다 — ${r.skipped[0].why}` : ''));
    void load();
  }

  // 현황판에서 넘어온 카드로 스크롤하고 잠깐 강조한다. 눌렀는데 목록 어딘가에
  // 있기만 하면 어느 것인지 알 수 없다.
  useEffect(() => {
    if (!focusId) return;
    const el = cardRefs.current[focusId];
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('flash');
      setTimeout(() => el.classList.remove('flash'), 1600);
    }
    onFocused?.();
  }, [focusId, rows, onFocused]);
  const live = projects.filter(p => p.status === 'running' || p.status === 'intake'
    || p.status === 'paused');

  async function decide(row: ApprovalRow, status: 'approved' | 'rejected') {
    // **거절도 묻는다.** 전에는 승인 중에서도 '실행' 종류만 물었고 거절은
    // 한 번도 묻지 않았다. 거절은 되돌릴 수 있어 보이지만 아니다 — 후속
    // 작업을 만들지 않고, 그 부서는 "허락받지 못했다" 는 전제로 넘어간다.
    // 다시 올리려면 그 일을 처음부터 다시 돌려야 한다.
    //
    // 실제로 점검 중 대기 2건이 의도치 않게 거절됐다. 기록(`decided_by: ui`
    // · `decided_at`)은 남아 있어서 **언제** 였는지는 1초 단위로 특정됐지만,
    // 어느 버튼이었는지까지는 남지 않는다. 한 번 묻는 것이 그 간극을 메운다.
    if (status === 'rejected') {
      if (!confirm(`"${row.label}"\n\n거절하면 이 일은 실행되지 않습니다. `
                   + `다시 올리려면 해당 부서가 처음부터 다시 돌려야 합니다.\n\n거절할까요?`)) {
        return;
      }
    }
    // 되돌릴 수 없는 것은 한 번 묻는다. 파일 저장은 덮어쓸 뿐이라 묻지 않는다.
    if (status === 'approved' && row.kind === 'action') {
      const what = `${row.integration ?? ''}.${row.action ?? ''}`;
      const priv = row.action_args?.privacy;
      if (!window.confirm(
        `승인하면 즉시 바깥으로 나갑니다.\n\n${what}` +
        (priv ? `\n공개 범위: ${String(priv)}` : '') +
        '\n\n진행할까요?')) return;
    }
    setBusy(row.id);
    setMsg('');
    const r = await api.storeUpdate<ApprovalRow>('approvals', row.id, { status });
    setBusy('');
    if (!r?.ok) { setMsg('처리하지 못했습니다. 백엔드가 떠 있는지 보세요.'); return; }
    const f = r.followup;
    setMsg(
      status === 'rejected' ? '거절했습니다 — 실행하지 않았습니다.'
        : f?.ran ? `실행 완료 — ${f.ran}`
        : f?.wrote ? `저장 완료 — ${f.wrote}`
        : f?.queued ? '승인 — 해당 부서에 지시를 보냈습니다.'
        : f?.reason ? `⚠️ ${f.reason}`
        : '승인했습니다.');
    void load();
  }

  return (
    <div className="ceo-approval">
      <div className="ceo-sec-head">
        <button className="ceo-sec-title as-toggle" onClick={onToggle}
          title={boxOpen ? '접기' : '펼치기'}>
          <span className="ceo-sec-chev">{boxOpen ? '▾' : '▸'}</span>
          🗂️ 결재함
          <span className="ceo-sec-count">{pending.length ? `${pending.length}건 대기` : '비어 있음'}</span>
        </button>
        <span className="ceo-sec-spacer" />
        {boxOpen && batchable.length > 1 && (
          <button className="ceo-appr-btn batch" disabled={batching}
            onClick={() => void approveAll()}
            title="바깥으로 나가는 안건은 제외됩니다">
            {batching ? '처리 중…' : `되돌릴 수 있는 ${batchable.length}건 일괄 승인`}
          </button>
        )}
        {live.length > 0 && (
          <button className="ceo-sec-link" onClick={onOpenProjects}>
            프로젝트 {live.length}건 진행 중 →
          </button>
        )}
      </div>

      {boxOpen && msg && <div className="ceo-appr-msg" onClick={() => setMsg('')}>{msg} — 눌러서 닫기</div>}

      {boxOpen && (pending.length === 0 ? (
        <div className="ceo-appr-empty">
          대기 중인 결재가 없습니다. 에이전트가 파일을 쓰거나 바깥으로 나가는 일을
          하려 할 때 여기로 올립니다.
        </div>
      ) : (
        <div className="ceo-appr-list">
          {groups.map(g => {
          const head = TIER_HEAD[g.tier] ?? TIER_HEAD[1];
          return (
          <div key={g.tier} className={`ceo-appr-group ${head.cls}`}>
            <div className="ceo-appr-group-head">
              <b>{head.title}</b>
              <span className="ceo-appr-group-n">{g.rows.length}건</span>
              <span className="ceo-appr-group-note">{head.note}</span>
            </div>
          {g.rows.map(a => {
            const k = KIND[a.kind ?? ''] ?? { icon: '📌', label: '결재' };
            const body = a.file_content
              ?? (a.action_args ? JSON.stringify(a.action_args, null, 2) : '');
            // 라벨이 "파일 저장: workspace/…/이름.md" 형태라, 꼬리표·제목·경로
            // 줄에 같은 문자열이 세 번 나왔다. 제목에는 파일 이름만 남긴다.
            const label = a.kind === 'file' && a.file_path
              ? (a.file_path.split('/').pop() || a.label)
              : a.label;
            return (
              <div key={a.id} className={`ceo-appr-card t${a.tier ?? 1}`}
                ref={el => { cardRefs.current[a.id] = el; }}>
                <div className="ceo-appr-top">
                  <span className={`ceo-appr-tier ${a.tier_tone ?? 'muted'}`}
                    title={a.tier_why ?? ''}>{a.tier_name ?? '내부'}</span>
                  <span className="ceo-appr-kind">{k.icon} {k.label}</span>
                  {a.department && (
                    <span className="ceo-appr-dept">{DEPT[a.department] ?? a.department}</span>
                  )}
                  <span className="ceo-appr-label">{label}</span>
                </div>

                {/* 되돌릴 수 없는 값은 승인 전에 반드시 보인다. */}
                {a.kind === 'action' && (
                  <div className="ceo-appr-warn">
                    <b>{a.integration}.{a.action}</b> — 승인하면 즉시 실행됩니다.
                    {a.action_args?.privacy != null && (
                      <> 공개 범위 <b>{String(a.action_args.privacy)}</b>.</>
                    )}
                    {a.action_args?.repo != null && (
                      <> 레포 <b>{String(a.action_args.repo)}</b>.</>
                    )}
                  </div>
                )}
                {a.file_path && (
                  <div className="ceo-appr-path">workspace/{a.file_path}</div>
                )}

                {open === a.id && body && (
                  <pre className="ceo-appr-body">{body.slice(0, 4000)}
                    {body.length > 4000 ? `\n\n… (전체 ${body.length.toLocaleString()}자 중 앞부분)` : ''}
                  </pre>
                )}

                <div className="ceo-appr-actions">
                  {body && (
                    <button className="ceo-appr-btn ghost"
                      onClick={() => setOpen(open === a.id ? null : a.id)}>
                      {open === a.id ? '접기' : '내용 보기'}
                    </button>
                  )}
                  {/* 판단 근거를 그 자리에서 얻는다. 전에는 메인 탭으로 가서
                      결재 내용을 손으로 옮겨 적어야 했다. */}
                  <button className="ceo-appr-btn ghost"
                    onClick={() => setAskRow(a)}>
                    <AssistantFace size={14} /> 맹비서에게 상담
                  </button>
                  <button className="ceo-appr-btn reject"
                    disabled={busy === a.id}
                    onClick={() => decide(a, 'rejected')}>거절</button>
                  <button className="ceo-appr-btn approve"
                    disabled={busy === a.id}
                    onClick={() => decide(a, 'approved')}>
                    {busy === a.id ? '처리 중…' : '승인'}
                  </button>
                </div>
              </div>
            );
          })}
          </div>
          );
          })}
        </div>
      ))}

      {askRow && (
        <Suspense fallback={null}>
          <AskHermes ctx={askCtx(askRow)} onClose={() => setAskRow(null)} />
        </Suspense>
      )}

      {boxOpen && recent.length > 0 && (
        <div className="ceo-appr-audit">
          <b>최근 처리</b>
          {recent.map(r => (
            <p key={r.id}>
              <span className={r.status === 'approved' ? 'ok' : 'no'}>
                {r.status === 'approved' ? '승인' : '거절'}
              </span>
              {' '}{(r.label ?? '').slice(0, 40)}
              <span className="who">
                {WHO[r.decided_by ?? ''] ?? r.decided_by ?? '기록 없음'}
                {r.decided_at
                  ? ` · ${new Date(r.decided_at * 1000).toLocaleString('ko-KR', {
                      month: '2-digit', day: '2-digit',
                      hour: '2-digit', minute: '2-digit', hour12: false })}`
                  : ''}
              </span>
            </p>
          ))}
        </div>
      )}

      {/* 진행 중인 프로젝트 목록은 아래 현황판이 맡는다. 여기서 또 보여
          주면 같은 것을 두 번 그리게 되고, 둘이 어긋나면 어느 쪽이 맞는지
          알 수 없게 된다. */}
    </div>
  );
}
