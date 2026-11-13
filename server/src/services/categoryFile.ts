import type Database from 'better-sqlite3';
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, watchFile } from 'fs';
import path from 'path';
import {
  DEFAULT_TAXONOMY, SYSTEM_CATEGORIES, SYSTEM_INCOME_CATEGORIES, SYSTEM_OTHER_CATEGORIES,
  INCOME_GROUP, OTHER_GROUP, CUSTOM_GROUP, FALLBACK_GROUP_COLOR,
  setTaxonomy, suggestEmoji, type CatGroup, type CatDef,
} from './taxonomy.js';

// The owner's personal category file — the source of truth for the category
// list. It lives next to the database (data/categories.json by default; data/ is
// git-ignored, so it is never committed) or at KEVFIN_CATEGORIES_PATH.
//
//   { "version": 1,
//     "groups": [ { "name": "Food & Dining", "color": "#f472b6",
//                   "categories": [ { "name": "Groceries", "emoji": "🛒",
//                                     "hint": "Supermarkets, Costco" } ] } ] }
//
// A category may also be written as a bare string ("Groceries"). The order of
// groups and categories in the file is the order the app uses.
//
// The budget_categories table is a cache of this file: after every load the
// table is made to match it. A category that disappears from the file is
// removed the same way the app removes one — its budget target and
// categorization rules are deleted, so its transactions fall back to automatic
// categorization, and imported rows that carried it move to Miscellaneous —
// and the sync reports a warning saying what was affected. Renames made in the
// app rewrite the file AND move every reference, so nothing is lost; renaming a
// category by editing the file counts as remove + add.
//
// An invalid file is never applied: the app keeps the categories it has and
// reports the error. Everything here takes the db handle explicitly, so the
// schema module can call it without an import cycle (schema → here).

type Db = Database.Database;

export const CATEGORY_FILE_VERSION = 1;
const MAX_CATEGORY_NAME = 30;
const MAX_GROUP_NAME = 40;
const MAX_HINT = 300;
const FALLBACK = 'Miscellaneous';

export interface CategoryFileReport {
  path: string;
  loadedAt: string | null;
  error: string | null;     // why the file was not applied (null = applied)
  warnings: string[];       // what the last load changed or fixed
}

// --- parse / validate (pure) ---------------------------------------------------

export type ParseResult =
  | { ok: true; taxonomy: CatGroup[]; warnings: string[] }
  | { ok: false; error: string };

const HEX = /^#[0-9a-fA-F]{6}$/;
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

