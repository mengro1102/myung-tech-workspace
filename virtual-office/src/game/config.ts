export const TILE_SIZE = 32;

// 월드 크기 (카메라 스크롤 범위)
export const WORLD_WIDTH  = 52 * TILE_SIZE; // 1664px
export const WORLD_HEIGHT = 30 * TILE_SIZE; // 960px

// Phaser 뷰포트 (실제 캔버스 크기)
export const VIEW_WIDTH  = 1280;
export const VIEW_HEIGHT = 720;

export interface RoomDef {
  x: number; y: number; width: number; height: number;
  label: string;
  floorColor: number;
  wallColor: number;
  deptKey: string;
}

export const ROOMS: Record<string, RoomDef> = {
  research_dept: {
    x: 1, y: 1, width: 12, height: 10,
    label: '학술연구부', deptKey: 'research',
    floorColor: 0x1a3328, wallColor: 0x2ecc71,
  },
  orchestration_dept: {
    x: 20, y: 1, width: 12, height: 10,
    label: '오케스트레이션팀', deptKey: 'orchestration',
    floorColor: 0x332a10, wallColor: 0xf59e0b,
  },
  finance_dept: {
    x: 39, y: 1, width: 12, height: 10,
    label: '금융투자부', deptKey: 'finance',
    floorColor: 0x172040, wallColor: 0x3b82f6,
  },
  dev_dept: {
    x: 1, y: 19, width: 12, height: 10,
    label: '개발팀', deptKey: 'dev',
    floorColor: 0x2d1515, wallColor: 0xef4444,
  },
  meeting_room: {
    x: 15, y: 14, width: 16, height: 14,
    label: '회의실', deptKey: 'meeting',
    floorColor: 0x1a1a2e, wallColor: 0x888888,
  },
  content_dept: {
    x: 39, y: 19, width: 12, height: 10,
    label: '콘텐츠생산부', deptKey: 'content',
    floorColor: 0x251535, wallColor: 0xa855f7,
  },
};

// 각 부서별 캐릭터 스프라이트 색상
export const DEPT_COLORS: Record<string, { body: number; head: number; accent: number }> = {
  research:      { body: 0x27ae60, head: 0x2ecc71, accent: 0x1abc9c },
  orchestration: { body: 0xd97706, head: 0xf59e0b, accent: 0xfbbf24 },
  finance:       { body: 0x2563eb, head: 0x3b82f6, accent: 0x60a5fa },
  dev:           { body: 0xdc2626, head: 0xef4444, accent: 0xf87171 },
  content:       { body: 0x9333ea, head: 0xa855f7, accent: 0xc084fc },
  meeting:       { body: 0x64748b, head: 0x94a3b8, accent: 0xcbd5e1 },
  player:        { body: 0x0f766e, head: 0x14b8a6, accent: 0x5eead4 },
};

export const API_BASE_URL = '/api';
export const SSE_URL = '/api/events/stream';
