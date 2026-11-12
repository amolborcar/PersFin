# Rebuild plan: personal budgeting focus

This plan changes KevFin into a personal, YNAB-style budgeting app for one
user on one always-on Mac mini. Each phase is one commit (or one PR), so CI
checks each step.

The repository `amolborcar/PersFin` is independent. It left the fork network
of `kxl3785/KevFin`. Open PRs against `amolborcar/PersFin` only.

## Status

| Phase | Status |
|---|---|
| 0 Baseline | Done. Build passes; tests pass (server 383, client 153). |
| 1 SimpleFIN → Plaid | Done. Build passes; tests pass (server 388, client 153). |
| 2 Remove real estate | Done, including the Mortgage category (migration 9). Build passes; tests pass (server 349, client 143). |
| 3 macOS only | Done. Build passes; tests pass (server 349, client 143). The `.dmg` build was not run (it needs a macOS runner or the Mac mini). |
| 3b–9 | Not started |

Update this table at the end of each phase.

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Investments | Keep. Replace SimpleFIN with Plaid Investments (`investmentsHoldingsGet`, `investmentsTransactionsGet`). |
| 2 | Budget model | Keep category targets. Zero-based budgeting is a later project. |
| 3 | Housing | Remove real-estate tracking and the Mortgage category. The owner rents; Rent is the housing category. Spending categories come from the personal category file. |
| 4 | Push | ntfy, self-hosted on the Mac mini, reached over Tailscale. iOS wake-ups go through the ntfy.sh upstream relay, which receives only a message ID. |
| 5 | Email | The user's own SMTP account with an app password, over TLS. |
| 6 | Always on | macOS launchd services on the Mac mini. Remove Docker and NAS support. |
| 7 | Platform | macOS only. Remove Windows. |

## Known limits and exceptions

- **External channels.** Weekly email and push send report data to the mail
  provider and to Apple's push service. Both are opt-in. Each channel has a
  privacy level: `full`, `totals only`, or `notice only`. Update the hard
  constraints in `CLAUDE.md` to name these two channels as the only allowed
  exceptions.
- **AI processing.** AI categorization sends payee, description, amount, date,
  and account type to Anthropic through the local Claude Code login. It does not
  send balances or account numbers.
- **Plaid investments.** Plaid gives no lot open date, so the cost-basis
  estimate (shares × price on the open date) cannot run for Plaid accounts. Some
  employer plans report no cost basis.
- **History depth.** The brokerage backfill uses today's holdings × historical
  prices, so it still covers about 5 years. Cash and credit history is rebuilt
  from Plaid transactions, which cover up to 2 years.
- **Upgrade of an existing database.** Migration 7 deletes all SimpleFIN data
  (connections, accounts, their transactions and balance history, caches).
  Take a backup (Setup → Download backup) before the first start of the new
  version if the database has SimpleFIN accounts.
- **Plaid access.** The Investments product must be enabled for the Plaid
  production account. Accounts linked without investment consent must be linked
  again (Plaid update mode).

## Phase 0: Baseline

1. Run `npm run install:all`, `npm run build`, and `npm test`. Record the result.
2. Seed a demo database (`DB_PATH=.../demo.db`). Use it for all manual tests.

## Phase 1: Replace SimpleFIN with Plaid (keep investments)

1. Move the `Holding` and `TxnDelta` types from `services/simplefin.ts` to a new
   provider-neutral file, `services/holdings.ts`.
2. In `services/plaid.ts`, add `fetchHoldings()`:
   - Call `investmentsHoldingsGet` for each item in parallel (`Promise.all`).
   - Cache the result with the `provider_cache` pattern.
   - Map `ticker_symbol` → `symbol`, `name` → `description`,
     `institution_value` → `marketValue`, `cost_basis` → `costBasis`,
     `quantity` → `shares`, and set `acquired` to `null`.
   - Map cash positions (`security.type === 'cash'`) to the cash symbol the code
     uses now.
3. Keep the existing `fetchPlaidTransactions()` for the cash and credit
   backfill. `investmentsTransactionsGet` is not necessary: the brokerage
   backfill uses holdings × historical prices.
