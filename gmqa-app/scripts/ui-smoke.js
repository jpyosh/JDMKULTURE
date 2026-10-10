#!/usr/bin/env node
// End-to-end smoke test of the real UI in a headless browser (installed Edge or Chrome) against
// the sandbox server. Fails on any page error, console error, or broken flow.
//   npm run test:ui              (SCREENSHOTS=<dir> to save a screenshot of every view)
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { start } = require('./sandbox');

const SHOTS = process.env.SCREENSHOTS;
const DAY = '2026-09-14';

async function launch() {
  for (const channel of ['msedge', 'chrome']) {
    try { return await chromium.launch({ channel, headless: true }); } catch { /* try next */ }
  }
  throw new Error('No Edge or Chrome installation found');
}

(async () => {
  const { server, url } = await start(0);
  const browser = await launch();
  // Pinned to shop time: the old payroll bug only appeared in UTC+8.
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, timezoneId: 'Asia/Manila' });
  const problems = [];
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('dialog', d => d.accept(d.type() === 'prompt' ? 'Smoke test void' : undefined));

  const shot = async name => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }); } };
  // Waits until the toast shows a message matching re (earlier toasts may still be visible).
  const expectToast = re => page.waitForFunction(src => new RegExp(src).test(document.querySelector('#app-toast.show')?.textContent || ''), re.source, { timeout: 8000 });
  const step = async (name, fn) => { process.stdout.write(`• ${name} ... `); await fn(); console.log('ok'); };
  const signIn = async email => {
    await page.fill('#login-email', email);
    await page.fill('#login-password', 'x');
    await page.click('#login-form button[type=submit]');
    await page.waitForSelector('#app:not([hidden])');
  };

  try {
    await step('sign-in gate', async () => {
      await page.goto(url);
      await page.waitForSelector('#login-form:not([hidden])');
      assert.match(await page.textContent('#gate-message'), /owner@sandbox/);
      await shot('00-gate');
      await signIn('owner@sandbox');
      assert.deepEqual(await page.locator('#nav button').allTextContents(),
        ['Carwash', 'Detailing', 'Tint & PPF', 'Parts & Inventory', 'EOD Closing', 'Pricing Matrix', 'Sales Reports',
          'Finance', 'Cash fund', 'Payroll', 'Settings']);
    });

    await step('design: system type, readable contrast, keyboard focus, reduced motion', async () => {
      await page.waitForSelector('#view-carwash .metric');
      const look = await page.evaluate(() => {
        const rgb = c => c.match(/[\d.]+/g).slice(0, 3).map(Number);
        const lum = c => {
          const [r, g, b] = rgb(c).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
        const css = sel => getComputedStyle(document.querySelector(sel));
        const primary = css('#view-carwash [data-review]');
        return {
          font: css('body').fontFamily,
          heading: css('#view-carwash h1').fontFamily,
          muted: contrast(css('#view-carwash .desc').color, css('body').backgroundColor),
          label: contrast(css('#view-carwash .metric .label').color, css('#view-carwash .metric').backgroundColor),
          button: contrast(primary.color, primary.backgroundColor),
        };
      });
      assert.match(look.font, /^-apple-system|^system-ui/, 'body uses the system font (SF Pro on Apple devices)');
      assert.match(look.heading, /^-apple-system|^system-ui/, 'headings use the system font');
      assert.ok(look.muted >= 4.5, `secondary text contrast ${look.muted.toFixed(2)}:1 is below 4.5:1`);
      assert.ok(look.label >= 4.5, `metric label contrast ${look.label.toFixed(2)}:1 is below 4.5:1`);
      assert.ok(look.button >= 4.5, `primary button text contrast ${look.button.toFixed(2)}:1 is below 4.5:1`);
      // Keyboard focus is always visible.
      await page.keyboard.press('Tab');
      await page.locator('#nav button').first().focus();
      const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return `${s.outlineStyle} ${s.boxShadow}`; });
      assert.notEqual(ring, 'none none', 'focused nav button shows a focus ring');
      // Reduced motion turns animations off.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const duration = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#app-toast')).transitionDuration));
      assert.ok(duration <= 0.01, `toast still animates (${duration}s) with reduced motion`);
      await page.emulateMedia({ reducedMotion: 'no-preference' });
    });

    const daily = page.locator('#view-carwash');
    const shopHHMM = () => page.evaluate(() => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()));
    const minutesApart = (a, b) => { const m = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3)); return Math.min(Math.abs(m(a) - m(b)), 1440 - Math.abs(m(a) - m(b))); };

    await step('live shop clock in the sidebar', async () => {
      const clock = page.locator('[data-clock]');
      await clock.waitFor();
      const first = await clock.textContent();
      assert.match(first, /\d{1,2}:\d{2}:\d{2}\s?(AM|PM)/, `clock shows the time with seconds (got "${first}")`);
      assert.match(first, /(Sun|Mon|Tue|Wed|Thu|Fri|Sat)/, 'clock shows the day');
      await page.waitForFunction(prev => document.querySelector('[data-clock]').textContent !== prev, first, { timeout: 3000 });
    });

    await step('new jobs get the current time unless it is changed', async () => {
      // The carwash tab opens on today: Time in is filled with the shop time.
      const timeIn = daily.locator('[data-editor] [data-f="time_in"]');
      await timeIn.waitFor();
      assert.ok(minutesApart(await timeIn.inputValue(), await shopHHMM()) <= 1, `time in is now (got "${await timeIn.inputValue()}")`);
      // A time typed by the user is kept (the auto time never overwrites it).
      await timeIn.fill('08:15');
      await timeIn.dispatchEvent('input');
      await page.waitForTimeout(6000);
      assert.equal(await timeIn.inputValue(), '08:15', 'a time the user typed is kept');
      // Detailing: a new job opened today also gets the time.
      await page.click('#nav [data-view="detailing"]');
      const dtTime = page.locator('#view-detailing [data-editor] [data-f="time_in"]');
      await dtTime.waitFor();
      assert.ok(minutesApart(await dtTime.inputValue(), await shopHHMM()) <= 1, 'detailing time in is now');
      // A job opened on an earlier day gets no automatic time.
      await page.locator('#view-detailing [data-open-date]').fill('2026-09-14');
      await page.locator('#view-detailing [data-open-date]').dispatchEvent('change');
      await page.waitForFunction(() => document.querySelector('#view-detailing [data-editor] [data-f="time_in"]').value === '');
      await page.click('#nav [data-view="carwash"]');
    });

    await step('time picker: our own, 12-hour, Now, Escape', async () => {
      const timeIn = daily.locator('[data-editor] [data-f="time_in"]');
      await timeIn.click();
      const tp = page.locator('.timepicker');
      await tp.waitFor();
      assert.notEqual(await tp.evaluate(el => getComputedStyle(el).backgroundColor), 'rgb(255, 255, 255)', 'dark theme');
      assert.equal(await tp.locator('[data-tp-hour]').count(), 12);
      assert.equal(await tp.locator('[data-tp-minute]').count(), 60);
      await tp.locator('[data-tp-hour="7"]').click();
      await tp.locator('[data-tp-minute="05"]').click();
      await tp.locator('[data-tp-ampm="AM"]').click();
      await tp.locator('[data-tp-done]').click();
      await page.waitForFunction(() => !document.querySelector('.timepicker'));
      assert.equal(await timeIn.inputValue(), '07:05');
      await timeIn.click();
      await tp.waitFor();
      await tp.locator('[data-tp-ampm="PM"]').click();
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.timepicker'));
      assert.equal(await timeIn.inputValue(), '07:05', 'Escape leaves the time as it was');
      await timeIn.click();
      await tp.locator('[data-tp-now]').click();
      assert.ok(minutesApart(await timeIn.inputValue(), await shopHHMM()) <= 1, 'Now sets the current time');
    });

    await step('review job: Time in is filled and editable; what it shows is saved', async () => {
      const editor = daily.locator('[data-editor]');
      const addPremium = async () => {
        await editor.locator('[data-f="vehicle_class"]').selectOption('S');
        await editor.locator('[data-add="service"]').selectOption({ label: 'Premium Wash' });
      };
      // A time typed in the form is what Review shows.
      await addPremium();
      await editor.locator('[data-f="time_in"]').fill('08:15');
      await editor.locator('[data-f="time_in"]').dispatchEvent('input');
      await daily.locator('[data-review]').click();
      const reviewTime = page.locator('#modal [data-review-time]');
      await reviewTime.waitFor();
      assert.equal(await reviewTime.inputValue(), '08:15');
      // Changed in Review: that is the time saved, shown as 12-hour with In / Out labels.
      await reviewTime.fill('10:05');
      await page.click('#modal [data-confirm]');
      await expectToast(/added/);
      const row = daily.locator('[data-jobs] tr', { hasText: '10:05 AM' });
      await row.waitFor();
      assert.match(await row.locator('.time-cell').textContent(), /In\s*10:05 AM[\s\S]*Out/);
      // An untouched form: Review shows the current time.
      await addPremium();
      await daily.locator('[data-review]').click();
      await reviewTime.waitFor();
      assert.ok(minutesApart(await reviewTime.inputValue(), await shopHHMM()) <= 1, 'Review fills in the current time');
      await page.click('#modal [data-close]');
      await daily.locator('[data-clear]').click();
    });

    await step('carwash tab shows migrated jobs', async () => {
      await daily.locator('[data-date]').fill(DAY);
      await daily.locator('[data-date]').dispatchEvent('change');
      await page.waitForFunction(() => document.querySelectorAll('#view-carwash [data-jobs] tr[data-id]').length === 19);
      assert.match(await daily.locator('[data-metrics]').textContent(), /Vehicles\s*19/);
    });

    await step('create a job with service + add-on + custom line', async () => {
      const editor = daily.locator('[data-editor]');
      await editor.locator('[data-f="vehicle_class"]').selectOption('M');
      await editor.locator('[data-f="plate"]').fill('smk 123');
      assert.equal(await editor.locator('[data-add="part"]').count(), 1, 'parts can be added to carwash jobs');
      await editor.locator('[data-add="service"]').selectOption({ label: 'Premium Wash' });
      await editor.locator('[data-add="addon"]').selectOption({ label: 'Engine Wash' });
      await editor.locator('[data-add="addon"]').selectOption({ label: 'Bac 2 Zero' });
      await editor.locator('[data-add-custom]').click();
      await editor.locator('[data-l="name"]').fill('Tire black');
      await editor.locator('[data-l="price"]').fill('100');
      await editor.locator('[data-l="commission"]').fill('20');
      await editor.locator('[data-f="discount"]').fill('50');
      assert.match(await editor.locator('[data-totals]').textContent(), /Total\s*₱2,100\.00/); // 650+800+600+100-50
      await shot('01-daily-entry');
      await daily.locator('[data-review]').click();
      await page.waitForSelector('#modal[open]');
      await shot('02-review');
      await page.click('#modal [data-confirm]');
      await expectToast(/CW-091426-001 added/);
      await page.waitForFunction(() => document.querySelectorAll('#view-carwash [data-jobs] tr[data-id]').length === 20);
      assert.equal(await daily.locator('[data-editor] .line-row').count(), 0, 'editor resets after adding');
    });

    const newRow = daily.locator('tr', { hasText: 'CW-091426-001' });
    await step('inline paid toggle updates totals', async () => {
      await newRow.locator('[data-inline="payment_received"]').check();
      await expectToast(/Saved/);
      await page.waitForFunction(() => /Collected\s*₱[\d,]+/.test(document.querySelector('#view-carwash [data-metrics]').textContent));
    });

    await step('edit job: change class re-prices catalog lines', async () => {
      await newRow.locator('[data-act="edit"]').click();
      await page.waitForSelector('#modal[open] [data-edit-editor] .line-row');
      await page.selectOption('#modal [data-f="vehicle_class"]', 'L');
      assert.match(await page.textContent('#modal [data-totals]'), /Total\s*₱2,150\.00/); // 700+800+600+100-50
      await shot('03-edit-modal');
      await page.click('#modal [data-save]');
      await expectToast(/saved/);
      assert.match(await newRow.textContent(), /₱2,150\.00/);
    });

    await step('void and restore (owner)', async () => {
      await newRow.locator('[data-act="void"]').click();
      await expectToast(/voided/);
      await page.waitForFunction(() => document.querySelectorAll('#view-carwash [data-jobs] tr[data-id]').length === 19);
      await daily.locator('[data-filter="voided"]').check();
      await newRow.locator('[data-act="restore"]').click();
      await expectToast(/restored/);
      await shot('04-daily-table');
    });

    await step('job history modal', async () => {
      await newRow.locator('[data-act="history"]').click();
      await page.waitForSelector('#modal[open] .history-entry');
      assert.ok(await page.locator('#modal .history-entry').count() >= 4);
      await shot('05-history');
      await page.click('#modal [data-close]');
    });

    const detailing = page.locator('#view-detailing');
    await step('detailing: running job is carried over, paid, then done', async () => {
      await page.click('#nav [data-view="detailing"]');
      const editor = detailing.locator('[data-editor]');
      await detailing.locator('[data-open-date]').fill(DAY);
      const services = await editor.locator('[data-add="service"] option').allTextContents();
      assert.ok(services.includes('Paint Correction') && !services.includes('Premium Wash'), 'only detailing services offered');
      const addons = await editor.locator('[data-add="addon"] option').allTextContents();
      for (const name of ['Asphalt Removal', 'Headlight Restoration', 'Waterless Engine Detail', 'Engine Wash', 'Bac 2 Zero']) {
        assert.ok(addons.includes(name), `${name} is offered on detailing jobs`);
      }
      await editor.locator('[data-f="vehicle_class"]').selectOption('M');
      await editor.locator('[data-f="plate"]').fill('dtl 777');
      await editor.locator('[data-add="service"]').selectOption({ label: 'Paint Correction' });
      await detailing.locator('[data-review]').click();
      await page.click('#modal [data-confirm]');
      await expectToast(/DT-091426-001 added/);
      const row = detailing.locator('[data-active] tr', { hasText: 'DT-091426-001' });
      await row.waitFor();
      assert.match(await row.textContent(), /In progress/);
      // Every action button must be fully visible inside the card (no clipping behind a scrollbar).
      const clipped = await page.evaluate(() => {
        const wrap = document.querySelector('#view-detailing [data-active]').closest('.table-wrap').getBoundingClientRect();
        return [...document.querySelectorAll('#view-detailing [data-active] [data-act]')]
          .filter(b => { const r = b.getBoundingClientRect(); return r.right > wrap.right + 1 || r.left < wrap.left - 1; })
          .map(b => b.textContent.trim() || b.title);
      });
      assert.deepEqual(clipped, [], 'board action buttons are clipped');
      await shot('05b-detailing-board');

      await row.locator('[data-act="pay"]').click();
      await page.fill('#modal [data-pay-date]', DAY);
      await page.selectOption('#modal [data-pay-method]', 'Cash');
      await page.click('#modal [data-confirm]');
      await expectToast(/payment recorded/i);
      await page.waitForFunction(() => /Paid/.test(document.querySelector('#view-detailing [data-active]').textContent));

      await row.locator('[data-act="complete"]').click();
      await page.fill('#modal [data-done-date]', '2026-09-15');
      await page.click('#modal [data-confirm]');
      await expectToast(/done/i);
      await page.waitForFunction(() => !/DT-091426-001/.test(document.querySelector('#view-detailing [data-active]').textContent));
      // The completed list shows every sale since the chosen day (here: days before the sale).
      await detailing.locator('[data-completed-date]').fill('2026-09-10');
      await detailing.locator('[data-completed-date]').dispatchEvent('change');
      const doneRow = detailing.locator('[data-completed] tr', { hasText: 'DT-091426-001' });
      await doneRow.waitFor();
      await shot('05c-detailing-completed');
      // A completed job can still be corrected: edit, undo payment, not done, and (owner) void + restore.
      for (const act of ['edit', 'unpay', 'reopen', 'void']) {
        assert.equal(await doneRow.locator(`[data-act="${act}"]`).count(), 1, `completed row has ${act}`);
      }
      await doneRow.locator('[data-act="void"]').click();
      await expectToast(/voided/);
      await page.waitForFunction(() => /VOID/.test(document.querySelector('#view-detailing [data-completed]').textContent));
      await doneRow.locator('[data-act="restore"]').click();
      await expectToast(/restored/);
      await page.waitForFunction(() => !/VOID/.test(document.querySelector('#view-detailing [data-completed]').textContent));
    });

    const eod = page.locator('#view-eod');
    await step('EOD: setup, expense, live variance, close day', async () => {
      await page.click('#nav [data-view="eod"]');
      await eod.locator('[data-date]').fill(DAY);
      await eod.locator('[data-date]').dispatchEvent('change');
      await page.waitForFunction(() => /Vehicles\s*20/.test(document.querySelector('#view-eod [data-metrics]').textContent));
      await eod.locator('[data-e="description"]').fill('Soap');
      await eod.locator('[data-e="amount"]').fill('120');
      await eod.locator('[data-add-expense]').click();
      await expectToast(/Expense added/);
      // Bill envelopes: plain steps, one button per bill with this week's amount filled in.
      const envelopes = eod.locator('[data-envelopes]');
      assert.match(await envelopes.textContent(), /no amount yet/i, 'bills without an amount are explained, not shown as rows');
      assert.equal(await envelopes.locator('[data-envelope]').count(), 0);
      await page.evaluate(() => fetch('/api/funds/1', { method: 'PATCH', headers: { Authorization: 'Bearer owner@sandbox', 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 2000, due_day: 25 }) }));
      await eod.locator('[data-date]').dispatchEvent('change');
      const meralcoRow = envelopes.locator('[data-envelope]', { hasText: 'Meralco' });
      await meralcoRow.waitFor();
      const guideText = await envelopes.textContent();
      for (const words of [/envelope/i, /owner/i, /this week/i]) assert.match(guideText, words);
      const oneTap = meralcoRow.locator('[data-put-aside]');
      const target = (await oneTap.textContent()).match(/₱[\d,.]+/)[0];
      await oneTap.click();
      await expectToast(/aside/i);
      await page.waitForFunction(() => /Done for this week/i.test(document.querySelector('#view-eod [data-envelope]')?.textContent || ''));
      const cashBox = await eod.locator('[data-cash]').textContent();
      assert.ok(/Put aside for bills/.test(cashBox) && cashBox.includes(target), `drawer shows the ${target} put aside`);
      // Undo, then put a different amount aside (the "Other amount" path).
      await meralcoRow.locator('[data-del-sa]').click();
      await expectToast(/removed|undone/i);
      await meralcoRow.locator('[data-other]').click();
      await meralcoRow.locator('[data-sa-amount]').fill('500');
      await meralcoRow.locator('[data-sa-side]').selectOption('cash');
      await meralcoRow.locator('[data-sa-add]').click();
      await expectToast(/aside/i);
      await page.waitForFunction(() => /₱500\.00/.test(document.querySelector('#view-eod [data-envelope]')?.textContent || ''));
      const rowHeight = (await meralcoRow.boundingBox()).height;
      assert.ok(rowHeight < 160, `envelope rows are too tall (${Math.round(rowHeight)}px)`);
      await eod.locator('[data-m="cash_float"]').fill('1000');
      const expected = (await eod.locator('[data-cash] .row-line.total .money').textContent()).replace(/[₱,]/g, '');
      await eod.locator('[data-m="actual_cash"]').fill(expected);
      await eod.locator('[data-m="actual_gcash"]').fill('0');
      assert.match(await eod.locator('[data-variance]').textContent(), /✓/);
      await eod.locator('[data-save]').click();
      await expectToast(/EOD saved/);
      await shot('06-eod');
      await eod.locator('[data-close-day]').click();
      await expectToast(/Day closed/);
      await page.waitForSelector('#view-eod .banner.ok');
    });

    await step('calendar: our own sleek date picker (Sunday first, Today, keyboard, Escape)', async () => {
      const input = eod.locator('[data-date]');
      await input.fill('2026-09-14');
      await input.dispatchEvent('change');
      await input.click();
      const picker = page.locator('.datepicker');
      await picker.waitFor();
      assert.deepEqual((await picker.locator('.dp-weekday').allTextContents()).map(t => t.trim()), ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']);
      assert.match(await picker.locator('.dp-title').textContent(), /September 2026/);
      assert.equal(await picker.locator('.dp-day[aria-selected="true"]').textContent(), '14');
      const bg = await picker.evaluate(el => getComputedStyle(el).backgroundColor);
      assert.notEqual(bg, 'rgb(255, 255, 255)', 'the picker follows the dark theme');
      // Pick a day: the input and the page follow (change event).
      await picker.locator('.dp-day:not(.dp-outside)', { hasText: /^15$/ }).click();
      await page.waitForFunction(() => document.querySelector('#view-eod [data-date]').value === '2026-09-15' && !document.querySelector('.datepicker'));
      await page.waitForFunction(() => /Sep 15, 2026/.test(document.querySelector('#view-eod [data-status]').textContent));
      // Next month, keyboard, then Escape closes without changing anything.
      await input.click();
      await picker.waitFor();
      await picker.locator('[data-dp-next]').click();
      assert.match(await picker.locator('.dp-title').textContent(), /October 2026/);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.datepicker'));
      assert.equal(await input.inputValue(), '2026-09-15');
      // Today button.
      await input.click();
      await picker.locator('[data-dp-today]').click();
      const today = await page.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; });
      await page.waitForFunction(t => document.querySelector('#view-eod [data-date]').value === t, today);
      await shot('06b-datepicker');
      await input.fill(DAY);
      await input.dispatchEvent('change');
    });

    await step('EOD shows sales by department', async () => {
      await eod.locator('[data-date]').fill('2026-09-15');
      await eod.locator('[data-date]').dispatchEvent('change');
      await page.waitForFunction(() => /Detailing/.test(document.querySelector('#view-eod [data-departments]')?.textContent || ''));
      const breakdown = await eod.locator('[data-departments]').textContent();
      assert.match(breakdown, /Detailing[\s\S]*₱5,000\.00/);
      assert.match(breakdown, /Carwash/);
      assert.match(breakdown, /Tint & PPF/);
      await shot('06b-eod-departments');
    });

    await step('pricing: edit and save a price', async () => {
      await page.click('#nav [data-view="pricing"]');
      const row = page.locator('#view-pricing tr:has([data-name][value="Standard Wash"])');
      await row.locator('[data-class="S"][data-field="price"]').fill('275');
      await page.click('#view-pricing [data-save-all]');
      await expectToast(/Saved 1 item/);
      await shot('07-pricing');

      // Department tabs: each shows only its own services; add-ons are one shared list on every tab.
      const addonNames = () => page.locator('#view-pricing [data-table="addon"] [data-name]').evaluateAll(els => els.map(e => e.value));
      const allAddons = await addonNames();
      assert.ok(allAddons.includes('Engine Wash') && allAddons.includes('Headlight Restoration'), 'carwash tab lists every add-on');
      await page.click('#view-pricing [data-dept-tab="detailing"]');
      await page.waitForSelector('#view-pricing [data-name][value="Paint Correction"]');
      assert.equal(await page.locator('#view-pricing [data-name][value="Standard Wash"]').count(), 0);
      assert.deepEqual(await addonNames(), allAddons, 'detailing tab lists the same add-ons');
      assert.equal(await page.locator('#view-pricing [data-table="addon"] select[data-dept]').count(), 0, 'add-ons have no department');
      await page.click('#view-pricing [data-dept-tab="tint_ppf"]');
      await page.click('#view-pricing [data-add="service"]');
      await page.waitForSelector('#modal[open] [data-new-name]');
      await page.fill('#modal [data-new-name]', 'Ceramic Tint 70%');
      await page.click('#modal [data-confirm]');
      await expectToast(/Ceramic Tint 70% added/);
      await page.waitForSelector('#view-pricing [data-name][value="Ceramic Tint 70%"]');
      assert.deepEqual(await addonNames(), allAddons, 'tint & PPF tab lists the same add-ons');
      await shot('07b-pricing-tint');
    });

    await step('parts: add a part, receive stock, sell over the counter', async () => {
      await page.click('#nav [data-view="parts"]');
      const parts = page.locator('#view-parts');
      await parts.locator('[data-new-part]').click();
      await page.fill('#modal [data-p="sku"]', 'OIL-1L');
      await page.fill('#modal [data-p="name"]', 'Engine oil 1L');
      await page.fill('#modal [data-p="price"]', '550');
      await page.fill('#modal [data-p="reorder_level"]', '2');
      await page.click('#modal [data-confirm]');
      await expectToast(/Part added/);
      const row = parts.locator('[data-parts] tr', { hasText: 'Engine oil 1L' });
      await row.waitFor();
      assert.match(await row.textContent(), /Low/, 'no stock yet: flagged low');

      await row.locator('[data-act="receive"]').click();
      await page.fill('#modal [data-r="quantity"]', '12');
      await page.fill('#modal [data-r="unit_cost"]', '300');
      await page.click('#modal [data-confirm]');
      await expectToast(/Stock received/);
      await page.waitForFunction(() => /\b12\b/.test([...document.querySelectorAll('#view-parts [data-parts] tr')]
        .find(r => r.textContent.includes('Engine oil 1L'))?.querySelector('[data-stock]')?.textContent || ''));

      await parts.locator('[data-counter-date]').fill('2026-09-21');
      await parts.locator('[data-counter-date]').dispatchEvent('change');
      await parts.locator('[data-new-sale]').click();
      await page.waitForSelector('#modal[open] [data-add="part"]');
      assert.equal(await page.locator('#modal [data-add="service"]').count(), 0, 'no services at the parts counter');
      await page.selectOption('#modal [data-add="part"]', { index: 1 });
      await page.fill('#modal [data-l="quantity"]', '2');
      assert.match(await page.textContent('#modal [data-totals]'), /Total\s*₱1,100\.00/);
      await page.click('#modal [data-save]');
      await expectToast(/PC-092126-001 added/);
      const sale = parts.locator('[data-counter] tr', { hasText: 'PC-092126-001' });
      await sale.waitFor();
      assert.match(await sale.textContent(), /Paid/, 'counter sales default to paid (cash-and-carry)');
      assert.doesNotMatch(await sale.textContent(), /Unpaid/);
      await page.waitForFunction(() => [...document.querySelectorAll('#view-parts [data-parts] tr')]
        .find(r => r.textContent.includes('Engine oil 1L'))?.querySelector('[data-stock]')?.textContent.trim().startsWith('10'));
      await shot('07c-parts');
    });

    await step('sales report', async () => {
      await page.click('#nav [data-view="reports"]');
      await page.fill('#view-reports [data-start]', '2026-09-01');
      await page.fill('#view-reports [data-end]', '2026-09-30');
      await page.locator('#view-reports [data-end]').dispatchEvent('change');
      await page.waitForSelector('#view-reports tr.weekly-total');
      // No hidden filters: payment method and paid status are plain columns, and there is a reading guide.
      assert.equal(await page.locator('#view-reports select').count(), 0, 'no filter dropdowns');
      const headers = (await page.locator('#view-reports thead th').allTextContents()).map(t => t.trim());
      for (const h of ['Cash received', 'GCash received', 'Unpaid', 'Carwash', 'Detailing', 'Tint & PPF', 'Total sales', 'Profit']) {
        assert.ok(headers.includes(h), `missing column ${h} in ${JSON.stringify(headers)}`);
      }
      assert.match(await page.locator('#view-reports [data-help]').textContent(), /How to read/);
      const money = async label => Number((await page.locator(`#view-reports tr.weekly-total td[data-label="${label}"]`).textContent()).replace(/[₱,]/g, ''));
      assert.equal(await money('Cash received') + await money('GCash received'), await money('Total sales'),
        'everything sold in September was also paid in September');
      await shot('08-reports');
    });

    const payroll = page.locator('#view-payroll');
    const setPayrollRange = async (start, end) => {
      await payroll.locator('[data-start]').fill(start);
      await payroll.locator('[data-end]').fill(end);
      await payroll.locator('[data-end]').dispatchEvent('change');
      await page.waitForFunction(([s, e]) => {
        const heads = document.querySelectorAll('#view-payroll thead .attendance-day');
        return heads.length && heads[0].dataset.date === s && heads[heads.length - 1].dataset.date === e;
      }, [start, end]);
    };
    const dayHeads = async () => (await payroll.locator('thead .attendance-day').allTextContents()).map(t => t.replace(/\s+/g, ''));

    await step('finance: month in/out, funds, pay a bill', async () => {
      await page.click('#nav [data-view="finance"]');
      const fin = page.locator('#view-finance');
      await fin.locator('[data-start]').fill('2026-09-01');
      await fin.locator('[data-end]').fill('2026-09-30');
      await fin.locator('[data-end]').dispatchEvent('change');
      await page.waitForFunction(() => /Net profit/.test(document.querySelector('#view-finance [data-pl]')?.textContent || ''));
      const pl = await fin.locator('[data-pl]').textContent();
      for (const label of ['Gross sales', 'Commission', 'Net sales', 'Payroll', 'Drawer expenses', 'Net profit']) assert.match(pl, new RegExp(label));
      const meralco = fin.locator('[data-funds-table] tr', { hasText: 'Meralco' });
      assert.match(await meralco.textContent(), /₱500\.00/, 'the EOD set-aside is in the fund');

      await meralco.locator('[data-act="edit-fund"]').click();
      await page.fill('#modal [data-fund-amount]', '8000');
      await page.click('#modal [data-confirm]');
      await expectToast(/Fund saved/);

      await fin.locator('[data-funds-table] tr', { hasText: 'Meralco' }).locator('[data-act="pay-bill"]').click();
      await page.fill('#modal [data-bill-date]', '2026-09-25');
      await page.fill('#modal [data-bill-amount]', '3000');
      await page.selectOption('#modal [data-bill-side]', 'cash');
      await page.click('#modal [data-confirm]');
      await expectToast(/Bill recorded/);
      await page.waitForFunction(() => /Meralco[\s\S]*₱3,000\.00/.test(document.querySelector('#view-finance [data-pl]').textContent));
      await shot('08c-finance');

      // New users get step-by-step directions on the page.
      const guide = fin.locator('[data-guide]');
      assert.equal(await guide.count(), 1, 'Finance has a how-to guide');
      const guideText = await guide.textContent();
      for (const words of [/Profit & loss/, /drawer/i, /Set aside/i, /Pay bill/, /Undo/]) assert.match(guideText, words);

      // A bill recorded by mistake is listed for the period and can be undone in full.
      const paidRow = fin.locator('[data-bills-paid] tr', { hasText: 'Meralco' });
      assert.match(await paidRow.textContent(), /2026-09-25[\s\S]*₱3,000\.00/);
      await paidRow.locator('[data-act="undo-bill"]').click();
      await expectToast(/undone/i);
      await page.waitForFunction(() => !/Bill: Meralco/.test(document.querySelector('#view-finance [data-pl]').textContent));
      assert.equal(await fin.locator('[data-bills-paid] tr', { hasText: 'Meralco' }).count(), 0);
      await shot('08d-finance-undone');
    });

    await step('cash fund: start it, abono at EOD (drawer untouched), itemized list, replenish, undo', async () => {
      // Empty fund: an abono is refused with a clear message.
      await page.click('#nav [data-view="eod"]');
      await eod.locator('[data-date]').fill('2026-09-16');
      await eod.locator('[data-date]').dispatchEvent('change');
      await page.waitForFunction(() => document.querySelector('#view-eod [data-date]').value === '2026-09-16');
      assert.ok((await eod.locator('[data-e="side"] option').allTextContents()).some(t => /cash fund/i.test(t)), 'expenses can be paid from the cash fund');
      await eod.locator('[data-e="side"]').selectOption('fund');
      await eod.locator('[data-e="description"]').fill('Chemicals: Soft99 5L');
      await eod.locator('[data-e="amount"]').fill('1200');
      const problemsBefore = problems.length;
      await eod.locator('[data-add-expense]').click();
      await expectToast(/cash fund/i);
      // The browser logs the refused request (400) as a console error; that one is expected here.
      assert.ok(problems.slice(problemsBefore).some(p => /status of 400/.test(p)), 'the server refused spending from an empty fund');
      problems.splice(problemsBefore, problems.length - problemsBefore, ...problems.slice(problemsBefore).filter(p => !/status of 400/.test(p)));

      // Owner starts the fund.
      await page.click('#nav [data-view="cash_fund"]');
      const cf = page.locator('#view-cash_fund');
      await cf.locator('[data-guide]').waitFor();
      for (const words of [/abono/i, /EOD/, /replenish/i]) assert.match(await cf.locator('[data-guide]').textContent(), words);
      await cf.locator('[data-set-target]').click();
      await page.fill('#modal [data-target]', '20000');
      await page.click('#modal [data-confirm]');
      await expectToast(/saved/i);
      await cf.locator('[data-add-money]').click();
      await page.fill('#modal [data-topup-amount]', '20000');
      await page.fill('#modal [data-topup-note]', 'Starting fund');
      await page.click('#modal [data-confirm]');
      await expectToast(/recorded/i);
      await page.waitForFunction(() => /₱20,000\.00/.test(document.querySelector('#view-cash_fund [data-balance]')?.textContent || ''));

      // Abono at EOD: a cost of the day, but the expected drawer does not change.
      await page.click('#nav [data-view="eod"]');
      await page.waitForFunction(() => document.querySelector('#view-eod [data-date]').value === '2026-09-16');
      const drawerBefore = await eod.locator('[data-cash] .row-line.total .money').textContent();
      await eod.locator('[data-e="side"]').selectOption('fund');
      await eod.locator('[data-e="description"]').fill('Chemicals: Soft99 5L');
      await eod.locator('[data-e="amount"]').fill('1200');
      await eod.locator('[data-add-expense]').click();
      await expectToast(/Expense added/);
      await page.waitForFunction(() => /Cash fund[\s\S]*Chemicals: Soft99 5L/.test(document.querySelector('#view-eod [data-expenses]').textContent));
      assert.equal(await eod.locator('[data-cash] .row-line.total .money').textContent(), drawerBefore, 'drawer untouched by a cash-fund purchase');

      // The itemized list, then replenish.
      await page.click('#nav [data-view="cash_fund"]');
      await page.waitForFunction(() => /₱18,800\.00/.test(document.querySelector('#view-cash_fund [data-balance]')?.textContent || ''));
      const pendingRow = cf.locator('[data-pending] tr', { hasText: 'Chemicals: Soft99 5L' });
      assert.match(await pendingRow.textContent(), /2026-09-16[\s\S]*₱1,200\.00/);
      assert.match(await cf.locator('[data-to-replenish]').textContent(), /₱1,200\.00/);
      const [download] = await Promise.all([page.waitForEvent('download'), cf.locator('[data-sheet]').click()]);
      assert.match(download.suggestedFilename(), /^Cash_Fund_.*\.pdf$/);
      await shot('09-cash-fund');
      await cf.locator('[data-replenish]').click();
      assert.equal(await page.inputValue('#modal [data-topup-amount]'), '1200');
      await page.click('#modal [data-confirm]');
      await expectToast(/recorded/i);
      await page.waitForFunction(() => /₱20,000\.00/.test(document.querySelector('#view-cash_fund [data-balance]')?.textContent || ''));
      assert.equal(await cf.locator('[data-pending] tr', { hasText: 'Chemicals' }).count(), 0);
      const history = cf.locator('[data-topups] tr', { hasText: '₱1,200.00' });
      assert.match(await history.textContent(), /1 item/);

      // Undo the replenishment: the item is waiting again.
      await history.locator('[data-act="undo-topup"]').click();
      await expectToast(/undone/i);
      await cf.locator('[data-pending] tr', { hasText: 'Chemicals: Soft99 5L' }).waitFor();
      await shot('09b-cash-fund-undone');
    });

    await step('payroll: any date range, days line up with weekdays', async () => {
      await page.click('#nav [data-view="payroll"]');
      // The shop's pay week runs Sunday to Saturday: Payroll opens on it, and "This week" / "Last week" follow it.
      await payroll.locator('thead .attendance-day').first().waitFor();
      const isSunToSat = heads => heads.length === 7 && heads[0].startsWith('Sun') && heads[6].startsWith('Sat');
      const opened = await dayHeads();
      assert.ok(isSunToSat(opened), `payroll opens on a Sunday–Saturday week (got ${opened[0]} … ${opened.at(-1)})`);
      await payroll.locator('[data-preset="last-week"]').click();
      await page.waitForFunction(first => document.querySelector('#view-payroll thead .attendance-day')?.textContent.replace(/\s+/g, '') !== first, opened[0]);
      assert.ok(isSunToSat(await dayHeads()), 'Last week is Sunday–Saturday');
      await payroll.locator('[data-preset="this-week"]').click();
      await page.waitForFunction(first => document.querySelector('#view-payroll thead .attendance-day')?.textContent.replace(/\s+/g, '') === first, opened[0]);
      assert.deepEqual(await dayHeads(), opened, 'This week is the week Payroll opened on');
      // Next week: the Sunday–Saturday week after the range shown, even from a half week.
      await setPayrollRange('2026-09-27', '2026-10-03');
      await payroll.locator('[data-preset="next-week"]').click();
      await page.waitForFunction(() => document.querySelector('#view-payroll [data-start]').value === '2026-10-04');
      assert.deepEqual(await dayHeads(), ['Sun10-04', 'Mon10-05', 'Tue10-06', 'Wed10-07', 'Thu10-08', 'Fri10-09', 'Sat10-10']);
      await setPayrollRange('2026-10-04', '2026-10-07');
      await payroll.locator('[data-preset="next-week"]').click();
      await page.waitForFunction(() => document.querySelector('#view-payroll [data-start]').value === '2026-10-11');
      assert.equal(await payroll.locator('[data-end]').inputValue(), '2026-10-17');

      // The calendar highlights the whole range From → To, and previews a new range on hover.
      const dp = page.locator('.datepicker');
      const rangeDays = async () => ({
        start: (await dp.locator('.dp-range-start').allTextContents()).join(),
        end: (await dp.locator('.dp-range-end').allTextContents()).join(),
        inRange: await dp.locator('.dp-in-range').count(),
      });
      await payroll.locator('[data-end]').click();
      await dp.waitFor();
      assert.deepEqual(await rangeDays(), { start: '11', end: '17', inRange: 7 });
      await dp.locator('.dp-day:not(.dp-outside)', { hasText: /^20$/ }).hover();
      assert.deepEqual(await rangeDays(), { start: '11', end: '20', inRange: 10 }, 'hovering a day previews the new range');
      await page.keyboard.press('Escape');
      await payroll.locator('[data-start]').click();
      await dp.waitFor();
      assert.deepEqual(await rangeDays(), { start: '11', end: '17', inRange: 7 }, 'the From calendar shows the same range');
      await page.waitForTimeout(300); // let the calendar finish fading in before the screenshot
      await shot('09c-payroll-range-calendar');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('.datepicker'));
      // Reported bug: week of Mon 2026-09-28 showed Monday as 09-27.
      await setPayrollRange('2026-09-28', '2026-10-04');
      assert.deepEqual(await dayHeads(), ['Mon09-28', 'Tue09-29', 'Wed09-30', 'Thu10-01', 'Fri10-02', 'Sat10-03', 'Sun10-04']);
      // Ranges that are not whole weeks.
      await setPayrollRange('2026-09-01', '2026-09-15');
      assert.equal((await dayHeads()).length, 15);
      assert.equal((await dayHeads())[0], 'Tue09-01');
      await payroll.locator('[data-preset="first-half"]').click();
      await page.waitForFunction(() => document.querySelectorAll('#view-payroll thead .attendance-day').length === 15);
    });

    // Every attendance cell, read as [header date, cell date, code], so a cell in the wrong column shows up.
    const payrollCells = () => page.evaluate(() => {
      const heads = [...document.querySelectorAll('#view-payroll thead .attendance-day')].map(h => h.dataset.date);
      return [...document.querySelectorAll('#view-payroll tbody tr[data-emp]')].map(tr =>
        [...tr.querySelectorAll('select[data-day]')].map((s, i) => [heads[i], s.dataset.day, s.value]));
    });
    const inputsMatchTable = () => page.evaluate(() => {
      const heads = [...document.querySelectorAll('#view-payroll thead .attendance-day')].map(h => h.dataset.date);
      const start = document.querySelector('#view-payroll [data-start]').value;
      const end = document.querySelector('#view-payroll [data-end]').value;
      return heads[0] === start && heads[heads.length - 1] === end;
    });

    await step('payroll: widening the range keeps every day on its own date', async () => {
      // Reported: Monday 09-28 attendance appeared under Sunday 09-27 when the range was widened.
      await setPayrollRange('2026-09-28', '2026-10-04');
      const first = payroll.locator('tbody tr[data-emp]').first();
      const reloaded = page.waitForResponse(r => r.url().includes('/api/payroll?') && r.request().method() === 'GET');
      await first.locator('[data-day="2026-09-28"]').selectOption('CN');
      await reloaded;
      await payroll.locator('[data-start]').fill('2026-09-27');
      await payroll.locator('[data-start]').dispatchEvent('change');
      await page.waitForFunction(() => document.querySelectorAll('#view-payroll thead .attendance-day').length === 8);
      const rows = await payrollCells();
      for (const row of rows) for (const [head, day] of row) assert.equal(day, head, 'cell sits under its own date');
      assert.deepEqual(rows[0].slice(0, 2).map(([d, , code]) => [d, code]), [['2026-09-27', ''], ['2026-09-28', 'CN']]);
      // Narrow again: Monday is still Monday.
      await setPayrollRange('2026-09-28', '2026-10-04');
      assert.equal((await payrollCells())[0][0].join(), '2026-09-28,2026-09-28,CN');
    });

    await step('payroll: a rejected or slow range never leaves the table out of step', async () => {
      await setPayrollRange('2026-09-28', '2026-10-04');
      // A typo makes the range a year long: the server refuses it; the dates go back to what the table shows.
      const problemsBefore = problems.length;
      await payroll.locator('[data-start]').fill('2025-09-28');
      await payroll.locator('[data-start]').dispatchEvent('change');
      await expectToast(/at most/);
      // The browser logs the refused request (400) as a console error; that one is expected here.
      const expected400 = problems.slice(problemsBefore).filter(p => /status of 400/.test(p));
      assert.ok(expected400.length >= 1, 'the over-long range was refused by the server');
      problems.splice(problemsBefore, problems.length - problemsBefore, ...problems.slice(problemsBefore).filter(p => !/status of 400/.test(p)));
      await page.waitForFunction(() => document.querySelector('#view-payroll [data-start]').value === '2026-09-28');
      assert.ok(await inputsMatchTable(), 'date inputs match the table after a refused range');
      // Moving "From" past "To" moves the whole range (same number of days), and the other way round.
      await payroll.locator('[data-start]').fill('2026-10-05');
      await payroll.locator('[data-start]').dispatchEvent('change');
      await page.waitForFunction(() => document.querySelector('#view-payroll thead .attendance-day')?.dataset.date === '2026-10-05');
      assert.equal(await payroll.locator('[data-end]').inputValue(), '2026-10-11');
      assert.ok(await inputsMatchTable());
      await payroll.locator('[data-end]').fill('2026-09-27');
      await payroll.locator('[data-end]').dispatchEvent('change');
      await page.waitForFunction(() => [...document.querySelectorAll('#view-payroll thead .attendance-day')].at(-1)?.dataset.date === '2026-09-27');
      assert.equal(await payroll.locator('[data-start]').inputValue(), '2026-09-21');
      assert.ok(await inputsMatchTable());
      // Typing quickly: an older, slower answer must not replace the newer range.
      await page.route('**/api/payroll?start=2026-09-01*', async route => { await new Promise(r => setTimeout(r, 1500)); await route.continue(); });
      await payroll.locator('[data-start]').fill('2026-09-01');
      await payroll.locator('[data-end]').fill('2026-09-15');
      await payroll.locator('[data-end]').dispatchEvent('change');
      await setPayrollRange('2026-09-21', '2026-09-27');
      await page.waitForTimeout(2000);
      await page.unroute('**/api/payroll?start=2026-09-01*');
      assert.deepEqual(await dayHeads(), ['Mon09-21', 'Tue09-22', 'Wed09-23', 'Thu09-24', 'Fri09-25', 'Sat09-26', 'Sun09-27'], 'the latest range wins');
      assert.ok(await inputsMatchTable());
    });

    await step('payroll: the overtime note follows the rule of the days shown', async () => {
      const note = () => payroll.locator('[data-ot-rule]').textContent();
      await setPayrollRange('2026-09-21', '2026-09-27');
      assert.equal(await note(), "OT pays the day's rate ÷ 8 × 1.25 per hour.");
      await setPayrollRange('2026-09-28', '2026-10-04');
      assert.equal(await note(), "OT pays the day's rate ÷ 8 × 1.25 per hour up to Oct 3, 2026, and the day's rate ÷ 8 × 1 from Oct 4, 2026.");
      await setPayrollRange('2026-10-05', '2026-10-11');
      assert.equal(await note(), 'OT pays the carwash rate ÷ 11 (construction rate ÷ 8) × 1 per hour.');
      await setPayrollRange('2026-10-01', '2026-10-07');
      assert.match(await note(), /× 1\.25 per hour up to Oct 3, 2026; the day's rate ÷ 8 × 1 on Oct 4, 2026; and the carwash rate ÷ 11 \(construction rate ÷ 8\) × 1 from Oct 5, 2026/);
    });

    await step('payroll: OT pay is shown next to OT hours', async () => {
      await setPayrollRange('2026-10-05', '2026-10-11');
      const heads = (await payroll.locator('thead th').allTextContents()).map(t => t.trim());
      assert.equal(heads[heads.indexOf('OT') + 1], 'OT pay', 'OT pay column right after OT hours');
      const row = payroll.locator('tbody tr[data-emp]').first();
      assert.equal((await row.locator('[data-ot-pay]').textContent()).trim(), '—', 'no overtime: no OT pay');
      await row.locator('[data-act="ot"]').click();
      await page.fill('#modal [data-cw="2026-10-05"]', '2');
      await page.click('#modal [data-confirm]');
      await expectToast(/Overtime saved/);
      await page.waitForFunction(() => document.querySelector('#view-payroll tbody tr[data-emp] [data-ot-pay]').textContent.trim() !== '—');
      // Carwash rate from the row ("… · ₱600.00 / ₱0.00"); carwash OT after Oct 5 is an 11-hour day at × 1: rate / 11 × 2.
      const rate = Number((await row.locator('.employee-cell .muted').textContent()).match(/₱([\d,]+\.\d\d)/)[1].replace(/,/g, ''));
      const expected = `₱${(Math.round(rate / 11 * 2 * 100) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      assert.equal((await row.locator('[data-ot-pay]').textContent()).trim(), expected);
      assert.equal((await row.locator('[data-act="ot"]').textContent()).trim(), '2h');
    });

    await step('payroll: sign-off sheet downloads as a PDF', async () => {
      await setPayrollRange('2026-09-27', '2026-10-04');
      // Reported: the button was hard to find (it sat below the whole table). It must be on screen
      // at the top of Payroll without scrolling.
      await page.evaluate(() => window.scrollTo(0, 0));
      const signoffBox = await payroll.locator('[data-signoff]').boundingBox();
      assert.ok(signoffBox && signoffBox.y >= 0 && signoffBox.y + signoffBox.height <= 1000, `sign-off button off screen (y=${signoffBox?.y})`);
      const above = await page.evaluate(() => document.querySelector('#view-payroll [data-signoff]').getBoundingClientRect().top
        < document.querySelector('#view-payroll .payroll-table').getBoundingClientRect().top);
      assert.ok(above, 'sign-off button sits above the payroll table');
      const [file] = await Promise.all([page.waitForEvent('download'), payroll.locator('[data-signoff]').click()]);
      assert.equal(file.suggestedFilename(), 'Payroll_Signoff_Sep27-Oct4_2026.pdf');
      const saved = await file.path();
      const bytes = fs.readFileSync(saved);
      assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
      assert.ok(bytes.length > 5000, 'a real document, not an error page');
    });

    await step('payroll: a raise during the week pays the whole week, earlier weeks untouched', async () => {
      // Reported: Chesser (800/day) got 850 on Saturday; editing the rate did not change his payout for
      // the week (it started today), and saving 850 again from Sunday did nothing since 850 was "already" his rate.
      const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date()));
      const addD = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
      const sunday = addD(today, -new Date(`${today}T00:00:00Z`).getUTCDay());
      const lastSunday = addD(sunday, -7);
      const fmt = n => `₱${(Math.round(n * 100) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const otPay = rate => (sunday >= '2026-10-05' ? rate / 11 : rate / 8) * 2; // 2h carwash OT on Sunday
      const netIs = want => page.waitForFunction(w => [...document.querySelectorAll('#view-payroll tbody tr[data-emp]')]
        .find(tr => tr.textContent.includes('Raise Tester'))?.querySelector('[data-net]').textContent.trim() === w, want, { timeout: 8000 });
      await setPayrollRange(lastSunday, addD(sunday, 6));
      await payroll.locator('[data-add-employee]').click();
      await page.fill('#modal [data-n="name"]', 'Raise Tester');
      await page.fill('#modal [data-n="rate_per_day"]', '800');
      await page.fill('#modal [data-n="construction_rate"]', '0');
      await page.click('#modal [data-confirm]');
      await expectToast(/Employee added/);
      const row = payroll.locator('tbody tr[data-emp]', { hasText: 'Raise Tester' });
      await row.waitFor();
      // Last Saturday and every day of this week, with 2h OT on Sunday.
      for (const day of [addD(sunday, -1), ...[0, 1, 2, 3, 4, 5, 6].map(i => addD(sunday, i))]) {
        const reloaded = page.waitForResponse(r => r.url().includes('/api/payroll?') && r.request().method() === 'GET');
        await row.locator(`[data-day="${day}"]`).selectOption('P');
        await reloaded;
      }
      await row.locator('[data-act="ot"]').click();
      await page.fill(`#modal [data-cw="${sunday}"]`, '2');
      await page.click('#modal [data-confirm]');
      await expectToast(/Overtime saved/);
      await netIs(fmt(8 * 800 + otPay(800)));

      // First try, as it happened: the raise saved with today as the effective date.
      await row.locator('[data-act="edit"]').click();
      await page.fill('#modal [data-n="effective_from"]', today);
      await page.fill('#modal [data-n="rate_per_day"]', '850');
      await page.click('#modal [data-confirm]');
      await expectToast(/Employee saved/);
      await page.waitForFunction(() => !document.querySelector('#modal[open]'));
      // Edit again: the form starts the change at this pay week's Sunday, says what changes, and saves 850
      // from Sunday even though 850 is already today's rate.
      await row.locator('[data-act="edit"]').click();
      assert.equal(await page.inputValue('#modal [data-n="effective_from"]'), sunday, 'a rate change starts with this pay week by default');
      assert.equal(await page.inputValue('#modal [data-n="rate_per_day"]'), '850');
      assert.match(await page.textContent('#modal [data-rate-note]'), /800\.00.*850\.00/, 'the form says which rate changes from that date');
      await page.click('#modal [data-confirm]');
      await expectToast(/Employee saved/);
      await netIs(fmt(800 + 7 * 850 + otPay(850))).catch(async () =>
        assert.fail(`net ${(await row.locator('[data-net]').textContent()).trim()}, expected ${fmt(800 + 7 * 850 + otPay(850))}`));
      // Days before this week keep the old rate.
      await setPayrollRange(lastSunday, addD(sunday, -1));
      assert.equal((await row.locator('[data-net]').textContent()).trim(), fmt(800), 'last week keeps the old rate');
      await row.locator('[data-act="deactivate"]').click();
      await expectToast(/removed/);
    });

    await step('payroll: attendance, adjustment and payout', async () => {
      await setPayrollRange('2026-09-14', '2026-09-20');
      const first = payroll.locator('tbody tr[data-emp]').first();
      await first.locator('[data-day="2026-09-14"]').selectOption('P');
      await page.waitForFunction(() => document.querySelector('#view-payroll [data-total]').textContent !== '₱0.00');
      // Reported: the option list of a coloured attendance cell was unreadable (light text on the cell's
      // pale tint). Every option must be readable against its own background, in every select.
      await page.waitForSelector('#view-payroll select.code-P');
      const unreadable = await page.evaluate(() => {
        const rgba = c => c.match(/[\d.]+/g).map(Number);
        const lum = c => {
          const [r, g, b] = rgba(c).slice(0, 3).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
          return 0.2126 * r + 0.7152 * g + 0.0722 * b;
        };
        const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
        const bad = [];
        for (const select of document.querySelectorAll('#view-payroll select')) {
          for (const option of select.options) {
            const s = getComputedStyle(option);
            const opaque = (rgba(s.backgroundColor)[3] ?? 1) === 1;
            if (!opaque || contrast(s.color, s.backgroundColor) < 4.5) bad.push(`${select.className} "${option.text}" ${s.color} on ${s.backgroundColor}`);
          }
        }
        return [...new Set(bad)];
      });
      assert.deepEqual(unreadable, [], 'dropdown options must have their own solid background and readable text');
      const netBefore = await first.locator('[data-net]').textContent();

      await first.locator('[data-act="adjust"]').click();
      await page.fill('#modal [data-adj-date]', '2026-09-15');
      await page.selectOption('#modal [data-adj-kind]', 'deduction');
      await page.fill('#modal [data-adj-amount]', '50');
      await page.fill('#modal [data-adj-note]', 'Cash advance');
      await page.click('#modal [data-confirm]');
      await expectToast(/Adjustment added/);
      await page.waitForFunction(before => document.querySelector('#view-payroll tbody tr[data-emp] [data-net]').textContent !== before, netBefore);

      await payroll.locator('[data-payout]').click();
      await page.fill('#modal [data-payout-date]', '2026-09-20');
      await page.selectOption('#modal [data-payout-side]', 'cash');
      assert.ok(Number(await page.inputValue('#modal [data-payout-amount]')) > 0, 'payout amount defaults to total net pay');
      await page.click('#modal [data-confirm]');
      await expectToast(/Payout recorded/);
      await payroll.locator('[data-payouts] .row-line').first().waitFor();
      const paidOut = Number((await payroll.locator('[data-total]').textContent()).replace(/[₱,]/g, ''));
      // Names stay visible while the table is scrolled sideways.
      const nameVisible = await page.evaluate(() => {
        const wrap = document.querySelector('#view-payroll .table-wrap');
        wrap.scrollLeft = wrap.scrollWidth;
        const cell = document.querySelector('#view-payroll tbody .employee-cell').getBoundingClientRect();
        return cell.left >= wrap.getBoundingClientRect().left - 1;
      });
      assert.ok(nameVisible, 'employee names scroll out of view');
      await shot('09-payroll');

      // The payout leaves the drawer on its date: EOD shows it and expects it gone.
      await page.click('#nav [data-view="eod"]');
      await eod.locator('[data-date]').fill('2026-09-20');
      await eod.locator('[data-date]').dispatchEvent('change');
      await page.waitForFunction(() => /Payroll paid out/.test(document.querySelector('#view-eod [data-cash]').textContent));
      await eod.locator('[data-m="cash_float"]').fill('0');
      const expected = Number((await eod.locator('[data-cash] .row-line.total .money').textContent()).replace(/[₱,]/g, ''));
      assert.equal(expected, -paidOut, 'no sales that day, so the drawer is short exactly the payout');
      await page.click('#nav [data-view="payroll"]');
    });

    await step('settings: add staff user and a vehicle class', async () => {
      await page.click('#nav [data-view="settings"]');
      await page.fill('#view-settings [data-u="email"]', 'helper@jdmkulture.ph');
      await page.click('#view-settings [data-add-user]');
      await expectToast(/User added/);
      await page.fill('#view-settings [data-c="code"]', 'van');
      await page.fill('#view-settings [data-c="label"]', 'Van');
      await page.click('#view-settings [data-add-class]');
      await expectToast(/Class added/);
      await page.waitForSelector('#view-settings tr[data-code="VAN"]');
      await shot('10-settings');
    });

    await step('staff: limited nav, closed day is read-only', async () => {
      await page.click('#signout-btn');
      await page.waitForSelector('#login-form:not([hidden])');
      const leftovers = await page.evaluate(() => [...document.querySelectorAll('main .view')].filter(v => v.innerHTML.trim()).map(v => v.id));
      assert.deepEqual(leftovers, [], 'previous user screens must be cleared on sign-out');
      await signIn('staff@sandbox');
      assert.deepEqual(await page.locator('#nav button').allTextContents(), ['Carwash', 'Detailing', 'Tint & PPF', 'Parts & Inventory', 'EOD Closing', 'Pricing Matrix']);
      await page.click('#nav [data-view="carwash"]');
      await daily.locator('[data-date]').fill(DAY);
      await daily.locator('[data-date]').dispatchEvent('change');
      await page.waitForSelector('#view-carwash .banner');
      assert.equal(await daily.locator('[data-entry-card]').isHidden(), true);
      assert.equal(await daily.locator('[data-act="void"]').count(), 0);
      await page.click('#nav [data-view="pricing"]');
      await page.waitForSelector('#view-pricing tbody tr[data-id]');
      assert.equal(await page.locator('#view-pricing tbody input').count(), 0, 'staff sees prices read-only');
      // Staff can sell parts but do not see costs.
      await page.click('#nav [data-view="parts"]');
      await page.locator('#view-parts [data-counter-date]').fill('2026-09-21');
      await page.locator('#view-parts [data-counter-date]').dispatchEvent('change');
      await page.locator('#view-parts [data-counter] tr', { hasText: 'PC-092126-001' }).waitFor();
      assert.equal(await page.locator('#view-parts [data-new-part]').isVisible(), false);
      assert.equal(await page.locator('#view-parts thead th', { hasText: /cost/i }).count(), 0, 'staff must not see part costs');
      await page.goto(`${url}/#settings`);
      await page.waitForSelector('#view-carwash.active');
      await shot('11-staff-daily');
    });

    await step('mobile layout renders', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.click('#nav [data-view="carwash"]');
      await daily.locator('[data-date]').fill('2026-10-05');
      await daily.locator('[data-date]').dispatchEvent('change');
      await page.waitForSelector('#view-carwash [data-entry-card]:not([hidden])');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `page scrolls sideways by ${overflow}px on mobile`);
      // Touch targets: 44pt minimum for navigation and the main actions.
      const short = await page.evaluate(() => [...document.querySelectorAll('#nav button, #view-carwash .date-nav .btn, #view-carwash [data-review]')]
        .filter(el => el.offsetParent).map(el => `${el.textContent.trim() || el.getAttribute('aria-label')} ${Math.round(el.getBoundingClientRect().height)}px`)
        .filter(s => parseInt(s.split(' ').pop(), 10) < 44));
      assert.deepEqual(short, [], 'buttons shorter than 44px on mobile');
      // Payroll (owner): the action buttons, including the sign-off sheet, fit the phone width.
      await page.click('#signout-btn');
      await signIn('owner@sandbox');
      await page.click('#nav [data-view="payroll"]');
      await page.waitForSelector('#view-payroll [data-signoff]');
      const phoneBox = await payroll.locator('[data-signoff]').boundingBox();
      assert.ok(phoneBox && phoneBox.y + phoneBox.height <= 844, `sign-off button below the fold on a phone (y=${phoneBox?.y})`);
      const payrollOverflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(payrollOverflow <= 1, `payroll scrolls sideways by ${payrollOverflow}px on mobile`);
      const offscreen = await page.evaluate(() => [...document.querySelectorAll('#view-payroll .entry-actions .btn')]
        .filter(b => { const r = b.getBoundingClientRect(); return r.left < -1 || r.right > window.innerWidth + 1; }).map(b => b.textContent.trim()));
      assert.deepEqual(offscreen, [], 'payroll buttons cut off on mobile');
      await shot('13-mobile-payroll');
      await shot('12-mobile');
    });

    assert.deepEqual(problems, [], 'browser reported errors');
    console.log('\nUI smoke test passed');
  } catch (error) {
    await shot('zz-failure').catch(() => {});
    console.error(`\nFAILED: ${error.message}`);
    if (problems.length) console.error(problems.join('\n'));
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();
