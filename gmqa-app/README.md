# GM QA — JDM Kulture Ops Console

Operations console for the JDM Kulture car wash: job orders, pricing, end-of-day cash/GCash
closing, sales reports, payroll. Express API + plain-JS frontend, Supabase Postgres + Supabase
Auth, deployed on Vercel.

## Screens and who sees them

| Screen | Owner | Staff |
|---|---|---|
| Daily Log — job orders with line items (service, add-ons, custom items) | ✓ | ✓ (not on closed days) |
| EOD Closing — float, expenses, expected vs counted, variance, close the day | ✓ | ✓ (not on closed days) |
| Pricing Matrix — price + commission per vehicle class | edit | view |
| Sales Reports — any date range | ✓ | — |
| Payroll — weekly attendance, OT, deductions | ✓ | — |
| Settings — users & roles, vehicle classes, change history | ✓ | — |

## Departments

| Department | Tab | JO numbers | Counts as a sale |
|---|---|---|---|
| Carwash | Carwash | `CW-MMDDYY-###` | on the day it is entered (same-day) |
| Detailing | Detailing | `DT-MMDDYY-###` | when it is both **marked done** and **paid**, on the later of the two days |
| Tint & PPF | Tint & PPF | `TP-MMDDYY-###` | same as Detailing |

- Detailing and Tint & PPF jobs are **running**: they stay on their board day after day until done and paid.
- Every service belongs to one department (Pricing Matrix → department tabs) and is only offered there.
  Add-ons are shared: every add-on is offered on Carwash, Detailing and Tint & PPF jobs.
- EOD and Sales Reports combine all departments and show each department's sales separately.
- Money is counted the day it is received: a running job paid before it is finished is in that day's
  drawer, while its sale and commission are booked on the day it is done.
- Once a running job is paid, its amount (items, class, discount) is locked until the payment is undone.
- Older `JO-` numbers from before departments existed are kept as they were.

## Business rules (all in `lib/calc.js`)

- A job **counts** once it has a vehicle class or a line item and is not voided.
- **Collected** = totals of paid jobs. **Receivables** = totals of unpaid jobs.
- **Commission** = every counted job (detailers are paid at EOD either way).
- **Net** = Collected − Commission. **Profit** (reports) = Collected − Commission − Expenses.
- Expected cash = float + cash collected − commission paid in cash − cash expenses.
- Expected GCash = GCash collected + tips − tips passed on − commission via GCash − GCash expenses.
- A line item's price and commission are **frozen when added**. Editing the Pricing Matrix never
  changes past jobs. Changing a job's vehicle class re-prices its catalog lines at today's prices.
- Payroll works for any date range (a week, 1st–15th, 16th–end...). Attendance and overtime are
  recorded per day; cash advances, bonuses etc. are dated adjustments. Each day is paid at the rate in
  effect that day (rates change from an effective date), so earlier periods never change.
