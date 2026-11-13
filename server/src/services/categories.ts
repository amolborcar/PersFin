import { getDb } from '../db/schema.js';
import {
  DEFAULT_TAXONOMY, DEFAULT_CATEGORIES, SYSTEM_CATEGORIES, CUSTOM_GROUP, FALLBACK_GROUP_COLOR,
  getTaxonomy, taxonomyGroupOf, taxonomyGroupColor, taxonomyEmoji, suggestEmoji, normalizeImportedCategory, resolveAlias,
  type CatDef, type CatGroup,
} from './taxonomy.js';
import {
  saveCategoryFile, renameCategoryReferences, parseCategoryFile, serializeCategoryFile,
} from './categoryFile.js';

// Category management: the active category list, the labeler applied at output
// boundaries, and the operations behind the manage-categories UI. The personal
// category file (services/categoryFile.ts) is the source of truth: every edit
// here rewrites the file and re-applies it, and budget_categories is its cache.
// budget re-exports everything here so consumers are unchanged.

export const groupColorOf = (g: string): string => taxonomyGroupColor(g);
// A category's group in the file, or "Custom" for one the file doesn't list.
export const defaultGroupOf = (name: string): string => taxonomyGroupOf()[name] ?? CUSTOM_GROUP;

// Group of every active category. Drives the manage UI and the cash-flow Sankey.
export function getCategoryGroupMap(): Record<string, string> {
  const groupOf = taxonomyGroupOf();
  return Object.fromEntries(getActiveCategories().map(c => [c, groupOf[c] ?? CUSTOM_GROUP]));
}

