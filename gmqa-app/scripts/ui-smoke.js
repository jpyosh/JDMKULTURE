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
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
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
        ['01Daily Log', '02EOD Closing', '03Pricing Matrix', '04Sales Reports', '05Payroll', '06Settings']);
    });

    const daily = page.locator('#view-daily');
    await step('daily log shows migrated jobs', async () => {
      await daily.locator('[data-date]').fill(DAY);
      await daily.locator('[data-date]').dispatchEvent('change');
      await page.waitForFunction(() => document.querySelectorAll('#view-daily [data-jobs] tr[data-id]').length === 19);
      assert.match(await daily.locator('[data-metrics]').textContent(), /Vehicles\s*19/);
    });

    await step('create a job with service + add-on + custom line', async () => {
      const editor = daily.locator('[data-editor]');
      await editor.locator('[data-f="vehicle_class"]').selectOption('M');
      await editor.locator('[data-f="plate"]').fill('smk 123');
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
      await expectToast(/JO-091426-020 added/);
      await page.waitForFunction(() => document.querySelectorAll('#view-daily [data-jobs] tr[data-id]').length === 20);
      assert.equal(await daily.locator('[data-editor] .line-row').count(), 0, 'editor resets after adding');
    });

    const newRow = daily.locator('tr', { hasText: 'JO-091426-020' });
    await step('inline paid toggle updates totals', async () => {
      await newRow.locator('[data-inline="payment_received"]').check();
      await expectToast(/Saved/);
      await page.waitForFunction(() => /Collected\s*₱[\d,]+/.test(document.querySelector('#view-daily [data-metrics]').textContent));
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
      await page.waitForFunction(() => document.querySelectorAll('#view-daily [data-jobs] tr[data-id]').length === 19);
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

    await step('pricing: edit and save a price', async () => {
      await page.click('#nav [data-view="pricing"]');
      const row = page.locator('#view-pricing tr:has([data-name][value="Standard Wash"])');
      await row.locator('[data-class="S"][data-field="price"]').fill('275');
      await page.click('#view-pricing [data-save-all]');
      await expectToast(/Saved 1 item/);
      await shot('07-pricing');
    });

    await step('sales report', async () => {
      await page.click('#nav [data-view="reports"]');
      await page.fill('#view-reports [data-start]', '2026-09-01');
      await page.fill('#view-reports [data-end]', '2026-09-30');
      await page.locator('#view-reports [data-end]').dispatchEvent('change');
      await page.waitForSelector('#view-reports tr.weekly-total');
      await shot('08-reports');
    });

    await step('payroll: attendance updates pay', async () => {
      await page.click('#nav [data-view="payroll"]');
      await page.fill('#view-payroll [data-week]', '2026-09-16');
      await page.locator('#view-payroll [data-week]').dispatchEvent('change');
      await page.waitForFunction(() => document.querySelector('#view-payroll [data-week]').value === '2026-09-14');
      const first = page.locator('#view-payroll tbody tr').first();
      await first.locator('[data-day="2026-09-14"]').selectOption('P');
      await page.waitForFunction(() => document.querySelector('#view-payroll [data-total]').textContent !== '₱0.00');
      await shot('09-payroll');
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
      await signIn('staff@sandbox');
      assert.deepEqual(await page.locator('#nav button').allTextContents(), ['01Daily Log', '02EOD Closing', '03Pricing Matrix']);
      await page.click('#nav [data-view="daily"]');
      await daily.locator('[data-date]').fill(DAY);
      await daily.locator('[data-date]').dispatchEvent('change');
      await page.waitForSelector('#view-daily .banner');
      assert.equal(await daily.locator('[data-entry-card]').isHidden(), true);
      assert.equal(await daily.locator('[data-act="void"]').count(), 0);
      await page.click('#nav [data-view="pricing"]');
      assert.equal(await page.locator('#view-pricing tbody input').count(), 0, 'staff sees prices read-only');
      await page.goto(`${url}/#settings`);
      await page.waitForSelector('#view-daily.active');
      await shot('11-staff-daily');
    });

    await step('mobile layout renders', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.click('#nav [data-view="daily"]');
      await daily.locator('[data-date]').fill('2026-10-05');
      await daily.locator('[data-date]').dispatchEvent('change');
      await page.waitForSelector('#view-daily [data-entry-card]:not([hidden])');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(overflow <= 1, `page scrolls sideways by ${overflow}px on mobile`);
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
