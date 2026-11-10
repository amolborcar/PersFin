import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations.js';

// Migration 7 removes every SimpleFIN record and leaves Plaid and manual data alone.
describe('migration 7 (remove-simplefin)', () => {
  it('deletes SimpleFIN connections, accounts, their transactions, history and caches', () => {
    const db = new Database(':memory:');
    for (const m of MIGRATIONS.filter(m => m.version <= 6)) m.up(db);

    db.prepare(`INSERT INTO simplefin_connections (id, access_url) VALUES (1, 'https://u:p@bridge.example.invalid/sf')`).run();
    const acct = db.prepare(`INSERT INTO accounts (id, source, connection_id, plaid_item_id, org_name, name, balance, category)
                             VALUES (?, ?, ?, ?, 'Bank', ?, 100, 'banking')`);
    acct.run('sf-1', 'simplefin', 1, null, 'SF Checking');
    acct.run('pl-1', 'plaid', 0, 'item-1', 'Plaid Checking');
    // A very old hybrid row: source defaulted to 'simplefin' but it belongs to a Plaid item.
    acct.run('pl-old', 'simplefin', 0, 'item-1', 'Old Plaid Savings');
    acct.run('man-1', 'manual', null, null, 'Imported Account');

    const txn = db.prepare(`INSERT INTO transactions (id, account_id, account_name, source, posted, amount) VALUES (?, ?, 'x', ?, 1, -5)`);
    txn.run('t-sf', 'sf-1', 'simplefin');
    txn.run('t-pl', 'pl-1', 'plaid');
    const obs = db.prepare(`INSERT INTO balance_observations (account_id, date, balance) VALUES (?, '2026-01-01', 1)`);
    obs.run('sf-1');
    obs.run('pl-1');
    const cache = db.prepare(`INSERT INTO provider_cache (key, fetched_at, payload) VALUES (?, 0, '[]')`);
    cache.run('sf_cache_1');
    cache.run('plaid_txn_cache_item-1');
    db.prepare(`INSERT INTO meta (key, value) VALUES ('sf_cache_9', '{}')`).run();

    MIGRATIONS.find(m => m.version === 7)!.up(db);

    const ids = (sql: string) => (db.prepare(sql).all() as { id: string }[]).map(r => r.id).sort();
    expect(ids(`SELECT id FROM accounts`)).toEqual(['man-1', 'pl-1', 'pl-old']);
    expect(ids(`SELECT id FROM transactions`)).toEqual(['t-pl']);
    expect(ids(`SELECT account_id AS id FROM balance_observations`)).toEqual(['pl-1']);
    expect(ids(`SELECT key AS id FROM provider_cache`)).toEqual(['plaid_txn_cache_item-1']);
    expect(ids(`SELECT key AS id FROM meta WHERE key LIKE 'sf_cache_%'`)).toEqual([]);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'simplefin_connections'`).get()).toBeUndefined();
  });

  it('runs cleanly on a fresh database', () => {
    const db = new Database(':memory:');
    expect(() => { for (const m of MIGRATIONS) m.up(db); }).not.toThrow();
  });
});
