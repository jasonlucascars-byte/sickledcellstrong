// Quiet messages + readable text suite for SickleStrong.
//
//   - The app never calls alert() or confirm(). Those freeze everything
//     (sync, the outbox) until tapped and look like a system error on iPhone.
//     notify() shows a toast for a short line and a card with OK for a longer
//     one; askConfirm() is an in-app choice that resolves true/false.
//   - A "Cancel" (or a tap outside the card) never deletes anything.
//   - On a 360px phone, text is at least 14px everywhere except the bottom
//     tab labels, nothing runs off the side, and no tab label is cut off.
//
// Run: node tests/quiet-messages.test.mjs

import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX = resolve(HERE, '..', 'index.html');
const INDEX_URL = pathToFileURL(INDEX).href;
const CHROMIUM = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
const STUB = `window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:null}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},from:()=>({select:()=>({eq:()=>({single:async()=>({data:null})})})}),rpc:async()=>({data:null,error:null})})};`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

// ── Static: no blocking dialogs left in the app script ──
const script = readFileSync(INDEX, 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1]
  .split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
check('App script calls no alert()', !/(?<![\w.])alert\(/.test(script));
check('App script calls no confirm()', !/(?<![\w.])confirm\(/.test(script));

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage({ viewport: { width: 360, height: 760 } });
const pageErrors = [];
const dialogs = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });
await page.route('**/*', (r) => {
  const u = r.request().url();
  if (u.startsWith('file://')) return r.continue();
  if (u.includes('@supabase')) return r.fulfill({ contentType: 'application/javascript', body: STUB });
  return r.abort();
});
await page.addInitScript(() => {
  localStorage.setItem('ss_auth_dismissed', 'true');
  localStorage.setItem('ss_install_dismissed', 'true');
  const iso = (h) => new Date(Date.now() - h * 3600e3).toISOString();
  localStorage.setItem('sickleStrongData', JSON.stringify({
    setupComplete: true, currentChildId: 'c1', parentName: 'Jason',
    children: [{ id: 'c1', name: 'Jaxxon', birthDate: '2018-05-01', diseaseType: 'HbSS', weight: 52, waterGoal: 64, waterIntake: 24,
      painLog: [{ id: 1, level: 8, location: 'Chest, Legs', startTime: iso(3), notes: 'Woke up crying' }],
      temperatureLog: [{ id: 3, temperature: 101.2, timestamp: iso(2) }], symptoms: [],
      notes: [{ id: 4, date: iso(5), mood: '😊', text: 'Good day at school' }],
      medications: [{ id: 5, name: 'Hydroxyurea', dose: '500 mg', frequency: 'Once daily', times: ['08:00'] }],
      weightHistory: [] }],
    contacts: [{ id: 7, type: 'doctor', name: 'Dr. Smith', phone: '334-555-0100' }] }));
});
await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof notify === 'function' && typeof askConfirm === 'function');
await page.waitForTimeout(500);

// ── notify ──
const n = await page.evaluate(async () => {
  const r = {};
  notify('✅ Settings saved');
  const t = document.getElementById('ssToast');
  r.shortIsToast = !!t && t.textContent === '✅ Settings saved' && !document.getElementById('ssNotice');
  r.toastPx = parseFloat(getComputedStyle(t).fontSize);
  const order = [];
  notify('First thing\n\nSaid at length.').then(() => order.push(1));
  notify('Second thing\n\nAlso long.').then(() => order.push(2));
  const card = document.getElementById('ssNotice');
  r.longIsCard = !!card && /First thing/.test(card.innerText) && !card.classList.contains('modal');
  r.bodyPx = Math.min(...[...card.querySelectorAll('div div')].filter(d => d.textContent && !d.children.length).map(d => parseFloat(getComputedStyle(d).fontSize)));
  // Code that closes "every .modal" must not take the notice with it
  document.querySelectorAll('.modal').forEach(m => m.remove());
  r.survivesModalClose = !!document.getElementById('ssNotice');
  card.querySelector('button').click();
  await new Promise(res => setTimeout(res, 0));
  r.secondShown = /Second thing/.test(document.getElementById('ssNotice')?.innerText || '');
  document.getElementById('ssNotice').querySelector('button').click();
  await new Promise(res => setTimeout(res, 0));
  r.order = order.join(',');
  r.allGone = !document.getElementById('ssNotice');
  r.escapes = (() => { notify('<img src=x onerror="window.__x=1"> heading\n\nbody'); const c = document.getElementById('ssNotice'); const ok = !c.querySelector('img') && /<img/.test(c.innerText); c.querySelector('button').click(); return ok; })();
  return r;
});
check('Short message shows as a toast', n.shortIsToast);
check('Toast text is 16px', n.toastPx >= 16, String(n.toastPx));
check('Long message shows as a card with OK (not a .modal)', n.longIsCard);
check('Card text is at least 16px', n.bodyPx >= 16, String(n.bodyPx));
check('Card survives code that closes every .modal', n.survivesModalClose);
check('Messages wait their turn and arrive in order', n.secondShown && n.order === '1,2' && n.allGone, n.order);
check('Message text is shown as text, never HTML', n.escapes);

