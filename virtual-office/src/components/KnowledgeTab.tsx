/**
 * 지식베이스 탭 — 위키를 IDE 처럼 뒤지고, 논문처럼 읽는다.
 *
 * ## 전에는
 *
 * 이 자리는 '노트' 탭이었다(사장님 할 일 체크리스트). 그건 프로젝트 탭의
 * 결재함 옆으로 옮겼다 — 둘 다 "사람만 할 수 있는 일" 이라 같은 화면에
 * 있는 것이 맞다.
 *
 * 위키를 보는 창구는 관리 탭 안의 slug 목록 하나뿐이었다. 그걸로는
 * `references/2coool-2nd-workshop-on-the-challenge-of-out-of-label-haz…`
 * 같은 줄 227개를 보는 것이 전부였다. 제목도, 날짜도, 그림도 없었다.
 *
 * ## 세 칸
 *
 *   왼쪽   폴더 → 파일. 제목과 로컬 수정시각. 제목 필터와 본문 검색.
 *   가운데 문서. ar5iv 처럼 — 한 페이지에 본문·그림·표가 다 있다.
 *   오른쪽 목차와 연결된 지식. 긴 논문에서 길을 잃지 않게.
 *
 * ## 왜 마크다운 렌더러를 또 만드나
 *
 * `GuideModal` 의 `Markdown` 이 이미 있다. 그걸 쓰지 않는 이유는 셋이다:
 *
 *   1. **그림이 안 나온다.** `![alt](src)` 에서 `!` 다음부터가 링크 정규식에
 *      걸려, 216건의 그림이 전부 "느낌표 + 파란 링크" 로 렌더링된다.
 *   2. **상대 경로를 풀어야 한다.** 그림은 `../assets/papers/…` 로 걸려
 *      있어서, 문서 폴더 기준으로 풀어 API 주소로 바꿔야 보인다.
 *   3. **목차가 필요하다.** 제목에 id 가 없으면 오른쪽 목차를 만들 수 없다.
 *
 * 그 셋을 공용 컴포넌트에 넣으면 연동 가이드와 프로젝트 산출물 보기까지
 * 같이 흔든다. 위키 문서에만 필요한 것이라 여기 둔다.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AskContext } from './AskHermes';
import {
  api,
  type KbDoc,
  type KbFile,
  type KbFolder,
  type KbOrigin,
  type KbTree,
} from '../api';

/* 보던 문서를 두고 그 자리에서 맹비서에게 묻는 패널. 열 때까지 필요
   없으므로 lazy 다 — 지식베이스를 읽기만 하는 사람에게 짐을 지우지 않는다. */
const AskHermes = lazy(() => import('./AskHermes'));

/* ── 출처 꼬리표 ──────────────────────────────────────────────────
   같은 폴더에 섞여 있던 셋을 구분한다. 근거의 무게가 다르다 — 사람이
   정리한 노드와, 기계가 모은 논문과, AI 가 쓴 산출물은 믿는 방식이
   달라야 한다. */
const ORIGIN: Record<KbOrigin, { label: string; cls: string; hint: string }> = {
  node:       { label: '노드',   cls: 'node',  hint: '사람이 정리한 지식' },
  reference:  { label: '논문',   cls: 'ref',   hint: 'arXiv 에서 모은 참조' },
  experience: { label: '산출물', cls: 'exp',   hint: 'AI 가 만들어 결재를 통과한 것' },
  injected:   { label: '주입',   cls: 'inj',   hint: '밖에서 넣은 글' },
  unknown:    { label: '기타',   cls: 'unk',   hint: '분류되지 않음' },
};

function when(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const now = new Date();
  const days = Math.floor((now.getTime() - d.getTime()) / 86400000);
  const hh = `${d.getHours()}`.padStart(2, '0');
  const mm = `${d.getMinutes()}`.padStart(2, '0');
  if (days === 0) return `오늘 ${hh}:${mm}`;
  if (days === 1) return `어제 ${hh}:${mm}`;
  if (days < 365) return `${d.getMonth() + 1}/${d.getDate()}`;
  return `${d.getFullYear()}.${d.getMonth() + 1}`;
}