- A payroll payout (wages handed out, weekly from that week's sales) is subtracted from that day's
  expected drawer in EOD.
- Jobs are **voided** (owner only, with a reason), never deleted. JO numbers are never reused.
- Closing a day locks it for staff. The owner can still edit or reopen it.
- Every insert/update/delete is written to `audit_log` with who did it (Settings → Change history).

## Finance and bill funds (owner)

- **Finance** shows any period (week, month, custom): sales by department, commission, net sales,
  payroll (net pay for work done in the period), bills paid, drawer expenses and **net profit**,
  plus a money in/out view of the drawer.
- **Bill funds** (Meralco, Maynilad, Internet, Rent, Business permit, or any you add) each have a usual
  amount and due date. The system works out a **weekly target** = what is still needed ÷ weeks left.
- At EOD, the supervisor sets aside each fund's share ("Set aside for bills"); it leaves the drawer.
- When a bill is paid (Finance → Pay bill) it comes out of its fund; any shortfall comes out of that
  day's drawer and shows on that day's EOD.
- Set-asides are not costs. The cost is counted when the bill is paid.

## Parts & inventory

- **Parts & Inventory** tab: SKU, price, commission per unit, stock and a reorder level (low-stock warning).
- Parts can be added with a quantity to any Carwash, Detailing or Tint & PPF job, or sold over the
  counter ("Parts counter" department, `PC-` numbers, no vehicle needed, defaults to paid).
- Selling takes stock out and freezes the part's average cost on the line; removing the part or
  voiding the job puts the stock back. Selling more than is in stock is blocked.
- Owner only: add/edit parts, **Receive** deliveries (updates the weighted average cost), **Adjust**
  counts (with a reason), stock history. Every stock change is recorded.
- Costs and margins are owner-only: staff never receive cost fields from the API.
- Finance subtracts the cost of parts sold before net profit.

## Project layout

```
server.js            Express app (createApp) — also the Vercel function via api/index.js
lib/db.js            Postgres access: db.one/many/exec, db.tx(actor, fn) for audited writes
lib/auth.js          Supabase token check + app_users role lookup
lib/calc.js          all money math (pure functions)
lib/http.js          validation helpers + error handler
lib/store.js         loadJobs / assertDayOpen
routes/*.js          one file per area (jobs, days, catalog, reports, payroll, admin)
migrations/NNN_*.sql schema changes, applied in order by scripts/db.js
public/              frontend: index.html, style.css, js/main.js, js/views/*, js/components/*
test/                API + migration tests (in-memory Postgres via PGlite)
scripts/db.js        migrate / backup / status / query / grant
scripts/sandbox.js   full app on a throwaway database
scripts/ui-smoke.js  headless-browser test of every screen
```

## Everyday commands (run inside `gmqa-app/`)

```
npm install
npm test                 # API + migration tests, no database needed
npm run test:ui          # clicks through every screen in headless Edge/Chrome
npm run sandbox          # app at http://localhost:3100 with fake logins and dry-run data
npm run dev              # app at http://localhost:3000 against the real database (.env)
```

`.env` (never committed) holds `DATABASE_URL`, `SUPABASE_URL` and `SUPABASE_ANON_KEY`. See `.env.example`.

## Database changes

Never edit the database by hand and never edit an applied migration. To change the schema:

1. Add `migrations/NNN_short_name.sql` (next number). Keep it additive where possible and
   backfill existing rows in the same file.
2. `npm test`. The migration tests run every migration on a copy of the dry-run data.
3. `npm run db -- migrate`. This writes a full JSON backup to `backups/` first, then applies
   each pending migration in its own transaction. A failure rolls back completely.
4. Deploy the code that uses the new schema.

Other DB commands:

```
npm run db -- status                        # which migrations are applied
npm run db -- backup                        # JSON dump of every table to backups/
npm run db -- query "select count(*) from jobs"   # read-only query
npm run db -- users                         # app users + Supabase Auth accounts
npm run db -- grant someone@email.com owner # or staff
npm run db -- revoke someone@email.com
```

## Users and sign-in

A person needs both:
1. a **Supabase Auth account**: Supabase Dashboard → Authentication → Users → Add user, and
2. an entry in **app_users**: Settings → Users & access (or `npm run db -- grant`).

A Supabase account alone grants nothing. Turn off "Allow new users to sign up" in Supabase Auth
settings anyway, since all accounts are created by the owner.

## Deploying (Vercel)

Project root: `gmqa-app`. Environment variables: `DATABASE_URL`, `SUPABASE_URL`,
`SUPABASE_ANON_KEY`. Pushing to `main` deploys. If a change includes a migration, run
`npm run db -- migrate` right before merging.

## Data history

Migration 002 (v2) converted the original data model. Copies of the tables as they were
before v2 are kept in `legacy_v1_jobs`, `legacy_v1_services`, `legacy_v1_addons` and
`legacy_v1_payroll_entries`.
