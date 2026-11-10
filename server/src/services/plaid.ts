import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  Products,
  CountryCode,
  type AccountBase,
  type Transaction,
  type Holding as PlaidHolding,
  type Security,
} from 'plaid';
import { getDb } from '../db/schema.js';
import { readProviderCache, writeProviderCache, deleteProviderCache } from '../db/providerCache.js';
import { categorize, type Category } from '../util/categorize.js';
import { FEED_WINDOW_DAYS, type RawTxn } from './feedStore.js';
import type { Holding, TxnDelta } from './holdings.js';
import { recordRealObservation } from './observations.js';
import { ProviderRefreshError, safePlaidReason, safeLabel, type ItemFailure } from './refreshErrors.js';

// Built lazily from the current env so credentials edited at runtime (via the
// Setup → API keys panel, which calls resetPlaidClient) take effect without a
// server restart. resolvePlaidEnv falls back to sandbox for an unknown value.
let cachedClient: PlaidApi | null = null;

function resolvePlaidEnv(): keyof typeof PlaidEnvironments {
  const env = process.env.PLAID_ENV ?? 'sandbox';
  return (env in PlaidEnvironments ? env : 'sandbox') as keyof typeof PlaidEnvironments;
}

export function getPlaidClient(): PlaidApi {
  if (!cachedClient) {
    cachedClient = new PlaidApi(new Configuration({
      basePath: PlaidEnvironments[resolvePlaidEnv()],
      baseOptions: {
        headers: {
          'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID ?? '',
          'PLAID-SECRET': process.env.PLAID_SECRET ?? '',
        },
      },
    }));
  }
  return cachedClient;
}

// Drop the cached client so the next call rebuilds it from the latest env.
export function resetPlaidClient(): void { cachedClient = null; }

// What's safe to log for a failed Plaid call. An AxiosError carries the whole
// request in err.config (PLAID-SECRET header, access_token in the body), so never
// log the error object itself — only Plaid's own error payload, or the message.
export function plaidErrorDetail(err: unknown): unknown {
  const e = err as { response?: { data?: unknown }; message?: string } | null;
  return e?.response?.data ?? e?.message ?? 'unknown error';
}

export function plaidConfigured(): boolean {
  return Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET);
}

export async function createLinkToken(userId: string): Promise<string> {
  const res = await getPlaidClient().linkTokenCreate({
    user: { client_user_id: userId },
    client_name: 'KevFin',
    // Transactions is required for every institution. Investments (holdings for
    // the Investments page and the brokerage backfill) is requested only where
    // the institution supports it, so a bank or card without it isn't blocked.
    products: [Products.Transactions],
    required_if_supported_products: [Products.Investments],
    country_codes: [CountryCode.Us],
    language: 'en',
  });
  return res.data.link_token;
}

export async function exchangePublicToken(publicToken: string, institutionName: string): Promise<void> {
  const exchange = await getPlaidClient().itemPublicTokenExchange({ public_token: publicToken });
  const { access_token, item_id } = exchange.data;

  getDb()
    .prepare(`INSERT OR REPLACE INTO plaid_items (item_id, access_token, institution_name) VALUES (?, ?, ?)`)
    .run(item_id, access_token, institutionName);

  await refreshItem(item_id, access_token, institutionName);
  await replaceOlderItems(item_id, institutionName);
}