export function parseCategoryFile(text: string): ParseResult {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch (e) { return { ok: false, error: `Not valid JSON: ${(e as Error).message}` }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'The file must be a JSON object.' };
  const obj = raw as { version?: unknown; groups?: unknown };
  if (obj.version !== CATEGORY_FILE_VERSION) return { ok: false, error: `"version" must be ${CATEGORY_FILE_VERSION}.` };
  if (!Array.isArray(obj.groups) || obj.groups.length === 0) return { ok: false, error: '"groups" must be a non-empty list.' };

  const warnings: string[] = [];
  const groupNames = new Set<string>();
  const catNames = new Map<string, string>(); // lower-case → as written
  const taxonomy: CatGroup[] = [];

  for (const [gi, g] of (obj.groups as unknown[]).entries()) {
    const where = `group ${gi + 1}`;
    if (!g || typeof g !== 'object') return { ok: false, error: `${where} must be an object.` };
    const gr = g as { name?: unknown; color?: unknown; categories?: unknown };
    const name = str(gr.name);
    if (!name) return { ok: false, error: `${where} has no "name".` };
    if (name.length > MAX_GROUP_NAME) return { ok: false, error: `Group "${name}" is longer than ${MAX_GROUP_NAME} characters.` };
    if (groupNames.has(name.toLowerCase())) return { ok: false, error: `Group "${name}" appears twice.` };
    groupNames.add(name.toLowerCase());
    const color = str(gr.color);
    if (color && !HEX.test(color)) return { ok: false, error: `Group "${name}" has an invalid "color" (use #rrggbb).` };
    if (gr.categories !== undefined && !Array.isArray(gr.categories)) return { ok: false, error: `Group "${name}": "categories" must be a list.` };

    const categories: CatDef[] = [];
    for (const c of (gr.categories as unknown[] | undefined) ?? []) {
      const cat = typeof c === 'string' ? { name: c } : c;
      if (!cat || typeof cat !== 'object') return { ok: false, error: `Group "${name}" has a category that is not a name or an object.` };
      const cc = cat as { name?: unknown; emoji?: unknown; hint?: unknown; aliases?: unknown };
      const cname = str(cc.name);
      if (!cname) return { ok: false, error: `Group "${name}" has a category with no "name".` };
      if (cname.length > MAX_CATEGORY_NAME) return { ok: false, error: `Category "${cname}" is longer than ${MAX_CATEGORY_NAME} characters.` };
      const dup = catNames.get(cname.toLowerCase());
      if (dup) return { ok: false, error: `Category "${cname}" appears more than once (also as "${dup}").` };
      catNames.set(cname.toLowerCase(), cname);
      if (cc.hint !== undefined && typeof cc.hint !== 'string') return { ok: false, error: `Category "${cname}": "hint" must be text.` };
      const hint = str(cc.hint);
      if (hint.length > MAX_HINT) return { ok: false, error: `Category "${cname}": "hint" is longer than ${MAX_HINT} characters.` };
      if (cc.aliases !== undefined && (!Array.isArray(cc.aliases) || cc.aliases.some(a => typeof a !== 'string'))) {
        return { ok: false, error: `Category "${cname}": "aliases" must be a list of names.` };
      }
      const aliases = [...new Set(((cc.aliases as string[] | undefined) ?? []).map(a => a.trim()).filter(Boolean))];
      const emoji = str(cc.emoji) || suggestEmoji(cname);
      const def: CatDef = { name: cname, emoji };
      if (hint) def.hint = hint;
      if (aliases.length) def.aliases = aliases;
      categories.push(def);
    }
    taxonomy.push({ name, color: color || FALLBACK_GROUP_COLOR, categories });
  }

  // An alias may not also be a category name or another category's alias.
  const aliasOwner = new Map<string, string>();
  for (const g of taxonomy) for (const c of g.categories) for (const a of c.aliases ?? []) {
    const k = a.toLowerCase();
    if (catNames.has(k)) return { ok: false, error: `"${a}" is both a category and an alias of "${c.name}".` };
    const other = aliasOwner.get(k);
    if (other && other !== c.name) return { ok: false, error: `"${a}" is an alias of both "${other}" and "${c.name}".` };
    aliasOwner.set(k, c.name);
  }

  // System categories are required by the budget logic: add any that are missing.
  const defaultsByName = new Map(DEFAULT_TAXONOMY.flatMap(g => g.categories.map(c => [c.name, c] as const)));
  const ensureGroup = (gname: string, atStart: boolean): CatGroup => {
    let grp = taxonomy.find(x => x.name === gname);
    if (!grp) {
      grp = { name: gname, color: DEFAULT_TAXONOMY.find(x => x.name === gname)?.color ?? FALLBACK_GROUP_COLOR, categories: [] };
      if (atStart) taxonomy.unshift(grp); else taxonomy.push(grp);
    }
    return grp;
  };
  for (const [list, gname, atStart] of [[SYSTEM_INCOME_CATEGORIES, INCOME_GROUP, true], [SYSTEM_OTHER_CATEGORIES, OTHER_GROUP, false]] as const) {
    for (const sys of list) {
      const existing = catNames.get(sys.toLowerCase());
      if (existing === sys) continue;
      if (existing) return { ok: false, error: `"${existing}" must be spelled "${sys}" (it is a system category).` };
      ensureGroup(gname, atStart).categories.push({ ...defaultsByName.get(sys)! });
      catNames.set(sys.toLowerCase(), sys);
      warnings.push(`Added the system category "${sys}", which the file left out.`);
    }
  }
  return { ok: true, taxonomy, warnings };
}

// File text for a taxonomy: categories without a hint are written compactly.
export function serializeCategoryFile(taxonomy: CatGroup[]): string {
  const groups = taxonomy.map(g => ({
    name: g.name,
    color: g.color,
    categories: g.categories.map(c => ({
      name: c.name, emoji: c.emoji,
      ...(c.hint ? { hint: c.hint } : {}),
      ...(c.aliases?.length ? { aliases: c.aliases } : {}),
    })),
  }));
  return JSON.stringify({ version: CATEGORY_FILE_VERSION, groups }, null, 2) + '\n';
}

