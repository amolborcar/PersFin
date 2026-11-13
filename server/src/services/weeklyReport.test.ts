import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { BudgetTxn } from './budget.js';
import type { RecurringItem } from './recurring.js';

// DB_PATH must be set before the schema module loads, so modules that reach it
// are imported dynamically after it is set.
const TMP = mkdtempSync(path.join(tmpdir(), 'persfin-weekly-'));
process.env.DB_PATH = path.join(TMP, 'weekly.db');
const weekly = await import('./weeklyReport.js');
const { renderWeeklyHtml, renderWeeklyText } = await import('../util/weeklyRender.js');
const { weekContaining } = await import('../util/weekWindow.js');
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const W = weekContaining('2026-11-09'); // Mon Nov 9 – Sun Nov 15, 2026
let n = 0;
const t = (date: string, amount: number, category: string, account = 'Visa Card'): BudgetTxn => ({
  id: `w${n++}`, date, amount, category, account, description: '', payee: category, merchant: category.toLowerCase(),
  suggested: category, memo: '', postedAt: 0, transactedAt: null, ruleId: null, ruleSource: 'auto',
});

// Hand-checked fixture. This week: Groceries 100 − 20 refund = 80, Restaurants
// 60, Miscellaneous 15 → 155. Transfers, the (tracked) card payment and the
// paycheck don't count as spending. Prior week: Groceries 120. The 8 weeks
// before: Groceries 120 + 40 + 40, Restaurants 40, Coffee 80 + 8 + 8 = 336 → 42 / week.
const txns: BudgetTxn[] = [
  t('2026-11-10', -100, 'Groceries'), t('2026-11-12', 20, 'Groceries'),
  t('2026-11-11', -60, 'Restaurants & Bars'),
  t('2026-11-12', -500, 'Transfers', 'Checking'),
  t('2026-11-13', -1000, 'Credit Card Payment', 'Checking'),
  t('2026-11-13', 3000, 'Paychecks', 'Checking'),
  t('2026-11-14', -15, 'Miscellaneous'),
  t('2026-11-03', -120, 'Groceries'),            // prior week
  t('2026-10-20', -40, 'Restaurants & Bars'),    // week of Oct 19
  t('2026-10-27', -80, 'Coffee Shops'),          // week of Oct 26
  t('2026-10-13', -8, 'Coffee Shops'),           // week of Oct 12
  t('2026-09-22', -8, 'Coffee Shops'),           // week of Sep 21 → Coffee Shops is regular (3 of 8 weeks)
  t('2026-10-05', -40, 'Groceries'),             // week of Oct 5 → Groceries is regular (3 of 8 weeks)
  t('2026-09-15', -40, 'Groceries'),             // week of Sep 14 (8 weeks back)
  t('2026-09-01', -30, 'Miscellaneous'),         // outside every window; still to review
  t('2026-08-25', -330, 'Groceries'),            // only in the "rest of month" history (Aug, after day 15)
];
const targets = new Map<string, { limit: number; period: 'monthly' | 'annual' }>([
  ['Groceries', { limit: 300, period: 'monthly' }],
  ['Restaurants & Bars', { limit: 50, period: 'monthly' }],
  ['Travel & Vacation', { limit: 1200, period: 'annual' }],
]);
const rec = (payee: string, category: string, charges: [string, number][]): RecurringItem => ({
  merchant: payee.toLowerCase(), payee, category, monthlyAvg: 0, lastAmount: 0, occurrences: charges.length, lastDate: charges[0][0], isFixed: false,
  transactions: charges.map(([date, amount]) => ({ date, amount, account: 'Visa Card', payee })),
});
const recurring = [
  rec('Netflix', 'Subscriptions', [['2026-11-10', -17.99], ['2026-10-10', -15.49], ['2026-09-10', -15.49], ['2026-08-10', -15.49]]),
  rec('New Gym', 'Fitness', [['2026-11-12', -50], ['2026-10-12', -50]]),
  rec('Spotify', 'Subscriptions', [['2026-11-09', -11.99], ['2026-10-09', -11.99], ['2026-07-09', -11.99]]),
  rec('Old Paper', 'Subscriptions', [['2026-10-01', -5], ['2026-09-01', -5]]),
];
const model = () => weekly.computeWeeklyModel({ week: W, txns, tracked: new Set(['2026-11']), targets, recurring, now: new Date('2026-11-15T23:00:00Z') });

