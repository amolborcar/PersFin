import type Database from 'better-sqlite3';

// The category taxonomy and its pure helpers. This module is deliberately
// dependency-free (no getDb import) so the DB migration runner can use it
// without creating an import cycle: schema → migrations → taxonomy.
//
// The live taxonomy comes from the owner's personal category file
// (data/categories.json — see services/categoryFile.ts), loaded at startup and
// whenever the file changes. DEFAULT_TAXONOMY is the built-in starting point:
// it seeds a new file and backs the one-time DB migrations.

export type Category = string;
// `hint` (optional) tells the AI categorizer what belongs in the category.
// `aliases` (optional) are other names for it — e.g. the built-in name it was
// renamed from — so automatic categorization and imports that produce an alias
// land in this category.
export interface CatDef { name: string; emoji: string; hint?: string; aliases?: string[] }
export interface CatGroup { name: string; color: string; categories: CatDef[] }

// System categories: the budget logic refers to these by name (income
// detection, transfers and card payments drop out of spending, Miscellaneous is
// the catch-all / review queue). They always exist and can't be removed or
// renamed; the category file loader adds any that are missing.
export const SYSTEM_INCOME_CATEGORIES = ['Paychecks', 'Other Income', 'Dividends & Capital Gains'];
export const SYSTEM_OTHER_CATEGORIES = ['Transfers', 'Credit Card Payment', 'Miscellaneous'];
export const SYSTEM_CATEGORIES = new Set([...SYSTEM_INCOME_CATEGORIES, ...SYSTEM_OTHER_CATEGORIES]);
// Categories in the group with this name count as income (plus the system ones).
export const INCOME_GROUP = 'Income';
// Where system categories go when the file leaves them out, and where new
// user-added categories go.
export const OTHER_GROUP = 'Other';
export const CUSTOM_GROUP = 'Custom';
export const FALLBACK_GROUP_COLOR = '#94a3b8';

// The built-in taxonomy (Monarch-style: groups → subcategories): a curated
// subset tuned to typical household spending.
export const DEFAULT_TAXONOMY: CatGroup[] = [
  { name: 'Income', color: '#22b8cf', categories: [
    { name: 'Paychecks', emoji: '💵' }, { name: 'Other Income', emoji: '💰' }, { name: 'Dividends & Capital Gains', emoji: '📈' },
  ] },
  { name: 'Housing', color: '#6c8fff', categories: [
    { name: 'Rent', emoji: '🏠', hint: 'Rent paid to a landlord or property manager' }, { name: 'Home Improvement', emoji: '🛠️' }, { name: 'Home Services', emoji: '🧹' },
    // Bills & Utilities folded into Housing.
    { name: 'Gas & Electric', emoji: '⚡' }, { name: 'Water', emoji: '💧' }, { name: 'Internet & Phone', emoji: '📶' }, { name: 'Subscriptions', emoji: '🔁' },
  ] },
  { name: 'Food & Dining', color: '#f472b6', categories: [
    { name: 'Groceries', emoji: '🛒', hint: 'Supermarkets, warehouse clubs and food markets' }, { name: 'Restaurants & Bars', emoji: '🍽️' }, { name: 'Coffee Shops', emoji: '☕' },
  ] },
  { name: 'Shopping', color: '#f87171', categories: [
    { name: 'Shopping', emoji: '🛍️' }, { name: 'Clothing', emoji: '👕' }, { name: 'Electronics', emoji: '💻' },
  ] },
  { name: 'Children', color: '#fb923c', categories: [
    { name: 'Child Care', emoji: '🧸' }, { name: 'Child Activities', emoji: '🎨' },
  ] },
  { name: 'Travel & Lifestyle', color: '#38bdf8', categories: [
    { name: 'Travel & Vacation', emoji: '✈️' }, { name: 'Entertainment & Recreation', emoji: '🎬' }, { name: 'Personal', emoji: '💅' },
    // Auto & Transport folded into Travel & Lifestyle.
    { name: 'Auto Payment', emoji: '🚗' }, { name: 'Gas', emoji: '⛽' }, { name: 'Parking & Tolls', emoji: '🅿️' }, { name: 'Taxi & Ride Shares', emoji: '🚕' },
    // Health & Wellness folded into Travel & Lifestyle.
    { name: 'Medical', emoji: '🏥' }, { name: 'Fitness', emoji: '🏋️' },
  ] },
  { name: 'Financial', color: '#2dd4bf', categories: [
    { name: 'Taxes', emoji: '🏛️' }, { name: 'Insurance', emoji: '🛡️' }, { name: 'Financial Fees', emoji: '🧾' },
  ] },
  { name: 'Gifts & Donations', color: '#c084fc', categories: [
    { name: 'Charity', emoji: '🎗️' }, { name: 'Gifts', emoji: '🎁' },
  ] },
  { name: 'Other', color: '#94a3b8', categories: [
    { name: 'Transfers', emoji: '🔄' }, { name: 'Credit Card Payment', emoji: '💳' }, { name: 'Miscellaneous', emoji: '🏷️' },
  ] },
];

