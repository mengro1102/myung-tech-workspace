import { useEffect, useRef, useState } from 'react';
import { api, AgentSummary, AgentDetail, EventRecord, deptColors, deptLabels, avatarFor } from '../api';
import { AGENT_PERSONAS, PersonaData } from '../data/personas';
import '../styles/office.css';

/* ══════════════════════════════════════════════════
   World constants
══════════════════════════════════════════════════ */
const WORLD_W = 1500;
const WORLD_H = 580;

/* Dept metadata — used only for React UI; Phaser uses no color bounding boxes */
const DEPT_META = [
  { id: 'research_dept',      hex: '#2ecc71', label: '학술연구부'    },
  { id: 'finance_dept',       hex: '#3b82f6', label: '금융투자부'    },
  { id: 'orchestration_dept', hex: '#f59e0b', label: '오케스트레이션' },
  { id: 'dev_dept',           hex: '#ef4444', label: '개발팀'        },
  { id: 'content_dept',       hex: '#a855f7', label: '콘텐츠생산부'  },
] as const;

/* Agent positions + intuitive names (성 + 역할 keyword) */
const AGENT_POS: Record<string, {
  x: number; y: number; dept: string; mgr: boolean;
  kname: string;   /* 김개발 스타일 */
  role:  string;   /* 상세 역할 */
}> = {
  orch_master_01:  { x: 750,  y: 200, dept: 'orchestration_dept', mgr: true,  kname: '명총괄',  role: 'CEO · 총괄 오케스트레이터'  },
  res_pm_01:       { x: 145,  y: 140, dept: 'research_dept',      mgr: true,  kname: '이연구',  role: '학술연구부 팀장'            },
  res_worker_01:   { x: 78,   y: 310, dept: 'research_dept',      mgr: false, kname: '박데이터', role: '데이터 엔지니어'           },
  res_crawler_01:  { x: 210,  y: 310, dept: 'research_dept',      mgr: false, kname: '김탐색',  role: '크롤러 개발자'              },
  fin_pm_01:       { x: 435,  y: 140, dept: 'finance_dept',       mgr: true,  kname: '최투자',  role: '금융투자부 팀장'            },
  fin_worker_01:   { x: 435,  y: 310, dept: 'finance_dept',       mgr: false, kname: '윤분석',  role: '투자 분석가'               },
  dev_pm_01:       { x: 1020, y: 140, dept: 'dev_dept',           mgr: true,  kname: '장개발',  role: '개발팀 팀장'               },
  dev_coder_01:    { x: 940,  y: 310, dept: 'dev_dept',           mgr: false, kname: '신코딩',  role: '소프트웨어 엔지니어'        },
  dev_qa_01:       { x: 1100, y: 310, dept: 'dev_dept',           mgr: false, kname: '오품질',  role: 'QA 엔지니어'               },
  con_pm_01:       { x: 1330, y: 140, dept: 'content_dept',       mgr: true,  kname: '한콘텐츠', role: '콘텐츠생산부 팀장'        },
  con_designer_01: { x: 1248, y: 310, dept: 'content_dept',       mgr: false, kname: '임디자인', role: 'UI/UX 디자이너'           },
  con_worker_01:   { x: 1432, y: 310, dept: 'content_dept',       mgr: false, kname: '강작가',  role: '콘텐츠 작가'               },
};

/* Dept colors (for React UI only) */
const DC: Record<string, string> = {
  research_dept: '#2ecc71', finance_dept: '#3b82f6',
  orchestration_dept: '#f59e0b', dev_dept: '#ef4444', content_dept: '#a855f7',
};

