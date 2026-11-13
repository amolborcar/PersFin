// Shared REST response shapes, imported by BOTH sides of the API boundary:
// the server (route/service return types) and the client (via the `@shared`
// alias — see client/tsconfig.json and client/vite.config.ts). Adding a field
// here is the one place that keeps the two in sync; before this file the
// client hand-copied these interfaces and drifted (e.g. SQLite's 0/1 booleans
// leaking into the UI as numbers).
//
// Type-only module: `import type` on both sides, nothing at runtime.

export interface Snapshot {
  date: string;
  accounts_total: number;
  net_worth: number;
}

export type AccountCategory = 'banking' | 'brokerage' | 'credit' | 'other';

export interface Account {
  id: string;
  org_name: string;
  name: string;
  renamed: boolean; // custom display name set (converted from SQLite 0/1 at the route layer)
  balance: number;
  currency: string;
  category: AccountCategory;
  hidden: boolean; // excluded from net worth (converted from SQLite 0/1 at the route layer)
  updated_at: string;
}

export interface ManualAsset {
  id: number;
  name: string;
  category: AccountCategory;
  value: number;
  // Annual growth/interest rate (percent). null = no rate set; the Forecast then
  // leaves this asset in the volatile investment pool (legacy behavior).
  interest_rate: number | null;
  updated_at: string;
}

export interface Breakdown {
  accounts: Account[];
  manualAssets: ManualAsset[];
}

export interface PlaidItem {
  item_id: string;
  institution_name: string;
  account_count: number;
  created_at: string;
}