// Picker taxonomy. Each category also carries `canonical` (its stable id, the
// same as its name) and `custom` (not one of the built-in defaults).
export function getCategoryGroups(): (Omit<CatGroup, 'categories'> & { categories: (CatDef & { canonical: string; custom?: boolean })[] })[] {
  const defaults = new Set(DEFAULT_CATEGORIES);
  const groupOf = getCategoryGroupMap();
  const order = getGroupNames();
  // Build from the ACTIVE categories. Categories sort alphabetically within their
  // group; groups follow the file's order.
  const byGroup = new Map<string, (CatDef & { canonical: string; custom?: boolean })[]>();
  for (const c of getActiveCategories()) {
    const g = groupOf[c] ?? CUSTOM_GROUP;
    const arr = byGroup.get(g) ?? [];
    arr.push({ name: c, emoji: taxonomyEmoji(c) ?? suggestEmoji(c), canonical: c, custom: !defaults.has(c) });
    byGroup.set(g, arr);
  }
  for (const arr of byGroup.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
  const names = [...byGroup.keys()].sort((a, b) => {
    const ia = order.indexOf(a), ib = order.indexOf(b);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
  });
  return names.map(g => ({ name: g, color: groupColorOf(g), categories: byGroup.get(g)! }));
}

// The ordered group names for the manage UI's reclassify dropdown (so a category
// can be moved even into a group that's currently empty), plus "Custom".
export function getGroupNames(): string[] {
  const names = getTaxonomy().map(g => g.name);
  return names.includes(CUSTOM_GROUP) ? names : [...names, CUSTOM_GROUP];
}

// System categories can't be removed or renamed (see taxonomy.ts).
const PROTECTED = SYSTEM_CATEGORIES;

// Names are the ids now (in-app renames move every reference), so labels are the
// identity; `canon` also maps an alias (e.g. a built-in name the category was
// renamed from) to the current name. Kept as an interface so output boundaries
// stay unchanged.
export interface CategoryLabeler { label: (c: string) => string; canon: (l: string) => string; emoji: (c: string) => string | undefined }
export function getCategoryLabeler(): CategoryLabeler {
  const names = new Set(getTaxonomy().flatMap(g => g.categories.map(c => c.name)));
  return { label: c => c, canon: l => (names.has(l) ? l : resolveAlias(l) ?? l), emoji: c => taxonomyEmoji(c) };
}

export function getActiveCategories(): string[] {
  return (getDb().prepare('SELECT name FROM budget_categories ORDER BY sort, name').all() as { name: string }[]).map(r => r.name);
}

// --- editing the file ----------------------------------------------------------

const clone = (t: CatGroup[]): CatGroup[] => t.map(g => ({ ...g, categories: g.categories.map(c => ({ ...c })) }));
const findCat = (t: CatGroup[], name: string) => {
  for (const g of t) { const i = g.categories.findIndex(c => c.name === name); if (i >= 0) return { g, i }; }
  return null;
};
const findCaseless = (t: CatGroup[], name: string) =>
  t.flatMap(g => g.categories).find(c => c.name.toLowerCase() === name.toLowerCase())?.name;
// The category (other than `except`) that has `name` as an alias, if any.
const aliasOwner = (t: CatGroup[], name: string, except?: string) =>
  t.flatMap(g => g.categories).find(c => c.name !== except && c.aliases?.some(a => a.toLowerCase() === name.toLowerCase()))?.name;
function groupFor(t: CatGroup[], name: string): CatGroup {
  let g = t.find(x => x.name === name);
  if (!g) {
    g = { name, color: DEFAULT_TAXONOMY.find(x => x.name === name)?.color ?? FALLBACK_GROUP_COLOR, categories: [] };
    t.push(g);
  }
  return g;
}
function edit(fn: (t: CatGroup[]) => void): void {
  const t = clone(getTaxonomy());
  fn(t);
  saveCategoryFile(getDb(), t);
}

// Add a new (custom) category to the "Custom" group, auto-picking an emoji from
// its name. Returns the created name, or the existing one if it collides.
export function addCategory(name: string, emoji?: string): string {
  const clean = name.trim().slice(0, 30);
  if (!clean) return '';
  const existing = findCaseless(getTaxonomy(), clean) ?? aliasOwner(getTaxonomy(), clean);
  if (existing) return existing;
  edit(t => { groupFor(t, CUSTOM_GROUP).categories.push({ name: clean, emoji: emoji?.trim() || suggestEmoji(clean) }); });
  return clean;
}

// Categories named in an imported CSV that aren't ours yet (after alias
// normalisation, case-insensitive) are added to "Custom", so honored imports land
// in their real bucket instead of Miscellaneous. Idempotent.
export function addImportedCategories(rawCategories: string[]): void {
  const t = clone(getTaxonomy());
  let changed = false;
  for (const raw of rawCategories) {
    const name = normalizeImportedCategory(raw).slice(0, 30);
    if (!name || findCaseless(t, name) || aliasOwner(t, name)) continue;
    groupFor(t, CUSTOM_GROUP).categories.push({ name, emoji: suggestEmoji(name) });
    changed = true;
  }
  if (changed) saveCategoryFile(getDb(), t);
}

// Rename and/or re-emoji a category. A rename moves every reference (rules,
// target, imported rows) to the new name and keeps the old name as an alias, so
// automatic categorization that still produces it lands here. System
// categories keep their names.
export function renameCategory(name: string, label?: string, emoji?: string) {
  const db = getDb();
  if (!findCat(getTaxonomy(), name)) return;
  let target = name;
  if (label !== undefined) {
    const clean = label.trim().slice(0, 30);
    const clash = clean ? findCaseless(getTaxonomy(), clean) ?? aliasOwner(getTaxonomy(), clean, name) : undefined;
    if (clean && clean !== name && !PROTECTED.has(name) && (!clash || clash === name)) {
      renameCategoryReferences(db, name, clean);
      target = clean;
    }
  }
  edit(t => {
    const at = findCat(t, name)!;
    const cat = at.g.categories[at.i];
    if (target !== name) {
      const keep = (cat.aliases ?? []).filter(a => a.toLowerCase() !== target.toLowerCase());
      if (!keep.some(a => a.toLowerCase() === name.toLowerCase())) keep.push(name);
      cat.aliases = keep;
    }
    cat.name = target;
    if (emoji !== undefined) cat.emoji = emoji.trim() || suggestEmoji(target);
  });
}

// Move a category into another group (created at the end if it doesn't exist).
export function setCategoryGroup(name: string, group: string) {
  const g = group.trim().slice(0, 40);
  if (!g || !findCat(getTaxonomy(), name)) return;
  edit(t => {
    const at = findCat(t, name)!;
    const [cat] = at.g.categories.splice(at.i, 1);
    groupFor(t, g).categories.push(cat);
  });
}

// Remove a category. Applying the file deletes its target and rules (its
// transactions fall back to automatic categorization) and moves imported rows
// that carried it to Miscellaneous.
export function removeCategory(name: string) {
  if (PROTECTED.has(name) || !findCat(getTaxonomy(), name)) return;
  edit(t => { const at = findCat(t, name)!; at.g.categories.splice(at.i, 1); });
}

// --- Category management: snapshot / undo / reset ---------------------------
// A full snapshot of everything the manage-categories UI can touch: the category
// file's taxonomy, plus the targets and rules that reference categories.
// Captured when the panel opens so "Undo changes" can restore it losslessly.
export interface CategoryState {
  taxonomy?: CatGroup[];
  categories: { name: string; sort: number; label: string | null; emoji: string | null; grp: string | null }[];
  targets: { category: string; monthly_limit: number; period: string }[];
  rules: { merchant: string; category: string }[];
  baseRules: { base: string; category: string }[];
  smartRules: { base: string | null; contains: string | null; amount: number | null; category: string }[];
}

export function getCategoryState(): CategoryState {
  const db = getDb();
  return {
    taxonomy: clone(getTaxonomy()),
    categories: db.prepare('SELECT name, sort, label, emoji, grp FROM budget_categories ORDER BY sort, name').all() as CategoryState['categories'],
    targets: db.prepare('SELECT category, monthly_limit, period FROM budget_targets').all() as CategoryState['targets'],
    rules: db.prepare(`SELECT merchant, category FROM rules WHERE kind = 'merchant'`).all() as CategoryState['rules'],
    baseRules: db.prepare(`SELECT base, category FROM rules WHERE kind = 'base'`).all() as CategoryState['baseRules'],
    smartRules: db.prepare(`SELECT base, contains, amount, category FROM rules WHERE kind = 'smart' ORDER BY id`).all() as CategoryState['smartRules'],
  };
}

// The taxonomy a snapshot describes: its own (validated), or — for a snapshot
// without one — its category names placed in their current groups.
function snapshotTaxonomy(s: CategoryState): CatGroup[] {
  if (Array.isArray(s.taxonomy)) {
    const parsed = parseCategoryFile(serializeCategoryFile(s.taxonomy));
    if (parsed.ok) return parsed.taxonomy;
  }
  const groupOf = taxonomyGroupOf();
  const t: CatGroup[] = [];
  for (const c of [...(s.categories ?? [])].sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))) {
    if (!c?.name?.trim()) continue;
    groupFor(t, groupOf[c.name] ?? CUSTOM_GROUP).categories.push({ name: c.name, emoji: taxonomyEmoji(c.name) ?? suggestEmoji(c.name) });
  }
  return t;
}