export const DEFAULT_CATEGORIES: string[] = DEFAULT_TAXONOMY.flatMap(g => g.categories.map(c => c.name));

// --- the live taxonomy ------------------------------------------------------
let current: CatGroup[] = DEFAULT_TAXONOMY;

export function getTaxonomy(): CatGroup[] { return current; }
export function setTaxonomy(t: CatGroup[]): void { current = t; }

// Every category name in the live taxonomy, in file order.
export function taxonomyCategories(): string[] {
  return current.flatMap(g => g.categories.map(c => c.name));
}
// category name → its group name.
export function taxonomyGroupOf(): Record<string, string> {
  return Object.fromEntries(current.flatMap(g => g.categories.map(c => [c.name, g.name])));
}
export function taxonomyGroupColor(group: string): string {
  return current.find(g => g.name === group)?.color ?? FALLBACK_GROUP_COLOR;
}
export function taxonomyEmoji(category: string): string | undefined {
  for (const g of current) for (const c of g.categories) if (c.name === category) return c.emoji;
  return undefined;
}
// The current category an alias stands for (case-insensitive), if any.
export function resolveAlias(name: string): string | undefined {
  const n = name.toLowerCase();
  for (const g of current) for (const c of g.categories) if (c.aliases?.some(a => a.toLowerCase() === n)) return c.name;
  return undefined;
}

// Income categories: the live Income group plus the system income categories.
export function isIncomeCategory(category: string): boolean {
  if (SYSTEM_INCOME_CATEGORIES.includes(category)) return true;
  return !!current.find(g => g.name === INCOME_GROUP)?.categories.some(c => c.name === category);
}

// Suggest a fitting emoji for a (new) category from its name.
const EMOJI_HINTS: [RegExp, string][] = [
  [/grocer|food ?market|supermarket/i, '🛒'], [/restaurant|dining|\beat|\bbar\b|brunch|lunch|dinner/i, '🍽️'], [/coffee|cafe|\btea\b|boba/i, '☕'], [/alcohol|liquor|wine|beer|brewery/i, '🍷'],
  [/\bgas\b|fuel|petrol/i, '⛽'], [/\bcar\b|auto|vehicle/i, '🚗'], [/transit|\bbus\b|train|subway|metro/i, '🚆'], [/taxi|ride ?share|uber|lyft/i, '🚕'], [/park|toll/i, '🅿️'], [/flight|airline|\bair\b|travel|vacation|\btrip\b/i, '✈️'], [/hotel|lodging|airbnb/i, '🏨'],
  [/rent|\bhome\b|hous|apartment/i, '🏠'], [/improv|repair|hardware|renovat/i, '🛠️'], [/clean|maid|\blawn|pest|\bhvac\b/i, '🧹'],
  [/health|medical|doctor|clinic|hospital/i, '🏥'], [/dental|dentist|teeth/i, '🦷'], [/\bgym\b|fitness|exercise|yoga|pilates/i, '🏋️'], [/pharm|\bdrug|prescription/i, '💊'],
  [/shop|store|retail|amazon|merchand/i, '🛍️'], [/cloth|apparel|fashion|shoe/i, '👕'], [/electron|\btech\b|gadget|computer|phone\b/i, '💻'], [/furnitur|home ?goods|decor/i, '🛋️'],
  [/child ?care|daycare|\bkid|baby|nanny/i, '🧸'], [/school|educat|college|tuition|class/i, '🎓'], [/\bpet|\bdog|\bcat\b|\bvet\b/i, '🐾'],
  [/entertain|movie|cinema|\bgame|stream|netflix|music|concert/i, '🎬'], [/book|read|library/i, '📚'], [/gift|present/i, '🎁'], [/charit|donat|tithe|nonprofit/i, '🎗️'], [/hobby|craft|art\b/i, '🎨'],
  [/util|electric|\bpower\b|energy/i, '⚡'], [/water|sewer/i, '💧'], [/internet|wifi|cable|mobile|wireless/i, '📶'], [/subscri|membership/i, '🔁'],
  [/\btax/i, '🏛️'], [/insur/i, '🛡️'], [/\bfee|charge|interest|penalty/i, '🧾'], [/\bbank|atm/i, '🏦'], [/invest|stock|dividend|capital/i, '📈'],
  [/income|salary|paycheck|wage|payroll/i, '💵'], [/transfer|\bpayment\b/i, '🔄'], [/saving|\bsave\b/i, '🐷'], [/beauty|salon|\bhair\b|\bnail|\bspa\b|barber/i, '💅'],
  [/business|office|\bwork\b/i, '💼'], [/cash|\bmoney\b/i, '💰'], [/laundry|dry clean/i, '🧺'], [/\bbills?\b/i, '🧾'],
];
export function suggestEmoji(name: string): string {
  for (const [re, e] of EMOJI_HINTS) if (re.test(name)) return e;
  return '🏷️';
}

