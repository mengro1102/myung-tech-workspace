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

  if (type === 'floor') {
    // Dark checkerboard
    ctx.fillStyle = '#14141F';
    ctx.fillRect(0, 0, 32, 32);
    ctx.fillStyle = '#16161F';
    ctx.fillRect(0, 0, 16, 16);
    ctx.fillRect(16, 16, 16, 16);
    // subtle grid lines
    ctx.strokeStyle = '#1A1A2A';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(0, 0, 32, 32);
  } else if (type === 'corridor') {
    ctx.fillStyle = '#0F0F18';
    ctx.fillRect(0, 0, 32, 32);
    ctx.strokeStyle = '#1A1A28';
    ctx.lineWidth = 0.5;
    ctx.strokeRect(0, 0, 32, 32);
  } else if (type === 'desk') {
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.clearRect(0, 0, 32, 32);
    // Desk surface
    ctx.fillStyle = '#5D4037';
    ctx.fillRect(2, 6, 28, 20);
    ctx.fillStyle = '#795548';
    ctx.fillRect(2, 6, 28, 3);
    // Monitor
    ctx.fillStyle = '#1E293B';
    ctx.fillRect(8, 8, 14, 10);
    ctx.fillStyle = '#38BDF8';
    ctx.fillRect(9, 9, 12, 8);
    // Screen glow
    ctx.fillStyle = 'rgba(56,189,248,0.2)';
    ctx.fillRect(8, 8, 14, 10);
    // Monitor stand
    ctx.fillStyle = '#455A64';
    ctx.fillRect(13, 18, 4, 3);
    // Keyboard
    ctx.fillStyle = '#2D3748';
    ctx.fillRect(5, 22, 22, 3);
    // Desk legs (hint)
    ctx.fillStyle = '#3E2723';
    ctx.fillRect(2, 25, 3, 4);
    ctx.fillRect(27, 25, 3, 4);
  } else if (type === 'carpet') {
    ctx.fillStyle = '#1A1A2E';
    ctx.fillRect(0, 0, 32, 32);
    // Subtle pattern
    ctx.fillStyle = '#1E1E35';
    for (let i = 0; i < 32; i += 8) {
      for (let j = 0; j < 32; j += 8) {
        ctx.fillRect(i+2, j+2, 4, 4);
      }
    }
  } else if (type === 'wall_v') {
    // Vertical wall segment
    ctx.fillStyle = '#2A2A3E';
    ctx.fillRect(0, 0, 32, 32);
    ctx.fillStyle = '#3A3A50';
    ctx.fillRect(0, 0, 4, 32);
    ctx.fillStyle = '#1A1A28';
    ctx.fillRect(4, 0, 28, 32);
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
