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
 *  주면 스스로 읽고, 관련 문서까지 따라간다.
 *
 *  **2. 답을 그 자리에 띄운다.** 메인 탭으로 보내면 탭을 옮겨야 하고,
 *  돌아오면 보던 문서를 다시 찾아야 한다.
 *
 *  **3. 닫아도 답은 계속 온다.** 대화는 이 컴포넌트가 아니라
 *  `askStore` 에 산다. 전에는 컴포넌트 state 였고, 패널을 닫는 순간
 *  통째로 사라져 **도착한 답이 버려졌다**(사장님 지적). 지금은 닫아도
 *  기다리고, 다시 열면 그 사이 온 답이 있다.
 *
 *  **4. 닫기와 중단을 나눈다.** ✕ 는 잠깐 치워 두는 것, ⏹ 는 이 답이
 *  필요 없다는 것이다. 세션·재시도 처리는 askStore 가 맡는다.
 */
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import AssistantFace from './AssistantFace';
import { ask, setOpen, stop, useThread } from './askStore';

const Markdown = lazy(() => import('./GuideModal').then(m => ({ default: m.Markdown })));

export type AskContext = {
  /** 맥락 종류. 세션을 종류마다 하나씩 둔다. */
  kind: 'knowledge' | 'approval';
  /** 대화 줄기의 열쇠 — 문서 경로, 결재 id. 같은 열쇠면 같은 대화다.
   *  없으면 label 을 쓴다. */
  key?: string;
  /** 화면에 적는 이름 — "PPO", "GPU 서버 증설". */
  label: string;
  /** 맹비서에게 넘기는 맥락 블록. 경로나 결재 내용이 여기 들어간다. */
  brief: string;
  /** 버튼으로 내놓을 질문. 타이핑 없이 한 번에 묻게 한다. */
  presets: string[];
};

/** 맥락의 대화 줄기 열쇠. 패널과 떠 있는 버튼이 같은 값을 써야 한다. */
export function threadKey(ctx: Pick<AskContext, 'kind' | 'key' | 'label'>): string {
  return `${ctx.kind}:${ctx.key ?? ctx.label}`;
}

export default function AskHermes({ ctx, onClose }:
  { ctx: AskContext; onClose: () => void }) {
  const key = threadKey(ctx);
  const t = useThread(key);
  const [input, setInput] = useState('');
  const bottom = useRef<HTMLDivElement>(null);

  // 열려 있음을 저장소에 알린다 — 열려 있는 동안 온 답은 "새 답" 이 아니다.
  useEffect(() => {
    setOpen(key, true);
    return () => setOpen(key, false);
  }, [key]);

  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }); },
            [t.turns.length, t.busy]);

  // Escape 로 닫는다. 바깥을 덮는 backdrop 이 없는 패널이라 키로 닫을 길을
  // 반드시 둔다. **닫기는 중단이 아니다** — 답은 계속 기다린다.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const send = (q: string) => {
    if (!q.trim() || t.busy) return;
    setInput('');
    void ask(key, ctx.kind, ctx.brief, q);
  };

  return (
    <aside className="ask-panel" aria-label="맹비서에게 묻기">
      <div className="ask-head">
        <span className="ask-title"><AssistantFace size={16} /> 맹비서에게 묻기</span>
        <span className="ask-ctx" title={ctx.label}>{ctx.label}</span>
        <button className="ask-close" onClick={onClose}
                aria-label={t.busy ? '닫기 — 답은 계속 기다립니다' : '닫기'}
                title={t.busy ? '닫아도 답은 계속 옵니다' : '닫기'}>✕</button>
      </div>

      <div className="ask-body">
        {t.turns.length === 0 && !t.busy && (
          <div className="ask-hint">
            보고 계신 것을 맹비서가 <strong>직접 읽습니다</strong> — 본문을
            옮겨 적지 않아도 됩니다. 아래를 누르거나 직접 물어보십시오.
          </div>
        )}
        {t.turns.map((m, i) => (
          m.role === 'note'
            ? <div key={i} className="ask-note">{m.text}</div>
            : (
              <div key={i} className={`ask-turn ${m.role}`}>
                <span className="ask-who">{m.role === 'user' ? '사장님' : '맹비서'}</span>
                {m.role === 'user'
                  ? <div className="ask-text">{m.text}</div>
                  : (
                    <Suspense fallback={<div className="ask-text">{m.text}</div>}>
                      <div className="ask-text md"><Markdown src={m.text} /></div>
                    </Suspense>
                  )}
              </div>
            )
        ))}
        {t.busy && (
          <div className="ask-turn assistant">
            <span className="ask-who">맹비서</span>
            {/* 걸리는 시간을 넉넉히 말한다. "30초" 라고 적어 두었다가 실제로
                3분이 걸리자 멈춘 것처럼 보였다. */}
            <div className="ask-text">
              ⏳ 문서를 읽고 생각하는 중…
              <br />
              <span className="ask-wait-note">
                보통 30초, 무료 모델이 붐비면 2–3분까지 걸립니다.
                <strong> 창을 닫아도 답은 계속 옵니다</strong> — 다시 열면 여기 있습니다.
              </span>
              {/* 닫기(✕)와 다르다. 이 답은 필요 없다는 뜻이다. */}
              <button className="ask-stop" onClick={() => stop(key)}>
                ⏹ 그만 기다리기
              </button>
            </div>
          </div>
        )}
        <div ref={bottom} />
      </div>

      {t.turns.length === 0 && (
        <div className="ask-presets">
          {ctx.presets.map(p => (
            <button key={p} className="ask-preset" disabled={t.busy}
                    onClick={() => send(p)}>{p}</button>
          ))}
        </div>
      )}

      <form className="ask-form"
            onSubmit={e => { e.preventDefault(); send(input); }}>
        <input className="ask-input" value={input} disabled={t.busy}
               placeholder={t.busy ? '답을 기다리는 중…' : '무엇이든 물어보십시오'}
               onChange={e => setInput(e.target.value)} />
        <button className="ask-send" type="submit" disabled={t.busy || !input.trim()}>
          보내기
        </button>
      </form>
    </aside>
  );
}
