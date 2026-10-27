// App lock (Face ID / fingerprint). Uses a CDP virtual platform authenticator.
// Run: node tests/app-lock.test.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(resolve(HERE, '..', 'index.html'));
const CHROMIUM = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
const STUB = `window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:{user:{id:'u1'}}}}),getUser:async()=>({data:{user:{id:'u1'}}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},from:()=>{const q={select:()=>q,eq:()=>q,in:()=>q,order:()=>q,single:async()=>({data:null}),then:(r)=>r({data:[],error:null}),insert:async()=>({error:null}),upsert:async()=>({error:null})};return q},rpc:async()=>({data:null,error:null})})};`;

// WebAuthn needs a real origin; localhost counts as secure.
const server = http.createServer((q, r) => { r.setHeader('content-type', 'text/html'); r.end(HTML); });
await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
const URL_ = `http://localhost:${server.address().port}/`;

const results = [];
const check = (n, ok, d = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };

const browser = await chromium.launch({ executablePath: CHROMIUM });
const ctx = await browser.newContext({ viewport: { width: 360, height: 760 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.route('**/*', (r) => {
  const u = r.request().url();
  if (u.startsWith(URL_)) return r.continue();
  if (u.includes('@supabase')) return r.fulfill({ contentType: 'application/javascript', body: STUB });
  return r.abort();
});
await page.addInitScript(() => {
  if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1');
  localStorage.setItem('ss_auth_dismissed', 'true'); localStorage.setItem('ss_install_dismissed', 'true');
  localStorage.setItem('sickleStrongData', JSON.stringify({ setupComplete: true, currentChildId: 'c1',
    children: [{ id: 'c1', name: 'Jaxxon', diseaseType: 'HbSS', painLog: [], temperatureLog: [], symptoms: [], notes: [], weightHistory: [], medications: [] }], contacts: [] }));
});
const cdp = await ctx.newCDPSession(page);
await cdp.send('WebAuthn.enable');
const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
  protocol: 'ctap2', transport: 'internal', hasResidentKey: false, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

await page.goto(URL_, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof enableAppLock === 'function');
await page.waitForTimeout(500);

check('Not locked before the lock is turned on', await page.evaluate(() => !document.getElementById('ssLock')));
check('Phone reports Face ID / fingerprint available', await page.evaluate(() => lockAvailable()));

// Autofill hints
const hints = await page.evaluate(() => ['loginEmail:username', 'loginPassword:current-password', 'signupEmail:username', 'signupPassword:new-password']
  .every((p) => { const [id, v] = p.split(':'); return document.getElementById(id)?.getAttribute('autocomplete') === v; }));
check('Sign-in and sign-up fields tell the phone to offer saved passwords', hints);

// Settings row
await page.evaluate(() => showSettings());
await page.waitForSelector('#lockOnBtn', { timeout: 3000 }).catch(() => {});
check('Settings offers "Turn on app lock"', await page.evaluate(() => !!document.getElementById('lockOnBtn')));
await page.evaluate(() => document.getElementById('lockOnBtn').click());
await page.waitForFunction(() => !!localStorage.getItem('ss_lock'), null, { timeout: 5000 }).catch(() => {});
check('Turning it on stores a credential id (no secret)', await page.evaluate(() => { const v = JSON.parse(localStorage.getItem('ss_lock') || 'null'); return !!(v && v.id); }));
await page.evaluate(() => document.querySelectorAll('.modal').forEach((m) => m.remove()));

// Reload -> locked, auto-unlock works with verified authenticator
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof showLockScreen === 'function');
await page.waitForTimeout(1200);
check('A verified fingerprint opens the app on its own', await page.evaluate(() => !document.getElementById('ssLock')));

// Failed verification keeps it locked
await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1200);
const locked = await page.evaluate(() => ({
  on: !!document.getElementById('ssLock'),
  text: document.getElementById('ssLock')?.innerText || '',
  inert: [...document.body.children].filter((e) => e.id !== 'ssLock' && e.inert).length > 0,
  call: document.getElementById('ssLockCall')?.getAttribute('href'),
}));
check('Failed fingerprint leaves the lock screen up', locked.on, locked.text.replace(/\n/g, ' | '));
check('Content behind the lock is inert', locked.inert);
check('Call 911 works from the lock screen', locked.call === 'tel:911');

// Tap Unlock after the fingerprint works again
await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });
await page.click('#ssLockOpen');
await page.waitForTimeout(800);
check('Unlock button opens it once verification succeeds', await page.evaluate(() => !document.getElementById('ssLock') && ![...document.body.children].some((e) => e.inert)));

// Re-lock after time in the background
await page.evaluate(() => { _lockHiddenAt = Date.now() - 120000; Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
await page.waitForTimeout(300);
check('Coming back after 2 minutes locks it again', await page.evaluate(() => !!document.getElementById('ssLock')));
await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });
await page.click('#ssLockOpen'); await page.waitForTimeout(600);
await page.evaluate(() => { _lockHiddenAt = Date.now() - 5000; document.dispatchEvent(new Event('visibilitychange')); });
check('A quick glance away (5 s) does not lock it', await page.evaluate(() => !document.getElementById('ssLock')));

// Sign-out escape hatch reachable and removes the lock
await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: false });
await page.evaluate(() => { hideLockScreen(); showLockScreen(); });
await page.waitForTimeout(500);
await page.click('#ssLockSignOut');
await page.waitForTimeout(300);
const so = await page.evaluate(() => { const m = document.querySelector('.modal.over-lock'); return { has: !!m, z: m ? getComputedStyle(m).zIndex : '', btn: !!document.getElementById('signOutConfirmBtn') }; });
check("\"Can't unlock? Sign out\" opens the sign-out card above the lock", so.has && so.btn && Number(so.z) > 6000, JSON.stringify(so));
await page.evaluate(() => document.getElementById('signOutConfirmBtn').click());
await page.waitForTimeout(1500).catch(() => {});
const gone = await page.evaluate(() => localStorage.getItem('ss_lock')).catch(() => 'navigated');
check('Signing out removes the lock', gone === null || gone === 'navigated', String(gone));

// Turn off from Settings
await cdp.send('WebAuthn.setUserVerified', { authenticatorId, isUserVerified: true });
await page.goto(URL_, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof enableAppLock === 'function');
await page.evaluate(() => { localStorage.setItem('ss_lock', JSON.stringify({ id: 'AAAA' })); });
check('A lock record whose credential is gone fails closed (not silently open)', await page.evaluate(async () => { try { return await _verifyLock(); } catch (e) { return false; } }) === false);
check('No uncaught page errors', errors.length === 0, errors.join(' | '));

await browser.close(); server.close();
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
