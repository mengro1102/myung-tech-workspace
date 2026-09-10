import { useState, useEffect } from 'react';
import { api, KnowledgeStatus } from '../api';

interface Props {
  onClose: () => void;
}

/* 단기기억 = GraphRAG(mrlee-wiki-graphrag) 노드 카테고리 */
const KB_CATS = [
  { key: 'concepts'    as const, label: '개념',   icon: '💡' },
  { key: 'entities'    as const, label: '엔티티', icon: '🧩' },
  { key: 'comparisons' as const, label: '비교',   icon: '⚖️' },
];

export default function MemoryModal({ onClose }: Props) {
  const [tab,       setTab]       = useState<'short' | 'long' | 'synthesis'>('short');
  const [hfModel,   setHfModel]   = useState('');
  const [hfToken,   setHfToken]   = useState('');
  const [syncing,   setSyncing]   = useState(false);
  const [syncMsg,   setSyncMsg]   = useState('');

  /* 단기기억: 실제 GraphRAG 상태 */
  const [kb,        setKb]        = useState<KnowledgeStatus | null>(null);
  const [kbLoading, setKbLoading] = useState(false);
  const [kbQuery,   setKbQuery]   = useState('');
  const [kbHits,    setKbHits]    = useState<{ node: string; line: string }[] | null>(null);

  const runSearch = async () => {
    if (!kbQuery.trim()) { setKbHits(null); return; }
    const r = await api.knowledgeSearch(kbQuery.trim());
    setKbHits(r?.hits ?? []);
  };

  /* ⚡ 지식 주입 (raw/ 저장 + 자동 git 동기화) */
  const [injTitle,  setInjTitle]  = useState('');
  const [injBody,   setInjBody]   = useState('');
  const [injecting, setInjecting] = useState(false);

  const handleInject = async () => {
    if (!injTitle.trim() && !injBody.trim()) return;
    setInjecting(true); setSyncMsg('');
    const r = await api.knowledgeInject({ title: injTitle.trim(), content: injBody, sync: true });
    setInjecting(false);
    if (r?.ok) {
      setInjTitle(''); setInjBody('');
      if (r.status) setKb(r.status);
      const pushed = r.sync_steps?.some(s => s.cmd?.includes('push') && s.ok);
      setSyncMsg(`✅ 주입 완료 → ${r.injected}${pushed ? ' · GitHub 동기화됨' : ' (로컬 저장, 푸시 확인 필요)'}`);
    } else {
      setSyncMsg(`⚠️ 주입 실패: ${r?.error ?? '서버 응답 없음'}`);
    }
  };

  const handleBackup = async () => {
    setSyncing(true); setSyncMsg('');
    const r = await api.knowledgeSync('manual backup');
    setSyncing(false);
    if (r?.status) setKb(r.status);
    setSyncMsg(r?.ok ? '✅ GitHub 백업(push) 완료' : '⚠️ 백업 일부 실패 — 로그 확인');
  };

  /* 합성 탭이 보여 줄 '실시간' 채널 — 실제로 연결 확인된 연동만 센다. */
  const [live, setLive] = useState<{ label: string }[]>([]);
  useEffect(() => {
    api.listIntegrations().then(r => {
      setLive((r?.integrations ?? []).filter(i => i.ok).map(i => ({ label: i.label })));
    });
  }, []);
  const liveCount = live.length;
  const liveNames = live.map(l => l.label).join(', ');

  /* ── 장기기억 FT (Phase 5) ── */
  const [ltBase,   setLtBase]   = useState('unsloth/Qwen2.5-3B-Instruct');
  const [ltRepo,   setLtRepo]   = useState('username/my-brain-v1');
  const [ltRank,   setLtRank]   = useState(16);
  const [ltEpochs, setLtEpochs] = useState(3);
  const [ltBusy,   setLtBusy]   = useState(false);
  const [ltMsg,    setLtMsg]    = useState('');

  const buildDataset = async () => {
    setLtBusy(true); setLtMsg('');
    const r = await api.longtermBuildDataset('sft');
    setLtBusy(false);
    setLtMsg(r?.ok ? `✅ SFT 데이터셋 ${r.count}건 생성 → ${r.rel}` : `⚠️ 실패: ${r?.error ?? '백엔드 미연결'}`);
  };

  const genColab = async () => {
    setLtBusy(true); setLtMsg('');
    const r = await api.longtermColab({ base_model: ltBase, hf_repo: ltRepo, rank: ltRank, epochs: ltEpochs });
    setLtBusy(false);
    setLtMsg(r?.ok ? `✅ Colab 노트북 생성 → ${r.rel} (Colab에 업로드해 실행)` : `⚠️ 실패: ${r?.error ?? '백엔드 미연결'}`);
  };

  const loadKb = async () => {
    setKbLoading(true);
    const s = await api.knowledgeStatus();
    setKb(s);
    setKbLoading(false);
  };

  useEffect(() => { loadKb(); }, []);

  /* 단기기억 불러오기 = 깃에서 GraphRAG 최신본 참조 (git pull) */
  const handlePull = async () => {
    setSyncing(true);
    setSyncMsg('');
    const s = await api.knowledgePull();
    setKb(s);
    setSyncing(false);
    setSyncMsg(
      s?.pull_ok
        ? `✅ 최신본 참조 완료 — ${s.total_nodes} 노드 (${s.last_commit ?? ''})`
        : `⚠️ 가져오기 실패: ${s?.pull_output ?? s?.error ?? '서버 응답 없음'}`
    );
  };

  /* 여기 handleSync 라는 함수가 있었다. setTimeout 1.2초 뒤에 "✅ 연결"
     이라고 표시하고 실제로는 아무것도 하지 않았다. 호출하는 곳이 없어
     화면에 뜬 적은 없지만, 남겨 두면 언젠가 누가 연결한다. 지웠다. */

  return (
    <div className="hm-backdrop" onClick={onClose}>
      <div className="hm-panel" style={{ maxWidth: 620 }} onClick={e => e.stopPropagation()}>
        <div className="hm-header">
          <span className="hm-title">🧬 지식 네트워크</span>
          <span className="hm-subtitle">{kb ? `${kb.total_nodes}개` : '…'}</span>
          <button className="hm-close" onClick={onClose}>✕</button>
        </div>

        {/* tabs */}
        <div className="mem-tabs">
          {(['short', 'long', 'synthesis'] as const).map(t => (
            <button
              key={t}
              className={`mem-tab ${tab === t ? 'active' : ''}`}
              onClick={() => setTab(t)}
            >
              {t === 'short' ? '⚡ 단기 기억' : t === 'long' ? '🧠 장기 기억 BETA' : '🔗 기억 합성'}
            </button>
          ))}
        </div>

        {/* short-term: GraphRAG (mrlee-wiki-graphrag) — 깃에서 참조 */}
        {tab === 'short' && (
          <div className="mem-content">
            <div className="mem-source-card">
              <div className="mem-source-icon">⚡</div>
              <div className="mem-source-body">
                <div className="mem-source-title">단기 기억 = GraphRAG (GitHub)</div>
                <div className="mem-source-desc">
                  {kbLoading ? '확인 중…'
                    : kb?.available
                      ? `연결됨 · ${kb.branch ?? '?'} · ${kb.total_nodes} 노드`
                      : `미연결 (${kb?.error ?? '경로 없음'})`}
                </div>
              </div>
              <button className="mem-action-btn" onClick={handlePull} disabled={syncing}>
                {syncing ? '⏳' : '↻ 최신본 참조'}
              </button>
              <button className="mem-action-btn secondary" onClick={handleBackup}
                      disabled={syncing || !kb?.is_git} title="git add/commit/push">
                {syncing ? '⏳' : '⬆ 백업'}
              </button>
            </div>

            <p className="mem-hint" style={{ marginTop: 10 }}>
              {kb?.path ?? 'D:\\AI_Workspace\\mrlee-wiki-graphrag'}
              {kb?.last_commit ? <><br/>최근: {kb.last_commit}</> : null}
            </p>

            {/* ⚡ 지식 주입 — raw/ 저장 + 자동 git 동기화 */}
            <div className="mem-inject">
              <label className="hm-field-label">⚡ 지식 주입 (두뇌에 추가 → 자동 백업)</label>
              <input
                className="hm-input"
                placeholder="제목 (예: RAG 운영 노트)"
                value={injTitle}
                onChange={e => setInjTitle(e.target.value)}
              />
              <textarea
                className="hm-input"
                style={{ marginTop: 8, minHeight: 70, resize: 'vertical' }}
                placeholder="내용 / 원시 메모 / 링크 요약을 붙여넣으세요. raw/articles/ 에 저장됩니다."
                value={injBody}
                onChange={e => setInjBody(e.target.value)}
              />
              <button className="hm-save-btn" style={{ marginTop: 10 }}
                      onClick={handleInject}
                      disabled={injecting || !kb?.available || (!injTitle.trim() && !injBody.trim())}>
                {injecting ? '주입 중…' : '⚡ 주입하고 동기화'}
              </button>
            </div>

            {syncMsg && <div className="mem-sync-msg">{syncMsg}</div>}

            {/* GraphRAG 카테고리별 노드 수 */}
            <div className="mem-cats">
              {KB_CATS.map(c => {
                const n = kb?.by_category?.[c.key] ?? 0;
                return (
                  <div key={c.key} className="mem-cat-row">
                    <span className="mem-cat-icon">{c.icon}</span>
                    <span className="mem-cat-name">{c.label}</span>
                    <div className="mem-cat-bar">
                      <div className="mem-cat-fill" style={{ width: `${Math.min(100, n * 4)}%` }} />
                    </div>
                    <span className="mem-cat-count">{n}</span>
                  </div>
                );
              })}
            </div>

            {/* 빠른 검색 (어휘) */}
            <label className="hm-field-label" style={{ marginTop: 14 }}>지식베이스 검색</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                className="hm-input"
                placeholder="예: attention, cmaq, transformer…"
                value={kbQuery}
                onChange={e => setKbQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') runSearch(); }}
              />
              <button className="mem-action-btn" onClick={runSearch} disabled={!kb?.available}>🔍</button>
            </div>
            {kbHits && (
              <div className="mem-search-results">
                {kbHits.length === 0
                  ? <div className="mem-empty-hint">결과 없음</div>
                  : kbHits.slice(0, 12).map((h, i) => (
                      <div key={i} className="mem-hit-row">
                        <span className="mem-hit-node">{h.node}</span>
                        <span className="mem-hit-line">{h.line.slice(0, 70)}</span>
                      </div>
                    ))}
              </div>
            )}

            {!kb?.available && (
              <div className="mem-empty-hint">GraphRAG 경로를 찾을 수 없어요 — GRAPHRAG_KB_PATH 확인 🧠</div>
            )}
          </div>
        )}

        {/* long-term: SFT/DPO 파인튜닝 (GraphRAG → 데이터셋 → Colab/로컬GPU) */}
        {tab === 'long' && (
          <div className="mem-content">
            <p className="mem-hint" style={{ marginBottom: 12 }}>
              🧠 장기 기억 = 지식을 모델에 학습(LoRA SFT). GraphRAG 노드 → 학습 데이터셋 → Colab(무료 T4) 또는 로컬 GPU에서 파인튜닝.
            </p>

            <button className="mem-action-btn" onClick={buildDataset} disabled={ltBusy || !kb?.available}>
              {ltBusy ? '⏳' : '① 데이터셋 빌드 (GraphRAG → SFT)'}
            </button>

            <label className="hm-field-label" style={{ marginTop: 14 }}>베이스 모델</label>
            <input className="hm-input" value={ltBase} onChange={e => setLtBase(e.target.value)} />

            <label className="hm-field-label" style={{ marginTop: 10 }}>HuggingFace 업로드 repo</label>
            <input className="hm-input" placeholder="username/my-brain-v1" value={ltRepo} onChange={e => setLtRepo(e.target.value)} />

            <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
              <div style={{ flex: 1 }}>
                <label className="hm-field-label">LoRA rank</label>
                <input className="hm-input" type="number" value={ltRank}
                       onChange={e => setLtRank(+e.target.value)} />
              </div>
              <div style={{ flex: 1 }}>
                <label className="hm-field-label">epochs</label>
                <input className="hm-input" type="number" value={ltEpochs}
                       onChange={e => setLtEpochs(+e.target.value)} />
              </div>
            </div>

            <button className="hm-save-btn" style={{ marginTop: 14 }} onClick={genColab} disabled={ltBusy}>
              {ltBusy ? '생성 중…' : '② 무료로 시작 — Colab 노트북 생성'}
            </button>
            {ltMsg && <div className="mem-sync-msg">{ltMsg}</div>}

            <div className="mem-beta-note">
              생성물은 <code>workspace/training/</code>에 저장됩니다. Colab에 <code>sft_dataset.jsonl</code> + <code>finetune_colab.ipynb</code>를 올려 실행하거나, 로컬 RTX 3090에서 동일 노트북을 사용하세요. (DPO는 선호쌍 데이터 필요 — 추후)
            </div>
          </div>
        )}

        {/* synthesis */}
        {tab === 'synthesis' && (
          <div className="mem-content">
            <p className="mem-hint">
              에이전트가 답할 때 <strong>무엇을 함께 보는가</strong>입니다.
              합성이란 이 채널들을 한 프롬프트에 얹는 일입니다.
            </p>

            <div className="mem-synth-list">
              <div className={`mem-synth-row ${kb?.available ? 'on' : 'off'}`}>
                <span className="mem-synth-dot" aria-hidden="true" />
                <div className="mem-synth-body">
                  <div className="mem-synth-name">⚡ 단기 — 위키 지식베이스</div>
                  <div className="mem-synth-desc">
                    {kb?.available
                      ? `켜짐 · ${kb.total_nodes}개 노드에서 질문과 관련된 문서를 찾아 근거로 붙입니다.`
                      : '꺼짐 · GRAPHRAG_KB_PATH 를 찾지 못했습니다.'}
                  </div>
                </div>
              </div>

              <div className={`mem-synth-row ${liveCount > 0 ? 'on' : 'off'}`}>
                <span className="mem-synth-dot" aria-hidden="true" />
                <div className="mem-synth-body">
                  <div className="mem-synth-name">📡 실시간 — 연동에서 온 실제 수치</div>
                  <div className="mem-synth-desc">
                    {liveCount > 0
                      ? `켜짐 · ${liveNames} — 질문에 관련 단어가 나오면 조회해서 붙입니다.`
                      : '꺼짐 · 연결 확인된 연동이 없습니다. 관리 → 연동에서 키를 넣으세요.'}
                  </div>
                </div>
              </div>

              <div className="mem-synth-row off">
                <span className="mem-synth-dot" aria-hidden="true" />
                <div className="mem-synth-body">
                  <div className="mem-synth-name">🧠 장기 — 축적된 경험</div>
                  <div className="mem-synth-desc">
                    아직 없습니다. 대화와 프로젝트 결과를 위키에 쌓아 검색되게 하는 것이
                    다음 단계입니다. 파인튜닝(장기 기억 탭)은 그렇게 모인 데이터가
                    수천 건이 된 뒤에 의미가 있습니다
                    {kb?.total_nodes ? ` — 지금 ${kb.total_nodes}개로는 RAG 가 더 정확합니다.` : '.'}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
