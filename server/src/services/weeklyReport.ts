import { getDb } from '../db/schema.js';
import { getCategorizedTransactions, cardTrackedMonths, isInternalTransfer, type BudgetTxn } from './budget.js';
import { getRecurring, type RecurringItem } from './recurring.js';
import { isIncomeCategory, taxonomyEmoji, suggestEmoji } from './taxonomy.js';
import { getMeta, setMeta } from './meta.js';
import { runClaudeNoTools, type ClaudeRunner } from './claudeRunner.js';
import { reportWeek, shiftWeek, weekFromKey, monthProgress, addDays, type WeekWindow } from '../util/weekWindow.js';
import { renderWeeklyHtml, renderWeeklyText } from '../util/weeklyRender.js';

// The weekly spending report (Monday–Sunday). This module computes its figures
// and stores each rendered report in `weekly_reports`; sending it (email, push)
// is services/delivery.ts.
//
// Spending follows the budget's rules exactly: income categories and internal
// money movement (Transfers, and Credit Card Payment in months where the card's
// own purchases are tracked) don't count; within a period each category's
// charges and refunds net, and a category never goes below $0.

export const AVG_WEEKS = 8;
// A category is "regular" when it had spending in at least this many of the
// prior AVG_WEEKS weeks and it is not the category of a fixed recurring bill.
// Only regular categories get a weekly comparison: a bill (rent, phone) lands
// in one week of the month, so comparing its week with its weekly average
// would only show when it was paid.
export const REGULAR_WEEKS = 3;

export interface WeeklyCategory {
  category: string; emoji: string;
  week: number;            // spent this week
  avg: number;             // average weekly spend over the prior AVG_WEEKS weeks
  regular: boolean;        // spent in >= REGULAR_WEEKS of those weeks (see above)
  mtd: number;             // spent this month through the week's end
  target: number | null;   // monthly target (annual targets ÷ 12), null if none
  projected: number | null; // expected month-end (null without a target): see computeWeeklyModel
  status: 'over' | 'at-risk' | 'on-track' | null;
}
export interface WeeklyChange { category: string; emoji: string; week: number; avg: number; delta: number }
export interface WeeklyRecurring { payee: string; category: string; amount: number; date: string; previous: number | null; kind: 'new' | 'price-change' | 'charged' }
export interface WeeklyModel {
  week: WeekWindow;
  generatedAt: string;
  total: number;
  priorWeek: number;
  avg8: number;
  income: number;
  categories: WeeklyCategory[];   // categories with spending this week or a target, biggest first
  up: WeeklyChange[];             // top increases vs the category's 8-week average
  down: WeeklyChange[];           // top decreases
  recurring: WeeklyRecurring[];   // recurring charges this week (new and changed first)
  review: { week: number; total: number }; // uncategorized expenses: this week / all time
  summary: string | null;         // optional AI-written paragraph
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// Per-category net spend for transactions dated [from, to]. A category's
// refunds net against its charges; the result is clamped at >= 0.
export function spendByCategory(txns: BudgetTxn[], tracked: Set<string>, from: string, to: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of txns) {
    if (t.date < from || t.date > to) continue;
    if (isIncomeCategory(t.category) || isInternalTransfer(t.category, tracked.has(t.date.slice(0, 7)))) continue;
    m.set(t.category, (m.get(t.category) ?? 0) - t.amount);
  }
  for (const [c, v] of m) if (v < 0.005) m.delete(c); else m.set(c, r2(v));
  return m;
}
const sum = (m: Map<string, number>) => r2([...m.values()].reduce((s, v) => s + v, 0));

// Recurring items with a charge in the week. "New" = first seen within the
// last ~10 weeks; "price-change" = this charge differs from the one before by
// more than 5% and at least $1.
export function weeklyRecurring(items: RecurringItem[], w: WeekWindow): WeeklyRecurring[] {
  const out: WeeklyRecurring[] = [];
  for (const it of items) {
    const charges = (it.transactions ?? []).slice().sort((a, b) => b.date.localeCompare(a.date));
    const thisWeek = charges.find(c => c.date >= w.start && c.date <= w.end);
    if (!thisWeek) continue;
    const prev = charges.find(c => c.date < thisWeek.date) ?? null;
    const oldest = charges[charges.length - 1];
    const amount = Math.abs(thisWeek.amount);
    const previous = prev ? Math.abs(prev.amount) : null;
    const kind: WeeklyRecurring['kind'] =
      oldest.date >= addDays(w.end, -70) ? 'new'
      : previous != null && Math.abs(amount - previous) >= 1 && Math.abs(amount - previous) / previous > 0.05 ? 'price-change'
      : 'charged';
    out.push({ payee: it.payee, category: it.category, amount: r2(amount), date: thisWeek.date, previous: previous == null ? null : r2(previous), kind });
  }
  const rank = { new: 0, 'price-change': 1, charged: 2 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || b.amount - a.amount);
}

