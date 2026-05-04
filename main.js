// ============================================================
// Punch — Electron main process (v1.2)
// Tray app, frameless widget, global hotkeys, idle detection,
// active-window polling, and GitHub-based auto-updates.
// ============================================================

const {
  app, BrowserWindow, Tray, Menu, globalShortcut,
  ipcMain, powerMonitor, nativeImage, shell
} = require('electron');
const path = require('path');
const fs = require('fs');

let activeWin = null;
try { activeWin = require('active-win'); }
catch (e) { console.warn('[punch] active-win unavailable:', e.message); }

let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
} catch (e) { console.warn('[punch] electron-updater unavailable:', e.message); }

const isDev = process.argv.includes('--dev');
const userDataPath = app.getPath('userData');
const dataFile = path.join(userDataPath, 'punch-data.json');

const DEFAULT_HOTKEY = 'CommandOrControl+Alt+P';
const WIDGET_SIZE = { width: 360, height: 380 };
const FULL_SIZE = { width: 920, height: 720 };

let mainWindow = null;
let tray = null;
let idlePollInterval = null;
let activeWinPollInterval = null;
let lastActiveWinKey = null;
let isUserIdle = false;
let currentHotkey = DEFAULT_HOTKEY;
let isQuitting = false;

// Single instance lock
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });
}

// ------------------------------------------------------------
// Window
// ------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: WIDGET_SIZE.width, height: WIDGET_SIZE.height,
    minWidth: 180, minHeight: 80,
    frame: false, backgroundColor: '#0d1014',
    alwaysOnTop: true, skipTaskbar: false, resizable: true, show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('close', (e) => { if (!isQuitting) { e.preventDefault(); mainWindow.hide(); } });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

if (isDev) {
  mainWindow.webContents.openDevTools({ mode: 'detach' });
}
}
function toggleWindowVisibility() {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && mainWindow.isFocused()) mainWindow.hide();
  else { mainWindow.show(); mainWindow.focus(); }
}

// ------------------------------------------------------------
// Tray
// ------------------------------------------------------------
function createTray() {
  let icon;
  try {
    icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
    if (icon.isEmpty()) throw new Error('empty');
  } catch (e) { icon = nativeImage.createEmpty(); }
  if (!icon.isEmpty()) icon = icon.resize({ width: 16, height: 16 });

  tray = new Tray(icon);
  tray.setToolTip('Punch — Time Tracker');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show / Hide widget', click: toggleWindowVisibility },
    { label: 'Start / Stop timer', click: () => sendToRenderer('hotkey:toggle-timer') },
    { type: 'separator' },
    { label: 'Open full view', click: () => { showAndFocus(); sendToRenderer('view:open-full'); } },
    { label: 'Check for updates', click: () => checkForUpdatesManual() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } }
  ]));
  tray.on('click', toggleWindowVisibility);
}

function sendToRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function updateTrayTooltip(timerText, projectName) {
  if (!tray) return;
  if (timerText && projectName) {
    tray.setToolTip(`Punch — ${timerText}\n${projectName}`);
  } else if (timerText) {
    tray.setToolTip(`Punch — ${timerText}`);
  } else {
    tray.setToolTip('Punch — Time Tracker');
  }
}