// Re-linking an institution through Plaid creates a brand-new item with new
// account ids; the old item keeps syncing alongside it, so every account at that
// institution would be counted twice. Treat a re-link as a replacement: carry
// the user's renames / categories / hidden flags over to the matching new
// accounts (by name), then drop the old item here and at Plaid (which bills per
// item).
async function replaceOlderItems(newItemId: string, institutionName: string): Promise<void> {
  const db = getDb();
  const older = db
    .prepare('SELECT item_id, access_token FROM plaid_items WHERE institution_name = ? AND item_id != ?')
    .all(institutionName, newItemId) as { item_id: string; access_token: string }[];
  if (older.length === 0) return;

  type Row = { id: string; name: string; custom_name: string | null; category: string; hidden: number };
  const accountsOf = (itemId: string) =>
    db.prepare('SELECT id, name, custom_name, category, hidden FROM accounts WHERE plaid_item_id = ?').all(itemId) as Row[];
  const fresh = accountsOf(newItemId);
  const carry = db.prepare('UPDATE accounts SET custom_name = ?, category = ?, hidden = ? WHERE id = ?');

  for (const item of older) {
    db.transaction(() => {
      for (const old of accountsOf(item.item_id)) {
        // Only carry settings when the name match is unambiguous.
        const matches = fresh.filter(f => f.name === old.name);
        if (matches.length === 1) carry.run(old.custom_name, old.category, old.hidden, matches[0].id);
      }
      db.prepare('DELETE FROM accounts WHERE plaid_item_id = ?').run(item.item_id);
      db.prepare('DELETE FROM plaid_items WHERE item_id = ?').run(item.item_id);
    })();
    await removeItemAtPlaid(item.access_token);
  }
  console.log(`[plaid] re-link of ${institutionName} replaced ${older.length} older connection(s)`);
}

// Best effort: tell Plaid to stop serving (and billing) an item we've dropped.
export async function removeItemAtPlaid(accessToken: string): Promise<void> {
  await getPlaidClient().itemRemove({ access_token: accessToken }).catch(err =>
    console.error('[plaid] item remove failed (already gone at Plaid?):', plaidErrorDetail(err)));
}

// Plaid reports each account's type, which is far more reliable than guessing
// from the name (Frec's direct-indexing accounts are named e.g. "S&P 500®").
// Fall back to the name heuristic for anything Plaid leaves ambiguous.
function plaidCategory(acct: AccountBase): Category {
  switch (acct.type) {
    case 'investment':
    case 'brokerage':
      return 'brokerage';
    case 'depository':
      return 'banking';
    case 'credit':
    case 'loan':
      return 'credit';
    default:
      return categorize(acct.name);
  }
}

export async function refreshItem(itemId: string, accessToken: string, institutionName: string): Promise<void> {
  const res = await getPlaidClient().accountsBalanceGet({ access_token: accessToken });

  const db = getDb();
  // category is set on first insert; refreshes preserve user overrides.
  const upsert = db.prepare(`
    INSERT INTO accounts (id, source, connection_id, plaid_item_id, org_name, name, currency, balance, category, updated_at)
    VALUES (@id, 'plaid', 0, @plaid_item_id, @org_name, @name, @currency, @balance, @category, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      org_name   = excluded.org_name,
      name       = excluded.name,
      currency   = excluded.currency,
      balance    = excluded.balance,
      -- 'other' is the old name-guess default, so let Plaid's type upgrade it;
      -- any other category may be a user override and is kept.
      category   = CASE WHEN accounts.category = 'other' THEN excluded.category ELSE accounts.category END,
      updated_at = datetime('now')
  `);

  for (const acct of res.data.accounts as AccountBase[]) {
    // Credit/loan balances are liabilities: store as negative so net worth subtracts them.
    const raw = acct.balances.current ?? 0;
    const balance = acct.type === 'credit' || acct.type === 'loan' ? -Math.abs(raw) : raw;
    upsert.run({
      id: acct.account_id,
      plaid_item_id: itemId,
      org_name: institutionName,
      name: acct.name,
      currency: acct.balances.iso_currency_code ?? 'USD',
      balance,
      category: plaidCategory(acct),
    });
    // Plaid reports the current balance (no as-of date), so observe it today.
    recordRealObservation(db, acct.account_id, new Date().toISOString().slice(0, 10), balance);
  }

  // Pull (and cache) this item's transaction feed and investment holdings too.
  // Forced because this IS the refresh path (daily sync / manual "Sync now" /
  // initial link). Independent calls, so they run in parallel.
  const hasBrokerage = (res.data.accounts as AccountBase[]).some(a => plaidCategory(a) === 'brokerage');
  await Promise.all([
    getItemTransactions(itemId, accessToken, true).catch(err =>
      console.error(`[plaid] transaction refresh failed for item ${itemId}:`, plaidErrorDetail(err))),
    hasBrokerage ? getItemHoldings(itemId, accessToken, true) : Promise.resolve(),
  ]);
}

