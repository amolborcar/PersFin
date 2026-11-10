// Provider-neutral shapes shared by the investment views (allocation,
// performance) and the net-worth backfill. Plaid is the only provider; the
// types live here so consumers don't depend on one provider module's internals.

export interface TxnDelta { date: string; delta: number } // delta = effect on balance

// costBasis is null when the institution doesn't expose it (many do not, or
// send 0) — kept distinct from a real 0 so the UI can show "—" instead of
// fabricating a 100% gain. shares/acquired (the lot's open date) are carried so
// a last-resort basis can be ESTIMATED as shares × historical price on that
// date; Plaid reports no open date, so `acquired` is null for Plaid holdings.
export interface Holding {
  symbol: string; description: string; marketValue: number; costBasis: number | null;
  shares: number | null; acquired: string | null;
}
