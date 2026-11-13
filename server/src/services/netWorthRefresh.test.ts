import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';

// A refresh where one provider fails must still snapshot what synced, then raise an
// error whose message names the failed sources and is safe to put in a response body.
let dir: string;
let closeDb: () => void;
let db: Database.Database;

const plaid = vi.fn<() => Promise<void>>();
vi.mock('./plaid.js', () => ({ refreshAllPlaid: () => plaid() }));

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'persfin-refresh-'));
  process.env.DB_PATH = join(dir, 'test.db');
  vi.resetModules();
  plaid.mockResolvedValue(undefined);
  const schema = await import('../db/schema.js');
  ({ closeDb } = schema);
  db = schema.getDb();
}, 60_000);

afterEach(() => { closeDb(); rmSync(dir, { recursive: true, force: true }); });

describe('refreshAndSnapshot', () => {
  it('snapshots, then names the failed institution and its reason', async () => {
    // Imported after vi.resetModules so it's the same class netWorth.js sees (instanceof).
    const { ProviderRefreshError } = await import('./refreshErrors.js');
    plaid.mockRejectedValue(new ProviderRefreshError('Plaid', 3, [{ label: 'Chase', reason: 'ITEM_LOGIN_REQUIRED' }]));
    const { refreshAndSnapshot, RefreshFailedError } = await import('./netWorth.js');

    const err = await refreshAndSnapshot().then(() => null, e => e);
    expect(err).toBeInstanceOf(RefreshFailedError);
    expect(err.message).toBe("Couldn't refresh Chase (Plaid: ITEM_LOGIN_REQUIRED) — everything else synced.");
    expect(err.sources).toEqual(['Plaid']);
    // the snapshot still happened despite the failure
    expect((db.prepare('SELECT COUNT(*) AS n FROM net_worth_snapshots').get() as { n: number }).n).toBe(1);
  });

  it('reduces an unexpected error to the source name, never the raw error text', async () => {
    plaid.mockRejectedValue(new Error('GET https://api.example.com?secret=SECRET-123 failed'));
    const { refreshAndSnapshot } = await import('./netWorth.js');

    const err = await refreshAndSnapshot().then(() => null, e => e);
    expect(err.message).toBe("Couldn't refresh Plaid — everything else synced.");
    expect(err.message).not.toContain('SECRET');
  });

  it('resolves quietly when every source succeeds', async () => {
    const { refreshAndSnapshot } = await import('./netWorth.js');
    await expect(refreshAndSnapshot()).resolves.toBeUndefined();
  });
});

describe('describeRefreshFailures', () => {
  it('lists each failed item with its provider and reason, and falls back to the source name', async () => {
    const { describeRefreshFailures } = await import('./netWorth.js');
    const { ProviderRefreshError } = await import('./refreshErrors.js');
    const m = new Map<string, unknown>([
      ['Plaid', new ProviderRefreshError('Plaid', 1, [{ label: 'Schwab', reason: 'HTTP 403' }])],
      ['history', 'not a provider error'],
    ]);
    expect(describeRefreshFailures(m)).toBe("Couldn't refresh Schwab (Plaid: HTTP 403), history — everything else synced.");
  });

  it('caps the list at three and counts the rest', async () => {
    const { describeRefreshFailures } = await import('./netWorth.js');
    const { ProviderRefreshError } = await import('./refreshErrors.js');
    const failures = ['A', 'B', 'C', 'D', 'E'].map(label => ({ label, reason: 'ITEM_LOGIN_REQUIRED' }));
    const m = new Map<string, unknown>([['Plaid', new ProviderRefreshError('Plaid', 5, failures)]]);
    expect(describeRefreshFailures(m)).toBe(
      "Couldn't refresh A (Plaid: ITEM_LOGIN_REQUIRED), B (Plaid: ITEM_LOGIN_REQUIRED), C (Plaid: ITEM_LOGIN_REQUIRED), +2 more — everything else synced.");
  });
});
