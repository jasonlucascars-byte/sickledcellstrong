// Teen access suite for SickleStrong.
//
// Teens 13–17 may join only through an invite. Only a parent of the child can
// create an invite (generate_child_invite checks it server-side), so a parent
// is always the one letting a teen in. Under 13 never gets an account.
//
// Run: node tests/teen-access.test.mjs

import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_URL = pathToFileURL(resolve(HERE, '..', 'index.html')).href;
const CHROMIUM = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
const STUB = `window.__signups=[];window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:null}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signUp:async(a)=>{window.__signups.push(a);return{data:{session:null,user:{id:'x'}},error:null}}},from:()=>({select:()=>({eq:()=>({single:async()=>({data:null})})})}),rpc:async()=>({data:null,error:null})})};`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage();
const pageErrors = [];
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

// Fills the invite sign-up and submits it with a given age choice.
const attempt = (age) => page.evaluate(async (age) => {
  document.querySelectorAll('.modal').forEach(m => m.remove());
  showInviteSignupModal('INV-TEST1234');
  const m = document.querySelector('.modal');
  m.querySelector('#inviteName').value = 'Maya';
  m.querySelector('#inviteEmail').value = 'maya@example.com';
  m.querySelector('#invitePassword').value = 'Sickle1Strong';
  if (age) m.querySelector(`input[name="inviteAge"][value="${age}"]`).checked = true;
  const before = window.__signups.length;
  m.querySelector('#inviteSignupSubmit').click();
  await new Promise(r => setTimeout(r, 80));
  const err = document.getElementById('inviteSignupError');
  return {
    error: err && err.style.display === 'block' ? err.textContent : '',
    signedUp: window.__signups.length > before,
    meta: window.__signups.at(-1)?.options?.data || null
  };
}, age);

const noAge = await attempt(null);
check('Invite sign-up asks for an age before creating an account', /choose your age/i.test(noAge.error) && !noAge.signedUp);

const child = await attempt('child');
check('Under 13: no account is created', !child.signedUp);
check('Under 13: told kindly that a parent can keep logging', /start at 13/i.test(child.error));

const teen = await attempt('teen');
check('13 to 17 through an invite: account is created', teen.signedUp && !teen.error, teen.error);
check('13 to 17: age band recorded on the account', teen.meta?.age_band === '13-17');
check('13 to 17: still joins through the invite code', teen.meta?.pending_invite_code === 'INV-TEST1234');

const adult = await attempt('adult');
check('18 or older: recorded as 18+', adult.signedUp && adult.meta?.age_band === '18+');

const notice = await page.evaluate(() => { showInviteSignupModal('INV-X'); const t = document.querySelector('.modal').innerText; document.querySelectorAll('.modal').forEach(m => m.remove()); return t; });
check('Invite notice says 13+ with a parent\'s invite, not 18+ only', /13 or older/.test(notice) && !/confirm you're 18 or older/.test(notice));

const familySignup = await page.evaluate(() => document.getElementById('authScreen').innerText);
check('Family sign-up says 13+ and that a parent approves 13 to 17',
  /13 or older/.test(familySignup) && /parent or guardian approves/i.test(familySignup));

const composer = await page.evaluate(() => {
  familyAuth.childCircles = [{ childId: 'c1', childName: 'Maya', isParent: true }];
  showInviteComposer('c1');
  const t = document.querySelector('.modal').innerText;
  document.querySelectorAll('.modal').forEach(m => m.remove());
  return t;
});
check('Parent invite screen explains how to invite a teen', /Inviting your teen/i.test(composer));

check('No uncaught page errors', pageErrors.length === 0, [...new Set(pageErrors)].join(' | '));
await browser.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