// --- Cached provider feeds -------------------------------------------------
// The full transaction list and the investment holdings per item are fetched at
// most once per ~24h and cached in memory + the DB (survives restarts), so the
// Budget and Investments pages can read them cheaply on every load instead of
// re-hitting Plaid. Without Plaid keys (keys removed, demo DB, tests) the
// cached copies are served as-is and no live call is attempted.
const TXN_CACHE_MS = 23 * 60 * 60 * 1000; // ~once per day
const TXN_WINDOW_DAYS = FEED_WINDOW_DAYS; // 2y of transactions
const txnMemCache = new Map<string, { fetchedAt: number; txns: RawTxn[] }>();
const holdingsMemCache = new Map<string, { fetchedAt: number; byAccount: Record<string, Holding[]> }>();

// Drop the in-memory caches — used by the "erase all data" reset so a wiped DB
// isn't silently repopulated from a stale in-process copy.
export function clearPlaidCaches(): void {
  txnMemCache.clear();
  holdingsMemCache.clear();
}

// Forget one item's cached feeds (memory + DB) when it's disconnected: the raw
// payloads are user data and shouldn't linger after the link is gone.
export function dropPlaidItemCache(itemId: string): void {
  txnMemCache.delete(itemId);
  holdingsMemCache.delete(itemId);
  deleteProviderCache(`plaid_txn_cache_${itemId}`);
  deleteProviderCache(`plaid_holdings_cache_${itemId}`);
}

function readTxnDbCache(itemId: string): { fetchedAt: number; txns: RawTxn[] } | null {
  const entry = readProviderCache<RawTxn[]>(`plaid_txn_cache_${itemId}`);
  return entry ? { fetchedAt: entry.fetchedAt, txns: entry.payload } : null;
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const toUnix = (date: string | null): number | null =>
  date ? Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000) : null;

// Map a Plaid transaction into KevFin's RawTxn shape. Plaid amounts are positive
// when money LEAVES the account; the budget uses the opposite convention
// (+ = money in), so flip the sign here.
function toRawTxn(t: Transaction, names: Map<string, string>): RawTxn {
  return {
    id: t.transaction_id,
    posted: toUnix(t.date) ?? 0,
    transactedAt: toUnix(t.authorized_date ?? null),
    amount: -(t.amount ?? 0),
    description: t.name ?? '',
    payee: t.merchant_name ?? '',
    memo: '',
    accountId: t.account_id,
    accountName: names.get(t.account_id) ?? '',
  };
}

// Live, paginated transaction pull for one item over the budgeting window.
async function fetchItemTransactionsLive(accessToken: string): Promise<RawTxn[]> {
  const endDate = ymd(new Date());
  const startDate = ymd(new Date(Date.now() - TXN_WINDOW_DAYS * 86400 * 1000));
  const names = new Map<string, string>();
  const out: RawTxn[] = [];
  let offset = 0;
  for (;;) {
    const res = await getPlaidClient().transactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: { count: 500, offset },
    });
    for (const a of res.data.accounts) names.set(a.account_id, a.name);
    for (const t of res.data.transactions) {
      // Skip pending rows: Plaid later replaces each with a posted row carrying a
      // new transaction_id, so counting both would double-count the same charge.
      if (t.pending) continue;
      out.push(toRawTxn(t, names));
    }
    offset += res.data.transactions.length;
    if (offset >= res.data.total_transactions || res.data.transactions.length === 0) break;
  }
  return out;
}

