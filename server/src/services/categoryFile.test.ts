import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { parseCategoryFile, serializeCategoryFile, taxonomyFromDb } from './categoryFile.js';
import { DEFAULT_TAXONOMY } from './taxonomy.js';
import { runMigrations } from '../db/migrations.js';

const file = (groups: unknown) => JSON.stringify({ version: 1, groups });
const allSystem = [
  { name: 'Income', categories: ['Paychecks', 'Other Income', 'Dividends & Capital Gains'] },
  { name: 'Other', categories: ['Transfers', 'Credit Card Payment', 'Miscellaneous'] },
];

describe('parseCategoryFile', () => {
  it('accepts bare names and objects, fills emoji and color, keeps hints', () => {
    const r = parseCategoryFile(file([
      ...allSystem,
      { name: 'Food', color: '#f472b6', categories: ['Groceries', { name: 'Takeout', emoji: '🥡', hint: 'Delivery apps' }] },
      { name: 'Pets', categories: ['Vet'] },
    ]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
    const food = r.taxonomy.find(g => g.name === 'Food')!;
    expect(food.categories).toEqual([{ name: 'Groceries', emoji: '🛒' }, { name: 'Takeout', emoji: '🥡', hint: 'Delivery apps' }]);
    expect(r.taxonomy.find(g => g.name === 'Pets')!.color).toBe('#94a3b8');
  });

  it('rejects invalid files with a clear reason', () => {
    const bad: [string, RegExp][] = [
      ['{nope', /Not valid JSON/],
      [JSON.stringify({ version: 2, groups: allSystem }), /"version" must be 1/],
      [JSON.stringify({ version: 1, groups: [] }), /non-empty list/],
      [file([...allSystem, { name: 'A', categories: ['Gym'] }, { name: 'B', categories: ['gym'] }]), /"gym" appears more than once/],
      [file([...allSystem, { name: 'Other', categories: [] }]), /Group "Other" appears twice/],
      [file([...allSystem, { name: 'A', color: 'red', categories: [] }]), /invalid "color"/],
      [file([...allSystem, { name: 'A', categories: ['x'.repeat(31)] }]), /longer than 30/],
      [file([...allSystem, { name: 'A', categories: [{ name: 'Gym', hint: 5 }] }]), /"hint" must be text/],
      [file([...allSystem, { name: 'A', categories: [{ emoji: '🏋️' }] }]), /category with no "name"/],
    ];
    for (const [text, re] of bad) {
      const r = parseCategoryFile(text);
      expect(r.ok, text).toBe(false);
      if (!r.ok) expect(r.error).toMatch(re);
    }
  });

  it('accepts aliases, and rejects an alias that is also a category or belongs to two', () => {
    const ok = parseCategoryFile(file([...allSystem, { name: 'Food', categories: [{ name: 'Food Shopping', aliases: ['Groceries', ' groceries '] }] }]));
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.taxonomy.find(g => g.name === 'Food')!.categories[0].aliases).toEqual(['Groceries', 'groceries']);
    const clash = parseCategoryFile(file([...allSystem, { name: 'Food', categories: ['Groceries', { name: 'Food Shopping', aliases: ['groceries'] }] }]));
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.error).toMatch(/both a category and an alias/);
    const twice = parseCategoryFile(file([...allSystem, { name: 'Food', categories: [{ name: 'A', aliases: ['X'] }, { name: 'B', aliases: ['x'] }] }]));
    expect(twice.ok).toBe(false);
    const notList = parseCategoryFile(file([...allSystem, { name: 'Food', categories: [{ name: 'A', aliases: 'X' }] }]));
    expect(notList.ok).toBe(false);
  });

  it('adds missing system categories (with a warning) and rejects a mis-cased one', () => {
    const r = parseCategoryFile(file([{ name: 'Food', categories: ['Groceries'] }]));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.taxonomy[0].name).toBe('Income');
    expect(r.taxonomy[0].categories.map(c => c.name)).toEqual(['Paychecks', 'Other Income', 'Dividends & Capital Gains']);
    expect(r.taxonomy.at(-1)!.categories.map(c => c.name)).toEqual(['Transfers', 'Credit Card Payment', 'Miscellaneous']);
    expect(r.warnings).toHaveLength(6);
    const mis = parseCategoryFile(file([{ name: 'Other', categories: ['transfers'] }]));
    expect(mis.ok).toBe(false);
    if (!mis.ok) expect(mis.error).toMatch(/must be spelled "Transfers"/);
  });

  it('round-trips the defaults, and the committed example matches them', () => {
    const r = parseCategoryFile(serializeCategoryFile(DEFAULT_TAXONOMY));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.taxonomy).toEqual(DEFAULT_TAXONOMY); expect(r.warnings).toEqual([]); }
    const example = readFileSync(path.join(__dirname, '../../../categories.example.json'), 'utf8');
    expect(example).toBe(serializeCategoryFile(DEFAULT_TAXONOMY));
  });
});

