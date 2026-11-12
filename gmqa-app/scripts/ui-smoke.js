#!/usr/bin/env node
// End-to-end smoke test of the real UI in a headless browser (installed Edge or Chrome) against
// the sandbox server. Fails on any page error, console error, or broken flow.
//   npm run test:ui              (SCREENSHOTS=<dir> to save a screenshot of every view)
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright-core');
const { start } = require('./sandbox');
// Several steps work on days in 2027 so they have a day to themselves. The server refuses dates after today
// (lib/clock.js, covered by test/api.test.js), so for this run today is pinned after them.
require('../lib/clock').setShopToday('2099-12-31');

const SHOTS = process.env.SCREENSHOTS;
const DAY = '2026-09-14';
// Parses a computed 'rgb(r, g, b)' colour; amber = the caution colour (unpaid, commission, costs), not the error red.
const colorOf = css => { const [r, g, b] = css.match(/[\d.]+/g).map(Number); return { r, g, b }; };
const isAmber = c => c.r > 180 && c.g > 120 && c.b < 120;

// What the current theme renders: colours, fonts, corners, motion and WCAG contrast of key text.
const LOOK_PARTS = ['#view-carwash.active h1', '#view-carwash .desc', '#view-carwash .card', '#view-carwash .metric .label',
  '#view-carwash .metric .value.amber', '#view-carwash [data-review]', '#nav button'];
