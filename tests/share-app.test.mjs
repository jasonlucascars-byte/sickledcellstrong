// "Share SickleStrong" — passing the app to a family outside this one.
//
// A parent (or a school nurse) shares a link to the public landing page. It
// must grant nothing and say nothing about the sharer's child; a signed-in
// sharer's link carries their share code so they can see a count of families
// who joined. The QR code is drawn by the app's own encoder (no dependency),
// so this suite decodes it with an independent reader (jsQR).
//
// Run: node tests/share-app.test.mjs   (needs: npm i --no-save playwright@1 jsqr pngjs)

import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(HERE, '..', 'index.html');
const INDEX_URL = pathToFileURL(INDEX).href;
const CHROMIUM = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
const CODE = 'FAM-ABC234';

const stub = (signedIn) => `window.supabase={createClient:()=>({auth:{
  getSession:async()=>({data:{session:${signedIn ? "{user:{id:'u1',email:'a@b.c'}}" : 'null'}}}),
  getUser:async()=>({data:{user:${signedIn ? "{id:'u1'}" : 'null'}}}),
  onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
  from:()=>{const q={select:()=>q,eq:()=>q,in:()=>q,order:()=>q,is:()=>q,gte:()=>q,single:async()=>({data:null}),maybeSingle:async()=>({data:null}),then:(r)=>r({data:[],error:null}),insert:async()=>({error:null}),upsert:async()=>({error:null}),update:()=>q,delete:()=>q};return q},
  rpc:async(n)=>n==='get_my_referral_code'?{data:'${CODE}',error:null}:n==='my_referral_count'?{data:3,error:null}:{data:null,error:null}})};`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROMIUM });

async function open({ signedIn = false, query = '', init } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith('file://')) return r.continue();
    if (u.includes('@supabase')) return r.fulfill({ contentType: 'application/javascript', body: stub(signedIn) });
    return r.abort();
  });
  await page.addInitScript((init) => {
    localStorage.setItem('ss_auth_dismissed', 'true');
    localStorage.setItem('ss_install_dismissed', 'true');
    localStorage.setItem('sickleStrongData', JSON.stringify({
      setupComplete: true, currentChildId: 'c1',
      children: [{ id: 'c1', name: 'Jaxxon', diseaseType: 'HbSS', painLog: [], temperatureLog: [], symptoms: [], notes: [], weightHistory: [], medications: [] }],
      contacts: [] }));
    window.__shared = [];
    navigator.share = async (d) => { window.__shared.push(d); };
    if (init) new Function(init)();
  }, init || '');
  await page.goto(INDEX_URL + query, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof showShareApp === 'function');
  await page.waitForTimeout(400);
  return page;
}

// Decode a PNG screenshot of the QR box with jsQR.
async function readQr(page) {
  const buf = await page.locator('#ssShareApp [data-qr] svg').screenshot();
  const png = PNG.sync.read(buf);
  return jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data ?? null;
}

// Render a module matrix to RGBA and decode it.
function decodeMatrix({ size, modules }) {
  const s = 6, q = 4, n = (size + q * 2) * s;
  const px = new Uint8ClampedArray(n * n * 4).fill(255);
  modules.forEach((row, y) => row.forEach((dark, x) => {
    if (!dark) return;
    for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) {
      const i = (((y + q) * s + dy) * n + (x + q) * s + dx) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
  }));
  return jsQR(px, n, n)?.data ?? null;
}