// --- DB side -----------------------------------------------------------------

// Move every reference from one category name to another: rules, the budget
// target, imported rows and the cached category row. Used for in-app renames.
export function renameCategoryReferences(db: Db, from: string, to: string): void {
  db.transaction(() => {
    db.prepare('UPDATE rules SET category = ? WHERE category = ?').run(to, from);
    db.prepare('UPDATE OR REPLACE budget_targets SET category = ? WHERE category = ?').run(to, from);
    db.prepare('UPDATE imported_txns SET category = ? WHERE category = ?').run(to, from);
    db.prepare('UPDATE OR REPLACE budget_categories SET name = ?, label = NULL WHERE name = ?').run(to, from);
  })();
}

// Make budget_categories match the taxonomy. Returns warnings for removed
// categories that still had a target, rules or imported rows.
export function applyTaxonomyToDb(db: Db, taxonomy: CatGroup[]): string[] {
  const names = taxonomy.flatMap(g => g.categories.map(c => c.name));
  const keep = new Set(names);
  const warnings: string[] = [];
  db.transaction(() => {
    const cached = (db.prepare('SELECT name FROM budget_categories').all() as { name: string }[]).map(r => r.name);
    for (const name of cached) {
      if (keep.has(name)) continue;
      const rules = db.prepare(`DELETE FROM rules WHERE kind IN ('merchant', 'base', 'smart') AND category = ?`).run(name).changes;
      const targets = db.prepare('DELETE FROM budget_targets WHERE category = ?').run(name).changes;
      const imported = db.prepare('UPDATE imported_txns SET category = ? WHERE category = ?').run(FALLBACK, name).changes;
      db.prepare('DELETE FROM budget_categories WHERE name = ?').run(name);
      const parts = [
        rules ? `${rules} rule${rules === 1 ? '' : 's'} deleted` : '',
        targets ? 'its budget target deleted' : '',
        imported ? `${imported} imported transaction${imported === 1 ? '' : 's'} moved to ${FALLBACK}` : '',
      ].filter(Boolean);
      if (parts.length) warnings.push(`Removed the category "${name}": ${parts.join(', ')}.`);
    }
    // The file is the truth for names, order, emoji and groups: clear the old
    // per-row overrides and write the file order.
    const upsert = db.prepare(`
      INSERT INTO budget_categories (name, sort, label, emoji, grp) VALUES (?, ?, NULL, NULL, NULL)
      ON CONFLICT(name) DO UPDATE SET sort = excluded.sort, label = NULL, emoji = NULL, grp = NULL
    `);
    names.forEach((n, i) => upsert.run(n, i));
  })();
  return warnings;
}

// Build a taxonomy from the cached category rows, for the first start (no file
// yet). Display labels from the old rename feature become real names: each
// labelled category's references are moved to the label first. System
// categories keep their names.
export function taxonomyFromDb(db: Db): CatGroup[] {
  const rows = db.prepare('SELECT name, label, emoji, grp FROM budget_categories ORDER BY sort, name')
    .all() as { name: string; label: string | null; emoji: string | null; grp: string | null }[];
  const defaultGroup = new Map(DEFAULT_TAXONOMY.flatMap(g => g.categories.map(c => [c.name, g.name] as const)));
  const defaultEmoji = new Map(DEFAULT_TAXONOMY.flatMap(g => g.categories.map(c => [c.name, c.emoji] as const)));
  const defaultHint = new Map(DEFAULT_TAXONOMY.flatMap(g => g.categories.filter(c => c.hint).map(c => [c.name, c.hint!] as const)));
  const taken = new Set(rows.map(r => r.name.toLowerCase()));
  const groups = new Map<string, CatDef[]>();
  for (const r of rows) {
    let name = r.name;
    const label = r.label?.trim().slice(0, MAX_CATEGORY_NAME);
    if (label && label !== name && !SYSTEM_CATEGORIES.has(name) && !taken.has(label.toLowerCase())) {
      renameCategoryReferences(db, name, label);
      taken.add(label.toLowerCase());
      name = label;
    }
    const g = r.grp?.trim() || defaultGroup.get(r.name) || CUSTOM_GROUP;
    const list = groups.get(g) ?? [];
    const hint = name === r.name ? defaultHint.get(r.name) : undefined;
    const emoji = r.emoji || defaultEmoji.get(r.name) || suggestEmoji(name);
    const def: CatDef = { name, emoji };
    if (hint) def.hint = hint;
    if (name !== r.name) def.aliases = [r.name]; // automatic categorization still produces the old name
    list.push(def);
    groups.set(g, list);
  }
  // Groups in default order, then any others, then Custom.
  const order = DEFAULT_TAXONOMY.map(g => g.name);
  const rank = (g: string) => (g === CUSTOM_GROUP ? 1e6 : order.includes(g) ? order.indexOf(g) : 1e5);
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([name, categories]) => ({ name, color: DEFAULT_TAXONOMY.find(x => x.name === name)?.color ?? FALLBACK_GROUP_COLOR, categories }));
}

