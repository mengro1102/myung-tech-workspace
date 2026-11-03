/* 가구 매니페스트 25개를 한 파일로 묶는다.
 *
 * 사무실을 열 때마다 `furniture/<ID>/manifest.json` 을 ID 마다 하나씩 받았다 —
 * 25번의 왕복으로 합쳐 10KB 를 받는 셈이다. 내용은 빌드 때 이미 다 정해져 있다.
 * 묶어 두면 요청 1번이다. (PNG 54장은 그대로다 — 그건 아틀라스를 만들어야
 * 줄고, 한 번 받으면 캐시된다. 지금 줄이는 것은 JSON 왕복뿐이다.)
 *
 * `predev` · `prebuild` 에서 돌아가니 매니페스트를 고치면 자동으로 다시 묶인다.
 * 결과 파일도 커밋한다 — 새로 클론한 사람이 스크립트를 안 돌려도 뜨게.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'public/assets/office/furniture');
const OUT = join(DIR, 'manifests.json');

const ids = readdirSync(DIR)
  .filter(n => statSync(join(DIR, n)).isDirectory())
  .sort();

const bundle = {};
for (const id of ids) {
  const p = join(DIR, id, 'manifest.json');
  try {
    bundle[id] = JSON.parse(readFileSync(p, 'utf8'));
  } catch (e) {
    console.error(`[manifest] ${id}: ${e.message}`);
    process.exit(1);
  }
}

writeFileSync(OUT, JSON.stringify(bundle) + '\n');
console.log(`[manifest] ${ids.length}개 -> public/assets/office/furniture/manifests.json`
          + ` (${(JSON.stringify(bundle).length / 1024).toFixed(1)}KB)`);
