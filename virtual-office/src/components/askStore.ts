/** 「맹비서에게 묻기」 대화를 **패널 바깥에** 둔다.
 *
 *  ## 왜
 *
 *  사장님: "질문한 상황에서 묻기 창을 닫고 다시 펼치면 이전에 답변하던
 *  과정이 중단된다."
 *
 *  대화(질문·답·기다리는 중)가 패널 컴포넌트 안의 state 였다. 패널은
 *  `{asking && <AskHermes/>}` 로 그려지므로 닫는 순간 통째로 사라지고,
 *  그 뒤에 도착한 답은 받을 곳이 없어 버려졌다.
 *
 *  그래서 대화를 모듈 수준 저장소로 옮긴다. 패널은 **보기만** 한다 —
 *  닫아도 요청은 저장소에서 계속 기다리고, 다시 열면 그 사이 도착한 답이
 *  그대로 있다.
 *
 *  ## 중단
 *
 *  닫는 것과 그만두는 것을 나눈다. 닫기는 "잠깐 치워 둔다", 중단은 "이
 *  답은 필요 없다" 다. 중단은 `AbortController` 로 기다리기를 멈춘다.
 *
 *  **맹비서 쪽은 멈추지 않는다.** 세션 채팅 경로에 서버 쪽 중단 API 가
 *  없어서, 맹비서는 하던 생각을 끝까지 하고 그 답은 세션 기록에 남는다.
 *  화면은 그 답을 받지 않을 뿐이다 — 이 사실을 화면에도 적는다. 멈춘
 *  것처럼 보이게 하고 뒤에서 돌게 두면 거짓말이 된다.
 *
 *  ## 대화 줄기
 *
 *  키는 맥락마다 하나다(문서 경로, 결재 id). 문서 A 를 묻다가 문서 B 로
 *  옮겨도 A 의 대화는 남아 있다가, A 로 돌아오면 다시 보인다.
 */
import { useSyncExternalStore } from 'react';
import { api } from '../api';

export type Turn = { role: 'user' | 'assistant' | 'note'; text: string };

export type Thread = {
  turns: Turn[];
  busy: boolean;
  /** 닫혀 있는 동안 답이 도착했다. 떠 있는 버튼에 표시한다. */
  unread: boolean;
  /** 열려 있나. 열려 있을 때 도착한 답은 unread 로 치지 않는다. */
  open: boolean;
};

const EMPTY: Thread = { turns: [], busy: false, unread: false, open: false };

const threads = new Map<string, Thread>();
const controllers = new Map<string, AbortController>();
const listeners = new Set<() => void>();

function emit() { listeners.forEach(fn => fn()); }

function patch(key: string, p: Partial<Thread>) {
  // 새 객체로 바꾼다 — useSyncExternalStore 는 참조가 바뀌어야 다시 그린다.
  threads.set(key, { ...(threads.get(key) ?? EMPTY), ...p });
  emit();
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** 한 줄기를 구독한다. 키가 없으면 빈 줄기. */
export function useThread(key: string): Thread {
  return useSyncExternalStore(subscribe, () => threads.get(key) ?? EMPTY);
}

/** 패널이 열렸다/닫혔다. 열면 읽은 것으로 친다. */
export function setOpen(key: string, open: boolean) {
  patch(key, open ? { open: true, unread: false } : { open: false });
}

/* ── 세션 ──────────────────────────────────────────────────────────
   맥락 **종류**마다 하나를 두고 localStorage 에 기억한다. 문서를 열 때마다
   세션을 만들면 하루에 수십 개가 쌓인다. 어느 문서에 대한 질문인지는
   메시지 안에 적는다. */
const SID_KEY = (kind: string) => `myungtech_ask_sid_${kind}`;
const TITLE: Record<string, string> = {
  knowledge: '지식베이스 질문', approval: '결재 상담',
};

async function ensureSid(kind: string, fresh = false): Promise<string> {
  const k = SID_KEY(kind);
  if (!fresh) {
    try { const kept = localStorage.getItem(k); if (kept) return kept; }
    catch { /* 사생활 보호 모드에서 던진다 — 없는 것으로 본다 */ }
  }
  // 제목에 초까지 넣는다 — 맹비서가 **중복 제목을 400 으로 거절**한다.
  const stamp = new Date().toLocaleString('ko-KR', { hour12: false });
  const r = await api.assistantNewSession(`${TITLE[kind] ?? '질문'} · ${stamp}`);
  const sid = r?.session?.id ?? '';
  if (sid) { try { localStorage.setItem(k, sid); } catch { /* 위와 같다 */ } }
  return sid;
}

/** 묻는다. 패널이 닫혀도 여기서 끝까지 기다린다. */
export async function ask(key: string, kind: string, brief: string, question: string) {
  const q = question.trim();
  const cur = threads.get(key) ?? EMPTY;
  if (!q || cur.busy) return;

  const ctrl = new AbortController();
  controllers.set(key, ctrl);
  patch(key, { turns: [...cur.turns, { role: 'user', text: q }], busy: true });

  // 맥락을 **질문 앞에** 붙인다. 뒤에 붙이면 긴 맥락에 질문이 묻힌다.
  const payload = `${brief}\n\n[질문]\n${q}`;

  let text = '';
  try {
    let sid = await ensureSid(kind);
    let r = sid ? await api.assistantChat(sid, payload, ctrl.signal) : null;
    // 기억해 둔 세션이 지워졌을 수 있다(대화 기록에서 지울 수 있다).
    // 그때만 새로 만들어 한 번 다시 보낸다.
    if (!ctrl.signal.aborted && r?.error && /not found|찾지 못/i.test(r.error)) {
      sid = await ensureSid(kind, true);
      r = sid ? await api.assistantChat(sid, payload, ctrl.signal) : null;
    }
    if (ctrl.signal.aborted) return;          // 중단은 stop() 이 이미 적었다
    const raw = r?.message;
    const said = typeof raw === 'string' ? raw : (raw?.content ?? '');
    text = said
      || (r?.error ? `⚠️ ${r.error}${r.hint ? `\n\n${r.hint}` : ''}`
        : '⚠️ 맹비서가 빈 답을 보냈습니다.');
  } finally {
    // **내 것일 때만** 지운다. 중단한 요청은 늦게 끝나는데, 그 사이 새
    // 질문을 했으면 key 에는 새 컨트롤러가 들어 있다. 무조건 지우면 새
    // 질문의 「그만 기다리기」가 아무 일도 안 하게 된다.
    if (controllers.get(key) === ctrl) controllers.delete(key);
  }
  if (!text) return;

  const now = threads.get(key) ?? EMPTY;
  patch(key, {
    turns: [...now.turns, { role: 'assistant', text }],
    busy: false,
    // 닫혀 있는 동안 도착했으면 떠 있는 버튼에 알린다.
    unread: !now.open,
  });
}

/** 기다리기를 그만둔다. */
export function stop(key: string) {
  const ctrl = controllers.get(key);
  if (!ctrl) return;
  ctrl.abort();
  controllers.delete(key);
  const now = threads.get(key) ?? EMPTY;
  patch(key, {
    busy: false,
    turns: [...now.turns, {
      role: 'note',
      // 멈춘 것처럼 보이게 하고 뒤에서 돌게 두면 거짓말이 된다.
      text: '⏹ 이 답은 기다리지 않습니다. (맹비서는 하던 생각을 끝까지 하고, '
          + '그 답은 대화 기록에 남을 수 있습니다.)',
    }],
  });
}
