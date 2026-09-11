/* 연동 가이드 뷰어.
 *
 * 문서는 docs/INTEGRATIONS.md 하나로 두고, 화면에서는 필요한 절만 꺼내 본다.
 * 카드 옆의 '가이드' 를 누르면 그 연동의 절이 바로 열린다 — 문서가 있어도
 * 찾지 못하면 "물어보고 등록하는 절차" 가 그대로 남기 때문이다.
 *
 * 마크다운 전체를 렌더링하지 않는다. 이 문서가 쓰는 것은 제목·표·코드블록·
 * 목록·링크·굵게뿐이고, 그만 처리하면 라이브러리 하나를 안 들여도 된다.
 */
import { useEffect, useMemo, useState } from 'react';

const ANCHOR = /<a id="([^"]+)"><\/a>/;

/** 문서를 앵커 단위로 쪼갠다. 앵커가 없는 머리말은 'common' 으로 둔다. */
function splitSections(md: string): Record<string, string> {
  const out: Record<string, string> = {};
  let key = 'common';
  let buf: string[] = [];
  for (const line of md.split('\n')) {
    const m = line.match(ANCHOR);
    if (m) {
      out[key] = buf.join('\n').trim();
      key = m[1];
      buf = [];
      continue;
    }
    buf.push(line);
  }
  out[key] = buf.join('\n').trim();
  return out;
}