/* ══════════════════════════════════════════════════
   Main Component
══════════════════════════════════════════════════ */
export default function VirtualOffice() {
  const [agents,      setAgents]      = useState<AgentSummary[]>([]);
  const [events,      setEvents]      = useState<EventRecord[]>([]);
  const [selectedId,  setSelectedId]  = useState<string | null>(null);
  const [agentDetail, setAgentDetail] = useState<AgentDetail | null>(null);
  const phaserRef = useRef<HTMLDivElement>(null);
  const gameRef   = useRef<any>(null);

  useEffect(() => {
    api.listAgents().then(d => setAgents(d?.agents ?? []));
    api.listEvents().then(d => setEvents((d?.events ?? []).slice(-30).reverse()));
  }, []);

  useEffect(() => {
    const es = new EventSource('/api/events/stream');
    es.addEventListener('new_event', (e: MessageEvent) => {
      try { setEvents(p => [JSON.parse(e.data) as EventRecord, ...p].slice(0, 30)); } catch {}
    });
    es.addEventListener('agent_state_change', (e: MessageEvent) => {
      try {
        const d = JSON.parse(e.data) as { agent_id: string; status: string };
        setAgents(p => p.map(a => a.agent_id === d.agent_id ? { ...a, status: d.status } : a));
      } catch {}
    });
    return () => es.close();
  }, []);

  useEffect(() => {
    const h = async (e: Event) => {
      const { agentId } = (e as CustomEvent<{ agentId: string }>).detail;
      setSelectedId(agentId);
      setAgentDetail(await api.getAgent(agentId));
    };
    window.addEventListener('vo:npc-click', h);
    return () => window.removeEventListener('vo:npc-click', h);
  }, []);

  /* ── Phaser ── */
  useEffect(() => {
    if (!phaserRef.current) return;

    (async () => {
      const Phaser = (await import('phaser')).default;
      if (gameRef.current) return;

      /* ─── BootScene ─── */
      class BootScene extends Phaser.Scene {
        constructor() { super('Boot'); }
        preload() {
          ['orchestration','research','finance','dev','content'].forEach(d => {
            this.load.image(`npc_${d}_m`, `/sprites/npc_${d}_manager.png`);
            this.load.image(`npc_${d}_w`, `/sprites/npc_${d}_worker.png`);
          });
          this.load.image('floor_tile', '/sprites/office/floor.png');
          const { width: cw, height: ch } = this.cameras.main;
          const bar = this.add.graphics();
          this.add.text(cw / 2, ch / 2 - 20, '명테크 오피스 로딩 중…', {
            fontSize: '11px', color: '#4b5563', fontFamily: 'Noto Sans KR, Inter, sans-serif',
          }).setOrigin(0.5);
          this.load.on('progress', (v: number) => {
            bar.clear();
            bar.fillStyle(0x10b981, 1);
            bar.fillRect(cw / 2 - 80, ch / 2, 160 * v, 6);
          });
        }
        create() { this.scene.start('Office'); }
      }

      /* ─── OfficeScene ─── */
      class OfficeScene extends Phaser.Scene {
        /* physics body (invisible) + separate visuals */
        playerBody!:   Phaser.GameObjects.Rectangle;
        ceoSprite!:    Phaser.GameObjects.Image | Phaser.GameObjects.Rectangle;
        ceoLabel!:     Phaser.GameObjects.Text;
        ceoRing!:      Phaser.GameObjects.Arc;
        ceoZone!:      Phaser.GameObjects.Zone;
        cursors!:      Phaser.Types.Input.Keyboard.CursorKeys;
        wasd!: { up: Phaser.Input.Keyboard.Key; down: Phaser.Input.Keyboard.Key;
                 left: Phaser.Input.Keyboard.Key; right: Phaser.Input.Keyboard.Key };
        speed = 85;

        constructor() { super('Office'); }

        create() {
          /* floor background */
          if (this.textures.exists('floor_tile')) {
            this.add.tileSprite(0, 0, WORLD_W, WORLD_H, 'floor_tile')
              .setOrigin(0, 0).setAlpha(0.22).setDepth(0);
          }
          /* world graphics */
          const g = this.add.graphics().setDepth(1);
          this.drawWorld(g);

          /* NPCs (excludes CEO — CEO = player, drawn separately) */
          Object.entries(AGENT_POS).forEach(([id, pos]) => {
            if (id === 'orch_master_01') return;
            this.spawnNPC(id, pos);
          });

          /* ── CEO (player) ── */
          const pp = AGENT_POS.orch_master_01;
          const ceoKey = 'npc_orchestration_m';

          /* physics body: small invisible rect */
          this.playerBody = this.add.rectangle(pp.x, pp.y, 10, 10, 0x000000, 0).setDepth(0);
          this.physics.add.existing(this.playerBody);
          (this.playerBody.body as Phaser.Physics.Arcade.Body).setCollideWorldBounds(true);

          /* CEO desk */
          const gd = this.add.graphics().setDepth(3);
          this.drawCEODesk(gd, pp.x, pp.y);

          /* CEO visual */
          if (this.textures.exists(ceoKey)) {
            this.ceoSprite = this.add.image(pp.x, pp.y, ceoKey)
              .setScale(1.3).setOrigin(0.5, 1).setDepth(10);
          } else {
            this.ceoSprite = this.add.rectangle(pp.x, pp.y, 12, 18, 0xf59e0b).setDepth(10);
          }

          /* CEO pulse ring */
          this.ceoRing = this.add.arc(pp.x, pp.y - 20, 14, 0, 360, false, 0xf59e0b, 0.45).setDepth(9);
          this.tweens.add({
            targets: this.ceoRing,
            scaleX: 2.8, scaleY: 2.8, alpha: 0,
            duration: 1600, repeat: -1, ease: 'Sine.easeOut',
          });

          /* CEO label */
          this.ceoLabel = this.add.text(pp.x, pp.y + 2, '명총괄\nCEO · 총괄', {
            fontSize: '8px', color: '#f59e0b', fontStyle: 'bold',
            fontFamily: 'Noto Sans KR, Inter, sans-serif',
            backgroundColor: 'rgba(7,7,15,0.85)',
            padding: { x: 4, y: 2 }, align: 'center',
          }).setOrigin(0.5, 0).setDepth(11);

          /* CEO click zone (moves in update) */
          this.ceoZone = this.add.zone(pp.x, pp.y - 20, 28, 60)
            .setInteractive({ cursor: 'pointer' }).setDepth(12);
          this.ceoZone.on('pointerdown', () => {
            window.dispatchEvent(new CustomEvent('vo:npc-click', { detail: { agentId: 'orch_master_01' } }));
          });

          /* camera */
          const cam = this.cameras.main;
          cam.setBounds(0, 0, WORLD_W, WORLD_H);
          const fitZoom = Math.min(cam.width / WORLD_W, cam.height / WORLD_H) * 0.97;
          cam.setZoom(fitZoom);
          cam.startFollow(this.playerBody, true, 0.06, 0.06);

          /* input */
          this.cursors = this.input.keyboard!.createCursorKeys();
          this.wasd = {
            up:    this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W),
            down:  this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S),
            left:  this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A),
            right: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D),
          };

          /* office title watermark */
          this.add.text(WORLD_W / 2, WORLD_H / 2, '명테크 오피스', {
            fontSize: '80px', color: '#ffffff', fontStyle: 'bold',
            fontFamily: 'Noto Sans KR, Inter, sans-serif',
          }).setOrigin(0.5).setAlpha(0.018).setDepth(0);

          /* footer */
          this.add.text(WORLD_W / 2, WORLD_H - 8, '🏢  명테크 오피스  ·  Myungtech AI Agent Workspace  ·  v1.1', {
            fontSize: '9px', color: '#ffffff', fontFamily: 'Noto Sans KR, Inter, sans-serif',
          }).setOrigin(0.5, 1).setAlpha(0.15).setDepth(1).setScrollFactor(0);
        }

        /* ── drawWorld: NO colored bounding boxes ── */
        drawWorld(g: Phaser.GameObjects.Graphics) {
          /* ── base floor ── */
          g.fillStyle(0x0d0b1c, 1);
          g.fillRect(0, 0, WORLD_W, WORLD_H);

          /* subtle dot grid */
          g.fillStyle(0x1a1630, 0.7);
          for (let x = 0; x < WORLD_W; x += 20) {
            for (let y = 0; y < WORLD_H; y += 20) {
              g.fillRect(x, y, 1, 1);
            }
          }

          /* ── wall structure (thin, neutral) ── */
          const wallColor = 0x22203a;

          /* outer boundary walls */
          g.fillStyle(wallColor, 1);
          g.fillRect(0,          0,          WORLD_W, 6);   /* top */
          g.fillRect(0,          WORLD_H - 6, WORLD_W, 6);  /* bottom */
          g.fillRect(0,          0,          6, WORLD_H);   /* left */
          g.fillRect(WORLD_W - 6, 0,          6, WORLD_H);  /* right */

          /* vertical partition walls between sections */
          const partitions = [290, 560, 870, 1160];
          partitions.forEach(x => {
            g.fillStyle(wallColor, 1);
            g.fillRect(x - 3, 6, 6, WORLD_H - 12);
            /* doorway gap in the middle */
            g.fillStyle(0x0d0b1c, 1);
            g.fillRect(x - 3, WORLD_H / 2 - 24, 6, 48);
          });

          /* horizontal corridor divider (walkway at ~y=60) */
          g.fillStyle(wallColor, 1);
          g.fillRect(6, 56, WORLD_W - 12, 4);
          /* doorway gaps */
          [145, 435, 750, 1020, 1330].forEach(cx => {
            g.fillStyle(0x0d0b1c, 1);
            g.fillRect(cx - 20, 56, 40, 4);
          });

          /* subtle floor tint per workspace (very faint — no bounding box look) */
          const zones = [
            { x: 6,    w: 284, color: 0x1a4a2a },
            { x: 297,  w: 256, color: 0x1a2a4a },
            { x: 567,  w: 296, color: 0x3a2a10 },
            { x: 877,  w: 276, color: 0x3a1a1a },
            { x: 1167, w: 327, color: 0x2a1a3a },
          ];
          zones.forEach(z => {
            g.fillStyle(z.color, 0.15);
            g.fillRect(z.x, 60, z.w, WORLD_H - 66);
          });

          /* ── dept name signs (wall-mounted, subtle) ── */
          /* (drawn as text objects in create, not here) */

          /* ── all desks ── */
          Object.entries(AGENT_POS).forEach(([id, pos]) => {
            if (id === 'orch_master_01') return;
            const color = 0x22203a;  /* neutral desk color — no dept color coding */
            this.drawDesk(g, pos.x, pos.y, pos.mgr);
          });

          this.drawDecorations(g);

          /* dept name text signs */
          const deptSigns = [
            { x: 145,  y: 32, label: '학술연구부',     color: '#2a4a35' },
            { x: 425,  y: 32, label: '금융투자부',      color: '#1e2e4a' },
            { x: 710,  y: 32, label: '오케스트레이션',  color: '#4a3510' },
            { x: 1015, y: 32, label: '개발팀',          color: '#4a1e1e' },
            { x: 1330, y: 32, label: '콘텐츠생산부',    color: '#2e1a4a' },
          ];
          deptSigns.forEach(s => {
            this.add.text(s.x, s.y, s.label, {
              fontSize: '10px', color: '#5a5870', fontStyle: 'bold',
              fontFamily: 'Noto Sans KR, Inter, sans-serif',
            }).setOrigin(0.5, 0.5).setDepth(2);
          });
        }

        drawDesk(g: Phaser.GameObjects.Graphics, x: number, y: number, isManager: boolean) {
          const dw = isManager ? 58 : 44, dh = 16;
          /* surface */
          g.fillStyle(0x3a2e1c, 1);
          g.fillRect(x - dw / 2, y + 4, dw, dh);
          g.fillStyle(0x52422c, 1);
          g.fillRect(x - dw / 2, y + 4, dw, 2);
          /* monitor stand */
          g.fillStyle(0x222030, 1);
          g.fillRect(x - 3, y - 8, 6, 11);
          /* monitor */
          const mw = isManager ? 28 : 20, mh = isManager ? 14 : 11;
          g.fillStyle(0x18182a, 1);
          g.fillRect(x - mw / 2, y - mh - 8, mw, mh);
          /* screen (neutral blue-gray glow) */
          g.fillStyle(0x2a3060, 0.75);
          g.fillRect(x - mw / 2 + 2, y - mh - 6, mw - 4, mh - 4);
          g.fillStyle(0x000000, 0.12);
          for (let sy = y - mh - 6; sy < y - 8; sy += 3) g.fillRect(x - mw / 2 + 2, sy, mw - 4, 1);
          /* chair */
          g.fillStyle(0x1e1e2e, 1);
          g.fillRect(x - 9, y + dh + 6, 18, 11);
          g.fillStyle(0x2a2a3e, 1);
          g.fillRect(x - 7, y + dh + 6, 14, 4);
        }

        drawCEODesk(g: Phaser.GameObjects.Graphics, x: number, y: number) {
          g.fillStyle(0x5a3e1c, 1);
          g.fillRect(x - 54, y + 2, 108, 30);
          g.fillStyle(0x7a5830, 1);
          g.fillRect(x - 54, y + 2, 108, 3);
          /* dual monitors */
          [-22, 22].forEach(ox => {
            g.fillStyle(0x222030, 1);
            g.fillRect(x + ox - 3, y - 12, 6, 13);
            g.fillStyle(0x18182a, 1);
            g.fillRect(x + ox - 15, y - 26, 30, 16);
            g.fillStyle(0xb87a28, 0.65);
            g.fillRect(x + ox - 13, y - 24, 26, 12);
            g.fillStyle(0x000000, 0.1);
            for (let sy = y - 24; sy < y - 12; sy += 3) g.fillRect(x + ox - 13, sy, 26, 1);
          });
          /* golden nameplate */
          g.fillStyle(0xf0a820, 0.28);
          g.fillRect(x - 20, y + 8, 40, 7);
          /* chair */
          g.fillStyle(0x382214, 1);
          g.fillRect(x - 15, y + 37, 30, 19);
          g.fillStyle(0x503020, 1);
          g.fillRect(x - 15, y + 37, 30, 5);
        }

        drawDecorations(g: Phaser.GameObjects.Graphics) {
          /* plants — zone corners and partition edges */
          const plants = [
            [16, 20], [270, 20], [16, 510], [270, 510],
            [310, 20], [550, 20], [310, 510], [550, 510],
            [580, 20], [856, 20], [580, 510], [856, 510],
            [886, 20], [1148, 20], [886, 510], [1148, 510],
            [1178, 20], [1472, 20], [1178, 510], [1472, 510],
          ];
          plants.forEach(([px, py]) => {
            g.fillStyle(0x5c3210, 1);
            g.fillRect((px as number) - 5, (py as number) + 10, 10, 9);
            g.fillStyle(0x123d1c, 1);
            g.fillCircle(px as number, py as number, 11);
            g.fillStyle(0x1a5828, 1);
            g.fillCircle((px as number) - 5, (py as number) - 3, 7);
            g.fillCircle((px as number) + 5, (py as number) - 3, 7);
          });

          /* bookshelves along top wall of each section */
          const shelves = [{ x: 16, w: 264 }, { x: 306, w: 240 }, { x: 576, w: 276 }, { x: 886, w: 258 }, { x: 1186, w: 300 }];
          shelves.forEach(s => {
            g.fillStyle(0x3e2e1a, 1);
            g.fillRect(s.x, 62, s.w, 18);
            const bc = [0xb03030, 0x3060b0, 0x28a852, 0xb09028, 0x9030b0, 0xb07028];
            for (let i = 0; i < Math.floor(s.w / 8); i++) {
              g.fillStyle(bc[i % bc.length], 0.8);
              g.fillRect(s.x + i * 8 + 1, 63, 6, 16);
            }
            g.fillStyle(0x5a4030, 1);
            g.fillRect(s.x, 62, s.w, 2);
          });

          /* water cooler */
          g.fillStyle(0x264472, 1); g.fillRect(574, 440, 20, 36);
          g.fillStyle(0x4070c0, 0.85); g.fillCircle(584, 441, 9);
          g.fillStyle(0xc0d8ff, 0.22); g.fillCircle(584, 441, 6);

          /* printer */
          g.fillStyle(0x303040, 1); g.fillRect(884, 440, 42, 24);
          g.fillStyle(0x484858, 1); g.fillRect(886, 442, 38, 8);

          /* CEO coffee table */
          g.fillStyle(0x3a2a14, 1); g.fillEllipse(750, 430, 62, 36);
          g.fillStyle(0x524030, 0.5); g.fillEllipse(750, 430, 54, 28);
          g.fillStyle(0xffffff, 0.2);
          g.fillCircle(736, 428, 4);
          g.fillCircle(764, 428, 4);

          /* corridor floor strips (slightly lighter — walkway indication) */
          g.fillStyle(0x18162c, 1);
          g.fillRect(6, 60, WORLD_W - 12, 4); /* horizontal corridor line */
        }

        /* ── spawnNPC ── */
        spawnNPC(agentId: string, pos: typeof AGENT_POS[string]) {
          const dept     = pos.dept.replace('_dept', '');
          const sKey     = `npc_${dept}_${pos.mgr ? 'm' : 'w'}`;
          const deptHex  = DC[pos.dept] ?? '#6b7280';
          const deptNum  = parseInt(deptHex.slice(1), 16);

          /* sprite or fallback */
          if (this.textures.exists(sKey)) {
            this.add.image(pos.x, pos.y, sKey)
              .setScale(1.25)
              .setOrigin(0.5, 1)
              .setDepth(5);
          } else {
            const gn = this.add.graphics().setDepth(5);
            gn.fillStyle(0x000000, 0.15); gn.fillEllipse(pos.x, pos.y + 12, 20, 7);
            gn.fillStyle(deptNum, pos.mgr ? 1 : 0.8);
            gn.fillRect(pos.x - 6, pos.y - 2, 12, 16);
            gn.fillStyle(0xeec8a0, 1); gn.fillCircle(pos.x, pos.y - 10, pos.mgr ? 9 : 8);
            gn.fillStyle(0x2a1a0a, 1);
            gn.fillCircle(pos.x - 3, pos.y - 11, 1.4);
            gn.fillCircle(pos.x + 3, pos.y - 11, 1.4);
            if (pos.mgr) {
              gn.fillStyle(0xffd700, 1);
              gn.fillTriangle(pos.x - 5, pos.y - 21, pos.x, pos.y - 27, pos.x + 5, pos.y - 21);
            }
          }

          /* name + role label */
          this.add.text(pos.x, pos.y + 2, `${pos.kname}  ${pos.mgr ? '●' : '○'}`, {
            fontSize: '8.5px', color: '#c8cad8',
            fontFamily: 'Noto Sans KR, Inter, sans-serif',
            backgroundColor: 'rgba(10,8,20,0.82)',
            padding: { x: 3, y: 1 },
          }).setOrigin(0.5, 0).setDepth(6);

          /* hover box + click */
          const hlg = this.add.graphics().setDepth(7).setAlpha(0);
          hlg.lineStyle(1.2, deptNum, 0.9);
          hlg.strokeRect(pos.x - 13, pos.y - 56, 26, 62);

          const zone = this.add.zone(pos.x, pos.y - 24, 30, 66)
            .setInteractive({ cursor: 'pointer' }).setDepth(8);
          zone.on('pointerdown', () =>
            window.dispatchEvent(new CustomEvent('vo:npc-click', { detail: { agentId } }))
          );
          zone.on('pointerover', () => hlg.setAlpha(1));
          zone.on('pointerout',  () => hlg.setAlpha(0));
        }

        /* ── update ── */
        update() {
          const body = this.playerBody.body as Phaser.Physics.Arcade.Body;
          body.setVelocity(0);
          if (this.cursors.left?.isDown  || this.wasd.left.isDown)  body.setVelocityX(-this.speed);
          if (this.cursors.right?.isDown || this.wasd.right.isDown) body.setVelocityX(this.speed);
          if (this.cursors.up?.isDown    || this.wasd.up.isDown)    body.setVelocityY(-this.speed);
          if (this.cursors.down?.isDown  || this.wasd.down.isDown)  body.setVelocityY(this.speed);

          const bx = this.playerBody.x, by = this.playerBody.y;
          this.ceoSprite.setPosition(bx, by);
          this.ceoRing.setPosition(bx, by - 20);
          this.ceoLabel.setPosition(bx, by + 2);
          this.ceoZone.setPosition(bx, by - 20);
        }
      }

      const P = (await import('phaser')).default;
      const game = new P.Game({
        type: P.AUTO, parent: phaserRef.current!,
        width: '100%', height: '100%',
        backgroundColor: '#0d0b1c',
        physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 }, debug: false } },
        scene: [BootScene, OfficeScene],
        banner: false,
      });
      gameRef.current = game;
    })();

    return () => { gameRef.current?.destroy(true); gameRef.current = null; };
  }, []);

  return (
    <div className="vo-root">

      {/* Left: events */}
      <div className="vo-left">
        <div className="vo-left-hdr">
          <span className="vo-left-title">최근 이벤트</span>
          <span className="live-tag">LIVE</span>
        </div>
        <div className="vo-events-list">
          {events.length === 0 && <div className="vo-events-empty">에이전트 활동 대기 중…</div>}
          {events.map(ev => <EventRow key={ev.event_id} ev={ev} />)}
        </div>
      </div>

      {/* Right: agent bar + explore */}
      <div className="vo-right">
        <div className="vo-agent-bar">
          {selectedId && agentDetail ? (
            <AgentDetailCard
              agent={agentDetail}
              persona={AGENT_PERSONAS[selectedId]}
              agents={agents}
              onClose={() => { setSelectedId(null); setAgentDetail(null); }}
            />
          ) : (
            <DeptOverview agents={agents} />
          )}
        </div>
        <div className="vo-explore">
          <div ref={phaserRef} className="vo-phaser-wrap" />
          <div className="vo-explore-hint">
            🕹 WASD / 방향키 이동 &nbsp;·&nbsp; NPC 클릭 시 에이전트 정보 확인
          </div>
        </div>
      </div>

    </div>
  );
}

