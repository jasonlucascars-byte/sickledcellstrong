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
import { CAPTURE_NOTICES } from './notices-capture.mjs';
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

// Opens the app as if from a reset email and types each of `answers` into the
// in-app "Choose a new password" form (null = tap "Not now"). `pw` = how the
// server answers each updateUser. `forms` records what the form said before
// each try (its error line); `notices` are the toasts/cards shown after.
async function resetFlow({ answers, pw, pendingInvite = null }) {
  const page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const dialogs = [];
  page.on('dialog', async (d) => { dialogs.push(d.type()); await d.dismiss(); });
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith('file://')) return r.continue();
    if (u.includes('@supabase')) return r.fulfill({ contentType: 'application/javascript', body: STUB });
    return r.abort();
  });
  await page.addInitScript(CAPTURE_NOTICES);
  await page.addInitScript(({ pw, pendingInvite }) => {
    if (sessionStorage.getItem('__seeded')) return;
    sessionStorage.setItem('__seeded', '1');
    sessionStorage.setItem('__signedIn', '1');
    sessionStorage.setItem('__pw', JSON.stringify(pw));
    localStorage.setItem('ss_auth_dismissed', 'true');
    if (pendingInvite) localStorage.setItem('ss_pending_invite', JSON.stringify(pendingInvite));
  }, { pw, pendingInvite });
  await page.goto(INDEX_URL + '#access_token=x&type=recovery', { waitUntil: 'domcontentloaded' });
  const forms = [];
  for (const a of answers) {
    const open = await page.waitForSelector('#ssPwReset', { timeout: 3000 }).then(() => true, () => false);
    if (!open) break;
    forms.push(await page.evaluate(() => {
      const e = document.getElementById('ssPwError');
      return { error: e && e.style.display === 'block' ? e.textContent : '', type: document.getElementById('ssPwInput').type };
    }));
    if (a == null) { await page.click('#ssPwCancel'); continue; }
    await page.fill('#ssPwInput', a);
    await page.click('#ssPwSave');
    await page.waitForTimeout(150);
  }
  await page.waitForTimeout(800);
  const after = await page.evaluate(() => ({
    open: !!document.getElementById('ssPwReset'),
    error: document.getElementById('ssPwError')?.textContent || '',
    calls: window.__calls, stored: localStorage.getItem('ss_pending_invite'), notices: window.__notices,
  }));
  return { page, forms, dialogs, ...after };
}

const PWNED = { code: 'weak_password', message: 'Password is known to be weak and easy to guess, please choose a different one.', reasons: ['pwned'] };
const SAME = { code: 'same_password', message: 'New password should be different from the old password.' };

// ── 1. Breached, then same-as-old, then accepted — all on one link ──
{
  const r = await resetFlow({ answers: ['Password1', 'OldPass1x', 'Sickle1Strong!'], pw: [PWNED, SAME, null] });
  check('Asks in an app form, not a browser pop-up', r.forms.length === 3 && r.dialogs.length === 0, JSON.stringify(r.dialogs));
  check('The password is hidden while typing', r.forms.every(f => f.type === 'password'));
  check('Rejected password: asked again on the same link (3 tries, 1 email)', r.calls.filter(c => c[0] === 'updateUser').length === 3);
  check('Breached password: says so plainly', /data breach/.test(r.forms[1]?.error || ''));
  check('Same password: says so plainly', /already have/.test(r.forms[2]?.error || ''));
  check('Never blames an expired link for a password rule', !r.forms.map(f => f.error).concat(r.notices).some(m => /expire/i.test(m)));
  check('Success message after the third try, and the form closes', /password is updated/i.test(r.notices.at(-1) || '') && !r.open);
  await r.page.context().close();
}

// ── 2. Too short is caught before asking the server ──
{
  const r = await resetFlow({ answers: ['abc', 'Sickle1Strong!'], pw: [null] });
  check('Too-short password: reason shown, server not asked for it', /at least 8/.test(r.forms[1]?.error || '') && r.calls.filter(c => c[0] === 'updateUser').length === 1);
  await r.page.context().close();
}

// ── 3. Keeps trying on the same link; "Not now" leaves the password alone ──
{
  const r = await resetFlow({ answers: ['Password1', 'Password1', 'Password1', 'Password1', null], pw: [PWNED, PWNED, PWNED, PWNED] });
  check('Four refusals: still offered another try (no fresh email needed)', r.forms.length === 5 && /data breach/.test(r.forms[4]?.error || ''));
  check('"Not now" closes it and says the password is unchanged', !r.open && /hasn't changed/.test(r.notices.at(-1) || ''));
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
