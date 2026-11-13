import { getDb } from '../db/schema.js';
import { fetchPlaidTransactions, fetchHoldings } from './plaid.js';
import type { TxnDelta } from './holdings.js';
import { recordEstimatedObservation } from './observations.js';
import { fetchDailyCloses, effectiveChain, closeAsOf, type PricePoint } from './prices.js';

const DAYS_BACK = 1825; // ~5 years of daily snapshots (enables 3Y/5Y ranges)

interface AccountRow {
  id: string;
  balance: number;
  category: string;
}

/** Daily date strings for the last N days, oldest first (excludes today). */
function dailyDates(n: number): string[] {
  const out: string[] = [];
  const now = new Date();
  for (let i = n; i >= 1; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Build a forward-filled close for every date from a chain of price series
// (primary first). The primary is used wherever it has real data; for dates
// before its earliest point, the next series is spliced in — scaled to connect
// continuously at the boundary. Returns the filled map and the latest close.
function buildSplicedFilled(dates: string[], chain: PricePoint[][]): { at: Map<string, number>; latest: number } {
  const at = new Map<string, number>();
  const series = chain.filter(s => s.length > 0);
  if (series.length === 0) return { at, latest: 0 };

  // Cumulative scale so each older series connects to the spliced value at the
  // newer series' start date.
  const scale = new Array(series.length).fill(1);
  for (let k = 1; k < series.length; k++) {
    const boundary = series[k - 1][0].date;
    const newerVal = series[k - 1][0].close * scale[k - 1];
    const olderVal = closeAsOf(series[k], boundary) ?? series[k][0].close;
    scale[k] = olderVal ? newerVal / olderVal : scale[k - 1];
  }

  for (const d of dates) {
    // first (newest) series that has real data at/before this date
    let k = series.findIndex(s => s[0].date <= d);
    if (k === -1) k = series.length - 1; // older than everything → oldest, leading-filled
    const c = closeAsOf(series[k], d) ?? series[k][0].close;
    at.set(d, c * scale[k]);
  }

  const latest = at.get(dates[dates.length - 1]) ?? series[0][series[0].length - 1].close;
  return { at, latest };
}

// Reconstruct an account's balance as of `date` by removing transactions after it.
function balanceAsOf(current: number, txns: TxnDelta[], date: string): number {
  let bal = current;
  for (const t of txns) {
    if (t.date > date) bal -= t.delta;
  }
  return bal;
}

/**
 * Backfill monthly net-worth snapshots from all sources.
 * - cash/banking/credit/other accounts: reconstructed from transactions (accurate)
 * - brokerage accounts: each holding scaled by its ticker's historical price;
 *   cash and non-tickered holdings (529s, crypto) held flat
 * - manual assets: held at current value
 * Returns the number of historical snapshots written.
 *
 * `onlyMissing` fills gaps without touching dates that already have a snapshot.
 * Reconstruction assumes today's holdings were held throughout, so it is a
 * weaker record than a genuinely-observed snapshot — the automatic gap-filling
 * path uses this mode so it can only ever add history, never rewrite it. The
 * explicit "Backfill" button (and a correctness repair) still rebuilds
 * everything.
 */
export async function backfillHistory(opts: { onlyMissing?: boolean } = {}): Promise<number> {
  const db = getDb();
  // `dates` must stay the FULL window even when only gaps are being written:
  // holdings are normalised against the price on the newest date in this list
  // (today's market value ÷ today's close), so narrowing it to a 2023 gap would
  // rebase every position onto 2023 prices.
  const dates = dailyDates(DAYS_BACK);
  const earliest = dates[0];
  const existing = new Set(
    (db.prepare('SELECT date FROM net_worth_snapshots').all() as { date: string }[]).map(r => r.date),
  );
  const writeDates = opts.onlyMissing ? dates.filter(d => !existing.has(d)) : dates;
  if (writeDates.length === 0) {
    console.log('[backfill] history already complete — nothing to write');
    return 0;
  }
  const accounts = db.prepare('SELECT id, balance, category FROM accounts WHERE hidden = 0').all() as AccountRow[];
  const { manual_total } = db
    .prepare('SELECT COALESCE(SUM(value),0) AS manual_total FROM manual_assets')
    .get() as { manual_total: number };

  const today = new Date().toISOString().slice(0, 10);

  // Gather transactions and holdings.
  const [txnsByAccount, holdingsByAccount] = await Promise.all([
    fetchPlaidTransactions(earliest, today),
    fetchHoldings(),
  ]);

  // Fetch a daily price series for every distinct ticker, then forward-fill it
  // across our snapshot dates for O(1) lookups.
  // Effective ticker chain = substituted proxy / real symbol / description proxy
  // (e.g. untickered target-date 529 → ['ITDD','AOA']; PDZJ 401k → ['VFFVX']).
  const effChain = (h: { symbol: string; description: string }): string[] =>
    effectiveChain(h.symbol, h.description);

  // Fetch a daily series for every distinct ticker across all chains.
  const tickers = new Set<string>();
  for (const a of accounts) {
    if (a.category !== 'brokerage') continue;
    for (const h of holdingsByAccount.get(a.id) ?? []) effChain(h).forEach(t => tickers.add(t));
  }
  const rawSeries = new Map<string, PricePoint[]>();
  await Promise.all(
    [...tickers].map(async sym => rawSeries.set(sym, await fetchDailyCloses(sym, earliest, today)))
  );

  // Build one spliced, forward-filled price map per distinct chain.
  const filledByChain = new Map<string, { at: Map<string, number>; latest: number }>();
  const chainKey = (chain: string[]) => chain.join('|');
  function getFilled(chain: string[]) {
    if (chain.length === 0) return null;
    const key = chainKey(chain);
    if (!filledByChain.has(key)) {
      const spliced = buildSplicedFilled(dates, chain.map(s => rawSeries.get(s) ?? []));
      filledByChain.set(key, spliced);
    }
    const f = filledByChain.get(key)!;
    return f.latest > 0 ? f : null;
  }

  // Per brokerage account: value(date) = cash (flat) + Σ holding scaled by its
  // chain's price movement. Holdings with no priceable chain stay flat.
  const brokerageValueAsOf = new Map<string, (date: string) => number>();
  for (const a of accounts) {
    if (a.category !== 'brokerage') continue;
    const holdings = holdingsByAccount.get(a.id) ?? [];
    const holdingsTotal = holdings.reduce((s, h) => s + h.marketValue, 0);
    const cashFlat = a.balance - holdingsTotal; // non-holding cash in the account
    brokerageValueAsOf.set(a.id, (date: string) => {
      let total = cashFlat;
      for (const h of holdings) {
        const fp = getFilled(effChain(h));
        const at = fp?.at.get(date);
        total += fp && at ? h.marketValue * (at / fp.latest) : h.marketValue;
      }
      return total;
    });
  }

  const upsert = db.prepare(`
    INSERT INTO net_worth_snapshots (date, accounts_total, net_worth)
    VALUES (?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      accounts_total = excluded.accounts_total,
      net_worth = excluded.net_worth
  `);

  const writeAll = db.transaction((days: string[]) => {
    for (const date of days) {
      let accountsTotal = manual_total; // manual assets held flat
      for (const a of accounts) {
        const value = a.category === 'brokerage'
          ? (brokerageValueAsOf.get(a.id)?.(date) ?? a.balance)
          : balanceAsOf(a.balance, txnsByAccount.get(a.id) ?? [], date);
        accountsTotal += value;
        // Estimated per-account history; a real observation for the same day
        // (recorded by a sync/snapshot) always wins and is never overwritten.
        recordEstimatedObservation(db, a.id, date, value);
      }

      upsert.run(date, accountsTotal, accountsTotal);
    }
  });
  writeAll(writeDates);

  console.log(
    opts.onlyMissing
      ? `[backfill] filled ${writeDates.length} missing daily snapshots (${writeDates[0]} … ${writeDates[writeDates.length - 1]})`
      : `[backfill] wrote ${writeDates.length} daily snapshots back to ${earliest}`,
  );
  return writeDates.length;
}
