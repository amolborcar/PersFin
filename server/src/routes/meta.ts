import { Router, type Request, type Response } from 'express';
import { execFile } from 'child_process';
import { buildAssumptionsMeta } from '../util/assumptions.js';
import { getEdgarStatus } from '../services/edgarHoldings.js';
import { parsePmsetSleepMinutes } from '../util/pmset.js';

const router = Router();

// Exposes the live proxy/substitution shortcuts so the client FAQ renders the
// exact mappings the look-through engine uses (no duplicated, drift-prone list).
router.get('/assumptions', (_req: Request, res: Response) => {
  res.json(buildAssumptionsMeta());
});

// EDGAR look-through diagnostics: which funds have cached N-PORT holdings
// (count + as-of quarter), which came back empty, and recent fetch errors —
// so a stuck fund is debuggable from the browser instead of container logs.
router.get('/edgar', (_req: Request, res: Response) => {
  res.json(getEdgarStatus());
});

// Whether this Mac goes to sleep on its own. The always-on setup runs scheduled
// jobs via launchd, which only runs a missed job once the Mac wakes — so Setup
// warns when system sleep is on. Read-only: `pmset -g` needs no admin rights,
// and PersFin never changes power settings. Not macOS → { supported: false }.
router.get('/power', (_req: Request, res: Response) => {
  if (process.platform !== 'darwin') return res.json({ supported: false, sleepMinutes: null });
  execFile('/usr/bin/pmset', ['-g'], { timeout: 3000 }, (err, stdout) => {
    res.json({ supported: true, sleepMinutes: err ? null : parsePmsetSleepMinutes(String(stdout)) });
  });
});

export default router;
