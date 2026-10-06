# Operational test: one full week, then undo everything

A complete run through the shop's week: carwash and detailing jobs, EOD closing, bill envelopes
(put aside, pay the bill), the cash fund for abonos (spend, replenish), payroll (attendance, overtime, cash advance, payout, sign-off sheet) and Finance.
The second half undoes every step and checks that everything is back to zero.

**Run it in the sandbox, not on the live app.** The sandbox is the full app on a throwaway database.
It is wiped when it stops, so nothing reaches production. On the live app some steps cannot be fully
undone, by design: voided jobs stay on record, JO numbers are never reused, and the change log keeps
every action.

- Start: `npm run sandbox` (inside `gmqa-app/`), then open http://localhost:3100
- Sign in as `owner@sandbox` (any password). For the staff steps, sign in as `staff@sandbox`.
- Test week: **Mon Oct 5 to Sun Oct 11, 2026**. Type the dates shown; the app defaults to today.
- Prices are the sandbox's sample prices, not your live Pricing Matrix. The expected numbers below
  were checked against a real run of this script.

Tick each box when what you see matches.

---

## Part 1: Run the week

### 0. Set up the Internet bill (owner)
Finance → Bill funds → **Internet** → **Edit**: Usual bill amount `1599`, Due day `15` → Save.
- [ ] Next due **2026-10-15**, weekly target **₱800.00** (on Oct 5)

### 1. Monday Oct 5: Carwash (staff)
Carwash tab, date **Oct 5**. Add three jobs:

| Plate | Class | Items | Payment |
|---|---|---|---|
| TST 001 | M | Premium Wash + Engine Wash (add-on) | Cash, paid |
| TST 002 | S | Standard Wash | GCash, paid |
| TST 003 | L | Standard Wash | Cash, **not** paid |

- [ ] JO numbers **CW-100526-001, -002, -003**
- [ ] TST 001 total **₱1,450.00**, commission **₱250.00**
- [ ] TST 003 shows as unpaid (receivable **₱350.00**). Now tick it **Paid**.

### 2. Monday Oct 5: Detailing job opened (staff)
Detailing tab → New job, Opened on **Oct 5**: class M, plate `TST 100`, detailer `Menan`,
**Paint Correction** + **Headlight Restoration** (add-on) → Review → Create.
- [ ] **DT-100526-001**, total **₱7,000.00**, commission **₱1,400.00**, status "In progress"
- [ ] It is **not** in Monday's sales yet

### 3. Monday Oct 5: EOD Closing (staff)
EOD Closing, date **Oct 5**:
- Supervisor `Test Supervisor`, Cash float `2000`
- Expense: `Soap and towels`, paid from **Drawer cash**, `300`
- **Bill envelopes** card → Internet shows "Put ₱800.00 aside this week" → press **Put ₱800.00 aside**

- [ ] Sales **₱2,050.00**, commission **₱250.00**
- [ ] Cash received **₱1,800.00**, GCash received **₱250.00**
- [ ] Internet now says **Done for this week ✓**, and the Cash drawer box shows "− Put aside for bills (envelopes) ₱800.00"
- [ ] Expected cash **₱2,450.00** (2,000 float + 1,800 − 250 commission − 300 soap − 800 put aside)
- [ ] Expected GCash **₱250.00**
- Enter Actual cash `2450` and Actual GCash `250` → variance **₱0.00** → **Close day**
- [ ] As staff, try to add another expense on Oct 5: it is **refused** (day closed)

### 4. Tuesday Oct 6: paid in advance, and the first abono
- EOD Closing, Oct 6: Cash float `2000` (staff)
- Detailing → DT-100526-001 → **Mark paid**: date **Oct 6**, GCash (staff)
- Carwash, Oct 6: plate `TST 004`, class S, Premium Wash, cash, paid (staff)

