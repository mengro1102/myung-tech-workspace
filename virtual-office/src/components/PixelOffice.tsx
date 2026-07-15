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
  const S = 2; // 2x 스케일 계수

  // 머리 (16×14px)
  ctx.fillStyle = skinTone;
  ctx.fillRect(px - 8*S/2, py - 14*S/2, 8*S/2, 7*S/2);

  // 눈
  ctx.fillStyle = '#1a1a2e';
  ctx.fillRect(px + (dir > 0 ? 2 : -6)*S/2, py - 12*S/2, 2*S/2, 2*S/2);

  // 귀
  ctx.fillStyle = skinTone;
  ctx.fillRect(px - 10*S/2, py - 12*S/2, 2*S/2, 4*S/2);
  ctx.fillRect(px + 8*S/2,  py - 12*S/2, 2*S/2, 4*S/2);

  // 몸 (셔츠)
  ctx.fillStyle = shirtColor;
  ctx.fillRect(px - 8*S/2, py - 7*S/2, 8*S/2, 7*S/2);

  // 다리 애니메이션
  ctx.fillStyle = '#374151';
  if (!busy) {
    const legOff = frame % 2 === 0 ? 0 : 4;
    ctx.fillRect(px - 6*S/2, py, 3*S/2, 5*S/2 + legOff);
    ctx.fillRect(px + 2*S/2, py, 3*S/2, 5*S/2 - legOff + 4);
  } else {
    // 앉아서 작업 중
    ctx.fillRect(px - 6*S/2, py - 2, 3*S/2, 4*S/2);
    ctx.fillRect(px + 2*S/2, py - 2, 3*S/2, 4*S/2);
    // 팔 (타이핑 모션)
    ctx.fillStyle = skinTone;
    const armOff = (frame % 3) * 2;
    ctx.fillRect(px - 14*S/2 + armOff, py - 5*S/2, 3*S/2, 2*S/2);
    ctx.fillRect(px + 10*S/2 - armOff, py - 5*S/2, 3*S/2, 2*S/2);
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

function drawRoom(ctx: CanvasRenderingContext2D, room: Room, selected: boolean) {
  const c  = DEPT_COLOR[room.dept] ?? '#64748b';
  const dk = DEPT_DARK[room.dept]  ?? '#1a1a2e';

  // 바닥 타일
  ctx.fillStyle = dk;
  ctx.fillRect(room.x, room.y, room.w, room.h);

  // 타일 격자
  ctx.strokeStyle = `${c}18`;
  ctx.lineWidth = 0.5;
  for (let gx = room.x; gx < room.x + room.w; gx += 24) {
    ctx.beginPath(); ctx.moveTo(gx, room.y); ctx.lineTo(gx, room.y + room.h); ctx.stroke();
  }
  for (let gy = room.y; gy < room.y + room.h; gy += 24) {
    ctx.beginPath(); ctx.moveTo(room.x, gy); ctx.lineTo(room.x + room.w, gy); ctx.stroke();
  }

  // 테두리
  ctx.strokeStyle = selected ? c : `${c}44`;
  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeRect(room.x + 0.5, room.y + 0.5, room.w - 1, room.h - 1);

  // 방 이름 표시판
  const label = DEPT_LABEL[room.dept] ?? room.dept;
  const lw    = label.length * 7 + 14;
  ctx.fillStyle = `${c}33`;
  ctx.fillRect(room.x + room.w / 2 - lw / 2, room.y + 5, lw, 16);
  ctx.fillStyle = c;
  ctx.font = 'bold 9px monospace';
  ctx.textAlign = 'center';
  ctx.fillText(label, room.x + room.w / 2, room.y + 17);
  ctx.textAlign = 'left';

  // 가구 (픽셀 디자인)
  ctx.fillStyle = `${c}22`;
  if (room.dept === 'orchestration_dept') {
    // 원형 회의 테이블
    ctx.beginPath();
    ctx.ellipse(room.x + room.w / 2, room.y + room.h / 2, 55, 32, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `${c}55`; ctx.lineWidth = 1.5;
    ctx.stroke();
    // 의자들
    for (let i = 0; i < 6; i++) {
      const angle = (i / 6) * Math.PI * 2;
      const cx = room.x + room.w / 2 + Math.cos(angle) * 70;
      const cy = room.y + room.h / 2 + Math.sin(angle) * 42;
      ctx.fillStyle = `${c}44`;
      ctx.beginPath(); ctx.arc(cx, cy, 6, 0, Math.PI * 2); ctx.fill();
    }
  } else {
    // L자형 데스크
    ctx.fillRect(room.x + 20, room.y + 36, room.w - 40, 14);
    ctx.fillRect(room.x + 20, room.y + 36, 14, room.h - 60);
    // 모니터
    ctx.fillStyle = `${c}55`;
    ctx.fillRect(room.x + 32, room.y + 22, 24, 16);
    ctx.fillStyle = `${c}22`;
    ctx.fillRect(room.x + 42, room.y + 38, 4, 4);
    // 사이드 선반
    ctx.fillStyle = `${c}18`;
    ctx.fillRect(room.x + room.w - 30, room.y + 50, 16, room.h - 80);
  }
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
