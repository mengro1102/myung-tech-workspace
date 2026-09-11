import { DEPT_COLORS } from '../deptTheme';
/* 오피스 평면도.
 *
 * 좌표는 전부 16px 타일 단위다. 화면 픽셀은 렌더러가 배율을 곱해 만든다.
 *
 * 가구는 **왼쪽-아래 타일**로 위치를 준다(`col`,`row`). 스프라이트는 대개
 * 발자국보다 위로 솟아 있어서(책상 위 모니터, 벽에 걸린 화이트보드) 아래를
 * 기준으로 잡아야 배치가 직관적이다. 벽 장식은 벽 타일 행에 놓으면 벽면 위로
 * 올라간다.
 */

export const GRID_W = 60;
export const GRID_H = 34;

export interface Placement {
  id: string;          // 스프라이트 id (예: DESK_FRONT)
  col: number;         // 왼쪽 타일
  row: number;         // 아래쪽 타일
  flip?: boolean;      // 좌우 반전 (…_SIDE 스프라이트용)
}

export type Facing = 'up' | 'down' | 'left' | 'right';

export interface Seat {
  col: number;
  row: number;
  face: Facing;
}

export interface RoomDef {
  dept: string;
  label: string;
  /** 벽을 포함한 사각형 */
  x: number; y: number; w: number; h: number;
  floorPattern: number;
  floorColor: string;
  wallColor: string;
  accent: string;
  carpet?: { x: number; y: number; w: number; h: number; color: string; variant: number };
  /** 방 안을 가로지르는 칸막이 벽. doors 로 지정한 열은 뚫린다. */
  partitions?: Array<{ row: number; from: number; to: number; doors: number[] }>;
  /** 복도로 통하는 출입구. 벽을 뚫어 바닥으로 만든다. */
  doors: Array<[number, number]>;
  /** 회의실까지 가는 길. 복도를 거쳐야 하므로 직선으로는 못 간다.
   *  마지막 점은 회의실 안이다. 돌아올 때는 뒤집어 쓴다. */
  toMeeting: Array<[number, number]>;
  furniture: Placement[];
  seats: Seat[];
}

/** 책상 한 세트 — 책상 + PC + 의자, 그리고 그 의자에 앉는 자리.
 *  같은 배치를 열두 번 쓰므로 한 번만 적는다. */
function station(col: number, row: number): { furniture: Placement[]; seat: Seat } {
  return {
    furniture: [
      { id: 'DESK_FRONT', col, row },
      // PC 는 책상 '위'에 놓인다. 책상 스프라이트는 48x32 지만 상판은 아래 16px
      // 뿐이라, PC 를 한 칸 위에 두면 허공에 뜬다 — 바닥 행을 책상과 맞춘다.
      { id: 'PC_FRONT_ON_1', col: col + 1, row },
      { id: 'WOODEN_CHAIR_BACK', col: col + 1, row: row + 2 },
    ],
    seat: { col: col + 1, row: row + 2, face: 'up' },
  };
}

function stations(defs: Array<[number, number]>): { furniture: Placement[]; seats: Seat[] } {
  const furniture: Placement[] = [];
  const seats: Seat[] = [];
  for (const [c, r] of defs) {
    const s = station(c, r);
    furniture.push(...s.furniture);
    seats.push(s.seat);
  }
  return { furniture, seats };
}

const research = stations([[3, 4], [9, 4], [14, 4]]);
const finance  = stations([[3, 19], [9, 19], [14, 19]]);
const dev      = stations([[43, 4], [49, 4], [54, 4]]);
const content  = stations([[43, 19], [49, 19], [54, 19]]);

