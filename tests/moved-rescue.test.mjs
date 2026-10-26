// Records left at an old SickleStrong address come over to the new one.
//
// Early beta families were sent to addresses that now serve moved/index.html.
// Those versions kept records only in that address's browser storage, which
// the new address can't read, so the moved page packs them into the app's
// #rescue= link and the app asks before adding them. Both pages are served
// here at their real addresses (routed to the local files), so storage is
// split between the two origins exactly as on a phone.
//
// Run: node tests/moved-rescue.test.mjs

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { CAPTURE_NOTICES } from './notices-capture.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const CHROMIUM = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
const OLD = 'https://sickledcellstrong-test.netlify.app/';
const APP = 'https://sicklestrong-v2.netlify.app/';
const STUB = `window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:null}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},from:()=>{const q={select:()=>q,eq:()=>q,in:()=>q,order:()=>q,single:async()=>({data:null}),then:(r)=>r({data:[],error:null})};return q},rpc:async()=>({data:null,error:null})})};`;
const TYPES = { '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.js': 'application/javascript' };

// What the June-1 version saved (same key, same shape).
const OLD_DATA = {
  setupComplete: true, currentChildId: '1717200000000',
  parents: { parent1: { name: 'Kim', phone: '334-555-0101', email: '' }, parent2: { name: '', phone: '', email: '' } },
  children: [
    { id: '1717200000000', name: 'Jaxxon', diseaseType: 'HbSS', waterIntake: 0, hydrationGoal: 64,
      painLog: [
        { id: 1717300000000, location: 'Legs', emoji: '😣', level: 4, startTime: '2026-06-02T14:00:00.000Z', helped: ['Water'], notes: 'after P.E. & "recess"', resolved: true },
        { id: 1717400000000, location: 'Back', emoji: '😖', level: 5, startTime: '2026-06-05T02:30:00.000Z', helped: [], notes: '', resolved: false },
      ],
      temperatureLog: [{ id: 1717350000000, temp: 101.6, timestamp: '2026-06-03T09:00:00.000Z' }],
      medications: [{ id: 1717200000001, name: 'Hydroxyurea', dose: '500 mg', times: ['08:00'], type: 'daily' }],
      symptoms: [], notes: [], weightHistory: [{ date: '2026-06-01T00:00:00.000Z', weight: 52 }] },
    { id: '1717200000099', name: 'Cameron', diseaseType: 'HbSC', painLog: [], temperatureLog: [],
      medications: [], symptoms: [{ id: 1717500000000, types: ['jaundice'], timestamp: '2026-06-06T10:00:00.000Z', photo: 'data:image/jpeg;base64,AAAA' }],
      notes: [], weightHistory: [] },
  ],
  contacts: [{ id: 1, type: 'Hematologist', name: 'Dr. Smith', phone: '334-555-0100' }],
  communityPosts: [], notificationsEnabled: false,
};

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROMIUM });

async function phone({ oldData, appData }) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 } });
  await ctx.route('**/*', (r) => {
    const u = new URL(r.request().url());
    if (u.href.includes('@supabase')) return r.fulfill({ contentType: 'application/javascript', body: STUB });
    if (u.origin + '/' === OLD) return r.fulfill({ contentType: 'text/html', path: resolve(ROOT, 'moved/index.html') });
    if (u.origin + '/' === APP) {
      const file = resolve(ROOT, u.pathname === '/' ? 'index.html' : '.' + u.pathname);
      if (existsSync(file)) return r.fulfill({ contentType: TYPES[extname(file)] || 'application/octet-stream', body: readFileSync(file) });
      return r.fulfill({ status: 404, body: '' });
    }
    return r.abort();
  });
  await ctx.addInitScript(CAPTURE_NOTICES);
  // Seed each origin's own storage, the way the phone would have it.
  await ctx.addInitScript(({ OLD, APP, oldData, appData }) => {
    if (location.href.startsWith(OLD) && oldData && !sessionStorage.getItem('seeded')) {
      localStorage.setItem('sickleStrongData', JSON.stringify(oldData)); sessionStorage.setItem('seeded', '1');
    }
    if (location.href.startsWith(APP) && !sessionStorage.getItem('seeded')) {
      localStorage.setItem('ss_auth_dismissed', 'true');
      localStorage.setItem('ss_install_dismissed', 'true');
      if (appData) localStorage.setItem('sickleStrongData', JSON.stringify(appData));
      sessionStorage.setItem('seeded', '1');
    }
  }, { OLD, APP, oldData, appData });
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  return { ctx, page };
}