// Replace the category file, targets and rules with a previously-captured snapshot.
export function restoreCategoryState(s: CategoryState) {
  const db = getDb();
  saveCategoryFile(db, snapshotTaxonomy(s));
  db.transaction(() => {
    db.prepare('DELETE FROM budget_targets').run();
    // Sign-flip rules aren't part of the snapshot (they never were) — only the
    // category-bearing kinds are replaced.
    db.prepare(`DELETE FROM rules WHERE kind IN ('merchant', 'base', 'smart')`).run();
    const it = db.prepare('INSERT OR REPLACE INTO budget_targets (category, monthly_limit, period) VALUES (?, ?, ?)');
    for (const t of s.targets ?? []) it.run(t.category, t.monthly_limit, t.period === 'annual' ? 'annual' : 'monthly');
    const ir = db.prepare(`INSERT OR REPLACE INTO rules (kind, merchant, category) VALUES ('merchant', ?, ?)`);
    for (const r of s.rules ?? []) ir.run(r.merchant, r.category);
    const ib = db.prepare(`INSERT OR REPLACE INTO rules (kind, base, category) VALUES ('base', ?, ?)`);
    for (const r of s.baseRules ?? []) ib.run(r.base, r.category);
    const is = db.prepare(`INSERT INTO rules (kind, base, contains, amount, category) VALUES ('smart', ?, ?, ?, ?)`);
    for (const r of s.smartRules ?? []) is.run(r.base ?? null, r.contains ?? null, r.amount ?? null, r.category);
  })();
}

// Reset the category file to the built-in defaults, removing custom categories.
// Budgets and rules for surviving (default) categories are kept; those that
// pointed at removed categories are removed with them.
export function resetCategoriesToDefault() {
  saveCategoryFile(getDb(), clone(DEFAULT_TAXONOMY));
}
