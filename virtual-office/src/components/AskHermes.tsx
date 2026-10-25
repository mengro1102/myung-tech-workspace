/** 보고 있는 것에 대해 그 자리에서 맹비서에게 묻는다.
 *
 *  ## 왜 필요한가
 *
 *  맹비서와 대화할 수 있는 곳이 **메인 탭 하나**였다. 지식베이스에서 논문을
 *  읽다가 "이거 요약해줘" 를 하려면 메인으로 가서, 어느 문서였는지 다시
 *  적고, 답을 보고, 다시 지식베이스로 돌아와 문서를 다시 찾아야 했다.
 *  결재함도 같다 — "이 결재 승인해도 될까" 를 물을 곳이 없었다.
 *
 *  ## 설계에서 고민한 것
 *
 *  **1. 본문을 프롬프트에 붙이지 않는다.** 경로만 준다.
 *
 *  문서를 통째로 붙이면 (a) 토큰을 쓰고, (b) 맹비서가 **이웃 노드를 못
 *  본다**. 맹비서에게는 `read_file` 과 지식 그래프 조회가 있다. 경로를
 *  주면 스스로 읽고, 관련 문서까지 따라간다. 붙여 넣는 쪽이 오히려
 *  맹비서를 눈먼 요약기로 만든다.
 *
 *  **2. 맥락마다 세션을 새로 만들지 않는다.**
 *
 *  문서를 열 때마다 세션을 만들면 하루에 수십 개가 쌓인다. 맥락 종류마다
 *  **하나**를 두고 localStorage 에 기억한다 — "지식베이스에서 물어본 것들"
 *  이 한 줄기로 남아 대화 기록에서 찾을 수 있다. 어느 문서에 대한
 *  질문인지는 **메시지 안**에 적는다.
 *
 *  **3. 답을 그 자리에 띄운다.** 메인 탭으로 보내면 탭을 옮겨야 하고,
 *  돌아오면 보던 문서를 다시 찾아야 한다 — 고치려던 문제가 그대로다.
 *
 *  **4. 세션이 지워졌을 때를 생각한다.** 대화 기록에서 지울 수 있게
 *  만들었으므로, 기억해 둔 id 가 죽어 있을 수 있다. 404 가 오면 조용히
 *  새로 만들어 한 번 다시 보낸다.
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { api } from '../api';

const Markdown = lazy(() => import('./GuideModal').then(m => ({ default: m.Markdown })));

export type AskContext = {
  /** 맥락 종류. 세션을 종류마다 하나씩 둔다. */
  kind: 'knowledge' | 'approval';
  /** 화면에 적는 이름 — "PPO", "GPU 서버 증설". */
  label: string;
  /** 맹비서에게 넘기는 맥락 블록. 경로나 결재 내용이 여기 들어간다. */
  brief: string;
  /** 버튼으로 내놓을 질문. 타이핑 없이 한 번에 묻게 한다. */
  presets: string[];
};

const SID_KEY = (kind: string) => `myungtech_ask_sid_${kind}`;
const TITLE = { knowledge: '지식베이스 질문', approval: '결재 상담' } as const;

type Turn = { role: 'user' | 'assistant'; text: string };

