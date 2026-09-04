import { useEffect, useRef, useState, useCallback } from 'react';

interface Agent { agent_id: string; character_name: string; role: string; department?: string; status?: string; }
interface TaskMsg { sender: string; target: string; payload: string; }

interface Props {
  agents: Agent[];
  cycleStatus: string;
  recentMessages: TaskMsg[];
  onAgentClick?: (agentId: string, dept: string) => void;
}

// ── 픽셀 팔레트 ──────────────────────────────────────────
const DEPT_COLOR: Record<string, string> = {
  orchestration_dept: '#0ffd6a',
  research_dept:      '#60a5fa',
  finance_dept:       '#fbbf24',
  dev_dept:           '#a78bfa',
  content_dept:       '#f472b6',
};
const DEPT_DARK: Record<string, string> = {
  orchestration_dept: '#0a2e1a',
  research_dept:      '#1e3a5f',
  finance_dept:       '#3d2800',
  dev_dept:           '#2e1a5f',
  content_dept:       '#5f1a3d',
};
const DEPT_LABEL: Record<string, string> = {
  orchestration_dept: 'CEO실',
  research_dept:      '연구실',
  finance_dept:       '금융실',
  dev_dept:           '개발실',
  content_dept:       '콘텐츠',
};

// ── 방 레이아웃 (960×540 논리 좌표) ───────────────────────
interface Room { x: number; y: number; w: number; h: number; dept: string; }
const BASE_W = 960, BASE_H = 540;
const ROOMS: Room[] = [
  { x: 12,  y: 12,  w: 255, h: 222, dept: 'research_dept' },
  { x: 12,  y: 258, w: 255, h: 258, dept: 'finance_dept' },
  { x: 354, y: 12,  w: 252, h: 504, dept: 'orchestration_dept' },
  { x: 693, y: 12,  w: 255, h: 222, dept: 'dev_dept' },
  { x: 693, y: 258, w: 255, h: 258, dept: 'content_dept' },
];

// ── 에이전트 타입 ─────────────────────────────────────────
interface PixelAgent {
  id: string; name: string; dept: string; role: string;
  x: number; y: number;
  tx: number; ty: number;
  frame: number;
  dir: 1 | -1;
  busy: boolean;
  busyTimer: number;
  speechBubble?: string;
  speechTimer: number;
  skinTone: string;
  shirtColor: string;
}

// ── 메시지 파티클 ─────────────────────────────────────────
interface MsgParticle {
  id: string;
  sx: number; sy: number;
  tx: number; ty: number;
  t: number;
  color: string;
  label: string;
  done?: boolean; // 태스크 완료 파티클
}

// ── 완료 파티클 (폭발) ────────────────────────────────────
interface CelebParticle {
  id: string; x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  color: string; size: number;
}

const SKIN_TONES   = ['#fce5cb', '#f0c28a', '#d4956a', '#a0614a', '#5c3626'];
const SHIRT_COLORS = ['#3b82f6','#ef4444','#8b5cf6','#f59e0b','#10b981','#ec4899','#06b6d4','#f97316'];

function randInRoom(room: Room, margin = 30): { x: number; y: number } {
  return {
    x: room.x + margin + Math.random() * (room.w - margin * 2),
    y: room.y + margin + Math.random() * (room.h - margin * 2),
  };
}