function updateTaskbarIcon(timerText) {
  if (!mainWindow || process.platform !== 'win32') {
    console.log('[taskbar] Skipped - not Windows or no window');
    return;
  }
  
  console.log('[taskbar] Updating icon with:', timerText);
  
  if (!timerText) {
    // Restore original icon when timer stops
    try {
      const originalIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png'));
      if (!originalIcon.isEmpty()) {
        mainWindow.setIcon(originalIcon);
      }
    } catch (e) {
      console.log('[taskbar] Could not restore original icon');
    }
    // Also clear overlay
    mainWindow.setOverlayIcon(null, '');
    console.log('[taskbar] Icon restored to default');
    return;
  }
  
  try {
    // Create a MASSIVE canvas - taskbar will shrink it
    const canvas = require('canvas');
    const cvs = canvas.createCanvas(512, 512);
    const ctx = cvs.getContext('2d');
    
    // Solid dark background
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, 512, 512);
    
    // Add a subtle border for definition
    ctx.strokeStyle = '#333333';
    ctx.lineWidth = 4;
    ctx.strokeRect(2, 2, 508, 508);
    
    // Show MM:SS format - SPLIT VERTICALLY
    const parts = timerText.split(':');
    const minutes = parts.length === 3 ? parts[1] : parts[0];
    const seconds = parts.length === 3 ? parts[2] : parts[1];
    
    // Draw the time - MASSIVE font, stacked vertically
    ctx.fillStyle = '#e89b43'; // Bright green for visibility
    ctx.textAlign = 'center';
    
    // Use monospace for better digit alignment
    ctx.font = 'bold 200px Consolas, monospace';
    
    // Draw minutes on top
    ctx.textBaseline = 'bottom';
    ctx.fillText(minutes, 256, 240);
    
    // Draw separator
    ctx.font = 'bold 80px Consolas, monospace';
    ctx.textBaseline = 'middle';
    ctx.fillText(':', 256, 256);
    
    // Draw seconds on bottom
    ctx.font = 'bold 200px Consolas, monospace';
    ctx.textBaseline = 'top';
    ctx.fillText(seconds, 256, 272);
    
    console.log('[taskbar] Icon set successfully');
    
    // Convert canvas to icon
    const img = nativeImage.createFromDataURL(cvs.toDataURL());
    mainWindow.setIcon(img);
  } catch (err) {
    console.error('[taskbar] Error creating icon:', err);
  }
}


