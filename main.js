// ============================================================
// Punch — Electron main process (v2.1.1)
// Tray app, frameless widget, global hotkeys, idle detection,
// active-window polling, and GitHub-based auto-updates.
// ============================================================

const {
  app, BrowserWindow, Tray, Menu, globalShortcut,
  ipcMain, powerMonitor, nativeImage, shell
} = require('electron');
const path = require('path');
const fs = require('fs');

// get-windows is the modern, prebuilt-binary successor of active-win and
// is ESM-only — load it via dynamic import. The module exports an
// async `activeWindow()` that returns the focused window's owner/title.
// Returns null while loading (first call); subsequent calls return the
// resolved function. Logged once at startup so we can confirm in the
// debug log when detection is online vs. silently broken.
let activeWin = null;
let activeWinLoadAttempted = false;
async function ensureActiveWin() {
  if (activeWin) return activeWin;
  if (activeWinLoadAttempted) return null;
  activeWinLoadAttempted = true;
  try {
    const mod = await import('get-windows');
    activeWin = mod.activeWindow || mod.default;
    writeLog('[focus] get-windows loaded; window detection available');
    return activeWin;
  } catch (e) {
    writeLog(`[focus] get-windows unavailable: ${e.message}`);
    console.warn('[punch] get-windows unavailable:', e.message);
    return null;
  }
}

let autoUpdater = null;
try {
  autoUpdater = require('electron-updater').autoUpdater;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
} catch (e) { console.warn('[punch] electron-updater unavailable:', e.message); }

const isDev = process.argv.includes('--dev');
const userDataPath = app.getPath('userData');
const dataFile = path.join(userDataPath, 'punch-data.json');
const logFile  = path.join(userDataPath, 'debug.log');