function roomCenter(dept: string): { x: number; y: number } {
  const r = ROOMS.find(r => r.dept === dept) ?? ROOMS[0];
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

// ── 픽셀 그리기 헬퍼 (2x 스프라이트) ─────────────────────
/** 색을 조금 어둡게/밝게 — 음영용. */
function shade(hex: string, amt: number): string {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  const cl = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  const r = cl(((n >> 16) & 255) * (1 + amt));
  const g = cl(((n >> 8) & 255) * (1 + amt));
  const b = cl((n & 255) * (1 + amt));
  return `rgb(${r},${g},${b})`;
}

/* 에이전트 아바타.
 *
 * 좌표는 발밑 중앙(px, py) 기준의 **정수 격자**로 정의하고 단위(U)를 정수배로만
 * 곱한다. 반픽셀이 생길 수 없으므로 조각 사이에 금이 가지 않는다.
 *
 * 격자: 가로 -6..+6, 세로 -14(머리끝)..+1(발). U=3 이면 대략 36x48px.
 *
 * 캐릭터처럼 보이게 하는 것은 디테일이 아니라 **실루엣**이다. 그래서 두 가지를
 * 지킨다.
 *
 *  - 머리와 어깨의 네 귀퉁이를 한 칸씩 깎는다. 직각 상자는 아무리 얼굴을 그려도
 *    상자로 읽힌다.
 *  - 모든 조각을 모아 한 칸 바깥으로 확장해 어두운 색으로 먼저 칠하고, 그 위에
 *    본 색을 덮는다. 결과적으로 실루엣 둘레에만 1칸 외곽선이 남는다. 밝은 바닥
 *    위에서도 인물이 배경에서 떨어져 보인다.
 */
function drawPixelAgent(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  dir: 1 | -1,
  frame: number,
  busy: boolean,
  skinTone: string,
  shirtColor: string,
) {
  const px = Math.round(x);
  const py = Math.round(y);
  const U = 3;                                   // 단위 픽셀 (정수여야 한다)

  const hair    = shade(skinTone, -0.66);
  const skinSh  = shade(skinTone, -0.20);
  const shirtSh = shade(shirtColor, -0.30);
  const shirtHi = shade(shirtColor, 0.18);
  const pants   = '#39415a';
  const pantsSh = '#2a3145';
  const shoe    = '#1c2030';
  const OUTLINE = 'rgba(18,20,32,0.92)';

  // 조각을 바로 칠하지 않고 모은다. 외곽선을 한 번에 두르기 위해서다.
  const parts: Array<[number, number, number, number, string]> = [];
  const r = (gx: number, gy: number, gw: number, gh: number, color: string) => {
    parts.push([gx, gy, gw, gh, color]);
  };

  // 발밑 그림자 — 인물이 바닥에 '있는' 느낌의 대부분은 그림자가 만든다.
  softShadow(ctx, px, py + U, 5 * U, 1.8 * U, 0.36);

  const step  = busy ? 0 : (frame % 4 < 2 ? 0 : 1);
  const swing = busy ? 0 : (frame % 4 < 2 ? 0 : 1);

  // ── 다리 ── 앉으면 짧게 접는다
  if (busy) {
    r(-3, -2, 2, 2, pantsSh);
    r(1, -2, 2, 2, pantsSh);
  } else {
    r(-3, -2 + step, 2, 3 - step, pants);
    r(1, -2 - step, 2, 3 + step, pants);
    r(-4, 1 - step, 3, 1, shoe);                 // 신발 — 발끝이 조금 나온다
    r(1, 1 + step, 3, 1, shoe);
  }

  // ── 몸통 ── 어깨 귀퉁이를 깎아 사다리꼴로 만든다
  r(-3, -7, 6, 1, shirtHi);                      // 어깨(좁음) + 하이라이트
  r(-4, -6, 8, 3, shirtColor);
  r(-4, -3, 8, 1, shirtSh);                      // 밑단 그림자
  r(-4, -6, 1, 4, shirtSh);                      // 옆구리 음영 — 팔과 몸을 갈라 준다
  r(3, -6, 1, 4, shirtSh);

  // ── 팔 ──
  if (busy) {
    const t = (frame % 3) - 1;                   // 타이핑
    r(-6, -6 + t, 2, 2, shirtColor);
    r(4, -6 - t, 2, 2, shirtColor);
    r(-6, -4 + t, 2, 1, skinTone);
    r(4, -4 - t, 2, 1, skinTone);
  } else {
    r(-6, -6 + swing, 2, 3, shirtColor);
    r(4, -6 - swing, 2, 3, shirtColor);
    r(-6, -3 + swing, 2, 1, skinTone);           // 손
    r(4, -3 - swing, 2, 1, skinTone);
  }

  // ── 목 ──
  r(-1, -8, 2, 1, skinSh);

  // ── 머리 ── 위아래 귀퉁이를 깎는다
  r(-3, -14, 6, 1, hair);                        // 정수리(좁음)
  r(-4, -13, 8, 2, hair);                        // 머리 윗면
  r(-4, -11, 8, 2, skinTone);                    // 얼굴
  r(-3, -9, 6, 1, skinTone);                     // 턱(좁음)
  r(-4, -11, 1, 1, hair);                        // 옆머리 — 얼굴을 좁혀 준다
  r(3, -11, 1, 1, hair);
  r(-5, -11, 1, 2, skinSh);                      // 귀 (머리에 붙어 있다)
  r(4, -11, 1, 2, skinSh);
  r(dir > 0 ? 1 : -3, -12, 2, 1, hair);          // 앞머리 — 보는 쪽으로 흘러내린다

  // 눈·입 — 보는 쪽으로 몰아 방향이 읽히게
  const eyeX = dir > 0 ? 0 : -3;
  r(eyeX, -11, 1, 1, '#2b3244');
  r(eyeX + 2, -11, 1, 1, '#2b3244');
  r(dir > 0 ? 1 : -2, -10, 1, 1, shade(skinTone, -0.42));   // 입

  // 외곽선 → 본 색. 순서가 중요하다.
  ctx.fillStyle = OUTLINE;
  for (const [gx, gy, gw, gh] of parts) {
    ctx.fillRect(px + (gx - 1) * U, py + (gy - 1) * U, (gw + 2) * U, (gh + 2) * U);
  }
  for (const [gx, gy, gw, gh, color] of parts) {
    ctx.fillStyle = color;
    ctx.fillRect(px + gx * U, py + gy * U, gw * U, gh * U);
  }

  // 작업 중 표시 — 머리 위 점 세 개. 외곽선을 두르지 않는다.
  if (busy) {
    const lit = frame % 3;
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = i === lit ? '#7dd3fc' : 'rgba(125,211,252,0.28)';
      ctx.fillRect(px + (-2 + i * 2) * U, py - 17 * U, U, U);
    }
  }
}