describe('taxonomyFromDb (first start on an existing database)', () => {
  it('turns old display labels into real names and moves their references', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(`UPDATE budget_categories SET label = 'Food Shopping' WHERE name = 'Groceries'`).run();
    db.prepare(`UPDATE budget_categories SET label = 'Uncategorized' WHERE name = 'Miscellaneous'`).run(); // system: ignored
    db.prepare(`UPDATE budget_categories SET grp = 'Travel & Lifestyle', emoji = '🧺' WHERE name = 'Shopping'`).run();
    db.prepare(`INSERT INTO rules (kind, merchant, category) VALUES ('merchant', 'safeway', 'Groceries')`).run();
    db.prepare(`INSERT INTO budget_targets (category, monthly_limit) VALUES ('Groceries', 600)`).run();

    const t = taxonomyFromDb(db);
    const names = t.flatMap(g => g.categories.map(c => c.name));
    expect(names).toContain('Food Shopping');
    expect(names).not.toContain('Groceries');
    expect(t.flatMap(g => g.categories).find(c => c.name === 'Food Shopping')!.aliases).toEqual(['Groceries']);
    expect(names).toContain('Miscellaneous');
    expect(t.find(g => g.name === 'Travel & Lifestyle')!.categories.find(c => c.name === 'Shopping')!.emoji).toBe('🧺');
    expect(db.prepare(`SELECT category FROM rules WHERE merchant = 'safeway'`).get()).toEqual({ category: 'Food Shopping' });
    expect(db.prepare(`SELECT category FROM budget_targets`).get()).toEqual({ category: 'Food Shopping' });
  });
});

