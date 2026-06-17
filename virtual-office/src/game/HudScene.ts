import Phaser from 'phaser';
import { SSE_URL } from './config';

interface EventEntry {
  time: string;
  text: string;
  color: string;
}

export class HudScene extends Phaser.Scene {
  private eventLog: EventEntry[] = [];
  private logTexts: Phaser.GameObjects.Text[] = [];
  private logContainer!: Phaser.GameObjects.Container;
  private statusText!: Phaser.GameObjects.Text;
  private roomLabel!: Phaser.GameObjects.Text;
  private sse: EventSource | null = null;

  constructor() { super({ key: 'HudScene' }); }

  create() {
    this._buildTopBar();
    this._buildControls();
    this._buildEventLog();
    this._connectSSE();
  }

  private _buildTopBar() {
    const W = this.cameras.main.width;

    const bar = this.add.rectangle(0, 0, W, 36, 0x0d0d1a, 0.88).setOrigin(0, 0);
    const borderLine = this.add.graphics();
    borderLine.lineStyle(1, 0x2a2a3e, 1);
    borderLine.lineBetween(0, 36, W, 36);

    const titleText = this.add.text(16, 10, '🏢 명테크 가상 오피스', {
      fontSize: '13px', color: '#14b8a6', fontFamily: 'monospace', fontStyle: 'bold',
    });

    this.roomLabel = this.add.text(W / 2, 10, '', {
      fontSize: '12px', color: '#aaaacc', fontFamily: 'monospace',
    }).setOrigin(0.5, 0);

    this.statusText = this.add.text(W - 16, 10, '● 온라인', {
      fontSize: '11px', color: '#22c55e', fontFamily: 'monospace',
    }).setOrigin(1, 0);

    [bar, borderLine, titleText, this.roomLabel, this.statusText].forEach(o =>
      o.setScrollFactor(0).setDepth(100)
    );
  }

  private _buildControls() {
    const W = this.cameras.main.width;
    const H = this.cameras.main.height;

    const ctrlBg = this.add.rectangle(0, H, W, 26, 0x0d0d1a, 0.80).setOrigin(0, 1);
    const ctrlTxt = this.add.text(W / 2, H - 6,
      '[WASD / ↑↓←→] 이동   [E] 상호작용   [ESC] 닫기', {
        fontSize: '10px', color: '#444466', fontFamily: 'monospace',
      }).setOrigin(0.5, 1);

    [ctrlBg, ctrlTxt].forEach(o => o.setScrollFactor(0).setDepth(100));
  }

  private _buildEventLog() {
    const W = this.cameras.main.width;
    const LOG_W = 280, LOG_H = 210;
    const LOG_X = W - LOG_W - 8;
    const LOG_Y = 44;

    const logBg = this.add.rectangle(0, 0, LOG_W, LOG_H, 0x0d0d1a, 0.78).setOrigin(0);
    const logBorder = this.add.graphics();
    logBorder.lineStyle(1, 0x2a2a3e, 0.8);
    logBorder.strokeRect(0, 0, LOG_W, LOG_H);

    const headerBg = this.add.rectangle(0, 0, LOG_W, 22, 0x14141f, 0.9).setOrigin(0);
    const headerTxt = this.add.text(8, 4, '실시간 이벤트', {
      fontSize: '10px', color: '#555577', fontFamily: 'monospace',
    });

    const MAX_LINES = 8;
    this.logTexts = [];
    for (let i = 0; i < MAX_LINES; i++) {
      const t = this.add.text(8, 26 + i * 23, '', {
        fontSize: '10px', color: '#777799', fontFamily: 'monospace',
        wordWrap: { width: LOG_W - 16 },
      });
      this.logTexts.push(t);
    }

    this.logContainer = this.add.container(LOG_X, LOG_Y, [
      logBg, logBorder, headerBg, headerTxt, ...this.logTexts,
    ]);
    this.logContainer.setScrollFactor(0).setDepth(100);

    this._addLog('시스템 시작', '#555577');
    this._addLog('WASD로 이동하세요', '#444466');
  }

  private _addLog(text: string, color = '#777799') {
    const now = new Date();
    const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
    this.eventLog.unshift({ time, text, color });
    if (this.eventLog.length > 8) this.eventLog.pop();

    this.logTexts.forEach((t, i) => {
      const entry = this.eventLog[i];
      if (entry) {
        t.setText(`${entry.time} ${entry.text}`);
        t.setColor(entry.color);
        t.setAlpha(1 - i * 0.1);
      } else {
        t.setText('');
      }
    });
  }

  private _connectSSE() {
    try {
      this.sse = new EventSource(SSE_URL);
      this.sse.onopen = () => {
        this.statusText?.setText('● 온라인').setColor('#22c55e');
        this._addLog('SSE 연결됨', '#22c55e');
      };
      this.sse.onerror = () => {
        this.statusText?.setText('● 오프라인').setColor('#ef4444');
      };
      this.sse.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data);
          if (data.type === 'agent_state_change') {
            const color = data.new_state === 'thinking' ? '#f59e0b' :
                          data.new_state === 'responding' ? '#14b8a6' :
                          data.new_state === 'error' ? '#ef4444' : '#555577';
            const label = data.character_name || data.agent_id;
            this._addLog(`${label} → ${data.new_state}`, color);
          } else if (data.type === 'workflow_start') {
            this._addLog(`워크플로우: ${data.department || '?'}`, '#60a5fa');
          } else if (data.type === 'workflow_done') {
            this._addLog(`완료: ${data.department || '-'}`, '#22c55e');
          }
        } catch { /* ignore */ }
      };
    } catch {
      this.statusText?.setText('● 오프라인').setColor('#ef4444');
    }
  }

  setRoomLabel(label: string) {
    this.roomLabel?.setText(label ? `📍 ${label}` : '');
  }

  pushLog(text: string, color = '#777799') {
    this._addLog(text, color);
  }

  shutdown() {
    this.sse?.close();
  }
}
