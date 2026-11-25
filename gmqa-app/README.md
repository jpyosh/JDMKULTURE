# GM Operations Console — JDM Kulture

Operations console for the JDM Kulture car wash: job orders, pricing, end-of-day cash/GCash
closing, sales reports, payroll. Express API + plain-JS frontend, Supabase Postgres + Supabase
Auth, deployed on Vercel.

## Screens and who sees them

| Screen | Owner | Staff |
|---|---|---|
| Daily Log — job orders with line items (service, add-ons, custom items) | ✓ | ✓ (not on closed days) |
| EOD Closing — float, expenses, expected vs counted, variance, close the day | ✓ | ✓ (not on closed days) |
| Parts — job orders and auto parts for sale. **Hidden since 2026-11-18** (the parts department moved to Excel) | ✓ | ✓ (no costs) |
| Inventory — everything stocked, tags, department containers, List / Sheet views, counts, deliveries, Excel export/paste | edit | view + stock counts |
| Pricing Matrix — price + commission per vehicle class | edit | view |
| Invoice & Forms — the shop's Service Invoice, Waiver & Release, Vehicle Release and Aftercare & Warranty, filled in on screen and printed as A4 (nothing saved or booked; kept in the browser tab until New customer or sign-out) | ✓ | ✓ |
| Sales Reports — any date range | ✓ | — |
| Suppliers — each supplier's parts sold, cost, profit and what is still to pay. **Hidden since 2026-11-18** | ✓ | — |
| Analytics — daily, weekly, monthly, quarterly trends | ✓ | — |
| Payroll — weekly attendance, OT, deductions | ✓ | — |
| Settings — users & roles, vehicle classes, change history | ✓ | — |

## Themes

Sidebar → **Theme** (everyone, per device, remembered in the browser): **Classic** (the default look),
**Telemetry** (industrial brutalist, dark; mechanical, stepped motion) and **Editorial** (minimalist, light;
quiet, eased motion). Themes only restyle: `public/themes/*.css` scope every rule to `<html data-theme="…">`
(a test checks this), `public/js/theme.js` runs the switch, and a script in `index.html` applies the saved
theme before the first paint. All motion stops with the system's reduced-motion setting.

## Departments

| Department | Tab | JO numbers | Counts as a sale |
|---|---|---|---|
| Carwash | Carwash | `CW-MMDDYY-###` | on the day it is entered (same-day) |
| Detailing | Detailing | `DT-MMDDYY-###` | on the day it is **finished** (marked done), paid or not |
| Tint & PPF | Tint & PPF | `TP-MMDDYY-###` | same as Detailing |
| Parts counter | Parts | `PC-MMDDYY-###` | same as Detailing |

- Detailing, Tint & PPF and parts jobs are **running**: they stay on their board day after day until done and paid.
  A job's commission (a parts job's labor too) is paid out on the day it is marked done, whether or not the customer has paid.
- A new running job takes the same form as Carwash (Payment, Customer paid, GCash tip) plus **Job done**. The date
  at the top picks the day, as on Carwash. Tick both and it is a sale that day and goes straight to Completed; tick
  Customer paid only and the money counts that day while the job stays on the board; tick Job done only and it is
  that day's sale, unpaid, until **Mark paid**. A job entered paid or done needs its day open.
- The board's cards: **Vehicles, Collected, Commission, Net** are the picked day (the same as EOD). **Unpaid (all
  days)** is what customers owe for finished jobs, **In progress** the jobs still being worked on, whatever the
  day. **Completed since** is the total of the Completed list from its "finished since" date.
- Every service belongs to one department (Pricing Matrix → department tabs) and is only offered there.
  Add-ons are shared: every add-on is offered on Carwash, Detailing and Tint & PPF jobs.
- EOD and Sales Reports combine all departments and show each department's sales separately.
- Money is counted the day it is received, so the drawer matches what is really there: a running job paid before
  it is finished is in that day's drawer, and one paid after it is finished is in the later day's drawer. Its sale
  and commission are booked on the day it is done either way (agreed 2026-11-05, migration 016). A job finished and
  not paid is that day's receivable, and its commission comes out of that day's drawer, like an unpaid carwash job.
