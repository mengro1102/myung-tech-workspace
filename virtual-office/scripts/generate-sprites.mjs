/**
 * Pixel-art sprite generator for 명테크 가상 오피스
 * Generates 32x48 PNG sprites for all character types
 * Usage: node scripts/generate-sprites.mjs
 */

import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '../public/sprites');
mkdirSync(OUT_DIR, { recursive: true });

// --- Palette definitions ---
const T = null; // transparent

// Skin tones
const SKIN    = '#F5CBA7';
const SKIN_D  = '#D4A574';
const SKIN_S  = '#C8956E';

// Common
const EYE     = '#1A1A2E';
const EYE_H   = '#FFFFFF';
const SHOE    = '#111111';
const PANTS   = '#2C3E50';
const PANTS_D = '#1A252F';

// Department body colors
const DEPT = {
  player:        { body:'#0F766E', bodyD:'#0A5C56', hair:'#2C3E50', accent:'#14B8A6' },
  research:      { body:'#27AE60', bodyD:'#1E8449', hair:'#2C3E50', accent:'#2ECC71' },
  orchestration: { body:'#D97706', bodyD:'#B7630A', hair:'#1A1A2E', accent:'#F59E0B' },
  finance:       { body:'#2563EB', bodyD:'#1D4ED8', hair:'#3D2B1F', accent:'#3B82F6' },
  dev:           { body:'#DC2626', bodyD:'#B91C1C', hair:'#1A1A2E', accent:'#EF4444' },
  content:       { body:'#9333EA', bodyD:'#7C3AED', hair:'#2C3E50', accent:'#A855F7' },
  meeting:       { body:'#64748B', bodyD:'#475569', hair:'#3D2B1F', accent:'#94A3B8' },
};

// Scale: each grid cell = 4x4 pixels → 8x12 grid = 32x48px sprite
const S = 4;

function hex(c) {
  if (!c) return null;
  const n = parseInt(c.replace('#',''), 16);
  return [(n>>16)&255, (n>>8)&255, n&255, 255];
}

function drawPixel(ctx, gx, gy, color) {
  if (!color) return;
  const [r,g,b,a] = typeof color === 'string' ? hex(color) : color;
  ctx.fillStyle = `rgba(${r},${g},${b},${a/255})`;
  ctx.fillRect(gx*S, gy*S, S, S);
}

function drawRow(ctx, gy, row, palette) {
  for (let gx = 0; gx < row.length; gx++) {
    const k = row[gx];
    if (k === '.' || !palette[k]) continue;
    drawPixel(ctx, gx, gy, palette[k]);
  }
}

// ── Character grids (8 wide × 12 tall) ──────────────────────────

const WORKER_GRID = [
  '..RRRR..',   // 0 hair top
  '.RRRRRR.',   // 1 hair
  '.HHHHHH.',   // 2 head
  '.HeEeEH.',   // 3 eyes (e=white, E=pupil)
  '.HHHHHH.',   // 4 nose area
  '.HsMMs.',    // 5 mouth (M=mouth, s=shadow)
  '..SSSS..',   // 6 neck
  '.BBBBBB.',   // 7 body
  'bBBBBBBb',   // 8 body wide
  '..PPPP..',   // 9 pants
  '.PP..PP.',   // 10 legs
  '.TT..TT.',   // 11 shoes
];

const MANAGER_GRID = [
  'AAAAAAAAA',  // 0 hat brim
  '.AAAAAAAAa', // 1 hat (uses A=accent)
  '.HHHHHH.',   // 2 head
  '.HeEeEH.',   // 3 eyes
  '.HHHHHH.',   // 4 nose
  '.HsMMs.',    // 5 mouth
  '..SSSS..',   // 6 neck
  '.BBBBBB.',   // 7 body/blazer
  'bBaaBBb',    // 8 body with tie (a=accent)
  '..PPPP..',   // 9 pants
  '.PP..PP.',   // 10 legs
  '.TT..TT.',   // 11 shoes
];

const PLAYER_GRID = [
  '..RRRR..',   // 0 hair
  '.RRRRRR.',   // 1 hair
  '.HHHHHH.',   // 2 head
  '.HeEeEH.',   // 3 eyes
  '.HHHHHH.',   // 4 face
  '.HsMMs.',    // 5 mouth
  '..SSSS..',   // 6 neck
  '.BBBBBB.',   // 7 body - teal jacket
  'bBBBBBBb',   // 8 body wide
  '..AaAA..',   // 9 belt/badge (A=accent)
  '.PP..PP.',   // 10 legs
  '.TT..TT.',   // 11 shoes
];

function buildPalette(dept, isManager) {
  const d = DEPT[dept] || DEPT.meeting;
  return {
    'H': SKIN,
    'h': SKIN_D,
    's': SKIN_S,
    'e': EYE_H,
    'E': EYE,
    'M': '#CC6B6B',  // mouth
    'S': SKIN_D,     // neck
    'R': d.hair,
    'r': '#6B4C38',  // hair highlight
    'B': d.body,
    'b': d.bodyD,
    'P': PANTS,
    'p': PANTS_D,
    'T': SHOE,
    't': '#2A2A2A',
    'A': d.accent,
    'a': d.body,
  };
}

