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

Data lives in a small SQLite file (`data/gmqa.sqlite`) that the server creates automatically
on first run. On a real host, keep this on a **persistent disk** (see deploy steps) so it
isn't wiped on redeploy.

## Run it locally first (optional, to see it before deploying)

You need [Node.js](https://nodejs.org) 18+ installed.

```
cd gmqa-app
npm install
npm start
```

Then open `http://localhost:3000` in your browser.

## Getting a real website URL (free, ~10 minutes) — Render.com

Render is the simplest option because it supports a small **persistent disk**, which
SQLite needs (unlike some free hosts that reset the filesystem on every deploy).

1. **Put the code on GitHub.**
   - Create a free GitHub account if you don't have one: https://github.com
   - Create a new repository (e.g. `gm-qa-ops`), and upload this whole `gmqa-app` folder to
     it (GitHub's web "Add file → Upload files" works fine, no command line needed).

2. **Create a Render account:** https://render.com — sign up free with GitHub.

3. **New → Web Service** → connect your `gm-qa-ops` repository.

4. Fill in:
   - **Name:** `gm-qa` (this becomes part of your URL)
   - **Runtime:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free

5. **Add a persistent disk** (so your data survives restarts/redeploys):
   - In the service settings, go to **Disks → Add Disk**
   - **Mount Path:** `/opt/render/project/src/data`
   - **Size:** 1 GB is plenty

6. Click **Create Web Service**. Render will build and deploy it — takes a few minutes.
   You'll get a live URL like `https://gm-qa.onrender.com`. That's your website.

7. Bookmark it, and optionally point your own domain at it later from Render's Settings →
   Custom Domain tab if you buy one.

**Note on the free tier:** Render's free web services sleep after 15 minutes of no traffic
and take ~30–60 seconds to wake up on the next visit. That's fine for a shop tool used a
few times a day. If that wake-up delay ever bothers your supervisors, Render's cheapest paid
tier ($7/mo) removes it.

### Alternative: Railway.app
Same idea — connect the GitHub repo, it auto-detects Node, add a volume mounted at `/app/data`
for the SQLite file. Railway's free tier is usage-credit based rather than always-free.

## Evolving it day by day

Since this is now real code (not a spreadsheet), the way to "evolve" it is to tell me what
you want changed or added — e.g. "add a loyalty punch-card counter per plate number," "add
the Petty Cash Fund tracker from the handover doc," "add login so only supervisors can edit
Pricing." I can write the change, you re-upload the updated files to GitHub, and Render
redeploys automatically.

## Known gaps to fill in next
- No login/authentication yet — anyone with the URL can edit everything. Worth adding once
  you're using this for real money.
- Petty Cash Fund tab (₱50,000 monthly imprest) from the handover doc isn't built yet.
- Tip jar / centralized tips tracking isn't wired up yet (data column exists on jobs but no
  dedicated view).