export function computeWeeklyModel(input: {
  week: WeekWindow;
  txns: BudgetTxn[];
  tracked: Set<string>;
  targets: Map<string, { limit: number; period: 'monthly' | 'annual' }>;
  recurring: RecurringItem[];
  now?: Date;
}): WeeklyModel {
  const { week: w, txns, tracked, targets } = input;
  const emoji = (c: string) => taxonomyEmoji(c) ?? suggestEmoji(c);

  const thisWeek = spendByCategory(txns, tracked, w.start, w.end);
  const prior = spendByCategory(txns, tracked, shiftWeek(w, -1).start, shiftWeek(w, -1).end);
  const priorWeeks = Array.from({ length: AVG_WEEKS }, (_, i) => shiftWeek(w, -(i + 1)))
    .map(pw => spendByCategory(txns, tracked, pw.start, pw.end));
  const avgOf = (c: string) => r2(priorWeeks.reduce((s, m) => s + (m.get(c) ?? 0), 0) / AVG_WEEKS);
  const fixedBills = new Set(input.recurring.filter(r => r.isFixed).map(r => r.category));
  const isRegular = (c: string) => !fixedBills.has(c) && priorWeeks.filter(m => m.has(c)).length >= REGULAR_WEEKS;

  const { monthKey, daysElapsed } = monthProgress(w.end);
  const mtd = spendByCategory(txns, tracked, `${monthKey}-01`, w.end);

  // Expected month-end = spent so far + what this category usually costs in
  // the REST of a month (after day `daysElapsed`), averaged over the 3 complete
  // months before. A bill paid early in the month (rent, insurance) then adds
  // nothing, while spending spread over the month (groceries) adds its usual
  // remainder. A plain straight-line pace would flag every paid bill as at risk.
  const restOfMonth = new Map<string, number>();
  for (let k = 1; k <= 3; k++) {
    const [y, mo] = monthKey.split('-').map(Number);
    const d = new Date(y, mo - 1 - k, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const last = monthProgress(`${key}-01`).daysInMonth;
    if (daysElapsed >= last) continue;
    const from = `${key}-${String(daysElapsed + 1).padStart(2, '0')}`;
    for (const [c, v] of spendByCategory(txns, tracked, from, `${key}-${last}`)) restOfMonth.set(c, (restOfMonth.get(c) ?? 0) + v / 3);
  }

  const names = new Set([...thisWeek.keys(), ...[...targets.keys()].filter(c => mtd.has(c) || thisWeek.has(c) || targets.get(c)!.limit > 0)]);
  const categories: WeeklyCategory[] = [...names].map(c => {
    const t = targets.get(c);
    const target = t && t.limit > 0 ? r2(t.period === 'annual' ? t.limit / 12 : t.limit) : null;
    const spent = mtd.get(c) ?? 0;
    const projected = target != null ? r2(spent + (restOfMonth.get(c) ?? 0)) : null;
    const status: WeeklyCategory['status'] = target == null ? null
      : spent > target ? 'over' : projected! > target ? 'at-risk' : 'on-track';
    return { category: c, emoji: emoji(c), week: thisWeek.get(c) ?? 0, avg: avgOf(c), regular: isRegular(c), mtd: spent, target, projected, status };
  }).sort((a, b) => b.week - a.week || b.mtd - a.mtd || a.category.localeCompare(b.category));

  const changes = [...new Set([...thisWeek.keys(), ...priorWeeks.flatMap(m => [...m.keys()])])]
    .filter(isRegular)
    .map(c => { const week = thisWeek.get(c) ?? 0, avg = avgOf(c); return { category: c, emoji: emoji(c), week, avg, delta: r2(week - avg) }; })
    .filter(x => Math.abs(x.delta) >= 1);
  const up = changes.filter(x => x.delta > 0).sort((a, b) => b.delta - a.delta).slice(0, 5);
  const down = changes.filter(x => x.delta < 0).sort((a, b) => a.delta - b.delta).slice(0, 5);

  const income = r2(txns.filter(t => t.date >= w.start && t.date <= w.end && isIncomeCategory(t.category)).reduce((s, t) => s + t.amount, 0));
  const uncategorized = txns.filter(t => t.category === 'Miscellaneous' && t.amount < 0);

  return {
    week: w,
    generatedAt: (input.now ?? new Date()).toISOString(),
    total: sum(thisWeek),
    priorWeek: sum(prior),
    avg8: r2(priorWeeks.reduce((s, m) => s + sum(m), 0) / AVG_WEEKS),
    income,
    categories,
    up, down,
    recurring: weeklyRecurring(input.recurring, w),
    review: { week: uncategorized.filter(t => t.date >= w.start && t.date <= w.end).length, total: uncategorized.length },
    summary: null,
  };
}

// --- optional AI summary -----------------------------------------------------
// Off by default. Sends only the aggregated figures (totals and per-category
// amounts, no merchants or transactions) to the local Claude Code with no tools.
export function getWeeklyAiSummary(): boolean { return getMeta('weekly_report_ai') === '1'; }
export function setWeeklyAiSummary(on: boolean): void { setMeta('weekly_report_ai', on ? '1' : '0'); }

export function summaryPrompt(m: WeeklyModel): string {
  const cats = m.categories.filter(c => c.week > 0 || c.status).slice(0, 12)
    .map(c => `${c.category}: week $${c.week.toFixed(0)}, 8-week avg $${c.avg.toFixed(0)}` +
      (c.target != null ? `, month-to-date $${c.mtd.toFixed(0)} of $${c.target.toFixed(0)} target (${c.status})` : ''));
  return [
    `Week ${m.week.start} to ${m.week.end}. Total spent $${m.total.toFixed(0)}; prior week $${m.priorWeek.toFixed(0)}; 8-week average $${m.avg8.toFixed(0)}; income $${m.income.toFixed(0)}.`,
    'By category:', ...cats.map(c => `- ${c}`),
    'Write 2 or 3 short, plain sentences for the owner about this week: what stood out and one practical note. No greeting, no lists, no advice about investments.',
  ].join('\n');
}

// --- generate + store ----------------------------------------------------------
export interface StoredWeeklyReport { key: string; start: string; end: string; total: number; generatedAt: string; emailSentAt: string | null; pushSentAt: string | null }

export async function generateWeeklyReport(opts: { week?: string; now?: Date; ai?: boolean; runner?: ClaudeRunner; appUrl?: string } = {}): Promise<WeeklyModel> {
  const now = opts.now ?? new Date();
  const w = (opts.week ? weekFromKey(opts.week) : null) ?? reportWeek(now);
  const db = getDb();
  const txns = await getCategorizedTransactions();
  const targets = new Map(
    (db.prepare('SELECT category, monthly_limit, period FROM budget_targets').all() as { category: string; monthly_limit: number; period: string }[])
      .map(t => [t.category, { limit: t.monthly_limit, period: (t.period === 'annual' ? 'annual' : 'monthly') as 'monthly' | 'annual' }]),
  );
  const recurring = await getRecurring().catch(() => [] as RecurringItem[]);
  const model = computeWeeklyModel({ week: w, txns, tracked: cardTrackedMonths(txns), targets, recurring, now });

  if (opts.ai ?? getWeeklyAiSummary()) {
    const r = await (opts.runner ?? runClaudeNoTools)(summaryPrompt(model), 'You write brief, factual notes about the owner\'s own weekly spending. Plain text only.');
    if (r.ok) model.summary = r.text.trim().slice(0, 800);
  }

  const appUrl = opts.appUrl ?? process.env.PERSFIN_PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 3001}`;
  db.prepare(`
    INSERT INTO weekly_reports (week_key, week_start, week_end, total, generated_at, model, html, text)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(week_key) DO UPDATE SET total = excluded.total, generated_at = excluded.generated_at,
      model = excluded.model, html = excluded.html, text = excluded.text
  `).run(w.key, w.start, w.end, model.total, model.generatedAt, JSON.stringify(model), renderWeeklyHtml(model, { appUrl }), renderWeeklyText(model));
  return model;
}

export function listWeeklyReports(limit = 26): StoredWeeklyReport[] {
  return getDb().prepare(`SELECT week_key AS key, week_start AS start, week_end AS end, total, generated_at AS generatedAt,
    email_sent_at AS emailSentAt, push_sent_at AS pushSentAt
    FROM weekly_reports ORDER BY week_key DESC LIMIT ?`).all(limit) as StoredWeeklyReport[];
}

export function getStoredWeeklyReport(key: string): { html: string; text: string; model: WeeklyModel } | null {
  const row = getDb().prepare('SELECT html, text, model FROM weekly_reports WHERE week_key = ?').get(key) as { html: string; text: string; model: string } | undefined;
  return row ? { html: row.html, text: row.text, model: JSON.parse(row.model) as WeeklyModel } : null;
}