function generateCharacter(dept, isManager, isPlayer) {
  const canvas = createCanvas(32, 48);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, 32, 48);

  const palette = buildPalette(dept, isManager);
  const grid = isPlayer ? PLAYER_GRID : (isManager ? MANAGER_GRID : WORKER_GRID);

  // Shadow
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.beginPath();
  ctx.ellipse(16, 46, 9, 3, 0, 0, Math.PI * 2);
  ctx.fill();

  // Draw each row
  for (let gy = 0; gy < grid.length; gy++) {
    drawRow(ctx, gy, grid[gy], palette);
  }

  // Highlight on eyes
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.fillRect(2*S+1, 3*S+1, 1, 1);
  ctx.fillRect(5*S+1, 3*S+1, 1, 1);

  return canvas.toBuffer('image/png');
}

// ── Tile generators ──────────────────────────────────────────────

function generateTile(type) {
  const canvas = createCanvas(32, 32);
  const ctx = canvas.getContext('2d');

  // 결정적 난수 — 타일마다 같은 무늬가 나오되 규칙적으로 보이지 않게 한다.
  // Math.random 을 쓰면 스프라이트를 다시 만들 때마다 화면이 달라진다.
  let seed = type.split('').reduce((a, c) => a + c.charCodeAt(0), 7);
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const px = (x, y, w, h, color) => { ctx.fillStyle = color; ctx.fillRect(x, y, w, h); };

  if (type === 'carpet') {
    // 방 바닥. 씬에서 room.floorColor 로 tint(곱셈)한다. 예전 텍스처는 #1A1A2E 로
    // 이미 어두워서, 어두운 방 색과 곱하면 거의 검정이 됐다 — 질감이 안 보였다.
    // 밝은 중간톤으로 그려야 tint 후에도 짜임새가 남는다.
    px(0, 0, 32, 32, '#C8C8C8');
    // 카펫 짜임 — 가로/세로 실이 교차하는 느낌
    for (let y = 0; y < 32; y += 2) {
      for (let x = 0; x < 32; x += 2) {
        const warp = ((x >> 1) + (y >> 1)) % 2 === 0;
        px(x, y, 2, 2, warp ? '#D2D2D2' : '#BEBEBE');
      }
    }
    // 섬유 노이즈 — 완전히 균일하면 인쇄물처럼 보인다
    for (let i = 0; i < 90; i++) {
      const x = (rnd() * 32) | 0, y = (rnd() * 32) | 0;
      px(x, y, 1, 1, rnd() > 0.5 ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.10)');
    }
    // 타일 경계 — 인접 타일과 붙었을 때 격자가 보이게
    ctx.strokeStyle = 'rgba(0,0,0,0.13)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, 31, 31);
  } else if (type === 'corridor') {
    // 복도 = 석재 바닥. 참고 이미지의 자갈길처럼 크기가 다른 돌을 깔고
    // 줄눈을 어둡게 남긴다. tint 하지 않고 그대로 쓴다.
    px(0, 0, 32, 32, '#232334');
    const stones = [
      [1, 1, 14, 9], [16, 1, 15, 9],
      [1, 11, 9, 9], [11, 11, 20, 9],
      [1, 21, 18, 10], [20, 21, 11, 10],
    ];
    for (const [x, y, w, h] of stones) {
      const v = 0.5 + rnd() * 0.5;                     // 돌마다 밝기 차이
      const base = Math.round(46 + v * 16);
      px(x, y, w, h, `rgb(${base},${base + 2},${base + 14})`);
      // 위/왼쪽 하이라이트, 아래 그림자 — 살짝 튀어나온 느낌
      px(x, y, w, 1, `rgba(255,255,255,0.10)`);
      px(x, y, 1, h, `rgba(255,255,255,0.06)`);
      px(x, y + h - 1, w, 1, `rgba(0,0,0,0.35)`);
    }
    // 이끼/얼룩 몇 점 — 완전히 깨끗하면 인공적이다
    for (let i = 0; i < 10; i++) {
      px((rnd() * 32) | 0, (rnd() * 32) | 0, 1, 1, 'rgba(120,150,130,0.10)');
    }
  } else if (type === 'floor') {
    // 공용 바닥 — 카펫보다 매끈한 타일
    px(0, 0, 32, 32, '#1B1B27');
    px(0, 0, 16, 16, '#1E1E2B');
    px(16, 16, 16, 16, '#1E1E2B');
    for (let i = 0; i < 24; i++) {
      px((rnd() * 32) | 0, (rnd() * 32) | 0, 1, 1, 'rgba(255,255,255,0.045)');
    }
    ctx.strokeStyle = 'rgba(255,255,255,0.05)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, 31, 31);
  } else if (type === 'desk') {
    ctx.clearRect(0, 0, 32, 32);

    // 바닥 그림자 — 물체가 바닥에 놓인 느낌을 만드는 가장 값싼 방법
    ctx.fillStyle = 'rgba(0,0,0,0.30)';
    ctx.beginPath();
    ctx.ellipse(16, 27, 13, 4, 0, 0, Math.PI * 2);
    ctx.fill();

    // 책상 — 윗면과 앞면을 나눠 두께를 준다
    px(2, 20, 28, 5, '#3E2B1E');            // 앞면(어두움)
    px(2, 7, 28, 13, '#6B4A32');            // 윗면
    px(2, 7, 28, 2, '#8A6244');             // 윗면 하이라이트
    for (let i = 0; i < 14; i++) {          // 나뭇결
      const y = 9 + ((rnd() * 10) | 0);
      px(3 + ((rnd() * 24) | 0), y, 3 + ((rnd() * 4) | 0), 1, 'rgba(0,0,0,0.10)');
    }
    px(4, 25, 3, 5, '#2A1C13');             // 다리
    px(25, 25, 3, 5, '#2A1C13');

    // 모니터 — 베젤 / 화면 / 발광
    px(9, 4, 15, 12, '#0E1420');            // 베젤
    px(10, 5, 13, 10, '#16324A');           // 화면 바탕
    px(10, 5, 13, 4, '#1E5C86');            // 화면 상단이 더 밝다
    for (let i = 0; i < 5; i++) {           // 코드 줄
      px(11, 6 + i * 2, 3 + ((rnd() * 8) | 0), 1, 'rgba(125,211,252,0.75)');
    }
    ctx.fillStyle = 'rgba(56,189,248,0.16)';
    ctx.fillRect(7, 2, 19, 16);             // 화면빛 번짐
    px(15, 16, 3, 3, '#33404F');            // 스탠드
    px(12, 19, 9, 1, '#3C4A5A');            // 받침

    // 키보드·머그
    px(11, 21, 11, 3, '#2C3846');
    px(12, 22, 9, 1, '#48586B');
    px(24, 19, 4, 5, '#B8452F');
    px(24, 19, 4, 1, '#D9634A');
  } else if (type === 'wall_v') {
    px(0, 0, 32, 32, '#2A2A3E');
    px(0, 0, 4, 32, '#3E3E58');             // 안쪽 면 하이라이트
    px(4, 0, 28, 32, '#1A1A28');
    for (let i = 0; i < 12; i++) {          // 벽 질감
      px(4 + ((rnd() * 28) | 0), (rnd() * 32) | 0, 1, 1, 'rgba(255,255,255,0.05)');
    }
  }

  return canvas.toBuffer('image/png');
}


