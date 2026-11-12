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

// Migration 8 removes real-estate tracking and keeps each day's accounts history exact.
describe('migration 8 (remove-real-estate)', () => {
  it('drops property tables and derived records, and sets net worth to the accounts total', () => {
    const db = new Database(':memory:');
    for (const m of MIGRATIONS.filter(m => m.version <= 7)) m.up(db);

    db.prepare(`INSERT INTO properties (id, address, zestimate, mortgage_balance) VALUES (1, '1 Elm St', 500000, 300000)`).run();
    db.prepare(`INSERT INTO property_value_history (property_id, date, value) VALUES (1, '2026-01-01', 490000)`).run();
    const snap = db.prepare(`INSERT INTO net_worth_snapshots (date, accounts_total, real_estate_total, net_worth) VALUES (?, ?, ?, ?)`);
    snap.run('2026-01-01', 100000, 190000, 290000);
    snap.run('2026-01-02', 101000, 200000, 301000);
    const obs = db.prepare(`INSERT INTO balance_observations (account_id, date, balance) VALUES (?, '2026-01-01', 1)`);
    obs.run('property:1');
    obs.run('acct-1');
    obs.run('manual:3');
    const meta = db.prepare(`INSERT INTO meta (key, value) VALUES (?, 'x')`);
    meta.run('zhvi_97477');
    meta.run('last_real_estate_refresh');
    meta.run('backfill_version');

    MIGRATIONS.find(m => m.version === 8)!.up(db);

    const tables = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[]).map(t => t.name);
    expect(tables).not.toContain('properties');
    expect(tables).not.toContain('property_value_history');
    const cols = (db.prepare(`SELECT name FROM pragma_table_info('net_worth_snapshots')`).all() as { name: string }[]).map(c => c.name);
    expect(cols).toEqual(['id', 'date', 'accounts_total', 'net_worth']);
    expect(db.prepare(`SELECT date, accounts_total, net_worth FROM net_worth_snapshots ORDER BY date`).all()).toEqual([
      { date: '2026-01-01', accounts_total: 100000, net_worth: 100000 },
      { date: '2026-01-02', accounts_total: 101000, net_worth: 101000 },
    ]);
    const obsIds = (db.prepare(`SELECT account_id FROM balance_observations ORDER BY account_id`).all() as { account_id: string }[]).map(r => r.account_id);
    expect(obsIds).toEqual(['acct-1', 'manual:3']);
    const metaKeys = (db.prepare(`SELECT key FROM meta`).all() as { key: string }[]).map(r => r.key);
    expect(metaKeys).toContain('backfill_version');
    expect(metaKeys).not.toContain('zhvi_97477');
    expect(metaKeys).not.toContain('last_real_estate_refresh');
  });
});