export const ROOMS: RoomDef[] = [
  {
    dept: 'research_dept', label: '학술연구부',
    x: 1, y: 1, w: 18, h: 14,
    floorPattern: 2, floorColor: '#3f4d69', wallColor: '#647aa0', accent: DEPT_COLORS.research_dept,
    carpet: { x: 4, y: 9, w: 7, h: 4, color: '#5a86c0', variant: 0 },
    doors: [[18, 8]],
    toMeeting: [[18, 8], [20, 8], [20, 24], [22, 24]],
    furniture: [
      { id: 'DOUBLE_BOOKSHELF', col: 3, row: 1 },
      { id: 'LARGE_PAINTING', col: 9, row: 1 },
      { id: 'CLOCK', col: 14, row: 1 },
      ...research.furniture,
      { id: 'SOFA_FRONT', col: 4, row: 10 },
      { id: 'COFFEE_TABLE', col: 7, row: 12 },
      { id: 'LARGE_PLANT', col: 15, row: 13 },
      { id: 'BIN', col: 2, row: 13 },
      { id: 'COFFEE', col: 12, row: 13 },
    ],
    seats: [...research.seats, { col: 5, row: 10, face: 'down' }],
  },
  {
    dept: 'finance_dept', label: '금융투자부',
    x: 1, y: 16, w: 18, h: 17,
    floorPattern: 1, floorColor: '#5e4d2c', wallColor: '#8d7440', accent: DEPT_COLORS.finance_dept,
    carpet: { x: 4, y: 25, w: 7, h: 5, color: '#c09140', variant: 1 },
    doors: [[18, 24]],
    toMeeting: [[18, 24], [20, 24], [22, 24]],
    furniture: [
      { id: 'BOOKSHELF', col: 3, row: 16 },
      { id: 'SMALL_PAINTING', col: 8, row: 16 },
      { id: 'SMALL_PAINTING_2', col: 10, row: 16 },
      { id: 'HANGING_PLANT', col: 15, row: 16 },
      ...finance.furniture,
      { id: 'SMALL_TABLE_FRONT', col: 5, row: 28 },
      { id: 'CUSHIONED_CHAIR_SIDE', col: 4, row: 28 },
      { id: 'CUSHIONED_CHAIR_SIDE', col: 7, row: 28, flip: true },
      { id: 'LARGE_PLANT', col: 15, row: 31 },
      { id: 'CACTUS', col: 2, row: 31 },
      { id: 'BIN', col: 17, row: 31 },
    ],
    seats: [...finance.seats, { col: 4, row: 28, face: 'right' }],
  },
  {
    dept: 'orchestration_dept', label: 'CEO실 · 회의실',
    x: 21, y: 1, w: 18, h: 32,
    floorPattern: 4, floorColor: '#35594a', wallColor: '#4d7d64', accent: DEPT_COLORS.orchestration_dept,
    carpet: { x: 26, y: 20, w: 8, h: 8, color: '#4aa377', variant: 2 },
    doors: [[21, 8], [38, 8], [21, 24], [38, 24]],
    // CEO 실에서 회의실로는 칸막이 문만 지나면 된다.
    toMeeting: [[29, 12], [29, 16]],
    // CEO 집무실과 회의실을 벽으로 나눈다. 가운데 두 칸이 문이다.
    partitions: [{ row: 14, from: 21, to: 38, doors: [29, 30] }],
    furniture: [
      // ── CEO 집무실 (위) ──
      { id: 'CLOCK', col: 23, row: 1 },
      { id: 'LARGE_PAINTING', col: 28, row: 1 },
      { id: 'DOUBLE_BOOKSHELF', col: 33, row: 1 },
      { id: 'DESK_FRONT', col: 28, row: 5 },
      { id: 'PC_FRONT_ON_1', col: 29, row: 5 },
      { id: 'WOODEN_CHAIR_BACK', col: 29, row: 7 },
      { id: 'SOFA_SIDE', col: 24, row: 11 },
      { id: 'COFFEE_TABLE', col: 25, row: 11 },
      { id: 'SOFA_SIDE', col: 27, row: 11, flip: true },
      { id: 'LARGE_PLANT', col: 35, row: 13 },
      { id: 'BIN', col: 22, row: 13 },
      // ── 회의실 (아래) ── 벽에 화이트보드를 걸어야 회의실로 읽힌다
      { id: 'CLOCK', col: 23, row: 14 },
      { id: 'WHITEBOARD', col: 25, row: 14 },
      { id: 'LARGE_PAINTING', col: 33, row: 14 },
      { id: 'PLANT', col: 22, row: 18 },
      { id: 'PLANT_2', col: 37, row: 18 },
      { id: 'TABLE_FRONT', col: 28, row: 25 },
      { id: 'WOODEN_CHAIR_BACK', col: 29, row: 22 },
      { id: 'CUSHIONED_CHAIR_SIDE', col: 27, row: 23 },
      { id: 'CUSHIONED_CHAIR_SIDE', col: 27, row: 25 },
      { id: 'CUSHIONED_CHAIR_SIDE', col: 31, row: 23, flip: true },
      { id: 'CUSHIONED_CHAIR_SIDE', col: 31, row: 25, flip: true },
      { id: 'WOODEN_CHAIR_FRONT', col: 29, row: 27 },
      { id: 'SMALL_TABLE_FRONT', col: 34, row: 30 },
      { id: 'LARGE_PLANT', col: 22, row: 31 },
      { id: 'BIN', col: 37, row: 31 },
    ],
    seats: [
      { col: 29, row: 7, face: 'up' },        // CEO 책상
      { col: 24, row: 11, face: 'right' },    // 응접 소파
      { col: 29, row: 22, face: 'up' },       // ── 여기부터 회의 테이블 ──
      { col: 27, row: 23, face: 'right' },
      { col: 27, row: 25, face: 'right' },
      { col: 31, row: 23, face: 'left' },
      { col: 31, row: 25, face: 'left' },
      { col: 29, row: 27, face: 'down' },
    ],
  },
  {
    dept: 'dev_dept', label: '개발실',
    x: 41, y: 1, w: 18, h: 14,
    floorPattern: 3, floorColor: '#4a4370', wallColor: '#6d5c9b', accent: DEPT_COLORS.dev_dept,
    carpet: { x: 45, y: 9, w: 7, h: 4, color: '#8468c9', variant: 0 },
    doors: [[41, 8]],
    toMeeting: [[41, 8], [39, 8], [39, 24], [37, 24]],
    furniture: [
      { id: 'DOUBLE_BOOKSHELF', col: 43, row: 1 },
      { id: 'LARGE_PAINTING', col: 49, row: 1 },
      { id: 'CLOCK', col: 54, row: 1 },
      ...dev.furniture,
      { id: 'SMALL_TABLE_FRONT', col: 45, row: 12 },
      { id: 'CUSHIONED_CHAIR_SIDE', col: 44, row: 12 },
      { id: 'CUSHIONED_CHAIR_SIDE', col: 47, row: 12, flip: true },
      { id: 'LARGE_PLANT', col: 56, row: 13 },
      { id: 'BIN', col: 42, row: 13 },
      { id: 'COFFEE', col: 52, row: 13 },
    ],
    seats: [...dev.seats, { col: 44, row: 12, face: 'right' }],
  },
  {
    dept: 'content_dept', label: '콘텐츠생산부',
    x: 41, y: 16, w: 18, h: 17,
    floorPattern: 2, floorColor: '#603a4f', wallColor: '#8d4d6d', accent: DEPT_COLORS.content_dept,
    carpet: { x: 45, y: 25, w: 7, h: 5, color: '#c96594', variant: 1 },
    doors: [[41, 24]],
    toMeeting: [[41, 24], [39, 24], [37, 24]],
    furniture: [
      { id: 'BOOKSHELF', col: 43, row: 16 },
      { id: 'SMALL_PAINTING', col: 48, row: 16 },
      { id: 'SMALL_PAINTING_2', col: 50, row: 16 },
      { id: 'HANGING_PLANT', col: 55, row: 16 },
      ...content.furniture,
      { id: 'SOFA_FRONT', col: 44, row: 27 },
      { id: 'SOFA_FRONT', col: 47, row: 27 },
      { id: 'COFFEE_TABLE', col: 45, row: 30 },
      { id: 'PLANT', col: 42, row: 31 },
      { id: 'PLANT_2', col: 57, row: 31 },
      { id: 'CACTUS', col: 52, row: 31 },
    ],
    seats: [...content.seats, { col: 45, row: 27, face: 'down' }],
  },
];