- A carwash job on credit can be paid on a later day: ticking **Paid** on a job of an earlier day asks for the
  payment date (today unless changed). Its sale and commission stay on the day of the job; the money counts in the
  drawer of the day it was paid, so a late payment never changes a closed day's count, and staff can record it
  although the day of the job is closed (migration 020).
- Once a running job is paid, its amount (items, class, discount) is locked until the payment is undone.
- The board's **Completed** list shows every job done and paid, finished since a chosen day (default: the last 7 days), including
  any dated after today, so a finished job never drops out of sight. Completed jobs can still be edited,
  have their payment undone, be marked not done, or be voided by the owner.
- Older `JO-` numbers from before departments existed are kept as they were.

## Parts department moved to Excel (2026-11-18)

From **2026-11-18** the app handles Carwash, Detailing and Tint & PPF only. The parts department is run as its own
business from its own Excel file (sales, stock, suppliers, what it owes the carwash) and keeps its own money.

- **History stays.** Every parts sale up to Nov 17 stays in the app: EOD, Sales Reports, Finance and Analytics show
  those days exactly as before. Nothing is deleted (the `parts` table also holds the shop's supplies).
- **No new parts sales** (`lib/parts-retired.js`): a parts counter job, or a part line on any job, dated from the cutover
  is refused. Older jobs keep their part lines and can still be edited. The Parts and Suppliers tabs, "+ Add part" and
  EOD's supplier-payment tick are hidden (`/api/auth/config` sends the date). Tests and the UI smoke test turn the
  cutover off for the older parts steps and on for the new ones.
- **Lent to Parts / Parts paid back** (EOD → Parts department, staff and owner, migration 023 `parts_loans`): when the
  shop drawer pays something for parts (the mechanic's labor before the customer has paid), it is recorded as lent; when
  parts gives it back, as paid back. Cash or GCash. It moves the expected drawer on its day (`daySummary`, mirrored in
  `eod.js`; the pay week and Remittances follow), never profit. Parts never pays back more than it owes, and a loan
  already paid back cannot be deleted before its repayment. EOD and Finance show what **parts owes the shop**.
- **Parts weekly net** (Finance → Parts department, owner only, `parts_weekly_net`): each pay week (Sunday to Saturday)
  the owner types the NET PROFIT from the Excel file's WEEKLY tab (a loss is negative). Finance adds it under the shop's
  Net profit as **Total net profit**, and Analytics shows it per period (`partsNetIn`): a week counts in the period
  holding its **Saturday**, so a week is never split between months. The first week (Nov 15–21) covers Nov 18–21 only;
  Nov 15–17 is in the app. Weeks not entered yet are marked in Finance.
- Parts' own costs (items, mechanic labor, its expenses) are in its Excel net. Shared costs (rent, bills, staff payroll)
  stay in the app, so they are not taken out twice.

## Business rules (all in `lib/calc.js`)

- A job **counts** once it has a vehicle class or a line item and is not voided.
- **Collected** = totals of paid jobs. **Receivables** = totals of unpaid jobs.
- **Commission** = every counted job (detailers are paid at EOD either way).
- **Net** = Collected − Commission. **Profit** (Sales Reports) = Collected − Commission − Cost of
  parts sold − Expenses, where parts bought to sell are stock, not an expense (`tradingProfit`). It is the Finance
  figure before payroll and bills. Sales Reports lists every day and marks the ones still open; Finance and
  Analytics count a day once it is closed. Its cards: Costs (commission + expenses), **Cost of parts sold**, Profit.
- EOD's cards: **Gross − Commission** (Collected − Commission), then for the owner only **Cost of parts sold** and **Net** =
  Gross − Commission − Expenses − Cost of parts sold: the day's Sales Reports profit (`trading` in `GET /days/:date`,
  removed for staff by `lib/redact.js`).
- Money counts in the drawer or GCash on the day it was received: a running job's or a counter sale's
  payment day (`paid_on`), otherwise the job's own day.
- Expected cash = float + cash collected − commission paid in cash − cash expenses.
- Expected GCash = GCash collected + tips − tips given to the crew − commission via GCash − GCash expenses.
- **GCash tips** stay in GCash until someone gives them to the crew (EOD → "GCash tips given to crew", or the
  reminder's **Mark given** button). Tips not given out carry over: the next days' EOD keeps reminding until
  they are. Closing a day with tips still owed asks first: **Given out, close day** or **Close, give it later**.
  Days before Thu Oct 29, 2026 keep the old rule (tips given out the same day), so their numbers do not change.
- **Copy sales report** (EOD) copies the day's report for the group chat in the boss's format: date, total of cars
  (paid or not), total sales (paid), less comms, less expenses (drawer cash + GCash, not the cash fund), total net,
  then Cash and Gcash as **actually counted** at EOD (the drawer count includes the float) and each side's variance
  (+ over, - short). A side not counted yet says so and has no variance (`salesReport` in `lib/calc.js`).
- **Dates are checked against today** (shop time, `lib/clock.js`): a day cannot be closed, and a job cannot be
  marked done or paid, on a date after today. A job, expense, bill set-aside, bill payment or payroll payout can
  be dated at most 7 days ahead, so a wrong year or month is refused.
- **Money entries are checked**: tips given to the crew cannot be more than the tips held; an identical payroll
  payout is asked about before it is recorded twice; a set-aside that has since paid a bill, or a cash fund
  top-up that has been spent, cannot be removed until the bill payment or purchases are undone.
- A line item's price and commission are **frozen when added**. Editing the Pricing Matrix never
  changes past jobs. Changing a job's vehicle class re-prices its catalog lines at today's prices.
- A week is the pay week, **Sunday to Saturday** (wages are paid on Saturday), on every screen: Payroll, Analytics,
  Finance and Sales Reports ("This week" / "Last week") and a weekly bill envelope's "this week". Payroll opens on this week; This week / Last week / Next week →
  (the Sun–Sat week after the range shown, also after a half week) pick whole weeks.
- New jobs dated today get **Time in** = the current shop time (it keeps up while the form is open) unless
  the user types a time; jobs dated another day get no automatic time. The sidebar shows a live shop clock.
- Every date field opens the app's own calendar (`public/js/components/datepicker.js`): Sunday first,
  Today, month arrows, keyboard (arrows, PageUp/Down, Home/End, Esc), bottom sheet on phones. Typing a date still works.
- Payroll works for any date range (a week, 1st–15th, 16th–end...). Attendance and overtime are
  recorded per day; cash advances, bonuses etc. are dated adjustments. Each day is paid at the rate in
  effect that day (rates change from an effective date), so earlier periods never change.
- Overtime pays the hourly rate (the day's rate ÷ the normal hours of that kind of day) × the OT
  multiplier, by the rule of the day it was worked. The owner sets the shop rule in Payroll → **OT
  settings** (table `ot_rules`): up to Sat Oct 3, 2026 the day's rate ÷ 8 × 1.25; Sun Oct 4 ÷ 8 × 1; from
  Mon Oct 5, 2026 the carwash rate ÷ 11 (an 11-hour carwash day) or the construction rate ÷ 8, × 1.
  Someone whose day is different (e.g. the GM on a standard 8-hour day) gets their own carwash hours
  and/or OT multiplier in Edit; blank follows the shop rule. Like rates, a change only applies from its
  date, so earlier weeks never change.
- Both forms are plain choices (8 / 11 hours, normal rate / +25%, starts this or next pay week) with a
  live preview from the server (`POST /payroll/preview`, `previewChange` in `lib/payroll-data.js`): what
  one OT hour pays, whose recorded pay changes, and any payout already made for a week whose pay would
  change. Such a change needs a second confirm (`confirm_paid`); the server refuses it otherwise (409).
- A payroll payout (wages handed out, weekly) is paid from the money saved during the week, **not** from the payday's
  drawer or GCash: EOD names it under the drawer ("Payroll handed out today") but never takes it out of the expected count,
  so payday is not negative. This applies to every payout, including those recorded before the rule changed.
- EOD's **This pay week** box shows the whole pay week (Sunday to Saturday) of the day picked: each day's money after
  commission and expenses (expected drawer less the float, and expected GCash), the **payroll for that week**, and what is
  left after it (`payWeek` in `lib/calc.js`). A payout belongs to the week holding the middle of its period, so wages for
  Sun–Sat handed out the next Sunday stay with the week they were earned in.
- **Sign-off sheet** (Payroll → Download sign-off sheet): a PDF for the selected pay period (up to 16
  days) with each employee's days, overtime, gross, adjustments, net pay and a signature / date-received
  box, plus Prepared / Checked / Approved / Released by. Employees with nothing to pay are left off.
  Built from the same payroll as the screen (`lib/signoff-pdf.js`, Inter font in `lib/fonts`).
- The old app saved each weekly sheet one day early (UTC dates). Migration 007 moves those converted
  days to the day they were worked, leaving any week already corrected by hand exactly as it is.
- Jobs are **voided** (owner only, with a reason), never deleted. JO numbers are never reused.
- Closing a day locks it for staff. The owner can still edit or reopen it.
- Every insert/update/delete is written to `audit_log` with who did it (Settings → Change history).

## Finance and bill funds (owner)

- **Finance** shows any period (week, month, custom): sales by department, commission, net sales,
  payroll (net pay for work done in the period), bills paid, drawer expenses and **net profit**,
  plus a money in/out view of the drawer.
- **Finance and Analytics count a day only once it is closed at EOD.** Sales, commission, expenses, payroll, bills
  and drawer money dated on a day still open wait until it is closed, and reopening a day takes it back out. A banner
  names the open days that have something on them. Fund balances and the **Bills paid** list stay live, because that
  money has really moved and a bill must stay undoable.
- **Bill funds** (Meralco, Maynilad, Internet, Rent, Business permit, or any you add) each have a usual
  amount and due date. The owner chooses per bill whether to **set money aside every week or every month**
  (`funds.set_aside_every`, weekly by default). The **target** = what is still needed ÷ weeks left, or ÷ calendar
  months left counting this one.
- At EOD, the **Bill envelopes** card shows the pay week of the day picked ("Week of Nov 15 – 21") and lists each bill
  that has an amount with this week's or month's share and one button ("Put ₱800.00 aside", from cash); "Other amount"
  allows a different amount, GCash, and an online **transfer fee**. Envelopes are put aside **by the week** (migration 022,
  `fund_set_asides.week_start`): once a week on any day of it, from the week's money like payroll, never out of that day's
  expected drawer. EOD's **This pay week** box takes them off ("Bill envelopes this week"), and Remittances leaves them out
  of the money for the bank on the day they were put aside. A fee is an ordinary expense of that day, paid from the same
  side, and is removed when the envelope is undone. Envelopes put aside before migration 022 stay daily (they came out of their
  day's drawer), so no closed day changes.
- When a bill is paid (Finance → Pay bill) it comes out of its fund; any shortfall comes out of that
  day's drawer and shows on that day's EOD.
- Set-asides are not costs. The cost is counted when the bill is paid.
- **Bills paid** (Finance) lists every bill paid in the period; **Undo** removes one recorded by mistake
  completely (fund, that day's drawer and profit go back). The audit log keeps a record of it.
- Finance opens with a **How Finance works** guide for new users (it stays closed once someone closes it).

## Analytics (owner)

- **Daily / Weekly / Monthly / Quarterly** show the last 14 days, 8 pay weeks (Sunday to Saturday), 6 months or
  4 calendar quarters up to the chosen day (`GET /analytics`, `periodBuckets` in `lib/calc.js`).
- Every period uses the same math as Finance (`periodTotals` and `profitAndLoss` in `lib/calc.js`), so its sales,
  costs and net profit always equal Finance for the same days. A test checks this for every period.
- The period still running stops at the chosen day. It is compared with the one before **per day with sales** and
  **per car**, never on its unfinished total.
- **To check**: a day with carwash attendance (`P` or `0.5P`) and no sales. If the jobs were never entered, that
  period's sales and profit are too low. Construction days are not flagged.
- **Services** (`serviceTrends` in `lib/calc.js`): each Pricing Matrix service and add-on sold in the periods shown,
  grouped by the name on the sale, because some catalog items were reused for a different service. Only true renames
  are merged (`SERVICE_RENAMES`: Standard Wash is Regular Wash). **Sold** counts every job, paid or not, like Cars;
  **Brought in** is the line price on paid jobs, like Sales. Custom lines, parts and labor are one **Other** line, and
  discounts have their own line, so services + other − discounts = the period's sales (a test checks this against
  Finance). **Change** compares sold per day with sales in the last two periods with sales.

## Cash fund (abonos)

- Money from the boss for purchases the day's sales cannot cover yet (food, supplies, chemicals...).
  Cash fund tab (owner): **Set fund size** (any amount), **Record money received**, **Download list (PDF)**,
  **Replenish**, and History with **Undo**.
- A purchase from the fund is recorded at EOD: Expenses → first box **Cash fund (abono)** (staff can do this).
  It is a cost of that day (Finance: "Bought with the cash fund") but never changes the expected drawer.
  Spending more than the fund holds is refused.
- A replenishment pays back every purchase dated on or before it that was still waiting, so it works
  weekly or monthly. Its itemized list stays printable; undoing it puts the purchases back on the list.
  A purchase already replenished cannot be deleted until that replenishment is undone.
- "Ask the boss for" = fund size − cash in the fund (or, with no size set, what was spent).
- Migration 008 adds `cash_fund`, `cash_fund_topups`, expense side `fund` and `expenses.topup_id`;
  existing expenses are unchanged.

## Remittances (owner)

- The money taken to the bank, one row per passbook line (`remittances`, migration 021): the date, the amount, whether it
  carried the drawer's **cash**, the **GCash** money or **both**, and the business days it covers (`covers_from..covers_to`).
  A deposit for several days at once is normal. Days left empty = a deposit not tied to any day yet (listed on its own).
  A deposit cannot cover a day after it was made, nor be dated after today.
- What a day leaves for the bank is EOD's expected drawer **less the float** (it stays for the next day) and EOD's expected
  GCash: after commission, expenses, bill envelopes and tips given out, **less wages handed out that day** (they come out
  of the money saved before the bank gets it). So a payday is often negative here; only days added together compare with a
  deposit.
- Deposits for the same money and days are added together (one transfer split into several passbook lines), then compared
  with what the app says those days left: **Matches**, **short** or **over** (`remittanceReport` in `lib/calc.js`).
  A day's money taken by two different deposits is flagged on both.
- **Still to deposit**: closed days whose cash or GCash no deposit has covered. Days still open are named and wait until closed.
  **Undo** removes a deposit recorded by mistake.
- **Passbook should say**: the owner sets the last balance printed in the passbook and its date once (`bank_start`, one row;
  setting it again replaces it). The screen adds every deposit dated after that day (`passbookExpected` in `lib/calc.js`), so it
  can be checked against the passbook each time it is updated. Interest and withdrawals are not tracked.
- With no range picked, the screen starts on the passbook date (everything before it is settled), else on the first day any
  deposit covers, else 30 days back.

## Inventory and parts

- **Inventory** tab: everything the shop stocks — auto parts for sale, carwash and detailing chemicals,
  wash mitts, drying towels, microfibers, machines — with SKU, unit, tags, stock and a reorder level
  (low-stock warning). Machines are counted like any other item.
- **Containers**: stock sits in four places: **Overall**, **Carwash**, **Detailing** and **Tint & PPF**. Deliveries and
  pasted stock land in Overall, and auto parts stay there, where they are sold. Tags only label an item; a container
  holds a quantity of it. The chips above the tags show All stock or one container (its items, stock and value).
  **Send** (owner, on an item's details or its Sheet row) moves a quantity between any two containers, back to Overall
  and between departments too. Auto Parts cannot be sent, and an item with stock in a department cannot be tagged Auto
  Parts until that stock is back in Overall. A move is never a cost: Finance, EOD and the drawer do not change, and
  the item's total and average cost stay. Stock value counts every container at the item's average cost, and the
  low-stock warning looks at the total of all four. A move shows once in the item's history (it is stored as two lines
  that cancel out, kind `transfer`), with who did it. Migration 018 adds `department_stock` and
  `stock_movements.department` (null = Overall); `parts.stock` is Overall.
- **Tags** group items (any number per item; owner adds, renames, recolours, deletes them). The built-in
  **Auto Parts** tag is what makes an item *for sale*: only those appear on the **Parts** tab and in a
  job's "+ Add part". It can be renamed but not deleted, and an item tagged with it needs a selling price.
- Inventory and Parts are **simple lists**: each row shows the item's name (with its tags and any set),
  its price and its stock, sorted by name; a search box and the tag chips filter. **Tap a row** for the
  item's details (SKU, price, set, commission, average cost and value for the owner, stock, reorder level)
  and its actions: Count (everyone), Receive, History and Edit (owner).
- **Sheet** (Inventory's List / Sheet switch, remembered per device, starts on List): every item in a grid edited
  in place like Excel. Click a cell and type to replace it; Enter saves and moves down, Tab saves and moves
  right (Shift goes back), Escape cancels, arrow keys move, F2 or double-click edits. Column headers sort; the
  item name stays frozen. The owner edits every field except Avg cost, Total and Value; staff only the container
  columns (Overall, Carwash, Detailing, Tint & PPF). Typing in a container column opens a count there with a reason,
  it never just overwrites the number. Double-click Tags to pick tags. Each row keeps Receive, Send (not for Auto
  Parts), Count, History (with Correct cost) and Edit.
- **Export CSV** opens in Excel / Google Sheets (what is shown, costs only for the owner), with a column per
  container and the total.
  **Paste from Excel** (owner): copy rows with their header row from Excel or Sheets; it shows a preview
  and any row errors, then adds all rows or none. Stock goes into Overall as opening stock at its cost; new tag
  names are created. It only adds new items (an existing name or SKU is refused); edit those in the sheet.
- **Counting is how usage is tracked**: chemicals and supplies are not logged per job. Anyone (staff too)
  records what is on the shelf, in any container (Auto Parts: Overall only); the difference is recorded as **Used**
  (or Damaged / Lost, or a Recount correction) in that container. Only the owner can raise a number; staff who find
  more than the record ask the owner to correct it. A count never just overwrites the number.
- **Receive** (owner) adds a delivery and updates the weighted average cost. **Paid with**: drawer cash,
  GCash or the cash fund records the amount as that day's expense (it shows on EOD as "from Inventory"
  and can only be undone from Inventory; the cash fund refuses more than it holds), or **Already paid /
  opening stock** records no money. Each delivery has its own cost per unit and supplier (the same item from
  another supplier at another price is just another delivery). **Undo** in an item's history removes its
  latest delivery, with its stock, average cost and expense.
- **Correct cost** (owner, any delivery in an item's history): for a delivery entered at the wrong price, e.g.
  opening stock entered at ₱0. The average cost is worked out again from that delivery on (`replayAvgCost` in
  `lib/calc.js`, previewed before saving), so later deliveries keep their weight and Undo still goes back
  exactly; a paid delivery's expense follows (that day's EOD; a cash fund purchase already replenished must be
  un-replenished first). Sales already made keep the cost they were sold at.
- How Finance counts deliveries: a supply (not Auto Parts) is a cost on the day it is bought. An auto part
  bought to sell is stock: the money leaves the drawer (EOD, Finance money in/out), but its cost counts
  only as **cost of parts sold** when it sells, so it is never counted twice.
- **Consignment**: paste or add the item tagged Auto Parts and Consignment, with the dealer price as its cost and
  no money recorded. It sells like any part, and profit is SRP less dealer price on the day of the sale. To remit,
  add an EOD expense and tick **Supplier payment** (owner only): the money leaves the drawer or fund, but it is
  not a second cost in Finance. The Sales Reports profit is a plain total, so it does subtract the payment, as it
  does for parts bought to sell. Consigned stock counts in the Inventory stock value until sold.
- **Suppliers** tab (owner, migration 022): each item can have one supplier (**Give items** on the tab, or Supplier in the
  item's Edit form). For any date range it lists each supplier's parts sold (pieces, sales, cost frozen when sold, profit =
  sales − cost − commission, and **Sold on**: each sale's day, pieces and JO number, marked if the customer has not paid), paid by the customer or not, and the parts sold with no supplier. A supplier either **pays as
  parts sell** (consignment-like) or is **paid on delivery**. For the first, **Still to pay** = cost of its parts sold since
  its "count what is owed from" day, less supplier payments to it since then (`supplierReport` in `lib/calc.js`).
  The tab opens on **Since counting started** (the earliest such day, at most 400 days back), so the sales listed add up
  to Still to pay; it keeps the days picked when you come back to it.
  **Record payment** adds a supplier payment (an EOD expense with `for_resale` and `supplier_id`), so it is not a second
  cost; EOD's Supplier payment box can name the supplier too. The item is the supplier's now, so changing an item's
  supplier moves its past sales with it. A job's discount is not split over its parts.
- Parts can be added with a quantity to any Carwash, Detailing or Tint & PPF job, or sold as a job order on the
  Parts tab ("Parts counter" department, `PC-` numbers, no vehicle needed). A part can stay for days until it is
  installed, so the tab is a running board with the same cards, date arrows and form as Tint & PPF. A walk-in ticks
  Customer paid and Job done and is finished at once; an install stays open. The part leaves stock when the job is
  opened, so it cannot be sold twice; voiding puts it back. Migration 017 made every older counter sale a finished
  job on its own day, so no day's numbers changed.
  A paid parts job must say **Cash or GCash** (nothing is picked for them; the server refuses a paid job
  without one). EOD's Cash drawer and GCash cards then show "from parts counter" on its own line.
- On a new sale, a part's **price each** can be raised above its list price (a harder job, a pricier
  source); never below it: lower the total with the Discount box. The list price in Inventory does not change.
- **Labor** (parts jobs): typed per job, since easy and hard installs differ, and it can be changed with **Edit**
  until the job is paid. The customer pays it on top of the parts and all of it is the installer's commission (a
  `labor` line: price = commission), so it shows in EOD's commission on the day the job is done. Once per job.
  Migration 014 allows the `labor` line kind.
- **Parts jobs** are itemized on the board: each item with its price (quantity × price each), labor, any discount,
  then the total. The Parts tab's search box covers the parts list and the jobs (JO#, items, plate, sold by).
- **Paid later**: a parts job finished and not paid stays on the board with a **Mark paid** button, which asks the
  day and Cash or GCash. The sale and its labor stay on the day it was done (Receivable there until paid, Collected
  after); the money counts in the drawer or GCash on the **day it was paid** (`jobs.paid_on`), where EOD notes it as
  money for earlier jobs. **Undo payment** takes it back off that day. Same closed-day rules as other jobs.
- **Sets**: a part can also sell as a set (e.g. one bulb ₱2,000, a pair ₱3,500). Count stock in **pieces**
  (unit `pc`) and fill **Set of** (pieces per set) and **Set price** (and commission per set). "+ Add part"
  then offers both; a set line takes its pieces from the same stock, and removing, voiding or restoring it
  moves exactly those pieces. Its cost is the pieces' average cost. Blank Set of = not sold as a set.
  Migration 010 adds `parts.set_size / set_price / set_commission` and `job_items.pack_size`.
- Selling takes stock out and freezes the part's average cost on the line; removing the part or
  voiding the job puts the stock back. Selling more than is in stock is blocked.
- Every stock change is recorded (stock history, owner). Costs and margins are owner-only: staff never
  receive cost fields from the API.
- Migration 009 adds `tags`, `part_tags`, stock change kind `use`, `stock_movements.expense_id` /
  `prev_avg_cost` and `expenses.for_resale`. The `parts` table holds every inventory item.

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
