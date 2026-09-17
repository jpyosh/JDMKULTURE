# GM QA — JDM Kulture Ops Console

A standalone website version of your "GM QA" spreadsheet: Daily Log, Pricing/Commission
Matrix, EOD Cash Reconciliation, Weekly Rollup, and Payroll — with its own database, so it
no longer depends on Google Sheets formulas at all.

## What's fixed vs. the spreadsheet (per your formula audit)

1. **Double-subtraction bug** — Total Net Shop Revenue is now computed exactly once
   (`Gross Sales − Total Commissions`), never subtracted per-row and again at the summary.
2. **Vehicle counter** — dynamically counts rows with a vehicle class, no `COUNTUNIQUEIFS`,
   no hardcoded fallback, no manual updating.
3. **Ceramic Coating: Motorcycle** — MOTO commission was ₱0 despite MOTO being charged
   ₱3,000. Set to ₱600 (same 20% ratio as the S-class tier of that service) — **please confirm
   this is the number you actually want to pay**, I inferred it from the pattern.
4. **Orphan row** — "Ceramic Coating w/o maintenance" had a commission but no price, so it
   was unusable. I gave it a placeholder price scaled off Graphene Ceramic Coating —
   **this one you should definitely check and correct** in the Pricing Matrix tab of the app,
   since I made it up to make the row usable, not because I know your real price for it.
5. **Row position drift** — irrelevant now; this app computes everything from a database,
   not from fixed spreadsheet cell positions.

## How it works

- **Daily Log**: add job orders per date; JO# auto-generates (`JO-MMDDYY-###`); price and
  commission are looked up live from the Pricing Matrix the moment you pick a service/add-on
  and vehicle class — exactly like the sheet's `INDEX`/`MATCH`, just without the risk of a
  formula getting overwritten.
- **Pricing Matrix**: every service and add-on, editable per vehicle class, for both price and
  commission. Change a number here and every future job order uses it instantly.
- **EOD Dashboard**: cash float, cash/GCash expense ledgers, expected cash/GCash math, actual
  counts, and variance — same structure as your sheet's reconciliation block.
- **Weekly Rollup**: auto-built from daily data — no more copy-pasting into a separate tab.
- **Payroll**: rate/day × days worked, plus construction days × construction rate, minus
  deductions, per pay period.

Production uses Supabase Postgres through the server-only `DATABASE_URL` environment variable.
Never commit, print, or put that connection string in frontend code. Without `DATABASE_URL`,
local development keeps using the existing SQLite file at `data/gmqa.sqlite`.

### Authentication

Supabase Auth protects every API mutation. Visitors can read the dashboards, but must sign in
with an email/password Supabase user before they can add jobs, edit pricing, reconcile EOD,
manage payroll, or change expenses. Configure these public project settings alongside
`DATABASE_URL`:

```
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_ANON_KEY=your-anon-key
```

Create users in Supabase Dashboard -> Authentication -> Users. The anon key is intended for
browser use; never expose the service-role key or the database connection string.

## Run it locally first (optional, to see it before deploying)

You need [Node.js](https://nodejs.org) 18+ installed.

```
cd gmqa-app
npm install
npm start
```

Then open `http://localhost:3000` in your browser.

To run locally against Supabase, export `DATABASE_URL` in the shell with the Supabase Postgres
connection string and start the app. `.env.example` is a reference only; this app does not load
dotenv files. Never commit the real connection string.

## Import existing SQLite data

1. Create the tables by running `supabase/schema.sql` in the Supabase SQL Editor.
2. Install dependencies with `npm install`.
3. Set `DATABASE_URL` and, if needed, `SQLITE_PATH` in the shell. The default SQLite path is
   `data/gmqa.sqlite`.
4. Run `npm run migrate` from `gmqa-app`.

The migration preserves primary keys and foreign-key relationships, is transactional, and does
not run automatically. It uses the existing `better-sqlite3` package only for this migration and
does not require or accept credentials on the command line.

## Deploy to Vercel

1. Import the repository into Vercel and set the project root to `gmqa-app`.
2. Add `DATABASE_URL` as a Vercel Production environment variable. Treat it as a secret and do
   not add it to Git, `vercel.json`, or browser JavaScript.
3. Deploy. `api/index.js` exports the Express app; `vercel.json` routes `/api/*` to it and serves
   the existing `public` files.

The base Supabase schema and any later SQL migrations must be applied in Supabase before deployment.
The application checks database connectivity at startup but does not run schema DDL during requests.
It does not seed production data or import SQLite records automatically.

## Legacy SQLite hosting

The no-`DATABASE_URL` SQLite mode remains useful for local development. It is not suitable for
Vercel's ephemeral filesystem; use Supabase Postgres for deployed data.

## Evolving it day by day

Since this is now real code (not a spreadsheet), the way to "evolve" it is to tell me what
you want changed or added — e.g. "add a loyalty punch-card counter per plate number," "add
the Petty Cash Fund tracker from the handover doc," "add login so only supervisors can edit
Pricing." I can write the change, you push the update to GitHub, and Vercel redeploys automatically.

## Known gaps to fill in next
- No login/authentication yet — anyone with the URL can edit everything. Worth adding once
  you're using this for real money.
- Petty Cash Fund tab (₱50,000 monthly imprest) from the handover doc isn't built yet.
- Tip jar / centralized tips tracking isn't wired up yet (data column exists on jobs but no
  dedicated view).