// ── Generate hint/bubble ──────────────────────────────────────────

function generateBubble(type) {
  const W = 120, H = 36;
  const canvas = createCanvas(W, H + 12);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H + 12);

  if (type === 'speech') {
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    roundRect(ctx, 0, 0, W, H, 8);
    // Tail
    ctx.beginPath();
    ctx.moveTo(14, H);
    ctx.lineTo(26, H);
    ctx.lineTo(20, H + 12);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.fillStyle = 'rgba(20,30,50,0.92)';
    roundRect(ctx, 0, 0, W, H, 6);
    ctx.strokeStyle = '#14B8A6';
    ctx.lineWidth = 1.5;
    roundStroke(ctx, 0, 0, W, H, 6);
  }

  return canvas.toBuffer('image/png');
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
  ctx.fill();
}

function roundStroke(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
  ctx.stroke();
}

// ── Main generation ──────────────────────────────────────────────

const depts = ['research', 'orchestration', 'finance', 'dev', 'content', 'meeting'];

console.log('Generating character sprites...');

// Player
const playerPng = generateCharacter('player', false, true);
writeFileSync(join(OUT_DIR, 'player.png'), playerPng);
console.log('  player.png ✓');

// NPCs per department
for (const dept of depts) {
  for (const role of ['manager', 'worker']) {
    const isManager = role === 'manager';
    const png = generateCharacter(dept, isManager, false);
    const fname = `npc_${dept}_${role}.png`;
    writeFileSync(join(OUT_DIR, fname), png);
    console.log(`  ${fname} ✓`);
  }
}

// Tiles
console.log('\nGenerating tile textures...');
for (const t of ['floor', 'corridor', 'desk', 'carpet', 'wall_v']) {
  writeFileSync(join(OUT_DIR, `tile_${t}.png`), generateTile(t));
  console.log(`  tile_${t}.png ✓`);
}

// Bubbles
console.log('\nGenerating UI elements...');
writeFileSync(join(OUT_DIR, 'bubble.png'), generateBubble('speech'));
writeFileSync(join(OUT_DIR, 'hint_bubble.png'), generateBubble('hint'));
console.log('  bubble.png ✓\n  hint_bubble.png ✓');

console.log('\n✅ All sprites generated in public/sprites/');
