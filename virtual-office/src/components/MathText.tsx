/** 문서 속 LaTeX 수식을 **그려서** 보여 준다.
 *
 *  ## 왜 필요한가
 *
 *  사장님: "논문 전문에서 LaTeX 코드가 문서 형식으로 표현 안 되고 코드
 *  자체가 나타난다."
 *
 *  실측해 보니 **저장은 멀쩡했다.** 위키의 수식은 전부 제대로 된 TeX 이고
 *  (`$\beta_{1}=0.9$`, `$$lrate=d_{\text{model}}^{-0.5}\cdot\min(…)$$`),
 *  표·그림이 LaTeX 로 샌 경우는 0건이다. 변환 파이프라인은 제 일을 했다.
 *
 *  문제는 화면이었다. 지식베이스의 렌더러는 `$…$` 를 **일부러** 고정폭
 *  글씨로만 띄우고 있었다. 당시 사유는 "KaTeX 의존성 하나와 번들 270KB 를
 *  수식 쓰는 14% 때문에 전부에게 물릴 수 없다" 였다 — 합당한 걱정이다.
 *
 *  ## 그 비용을 안 내는 방법
 *
 *  **수식이 실제로 있는 문서를 열 때만** KaTeX 를 받는다(동적 import).
 *  수식이 없는 문서에서는 한 바이트도 받지 않고, 받은 뒤에는 캐시된다.
 *  그래서 "전부에게 물린다" 는 전제가 더는 성립하지 않는다.
 *
 *  받는 동안에는 예전처럼 고정폭 원문을 보여 준다 — 빈칸이 깜빡이는 것보다
 *  낫고, 끝내 못 받아도 그 상태로 읽을 수 있다.
 *
 *  ## 수식을 평문으로 바꿔 저장하지 않는 이유
 *
 *  그건 정보를 버리는 것이다. `$\mathbf{z}=(z_{1},…,z_{n})$` 를 말로 풀어
 *  적으면 되돌릴 수 없고, 맹비서가 근거로 읽을 때도 원문보다 못하다. TeX 은
 *  LLM 이 그대로 읽는 표기다. **원문은 그대로 두고 화면에서만 그린다.**
 */
import { useEffect, useState } from 'react';

type Katex = { renderToString: (tex: string, opts: Record<string, unknown>) => string };

let mod: Katex | null = null;
let pending: Promise<void> | null = null;
const waiters = new Set<() => void>();

/** 처음 수식을 만났을 때 한 번만 받는다. */
function ensureKatex(): Katex | null {
  if (mod) return mod;
  if (!pending) {
    pending = Promise.all([
      import('katex'),
      // 글꼴·조판 CSS. 같이 받아야 그린 결과가 제자리에 선다.
      import('katex/dist/katex.min.css'),
    ]).then(([m]) => {
      mod = ((m as { default?: Katex }).default ?? m) as Katex;
      waiters.forEach(fn => fn());
      waiters.clear();
    }).catch(() => {
      // 못 받으면 영영 원문으로 보여 준다. 화면이 멈추는 것보다 낫다.
      pending = null;
    });
  }
  return null;
}

/** KaTeX 가 준비되면 다시 그리게 하는 구독. */
function useKatex(): Katex | null {
  const [ready, setReady] = useState<Katex | null>(() => ensureKatex());
  useEffect(() => {
    if (ready) return;
    const fn = () => setReady(mod);
    waiters.add(fn);
    return () => { waiters.delete(fn); };
  }, [ready]);
  return ready;
}

function html(k: Katex, tex: string, display: boolean): string {
  try {
    return k.renderToString(tex, {
      displayMode: display,
      // 수식 하나가 깨졌다고 문서 전체가 안 보이면 안 된다. KaTeX 가 그
      // 토막만 빨갛게 표시하고 넘어간다.
      throwOnError: false,
      // 위키 문서는 arXiv 에서 온 남의 글이다. `\href`·`\url` 로 링크를 심을
      // 수 있게 두지 않는다.
      trust: false,
      strict: false,
      output: 'html',
    });
  } catch {
    return '';
  }
}

export function MathInline({ tex }: { tex: string }) {
  const k = useKatex();
  const out = k ? html(k, tex, false) : '';
  if (!out) return <code className="kb-tex">{tex}</code>;
  return <span className="md-math" dangerouslySetInnerHTML={{ __html: out }} />;
}

export function MathBlock({ tex }: { tex: string }) {
  const k = useKatex();
  const out = k ? html(k, tex, true) : '';
  if (!out) return <pre className="kb-tex-block">{tex}</pre>;
  return <div className="md-math-block" dangerouslySetInnerHTML={{ __html: out }} />;
}

/** 여러 줄에 걸친 `$$ … $$` 를 집어낸다.
 *
 *  실측한 모양은 넷이다:
 *
 *      '$$' 만 있는 줄            430   ← 여는/닫는 울타리
 *      한 줄에 $$ 가 2개 이상      149   ← `$$ … $$` 한 줄짜리
 *      짝이 다음 줄에 있는 것       10   ← `$$\begin{aligned}` … `\end{aligned}$$`
 *      인라인 $ 짝이 맞는 줄     1561
 *
 *  @returns [TeX 본문, 다음에 읽을 줄 번호] — 울타리를 못 닫으면 null
 */
export function takeMathBlock(lines: string[], i: number): [string, number] | null {
  const first = lines[i];
  const at = first.indexOf('$$');
  if (at < 0 || first.slice(0, at).trim()) return null;   // 줄 중간에서 시작하면 블록이 아니다

  const rest = first.slice(at + 2);
  const close = rest.indexOf('$$');
  if (close >= 0) {
    // 닫은 뒤에 글이 더 있으면 문단 중간의 수식이다 — 블록으로 삼키지 않는다.
    return rest.slice(close + 2).trim() ? null : [rest.slice(0, close).trim(), i + 1];
  }

  const body: string[] = [];
  if (rest.trim()) body.push(rest);          // `$$\begin{aligned}` 처럼 붙어 있는 것
  for (let j = i + 1; j < lines.length; j++) {
    const k = lines[j].indexOf('$$');
    if (k < 0) { body.push(lines[j]); continue; }
    if (lines[j].slice(0, k).trim()) body.push(lines[j].slice(0, k));
    return [body.join('\n').trim(), j + 1];
  }
  return null;                                // 울타리가 안 닫혔다 — 평문으로 둔다
}
