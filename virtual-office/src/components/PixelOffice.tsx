import { useEffect, useRef, useState, useCallback } from 'react';
import {
  CHAR_H, CHAR_ROW, CHAR_W, FRAME, TILE,
  WALL_PIECE_H, WALL_PIECE_W,
  carpetPieceRect, loadOfficeAssets, tint, wallPieceRect,
  type OfficeAssets,
} from '../office/pixelAssets';
import {
  CORRIDOR, GRID_H, GRID_W, MEETING_SEATS, ROOMS, TILE_WALL,
  buildTileMap, carpetCase, wallMask,
  type Facing, type RoomDef, type Seat,
} from '../office/officeLayout';

interface Agent { agent_id: string; character_name: string; role: string; department?: string; status?: string; }
interface TaskMsg { sender: string; target: string; payload: string; }

interface Props {
  agents: Agent[];
  cycleStatus: string;
  recentMessages: TaskMsg[];
  onAgentClick?: (agentId: string, dept: string) => void;
}

/* 오피스 2D 렌더러.
 *
 * 예전에는 바닥·가구·사람을 전부 fillRect 로 손수 그렸다. 실루엣을 깎고
 * 외곽선을 둘러 사람처럼 보이게 하는 데까지 갔지만, 직접 그린 도형은 결국
 * 도형이었다. 이제는 검증된 픽셀 아트 스프라이트를 쓴다(출처와 라이선스는
 * public/assets/office/ATTRIBUTION.md).
 *
 * 그리는 순서가 곧 원근이다.
 *   1) 바닥 → 카펫 → 벽 : 변하지 않는다. 오프스크린에 한 번만 그려 두고 매
 *                         프레임 통째로 복사한다.
 *   2) 가구 + 사람      : 발밑 y 로 정렬해 한 번에 그린다. 그래야 책상 뒤에 선
 *                         사람이 책상에 가려진다.
 *   3) 파티클 · 라벨    : 항상 맨 위.
 */

const BASE_W = GRID_W * TILE;   // 960
const BASE_H = GRID_H * TILE;   // 544

/** 오케스트레이션 방을 CEO 집무실과 회의실로 나누는 칸막이 행. */
const MEETING_AREA_TOP = 14;

const DEPT_COLOR: Record<string, string> = Object.fromEntries(
  ROOMS.map(r => [r.dept, r.accent]),
);

// ── 에이전트 ─────────────────────────────────────────────
interface PixelAgent {
  id: string; name: string; dept: string; role: string;
  x: number; y: number;         // 발밑 좌표 (베이스 픽셀)
  tx: number; ty: number;       // 목표
  face: Facing;
  seat: Seat | null;            // 평소 자리 (없으면 서성인다)
  /** 남은 경유지. 방을 나갈 때는 문을 지나야 해서 직선으로는 못 간다. */
  path: Array<{ x: number; y: number }>;
  /** 경로 끝에서 바라볼 방향. 회의 자리로 갈 때 쓴다. */
  dest: Seat | null;
  sprite: number;               // char_N
  busy: boolean;
  busyTimer: number;
  speechBubble?: string;
  speechTimer: number;
  restTimer: number;
}

interface MsgParticle {
  id: string;
  sx: number; sy: number;
  tx: number; ty: number;
  t: number;
  color: string;
  label: string;
  done?: boolean;
}

interface CelebParticle {
  id: string; x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  color: string; size: number;
}

const { tiles, roomAt } = buildTileMap();

function roomOf(dept: string): RoomDef {
  return ROOMS.find(r => r.dept === dept) ?? ROOMS[0];
}

/** 타일의 발밑 지점 — 사람은 타일 아래 모서리에 선다. */
function tileFoot(col: number, row: number): { x: number; y: number } {
  return { x: col * TILE + TILE / 2, y: row * TILE + TILE };
}

function roomCenter(dept: string): { x: number; y: number } {
  const r = roomOf(dept);
  return { x: (r.x + r.w / 2) * TILE, y: (r.y + r.h / 2) * TILE };
}