function drawSpeechBubble(
  ctx: CanvasRenderingContext2D,
  x: number, y: number,
  text: string,
) {
  const maxW = 130;
  const pad  = 6;
  ctx.font = '8px monospace';
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW - pad * 2) {
      if (line) lines.push(line);
      line = w;
    } else { line = test; }
    if (lines.length >= 2) break;
  }
  if (line && lines.length < 3) lines.push(line);
  const bw = Math.min(maxW, Math.max(...lines.map(l => ctx.measureText(l).width)) + pad * 2);
  const bh = lines.length * 11 + pad * 2;
  const bx = x - bw / 2;
  const by = y - 28 - bh;

  ctx.fillStyle = 'rgba(10,10,20,0.92)';
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.roundRect(bx, by, bw, bh, 4);
  ctx.fill(); ctx.stroke();
  // 꼬리
  ctx.fillStyle = 'rgba(10,10,20,0.92)';
  ctx.beginPath();
  ctx.moveTo(x - 4, by + bh); ctx.lineTo(x, by + bh + 7); ctx.lineTo(x + 4, by + bh);
  ctx.fill();

  ctx.fillStyle = '#e2e8f0';
  lines.forEach((l, i) => ctx.fillText(l, bx + pad, by + pad + 9 + i * 11));
}

/* ── 오피스 렌더링 ────────────────────────────────────────────────────────
   예전 방은 단색 바닥 + 부서색 반투명 사각형이라 사물이 '재질'로 읽히지 않았다.
   개선 방향은 셋이다.

   1) 바닥에 결을 준다 — 판재 이음새와 미세한 얼룩. 완전히 균일한 면은 인쇄물처럼 보인다.
   2) 가구를 재질색으로 그린다 — 나무는 나무색, 화면은 화면색. 부서색은 방 정체성
      (라벨·테두리·러그 테두리)에만 쓰고 사물에는 안 쓴다.
   3) 모든 사물 아래에 부드러운 그림자를 깐다. 바닥에 '놓인' 느낌은 대부분 그림자가 만든다.

   주의: 이 함수는 애니메이션 루프에서 매 프레임 호출된다. 얼룩·결에 Math.random 을
   쓰면 화면이 지글거린다. 좌표 기반 해시로 결정적으로 뽑는다. */

