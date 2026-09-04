/* 오피스 스프라이트 로더.
 *
 * 지금까지는 아바타·가구·바닥을 전부 fillRect 로 손수 그렸다. 사람으로 읽히게
 * 하려고 실루엣을 깎고 외곽선을 두르는 데까지 갔지만, 결국 직접 그린 도형은
 * 도형이다. 그래서 검증된 픽셀 아트를 가져와 쓴다.
 *
 *   가구·바닥·벽·카펫 : pixel-agents (MIT, (c) 2026 Pablo De Lucca)
 *   캐릭터            : JIK-A-4 MetroCity Free Topdown Character Pack (CC0)
 *
 * 출처와 라이선스 전문은 public/assets/office/ATTRIBUTION.md 에 있다.
 *
 * 원본 시트 규격을 그대로 따른다. 규격을 바꾸면 이 파일만 고치면 된다.
 */

export const TILE = 16;

/** 캐릭터 시트: 16x32 프레임 7개 x 3행(down/up/right). */
export const CHAR_W = 16;
export const CHAR_H = 32;
export const CHAR_ROW = { down: 0, up: 1, right: 2 } as const;
export type CharRow = keyof typeof CHAR_ROW;

/** 프레임 인덱스. left 는 right 를 좌우 반전해서 만든다. */
export const FRAME = {
  walk:    [0, 1, 2, 1] as const,   // 0-1-2-1 로 돌려야 걸음이 자연스럽다
  typing:  [3, 4] as const,
  reading: [5, 6] as const,
};

const BASE = 'assets/office';

export interface FurnSprite {
  img: HTMLImageElement;
  w: number;   // 픽셀
  h: number;
  fw: number;  // 타일 단위 발자국
  fh: number;
}

export interface OfficeAssets {
  chars: HTMLImageElement[];
  floors: HTMLImageElement[];
  wall: HTMLImageElement;
  carpets: HTMLImageElement[];
  furniture: Map<string, FurnSprite>;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`이미지를 불러오지 못했습니다: ${url}`));
    img.src = url;
  });
}

/* 매니페스트는 단일 스프라이트(asset)와 방향/상태/애니메이션 그룹(group)이
 * 섞여 있다. 우리는 방향별 정지 이미지만 쓰므로 트리를 평탄화해서 id → 파일로
 * 만든다. 애니메이션 그룹은 첫 프레임만, 상태 그룹은 'on' 을 고른다. */
interface ManifestNode {
  type: 'asset' | 'group';
  id?: string;
  file?: string;
  width?: number;
  height?: number;
  footprintW?: number;
  footprintH?: number;
  groupType?: string;
  state?: string;
  members?: ManifestNode[];
}

function flatten(node: ManifestNode, out: ManifestNode[]): void {
  if (node.type === 'asset' && node.file) {
    out.push(node);
    return;
  }
  const members = node.members ?? [];
  if (node.groupType === 'animation') {
    if (members[0]) flatten(members[0], out);       // 첫 프레임만
    return;
  }
  if (node.groupType === 'state') {
    const on = members.find(m => m.state !== 'off') ?? members[0];
    if (on) flatten(on, out);
    return;
  }
  for (const m of members) flatten(m, out);
}

const FURNITURE_IDS = [
  'BIN', 'BOOKSHELF', 'CACTUS', 'CLOCK', 'COFFEE', 'COFFEE_TABLE',
  'CUSHIONED_BENCH', 'CUSHIONED_CHAIR', 'DESK', 'DOUBLE_BOOKSHELF',
  'HANGING_PLANT', 'LARGE_PAINTING', 'LARGE_PLANT', 'PC', 'PLANT', 'PLANT_2',
  'POT', 'SMALL_PAINTING', 'SMALL_PAINTING_2', 'SMALL_TABLE', 'SOFA',
  'TABLE_FRONT', 'WHITEBOARD', 'WOODEN_BENCH', 'WOODEN_CHAIR',
];

let cached: Promise<OfficeAssets> | null = null;

