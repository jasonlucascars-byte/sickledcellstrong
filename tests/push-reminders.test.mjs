// Medication reminders with the app closed (Web Push) for SickleStrong.
//
// Server side (supabase/functions/med-reminders), run directly in Node:
//   - webpush.ts encrypts per RFC 8291 — checked by decrypting here with an
//     independent node:crypto implementation (and with the `http_ece`
//     library too, when it happens to be installed).
//   - The VAPID token verifies against the public key and names the right
//     push service.
//   - schedule.ts sends each dose once, 15 minutes ahead, in the phone's own
//     time zone, only to people with access to that child, and keeps
//     medicine names off the lock screen unless the family turns them on.
// App side (index.html in Chromium):
//   - The reminders card explains each situation honestly (signed out,
//     iPhone not on the Home Screen, blocked, on).
//   - Enabling saves the subscription with the phone's time zone; turning
//     off and signing out remove it, so the next person signed in on this
//     phone never sees the last account's children on the lock screen.
//
// Run: node tests/push-reminders.test.mjs

import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import crypto from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const FN = resolve(HERE, '..', 'supabase', 'functions', 'med-reminders');
const INDEX_URL = pathToFileURL(resolve(HERE, '..', 'index.html')).href;
const CHROMIUM = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
const { encryptPayload, vapidAuthorization, sendPush, b64urlToBytes, bytesToB64url } = await import(pathToFileURL(resolve(FN, 'webpush.ts')).href);
const { dueReminders, sentKey, formatTime } = await import(pathToFileURL(resolve(FN, 'schedule.ts')).href);

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// ── 1. Encryption: what a phone would do to read it ─────────────────────
const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
const authSecret = crypto.randomBytes(16);
const sub = { endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: bytesToB64url(ua.getPublicKey()), auth: bytesToB64url(authSecret) };
const message = { title: "💊 Jaxxon's medicine in 15 minutes", body: '1 medicine due at 8:00 AM.' };
const body = Buffer.from(await encryptPayload(sub, new TextEncoder().encode(JSON.stringify(message))));

