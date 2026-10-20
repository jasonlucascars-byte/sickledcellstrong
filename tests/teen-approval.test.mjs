// Teen self sign-up + parent approval suite for SickleStrong.
//
// A 13–17-year-old may sign up on their own; the account opens nothing until
// a parent, signed in with the email the teen named, approves it and picks the
// teen's profile. The database enforces it (approve_teen_request,
// children_block_teen_insert); this suite pins the app's half.
//
// Run: node tests/teen-approval.test.mjs

import { chromium } from 'playwright';
import { CAPTURE_NOTICES } from './notices-capture.mjs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_URL = pathToFileURL(resolve(HERE, '..', 'index.html')).href;
const CHROMIUM = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';

// Stub with knobs on window.__s: who is signed in, what child_access returns,
// and how each RPC answers. Calls are recorded in window.__calls.
const STUB = `
window.__calls = []; window.__s = { user: null, access: [], rpc: {} };
const rec = (k, a) => { window.__calls.push([k, a]); };
window.supabase = { createClient: () => ({
  auth: {
    getSession: async () => ({ data: { session: window.__s.user ? { user: window.__s.user } : null } }),
    getUser: async () => ({ data: { user: window.__s.user } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signUp: async (a) => { rec('signUp', a); return { data: { session: null, user: { id: 'u' } }, error: null }; },
    signInWithPassword: async () => ({ data: null, error: { message: 'stub' } }),
    signOut: async () => { rec('signOut'); return { error: null }; }
  },
  from: (t) => { const b = { select() { return b; }, eq() { return b; }, in() { return b; }, order() { return b; },
    limit() { return b; }, maybeSingle: async () => ({ data: null }), single: async () => ({ data: null }),
    then(res) { return Promise.resolve({ data: t === 'child_access' ? window.__s.access : [], error: null }).then(res); } }; return b; },
  rpc: async (name, args) => { rec('rpc:' + name, args); const f = window.__s.rpc[name]; return f ? f(args) : { data: [], error: null }; }
}) };`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROMIUM });
const pageErrors = [];

async function open(query = '') {
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.accept(); });
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith('file://')) return r.continue();
    if (u.includes('@supabase')) return r.fulfill({ contentType: 'application/javascript', body: STUB });
    return r.abort();
  });
  await page.addInitScript(CAPTURE_NOTICES);
  await page.goto(INDEX_URL + query, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof showTeenApproval === 'function');
  await page.waitForTimeout(300);
  return { page, dialogs };
}

// ── Sign-up form ──
{
  const { page, dialogs } = await open();
  const signup = async (age, parentEmail = '') => page.evaluate(async ({ age, parentEmail }) => {
    document.getElementById('signupName').value = 'Maya';
    document.getElementById('signupEmail').value = 'maya@example.com';
    document.getElementById('signupPassword').value = 'Sickle1Strong';
    document.querySelectorAll('input[name="signupAge"]').forEach(r => { r.checked = r.value === age; });
    onSignupAgeChange();
    document.getElementById('signupParentEmail').value = parentEmail;
    const n = window.__calls.filter(c => c[0] === 'signUp').length;
    await handleSignup();
    const ups = window.__calls.filter(c => c[0] === 'signUp');
    return { made: ups.length > n, meta: ups.at(-1)?.[1]?.options?.data || null,
             parentShown: document.getElementById('signupParentEmailGroup').style.display !== 'none' };
  }, { age, parentEmail });

  const kid = await signup('child');
  check('Sign-up: under 13 is refused', !kid.made && /start at 13/.test((await page.evaluate(() => window.__notices)).at(-1) || ''));
  const noParent = await signup('teen', '');
  check('Sign-up: 13 to 17 asks for a parent email', noParent.parentShown && !noParent.made);
  const own = await signup('teen', 'MAYA@example.com');
  check("Sign-up: the parent email can't be the teen's own", !own.made);
  const teen = await signup('teen', 'mom@example.com');
  check('Sign-up: 13 to 17 account is created as a teen',
    teen.made && teen.meta?.age_band === '13-17' && teen.meta?.parent_email === 'mom@example.com' && teen.meta?.role === 'teen');
  const adult = await signup('adult');
  check('Sign-up: 18+ is recorded as 18+', adult.made && adult.meta?.age_band === '18+');
  await page.context().close();
}

// ── Teen waiting screen ──
{
  const { page } = await open();
  const r = await page.evaluate(async () => {
    window.__s.user = { id: 't1', email: 'maya@example.com', user_metadata: { age_band: '13-17', full_name: 'Maya <b>x</b>', parent_email: 'mom@example.com' } };
    const needs = await teenNeedsApproval(window.__s.user);
    window.__s.access = [{ id: 'a1' }];
    const approved = await teenNeedsApproval(window.__s.user);
    const adult = await teenNeedsApproval({ id: 'p', user_metadata: { age_band: '18+' } });
    window.__s.access = [];
    showTeenWaiting(window.__s.user);
    const screen = document.getElementById('teenWaiting');
    window.__s.rpc.create_teen_request = () => ({ data: [{ out_code: 'TEEN-ABCDEF12', out_parent_email: 'mom@example.com' }], error: null });
    // Keep the test page in place: no share sheet, and capture the mailto.
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    screen.querySelector('#teenSendLink').click();
    await new Promise(r => setTimeout(r, 80));
    return {
      needs, approved, adult,
      covers: getComputedStyle(screen).position === 'fixed' && Number(getComputedStyle(screen).zIndex) >= 5000,
      titleSafe: !screen.querySelector('#teenWaitTitle b') && /Maya <b>x<\/b>/.test(screen.querySelector('#teenWaitTitle').textContent),
      prefilled: screen.querySelector('#teenParentEmail').value === 'mom@example.com',
      rpcArgs: window.__calls.filter(c => c[0] === 'rpc:create_teen_request').at(-1)?.[1],
      link: screen.querySelector('#teenLinkBox').textContent
    };
  });
  check('Teen with no access needs approval; with access or adult does not', r.needs && !r.approved && !r.adult);
  check('Waiting screen covers the app', r.covers);
  check('Waiting screen shows the name as text, not HTML', r.titleSafe);
  check("Waiting screen pre-fills the parent's email", r.prefilled);
  check('Send link asks the server with that email', r.rpcArgs?.p_parent_email === 'mom@example.com');
  check('The link is an approve link with the code', /\?approve=TEEN-ABCDEF12/.test(r.link));
  await page.context().close();
}