- [ ] Detailing status "Paid 10-06 · in progress" (still on the board)
- [ ] EOD Oct 6: sales **₱600.00** (the detailing job is **not** a sale yet), paid in advance **₱7,000.00**
- [ ] Expected cash **₱2,500.00**, expected GCash **₱7,000.00**

**Cash fund (owner):** Cash fund tab → **Set fund size** `20000` → **Record money received**: date **Oct 6**, `20000`, note `Starting fund (TEST)`.
- [ ] Fund size **₱20,000.00**, cash in the fund **₱20,000.00**

**Abono (staff):** EOD Closing, Oct 6 → Expenses: first box **Cash fund (abono)**, `Chemicals: Soft99 5L (TEST)`, `1200` → **+ Add**.
- [ ] The expense shows a green **Cash fund** label and the note "₱1,200.00 was paid from the cash fund"
- [ ] Expected cash is still **₱2,500.00** (a cash-fund purchase never touches the drawer)
- [ ] Cash fund tab: cash in the fund **₱18,800.00**, "Ask the boss for" **₱1,200.00**, the purchase is under **Waiting to be replenished**
- [ ] Try adding a cash-fund expense of `20000`: it is refused ("only has ₱18,800.00 left")

### 5. Wednesday Oct 7: job finished, bill paid
- EOD Closing, Oct 7: Cash float `3000` (staff)
- Detailing → DT-100526-001 → **Mark done**: date **Oct 7** (staff)
- Finance → Internet → **Pay bill** (owner): date **Oct 7**, amount `1599`, shortfall from Cash drawer, note `October internet (TEST)`

- [ ] The job moves to **Completed**; Detailing sales are now **₱7,000.00**
- [ ] The Pay bill box says **₱800.00 from the fund, ₱799.00 from the drawer**
- [ ] EOD Oct 7: sales **₱7,000.00**, commission **₱1,400.00**, "paid earlier" **₱7,000.00**, bill from drawer **₱799.00**
- [ ] Expected cash **₱801.00** (3,000 − 1,400 commission − 799 bill)
- [ ] Finance → Internet fund balance **₱0.00**, next due moves to **2026-11-15**

### 6. Payroll (owner)
Payroll → **+ Add employee**: `ZZ Test Worker`, carwash rate `500`, construction rate `800`.
Set the range to **Oct 5 – Oct 11** and fill the row:

| Mon 5 | Tue 6 | Wed 7 | Thu 8 | Fri 9 | Sat 10 | Sun 11 |
|---|---|---|---|---|---|---|
| P | P + **2h** carwash OT | CN + **1h** construction OT | A | 0.5P | P | OFF |

Add a deduction on **Oct 8**: `300`, note `Cash advance (TEST)`.
- [ ] Note above the table: "OT pays the carwash rate ÷ 11 (construction rate ÷ 8) × 1 per hour."
- [ ] OT pay **₱190.91** (500 ÷ 11 × 2 = 90.91, plus 800 ÷ 8 × 1 = 100)
- [ ] Gross **₱2,740.91** (3.5 carwash days 1,750 + 1 construction day 800 + OT 190.91)
- [ ] Net **₱2,440.91** after the ₱300 deduction
- [ ] **Sign-off sheet (PDF)** downloads as `Payroll_Signoff_Oct5-Oct11_2026.pdf` with ZZ Test Worker on it

Record a payout: date **Oct 11**, cash, `2440.91`.
- [ ] EOD Oct 11 shows payroll paid out **₱2,440.91** (expected cash goes below zero because that day has no float; that is expected)

**Replenish the cash fund (owner), Sunday:** Cash fund tab → **Download list (PDF)**.
- [ ] `Cash_Fund_Replenishment_Oct…_2026.pdf` lists Oct 6, Chemicals: Soft99 5L (TEST), ₱1,200.00, total ₱1,200.00, with Prepared / Checked / Received by lines

