// KevFin desktop (Electron main process).
//
// Wraps the existing Express server + built client. Two ways to run the server:
//  - Background service (Setup → "Keep running in the background"): launchd runs
//    the server at login and keeps it running when this app is closed, and runs
//    the scheduled jobs (see launchd.js). The app then only opens a window to it.
//  - Otherwise the app spawns the server as a child process with the user's
//    chosen storage paths and stops it when the last window closes.
// A small config file in userData remembers where the database and keys file
// live so they can be relocated to a cloud-synced or NAS folder.

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn, fork, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const http = require('http');
const launchd = require('./launchd.js');

const isPackaged = app.isPackaged;

// --- where the built server + client live ---------------------------------
// Dev: desktop/ is a sibling of server/ and client/ in the repo.
// Packaged: extraResources keeps the same server/ + client/ sibling layout, so
// the server's `path.join(__dirname, '../../client/dist')` still resolves.
function resourcesRoot() {
  return isPackaged ? process.resourcesPath : path.join(__dirname, '..');
}
function serverEntry() {
  return path.join(resourcesRoot(), 'server', 'dist', 'index.js');
}

// If a claude binary is bundled at resources/claude/, point the assistant at it
// (the server resolves CLAUDE_BIN first). When absent, the assistant degrades to
// its sign-in gate and the rest of the app is unaffected.
function bundledClaudeBin() {
  const bin = path.join(resourcesRoot(), 'claude', 'claude');
  try { if (fs.existsSync(bin)) return bin; } catch { /* ignore */ }
  return null;
}

// --- tiny config store (userData/kevfin-desktop.json) ---------------------
function configPath() {
  return path.join(app.getPath('userData'), 'kevfin-desktop.json');
}
function defaultConfig() {
  const dir = app.getPath('userData');
  return { dbPath: path.join(dir, 'kevfin.db'), keysPath: path.join(dir, 'kevfin.env'), port: 3001 };
}
function loadConfig() {
  try { return { ...defaultConfig(), ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) }; }
  catch { return defaultConfig(); }
}
function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch (e) { console.error('[desktop] saveConfig failed:', e); }
}

// --- pick a free port (preferred first, else any) -------------------------
function getFreePort(preferred) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(getFreePort(0)));
    // Bind 127.0.0.1 like the server does (KEVFIN_LISTEN=local+tailscale): a
    // wildcard probe could succeed beside a server bound to 127.0.0.1 only and
    // report a busy port as free.
    srv.listen(preferred || 0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

// --- wait until the server answers ----------------------------------------
function waitForServer(port, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/meta/assumptions', timeout: 1500 }, (res) => {
        res.resume(); resolve();
      });
      req.on('error', () => {
        if (Date.now() - start > timeoutMs) reject(new Error('Server did not start in time.'));
        else setTimeout(tick, 300);
      });
      req.on('timeout', () => req.destroy());
    };
    tick();
  });
}

// Resolve once the preferred port can be bound (e.g. after a server stops).
async function waitPortFree(port, timeoutMs) {
  const start = Date.now();
  while ((await getFreePort(port)) !== port) {
    if (Date.now() - start > timeoutMs) throw new Error(`Port ${port} is in use by another program.`);
    await new Promise(r => setTimeout(r, 300));
  }
}

let serverChild = null;
let mainWindow = null;
let currentPort = 0;

function ensureDataDirs(cfg) {
  // Make sure the chosen folders exist before the server opens files there.
  for (const p of [cfg.dbPath, cfg.keysPath]) {
    try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch { /* ignore */ }
  }
}

