import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

const BRIDGE_STATE_FILENAME = 'bridge_state.json';

export function activate(context: vscode.ExtensionContext) {
  const provider = new BridgeViewProvider(context.extensionUri, context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('myungTechBridgeView', provider)
  );
}

export function deactivate() {}

class BridgeViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private watcher?: vscode.FileSystemWatcher;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly context: vscode.ExtensionContext
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    // Load static shell ONCE — all subsequent updates via postMessage
    webviewView.webview.html = getStaticShellHtml();

    // Send initial data after shell is loaded
    setTimeout(() => this.pushState(), 300);

    // Watch bridge_state.json for changes → push data only
    this.setupFileWatcher();

    webviewView.onDidDispose(() => {
      this.watcher?.dispose();
    });

    // Handle messages FROM webview (bidirectional RPC)
    webviewView.webview.onDidReceiveMessage((msg) => {
      this.handleWebviewMessage(msg);
    });
  }

  private getBridgeStatePath(): string | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return undefined;
    }
    return path.join(workspaceFolders[0].uri.fsPath, 'bridge', BRIDGE_STATE_FILENAME);
  }

  private readBridgeState(): object | null {
    const filePath = this.getBridgeStatePath();
    if (!filePath) {
      return null;
    }
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  private setupFileWatcher() {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders || workspaceFolders.length === 0) {
      return;
    }

    const pattern = new vscode.RelativePattern(
      workspaceFolders[0],
      `bridge/${BRIDGE_STATE_FILENAME}`
    );

    this.watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const onFileChange = () => this.pushState();
    this.watcher.onDidChange(onFileChange);
    this.watcher.onDidCreate(onFileChange);

    this.context.subscriptions.push(this.watcher);
  }

  /** Push JSON data to WebView via postMessage — NO HTML reload */
  private pushState() {
    if (!this.view) {
      return;
    }
    const state = this.readBridgeState();
    this.view.webview.postMessage({ type: 'bridgeUpdate', data: state });
  }

  /** Handle incoming RPC messages from WebView */
  private handleWebviewMessage(msg: { command: string; payload?: unknown }) {
    switch (msg.command) {
      case 'requestRefresh':
        this.pushState();
        break;
      case 'openManifest':
        if (typeof msg.payload === 'string') {
          const uri = vscode.Uri.file(msg.payload);
          vscode.workspace.openTextDocument(uri).then(doc => {
            vscode.window.showTextDocument(doc);
          });
        }
        break;
      case 'showInfo':
        if (typeof msg.payload === 'string') {
          vscode.window.showInformationMessage(msg.payload);
        }
        break;
      default:
        break;
    }
  }
}

/**
 * Returns a STATIC HTML shell that is loaded ONCE.
 * All data updates arrive via window.addEventListener('message').
 */
