import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startBrowserHarness } from './harness.js';

test('ALTCHA Widget 3.5.0 real-browser native integration', { timeout: 90000 }, async (t) => {
  const harness = await startBrowserHarness();
  let browser;
  try {
    browser = await chromium.launch(process.env.CHROME_EXECUTABLE
      ? { executablePath: process.env.CHROME_EXECUTABLE }
      : process.platform === 'darwin' ? { channel: 'chrome' } : {});
    const page = await browser.newPage();
    await page.goto(harness.url);
    const results = await Promise.race([harness.completed, new Promise<never>((_resolve, reject) => {
      t.signal.addEventListener('abort', () => reject(new Error('Browser test aborted/timed out')), { once: true });
    })]);
    for (const result of results) await t.test(result.name, () => assert.equal(result.passed, true, result.error ?? 'Browser integration failed'));
  } finally { await browser?.close(); await harness.close(); }
});
