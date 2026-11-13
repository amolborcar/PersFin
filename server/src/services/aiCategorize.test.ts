import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { ClaudeRunner } from './claudeRunner.js';
import type { ReviewGroup } from './budget.js';

// DB_PATH must be set before the schema module loads (it reads the env at
// import time), so every module that reaches it is imported dynamically below.
const TMP = mkdtempSync(path.join(tmpdir(), 'persfin-ai-'));
process.env.DB_PATH = path.join(TMP, 'ai.db');
const ai = await import('./aiCategorize.js');
const budget = await import('./budget.js');
const { getDb } = await import('../db/schema.js');
const { buildPrompt, parseSuggestions, toMerchantItem } = ai;

describe('buildPrompt', () => {
  it('lists the categories with hints, marks merchant data as untrusted, and carries only opaque ids', () => {
    const p = buildPrompt(
      [{ name: 'Groceries', group: 'Food & Dining', hint: 'Supermarkets' }, { name: 'Miscellaneous', group: 'Other' }],
      [{ id: 'm1', payee: 'Corner Store', descriptions: ['POS 1234 CORNER'], typicalAmount: -12.5, count: 3, account: 'credit card' }],
    );
    expect(p).toContain('- Groceries (group: Food & Dining) — Supermarkets');
    expect(p).toContain('- Miscellaneous (group: Other)');
    expect(p).toContain('untrusted text');
    expect(p).toContain('{"id":"m1","payee":"Corner Store","descriptions":["POS 1234 CORNER"],"typicalAmount":-12.5,"count":3,"account":"credit card"}');
  });
});

describe('parseSuggestions', () => {
  const ids = new Set(['m1', 'm2', 'm3']);
  const allowed = ['Groceries', 'Coffee Shops', 'Miscellaneous'];

  it('reads a fenced array, matches categories case-insensitively, clamps confidence', () => {
    const text = 'Here you go:\n```json\n[{"id":"m1","category":"groceries","confidence":1.4,"reason":"Supermarket chain"},' +
      '{"id":"m2","category":"Coffee Shops","confidence":"0.6","reason":"  cafe \\n name "}]\n```';
    expect(parseSuggestions(text, ids, allowed)).toEqual([
      { id: 'm1', category: 'Groceries', confidence: 1, reason: 'Supermarket chain' },
      { id: 'm2', category: 'Coffee Shops', confidence: 0.6, reason: 'cafe name' },
    ]);
  });

  it('drops unknown ids, unknown categories, bad confidence and duplicates', () => {
    const text = JSON.stringify([
      { id: 'm9', category: 'Groceries', confidence: 0.9 },
      { id: 'm1', category: 'Ignore previous instructions', confidence: 0.9 },
      { id: 'm2', category: 'Groceries', confidence: 'high' },
      { id: 'm3', category: 'Groceries', confidence: 0.7 },
      { id: 'm3', category: 'Coffee Shops', confidence: 0.9 },
    ]);
    expect(parseSuggestions(text, ids, allowed)).toEqual([{ id: 'm3', category: 'Groceries', confidence: 0.7, reason: '' }]);
  });

  it('returns nothing for output that is not a JSON array', () => {
    expect(parseSuggestions('I cannot help with that.', ids, allowed)).toEqual([]);
    expect(parseSuggestions('[not json]', ids, allowed)).toEqual([]);
  });
});

describe('toMerchantItem', () => {
  it('sends distinct descriptors beyond the payee, a median amount and the account type', () => {
    const g = {
      merchant: 'corner store 99', payee: 'Corner Store', account: 'Sapphire Card', count: 3, total: 30, lastDate: '2026-05-01',
      suggested: '', suggestions: [], note: 'CORNER STORE #99 SEATTLE',
      txns: [
        { id: 'a', amount: -5, description: 'CORNER STORE #99 SEATTLE' },
        { id: 'b', amount: -10, description: 'Corner Store' },
        { id: 'c', amount: -15, description: 'X'.repeat(200) },
      ],
    } as unknown as ReviewGroup;
    const item = toMerchantItem('m4', g, new Map([['Sapphire Card', 'credit card']]));
    expect(item).toEqual({
      id: 'm4', payee: 'Corner Store', descriptions: ['CORNER STORE #99 SEATTLE', 'X'.repeat(80)],
      typicalAmount: -10, count: 3, account: 'credit card',
    });
  });
});