// --- file I/O ----------------------------------------------------------------

let filePath = '';
let lastText: string | null = null;
let watching = '';
let report: CategoryFileReport = { path: '', loadedAt: null, error: null, warnings: [] };

export function categoryFilePath(dbPath: string): string {
  return process.env.KEVFIN_CATEGORIES_PATH || path.join(path.dirname(dbPath), 'categories.json');
}
export function getCategoryFileReport(): CategoryFileReport { return report; }

function writeFileAtomic(p: string, text: string): void {
  mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, p); // an editor or the watcher never sees a half-written file
}

// Read the file and apply it. On an invalid file nothing changes and the error
// is reported; the live taxonomy stays as it was.
export function reloadCategoryFile(db: Db): CategoryFileReport {
  let text: string;
  try { text = readFileSync(filePath, 'utf8'); }
  catch (e) { report = { ...report, error: `Can't read the file: ${(e as Error).message}` }; return report; }
  lastText = text;
  const parsed = parseCategoryFile(text);
  if (!parsed.ok) {
    console.error(`[categories] ${filePath} not applied: ${parsed.error}`);
    report = { path: filePath, loadedAt: report.loadedAt, error: parsed.error, warnings: [] };
    return report;
  }
  setTaxonomy(parsed.taxonomy);
  const warnings = [...parsed.warnings, ...applyTaxonomyToDb(db, parsed.taxonomy)];
  for (const w of warnings) console.warn(`[categories] ${w}`);
  report = { path: filePath, loadedAt: new Date().toISOString(), error: null, warnings };
  return report;
}

// Write a taxonomy to the file and apply it (used by the in-app category edits).
export function saveCategoryFile(db: Db, taxonomy: CatGroup[]): CategoryFileReport {
  const text = serializeCategoryFile(taxonomy);
  writeFileAtomic(filePath, text);
  return reloadCategoryFile(db);
}

// Called once per DB open (after migrations): create the file from the current
// categories if it doesn't exist, apply it, and watch it for edits.
export function initCategoryFile(db: Db, dbPath: string, opts: { watch?: boolean } = {}): void {
  filePath = categoryFilePath(dbPath);
  report = { path: filePath, loadedAt: null, error: null, warnings: [] };
  if (!existsSync(filePath)) {
    const fromDb = taxonomyFromDb(db);
    writeFileAtomic(filePath, serializeCategoryFile(fromDb.length ? fromDb : DEFAULT_TAXONOMY));
    console.log(`[categories] created ${filePath}`);
  }
  const r = reloadCategoryFile(db);
  // An invalid file at startup: keep the cached categories as the live taxonomy.
  if (r.error) setTaxonomy(taxonomyFromDb(db));
  if (opts.watch && watching !== filePath) {
    watching = filePath;
    const p = filePath;
    // Polling watch: works across editors that replace the file on save.
    watchFile(p, { interval: 2000 }, () => {
      if (p !== filePath) return;
      let text: string;
      try { text = readFileSync(p, 'utf8'); } catch { return; }
      if (text === lastText) return; // our own write, or no real change
      console.log(`[categories] ${p} changed — reloading`);
      reloadCategoryFile(onReloadDb ? onReloadDb() : db);
    }).unref();
  }
}

// The schema module registers how to get the live db handle (the handle can be
// replaced after a restore), so the watcher never uses a closed one.
let onReloadDb: (() => Db) | null = null;
export function setCategoryDbProvider(fn: () => Db): void { onReloadDb = fn; }
