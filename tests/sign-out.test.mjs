// Sign-out suite for SickleStrong.
//
// Signing out clears the phone (a shared or borrowed phone must not keep a
// child's health records for the next person). The risk that creates is an
// entry that never reached the cloud, so this suite pins the guards:
//
//   - the Account row (and Sign out) appears in Settings only when signed in
//   - offline: sign-out refuses and nothing is cleared
//   - a failed cloud write is remembered (ss_unsynced) and sign-out warns,
//     offering an export, before erasing anything
//   - on sign-out, app data and session keys are cleared and the welcome
//     screen offers "I already have an account"
//
// Run: node tests/sign-out.test.mjs

import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_URL = pathToFileURL(resolve(HERE, '..', 'index.html')).href;
const CHROMIUM = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';

const STUB = `window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:null}}),signUp:async()=>({data:null,error:{message:'stub'}}),signInWithPassword:async()=>({data:null,error:{message:'stub'}}),signOut:async()=>{window.__signedOut=true;return{error:null}},resetPasswordForEmail:async()=>({data:{},error:null}),updateUser:async()=>({data:{},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},from:()=>({select:()=>({eq:()=>({single:async()=>({data:null})})})}),rpc:async()=>({data:null,error:null})})};`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROMIUM });
const context = await browser.newContext();
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.route('**/*', (route) => {
  const u = route.request().url();
  if (u.startsWith('file://')) return route.continue();
  if (u.includes('@supabase')) return route.fulfill({ contentType: 'application/javascript', body: STUB });
  return route.abort();
});

await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof showSignOut === 'function' && typeof sb !== 'undefined');

const tick = () => page.waitForTimeout(60);
// The fresh page shows the setup wizard on top, so click via the DOM rather
// than by pointer; what's under test is the handlers, not the overlay order.
const press = (id) => page.evaluate((i) => document.getElementById(i).click(), id);

// ── 1. Signed out: Settings has no Account row ──
await page.evaluate(() => showSettings());
await tick();
check('Signed out: no Sign out button in Settings', await page.evaluate(() => !document.getElementById('signOutBtn')));
await page.evaluate(() => document.querySelectorAll('.modal').forEach((m) => m.remove()));

// Signed in from here on, with a family saved on the phone.
await page.evaluate(() => {
  sb.auth.getSession = async () => ({ data: { session: { user: { email: 'parent+<b>x</b>@example.com' } } } });
  localStorage.setItem('sickleStrongData', JSON.stringify({ ...appData, setupComplete: true }));
  localStorage.setItem('ss_auth', '{}');
  localStorage.setItem('sb-zprm-auth-token', 'x');
  localStorage.setItem('unrelated_key', 'keep');
});

// ── 2. Signed in: Account row shows the email as text, with Sign out ──
await page.evaluate(() => showSettings());
await tick();
const row = await page.evaluate(() => {
  const r = document.getElementById('settingsAccountRow');
  return { hasBtn: !!document.getElementById('signOutBtn'), text: r?.textContent || '', bold: !!r?.querySelector('b') };
});
check('Signed in: Sign out button shown in Settings', row.hasBtn);
check('Signed in: email shown as plain text', row.text.includes('parent+<b>x</b>@example.com') && !row.bold);

// ── 3. Offline: refuses, nothing cleared ──
await press('signOutBtn');
await tick();
await context.setOffline(true);
await press('signOutConfirmBtn');
await tick();
const offline = await page.evaluate(() => ({
  warned: /offline/i.test(document.getElementById('signOutWarning')?.textContent || ''),
  kept: localStorage.getItem('sickleStrongData') !== null,
  signedOut: !!window.__signedOut
}));
check('Offline: sign-out refused with a message', offline.warned);
check('Offline: local data untouched and session kept', offline.kept && !offline.signedOut);
await context.setOffline(false);
await page.evaluate(() => document.querySelectorAll('.modal').forEach((m) => m.remove()));

// ── 4. A failed cloud write is remembered ──
await page.evaluate(async () => {
  localStorage.removeItem('ss_unsynced');
  cloudSync(async () => ({ error: { message: 'network down' } }));
  await new Promise((r) => setTimeout(r, 50));
});
check('Failed cloud write marks the phone as having unsynced entries',
  await page.evaluate(() => localStorage.getItem('ss_unsynced') === '1'));

// ── 5. With unsynced entries: warns and offers export before erasing ──
await page.evaluate(() => showSignOut());
await tick();
const warnState = await page.evaluate(() => ({
  warned: /may not have reached/.test(document.getElementById('signOutWarning')?.textContent || ''),
  exportShown: document.getElementById('signOutExportBtn')?.style.display === 'block',
  btnText: document.getElementById('signOutConfirmBtn')?.textContent || ''
}));
check('Unsynced: warning shown before signing out', warnState.warned);
check('Unsynced: "Export a copy first" offered', warnState.exportShown);
check('Unsynced: button reads "Sign out anyway"', /anyway/.test(warnState.btnText));

// ── 6. Sign out anyway: clears the phone and reloads to the welcome screen ──
await Promise.all([
  page.waitForEvent('load'),
  press('signOutConfirmBtn')
]);
await page.waitForFunction(() => typeof showSignOut === 'function');
await tick();
const after = await page.evaluate(() => ({
  data: localStorage.getItem('sickleStrongData'),
  auth: localStorage.getItem('ss_auth'),
  sbKey: localStorage.getItem('sb-zprm-auth-token'),
  unsynced: localStorage.getItem('ss_unsynced'),
  unrelated: localStorage.getItem('unrelated_key'),
  wizard: document.getElementById('setupWizard')?.classList.contains('active'),
  signInOffered: [...document.querySelectorAll('#wizardContent button')].some((b) => /already have an account/i.test(b.textContent))
}));
check('After sign-out: family data cleared from the phone', after.data === null);
check('After sign-out: ss_auth, ss_unsynced and sb-* session keys cleared',
  after.auth === null && after.sbKey === null && after.unsynced === null);
check('After sign-out: unrelated keys left alone', after.unrelated === 'keep');
check('After sign-out: welcome screen offers "I already have an account"', after.wizard && after.signInOffered);

// ── 7. That button opens the sign-in tab ──
await page.evaluate(() => [...document.querySelectorAll('#wizardContent button')]
  .find((b) => /already have an account/i.test(b.textContent)).click());
await tick();
check('"I already have an account" opens Sign In',
  await page.evaluate(() => document.getElementById('authScreen').classList.contains('active')
    && document.getElementById('loginTab').classList.contains('active')));

check('No uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