export default function AskHermes({ ctx, onClose }:
  { ctx: AskContext; onClose: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); }, [turns, busy]);

  // Escape 로 닫는다. 바깥을 덮는 backdrop 이 없는 패널이라(문서를 계속
  // 보면서 묻는 것이 목적이다) 키로 닫을 길을 반드시 둔다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /** 이 맥락의 세션 id. 없거나 죽었으면 만든다. */
  const ensureSid = async (fresh = false): Promise<string> => {
    const key = SID_KEY(ctx.kind);
    if (!fresh) {
      try {
        const kept = localStorage.getItem(key);
        if (kept) return kept;
      } catch { /* 사생활 보호 모드에서 던진다 — 없는 것으로 본다 */ }
    }
    // 제목에 시각을 넣는다 — 맹비서가 **중복 제목을 400 으로 거절**한다.
    const stamp = new Date().toLocaleString('ko-KR', { hour12: false });
    const r = await api.assistantNewSession(`${TITLE[ctx.kind]} · ${stamp}`);
    const sid = r?.session?.id ?? '';
    if (sid) { try { localStorage.setItem(key, sid); } catch { /* 위와 같다 */ } }
    return sid;
  };

  const ask = async (question: string) => {
    const q = question.trim();
    if (!q || busy) return;
    setInput('');
    setTurns(prev => [...prev, { role: 'user', text: q }]);
    setBusy(true);

    // 맥락을 **질문 앞에** 붙인다. 뒤에 붙이면 긴 맥락에 질문이 묻힌다.
    const payload = `${ctx.brief}\n\n[질문]\n${q}`;

    let sid = await ensureSid();
    let r = sid ? await api.assistantChat(sid, payload) : null;

    // 기억해 둔 세션이 지워졌을 수 있다(대화 기록에서 지울 수 있게
    // 만들었으므로). 그때만 새로 만들어 한 번 다시 보낸다.
    if (r?.error && /not found|찾지 못/i.test(r.error)) {
      sid = await ensureSid(true);
      r = sid ? await api.assistantChat(sid, payload) : null;
    }

    setBusy(false);
    const raw = r?.message;
    const said = typeof raw === 'string' ? raw : (raw?.content ?? '');
    const text = said
      || (r?.error ? `⚠️ ${r.error}${r.hint ? `\n\n${r.hint}` : ''}`
        : '⚠️ 맹비서가 빈 답을 보냈습니다.');
    setTurns(prev => [...prev, { role: 'assistant', text }]);
  };

  return (
    <aside className="ask-panel" aria-label="맹비서에게 묻기">
      <div className="ask-head">
        <span className="ask-title">🤖 맹비서에게 묻기</span>
        <span className="ask-ctx" title={ctx.label}>{ctx.label}</span>
        <button className="ask-close" onClick={onClose} aria-label="닫기">✕</button>
      </div>

      <div className="ask-body">
        {turns.length === 0 && !busy && (
          <div className="ask-hint">
            보고 계신 것을 맹비서가 <strong>직접 읽습니다</strong> — 본문을
            옮겨 적지 않아도 됩니다. 아래를 누르거나 직접 물어보십시오.
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className={`ask-turn ${t.role}`}>
            <span className="ask-who">{t.role === 'user' ? '사장님' : '맹비서'}</span>
            {t.role === 'user'
              ? <div className="ask-text">{t.text}</div>
              : (
                <Suspense fallback={<div className="ask-text">{t.text}</div>}>
                  <div className="ask-text md"><Markdown src={t.text} /></div>
                </Suspense>
              )}
          </div>
        ))}
        {busy && (
          <div className="ask-turn assistant">
            <span className="ask-who">맹비서</span>
            {/* 걸리는 시간을 넉넉히 말한다. "30초" 라고 적어 두었다가 실제로
                3분이 걸리자 멈춘 것처럼 보였다 — 무료 모델 라우터가 느린
                모델을 고르면 그만큼 걸린다. */}
            <div className="ask-text">
              ⏳ 문서를 읽고 생각하는 중…
              <br />
              <span className="ask-wait-note">
                보통 30초, 무료 모델이 붐비면 2–3분까지 걸립니다. 그동안 문서는
                계속 보실 수 있습니다.
              </span>
            </div>
          </div>
        )}
        <div ref={bottom} />
      </div>

      {turns.length === 0 && (
        <div className="ask-presets">
          {ctx.presets.map(p => (
            <button key={p} className="ask-preset" disabled={busy}
                    onClick={() => void ask(p)}>{p}</button>
          ))}
        </div>
      )}

      <form className="ask-form"
            onSubmit={e => { e.preventDefault(); void ask(input); }}>
        <input className="ask-input" value={input} disabled={busy}
               placeholder={busy ? '답을 기다리는 중…' : '무엇이든 물어보십시오'}
               onChange={e => setInput(e.target.value)} />
        <button className="ask-send" type="submit" disabled={busy || !input.trim()}>
          보내기
        </button>
      </form>
    </aside>
  );
}
