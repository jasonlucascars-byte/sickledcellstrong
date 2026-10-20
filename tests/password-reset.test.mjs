// Password-reset suite for SickleStrong.
//
// Pins two fixes from Kim's sign-in on 2026-10-19:
//   1. A rejected new password (breached, too weak, same as before) is
//      explained, and they can try again right there — the reset session is
//      still good — instead of being told the link expired.
//   2. An invite opened before "I already have an account" survives the reset
//      email (which lands on the bare app URL in a fresh tab) and is redeemed
//      once they're signed in.
//
// Run: node tests/password-reset.test.mjs

import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_URL = pathToFileURL(resolve(HERE, '..', 'index.html')).href;
const CHROMIUM = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';

// updateUser answers come from sessionStorage '__pw' (a JSON list consumed in order).
const STUB = `
window.__calls = [];
const signedIn = () => sessionStorage.getItem('__signedIn') === '1';
const user = () => ({ id: 'k1', email: 'kim@example.com', user_metadata: {} });
window.supabase = { createClient: () => ({
  auth: {
    getSession: async () => ({ data: { session: signedIn() ? { user: user() } : null } }),
    getUser: async () => ({ data: { user: signedIn() ? user() : null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    updateUser: async (a) => { window.__calls.push(['updateUser', a]);
      const q = JSON.parse(sessionStorage.getItem('__pw') || '[]'); const r = q.shift() || null;
      sessionStorage.setItem('__pw', JSON.stringify(q)); return { data: {}, error: r }; },
    signInWithPassword: async () => ({ data: null, error: { message: 'stub' } }),
    signUp: async () => ({ data: null, error: { code: 'weak_password', message: 'Password is known to be weak and easy to guess, please choose a different one.', reasons: ['pwned'] } })
  },
  from: () => { const b = { select() { return b; }, eq() { return b; }, in() { return b; }, order() { return b; }, limit() { return b; },
    maybeSingle: async () => ({ data: null }), single: async () => ({ data: null }), then(r) { return Promise.resolve({ data: [], error: null }).then(r); } }; return b; },
  rpc: async (name, args) => { window.__calls.push(['rpc:' + name, args]);
    if (name === 'redeem_child_invite') return { data: [{ out_child_name: 'Jaxxon', out_circle_role: 'parent', out_permission: 'full', out_family_code: 'X' }], error: null };
    return { data: [], error: null }; }
}) };`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROMIUM });
const pageErrors = [];

// Opens the app as if from a reset email. `answers` = what the person types
// into each prompt; `pw` = how the server answers each updateUser.
async function resetFlow({ answers, pw, pendingInvite = null }) {
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const shown = []; let i = 0;
  page.on('dialog', async (d) => {
    shown.push({ type: d.type(), msg: d.message() });
    if (d.type() === 'prompt') { const a = answers[i++]; a == null ? await d.dismiss() : await d.accept(a); }
    else await d.accept();
  });
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith('file://')) return r.continue();
    if (u.includes('@supabase')) return r.fulfill({ contentType: 'application/javascript', body: STUB });
    return r.abort();
  });
  await page.addInitScript(({ pw, pendingInvite }) => {
    if (sessionStorage.getItem('__seeded')) return;
    sessionStorage.setItem('__seeded', '1');
    sessionStorage.setItem('__signedIn', '1');
    sessionStorage.setItem('__pw', JSON.stringify(pw));
    localStorage.setItem('ss_auth_dismissed', 'true');
    if (pendingInvite) localStorage.setItem('ss_pending_invite', JSON.stringify(pendingInvite));
  }, { pw, pendingInvite });
  await page.goto(INDEX_URL + '#access_token=x&type=recovery', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1200);
  const calls = await page.evaluate(() => window.__calls);
  const stored = await page.evaluate(() => localStorage.getItem('ss_pending_invite'));
  return { page, shown, calls, stored };
}

const PWNED = { code: 'weak_password', message: 'Password is known to be weak and easy to guess, please choose a different one.', reasons: ['pwned'] };
const SAME = { code: 'same_password', message: 'New password should be different from the old password.' };

