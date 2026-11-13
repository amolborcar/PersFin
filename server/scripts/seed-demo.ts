/**
 * Seed a self-contained DEMO database with realistic but entirely fictional
 * finances — used to produce the screenshots in the README without exposing any
 * real data. Point the app at the demo DB and run it:
 *
 *   DB_PATH=$PWD/data/demo.db npx tsx scripts/seed-demo.ts      (from server/)
 *   DB_PATH=$PWD/data/demo.db npm run dev --prefix server
 *
 * It writes only to whatever DB_PATH points at, so it never touches your real
 * data/kevfin.db. All names, balances, holdings and transactions below are made
 * up. Re-running resets the demo DB from scratch.
 */
import { getDb } from '../src/db/schema.js';
import { seedPlaidItem, type SeedAccount } from '../src/db/plaidSeed.js';
import { takeSnapshot } from '../src/services/netWorth.js';

if (!process.env.DB_PATH) {
  console.error('Refusing to run without DB_PATH set (so the real DB is never touched).');
  console.error('Try:  DB_PATH=$PWD/data/demo.db npx tsx scripts/seed-demo.ts');
  process.exit(1);
}

const db = getDb();

// --- Wipe any prior demo content so re-runs are clean -----------------------
for (const t of [
  'accounts', 'manual_assets', 'net_worth_snapshots',
  'plaid_items', 'balance_observations',
  'budget_targets', 'rules', 'asset_class_overrides',
  'provider_cache', 'transactions',
]) {
  try { db.exec(`DELETE FROM ${t}`); } catch { /* table may not exist yet */ }
}