function decrypt(buf) {
  const salt = buf.subarray(0, 16), rs = buf.readUInt32BE(16), idlen = buf[20];
  const asPublic = buf.subarray(21, 21 + idlen), ct = buf.subarray(21 + idlen);
  const shared = ua.computeSecret(asPublic);
  const hk = (salt, ikm, info, n) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, n));
  const ikm = hk(authSecret, shared, Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]), 32);
  const cek = hk(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hk(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  return { rs, idlen, text: pt.subarray(0, pt.lastIndexOf(2)).toString() };
}
let dec = null;
try { dec = decrypt(body); } catch (e) { dec = { error: e.message }; }
check('Reminder decrypts with the phone\'s key (RFC 8291)', dec.text === JSON.stringify(message), dec.error || '');
check('Record header is standard (4096-byte records, 65-byte key id)', dec.rs === 4096 && dec.idlen === 65);

try {
  const ece = (await import('http_ece')).default;
  const viaLib = ece.decrypt(body, { version: 'aes128gcm', privateKey: ua, authSecret: authSecret.toString('base64url') });
  check('Independent http_ece library decrypts it too', viaLib.toString() === JSON.stringify(message));
} catch (e) {
  if (!/Cannot find (package|module)/.test(e.message)) check('Independent http_ece library decrypts it too', false, e.message);
}

const other = crypto.createECDH('prime256v1'); other.generateKeys();
let wrongKeyFails = false;
try { const save = ua.computeSecret; ua.computeSecret = (k) => other.computeSecret(k); try { decrypt(body); } finally { ua.computeSecret = save; } } catch { wrongKeyFails = true; }
check('Another phone\'s key cannot read it', wrongKeyFails);

// ── 2. VAPID ─────────────────────────────────────────────────────────────
const vk = crypto.createECDH('prime256v1'); vk.generateKeys();
const vapid = { publicKey: bytesToB64url(vk.getPublicKey()), privateKey: bytesToB64url(vk.getPrivateKey()), subject: 'mailto:hello@sicklestrong.app' };
const authz = await vapidAuthorization(sub.endpoint, vapid, 1_800_000_000);
const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(authz) || [];
const [h, p, s] = (jwt || '..').split('.');
const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
const pubKeyObj = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: bytesToB64url(vk.getPublicKey().subarray(1, 33)), y: bytesToB64url(vk.getPublicKey().subarray(33)) }, format: 'jwk' });
const sigOk = crypto.verify('sha256', Buffer.from(`${h}.${p}`), { key: pubKeyObj, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
check('VAPID token is signed by our key', sigOk && k === vapid.publicKey);
check('VAPID token names the push service and expires within a day', claims.aud === 'https://fcm.googleapis.com' && claims.exp - 1_800_000_000 <= 86400 && claims.sub === vapid.subject);

const calls = [];
const fake = (status) => async (url, init) => { calls.push({ url, init }); return { status }; };
const ok = await sendPush(sub, message, vapid, { ttl: 900, topic: 'abc' }, fake(201));
const gone = await sendPush(sub, message, vapid, {}, fake(410));
check('Send: headers for an encrypted, expiring, high-priority push', calls[0].init.headers['Content-Encoding'] === 'aes128gcm' && calls[0].init.headers.TTL === '900' && calls[0].init.headers.Urgency === 'high' && calls[0].init.headers.Topic === 'abc' && ok.ok);
check('Send: "gone" reply is reported so the subscription is deleted', gone.gone && !gone.ok);

// ── 3. Schedule ──────────────────────────────────────────────────────────
const CHI = 'America/Chicago';
const at = (iso) => new Date(iso); // UTC instants
// 8:00 AM Chicago on Oct 20, 2026 (CDT, UTC-5) = 13:00Z
const subA = { id: 's1', auth_id: 'kim', time_zone: CHI, show_names: false };
const access = [{ auth_id: 'kim', child_id: 'jax' }];
const children = [{ id: 'jax', name: 'Jaxxon Maner', is_active: true }, { id: 'cam', name: 'Cameron', is_active: true }];
const med = (o) => ({ id: 'm1', child_id: 'jax', name: 'Hydroxyurea', dose: '500 mg', times: ['08:00'], type: 'daily', is_active: true, start_date: null, end_date: null, ...o });
const run = (now, o = {}) => dueReminders(at(now), o.subs || [subA], o.access || access, o.children || children, o.meds || [med()], o.sent || new Set());

check('7:44 AM: too early, nothing sent', run('2026-10-20T12:44:00Z').length === 0);
const r745 = run('2026-10-20T12:45:00Z');
check('7:45 AM: reminder for the 8:00 dose', r745.length === 1 && r745[0].doseTime === '08:00' && r745[0].doseDate === '2026-10-20');
check('Title says who and how long', r745[0]?.title === "💊 Jaxxon's medicine in 15 minutes", r745[0]?.title);
check('Lock screen hides medicine names by default', !/Hydroxyurea/.test(r745[0]?.body) && /1 medicine due at 8:00 AM/.test(r745[0]?.body), r745[0]?.body);
check('Names shown when the family turns them on', /Hydroxyurea 500 mg · 8:00 AM/.test(run('2026-10-20T12:45:00Z', { subs: [{ ...subA, show_names: true }] })[0]?.body || ''));
check('7:55 AM (late run): still sent, says 5 minutes', /in 5 minutes/.test(run('2026-10-20T12:55:00Z')[0]?.title || ''));
check('8:00 AM: dose time reached, no reminder', run('2026-10-20T13:00:00Z').length === 0);
check('Already sent: not sent again', run('2026-10-20T12:50:00Z', { sent: new Set([sentKey('s1', 'm1', '2026-10-20', '08:00')]) }).length === 0);
check('Phone in New York: reminded on New York time', run('2026-10-20T11:45:00Z', { subs: [{ ...subA, time_zone: 'America/New_York' }] }).length === 1 && run('2026-10-20T12:45:00Z', { subs: [{ ...subA, time_zone: 'America/New_York' }] }).length === 0);
check('No access to the child: no reminder', run('2026-10-20T12:45:00Z', { access: [{ auth_id: 'kim', child_id: 'cam' }] }).length === 0);
check('Someone else\'s access does not count', run('2026-10-20T12:45:00Z', { access: [{ auth_id: 'jason', child_id: 'jax' }] }).length === 0);
check('Deleted medication: no reminder', run('2026-10-20T12:45:00Z', { meds: [med({ is_active: false })] }).length === 0);
check('"As needed" medication: no reminder', run('2026-10-20T12:45:00Z', { meds: [med({ type: 'prn' })] }).length === 0);
check('Inactive child: no reminder', run('2026-10-20T12:45:00Z', { children: [{ id: 'jax', name: 'Jaxxon', is_active: false }] }).length === 0);
check('Course ended yesterday: no reminder', run('2026-10-20T12:45:00Z', { meds: [med({ end_date: '2026-10-19' })] }).length === 0);
const two = run('2026-10-20T12:45:00Z', { meds: [med(), med({ id: 'm2', name: 'Folic acid', dose: '1 mg' })] });
check('Two medicines at 8:00: one reminder, both covered', two.length === 1 && two[0].medIds.length === 2 && /2 medicines/.test(two[0].body));
const late = run('2026-10-21T04:52:00Z', { meds: [med({ times: ['00:05'] })] }); // 11:52 PM Oct 20 Chicago
check('12:05 AM dose: reminded at 11:52 PM, filed under the next day', late.length === 1 && late[0].doseDate === '2026-10-21', JSON.stringify(late.map(d => d.doseDate)));
check('Junk time values are ignored, not crashed on', run('2026-10-20T12:45:00Z', { meds: [med({ times: ['25:00', 'noon', null, '08:00'] })] }).length === 1);
check('Times read as AM/PM', formatTime('20:30') === '8:30 PM' && formatTime('00:05') === '12:05 AM');

// ── 4. App ───────────────────────────────────────────────────────────────
const STUB = `window.__rpc=[];window.__signedOut=0;window.supabase={createClient:()=>({auth:{
  getSession:async()=>({data:{session:window.__session||null}}),getUser:async()=>({data:{user:null}}),
  onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>{window.__rpc.push(['signOut']);return{error:null}}},
  from:()=>({select:()=>({eq:()=>({single:async()=>({data:null})})})}),
  rpc:async(n,a)=>{window.__rpc.push([n,a]);return{data:null,error:null}}})};`;

// A fake push stack: Chromium can't really subscribe from file://.
const FAKE_PUSH = () => {
  window.__perm = window.__perm || 'default';
  window.__pushSub = null;
  const sub = () => ({
    endpoint: 'https://fcm.googleapis.com/fcm/send/test-1',
    toJSON() { return { endpoint: this.endpoint, keys: { p256dh: 'B'.padEnd(87, 'A'), auth: 'A'.repeat(22) } }; },
    async unsubscribe() { window.__unsubscribed = (window.__unsubscribed || 0) + 1; window.__pushSub = null; return true; },
  });
  const reg = {
    pushManager: {
      async getSubscription() { return window.__pushSub; },
      async subscribe(o) { window.__subscribeKeyLen = o.applicationServerKey.length; window.__pushSub = sub(); return window.__pushSub; },
    },
    async showNotification() {},
  };
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve(reg), getRegistration: async () => reg, register: async () => reg, addEventListener() {} } });
  window.Notification = function () {};
  Object.defineProperty(window.Notification, 'permission', { get: () => window.__perm });
  window.Notification.requestPermission = async () => { window.__perm = window.__grant || 'granted'; return window.__perm; };
};