// ── 1. Breached, then same-as-old, then accepted — all on one link ──
{
  const r = await resetFlow({ answers: ['Password1', 'OldPass1x', 'Sickle1Strong!'], pw: [PWNED, SAME, null] });
  const prompts = r.shown.filter(d => d.type === 'prompt').map(d => d.msg);
  const alerts = r.shown.filter(d => d.type === 'alert').map(d => d.msg);
  check('Rejected password: asked again on the same link (3 tries, 1 email)', prompts.length === 3 && r.calls.filter(c => c[0] === 'updateUser').length === 3);
  check('Breached password: says so plainly', /data breach/.test(prompts[1] || ''));
  check('Same password: says so plainly', /already have/.test(prompts[2] || ''));
  check('Never blames an expired link for a password rule', !alerts.concat(prompts).some(m => /expire/i.test(m)));
  check('Success message after the third try', /password is updated/i.test(alerts.at(-1) || ''));
  await r.page.context().close();
}

// ── 2. Too short is caught before asking the server ──
{
  const r = await resetFlow({ answers: ['abc', 'Sickle1Strong!'], pw: [null] });
  const prompts = r.shown.filter(d => d.type === 'prompt').map(d => d.msg);
  check('Too-short password: reason shown, server not asked for it', prompts.length === 2 && r.calls.filter(c => c[0] === 'updateUser').length === 1);
  await r.page.context().close();
}

// ── 3. Gives up gracefully after three refusals ──
{
  const r = await resetFlow({ answers: ['Password1', 'Password1', 'Password1'], pw: [PWNED, PWNED, PWNED] });
  const last = r.shown.filter(d => d.type === 'alert').at(-1)?.msg || '';
  check('After three refusals: explains and points to a fresh link', /data breach/.test(last) && /Forgot your password/.test(last));
  await r.page.context().close();
}

// ── 4. Invite survives the reset and is redeemed once signed in ──
{
  const r = await resetFlow({ answers: ['Sickle1Strong!'], pw: [null], pendingInvite: { code: 'INV-1A7E0B57', at: Date.now() } });
  const redeem = r.calls.find(c => c[0] === 'rpc:redeem_child_invite');
  check('After the reset, the saved invite is redeemed automatically', redeem?.[1]?.p_code === 'INV-1A7E0B57');
  check('And then cleared, so it is not redeemed twice', r.stored === null);
  await r.page.context().close();
}

// ── 5. An old saved invite (over 14 days) is ignored ──
{
  const r = await resetFlow({ answers: ['Sickle1Strong!'], pw: [null], pendingInvite: { code: 'INV-1A7E0B57', at: Date.now() - 15 * 86400000 } });
  check('A saved invite older than 14 days is dropped, not redeemed', !r.calls.some(c => c[0] === 'rpc:redeem_child_invite') && r.stored === null);
  await r.page.context().close();
}

// ── 6. "I already have an account" saves the invite; sign-up explains breaches ──
{
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith('file://')) return r.continue();
    if (u.includes('@supabase')) return r.fulfill({ contentType: 'application/javascript', body: STUB });
    return r.abort();
  });
  await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof showInviteSignupModal === 'function');
  const out = await page.evaluate(async () => {
    showInviteSignupModal('INV-ABCD1234');
    document.querySelector('#inviteSignIn').click();
    const saved = JSON.parse(localStorage.getItem('ss_pending_invite') || 'null')?.code;
    showInviteSignupModal('INV-ABCD1234');
    const m = document.querySelector('.modal');
    m.querySelector('#inviteName').value = 'Kim';
    m.querySelector('#inviteEmail').value = 'kim@example.com';
    m.querySelector('#invitePassword').value = 'Password1';
    m.querySelector('input[name="inviteAge"][value="adult"]').checked = true;
    m.querySelector('#inviteSignupSubmit').click();
    await new Promise(r => setTimeout(r, 80));
    return { saved, err: m.querySelector('#inviteSignupError').textContent };
  });
  check('"I already have an account" keeps the invite through a reset', out.saved === 'INV-ABCD1234');
  check('Invite sign-up explains a breached password in plain words', /data breach/.test(out.err), out.err);
  await page.context().close();
}

check('No uncaught page errors', pageErrors.length === 0, [...new Set(pageErrors)].join(' | '));
await browser.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