// --- Deterministic tiny PRNG so the demo is identical every run -------------
let _s = 1337;
const rnd = () => ((_s = (_s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const jitter = (base: number, pct: number) => base * (1 + (rnd() - 0.5) * 2 * pct);
const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)];
const unix = (d: Date) => Math.floor(d.getTime() / 1000);

const TODAY = new Date('2026-06-23T12:00:00Z');

// --- Fictional accounts, with holdings summing to each balance --------------
// Shaped like a Plaid sync leaves them (see src/db/plaidSeed.ts). Holdings carry
// the cases Plaid reports:
//  - most positions report a total cost_basis,
//  - MSFT and NVDA report none (Plaid's null, common for employer plans), to
//    exercise the "no basis" → "—" path, and
//  - a small cash position (Plaid security type "cash").
const h = (symbol: string, description: string, marketValue: number, costBasis: number | null, shares: number | null = null) =>
  ({ symbol, description, marketValue, costBasis, shares, acquired: null });
type Acct = SeedAccount & { transactions: NonNullable<SeedAccount['transactions']> };

const accounts: Acct[] = [
  {
    org: 'Fidelity', id: 'demo-fidelity-brokerage', name: 'Individual Brokerage', balance: 184320.55, category: 'brokerage',
    holdings: [
      h('VOO', 'Vanguard S&P 500 ETF', 78400.00, 54200.00),
      h('VTI', 'Vanguard Total Stock Market ETF', 42900.30, 31500.00),
      h('AAPL', 'Apple Inc', 18250.00, 9800.00),
      h('MSFT', 'Microsoft Corp', 15600.00, null, 40),
      h('NVDA', 'NVIDIA Corp', 12300.25, null),
      h('VXUS', 'Vanguard Total Intl Stock ETF', 9870.00, 10450.00),
      h('BND', 'Vanguard Total Bond Market ETF', 6000.00, 6300.00),
      h('', 'Cash reserves', 1000.00, null),
    ],
    transactions: [],
  },
  {
    org: 'Vanguard', id: 'demo-vanguard-roth', name: 'Roth IRA', balance: 96540.20, category: 'brokerage',
    holdings: [
      h('VTI', 'Vanguard Total Stock Market ETF', 52000.00, 38000.00),
      h('VXUS', 'Vanguard Total Intl Stock ETF', 24540.20, 21000.00),
      h('BND', 'Vanguard Total Bond Market ETF', 12000.00, 12600.00),
      h('QQQ', 'Invesco QQQ Trust', 8000.00, 5400.00),
    ],
    transactions: [],
  },
  { org: 'Chase', id: 'demo-chase-checking', name: 'Total Checking', balance: 12430.18, category: 'banking', transactions: [] },
  { org: 'Ally', id: 'demo-ally-savings', name: 'Online Savings', balance: 45000.00, category: 'banking', transactions: [] },
  { org: 'Chase', id: 'demo-chase-sapphire', name: 'Sapphire Credit Card', balance: -2841.55, category: 'credit', transactions: [] },
];
const checking = accounts.find(a => a.id === 'demo-chase-checking')!;
const card = accounts.find(a => a.id === 'demo-chase-sapphire')!;
const brokerage = accounts.find(a => a.id === 'demo-fidelity-brokerage')!;

// --- 14 months of transactions ---------------------------------------------
let txnSeq = 0;
const tx = (acct: Acct, day: Date, amount: number, payee: string) => {
  acct.transactions.push({
    id: `demo-tx-${txnSeq++}`, posted: unix(day),
    amount: Math.round(amount * 100) / 100, description: payee, payee,
  });
};
const dayOf = (year: number, month0: number, day: number) =>
  new Date(Date.UTC(year, month0, Math.min(day, 28), 12, 0, 0));

// Walk back 14 whole months from the current one.
for (let back = 14; back >= 0; back--) {
  const base = new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth() - back, 1));
  const y = base.getUTCFullYear(), m = base.getUTCMonth();
  const isCurrent = back === 0;
  const cutoffDay = isCurrent ? TODAY.getUTCDate() : 28;
  const on = (day: number, fn: () => void) => { if (day <= cutoffDay) fn(); };

  // Income — semi-monthly payroll into checking
  on(15, () => tx(checking, dayOf(y, m, 15), 3120.44, 'ACME CORP PAYROLL'));
  on(28, () => tx(checking, dayOf(y, m, 28), 3120.44, 'ACME CORP PAYROLL'));

  // Recurring bills — checking
  on(3, () => tx(checking, dayOf(y, m, 3), -2800.00, 'AVALON APARTMENTS RENT'));
  on(8, () => tx(checking, dayOf(y, m, 8), -jitter(132, 0.18), 'PG&E ELECTRIC'));
  on(12, () => tx(checking, dayOf(y, m, 12), -89.99, 'COMCAST XFINITY'));
  on(18, () => tx(checking, dayOf(y, m, 18), -85.00, 'VERIZON WIRELESS'));

  // Recurring subscriptions / memberships — credit card
  on(2, () => tx(card, dayOf(y, m, 2), -185.00, 'EQUINOX FITNESS'));
  on(5, () => tx(card, dayOf(y, m, 5), -15.49, 'NETFLIX'));
  on(6, () => tx(card, dayOf(y, m, 6), -20.00, 'ANTHROPIC SUBSCRIPTION'));
  on(7, () => tx(card, dayOf(y, m, 7), -11.99, 'SPOTIFY'));
  on(9, () => tx(card, dayOf(y, m, 9), -2.99, 'ICLOUD STORAGE'));
  on(14, () => tx(card, dayOf(y, m, 14), -142.00, 'GEICO INSURANCE'));

  // Variable groceries
  on(4, () => tx(card, dayOf(y, m, 4), -jitter(128, 0.3), 'WHOLE FOODS MARKET'));
  on(11, () => tx(card, dayOf(y, m, 11), -jitter(74, 0.35), "TRADER JOE'S"));
  on(21, () => tx(card, dayOf(y, m, 21), -jitter(112, 0.3), 'SAFEWAY'));

  // Coffee + dining
  for (const d of [3, 9, 16, 23]) on(d, () => tx(card, dayOf(y, m, d), -jitter(6.5, 0.3), 'STARBUCKS'));
  for (const d of [6, 13, 20, 26]) on(d, () => tx(card, dayOf(y, m, d), -jitter(24, 0.5), pick(['CHIPOTLE', "MCDONALD'S", 'PIZZA HUT', 'THAI KITCHEN'])));

  // Gas, shopping, rideshare
  on(10, () => tx(card, dayOf(y, m, 10), -jitter(58, 0.25), pick(['SHELL', 'CHEVRON'])));
  on(24, () => tx(card, dayOf(y, m, 24), -jitter(52, 0.25), pick(['SHELL', 'CHEVRON'])));
  for (const d of [7, 17, 27]) on(d, () => tx(card, dayOf(y, m, d), -jitter(64, 0.7), pick(['AMAZON', 'TARGET'])));
  on(19, () => tx(card, dayOf(y, m, 19), -jitter(19, 0.4), 'UBER TRIP'));

  // Occasional / seasonal
  if (rnd() < 0.4) on(22, () => tx(card, dayOf(y, m, 22), -jitter(95, 0.4), 'NIKE'));
  if (rnd() < 0.3) on(20, () => tx(card, dayOf(y, m, 20), -jitter(28, 0.3), 'CVS PHARMACY'));
  if (rnd() < 0.25) on(15, () => tx(card, dayOf(y, m, 15), -jitter(430, 0.3), 'DELTA AIRLINES'));
  if (rnd() < 0.18) on(16, () => tx(card, dayOf(y, m, 16), -jitter(380, 0.25), 'MARRIOTT HOTEL'));
  if (rnd() < 0.25) on(25, () => tx(card, dayOf(y, m, 25), -50.00, 'RED CROSS DONATION'));

  // Quarterly dividend into brokerage
  if (m % 3 === 2) on(15, () => tx(brokerage, dayOf(y, m, 15), jitter(180, 0.2), 'VANGUARD DIVIDEND REINVEST'));

  // A few merchants the built-in keyword rules don't recognize, so Quick review
  // (and its AI suggestions) has something to show.
  if (back <= 3) on(13, () => tx(card, dayOf(y, m, 13), -jitter(38, 0.3), 'NORTHSIDE PAWS'));
  if (back <= 2) on(22, () => tx(card, dayOf(y, m, 22), -jitter(120, 0.2), 'KESTREL OUTFITTERS'));
  if (back === 1) on(8, () => tx(card, dayOf(y, m, 8), -45.00, 'MIRA STUDIO LLC'));

  // Monthly credit-card payment from checking (excluded from spend/income)
  on(27, () => tx(checking, dayOf(y, m, 27), -jitter(2400, 0.2), 'CHASE CARD PAYMENT THANK YOU'));
}