async function bringOver(page) {
  await page.goto(OLD);
  await page.click('#bring');
  await page.waitForURL((u) => u.href.startsWith(APP), { timeout: 10000 });
  await page.waitForSelector('#ssConfirm', { timeout: 10000 });
}
const confirmText = (page) => page.evaluate(() => document.getElementById('ssConfirm').innerText);
const answer = async (page, yes) => {
  await page.evaluate((yes) => document.querySelectorAll('#ssConfirm button')[yes ? 1 : 0].click(), yes);
  await page.waitForTimeout(500);
};
const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('sickleStrongData') || 'null'));

// ── 1. A fresh phone at the new address ──
{
  const { ctx, page } = await phone({ oldData: OLD_DATA });
  await page.goto(OLD);
  const found = await page.evaluate(() => ({ text: document.getElementById('foundText').textContent, bring: !document.getElementById('bring').hidden }));
  check('Old address: says it moved and lists what it found on this phone',
    found.bring && /Jaxxon, Cameron/.test(found.text) && /6 entries/.test(found.text) && /1 care contact/.test(found.text), found.text);

  await bringOver(page);
  const asked = await confirmText(page);
  check('New app asks first, naming the profiles and entry count', /Jaxxon, Cameron/.test(asked) && /6 entries/.test(asked), asked.replace(/\n/g, ' | '));
  check('The records are taken out of the address bar right away', !page.url().includes('rescue'), page.url());

  await answer(page, true);
  const data = await stored(page);
  const jax = data?.children?.find((c) => c.name === 'Jaxxon');
  check('Accepted: both profiles and every entry are in the new app',
    data?.children?.length === 2 && jax?.painLog?.length === 2 && jax?.temperatureLog?.length === 1 && jax?.medications?.length === 1
    && data.children[1].symptoms.length === 1 && data.contacts.length === 1);
  check('Text comes over exactly as typed (no escaping in storage)', jax?.painLog?.[0]?.notes === 'after P.E. & "recess"', jax?.painLog?.[0]?.notes);
  check('Photos come over when they fit', data?.children?.[1]?.symptoms?.[0]?.photo === 'data:image/jpeg;base64,AAAA');
  check('A fresh phone goes straight to the app, not the setup wizard', data?.setupComplete === true && !!data.currentChildId);
  const shown = (await page.evaluate(() => window.__notices || [])).join(' | ');
  check('Says what was brought over', /Brought over 2 profiles, 6 entries, 1 contact/.test(shown), shown);

  // Old address keeps its copy: nothing there is deleted.
  await page.goto(OLD);
  const still = await page.evaluate(() => JSON.parse(localStorage.getItem('sickleStrongData')).children.length);
  check('The old address keeps its copy (nothing deleted there)', still === 2);
  check('No uncaught page errors (fresh phone)', page.errors.length === 0, page.errors.join(' | '));
  await ctx.close();
}

