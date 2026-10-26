// Yellow eyes from the pain body map.
//
// A parent who sees yellow eyes looks for it on the body map (the head). It
// isn't pain, so the map offers a button that opens Log Symptoms with
// Jaundice already ticked, rather than a pain location that would skew pain
// reports. A report-tier helper can't log symptoms, so they're told to tell
// the parent instead.
//
// Run: node tests/yellow-eyes.test.mjs

import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_URL = pathToFileURL(resolve(HERE, '..', 'index.html')).href;
const CHROMIUM = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
const STUB = `window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:null}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},from:()=>{const q={select:()=>q,eq:()=>q,in:()=>q,order:()=>q,single:async()=>({data:null}),then:(r)=>r({data:[],error:null}),insert:async()=>({error:null}),upsert:async()=>({error:null})};return q},rpc:async()=>({data:null,error:null})})};`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage({ viewport: { width: 360, height: 760 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.route('**/*', (r) => {
  const u = r.request().url();
  if (u.startsWith('file://')) return r.continue();
  if (u.includes('@supabase')) return r.fulfill({ contentType: 'application/javascript', body: STUB });
  return r.abort();
});
await page.addInitScript(() => {
  localStorage.setItem('ss_auth_dismissed', 'true');
  localStorage.setItem('ss_install_dismissed', 'true');
  localStorage.setItem('sickleStrongData', JSON.stringify({ setupComplete: true, currentChildId: 'c1',
    children: [{ id: 'c1', name: 'Jaxxon', diseaseType: 'HbSS', painLog: [], temperatureLog: [], symptoms: [], notes: [], weightHistory: [], medications: [] }],
    contacts: [] }));
});
await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof showPainBodyMap === 'function');
await page.waitForTimeout(400);

await page.evaluate(() => showPainBodyMap());
const prompt = await page.evaluate(() => document.getElementById('yellowEyesPrompt')?.innerText || '');
check('Body map asks "Eyes or skin look yellow?"', /Eyes or skin look yellow\?/.test(prompt), prompt.replace(/\n/g, ' | '));

await page.evaluate(() => togglePainLocation('Head'));
await page.evaluate(() => document.getElementById('yellowEyesBtn').click());
await page.waitForTimeout(150);
const after = await page.evaluate(() => ({
  ticked: document.getElementById('sym_jaundice')?.checked,
  others: [...document.querySelectorAll('input[id^="sym_"]:checked')].length,
  modals: document.querySelectorAll('.modal').length,
  leftover: (window.selectedPainLocations || []).length,
}));
check('The button opens Log Symptoms with only Jaundice ticked', after.ticked === true && after.others === 1, JSON.stringify(after));
check('The pain map closes and its half-picked locations are dropped', after.modals === 1 && after.leftover === 0, JSON.stringify(after));

await page.evaluate(() => { document.getElementById('selectedSeverity').value = '2'; document.querySelector('button[onclick="saveSymptomLog()"]').click(); });
await page.waitForTimeout(200);
const saved = await page.evaluate(() => ({ s: getCurrentChild().symptoms, p: getCurrentChild().painLog.length }));
check('Saving logs a Jaundice symptom and no pain entry',
  saved.s.length === 1 && JSON.stringify(saved.s[0]).includes('jaundice') && saved.p === 0, JSON.stringify(saved.s[0]));

// A report-tier helper (babysitter) can log pain but not symptoms.
await page.evaluate(() => { document.querySelectorAll('.modal').forEach((m) => m.remove()); window.canDo = (need) => need !== 'full'; showPainBodyMap(); });
const helper = await page.evaluate(() => ({ text: document.getElementById('yellowEyesPrompt')?.innerText || '', btn: !!document.getElementById('yellowEyesBtn') }));
check('A helper who can\'t log symptoms is told to tell the parent', !helper.btn && /Tell Jaxxon's parent right away/.test(helper.text), helper.text);

check('No uncaught page errors', errors.length === 0, errors.join(' | '));
await browser.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
