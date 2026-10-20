// "Logged by" + pain scale suite for SickleStrong.
//
//   - Pain is rated 2–10 and must reach the cloud as 2–10. It used to be
//     clamped to 1–5, so an 8 showed up for other caregivers as "5/10".
//   - A pain entry saved under the old clamp keeps the phone's real level.
//   - Entries someone else logged say "Logged by <first name>", as text;
//     your own entries, and authors who can't be named, show nothing.
//
// Run: node tests/logged-by.test.mjs

import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_URL = pathToFileURL(resolve(HERE, '..', 'index.html')).href;
const CHROMIUM = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
const STUB = `window.__inserts=[];window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:null}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},from:(t)=>({insert:async(row)=>{window.__inserts.push([t,row]);return{error:null}},select:()=>({eq:()=>({single:async()=>({data:null})})})}),rpc:async()=>({data:null,error:null})})};`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.route('**/*', (r) => {
  const u = r.request().url();
  if (u.startsWith('file://')) return r.continue();
  if (u.includes('@supabase')) return r.fulfill({ contentType: 'application/javascript', body: STUB });
  return r.abort();
});
await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof loggedByHtml === 'function' && typeof _pushPainLog === 'function');

const out = await page.evaluate(async () => {
  const r = {};
  // Pain level goes up as rated
  for (const level of [2, 6, 8, 10]) await _pushPainLog({ level, cloudId: 'x' + level }, 'c1', 'f1');
  r.severities = window.__inserts.filter(i => i[0] === 'pain_logs').map(i => i[1].severity);

  // Old clamped entry keeps the phone's level; a genuine 5 or a cloud edit is left alone
  const a = { level: 5 }; _fillFromLocal(a, { level: 8 }); r.keepsLocal8 = a.level;
  const b = { level: 4 }; _fillFromLocal(b, { level: 8 }); r.cloud4Stays = b.level;
  const c = { level: 5 }; _fillFromLocal(c, { level: 4 }); r.lowerLocalIgnored = c.level;

  // Rendering
  appData.myUserId = 'me';
  appData.setupComplete = true;
  appData.children = [{ id: 'c1', name: 'Jaxxon', painLog: [
      { id: 1, level: 8, location: 'Chest', startTime: '2026-10-20T02:50:00Z', loggedById: 'kim', loggedByName: 'Kimberly Maner' },
      { id: 2, level: 4, location: 'Legs', startTime: '2026-10-19T02:50:00Z', loggedById: 'me', loggedByName: 'Jason Lucas' },
      { id: 3, level: 2, location: 'Arm', startTime: '2026-10-18T02:50:00Z', loggedById: 'gone', loggedByName: '' },
      { id: 4, level: 6, location: 'Back', startTime: '2026-10-17T02:50:00Z', loggedById: 'evil', loggedByName: '<img src=x onerror="window.__xss=1"> Mallory' }
    ], temperatureLog: [{ id: 5, temperature: 101.5, timestamp: '2026-10-20T01:00:00Z', loggedById: 'kim', loggedByName: 'Kimberly Maner' }],
    symptoms: [], notes: [{ id: 6, date: '2026-10-20T00:00:00Z', mood: '😊', text: 'ok', loggedById: 'kim', loggedByName: 'Kimberly Maner' }],
    medications: [], weightHistory: [] }];
  appData.currentChildId = 'c1';
  renderSymptomHistory();
  const hist = document.getElementById('symptomHistory');
  const text = hist.innerText;
  r.kimShown = (text.match(/Logged by Kimberly/g) || []).length;
  r.selfHidden = !/Logged by Jason/.test(text);
  r.goneHidden = (text.match(/Logged by/g) || []).length;
  r.xssSafe = !hist.querySelector('img') && !window.__xss && /Logged by <img/.test(text);
  r.showsTen = /8\/10/.test(text);
  renderNotes();
  r.noteShown = /Logged by Kimberly/.test(document.getElementById('notesList')?.innerText || '');
  return r;
});

check('Pain levels 2, 6, 8, 10 reach the cloud as rated (no clamp to 5)', JSON.stringify(out.severities) === '[2,6,8,10]', JSON.stringify(out.severities));
check('Entry saved under the old clamp keeps the phone\'s real level', out.keepsLocal8 === 8);
check('A cloud level other than the old clamp is not overridden', out.cloud4Stays === 4 && out.lowerLocalIgnored === 5);
check('Someone else\'s pain and fever entries say "Logged by Kimberly"', out.kimShown === 2, String(out.kimShown));
check('Your own entries show no label', out.selfHidden);
check('An author who can\'t be named shows no label', out.goneHidden === 3, String(out.goneHidden));
check('Author name renders as text, never HTML', out.xssSafe);
check('Pain shows its real level out of 10', out.showsTen);
check('Notes show who wrote them', out.noteShown);
check('No uncaught page errors', pageErrors.length === 0, [...new Set(pageErrors)].join(' | '));

await browser.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