/* ── DeptOverview ── */
function DeptOverview({ agents }: { agents: AgentSummary[] }) {
  const groups = DEPT_META.map(m => ({
    ...m, list: agents.filter(a => a.department === m.id),
  }));
  return (
    <div className="vo-dept-overview">
      {groups.map(dept => {
        const activeCount = dept.list.filter(a => a.status !== 'Idle').length;
        return (
          <div key={dept.id} className="vo-dept-col">
            <div className="vo-dept-col-hdr" style={{ borderBottomColor: dept.hex + '50' }}>
              <span className="vo-dept-col-name" style={{ color: dept.hex }}>{dept.label}</span>
              <span className="vo-dept-col-meta">
                {dept.list.length}명
                {activeCount > 0 && (
                  <span className="vo-dept-col-active" style={{ background: dept.hex }}>활성 {activeCount}</span>
                )}
              </span>
            </div>
            <div className="vo-dept-agents">
              {dept.list.map(a => {
                const pos = AGENT_POS[a.agent_id];
                const active = a.status !== 'Idle';
                return (
                  <div key={a.agent_id} className="vo-dept-agent-row">
                    <span className="vo-dept-agent-dot" style={{ background: active ? dept.hex : '#374151' }} />
                    <div className="vo-dept-agent-info">
                      <span className="vo-dept-agent-name">{pos?.kname ?? a.character_name}</span>
                      <span className="vo-dept-agent-role">{pos?.role ?? a.role}</span>
                    </div>
                    {pos?.mgr && (
                      <span className="vo-dept-agent-pm" style={{ color: dept.hex, borderColor: dept.hex + '50' }}>팀장</span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── AgentDetailCard ── */
function AgentDetailCard({ agent, persona, agents, onClose }: {
  agent: AgentDetail; persona: PersonaData | undefined;
  agents: AgentSummary[]; onClose: () => void;
}) {
  const color  = deptColors[agent.department] ?? '#6b7280';
  const live   = agents.find(a => a.agent_id === agent.agent_id);
  const active = live?.status !== 'Idle';
  const pos    = AGENT_POS[agent.agent_id];
  return (
    <div className="vo-detail-card">
      <div className="vo-detail-card-left">
        <img src={avatarFor(agent)} alt="" className="vo-detail-avatar"
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
        <div>
          <div className="vo-detail-card-name">{pos?.kname ?? agent.character_name}</div>
          <div className="vo-detail-card-role" style={{ color }}>{pos?.role ?? agent.role}</div>
          <div className="vo-detail-card-dept" style={{ background: color + '18', color, borderColor: color + '40' }}>
            {deptLabels[agent.department] ?? agent.department}
          </div>
        </div>
      </div>
      <div className="vo-detail-card-mid">
        {persona && <p className="vo-detail-card-persona">{persona.persona.slice(0, 130)}…</p>}
        {persona?.skills && (
          <div className="vo-detail-card-skills">
            {persona.skills.slice(0, 4).map((s: string) => (
              <span key={s} className="vo-skill-chip" style={{ borderColor: color + '50', color }}>{s}</span>
            ))}
          </div>
        )}
      </div>
      <div className="vo-detail-card-right">
        <div className="vo-detail-status-row">
          <span className="vo-detail-status-dot" style={{ background: active ? color : '#374151' }} />
          <span style={{ fontSize: 11, color: '#64748b' }}>{live?.status ?? '—'}</span>
        </div>
        <button className="vo-detail-close-btn" onClick={onClose}>✕ 닫기</button>
      </div>
    </div>
  );
}

/* ── EventRow ── */
function EventRow({ ev }: { ev: EventRecord }) {
  const fromColor = deptColors[ev.sender] ?? '#6b7280';
  const toColor   = deptColors[ev.target]   ?? '#6b7280';
  let text = ev.payload.slice(0, 90);
  try {
    const o = JSON.parse(ev.payload);
    const v = o.message ?? o.result ?? o.task ?? o.content;
    if (typeof v === 'string') text = v.slice(0, 90);
  } catch {}
  const ts = new Date(ev.timestamp).toLocaleTimeString('ko-KR', {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  return (
    <div className="vo-event-row" style={{ borderLeftColor: fromColor }}>
      <div className="vo-event-route">
        <span className="vo-event-sender" style={{ color: fromColor }}>
          {ev.sender.replace('_dept', '').slice(0, 5).toUpperCase()}
        </span>
        <span className="vo-event-arrow">→</span>
        <span className="vo-event-target" style={{ color: toColor }}>
          {ev.target.replace('_dept', '').slice(0, 5).toUpperCase()}
        </span>
        <span className="vo-event-time">{ts}</span>
      </div>
      <p className="vo-event-text">{text}</p>
    </div>
  );
}