// Monarch (and similar exporters) label some categories differently than our
// taxonomy, and use a few internal-money-movement buckets that should collapse to
// Transfers (so they drop out of "needs review"). Anything NOT listed here is
// kept verbatim — see ensureImportedCategories.
const IMPORT_CATEGORY_ALIASES: Record<string, string> = {
  'transfer': 'Transfers',
  'transfers': 'Transfers',
  'credit card payment': 'Credit Card Payment',
  'loan repayment': 'Transfers',
  'cash & atm': 'Transfers',
  'balance adjustments': 'Transfers',
  'internet & cable': 'Internet & Phone',
  'phone': 'Internet & Phone',
};

// The category an imported row's CSV category maps to: an alias if one applies,
// otherwise the name as given. Empty in → empty out.
export function normalizeImportedCategory(raw: string | null | undefined): string {
  const t = (raw ?? '').trim();
  if (!t) return '';
  return IMPORT_CATEGORY_ALIASES[t.toLowerCase()] ?? t;
}

// Keep the user's imported (Monarch) categories: create any CSV category that
// isn't already one of ours (after alias-normalisation, case-insensitive) so
// honored imports land in their real bucket instead of Miscellaneous. Idempotent.
export function ensureImportedCategories(db: Database.Database, rawCategories: string[]) {
  const activeLower = new Set(
    (db.prepare('SELECT name FROM budget_categories').all() as { name: string }[]).map(r => r.name.toLowerCase())
  );
  let sort = (db.prepare('SELECT COALESCE(MAX(sort),0) AS m FROM budget_categories').get() as { m: number }).m;
  const ins = db.prepare('INSERT OR IGNORE INTO budget_categories (name, sort, emoji) VALUES (?, ?, ?)');
  for (const raw of rawCategories) {
    const name = normalizeImportedCategory(raw);
    if (!name || activeLower.has(name.toLowerCase())) continue;
    ins.run(name, ++sort, suggestEmoji(name));
    activeLower.add(name.toLowerCase());
  }
}

// Old (flat) category → new (Monarch-style) subcategory. Used by the one-time
// taxonomy migration to remap an existing install's rules, targets and active
// category list to the new scheme.
export const TAXONOMY_MIGRATION: Record<string, string> = {
  Income: 'Other Income', Dining: 'Restaurants & Bars', Transport: 'Gas',
  'Bills & Utilities': 'Gas & Electric', Entertainment: 'Entertainment & Recreation',
  Health: 'Medical', Travel: 'Travel & Vacation', Fees: 'Financial Fees',
  Other: 'Miscellaneous', Home: 'Home Improvement',
  // Groceries, Shopping, Subscriptions, Transfers, Mortgage keep their names.
};

// Retired groups folded into broader ones. The taxonomy default already routes
// non-overridden categories to the new group; the one-time migration remaps any
// explicit per-category `grp` overrides still pointing at a retired group.
export const GROUP_MERGES: Record<string, string> = {
  'Auto & Transport': 'Travel & Lifestyle',
  'Health & Wellness': 'Travel & Lifestyle',
  'Bills & Utilities': 'Housing',
};