Press **Replenish ₱1,200.00** → date **Oct 11** → **Record**.
- [ ] Cash in the fund back to **₱20,000.00**, nothing waiting; History shows ₱1,200.00 with "1 item"

### 7. Finance for the week (owner)
Finance, From **Oct 5** To **Oct 11**:

| Profit & loss | Expected |
|---|---|
| Carwash sales | ₱2,650.00 |
| Detailing sales | ₱7,000.00 |
| Gross sales | ₱9,650.00 |
| − Commission | ₱1,750.00 |
| Net sales | ₱7,900.00 |
| Payroll | ₱2,440.91 |
| Bill: Internet | ₱1,599.00 |
| Drawer expenses | ₱300.00 |
| Bought with the cash fund (abonos) | ₱1,200.00 |
| Total operating expenses | ₱5,539.91 |
| **Net profit** | **₱2,360.09** |

| Money in & out of the drawer | Expected |
|---|---|
| Cash received | ₱2,400.00 |
| GCash received | ₱7,250.00 |
| − Commission paid | ₱1,750.00 |
| − Drawer expenses | ₱300.00 |
| − Payroll paid out | ₱2,440.91 |
| − Set aside to bill funds | ₱800.00 |
| − Bill shortfalls paid from drawer | ₱799.00 |
| **Left over for the owner** | **₱3,560.09** (the abono is a cost, but it never left the drawer) |

- [ ] All of the above match
- [ ] **Bills paid** lists Internet, 2026-10-07, ₱1,599.00 (₱800.00 from fund, ₱799.00 cash drawer)
- [ ] Sales Reports for Oct 5–11 show the same sales total, ₱9,650.00

---

## Part 2: Undo everything (newest first)

| # | Where | Action |
|---|---|---|
| 0 | Cash fund → History | **Undo** the ₱1,200.00 replenishment (the purchase goes back to "Waiting") |
| 1 | Payroll, Oct 5–11 | **Delete payout** on the ₱2,440.91 payout |
| 2 | Payroll | Delete the ₱300 cash advance |
| 3 | Payroll | Clear all seven days of ZZ Test Worker: set each day to **—** and its OT to 0 |
| 4 | Payroll | ZZ Test Worker → Edit → **Remove from payroll** |
| 5 | Finance → Bills paid | **Undo** the Internet bill; the box says ₱800.00 back to the fund and ₱799.00 back to the cash drawer on 2026-10-07 |
| 6 | Detailing → Completed (Since Oct 5) | DT-100526-001 → **Not done**, then **Undo payment**, then **✕ Void** (reason `Operational test`) |
| 7 | Carwash, Oct 5 and Oct 6 | **✕ Void** TST 001–004 (reason `Operational test`) |
| 8 | EOD Closing, Oct 5 (owner) | **Reopen** the day, press ✕ on "₱800.00 cash today" in Bill envelopes, **Delete** the ₱300 soap expense, set float, actual cash and actual GCash back to 0 / blank |
| 9 | EOD Closing, Oct 6 and Oct 7 | Delete the ₱1,200 cash-fund expense on Oct 6; set both cash floats back to 0 |
| 10 | Finance → Internet → Edit | Usual amount back to `0` |
| 11 | Cash fund | **Undo** the ₱20,000.00 starting fund in History; **Set fund size** back to `0` |

Check the result:
- [ ] Finance Oct 5–11: every line **₱0.00**, net profit **₱0.00**, Bills paid "No bills paid in this period."
- [ ] Internet fund balance **₱0.00**
- [ ] Cash fund: size ₱0.00, cash in the fund ₱0.00, History empty
- [ ] EOD Oct 5: 0 vehicles, sales ₱0.00, expected cash ₱0.00
- [ ] Payroll Oct 5–11: ZZ Test Worker no longer listed
- [ ] The voided jobs are still visible with "Show voided" and in Settings → Change history (kept on record by design)

Stop the sandbox (Ctrl+C) and everything is gone.
