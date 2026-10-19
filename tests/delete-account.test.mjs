// In-app account deletion suite for SickleStrong.
//
// Apple requires any app with sign-up to offer account deletion inside the
// app. The server half is the delete_my_account() RPC (see db/security-model.sql);
// this suite pins the client half:
//
//   - signed-out users are pointed at Clear All Data, not shown a password box
//   - the password is re-checked before anything is deleted
//   - SOLE_PARENT_OF_CHILDREN names the children (as text, never parsed HTML)
//     and nothing local is cleared
//   - on success, the app's local copy and session keys are wiped
//
// Run: node tests/delete-account.test.mjs

import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_URL = pathToFileURL(resolve(HERE, '..', 'index.html')).href;
const CHROMIUM = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';

const STUB = `window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:null}}),signUp:async()=>({data:null,error:{message:'stub'}}),signInWithPassword:async()=>({data:null,error:{message:'stub'}}),signOut:async()=>({error:null}),resetPasswordForEmail:async()=>({data:{},error:null}),updateUser:async()=>({data:{},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},from:()=>({select:()=>({eq:()=>({single:async()=>({data:null})})})}),rpc:async()=>({data:null,error:null})})};`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.route('**/*', (route) => {
  const u = route.request().url();
  if (u.startsWith('file://')) return route.continue();
  if (u.includes('@supabase')) return route.fulfill({ contentType: 'application/javascript', body: STUB });
  return route.abort();
});

await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof showDeleteAccount === 'function' && typeof sb !== 'undefined');

const out = await page.evaluate(async () => {
  const r = {};
  const tick = () => new Promise((res) => setTimeout(res, 30));
  const close = () => document.querySelectorAll('.modal').forEach((m) => m.remove());

  // ── 1. Settings links to the in-app flow, not an email ──
  showSettings();
  const link = [...document.querySelectorAll('.modal a')].find((a) => /Delete my account/.test(a.textContent));
  r.settingsLinkInApp = !!link && !/^mailto:/.test(link.getAttribute('href') || '');
  close();

  // ── 2. Signed out: no password box, points to Clear All Data ──
  await showDeleteAccount(); await tick();
  r.signedOutNoPassword = !document.getElementById('deleteAccountPassword');
  r.signedOutMentionsClear = /Clear All Data/.test(document.querySelector('.modal')?.textContent || '');
  close();

  // Signed in from here on.
  const calls = { rpc: 0, signIn: [] };
  sb.auth.getSession = async () => ({ data: { session: { user: { email: 'parent@example.com' } } } });
  sb.auth.signInWithPassword = async (c) => {
    calls.signIn.push(c);
    return c.password === 'right' ? { data: {}, error: null } : { data: null, error: { message: 'Invalid login credentials' } };
  };
  let rpcResult = { data: null, error: null };
  sb.rpc = async (name) => { calls.rpc++; r.rpcName = name; return rpcResult; };

  localStorage.setItem('sickleStrongData', '{"children":[]}');
  localStorage.setItem('ss_auth', '{}');
  localStorage.setItem('sb-zprm-auth-token', 'x');
  localStorage.setItem('unrelated_key', 'keep');

  const open = async () => { await showDeleteAccount(); await tick(); };
  const submit = async (pw) => {
    document.getElementById('deleteAccountPassword').value = pw;
    document.getElementById('deleteAccountBtn').click();
    await tick(); await tick();
    return document.getElementById('deleteAccountError');
  };

  // ── 3. Empty password: nothing sent ──
  await open();
  let err = await submit('');
  r.emptyBlocked = err.style.display === 'block' && calls.signIn.length === 0 && calls.rpc === 0;

  // ── 4. Wrong password: re-auth fails, RPC never called ──
  err = await submit('wrong');
  r.wrongPwBlocked = /didn't match/.test(err.textContent) && calls.rpc === 0;
  r.reauthUsesSessionEmail = calls.signIn[0]?.email === 'parent@example.com';

  // ── 5. Sole parent: names the children as plain text, keeps local data ──
  const hostile = 'Cam <img src=x onerror="window.__xss=1">, Jaxxon';
  rpcResult = { data: null, error: { message: 'SOLE_PARENT_OF_CHILDREN', details: hostile } };
  err = await submit('right');
  r.soleParentNamed = err.textContent.includes(hostile) && /only parent/.test(err.textContent);
  r.soleParentNoHtml = !err.querySelector('img') && !window.__xss;
  r.soleParentKeepsLocal = localStorage.getItem('sickleStrongData') !== null;
  r.btnReenabled = !document.getElementById('deleteAccountBtn').disabled;

  // ── 6. Generic failure: friendly message, local data kept ──
  rpcResult = { data: null, error: { message: 'boom' } };
  err = await submit('right');
  r.genericError = /couldn't delete/.test(err.textContent) && localStorage.getItem('sickleStrongData') !== null;

  // ── 7. Success: RPC named correctly, local copy + session keys wiped ──
  rpcResult = { data: null, error: null };
  await submit('right');
  r.rpcIsDeleteMyAccount = r.rpcName === 'delete_my_account';
  r.successScreen = /has been deleted/.test(document.querySelector('.modal')?.textContent || '');
  r.localCleared = localStorage.getItem('sickleStrongData') === null
    && localStorage.getItem('ss_auth') === null
    && localStorage.getItem('sb-zprm-auth-token') === null;
  r.unrelatedKept = localStorage.getItem('unrelated_key') === 'keep';
  return r;
});

check('Settings "Delete my account" opens the in-app flow (not mailto)', out.settingsLinkInApp);
check('Signed out: no password field shown', out.signedOutNoPassword);
check('Signed out: points to Clear All Data', out.signedOutMentionsClear);
check('Empty password: nothing sent to the server', out.emptyBlocked);
check('Wrong password: re-auth fails and delete is never called', out.wrongPwBlocked);
check('Re-auth uses the signed-in email', out.reauthUsesSessionEmail);
check('Sole parent: message names the children', out.soleParentNamed);
check('Sole parent: names rendered as text, not HTML', out.soleParentNoHtml);
check('Sole parent: local data untouched', out.soleParentKeepsLocal);
check('Sole parent: button re-enabled for retry', out.btnReenabled);
check('Other server error: friendly message, local data kept', out.genericError);
check('Calls the delete_my_account RPC', out.rpcIsDeleteMyAccount);
check('Success screen shown', out.successScreen);
check('Success: app data, ss_* and sb-* session keys cleared', out.localCleared);
check('Success: unrelated localStorage keys left alone', out.unrelatedKept);
check('No uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
