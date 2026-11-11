/* 위키 문서의 LaTeX 를 전수로 파싱해 본다 — 화면에서 빨갛게 깨질 것을 미리 찾는다.
 *
 *     npm run check-math                 # 기본 위키 경로
 *     npm run check-math -- D:/다른/위키
 *
 * ## 왜 이게 있나
 *
 * 2026-11-07, 사장님: "지식베이스에서 수식이 인식이 안 된다."
 * 눈으로 한 건 보고 "렌더러가 고장" 이라고 답하기 쉬운 자리였다. 전수로 재
 * 봤더니 **수식 5,651개 중 깨진 것은 56개(1.0%)** 였고, 원인이 둘로 갈렸다.
 *
 *   8개  우리 글의 오타       → 문서를 고쳤다(역슬래시가 두 겹, \text 안의 _)
 *  48개  KaTeX 가 모르는 정상 LaTeX → 그릴 때만 바꿔 준다(MathText.tsx)
 *
 * 한 건만 보고 고쳤으면 둘 중 하나는 통째로 놓쳤다. 그래서 이 스크립트를
 * 남긴다 — 다음에 또 "수식이 안 보인다" 가 오면 **먼저 이걸 돌린다.**
 *
 * KaTeX 는 이 프로젝트에만 있다(위키는 파이썬이다). 그래서 검사기도 여기 산다.
 */
import katex from 'katex';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const KB = resolve(process.argv[2] || 'D:/AI_Workspace/mrlee-wiki-graphrag');
const MATHTEXT = new URL('../src/components/MathText.tsx', import.meta.url);

/* ── 화면과 같은 값을 써야 검사가 의미 있다 ──────────────────────────
 * 원본은 MathText.tsx 다. 여기 적힌 것은 사본이고, 아래에서 **원본에 아직
 * 그대로 있는지 확인한다** — 한쪽만 고치면 이 검사는 거짓말이 된다. */
const MACROS = {
  '\\textsc': '\\textrm{#1}',
  '\\mbox': '\\text{#1}',
  '\\qed': '\\blacksquare',
  '\\Lex': '\\mathrm{Lex}',
};
const normalize = t => t
  .replace(/\\color\[[a-zA-Z]+\]\{[^}]*\}/g, '')
  .replace(/(\\begin\{(?:array|tabular)\})\[[^\]]*\]/g, '$1');

function assertInSync() {
  let src;
  try { src = readFileSync(MATHTEXT, 'utf8'); } catch { return; }
  const missing = Object.keys(MACROS).filter(k => !src.includes(`'${k.replace(/\\/g, '\\\\')}'`));
  if (missing.length) {
    console.error(`⚠️  MathText.tsx 와 어긋났습니다 — 여기엔 있고 거기엔 없는 매크로: ${missing.join(', ')}`);
    console.error('    둘 중 하나만 고쳤습니다. 맞춰 두십시오.');
    process.exitCode = 2;
  }
}

/** MathText.tsx 의 takeMathBlock 과 같은 규칙. */
function takeMathBlock(lines, i) {
  const first = lines[i];
  const at = first.indexOf('$$');
  if (at < 0 || first.slice(0, at).trim()) return null;
  const rest = first.slice(at + 2);
  const close = rest.indexOf('$$');
  if (close >= 0) return rest.slice(close + 2).trim() ? null : [rest.slice(0, close).trim(), i + 1];
  const body = [];
  if (rest.trim()) body.push(rest);
  for (let j = i + 1; j < lines.length; j++) {
    const k = lines[j].indexOf('$$');
    if (k < 0) { body.push(lines[j]); continue; }
    if (lines[j].slice(0, k).trim()) body.push(lines[j].slice(0, k));
    return [body.join('\n').trim(), j + 1];
  }
  return null;   // 울타리가 안 닫혔다 — 화면도 평문으로 두므로 검사하지 않는다
}

function markdownFiles(dir) {
  const out = [];
  (function walk(d) {
    for (const n of readdirSync(d)) {
      if (n === '.git' || n === 'node_modules' || n === 'graph') continue;
      const p = join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.md')) out.push(p);
    }
  })(dir);
  return out;
}

if (!existsSync(KB)) {
  console.error(`위키를 못 찾았습니다: ${KB}`);
  process.exit(2);
}

assertInSync();

// `\$` 는 글자 그대로의 달러다(논문이 금액을 적을 때 쓴다) — 닫는 울타리로
// 보지 않는다. 화면(KnowledgeTab.tsx)과 같은 규칙이라야 검사가 의미 있다.
const INLINE = /\$((?:[^$\n\\]|\\.)+)\$/g;
const rows = [];
let total = 0;

const check = (tex, display, f, line, kind) => {
  total++;
  try {
    katex.renderToString(normalize(tex), {
      displayMode: display, throwOnError: true, strict: false, trust: false, macros: { ...MACROS },
    });
  } catch (e) {
    rows.push({ f: relative(KB, f), line, kind, tex: tex.slice(0, 110), why: String(e.message).slice(0, 90) });
  }
};

const files = markdownFiles(KB);
for (const f of files) {
  const lines = readFileSync(f, 'utf8').split('\n');
  let inFence = false;
  for (let i = 0; i < lines.length; ) {
    if (/^\s*```/.test(lines[i])) { inFence = !inFence; i++; continue; }
    if (inFence) { i++; continue; }   // 코드 블록의 `$` 는 수식이 아니다
    const blk = takeMathBlock(lines, i);
    if (blk) { check(blk[0], true, f, i + 1, 'block'); i = blk[1]; continue; }
    for (const m of lines[i].matchAll(INLINE)) check(m[1], false, f, i + 1, 'inline');
    i++;
  }
}

console.log(`문서 ${files.length}건 · 수식 ${total}개 · 깨진 것 ${rows.length}개`);
if (rows.length) {
  const byFile = {};
  for (const r of rows) (byFile[r.f] ??= []).push(r);
  for (const [f, rs] of Object.entries(byFile).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`\n### ${f}  (${rs.length}개)`);
    for (const r of rs.slice(0, 4)) console.log(`  L${r.line} ${r.kind}  ${r.why}\n     ${r.tex}`);
    if (rs.length > 4) console.log(`  … 외 ${rs.length - 4}개`);
  }
  process.exitCode = 1;
}