/** 좌표 해시 — 같은 자리는 항상 같은 값. 매 프레임 호출돼도 무늬가 안 흔들린다. */
function noise2(x: number, y: number): number {
  const n = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/** 사물 아래 타원 그림자. 바닥에 붙어 있는 느낌을 만든다. */
function softShadow(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, rx: number, ry: number, a = 0.32,
) {
  const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(rx, ry));
  g.addColorStop(0, `rgba(0,0,0,${a})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(1, ry / Math.max(rx, ry));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, Math.max(rx, ry), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** 윗면 + 앞면 + 그림자로 두께가 있는 상자. 가구의 기본 단위. */
function box(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, depth: number,
  top: string, side: string, hi?: string,
) {
  softShadow(ctx, x + w / 2, y + h + depth - 1, w * 0.62, depth * 1.5, 0.30);
  ctx.fillStyle = side;
  ctx.fillRect(x, y + h, w, depth);          // 앞면
  ctx.fillStyle = top;
  ctx.fillRect(x, y, w, h);                  // 윗면
  if (hi) { ctx.fillStyle = hi; ctx.fillRect(x, y, w, 2); }  // 윗면 앞쪽 하이라이트
}

/** 화면이 켜진 모니터 — 빛 번짐까지 그려야 '켜져 있다'로 읽힌다. */
function monitor(ctx: CanvasRenderingContext2D, x: number, y: number, w = 26, h = 18) {
  ctx.fillStyle = 'rgba(56,189,248,0.10)';
  ctx.fillRect(x - 5, y - 4, w + 10, h + 8);
  ctx.fillStyle = '#0e1420';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#173049';
  ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
  ctx.fillStyle = 'rgba(125,211,252,0.55)';
  for (let i = 0; i < 4; i++) {
    const lw = 4 + Math.floor(noise2(x + i, y) * (w - 12));
    ctx.fillRect(x + 4, y + 4 + i * 3, lw, 1);
  }
  ctx.fillStyle = '#334155';
  ctx.fillRect(x + w / 2 - 2, y + h, 4, 3);
  ctx.fillRect(x + w / 2 - 7, y + h + 3, 14, 2);
}

/** 화분 — 잎을 겹쳐 부피감을 준다. */
function plant(ctx: CanvasRenderingContext2D, x: number, y: number, s = 1) {
  softShadow(ctx, x, y + 2, 10 * s, 4 * s, 0.28);
  ctx.fillStyle = '#8a5a3c';
  ctx.fillRect(x - 6 * s, y - 6 * s, 12 * s, 8 * s);
  ctx.fillStyle = '#a06a48';
  ctx.fillRect(x - 6 * s, y - 6 * s, 12 * s, 2 * s);
  const leaves: [number, number, number, string][] = [
    [-5, -12, 6, '#2f6b45'], [4, -13, 6, '#2f6b45'],
    [0, -17, 7, '#3d8a5a'], [-3, -9, 5, '#256b3f'], [4, -9, 5, '#256b3f'],
  ];
  for (const [dx, dy, r, col] of leaves) {
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.ellipse(x + dx * s, y + dy * s, r * s, (r + 1) * s, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = 'rgba(255,255,255,0.16)';
  ctx.beginPath();
  ctx.ellipse(x - 1 * s, y - 18 * s, 3 * s, 2 * s, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** 러그 — 방마다 색이 다른 테두리로 정체성을 준다. 참고 이미지의 카펫 역할. */
function rug(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number, c: string) {
  // 이전 러그는 방 배경과 명도가 비슷해 거의 보이지 않았다. 어두운 바탕을 먼저
  // 깔아 바닥과 분리한 뒤 부서색 테두리를 얹는다 — 참고 이미지의 카펫처럼
  // '깔려 있는 물건'으로 읽혀야 한다.
  const x = cx - w / 2, y = cy - h / 2;
  softShadow(ctx, cx, cy + h / 2 - 2, w * 0.5, 5, 0.22);
  ctx.fillStyle = 'rgba(8,10,16,0.55)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = `${c}30`;
  ctx.fillRect(x, y, w, h);

  // 안쪽 무늬 — 단색이면 그냥 사각형으로 보인다
  ctx.fillStyle = `${c}1a`;
  for (let gy = y + 6; gy < y + h - 6; gy += 10) ctx.fillRect(x + 6, gy, w - 12, 1);

  ctx.strokeStyle = `${c}aa`;
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 3, y + 3, w - 6, h - 6);
  ctx.strokeStyle = `${c}55`;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 8, y + 8, w - 16, h - 16);

  // 술(fringe) — 짧은 선 몇 개로 카펫 느낌이 확 산다
  ctx.fillStyle = `${c}77`;
  for (let fx = x + 6; fx < x + w - 4; fx += 7) {
    ctx.fillRect(fx, y - 2, 2, 3);
    ctx.fillRect(fx, y + h - 1, 2, 3);
  }
}

/** 소파 — 등받이/좌석/팔걸이를 나눠 부피를 만든다. */
function sofa(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h = 26) {
  softShadow(ctx, x + w / 2, y + h + 3, w * 0.5, 5, 0.30);
  ctx.fillStyle = '#3a4560';                      // 등받이
  ctx.fillRect(x, y, w, 9);
  ctx.fillStyle = '#4a5878';                      // 좌석
  ctx.fillRect(x, y + 9, w, h - 12);
  ctx.fillStyle = '#56668a';                      // 좌석 앞 하이라이트
  ctx.fillRect(x, y + 9, w, 2);
  ctx.fillStyle = '#333d55';                      // 팔걸이
  ctx.fillRect(x - 4, y + 4, 5, h - 6);
  ctx.fillRect(x + w - 1, y + 4, 5, h - 6);
  ctx.fillStyle = 'rgba(0,0,0,0.20)';             // 방석 이음새
  for (let i = 1; i < 3; i++) ctx.fillRect(x + (w / 3) * i, y + 10, 1, h - 14);
  ctx.fillStyle = '#232a3a';                      // 다리
  ctx.fillRect(x + 3, y + h - 3, 4, 4);
  ctx.fillRect(x + w - 7, y + h - 3, 4, 4);
}

/** 화이트보드 — 벽에 걸린 판. 흐릿한 글씨 자국까지 넣어야 '쓰던 물건'으로 보인다. */
function whiteboard(ctx: CanvasRenderingContext2D, x: number, y: number, w = 74, h = 42) {
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  ctx.fillRect(x + 2, y + 3, w, h);               // 벽 그림자
  ctx.fillStyle = '#8d99ae';                      // 프레임
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#e8ecf2';                      // 보드면
  ctx.fillRect(x + 2, y + 2, w - 4, h - 6);
  ctx.fillStyle = 'rgba(60,80,120,0.45)';         // 글씨 자국
  for (let i = 0; i < 4; i++) {
    const lw = 12 + ((noise2(x + i * 7, y) * (w - 26)) | 0);
    ctx.fillRect(x + 7, y + 8 + i * 7, lw, 2);
  }
  ctx.fillStyle = 'rgba(200,60,60,0.5)';          // 빨간 동그라미
  ctx.beginPath();
  ctx.ellipse(x + w - 20, y + 16, 9, 6, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = '#5b6577';                      // 마커 트레이
  ctx.fillRect(x + 4, y + h - 4, w - 8, 3);
  ctx.fillStyle = '#d94f4f';
  ctx.fillRect(x + 10, y + h - 5, 6, 2);
  ctx.fillStyle = '#4f7fd9';
  ctx.fillRect(x + 20, y + h - 5, 6, 2);
}

/** 커피 테이블 — 소파 앞 낮은 탁자. 컵과 노트를 올려 생활감을 준다. */
function coffeeTable(ctx: CanvasRenderingContext2D, cx: number, cy: number, w = 46, h = 20) {
  softShadow(ctx, cx, cy + h / 2 + 3, w * 0.55, 5, 0.28);
  ctx.fillStyle = '#3e2b1e';
  ctx.fillRect(cx - w / 2, cy - h / 2 + h - 3, w, 5);
  ctx.fillStyle = '#6b4a32';
  ctx.fillRect(cx - w / 2, cy - h / 2, w, h - 2);
  ctx.fillStyle = '#87613f';
  ctx.fillRect(cx - w / 2, cy - h / 2, w, 2);
  ctx.fillStyle = '#c8d2e0';                      // 노트
  ctx.fillRect(cx - 16, cy - 4, 13, 9);
  ctx.fillStyle = '#9aa7b8';
  ctx.fillRect(cx - 16, cy - 4, 13, 2);
  ctx.fillStyle = '#b8452f';                      // 머그
  ctx.fillRect(cx + 6, cy - 5, 7, 8);
  ctx.fillStyle = '#d9634a';
  ctx.fillRect(cx + 6, cy - 5, 7, 2);
}

/** 정수기 — 구석을 채우는 소품. */
function waterCooler(ctx: CanvasRenderingContext2D, x: number, y: number) {
  softShadow(ctx, x, y + 3, 9, 4, 0.28);
  ctx.fillStyle = '#2f3a4a';
  ctx.fillRect(x - 7, y - 16, 14, 18);
  ctx.fillStyle = '#3f4d61';
  ctx.fillRect(x - 7, y - 16, 14, 2);
  ctx.fillStyle = 'rgba(120,190,230,0.75)';       // 물통
  ctx.fillRect(x - 6, y - 30, 12, 14);
  ctx.fillStyle = 'rgba(180,225,245,0.5)';
  ctx.fillRect(x - 6, y - 30, 4, 14);
  ctx.fillStyle = '#1f2733';
  ctx.fillRect(x - 3, y - 8, 6, 3);
}

function drawRoom(ctx: CanvasRenderingContext2D, room: Room, selected: boolean) {
  const c  = DEPT_COLOR[room.dept] ?? '#64748b';
  const dk = DEPT_DARK[room.dept]  ?? '#1a1a2e';

  // ── 바닥 ──
  ctx.fillStyle = dk;
  ctx.fillRect(room.x, room.y, room.w, room.h);

  // 판재 이음새 — 밝은 선과 어두운 선을 짝지어야 홈처럼 보인다
  for (let gy = room.y + 18; gy < room.y + room.h; gy += 18) {
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(room.x, gy, room.w, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(room.x, gy + 1, room.w, 1);
  }
  for (let gx = room.x + 26; gx < room.x + room.w; gx += 26) {
    ctx.fillStyle = 'rgba(0,0,0,0.13)';
    ctx.fillRect(gx, room.y, 1, room.h);
  }
  // 미세한 얼룩 — 좌표 해시라 프레임마다 흔들리지 않는다
  for (let i = 0; i < 26; i++) {
    const nx = noise2(room.x + i, room.y);
    const ny = noise2(room.y + i * 3, room.x);
    ctx.fillStyle = nx > 0.5 ? 'rgba(255,255,255,0.035)' : 'rgba(0,0,0,0.07)';
    ctx.fillRect(room.x + nx * (room.w - 4), room.y + ny * (room.h - 4), 2, 2);
  }
  // 벽 쪽으로 갈수록 어두워지는 감쇠 — 실내 조명 느낌
  const vg = ctx.createLinearGradient(0, room.y, 0, room.y + room.h);
  vg.addColorStop(0, 'rgba(0,0,0,0.30)');
  vg.addColorStop(0.22, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.16)');
  ctx.fillStyle = vg;
  ctx.fillRect(room.x, room.y, room.w, room.h);

  // ── 벽 ──
  ctx.fillStyle = 'rgba(0,0,0,0.42)';
  ctx.fillRect(room.x, room.y, room.w, 7);              // 상단 벽 두께
  ctx.fillStyle = `${c}55`;
  ctx.fillRect(room.x, room.y, room.w, 2);              // 벽 윗선(부서색)
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  ctx.fillRect(room.x, room.y + 7, room.w, 1);          // 걸레받이 하이라이트

  ctx.strokeStyle = selected ? c : `${c}3a`;
  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeRect(room.x + 0.5, room.y + 0.5, room.w - 1, room.h - 1);
  if (selected) {
    ctx.strokeStyle = `${c}22`;
    ctx.lineWidth = 6;
    ctx.strokeRect(room.x + 3, room.y + 3, room.w - 6, room.h - 6);
  }

  // ── 가구 ── 재질색으로 그린다. 부서색은 방 정체성에만 쓴다.
  if (room.dept === 'orchestration_dept') {
    rug(ctx, room.x + room.w / 2, room.y + room.h / 2, Math.min(room.w - 40, 190), Math.min(room.h - 50, 120), c);

    const cx = room.x + room.w / 2, cy = room.y + room.h / 2;
    softShadow(ctx, cx, cy + 26, 62, 16, 0.34);
    ctx.fillStyle = '#523726';
    ctx.beginPath(); ctx.ellipse(cx, cy + 6, 56, 33, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#6d4a32';
    ctx.beginPath(); ctx.ellipse(cx, cy, 56, 33, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.10)';
    ctx.beginPath(); ctx.ellipse(cx - 12, cy - 10, 26, 12, -0.3, 0, Math.PI * 2); ctx.fill();

    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const ox = cx + Math.cos(a) * 74, oy = cy + Math.sin(a) * 46;
      softShadow(ctx, ox, oy + 5, 9, 4, 0.28);
      ctx.fillStyle = '#2f3a4a';
      ctx.beginPath(); ctx.arc(ox, oy, 7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#3f4d61';
      ctx.beginPath(); ctx.arc(ox, oy - 1, 6, 0, Math.PI * 2); ctx.fill();
    }
    // 회의실은 테이블 하나뿐이라 넓은 바닥이 비어 보였다. 참고 이미지의 밀도에
    // 맞춰 라운지 구역을 만든다 — 화이트보드(상단 벽), 소파+커피테이블(하단),
    // 정수기와 화분(구석).
    whiteboard(ctx, room.x + room.w / 2 - 37, room.y + 12);

    const loungeY = room.y + room.h - 92;
    rug(ctx, room.x + room.w / 2, loungeY + 28, Math.min(room.w - 44, 176), 74, c);
    sofa(ctx, room.x + room.w / 2 - 52, loungeY, 104);
    coffeeTable(ctx, room.x + room.w / 2, loungeY + 44);

    waterCooler(ctx, room.x + 24, room.y + room.h - 20);
    plant(ctx, room.x + room.w - 24, room.y + room.h - 18, 0.95);
    plant(ctx, room.x + 26, room.y + 64, 0.85);
    plant(ctx, room.x + room.w - 26, room.y + 64, 0.8);
  } else {
    rug(ctx, room.x + room.w / 2, room.y + room.h - 44, Math.min(room.w - 56, 150), 62, c);

    // L 자 책상 — 윗면/앞면을 나눠 두께를 준다
    box(ctx, room.x + 20, room.y + 34, room.w - 46, 16, 6, '#6b4a32', '#3e2b1e', '#87613f');
    box(ctx, room.x + 20, room.y + 34, 16, room.h - 74, 6, '#63432d', '#38271b');

    monitor(ctx, room.x + 40, room.y + 16);
    if (room.w > 190) monitor(ctx, room.x + 78, room.y + 18, 22, 15);

    // 키보드·머그
    ctx.fillStyle = '#2b3543';
    ctx.fillRect(room.x + 44, room.y + 40, 22, 6);
    ctx.fillStyle = '#3f4d5e';
    ctx.fillRect(room.x + 45, room.y + 41, 20, 2);
    ctx.fillStyle = '#b8452f';
    ctx.fillRect(room.x + 72, room.y + 38, 7, 8);
    ctx.fillStyle = '#d9634a';
    ctx.fillRect(room.x + 72, room.y + 38, 7, 2);

    // 책장 — 책등 색을 섞어 디테일을 준다
    const sx = room.x + room.w - 34, sy = room.y + 46, sh = Math.max(40, room.h - 92);
    box(ctx, sx, sy, 20, sh, 5, '#3a2a1c', '#2a1c13');
    const spines = ['#8d5a3c', '#3f6b8a', '#7a4a6b', '#4a7a5a', '#a08040'];
    for (let r = 0; r < Math.floor(sh / 14); r++) {
      const shelfY = sy + 4 + r * 14;
      ctx.fillStyle = '#2a1c13';
      ctx.fillRect(sx + 1, shelfY + 10, 18, 2);
      for (let b = 0; b < 5; b++) {
        ctx.fillStyle = spines[(r * 5 + b + room.x) % spines.length];
        ctx.fillRect(sx + 2 + b * 3.4, shelfY, 3, 10);
      }
    }
    plant(ctx, room.x + room.w - 22, room.y + room.h - 16, 0.85);
  }

  // ── 방 이름표 ── 벽에 붙은 명패처럼
  const label = DEPT_LABEL[room.dept] ?? room.dept;
  const lw = label.length * 7 + 18;
  const lx = room.x + room.w / 2 - lw / 2, ly = room.y + 6;
  softShadow(ctx, room.x + room.w / 2, ly + 19, lw / 2, 4, 0.3);
  ctx.fillStyle = 'rgba(10,12,20,0.88)';
  ctx.fillRect(lx, ly, lw, 17);
  ctx.fillStyle = c;
  ctx.fillRect(lx, ly, 3, 17);
  ctx.strokeStyle = `${c}55`;
  ctx.lineWidth = 1;
  ctx.strokeRect(lx + 0.5, ly + 0.5, lw - 1, 16);
  ctx.fillStyle = c;
  ctx.font = 'bold 9px "Noto Sans KR", monospace';
  ctx.textAlign = 'center';
  ctx.fillText(label, room.x + room.w / 2 + 1, ly + 12);
  ctx.textAlign = 'left';
}


function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

export default function PixelOffice({ agents, cycleStatus, recentMessages, onAgentClick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<{
    pixelAgents: PixelAgent[];
    particles:   MsgParticle[];
    celebs:      CelebParticle[];
    frame: number;
    selectedDept: string | null;
    prevMsgKey: string;
  }>({ pixelAgents: [], particles: [], celebs: [], frame: 0, selectedDept: null, prevMsgKey: '' });
  const animRef   = useRef<number>(0);
  const [hoveredDept, setHoveredDept] = useState<string | null>(null);

  // 에이전트 초기화 / 갱신
  useEffect(() => {
    const prev = stateRef.current.pixelAgents;
    const pa: PixelAgent[] = agents.map((a, i) => {
      const dept    = a.department ?? 'orchestration_dept';
      const room    = ROOMS.find(r => r.dept === dept) ?? ROOMS[0];
      const existing = prev.find(p => p.id === a.agent_id);
      if (existing) {
        existing.busy = a.status !== 'Idle';
        return existing;
      }
      const pos = randInRoom(room);
      return {
        id: a.agent_id,
        name: a.character_name.split(' ')[0],
        dept,
        role: a.role,
        x: pos.x, y: pos.y,
        tx: pos.x, ty: pos.y,
        frame: Math.floor(Math.random() * 4),
        dir: Math.random() > 0.5 ? 1 : -1,
        busy: a.status !== 'Idle',
        busyTimer: 0,
        speechBubble: undefined,
        speechTimer: 0,
        skinTone:   SKIN_TONES[i % SKIN_TONES.length],
        shirtColor: SHIRT_COLORS[i % SHIRT_COLORS.length],
      };
    });
    stateRef.current.pixelAgents = pa;
  }, [agents]);

  // 새 메시지 → 파티클 생성 + 수신 에이전트 활성화
  useEffect(() => {
    if (!recentMessages.length) return;
    const last = recentMessages[0];
    const key  = `${last.sender}${last.target}${last.payload.slice(0, 20)}`;
    if (stateRef.current.prevMsgKey === key) return;
    stateRef.current.prevMsgKey = key;

    const from  = roomCenter(last.sender);
    const to    = roomCenter(last.target);
    const color = DEPT_COLOR[last.sender] ?? '#94a3b8';
    const isDone = last.payload.toLowerCase().includes('완료') || last.payload.toLowerCase().includes('done');

    const p: MsgParticle = {
      id: Date.now().toString(),
      sx: from.x, sy: from.y,
      tx: to.x,   ty: to.y,
      t: 0,
      color,
      label: last.payload.replace(/\[task-[^\]]+\]\s*/g, '').slice(0, 25),
      done: isDone,
    };
    stateRef.current.particles.push(p);

    // 수신 에이전트 말풍선 + busy 전환
    const receiver = stateRef.current.pixelAgents.find(a => a.dept === last.target);
    if (receiver) {
      receiver.speechBubble = last.payload.replace(/\[task-[^\]]+\]\s*/g, '').slice(0, 60);
      receiver.speechTimer  = 150;
      receiver.busy         = true;
      receiver.busyTimer    = 100;
    }
  }, [recentMessages]);

  // 메인 애니메이션 루프
  const animate = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const { pixelAgents, particles, celebs } = stateRef.current;
    stateRef.current.frame++;
    const F = stateRef.current.frame;

    const W = canvas.width;
    const H = canvas.height;
    const sx = W / BASE_W, sy = H / BASE_H;
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.scale(sx, sy);

    // 배경
    ctx.fillStyle = '#050508';
    ctx.fillRect(0, 0, BASE_W, BASE_H);

    // 복도 (2개)
    const corridors = [{ x: 273, w: 75 }, { x: 609, w: 78 }];
    corridors.forEach(({ x, w }) => {
      ctx.fillStyle = '#0a0a12';
      ctx.fillRect(x, 12, w, BASE_H - 24);
      ctx.strokeStyle = 'rgba(255,255,255,0.04)'; ctx.lineWidth = 0.5;
      for (let gx = x; gx < x + w; gx += 12) {
        ctx.beginPath(); ctx.moveTo(gx, 12); ctx.lineTo(gx, BASE_H - 12); ctx.stroke();
      }
    });

    // 방 그리기
    ROOMS.forEach(room => drawRoom(ctx, room, hoveredDept === room.dept));

    // 메시지 파티클
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.t += 0.015;
      if (p.t >= 1) {
        // 완료 파티클 폭발
        if (p.done) {
          for (let j = 0; j < 18; j++) {
            const angle = (j / 18) * Math.PI * 2;
            const speed = 1.5 + Math.random() * 3;
            celebs.push({
              id: `${Date.now()}-${j}`,
              x: p.tx, y: p.ty,
              vx: Math.cos(angle) * speed,
              vy: Math.sin(angle) * speed,
              life: 60, maxLife: 60,
              color: p.color,
              size: 2 + Math.random() * 3,
            });
          }
        }
        particles.splice(i, 1);
        continue;
      }

      const px = lerp(p.sx, p.tx, p.t);
      const py = lerp(p.sy, p.ty, p.t) - Math.sin(p.t * Math.PI) * 50;

      // 발광 원
      const g = ctx.createRadialGradient(px, py, 0, px, py, 12);
      g.addColorStop(0, p.color + 'cc');
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, 12, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(px, py, 3, 0, Math.PI * 2); ctx.fill();

      // 라벨
      if (p.t > 0.2 && p.t < 0.8) {
        ctx.font = '7px monospace';
        ctx.fillStyle = p.color + 'cc';
        ctx.textAlign = 'center';
        ctx.fillText(p.label.slice(0, 18), px, py - 15);
        ctx.textAlign = 'left';
      }
    }

    // 완료 파티클 (폭발)
    for (let i = celebs.length - 1; i >= 0; i--) {
      const c = celebs[i];
      c.x += c.vx; c.y += c.vy;
      c.vy += 0.08; // gravity
      c.life--;
      if (c.life <= 0) { celebs.splice(i, 1); continue; }
      const alpha = c.life / c.maxLife;
      ctx.globalAlpha = alpha;
      ctx.fillStyle = c.color;
      ctx.beginPath();
      ctx.arc(c.x, c.y, c.size, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    // 에이전트 업데이트 & 그리기
    pixelAgents.forEach(a => {
      const dx   = a.tx - a.x, dy = a.ty - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 2) {
        if (Math.random() < 0.006 && !a.busy) {
          const room = ROOMS.find(r => r.dept === a.dept) ?? ROOMS[0];
          const pos  = randInRoom(room);
          a.tx = pos.x; a.ty = pos.y;
          a.dir = a.tx > a.x ? 1 : -1;
        }
      } else {
        const speed = a.busy ? 0 : 0.7;
        a.x += (dx / dist) * speed;
        a.y += (dy / dist) * speed;
        a.dir = dx > 0 ? 1 : -1;
      }

      if (F % 8 === 0) a.frame = (a.frame + 1) % 4;

      if (a.busyTimer > 0) {
        a.busyTimer--;
        if (a.busyTimer === 0) a.busy = false;
      }

      if (a.speechTimer > 0) {
        a.speechTimer--;
        if (a.speechTimer === 0) a.speechBubble = undefined;
      }

      if (cycleStatus !== 'stopped' && Math.random() < 0.0008) {
        a.busy = true;
        a.busyTimer = 50 + Math.floor(Math.random() * 70);
      }

      // 에이전트 그리기 (2x)
      drawPixelAgent(ctx, a.x, a.y, a.dir, a.frame, a.busy, a.skinTone, a.shirtColor);

      // 이름표
      ctx.font = '8px monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(0,0,0,0.75)';
      ctx.fillRect(a.x - 18, a.y + 11, 36, 11);
      ctx.fillStyle = DEPT_COLOR[a.dept] ?? '#94a3b8';
      ctx.fillText(a.name, a.x, a.y + 20);
      ctx.textAlign = 'left';

      // 말풍선
      if (a.speechBubble && a.speechTimer > 10) {
        const alpha = a.speechTimer < 25 ? a.speechTimer / 25 : 1;
        ctx.globalAlpha = alpha;
        drawSpeechBubble(ctx, a.x, a.y, a.speechBubble);
        ctx.globalAlpha = 1;
      }

      // 작업 중 표시 (점 3개)
      if (a.busy) {
        const dotCount = ((F / 8) % 3) + 1;
        ctx.fillStyle = DEPT_COLOR[a.dept] ?? '#0ffd6a';
        for (let d = 0; d < dotCount; d++) {
          ctx.beginPath();
          ctx.arc(a.x - 8 + d * 8, a.y - 22, 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    });

    // 상태 오버레이
    if (cycleStatus !== 'stopped') {
      ctx.fillStyle = 'rgba(15,253,106,0.03)';
      ctx.fillRect(0, 0, BASE_W, BASE_H);
      ctx.font = 'bold 10px monospace';
      ctx.fillStyle = 'rgba(15,253,106,0.55)';
      ctx.textAlign = 'right';
      ctx.fillText(`● LIVE · ${cycleStatus}`, BASE_W - 10, BASE_H - 10);
      ctx.textAlign = 'left';
    }

    ctx.restore();
    animRef.current = requestAnimationFrame(animate);
  }, [hoveredDept, cycleStatus]);

  useEffect(() => {
    animRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animRef.current);
  }, [animate]);

  // 캔버스 리사이즈
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ro = new ResizeObserver(() => {
      canvas.width  = canvas.offsetWidth;
      canvas.height = canvas.offsetHeight;
    });
    ro.observe(canvas);
    canvas.width  = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    return () => ro.disconnect();
  }, []);

  // 마우스 호버 → 방 감지 (960×540 역변환)
  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width  * BASE_W;
    const my = (e.clientY - rect.top)  / rect.height * BASE_H;
    const hit = ROOMS.find(r => mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h);
    setHoveredDept(hit?.dept ?? null);
  }, []);

  // 클릭 → 에이전트 또는 방 선택
  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onAgentClick) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const mx = (e.clientX - rect.left) / rect.width  * BASE_W;
    const my = (e.clientY - rect.top)  / rect.height * BASE_H;
    // 에이전트 히트 테스트 (20px 반경)
    const hit = stateRef.current.pixelAgents.find(a => {
      const dx = a.x - mx, dy = a.y - my;
      return Math.sqrt(dx*dx + dy*dy) < 20;
    });
    if (hit) onAgentClick(hit.id, hit.dept);
  }, [onAgentClick]);

  return (
    <canvas
      ref={canvasRef}
      className="pixel-office-canvas"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHoveredDept(null)}
      onClick={handleClick}
      style={{ display: 'block', width: '100%', height: '100%', imageRendering: 'pixelated', cursor: 'crosshair' }}
    />
  );
}
