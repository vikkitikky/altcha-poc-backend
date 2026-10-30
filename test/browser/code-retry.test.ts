import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startRetryHarness } from './retry-harness.js';
test('native Code HTTP 200 false / 400 / 401 / 422 / network failure runtime', { timeout: 90000 }, async(t)=>{
  const harness=await startRetryHarness(); let browser;
  try {
    browser=await chromium.launch(process.env.CHROME_EXECUTABLE ? {executablePath:process.env.CHROME_EXECUTABLE} : process.platform==='darwin'?{channel:'chrome'}:{});
    const page=await browser.newPage();await page.goto(harness.url);
    const results=await Promise.race([harness.completed,new Promise<never>((_,reject)=>t.signal.addEventListener('abort',()=>reject(new Error('Retry suite aborted')),{once:true}))]);
    for(const result of results) await t.test(result.name,()=>assert.equal(result.passed,true,result.error??'Retry behavior mismatch'));
  } finally {await browser?.close();await harness.close();}
});