/** Cached transaction feed for one item — re-fetched at most once per TXN_CACHE_MS. */
async function getItemTransactions(itemId: string, accessToken: string, force = false): Promise<RawTxn[]> {
  const now = Date.now();

  const mem = txnMemCache.get(itemId);
  if (!plaidConfigured()) return mem?.txns ?? readTxnDbCache(itemId)?.txns ?? [];
  if (!force && mem && now - mem.fetchedAt < TXN_CACHE_MS) return mem.txns;

  if (!force) {
    const db = readTxnDbCache(itemId);
    if (db && now - db.fetchedAt < TXN_CACHE_MS) { txnMemCache.set(itemId, db); return db.txns; }
  }

  try {
    const txns = await fetchItemTransactionsLive(accessToken);
    const entry = { fetchedAt: now, txns };
    txnMemCache.set(itemId, entry);
    writeProviderCache(`plaid_txn_cache_${itemId}`, { fetchedAt: now, payload: txns });
    console.log(`[plaid] fetched item ${itemId} (${txns.length} transactions) — cached for ~24h`);
    return txns;
  } catch (err) {
    console.error(`[plaid] transaction fetch failed for item ${itemId}:`, plaidErrorDetail(err));
    return mem?.txns ?? readTxnDbCache(itemId)?.txns ?? []; // fall back to stale
  }
}

const allItems = () =>
  getDb().prepare('SELECT item_id, access_token FROM plaid_items').all() as { item_id: string; access_token: string }[];

/** All Plaid transactions across items (from the daily cache), for budgeting. */
export async function getAllPlaidTransactions(): Promise<RawTxn[]> {
  const lists = await Promise.all(allItems().map(i => getItemTransactions(i.item_id, i.access_token)));
  return lists.flat();
}

// --- Investment holdings ---------------------------------------------------

// Map Plaid's holdings + securities into KevFin's Holding shape, per account.
//  - cost_basis is Plaid's total basis for the position; null or ≤ 0 means
//    "unknown" (many employer plans report nothing), never a fake zero.
//  - Plaid reports no lot open date, so `acquired` is always null.
//  - A cash position (security type "cash", ticker like "CUR:USD") carries no
//    priceable ticker. It is described as "Cash reserves" so the allocation
//    view's existing cash patterns bucket it as cash rather than as equity.
export function holdingsFromPlaid(holdings: PlaidHolding[], securities: Security[]): Map<string, Holding[]> {
  const secById = new Map(securities.map(s => [s.security_id, s]));
  const out = new Map<string, Holding[]>();
  for (const h of holdings) {
    const sec = secById.get(h.security_id);
    const isCash = sec?.type === 'cash';
    const list = out.get(h.account_id) ?? [];
    list.push({
      symbol: isCash ? '' : (sec?.ticker_symbol ?? '').trim(),
      description: isCash ? 'Cash reserves' : (sec?.name ?? '').trim(),
      marketValue: Number.isFinite(h.institution_value) ? h.institution_value : 0,
      costBasis: h.cost_basis != null && h.cost_basis > 0 ? h.cost_basis : null,
      shares: !isCash && Number.isFinite(h.quantity) && h.quantity !== 0 ? h.quantity : null,
      acquired: null,
    });
    out.set(h.account_id, list);
  }
  return out;
}

function readHoldingsDbCache(itemId: string): { fetchedAt: number; byAccount: Record<string, Holding[]> } | null {
  const entry = readProviderCache<Record<string, Holding[]>>(`plaid_holdings_cache_${itemId}`);
  return entry ? { fetchedAt: entry.fetchedAt, byAccount: entry.payload } : null;
}

/** Cached holdings for one item — re-fetched at most once per TXN_CACHE_MS. */
async function getItemHoldings(itemId: string, accessToken: string, force = false): Promise<Record<string, Holding[]>> {
  const now = Date.now();

  const mem = holdingsMemCache.get(itemId);
  if (!plaidConfigured()) return mem?.byAccount ?? readHoldingsDbCache(itemId)?.byAccount ?? {};
  if (!force && mem && now - mem.fetchedAt < TXN_CACHE_MS) return mem.byAccount;

  if (!force) {
    const db = readHoldingsDbCache(itemId);
    if (db && now - db.fetchedAt < TXN_CACHE_MS) { holdingsMemCache.set(itemId, db); return db.byAccount; }
  }

  try {
    const res = await getPlaidClient().investmentsHoldingsGet({ access_token: accessToken });
    const byAccount = Object.fromEntries(holdingsFromPlaid(res.data.holdings, res.data.securities));
    const entry = { fetchedAt: now, byAccount };
    holdingsMemCache.set(itemId, entry);
    writeProviderCache(`plaid_holdings_cache_${itemId}`, { fetchedAt: now, payload: byAccount });
    console.log(`[plaid] fetched holdings for item ${itemId} (${Object.keys(byAccount).length} accounts) — cached for ~24h`);
    return byAccount;
  } catch (err) {
    // Items without investment consent (PRODUCTS_NOT_SUPPORTED,
    // NO_INVESTMENT_ACCOUNTS, ADDITIONAL_CONSENT_REQUIRED) land here too: the
    // account then shows its balance with no holdings breakdown.
    // Remember the fallback in memory for the cache period, so a page load
    // doesn't re-hit Plaid for an item that just refused; the next forced
    // refresh (daily sync / "Sync now") tries again.
    console.error(`[plaid] holdings fetch failed for item ${itemId}:`, plaidErrorDetail(err));
    const byAccount = mem?.byAccount ?? readHoldingsDbCache(itemId)?.byAccount ?? {}; // fall back to stale
    holdingsMemCache.set(itemId, { fetchedAt: now, byAccount });
    return byAccount;
  }
}

