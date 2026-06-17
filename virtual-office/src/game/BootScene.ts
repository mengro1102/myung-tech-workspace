import Phaser from 'phaser';
import { ROOMS } from './config';

export class BootScene extends Phaser.Scene {
  constructor() { super({ key: 'BootScene' }); }

  preload() {
    const W = this.cameras.main.width;
    const H = this.cameras.main.height;

    // Loading screen
    this.add.rectangle(W / 2, H / 2, W, H, 0x0d0d1a);
    const title = this.add.text(W / 2, H / 2 - 70, '명테크 가상 오피스', {
      fontSize: '28px', color: '#14b8a6', fontFamily: 'monospace', fontStyle: 'bold',
    }).setOrigin(0.5);
    this.add.text(W / 2, H / 2 - 36, 'Multi-Agent Workspace v2.0', {
      fontSize: '13px', color: '#555577', fontFamily: 'monospace',
    }).setOrigin(0.5);

    // Progress bar
    const barBg = this.add.rectangle(W / 2, H / 2, 360, 10, 0x1e1e2e).setOrigin(0.5);
    const bar   = this.add.rectangle(W / 2 - 180, H / 2, 0, 10, 0x14b8a6).setOrigin(0, 0.5);
    const pct   = this.add.text(W / 2, H / 2 + 22, '0%', {
      fontSize: '11px', color: '#444466', fontFamily: 'monospace',
    }).setOrigin(0.5);
    barBg;

    this.load.on('progress', (v: number) => {
      bar.width = 360 * v;
      pct.setText(`${Math.round(v * 100)}%`);
    });
    this.load.on('fileprogress', (file: any) => {
      pct.setText(file.key);
    });

    // Loading indicator animation
    this.tweens.add({
      targets: title,
      alpha: { from: 1, to: 0.7 },
      duration: 800, yoyo: true, repeat: -1,
    });

    // ── Load generated PNG sprites ─────────────────────────────
    const S = '/sprites/';

    // Tiles
    this.load.image('tile_floor',    S + 'tile_floor.png');
    this.load.image('tile_corridor', S + 'tile_corridor.png');
    this.load.image('tile_desk',     S + 'tile_desk.png');
    this.load.image('tile_carpet',   S + 'tile_carpet.png');

    // Bubbles
    this.load.image('bubble',        S + 'bubble.png');
    this.load.image('hint_bubble',   S + 'hint_bubble.png');

    // Player
    this.load.image('player', S + 'player.png');

    // NPCs
    const depts = [...new Set(Object.values(ROOMS).map(r => r.deptKey))];
    for (const dept of depts) {
      this.load.image(`npc_${dept}_manager`, S + `npc_${dept}_manager.png`);
      this.load.image(`npc_${dept}_worker`,  S + `npc_${dept}_worker.png`);
    }
  }

  create() {
    this.scene.start('OfficeScene');
  }
}
