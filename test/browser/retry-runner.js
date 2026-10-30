const widget = document.querySelector('altcha-widget');
const originalFetch = fetch;
const states = [], events = [], rejections = [];
for (const name of ['statechange','codechallenge','serververification','verified']) widget.addEventListener(name, event => {
  events.push(name); if (name === 'statechange') states.push(event.detail.state);
});
window.addEventListener('unhandledrejection', event => { rejections.push(String(event.reason)); event.preventDefault(); });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const check = (value, message) => { if (!value) throw new Error(message); };
const data = () => fetch('/observations').then(r=>r.json());
widget.addEventListener('load', async () => {
  const result = { name: window.retryCase, passed: false, userAgent: navigator.userAgent };
  try {
    await widget.configure({ challenge:'/api/captcha/challenge?site_id=example', verifyUrl:'/probe/verify' });
    await widget.verify(); await wait(50);
    check(widget.getState() === 'code', 'Initial code state');
    const input = widget.querySelector('.altcha-code-challenge input'); check(input, 'Native code input visible');
    input.value = 'WRONG'; input.dispatchEvent(new Event('input', {bubbles:true})); input.form.requestSubmit();
    for (let i=0;i<100 && (window.retryCase==='false' ? widget.getState()!=='error' : rejections.length===0);i++) await wait(50);
    const after = widget.getState();
    const snapshot = await data();
    const pow = new FormData(document.querySelector('form')).get('altcha');
    check(window.retryCase === 'network' ? snapshot.submissions.length >= 1 : snapshot.submissions.length === 1, 'Native verification count');
    check(JSON.stringify(snapshot.submissions[0].keys) === '["code","payload"]', 'Native body code and original payload');
    check(snapshot.submissions[0].code === 'WRONG' && snapshot.submissions[0].payload === pow, 'Original PoW is retained');
    check(!widget.querySelector('.altcha-code-challenge input'), 'Code UI closes on submission');
    check(snapshot.issued === 1, 'No automatic new challenge or reset');
    check(!events.includes('verified') && !events.includes('serververification'), 'No success events');
    if (window.retryCase === 'false') {
      check(after === 'error' && rejections.length === 0, 'Soft failure enters error without rejection');
      widget.querySelector('input[type=checkbox]').click();
      for(let i=0;i<60 && widget.getState()!=='code';i++) await wait(50);
      check(widget.getState() === 'code' && (await data()).issued === 2, 'Native checkbox explicitly starts a fresh challenge/PoW');
      check(widget.querySelector('.altcha-code-challenge input').value === '', 'New Code component clears old input');
    } else {
      check(after === 'verifying' && rejections.length === 1, 'Thrown HTTP/network error leaves verifying with unhandled rejection');
      const checkbox = widget.querySelector('input[type=checkbox]'); checkbox.click(); await wait(100);
      check((await data()).issued === 1, 'Checkbox cannot retry while verifying');
    }
    check(fetch === originalFetch, 'No custom fetch');
    result.passed = true;
    result.observed = { after, states, events, unhandledRejections: rejections.length, samePowRetained: true, automaticChallengeFetch: false, transportRequests: snapshot.submissions.length };
  } catch(error) { result.error = error.message; }
  document.querySelector('output').textContent = `${result.passed?'PASS':'FAIL'} ${result.name}${result.error?': '+result.error:''}`;
  await fetch('/result',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(result)});
}, {once:true});