4. Point `allocation.ts`, `performance.ts`, and `backfill.ts` at the Plaid
   functions.
5. Delete `routes/simplefin.ts`, `services/simplefin.ts`, and
   `client/src/components/ConnectSimpleFIN.tsx`. Remove the route and the
   SimpleFIN refresh from `server/src/index.ts`.
6. In `services/feedStore.ts`, change `FeedSource` to `'plaid'` and remove
   `rawTxnsFromSimpleFin`.
7. Add a migration that drops `simplefin_connections` and deletes `sf_cache_*`
   rows from `provider_cache`. Do not change old migrations.
8. Remove the other references: `netWorth.ts`, `refreshErrors.ts`, `budget.ts`,
   `recurring.ts`, `data.ts`, `db/providerCache.ts`, `util/categorize.ts`,
   `Setup.tsx`, `Welcome.tsx`, `Dashboard.tsx`, `ConnectPlaid.tsx`,
   `lib/merchantLogo.ts`.
9. Change the SimpleFIN test fixtures to the Plaid shape with the shared
   helper `server/src/db/plaidSeed.ts` (also used by `scripts/seed-demo.ts`).
   Do not delete test cases. Affected: `budget.test.ts`, `budgetFixes.test.ts`,
   `budgetGolden.test.ts`, `feedStore.test.ts`, `netWorthRefresh.test.ts`,
   `refreshErrors.test.ts`, `rulesReview.test.ts`. The golden budget snapshots
   must stay unchanged.
   Move the account rename/category/hide endpoint from `/api/simplefin/accounts`
   to `/api/accounts` (`routes/accounts.ts`).
10. Add tests for the Plaid → `Holding` mapping: null cost basis, cash
    positions, missing ticker.
11. Verify: build and tests pass. Plaid link, sync, and the Investments page
    work on the demo database.

## Phase 2: Remove real estate

1. Delete `routes/properties.ts`, `services/zillow.ts`, `services/zhvi.ts`,
   `services/mortgage.ts`, `util/amortization.ts`, `client/src/lib/mortgage.ts`,
   `AddProperty.tsx`, `ZillowKey.tsx`, and their tests.
2. Add a migration that drops `properties` and `property_value_history`. Stop
   writing `real_estate_total` in `net_worth_snapshots`.
3. Remove the real-estate parts of `netWorth.ts` (`refreshRealEstateAndSnapshot`,
   `catchUpRealEstate`), `index.ts` (cron), `historyCatchUp.ts`, `backfill.ts`,
   `report.ts`, `reportTemplate.ts`, `snapshotTemplate.ts`,
   `shared/apiTypes.ts`, `keys.ts` (`OPENWEBNINJA_KEY`, `APILLOW_KEY`), the
   `properties` proposal in `ingest.ts`, and home equity in `Forecast.tsx` and
   `lib/forecastSim.ts`.
4. Remove the Mortgage budget category: the owner rents and tracks rent
   (category Rent). Remove the special handling that kept mortgage payments
   out of spending, the `MORTGAGE_RE` auto-category, the mortgage terms in the
   liability-account pattern, the Budget "Housing carry" card, the mortgage
   exclusion in recurring bills, and the `mortgage` fields in the budget and
   cash-flow APIs. Migration 9 removes the category from existing databases
   the same way the UI removes a category (rules and target deleted, imported
   rows moved to Miscellaneous).
5. Do not increase `CURRENT_BACKFILL_VERSION`. Migration 8 sets each stored
   day's `net_worth` to its `accounts_total`, which is exact; a version bump
   would instead overwrite observed history with estimates.
6. Verify: the remaining `real estate` mentions are the REIT asset class in the
   allocation view, old migrations, and comments. Build and tests pass.
   The golden budget fixture's housing payment is now rent; the snapshots
   change by that (and by the removed `housing`/`mortgage` fields).

## Phase 3: macOS only