const browser = await chromium.launch({ executablePath: CHROMIUM });
const pageErrors = [];
async function open({ ua, session = false, perm = 'default', data = {} } = {}) {
  const ctx = await browser.newContext(ua ? { userAgent: ua } : {});
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith('file://')) return r.continue();
    if (u.includes('@supabase')) return r.fulfill({ contentType: 'application/javascript', body: STUB });
    return r.abort();
  });
  await page.addInitScript(({ session, perm, data }) => {
    window.__session = session ? { user: { id: 'kim' } } : null;
    window.__perm = perm;
    localStorage.setItem('ss_auth_dismissed', 'true');
    localStorage.setItem('ss_install_dismissed', 'true');
    localStorage.setItem('sickleStrongData', JSON.stringify({ setupComplete: true, currentChildId: 'c1',
      children: [{ id: 'c1', name: 'Jaxxon', painLog: [], temperatureLog: [], symptoms: [], notes: [], weightHistory: [], medications: [] }],
      contacts: [], ...data }));
  }, { session, perm, data });
  await page.addInitScript(FAKE_PUSH);
  await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof reminderState === 'function');
  await page.waitForTimeout(400);
  return page;
}
const card = (page) => page.evaluate(async () => { await updateNotificationUI(); return { status: document.getElementById('notifStatusText').textContent, btn: document.getElementById('notifButton').textContent, help: document.getElementById('notifHelpText').innerText }; });