/** 방 안 아무 데나. 가구를 피하지는 않는다 — 사람이 화분을 스치고 지나가는
 *  정도는 이 그림에서 문제가 되지 않는다. */
function randomSpotIn(room: RoomDef): { x: number; y: number } {
  const col = room.x + 2 + Math.floor(Math.random() * Math.max(1, room.w - 4));
  const row = room.y + 2 + Math.floor(Math.random() * Math.max(1, room.h - 4));
  return tileFoot(col, row);
}

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

// ── 말풍선 ───────────────────────────────────────────────
function drawSpeechBubble(ctx: CanvasRenderingContext2D, x: number, y: number, text: string) {
  const line = text.length > 26 ? text.slice(0, 25) + '…' : text;
  ctx.font = '8px "JetBrains Mono", monospace';
  const w = Math.max(40, ctx.measureText(line).width + 12);
  const h = 16;
  const bx = x - w / 2;
  const by = y - CHAR_H - 26;

  ctx.fillStyle = 'rgba(9,11,18,0.92)';
  ctx.fillRect(bx, by, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.22)';
  ctx.lineWidth = 1;
  ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1);
  ctx.fillStyle = 'rgba(9,11,18,0.92)';
  ctx.beginPath();
  ctx.moveTo(x - 4, by + h);
  ctx.lineTo(x + 4, by + h);
  ctx.lineTo(x, by + h + 5);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = '#dbe4f0';
  ctx.textAlign = 'center';
  ctx.fillText(line, x, by + 11);
  ctx.textAlign = 'left';
}

/* ── 정지 배경 ────────────────────────────────────────────────────────────
 * 바닥·카펫·벽은 한 번 그리면 변하지 않는다. 매 프레임 2천 개의 타일을 다시
 * 그리는 대신 오프스크린에 한 번 그려 두고 통째로 복사한다. */
function paintStatic(assets: OfficeAssets): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = BASE_W;
  c.height = BASE_H;
  const ctx = c.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  // 바닥
  for (let row = 0; row < GRID_H; row++) {
    for (let col = 0; col < GRID_W; col++) {
      const ri = roomAt[row * GRID_W + col];
      const room = ri >= 0 ? ROOMS[ri] : null;
      const pattern = room ? room.floorPattern : CORRIDOR.floorPattern;
      const color = room ? room.floorColor : CORRIDOR.floorColor;
      const img = assets.floors[pattern % assets.floors.length];
      ctx.drawImage(tint(img, color, `f${pattern}:${color}`), col * TILE, row * TILE);
    }
  }

  // 카펫 — 교차점 단위 오토타일. 방 색을 입힌다.
  for (const room of ROOMS) {
    const rug = room.carpet;
    if (!rug) continue;
    const inside = (col: number, row: number) =>
      col >= rug.x && col < rug.x + rug.w && row >= rug.y && row < rug.y + rug.h;
    const img = assets.carpets[rug.variant % assets.carpets.length];
    const sheet = tint(img, rug.color, `c${rug.variant}:${rug.color}`);
    for (let jr = rug.y; jr <= rug.y + rug.h; jr++) {
      for (let jc = rug.x; jc <= rug.x + rug.w; jc++) {
        const cs = carpetCase(inside, jc, jr);
        if (cs === 0) continue;
        const { sx, sy } = carpetPieceRect(cs);
        // 교차점은 타일 경계에 있으므로 반 칸씩 당겨 그린다.
        ctx.drawImage(sheet, sx, sy, TILE, TILE,
          jc * TILE - TILE / 2, jr * TILE - TILE / 2, TILE, TILE);
      }
    }
  }

  // 벽 — 이웃 비트마스크로 조각을 고른다. 조각은 타일보다 16px 위로 솟는다.
  for (let row = 0; row < GRID_H; row++) {
    for (let col = 0; col < GRID_W; col++) {
      const i = row * GRID_W + col;
      if (tiles[i] !== TILE_WALL) continue;
      const ri = roomAt[i];
      const color = ri >= 0 ? ROOMS[ri].wallColor : '#6a7085';
      const sheet = tint(assets.wall, color, `w:${color}`);
      const { sx, sy } = wallPieceRect(wallMask(tiles, col, row));
      ctx.drawImage(sheet, sx, sy, WALL_PIECE_W, WALL_PIECE_H,
        col * TILE, row * TILE - TILE, WALL_PIECE_W, WALL_PIECE_H);
    }
  }

  return c;
}