/** Current holdings per account id, across items (from the daily cache). */
export async function fetchHoldings(): Promise<Map<string, Holding[]>> {
  // Only items with a brokerage account have holdings worth asking for.
  const items = getDb().prepare(`
    SELECT item_id, access_token FROM plaid_items pi
    WHERE EXISTS (SELECT 1 FROM accounts a WHERE a.plaid_item_id = pi.item_id AND a.category = 'brokerage')
  `).all() as { item_id: string; access_token: string }[];
  const perItem = await Promise.all(items.map(i => getItemHoldings(i.item_id, i.access_token)));
  const out = new Map<string, Holding[]>();
  for (const byAccount of perItem) {
    for (const [accountId, list] of Object.entries(byAccount)) out.set(accountId, list);
  }
  return out;
}

/**
 * Fetch transactions since `startDate` (YYYY-MM-DD) for all Plaid items, grouped
 * by account id. Plaid amounts are positive when money LEAVES the account, so the
 * balance effect is delta = -amount.
 */
export async function fetchPlaidTransactions(startDate: string, endDate: string): Promise<Map<string, TxnDelta[]>> {
  const out = new Map<string, TxnDelta[]>();
  if (!plaidConfigured()) return out;

  const db = getDb();
  const items = db.prepare('SELECT access_token FROM plaid_items').all() as { access_token: string }[];

  for (const it of items) {
    let offset = 0;
    // paginate until we've pulled every transaction in the window
    for (;;) {
      const res = await getPlaidClient().transactionsGet({
        access_token: it.access_token,
        start_date: startDate,
        end_date: endDate,
        options: { count: 500, offset },
      });
      for (const t of res.data.transactions) {
        const list = out.get(t.account_id) ?? [];
        list.push({ date: t.date, delta: -(t.amount ?? 0) });
        out.set(t.account_id, list);
      }
      offset += res.data.transactions.length;
      if (offset >= res.data.total_transactions || res.data.transactions.length === 0) break;
    }
  }
  return out;
}

export async function refreshAllPlaid(): Promise<void> {
  if (!plaidConfigured()) return;
  const db = getDb();
  const items = db
    .prepare('SELECT item_id, access_token, institution_name FROM plaid_items')
    .all() as { item_id: string; access_token: string; institution_name: string }[];

  // One item failing (expired login, institution outage) must not stop the others
  // from refreshing — let every item finish (so the caller snapshots after all
  // writes have landed), then report the failures.
  const results = await Promise.allSettled(items.map(i => refreshItem(i.item_id, i.access_token, i.institution_name)));
  const failures: ItemFailure[] = [];
  results.forEach((r, n) => {
    if (r.status === 'rejected') {
      failures.push({ label: safeLabel(items[n].institution_name, 'Plaid item'), reason: safePlaidReason(r.reason) });
      console.error(`[plaid] refresh failed for item ${items[n].item_id}:`, plaidErrorDetail(r.reason));
    }
  });
  // Carries institution + Plaid error_code per failed item (and nothing else) so the
  // sync response can name them — see refreshErrors.ts.
  if (failures.length) throw new ProviderRefreshError('Plaid', items.length, failures);
}
