import { esc, fmtMoney, fmtSigned, fmtRangeUS, fmtDateUS } from './reportCharts.js';
import type { WeeklyModel, WeeklyCategory } from '../services/weeklyReport.js';

// Renderings of the weekly report. Pure functions of the model.
//
// The HTML is written for email clients: a single 600 px table layout, inline
// styles only, no scripts, no web fonts, no external images, and bars drawn as
// table cells (email clients drop SVG and many block images). Every value from
// the data is escaped.

const C = {
  ink: '#1f2a24', muted: '#6b7280', rule: '#e5e7eb', bg: '#f6f7f5', card: '#ffffff',
  green: '#2f7d4f', amber: '#a15c07', red: '#b0473c', accent: '#2f5d8a', bar: '#c9d6e3', barOver: '#e7b8b2',
};
const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;

const pctChange = (now: number, before: number) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);
const signedPct = (p: number) => `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p)}%`;
const STATUS: Record<NonNullable<WeeklyCategory['status']>, { label: string; color: string }> = {
  over: { label: 'Over', color: C.red }, 'at-risk': { label: 'At risk', color: C.amber }, 'on-track': { label: 'On track', color: C.green },
};

export function weekLabel(m: Pick<WeeklyModel, 'week'>): string {
  return fmtRangeUS(m.week.start, m.week.end);
}

// One-line comparison: "−12% vs last week ($540) · 8-week average $700".
export function comparisonLine(m: WeeklyModel): string {
  const p = pctChange(m.total, m.priorWeek);
  const vsPrior = p == null ? `last week ${fmtMoney(m.priorWeek)}` : `${signedPct(p)} vs last week (${fmtMoney(m.priorWeek)})`;
  return `${vsPrior} · 8-week average ${fmtMoney(m.avg8)}`;
}

function section(title: string, body: string): string {
  return `<tr><td style="padding:20px 24px 4px;"><p style="margin:0 0 10px;font-size:13px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;color:${C.muted};">${esc(title)}</p>${body}</td></tr>`;
}

function bar(fraction: number, over: boolean): string {
  const w = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;"><tr>` +
    (w > 0 ? `<td width="${w}%" style="height:6px;background:${over ? C.barOver : C.bar};font-size:0;line-height:0;">&nbsp;</td>` : '') +
    (w < 100 ? `<td style="height:6px;background:${C.rule};font-size:0;line-height:0;">&nbsp;</td>` : '') +
    `</tr></table>`;
}

function paceTable(m: WeeklyModel): string {
  // Targets with nothing spent and no risk collapse into one line at the end.
  const idle = m.categories.filter(c => c.target != null && c.mtd === 0 && c.status === 'on-track');
  const rows = m.categories.filter(c => c.target != null && !idle.includes(c))
    .sort((a, b) => ({ over: 0, 'at-risk': 1, 'on-track': 2 }[a.status!] - ({ over: 0, 'at-risk': 1, 'on-track': 2 }[b.status!])) || b.mtd - a.mtd);
  if (!rows.length && !idle.length) return '';
  const body = rows.map(c => {
    const s = STATUS[c.status!];
    return `<tr><td style="padding:6px 0;font-size:14px;color:${C.ink};">${esc(c.emoji)} ${esc(c.category)}</td>` +
      `<td style="padding:6px 0;font-size:13px;color:${C.muted};text-align:right;white-space:nowrap;">${fmtMoney(c.mtd)} of ${fmtMoney(c.target!)}</td>` +
      `<td style="padding:6px 0 6px 10px;font-size:12px;font-weight:700;color:${s.color};text-align:right;white-space:nowrap;">${s.label}</td></tr>` +
      `<tr><td colspan="3" style="padding:0 0 6px;">${bar(c.mtd / c.target!, c.status === 'over')}` +
      (c.status !== 'on-track' ? `<p style="margin:3px 0 0;font-size:12px;color:${C.muted};">On pace for ${fmtMoney(c.projected!)} this month.</p>` : '') +
      `</td></tr>`;
  }).join('');
  const idleLine = idle.length
    ? `<p style="margin:4px 0 0;font-size:12px;color:${C.muted};">Nothing spent yet: ${idle.map(c => esc(c.category)).join(', ')}.</p>` : '';
  return section('Budget pace this month', `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${body}</table>${idleLine}`);
}

