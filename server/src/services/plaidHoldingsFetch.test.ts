import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The live holdings path: which items are asked, what is cached, and how a
// refusal (no investment consent) is handled — with a fake Plaid client.
const TMP = mkdtempSync(join(tmpdir(), 'kevfin-holdings-'));
process.env.DB_PATH = join(TMP, 'holdings.db');
process.env.PLAID_CLIENT_ID = 'cid';
process.env.PLAID_SECRET = 'secret';

const holdingsCalls: string[] = [];
vi.mock('plaid', async importOriginal => {
  const real = await importOriginal<typeof import('plaid')>();
  class FakePlaid {
    investmentsHoldingsGet = vi.fn(async (req: { access_token: string }) => {
      holdingsCalls.push(req.access_token);
      if (req.access_token === 'tok-refuses') {
        throw Object.assign(new Error('400'), { response: { status: 400, data: { error_code: 'ADDITIONAL_CONSENT_REQUIRED' } } });
      }
      return { data: {
        holdings: [{ account_id: 'brk-1', security_id: 's1', institution_value: 900, cost_basis: 700, quantity: 3 }],
        securities: [{ security_id: 's1', ticker_symbol: 'VTI', name: 'Vanguard Total Stock Market ETF', type: 'etf' }],
      } };
    });
  }
  return { ...real, PlaidApi: FakePlaid };
});

const { getDb, closeDb } = await import('../db/schema.js');
afterAll(() => { closeDb(); rmSync(TMP, { recursive: true, force: true }); });

describe('fetchHoldings (live path)', () => {
  it('asks only items with a brokerage account, caches the result, and survives a refusal', async () => {
    const db = getDb();
    const item = db.prepare('INSERT INTO plaid_items (item_id, access_token, institution_name) VALUES (?, ?, ?)');
    item.run('item-brk', 'tok-brk', 'Fidelity');
    item.run('item-bank', 'tok-bank', 'Chase');
    item.run('item-refuses', 'tok-refuses', 'Schwab');
    const acct = db.prepare(`INSERT INTO accounts (id, source, connection_id, plaid_item_id, org_name, name, balance, category)
                             VALUES (?, 'plaid', 0, ?, 'x', ?, 0, ?)`);
    acct.run('brk-1', 'item-brk', 'Brokerage', 'brokerage');
    acct.run('chk-1', 'item-bank', 'Checking', 'banking');
    acct.run('brk-2', 'item-refuses', 'IRA', 'brokerage');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { fetchHoldings } = await import('./plaid.js');

    const first = await fetchHoldings();
    expect(holdingsCalls.sort()).toEqual(['tok-brk', 'tok-refuses']); // never the bank-only item
    expect(first.get('brk-1')).toEqual([
      { symbol: 'VTI', description: 'Vanguard Total Stock Market ETF', marketValue: 900, costBasis: 700, shares: 3, acquired: null },
    ]);
    expect(first.has('brk-2')).toBe(false);
    const cached = db.prepare(`SELECT key FROM provider_cache WHERE key LIKE 'plaid_holdings_cache_%'`).all();
    expect(cached).toEqual([{ key: 'plaid_holdings_cache_item-brk' }]);

    // A second read within the cache period makes no live call, not even for
    // the item that refused.
    holdingsCalls.length = 0;
    const second = await fetchHoldings();
    expect(holdingsCalls).toEqual([]);
    expect(second.get('brk-1')).toEqual(first.get('brk-1'));
  });
});