export function loadOfficeAssets(): Promise<OfficeAssets> {
  if (cached) return cached;
  cached = (async () => {
    const [chars, floors, wall, carpets] = await Promise.all([
      Promise.all([0, 1, 2, 3, 4, 5].map(i => loadImage(`${BASE}/characters/char_${i}.png`))),
      Promise.all([0, 1, 2, 3, 4, 5, 6, 7, 8].map(i => loadImage(`${BASE}/floors/floor_${i}.png`))),
      loadImage(`${BASE}/walls/wall_0.png`),
      Promise.all([0, 1, 2].map(i => loadImage(`${BASE}/carpets/carpet_${i}.png`))),
    ]);

    const furniture = new Map<string, FurnSprite>();
    await Promise.all(FURNITURE_IDS.map(async id => {
      const dir = `${BASE}/furniture/${id}`;
      const manifest: ManifestNode = await fetch(`${dir}/manifest.json`).then(r => r.json());
      // 단일 스프라이트는 파일명이 매니페스트에 없다 — id 와 같다.
      if (manifest.type === 'asset' && !manifest.file) manifest.file = `${manifest.id}.png`;
      const leaves: ManifestNode[] = [];
      flatten(manifest, leaves);
      await Promise.all(leaves.map(async leaf => {
        if (!leaf.file || !leaf.id) return;
        const img = await loadImage(`${dir}/${leaf.file}`);
        furniture.set(leaf.id, {
          img,
          w: leaf.width ?? img.width,
          h: leaf.height ?? img.height,
          fw: leaf.footprintW ?? Math.round(img.width / TILE),
          fh: leaf.footprintH ?? Math.round(img.height / TILE),
        });
      }));
    }));

    return { chars, floors, wall, carpets, furniture };
  })();
  return cached;
}

/* ── 틴트 ────────────────────────────────────────────────────────────────
 *
 * 바닥·벽·카펫 시트는 회색조다. 방마다 색을 입혀야 하는데, 포토샵 Colorize 를
 * 그대로 구현할 필요는 없다. 회색조에 곱하기(multiply)를 걸면 흰색은 대상 색이
 * 되고 어두운 픽셀은 그만큼 어두워진다 — 명암이 그대로 남는다.
 * 결과는 타일마다 한 번만 만들어 캐시한다. 매 프레임 만들면 안 된다.
 */
const tintCache = new Map<string, HTMLCanvasElement>();

export function tint(img: HTMLImageElement, color: string, key: string): HTMLCanvasElement {
  const hit = tintCache.get(key);
  if (hit) return hit;

  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  const g = c.getContext('2d')!;
  g.imageSmoothingEnabled = false;
  g.drawImage(img, 0, 0);
  g.globalCompositeOperation = 'multiply';
  g.fillStyle = color;
  g.fillRect(0, 0, c.width, c.height);
  // 곱하기는 투명 영역도 칠한다. 원본 알파로 다시 오려낸다.
  g.globalCompositeOperation = 'destination-in';
  g.drawImage(img, 0, 0);

  tintCache.set(key, c);
  return c;
}

/** 벽 비트마스크(N=1 E=2 S=4 W=8) → 시트 안의 조각 위치. 조각은 16x32 이고
 *  타일보다 16px 위로 튀어나온다. 그 튀어나온 부분이 벽면이다. */
export const WALL_PIECE_W = 16;
export const WALL_PIECE_H = 32;
export function wallPieceRect(mask: number): { sx: number; sy: number } {
  return { sx: (mask % 4) * WALL_PIECE_W, sy: Math.floor(mask / 4) * WALL_PIECE_H };
}

/** 카펫은 타일이 아니라 '교차점' 단위로 깔린다. 4비트는 교차점을 둘러싼 네 칸
 *  (NW=1, NE=2, SE=4, SW=8) 이 카펫인지를 나타낸다. */
export function carpetPieceRect(msCase: number): { sx: number; sy: number } {
  return { sx: (msCase % 4) * TILE, sy: Math.floor(msCase / 4) * TILE };
}
