import './env.js'; // loads the keys file (honors PERSFIN_ENV_PATH) before anything reads env
import express from 'express';
import cron from 'node-cron';
import os from 'os';
import { mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

import accountRoutes from './routes/accounts.js';
import plaidRoutes from './routes/plaid.js';
import assetRoutes from './routes/assets.js';
import allocationRoutes from './routes/allocation.js';
import budgetRoutes from './routes/budget.js';
import rulesRoutes from './routes/rules.js';
import netWorthRoutes from './routes/netWorth.js';
import recurringRoutes from './routes/recurring.js';
import performanceRoutes from './routes/performance.js';
import assistantRoutes from './routes/assistant.js';
import metaRoutes from './routes/meta.js';
import configRoutes from './routes/config.js';
import prefsRoutes from './routes/prefs.js';
import exportRoutes from './routes/export.js';
import dataRoutes from './routes/data.js';
import testsRoutes from './routes/tests.js';
import reportRoutes from './routes/report.js';
import jobRoutes from './routes/jobs.js';
import deliveryRoutes from './routes/delivery.js';
import { catchUpHistory } from './services/historyCatchUp.js';
import { runJob } from './services/jobs.js';
import { runWeeklyDelivery } from './services/delivery.js';
import { WEEKLY_SEND_HOUR } from './util/weekWindow.js';
import { localOriginGuard } from './localOrigin.js';
import { listenModeFromEnv, listenHosts, LOOPBACK_HOSTS } from './util/listen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../data');
mkdirSync(DATA_DIR, { recursive: true });

const app = express();
app.use('/api', localOriginGuard); // there is no login — see localOrigin.ts

app.use(express.json({ limit: '15mb' })); // allow large CSV transaction uploads

app.use('/api/accounts', accountRoutes);
app.use('/api/plaid', plaidRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/allocation', allocationRoutes);
app.use('/api/budget/rules', rulesRoutes); // before /api/budget so it is matched first
app.use('/api/budget', budgetRoutes);
app.use('/api/net-worth', netWorthRoutes);
app.use('/api/recurring', recurringRoutes);
app.use('/api/performance', performanceRoutes);
app.use('/api/assistant', assistantRoutes);
app.use('/api/meta', metaRoutes);
app.use('/api/config', configRoutes);
app.use('/api/prefs', prefsRoutes);
app.use('/api/export', exportRoutes);
app.use('/api/data', dataRoutes);
app.use('/api/tests', testsRoutes);
app.use('/api/report', reportRoutes);
app.use('/api/jobs', jobRoutes);
app.use('/api/delivery', deliveryRoutes);

// In production the built client is served from the same port.
// In dev, Vite runs on its own port and proxies /api here instead.
if (process.env.NODE_ENV === 'production') {
  const clientDist = path.join(__dirname, '../../client/dist');
  app.use(express.static(clientDist));
  // SPA fallback: any non-/api path returns index.html. Unknown /api paths get
  // a JSON 404 instead — HTML with a 200 would mask the real error for clients.
  app.get('*', (req, res) => {
    if (req.path.startsWith('/api')) return res.status(404).json({ error: 'not found' });
    res.sendFile(path.join(clientDist, 'index.html'));
  });
}

// Scheduled jobs (see services/jobs.ts). Under the macOS always-on setup,
// launchd agents trigger them via POST /api/jobs/<name> (PERSFIN_SCHEDULER=launchd)
// and run a missed job once the Mac wakes; otherwise (dev) node-cron does it
// in-process. Either way runJob makes each job run at most once per local day.
if (process.env.PERSFIN_SCHEDULER !== 'launchd') {
  // Accounts: refresh daily at 6 AM, then repair history.
  cron.schedule('0 6 * * *', () => {
    runJob('daily-sync').catch(err => console.error('[cron] daily-sync failed:', err));
  });
  // Daily midnight snapshot (skipped while disabled in Setup → Sync; DAILY_SNAPSHOT
  // in the env seeds the default before it's ever toggled).
  cron.schedule('0 0 * * *', () => {
    runJob('snapshot').catch(err => console.error('[cron] snapshot failed:', err));
  });
  // Weekly report: Sunday evening (services/delivery.ts).
  cron.schedule(`0 ${WEEKLY_SEND_HOUR} * * 0`, () => {
    runJob('weekly-report').catch(err => console.error('[cron] weekly-report failed:', err));
  });
}

// A stray rejected promise (e.g. a fire-and-forget provider call) should be logged,
// not take the whole server down — Node's default is to exit on unhandled rejections.
process.on('unhandledRejection', err => console.error('[unhandledRejection]', err));

const PORT = Number(process.env.PORT ?? 3001);

function onListening() {
  console.log(`PersFin server running on http://localhost:${PORT}`);
  // Catch up on history a scheduled run missed while offline. Fire-and-forget
  // so a slow or failing provider can't hold up serving.
  catchUpHistory().catch(err => console.error('[startup] history catch-up failed:', err));
  // Send the due weekly report on any channel that has not sent it (the Mac was
  // off on Sunday evening, or a send failed). Does nothing when all are off.
  runWeeklyDelivery().catch(err => console.error('[startup] weekly delivery catch-up failed:', err));
}

const listenMode = listenModeFromEnv(process.env.PERSFIN_LISTEN);
if (listenMode === 'all') {
  app.listen(PORT, onListening);
} else {
  // Loopback + Tailscale only (see util/listen.ts). Tailscale can come up after
  // the server (e.g. at login), so new Tailscale addresses are bound as they
  // appear. If 127.0.0.1 can't be bound (port taken), exit so launchd retries.
  const bound = new Set<string>();
  const bindNew = () => {
    for (const host of listenHosts(listenMode, os.networkInterfaces()) ?? []) {
      if (bound.has(host)) continue;
      bound.add(host);
      const srv = app.listen(PORT, host, () => {
        console.log(`[listen] ${host}:${PORT}`);
        if (host === '127.0.0.1') onListening();
      });
      srv.on('error', (err: NodeJS.ErrnoException) => {
        console.error(`[listen] could not bind ${host}:${PORT} (${err.code ?? err.message})`);
        if (host === '127.0.0.1') process.exit(1);
        // A Tailscale address that went away is retried on a later check;
        // a missing IPv6 loopback is not worth retrying.
        if (!LOOPBACK_HOSTS.includes(host)) bound.delete(host);
      });
    }
  };
  bindNew();
  setInterval(bindNew, 60_000).unref();
}