async function startServer() {
  const cfg = loadConfig();
  currentPort = await getFreePort(cfg.port || 3001);
  ensureDataDirs(cfg);

  const env = {
    ...process.env,
    ...launchd.serverEnv({ port: currentPort, dbPath: cfg.dbPath, keysPath: cfg.keysPath, claudeBin: bundledClaudeBin() }),
  };

  // Dev: run the server with the system Node so the existing better-sqlite3
  // build (system ABI) loads. Packaged: run under Electron's bundled Node
  // (ELECTRON_RUN_AS_NODE) with the native module rebuilt for Electron's ABI.
  if (isPackaged) {
    serverChild = fork(serverEntry(), [], {
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
  } else {
    serverChild = spawn('node', [serverEntry()], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  }

  serverChild.stdout.on('data', d => process.stdout.write(`[server] ${d}`));
  serverChild.stderr.on('data', d => process.stderr.write(`[server] ${d}`));
  serverChild.on('exit', (code) => { console.log('[desktop] server exited', code); serverChild = null; });

  await waitForServer(currentPort);
  return currentPort;
}

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1320, height: 900, minWidth: 900, minHeight: 600,
    title: 'KevFin',
    backgroundColor: '#0b0d12',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(`http://127.0.0.1:${port}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

// Stops only the server this app spawned; a background (launchd) server keeps
// running when the app closes.
function stopServer() {
  if (serverChild) { try { serverChild.kill(); } catch { /* ignore */ } serverChild = null; }
}

// --- background service (launchd) ----------------------------------------
const AGENT_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const LOG_DIR = path.join(os.homedir(), 'Library', 'Logs', 'KevFin');
const agentFile = (label) => path.join(AGENT_DIR, `${label}.plist`);
const guiDomain = () => `gui/${process.getuid()}`;

function launchctl(args) {
  return execFileSync('/bin/launchctl', args, { stdio: 'pipe' }).toString();
}
function isLoaded(label) {
  try { launchctl(['print', `${guiDomain()}/${label}`]); return true; } catch { return false; }
}
function sleepMs(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
// A just-booted-out agent can take a moment to unload; retry the bootstrap.
function bootstrap(label) {
  for (let attempt = 1; ; attempt++) {
    try { launchctl(['bootstrap', guiDomain(), agentFile(label)]); return; }
    catch (e) { if (attempt >= 10) throw e; sleepMs(500); }
  }
}
function bootout(label) {
  if (!isLoaded(label)) return;
  try { launchctl(['bootout', `${guiDomain()}/${label}`]); }
  catch (e) { console.error(`[desktop] bootout ${label} failed:`, e.message); }
}

function backgroundEnabled() {
  return process.platform === 'darwin' && fs.existsSync(agentFile(launchd.LABELS.server));
}

// Write (or rewrite) every agent for the current storage paths and (re)load it.
function installBackground(cfg) {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  fs.mkdirSync(LOG_DIR, { recursive: true });
  ensureDataDirs(cfg);
  const agents = launchd.buildAgents({
    packaged: isPackaged, execPath: process.execPath, entry: serverEntry(),
    port: cfg.port || 3001, dbPath: cfg.dbPath, keysPath: cfg.keysPath,
    claudeBin: bundledClaudeBin(), logDir: LOG_DIR,
  });
  for (const a of agents) {
    bootout(a.label);
    fs.writeFileSync(agentFile(a.label), a.xml);
    bootstrap(a.label);
  }
}

function uninstallBackground() {
  for (const label of launchd.ALL_LABELS) {
    bootout(label);
    try { fs.rmSync(agentFile(label), { force: true }); } catch { /* ignore */ }
  }
}

// Agents load at login; after a manual `launchctl bootout` they may not be.
function ensureBackgroundLoaded() {
  for (const label of launchd.ALL_LABELS) {
    if (fs.existsSync(agentFile(label)) && !isLoaded(label)) bootstrap(label);
  }
}

// Use the background server when it is enabled and answering; otherwise run
// (or keep) the app's own child server.
async function ensureServer() {
  const cfg = loadConfig();
  if (backgroundEnabled()) {
    try {
      ensureBackgroundLoaded();
      await waitForServer(cfg.port || 3001, 20000);
      currentPort = cfg.port || 3001;
      return currentPort;
    } catch (e) {
      console.error('[desktop] background server not reachable — starting a local one:', e.message);
    }
  }
  if (serverChild) return currentPort;
  return startServer();
}

function reloadWindow() {
  if (mainWindow) mainWindow.loadURL(`http://127.0.0.1:${currentPort}`);
}

app.whenReady().then(async () => {
  try {
    const port = await ensureServer();
    createWindow(port);
  } catch (e) {
    dialog.showErrorBox('KevFin failed to start', String((e && e.stack) || e));
    app.quit();
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length > 0) return;
    // The child server stops with the last window; start it again if needed.
    ensureServer().then(createWindow).catch(e => dialog.showErrorBox('KevFin failed to start', String(e)));
  });
});

app.on('window-all-closed', () => { stopServer(); });
app.on('before-quit', stopServer);

// --- IPC: background service (used by Setup → Sync) -------------------------
ipcMain.handle('kevfin:getBackground', () => ({
  supported: process.platform === 'darwin',
  enabled: backgroundEnabled(),
  logDir: LOG_DIR,
}));

// Switch between the background (launchd) server and the app's own child
// server. The window reloads on the server that is now running.
ipcMain.handle('kevfin:setBackground', async (_e, enabled) => {
  if (process.platform !== 'darwin') return { ok: false, error: 'Only available on macOS.' };
  const cfg = loadConfig();
  const port = cfg.port || 3001;
  try {
    if (enabled) {
      stopServer();
      await waitPortFree(port, 10000);
      installBackground(cfg);
      try {
        await waitForServer(port, 30000);
      } catch {
        uninstallBackground();
        await startServer();
        setTimeout(reloadWindow, 300);
        return { ok: false, error: `The background server did not start. See ${path.join(LOG_DIR, 'server.err.log')}.` };
      }
      currentPort = port;
    } else {
      uninstallBackground();
      await waitPortFree(port, 10000).catch(() => { /* startServer picks another port */ });
      await startServer();
    }
    // Reply first, then reload the page onto the server that is now running.
    setTimeout(reloadWindow, 300);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// --- IPC: storage location (used by the Setup → Storage panel) ------------
ipcMain.handle('kevfin:getPaths', () => {
  const c = loadConfig();
  return { dbPath: c.dbPath, keysPath: c.keysPath, port: currentPort };
});

ipcMain.handle('kevfin:chooseDir', async (_e, which) => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: which === 'keys' ? 'Choose a folder for the keys file' : 'Choose a folder for the database',
    message: 'Pick a folder — a cloud-synced or NAS folder works for syncing across machines.',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return null;
  return r.filePaths[0];
});

// Move/point the DB and/or keys file to the chosen folder(s), persist, relaunch.
ipcMain.handle('kevfin:applyAndRelaunch', async (_e, next) => {
  const cfg = loadConfig();
  const updated = { ...cfg };

  const relocate = (curPath, dir, filename) => {
    const dest = path.join(dir, filename);
    if (dest === curPath) return dest;
    try {
      fs.mkdirSync(dir, { recursive: true });
      // Use the file already at the destination if there is one; otherwise carry
      // the current file over so we don't start from an empty database.
      if (!fs.existsSync(dest) && fs.existsSync(curPath)) fs.copyFileSync(curPath, dest);
    } catch (e) {
      throw new Error(`Could not write to ${dir}: ${e.message}`);
    }
    return dest;
  };

  try {
    if (next.dbDir) updated.dbPath = relocate(cfg.dbPath, next.dbDir, 'kevfin.db');
    if (next.keysDir) updated.keysPath = relocate(cfg.keysPath, next.keysDir, 'kevfin.env');
  } catch (e) {
    return { ok: false, error: e.message };
  }

  saveConfig(updated);
  // A background server still points at the old paths; rewrite and restart it.
  if (backgroundEnabled()) {
    try { installBackground(updated); }
    catch (e) { return { ok: false, error: `Saved, but the background service could not be updated: ${e.message}` }; }
  }
  app.relaunch();
  app.exit(0);
  return { ok: true };
});