export const CORRIDOR = {
  floorPattern: 1,
  floorColor: '#333849',
};

/* ── 타일맵 ──────────────────────────────────────────────────────────────
 * 벽 자동 타일링과 이동 판정에 쓴다. 방마다 테두리가 벽이고, 칸막이가 있으면
 * 그 행도 벽이다(문으로 지정한 칸은 뚫는다). */
export const TILE_CORRIDOR = 0;
export const TILE_FLOOR = 1;
export const TILE_WALL = 2;

export interface TileMap {
  tiles: Uint8Array;
  /** 타일이 속한 방의 ROOMS 인덱스. 복도는 -1. */
  roomAt: Int8Array;
}

export function buildTileMap(): TileMap {
  const tiles = new Uint8Array(GRID_W * GRID_H);          // 기본값 = 복도
  const roomAt = new Int8Array(GRID_W * GRID_H).fill(-1);

  ROOMS.forEach((room, ri) => {
    for (let r = room.y; r < room.y + room.h; r++) {
      for (let c = room.x; c < room.x + room.w; c++) {
        if (c < 0 || c >= GRID_W || r < 0 || r >= GRID_H) continue;
        const i = r * GRID_W + c;
        const onEdge = c === room.x || c === room.x + room.w - 1
                    || r === room.y || r === room.y + room.h - 1;
        tiles[i] = onEdge ? TILE_WALL : TILE_FLOOR;
        roomAt[i] = ri;
      }
    }
    for (const [c, r] of room.doors) {
      tiles[r * GRID_W + c] = TILE_FLOOR;
    }
    for (const p of room.partitions ?? []) {
      for (let c = p.from; c <= p.to; c++) {
        if (p.doors.includes(c)) continue;
        tiles[p.row * GRID_W + c] = TILE_WALL;
      }
    }
  });

  return { tiles, roomAt };
}

