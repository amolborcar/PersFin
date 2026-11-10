import type Database from 'better-sqlite3';

// The durable transaction store. Provider payloads (Plaid) are
// cached for ~a day and cover a rolling 2-year window; before this table
// existed, budget history silently aged out of that window. Every read of the
// feed now syncs the cached payload into `transactions` (append/refresh within
// the provider window, never touching older rows), and consumers read from the
// table — so history accumulates for as long as the app runs.
//
// Categorization stays read-time in the budget service: it is holistic
// (transfer-pair detection, feed↔import dedup, tracked-card logic all operate
// over the whole ledger at once), so rows here are the raw normalized feed.
//
// Everything takes the db handle explicitly so the migration runner can use
// this module without an import cycle (schema → migrations → here).

type Db = Database.Database;

// Rows from the removed SimpleFIN provider are deleted by migration 7, so
// Plaid is the only source that remains.
export type FeedSource = 'plaid';

// The provider transaction window (the provider fetches this much history).
// Reconciliation below is scoped to it: inside the window the payload is
// authoritative (pending reversals disappear), outside it rows are permanent.
export const FEED_WINDOW_DAYS = 730;

export interface RawTxn {
  id: string; posted: number; transactedAt: number | null; amount: number; description: string; payee: string; memo: string;
  accountId: string; accountName: string;
}

/**
 * Sync one source's current payload into the transactions table:
 *  - upsert every row (provider-amended fields refresh in place);
 *  - inside the provider window, delete rows for accounts PRESENT in the
 *    payload that the payload no longer contains (reversed pending charges) —
 *    the payload is authoritative there;
 *  - rows older than the window, or for accounts absent from this payload,
 *    are never touched. That asymmetry is the whole point of the table.
 */
export function syncFeedTransactions(db: Db, source: FeedSource, txns: RawTxn[], sinceUnix: number): void {
  const upsert = db.prepare(`
    INSERT INTO transactions (id, account_id, account_name, source, posted, transacted_at, amount, payee, description, memo)
    VALUES (@id, @accountId, @accountName, @source, @posted, @transactedAt, @amount, @payee, @description, @memo)
    ON CONFLICT(id) DO UPDATE SET
      account_id    = excluded.account_id,
      account_name  = excluded.account_name,
      posted        = excluded.posted,
      transacted_at = excluded.transacted_at,
      amount        = excluded.amount,
      payee         = excluded.payee,
      description   = excluded.description,
      memo          = excluded.memo,
      updated_at    = datetime('now')
  `);
  const inWindowIds = db.prepare(
    `SELECT id FROM transactions WHERE source = ? AND account_id = ? AND posted >= ?`
  );
  const del = db.prepare('DELETE FROM transactions WHERE id = ?');

  db.transaction(() => {
    const payloadIds = new Set(txns.map(t => t.id));
    const accountIds = new Set(txns.map(t => t.accountId));
    for (const t of txns) upsert.run({ ...t, source });
    for (const acct of accountIds) {
      for (const row of inWindowIds.all(source, acct, sinceUnix) as { id: string }[]) {
        if (!payloadIds.has(row.id)) del.run(row.id);
      }
    }
  })();
}

/**
 * The full durable feed, in insertion order (rowid). Downstream consumers that
 * care about ordering sort explicitly.
 */
export function readFeedTransactions(db: Db): RawTxn[] {
  const rows = db.prepare(`
    SELECT id, account_id, account_name, posted, transacted_at, amount, payee, description, memo
    FROM transactions ORDER BY rowid
  `).all() as {
    id: string; account_id: string; account_name: string; posted: number;
    transacted_at: number | null; amount: number; payee: string; description: string; memo: string;
  }[];
  return rows.map(r => ({
    id: r.id, posted: r.posted, transactedAt: r.transacted_at, amount: r.amount,
    description: r.description, payee: r.payee, memo: r.memo,
    accountId: r.account_id, accountName: r.account_name,
  }));
}