/** 인라인 마크다운(굵게·코드·링크)만 처리한 조각들 */
function inline(text: string, keyBase: string) {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*)|(`[^`]+`)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-${i++}`;
    if (tok.startsWith('**')) parts.push(<strong key={k}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) parts.push(<code key={k} className="gd-code">{tok.slice(1, -1)}</code>);
    else {
      const mm = tok.match(/\[([^\]]+)\]\(([^)]+)\)/)!;
      parts.push(<a key={k} href={mm[2]} target="_blank" rel="noreferrer">{mm[1]}</a>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/** 가벼운 마크다운 렌더러. 프로젝트 산출물 보기에서도 쓴다. */
export function Markdown({ src }: { src: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = src.split('\n');
  let i = 0;
  let n = 0;

  while (i < lines.length) {
    const line = lines[i];

    // 코드 블록
    if (line.trim().startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={n++} className="gd-pre">{body.join('\n')}</pre>);
      continue;
    }

    // 표 — 헤더 다음 줄이 구분선이면
    if (line.startsWith('|') && (lines[i + 1] ?? '').replace(/[\s|:-]/g, '') === '') {
      const head = line.split('|').slice(1, -1).map(c => c.trim());
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        rows.push(lines[i].split('|').slice(1, -1).map(c => c.trim()));
        i++;
      }
      blocks.push(
        <div key={n++} className="gd-table-wrap">
          <table className="gd-table">
            <thead><tr>{head.map((h, j) => <th key={j}>{inline(h, `h${n}${j}`)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => (
              <tr key={ri}>{r.map((c, ci) => <td key={ci}>{inline(c, `c${n}${ri}${ci}`)}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>);
      continue;
    }

    // 제목
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      blocks.push(<div key={n++} className={`gd-h gd-h${lvl}`}>{inline(h[2], `t${n}`)}</div>);
      i++;
      continue;
    }

    // 인용
    if (line.startsWith('>')) {
      const body: string[] = [];
      while (i < lines.length && lines[i].startsWith('>')) body.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={n++} className="gd-quote">{inline(body.join(' '), `q${n}`)}</blockquote>);
      continue;
    }

    // 목록 (번호 / 불릿). 들여쓴 항목은 중첩으로 넣는다 — 형제로 올리면
    // 번호가 밀려서 문서의 '5단계' 가 화면에서 7번이 된다.
    const LIST = /^(\s*)(\d+\.|[-*])\s+(.*)$/;
    const first = line.match(LIST);
    if (first) {
      const baseIndent = first[1].length;
      type Item = { text: string; children: Item[]; ordered: boolean };
      const items: Item[] = [];
      const rootOrdered = /\d/.test(first[2]);

      while (i < lines.length) {
        const m2 = lines[i].match(LIST);
        if (m2 && m2[1].length <= baseIndent) {
          items.push({ text: m2[3], children: [], ordered: /\d/.test(m2[2]) });
          i++;
          continue;
        }
        if (m2 && items.length) {                       // 더 들여쓴 = 자식
          items[items.length - 1].children.push(
            { text: m2[3], children: [], ordered: /\d/.test(m2[2]) });
          i++;
          continue;
        }
        // 목록도 아니고 들여쓴 이어지는 줄이면 마지막 항목에 붙인다
        if (!m2 && items.length && /^\s{3,}\S/.test(lines[i])) {
          const tgt = items[items.length - 1];
          const box = tgt.children.length ? tgt.children[tgt.children.length - 1] : tgt;
          box.text += ' ' + lines[i].trim();
          i++;
          continue;
        }
        break;
      }

      const render = (list: Item[], ordered: boolean, key: string) => {
        const L = ordered ? 'ol' : 'ul';
        return (
          <L key={key} className="gd-list">
            {list.map((it, j) => (
              <li key={j}>
                {inline(it.text, `${key}-${j}`)}
                {it.children.length > 0 &&
                  render(it.children, it.children[0].ordered, `${key}-${j}-c`)}
              </li>
            ))}
          </L>
        );
      };
      blocks.push(render(items, rootOrdered, `l${n++}`));
      continue;
    }

    if (line.trim() === '---') { blocks.push(<hr key={n++} className="gd-hr" />); i++; continue; }
    if (line.trim() === '') { i++; continue; }

    // 문단 — 빈 줄까지 이어 붙인다
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !/^(#|\||>|```|\s*(\d+\.|[-*])\s)/.test(lines[i])) {
      para.push(lines[i++]);
    }
    blocks.push(<p key={n++} className="gd-p">{inline(para.join(' '), `p${n}`)}</p>);
  }
  return <>{blocks}</>;
}

export default function GuideModal({ anchor, onClose }: {
  /** 열자마자 보여 줄 절. 없으면 공통 안내부터 */
  anchor?: string;
  onClose: () => void;
}) {
  const [md, setMd] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState(anchor || 'common');

  useEffect(() => {
    fetch('/api/docs/integrations')
      .then(r => r.json())
      .then(d => (d.markdown ? setMd(d.markdown) : setErr(d.error || '문서를 받지 못했습니다')))
      .catch(() => setErr('백엔드에 연결하지 못했습니다 (127.0.0.1:9000)'));
  }, []);

  const sections = useMemo(() => (md ? splitSections(md) : {}), [md]);
  const keys = useMemo(() => Object.keys(sections), [sections]);

  /* 절 이름을 사람이 읽을 라벨로. 문서의 첫 제목 줄에서 뽑는다 —
     여기서 따로 관리하면 문서를 고칠 때 어긋난다. */
  const label = (k: string) => {
    if (k === 'common') return '공통';
    const first = (sections[k] || '').split('\n').find(l => l.startsWith('#'));
    return first ? first.replace(/^#+\s*/, '').split('—')[0].trim() : k;
  };

  return (
    <div className="hm-backdrop" onClick={onClose}>
      <div className="hm-panel gd-panel" onClick={e => e.stopPropagation()}>
        <div className="hm-header">
          <span className="hm-title">📖 연동 가이드</span>
          <span className="hm-subtitle">docs/INTEGRATIONS.md</span>
          <button className="hm-close" onClick={onClose} aria-label="닫기">✕</button>
        </div>

        {err && <div className="gd-err">{err}</div>}
        {!md && !err && <div className="gd-empty">불러오는 중…</div>}

        {md && (
          <>
            <div className="gd-tabs">
              {keys.map(k => (
                <button key={k} className={`gd-tab ${tab === k ? 'active' : ''}`}
                        onClick={() => setTab(k)}>{label(k)}</button>
              ))}
            </div>
            <div className="gd-body">
              <Markdown src={sections[tab] ?? ''} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