function writeLog(msg) {
  try { fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`); } catch (_) {}
}

process.on('uncaughtException',  (err) => writeLog(`uncaughtException: ${err.stack || err}`));
process.on('unhandledRejection', (err) => writeLog(`unhandledRejection: ${err?.stack || err}`));

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

  // Fallback: if renderer fails to signal ready within 8s, show anyway
  const showFallback = setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
  }, 8000);
  mainWindow.once('ready-to-show', () => clearTimeout(showFallback));

  mainWindow.on('close', (e) => { if (!isQuitting) { e.preventDefault(); mainWindow.hide(); } });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  // Log renderer crashes to help diagnose packaged-mode issues
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    writeLog(`Renderer process gone: ${details.reason} (exitCode ${details.exitCode})`);
  });
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    writeLog(`Failed to load: ${desc} (${code}) — ${url}`);
  });

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

// Steam-style approach: create a tiny invisible "timer window" off-screen
// with its own AppUserModelID. Windows treats it as a separate app and gives
// it its own taskbar entry, distinct from the pinned shortcut. We never
// touch the main window's AUMID, so Punch's main entry groups normally with
// the pinned shortcut (or with itself on desktop launches). Setting the
// icon on this ghost window is what shows the live MM:SS countdown.
//
// Earlier approaches (v1.4.3 process AUMID, v1.4.4 main-window setAppDetails)
// failed because Windows binds the launching process's taskbar entry to the
// shortcut's AUMID before our JS runs, and changing AUMID after the fact
// doesn't move an existing entry. A brand-new window doesn't have that
// pre-existing binding, so its setAppDetails actually controls grouping.
let timerWindow = null;

function ensureTimerWindow() {
  if (timerWindow && !timerWindow.isDestroyed()) return timerWindow;

  timerWindow = new BrowserWindow({
    width: 1, height: 1,
    x: -32000, y: -32000,           // off-screen
    show: false,
    frame: false,
    transparent: true,
    skipTaskbar: false,             // show in taskbar
    // Note: do NOT set focusable: false here. On Windows that adds the
    // WS_EX_TOOLWINDOW style which also excludes the window from the
    // taskbar — defeating the entire point. The ghost is focusable but
    // we use showInactive() so it never steals focus.
    minimizable: false,
    maximizable: false,
    resizable: false,
    alwaysOnTop: false,
    title: 'Punch Timer',
    icon: nativeImage.createEmpty(),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: true
    }
  });

  writeLog('[taskbar] timer window created');

  if (process.platform === 'win32') {
    try {
      timerWindow.setAppDetails({
        appId: 'com.justin.punch.live',
        relaunchDisplayName: 'Punch Timer'
      });
      writeLog('[taskbar] setAppDetails applied to timer window');
    } catch (e) {
      writeLog(`[taskbar] timerWindow setAppDetails failed: ${e.message}`);
    }
  }

  // Trivial content; we just need a BrowserWindow object to host a taskbar entry.
  timerWindow.loadURL('data:text/html,<html><body style="margin:0;background:transparent"></body></html>');

  // If the user clicks the timer window's taskbar entry, focus the main Punch
  // window instead (the timer window itself is invisible).
  // Guard: when the user minimizes mainWindow, Windows sometimes routes focus
  // here as the next taskbar entry — don't fight that intent by un-minimizing.
  timerWindow.on('focus', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) return;
      if (!mainWindow.isVisible()) mainWindow.show();
      mainWindow.focus();
    }
  });

  // Don't actually close on user attempt (e.g. right-click → Close) — just hide.
  timerWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      timerWindow.hide();
    }
  });

  return timerWindow;
}

function destroyTimerWindow() {
  if (timerWindow && !timerWindow.isDestroyed()) {
    timerWindow.removeAllListeners('close');
    timerWindow.destroy();
  }
  timerWindow = null;
}

// Per-tick taskbar update. The renderer draws the live MM:SS / HH:MM icon
// and sends it as a PNG data URL. We push it to the ghost timerWindow, which
// has its own AUMID and shows as a separate taskbar entry.
function updateTaskbarIcon(timerText, dataUrl) {
  if (process.platform !== 'win32') return;

  if (!timerText) {
    // Timer stopped — hide the ghost entry. The main Punch entry is
    // untouched (was never modified in the running case).
    if (timerWindow && !timerWindow.isDestroyed()) {
      try { timerWindow.hide(); } catch (_) {}
    }
    return;
  }

  if (!dataUrl) {
    writeLog('[taskbar] update called without dataUrl — skipped');
    return;
  }

  try {
    const img = nativeImage.createFromDataURL(dataUrl);
    if (img.isEmpty()) {
      writeLog('[taskbar] decoded image was empty — skipped');
      return;
    }
    const w = ensureTimerWindow();
    w.setIcon(img);
    if (!w.isVisible()) {
      // showInactive avoids stealing focus from whatever the user is doing.
      w.showInactive();
      writeLog('[taskbar] timer window shown in taskbar');
    }
  } catch (err) {
    writeLog(`[taskbar] update failed: ${err.message}`);
  }
}

function showAndFocus() {
  if (!mainWindow) return;
  if (!mainWindow.isVisible()) mainWindow.show();
  mainWindow.focus();
}

// ------------------------------------------------------------
// Nudge attention
// ------------------------------------------------------------
// Cooldown timestamp so a stream of nudges can't repeatedly steal focus from
// the user. If they ignore a popup, we still raise the next nudge but only
// after this window expires. The popup itself stays visible — only the
// focus/flash side-effects are throttled.
let lastNudgeFrontAtMs = 0;
const NUDGE_FRONT_COOLDOWN_MS = 60 * 1000;

function bringToFrontForNudge() {
  if (!mainWindow || mainWindow.isDestroyed()) return { brought: false, reason: 'no-window' };
  const now = Date.now();
  if (now - lastNudgeFrontAtMs < NUDGE_FRONT_COOLDOWN_MS) {
    // Don't fight the user. Still flash the taskbar so they see the cue.
    try { mainWindow.flashFrame(true); } catch (_) {}
    return { brought: false, reason: 'cooldown' };
  }
  lastNudgeFrontAtMs = now;
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    // flashFrame is a no-op once the window has focus; harmless if it
    // already does. On Windows it pings the taskbar entry if the OS
    // refused the focus request — our fallback attention cue.
    try { mainWindow.flashFrame(true); } catch (_) {}
  } catch (e) {
    writeLog(`[nudge] bringToFront failed: ${e.message}`);
    return { brought: false, reason: 'error' };
  }
  return { brought: true };
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
  const aw = await ensureActiveWin();
  if (!aw) return;
  try {
    const win = await aw();
    if (!win) return;
    if (win.owner?.processId === process.pid) return; // ignore Punch itself
    const key = `${win.owner?.name || ''}::${win.title || ''}`;
    if (key !== lastActiveWinKey) {
      lastActiveWinKey = key;
      sendToRenderer('window:changed', { appName: win.owner?.name || '', title: win.title || '', path: win.owner?.path || '' });
    }
  } catch (e) {
    writeLog(`[autodetect] activeWindow() threw: ${e.message}`);
  }
}
function startActiveWinPoll() {
  stopActiveWinPoll();
  // Don't block on the async load — start the timer immediately; the
  // first few polls will be no-ops until the module finishes importing.
  ensureActiveWin();
  activeWinPollInterval = setInterval(pollActiveWindow, 4000);
  pollActiveWindow();
  return true;
}
function stopActiveWinPoll() { if (activeWinPollInterval) clearInterval(activeWinPollInterval); activeWinPollInterval = null; lastActiveWinKey = null; }

// ------------------------------------------------------------
// Focus Signals — window tracking
// ------------------------------------------------------------
// Separate from the autodetect poll above. The autodetect poll runs at 4s
// to feed rule-based project suggestions; the focus tracking poll runs at
// a user-configurable interval (default 30s) and feeds the focusEvents
// data foundation. Two streams of active-window data keeps either feature
// removable without breaking the other.
let focusTrackingInterval = null;
let focusTrackingLastKey = null;
let focusTrackingCaptureTitles = false;

async function pollFocusWindow() {
  const aw = await ensureActiveWin();
  if (!aw) return;
  try {
    const win = await aw();
    if (!win) return;
    // Skip Punch itself — tracking the time tracker is noise, and self
    // events would also dominate the most-used-app stat unfairly since
    // Punch is always-on-top. process.pid covers both dev (Electron) and
    // packaged (Punch.exe) without name-matching guesswork.
    if (win.owner?.processId === process.pid) return;
    const appName = win.owner?.name || '';
    const title = focusTrackingCaptureTitles ? (win.title || '') : '';
    const key = `${appName}::${title}`;
    if (key === focusTrackingLastKey) return;
    focusTrackingLastKey = key;
    sendToRenderer('focus:window-changed', {
      appName,
      windowTitle: focusTrackingCaptureTitles ? (win.title || '') : null,
      ts: Date.now()
    });
  } catch (e) {
    // get-windows can throw transiently on lock screens / fullscreen apps.
    // Log it so we have visibility — silent swallow was how the active-win
    // ffi-napi failure went undetected for so long.
    writeLog(`[focus] activeWindow() threw: ${e.message}`);
  }
}

function startFocusTrackingPoll(intervalSec, trackTitles) {
  stopFocusTrackingPoll();
  // Kick off the async import in the background. The first few polls
  // may be no-ops while the module loads (typically <50ms).
  ensureActiveWin();
  const ms = Math.max(5, Math.min(300, Number(intervalSec) || 30)) * 1000;
  focusTrackingCaptureTitles = !!trackTitles;
  focusTrackingInterval = setInterval(pollFocusWindow, ms);
  pollFocusWindow();
  writeLog(`[focus] window tracking started: interval=${ms}ms titles=${focusTrackingCaptureTitles}`);
  return true;
}

function stopFocusTrackingPoll() {
  if (focusTrackingInterval) clearInterval(focusTrackingInterval);
  focusTrackingInterval = null;
  focusTrackingLastKey = null;
}

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
ipcMain.handle('taskbar:update-overlay', (_e, { timerText, dataUrl }) => updateTaskbarIcon(timerText, dataUrl));
ipcMain.handle('window:resize', (_e, { width, height }) => { mainWindow?.setSize(width, height, true); });
ipcMain.handle('window:set-always-on-top', (_e, on) => { mainWindow?.setAlwaysOnTop(!!on); });
ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:set-min-size', (_e, { minWidth, minHeight }) => {
  mainWindow?.setMinimumSize(minWidth, minHeight);
});
ipcMain.handle('window:hide', () => mainWindow?.hide());
ipcMain.handle('window:close-app', () => { isQuitting = true; app.quit(); });
ipcMain.handle('nudge:bring-to-front', () => bringToFrontForNudge());
ipcMain.handle('hotkey:set', (_e, accel) => registerHotkey(accel || DEFAULT_HOTKEY));
ipcMain.handle('hotkey:get', () => currentHotkey);
ipcMain.handle('idle:start-poll', (_e, threshold) => startIdlePoll(threshold));
ipcMain.handle('idle:stop-poll', () => stopIdlePoll());
ipcMain.handle('autodetect:start', () => startActiveWinPoll());
ipcMain.handle('autodetect:stop', () => stopActiveWinPoll());
ipcMain.handle('autodetect:available', async () => !!(await ensureActiveWin()));
ipcMain.handle('focus:tracking:start', (_e, { intervalSec, trackTitles }) =>
  startFocusTrackingPoll(intervalSec, trackTitles));
ipcMain.handle('focus:tracking:stop', () => stopFocusTrackingPoll());
ipcMain.handle('focus:tracking:available', async () => !!(await ensureActiveWin()));
ipcMain.handle('webhook:post', async (_e, { url, payload }) => {
  if (!url) return { ok: false, error: 'No URL' };
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    let body = ''; try { body = await res.text(); } catch (_) {}
    return { ok: res.ok, status: res.status, body: body.slice(0, 500) };
  } catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('app:open-data-dir', () => shell.openPath(userDataPath));
ipcMain.handle('app:open-log', () => shell.openPath(logFile));
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
  stopFocusTrackingPoll();
  destroyTimerWindow();
});
