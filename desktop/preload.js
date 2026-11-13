// Exposes a minimal, safe desktop API to the renderer (the KevFin web app).
// Its presence (window.kevfinDesktop) is also how the client detects it's running
// inside the desktop app vs. a plain browser.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kevfinDesktop', {
  // Current database + keys-file paths and the live port.
  getPaths: () => ipcRenderer.invoke('kevfin:getPaths'),
  // Open a native folder picker; `which` is 'db' or 'keys'. Returns a path or null.
  chooseDir: (which) => ipcRenderer.invoke('kevfin:chooseDir', which),
  // Move/point storage to the chosen folder(s) and relaunch. `next` is
  // { dbDir?, keysDir? }. Returns { ok } or { ok:false, error }.
  applyAndRelaunch: (next) => ipcRenderer.invoke('kevfin:applyAndRelaunch', next),
  // Background service (launchd): { supported, enabled, logDir }.
  getBackground: () => ipcRenderer.invoke('kevfin:getBackground'),
  // Turn it on/off. Returns { ok } or { ok:false, error }; the window reloads.
  setBackground: (enabled) => ipcRenderer.invoke('kevfin:setBackground', !!enabled),
});