async function readLook(page) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(parts => parts.every(sel => document.querySelector(sel)), LOOK_PARTS);
  return page.evaluate(() => {
    const rgb = c => c.match(/[\d.]+/g).slice(0, 3).map(Number);
    const lum = c => {
      const [r, g, b] = rgb(c).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const contrast = (a, b) => { const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };
    const css = (sel, pseudo) => getComputedStyle(document.querySelector(sel), pseudo);
    const opaque = sel => {
      for (let el = document.querySelector(sel); el; el = el.parentElement) {
        const bg = getComputedStyle(el).backgroundColor;
        if (!/rgba\(.*, 0\)$|transparent/.test(bg)) return bg;
      }
      return getComputedStyle(document.documentElement).backgroundColor;
    };
    const primary = css('#view-carwash [data-review]');
    return {
      theme: document.documentElement.dataset.theme,
      bg: css('body').backgroundColor,
      font: css('body').fontFamily,
      heading: { font: css('#view-carwash h1').fontFamily, case: css('#view-carwash h1').textTransform },
      navFont: css('#nav button').fontFamily,
      radius: { card: css('#view-carwash .card').borderTopLeftRadius, button: primary.borderTopLeftRadius },
      buttonBg: primary.backgroundColor,
      muted: contrast(css('#view-carwash .desc').color, opaque('#view-carwash .desc')),
      label: contrast(css('#view-carwash .metric .label').color, opaque('#view-carwash .metric')),
      button: contrast(primary.color, primary.backgroundColor),
      text: contrast(css('#view-carwash h1').color, opaque('#view-carwash h1')),
      caution: css('#view-carwash .metric .value.amber').color,
      motion: {
        view: css('#view-carwash.active').animationName,
        header: css('#view-carwash.active > .view-header').animationName,
        cursor: css('#view-carwash h1', '::after').animationName,
      },
      overflow: document.documentElement.scrollWidth - window.innerWidth,
    };
  });
}

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
  // Every dialog is accepted, except the next one after declineNext() (its text is kept in lastDeclined).
  let declining = false;
  let lastDeclined = '';
  const declineNext = () => { declining = true; lastDeclined = ''; };
  page.on('dialog', d => {
    if (declining) { declining = false; lastDeclined = d.message(); return d.dismiss(); }
    return d.accept(d.type() === 'prompt' ? 'Smoke test void' : undefined);
  });

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
      // The product is "GM Operations Console": no "QA" anywhere a person can see it.
      assert.match(await page.title(), /GM Operations Console/);
      assert.doesNotMatch(await page.title(), /\bQA\b/);
      assert.match(await page.textContent('#gate .wordmark .sub'), /^GM Operations Console$/);
      await shot('00-gate');
      await signIn('owner@sandbox');
      assert.match(await page.textContent('#app .rail .wordmark .sub'), /^GM Operations Console$/);
      assert.doesNotMatch(await page.evaluate(() => document.body.innerText), /\bQA\b/);
      assert.deepEqual(await page.locator('#nav button').allTextContents(),
        ['Carwash', 'Detailing', 'Tint & PPF', 'Parts', 'Inventory', 'EOD Closing', 'Pricing Matrix', 'Sales Reports',
          'Analytics', 'Finance', 'Cash fund', 'Payroll', 'Settings']);
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
      await page.locator('#view-detailing [data-date]').fill('2026-09-14');
      await page.locator('#view-detailing [data-date]').dispatchEvent('change');
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
      // Scrolling the wide table sideways keeps the JO# column in view.
      const wrap = daily.locator('.table-wrap:has(.jobs-table)');
      const scrolled = await wrap.evaluate(el => { el.scrollLeft = 300; return el.scrollLeft; });
      assert.ok(scrolled > 0, 'jobs table should be wide enough to scroll at 1440px');
      const drift = await wrap.evaluate(el => el.querySelector('tr[data-id] td').getBoundingClientRect().left - el.getBoundingClientRect().left);
      assert.ok(Math.abs(drift) <= 2, `JO# column scrolled out of view (${Math.round(drift)}px)`);
      await wrap.evaluate(el => { el.scrollLeft = 0; });
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
    const shopToday = () => page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date()));
    const asOwner = path => page.evaluate(p => fetch(`/api${p}`, { headers: { Authorization: 'Bearer owner@sandbox' } }).then(r => r.json()), path);
    const carwashDate = async date => {
      await daily.locator('[data-date]').fill(date);
      await daily.locator('[data-date]').dispatchEvent('change');
      await page.waitForFunction(d => document.querySelector('#view-carwash [data-jobs]').dataset.forDay === d, date);
    };
    await step('inline paid toggle on an earlier day asks when it was paid, then updates totals', async () => {
      await newRow.locator('[data-inline="payment_received"]').check();
      await page.waitForSelector('#modal[open] [data-pay-date]');
      assert.equal(await page.inputValue('#modal [data-pay-date]'), await shopToday(), 'the money usually came in today');
      await page.fill('#modal [data-pay-date]', DAY); // paid on the day of the job after all
      await page.click('#modal [data-confirm]');
      await expectToast(/payment recorded/);
      await page.waitForFunction(() => /Collected\s*₱[\d,]+/.test(document.querySelector('#view-carwash [data-metrics]').textContent));
      assert.ok(await newRow.locator('[data-inline="payment_received"]').isChecked());
      assert.equal(await newRow.locator('[data-paid-on]').count(), 0, 'paid on its own day: nothing more to say');
    });

    await step('carwash: credit paid on a later day goes in that day\'s drawer, from the row or the edit form', async () => {
      const [JOB_DAY, PAY_DAY, PAY_DAY_2] = ['2026-07-01', '2026-07-03', '2026-07-04']; // days with nothing else on them
      await carwashDate(JOB_DAY);
      const addCredit = async plate => {
        const editor = daily.locator('[data-editor]');
        await editor.locator('[data-f="vehicle_class"]').selectOption('S');
        await editor.locator('[data-f="plate"]').fill(plate);
        await editor.locator('[data-add="service"]').selectOption({ label: 'Premium Wash' });
        await daily.locator('[data-review]').click();
        await page.click('#modal [data-confirm]');
        await expectToast(/added/);
        await daily.locator('tr', { hasText: plate }).waitFor();
      };
      await addCredit('CREDIT1');
      await addCredit('CREDIT2');
      const row1 = daily.locator('tr', { hasText: 'CREDIT1' });
      const row2 = daily.locator('tr', { hasText: 'CREDIT2' });

      // From the row: cancelling leaves it unpaid; confirming records the day and how it was paid.
      await row1.locator('[data-inline="payment_received"]').check();
      await page.waitForSelector('#modal[open] [data-pay-date]');
      await page.click('#modal [data-close]');
      await page.waitForFunction(() => !document.querySelector('#modal').open);
      assert.equal(await row1.locator('[data-inline="payment_received"]').isChecked(), false, 'cancelled: still unpaid');
      await row1.locator('[data-inline="payment_received"]').check();
      await page.waitForSelector('#modal[open] [data-pay-date]');
      await page.fill('#modal [data-pay-date]', PAY_DAY);
      await page.selectOption('#modal [data-pay-method]', 'GCash');
      await page.click('#modal [data-confirm]');
      await expectToast(/payment recorded/);
      await row1.locator('[data-paid-on]').waitFor();
      assert.match(await row1.locator('[data-paid-on]').textContent(), /07-03/);
      const total = (await asOwner(`/jobs?date=${JOB_DAY}&department=carwash`)).find(j => j.plate === 'CREDIT1').totals.total;
      const payDay = (await asOwner(`/days/${PAY_DAY}`)).summary;
      assert.deepEqual([payDay.gcashReceived, payDay.earlierSalesPaid, payDay.vehicles], [total, total, 0], 'the money is in the day it was paid');
      assert.equal((await asOwner(`/days/${JOB_DAY}`)).summary.gcashReceived, 0, 'not in the day of the job');

      // From the edit form: ticking Customer paid on an earlier day's job asks for the payment date too.
      await row2.locator('[data-act="edit"]').click();
      await page.waitForSelector('#modal[open] [data-edit-editor] .line-row');
      assert.ok(await page.locator('#modal [data-paid-on-cell]').isHidden(), 'no date until it is ticked paid');
      await page.check('#modal [data-f="payment_received"]');
      assert.equal(await page.inputValue('#modal [data-paid-on]'), await shopToday());
      await page.fill('#modal [data-paid-on]', PAY_DAY_2);
      await page.click('#modal [data-save]');
      await expectToast(/saved/);
      await row2.locator('[data-paid-on]').waitFor();
      assert.match(await row2.locator('[data-paid-on]').textContent(), /07-04/);
      assert.equal((await asOwner(`/days/${PAY_DAY_2}`)).summary.cashReceived, total);
      await carwashDate(DAY);
      await newRow.waitFor();
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
    await step('a half-entered job is still there after looking at another tab', async () => {
      for (const [tab, away] of [['carwash', 'pricing'], ['detailing', 'eod']]) {
        await page.click(`#nav [data-view="${tab}"]`);
        const editor = page.locator(`#view-${tab} [data-editor]`);
        await editor.locator('[data-f="plate"]').fill('HALF 123');
        await editor.locator('[data-f="vehicle_class"]').selectOption('M');
        await editor.locator('[data-add="addon"]').selectOption({ label: 'Engine Wash' });
        await page.click(`#nav [data-view="${away}"]`);
        await page.waitForSelector(`#view-${away}.active`);
        await page.click(`#nav [data-view="${tab}"]`);
        await page.waitForSelector(`#view-${tab}.active`);
        await page.waitForLoadState('networkidle');
        assert.equal(await editor.locator('[data-f="plate"]').inputValue(), 'HALF 123', `${tab}: the plate typed is still there`);
        assert.equal(await editor.locator('[data-f="vehicle_class"]').inputValue(), 'M');
        assert.equal(await editor.locator('.line-row').count(), 1, `${tab}: and so is the item added`);
        // Clear empties it, and an empty form is rebuilt on the next visit (new prices and stock).
        await page.click(`#view-${tab} [data-clear]`);
        assert.equal(await editor.locator('[data-f="plate"]').inputValue(), '');
        assert.equal(await editor.locator('.line-row').count(), 0);
      }
      await page.click('#nav [data-view="carwash"]');
    });

    await step('detailing: running job is carried over, paid, then done', async () => {
      await page.click('#nav [data-view="detailing"]');
      const editor = detailing.locator('[data-editor]');
      await detailing.locator('[data-date]').fill(DAY);
      await detailing.locator('[data-date]').dispatchEvent('change');
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

    await step('tint & PPF: carwash cards and form; a job is a sale on the day it is finished', async () => {
      const tint = page.locator('#view-tint_ppf');
      const editor = tint.locator('[data-editor]');
      const TINT_DAY = '2026-08-20';
      const metrics = async () => Object.fromEntries((await tint.locator('[data-metrics] .metric').evaluateAll(cards =>
        cards.map(c => [c.querySelector('.label').textContent.trim(), c.querySelector('.value').textContent.trim()]))));
      const setDay = async day => {
        await tint.locator('[data-date]').fill(day);
        await tint.locator('[data-date]').dispatchEvent('change');
      };
      const vehiclesCard = n => page.waitForFunction(want => document.querySelector('#view-tint_ppf [data-metrics] .metric .value')?.textContent.trim() === want, String(n));
      await page.click('#nav [data-view="tint_ppf"]');
      await editor.locator('[data-f="vehicle_class"]').waitFor();
      await setDay(TINT_DAY);
      await tint.locator('[data-completed-date]').fill('2026-08-01');
      await tint.locator('[data-completed-date]').dispatchEvent('change');
      await page.waitForFunction(() => /08-01/.test(document.querySelector('#view-tint_ppf [data-metrics]').textContent));
      assert.deepEqual(Object.keys(await metrics()),
        ['Vehicles', 'Collected', 'Unpaid (all days)', 'Commission', 'Net (collected − comm.)', 'In progress', 'Completed since 08-01']);
      assert.match(await tint.locator('[data-entry-date]').textContent(), /Aug 20, 2026/);

      // Same form as carwash, plus Job done.
      const addJob = async ({ plate, method, paid, done, tip }) => {
        await editor.locator('[data-f="vehicle_class"]').selectOption('M');
        await editor.locator('[data-f="plate"]').fill(plate);
        await editor.locator('[data-add="addon"]').selectOption({ label: 'Engine Wash' });
        await editor.locator('[data-f="payment_method"]').selectOption(method);
        await editor.locator('[data-f="payment_received"]').setChecked(paid);
        await editor.locator('[data-f="job_done"]').setChecked(done);
        await editor.locator('[data-f="tip_gcash"]').fill(tip);
        await tint.locator('[data-review]').click();
        await page.waitForSelector('#modal[open]');
        const text = await page.locator('#modal').textContent();
        await page.click('#modal [data-confirm]');
        await expectToast(/TP-082026-\d+ added/);
        return text;
      };

      // Paid and done: goes straight to Completed and shows in the day's cards.
      const review = await addJob({ plate: 'tnt 1', method: 'GCash', paid: true, done: true, tip: '50' });
      assert.match(review, /GCash · paid/);
      assert.match(review, /counts as a sale on Thu, Aug 20, 2026/i);
      await tint.locator('[data-completed] tr', { hasText: 'TP-082026-001' }).waitFor();
      assert.equal(await tint.locator('[data-active] tr', { hasText: 'TP-082026-001' }).count(), 0, 'not on the board');
      await vehiclesCard(1);
      const paidCards = await metrics();
      assert.notEqual(paidCards.Collected, '₱0.00');
      assert.equal(paidCards['Unpaid (all days)'], '₱0.00');

      // Done, not paid: on the board, shows as Unpaid. Mark paid keeps the method and tip typed on the form.
      await addJob({ plate: 'tnt 2', method: 'GCash', paid: false, done: true, tip: '75' });
      const owed = tint.locator('[data-active] tr', { hasText: 'TP-082026-002' });
      await owed.waitFor();
      assert.match(await owed.textContent(), /awaiting payment/);
      await vehiclesCard(2);
      assert.notEqual((await metrics())['Unpaid (all days)'], '₱0.00');
      await shot('05d-tint-board');
      await owed.locator('[data-act="pay"]').click();
      assert.equal(await page.inputValue('#modal [data-pay-method]'), 'GCash', 'the method picked on the form');
      assert.equal(await page.inputValue('#modal [data-pay-tip]'), '75', 'the tip typed on the form is not lost');
      assert.equal(await page.inputValue('#modal [data-pay-date]'), TINT_DAY, 'the payment day is the day open on the tab');
      await page.click('#modal [data-confirm]');
      await expectToast(/payment recorded/i);
      await tint.locator('[data-completed] tr', { hasText: 'TP-082026-002' }).waitFor();

      // Paid, still in progress: the In progress card counts it.
      await addJob({ plate: 'tnt 3', method: 'Cash', paid: true, done: false, tip: '' });
      await page.waitForFunction(() => /Paid 08-20 · in progress/.test(document.querySelector('#view-tint_ppf [data-active]').textContent));
      assert.equal((await metrics())['In progress'], '1');

      // The arrows move the cards and the form's day, like Carwash; the Today button comes back.
      await tint.locator('[data-shift="1"]').click();
      await vehiclesCard(0);
      assert.match(await tint.locator('[data-entry-date]').textContent(), /Aug 21, 2026/);
      await tint.locator('[data-today]').click();
      await page.waitForFunction(() => document.querySelector('#view-tint_ppf [data-date]').value !== '2026-08-21');
    });

    const eod = page.locator('#view-eod');
    await step('EOD: setup, expense, live variance, close day', async () => {
      await page.click('#nav [data-view="eod"]');
      await eod.locator('[data-date]').fill(DAY);
      await eod.locator('[data-date]').dispatchEvent('change');
      await page.waitForFunction(() => /Vehicles\s*20/.test(document.querySelector('#view-eod [data-metrics]').textContent));
      // Numbers typed but not saved yet stay on screen while an expense is added.
      const typed = async () => [await eod.locator('[data-m="cash_float"]').inputValue(), await eod.locator('[data-m="actual_cash"]').inputValue()];
      await eod.locator('[data-m="cash_float"]').fill('777');
      await eod.locator('[data-m="actual_cash"]').fill('4321');
      await eod.locator('[data-e="description"]').fill('Soap');
      await eod.locator('[data-e="amount"]').fill('120');
      await eod.locator('[data-add-expense]').click();
      await expectToast(/Expense added/);
      assert.deepEqual(await typed(), ['777', '4321'], 'adding an expense keeps the float and count typed in');
      assert.match(await eod.locator('[data-cash]').textContent(), /Cash float\s*₱777\.00/, 'and the drawer math still uses them');
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
      assert.deepEqual(await typed(), ['777', '4321'], 'putting money aside keeps them too');
      // They were never saved, so leaving the day drops them: another day never shows this day's typing.
      await eod.locator('[data-shift="1"]').click();
      await page.waitForFunction(() => !/Soap/.test(document.querySelector('#view-eod [data-expenses]').textContent)); // the next day is up
      assert.deepEqual(await typed(), ['0', '']);
      await eod.locator('[data-shift="-1"]').click();
      await page.waitForFunction(() => /Soap/.test(document.querySelector('#view-eod [data-expenses]').textContent));
      assert.deepEqual(await typed(), ['0', '']);
      await meralcoRow.waitFor();
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
      // Unpaid and commission need attention but are not errors: amber, not the error red.
      const caution = colorOf(await eod.locator('[data-metrics] .value.amber').first().evaluate(el => getComputedStyle(el).color));
      assert.ok(isAmber(caution), `unpaid/commission should read amber, got rgb(${caution.r},${caution.g},${caution.b})`);
      await eod.locator('[data-save]').click();
      await expectToast(/EOD saved/);
      await shot('06-eod');
      await eod.locator('[data-close-day]').click();
      await expectToast(/Day closed/);
      await page.waitForSelector('#view-eod .banner.ok');
    });

    await step('EOD: GCash tips are a reminder until given to the crew, also when closing the day', async () => {
      // Reported: the GCash card showed a tip as "passed to crew" although nobody had given it out yet.
      const tipJob = (date, tip) => page.evaluate(([d, t]) => fetch('/api/jobs', { method: 'POST',
        headers: { Authorization: 'Bearer owner@sandbox', 'Content-Type': 'application/json' },
        body: JSON.stringify({ job_date: d, vehicle_class: 'S', payment_method: 'GCash', payment_received: true, tip_gcash: t,
          items: [{ name: 'Tip test wash', price: 300, commission: 0 }] }) }).then(r => r.status), [date, tip]);
      const openDay = async date => {
        await eod.locator('[data-date]').fill(date);
        await eod.locator('[data-date]').dispatchEvent('change');
        await page.waitForFunction(d => document.querySelector('#view-eod [data-date]').value === d
          && /is open|Closed by/.test(document.querySelector('#view-eod [data-status]').textContent), date);
      };
      const reminder = eod.locator('[data-tips-reminder]');
      const gcashLine = async label => (await eod.locator('[data-gcash] .row-line', { hasText: label }).locator('.money').textContent()).trim();
      assert.equal(await tipJob('2027-03-01', 50), 201);
      assert.equal(await tipJob('2027-03-03', 30), 201);

      // Day 1: the tip is still to be given; closing asks first. "Later" closes and carries it over.
      await openDay('2027-03-01');
      await reminder.waitFor();
      assert.match(await reminder.textContent(), /₱50\.00/);
      assert.equal(await gcashLine('Tips given to crew'), '₱0.00');
      assert.equal(await gcashLine('Expected GCash'), '₱350.00', 'the tip is still in GCash');
      await eod.locator('[data-close-day]').click();
      const modal = page.locator('#modal[open]');
      await modal.locator('[data-tips-later]').waitFor();
      assert.match(await modal.textContent(), /₱50\.00/);
      await modal.locator('[data-tips-later]').click();
      await expectToast(/Day closed/);
      await page.waitForSelector('#view-eod .banner.ok');

      // Day 2: yesterday's tip is still a reminder until it is marked given.
      await openDay('2027-03-02');
      await reminder.waitFor();
      assert.match(await reminder.textContent(), /₱50\.00/);
      assert.match(await reminder.textContent(), /earlier/i);
      await reminder.locator('[data-give-tips]').click();
      await expectToast(/given/i);
      await page.waitForFunction(() => !document.querySelector('#view-eod [data-tips-reminder]'));
      assert.equal(await gcashLine('Tips given to crew'), '₱50.00');
      await eod.locator('[data-close-day]').click();
      await expectToast(/Day closed/);

      // Day 3: "Given out, close day" records the tips and closes in one go.
      await openDay('2027-03-03');
      await reminder.waitFor();
      await eod.locator('[data-close-day]').click();
      await modal.locator('[data-tips-give-close]').click();
      await expectToast(/Day closed/);
      await page.waitForSelector('#view-eod .banner.ok');
      assert.equal(await gcashLine('Tips given to crew'), '₱30.00');
      assert.equal(await reminder.count(), 0);
    });

    await step('EOD: one button copies the daily sales report for the group chat', async () => {
      // The boss wants this every day in the group chat, in his format.
      await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
      // 2027-03-03 (closed in the step above): one ₱300 GCash car, with a ₱30 tip that is not in the report.
      await eod.locator('[data-date]').fill('2027-03-03');
      await eod.locator('[data-date]').dispatchEvent('change');
      await page.waitForFunction(() => document.querySelector('#view-eod [data-date]').value === '2027-03-03'
        && /Closed by/.test(document.querySelector('#view-eod [data-status]').textContent));
      await eod.locator('[data-sales-report]').click();
      await expectToast(/copied/i);
      const head = 'March 3, 2027\nTotal of cars - 1\nTotal sales - 300\nLess comms - 0\nLess expenses - 0\nTotal net = 300\n\n';
      assert.equal(await page.inputValue('#modal[open] [data-report-text]'), `${head}Cash - not counted yet\nGcash - not counted yet`, 'nothing is made up before the count');
      await page.click('#modal [data-close]');

      // After the count: the amounts on screen go in the report, with each side's variance.
      await eod.locator('[data-m="actual_cash"]').fill('50');
      await eod.locator('[data-m="actual_gcash"]').fill('290');
      await eod.locator('[data-sales-report]').click();
      await expectToast(/copied/i);
      const want = `${head}Cash - 50\nGcash - 290\nCash variance = +50\nGcash variance = -10`;
      assert.equal(await page.inputValue('#modal[open] [data-report-text]'), want, 'shown, so it can also be copied by hand');
      // The Windows clipboard hands line breaks back as \r\n.
      assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, '\n'), want);
      await shot('06b-sales-report');
      await page.click('#modal [data-close]');
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

    const inv = page.locator('#view-inventory');
    const invRow = name => inv.locator('[data-list] [data-item]', { hasText: name });
    const invStock = async name => (await invRow(name).locator('[data-stock]').textContent()).trim();
    const listCount = n => page.waitForFunction(count => document.querySelectorAll('#view-inventory [data-list] [data-item]').length === count, n);
    const waitStock = (name, start) => page.waitForFunction(([n, s]) => [...document.querySelectorAll('#view-inventory [data-item]')]
      .find(r => r.textContent.includes(n))?.querySelector('[data-stock]')?.textContent.trim().startsWith(s), [name, start]);
    // Tapping a row opens the item's details with its actions.
    const openItem = async name => {
      await invRow(name).click();
      await page.waitForSelector('#modal[open] [data-panel]');
    };

    await step('inventory: paste rows from Excel, tags, low stock', async () => {
      await page.click('#nav [data-view="inventory"]');
      await inv.locator('[data-paste]').click();
      await page.fill('#modal [data-paste-text]', [
        'SKU\tItem\tUnit\tSelling price\tReorder at\tTags\tStock\tCost',
        'OIL-1L\tEngine oil 1L\tbottle\t550\t2\tAuto Parts\t0\t0',
        '\tSnow foam\tgal\t\t1\tCarwash chemicals\t4\t300',
        '\tMicrofiber 40x40\tpc\t\t10\tMicrofiber; Detailing chemicals\t24\t45',
      ].join('\n'));
      await page.waitForFunction(() => document.querySelectorAll('#modal [data-preview] tbody tr').length === 3);
      await page.click('#modal [data-confirm]');
      await expectToast(/3 items added/);
      await invRow('Snow foam').waitFor();
      assert.match(await invRow('Engine oil 1L').textContent(), /Low/, 'no stock yet: flagged low');
      assert.match(await invRow('Engine oil 1L').textContent(), /Auto Parts/, 'tags show under the name');
      assert.match(await invRow('Engine oil 1L').locator('[data-price]').textContent(), /₱550\.00/, 'for sale: its price');
      assert.equal(await invStock('Microfiber 40x40'), '24 pc');
      assert.match(await inv.locator('[data-low]').textContent(), /Engine oil 1L/);

      // Tag chips filter the list.
      await inv.locator('[data-tag-filter]', { hasText: 'Carwash chemicals' }).click();
      await listCount(1);
      assert.equal(await invRow('Snow foam').count(), 1);
      await inv.locator('[data-tag-filter=""]').click();
      await listCount(3);
      await inv.locator('[data-search]').fill('micro');
      await listCount(1);
      await inv.locator('[data-search]').fill('');
      await listCount(3);
    });

    await step('tags: every tag its own colour, picked from swatches', async () => {
      const chipColours = () => page.evaluate(() => [...document.querySelectorAll('#view-inventory [data-tag-filter] .dot')]
        .map(d => [...d.classList].find(c => c.startsWith('c-'))));
      const colours = await chipColours();
      assert.equal(new Set(colours).size, colours.length, `two tags share a colour: ${colours}`);

      await inv.locator('[data-manage-tags]').click();
      const row = page.locator('#modal [data-tag-row]').filter({ has: page.locator('input[value="Wash mitts"]') });
      assert.ok(await row.locator('[data-swatch]').count() >= 18, 'at least 18 colours to pick from');
      assert.equal(await row.locator('[data-swatch].used').count(), colours.length - 1, 'colours other tags use are marked');
      await row.locator('[data-swatch="grape"]').click();
      assert.match(await row.locator('[data-t-preview]').getAttribute('class'), /c-grape/, 'the preview follows the pick');
      await row.locator('[data-t-save]').click();
      await expectToast(/Tag saved/);
      await page.click('#modal [data-close]');
      await page.waitForFunction(() => [...document.querySelectorAll('#view-inventory [data-tag-filter]')]
        .find(b => b.textContent.includes('Wash mitts'))?.querySelector('.dot.c-grape'));
    });

    await step('inventory: a simple list; tap an item for its details, count and edit', async () => {
      assert.equal(await inv.locator('[data-sheet]').isVisible(), false, 'Inventory starts on the list');
      assert.match(await inv.locator('[data-mode="list"]').getAttribute('class'), /active/);
      // The details show everything about the item, with its actions.
      await openItem('Snow foam');
      assert.match(await page.textContent('#modal [data-panel]'), /Stock\s*4 gal[\s\S]*Reorder at\s*1[\s\S]*Avg cost\s*₱300\.00/);
      for (const act of ['receive', 'count', 'history', 'edit']) assert.equal(await page.locator(`#modal [data-act="${act}"]`).count(), 1, `${act} button`);

      // A count records usage with a reason, never just overwrites the number.
      await page.click('#modal [data-act="count"]');
      await page.fill('#modal [data-c="counted"]', '2.5');
      assert.equal(await page.inputValue('#modal [data-c="reason"]'), 'used');
      assert.match(await page.textContent('#modal [data-c-summary]'), /1\.5 gal used/);
      await page.click('#modal [data-confirm]');
      await expectToast(/Count saved/);
      await waitStock('Snow foam', '2.5');

      // Everything else is changed in the item's form: reorder level and tags.
      await openItem('Snow foam');
      await page.click('#modal [data-act="edit"]');
      await page.fill('#modal [data-p="reorder_level"]', '3');
      await page.locator('#modal [data-tag-pick]', { hasText: 'Detailing chemicals' }).locator('input').check();
      await page.click('#modal [data-confirm]');
      await expectToast(/Item saved/);
      await page.waitForFunction(() => /Detailing chemicals/.test([...document.querySelectorAll('#view-inventory [data-item]')]
        .find(r => r.textContent.includes('Snow foam'))?.textContent || ''));
      assert.match(await invRow('Snow foam').textContent(), /Low/, '2.5 gal is at or below the new reorder level');
      await shot('07c-inventory-list');
    });

    await step('inventory: receive, history, correct a delivery\'s cost, CSV export', async () => {
      // Opening stock whose cost is not known yet: entered at ₱0.
      await openItem('Engine oil 1L');
      await page.click('#modal [data-act="receive"]');
      await page.fill('#modal [data-r="quantity"]', '12');
      await page.fill('#modal [data-r="unit_cost"]', '0');
      await page.selectOption('#modal [data-r="paid_from"]', 'none');
      await page.click('#modal [data-confirm]');
      await expectToast(/Stock received/);
      await waitStock('Engine oil 1L', '12');
      assert.match(await inv.locator('[data-total-value]').textContent(), /₱/, 'stock value total for the owner');

      await openItem('Snow foam');
      await page.click('#modal [data-act="history"]');
      await page.waitForSelector('#modal[open] .history-entry');
      assert.match(await page.textContent('#modal .history-list'), /Used[\s\S]*-1\.5 gal[\s\S]*Received[\s\S]*\+4 gal/);
      await page.click('#modal [data-close]');

      // The cost turns out to be ₱300 a bottle: correct that delivery from its history.
      await openItem('Engine oil 1L');
      await page.click('#modal [data-act="history"]');
      await page.click('#modal [data-correct-cost]');
      await page.fill('#modal [data-cc="unit_cost"]', '300');
      assert.match(await page.textContent('#modal [data-cc-hint]'), /average cost becomes ₱300\.00/);
      await page.click('#modal [data-confirm]');
      await expectToast(/Cost corrected/);
      await openItem('Engine oil 1L');
      assert.match(await page.textContent('#modal [data-panel]'), /Avg cost\s*₱300\.00/);

      // Also sold as a set: a case of 4 bottles for ₱2,000 (stock stays in bottles).
      await page.click('#modal [data-act="edit"]');
      await page.fill('#modal [data-p="set_size"]', '4');
      await page.fill('#modal [data-p="set_price"]', '2000');
      await page.click('#modal [data-confirm]');
      await expectToast(/Item saved/);
      await page.waitForFunction(() => /set of 4/.test([...document.querySelectorAll('#view-inventory [data-item]')]
        .find(r => r.textContent.includes('Engine oil'))?.textContent || ''));

      const [csv] = await Promise.all([page.waitForEvent('download'), inv.locator('[data-export]').click()]);
      assert.match(csv.suggestedFilename(), /^Inventory_\d{4}-\d{2}-\d{2}\.csv$/);
      const text = fs.readFileSync(await csv.path(), 'utf8');
      assert.ok(text.startsWith('﻿'), 'Excel-friendly CSV');
      assert.match(text, /SKU,Item,Unit,Tags,Price,Commission,Set of,Set price,Avg cost,Overall,Carwash,Detailing,Tint & PPF,Total stock,Reorder at,Value/);
      assert.match(text, /OIL-1L,Engine oil 1L,bottle,Auto Parts,550,0,4,2000,300,12,0,0,0,12,2,3600/);
      await shot('07c-inventory');
    });

    const sheetRow = name => inv.locator('[data-sheet] tbody tr[data-item]', { hasText: name });
    const invCell = (name, field) => sheetRow(name).locator(`td[data-field="${field}"]`);
    const cellText = async (name, field) => (await invCell(name, field).textContent()).trim();
    const cellBecomes = (name, field, text) => page.waitForFunction(([n, f, t]) => [...document.querySelectorAll('#view-inventory [data-sheet] tr[data-item]')]
      .find(r => r.textContent.includes(n))?.querySelector(`td[data-field="${f}"]`).textContent.trim() === t, [name, field, text]);

    await step('inventory sheet: a List / Sheet switch; edit cells in place like Excel', async () => {
      await inv.locator('[data-mode="sheet"]').click();
      await sheetRow('Snow foam').waitFor();
      assert.equal(await inv.locator('[data-list]').isVisible(), false, 'one view at a time');

      // Type on a cell to replace it; Tab saves and moves right, Enter saves and moves down.
      await invCell('Engine oil 1L', 'price').click();
      await page.keyboard.type('560');
      await page.keyboard.press('Tab');
      await expectToast(/Saved/);
      await cellBecomes('Engine oil 1L', 'price', '₱560.00');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.field), 'commission', 'Tab moves to the next cell');
      await invCell('Engine oil 1L', 'price').click();
      await page.keyboard.type('550');
      await page.keyboard.press('Enter');
      await cellBecomes('Engine oil 1L', 'price', '₱550.00');

      await invCell('Microfiber 40x40', 'reorder_level').click();
      await page.keyboard.type('4');
      await page.keyboard.press('Enter');
      await cellBecomes('Microfiber 40x40', 'reorder_level', '4');
      const focused = await page.evaluate(() => ({ field: document.activeElement.dataset.field, row: document.activeElement.closest('tr')?.textContent }));
      assert.equal(focused.field, 'reorder_level', 'Enter moves to the cell below');
      assert.match(focused.row, /Snow foam/);

      // Escape cancels an edit; arrow keys move between cells.
      await page.keyboard.type('99');
      await page.keyboard.press('Escape');
      assert.equal(await cellText('Snow foam', 'reorder_level'), '3');
      await page.keyboard.press('ArrowLeft');
      assert.equal(await page.evaluate(() => document.activeElement.dataset.field), 'total_stock');
      await page.keyboard.press('ArrowUp');
      assert.match(await page.evaluate(() => document.activeElement.closest('tr').textContent), /Microfiber/);

      // The stock column records a count with a reason, never just overwrites the number.
      await invCell('Snow foam', 'stock').click();
      await page.keyboard.type('2');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#modal[open] [data-c="reason"]');
      assert.equal(await page.inputValue('#modal [data-c="counted"]'), '2');
      assert.match(await page.textContent('#modal [data-c-summary]'), /0\.5 gal used/);
      await page.click('#modal [data-confirm]');
      await expectToast(/Count saved/);
      await cellBecomes('Snow foam', 'stock', '2');
      await cellBecomes('Snow foam', 'total_stock', '2 Low');

      // Tags are edited from the tags cell.
      await invCell('Snow foam', 'tags').dblclick();
      await page.waitForSelector('#modal[open] [data-tag-pick]');
      await page.locator('#modal [data-tag-pick]', { hasText: 'Detailing chemicals' }).locator('input').uncheck();
      await page.click('#modal [data-confirm]');
      await expectToast(/Saved/);
      await page.waitForFunction(() => !/Detailing chemicals/.test([...document.querySelectorAll('#view-inventory [data-sheet] tr[data-item]')]
        .find(r => r.textContent.includes('Snow foam'))?.querySelector('td[data-field="tags"]').textContent || 'Detailing chemicals'));

      // Columns sort; the item name stays in view; each row keeps its buttons, History with Correct cost included.
      await inv.locator('[data-sheet] th[data-sort="stock"] button').click();
      assert.equal(await inv.locator('[data-sheet] th[data-sort="stock"]').getAttribute('aria-sort'), 'ascending');
      const stocks = (await inv.locator('[data-sheet] td[data-field="stock"]').allTextContents()).map(t => parseFloat(t));
      assert.deepEqual(stocks, [...stocks].sort((a, b) => a - b));
      await inv.locator('[data-sheet] th[data-sort="name"] button').click();
      assert.equal(await invCell('Snow foam', 'name').evaluate(td => getComputedStyle(td).position), 'sticky', 'the name column is frozen');
      await sheetRow('Engine oil 1L').locator('[data-act="history"]').click();
      await page.waitForSelector('#modal[open] [data-correct-cost]');
      await page.click('#modal [data-close]');
      await shot('07c-inventory-sheet');

      // The choice is remembered on this device.
      await page.reload();
      await page.click('#nav [data-view="inventory"]');
      await sheetRow('Snow foam').waitFor();
      await inv.locator('[data-mode="list"]').click();
      await invRow('Snow foam').waitFor();
      assert.equal(await inv.locator('[data-sheet]').isVisible(), false);
    });

    await step('inventory containers: send stock to a department, see each container, count there, move it back', async () => {
      const container = key => inv.locator(`[data-container="${key}"]`);
      const pick = async key => { await container(key).click(); await page.waitForFunction(k => document.querySelector(`#view-inventory [data-container="${k}"]`).classList.contains('active'), key); };
      const totalValue = async () => (await inv.locator('[data-foot] [data-total-value]').textContent()).trim();
      const valueBefore = await totalValue();
      assert.deepEqual((await inv.locator('[data-container]').allTextContents()).map(t => t.replace(/\s*\d+$/, '').trim()),
        ['All stock', 'Overall', 'Carwash', 'Detailing', 'Tint & PPF'], 'the four containers, and everything together');

      // The owner sends stock from an item's details.
      await openItem('Snow foam');
      await page.click('#modal [data-act="move"]');
      await page.waitForSelector('#modal[open] [data-m="quantity"]');
      assert.equal(await page.inputValue('#modal [data-m="from"]'), 'overall');
      await page.selectOption('#modal [data-m="to"]', 'carwash');
      await page.fill('#modal [data-m="quantity"]', '1.5');
      assert.match(await page.textContent('#modal [data-m-hint]'), /Overall 2 → 0\.5[\s\S]*Carwash 0 → 1\.5[\s\S]*No money/);
      await page.click('#modal [data-confirm]');
      await expectToast(/Stock moved/);

      // The list still shows the shop's total, and where it is. The value and the Low warning do not move.
      await page.waitForFunction(() => /Carwash 1\.5/.test([...document.querySelectorAll('#view-inventory [data-item]')].find(r => r.textContent.includes('Snow foam'))?.textContent || ''));
      assert.equal(await invStock('Snow foam'), '2 gal');
      assert.match(await invRow('Snow foam').textContent(), /Overall 0\.5/);
      assert.match(await invRow('Snow foam').textContent(), /Low/, 'low stock looks at the total');
      assert.equal(await totalValue(), valueBefore, 'a move does not change the stock value');

      // Each container on its own: what is in it, and what that is worth.
      await pick('carwash');
      await listCount(1);
      assert.equal(await invStock('Snow foam'), '1.5 gal');
      assert.match(await totalValue(), /₱[\d,.]+/);
      await shot('07d-inventory-container');

      // Counting from a container counts in that container.
      await openItem('Snow foam');
      assert.match(await page.textContent('#modal [data-panel]'), /Stock\s*2 gal[\s\S]*Overall\s*0\.5[\s\S]*Carwash\s*1\.5/);
      await page.click('#modal [data-act="count"]');
      assert.equal(await page.inputValue('#modal [data-c="container"]'), 'carwash');
      await page.fill('#modal [data-c="counted"]', '1');
      assert.match(await page.textContent('#modal [data-c-summary]'), /0\.5 gal used/);
      await page.click('#modal [data-confirm]');
      await expectToast(/Count saved/);
      await waitStock('Snow foam', '1 gal');

      // Moving on to another department, then back to Overall.
      await openItem('Snow foam');
      await page.click('#modal [data-act="move"]');
      assert.equal(await page.inputValue('#modal [data-m="from"]'), 'carwash', 'starts from the container in view');
      await page.selectOption('#modal [data-m="to"]', 'detailing');
      await page.fill('#modal [data-m="quantity"]', '5');
      assert.match(await page.textContent('#modal [data-m-hint]'), /Only 1 gal in Carwash/);
      assert.equal(await page.locator('#modal [data-confirm]').isDisabled(), true, 'more than is there cannot be sent');
      await page.fill('#modal [data-m="quantity"]', '1');
      await page.click('#modal [data-confirm]');
      await expectToast(/Stock moved/);
      await listCount(0);
      await pick('detailing');
      await listCount(1);
      await openItem('Snow foam');
      await page.click('#modal [data-act="move"]');
      await page.selectOption('#modal [data-m="to"]', 'overall');
      await page.fill('#modal [data-m="quantity"]', '0.5');
      await page.click('#modal [data-confirm]');
      await expectToast(/Stock moved/);
      await waitStock('Snow foam', '0.5 gal');

      // The history shows each move once, where it went and who did it, and where a count was made.
      await openItem('Snow foam');
      await page.click('#modal [data-act="history"]');
      await page.waitForSelector('#modal[open] .history-list');
      const history = await page.textContent('#modal .history-list');
      assert.match(history, /Moved\s*1\.5 gal\s*·\s*Overall → Carwash/);
      assert.match(history, /Moved\s*1 gal\s*·\s*Carwash → Detailing/);
      assert.match(history, /Moved\s*0\.5 gal\s*·\s*Detailing → Overall/);
      assert.match(history, /Used\s*-0\.5 gal\s*·\s*Carwash/);
      assert.equal((history.match(/Moved/g) || []).length, 3, 'one entry per move');
      assert.match(await page.locator('#modal .history-entry', { hasText: 'Overall → Carwash' }).textContent(), /owner/i, 'it says who');
      await page.click('#modal [data-close]');
      await pick('');
      await invRow('Snow foam').waitFor();

      // Everything in one department: a count starts there, not in an empty Overall, so the shelf is not counted twice.
      await openItem('Microfiber 40x40');
      await page.click('#modal [data-act="move"]');
      await page.selectOption('#modal [data-m="to"]', 'tint_ppf');
      await page.fill('#modal [data-m="quantity"]', '24');
      await page.click('#modal [data-confirm]');
      await expectToast(/Stock moved/);
      await page.waitForFunction(() => /Tint & PPF 24/.test([...document.querySelectorAll('#view-inventory [data-item]')].find(r => r.textContent.includes('Microfiber'))?.textContent || ''));
      await openItem('Microfiber 40x40');
      await page.click('#modal [data-act="count"]');
      assert.equal(await page.inputValue('#modal [data-c="container"]'), 'tint_ppf', 'starts where the stock is');

      // More than an empty Overall suggests a recount; going to the right container takes that back.
      await page.selectOption('#modal [data-c="container"]', 'overall');
      await page.fill('#modal [data-c="counted"]', '20');
      assert.equal(await page.inputValue('#modal [data-c="reason"]'), 'recount');
      await page.selectOption('#modal [data-c="container"]', 'tint_ppf');
      assert.equal(await page.inputValue('#modal [data-c="reason"]'), 'used', 'the suggestion does not stick');
      assert.match(await page.textContent('#modal [data-c-summary]'), /4 pc used/);
      // A reason picked by hand comes back when the suggestion no longer applies.
      await page.selectOption('#modal [data-c="reason"]', 'damaged');
      await page.selectOption('#modal [data-c="container"]', 'overall');
      await page.selectOption('#modal [data-c="container"]', 'tint_ppf');
      assert.equal(await page.inputValue('#modal [data-c="reason"]'), 'damaged');
      await page.click('#modal [data-close]');
      await openItem('Microfiber 40x40');
      await page.click('#modal [data-act="move"]');
      assert.equal(await page.inputValue('#modal [data-m="from"]'), 'tint_ppf');
      await page.selectOption('#modal [data-m="to"]', 'overall');
      await page.fill('#modal [data-m="quantity"]', '24');
      await page.click('#modal [data-confirm]');
      await expectToast(/Stock moved/);
      await page.waitForFunction(() => !/Tint & PPF 24/.test([...document.querySelectorAll('#view-inventory [data-item]')].find(r => r.textContent.includes('Microfiber'))?.textContent || 'Tint & PPF 24'));

      // Auto Parts stay in Overall: no Send, and no container to count in.
      await openItem('Engine oil 1L');
      assert.equal(await page.locator('#modal [data-act="move"]').count(), 0, 'auto parts cannot be sent');
      await page.click('#modal [data-act="count"]');
      assert.equal(await page.locator('#modal [data-c="container"]').count(), 0);
      await page.click('#modal [data-close]');

      // The sheet has a column per container; typing in a department's cell records a count there.
      await inv.locator('[data-mode="sheet"]').click();
      await sheetRow('Snow foam').waitFor();
      assert.equal(await cellText('Snow foam', 'stock'), '1');
      assert.equal(await cellText('Snow foam', 'detailing'), '0.5');
      assert.equal(await cellText('Snow foam', 'carwash'), '—');
      await cellBecomes('Snow foam', 'total_stock', '1.5 Low');
      assert.equal(await cellText('Engine oil 1L', 'detailing'), '—');
      assert.doesNotMatch(await invCell('Engine oil 1L', 'detailing').getAttribute('class'), /editable/, 'not for auto parts');
      await sheetRow('Snow foam').locator('[data-act="move"]').waitFor();
      assert.equal(await sheetRow('Engine oil 1L').locator('[data-act="move"]').count(), 0);
      await invCell('Snow foam', 'detailing').click();
      await page.keyboard.type('0.25');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#modal[open] [data-c="reason"]');
      assert.equal(await page.inputValue('#modal [data-c="container"]'), 'detailing');
      assert.match(await page.textContent('#modal [data-c-summary]'), /0\.25 gal used/);
      await page.click('#modal [data-confirm]');
      await expectToast(/Count saved/);
      await cellBecomes('Snow foam', 'detailing', '0.25');
      await inv.locator('[data-mode="list"]').click();
      await invRow('Snow foam').waitFor();
    });

    const partsView = page.locator('#view-parts');
    const partRow = name => partsView.locator('[data-parts] [data-part]', { hasText: name });
    const partsEditor = partsView.locator('[data-editor]');
    const activeRow = jo => partsView.locator('[data-active] tr', { hasText: jo });
    const doneRow = jo => partsView.locator('[data-completed] tr', { hasText: jo });
    const setPartsDay = async day => {
      await partsView.locator('[data-date]').fill(day);
      await partsView.locator('[data-date]').dispatchEvent('change');
    };
    const partStockStarts = start => page.waitForFunction(s => [...document.querySelectorAll('#view-parts [data-part]')]
      .find(r => r.textContent.includes('Engine oil 1L'))?.querySelector('[data-stock]')?.textContent.trim().startsWith(s), start);

    await step('parts: a simple list with search; job orders with labor and a raised price, itemized', async () => {
      await page.click('#nav [data-view="parts"]');
      const row = partRow('Engine oil 1L');
      await row.waitFor();
      assert.equal(await partRow('Snow foam').count(), 0, 'supplies are not on the Parts tab');
      assert.match(await row.locator('[data-stock]').textContent(), /\b12\b/);
      assert.match(await row.textContent(), /set of 4[\s\S]*₱2,000\.00/, 'the list shows the set price');
      // Tap a part for its details.
      await row.click();
      await page.waitForSelector('#modal[open] [data-panel]');
      assert.match(await page.textContent('#modal [data-panel]'), /OIL-1L[\s\S]*Avg cost\s*₱300\.00/);
      await page.click('#modal [data-close]');

      await setPartsDay('2026-09-21');
      await partsView.locator('[data-completed-date]').fill('2026-09-01');
      await partsView.locator('[data-completed-date]').dispatchEvent('change');
      assert.equal(await partsEditor.locator('[data-add="service"]').count(), 0, 'no services at the parts counter');
      assert.equal(await partsEditor.locator('[data-f="payment_received"]').isChecked(), false, 'a new job starts open and unpaid');
      await partsEditor.locator('[data-add="part"]').selectOption({ index: 1 });
      await partsEditor.locator('[data-l="quantity"]').fill('2');
      assert.match(await partsEditor.locator('[data-totals]').textContent(), /Total\s*₱1,100\.00/);
      // A harder job: the price goes up on this sale (never below the list price), and labor is typed in.
      await partsEditor.locator('[data-l="unit_price"]').fill('500');
      await partsEditor.locator('[data-pay-choice] input[value="GCash"]').check();
      await partsView.locator('[data-review]').click();
      await expectToast(/at least ₱550\.00/);
      await partsEditor.locator('[data-l="unit_price"]').fill('600');
      await partsEditor.locator('[data-labor]').fill('300');
      assert.match(await partsEditor.locator('[data-totals]').textContent(), /Subtotal\s*₱1,500\.00[\s\S]*Commission\s*₱300\.00[\s\S]*Total\s*₱1,500\.00/);
      // A walk-in: paid and done at once.
      await partsEditor.locator('[data-f="payment_received"]').check();
      await partsEditor.locator('[data-f="job_done"]').check();
      await shot('07c-parts-new-job');
      await partsView.locator('[data-review]').click();
      await page.waitForSelector('#modal[open] [data-confirm]');
      assert.match(await page.textContent('#modal'), /counts as a sale on Mon, Sep 21, 2026/i);
      await page.click('#modal [data-confirm]');
      await expectToast(/PC-092126-001 added/);
      const sale = doneRow('PC-092126-001');
      await sale.waitFor();
      assert.equal(await activeRow('PC-092126-001').count(), 0, 'paid and done goes straight to Completed');
      assert.match(await sale.textContent(), /GCash/);
      // Itemized: each item with its price, then labor, then the total.
      assert.deepEqual((await sale.locator('.receipt-line').allTextContents()).map(t => t.replace(/\s+/g, ' ').trim()),
        ['Engine oil 1L 2 × ₱600.00 ₱1,200.00', 'Labor ₱300.00', 'Total ₱1,500.00']);
      await partStockStarts('10');

      // The same part as a set: one case of 4 at the set price takes 4 bottles.
      const setOption = await partsEditor.locator('[data-add="part"] option', { hasText: 'set of 4' }).getAttribute('value');
      await partsEditor.locator('[data-add="part"]').selectOption(setOption);
      assert.match(await partsEditor.locator('[data-lines]').textContent(), /set of 4/);
      assert.match(await partsEditor.locator('[data-totals]').textContent(), /Total\s*₱2,000\.00/);
      await partsEditor.locator('[data-pay-choice] input[value="Cash"]').check();
      await partsEditor.locator('[data-f="payment_received"]').check();
      await partsEditor.locator('[data-f="job_done"]').check();
      await partsView.locator('[data-review]').click();
      await page.click('#modal [data-confirm]');
      await expectToast(/PC-092126-002 added/);
      await partStockStarts('6');
      await doneRow('PC-092126-002').waitFor();

      // One search box for the whole tab: parts and the jobs.
      await partsView.locator('[data-search]').fill('labor');
      await page.waitForFunction(() => document.querySelectorAll('#view-parts [data-completed] tr[data-id]').length === 1);
      assert.equal(await doneRow('PC-092126-001').count(), 1);
      await partsView.locator('[data-search]').fill('snow');
      await page.waitForFunction(() => !document.querySelector('#view-parts [data-part]') && !document.querySelector('#view-parts [data-completed] tr[data-id]'));
      await partsView.locator('[data-search]').fill('');
      await page.waitForFunction(() => document.querySelectorAll('#view-parts [data-completed] tr[data-id]').length === 2);
      await shot('07c-parts');

      // EOD puts each job in the drawer or GCash it was paid with, on its own line; the labor is commission.
      await page.click('#nav [data-view="eod"]');
      const eodView = page.locator('#view-eod');
      await eodView.locator('[data-date]').fill('2026-09-21');
      await eodView.locator('[data-date]').dispatchEvent('change');
      const partsLine = side => eodView.locator(`[data-${side}] .row-line`, { hasText: 'parts counter' }).locator('.money');
      await partsLine('cash').waitFor();
      assert.equal((await partsLine('cash').textContent()).trim(), '₱2,000.00');
      assert.equal((await partsLine('gcash').textContent()).trim(), '₱1,500.00');
      await page.click('#nav [data-view="parts"]');
    });

    await step('parts: an open job stays for days; commission on the day it is done, money on the day it is paid', async () => {
      const metrics = async () => Object.fromEntries((await partsView.locator('[data-metrics] .metric').evaluateAll(cards =>
        cards.map(c => [c.querySelector('.label').textContent.trim(), c.querySelector('.value').textContent.trim()]))));
      const vehiclesCard = n => page.waitForFunction(want => document.querySelector('#view-parts [data-metrics] .metric .value')?.textContent.trim() === want, String(n));

      // Monday: opened with labor, nothing ticked. The part is held, nothing counts yet.
      await setPartsDay('2026-09-22');
      await vehiclesCard(0);
      assert.deepEqual(Object.keys(await metrics()).slice(0, 6), ['Vehicles', 'Collected', 'Unpaid (all days)', 'Commission', 'Net (collected − comm.)', 'In progress']);
      await partsEditor.locator('[data-add="part"]').selectOption({ index: 1 });
      await partsEditor.locator('[data-labor]').fill('200');
      await partsView.locator('[data-review]').click();
      await page.waitForSelector('#modal[open] [data-confirm]');
      assert.match(await page.textContent('#modal'), /stays on the board/);
      await page.click('#modal [data-confirm]');
      await expectToast(/PC-092226-001 added/);
      const job = activeRow('PC-092226-001');
      await job.waitFor();
      assert.match(await job.textContent(), /In progress/);
      await partStockStarts('5');
      await page.waitForFunction(() => /In progress\s*1/.test(document.querySelector('#view-parts [data-metrics]').innerText));
      assert.equal((await metrics()).Commission, '₱0.00', 'no commission until the job is done');
      await shot('07c-parts-open-job');

      // The install turns out harder: Edit changes the labor.
      await job.locator('[data-act="edit"]').click();
      await page.waitForSelector('#modal[open] [data-labor]');
      assert.equal(await page.inputValue('#modal [data-labor]'), '200');
      await page.fill('#modal [data-labor]', '250');
      await page.click('#modal [data-save]');
      await expectToast(/PC-092226-001 saved/);
      await page.waitForFunction(() => /₱800\.00/.test(document.querySelector('#view-parts [data-active]').textContent));

      // Wednesday: marked done. Its sale and commission are that day's, still unpaid.
      await setPartsDay('2026-09-23');
      await vehiclesCard(0);
      await job.locator('[data-act="complete"]').click();
      await page.waitForSelector('#modal[open] [data-done-date]');
      assert.equal(await page.inputValue('#modal [data-done-date]'), '2026-09-23', 'the done day is the day open on the tab');
      await page.click('#modal [data-confirm]');
      await expectToast(/marked done/);
      await vehiclesCard(1);
      const doneCards = await metrics();
      assert.deepEqual([doneCards.Commission, doneCards['Unpaid (all days)'], doneCards.Collected], ['₱250.00', '₱800.00', '₱0.00']);
      assert.match(await job.textContent(), /awaiting payment/);
      // Every action button must be fully visible, with the itemized job and the longest status in the row,
      // also on a narrower laptop screen.
      await page.setViewportSize({ width: 1280, height: 720 });
      const clipped = await page.evaluate(() => {
        const wrap = document.querySelector('#view-parts [data-active]').closest('.table-wrap').getBoundingClientRect();
        return [...document.querySelectorAll('#view-parts [data-active] [data-act]')]
          .filter(el => { const r = el.getBoundingClientRect(); return r.right > wrap.right + 1 || r.left < wrap.left - 1; })
          .map(el => el.textContent.trim() || el.title);
      });
      await page.setViewportSize({ width: 1440, height: 1000 });
      assert.deepEqual(clipped, [], 'parts board action buttons are clipped');

      // Friday: the customer pays. Cash or GCash must be picked.
      await setPartsDay('2026-09-25');
      await vehiclesCard(0);
      await job.locator('[data-act="pay"]').click();
      await page.waitForSelector('#modal[open] [data-pay-date]');
      assert.equal(await page.inputValue('#modal [data-pay-date]'), '2026-09-25', 'the payment day is the day open on the tab');
      await page.click('#modal [data-confirm]');
      await expectToast(/Choose Cash or GCash/);
      await page.locator('#modal [data-pay-method] input[value="GCash"]').check();
      await shot('07c-parts-mark-paid');
      await page.click('#modal [data-confirm]');
      await expectToast(/payment recorded/);
      await doneRow('PC-092226-001').waitFor();
      assert.equal(await activeRow('PC-092226-001').count(), 0);
      assert.equal(await doneRow('PC-092226-001').locator('[data-act="unpay"]').count(), 1, 'a payment can be undone');

      // The money is in Friday's GCash, with a note saying it was for an earlier day.
      await page.click('#nav [data-view="eod"]');
      const eodView = page.locator('#view-eod');
      await eodView.locator('[data-date]').fill('2026-09-25');
      await eodView.locator('[data-date]').dispatchEvent('change');
      const partsGcash = eodView.locator('[data-gcash] .row-line', { hasText: 'parts counter' }).locator('.money');
      await partsGcash.waitFor();
      assert.equal((await partsGcash.textContent()).trim(), '₱800.00');
      assert.match(await eodView.locator('[data-cash]').textContent(), /₱800\.00 received today is for jobs and counter sales from earlier days/);
      await page.click('#nav [data-view="parts"]');
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
      const help = await page.locator('#view-reports [data-help]').textContent();
      assert.match(help, /How to read/);
      // Profit is worked out as in Finance, and the guide describes today's rules.
      assert.ok(headers.includes('Parts cost'), 'the cost of parts sold has its own column');
      assert.match(await page.locator('#view-reports .view-header .desc').textContent(), /Cost of parts sold/);
      assert.doesNotMatch(help, /both done and paid/, 'running jobs are booked on the day they are finished');
      assert.match(help, /day (it is|they are) finished/);
      assert.match(help, /Finance/);
      // September 14 was closed at EOD; the other days are listed and marked as still open.
      assert.equal(await page.locator('#view-reports tbody tr', { hasText: '2026-09-14' }).locator('[data-open-day]').count(), 0);
      assert.ok(await page.locator('#view-reports tbody [data-open-day]').count() > 0, 'days not closed yet are marked');
      assert.match(await page.locator('#view-reports [data-open-days]').textContent(), /still open/);
      const money = async label => Number((await page.locator(`#view-reports tr.weekly-total td[data-label="${label}"]`).textContent()).replace(/[₱,]/g, ''));
      assert.equal(await money('Cash received') + await money('GCash received'), await money('Total sales'),
        'everything sold in September was also paid in September');
      const costs = colorOf(await page.locator('#view-reports .weekly-stat strong.amber-text').evaluate(el => getComputedStyle(el).color));
      assert.ok(isAmber(costs), `costs should read amber, got rgb(${costs.r},${costs.g},${costs.b})`);
      await shot('08-reports');
    });

    await step('analytics: daily, weekly, monthly and quarterly', async () => {
      // The Sold / Brought in buttons can be tapped while the figures are still loading.
      await page.route('**/api/analytics*', async route => { await new Promise(r => setTimeout(r, 800)); await route.continue(); });
      await page.click('#nav [data-view="analytics"]');
      const view = page.locator('#view-analytics');
      await view.locator('[data-measure="sales"]').click();
      await view.locator('[data-measure="sold"]').click();
      assert.deepEqual(problems, [], 'tapping before the figures arrive');
      await view.locator('[data-bar]').first().waitFor();
      await page.unroute('**/api/analytics*');
      await view.locator('[data-date]').fill('2026-09-30');
      await view.locator('[data-date]').dispatchEvent('change');
      assert.deepEqual((await view.locator('[data-grain]').allTextContents()).map(t => t.trim()), ['Daily', 'Weekly', 'Monthly', 'Quarterly']);
      assert.match(await view.textContent(), /weeks run Monday to Sunday/i, 'the guide names the week every screen uses');
      for (const [grain, rows] of [['day', 14], ['week', 8], ['month', 6], ['quarter', 4]]) {
        await view.locator(`[data-grain="${grain}"]`).click();
        await page.waitForFunction(([g, n]) => {
          const el = document.querySelector('#view-analytics');
          return el.querySelector(`[data-grain="${g}"]`).classList.contains('active') && el.querySelectorAll('[data-rows] tr').length === n;
        }, [grain, rows]);
        assert.equal(await view.locator('[data-chart] [data-bar]').count(), rows, `${grain} has one bar per period`);
      }
      await view.locator('[data-grain="month"]').click();
      await page.waitForFunction(() => /Sep 2026/.test(document.querySelector('#view-analytics [data-rows]').textContent));
      const headers = (await view.locator('thead th').allTextContents()).map(t => t.trim());
      for (const h of ['Period', 'Days with sales', 'Cars', 'Sales', 'Per day', 'Per car', 'Commission', 'Expenses', 'Payroll', 'Bills', 'Net profit']) {
        assert.ok(headers.includes(h), `missing column ${h} in ${JSON.stringify(headers)}`);
      }
      assert.equal(await view.locator('.weekly-stat').count(), 4);
      assert.match(await view.locator('[data-open-days]').textContent(), /not counted/i, 'days still open are named, not silently missing');
      assert.match(await view.locator('[data-help]').textContent(), /closed/i);
      assert.match(await view.locator('[data-help]').textContent(), /How to read/);
      // Services: one trend per service; the figures follow the period picked on the chart and add up to its sales.
      const services = view.locator('[data-services]');
      const rows = services.locator('[data-service]');
      assert.ok(await rows.count() > 0, 'September has services');
      assert.equal(await rows.first().locator('[data-spark] span').count(), 6, 'one bar per month');
      const pesos = async el => Number((await el.textContent()).replace(/[₱,]/g, ''));
      const salesOf = n => view.locator('[data-rows] tr').nth(n).locator('td[data-label="Sales"]');
      assert.equal(await pesos(services.locator('[data-services-total]')), await pesos(salesOf(0)), 'services add up to the sales of the period');
      assert.match(await services.locator('[data-services-period]').textContent(), /Sep 2026/);
      await view.locator('[data-bar="4"]').click();
      await page.waitForFunction(() => /Aug 2026/.test(document.querySelector('#view-analytics [data-services-period]').textContent));
      assert.equal(await pesos(services.locator('[data-services-total]')), await pesos(salesOf(1)), 'the totals follow the chosen bar');
      await view.locator('[data-bar="5"]').click();
      const soldBars = await rows.first().locator('[data-spark]').getAttribute('aria-label');
      await services.locator('[data-measure="sales"]').click();
      assert.notEqual(await rows.first().locator('[data-spark]').getAttribute('aria-label'), soldBars, 'the trend bars switch to pesos');
      assert.match(await rows.first().locator('[data-spark]').getAttribute('aria-label'), /₱/);
      await view.locator('[data-grain="week"]').click();
      await page.waitForFunction(() => document.querySelector('#view-analytics [data-service] [data-spark]')?.querySelectorAll('span').length === 8);
      assert.equal(await services.locator('[data-measure="sales"]').getAttribute('aria-pressed'), 'true', 'the choice survives a change of period');
      await services.locator('[data-measure="sold"]').click();
      await view.locator('[data-grain="month"]').click();
      await page.waitForFunction(() => document.querySelector('#view-analytics [data-service] [data-spark]')?.querySelectorAll('span').length === 6);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 0, `page scrolls sideways by ${overflow}px`);
      await shot('08b-analytics');
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
      // The calendar works inside a modal too: picking a day sets the payment date.
      await page.fill('#modal [data-bill-date]', '2026-09-01');
      await page.click('#modal [data-bill-date]');
      await page.locator('.datepicker .dp-day:not(.dp-outside)', { hasText: /^25$/ }).click({ timeout: 3000 });
      await page.waitForFunction(() => document.querySelector('#modal [data-bill-date]').value === '2026-09-25' && !document.querySelector('.datepicker'));
      await page.fill('#modal [data-bill-amount]', '3000');
      await page.selectOption('#modal [data-bill-side]', 'cash');
      await page.click('#modal [data-confirm]');
      await expectToast(/Bill recorded/);
      // The bill's day is still open, so it is not counted yet and the page says why.
      const openDays = fin.locator('[data-open-days]');
      await page.waitForFunction(() => /Sep 25/.test(document.querySelector('#view-finance [data-open-days]')?.textContent || ''));
      assert.match(await openDays.textContent(), /not counted/i);
      assert.doesNotMatch(await fin.locator('[data-pl]').textContent(), /Bill: Meralco/);
      assert.equal(await fin.locator('[data-bills-paid] tr', { hasText: 'Meralco' }).count(), 1, 'it can still be undone');
      // Close the day and it counts.
      await page.evaluate(() => fetch('/api/days/2026-09-25/close', { method: 'POST', headers: { Authorization: 'Bearer owner@sandbox', 'Content-Type': 'application/json' }, body: '{}' }));
      await fin.locator('[data-end]').dispatchEvent('change');
      await page.waitForFunction(() => /Meralco[\s\S]*₱3,000\.00/.test(document.querySelector('#view-finance [data-pl]').textContent));
      assert.doesNotMatch(await openDays.textContent(), /Sep 25/);
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
      await page.evaluate(() => fetch('/api/days/2026-09-25/reopen', { method: 'POST', headers: { Authorization: 'Bearer owner@sandbox' } }));
    });

    await step('bill funds: the owner picks weekly or monthly, and EOD follows', async () => {
      const fin = page.locator('#view-finance');
      const meralco = () => fin.locator('[data-funds-table] tr', { hasText: 'Meralco' });
      const setEvery = async every => {
        await meralco().locator('[data-act="edit-fund"]').click();
        await page.selectOption('#modal [data-fund-every]', every);
        await page.click('#modal [data-confirm]');
        await expectToast(/Fund saved/);
      };
      await meralco().locator('[data-act="edit-fund"]').click();
      assert.equal(await page.inputValue('#modal [data-fund-every]'), 'weekly', 'an existing bill starts weekly');
      await page.click('#modal [data-close]');
      await setEvery('monthly');
      await page.waitForFunction(() => /per month/.test(document.querySelector('#view-finance [data-funds-table]').textContent));

      await page.click('#nav [data-view="eod"]');
      await eod.locator('[data-date]').fill('2026-09-16');
      await eod.locator('[data-date]').dispatchEvent('change');
      await page.waitForFunction(() => /aside this month/i.test(document.querySelector('#view-eod [data-envelope]')?.textContent || ''));
      await shot('08e-envelope-monthly');

      await page.click('#nav [data-view="finance"]');
      await setEvery('weekly');
      await page.waitForFunction(() => /per week/.test(document.querySelector('#view-finance [data-funds-table]').textContent));
    });

    await step('EOD: the owner records a supplier payment; it is labelled, and the box resets', async () => {
      await page.click('#nav [data-view="eod"]');
      await eod.locator('[data-date]').fill('2026-09-15');
      await eod.locator('[data-date]').dispatchEvent('change');
      await page.waitForFunction(() => document.querySelector('#view-eod [data-date]').value === '2026-09-15');
      await eod.locator('[data-e="for_resale"]').check();
      assert.match(await eod.locator('[data-fund-hint]').textContent(), /not counted twice/i, 'the hint says what the box does');
      await eod.locator('[data-e="description"]').fill('Remit H95 x1');
      await eod.locator('[data-e="amount"]').fill('7200');
      await eod.locator('[data-add-expense]').click();
      await expectToast(/Expense added/);
      const row = eod.locator('[data-expenses] .row-line', { hasText: 'Remit H95 x1' });
      await row.waitFor();
      assert.match(await row.textContent(), /Supplier payment/);
      assert.equal(await eod.locator('[data-e="for_resale"]').isChecked(), false, 'the next expense starts as an ordinary one');
      await row.locator('[data-del-expense]').click();
      await expectToast(/Expense deleted/);
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
      // Weeks run Monday to Sunday on every screen: Payroll opens on this week, and "This week" / "Last week" follow it.
      await payroll.locator('thead .attendance-day').first().waitFor();
      const isMonToSun = heads => heads.length === 7 && heads[0].startsWith('Mon') && heads[6].startsWith('Sun');
      const opened = await dayHeads();
      assert.ok(isMonToSun(opened), `payroll opens on a Monday–Sunday week (got ${opened[0]} … ${opened.at(-1)})`);
      await payroll.locator('[data-preset="last-week"]').click();
      await page.waitForFunction(first => document.querySelector('#view-payroll thead .attendance-day')?.textContent.replace(/\s+/g, '') !== first, opened[0]);
      assert.ok(isMonToSun(await dayHeads()), 'Last week is Monday–Sunday');
      await payroll.locator('[data-preset="this-week"]').click();
      await page.waitForFunction(first => document.querySelector('#view-payroll thead .attendance-day')?.textContent.replace(/\s+/g, '') === first, opened[0]);
      assert.deepEqual(await dayHeads(), opened, 'This week is the week Payroll opened on');
      // Next week: the Monday–Sunday week after the range shown, even from a half week.
      await setPayrollRange('2026-09-28', '2026-10-04');
      await payroll.locator('[data-preset="next-week"]').click();
      // The date boxes change before the table has loaded, so wait for the table itself.
      await page.waitForFunction(() => document.querySelector('#view-payroll thead .attendance-day')?.dataset.date === '2026-10-05');
      assert.deepEqual(await dayHeads(), ['Mon10-05', 'Tue10-06', 'Wed10-07', 'Thu10-08', 'Fri10-09', 'Sat10-10', 'Sun10-11']);
      await setPayrollRange('2026-10-05', '2026-10-07');
      await payroll.locator('[data-preset="next-week"]').click();
      await page.waitForFunction(() => document.querySelector('#view-payroll [data-start]').value === '2026-10-12');
      assert.equal(await payroll.locator('[data-end]').inputValue(), '2026-10-18');
      // The other weekly screens agree: Finance's This week is the same Monday to Sunday.
      const thisMonday = await page.evaluate(() => { const d = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date()) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); });
      await payroll.locator('[data-preset="this-week"]').click();
      await page.waitForFunction(d => document.querySelector('#view-payroll thead .attendance-day')?.dataset.date === d, thisMonday);
      assert.equal(await payroll.locator('[data-start]').inputValue(), thisMonday);
      await setPayrollRange('2026-10-12', '2026-10-18');

      // The calendar highlights the whole range From → To, and previews a new range on hover.
      const dp = page.locator('.datepicker');
      const rangeDays = async () => ({
        start: (await dp.locator('.dp-range-start').allTextContents()).join(),
        end: (await dp.locator('.dp-range-end').allTextContents()).join(),
        inRange: await dp.locator('.dp-in-range').count(),
      });
      await payroll.locator('[data-end]').click();
      await dp.waitFor();
      assert.deepEqual(await rangeDays(), { start: '12', end: '18', inRange: 7 });
      await dp.locator('.dp-day:not(.dp-outside)', { hasText: /^20$/ }).hover();
      assert.deepEqual(await rangeDays(), { start: '12', end: '20', inRange: 9 }, 'hovering a day previews the new range');
      await page.keyboard.press('Escape');
      await payroll.locator('[data-start]').click();
      await dp.waitFor();
      assert.deepEqual(await rangeDays(), { start: '12', end: '18', inRange: 7 }, 'the From calendar shows the same range');
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

    await step('payroll: OT settings and an employee\'s work day are plain choices, previewed before saving', async () => {
      // Reported: the first OT screens (bare numbers, a shared date field) were confusing and easy to get wrong.
      const note = () => payroll.locator('[data-ot-rule]').textContent();
      const fmt = n => `₱${(Math.round(n * 100) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const modal = page.locator('#modal');
      const checked = name => modal.locator(`input[name="${name}"]:checked`).getAttribute('value');
      const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date()));
      const addDay = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
      const weekStart = addDay(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7)); // the Monday this week starts on
      await setPayrollRange('2027-03-07', '2027-03-13');
      assert.equal(await note(), 'OT pays the carwash rate ÷ 11 (construction rate ÷ 8) × 1 per hour.');

      // Shop rule: the choices start at the rule in effect this pay week; a change starts this pay week by default.
      await payroll.locator('[data-ot-settings]').click();
      assert.equal(await checked('cw-hours'), '11');
      assert.equal(await checked('cn-hours'), '8');
      assert.equal(await checked('ot-pay'), '1');
      assert.equal(await checked('starts'), 'this');
      assert.match(await modal.locator('label', { has: page.locator('input[name="starts"][value="this"]') }).textContent(), /This pay week/);
      await modal.locator('input[name="starts"][value="date"]').check();
      await modal.locator('[data-starts-date]').fill('2027-03-07');
      await modal.locator('input[name="cw-hours"][value="other"]').check();
      await modal.locator('[data-other="cw-hours"]').fill('9');
      await modal.locator('input[name="ot-pay"][value="1.25"]').check();
      await page.waitForFunction(() => /÷ 9 h × 1\.25 = ₱/.test(document.querySelector('#modal [data-example]')?.textContent || ''));
      await page.click('#modal [data-confirm]');
      await expectToast(/Overtime settings saved/);
      await page.waitForFunction(() => /÷ 9/.test(document.querySelector('#view-payroll [data-ot-rule]').textContent));
      assert.equal(await note(), 'OT pays the carwash rate ÷ 9 (construction rate ÷ 8) × 1.25 per hour.');

      // A new employee on an 8-hour day: the form shows what one OT hour pays them.
      await payroll.locator('[data-add-employee]').click();
      await page.fill('#modal [data-n="name"]', 'Own Hours GM');
      await page.fill('#modal [data-n="role"]', 'GM');
      await page.fill('#modal [data-n="rate_per_day"]', '1100');
      await page.fill('#modal [data-n="construction_rate"]', '0');
      assert.equal(await checked('work-day'), 'shop');
      assert.equal(await checked('emp-ot'), 'shop');
      await modal.locator('input[name="work-day"][value="8"]').check();
      // (as of today: the Mar 2027 shop change to × 1.25 is still ahead)
      await page.waitForFunction(() => /Own Hours GM's OT: day rate ₱1,100 ÷ 8 h × 1 = ₱137\.50 per OT hour/.test(document.querySelector('#modal [data-example]')?.textContent || ''));
      await page.click('#modal [data-confirm]');
      await expectToast(/Employee added/);
      const row = payroll.locator('tbody tr[data-emp]', { hasText: 'Own Hours GM' });
      await row.waitFor();
      assert.match(await row.locator('.employee-cell .muted').textContent(), /GM · ₱1,100\.00 \/ ₱0\.00 · 8h day$/);
      await row.locator('[data-act="ot"]').click();
      await page.fill('#modal [data-cw="2027-03-08"]', '2');
      await page.click('#modal [data-confirm]');
      await expectToast(/Overtime saved/);
      const otPayIs = want => page.waitForFunction(w => [...document.querySelectorAll('#view-payroll tbody tr[data-emp]')]
        .find(tr => tr.textContent.includes('Own Hours GM'))?.querySelector('[data-ot-pay]').textContent.trim() === w, want, { timeout: 8000 })
        .catch(async () => assert.fail(`OT pay ${(await row.locator('[data-ot-pay]').textContent()).trim()}, expected ${want}`));
      await otPayIs(fmt(1100 / 8 * 1.25 * 2));

      // Their own OT pay: the normal hourly rate. The preview lists the change before it is saved.
      await row.locator('[data-act="edit"]').click();
      assert.equal(await checked('work-day'), '8');
      assert.equal(await checked('starts'), 'this');
      await modal.locator('input[name="emp-ot"][value="1"]').check();
      await page.waitForFunction(() => /Own Hours GM.*₱343\.75.*₱275\.00/.test(document.querySelector('#modal [data-changes]')?.textContent || ''));
      await page.click('#modal [data-confirm]');
      await expectToast(/Employee saved/);
      await otPayIs(fmt(1100 / 8 * 2));
      assert.match(await row.locator('.employee-cell .muted').textContent(), /8h day · OT at normal rate$/);

      // That week's wages are paid out: going back to the shop rule needs a second confirm.
      const payoutId = await page.evaluate(async () => (await (await fetch('/api/payroll/payouts', { method: 'POST',
        headers: { Authorization: 'Bearer owner@sandbox', 'Content-Type': 'application/json' },
        body: JSON.stringify({ payout_date: '2027-03-13', period_start: '2027-03-07', period_end: '2027-03-13', side: 'cash', amount: 100 }) })).json()).id);
      await row.locator('[data-act="edit"]').click();
      await modal.locator('input[name="work-day"][value="shop"]').check();
      await modal.locator('input[name="emp-ot"][value="shop"]').check();
      await page.waitForFunction(() => /already paid out/.test(document.querySelector('#modal [data-paid]')?.textContent || ''));
      assert.ok(await page.locator('#modal [data-confirm]').isDisabled(), 'Save waits for the second confirm');
      await modal.locator('[data-confirm-paid]').check();
      await page.click('#modal [data-confirm]');
      await expectToast(/Employee saved/);
      await otPayIs(fmt(1100 / 9 * 1.25 * 2));

      // Undo the shop change from its history (the paid week asks again; the dialog is accepted).
      await payroll.locator('[data-ot-settings]').click();
      await modal.locator('[data-history] summary').click();
      await page.click('#modal [data-rule-row="2027-03-07"] [data-del-rule]');
      await expectToast(/Overtime change undone/);
      await page.waitForFunction(() => /÷ 11/.test(document.querySelector('#view-payroll [data-ot-rule]').textContent));
      await otPayIs(fmt(1100 / 11 * 2));
      await page.evaluate(async id => fetch(`/api/payroll/payouts/${id}`, { method: 'DELETE', headers: { Authorization: 'Bearer owner@sandbox' } }), payoutId);
      await row.locator('[data-act="deactivate"]').click();
      await expectToast(/removed/);
      // Back to this week, so the next steps' ranges are never more than 62 days from the one shown.
      await payroll.locator('[data-preset="this-week"]').click();
      await page.waitForFunction(s => document.querySelector('#view-payroll thead .attendance-day')?.dataset.date === s, weekStart);
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
      // the week (it started today), and saving 850 again from the start of the week did nothing since 850 was "already" his rate.
      const today = await page.evaluate(() => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date()));
      const addD = (d, n) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
      const weekStart = addD(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7)); // the Monday this pay week starts on
      const lastWeekStart = addD(weekStart, -7);
      const fmt = n => `₱${(Math.round(n * 100) / 100).toLocaleString('en-PH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
      const otPay = rate => (weekStart >= '2026-10-05' ? rate / 11 : rate / 8) * 2; // 2h carwash OT on the first day of the week
      const netIs = want => page.waitForFunction(w => [...document.querySelectorAll('#view-payroll tbody tr[data-emp]')]
        .find(tr => tr.textContent.includes('Raise Tester'))?.querySelector('[data-net]').textContent.trim() === w, want, { timeout: 8000 })
        .catch(async () => assert.fail(`net ${await page.evaluate(() => [...document.querySelectorAll('#view-payroll tbody tr[data-emp]')]
          .find(tr => tr.textContent.includes('Raise Tester'))?.querySelector('[data-net]').textContent.trim())}, expected ${want}`));
      await setPayrollRange(lastWeekStart, addD(weekStart, 6));
      await payroll.locator('[data-add-employee]').click();
      await page.fill('#modal [data-n="name"]', 'Raise Tester');
      await page.fill('#modal [data-n="rate_per_day"]', '800');
      await page.fill('#modal [data-n="construction_rate"]', '0');
      await page.click('#modal [data-confirm]');
      await expectToast(/Employee added/);
      const row = payroll.locator('tbody tr[data-emp]', { hasText: 'Raise Tester' });
      await row.waitFor();
      // The last day of last week and every day of this week, with 2h OT on its first day.
      for (const day of [addD(weekStart, -1), ...[0, 1, 2, 3, 4, 5, 6].map(i => addD(weekStart, i))]) {
        const reloaded = page.waitForResponse(r => r.url().includes('/api/payroll?') && r.request().method() === 'GET');
        await row.locator(`[data-day="${day}"]`).selectOption('P');
        await reloaded;
      }
      await row.locator('[data-act="ot"]').click();
      await page.fill(`#modal [data-cw="${weekStart}"]`, '2');
      await page.click('#modal [data-confirm]');
      await expectToast(/Overtime saved/);
      await netIs(fmt(8 * 800 + otPay(800)));

      // First try, as it happened: the raise saved with today as the effective date.
      await row.locator('[data-act="edit"]').click();
      await page.check('#modal input[name="starts"][value="date"]');
      await page.fill('#modal [data-starts-date]', today);
      await page.fill('#modal [data-n="rate_per_day"]', '850');
      await page.click('#modal [data-confirm]');
      await expectToast(/Employee saved/);
      await page.waitForFunction(() => !document.querySelector('#modal[open]'));
      // Edit again: the form starts the change at the Monday this pay week starts on, says what changes, and saves 850
      // from that Monday even though 850 is already today's rate.
      await row.locator('[data-act="edit"]').click();
      assert.equal(await page.locator('#modal input[name="starts"]:checked').getAttribute('value'), 'this', 'a rate change starts with this pay week by default');
      assert.match(await page.locator('#modal label', { has: page.locator('input[name="starts"][value="this"]') }).textContent(),
        new RegExp(new Date(`${weekStart}T00:00:00Z`).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'UTC' })));
      assert.equal(await page.inputValue('#modal [data-n="rate_per_day"]'), '850');
      assert.match(await page.textContent('#modal [data-rate-note]'), /800\.00.*850\.00/, 'the form says which rate changes from that date');
      await page.click('#modal [data-confirm]');
      await expectToast(/Employee saved/);
      await netIs(fmt(800 + 7 * 850 + otPay(850))).catch(async () =>
        assert.fail(`net ${(await row.locator('[data-net]').textContent()).trim()}, expected ${fmt(800 + 7 * 850 + otPay(850))}`));
      // Days before this week keep the old rate.
      await setPayrollRange(lastWeekStart, addD(weekStart, -1));
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
      // The same payout entered again is asked about first; saying no records nothing.
      await payroll.locator('[data-payout]').click();
      await page.fill('#modal [data-payout-date]', '2026-09-20');
      declineNext();
      await page.click('#modal [data-confirm]');
      await page.waitForFunction(() => !document.querySelector('#modal [data-confirm]').disabled);
      assert.match(lastDeclined, /already recorded/);
      await page.click('#modal [data-close]');
      assert.equal(await payroll.locator('[data-payouts] .row-line').count(), 1, 'still one payout');
      const paidOut =Number((await payroll.locator('[data-total]').textContent()).replace(/[₱,]/g, ''));
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

    // Picks a theme in the sidebar and waits for the switch (and its transition) to finish.
    const pickTheme = async name => {
      await page.click(`.theme-switch [data-theme-choice="${name}"]`);
      await page.waitForFunction(n => document.documentElement.dataset.theme === n && !document.documentElement.classList.contains('theme-switching'), name);
    };
    const modalMotion = async () => {
      await daily.locator('tr[data-id] [data-act="edit"]').first().click();
      await page.waitForSelector('#modal[open]');
      const name = await page.evaluate(() => getComputedStyle(document.querySelector('#modal')).animationName);
      await page.click('#modal [data-close]');
      await page.waitForFunction(() => !document.querySelector('#modal').open);
      return name;
    };

    await step('Enter in a box does what the button next to it does', async () => {
      const ENTER_DAY = '2026-06-15'; // nothing else on it
      // EOD: an expense, then the setup boxes.
      await page.click('#nav [data-view="eod"]');
      await eod.locator('[data-date]').fill(ENTER_DAY);
      await eod.locator('[data-date]').dispatchEvent('change');
      await page.waitForFunction(() => /No expenses recorded/.test(document.querySelector('#view-eod [data-expenses]').textContent));
      await eod.locator('[data-e="description"]').fill('Rags');
      await eod.locator('[data-e="amount"]').fill('45');
      await eod.locator('[data-e="amount"]').press('Enter');
      await expectToast(/Expense added/);
      assert.equal(await eod.locator('[data-expenses] .row-line').count(), 1);
      await eod.locator('[data-m="cash_float"]').fill('500');
      await eod.locator('[data-m="cash_float"]').press('Enter');
      await expectToast(/EOD saved/);
      // A new job: Enter opens the review, where nothing is saved until Add job.
      await page.click('#nav [data-view="carwash"]');
      await carwashDate(ENTER_DAY);
      const editor = daily.locator('[data-editor]');
      await editor.locator('[data-f="vehicle_class"]').selectOption('S');
      await editor.locator('[data-add="service"]').selectOption({ label: 'Premium Wash' });
      await editor.locator('[data-f="plate"]').fill('ENTER 1');
      await editor.locator('[data-f="plate"]').press('Enter');
      await page.waitForSelector('#modal[open] [data-confirm]');
      await page.click('#modal [data-confirm]');
      await expectToast(/added/);
      // In a pop-up form, Enter presses its main button.
      await daily.locator('tr', { hasText: 'ENTER 1' }).locator('[data-act="edit"]').click();
      await page.waitForSelector('#modal[open] [data-edit-editor] .line-row');
      await page.fill('#modal [data-f="remarks"]', 'Saved with Enter');
      await page.press('#modal [data-f="remarks"]', 'Enter');
      await expectToast(/saved/);
      await page.waitForFunction(() => !document.querySelector('#modal').open);
      // A small inline form (Settings → add a user).
      await page.click('#nav [data-view="settings"]');
      await page.fill('#view-settings [data-u="email"]', 'enter@sandbox.test');
      await page.press('#view-settings [data-u="email"]', 'Enter');
      await expectToast(/User added/);
      await page.locator('#view-settings [data-users] tr', { hasText: 'enter@sandbox.test' }).waitFor();
      await page.click('#nav [data-view="carwash"]');
      await carwashDate(DAY);
    });

    await step('themes: Classic, Telemetry and Editorial, each with its own look and motion, remembered per device', async () => {
      await page.click('#nav [data-view="carwash"]');
      await daily.locator('[data-date]').fill(DAY);
      await daily.locator('[data-date]').dispatchEvent('change');
      await page.waitForSelector('#view-carwash tr[data-id]');
      const choices = page.locator('.theme-switch [data-theme-choice]');
      assert.deepEqual(await choices.evaluateAll(els => els.map(e => [e.dataset.themeChoice, e.getAttribute('aria-label'), e.getAttribute('role')])),
        [['classic', 'Classic', 'radio'], ['telemetry', 'Telemetry', 'radio'], ['editorial', 'Editorial', 'radio']]);

      // Classic is the default and is the app exactly as it was.
      let look = await readLook(page);
      assert.equal(look.theme, 'classic');
      assert.equal(look.bg, 'rgb(0, 0, 0)');
      assert.match(look.font, /^-apple-system/);
      assert.equal(look.motion.view, 'view-in');
      assert.equal(await page.getAttribute('.theme-switch [data-theme-choice="classic"]', 'aria-checked'), 'true');
      assert.match(await page.textContent('.theme-switch [data-theme-name]'), /^Classic$/);
      assert.equal(await modalMotion(), 'sheet-in');
      await shot('14-theme-classic');

      // Telemetry: industrial brutalist, dark. Mechanical, stepped motion.
      await pickTheme('telemetry');
      look = await readLook(page);
      assert.equal(look.bg, 'rgb(10, 10, 10)', 'deactivated-CRT black, not pure black');
      assert.match(look.navFont, /^"?JetBrains Mono/);
      assert.match(look.heading.font, /^"?Inter/);
      assert.equal(look.heading.case, 'uppercase');
      assert.deepEqual(look.radius, { card: '0px', button: '0px' }, 'square corners');
      for (const k of ['muted', 'label', 'button', 'text']) assert.ok(look[k] >= 4.5, `telemetry ${k} contrast ${look[k].toFixed(2)}:1`);
      const [r, g, b] = look.caution.match(/\d+/g).map(Number);
      assert.ok(r > 180 && g > 120 && b < 120, `caution amounts stay amber (got ${look.caution})`);
      assert.equal(look.motion.view, 'tele-scan', 'screens draw in like a CRT scan');
      assert.equal(look.motion.cursor, 'tele-blink', 'the title has a terminal cursor');
      assert.equal(await modalMotion(), 'tele-power', 'dialogs switch on like a CRT');
      assert.equal(await page.getAttribute('.theme-switch [data-theme-choice="telemetry"]', 'aria-checked'), 'true');
      assert.equal(await page.getAttribute('.theme-switch [data-theme-choice="classic"]', 'aria-checked'), 'false');
      await page.keyboard.press('Tab');
      await page.locator('#nav button').first().focus();
      assert.notEqual(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'none', 'focus ring in telemetry');
      await shot('15-theme-telemetry');

      // Editorial: premium minimalist, light. Quiet, eased, staggered motion.
      await pickTheme('editorial');
      look = await readLook(page);
      assert.equal(look.bg, 'rgb(247, 246, 243)', 'warm bone paper');
      assert.match(look.font, /^"?Geist/);
      assert.match(look.heading.font, /^"?Newsreader/);
      assert.equal(look.heading.case, 'none');
      assert.equal(look.radius.card, '12px');
      assert.equal(look.buttonBg, 'rgb(17, 17, 17)');
      for (const k of ['muted', 'label', 'button', 'text']) assert.ok(look[k] >= 4.5, `editorial ${k} contrast ${look[k].toFixed(2)}:1`);
      assert.equal(look.caution, 'rgb(149, 100, 0)', 'caution in the muted yellow');
      assert.equal(look.motion.header, 'ed-in', 'sections fade up in sequence');
      assert.equal(await modalMotion(), 'ed-rise');
      assert.equal(await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content), '#F7F6F3');
      await shot('16-theme-editorial');

      // Remembered on this device, and applied before the first paint (no flash of another theme).
      assert.equal(await page.evaluate(() => localStorage.getItem('gmops-theme')), 'editorial');
      await page.reload();
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'editorial');
      await page.waitForSelector('#app:not([hidden])');

      // Reduced motion: no theme animates.
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await pickTheme('telemetry');
      assert.equal(await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('#view-carwash.active')).animationDuration)), 0);
      await page.emulateMedia({ reducedMotion: 'no-preference' });

      await pickTheme('classic');
      assert.equal((await readLook(page)).bg, 'rgb(0, 0, 0)');
      assert.equal(await page.evaluate(() => document.querySelector('meta[name="theme-color"]').content), '#000000');
    });

    await step('staff: limited nav, closed day is read-only', async () => {
      await page.click('#signout-btn');
      await page.waitForSelector('#login-form:not([hidden])');
      const leftovers = await page.evaluate(() => [...document.querySelectorAll('main .view')].filter(v => v.innerHTML.trim()).map(v => v.id));
      assert.deepEqual(leftovers, [], 'previous user screens must be cleared on sign-out');
      await signIn('staff@sandbox');
      assert.deepEqual(await page.locator('#nav button').allTextContents(), ['Carwash', 'Detailing', 'Tint & PPF', 'Parts', 'Inventory', 'EOD Closing', 'Pricing Matrix']);
      assert.ok(await page.locator('.theme-switch').isVisible(), 'staff can pick a theme too');
      await page.click('#nav [data-view="eod"]');
      await eod.locator('[data-add-expense]').waitFor();
      assert.equal(await eod.locator('[data-e="for_resale"]').count(), 0, 'only the owner records a supplier payment');
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
      await page.locator('#view-parts [data-completed-date]').fill('2026-09-01');
      await page.locator('#view-parts [data-completed-date]').dispatchEvent('change');
      await doneRow('PC-092126-001').waitFor();
      assert.doesNotMatch(await partsView.textContent(), /cost/i, 'staff must not see part costs');
      await partRow('Engine oil 1L').click();
      await page.waitForSelector('#modal[open] [data-panel]');
      assert.doesNotMatch(await page.textContent('#modal [data-panel]'), /cost/i, 'staff must not see part costs in the details');
      await page.click('#modal [data-close]');
      // Staff see the inventory without costs and record counts, but cannot change items.
      await page.click('#nav [data-view="inventory"]');
      await invRow('Microfiber 40x40').waitFor();
      assert.doesNotMatch(await inv.textContent(), /cost|value/i, 'staff must not see costs');
      assert.equal(await inv.locator('[data-paste]').isVisible(), false);
      assert.equal(await inv.locator('[data-container]').count(), 5, 'staff see every container');
      // In the Sheet too: no cost columns, and only the stock can be changed (it records a count).
      await inv.locator('[data-mode="sheet"]').click();
      await sheetRow('Microfiber 40x40').waitFor();
      assert.equal(await inv.locator('[data-sheet] thead th', { hasText: /cost|value/i }).count(), 0, 'staff must not see costs');
      assert.deepEqual(await inv.locator('[data-sheet] tbody tr').first().locator('td.editable').evaluateAll(tds => tds.map(td => td.dataset.field)), ['stock']);
      await inv.locator('[data-mode="list"]').click();
      await invRow('Microfiber 40x40').waitFor();
      await openItem('Microfiber 40x40');
      assert.doesNotMatch(await page.textContent('#modal [data-panel]'), /cost|value/i, 'staff must not see costs in the details');
      for (const act of ['receive', 'history', 'edit', 'move']) assert.equal(await page.locator(`#modal [data-act="${act}"]`).count(), 0, `staff cannot ${act}`);
      await page.click('#modal [data-act="count"]');
      // Only the owner can raise a count: staff are told why and cannot save it.
      await page.fill('#modal [data-c="counted"]', '99');
      assert.match(await page.textContent('#modal [data-c-summary]'), /Only the owner can raise a count/);
      assert.equal(await page.isDisabled('#modal [data-confirm]'), true);
      await page.fill('#modal [data-c="counted"]', '20');
      await page.click('#modal [data-confirm]');
      await expectToast(/Count saved/);
      await waitStock('Microfiber 40x40', '20');
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
      // Inventory and Parts: the simple lists fit a phone; the page never scrolls sideways, rows are easy to tap.
      for (const [view, row] of [['inventory', invRow('Snow foam')], ['parts', partRow('Engine oil 1L')]]) {
        await page.click(`#nav [data-view="${view}"]`);
        await row.waitFor();
        const sideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(sideways <= 1, `${view} scrolls sideways by ${sideways}px on mobile`);
        // The list redraws as the view opens, so measure a row that is really on screen.
        let box = null;
        for (let i = 0; i < 30 && !box; i += 1) {
          box = await row.boundingBox();
          if (!box) await page.waitForTimeout(100);
        }
        assert.ok(box && box.height >= 44, `${view} rows are at least 44px tall`);
        await shot(`12b-mobile-${view}`);
      }
      // The Sheet scrolls inside its own box on a phone; the page never scrolls sideways.
      await page.click('#nav [data-view="inventory"]');
      await inv.locator('[data-mode="sheet"]').click();
      await sheetRow('Snow foam').waitFor();
      const sheetSideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(sheetSideways <= 1, `the sheet pushes the page sideways by ${sheetSideways}px on mobile`);
      await shot('12b-mobile-inventory-sheet');
      await inv.locator('[data-mode="list"]').click();
      await invRow('Snow foam').waitFor();
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
      // Analytics (owner): the services list fits a phone. Change compares two periods with closed days.
      for (const day of ['2026-09-08', '2026-09-22']) {
        await page.evaluate(async d => {
          const headers = { Authorization: 'Bearer owner@sandbox', 'Content-Type': 'application/json' };
          await fetch('/api/jobs', { method: 'POST', headers, body: JSON.stringify({ job_date: d, vehicle_class: 'S', payment_method: 'Cash', payment_received: true,
            items: [{ name: 'Compare wash', price: 300, commission: 0 }] }) });
          await fetch(`/api/days/${d}/close`, { method: 'POST', headers, body: '{}' });
        }, day);
      }
      await page.click('#nav [data-view="analytics"]');
      await page.locator('#view-analytics [data-date]').fill('2026-09-30');
      await page.locator('#view-analytics [data-date]').dispatchEvent('change');
      await page.locator('#view-analytics [data-service]').first().waitFor();
      await page.locator('#view-analytics [data-grain="week"]').click();
      await page.waitForFunction(() => / vs /.test(document.querySelector('#view-analytics [data-services-compare]').textContent));
      assert.ok(await page.locator('#view-analytics [data-services-compare]').isVisible(), 'a phone shows which periods Change compares');
      const analyticsSideways = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(analyticsSideways <= 1, `analytics scrolls sideways by ${analyticsSideways}px on mobile`);
      await page.locator('#view-analytics [data-services]').scrollIntoViewIfNeeded();
      await shot('13b-mobile-analytics');
      await shot('12-mobile');
    });

    await step('mobile: every theme fits a phone, with 44px touch targets', async () => {
      await page.click('#nav [data-view="carwash"]');
      await page.waitForSelector('#view-carwash [data-entry-card]:not([hidden])');
      assert.ok(await page.locator('.theme-switch').isVisible(), 'the theme switch is reachable on a phone');
      for (const theme of ['telemetry', 'editorial', 'classic']) {
        await pickTheme(theme);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 1, `${theme}: page scrolls sideways by ${overflow}px on mobile`);
        const shortNow = () => page.evaluate(() => [...document.querySelectorAll('#nav button, #view-carwash .date-nav .btn, #view-carwash [data-review]')]
          .filter(el => el.offsetParent).filter(el => el.getBoundingClientRect().height < 44).map(el => el.textContent.trim() || el.getAttribute('aria-label')));
        // A button can be mid-change just after the theme switches; only one that stays short fails.
        let short = await shortNow();
        for (let i = 0; i < 30 && short.length; i += 1) {
          await page.waitForTimeout(100);
          short = await shortNow();
        }
        assert.deepEqual(short, [], `${theme}: buttons shorter than 44px on mobile`);
        const spill = await page.evaluate(() => [...document.querySelectorAll('#view-carwash .card input, #view-carwash .card select')]
          .filter(el => el.offsetParent).filter(el => {
            const card = el.closest('.card').getBoundingClientRect();
            const box = el.getBoundingClientRect();
            return box.right > card.right + 0.5 || box.left < card.left - 0.5;
          }).map(el => {
            const card = el.closest('.card').getBoundingClientRect();
            const box = el.getBoundingClientRect();
            return `${el.dataset.f || el.placeholder || el.type} ${Math.round(box.left)}-${Math.round(box.right)} in card ${Math.round(card.left)}-${Math.round(card.right)}`;
          }));
        assert.deepEqual(spill, [], `${theme}: fields spill out of their card on mobile`);
        const switchBox = await page.locator('.theme-switch').boundingBox();
        assert.ok(switchBox.x >= 0 && switchBox.x + switchBox.width <= 390, `${theme}: theme switch cut off on mobile`);
        await shot(`17-mobile-${theme}`);
      }
    });

    assert.deepEqual(problems, [], 'browser reported errors');
    console.log('\nUI smoke test passed');
  } catch (error) {
    await shot('zz-failure').catch(() => {});
    console.error(`\nFAILED: ${error.message}`);
    console.error(error.stack.split('\n').filter(l => l.includes('ui-smoke')).join('\n'));
    if (problems.length) console.error(problems.join('\n'));
    process.exitCode = 1;
  } finally {
    await browser.close();
    server.close();
  }
})();
