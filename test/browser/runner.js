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
  await new Promise(resolve => setTimeout(resolve, 0));
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
      case 'image-business':
      case 'image-wrong-retry':
      case 'image-his':
      case 'image-reload': {
        const waitFor = async condition => { for(let i=0;i<160;i++){ if(condition())return; await new Promise(r=>setTimeout(r,50)); } throw new Error(`Timed out in state ${widget.getState()}`); };
        const answer = async () => (await (await fetch('/test-answer')).json()).answer;
        const nativeInput = () => widget.querySelector('.altcha-code-challenge input');
        const submit = code => { const input=nativeInput(); check(input,'Native Code input'); input.value=code; input.dispatchEvent(new Event('input',{bubbles:true})); input.form.requestSubmit(); };
        await widget.verify(); await waitFor(()=>widget.getState()==='code');
        const firstPow = new FormData(document.querySelector('form')).get('altcha');
        const firstImage = widget.querySelector('.altcha-code-challenge img');
        check(firstImage && firstImage.src.startsWith('data:image/png;base64,'), 'Real backend PNG rendered by native widget');
        await waitFor(()=>firstImage.complete && firstImage.naturalWidth>0);
        check(firstImage.naturalWidth>0,'PNG decodes in browser');
        const imageSource=firstImage.src;
        if(window.testCase.name==='image-wrong-retry') {
          const good=await answer(); submit((good[0]==='A'?'C':'A')+good.slice(1));
          await waitFor(()=>widget.getState()==='error');
          check(!nativeInput(),'Wrong answer closes Code UI');
          check(!events.some(e=>e.type==='verified'),'Partial image/PoW never emits verified');
          check(new FormData(document.querySelector('form')).get('altcha')===firstPow,'No server token after wrong code');
          equal(await (await fetch('/test-security')).json(),{permits:0,powUsed:null,attempts:'1'},'No premature PoW consumption or token permit');
          const rows=await observations(); equal(rows.at(-1).keys,['code','payload'],'Native code verification fields');
          widget.querySelector('input[type=checkbox]').click();
          await waitFor(()=>widget.getState()==='code');
          check(widget.querySelector('.altcha-code-challenge img').src!==imageSource,'Native checkbox fetches new image');
          check(new FormData(document.querySelector('form')).get('altcha')!==firstPow,'Native retry solves new PoW');
          check(nativeInput().value==='','Old answer not retained');
        } else if(window.testCase.name==='image-reload') {
          widget.querySelector('.altcha-code-challenge button[type=button]').click();
          await waitFor(()=>widget.getState()==='verifying'); await waitFor(()=>widget.getState()==='code');
          check(widget.querySelector('.altcha-code-challenge img').src!==imageSource,'Native reload gives new image and PoW');
        }
        submit(await answer()); await waitFor(()=>widget.getState()==='verified'); await new Promise(resolve => setTimeout(resolve, 0));
        const token=new FormData(document.querySelector('form')).get('altcha');
        check(claims(token).image_verified===true && claims(token).captcha_mode==='pow+image','Token attests complete image+PoW');
        if(window.testCase.name==='image-his') {
          check(claims(token).his_received===true,'Image and HIS compose');
          equal(methods(await observations()).slice(0,2),['GET /api/captcha/challenge','POST /api/captcha/challenge'],'Native HIS handshake');
        }
        if(window.testCase.name==='image-wrong-retry') equal(methods(await observations()),['GET /api/captcha/challenge','POST /api/captcha/verify','GET /api/captcha/challenge','POST /api/captcha/verify'],'No frontend recovery adapter');
        const body=JSON.stringify({payload:token,message:'image test'});
        const send=()=>fetch(`${window.testCase.businessOrigin}/api/business/submit`,{method:'POST',headers:{'Content-Type':'application/json'},body});
        check((await send()).status===200,'Full native image → Business HTTP flow'); check((await send()).status===400,'Image token replay rejected');
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
