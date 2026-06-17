const vscode = require('vscode');

function activate(context) {
  let panel = null;

  const cmd = vscode.commands.registerCommand('myungtech.openOffice', () => {
    if (panel) { panel.reveal(); return; }

    panel = vscode.window.createWebviewPanel(
      'myungtechOffice', '🏢 명테크 AI 워크스페이스',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    panel.webview.html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src * 'unsafe-inline' 'unsafe-eval' data: blob:;">
  <style>body,html,iframe{margin:0;padding:0;width:100%;height:100%;border:none;background:#040812}</style>
</head>
<body>
  <iframe src="http://localhost:5173" allow="*" style="width:100%;height:100vh;border:none;"></iframe>
</body>
</html>`;

    panel.onDidDispose(() => { panel = null; }, null, context.subscriptions);
  });

  context.subscriptions.push(cmd);

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.text = '$(server) 명테크 오피스';
  statusBar.command = 'myungtech.openOffice';
  statusBar.tooltip = '명테크 AI Agent 워크스페이스 열기';
  statusBar.show();
  context.subscriptions.push(statusBar);
}

function deactivate() {}
module.exports = { activate, deactivate };
