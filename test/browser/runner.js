/* Browser-side integration tests. No fetch replacement, request interception,
   verifyFunction, challenge transformation or client challenge state. */
const widget = document.querySelector('altcha-widget');
const output = document.querySelector('output');
const originalFetch = window.fetch;
const events = [];
for (const type of ['verified', 'serververification']) widget.addEventListener(type, event => events.push({ type, payload: event.detail.payload }));
const check = (value, message) => { if (!value) throw new Error(message); };
const equal = (actual, expected, message) => check(JSON.stringify(actual) === JSON.stringify(expected), message);
const observations = async () => (await fetch('/observations')).json();
const methods = rows => rows.map(row => `${row.method} ${row.path}`);
const claims = token => JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
async function solveWithWidget() {
  await widget.verify();
  check(widget.getState() === 'verified', `Widget state: ${widget.getState()}`);
  await new Promise(requestAnimationFrame);
  const token = new FormData(document.querySelector('form')).get('altcha');
  check(typeof token === 'string' && token.split('.').length === 3, 'Native hidden form field must contain server JWT');
  return token;
}
widget.addEventListener('load', async () => {
  const result = { name: window.testCase.name, passed: false, userAgent: navigator.userAgent };
  try {
    await widget.configure({ challenge: '/api/captcha/challenge?site_id=example&action=submit_form', verifyUrl: '/api/captcha/verify' });
    switch (window.testCase.name) {
      case 'native-pow-business': {
        const token = await solveWithWidget();
        equal(claims(token).site_id, 'example', 'Signed context');
        const rows = await observations();
        equal(methods(rows), ['GET /api/captcha/challenge', 'POST /api/captcha/verify'], 'Native PoW method sequence');
        equal(rows[1].keys, ['payload'], 'Native verification body');
        check(events.find(e => e.type === 'verified')?.payload === token, 'Verified event receives server payload');
        check(events.find(e => e.type === 'serververification')?.payload === token, 'Server verification event receives server payload');
        const fields = new FormData(document.querySelector('form'));
        const body = JSON.stringify({ payload: fields.get('altcha'), message: fields.get('message') });
        const submit = () => fetch(`${window.testCase.businessOrigin}/api/business/submit`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
        const first = await submit(); check(first.status === 200 && (await first.json()).accepted === true, 'Business MS HTTP validation');
        check((await submit()).status === 400, 'Business replay must fail');
        break;
      }
      case 'his-reset': {
        document.querySelector('input[name=message]').focus();
        // The collector accepts browser events as observations; these test events
        // also demonstrate why HIS cannot authenticate human presence.
        window.dispatchEvent(new PointerEvent('pointermove', { clientX: 20, clientY: 30, pointerType: 'mouse' }));
        const first = await solveWithWidget();
        check(claims(first).his_received === true, 'HIS receipt is bound to challenge/token');
        const rows = await observations();
        equal(methods(rows), ['GET /api/captcha/challenge', 'POST /api/captcha/challenge', 'POST /api/captcha/verify'], 'Native HIS method sequence');
        equal(rows[1].keys, ['his'], 'Native HIS body');
        equal(rows[1].hisKeys, ['focus', 'maxTouchPoints', 'pointer', 'scroll', 'time', 'touch'], 'Native collector schema');
        equal(rows[2].keys, ['payload'], 'HIS is absent from native verification');
        widget.reset();
        const second = await solveWithWidget(); check(first !== second, 'Reset must produce a fresh token');
        equal(methods(await observations()).slice(3), ['GET /api/captcha/challenge', 'POST /api/captcha/challenge', 'POST /api/captcha/verify'], 'Reset repeats HIS handshake');
        break;
      }
      case 'his-disabled': {
        await widget.verify();
        check(widget.getState() === 'error', 'Disabled collector must reject server HIS request');
        equal(methods(await observations()), ['GET /api/captcha/challenge'], 'No invented HIS fallback');
        break;
      }
      case 'native-retry': {
        await widget.configure({ verifyUrl: '/api/captcha/absent' });
        await widget.verify(); check(widget.getState() === 'error', 'Missing verification route should fail');
        widget.reset(); await widget.configure({ verifyUrl: '/api/captcha/verify' });
        check(claims(await solveWithWidget()).policy === 'standard', 'Native retry succeeds');
        equal(methods(await observations()), ['GET /api/captcha/challenge', 'POST /api/captcha/absent', 'GET /api/captcha/challenge', 'POST /api/captcha/verify'], 'Retry fetches a new challenge');
        break;
      }
      default: throw new Error('Unknown test case');
    }
    check(window.fetch === originalFetch, 'Global fetch must remain unchanged');
    result.passed = true;
  } catch (error) { result.error = error.message; }
  output.textContent = `${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.error ? ': ' + result.error : ''}`;
  await fetch('/result', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) });
}, { once: true });