// ── 2. The new app already has records for the same child ──
{
  const existing = {
    setupComplete: true, currentChildId: 'c1', parents: { parent1: { name: 'Kimberly', phone: '', email: '' } },
    children: [{ id: 'c1', name: 'jaxxon ', diseaseType: 'HbSS',
      painLog: [{ id: 'aaaa-uuid', startTime: '2026-06-02T14:00:00.000Z', level: 6, notes: 'already here' }],
      temperatureLog: [], symptoms: [], notes: [], weightHistory: [], medications: [{ id: 'm1', name: 'hydroxyurea', dose: '1000 mg' }] }],
    contacts: [{ id: 'k1', name: 'Dr. Smith', phone: '(334) 555-0100' }],
  };
  const { ctx, page } = await phone({ oldData: OLD_DATA, appData: existing });
  await bringOver(page);
  await answer(page, true);
  const data = await stored(page);
  const jax = data.children.find((c) => c.id === 'c1');
  check('Merging: the matching child gets only what it was missing',
    jax.painLog.length === 2 && jax.temperatureLog.length === 1 && jax.medications.length === 1, JSON.stringify(jax.painLog.map((p) => p.id)));
  check('Merging: what was already here is unchanged',
    jax.painLog[0].notes === 'already here' && jax.painLog[0].level === 6 && jax.medications[0].dose === '1000 mg' && data.parents.parent1.name === 'Kimberly');
  check('Merging: a new child is added, a known contact is not duplicated',
    data.children.length === 2 && data.children.some((c) => c.name === 'Cameron') && data.contacts.length === 1);
  check('No uncaught page errors (merge)', page.errors.length === 0, page.errors.join(' | '));
  await ctx.close();
}

// ── 3. Saying "Not now" changes nothing ──
{
  const { ctx, page } = await phone({ oldData: OLD_DATA });
  await bringOver(page);
  await answer(page, false);
  const data = await stored(page);
  check('"Not now" adds nothing', !data || !data.children || data.children.length === 0, JSON.stringify(data)?.slice(0, 80));
  await ctx.close();
}

// ── 4. A damaged or made-up link ──
{
  const { ctx, page } = await phone({});
  await page.goto(APP + '#rescue=g.not-real-data');
  await page.waitForTimeout(800);
  const body = (await page.evaluate(() => window.__notices || [])).join(' | ');
  const data = await stored(page);
  check('A damaged link changes nothing and says so', /couldn't read the records/.test(body) && (!data || !data.children?.length));
  check('No uncaught page errors (damaged link)', page.errors.length === 0, page.errors.join(' | '));
  await ctx.close();
}

// ── 5. Nothing saved at the old address ──
{
  const { ctx, page } = await phone({});
  await page.goto(OLD);
  const view = await page.evaluate(() => ({ bring: !document.getElementById('bring').hidden, open: document.getElementById('open').href }));
  check('Old address with no records: just a button to the new app', !view.bring && view.open === APP, JSON.stringify(view));
  await ctx.close();
}

// ── 6. Hostile text in a crafted link can't run ──
{
  const evil = { children: [{ id: 'x', name: '<img src=x onerror="window.__pwned=1">', painLog: [{ id: 1, startTime: '2026-06-01T00:00:00Z', notes: '<script>window.__pwned=1</script>', level: 3 }] }] };
  const json = Buffer.from(JSON.stringify(evil)).toString('base64url');
  const { ctx, page } = await phone({});
  await page.goto(APP + '#rescue=j.' + json);
  await page.waitForSelector('#ssConfirm');
  await answer(page, true);
  await page.evaluate(() => { try { updateUI(); } catch (e) {} });
  await page.waitForTimeout(300);
  check('Names and notes from a link are shown as text, never run', !(await page.evaluate(() => window.__pwned)));
  await ctx.close();
}

// ── 7. Photos too big for a link stay behind; everything else comes ──
{
  const big = JSON.parse(JSON.stringify(OLD_DATA));
  // Random bytes don't compress, so this can't fit in a link.
  const noise = Buffer.from(Array.from({ length: 1600000 }, () => Math.floor(Math.random() * 256))).toString('base64');
  big.children[1].symptoms[0].photo = 'data:image/jpeg;base64,' + noise;
  const { ctx, page } = await phone({ oldData: big });
  await bringOver(page);
  await answer(page, true);
  const data = await stored(page);
  const sym = data?.children?.find((c) => c.name === 'Cameron')?.symptoms?.[0];
  const shown = (await page.evaluate(() => window.__notices || [])).join(' | ');
  check('Too-big photos: the entry still comes over, without its photo', !!sym && !sym.photo && data.children.length === 2);
  check('Too-big photos: the app says the photos stayed behind', /Photos were too big to move/.test(shown), shown);
  await ctx.close();
}

await browser.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