function getStaticShellHtml(): string {
  return `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Myung-Tech Bridge Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
      background: var(--vscode-editor-background, #1e1e1e);
      color: var(--vscode-editor-foreground, #d4d4d4);
      padding: 12px;
      font-size: 13px;
    }
    .header {
      text-align: center;
      margin-bottom: 16px;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
    }
    .header h1 { font-size: 15px; font-weight: 600; color: var(--vscode-foreground, #fff); }
    .header .timestamp { font-size: 11px; color: var(--vscode-descriptionForeground, #888); margin-top: 4px; }
    .section-title {
      font-size: 12px; font-weight: 600; text-transform: uppercase;
      letter-spacing: 0.5px; color: var(--vscode-descriptionForeground, #888);
      margin: 12px 0 8px 0;
    }
    .dept-grid { display: flex; flex-direction: column; gap: 8px; }
    .dept-card {
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-panel-border, #333);
      border-radius: 6px; padding: 10px 12px;
      position: relative; overflow: hidden; cursor: pointer;
      transition: border-color 0.2s;
    }
    .dept-card:hover { border-color: var(--vscode-focusBorder, #007acc); }
    .dept-card::before {
      content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 3px;
    }
    .dept-card.ready::before { background: #4ec9b0; }
    .dept-card.error::before { background: #f14c4c; }
    .dept-card.unknown::before { background: #cca700; }
    .dept-name { font-weight: 600; font-size: 13px; color: var(--vscode-foreground, #fff); }
    .dept-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    .badge {
      display: inline-block; font-size: 11px; padding: 2px 6px; border-radius: 3px;
      background: var(--vscode-badge-background, #4d4d4d); color: var(--vscode-badge-foreground, #fff);
    }
    .badge.status-ready { background: #2d4f47; color: #4ec9b0; }
    .badge.brain { background: #3b3147; color: #c586c0; }
    .badge.skill { background: #2b3d4f; color: #9cdcfe; }
    .events-section { margin-top: 16px; }
    .event-card {
      background: var(--vscode-editorWidget-background, #252526);
      border: 1px solid var(--vscode-panel-border, #333);
      border-radius: 6px; padding: 10px 12px; margin-bottom: 8px;
    }
    .event-header { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
    .event-arrow { color: #dcdcaa; font-weight: bold; }
    .event-id { font-size: 10px; color: var(--vscode-descriptionForeground, #666); font-family: monospace; }
    .event-payload {
      font-size: 12px; color: var(--vscode-foreground, #ccc);
      padding: 6px 8px; background: var(--vscode-textBlockQuote-background, #2a2a2a);
      border-radius: 4px; margin-top: 4px;
    }
    .event-time { font-size: 10px; color: var(--vscode-descriptionForeground, #666); margin-top: 4px; }
    .canvas-container { margin-top: 12px; display: flex; justify-content: center; }
    canvas { border-radius: 6px; background: var(--vscode-editor-background, #1e1e1e); }
    .empty-state { text-align: center; padding: 32px 16px; color: var(--vscode-descriptionForeground, #888); }
    .toolbar {
      display: flex; justify-content: flex-end; margin-bottom: 8px;
    }
    .toolbar button {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
      border: none; border-radius: 4px; padding: 4px 10px;
      font-size: 11px; cursor: pointer;
    }
    .toolbar button:hover { background: var(--vscode-button-hoverBackground, #1177bb); }
  </style>
</head>
<body>
  <div class="toolbar">
    <button id="btn-refresh">⟳ Refresh</button>
  </div>

  <div class="header">
    <h1>🏢 Myung-Tech Orchestration</h1>
    <div class="timestamp" id="timestamp">연결 대기 중...</div>
  </div>

  <div class="section-title">부서 상태</div>
  <div class="dept-grid" id="dept-grid">
    <div class="empty-state">데이터 로딩 중...</div>
  </div>

  <div class="events-section">
    <div class="section-title">Shared Memory Events</div>
    <div id="events-container">
      <div class="empty-state">데이터 로딩 중...</div>
    </div>
  </div>

  <div class="canvas-container">
    <canvas id="topology-canvas" width="320" height="180"></canvas>
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    // ─── RPC: Send messages TO extension ───
    document.getElementById('btn-refresh').addEventListener('click', () => {
      vscode.postMessage({ command: 'requestRefresh' });
    });

    function openManifest(manifestPath) {
      vscode.postMessage({ command: 'openManifest', payload: manifestPath });
    }

    // ─── RPC: Receive messages FROM extension ───
    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'bridgeUpdate' && msg.data) {
        renderState(msg.data);
      }
    });

    // ─── Incremental DOM Renderer ───
    function renderState(state) {
      // Timestamp
      const tsEl = document.getElementById('timestamp');
      if (state.generated_at) {
        const d = new Date(state.generated_at);
        tsEl.textContent = '최종 갱신: ' + d.toLocaleString('ko-KR');
      } else {
        tsEl.textContent = '타임스탬프 없음';
      }

      // Department Cards — incremental rebuild
      const grid = document.getElementById('dept-grid');
      const departments = state.departments || [];
      if (departments.length === 0) {
        grid.innerHTML = '<div class="empty-state">부서 데이터 없음</div>';
      } else {
        let html = '';
        departments.forEach(dept => {
          const statusClass = (dept.status || '').toLowerCase() === 'ready' ? 'ready' :
                              (dept.error_detail ? 'error' : 'unknown');
          const skills = (dept.active_skills || [])
            .map(s => '<span class="badge skill">' + escHtml(s) + '</span>').join('');
          html += '<div class="dept-card ' + statusClass + '" onclick="openManifest(\\''+escHtml(dept.manifest_path || '')+'\\')">'+
            '<div class="dept-name">' + escHtml(dept.name || dept.id) + '</div>' +
            '<div class="dept-meta">' +
              '<span class="badge status-ready">' + escHtml(dept.status) + '</span>' +
              '<span class="badge brain">' + escHtml(dept.assigned_brain || '—') + '</span>' +
              skills +
            '</div></div>';
        });
        grid.innerHTML = html;
      }

      // Events
      const evContainer = document.getElementById('events-container');
      const events = state.shared_memory_events || [];
      if (events.length === 0) {
        evContainer.innerHTML = '<div class="empty-state">이벤트 없음</div>';
      } else {
        let html = '';
        events.forEach(ev => {
          const time = ev.timestamp ? new Date(ev.timestamp).toLocaleString('ko-KR') : '';
          html += '<div class="event-card">' +
            '<div class="event-header">' +
              '<span class="badge">' + escHtml(ev.sender) + '</span>' +
              '<span class="event-arrow">→</span>' +
              '<span class="badge">' + escHtml(ev.target) + '</span>' +
            '</div>' +
            '<div class="event-id">' + escHtml(ev.event_id) + '</div>' +
            '<div class="event-payload">' + escHtml(ev.payload || '') + '</div>' +
            '<div class="event-time">' + escHtml(time) + '</div>' +
          '</div>';
        });
        evContainer.innerHTML = html;
      }

      // Topology Canvas
      renderTopology(departments, events);
    }

    function renderTopology(departments, events) {
      const canvas = document.getElementById('topology-canvas');
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const deptPositions = {};
      const nodeRadius = 24;
      const cols = departments.length;
      if (cols === 0) return;
      const spacing = canvas.width / (cols + 1);

      departments.forEach((dept, i) => {
        const x = spacing * (i + 1);
        const y = 60;
        deptPositions[dept.id] = { x, y };

        // Node circle
        ctx.beginPath();
        ctx.arc(x, y, nodeRadius, 0, Math.PI * 2);
        const statusColor = dept.status === 'Ready' ? '#4ec9b0' : '#cca700';
        ctx.fillStyle = statusColor + '22';
        ctx.fill();
        ctx.strokeStyle = statusColor;
        ctx.lineWidth = 2;
        ctx.stroke();

        // Label
        ctx.fillStyle = '#d4d4d4';
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        const label = (dept.name || dept.id).replace(/부$/, '');
        ctx.fillText(label, x, y + nodeRadius + 14);
      });

      // Draw event arrows
      events.forEach(ev => {
        const from = deptPositions[ev.sender];
        const to = deptPositions[ev.target];
        if (!from || !to) return;

        const startY = from.y + nodeRadius + 2;
        const endY = to.y + nodeRadius + 2;
        const midY = 140;

        ctx.beginPath();
        ctx.moveTo(from.x, startY);
        ctx.quadraticCurveTo((from.x + to.x) / 2, midY, to.x, endY);
        ctx.strokeStyle = '#dcdcaa88';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);

        // Arrow head
        const angle = Math.atan2(endY - midY, to.x - (from.x + to.x) / 2);
        ctx.beginPath();
        ctx.moveTo(to.x, endY);
        ctx.lineTo(to.x - 8 * Math.cos(angle - 0.4), endY - 8 * Math.sin(angle - 0.4));
        ctx.lineTo(to.x - 8 * Math.cos(angle + 0.4), endY - 8 * Math.sin(angle + 0.4));
        ctx.closePath();
        ctx.fillStyle = '#dcdcaa';
        ctx.fill();

        // Event ID label
        ctx.fillStyle = '#888';
        ctx.font = '9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(ev.event_id, (from.x + to.x) / 2, midY - 4);
      });
    }

    function escHtml(str) {
      return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
  </script>
</body>
</html>`;
}