describe('computeWeeklyModel', () => {
  it('totals spending the way the budget does, with prior-week and 8-week comparisons', () => {
    const m = model();
    expect(m.total).toBe(155);
    expect(m.priorWeek).toBe(120);
    expect(m.avg8).toBe(42);
    expect(m.income).toBe(3000);
    expect(m.review).toEqual({ week: 1, total: 2 });
  });

  it('does not flag a bill already paid this month as at risk', () => {
    const rent = [t('2026-11-01', -2800, 'Rent', 'Checking'), t('2026-10-01', -2800, 'Rent', 'Checking'),
      t('2026-09-01', -2800, 'Rent', 'Checking'), t('2026-08-01', -2800, 'Rent', 'Checking')];
    const m = weekly.computeWeeklyModel({ week: W, txns: [...txns, ...rent], tracked: new Set(['2026-11']),
      targets: new Map([['Rent', { limit: 2800, period: 'monthly' }]]), recurring: [], now: new Date() });
    expect(m.categories.find(c => c.category === 'Rent')).toMatchObject({ mtd: 2800, projected: 2800, status: 'on-track' });
  });

  it('counts a card payment as spending when the card is not tracked that month', () => {
    const m = weekly.computeWeeklyModel({ week: W, txns, tracked: new Set(), targets, recurring, now: new Date() });
    expect(m.total).toBe(1155);
  });

  it('shows month-to-date against each target with the pace', () => {
    const by = Object.fromEntries(model().categories.map(c => [c.category, c]));
    // Groceries: 120 + 80 = 200 of 300 by Nov 15. After the 15th it usually
    // costs (Aug 330 + Sep 0 + Oct 0) / 3 = 110 more → 310 → at risk.
    expect(by['Groceries']).toMatchObject({ week: 80, avg: 25, regular: true, mtd: 200, target: 300, projected: 310, status: 'at-risk' });
    // Restaurants: already over; usual rest of month (Oct 20: 40) / 3 → 73.33.
    expect(by['Restaurants & Bars']).toMatchObject({ week: 60, regular: false, mtd: 60, target: 50, projected: 73.33, status: 'over' });
    // Annual 1,200 → 100 a month; nothing spent → on track.
    expect(by['Travel & Vacation']).toMatchObject({ week: 0, mtd: 0, target: 100, projected: 0, status: 'on-track' });
    expect(by['Miscellaneous']).toMatchObject({ week: 15, target: null, status: null });
    expect(model().categories.map(c => c.category).slice(0, 3)).toEqual(['Groceries', 'Restaurants & Bars', 'Miscellaneous']);
  });

  it('ranks the biggest changes against the 8-week average, for regular categories only', () => {
    const m = model();
    // Restaurants (1 week of 8) and Miscellaneous (none) are not regular.
    expect(m.up.map(x => [x.category, x.delta])).toEqual([['Groceries', 55]]);
    expect(m.down.map(x => [x.category, x.delta])).toEqual([['Coffee Shops', -12]]);
  });

  it('leaves the category of a fixed recurring bill out of the weekly comparison', () => {
    const bill = { ...rec('Coffee Club', 'Coffee Shops', [['2026-10-27', -80]]), isFixed: true };
    const m = weekly.computeWeeklyModel({ week: W, txns, tracked: new Set(['2026-11']), targets, recurring: [bill], now: new Date() });
    expect(m.down).toEqual([]);
  });

  it('lists recurring charges this week: new first, then price changes', () => {
    expect(model().recurring).toEqual([
      { payee: 'New Gym', category: 'Fitness', amount: 50, date: '2026-11-12', previous: 50, kind: 'new' },
      { payee: 'Netflix', category: 'Subscriptions', amount: 17.99, date: '2026-11-10', previous: 15.49, kind: 'price-change' },
      { payee: 'Spotify', category: 'Subscriptions', amount: 11.99, date: '2026-11-09', previous: 11.99, kind: 'charged' },
    ]);
  });
});