function showAndFocus() {
  if (!mainWindow) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

// ------------------------------------------------------------
// Hotkeys
// ------------------------------------------------------------
function registerHotkey(accel) {
  globalShortcut.unregisterAll();
  if (!accel) return false;
  try {
    const ok = globalShortcut.register(accel, () => {
      sendToRenderer('hotkey:toggle-timer');
      showAndFocus();
      sendToRenderer('hotkey:focus-notes');
    });
    if (ok) currentHotkey = accel;
    return ok;
  } catch (e) { console.error('[punch] hotkey register failed:', e); return false; }
}

// ------------------------------------------------------------
// Idle
// ------------------------------------------------------------
function startIdlePoll(thresholdSec) {
  stopIdlePoll();
  if (!thresholdSec || thresholdSec < 30) thresholdSec = 300;
  idlePollInterval = setInterval(() => {
    let idleSec = 0;
    try { idleSec = powerMonitor.getSystemIdleTime(); } catch (e) { return; }
    if (!isUserIdle && idleSec >= thresholdSec) {
      isUserIdle = true;
      sendToRenderer('idle:start', { idleSinceMs: Date.now() - idleSec * 1000, idleSec });
    } else if (isUserIdle && idleSec < 5) {
      isUserIdle = false;
      sendToRenderer('idle:end', { nowMs: Date.now() });
    }
  }, 10000);
}
function stopIdlePoll() { if (idlePollInterval) clearInterval(idlePollInterval); idlePollInterval = null; isUserIdle = false; }

// ------------------------------------------------------------
// Active window polling (autodetect)
// ------------------------------------------------------------
async function pollActiveWindow() {
  if (!activeWin) return;
  try {
    const win = await activeWin();
    if (!win) return;
    const key = `${win.owner?.name || ''}::${win.title || ''}`;
    if (key !== lastActiveWinKey) {
      lastActiveWinKey = key;
      sendToRenderer('window:changed', { appName: win.owner?.name || '', title: win.title || '', path: win.owner?.path || '' });
    }
  } catch (e) {}
}
function startActiveWinPoll() {
  stopActiveWinPoll();
  if (!activeWin) return false;
  activeWinPollInterval = setInterval(pollActiveWindow, 4000);
  pollActiveWindow();
  return true;
}
function stopActiveWinPoll() { if (activeWinPollInterval) clearInterval(activeWinPollInterval); activeWinPollInterval = null; lastActiveWinKey = null; }

// ------------------------------------------------------------
// Auto-updater
// ------------------------------------------------------------
function setupAutoUpdater() {
  if (!autoUpdater || !app.isPackaged) return;

  autoUpdater.on('checking-for-update', () => sendToRenderer('update:status', { state: 'checking' }));
  autoUpdater.on('update-available', (info) => sendToRenderer('update:status', { state: 'available', version: info.version }));
  autoUpdater.on('update-not-available', () => sendToRenderer('update:status', { state: 'current' }));
  autoUpdater.on('error', (err) => sendToRenderer('update:status', { state: 'error', message: String(err.message || err) }));
  autoUpdater.on('download-progress', (p) => sendToRenderer('update:status', { state: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => sendToRenderer('update:status', { state: 'ready', version: info.version }));

  // Silent background check shortly after startup
  setTimeout(() => { autoUpdater.checkForUpdates().catch(() => {}); }, 5000);
}

function checkForUpdatesManual() {
  if (!autoUpdater || !app.isPackaged) {
    sendToRenderer('update:status', { state: 'dev' });
    return;
  }
  autoUpdater.checkForUpdates().catch((err) =>
    sendToRenderer('update:status', { state: 'error', message: String(err.message || err) })
  );
}

// ------------------------------------------------------------
// IPC
// ------------------------------------------------------------
ipcMain.handle('data:load', async () => {
  try { if (!fs.existsSync(dataFile)) return null; return JSON.parse(fs.readFileSync(dataFile, 'utf8')); }
  catch (e) { console.error('[punch] load:', e); return null; }
});
ipcMain.handle('data:save', async (_e, data) => {
  try { fs.writeFileSync(dataFile, JSON.stringify(data, null, 2)); return true; }
  catch (e) { console.error('[punch] save:', e); return false; }
});
ipcMain.handle('data:path', () => dataFile);
ipcMain.handle('tray:update-tooltip', (_e, { timerText, projectName }) => updateTrayTooltip(timerText, projectName));
ipcMain.handle('taskbar:update-overlay', (_e, { timerText }) => updateTaskbarIcon(timerText));
ipcMain.handle('window:resize', (_e, { width, height }) => { mainWindow?.setSize(width, height, true); });
ipcMain.handle('window:set-always-on-top', (_e, on) => { mainWindow?.setAlwaysOnTop(!!on); });
ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:set-min-size', (_e, { minWidth, minHeight }) => {
  mainWindow?.setMinimumSize(minWidth, minHeight);
});
ipcMain.handle('window:hide', () => mainWindow?.hide());
ipcMain.handle('window:close-app', () => { isQuitting = true; app.quit(); });
ipcMain.handle('hotkey:set', (_e, accel) => registerHotkey(accel || DEFAULT_HOTKEY));
ipcMain.handle('hotkey:get', () => currentHotkey);
ipcMain.handle('idle:start-poll', (_e, threshold) => startIdlePoll(threshold));
ipcMain.handle('idle:stop-poll', () => stopIdlePoll());
ipcMain.handle('autodetect:start', () => startActiveWinPoll());
ipcMain.handle('autodetect:stop', () => stopActiveWinPoll());
ipcMain.handle('autodetect:available', () => !!activeWin);
ipcMain.handle('webhook:post', async (_e, { url, payload }) => {
  if (!url) return { ok: false, error: 'No URL' };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    let body = ''; try { body = await res.text(); } catch (_) {}
    return { ok: res.ok, status: res.status, body: body.slice(0, 500) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('app:open-data-dir', () => shell.openPath(userDataPath));
ipcMain.handle('app:get-version', () => app.getVersion());
ipcMain.handle('app:is-packaged', () => app.isPackaged);
ipcMain.handle('update:check', () => checkForUpdatesManual());
ipcMain.handle('update:download', () => {
  if (!autoUpdater || !app.isPackaged) return false;
  autoUpdater.downloadUpdate().catch(err => sendToRenderer('update:status', { state: 'error', message: String(err.message || err) }));
  return true;
});
ipcMain.handle('update:install', () => {
  if (!autoUpdater || !app.isPackaged) return false;
  isQuitting = true;
  setImmediate(() => autoUpdater.quitAndInstall());
  return true;
});

// ------------------------------------------------------------
// Lifecycle
// ------------------------------------------------------------
app.whenReady().then(() => {
  createWindow();
  createTray();
  registerHotkey(DEFAULT_HOTKEY);
  setupAutoUpdater();
});
app.on('window-all-closed', (e) => { if (!isQuitting) e.preventDefault(); });
app.on('before-quit', () => { isQuitting = true; });
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopIdlePoll();
  stopActiveWinPoll();
});