function size(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** `raw/papers/x.md` 에서 본 `../assets/a.png` → `raw/assets/a.png`.
 *
 *  그림 216건이 상대 경로로 걸려 있다. 풀지 않으면 브라우저가 화면 주소
 *  기준으로 받아, 전부 404 가 된다. `..` 를 직접 걷는다 — URL 생성자를
 *  쓰면 상대 경로가 아닌 절대 URL 이 나와서 API 로 못 넘긴다. */
function resolveRel(docPath: string, src: string): string {
  if (/^(https?:|data:|\/)/.test(src)) return src;       // 밖의 것은 그대로
  const base = docPath.split('/').slice(0, -1);
  const out = [...base];
  for (const part of src.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** 프런트매터를 떼어 낸다. 뷰어는 그걸 머리글 카드로 따로 보여 주므로,
 *  본문에 또 나오면 같은 것을 두 번 읽게 된다. */
function stripFront(text: string): string {
  if (!text.startsWith('---')) return text;
  const end = text.indexOf('\n---', 3);
  if (end < 0) return text;
  return text.slice(end + 4).replace(/^\n+/, '');
}

/** 머리글에 이미 건 제목과 같은 맨 앞 `# 제목` 을 뗀다.
 *
 *  문서 대부분이 프런트매터 title 과 같은 `# 제목` 으로 시작한다. 머리글에
 *  크게 걸어 놓고 본문 첫 줄에 또 그리면 같은 말이 두 번 연달아 나온다.
 *
 *  **뷰어와 목차가 같은 본문을 봐야 한다.** 한쪽에서만 떼면 제목 id 가 한
 *  칸씩 밀려, 목차를 눌렀을 때 엉뚱한 절로 뛴다. */
function dropDupTitle(body: string, title: string): string {
  const m = body.match(/^#\s+(.+?)\s*#*\s*(\n|$)/);
  if (!m) return body;
  const norm = (x: string) => x.trim().toLowerCase().replace(/\s+/g, ' ');
  return norm(m[1]) === norm(title) ? body.slice(m[0].length).replace(/^\n+/, '') : body;
}

interface Heading { id: string; level: number; text: string }

/** 목차용 제목 수집. 코드블록 안의 `#` 은 주석이지 제목이 아니다. */
function headings(body: string): Heading[] {
  const out: Heading[] = [];
  let fence = false;
  let n = 0;
  for (const line of body.split('\n')) {
    if (line.trim().startsWith('```')) { fence = !fence; continue; }
    if (fence) continue;
    const m = line.match(/^(#{1,4})\s+(.+?)\s*#*$/);
    if (m) out.push({ id: `kb-h-${n++}`, level: m[1].length, text: m[2] });
  }
  return out;
}

/* ── 인라인 ──────────────────────────────────────────────────────── */

/** 굵게·기울임·코드·링크·위키링크. 그림은 블록에서 따로 다룬다.
 *
 *  `onNav` 가 있으면 `[[slug]]` 는 탭 안에서 이동하는 버튼이 되고, 없으면
 *  그냥 글자로 남는다. 위키링크를 `<a href>` 로 만들면 화면이 통째로
 *  빠져나간다 — SPA 라 돌아올 길이 없다.
 *
 *  `canNav` 로 **문서가 있는 slug 만** 버튼이 된다. 그래프에는 문서 없는
 *  위키링크(dangling)가 섞여 있어서, 다 눌리게 두면 눌러 보고 아무 일도
 *  일어나지 않는 자리가 생긴다. */
function inline(text: string, key: string,
                onNav?: (slug: string) => void,
                canNav?: (slug: string) => boolean) {
  const parts: React.ReactNode[] = [];
  // `$…$` 가 끝에 있다. 위키 390건 중 54건이 LaTeX 를 그렇게 쓴다
  // (`$\pi_\theta(a \mid s)$` 같은 것). KaTeX 를 들이지는 않는다 — 의존성
  // 하나와 번들 270KB 를 그 14% 때문에 전부에게 물린다. 대신 **수식이라는
  // 것이 보이게** 고정폭으로 띄운다. 달러 기호가 문장 가운데 흩어져 있는
  // 것보다는 읽힌다. 조판은 아니다.
  const re = /(\[\[[^\]]+\]\])|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(`[^`]+`)|(\[[^\]]*\]\([^)]+\))|(\$[^$\n]{1,160}\$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${key}-${i++}`;
    if (tok.startsWith('[[')) {
      const raw = tok.slice(2, -2);
      const [slug, alias] = raw.split('|');
      const label = (alias || slug).trim();
      const target = slug.trim();
      parts.push(onNav && (!canNav || canNav(target))
        ? <button key={k} type="button" className="kb-wl"
                  title={`${target} 로 이동`}
                  onClick={() => onNav(target)}>{label}</button>
        : <span key={k} className="kb-wl dead"
                title={`${target} — 아직 문서가 없습니다`}>{label}</span>);
    } else if (tok.startsWith('**')) {
      parts.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('`')) {
      parts.push(<code key={k} className="kb-code">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith('$')) {
      parts.push(<span key={k} className="kb-math" title="LaTeX 수식">{tok.slice(1, -1)}</span>);
    } else if (tok.startsWith('*')) {
      parts.push(<em key={k}>{tok.slice(1, -1)}</em>);
    } else {
      const mm = tok.match(/\[([^\]]*)\]\(([^)]+)\)/)!;
      const href = mm[2];
      // arXiv·외부 링크는 새 탭. 내부 md 링크는 지금 다루지 않는다 —
      // 위키 문서끼리는 [[wikilink]] 로 걸려 있고, 그쪽은 위에서 처리한다.
      parts.push(<a key={k} href={href} target="_blank" rel="noreferrer">{mm[1] || href}</a>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/* ── 본문 렌더러 ─────────────────────────────────────────────────── */

interface MdProps {
  body: string;
  docPath: string;
  onNav?: (slug: string) => void;
  canNav?: (slug: string) => boolean;
}

/** ar5iv 처럼 — 한 페이지에 본문·그림·표가 다 들어간다.
 *
 *  그림에는 번호를 붙인다(그림 1, 그림 2 …). 논문 본문 추출물은 그림이
 *  20장 넘게 이어지는데, 번호가 없으면 본문의 "Figure 3 참조" 와 화면의
 *  그림을 맞춰 볼 수가 없다. */
function KbMarkdown({ body, docPath, onNav, canNav }: MdProps) {
  const blocks: React.ReactNode[] = [];
  const lines = body.split('\n');
  let i = 0;
  let n = 0;
  let hi = 0;        // 제목 번호 — headings() 와 **같은 순서로** 세야 목차가 맞는다
  let fig = 0;

  const IMG = /^!\[([^\]]*)\]\(([^)]+)\)\s*$/;
  const LIST = /^(\s*)(\d+\.|[-*])\s+(.*)$/;

  while (i < lines.length) {
    const line = lines[i];

    // 코드블록
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) buf.push(lines[i++]);
      i++;
      blocks.push(
        <pre key={n++} className="kb-pre">
          {lang && <span className="kb-pre-lang">{lang}</span>}
          <code>{buf.join('\n')}</code>
        </pre>);
      continue;
    }

    // 그림. 연달아 오면 한 줄에 흘려 넣는다 — 논문 추출물은 그림이
    // 20장 넘게 이어져서, 하나씩 세로로 쌓으면 본문이 보이지 않는다.
    const im = line.match(IMG);
    if (im) {
      const group: { alt: string; src: string }[] = [];
      while (i < lines.length) {
        const mm = lines[i].match(IMG);
        if (mm) { group.push({ alt: mm[1], src: mm[2] }); i++; continue; }
        if (lines[i].trim() === '') { i++; continue; }
        break;
      }
      blocks.push(
        <div key={n++} className={`kb-figs ${group.length > 1 ? 'many' : 'one'}`}>
          {group.map((g, j) => {
            const num = ++fig;
            const url = api.knowledgeFileUrl(resolveRel(docPath, g.src));
            return (
              <figure key={j} className="kb-fig">
                <a href={url} target="_blank" rel="noreferrer" title="원본 크기로 열기">
                  <img src={url} alt={g.alt || `그림 ${num}`} loading="lazy" />
                </a>
                <figcaption>
                  <b>그림 {num}</b>
                  {g.alt && !/^p\d+_fig/.test(g.alt) && <> · {g.alt}</>}
                </figcaption>
              </figure>
            );
          })}
        </div>);
      continue;
    }

    // 표
    if (line.startsWith('|') && (lines[i + 1] ?? '').replace(/[\s|:-]/g, '') === '') {
      const head = line.split('|').slice(1, -1).map(c => c.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        rows.push(lines[i].split('|').slice(1, -1).map(c => c.trim()));
        i++;
      }
      blocks.push(
        <div key={n++} className="kb-table-wrap">
          <table className="kb-table">
            <thead><tr>{head.map((h, j) => <th key={j}>{inline(h, `th${n}${j}`, onNav, canNav)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => (
              <tr key={ri}>{r.map((c, ci) => <td key={ci}>{inline(c, `td${n}${ri}${ci}`, onNav, canNav)}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>);
      continue;
    }

    // 제목. id 를 단다 — 오른쪽 목차가 이걸로 뛴다.
    const h = line.match(/^(#{1,4})\s+(.+?)\s*#*$/);
    if (h) {
      const lvl = h[1].length;
      const Tag = (`h${Math.min(lvl + 1, 6)}`) as 'h2' | 'h3' | 'h4' | 'h5';
      blocks.push(
        <Tag key={n++} id={`kb-h-${hi++}`} className={`kb-h kb-h${lvl}`}>
          {inline(h[2], `h${n}`, onNav, canNav)}
        </Tag>);
      i++;
      continue;
    }

    // 구분선
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={n++} className="kb-hr" />);
      i++;
      continue;
    }

    // 인용
    if (line.startsWith('>')) {
      const buf: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) buf.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(
        <blockquote key={n++} className="kb-quote">
          {inline(buf.join(' '), `q${n}`, onNav, canNav)}
        </blockquote>);
      continue;
    }

    // 목록. 들여쓴 항목은 중첩으로 넣는다 — 형제로 올리면 번호가 밀려서
    // 문서의 '5단계' 가 화면에서 7번이 된다.
    if (LIST.test(line)) {
      const indentOf = (s: string) => s.replace(/\t/g, '  ').length;
      const render = (depth: number): React.ReactNode => {
        const ordered = /\d+\./.test(lines[i].match(LIST)![2]);
        const items: React.ReactNode[] = [];
        while (i < lines.length) {
          const m2 = lines[i].match(LIST);
          if (!m2) {
            // 목록 안의 이어지는 줄(들여쓴 본문)은 앞 항목에 붙인다
            if (lines[i].trim() === '' && (lines[i + 1] ?? '').match(LIST)) { i++; continue; }
            break;
          }
          if (indentOf(m2[1]) < depth) break;
          if (indentOf(m2[1]) > depth) { items.push(<li key={`s${items.length}`}>{render(indentOf(m2[1]))}</li>); continue; }
          const text = m2[3];
          i++;
          const kids: React.ReactNode[] = [];
          const nxt = lines[i]?.match(LIST);
          if (nxt && indentOf(nxt[1]) > depth) kids.push(render(indentOf(nxt[1])));
          items.push(
            <li key={items.length}>
              {inline(text, `li${n}-${depth}-${items.length}`, onNav, canNav)}
              {kids}
            </li>);
        }
        return ordered
          ? <ol key={`ol${n}-${depth}`} className="kb-ol">{items}</ol>
          : <ul key={`ul${n}-${depth}`} className="kb-ul">{items}</ul>;
      };
      blocks.push(<div key={n++} className="kb-list">{render(indentOf(line.match(LIST)![1]))}</div>);
      continue;
    }

    // 빈 줄
    if (line.trim() === '') { i++; continue; }

    // 문단. 다음 빈 줄까지 모은다.
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== ''
           && !lines[i].startsWith('|') && !lines[i].startsWith('>')
           && !lines[i].trim().startsWith('```')
           && !LIST.test(lines[i]) && !IMG.test(lines[i])
           && !/^#{1,4}\s/.test(lines[i])) {
      buf.push(lines[i++]);
    }
    if (buf.length) {
      blocks.push(<p key={n++} className="kb-p">{inline(buf.join(' '), `p${n}`, onNav, canNav)}</p>);
    } else {
      i++;   // 어느 규칙에도 안 걸린 줄 — 무한 루프를 막는다
    }
  }

  return <div className="kb-body">{blocks}</div>;
}

/* ── 사이드바 ────────────────────────────────────────────────────── */

interface SideProps {
  tree: KbTree | null;
  cur: string;
  onPick: (f: KbFile) => void;
}

function KbSidebar({ tree, cur, onPick }: SideProps) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});

  /* 열려 있는 문서의 폴더는 펼친다.
   *
   * 폴더를 전부 접어 두는 것이 기본인데(390건을 다 펴면 사이드바가 수천
   * 픽셀이 된다), 그러면 **새로고침으로 복원한 문서가 어디 있는지 안
   * 보인다** — 본문은 떠 있는데 사이드바에는 아무것도 강조되지 않는다.
   *
   * 사장님이 직접 접은 폴더는 건드리지 않는다. `cur` 이 바뀔 때만, 그
   * 폴더가 아직 한 번도 안 열렸을 때만 편다. */
  useEffect(() => {
    if (!cur) return;
    const folder = cur.slice(0, cur.lastIndexOf('/'));
    if (!folder) return;
    setOpen(o => (folder in o ? o : { ...o, [folder]: true }));
  }, [cur]);
  // 본문 검색은 서버가 한다. 제목 필터와 **다른 일**이라 따로 둔다 —
  // 제목에 없는 말이 본문에 있는 경우가 논문에서는 대부분이다.
  const [deep, setDeep] = useState<{ q: string; hits: string[] } | null>(null);
  const [deepBusy, setDeepBusy] = useState(false);

  // 처음에는 **전부 접는다.** 앞 세 폴더를 펴 두었더니 개념 55건이 그대로
  // 쏟아져서, 폴더가 아홉 개라는 사실 자체가 안 보였다. 아래 isOpen 의
  // `open[f.path] ?? false` 가 접힌 상태를 기본으로 하므로, 펴 두던 효과를
  // 지우는 것으로 끝난다 — 따로 초기화할 것이 없다.
  //
  // 검색 중에는 이 상태를 무시하고 전부 편다(isOpen 의 `needle || deep`).

  const needle = q.trim().toLowerCase();
  const folders = useMemo<KbFolder[]>(() => {
    if (!tree?.folders) return [];
    if (!needle && !deep) return tree.folders;
    const hit = deep ? new Set(deep.hits) : null;
    return tree.folders
      .map(f => ({
        ...f,
        files: f.files.filter(x =>
          (!needle || x.title.toLowerCase().includes(needle)
                   || x.name.toLowerCase().includes(needle))
          && (!hit || hit.has(x.path))),
      }))
      .filter(f => f.files.length > 0);
  }, [tree, needle, deep]);

  const shown = folders.reduce((a, f) => a + f.files.length, 0);

  const runDeep = useCallback(async () => {
    const term = q.trim();
    if (!term) { setDeep(null); return; }
    setDeepBusy(true);
    const r = await api.knowledgeSearch(term);
    setDeepBusy(false);
    // search() 는 폴더 순서대로 limit 을 채워 끊는다(알려진 결함, 서버 주석
    // 참고). 그래서 "본문 검색 결과 없음" 이 아니라 **몇 건 찾았는지**를
    // 보여 준다 — 뒤쪽 폴더가 안 나올 수 있다는 것을 숨기지 않는다.
    const hits = (r?.hits ?? []).map(h => (h.node.endsWith('.md') ? h.node : `${h.node}.md`));
    setDeep({ q: term, hits: Array.from(new Set(hits)) });
  }, [q]);

  return (
    <aside className="kb-side">
      <div className="kb-search">
        <input
          className="kb-search-input"
          placeholder="제목 검색…"
          value={q}
          onChange={e => { setQ(e.target.value); if (deep) setDeep(null); }}
          onKeyDown={e => { if (e.key === 'Enter') void runDeep(); }}
        />
        {q && (
          <button className="kb-search-x" onClick={() => { setQ(''); setDeep(null); }}
                  title="지우기">✕</button>
        )}
      </div>
      <div className="kb-search-row">
        <button className="kb-deep-btn" onClick={() => void runDeep()}
                disabled={!q.trim() || deepBusy}
                title="제목이 아니라 본문에서 찾습니다">
          {deepBusy ? '본문 찾는 중…' : '본문 검색'}
        </button>
        <span className="kb-side-count">
          {tree ? `${shown} / ${tree.total}건` : '…'}
        </span>
      </div>
      {deep && (
        <div className="kb-deep-note">
          본문에 <b>{deep.q}</b> → {deep.hits.length}건
          {/* 서버 search() 의 limit 이 폴더 순서를 편든다. 모른 채 "없다" 고
              믿게 하지 않는다. */}
          <span> · 앞쪽 폴더부터 최대 50건만 봅니다</span>
        </div>
      )}

      <div className="kb-tree">
        {!tree && <div className="kb-side-empty">불러오는 중…</div>}
        {tree && !tree.available && (
          <div className="kb-side-empty err">{tree.error ?? '지식베이스를 찾지 못했습니다'}</div>
        )}
        {tree?.available && folders.length === 0 && (
          <div className="kb-side-empty">찾는 것이 없습니다</div>
        )}
        {folders.map(f => {
          const isOpen = needle || deep ? true : (open[f.path] ?? false);
          return (
            <section key={f.path} className="kb-folder">
              <button className={`kb-folder-head ${isOpen ? 'open' : ''}`}
                      onClick={() => setOpen(o => ({ ...o, [f.path]: !isOpen }))}
                      title={`${f.hint} · ${f.path}`}>
                <span className="kb-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                <span className="kb-folder-name">{f.label}</span>
                <span className="kb-folder-n">{f.files.length}</span>
              </button>
              {isOpen && (
                <div className="kb-files">
                  {f.files.map(x => (
                    <button key={x.path}
                            className={`kb-file ${cur === x.path ? 'on' : ''}`}
                            onClick={() => onPick(x)}
                            title={`${x.path}\n${size(x.size)} · 로컬 수정 ${when(x.mtime)}`}>
                      <span className={`kb-dot ${ORIGIN[x.origin]?.cls ?? 'unk'}`} aria-hidden="true" />
                      <span className="kb-file-t">{x.title}</span>
                      <span className="kb-file-d">{when(x.mtime)}</span>
                    </button>
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>

      {tree?.available && (
        <div className="kb-side-foot" title={tree.root}>
          {/* 사장님이 보고 싶다고 한 것은 **로컬** 수정시각이다. 깃 동기화
              시각이 아니다 — 깃에 올리지 않은 수집분이 다수다. */}
          위키 로컬 최신 변경 · <b>{when(tree.mtime)}</b>
        </div>
      )}
    </aside>
  );
}

/* ── 문서 ────────────────────────────────────────────────────────── */

interface ViewProps {
  file: KbFile | null;
  doc: KbDoc | null;
  busy: boolean;
  onNavPath: (path: string) => void;
  /** `[[slug]]` 를 실제 문서로 옮긴다. 문서가 없는 slug 면 undefined 를
   *  돌려주고, 렌더러는 그걸 눌리지 않는 회색 꼬리표로 그린다. */
  resolveSlug: (slug: string) => string | undefined;
}

function KbViewer({ file, doc, busy, onNavPath, resolveSlug }: ViewProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // 문서를 바꾸면 맨 위로. 안 올리면 긴 논문을 읽던 자리에 새 문서의
  // 중간이 걸려서, 눌렀는데 아무 일도 안 일어난 것처럼 보인다.
  useEffect(() => { bodyRef.current?.scrollTo({ top: 0 }); }, [doc?.path]);

  if (!file) {
    return (
      <div className="kb-main empty" ref={bodyRef}>
        <div className="kb-welcome">
          <h2>지식베이스</h2>
          <p>
            왼쪽에서 문서를 고르세요. 맹비서와 부서가 근거로 쓰는 것이
            그대로 여기 있습니다 — 사람이 정리한 개념 노드, arXiv 에서
            모은 논문, 부서가 만들어 결재를 통과한 산출물.
          </p>
          <div className="kb-legend">
            {(Object.keys(ORIGIN) as KbOrigin[]).slice(0, 3).map(k => (
              <span key={k} className="kb-legend-item">
                <span className={`kb-dot ${ORIGIN[k].cls}`} />
                <b>{ORIGIN[k].label}</b> {ORIGIN[k].hint}
              </span>
            ))}
          </div>
        </div>
      </div>
    );
  }

  // PDF 는 브라우저 내장 뷰어에 넘긴다. md 로 바꿔 그리려 들면 레이아웃·
  // 수식·표가 다 깨지고, 그러느라 원문을 못 보게 된다.
  if (file.kind === 'pdf') {
    /* `#zoom=80` — 브라우저 PDF 뷰어에 배율을 지정한다.
     *
     * 그냥 열면 뷰어가 창 너비에 맞춰 잡는데, 이 iframe 폭에서는 133% 가
     * 나왔다. iframe 을 더 키우기는 어려우니(앱 크롬이 위를 차지한다)
     * 안쪽 배율을 줄여 한 번에 보이는 양을 늘린다.
     *
     * `?path=` 뒤에 붙는 `#` 는 서버로 가지 않는다 — 브라우저가 뷰어에
     * 넘기는 값이라 API 요청에는 영향이 없다. */
    const url = api.knowledgeFileUrl(file.path) + '#zoom=80';
    return (
      /* `kb-main pdf` — 남은 높이를 **정확히** 채운다.
         전에는 `height: calc(100vh - 300px)` 였다. 300px 는 머리말·탭·문서
         머리글을 눈대중으로 뺀 값이라 어느 화면에서도 맞지 않았다 —
         768px 창에서 PDF 가 480px(63%)만 쓰고, 큰 화면에서는 아래가 남았다.
         flex 로 두면 크롬 높이를 몰라도 늘 남은 만큼을 쓴다. */
      <div className="kb-main pdf" ref={bodyRef}>
        <header className="kb-doc-head">
          <div className="kb-doc-badges">
            <span className="kb-badge ref">PDF 원문</span>
            <span className="kb-doc-meta">{size(file.size)} · 로컬 수정 {when(file.mtime)}</span>
          </div>
          <h1 className="kb-doc-title">{file.title}</h1>
          <div className="kb-doc-path">{file.path}</div>
        </header>
        <iframe className="kb-pdf" src={url} title={file.title} />
      </div>
    );
  }

  if (busy && !doc) {
    return <div className="kb-main" ref={bodyRef}><div className="kb-loading">불러오는 중…</div></div>;
  }
  if (doc?.error) {
    return <div className="kb-main" ref={bodyRef}><div className="kb-err">{doc.error}</div></div>;
  }
  if (!doc) return <div className="kb-main" ref={bodyRef} />;

  const body = dropDupTitle(stripFront(doc.text), doc.title);
  const o = ORIGIN[doc.origin] ?? ORIGIN.unknown;

  return (
    <div className="kb-main" ref={bodyRef}>
      <article className="kb-doc">
        <header className="kb-doc-head">
          <div className="kb-doc-badges">
            <span className={`kb-badge ${o.cls}`} title={o.hint}>{o.label}</span>
            {doc.front.type && doc.front.type !== doc.origin && (
              <span className="kb-badge dim">{doc.front.type}</span>
            )}
            <span className="kb-doc-meta">
              {size(doc.size)}
              {' · '}
              {/* 깃이 아니라 파일 시스템의 시각이다 */}
              로컬 수정 {when(doc.mtime)}
              {doc.front.created && <> · 작성 {doc.front.created}</>}
            </span>
          </div>
          <h1 className="kb-doc-title">{doc.title}</h1>
          {doc.front.description && (
            <p className="kb-doc-desc">{doc.front.description}</p>
          )}
          <div className="kb-doc-path" title="위키 루트 기준 경로">{doc.path}</div>
        </header>

        {/* 본문의 `[[slug]]` 를 눌러 이동한다. 위키링크는 실제로 많다 —
            actor-critic 한 문서에만 6개가 걸려 있다. */}
        <KbMarkdown body={body} docPath={doc.path}
                    canNav={slug => !!resolveSlug(slug)}
                    onNav={slug => {
                      const p = resolveSlug(slug);
                      if (p) onNavPath(p);
                    }} />

        {doc.neighbors.length > 0 && (
          <footer className="kb-doc-foot">
            <h3>연결된 지식 <span>{doc.neighbors.length}</span></h3>
            <div className="kb-chips">
              {doc.neighbors.map(nb => (
                nb.path
                  ? <button key={nb.slug} className="kb-chip" onClick={() => onNavPath(nb.path)}
                            title={`${nb.why} · ${nb.path}`}>{nb.title}</button>
                  // 그래프에만 있고 문서가 없는 링크. 눌리지 않게 두고
                  // 그렇다는 것을 보여 준다 — 눌러 보고 아무 일도 안
                  // 일어나는 것보다 낫다.
                  : <span key={nb.slug} className="kb-chip dead"
                          title="아직 문서가 없는 링크">{nb.title}</span>
              ))}
            </div>
          </footer>
        )}
      </article>
    </div>
  );
}

/* ── 목차 ────────────────────────────────────────────────────────── */

function KbRail({ doc }: { doc: KbDoc | null }) {
  // 뷰어와 **같은 본문**을 봐야 한다 — dropDupTitle 주석 참고.
  const hs = useMemo(
    () => (doc ? headings(dropDupTitle(stripFront(doc.text), doc.title)) : []),
    [doc]);
  if (hs.length < 3) return null;        // 둘뿐이면 목차가 본문보다 길다
  return (
    <nav className="kb-rail">
      <div className="kb-rail-title">목차</div>
      <div className="kb-rail-list">
        {hs.map(h => (
          <button key={h.id} className={`kb-rail-item l${h.level}`}
                  onClick={() => document.getElementById(h.id)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
            {h.text}
          </button>
        ))}
      </div>
    </nav>
  );
}

/* ── 탭 ──────────────────────────────────────────────────────────── */

/** 주소창의 `#knowledge/concepts/ppo.md` 에서 문서 경로만 꺼낸다.
 *
 *  탭은 App.tsx 가 해시로 기억하는데 **그 안에서 열어 둔 문서**는 기억하지
 *  않았다. 논문을 읽다가 새로고침하면 빈 환영 화면으로 돌아갔다.
 *
 *  덤으로 특정 문서를 가리키는 링크를 줄 수 있게 된다. */
function pathFromHash(): string {
  const h = decodeURIComponent(window.location.hash.replace(/^#\/?/, ''));
  if (!h.startsWith('knowledge/')) return '';
  return h.slice('knowledge/'.length);
}

export default function KnowledgeTab() {
  const [tree, setTree] = useState<KbTree | null>(null);
  const [file, setFile] = useState<KbFile | null>(null);
  const [doc, setDoc] = useState<KbDoc | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => { void api.knowledgeTree().then(setTree); }, []);

  /** 열어 둔 문서를 주소에 적는다.
   *
   *  `replaceState` 를 쓴다 — 탭 전환과 달리 문서를 넘길 때마다 히스토리에
   *  쌓으면, 뒤로가기 한 번이 **이전 탭이 아니라 이전 문서**로 가서 탭을
   *  빠져나오는 데 수십 번을 눌러야 한다. */
  const writeHash = useCallback((path: string) => {
    const next = path ? `#knowledge/${encodeURI(path)}` : '#knowledge';
    if (window.location.hash !== next) {
      window.history.replaceState(null, '', window.location.pathname + next);
    }
  }, []);

  /** slug → 경로. 위키링크와 그래프 이웃은 맨 이름(`ppo`)으로 가리키는데
   *  화면이 열어야 하는 것은 경로(`concepts/ppo.md`)다.
   *
   *  이름이 겹치면 **앞 폴더가 이긴다.** KB_TREE_DIRS 가 사람이 정리한
   *  노드를 먼저 두므로, 같은 이름이 raw 메모에도 있을 때 노드 쪽으로
   *  간다(`raw/ppo.md` 보다 `concepts/ppo.md`). 그게 위키가 의도한
   *  정본이다. */
  const slugIndex = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of tree?.folders ?? []) {
      for (const x of f.files) {
        const id = x.name.replace(/\.md$/, '');
        if (!m.has(id)) m.set(id, x.path);
      }
    }
    return m;
  }, [tree]);
  const resolveSlug = useCallback((slug: string) => slugIndex.get(slug), [slugIndex]);

  const openPath = useCallback(async (path: string) => {
    // 트리에서 파일 메타를 찾는다. 없으면(그래프에만 있는 이웃) 최소한의
    // 것을 만들어 넘긴다 — 본문은 서버가 주므로 보이기는 한다.
    const found = tree?.folders
      .flatMap(f => f.files)
      .find(x => x.path === path);
    setFile(found ?? {
      path, name: path.split('/').pop() ?? path, title: path,
      size: 0, mtime: 0, origin: 'unknown',
      // 트리에 없는 .pdf 도 PDF 로 열어야 한다. kind 가 빠지면 마크다운
      // 뷰어로 가서 "md 파일만 읽습니다" 오류가 뜬다.
      ...(path.toLowerCase().endsWith('.pdf') ? { kind: 'pdf' as const } : {}),
    });
    writeHash(path);
    if (path.toLowerCase().endsWith('.pdf')) { setDoc(null); return; }
    setBusy(true);
    setDoc(await api.knowledgeDoc(path));
    setBusy(false);
  }, [tree, writeHash]);

  /* 주소에 적힌 문서를 연다 — 새로고침·링크로 들어왔을 때.
   *
   * 트리를 받은 **뒤에** 연다. 먼저 열면 파일 메타(제목·크기·출처)를 못
   * 찾아 제목 자리에 경로가 그대로 뜬다.
   *
   * 한 번만 한다. 그 뒤에는 사장님이 고른 것이 주소를 바꾸므로, 계속
   * 지켜보면 서로 덮어쓴다. */
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !tree?.available) return;
    restored.current = true;
    const p = pathFromHash();
    if (p) void openPath(p);
  }, [tree, openPath]);

  /* 주소가 **밖에서** 바뀌면 문서도 따라간다.
   *
   * 링크를 붙여 넣거나 뒤로/앞으로를 누를 때다. 이게 없으면 주소는 PDF 를
   * 가리키는데 화면은 아까 보던 md 가 그대로 남는다 — 주소와 화면이 서로
   * 다른 것을 말하게 된다(실제로 그랬다).
   *
   * 우리가 쓴 것(replaceState)은 hashchange 를 일으키지 않으므로 서로
   * 덮어쓸 걱정은 없다. 지금 연 것과 같으면 다시 받지도 않는다. */
  const openedRef = useRef('');
  useEffect(() => { openedRef.current = file?.path ?? ''; }, [file]);
  useEffect(() => {
    const onHash = () => {
      const p = pathFromHash();
      if (p && p !== openedRef.current) void openPath(p);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [openPath]);

  const pick = useCallback((f: KbFile) => {
    setFile(f);
    writeHash(f.path);
    if (f.kind === 'pdf') { setDoc(null); return; }
    setBusy(true);
    void api.knowledgeDoc(f.path).then(d => { setDoc(d); setBusy(false); });
  }, [writeHash]);

  /* ── 맹비서에게 묻기 ────────────────────────────────────────────
     맥락으로 **경로만** 넘긴다. 본문을 붙이면 토큰을 쓰는 데다 맹비서가
     이웃 노드를 못 본다 — read_file 과 지식 그래프를 스스로 쓰게 두는
     쪽이 낫다. */
  const [asking, setAsking] = useState(false);
  /* md 는 서버가 준 abs_path 를 쓴다. PDF 는 doc 을 받지 않으므로 트리가
     준 위키 루트에 상대 경로를 붙인다 — **루트를 화면에 박아 두지
     않는다.** 박아 두면 위키를 옮긴 날 조용히 틀린 경로를 맹비서에게
     주고, 맹비서는 "파일이 없다" 고만 답한다. */
  const diskPath = (f: KbFile): string =>
    doc?.abs_path
    || (tree?.root ? `${tree.root}\\${f.path.split('/').join('\\')}` : f.path);

  const askCtx: AskContext | null = !file ? null : {
    kind: 'knowledge',
    label: file.title,
    brief: [
      '[지식베이스 문서]',
      `제목: ${file.title}`,
      `위키 기준 경로: ${file.path}`,
      `디스크 경로: ${diskPath(file)}`,
      '',
      '이 문서를 read_file 로 **직접 읽고** 답하십시오. 필요하면 지식베이스',
      '조회로 관련 문서까지 따라가십시오. 문서에 없는 것은 없다고 말하고,',
      '추측으로 메우지 마십시오.',
    ].join('\n'),
    presets: file.kind === 'pdf'
      ? ['이 논문의 핵심 기여를 3가지로 정리해줘',
         '이 논문의 방법을 단계별로 설명해줘',
         '우리 위키에 이미 있는 관련 문서와 무엇이 다른지 알려줘']
      : ['이 문서를 5줄로 요약해줘',
         '이 문서에서 빠진 것 · 더 채울 것을 지적해줘',
         '이것과 관련된 위키 문서를 찾아 연결해줘'],
  };

  return (
    <div className="kb-root">
      <KbSidebar tree={tree} cur={file?.path ?? ''} onPick={pick} />
      <KbViewer file={file} doc={doc} busy={busy}
                onNavPath={p => void openPath(p)}
                resolveSlug={resolveSlug} />
      <KbRail doc={file?.kind === 'pdf' ? null : doc} />

      {/* 떠 있는 묻기 버튼.
       *
       *  전에는 문서 머리글 안에 있었다. 논문은 길어서 **스크롤하면
       *  사라졌고**, 묻고 싶어지는 지점(중간·끝)에서는 위로 한참 올라가야
       *  했다 — "읽다가 언제든" 이 안 됐다.
       *
       *  패널이 열리면 숨긴다. 같은 자리(오른쪽 아래)에 패널이 뜨므로
       *  그대로 두면 버튼이 패널 밑에 깔린다. */}
      {file && !asking && (
        <button className="kb-ask-fab" onClick={() => setAsking(true)}
                title="보고 계신 문서에 대해 맹비서에게 묻습니다">
          <span className="kb-ask-fab-ico">🤖</span>
          <span className="kb-ask-fab-txt">맹비서에게 묻기</span>
        </button>
      )}

      {asking && askCtx && (
        <Suspense fallback={null}>
          <AskHermes ctx={askCtx} onClose={() => setAsking(false)} />
        </Suspense>
      )}
    </div>
  );
}
