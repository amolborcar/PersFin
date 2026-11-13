import { getMeta, setMeta } from './meta.js';
import { refreshAccountsAndSnapshot, takeSnapshot } from './netWorth.js';
import { catchUpHistory } from './historyCatchUp.js';
import { isDailySnapshotEnabled } from './data.js';
import { categorizeWithAi, getAiSettings } from './aiCategorize.js';

// Scheduled jobs, run by whichever scheduler is active: macOS launchd (the
// always-on desktop setup — each job is a launchd agent that POSTs
// /api/jobs/<name>) or the in-process node-cron (dev). Both go through
// runJob, which makes every job idempotent per local calendar day: a second
// trigger on the same day (a duplicate scheduler, or launchd re-running a job
// it missed while the Mac slept) does nothing. `force` re-runs it anyway.

export type JobName = 'daily-sync' | 'snapshot';
export const JOB_NAMES: JobName[] = ['daily-sync', 'snapshot'];
export type JobStatus = 'ran' | 'skipped' | 'running' | 'disabled';
export interface JobResult { job: JobName; key: string; status: JobStatus }

// A job body. Returning false means "not enabled": nothing ran, and the day is
// not marked done, so a later trigger can still run it once it is enabled.
type JobFn = () => Promise<boolean | void> | boolean | void;

// YYYY-MM-DD in the machine's local time zone — the day a job belongs to.
export function localDateKey(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function makeJobRunner(
  jobs: Record<JobName, JobFn>,
  store: { get: (key: string) => string | null; set: (key: string, value: string) => void },
  now: () => Date = () => new Date(),
) {
  const running = new Set<JobName>();
  return async function runJob(job: JobName, opts: { force?: boolean } = {}): Promise<JobResult> {
    const key = localDateKey(now());
    if (running.has(job)) return { job, key, status: 'running' };
    const stamp = `job_last_run:${job}`;
    if (!opts.force && store.get(stamp) === key) return { job, key, status: 'skipped' };
    running.add(job);
    try {
      const out = await jobs[job]();
      if (out === false) return { job, key, status: 'disabled' };
      store.set(stamp, key);
      return { job, key, status: 'ran' };
    } finally {
      running.delete(job);
    }
  };
}

export const runJob = makeJobRunner(
  {
    // Accounts (Plaid), then snapshot, then repair history (an always-on server
    // may go months without a restart, and this is the hook that notices a gap
    // left by downtime or a version stamp left by an upgrade), then AI
    // category suggestions for new uncategorized merchants.
    'daily-sync': async () => {
      console.log('[job] daily-sync: refreshing accounts...');
      await refreshAccountsAndSnapshot();
      await catchUpHistory().catch(err => console.error('[job] history catch-up failed:', err));
      // Suggest categories for new uncategorized merchants (Setup in Quick review).
      if (getAiSettings().daily) await categorizeWithAi().catch(err => console.error('[job] AI categorize failed:', err));
    },
    // Records current DB state so net-worth history stays continuous even on
    // days when no account refresh runs. The toggle lives in the DB (Setup).
    'snapshot': () => {
      if (!isDailySnapshotEnabled()) return false;
      console.log('[job] snapshot: recording today\'s net worth...');
      takeSnapshot();
    },
  },
  { get: getMeta, set: setMeta },
);
