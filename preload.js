// Preload — contextBridge API
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('punch', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveData: (data) => ipcRenderer.invoke('data:save', data),
  dataPath: () => ipcRenderer.invoke('data:path'),
  openDataDir: () => ipcRenderer.invoke('app:open-data-dir'),
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  isPackaged: () => ipcRenderer.invoke('app:is-packaged'),

  resize: (width, height) => ipcRenderer.invoke('window:resize', { width, height }),
  setMinSize: (minWidth, minHeight) => ipcRenderer.invoke('window:set-min-size', { minWidth, minHeight }),
  setAlwaysOnTop: (on) => ipcRenderer.invoke('window:set-always-on-top', on),
  updateTrayTooltip: (timerText, projectName) => ipcRenderer.invoke('tray:update-tooltip', { timerText, projectName }),
  updateTaskbarOverlay: (timerText) => ipcRenderer.invoke('taskbar:update-overlay', { timerText }),
  minimize: () => ipcRenderer.invoke('window:minimize'),
  hide: () => ipcRenderer.invoke('window:hide'),
  quitApp: () => ipcRenderer.invoke('window:close-app'),

  setHotkey: (accel) => ipcRenderer.invoke('hotkey:set', accel),
  getHotkey: () => ipcRenderer.invoke('hotkey:get'),

  startIdlePoll: (thresholdSec) => ipcRenderer.invoke('idle:start-poll', thresholdSec),
  stopIdlePoll: () => ipcRenderer.invoke('idle:stop-poll'),

  startAutodetect: () => ipcRenderer.invoke('autodetect:start'),
  stopAutodetect: () => ipcRenderer.invoke('autodetect:stop'),
  autodetectAvailable: () => ipcRenderer.invoke('autodetect:available'),

  postWebhook: (url, payload) => ipcRenderer.invoke('webhook:post', { url, payload }),

  checkForUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),

  onToggleTimer: (cb) => ipcRenderer.on('hotkey:toggle-timer', () => cb()),
  onFocusNotes: (cb) => ipcRenderer.on('hotkey:focus-notes', () => cb()),
  onOpenFull: (cb) => ipcRenderer.on('view:open-full', () => cb()),
  onWindowChanged: (cb) => ipcRenderer.on('window:changed', (_e, data) => cb(data)),
  onIdleStart: (cb) => ipcRenderer.on('idle:start', (_e, data) => cb(data)),
  onIdleEnd: (cb) => ipcRenderer.on('idle:end', (_e, data) => cb(data)),
  onUpdateStatus: (cb) => ipcRenderer.on('update:status', (_e, data) => cb(data))
});