// ── askConfirm ──
const c = await page.evaluate(async () => {
  const r = {};
  const pick = async (which) => {
    const p = askConfirm('Delete this?', { okLabel: 'Delete', danger: true });
    const card = document.getElementById('ssConfirm');
    const [no, yes] = card.querySelectorAll('button');
    if (which === 'yes') yes.click(); else if (which === 'no') no.click(); else card.click();
    return p;
  };
  r.yes = await pick('yes'); r.no = await pick('no'); r.outside = await pick('outside');
  r.labels = (() => { askConfirm('x', { okLabel: 'Remove' }); const t = document.getElementById('ssConfirm').innerText; document.getElementById('ssConfirm').remove(); return t; })();

  // A real delete: Cancel keeps the medication, Delete removes it
  const meds = () => getCurrentChild().medications.length;
  const before = meds();
  const shell = () => { const m = document.createElement('div'); m.className = 'modal'; document.body.appendChild(m); };
  shell(); let p = deleteMedication(5); await new Promise(res => setTimeout(res, 0));
  document.querySelectorAll('#ssConfirm button')[0].click(); await p;
  r.cancelKept = meds() === before;
  p = deleteMedication(5); await new Promise(res => setTimeout(res, 0));
  document.querySelectorAll('#ssConfirm button')[1].click(); await p;
  r.deleteRemoved = meds() === before - 1;
  document.querySelectorAll('.modal').forEach(m => m.remove());
  return r;
});
check('Confirm: the action button answers yes', c.yes === true);
check('Confirm: Cancel answers no', c.no === false);
check('Confirm: a tap outside the card answers no', c.outside === false);
check('Confirm: shows the action name on the button', /Remove/.test(c.labels) && /Cancel/.test(c.labels));
check('Deleting a medication: Cancel keeps it', c.cancelKept);
check('Deleting a medication: Delete removes it', c.deleteRemoved);

// ── Readable text and phone layout across every tab ──
const layout = [];
for (const tab of ['home', 'symptoms', 'hydration', 'emergency', 'education', 'community', 'notes']) {
  await page.evaluate((t) => document.querySelector(`.nav-tab[onclick*="'${t}'"]`).click(), tab);
  await page.waitForTimeout(700);
  layout.push(await page.evaluate((tab) => {
    const W = window.innerWidth;
    const small = new Set();
    document.querySelectorAll('.section.active *, .header *').forEach(el => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || !el.getBoundingClientRect().width) return;
      const ownText = [...el.childNodes].some(nd => nd.nodeType === 3 && nd.textContent.trim());
      if (ownText && parseFloat(cs.fontSize) < 14) small.add(`${el.textContent.trim().slice(0, 20)}(${cs.fontSize})`);
    });
    const truncated = [...document.querySelectorAll('.nav-label')].filter(l => l.scrollWidth > l.clientWidth + 1).map(l => l.textContent.trim());
    return { tab, small: [...small], scroll: document.documentElement.scrollWidth - W, truncated };
  }, tab));
}
const tooSmall = layout.filter(l => l.small.length);
check('Every tab: no text under 14px', !tooSmall.length, tooSmall.map(l => `${l.tab}: ${l.small.slice(0, 3).join(', ')}`).join(' | '));
check('Every tab: nothing runs off the side at 360px', layout.every(l => l.scroll <= 0), layout.filter(l => l.scroll > 0).map(l => l.tab).join(','));
check('Bottom tab labels all fit (none cut off)', layout.every(l => !l.truncated.length), layout[0].truncated.join(','));

check('No browser pop-ups appeared', dialogs.length === 0, dialogs.join(' | '));
check('No uncaught page errors', pageErrors.length === 0, [...new Set(pageErrors)].join(' | '));
await browser.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