// The file next to a throwaway database, through the real budget service.
describe('category file ↔ database', () => {
  const TMP = mkdtempSync(path.join(tmpdir(), 'persfin-catfile-'));
  const catPath = path.join(TMP, 'categories.json');
  let budget: typeof import('./budget.js');
  let getDb: typeof import('../db/schema.js').getDb;
  let catFile: typeof import('./categoryFile.js');
  let taxonomy: typeof import('./taxonomy.js');

  beforeAll(async () => {
    process.env.DB_PATH = path.join(TMP, 'test.db');
    budget = await import('./budget.js');
    ({ getDb } = await import('../db/schema.js'));
    catFile = await import('./categoryFile.js');
    taxonomy = await import('./taxonomy.js');
    getDb();
  });
  afterAll(() => rmSync(TMP, { recursive: true, force: true }));

  const readFile = () => JSON.parse(readFileSync(catPath, 'utf8')) as { groups: { name: string; categories: { name: string; hint?: string }[] }[] };
  const fileNames = () => readFile().groups.flatMap(g => g.categories.map(c => c.name));
  const writeAndReload = (data: unknown) => { writeFileSync(catPath, typeof data === 'string' ? data : JSON.stringify(data)); return catFile.reloadCategoryFile(getDb()); };

  it('creates the file next to the database on first start', () => {
    expect(existsSync(catPath)).toBe(true);
    expect(fileNames()).toEqual(DEFAULT_TAXONOMY.flatMap(g => g.categories.map(c => c.name)));
    expect(budget.getActiveCategories()).toEqual(fileNames());
  });

  it('in-app add / move / rename / remove write the file and keep references', async () => {
    const pets = budget.addCategory('Pets');
    expect(readFile().groups.find(g => g.name === 'Custom')!.categories.map(c => c.name)).toEqual(['Pets']);

    budget.setCategoryGroup(pets, 'Household');
    expect(readFile().groups.find(g => g.name === 'Household')!.categories.map(c => c.name)).toEqual(['Pets']);

    await budget.applyCategoryRule('chewy', 'Pets', 'one');
    budget.setTarget('Pets', 80);
    budget.renameCategory('Pets', 'Pet Care');
    expect(fileNames()).toContain('Pet Care');
    expect(fileNames()).not.toContain('Pets');
    const db = getDb();
    expect(db.prepare(`SELECT category FROM rules WHERE merchant = 'chewy'`).get()).toEqual({ category: 'Pet Care' });
    expect(db.prepare(`SELECT category FROM budget_targets WHERE category = 'Pet Care'`).get()).toBeTruthy();

    expect(readFile().groups.flatMap(g => g.categories).find(c => c.name === 'Pet Care')).toMatchObject({ aliases: ['Pets'] });

    budget.renameCategory('Miscellaneous', 'Stuff'); // system categories keep their names
    expect(fileNames()).toContain('Miscellaneous');

    budget.removeCategory('Pet Care');
    expect(fileNames()).not.toContain('Pet Care');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM rules WHERE category = 'Pet Care'`).get()).toEqual({ n: 0 });
    budget.removeCategory('Transfers'); // system: can't be removed
    expect(fileNames()).toContain('Transfers');
  });

  it('keeps hints through in-app edits', () => {
    budget.renameCategory('Groceries', undefined, '🥦');
    const groceries = readFile().groups.flatMap(g => g.categories).find(c => c.name === 'Groceries')!;
    expect(groceries.hint).toBe('Supermarkets, warehouse clubs and food markets');
  });

  it('applies an edited file: a removed category loses its rules and target, with a warning', async () => {
    budget.addCategory('Hobbies');
    await budget.applyCategoryRule('michaels', 'Hobbies', 'one');
    budget.setTarget('Hobbies', 50);
    getDb().prepare(`INSERT INTO imported_txns (id, date, amount, payee, merchant, account, category) VALUES ('imp-h', '2026-05-01', -12, 'Craft', 'craft', 'Card', 'Hobbies')`).run();

    const data = readFile();
    for (const g of data.groups) g.categories = g.categories.filter(c => c.name !== 'Hobbies');
    data.groups.push({ name: 'Learning', categories: [{ name: 'Courses', hint: 'Online classes' }] });
    const r = writeAndReload(data);

    expect(r.error).toBeNull();
    expect(r.warnings).toEqual([
      'Removed the category "Hobbies": 1 rule deleted, its budget target deleted, 1 imported transaction moved to Miscellaneous.',
    ]);
    expect(budget.getActiveCategories()).toContain('Courses');
    expect(budget.getActiveCategories()).not.toContain('Hobbies');
    expect(getDb().prepare(`SELECT category FROM imported_txns WHERE id = 'imp-h'`).get()).toEqual({ category: 'Miscellaneous' });
    expect(taxonomy.getTaxonomy().find(g => g.name === 'Learning')!.categories[0].hint).toBe('Online classes');
  });

  it('never applies an invalid file', () => {
    const before = budget.getActiveCategories();
    const good = readFileSync(catPath, 'utf8');
    const r = writeAndReload('{ "version": 1, "groups": [ broken');
    expect(r.error).toMatch(/Not valid JSON/);
    expect(budget.getActiveCategories()).toEqual(before);
    expect(catFile.getCategoryFileReport().error).toMatch(/Not valid JSON/);
    expect(writeAndReload(good).error).toBeNull(); // fixing the file applies it again
  });

  it('counts categories in the Income group as income', () => {
    const data = readFile();
    data.groups.find(g => g.name === 'Income')!.categories.push({ name: 'Side Gig' });
    expect(writeAndReload(data).error).toBeNull();
    expect(taxonomy.isIncomeCategory('Side Gig')).toBe(true);
    expect(taxonomy.isIncomeCategory('Groceries')).toBe(false);
    expect(taxonomy.isIncomeCategory('Paychecks')).toBe(true);
  });

  it('undo restores the file and the rules from a snapshot', async () => {
    const snap = budget.getCategoryState();
    budget.addCategory('Temporary');
    await budget.applyCategoryRule('tempshop', 'Temporary', 'one');
    budget.restoreCategoryState(snap);
    expect(fileNames()).not.toContain('Temporary');
    expect(fileNames()).toContain('Side Gig');
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM rules WHERE merchant = 'tempshop'`).get()).toEqual({ n: 0 });
  });

  it('categorizes by the new name after renaming a built-in category', async () => {
    const { seedPlaidItem } = await import('../db/plaidSeed.js');
    seedPlaidItem(getDb(), 'alias-item', [{
      id: 'alias-card', org: 'Bank', name: 'Visa Card', balance: -50, category: 'credit',
      transactions: [{ id: 'alias-t1', posted: Math.floor(Date.parse('2026-05-04T12:00:00Z') / 1000), amount: -42.1, payee: 'WHOLE FOODS MARKET', description: 'WHOLE FOODS MARKET' }],
    }]);
    const catOf = async () => (await budget.getCategorizedTransactions()).find(t => t.id === 'alias-t1')!.category;
    expect(await catOf()).toBe('Groceries');
    budget.renameCategory('Groceries', 'Food Shopping');
    expect(await catOf()).toBe('Food Shopping');
    expect(budget.getCategoryLabeler().canon('Groceries')).toBe('Food Shopping');
    budget.addCategory('groceries'); // the old name now points at the renamed category
    expect(fileNames()).not.toContain('groceries');
    budget.renameCategory('Food Shopping', 'Groceries'); // renaming back drops the alias
    expect(readFile().groups.flatMap(g => g.categories).find(c => c.name === 'Groceries')).toMatchObject({ aliases: ['Food Shopping'] });
    expect(await catOf()).toBe('Groceries');
  });

  it('reset writes the built-in defaults', () => {
    budget.resetCategoriesToDefault();
    expect(fileNames()).toEqual(DEFAULT_TAXONOMY.flatMap(g => g.categories.map(c => c.name)));
  });
});
