import { describe, it, expect } from 'vitest';
import type { Holding as PlaidHolding, Security } from 'plaid';
import { holdingsFromPlaid } from './plaid.js';

// Minimal Plaid payload builders: only the fields the mapping reads matter.
const sec = (security_id: string, over: Partial<Security> = {}): Security => ({
  security_id, isin: null, cusip: null, sedol: null, institution_security_id: null, institution_id: null,
  proxy_security_id: null, name: null, ticker_symbol: null, is_cash_equivalent: false, type: 'etf',
  close_price: null, close_price_as_of: null, iso_currency_code: 'USD', unofficial_currency_code: null,
  market_identifier_code: null, option_contract: null, ...over,
} as Security);
const hold = (account_id: string, security_id: string, over: Partial<PlaidHolding> = {}): PlaidHolding => ({
  account_id, security_id, institution_price: 1, institution_value: 100, cost_basis: 80, quantity: 2,
  iso_currency_code: 'USD', unofficial_currency_code: null, ...over,
} as PlaidHolding);

describe('holdingsFromPlaid', () => {
  it('maps ticker, name, value, basis and shares per account', () => {
    const m = holdingsFromPlaid(
      [hold('acct-1', 's-voo', { institution_value: 5000, cost_basis: 4200, quantity: 10 })],
      [sec('s-voo', { ticker_symbol: ' VOO ', name: 'Vanguard S&P 500 ETF' })],
    );
    expect(m.get('acct-1')).toEqual([
      { symbol: 'VOO', description: 'Vanguard S&P 500 ETF', marketValue: 5000, costBasis: 4200, shares: 10, acquired: null },
    ]);
  });

  it('treats a null or non-positive cost basis as unknown, never a fake zero', () => {
    const m = holdingsFromPlaid(
      [hold('a', 's1', { cost_basis: null }), hold('a', 's2', { cost_basis: 0 })],
      [sec('s1', { ticker_symbol: 'MSFT' }), sec('s2', { ticker_symbol: 'NVDA' })],
    );
    expect(m.get('a')!.map(h => h.costBasis)).toEqual([null, null]);
  });

  it('describes a cash position as cash reserves with no ticker or share count', () => {
    const m = holdingsFromPlaid(
      [hold('a', 's-cash', { institution_value: 250, cost_basis: 250, quantity: 250 })],
      [sec('s-cash', { type: 'cash', ticker_symbol: 'CUR:USD', name: 'U S Dollar', is_cash_equivalent: true })],
    );
    expect(m.get('a')).toEqual([
      { symbol: '', description: 'Cash reserves', marketValue: 250, costBasis: 250, shares: null, acquired: null },
    ]);
  });

  it('keeps a holding whose security has no ticker or is missing from the list', () => {
    const m = holdingsFromPlaid(
      [hold('a', 's-cit'), hold('a', 's-unknown')],
      [sec('s-cit', { ticker_symbol: null, name: 'Target Date 2050 CIT' })],
    );
    expect(m.get('a')!.map(h => [h.symbol, h.description])).toEqual([['', 'Target Date 2050 CIT'], ['', '']]);
  });

  it('groups holdings by account', () => {
    const m = holdingsFromPlaid([hold('a', 's'), hold('b', 's'), hold('a', 's')], [sec('s', { ticker_symbol: 'VTI' })]);
    expect(m.get('a')).toHaveLength(2);
    expect(m.get('b')).toHaveLength(1);
  });
});