/** 벽 자동 타일링용 4비트 마스크 (N=1 E=2 S=4 W=8). */
export function wallMask(tiles: Uint8Array, col: number, row: number): number {
  const at = (c: number, r: number) =>
    c >= 0 && c < GRID_W && r >= 0 && r < GRID_H && tiles[r * GRID_W + c] === TILE_WALL;
  return (at(col, row - 1) ? 1 : 0)
       | (at(col + 1, row) ? 2 : 0)
       | (at(col, row + 1) ? 4 : 0)
       | (at(col - 1, row) ? 8 : 0);
}

/** 카펫은 타일이 아니라 교차점 단위로 깔린다. 교차점 (jc, jr) 을 둘러싼 네 칸이
 *  카펫인지로 4비트를 만든다 (NW=1, NE=2, SE=4, SW=8). */
export function carpetCase(
  inside: (col: number, row: number) => boolean,
  jc: number, jr: number,
): number {
  return (inside(jc - 1, jr - 1) ? 1 : 0)
       | (inside(jc, jr - 1) ? 2 : 0)
       | (inside(jc, jr) ? 4 : 0)
       | (inside(jc - 1, jr) ? 8 : 0);
}

/** 회의 테이블 자리. 회의를 소집하면 전 부서가 여기로 모인다.
 *  ROOMS 의 오케스트레이션 방 seats 중 테이블 주변만 골라 둔 것이다. */
export const MEETING_SEATS: Seat[] = [
  { col: 29, row: 22, face: 'up' },
  { col: 27, row: 23, face: 'right' },
  { col: 31, row: 23, face: 'left' },
  { col: 27, row: 25, face: 'right' },
  { col: 31, row: 25, face: 'left' },
  { col: 29, row: 27, face: 'down' },
];