1. Remove the `win:` and `nsis:` blocks from `desktop/electron-builder.yml`.
2. Remove the `windows-2022` entry from `.github/workflows/desktop-build.yml`.
3. Delete `Dockerfile`, `.dockerignore`, `docker-compose*.yml`, `DEPLOY.md`,
   `DEPLOY-SYNOLOGY.md`, `kevfin.env.example` (the Docker keys file), and
   `.github/workflows/publish-image.yml`.
4. Remove the CI step that fast-forwards `production` after a push to `main`
   (it fed the NAS deployment).
5. Remove Windows code paths in `desktop/main.js` and `desktop/scripts/`, the
   Windows and Docker rows in `scripts/release.mjs`, and the Windows and Docker
   instructions in `README.md`, `DESKTOP.md` and `docs/ADVANCED.md`.

## Phase 3b: Always on with launchd (Mac mini)

1. **Server LaunchAgent** `~/Library/LaunchAgents/com.kevfin.server.plist`:
   - `RunAtLoad` and `KeepAlive`.
   - Run the server with the Electron binary and `ELECTRON_RUN_AS_NODE=1`
     (better-sqlite3 is built for Electron's ABI).
   - Pass `PORT`, `DB_PATH`, and `KEVFIN_ENV_PATH` as `desktop/main.js` does.
   - Write logs to `~/Library/Logs/KevFin/`.
   - Listen on `127.0.0.1` and the Tailscale interface only.
2. **Desktop app as client:** at start, check the configured port. If the server
   answers, open the window to it. If not, start the server as now. Do not stop
   a launchd server when the window closes.
3. **Setup toggle** "Keep KevFin running in the background": write or remove the
   plists and run `launchctl bootstrap` / `bootout` for `gui/$UID`.
4. **Scheduled jobs** with `StartCalendarInterval`. Each job runs
   `curl -X POST http://127.0.0.1:<port>/api/...`:
   - Daily 06:00: Plaid sync, then AI categorization.
   - Daily 00:00: net-worth snapshot.
   - Sunday 19:00: weekly report.
   launchd runs a missed job once on the next wake. All endpoints are
   idempotent (date key for sync and snapshot, week key for the report). Keep
   `node-cron` for dev mode only.
5. **Sleep check:** the Mac mini must not sleep. The Setup page reads
   `pmset -g` (no admin rights necessary) and shows a warning if system sleep is
   on. The fix is System Settings → Energy → "Prevent automatic sleeping when
   the display is off". The app does not change power settings.
6. **ntfy:** `brew install ntfy` and `brew services start ntfy`.
7. Tests: plist generation (paths, environment, schedule) and endpoint
   idempotency.

## Phase 4: Personal category file

1. Store the file at `data/categories.json` (`data/` is git-ignored). Add
   `categories.json` to `.gitignore` as a second safety measure. Commit
   `categories.example.json` as a template.
2. Format:
   ```json
   {
     "version": 1,
     "groups": [
       { "name": "Food", "color": "#f472b6", "categories": [
         { "name": "Groceries", "emoji": "🛒", "hint": "Supermarkets, Costco", "monthlyTarget": 600 }
       ]}
     ],
     "system": { "income": "Paychecks", "transfer": "Transfers", "ccPayment": "Credit Card Payment", "fallback": "Uncategorized" }
   }
   ```
   `hint` tells the AI what belongs in the category. `system` maps the
   categories that the transfer and credit-card logic use.
3. Add `services/categoryFile.ts`: load, validate (hand-written type guard),
   and watch the file. On first boot with no file, copy the example.
4. Change `taxonomy.ts` to build `TAXONOMY` from the file. Keep it free of
   `getDb` (the migration runner imports it).
5. Change `categories.ts` so UI create, rename, and delete write to the file.
   `budget_categories` becomes a cache.
6. When a category with transactions or rules is deleted or renamed, move them
   to `fallback` and show a warning.
7. Tests: validation, missing file, rename and delete of rules.

## Phase 5: AI categorization

1. Precedence (highest first): manual edit → user rule → accepted AI suggestion
   → `autoCategory` regex → `fallback`.
2. New table `ai_suggestions (txn_id PK, category, confidence, reason, model,
   created_at, status)`. Status: `pending`, `accepted`, `rejected`.
3. New service `services/aiCategorize.ts`:
   - Select transactions with no manual or rule category and no suggestion.
   - Batch about 100 transactions. Send `id, date, amount, payee, description,
     account type` only.
   - Spawn with `NO_TOOLS_CLAUDE_ARGS` from `assistant.ts`. The prompt goes over
     stdin. Use the same timeout and kill-on-disconnect.
   - Ask for strict JSON `[{id, category, confidence, reason}]`.
   - Drop rows with an unknown ID or category. Memos are untrusted input.
4. Run it after each daily sync and from a "Categorize with AI" button.
5. Extend `ReviewWizard.tsx`: pending suggestions grouped by merchant, with
   Accept, Change, Reject, and "Accept and make a rule".
6. Optional auto-accept at confidence ≥ 0.9. Default off.
7. Tests: parser and validator, precedence, batch selection (mock the spawn as
   in `assistantArgs.test.ts`).

## Phase 6: Weekly report content

1. Add `services/weeklyReport.ts`. Reuse `util/reportWindow.ts` and
   `util/reportCharts.ts`. Add `weeklyWindow()` (Monday to Sunday, local time).
2. Content: total spending vs. prior week and 8-week average; per-category week,
   month-to-date vs. target, and pace; top 5 changes up and down; new recurring
   charges and price changes; uncategorized count with a link; optional AI
   narrative (no-tools spawn).
3. Renderings: HTML email (inline CSS, inline SVG or base64 PNG charts, no
   scripts) and a short plain-text push summary.
4. Store each report in a `weekly_reports` table and show past reports in the
   app.
5. Tests: window boundaries (DST, year end), figures against golden demo data.

## Phase 7: Delivery

1. **Email:** add `nodemailer`. Keys `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
   `SMTP_PASS`, `REPORT_EMAIL_TO` in the keys file through `keys.ts` and Setup
   (masked). TLS on port 465 or STARTTLS. "Send test email" button.
2. **Push:** ntfy topic URL and access token in the keys file. ntfy server
   config uses `upstream-base-url: https://ntfy.sh` for iOS. "Send test push"
   button.
3. **Privacy level** per channel: `full`, `totals only`, `notice only`.
4. **Run endpoint** `POST /api/report/weekly/run`: build, store, and send once
   per week key. On server start, send the last finished week if it was not
   sent.
5. Update `CLAUDE.md` hard constraints.
6. Tests: idempotency, missed-week catch-up, message per privacy level.

## Phase 8: Visualizations

Recharts, with data shaping in `client/src/lib/*.ts` and Vitest tests.

1. Category trend: stacked bars per week or month by group, with drill-down.
2. Budget pace: month-to-date vs. target per category, with a projected
   month-end marker.
3. Calendar heatmap of daily spending (12 months).
4. Period-over-period change by category (diverging bars).
5. Top merchants per category.
6. Savings rate by month.

## Phase 9: Documentation and cleanup

1. Rewrite `README.md`. Update `CLAUDE.md`, `DESKTOP.md`, `docs/ADVANCED.md`,
   and `server/.env.example`.
2. Remove links to the upstream project `kxl3785/KevFin`: releases, issues, and
   the donation link in `README.md`.
3. Delete `.github/workflows/update-irs-limits.yml` and
   `.github/agent-tasks/update-irs-limits.md`, or set up the `AGENT_CMD` secret.
   This repository does not have that secret.
4. Remove dead code and unused packages.
5. Optional rename of the app, with a one-time data path migration.

## Order

| Phase | Depends on | Size |
|---|---|---|
| 1 SimpleFIN → Plaid | 0 | Large |
| 2 Remove real estate | 1 | Medium |
| 3 macOS only | – | Small |
| 3b launchd | 3 | Medium |
| 4 Category file | 1, 2 | Medium |
| 5 AI categorization | 4 | Medium |
| 6 Weekly report content | 4 | Medium |
| 7 Delivery | 3b, 6 | Medium |
| 8 Visualizations | 4 | Medium |
| 9 Docs | all | Small |