{
  const page = await open();
  const c = await card(page);
  check('Signed out: card says to sign in, not a dead Enable button', /Sign in/.test(c.status) && c.btn === 'Sign in', JSON.stringify(c));
  await page.context().close();
}
{
  const page = await open({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1', session: true });
  const c = await card(page);
  check('iPhone in Safari: explains Add to Home Screen first', /Home Screen/.test(c.status) && c.btn === 'Show me how');
  await page.evaluate(() => toggleNotifications());
  await page.waitForTimeout(100);
  const shown = await page.evaluate(() => document.getElementById('ssNotice')?.innerText || '');
  check('iPhone: "Show me how" gives the steps', /Add to Home Screen/.test(shown) && /Share/.test(shown));
  await page.context().close();
}
{
  const page = await open({ session: true, perm: 'denied' });
  const c = await card(page);
  check('Blocked: says so and offers how to fix', /Blocked/.test(c.status) && /How to fix/.test(c.btn));
  await page.context().close();
}
{
  const page = await open({ session: true });
  const c0 = await card(page);
  check('Signed in, not on yet: Enable', c0.btn === 'Enable' && /even when the app is closed/.test(c0.help));
  await page.evaluate(() => toggleNotifications());
  await page.waitForTimeout(150);
  const after = await page.evaluate(() => ({ rpc: window.__rpc.filter(r => r[0] === 'save_push_subscription'), keyLen: window.__subscribeKeyLen, on: appData.pushEnabled }));
  const a = after.rpc[0]?.[1] || {};
  check('Enable subscribes with our 65-byte public key', after.keyLen === 65);
  check('Enable saves the subscription with this phone\'s time zone', a.p_endpoint === 'https://fcm.googleapis.com/fcm/send/test-1' && a.p_p256dh?.length === 87 && a.p_auth?.length === 22 && typeof a.p_time_zone === 'string' && a.p_time_zone.length > 2 && a.p_show_names === false, JSON.stringify(a));
  const c1 = await card(page);
  check('Card then shows On, with the lock-screen names option off', /On/.test(c1.status) && c1.btn === 'Turn off' && /lock screen/.test(c1.help) && !(await page.evaluate(() => document.getElementById('pushShowNames').checked)));

  await page.evaluate(() => { const b = document.getElementById('pushShowNames'); b.checked = true; b.dispatchEvent(new Event('change')); });
  await page.waitForTimeout(100);
  check('Turning names on re-saves with show_names', await page.evaluate(() => window.__rpc.filter(r => r[0] === 'save_push_subscription').at(-1)[1].p_show_names === true));

  await page.evaluate(() => { window.__rpc.length = 0; return refreshPushSubscription(); });
  check('Every signed-in open re-saves the subscription (endpoints rotate)', await page.evaluate(() => window.__rpc.some(r => r[0] === 'save_push_subscription')));

  await page.evaluate(() => toggleNotifications());
  await page.waitForTimeout(150);
  const off = await page.evaluate(() => ({ rm: window.__rpc.find(r => r[0] === 'remove_push_subscription'), un: window.__unsubscribed, on: appData.pushEnabled }));
  check('Turn off removes it from the server and the phone', off.rm?.[1]?.p_endpoint === 'https://fcm.googleapis.com/fcm/send/test-1' && off.un === 1 && off.on === false);
  await page.context().close();
}
{
  // Sign out: the subscription goes before the session does
  const page = await open({ session: true, perm: 'granted', data: { pushEnabled: true, notificationsEnabled: true } });
  await page.evaluate(() => refreshPushSubscription());
  await page.evaluate(() => { window.__rpc.length = 0; return removePushSubscription().then(() => sb.auth.signOut({ scope: 'local' })); });
  const order = await page.evaluate(() => window.__rpc.map(r => r[0]));
  check('Sign-out path removes reminders before signing out', order[0] === 'remove_push_subscription' && order.at(-1) === 'signOut', order.join(','));
  const src = await page.evaluate(() => showSignOut.toString());
  check('Sign Out calls it before signOut()', src.indexOf('removePushSubscription') > -1 && src.indexOf('removePushSubscription') < src.indexOf('sb.auth.signOut'));
  await page.context().close();
}
check('No uncaught page errors', pageErrors.length === 0, [...new Set(pageErrors)].join(' | '));

await browser.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
