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
import { useCallback, useEffect, useState } from 'react';
import { api, type ApprovalRow, type ProjectRow } from '../api';

const KIND: Record<string, { icon: string; label: string }> = {
  file: { icon: '📄', label: '파일 저장' },
  action: { icon: '🚀', label: '외부 실행' },
  project: { icon: '📋', label: '프로젝트 착수' },
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

export default function ApprovalBox({ onOpenProjects }: { onOpenProjects: () => void }) {
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [projects, setProjects] = useState<ProjectRow[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState('');
  const [msg, setMsg] = useState('');

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
  const live = projects.filter(p => p.status === 'running' || p.status === 'intake'
    || p.status === 'paused');

  async function decide(row: ApprovalRow, status: 'approved' | 'rejected') {
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
        <span className="ceo-sec-title">
          🗂️ 결재함
          <span className="ceo-sec-count">{pending.length ? `${pending.length}건 대기` : '비어 있음'}</span>
        </span>
        {live.length > 0 && (
          <button className="ceo-sec-link" onClick={onOpenProjects}>
            프로젝트 {live.length}건 진행 중 →
          </button>
        )}
      </div>

      {msg && <div className="ceo-appr-msg" onClick={() => setMsg('')}>{msg} — 눌러서 닫기</div>}

      {pending.length === 0 ? (
        <div className="ceo-appr-empty">
          대기 중인 결재가 없습니다. 에이전트가 파일을 쓰거나 바깥으로 나가는 일을
          하려 할 때 여기로 올립니다.
        </div>
      ) : (
        <div className="ceo-appr-list">
          {pending.map(a => {
            const k = KIND[a.kind ?? ''] ?? { icon: '📌', label: '결재' };
            const body = a.file_content
              ?? (a.action_args ? JSON.stringify(a.action_args, null, 2) : '');
            // 라벨이 "파일 저장: workspace/…/이름.md" 형태라, 꼬리표·제목·경로
            // 줄에 같은 문자열이 세 번 나왔다. 제목에는 파일 이름만 남긴다.
            const label = a.kind === 'file' && a.file_path
              ? (a.file_path.split('/').pop() || a.label)
              : a.label;
            return (
              <div key={a.id} className="ceo-appr-card">
                <div className="ceo-appr-top">
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
      )}

      {/* 진행 중인 프로젝트 목록은 아래 현황판이 맡는다. 여기서 또 보여
          주면 같은 것을 두 번 그리게 되고, 둘이 어긋나면 어느 쪽이 맞는지
          알 수 없게 된다. */}
    </div>
  );
}
