import { describe, it, expect, vi } from 'vitest';
import { makeJobRunner, localDateKey } from './jobs.js';

// An in-memory stand-in for the meta table.
const memStore = () => {
  const m = new Map<string, string>();
  return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => { m.set(k, v); }, m };
};

describe('localDateKey', () => {
  it('formats the local calendar day as YYYY-MM-DD', () => {
    expect(localDateKey(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
    expect(localDateKey(new Date(2026, 11, 31, 0, 0))).toBe('2026-12-31');
  });
});

describe('makeJobRunner', () => {
  it('runs a job once per local day, then skips repeats', async () => {
    const sync = vi.fn();
    const store = memStore();
    let now = new Date(2026, 10, 13, 6, 0);
    const run = makeJobRunner({ 'daily-sync': sync, snapshot: vi.fn() }, store, () => now);

    expect(await run('daily-sync')).toEqual({ job: 'daily-sync', key: '2026-11-13', status: 'ran' });
    expect(await run('daily-sync')).toMatchObject({ status: 'skipped' });
    expect(sync).toHaveBeenCalledTimes(1);

    now = new Date(2026, 10, 14, 6, 0); // the next day runs again
    expect(await run('daily-sync')).toMatchObject({ key: '2026-11-14', status: 'ran' });
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('runs again on the same day when forced', async () => {
    const sync = vi.fn();
    const run = makeJobRunner({ 'daily-sync': sync, snapshot: vi.fn() }, memStore());
    await run('daily-sync');
    expect(await run('daily-sync', { force: true })).toMatchObject({ status: 'ran' });
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it('reports "running" for an overlapping trigger instead of starting a second run', async () => {
    let release!: () => void;
    const sync = vi.fn(() => new Promise<void>(r => { release = r; }));
    const run = makeJobRunner({ 'daily-sync': sync, snapshot: vi.fn() }, memStore());
    const first = run('daily-sync');
    expect(await run('daily-sync')).toMatchObject({ status: 'running' });
    release();
    expect(await first).toMatchObject({ status: 'ran' });
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it('does not mark the day done when the job is disabled', async () => {
    const store = memStore();
    let enabled = false;
    const snap = vi.fn(() => (enabled ? undefined : false));
    const run = makeJobRunner({ 'daily-sync': vi.fn(), snapshot: snap }, store);
    expect(await run('snapshot')).toMatchObject({ status: 'disabled' });
    enabled = true;
    expect(await run('snapshot')).toMatchObject({ status: 'ran' });
  });

  it('does not mark the day done when the job throws, so a retry can run', async () => {
    const store = memStore();
    let fail = true;
    const sync = vi.fn(async () => { if (fail) throw new Error('boom'); });
    const run = makeJobRunner({ 'daily-sync': sync, snapshot: vi.fn() }, store);
    await expect(run('daily-sync')).rejects.toThrow('boom');
    fail = false;
    expect(await run('daily-sync')).toMatchObject({ status: 'ran' });
  });
});