// ── Parent opens the link ──
{
  const { page } = await open('?approve=teen-abcdef12');
  const stored = await page.evaluate(() => ({ pending: localStorage.getItem('ss_pending_approve'), url: location.search }));
  check('Approve link is saved (survives email confirmation) and stripped from the address', stored.pending === 'TEEN-ABCDEF12' && !/approve/.test(stored.url));
  check('Signed out: approve link opens Sign In', await page.evaluate(() => document.getElementById('authScreen').classList.contains('active')));

  const mismatch = await page.evaluate(async () => {
    window.__s.user = { id: 'p2', email: 'dad@example.com', user_metadata: {} };
    window.__s.rpc.lookup_teen_request = () => ({ data: [{ out_teen_name: 'Maya', out_status: 'pending', out_expired: false, out_email_matches: false, out_parent_email_hint: 'm•••@example.com' }], error: null });
    await showTeenApproval('TEEN-ABCDEF12');
    const t = document.querySelector('.modal').innerText;
    document.querySelectorAll('.modal').forEach(m => m.remove());
    return t;
  });
  check('Wrong account: told which email to sign in with, no approve button', /m•••@example\.com/.test(mismatch) && !/^Approve$/m.test(mismatch));

  const noKids = await page.evaluate(async () => {
    window.__s.rpc.lookup_teen_request = () => ({ data: [{ out_teen_name: 'Maya', out_status: 'pending', out_expired: false, out_email_matches: true }], error: null });
    familyAuth.childCircles = [];
    await showTeenApproval('TEEN-ABCDEF12');
    const t = document.querySelector('.modal').innerText;
    document.querySelectorAll('.modal').forEach(m => m.remove());
    return { t, kept: localStorage.getItem('ss_pending_approve') };
  });
  check('Parent with no profiles yet: asked to add one, link kept', /First add Maya/.test(noKids.t) && noKids.kept === 'TEEN-ABCDEF12');

  const approve = await page.evaluate(async () => {
    window.__s.rpc.lookup_teen_request = () => ({ data: [{ out_teen_name: 'Maya <img src=x onerror="window.__x=1">', out_status: 'pending', out_expired: false, out_email_matches: true }], error: null });
    window.__s.rpc.approve_teen_request = () => ({ data: [{ out_child_name: 'Maya', out_teen_name: 'Maya' }], error: null });
    familyAuth.childCircles = [{ childId: 'c1', childName: 'Maya', isParent: true }, { childId: 'c2', childName: 'Sibling', isParent: false }];
    await showTeenApproval('TEEN-ABCDEF12');
    const modal = document.querySelector('.modal');
    const options = [...modal.querySelectorAll('input[name="approveChild"]')].map(i => i.value);
    const defaultPerm = modal.querySelector('input[name="approvePerm"]:checked')?.value;
    const safe = !modal.querySelector('img') && !window.__x;
    modal.querySelector('#approveConfirm').click();
    await new Promise(r => setTimeout(r, 80));
    return { options, defaultPerm, safe, args: window.__calls.filter(c => c[0] === 'rpc:approve_teen_request').at(-1)?.[1],
             cleared: localStorage.getItem('ss_pending_approve') === null, closed: !document.querySelector('.modal') };
  });
  check('Only profiles you parent are offered', JSON.stringify(approve.options) === '["c1"]');
  check('Default access is "Can Report Pain & Fever"', approve.defaultPerm === 'report');
  check("Teen's name renders as text, never HTML", approve.safe);
  check('Approve sends the code, chosen child and access', approve.args?.p_code === 'TEEN-ABCDEF12' && approve.args?.p_child_id === 'c1' && approve.args?.p_permission === 'report');
  check('After approving, the saved link is cleared', approve.cleared && approve.closed);

  const used = await page.evaluate(async () => {
    savePendingApproval('TEEN-ABCDEF12');
    window.__s.rpc.lookup_teen_request = () => ({ data: [{ out_teen_name: 'Maya', out_status: 'approved', out_expired: false, out_email_matches: true }], error: null });
    await showTeenApproval('TEEN-ABCDEF12');
    return { modal: !!document.querySelector('.modal'), cleared: localStorage.getItem('ss_pending_approve') === null };
  });
  check('An already-approved link just says so', !used.modal && used.cleared);
  await page.context().close();
}

check('No uncaught page errors', pageErrors.length === 0, [...new Set(pageErrors)].join(' | '));
await browser.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