function spendTable(m: WeeklyModel): string {
  const rows = m.categories.filter(c => c.week > 0);
  if (!rows.length) return section('Spending this week', `<p style="margin:0;font-size:14px;color:${C.muted};">No spending recorded this week.</p>`);
  const body = rows.map(c => {
    const d = c.week - c.avg;
    const tone = Math.abs(d) < 1 ? C.muted : d > 0 ? C.red : C.green;
    // Only regular categories get a weekly comparison (see REGULAR_WEEKS).
    const vs = !c.regular ? '' : Math.abs(d) < 1 ? 'about usual' : `${fmtSigned(d)} vs avg`;
    return `<tr><td style="padding:5px 0;font-size:14px;color:${C.ink};">${esc(c.emoji)} ${esc(c.category)}</td>` +
      `<td style="padding:5px 0;font-size:14px;color:${C.ink};text-align:right;white-space:nowrap;">${fmtMoney(c.week)}</td>` +
      `<td style="padding:5px 0 5px 12px;font-size:12px;color:${tone};text-align:right;white-space:nowrap;">${vs}</td></tr>`;
  }).join('');
  return section('Spending this week', `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${body}</table>`);
}

function changesBlock(m: WeeklyModel): string {
  if (!m.up.length && !m.down.length) return '';
  const list = (items: WeeklyModel['up'], color: string) => items.map(x =>
    `<p style="margin:0 0 4px;font-size:14px;color:${C.ink};">${esc(x.emoji)} ${esc(x.category)} <span style="color:${color};">${fmtSigned(x.delta)}</span> <span style="color:${C.muted};font-size:12px;">(${fmtMoney(x.week)} vs ${fmtMoney(x.avg)} avg)</span></p>`).join('');
  const col = (title: string, html: string) => `<td valign="top" width="50%" style="padding-right:10px;"><p style="margin:0 0 6px;font-size:12px;color:${C.muted};">${title}</p>${html || `<p style="margin:0;font-size:13px;color:${C.muted};">—</p>`}</td>`;
  return section('Biggest changes vs your 8-week average (regular spending)',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${col('Up', list(m.up, C.red))}${col('Down', list(m.down, C.green))}</tr></table>`);
}

function recurringBlock(m: WeeklyModel): string {
  if (!m.recurring.length) return '';
  const tag = (kind: string) => kind === 'new' ? `<span style="font-size:11px;font-weight:700;color:${C.accent};">NEW</span> `
    : kind === 'price-change' ? `<span style="font-size:11px;font-weight:700;color:${C.amber};">PRICE CHANGE</span> ` : '';
  const body = m.recurring.map(r =>
    `<tr><td style="padding:5px 0;font-size:14px;color:${C.ink};">${tag(r.kind)}${esc(r.payee)} <span style="font-size:12px;color:${C.muted};">${esc(r.category)} · ${esc(fmtDateUS(r.date, false))}</span></td>` +
    `<td style="padding:5px 0;font-size:14px;color:${C.ink};text-align:right;white-space:nowrap;">${fmtMoney(r.amount)}` +
    (r.kind === 'price-change' && r.previous != null ? ` <span style="font-size:12px;color:${C.muted};">(was ${fmtMoney(r.previous)})</span>` : '') + `</td></tr>`).join('');
  return section('Recurring charges this week', `<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${body}</table>`);
}

export function renderWeeklyHtml(m: WeeklyModel, opts: { appUrl: string }): string {
  const reviewUrl = `${opts.appUrl.replace(/\/+$/, '')}/budget`;
  const review = m.review.total > 0
    ? `<tr><td style="padding:16px 24px 4px;"><p style="margin:0;font-size:14px;color:${C.ink};">` +
      (m.review.week > 0
        ? `${m.review.week} uncategorized transaction${m.review.week === 1 ? '' : 's'} this week (${m.review.total} in total). `
        : `${m.review.total} uncategorized transaction${m.review.total === 1 ? '' : 's'} to review. `) +
      `<a href="${esc(reviewUrl)}" style="color:${C.accent};">Review them in PersFin →</a></p></td></tr>`
    : '';
  const summary = m.summary
    ? `<tr><td style="padding:16px 24px 0;"><p style="margin:0;font-size:15px;line-height:1.5;color:${C.ink};">${esc(m.summary)}</p></td></tr>`
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PersFin · Week of ${esc(weekLabel(m))}</title></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:${FONT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:${C.card};border:1px solid ${C.rule};border-radius:12px;">
<tr><td style="padding:24px 24px 0;">
<p style="margin:0;font-size:13px;color:${C.muted};">PersFin · weekly spending</p>
<p style="margin:4px 0 0;font-size:20px;font-weight:700;color:${C.ink};">Week of ${esc(weekLabel(m))}</p>
<p style="margin:14px 0 0;font-size:34px;font-weight:700;color:${C.ink};">${fmtMoney(m.total)} <span style="font-size:15px;font-weight:400;color:${C.muted};">spent</span></p>
<p style="margin:4px 0 0;font-size:14px;color:${C.muted};">${esc(comparisonLine(m))}</p>
${m.income > 0 ? `<p style="margin:4px 0 0;font-size:14px;color:${C.muted};">Income this week ${fmtMoney(m.income)}</p>` : ''}
</td></tr>
${summary}
${paceTable(m)}
${spendTable(m)}
${changesBlock(m)}
${recurringBlock(m)}
${review}
<tr><td style="padding:20px 24px 24px;"><p style="margin:0;font-size:12px;color:${C.muted};">Generated ${esc(fmtDateUS(m.generatedAt.slice(0, 10)))} by PersFin on your own computer.</p></td></tr>
</table></td></tr></table>
</body></html>`;
}

// Short plain text (push notifications, the email's text part):
//   Week of Nov 9 – 15, 2026: spent $612 (−12% vs last week; 8-week avg $700).
//   Over budget: Restaurants & Bars. At risk: Groceries.
//   3 transactions to review.
export function renderWeeklyText(m: WeeklyModel): string {
  const p = pctChange(m.total, m.priorWeek);
  const lines = [`Week of ${weekLabel(m)}: spent ${fmtMoney(m.total)} (${p == null ? `last week ${fmtMoney(m.priorWeek)}` : `${signedPct(p)} vs last week`}; 8-week avg ${fmtMoney(m.avg8)}).`];
  const over = m.categories.filter(c => c.status === 'over').map(c => c.category);
  const risk = m.categories.filter(c => c.status === 'at-risk').map(c => c.category);
  const budget = [over.length ? `Over budget: ${over.join(', ')}.` : '', risk.length ? `At risk: ${risk.join(', ')}.` : ''].filter(Boolean).join(' ');
  if (budget) lines.push(budget);
  if (m.review.week > 0) lines.push(`${m.review.week} transaction${m.review.week === 1 ? '' : 's'} to review.`);
  return lines.join('\n');
}

// --- privacy levels for email and push (services/delivery.ts) --------------------
// full    the whole report (category names, amounts, recurring payees)
// totals  the week's total, its comparisons, and counts — no category names,
//         merchants or transactions
// notice  only that the report is ready, with a link to it in the app
export type PrivacyLevel = 'full' | 'totals' | 'notice';
export const PRIVACY_LEVELS: PrivacyLevel[] = ['full', 'totals', 'notice'];

export function weeklySubject(m: WeeklyModel, level: PrivacyLevel): string {
  return level === 'notice'
    ? `PersFin · Your report for the week of ${weekLabel(m)} is ready`
    : `PersFin · Week of ${weekLabel(m)}: ${fmtMoney(m.total)} spent`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

//   Week of Nov 9 – 15, 2026: spent $612 (−12% vs last week; 8-week avg $700).
//   2 categories over budget, 1 at risk.
//   3 transactions to review.
export function renderWeeklyTotalsText(m: WeeklyModel): string {
  const lines = [renderWeeklyText(m).split('\n')[0]];
  const over = m.categories.filter(c => c.status === 'over').length;
  const risk = m.categories.filter(c => c.status === 'at-risk').length;
  if (over || risk) lines.push(`${plural(over, 'category', 'categories')} over budget, ${risk} at risk.`);
  if (m.review.week > 0) lines.push(`${plural(m.review.week, 'transaction', 'transactions')} to review.`);
  return lines.join('\n');
}

export function renderWeeklyNoticeText(m: WeeklyModel): string {
  return `Your PersFin report for the week of ${weekLabel(m)} is ready.`;
}

// A short email for the 'totals' and 'notice' levels: the same card style as
// the full report, with the text above and a link to the full report.
export function renderWeeklyBriefHtml(m: WeeklyModel, level: 'totals' | 'notice', opts: { reportUrl: string }): string {
  const lines = (level === 'totals' ? renderWeeklyTotalsText(m) : renderWeeklyNoticeText(m)).split('\n');
  const body = lines.map((l, i) => `<p style="margin:${i ? 6 : 0}px 0 0;font-size:${i ? 14 : 16}px;line-height:1.5;color:${i ? C.muted : C.ink};">${esc(l)}</p>`).join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>PersFin · Week of ${esc(weekLabel(m))}</title></head>
<body style="margin:0;padding:0;background:${C.bg};font-family:${FONT};">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${C.bg};"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;background:${C.card};border:1px solid ${C.rule};border-radius:12px;">
<tr><td style="padding:24px;">
<p style="margin:0 0 12px;font-size:13px;color:${C.muted};">PersFin · weekly spending</p>
${body}
<p style="margin:16px 0 0;font-size:14px;"><a href="${esc(opts.reportUrl)}" style="color:${C.accent};">Open the full report in PersFin →</a></p>
</td></tr></table></td></tr></table>
</body></html>`;
}
