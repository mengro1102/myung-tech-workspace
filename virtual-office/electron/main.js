const { app, BrowserWindow, Tray, Menu, nativeImage, shell, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
const DEV_URL = 'http://localhost:5173';
const ICON = path.join(__dirname, '../public/icon.png');

let mainWindow = null;
let officeWindow = null;
let tray = null;
let isQuitting = false;

/* ── 셸 설정 영속화 (userData/shell-settings.json) ── */
const SETTINGS_PATH = path.join(app.getPath('userData'), 'shell-settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8')); }
  catch { return { openOfficeOnLaunch: false }; }
}
function saveSettings(s) {
  try { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2)); } catch {}
}
let settings = loadSettings();

/* ── 라우트 로딩 (BrowserRouter: dev=URL, prod=loadFile + pushState) ── */
function loadRoute(win, route) {
  if (isDev) {
    win.loadURL(DEV_URL + route);
  } else {
    win.loadFile(path.join(__dirname, '../dist/index.html')).then(() => {
      if (route && route !== '/') {
        win.webContents.executeJavaScript(
          `window.history.pushState({}, '', '${route}');` +
          `window.dispatchEvent(new PopStateEvent('popstate'));`
        ).catch(() => {});
      }
    });
  }
}

/* ── 메인 창 ── */
function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); return mainWindow; }
  mainWindow = new BrowserWindow({
    width: 1400, height: 900, minWidth: 1200, minHeight: 700,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#040812',
    icon: ICON,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'), webSecurity: false,
    },
  });
  loadRoute(mainWindow, '/');
  if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  // 닫기 → 트레이로 최소화(완전 종료는 트레이 메뉴 '종료')
  mainWindow.on('close', (e) => {
    if (!isQuitting) { e.preventDefault(); mainWindow.hide(); }
  });
  return mainWindow;
}

/* ── 별도 가상 사무실 창 ── */
function createOfficeWindow() {
  if (officeWindow && !officeWindow.isDestroyed()) { officeWindow.show(); officeWindow.focus(); return officeWindow; }
  officeWindow = new BrowserWindow({
    width: 1100, height: 760, minWidth: 800, minHeight: 560,
    title: '명테크 — 가상 사무실',
    backgroundColor: '#040812', icon: ICON,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'), webSecurity: false,
    },
  });
  loadRoute(officeWindow, '/office');
  officeWindow.on('closed', () => { officeWindow = null; });
  return officeWindow;
}

/* ── 렌더러로 메뉴 명령 전송 (메인 창) ── */
function sendMenu(cmd) {
  const w = createMainWindow();
  w.show(); w.focus();
  w.webContents.send('menu-command', cmd);
}

/* ── 시스템 트레이 ── */
function buildTray() {
  let img = nativeImage.createFromPath(ICON);
  if (img.isEmpty()) img = nativeImage.createEmpty();
  try { tray = new Tray(img); } catch { return; }
  tray.setToolTip('명테크 — AI 1인 기업 OS');

  const menu = Menu.buildFromTemplate([
    { label: 'Connect AI 열기', click: () => createMainWindow() },
    { label: '가상 사무실 창 열기', click: () => createOfficeWindow() },
    { type: 'separator' },
    { label: '오늘 브리핑 받기', click: () => sendMenu('briefing') },
    { label: '새 대화', click: () => sendMenu('new-chat') },
    { type: 'separator' },
    {
      label: '켤 때 사무실 창 같이 열기', type: 'checkbox',
      checked: !!settings.openOfficeOnLaunch,
      click: (item) => { settings.openOfficeOnLaunch = item.checked; saveSettings(settings); },
    },
    {
      label: '시스템 시작 시 자동 실행', type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: 'separator' },
    { label: '종료', click: () => { isQuitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.on('click', () => {
    if (mainWindow && mainWindow.isVisible()) mainWindow.hide();
    else createMainWindow();
  });
}

/* ── IPC: 렌더러에서 사무실 창 열기 ── */
ipcMain.on('open-office', () => createOfficeWindow());

/* ── 단일 인스턴스 ── */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => { createMainWindow(); });

  app.whenReady().then(() => {
    createMainWindow();
    buildTray();
    if (settings.openOfficeOnLaunch) createOfficeWindow();
  });

  // 트레이 상주 → 모든 창 닫혀도 종료하지 않음(트레이 '종료'로만)
  app.on('window-all-closed', () => { /* keep alive in tray */ });
  app.on('activate', () => { createMainWindow(); });
  app.on('before-quit', () => { isQuitting = true; });
}
