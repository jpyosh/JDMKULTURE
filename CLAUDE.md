# JDMKULTURE

The app lives in `gmqa-app/`. Read `gmqa-app/README.md` for the business rules, layout and commands.

- Production database: Supabase Postgres. Schema changes go only through a new
  `gmqa-app/migrations/NNN_*.sql` plus `npm run db -- migrate`, which backs up first. Never edit an applied migration.
- Money math lives only in `lib/calc.js`. The frontend EOD preview (`public/js/views/eod.js`) mirrors it, so change both together.
- Writes go through `db.tx(req.user.email, ...)` so the audit log records who changed what.
- Business dates are 'YYYY-MM-DD' strings in shop (Philippine) time. Never use `toISOString()` to get "today" in the browser.
- Before finishing a change: `npm test` and `npm run test:ui` (both offline).
- Ask before running `db -- migrate` against production, or before any destructive SQL.