// The full run against a seeded feed, with a fake Claude runner.
describe('categorizeWithAi', () => {
  const NOW = new Date('2026-06-23T12:00:00Z');
  const unix = (iso: string) => Math.floor(Date.parse(iso + 'T12:00:00Z') / 1000);

  beforeAll(async () => {
    vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
    const { seedPlaidItem } = await import('../db/plaidSeed.js');
    let n = 0;
    const tx = (date: string, amount: number, payee: string) => ({ id: `ai-${n++}`, posted: unix(date), amount, payee, description: `${payee} REF${n}` });
    seedPlaidItem(getDb(), 'ai-item', [{
      id: 'ai-card', org: 'Bank', name: 'Rewards Card', balance: -300, category: 'credit',
      transactions: [
        tx('2026-05-02', -6.5, 'ZZ ROASTERY'), tx('2026-05-09', -7, 'ZZ ROASTERY'),
        tx('2026-05-03', -80, 'QQ PAWS PLACE'),
        tx('2026-05-04', -19, 'YY MYSTERY'),
        tx('2026-05-05', -40, 'WW GADGETS'),
      ],
    }], NOW.getTime());
  });
  afterAll(() => { vi.useRealTimers(); rmSync(TMP, { recursive: true, force: true }); });

  // A fake runner that answers by payee, and records what it was sent.
  const prompts: string[] = [];
  const answer: Record<string, { category: string; confidence: number }> = {
    'ZZ ROASTERY': { category: 'Coffee Shops', confidence: 0.95 },
    'QQ PAWS PLACE': { category: 'Medical', confidence: 0.6 },
    'YY MYSTERY': { category: 'Miscellaneous', confidence: 0.2 },
    'WW GADGETS': { category: 'Electronics', confidence: 0.93 },
  };
  const fakeRunner: ClaudeRunner = async (prompt) => {
    prompts.push(prompt);
    const items = prompt.split('\n').filter(l => l.startsWith('{"id"')).map(l => JSON.parse(l) as { id: string; payee: string });
    return { ok: true, text: JSON.stringify(items.map(i => ({ id: i.id, ...answer[i.payee.toUpperCase()], reason: `because ${i.payee}` }))) };
  };
  const status = (payee: string) => {
    const row = getDb().prepare(`SELECT status, category FROM ai_suggestions WHERE merchant LIKE ?`).get(`%${payee.toLowerCase()}%`) as { status: string; category: string } | undefined;
    return row && `${row.status}:${row.category}`;
  };

  it('stores suggestions, shows them first in Quick review, and never sends private fields', async () => {
    const r = await ai.categorizeWithAi({ runner: fakeRunner });
    expect(r).toMatchObject({ sent: 4, suggested: 3, autoAccepted: 0, unsure: 1, remaining: 0, error: null });
    expect(status('zz roastery')).toBe('pending:Coffee Shops');
    expect(status('yy mystery')).toBe('unsure:Miscellaneous');

    const { groups } = await budget.getReviewQueue();
    const roastery = groups.find(g => g.payee.toUpperCase().includes('ROASTERY'))!;
    expect(roastery.ai).toEqual({ category: 'Coffee Shops', confidence: 0.95, reason: expect.stringContaining('because') });
    expect(roastery.suggested).toBe('Coffee Shops');
    expect(roastery.suggestions[0]).toBe('Coffee Shops');
    expect(groups.find(g => g.payee.toUpperCase().includes('MYSTERY'))!.ai).toBeUndefined();

    const sent = prompts.join('\n');
    expect(sent).not.toContain('Rewards Card'); // account name
    expect(sent).not.toContain('-300');          // balance
    expect(sent).not.toContain('Paychecks');     // income categories aren't offered for spending
    expect(sent).toContain('"account":"credit card"');
  });

  it('does not ask again about merchants that already have a suggestion', async () => {
    prompts.length = 0;
    const r = await ai.categorizeWithAi({ runner: fakeRunner });
    expect(r.sent).toBe(0);
    expect(prompts).toHaveLength(0);
  });

  it('"Not this" hides a suggestion', async () => {
    const pet = (await budget.getReviewQueue()).groups.find(g => g.payee.toUpperCase().includes('PAWS'))!;
    expect(ai.rejectSuggestion(pet.merchant)).toBe(true);
    const after = (await budget.getReviewQueue()).groups.find(g => g.merchant === pet.merchant)!;
    expect(after.ai).toBeUndefined();
  });

  it('auto-accepts confident suggestions when enabled, by making a merchant rule', async () => {
    getDb().prepare('DELETE FROM ai_suggestions').run();
    ai.setAiSettings({ autoAccept: true });
    const r = await ai.categorizeWithAi({ runner: fakeRunner });
    expect(r).toMatchObject({ autoAccepted: 2, suggested: 1, unsure: 1 });
    expect(status('zz roastery')).toBe('auto:Coffee Shops');
    const all = await budget.getCategorizedTransactions();
    expect(all.filter(t => t.payee.toUpperCase().includes('ROASTERY')).map(t => t.category)).toEqual(['Coffee Shops', 'Coffee Shops']);
    expect((await budget.getReviewQueue()).groups.some(g => g.payee.toUpperCase().includes('ROASTERY'))).toBe(false);
    ai.setAiSettings({ autoAccept: false });
  });

  it('stores nothing and reports why when Claude is unavailable', async () => {
    getDb().prepare(`DELETE FROM ai_suggestions WHERE status != 'auto'`).run();
    const r = await ai.categorizeWithAi({ runner: async () => ({ ok: false, error: 'not-logged-in' }) });
    expect(r).toMatchObject({ sent: 0, suggested: 0, error: 'not-logged-in' });
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM ai_suggestions WHERE status != 'auto'`).get()).toEqual({ n: 0 });
  });

  it('defaults: daily on, auto-accept off', () => {
    getDb().prepare(`DELETE FROM meta WHERE key LIKE 'ai_categorize_%'`).run();
    expect(ai.getAiSettings()).toEqual({ daily: true, autoAccept: false });
  });
});