export default function PixelOffice({ agents, cycleStatus, recentMessages, onAgentClick }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const assetsRef = useRef<OfficeAssets | null>(null);
  const staticRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<{
    pixelAgents: PixelAgent[];
    particles: MsgParticle[];
    celebs: CelebParticle[];
    frame: number;
    prevMsgKey: string;
    /** 회의가 끝나는 프레임. 0 이면 회의 중이 아니다. */
    meetingUntil: number;
    /** 다음 정기 회의 프레임. */
    nextMeeting: number;
    /** 방송을 받아 회의를 소집해야 한다는 표시. */
    meetingRequested: boolean;
  }>({
    pixelAgents: [], particles: [], celebs: [], frame: 0, prevMsgKey: '',
    meetingUntil: 0, nextMeeting: 60 * 45, meetingRequested: false,
  });
  const animRef = useRef<number>(0);
  const [hoveredDept, setHoveredDept] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 스프라이트 로드
  useEffect(() => {
    let alive = true;
    loadOfficeAssets().then(a => {
      if (!alive) return;
      assetsRef.current = a;
      staticRef.current = paintStatic(a);
      setReady(true);
    }).catch((e: Error) => {
      if (alive) setLoadError(e.message);
    });
    return () => { alive = false; };
  }, []);

  // 에이전트 초기화 / 갱신 — 부서 안에서 자리를 하나씩 나눠 준다.
  useEffect(() => {
    const prev = stateRef.current.pixelAgents;
    const taken = new Map<string, number>();
    stateRef.current.pixelAgents = agents.map((a, i) => {
      const dept = a.department ?? 'orchestration_dept';
      const room = roomOf(dept);
      const n = taken.get(dept) ?? 0;
      taken.set(dept, n + 1);
      const seat = room.seats.length ? room.seats[n % room.seats.length] : null;

      const existing = prev.find(p => p.id === a.agent_id);
      if (existing) {
        existing.busy = a.status !== 'Idle';
        existing.seat = seat;
        return existing;
      }
      const start = seat ? tileFoot(seat.col, seat.row) : randomSpotIn(room);
      return {
        id: a.agent_id,
        name: a.character_name.split(' ')[0],
        dept,
        role: a.role,
        x: start.x, y: start.y,
        tx: start.x, ty: start.y,
        face: seat?.face ?? 'down',
        seat,
        path: [],
        dest: null,
        sprite: i % 6,
        busy: a.status !== 'Idle',
        busyTimer: 0,
        speechBubble: undefined,
        speechTimer: 0,
        restTimer: 200 + Math.floor(Math.random() * 600),
      };
    });
  }, [agents]);

  // 새 메시지 → 파티클 + 수신 에이전트 활성화
  useEffect(() => {
    if (!recentMessages.length) return;
    const last = recentMessages[0];
    const key = `${last.sender}${last.target}${last.payload.slice(0, 20)}`;
    if (stateRef.current.prevMsgKey === key) return;
    stateRef.current.prevMsgKey = key;

    const from = roomCenter(last.sender);
    const to = roomCenter(last.target);
    const color = DEPT_COLOR[last.sender] ?? '#94a3b8';
    const text = last.payload.replace(/\[task-[^\]]+\]\s*/g, '');
    const isDone = /완료|done/i.test(text);

    stateRef.current.particles.push({
      id: Date.now().toString(),
      sx: from.x, sy: from.y,
      tx: to.x, ty: to.y,
      t: 0, color,
      label: text.slice(0, 25),
      done: isDone,
    });

    // 전체 방송·브리핑은 회의로 본다 — 사람들이 회의실로 모인다.
    if (/전체|브리핑|회의|방송/.test(text)) stateRef.current.meetingRequested = true;

    const receiver = stateRef.current.pixelAgents.find(a => a.dept === last.target);
    if (receiver) {
      receiver.speechBubble = text.slice(0, 60);
      receiver.speechTimer = 180;
      receiver.busy = true;
      receiver.busyTimer = 240;
    }
  }, [recentMessages]);

  // ── 메인 루프 ───────────────────────────────────────────
  const animate = useCallback(() => {
    animRef.current = requestAnimationFrame(animate);

    const canvas = canvasRef.current;
    const assets = assetsRef.current;
    const bg = staticRef.current;
    if (!canvas || !assets || !bg) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { pixelAgents, particles, celebs } = stateRef.current;
    const F = ++stateRef.current.frame;

    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = '#0a0c14';
    ctx.fillRect(0, 0, BASE_W, BASE_H);
    ctx.drawImage(bg, 0, 0);

    /* ── 회의 소집 · 해산 ──
     * 회의실을 차려 놓고 아무도 안 가면 그냥 빈 방이다. 전체 방송을 받거나
     * 일정 시간이 지나면 각 부서에서 한 명씩 회의실로 걸어온다. 방은 벽으로
     * 막혀 있으므로 문을 지나는 경유지를 따라간다. */
    const st = stateRef.current;
    const running = cycleStatus !== 'stopped';
    /** 회의실 안에 이미 있는 사람은 복도로 나갔다 들어올 필요가 없다. */
    const inMeetingRoom = (a: PixelAgent) =>
      a.dept === 'orchestration_dept' && a.y > MEETING_AREA_TOP * TILE;
    let meeting = st.meetingUntil > 0 && F < st.meetingUntil;

    if (!meeting && st.meetingUntil > 0) {
      // 방금 끝났다 — 각자 제자리로.
      st.meetingUntil = 0;
      for (const a of pixelAgents) {
        if (!a.dest) continue;
        const home = a.seat ? tileFoot(a.seat.col, a.seat.row) : { x: a.x, y: a.y };
        const staying = a.seat ? a.seat.row > MEETING_AREA_TOP : false;
        a.dest = a.seat;
        a.path = staying && a.dept === 'orchestration_dept'
          ? [home]
          : [...[...roomOf(a.dept).toMeeting].reverse().map(([c, r]) => tileFoot(c, r)), home];
      }
    } else if (!meeting && (st.meetingRequested || (running && F > st.nextMeeting))) {
      st.meetingRequested = false;
      st.meetingUntil = F + 60 * 30;          // 30초쯤 앉아 있는다
      st.nextMeeting = F + 60 * 150;
      meeting = true;
      let k = 0;
      for (const a of pixelAgents) {
        if (k >= MEETING_SEATS.length) break;
        const target = MEETING_SEATS[k++];
        const chair = tileFoot(target.col, target.row);
        a.dest = target;
        a.path = inMeetingRoom(a)
          ? [chair]
          : [...roomOf(a.dept).toMeeting.map(([c, r]) => tileFoot(c, r)), chair];
      }
    }

    // ── 에이전트 이동 ──
    for (const a of pixelAgents) {
      // 목적지: 경로가 남아 있으면 다음 경유지, 아니면 하던 대로.
      if (a.path.length) {
        a.tx = a.path[0].x; a.ty = a.path[0].y;
      } else if (a.busy && a.seat && !meeting) {
        // 바빠지면 자기 자리로 돌아가 앉는다 — 일하는 모습이 보여야 한다.
        const s = tileFoot(a.seat.col, a.seat.row);
        a.tx = s.x; a.ty = s.y;
      }

      const dx = a.tx - a.x, dy = a.ty - a.y;
      const dist = Math.hypot(dx, dy);

      if (dist < 1.5) {
        a.x = a.tx; a.y = a.ty;
        if (a.path.length) {
          a.path.shift();
          if (!a.path.length && a.dest) a.face = a.dest.face;
        } else {
          if (a.dest) {
            a.face = a.dest.face;
          } else if (a.seat) {
            const s = tileFoot(a.seat.col, a.seat.row);
            if (Math.hypot(s.x - a.x, s.y - a.y) < 1.5) a.face = a.seat.face;
          }
          // 자리에 있다가 가끔 일어나 돌아다닌다. 바쁘거나 회의 중이면 안 움직인다.
          if (!a.busy && !meeting && --a.restTimer <= 0) {
            a.restTimer = 260 + Math.floor(Math.random() * 700);
            const spot = (Math.random() < 0.5 && a.seat)
              ? tileFoot(a.seat.col, a.seat.row)
              : randomSpotIn(roomOf(a.dept));
            a.tx = spot.x; a.ty = spot.y;
          }
        }
      } else {
        const speed = a.path.length ? 0.8 : 0.55;   // 회의에 갈 때는 좀 빨리 걷는다
        a.x += (dx / dist) * speed;
        a.y += (dy / dist) * speed;
        a.face = Math.abs(dx) > Math.abs(dy)
          ? (dx > 0 ? 'right' : 'left')
          : (dy > 0 ? 'down' : 'up');
      }

      if (a.busyTimer > 0 && --a.busyTimer === 0) a.busy = false;
      if (a.speechTimer > 0 && --a.speechTimer === 0) a.speechBubble = undefined;
      if (running && !meeting && Math.random() < 0.0008) {
        a.busy = true;
        a.busyTimer = 180 + Math.floor(Math.random() * 300);
      }
    }

    // ── 가구 + 사람을 발밑 y 로 정렬해 한 번에 ──
    const layer: Array<{ y: number; draw: () => void }> = [];

    for (const room of ROOMS) {
      for (const p of room.furniture) {
        const sp = assets.furniture.get(p.id);
        if (!sp) continue;
        const x = p.col * TILE;
        const y = (p.row + 1) * TILE - sp.h;
        layer.push({
          y: y + sp.h,
          draw: () => {
            if (!p.flip) { ctx.drawImage(sp.img, x, y); return; }
            ctx.save();
            ctx.translate(x + sp.w, y);
            ctx.scale(-1, 1);
            ctx.drawImage(sp.img, 0, 0);
            ctx.restore();
          },
        });
      }
    }

    for (const a of pixelAgents) {
      const moving = Math.hypot(a.tx - a.x, a.ty - a.y) >= 1.5;
      const sheet = assets.chars[a.sprite % assets.chars.length];
      const flip = a.face === 'left';
      const rowKey: keyof typeof CHAR_ROW =
        a.face === 'up' ? 'up' : a.face === 'down' ? 'down' : 'right';
      const frame = moving
        ? FRAME.walk[(F >> 3) % FRAME.walk.length]
        : a.busy
          ? FRAME.typing[(F >> 4) % FRAME.typing.length]
          : FRAME.walk[0];
      const sx = frame * CHAR_W;
      const sy = CHAR_ROW[rowKey] * CHAR_H;
      const ax = Math.round(a.x), ay = Math.round(a.y);
      const dx = ax - CHAR_W / 2;
      const dy = ay - CHAR_H;

      layer.push({
        y: a.y,
        draw: () => {
          // 발밑 그림자 — 없으면 인물이 바닥에서 떠 보인다.
          ctx.fillStyle = 'rgba(0,0,0,0.28)';
          ctx.beginPath();
          ctx.ellipse(ax, ay - 1, 6, 2.5, 0, 0, Math.PI * 2);
          ctx.fill();

          if (flip) {
            ctx.save();
            ctx.translate(dx + CHAR_W, dy);
            ctx.scale(-1, 1);
            ctx.drawImage(sheet, sx, sy, CHAR_W, CHAR_H, 0, 0, CHAR_W, CHAR_H);
            ctx.restore();
          } else {
            ctx.drawImage(sheet, sx, sy, CHAR_W, CHAR_H, dx, dy, CHAR_W, CHAR_H);
          }
        },
      });
    }

    layer.sort((p, q) => p.y - q.y);
    for (const d of layer) d.draw();

    // ── 방 강조 · 이름표 ──
    for (const room of ROOMS) {
      const rx = room.x * TILE, ry = room.y * TILE;
      const rw = room.w * TILE, rh = room.h * TILE;
      if (hoveredDept === room.dept) {
        ctx.fillStyle = room.accent + '1f';
        ctx.fillRect(rx, ry, rw, rh);
        ctx.strokeStyle = room.accent;
        ctx.lineWidth = 1;
        ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
      }
      ctx.font = 'bold 9px "Noto Sans KR", sans-serif';
      const lw = ctx.measureText(room.label).width + 12;
      ctx.fillStyle = 'rgba(6,8,14,0.85)';
      ctx.fillRect(rx + 6, ry + 3, lw, 14);
      ctx.fillStyle = room.accent;
      ctx.fillRect(rx + 6, ry + 3, 2, 14);
      ctx.fillStyle = '#e6ecf5';
      ctx.fillText(room.label, rx + 13, ry + 13);
    }

    // ── 사람 위 표시: 이름 · 작업중 · 말풍선 ──
    for (const a of pixelAgents) {
      ctx.font = '8px "JetBrains Mono", monospace';
      ctx.textAlign = 'center';
      const nw = ctx.measureText(a.name).width + 8;
      ctx.fillStyle = 'rgba(6,8,14,0.82)';
      ctx.fillRect(a.x - nw / 2, a.y + 2, nw, 11);
      ctx.fillStyle = DEPT_COLOR[a.dept] ?? '#94a3b8';
      ctx.fillText(a.name, a.x, a.y + 10);
      ctx.textAlign = 'left';

      if (a.busy) {
        const lit = Math.floor(F / 12) % 3;
        for (let d = 0; d < 3; d++) {
          ctx.fillStyle = d === lit
            ? (DEPT_COLOR[a.dept] ?? '#0ffd6a')
            : 'rgba(255,255,255,0.22)';
          ctx.fillRect(a.x - 5 + d * 4, a.y - CHAR_H - 7, 2, 2);
        }
      }

      if (a.speechBubble && a.speechTimer > 10) {
        ctx.globalAlpha = a.speechTimer < 30 ? a.speechTimer / 30 : 1;
        drawSpeechBubble(ctx, a.x, a.y, a.speechBubble);
        ctx.globalAlpha = 1;
      }
    }

    // ── 메시지 파티클 ──
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i];
      p.t += 0.012;
      if (p.t >= 1) {
        if (p.done) {
          for (let j = 0; j < 18; j++) {
            const angle = (j / 18) * Math.PI * 2;
            const speed = 1.2 + Math.random() * 2.4;
            celebs.push({
              id: `${Date.now()}-${j}`,
              x: p.tx, y: p.ty,
              vx: Math.cos(angle) * speed,
              vy: Math.sin(angle) * speed,
              life: 60, maxLife: 60,
              color: p.color,
              size: 1.5 + Math.random() * 2.5,
            });
          }
        }
        particles.splice(i, 1);
        continue;
      }
      const px = lerp(p.sx, p.tx, p.t);
      const py = lerp(p.sy, p.ty, p.t) - Math.sin(p.t * Math.PI) * 46;

      const g = ctx.createRadialGradient(px, py, 0, px, py, 11);
      g.addColorStop(0, p.color + 'cc');
      g.addColorStop(1, 'transparent');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(px, py, 11, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.arc(px, py, 2.5, 0, Math.PI * 2); ctx.fill();

      if (p.t > 0.2 && p.t < 0.8) {
        ctx.font = '7px "JetBrains Mono", monospace';
        ctx.fillStyle = p.color + 'cc';
        ctx.textAlign = 'center';
        ctx.fillText(p.label.slice(0, 18), px, py - 14);
        ctx.textAlign = 'left';
      }
    }

    for (let i = celebs.length - 1; i >= 0; i--) {
      const c = celebs[i];
      c.x += c.vx; c.y += c.vy; c.vy += 0.08; c.life--;
      if (c.life <= 0) { celebs.splice(i, 1); continue; }
      ctx.globalAlpha = c.life / c.maxLife;
      ctx.fillStyle = c.color;
      ctx.beginPath(); ctx.arc(c.x, c.y, c.size, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }

    if (meeting) {
      const room = ROOMS.find(r => r.dept === 'orchestration_dept');
      if (room) {
        const label = '● 회의 중';
        ctx.font = 'bold 9px "Noto Sans KR", sans-serif';
        const lw = ctx.measureText(label).width + 12;
        const bx = (room.x + room.w / 2) * TILE - lw / 2;
        const by = 15 * TILE + 4;
        ctx.fillStyle = 'rgba(6,8,14,0.9)';
        ctx.fillRect(bx, by, lw, 14);
        ctx.fillStyle = room.accent;
        ctx.fillText(label, bx + 6, by + 10);
      }
    }

    if (cycleStatus !== 'stopped') {
      ctx.font = 'bold 9px "JetBrains Mono", monospace';
      ctx.fillStyle = 'rgba(15,253,106,0.6)';
      ctx.textAlign = 'right';
      ctx.fillText(`● LIVE · ${cycleStatus}`, BASE_W - 8, BASE_H - 8);
      ctx.textAlign = 'left';
    }
  }, [hoveredDept, cycleStatus]);

  useEffect(() => {
    animRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animRef.current);
  }, [animate]);

  /* 캔버스는 논리 해상도(960×544)로 고정하고 CSS 로 늘린다. 예전에는 표시
   * 크기에 맞춰 backing store 를 바꾸고 매 프레임 scale() 을 걸었는데, 배율이
   * 정수가 아니면 타일 경계가 흐려진다. 고정 해상도 + image-rendering:pixelated
   * 로 확대하면 픽셀이 그대로 커진다. */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = BASE_W;
    canvas.height = BASE_H;
    const ctx = canvas.getContext('2d');
    if (ctx) ctx.imageSmoothingEnabled = false;
  }, [ready]);

  const toBase = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    return {
      mx: (e.clientX - rect.left) / rect.width * BASE_W,
      my: (e.clientY - rect.top) / rect.height * BASE_H,
    };
  };

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { mx, my } = toBase(e);
    const col = Math.floor(mx / TILE), row = Math.floor(my / TILE);
    const ri = col >= 0 && col < GRID_W && row >= 0 && row < GRID_H
      ? roomAt[row * GRID_W + col] : -1;
    setHoveredDept(ri >= 0 ? ROOMS[ri].dept : null);
  }, []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onAgentClick) return;
    const { mx, my } = toBase(e);
    const hit = stateRef.current.pixelAgents.find(a =>
      mx >= a.x - 10 && mx <= a.x + 10 && my >= a.y - CHAR_H && my <= a.y + 4);
    if (hit) onAgentClick(hit.id, hit.dept);
  }, [onAgentClick]);

  if (loadError) {
    return (
      <div className="pixel-office-fallback" role="alert">
        오피스 스프라이트를 불러오지 못했습니다 — {loadError}
      </div>
    );
  }

  return (
    <canvas
      ref={canvasRef}
      className="pixel-office-canvas"
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setHoveredDept(null)}
      onClick={handleClick}
      style={{
        display: 'block',
        width: '100%',
        height: '100%',
        imageRendering: 'pixelated',
        cursor: 'pointer',
      }}
    />
  );
}
