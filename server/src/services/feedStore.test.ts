import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { syncFeedTransactions, readFeedTransactions, type RawTxn } from './feedStore.js';

const DAY = 86400;
const NOW = 1_800_000_000; // fixed unix seconds
const WINDOW_START = NOW - 730 * DAY;

function memDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE transactions (
      id TEXT PRIMARY KEY, account_id TEXT NOT NULL, account_name TEXT NOT NULL,
      source TEXT NOT NULL, posted INTEGER NOT NULL, transacted_at INTEGER,
      amount REAL NOT NULL, payee TEXT NOT NULL DEFAULT '', description TEXT NOT NULL DEFAULT '',
      memo TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return db;
}

const txn = (id: string, posted: number, over: Partial<RawTxn> = {}): RawTxn => ({
  id, posted, transactedAt: null, amount: -10, description: 'd', payee: 'p', memo: '',
  accountId: 'acct-1', accountName: 'Checking', ...over,
});

describe('syncFeedTransactions', () => {
  let db: Database.Database;
  beforeEach(() => { db = memDb(); });

  it('keeps rows that have aged out of the provider window (the durability fix)', () => {
    // Day 1: the payload still contains an old transaction near the window edge.
    const oldTxn = txn('old', WINDOW_START + DAY);
    syncFeedTransactions(db, 'plaid', [oldTxn, txn('new', NOW - DAY)], WINDOW_START);

    // Much later: the provider window has moved past 'old', so the payload no
    // longer includes it. It must survive — that history is otherwise lost.
    const laterWindowStart = WINDOW_START + 90 * DAY;
    syncFeedTransactions(db, 'plaid', [txn('new', NOW - DAY)], laterWindowStart);

    expect(readFeedTransactions(db).map(t => t.id)).toEqual(['old', 'new']);
  });

  it('removes in-window rows the payload no longer contains (reversed pending charges)', () => {
    syncFeedTransactions(db, 'plaid', [txn('keep', NOW - DAY), txn('reversed', NOW - DAY)], WINDOW_START);
    syncFeedTransactions(db, 'plaid', [txn('keep', NOW - DAY)], WINDOW_START);
    expect(readFeedTransactions(db).map(t => t.id)).toEqual(['keep']);
  });

  it('never reconciles into accounts absent from the payload', () => {
    syncFeedTransactions(db, 'plaid', [txn('other-acct', NOW - DAY, { accountId: 'acct-2' })], WINDOW_START);
    // A payload for acct-1 only (e.g. another item's feed): acct-2 rows untouched.
    syncFeedTransactions(db, 'plaid', [txn('acct-1-row', NOW - DAY)], WINDOW_START);
    expect(readFeedTransactions(db).map(t => t.id)).toEqual(['other-acct', 'acct-1-row']);
  });

  it('refreshes provider-amended fields in place', () => {
    syncFeedTransactions(db, 'plaid', [txn('t', NOW - DAY, { amount: -10, payee: 'PENDING FOO' })], WINDOW_START);
    syncFeedTransactions(db, 'plaid', [txn('t', NOW - DAY, { amount: -12.5, payee: 'FOO STORE' })], WINDOW_START);
    const [t] = readFeedTransactions(db);
    expect(t.amount).toBe(-12.5);
    expect(t.payee).toBe('FOO STORE');
  });

  it('preserves insertion order across syncs', () => {
    syncFeedTransactions(db, 'plaid', [txn('a', NOW - 3 * DAY)], WINDOW_START);
    syncFeedTransactions(db, 'plaid', [txn('b', NOW - 5 * DAY, { accountId: 'acct-2' })], WINDOW_START);
    syncFeedTransactions(db, 'plaid', [txn('a', NOW - 3 * DAY), txn('c', NOW - DAY)], WINDOW_START);
    expect(readFeedTransactions(db).map(t => t.id)).toEqual(['a', 'b', 'c']);
  });
});
