// Exposes a minimal, safe desktop API to the renderer (the PersFin web app).
// Its presence (window.persfinDesktop) is also how the client detects it's running
// inside the desktop app vs. a plain browser.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('persfinDesktop', {
  // Current database + keys-file paths and the live port.
  getPaths: () => ipcRenderer.invoke('persfin:getPaths'),
  // Open a native folder picker; `which` is 'db' or 'keys'. Returns a path or null.
  chooseDir: (which) => ipcRenderer.invoke('persfin:chooseDir', which),
  // Move/point storage to the chosen folder(s) and relaunch. `next` is
  // { dbDir?, keysDir? }. Returns { ok } or { ok:false, error }.
  applyAndRelaunch: (next) => ipcRenderer.invoke('persfin:applyAndRelaunch', next),
  // Background service (launchd): { supported, enabled, logDir }.
  getBackground: () => ipcRenderer.invoke('persfin:getBackground'),
  // Turn it on/off. Returns { ok } or { ok:false, error }; the window reloads.
  setBackground: (enabled) => ipcRenderer.invoke('persfin:setBackground', !!enabled),
});