describe('rendering', () => {
  it('writes an email-safe HTML report with every section and a review link', () => {
    const html = renderWeeklyHtml(model(), { appUrl: 'http://mac-mini.tail1234.ts.net:3001/' });
    expect(html).toContain('Week of Nov 9 – Nov 15, 2026');
    expect(html).toContain('$155');
    expect(html).toContain('+29% vs last week ($120) · 8-week average $42');
    expect(html).toContain('Nothing spent yet: Travel &amp; Vacation.');
    for (const s of ['Budget pace this month', 'Spending this week', 'Biggest changes', 'Recurring charges this week']) expect(html).toContain(s);
    expect(html).toContain('PRICE CHANGE');
    expect(html).toContain('href="http://mac-mini.tail1234.ts.net:3001/budget"');
    expect(html).not.toMatch(/<script|<svg|<img|<link/i);
  });

  it('escapes names from the data', () => {
    const m = model();
    m.categories[0].category = '<script>alert(1)</script>';
    m.summary = 'Spent "more" & <b>less</b>';
    const html = renderWeeklyHtml(m, { appUrl: 'http://localhost:3001' });
    expect(html).not.toContain('<script>alert(1)');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Spent &quot;more&quot; &amp; &lt;b&gt;less&lt;/b&gt;');
  });

  it('writes a short text version', () => {
    expect(renderWeeklyText(model())).toBe([
      'Week of Nov 9 – Nov 15, 2026: spent $155 (+29% vs last week; 8-week avg $42).',
      'Over budget: Restaurants & Bars. At risk: Groceries.',
      '1 transaction to review.',
    ].join('\n'));
  });
});

describe('generateWeeklyReport (stored)', () => {
  beforeAll(async () => {
    vi.useFakeTimers({ now: new Date(2026, 10, 15, 19, 0), toFake: ['Date'] });
    const { getDb } = await import('../db/schema.js');
    const { seedPlaidItem } = await import('../db/plaidSeed.js');
    const unix = (iso: string) => Math.floor(Date.parse(iso + 'T12:00:00Z') / 1000);
    seedPlaidItem(getDb(), 'wk-item', [{
      id: 'wk-card', org: 'Bank', name: 'Visa Card', balance: -100, category: 'credit',
      transactions: [
        { id: 'wk1', posted: unix('2026-11-10'), amount: -64.2, payee: 'WHOLE FOODS MARKET', description: 'WHOLE FOODS MARKET' },
        { id: 'wk2', posted: unix('2026-11-04'), amount: -30, payee: 'WHOLE FOODS MARKET', description: 'WHOLE FOODS MARKET' },
      ],
    }]);
  });
  afterAll(() => vi.useRealTimers());

  it('stores the report for the week and lists it; regenerating replaces it', async () => {
    const m = await weekly.generateWeeklyReport({ ai: false });
    expect(m.week.key).toBe('2026-11-09');
    expect(m.total).toBe(64.2);
    expect(m.priorWeek).toBe(30);
    expect(weekly.listWeeklyReports()).toEqual([{ key: '2026-11-09', start: '2026-11-09', end: '2026-11-15', total: 64.2, generatedAt: m.generatedAt }]);
    const stored = weekly.getStoredWeeklyReport('2026-11-09')!;
    expect(stored.html).toContain('$64');
    expect(stored.text).toMatch(/^Week of Nov 9 – Nov 15, 2026: spent \$64/);
    await weekly.generateWeeklyReport({ ai: false });
    expect(weekly.listWeeklyReports()).toHaveLength(1);
  });

  it('adds an AI summary when asked, from aggregated figures only', async () => {
    let prompt = '';
    const m = await weekly.generateWeeklyReport({
      ai: true, runner: async p => { prompt = p; return { ok: true, text: ' A quiet week, mostly groceries. ' }; },
    });
    expect(m.summary).toBe('A quiet week, mostly groceries.');
    expect(prompt).toContain('Total spent $64');
    expect(prompt).not.toMatch(/WHOLE FOODS|Visa Card/i); // no merchants or account names
    expect(weekly.getStoredWeeklyReport('2026-11-09')!.html).toContain('A quiet week, mostly groceries.');
  });

  it('builds an earlier week on request', async () => {
    const m = await weekly.generateWeeklyReport({ week: '2026-11-02', ai: false });
    expect(m.total).toBe(30);
    expect(weekly.listWeeklyReports().map(r => r.key)).toEqual(['2026-11-09', '2026-11-02']);
  });
});
