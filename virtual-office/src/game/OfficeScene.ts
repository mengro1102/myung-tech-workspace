import Phaser from 'phaser';
import {
  TILE_SIZE, WORLD_WIDTH, WORLD_HEIGHT,
  ROOMS, RoomDef, API_BASE_URL, SSE_URL, DEPT_COLORS,
} from './config';

const TS = TILE_SIZE;

interface NpcData {
  container: Phaser.GameObjects.Container;
  sprite: Phaser.GameObjects.Image;
  statusRing: Phaser.GameObjects.Arc;
  nameTag: Phaser.GameObjects.Text;
  hintContainer: Phaser.GameObjects.Container | null;
  agentId: string;
  characterName: string;
  role: string;
  department: string;
  status: string;
  worldX: number;
  worldY: number;
  executionLog: LogEntry[];
}

interface LogEntry {
  time: string;
  type: string;
  content: string;
  from?: string;
  to?: string;
}

export class OfficeScene extends Phaser.Scene {
  private player!: Phaser.Physics.Arcade.Sprite;
  private cursors!: Phaser.Types.Input.Keyboard.CursorKeys;
  private wasd!: Record<string, Phaser.Input.Keyboard.Key>;
  private interactKey!: Phaser.Input.Keyboard.Key;

  private npcs: NpcData[] = [];
  private npcMap: Map<string, NpcData> = new Map();
  private nearestNpc: NpcData | null = null;
  private dialogOpen = false;
  private dialogContainer: Phaser.GameObjects.Container | null = null;

  private walls!: Phaser.Physics.Arcade.StaticGroup;
  private activeComms: Map<string, { line: Phaser.GameObjects.Graphics; timer: Phaser.Time.TimerEvent }> = new Map();
  private currentRoomKey = '';

  private sse: EventSource | null = null;

  constructor() { super({ key: 'OfficeScene' }); }

  create() {
    this.physics.world.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this._drawWorld();
    this._createWalls();
    this._createPlayer();
    this._setupControls();
    this._setupCamera();
    this._loadNPCs();
    this._connectSSE();
    this.scene.launch('HudScene');
  }

  // ─── World Rendering ──────────────────────────────────────────────

  private _drawWorld() {
    // Corridor background
    for (let tx = 0; tx < WORLD_WIDTH / TS; tx++) {
      for (let ty = 0; ty < WORLD_HEIGHT / TS; ty++) {
        this.add.image(tx * TS + TS / 2, ty * TS + TS / 2, 'tile_corridor').setDepth(0);
      }
    }
    for (const [key, room] of Object.entries(ROOMS)) {
      this._drawRoom(key, room);
    }
    this._drawCorridorDecals();
  }