// --- Persist one Plaid item per institution + cached payloads ---------------
const byOrg = new Map<string, Acct[]>();
for (const a of accounts) byOrg.set(a.org, [...(byOrg.get(a.org) ?? []), a]);
for (const [org, list] of byOrg) seedPlaidItem(db, `demo-item-${org.toLowerCase()}`, list);

// --- A manual asset ---------------------------------------------------------
db.prepare('INSERT INTO manual_assets (name, category, value) VALUES (?, ?, ?)')
  .run('I Bonds (TreasuryDirect)', 'brokerage', 15000);

// --- Budget targets so the Budget page shows progress -----------------------
db.exec(`CREATE TABLE IF NOT EXISTS budget_targets (category TEXT PRIMARY KEY, monthly_limit REAL NOT NULL)`);
const target = db.prepare('INSERT OR REPLACE INTO budget_targets (category, monthly_limit) VALUES (?, ?)');
for (const [c, v] of [
  ['Rent', 2800], ['Gas & Electric', 180], ['Internet & Phone', 200], ['Groceries', 850],
  ['Restaurants & Bars', 450], ['Coffee Shops', 90], ['Gas', 220], ['Shopping', 400],
  ['Subscriptions', 80], ['Entertainment & Recreation', 120], ['Fitness', 185], ['Insurance', 150],
  ['Travel & Vacation', 500], ['Medical', 120], ['Clothing', 150], ['Charity', 100],
] as [string, number][]) target.run(c, v);

// --- Synthetic net-worth history: ~5y monthly + last 90d, then today's real ---
const snap = db.prepare(`INSERT OR REPLACE INTO net_worth_snapshots (date, accounts_total, net_worth) VALUES (?, ?, ?)`);
const startAcc = 132000, endAcc = 350449;   // accounts + manual assets grow over time
const start = new Date(Date.UTC(2021, 0, 1));
const totalDays = Math.round((TODAY.getTime() - start.getTime()) / 86400000);
const writeSnap = (d: Date) => {
  const t = Math.min(1, Math.max(0, (d.getTime() - start.getTime()) / 86400000 / totalDays));
  const ease = Math.pow(t, 1.15); // gently accelerating growth
  const acc = Math.round(jitter(startAcc + (endAcc - startAcc) * ease, 0.025));
  snap.run(d.toISOString().slice(0, 10), acc, acc);
};
// Monthly points across the full span...
for (let mm = 0; ; mm++) {
  const d = new Date(Date.UTC(2021, mm, 1));
  if (d >= TODAY) break;
  writeSnap(d);
}
// ...plus daily points for the last 90 days so the short ranges have detail.
for (let back = 90; back >= 1; back--) {
  writeSnap(new Date(TODAY.getTime() - back * 86400000));
}
// Today's snapshot from the actual seeded accounts (overwrites estimate).
takeSnapshot();

const n = db.prepare('SELECT COUNT(*) c FROM net_worth_snapshots').get() as { c: number };
const txCount = accounts.reduce((s, a) => s + a.transactions.length, 0);
console.log(`Seeded demo DB at ${process.env.DB_PATH}`);
console.log(`  ${accounts.length} accounts, ${txCount} transactions, ${n.c} net-worth snapshots, 1 manual asset`);
process.exit(0);
