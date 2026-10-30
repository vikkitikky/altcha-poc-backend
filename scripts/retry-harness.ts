import { writeFile } from 'node:fs/promises';
import { startRetryHarness } from '../test/browser/retry-harness.js';
const harness = await startRetryHarness();
console.log(`Retry research suite: ${harness.url}`);
let timer: NodeJS.Timeout | undefined;
try {
  const results = await Promise.race([harness.completed, new Promise<never>((_, reject) => { timer=setTimeout(()=>reject(new Error('Retry suite timeout')),300000); })]);
  for (const result of results) console.log(`${result.passed?'PASS':'FAIL'} ${result.name}${result.error?': '+result.error:''}`);
  await writeFile(new URL('../docs/code-retry-results.json',import.meta.url), JSON.stringify({widget:'3.5.0',results},null,2)+'\n');
  process.exitCode=results.every(r=>r.passed)?0:1;
} finally { if(timer) clearTimeout(timer); await harness.close(); }
