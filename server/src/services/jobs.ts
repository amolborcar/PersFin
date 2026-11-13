import { getMeta, setMeta } from './meta.js';
import { refreshAccountsAndSnapshot, takeSnapshot } from './netWorth.js';
import { catchUpHistory } from './historyCatchUp.js';
import { isDailySnapshotEnabled } from './data.js';
import { categorizeWithAi, getAiSettings } from './aiCategorize.js';
import { runWeeklyDelivery } from './delivery.js';
import { dueWeek } from '../util/weekWindow.js';

// Scheduled jobs, run by whichever scheduler is active: macOS launchd (the
// always-on desktop setup — each job is a launchd agent that POSTs
// /api/jobs/<name>) or the in-process node-cron (dev). Both go through
// runJob, which makes every job idempotent per period — a local calendar day,
// or for weekly-report the report week — so a second trigger in the same
// period (a duplicate scheduler, or launchd re-running a job it missed while
// the Mac slept) does nothing. `force` re-runs it anyway.

export type JobName = 'daily-sync' | 'snapshot' | 'weekly-report';
export const JOB_NAMES: JobName[] = ['daily-sync', 'snapshot', 'weekly-report'];
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

// The period key of each job: the local day, except where `periods` says otherwise.
type PeriodFn = (d: Date) => string;

export function makeJobRunner(
  jobs: Record<JobName, JobFn>,
  store: { get: (key: string) => string | null; set: (key: string, value: string) => void },
  now: () => Date = () => new Date(),
  periods: Partial<Record<JobName, PeriodFn>> = {},
) {
  const running = new Set<JobName>();
  return async function runJob(job: JobName, opts: { force?: boolean } = {}): Promise<JobResult> {
    const key = (periods[job] ?? localDateKey)(now());
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
      // Send the weekly report on any channel that missed it (retries a failed send).
      await runWeeklyDelivery().catch(err => console.error('[job] weekly delivery catch-up failed:', err));
    },
    // Records current DB state so net-worth history stays continuous even on
    // days when no account refresh runs. The toggle lives in the DB (Setup).
    'snapshot': () => {
      if (!isDailySnapshotEnabled()) return false;
      console.log('[job] snapshot: recording today\'s net worth...');
      takeSnapshot();
    },
    // Sunday evening: build the week's report and send it on each channel that
    // is on (services/delivery.ts). A failed channel throws, so the week is not
    // marked done; the daily sync retries it too.
    'weekly-report': async () => {
      console.log('[job] weekly-report: building and sending...');
      const run = await runWeeklyDelivery({ build: true });
      const failed = run.results.filter(r => r.status === 'error');
      if (failed.length) throw new Error(failed.map(f => `${f.channel}: ${f.error}`).join('; '));
    },
  },
  { get: getMeta, set: setMeta },
  () => new Date(),
  { 'weekly-report': d => dueWeek(d).key },
);
