import type Database from 'better-sqlite3';
import type { RawTxn } from '../services/feedStore.js';
import type { Holding } from '../services/holdings.js';
import { recordRealObservation } from '../services/observations.js';
import { categorize, type Category } from '../util/categorize.js';

// Writes one Plaid item into a database exactly as a sync would leave it — the
// item row, its accounts, and the cached transaction + holdings payloads —
// without any network call. Used by the demo seeder (scripts/seed-demo.ts) and
// by DB-backed tests. With no Plaid keys set, the Plaid service serves these
// cached payloads as-is, so the budget and investment views read them like
// real data. Never point this at a real database.

export interface SeedTxn { id: string; posted: number; amount: number; description: string; payee: string }

export interface SeedAccount {
  id: string;
  org: string;              // institution name shown for the account
  name: string;
  balance: number;          // as stored: liabilities negative
  category?: Category;      // defaults to the name heuristic, as for an ambiguous Plaid type
  holdings?: Holding[];
  transactions?: SeedTxn[];
}

export function seedPlaidItem(
  db: Database.Database,
  itemId: string,
  accounts: SeedAccount[],
  fetchedAt: number = Date.now(),
): void {
  const institution = accounts[0]?.org ?? 'Demo Bank';
  db.prepare(`INSERT OR REPLACE INTO plaid_items (item_id, access_token, institution_name) VALUES (?, ?, ?)`)
    .run(itemId, `seed-token-${itemId}`, institution);

  const upsertAccount = db.prepare(`
    INSERT OR REPLACE INTO accounts (id, source, connection_id, plaid_item_id, org_name, name, currency, balance, category, updated_at)
    VALUES (@id, 'plaid', 0, @itemId, @org, @name, 'USD', @balance, @category, datetime('now'))
  `);
  const today = new Date(fetchedAt).toISOString().slice(0, 10);
  const txns: RawTxn[] = [];
  const holdings: Record<string, Holding[]> = {};
  for (const a of accounts) {
    upsertAccount.run({ id: a.id, itemId, org: a.org, name: a.name, balance: a.balance, category: a.category ?? categorize(a.name) });
    recordRealObservation(db, a.id, today, a.balance);
    for (const t of a.transactions ?? []) {
      txns.push({
        id: t.id, posted: t.posted, transactedAt: null, amount: t.amount,
        description: t.description, payee: t.payee, memo: '', accountId: a.id, accountName: a.name,
      });
    }
    if (a.holdings) holdings[a.id] = a.holdings;
  }

  const cache = db.prepare('INSERT OR REPLACE INTO provider_cache (key, fetched_at, payload) VALUES (?, ?, ?)');
  cache.run(`plaid_txn_cache_${itemId}`, fetchedAt, JSON.stringify(txns));
  cache.run(`plaid_holdings_cache_${itemId}`, fetchedAt, JSON.stringify(holdings));
}
