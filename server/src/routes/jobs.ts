import { Router, type Request, type Response } from 'express';
import { runJob, JOB_NAMES, type JobName } from '../services/jobs.js';

const router = Router();

// Trigger a scheduled job: POST /api/jobs/daily-sync or /api/jobs/snapshot.
// The launchd agents call this with curl (no Origin header, Host 127.0.0.1, so
// the local-origin guard lets it through). Idempotent per local day — a repeat
// returns status "skipped"; ?force=1 runs it again. Responds when the job ends.
router.post('/:name', async (req: Request, res: Response) => {
  const name = req.params.name as JobName;
  if (!JOB_NAMES.includes(name)) return res.status(404).json({ error: 'unknown job' });
  try {
    res.json(await runJob(name, { force: req.query.force === '1' }));
  } catch (err) {
    console.error(`[job] ${name} failed:`, err);
    res.status(500).json({ error: `${name} failed` });
  }
});

export default router;
