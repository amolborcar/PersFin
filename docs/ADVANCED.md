# KevFin — advanced guide

The [main README](../README.md) covers installing the desktop app. This page is for
everything else: Intel Macs, how the pieces work, and developing it.

> ⚠️ **KevFin has no login screen.** Keep it on your home network or behind
> something like Tailscale — **don't expose it directly to the internet.**

KevFin runs on macOS only. Docker, NAS and Windows support were removed.

## Intel Mac

The ready-made download is for Apple-silicon Macs. On an Intel Mac, run it from
source (see [For developers](#for-developers)).

## Features in detail

- **Net worth** — daily history points, ~5-year backfill (cash/credit from
  transactions, brokerage from holdings × historical prices, real estate from a
  Zestimate history or the Zillow Home Value Index), and index comparison. The
  backfill also runs itself when history is missing or gap-ridden — a first run,
  or days the server was off — so the chart fills in without being asked.
- **Accounts** — connect institutions via [SimpleFIN](https://www.simplefin.org/) or
  [Plaid](https://plaid.com/); rename, recategorize (drag & drop), and hide accounts.
- **Real estate** — track properties with an amortized mortgage estimator so equity
  reflects paydown to date. Current value comes from a Zillow provider, and the
  historical trend is drawn from the ZIP-level [Zillow Home Value
  Index](https://www.zillow.com/research/data/) (ZHVI). For a sharper, home-specific
  curve you can paste that property's own Zestimate history from Zillow — open the
  home on Zillow, switch its Home-value chart to **Table view**, and paste it into
  the property's **Value history** panel. Those points override ZHVI for that home.
- **Investments** — fund look-through to asset class / sector / region / individual
  stock, with manual asset-class overrides.
- **Budget** — auto-categorized spending vs. targets, an all-transactions view,
  automatic recurring-bill detection, a month-by-month cash-flow trend, and a
  Sankey breakdown of income → categories → savings.
- **Forecast** — Monte Carlo retirement model seeded from your real tax buckets
  (taxable / pre-tax / Roth / HSA / college) and spending.
- **AI assistant** — ask questions about your finances in plain English
  (see [below](#how-the-ai-assistant-works)).
- **Encrypted snapshot export** — share a read-only, password-protected copy of
  your dashboard as a single offline HTML file (see [below](#sharing--data-control)).
- **Backups & data control** — download, restore, or wipe your database, and run a
  one-click full sync, all from the in-app **Setup** hub (see [below](#sharing--data-control)).
- **Privacy mode** — one click masks every dollar figure on screen.
- **Works on your phone** — the layout is fully responsive, so the dashboard, budget,
  charts, and Sankey are usable from a phone over your LAN or Tailscale.

## Sharing & data control

Everything operational lives behind the **gear icon (Setup)** in the top bar:
sync status, automation, backups, and the snapshot export. There are two distinct
ways to get your data out — one to *share*, one to *keep*:

### Encrypted snapshot export (to share)
Produces a single **password-protected HTML file** capturing all current data —
net worth, accounts, allocation, performance, and budget — frozen at that moment.

- **Self-contained & offline.** The file embeds its own viewer; the recipient just
  opens it in any browser and types the password. No server, no KevFin install.
- **Encrypted client-side.** The payload is AES-256-GCM encrypted with a key derived
  from your password via PBKDF2 (600k iterations). The password is used once to
  encrypt and is never stored; the data is unreadable without it.
- **Optional expiry.** Set a date after which the viewer refuses to render. This is a
  *courtesy* limit (enforced only by the viewer, not cryptographically) — fine for a
  spouse or advisor, not a defense against a determined adversary.

Great for handing someone a point-in-time read-only view without giving them access
to the live app.

### Backups (to keep)
A backup is the **live SQLite database**, for migration or disaster recovery —
different from the read-only snapshot above.

- **Download backup** — a consistent full copy of `kevfin.db`.
- **Restore from backup** — upload a `.db`; it's validated, and your current database
  is automatically copied aside first as a safety net before the swap.
- **Erase all data** — a full reset that empties every user table (API keys in
  `server/.env` are untouched).

### Sync
The Setup hub shows when your accounts and real estate were last synced and offers a
one-click **Sync now** that pulls fresh balances from every linked institution
(SimpleFIN + Plaid) and refreshes property values (Zillow), then records a net-worth
point. A daily midnight net-worth history point is also recorded automatically (set
`DAILY_SNAPSHOT=false` to turn it off).

## Your category file

Your budget categories live in `categories.json` next to the database
(`data/categories.json` when running from source; in the desktop app, in the
storage folder). It is never committed to git. The app creates it on first start,
and Budget → Manage categories edits it. You can also edit it in any text editor;
changes apply within a few seconds.

```json
{
  "version": 1,
  "groups": [
    { "name": "Food & Dining", "color": "#f472b6", "categories": [
      { "name": "Groceries", "emoji": "🛒", "hint": "Supermarkets and food markets" },
      "Coffee Shops"
    ] }
  ]
}
```

- `hint` (optional) tells the AI categorizer what belongs in the category.
- `aliases` (optional) are other names for the category. A rename in the app adds
  the old name here.
- Categories in the group named `Income` count as income.
- The system categories Paychecks, Other Income, Dividends & Capital Gains,
  Transfers, Credit Card Payment and Miscellaneous always exist; if the file
  leaves one out, the app adds it.
- If you delete a category from the file, its budget target and rules are
  deleted, and imported transactions that used it move to Miscellaneous. The
  manage panel shows what changed.
- A file with an error is not applied; the manage panel shows the error.

See `categories.example.json` for the full default list.

## Weekly report

Setup → **Weekly reports** builds a report for the week (Monday to Sunday) and
keeps past ones. It shows what you spent compared with last week and your
8-week average, each budget's month-to-date and expected month-end, the biggest
changes in your regular spending, recurring charges (new ones and price
changes), and how many transactions still need a category.

- Expected month-end adds what the category usually costs in the rest of a
  month (average of the last 3 months), so a bill you already paid does not show
  as "at risk".
- **AI summary** (off by default) adds a few sentences from your local Claude
  Code. It sends only the week's totals by category.
- Set `KEVFIN_PUBLIC_URL` (for example your Tailscale address) so the report's
  "Review them" link opens KevFin from another device.

## How the AI assistant works

The built-in assistant **does not use a paid API key.** It runs your **locally
installed [Claude Code](https://claude.com/claude-code)** in headless mode, on
whatever Claude login exists on that machine, so it draws on your own Claude
subscription, on your own computer. No credentials are stored in this repo, and
nothing routes to anyone else's account.

Where KevFin looks for the `claude` binary (`server/src/services/assistant.ts`):
1. `CLAUDE_BIN` in the keys file (`server/.env`, or the file set by `KEVFIN_ENV_PATH`)
2. a `claude` on your `PATH`
3. the binary bundled in the macOS Claude desktop app

If none is found, the assistant is simply disabled; the rest of the app works.

Every run is sandboxed: chat and document import may only **read** files inside
their own private temporary folder, the quarterly-report run gets no tools at all,
shell / write / web tools are denied, your own MCP servers are ignored, and runs
are killed on timeout or when you close the request. The model only sees the
compact financial summary KevFin builds for it.

### AI category suggestions

In Budget → Quick review, **✨ Suggest categories with AI** asks the same local
Claude Code for a category for each uncategorized merchant. It runs with no tools
at all. Per merchant it sends the payee, up to three bank descriptors, a typical
amount, how many charges there are, and the account type (for example "credit
card"), plus your category list and hints. It never sends balances, account names
or numbers, or memos.

- **Accept** makes a merchant rule; **Not this** hides the suggestion.
- **Daily** (on by default) asks about new merchants after the daily sync.
- **Auto-accept ≥ 90%** (off by default) makes the rule directly for confident
  suggestions. You can see and remove rules in the Rules manager.
- Add a `hint` to a category in your category file to steer the suggestions.

## For developers

### Architecture

```
client/   React + Vite single-page app (dashboard, charts, budget, forecast)
server/   Express + TypeScript API, SQLite (better-sqlite3), daily cron history points
data/     SQLite database + backups (git-ignored — never committed)
```

- **Server** (port `3001`) exposes a `/api/*` REST surface and, in production,
  serves the built client from the same port.
- **Client** (Vite dev server, port `5173`) proxies `/api` to the server in dev.
- **Storage** is a single SQLite file. Account data is fetched from providers at
  most ~once per day and cached in the DB, so the app is fast and offline-tolerant.

### Getting started (development)

Requires Node 20+.

```bash
# 1. Install dependencies
npm install --prefix server
npm install --prefix client

# 2. Configure the server
cp server/.env.example server/.env   # then fill in keys as needed (all optional to start)

# 3. Run both halves (two terminals)
npm run dev --prefix server          # http://localhost:3001
npm run dev --prefix client          # http://localhost:5173
```

Open http://localhost:5173 and connect an institution, or seed the demo data below
to explore with fictional numbers first.

### Environment variables

All are optional — KevFin runs without any keys; you just won't have live data for
the corresponding feature until they're set. Institutions themselves are linked from
the dashboard (a SimpleFIN setup token or the Plaid Link flow); the Plaid app
credentials below only need to be set if you use Plaid-linked institutions.

| Variable | Purpose |
| --- | --- |
| `PORT` | Server port (default `3001`). |
| `OPENWEBNINJA_KEY` | [OpenWeb Ninja](https://www.openwebninja.com) API key for property values (tried first). |
| `APILLOW_KEY` | [APILLOW](https://apillow.co) API key — fallback for property values when OpenWeb Ninja is unset or over its plan limit. |
| `SEC_CONTACT_EMAIL` | Contact email KevFin declares to SEC EDGAR when fetching fund holdings (country/stock look-through). SEC rejects anonymous tools; without it no SEC requests are made. Also settable in the app (Setup → SEC contact email). |
| `SEC_EDGAR_UA` | Advanced: override the whole SEC User-Agent (`Name email`). |
| `PLAID_CLIENT_ID` / `PLAID_SECRET` / `PLAID_ENV` | Plaid credentials (only needed for Plaid-linked institutions). |
| `CLAUDE_BIN` | Override path to the Claude Code binary (only if auto-detection fails). |
| `DB_PATH` | Override the SQLite path. |
| `DAILY_SNAPSHOT` | Set `false` to disable the automatic midnight net-worth history point. |

### Demo data

To explore the app — or retake the README screenshots — without touching any real
data, seed a throwaway database. The seeder **refuses to run unless `DB_PATH` is set**,
so it can never overwrite `data/kevfin.db`:

```bash
cd server
DB_PATH="$PWD/../data/demo.db" npx tsx scripts/seed-demo.ts
DB_PATH="$PWD/../data/demo.db" npm run dev          # server on the demo DB
# in client/, point the proxy at it if your real server is also running:
API_PROXY=http://localhost:3001 npm run dev --prefix ../client
```

Everything it creates — institutions, balances, holdings, transactions, the property,
and ~5 years of history — is fictional.