  private _drawRoom(key: string, room: RoomDef) {
    const px = room.x * TS, py = room.y * TS;
    const pw = room.width * TS, ph = room.height * TS;

    // Carpet floor
    for (let tx = 0; tx < room.width; tx++) {
      for (let ty = 0; ty < room.height; ty++) {
        const tile = this.add.image(px + tx * TS + TS / 2, py + ty * TS + TS / 2, 'tile_carpet').setDepth(1);
        tile.setTint(room.floorColor);
      }
    }

    // Walls
    const gfx = this.add.graphics().setDepth(2);
    gfx.fillStyle(room.wallColor, 0.85);
    gfx.fillRect(px, py, pw, 6);            // top
    gfx.fillRect(px, py, 6, ph);            // left
    gfx.fillRect(px + pw - 6, py, 6, ph);  // right

    // Bottom wall with door gap (3 tiles wide)
    const doorW = TS * 3;
    const doorX = px + Math.floor(room.width / 2) * TS - doorW / 2;
    gfx.fillRect(px, py + ph - 6, doorX - px, 6);
    gfx.fillRect(doorX + doorW, py + ph - 6, (px + pw) - (doorX + doorW), 6);

    // Inner accent glow
    gfx.lineStyle(1, room.wallColor, 0.25);
    gfx.strokeRect(px + 8, py + 8, pw - 16, ph - 16);

    // Door glow
    gfx.fillStyle(room.wallColor, 0.12);
    gfx.fillRect(doorX, py + ph - 8, doorW, 8);
    gfx.lineStyle(1, room.wallColor, 0.5);
    gfx.lineBetween(doorX, py + ph - 6, doorX, py + ph);
    gfx.lineBetween(doorX + doorW, py + ph - 6, doorX + doorW, py + ph);

    // Room label
    const labelW = room.label.length * 10 + 24;
    this.add.rectangle(px + pw / 2, py + 14, labelW, 22, room.wallColor, 0.9).setDepth(3);
    this.add.text(px + pw / 2, py + 14, room.label, {
      fontSize: '11px', color: '#ffffff', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(3);

    // Furniture
    this._placeFurniture(key, room, gfx);
  }

  private _placeFurniture(key: string, room: RoomDef, gfx: Phaser.GameObjects.Graphics) {
    const px = room.x * TS, py = room.y * TS;
    const pw = room.width * TS, ph = room.height * TS;

    if (key === 'meeting_room') {
      const cx = px + pw / 2, cy = py + ph / 2 + TS;
      gfx.fillStyle(0x4a3728);
      gfx.fillRoundedRect(cx - 96, cy - 32, 192, 64, 8);
      gfx.fillStyle(0x5d4037);
      gfx.fillRoundedRect(cx - 94, cy - 30, 188, 10, 4);
      gfx.lineStyle(1, 0x795548);
      gfx.strokeRoundedRect(cx - 96, cy - 32, 192, 64, 8);
      gfx.fillStyle(0x263238);
      for (let i = -2; i <= 2; i++) {
        gfx.fillRoundedRect(cx + i * 38 - 14, cy - 52, 28, 16, 4);
        gfx.fillRoundedRect(cx + i * 38 - 14, cy + 36, 28, 16, 4);
      }
      gfx.fillStyle(0x1565c0);
      for (let i = -1; i <= 1; i++) gfx.fillRect(cx + i * 60 - 10, cy - 8, 20, 4);
    } else {
      const positions = this._getDeskPositions(room);
      for (const dp of positions) {
        const tile = this.add.image(
          px + dp.x * TS + TS / 2,
          py + dp.y * TS + TS / 2,
          'tile_desk'
        ).setDepth(2).setAlpha(0.9);
        tile.setTint(room.wallColor);
      }
      // Wall shelf
      gfx.fillStyle(room.wallColor, 0.12);
      gfx.fillRect(px + 6, py + 8, pw - 12, TS - 4);
      // Corner plant
      gfx.fillStyle(0x2e7d32, 0.8);
      gfx.fillCircle(px + pw - 16, py + 28, 10);
      gfx.fillStyle(0x4caf50, 0.6);
      gfx.fillCircle(px + pw - 16, py + 22, 7);
      gfx.fillStyle(0x5d4037, 0.9);
      gfx.fillRect(px + pw - 20, py + 36, 8, 8);
    }
  }

  private _getDeskPositions(room: RoomDef): Array<{ x: number; y: number }> {
    const mx = Math.floor(room.width / 2);
    return [
      { x: 2,        y: 2 },
      { x: room.width - 3, y: 2 },
      { x: mx - 1,   y: room.height - 4 },
    ];
  }

  private _drawCorridorDecals() {
    const gfx = this.add.graphics().setDepth(1);
    gfx.lineStyle(1, 0x2a2a3e, 0.4);
    const topY = (ROOMS.research_dept.y + ROOMS.research_dept.height) * TS - TS / 2;
    gfx.lineBetween(0, topY, WORLD_WIDTH, topY);
    const midX = (ROOMS.meeting_room.x + ROOMS.meeting_room.width / 2) * TS;
    gfx.lineBetween(midX, 0, midX, WORLD_HEIGHT);
  }

  // ─── Physics Walls ────────────────────────────────────────────────

  private _createWalls() {
    this.walls = this.physics.add.staticGroup();
    for (const room of Object.values(ROOMS)) {
      const px = room.x * TS, py = room.y * TS;
      const pw = room.width * TS, ph = room.height * TS;
      const doorW = TS * 3;
      const doorX = Math.floor(room.width / 2) * TS - doorW / 2;

      this._addWall(px,           py - 4,      pw, 8);       // top
      this._addWall(px - 4,       py,           8, ph);      // left
      this._addWall(px + pw - 4,  py,           8, ph);      // right
      this._addWall(px,           py + ph - 4, doorX, 8);           // bottom-left
      this._addWall(px + doorX + doorW, py + ph - 4, pw - doorX - doorW, 8); // bottom-right
    }
    this._addWall(0,              -4,           WORLD_WIDTH, 8);
    this._addWall(0,              WORLD_HEIGHT - 4, WORLD_WIDTH, 8);
    this._addWall(-4,             0,            8, WORLD_HEIGHT);
    this._addWall(WORLD_WIDTH - 4, 0,           8, WORLD_HEIGHT);
  }

  private _addWall(x: number, y: number, w: number, h: number) {
    if (w <= 0 || h <= 0) return;
    const r = this.add.rectangle(x + w / 2, y + h / 2, w, h, 0x000000, 0);
    this.physics.add.existing(r, true);
    this.walls.add(r);
  }

  // ─── Player ──────────────────────────────────────────────────────

  private _createPlayer() {
    const startX = (ROOMS.meeting_room.x + ROOMS.meeting_room.width / 2) * TS;
    const startY = (ROOMS.meeting_room.y - 3) * TS;

    this.player = this.physics.add.sprite(startX, startY, 'player');
    this.player.setCollideWorldBounds(true).setDepth(10).setScale(1.2);
    (this.player.body as Phaser.Physics.Arcade.Body).setSize(16, 28).setOffset(8, 16);

    // Glow ring under player
    const glowRing = this.add.arc(0, 0, 18, 0, 360, false, 0x14b8a6, 0).setDepth(9);
    this.tweens.add({
      targets: glowRing, fillAlpha: { from: 0, to: 0.3 },
      duration: 1000, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
    });

    const youLabel = this.add.text(0, 0, 'YOU', {
      fontSize: '9px', color: '#14b8a6', fontFamily: 'monospace', fontStyle: 'bold',
      stroke: '#000', strokeThickness: 2,
    }).setOrigin(0.5).setDepth(11);

    this.events.on('postupdate', () => {
      glowRing.setPosition(this.player.x, this.player.y + 10);
      youLabel.setPosition(this.player.x, this.player.y - 38);
    });

    this.physics.add.collider(this.player, this.walls);
  }

  private _setupControls() {
    this.cursors = this.input.keyboard!.createCursorKeys();
    this.wasd = {
      up:    this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      down:  this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      left:  this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      right: this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };
    this.interactKey = this.input.keyboard!.addKey(Phaser.Input.Keyboard.KeyCodes.E);
  }

  private _setupCamera() {
    this.cameras.main.setBounds(0, 0, WORLD_WIDTH, WORLD_HEIGHT);
    this.cameras.main.startFollow(this.player, true, 0.12, 0.12);
    this.cameras.main.setZoom(1.2);
  }

  // ─── NPCs ────────────────────────────────────────────────────────

  private async _loadNPCs() {
    try {
      const res = await fetch(`${API_BASE_URL}/agents`);
      const data = await res.json();
      for (const agent of (data.agents || [])) {
        const room = ROOMS[agent.department as keyof typeof ROOMS];
        if (!room) continue;
        const npc = this._createNPC(agent, room);
        if (npc) { this.npcs.push(npc); this.npcMap.set(agent.agent_id, npc); }
      }
      const hud = this.scene.get('HudScene') as any;
      hud?.pushLog?.(`에이전트 ${this.npcs.length}명 배치 완료`, '#22c55e');
    } catch {
      const hud = this.scene.get('HudScene') as any;
      hud?.pushLog?.('API 오프라인', '#ef4444');
    }
  }

  private _createNPC(agent: any, room: RoomDef): NpcData | null {
    const isManager = agent.role?.toLowerCase().includes('manager') ||
                      agent.role?.toLowerCase().includes('orchestrator');
    const texKey = `npc_${room.deptKey}_${isManager ? 'manager' : 'worker'}`;
    const sameRoom = this.npcs.filter(n => n.department === agent.department).length;
    const positions = this._getDeskPositions(room);
    const pos = positions[sameRoom % positions.length];
    const worldX = room.x * TS + pos.x * TS + TS * 0.5 + (sameRoom >= 3 ? TS * 2 : 0);
    const worldY = room.y * TS + pos.y * TS + TS * 0.5;

    const sprite = this.add.image(0, 0, texKey).setScale(1.1);
    const statusRing = this.add.arc(0, 16, 14, 0, 360, false, 0x666688, 0.3);
    const deptColor = (DEPT_COLORS[room.deptKey] ?? { head: 0x888888 }).head;
    const badge = this.add.arc(13, -26, 5, 0, 360, false, deptColor, 0.9);
    const nameTag = this.add.text(0, -40, agent.character_name, {
      fontSize: '9px', color: '#ccccdd', fontFamily: 'monospace',
      stroke: '#000', strokeThickness: 2,
    }).setOrigin(0.5);

    const container = this.add.container(worldX, worldY, [statusRing, sprite, badge, nameTag]);
    container.setDepth(5);

    this.tweens.add({
      targets: container, y: worldY - 4,
      duration: 1400 + Math.random() * 600, yoyo: true, repeat: -1,
      ease: 'Sine.easeInOut', delay: Math.random() * 1200,
    });

    return {
      container, sprite, statusRing, nameTag,
      hintContainer: null,
      agentId: agent.agent_id, characterName: agent.character_name,
      role: agent.role, department: agent.department, status: 'idle',
      worldX, worldY, executionLog: [],
    };
  }

  // ─── Game Loop ────────────────────────────────────────────────────

  update() {
    if (this.dialogOpen) { this.player.setVelocity(0, 0); return; }
    this._handleMovement();
    this._checkProximity();
    this._checkRoomEntry();
    this._handleInteract();
  }

  private _handleMovement() {
    const SPEED = 200;
    let vx = 0, vy = 0;
    if (this.cursors.left.isDown  || this.wasd.left.isDown)  vx = -SPEED;
    if (this.cursors.right.isDown || this.wasd.right.isDown) vx =  SPEED;
    if (this.cursors.up.isDown    || this.wasd.up.isDown)    vy = -SPEED;
    if (this.cursors.down.isDown  || this.wasd.down.isDown)  vy =  SPEED;
    if (vx !== 0 && vy !== 0) { vx *= 0.707; vy *= 0.707; }
    this.player.setVelocity(vx, vy);
    if (vx < 0) this.player.setFlipX(true);
    else if (vx > 0) this.player.setFlipX(false);
  }

  private _checkProximity() {
    const RANGE = 90;
    let nearest: NpcData | null = null, nearestDist = Infinity;
    for (const npc of this.npcs) {
      const dx = this.player.x - npc.container.x;
      const dy = this.player.y - npc.container.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < RANGE && d < nearestDist) { nearest = npc; nearestDist = d; }
    }
    if (this.nearestNpc && this.nearestNpc !== nearest) this._hideHint(this.nearestNpc);
    if (nearest && nearest !== this.nearestNpc) this._showHint(nearest);
    this.nearestNpc = nearest;
  }

  private _checkRoomEntry() {
    for (const [key, room] of Object.entries(ROOMS)) {
      const inX = this.player.x >= room.x * TS && this.player.x <= (room.x + room.width) * TS;
      const inY = this.player.y >= room.y * TS && this.player.y <= (room.y + room.height) * TS;
      if (inX && inY && this.currentRoomKey !== key) {
        this.currentRoomKey = key;
        const hud = this.scene.get('HudScene') as any;
        hud?.setRoomLabel?.(room.label);
        hud?.pushLog?.(`📍 ${room.label} 입장`, '#60a5fa');
        return;
      }
    }
    if (this.currentRoomKey) {
      const room = ROOMS[this.currentRoomKey as keyof typeof ROOMS];
      const inX = this.player.x >= room.x * TS && this.player.x <= (room.x + room.width) * TS;
      const inY = this.player.y >= room.y * TS && this.player.y <= (room.y + room.height) * TS;
      if (!inX || !inY) {
        this.currentRoomKey = '';
        (this.scene.get('HudScene') as any)?.setRoomLabel?.('');
      }
    }
  }

  private _showHint(npc: NpcData) {
    if (npc.hintContainer) return;
    const bg = this.add.image(0, 0, 'hint_bubble').setScale(0.85);
    const txt = this.add.text(0, -1, `[E] ${npc.characterName}`, {
      fontSize: '10px', color: '#14b8a6', fontFamily: 'monospace',
    }).setOrigin(0.5);
    npc.hintContainer = this.add.container(npc.worldX, npc.worldY - 64, [bg, txt]);
    npc.hintContainer.setDepth(20).setAlpha(0);
    this.tweens.add({ targets: npc.hintContainer, alpha: 1, y: npc.worldY - 70, duration: 200 });
  }

  private _hideHint(npc: NpcData) {
    if (!npc.hintContainer) return;
    const h = npc.hintContainer; npc.hintContainer = null;
    this.tweens.add({ targets: h, alpha: 0, duration: 150, onComplete: () => h.destroy() });
  }

  private _handleInteract() {
    if (Phaser.Input.Keyboard.JustDown(this.interactKey) && this.nearestNpc) {
      this._openReport(this.nearestNpc);
    }
  }

  // ─── Agent Communication Visualization ───────────────────────────

  private _showCommBeam(fromId: string, toId?: string) {
    const fromNpc = this.npcMap.get(fromId);
    if (!fromNpc) return;
    const existing = this.activeComms.get(fromId);
    if (existing) { existing.line.destroy(); existing.timer.destroy(); this.activeComms.delete(fromId); }

    const toNpc = toId ? this.npcMap.get(toId) : null;
    const fx = fromNpc.container.x, fy = fromNpc.container.y - 20;
    const tx = toNpc ? toNpc.container.x : fx + 50;
    const ty = toNpc ? toNpc.container.y - 20 : fy - 30;

    const gfx = this.add.graphics().setDepth(9);
    gfx.lineStyle(2, 0x14b8a6, 0.6);
    gfx.lineBetween(fx, fy, tx, ty);

    const dot = this.add.arc(fx, fy, 4, 0, 360, false, 0x14b8a6, 0.9).setDepth(10);
    this.tweens.add({
      targets: dot, x: tx, y: ty,
      duration: 700, ease: 'Quad.easeInOut', yoyo: true, repeat: 2,
      onComplete: () => dot.destroy(),
    });
    this.tweens.add({
      targets: gfx, alpha: { from: 0.6, to: 0.1 },
      duration: 400, yoyo: true, repeat: 4,
      onComplete: () => gfx.destroy(),
    });

    fromNpc.statusRing.setFillStyle(0x14b8a6, 0.7);
    this.tweens.add({
      targets: fromNpc.sprite, scaleX: { from: 1.1, to: 1.3 }, scaleY: { from: 1.1, to: 1.3 },
      duration: 250, yoyo: true, repeat: 2, ease: 'Sine.easeInOut',
    });

    const timer = this.time.delayedCall(4500, () => {
      fromNpc.statusRing.setFillStyle(0x666688, 0.3);
      this.activeComms.delete(fromId);
    });
    this.activeComms.set(fromId, { line: gfx, timer });
  }

  private _showSpeechBubble(npc: NpcData, text: string) {
    const disp = text.length > 30 ? text.slice(0, 30) + '…' : text;
    const bg = this.add.image(npc.worldX, npc.worldY - 72, 'bubble').setScale(0.85).setDepth(30);
    const txt = this.add.text(npc.worldX, npc.worldY - 80, disp, {
      fontSize: '9px', color: '#1a1a2e', fontFamily: 'monospace',
    }).setOrigin(0.5).setDepth(31);
    [bg, txt].forEach(o => o.setAlpha(0));
    this.tweens.add({ targets: [bg, txt], alpha: 1, y: '-=4', duration: 200 });
    this.time.delayedCall(4000, () => {
      this.tweens.add({
        targets: [bg, txt], alpha: 0, duration: 300,
        onComplete: () => { bg.destroy(); txt.destroy(); },
      });
    });
  }

  // ─── Agent Report Dialog ──────────────────────────────────────────

  private async _openReport(npc: NpcData) {
    if (this.dialogContainer) this.dialogContainer.destroy();
    this.dialogOpen = true;
    this.player.setVelocity(0, 0);

    let agentDetail: any = null;
    let events: any[] = [];
    try {
      const [ar, er] = await Promise.all([
        fetch(`${API_BASE_URL}/agents/${npc.agentId}`),
        fetch(`${API_BASE_URL}/events`),
      ]);
      agentDetail = await ar.json();
      const evData = await er.json();
      events = (evData.events || [])
        .filter((e: any) => e.sender === npc.agentId || e.target === npc.agentId)
        .slice(0, 8);
    } catch { /* offline */ }

    const W = 520, H = 560;
    const zoom = this.cameras.main.zoom;
    const cx = this.cameras.main.scrollX + (this.cameras.main.width / zoom - W) / 2;
    const cy = this.cameras.main.scrollY + (this.cameras.main.height / zoom - H) / 2;

    const room = ROOMS[npc.department as keyof typeof ROOMS];
    const wallColor = room?.wallColor ?? 0x4ec9b0;
    const wallHex = '#' + wallColor.toString(16).padStart(6, '0');

    const bg = this.add.rectangle(0, 0, W, H, 0x080810, 0.97).setOrigin(0);
    const border = this.add.graphics();
    border.lineStyle(2, wallColor, 0.9);
    border.strokeRect(0, 0, W, H);
    border.lineStyle(1, wallColor, 0.15);
    border.strokeRect(4, 4, W - 8, H - 8);

    const hdrBg = this.add.rectangle(0, 0, W, 56, wallColor, 0.92).setOrigin(0);
    const npcImg = this.add.image(38, 28, `npc_${room?.deptKey ?? 'meeting'}_${npc.role?.toLowerCase().includes('manager') ? 'manager' : 'worker'}`).setScale(1.1);
    const nameTxt = this.add.text(70, 8, npc.characterName, {
      fontSize: '18px', color: '#fff', fontFamily: 'monospace', fontStyle: 'bold',
    });
    const roleTxt = this.add.text(70, 32, npc.role, {
      fontSize: '11px', color: 'rgba(255,255,255,0.75)', fontFamily: 'monospace',
    });

    const statusColor = npc.status === 'idle' ? '#666688' :
                        npc.status === 'thinking' ? '#f59e0b' : '#14b8a6';
    const statusTxt = this.add.text(W - 14, 28, `● ${npc.status}`, {
      fontSize: '11px', color: statusColor, fontFamily: 'monospace',
    }).setOrigin(1, 0.5);

    const closeBtn = this.add.rectangle(W - 20, 28, 24, 24, 0xffffff, 0.1).setOrigin(0.5).setInteractive();
    const closeX = this.add.text(W - 20, 28, '✕', {
      fontSize: '14px', color: '#ccc', fontFamily: 'monospace',
    }).setOrigin(0.5);
    closeBtn.on('pointerover', () => closeBtn.setFillStyle(0xef4444, 0.4));
    closeBtn.on('pointerout',  () => closeBtn.setFillStyle(0xffffff, 0.1));
    closeBtn.on('pointerdown', () => this._closeDialog());

    // Info grid
    const line1 = this.add.graphics();
    line1.lineStyle(1, wallColor, 0.3);
    line1.lineBetween(16, 66, W - 16, 66);

    const infoRows = [
      ['ID', npc.agentId],
      ['부서', npc.department],
      ['역할', npc.role],
      ['레벨', agentDetail?.level?.toString() ?? '-'],
    ];
    const infoObjs: Phaser.GameObjects.GameObject[] = [];
    infoRows.forEach(([label, val], i) => {
      const ix = (i % 2) * (W / 2) + 16;
      const iy = 74 + Math.floor(i / 2) * 26;
      infoObjs.push(
        this.add.text(ix, iy, label + ':', { fontSize: '10px', color: '#555577', fontFamily: 'monospace' }),
        this.add.text(ix + 40, iy, val, { fontSize: '10px', color: '#aaaacc', fontFamily: 'monospace' })
      );
    });

    // Persona
    const pY = 132;
    const pLine = this.add.graphics();
    pLine.lineStyle(1, wallColor, 0.2);
    pLine.lineBetween(16, pY - 4, W - 16, pY - 4);

    const pLabel = this.add.text(16, pY, 'SOUL / 페르소나', {
      fontSize: '10px', color: wallHex, fontFamily: 'monospace', fontStyle: 'bold',
    });
    const persona = agentDetail?.persona ?? agentDetail?.base_prompt ?? '(정보 없음)';
    const pTxt = this.add.text(16, pY + 16, persona.slice(0, 120), {
      fontSize: '10px', color: '#777788', fontFamily: 'monospace',
      wordWrap: { width: W - 32 },
    });

    // Execution log section
    const logY = 204;
    const logLine = this.add.graphics();
    logLine.lineStyle(1, wallColor, 0.3);
    logLine.lineBetween(16, logY - 4, W - 16, logY - 4);

    const logLabel = this.add.text(16, logY, `📋 수행 이력 (${events.length}건)`, {
      fontSize: '11px', color: wallHex, fontFamily: 'monospace', fontStyle: 'bold',
    });

    const logObjs: Phaser.GameObjects.GameObject[] = [];
    if (events.length === 0 && npc.executionLog.length === 0) {
      logObjs.push(this.add.text(16, logY + 22, '수행 이력 없음 — API 이벤트 대기 중', {
        fontSize: '10px', color: '#444455', fontFamily: 'monospace',
      }));
    }

    let curY = logY + 22;
    events.forEach((ev) => {
      const isFrom = ev.sender === npc.agentId;
      const accentColor = isFrom ? wallColor : 0x444466;
      logObjs.push(
        this.add.rectangle(14, curY + 8, 3, 22, accentColor, 0.9).setOrigin(0),
        this.add.text(22, curY, (ev.timestamp ?? '').slice(11, 19), {
          fontSize: '9px', color: '#444466', fontFamily: 'monospace',
        }),
        this.add.text(88, curY, isFrom ? `→ ${ev.target}` : `← ${ev.sender}`, {
          fontSize: '9px', color: isFrom ? wallHex : '#777799', fontFamily: 'monospace',
        }),
        this.add.text(22, curY + 12, (ev.payload ?? '').slice(0, 58) + (ev.payload?.length > 58 ? '…' : ''), {
          fontSize: '9px', color: '#666677', fontFamily: 'monospace',
          wordWrap: { width: W - 40 },
        })
      );
      curY += 34;
    });

    // Local runtime log
    if (npc.executionLog.length > 0) {
      logObjs.push(this.add.text(16, curY + 4, '── 실시간 상태 변화 ──', {
        fontSize: '9px', color: '#333355', fontFamily: 'monospace',
      }));
      curY += 20;
      npc.executionLog.slice(0, 6).forEach((entry) => {
        const c = entry.type === 'thinking' ? '#f59e0b' : entry.type === 'error' ? '#ef4444' : '#555566';
        logObjs.push(this.add.text(16, curY, `[${entry.time}] ${entry.content}`, {
          fontSize: '9px', color: c, fontFamily: 'monospace',
        }));
        curY += 17;
      });
    }

    const escTxt = this.add.text(W / 2, H - 18, '[ESC] 닫기', {
      fontSize: '10px', color: '#333355', fontFamily: 'monospace',
    }).setOrigin(0.5);

    this.dialogContainer = this.add.container(cx, cy, [
      bg, border, hdrBg,
      npcImg, nameTxt, roleTxt, statusTxt, closeBtn, closeX,
      line1, ...infoObjs,
      pLine, pLabel, pTxt,
      logLine, logLabel, ...logObjs,
      escTxt,
    ]);
    this.dialogContainer.setDepth(50).setScrollFactor(0).setAlpha(0);
    this.tweens.add({ targets: this.dialogContainer, alpha: 1, duration: 150 });
    this.input.keyboard!.once('keydown-ESC', () => this._closeDialog());
  }

  private _closeDialog() {
    if (!this.dialogContainer) return;
    const d = this.dialogContainer; this.dialogContainer = null;
    this.tweens.add({
      targets: d, alpha: 0, duration: 120,
      onComplete: () => { d.destroy(); this.dialogOpen = false; },
    });
  }

  // ─── SSE ──────────────────────────────────────────────────────────

  private _connectSSE() {
    try {
      this.sse = new EventSource(SSE_URL);
      this.sse.onmessage = (ev) => {
        try { this._handleSSE(JSON.parse(ev.data)); } catch { /* ignore */ }
      };
    } catch { /* unavailable */ }
  }

  private _handleSSE(data: any) {
    const hud = this.scene.get('HudScene') as any;
    if (data.type === 'agent_state_change') {
      const npc = this.npcMap.get(data.agent_id);
      if (!npc) return;
      npc.status = data.new_state;
      const col = data.new_state === 'thinking' ? 0xf59e0b :
                  data.new_state === 'responding' ? 0x14b8a6 :
                  data.new_state === 'error' ? 0xef4444 : 0x666688;
      npc.statusRing.setFillStyle(col, data.new_state === 'idle' ? 0.3 : 0.7);
      npc.executionLog.unshift({
        time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
        type: data.new_state, content: `상태: ${data.new_state}`,
      });
      if (npc.executionLog.length > 20) npc.executionLog.pop();
      if (data.new_state !== 'idle') {
        this._showCommBeam(data.agent_id, data.target_id);
        if (data.message) this._showSpeechBubble(npc, data.message);
      }
    } else if (data.type === 'agent_message') {
      const npc = this.npcMap.get(data.sender);
      if (npc) {
        this._showCommBeam(data.sender, data.target);
        if (data.content) this._showSpeechBubble(npc, data.content);
        npc.executionLog.unshift({
          time: new Date().toLocaleTimeString('ko-KR'),
          type: 'message', content: (data.content ?? '').slice(0, 50),
          from: data.sender, to: data.target,
        });
      }
      hud?.pushLog?.(`${data.sender} → ${data.target}`, '#60a5fa');
    } else if (data.type === 'workflow_start') {
      hud?.pushLog?.(`워크플로우: ${data.department}`, '#60a5fa');
    } else if (data.type === 'workflow_done') {
      hud?.pushLog?.(`완료: ${data.department}`, '#22c55e');
    }
  }

  shutdown() {
    this.sse?.close();
    this.activeComms.forEach(v => { v.line.destroy(); v.timer.destroy(); });
  }
}
