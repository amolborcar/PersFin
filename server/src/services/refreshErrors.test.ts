import { describe, it, expect, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProviderRefreshError, safePlaidReason, safeLabel } from './refreshErrors.js';

// What an AxiosError from Plaid looks like: the secret and access_token ride along
// in err.config, and the message/stack can echo the URL.
const SECRET = 'plaid-secret-XYZ789';
const TOKEN = 'access-production-TOKEN123';
const axiosLike = (status: number, errorCode?: string) => Object.assign(
  new Error(`Request failed with status code ${status} for ${TOKEN}`),
  {
    config: { headers: { 'PLAID-SECRET': SECRET }, data: JSON.stringify({ access_token: TOKEN }) },
    response: { status, data: errorCode ? { error_code: errorCode, error_message: `bad ${TOKEN}` } : {} },
  },
);

describe('safePlaidReason', () => {
  it("returns Plaid's error_code and nothing else from the error", () => {
    const r = safePlaidReason(axiosLike(400, 'ITEM_LOGIN_REQUIRED'));
    expect(r).toBe('ITEM_LOGIN_REQUIRED');
    expect(r).not.toContain(TOKEN);
  });

  it('falls back to the HTTP status, then a generic word', () => {
    expect(safePlaidReason(axiosLike(502))).toBe('HTTP 502');
    expect(safePlaidReason(new Error(`boom ${TOKEN}`))).toBe('error');
    expect(safePlaidReason(null)).toBe('error');
  });

  it('refuses an error_code that is not a plain code', () => {
    expect(safePlaidReason(axiosLike(400, `ITEM ${TOKEN}`))).toBe('HTTP 400');
  });
});

describe('safeLabel', () => {
  it('collapses whitespace/control characters, caps length, and falls back', () => {
    expect(safeLabel('  Chase\n\tBank ', 'x')).toBe('Chase Bank');
    expect(safeLabel('a'.repeat(100), 'x')).toHaveLength(40);
    expect(safeLabel('', 'Plaid item')).toBe('Plaid item');
    expect(safeLabel(null, 'fallback')).toBe('fallback');
  });
});

describe('ProviderRefreshError', () => {
  it('keeps the "N of M" summary message', () => {
    const e = new ProviderRefreshError('Plaid', 3, [{ label: 'Chase', reason: 'ITEM_LOGIN_REQUIRED' }]);
    expect(e.message).toBe('Plaid refresh failed for 1 of 3 item(s)');
  });
});

// --- the real provider aggregates, end to end ---------------------------------

const TMP = mkdtempSync(join(tmpdir(), 'persfin-referr-'));
process.env.DB_PATH = join(TMP, 'referr.db');
process.env.PLAID_CLIENT_ID = 'cid';
process.env.PLAID_SECRET = SECRET;

vi.mock('plaid', async importOriginal => {
  const real = await importOriginal<typeof import('plaid')>();
  class FakePlaid {
    accountsBalanceGet = vi.fn(async (req: { access_token: string }) => {
      if (req.access_token === 'tok-bad') throw axiosLike(400, 'ITEM_LOGIN_REQUIRED');
      return { data: { accounts: [] } };
    });
  }
  return { ...real, PlaidApi: FakePlaid };
});

const { getDb, closeDb } = await import('../db/schema.js');
afterAll(() => { closeDb(); rmSync(TMP, { recursive: true, force: true }); });

describe('refreshAllPlaid', () => {
  it('names the failing institution and its error_code, never the token or secret', async () => {
    const db = getDb();
    const add = db.prepare('INSERT INTO plaid_items (item_id, access_token, institution_name) VALUES (?, ?, ?)');
    add.run('item-1', 'tok-bad', 'Chase');
    add.run('item-2', 'tok-ok', 'Fidelity');
    const { refreshAllPlaid } = await import('./plaid.js');
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const err = await refreshAllPlaid().then(() => null, e => e as ProviderRefreshError);
    expect(err).toBeInstanceOf(ProviderRefreshError);
    expect(err!.failures).toEqual([{ label: 'Chase', reason: 'ITEM_LOGIN_REQUIRED' }]);
    const exposed = JSON.stringify({ m: err!.message, f: err!.failures });
    expect(exposed).not.toContain('tok-bad');
    expect(exposed).not.toContain(TOKEN);
    expect(exposed).not.toContain(SECRET);
  });
});