// ── Signed out ──
{
  const page = await open();
  const card = await page.evaluate(() => {
    const c = document.getElementById('shareAppCard');
    return c && c.closest('#dashboard, .page, [id$="Page"], [id$="View"]') ? c.innerText : c?.innerText;
  });
  check('Home shows the "Know a family facing sickle cell?" card', !!card && /Know a family facing sickle cell\?/.test(card));

  await page.evaluate(() => document.getElementById('shareAppBtn').click());
  await page.waitForSelector('#ssShareApp [data-qr] svg');
  await page.evaluate(() => document.querySelector('#ssShareApp [data-act="share"]').click());
  await page.waitForTimeout(100);
  const shared = await page.evaluate(() => window.__shared[0]);
  const text = shared?.text || '';
  check('Signed out: the link is the public page with no share code',
    text.includes('https://sicklestrong-landing-v2.netlify.app/#join') && !text.includes('ref='), text);
  check('The message never names the sharer\'s child', text.length > 0 && !/Jaxxon/.test(text));
  check('The message explains the app to someone who has never heard of it',
    /families living with sickle cell disease/.test(text) && /nothing to install/i.test(text));
  check('The message is not an invite (no invite or join code)', !/INV-|STRONG-|\?invite=|\?join=/.test(text));
  check('QR code scans to the same link', (await readQr(page)) === 'https://sicklestrong-landing-v2.netlify.app/#join');
  const hint = await page.evaluate(() => document.getElementById('ssShareApp').innerText);
  check('Signed out: explains signing in shows the count', /Sign in to see how many families join/.test(hint));
  check('Signed out: no uncaught page errors', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ── Signed in ──
{
  const page = await open({ signedIn: true });
  await page.waitForTimeout(300);
  // Runs after every signed-in sync (syncAllFromCloud); called directly here
  // because the stubbed cloud has nothing to sync.
  const cardCount = await page.evaluate(async () => {
    await refreshShareCount();
    const el = document.getElementById('shareAppCount');
    return el.style.display !== 'none' ? el.textContent : '';
  });
  check('Signed in: the card shows how many families joined', /3 families joined through your link/.test(cardCount), cardCount);

  await page.evaluate(() => document.getElementById('shareAppBtn').click());
  await page.waitForSelector('#ssShareApp [data-qr] svg');
  await page.waitForTimeout(100);
  await page.evaluate(() => document.querySelector('#ssShareApp [data-act="share"]').click());
  await page.waitForTimeout(100);
  const text = await page.evaluate(() => window.__shared[0]?.text || '');
  const link = `https://sicklestrong-landing-v2.netlify.app/?ref=${CODE}#join`;
  check('Signed in: the link carries the sharer\'s code', text.includes(link), text);
  check('Signed in: QR code scans to the coded link', (await readQr(page)) === link);
  const modalText = await page.evaluate(() => document.getElementById('ssShareApp').innerText);
  check('Signed in: the share window shows the count and says it never shows names',
    /3 families joined/.test(modalText) && /never names/.test(modalText));
  check('Signed in: no uncaught page errors', page.errors.length === 0, page.errors.join(' | '));
  await page.close();
}

// ── Arriving through a shared link ──
{
  const page = await open({ query: '?ref=nurse-lexi' });
  const got = await page.evaluate(() => ({
    saved: JSON.parse(localStorage.getItem('ss_ref') || 'null')?.code,
    url: location.search,
    meta: refMeta(),
  }));
  check('A ?ref= code is kept (uppercased) for sign-up', got.saved === 'NURSE-LEXI' && got.meta.referred_by === 'NURSE-LEXI', JSON.stringify(got));
  check('The code is taken out of the address bar', !got.url.includes('ref='), got.url);
  await page.close();
}
{
  const page = await open({ query: '?ref=%3Cscript%3E' });
  const saved = await page.evaluate(() => localStorage.getItem('ss_ref'));
  check('A malformed code is ignored', saved === null, String(saved));
  await page.close();
}
{
  const old = JSON.stringify({ code: 'FAM-OLD234', at: Date.now() - 31 * 864e5 });
  const page = await open({ init: `localStorage.setItem('ss_ref', ${JSON.stringify(old)})` });
  const meta = await page.evaluate(() => refMeta());
  check('A code older than 30 days no longer counts', !meta.referred_by, JSON.stringify(meta));
  await page.close();
}

// Both account sign-ups (family and invite) send the code along.
const src = readFileSync(INDEX, 'utf8');
const signUps = src.split('await sb.auth.signUp(').slice(1).map((s) => s.slice(0, 700));
check('Both sign-up paths add referred_by', signUps.length === 2 && /refMeta\(\)/.test(signUps[1]) &&
  /Object\.assign\(meta, refMeta\(\)\);\s*const \{ data, error \} = await sb\.auth\.signUp\(\{\s*email, password,\s*options: \{ data: meta/.test(src));

// ── The encoder itself, across every version it supports ──
{
  const page = await open();
  const lengths = [1, 10, 14, 20, 26, 34, 42, 50, 62, 70, 84, 100, 106, 122, 140, 152, 154, 170, 180, 200, 213];
  const out = await page.evaluate((lengths) => lengths.map((n) => {
    const t = Array.from({ length: n }, (_, i) => 'abcXYZ019-/?=#'[(i * 7) % 14]).join('');
    const q = qrEncode(t);
    return { t, size: q.size, modules: q.modules };
  }), lengths);
  const bad = out.filter((o) => decodeMatrix(o) !== o.t).map((o) => `${o.t.length}ch/v${(o.size - 17) / 4}`);
  const versions = [...new Set(out.map((o) => (o.size - 17) / 4))];
  check(`Encoder output decodes at versions ${versions.join(',')}`, bad.length === 0 && versions.length === 10, bad.join(' '));
  const tooLong = await page.evaluate(() => { try { qrEncode('x'.repeat(400)); return 'no error'; } catch (e) { return e.message; } });
  check('Text too long for a QR code fails loudly, not silently', tooLong === 'QR_TOO_LONG', tooLong);
  await page.close();
}

await browser.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
