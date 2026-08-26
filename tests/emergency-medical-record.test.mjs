// Emergency medical record fields.
//
// The gap this closes: an ER asks three things on arrival — drug allergies,
// baseline hemoglobin, last transfusion — and the app could answer none of
// them. It knew medications and nothing else. A doctor report that omits a
// child's allergies is worse than no report, so the tests below care most
// about two things: that a recorded value reaches both report formats, and
// that a MISSING value reads "Not recorded" rather than 0, blank, or
// "undefined" — a clinician must never mistake absence for data.
//
// Run: node tests/emergency-medical-record.test.mjs

import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_URL = pathToFileURL(resolve(HERE, '..', 'index.html')).href;
const CHROMIUM = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';

const STUB = `window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:null}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},from:()=>({select:()=>({eq:()=>({single:async()=>({data:null})})})}),rpc:async()=>({data:null,error:null})})};`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.route('**/*', (route) => {
  const u = route.request().url();
  if (u.startsWith('file://')) return route.continue();
  if (u.includes('@supabase')) return route.fulfill({ contentType: 'application/javascript', body: STUB });
  return route.abort();
});

await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof renderEmergencyInfoCard === 'function');

const out = await page.evaluate(async () => {
  const r = {};
  window.alert = () => {};
  window.confirm = () => true;

  const mkChild = (over = {}) => Object.assign({
    id: 'c1', name: 'Test Child', diseaseType: 'HbSS', weight: 60,
    painLog: [], temperatureLog: [], symptoms: [], medications: [],
    weightHistory: [], notes: [], contacts: []
  }, over);

  // ── 1. Empty state: every field must read "Not recorded" ──
  appData.children = [mkChild()];
  appData.currentChildId = 'c1';
  appData.contacts = [];
  renderEmergencyInfoCard();
  const emptyCard = document.getElementById('emergencyInfoContent').textContent;
  r.emptyCardText = emptyCard.replace(/\s+/g, ' ').trim();
  r.emptyNotRecordedCount = (emptyCard.match(/Not recorded/g) || []).length;
  r.emptyHasZero = /\b0\b/.test(emptyCard);
  r.emptyHasUndefined = /undefined|null|NaN/.test(emptyCard);

  // ── 2. The save path, driven through the real modal ──
  showEditEmergencyInfo();
  document.getElementById('emDrugAllergies').value = 'Penicillin — hives';
  document.getElementById('emBaselineHgb').value = '8.5';
  document.getElementById('emTransfusionDate').value = '2026-06-15';
  document.getElementById('emTransfusionUnits').value = '2';
  saveEmergencyInfo();
  const child = appData.children[0];
  r.saved = {
    allergies: child.drugAllergies,
    hgb: child.baselineHemoglobin,
    date: child.lastTransfusionDate,
    units: child.lastTransfusionUnits
  };
  r.modalClosed = !document.querySelector('.modal.active');
  renderEmergencyInfoCard();
  r.filledCardText = document.getElementById('emergencyInfoContent').textContent.replace(/\s+/g, ' ').trim();

  // ── 3. Validation rejects out-of-range values and keeps the old one ──
  showEditEmergencyInfo();
  document.getElementById('emBaselineHgb').value = '99';
  saveEmergencyInfo();
  r.hgbAfterBadInput = appData.children[0].baselineHemoglobin;   // must still be 8.5
  document.querySelector('.modal.active')?.remove();

  // ── 4. Blank clears back to null, not 0 ──
  showEditEmergencyInfo();
  document.getElementById('emDrugAllergies').value = '';
  document.getElementById('emBaselineHgb').value = '';
  document.getElementById('emTransfusionDate').value = '';
  document.getElementById('emTransfusionUnits').value = '';
  saveEmergencyInfo();
  const cleared = appData.children[0];
  r.clearedToNull = cleared.drugAllergies === null && cleared.baselineHemoglobin === null
                 && cleared.lastTransfusionDate === null && cleared.lastTransfusionUnits === null;
  document.querySelector('.modal.active')?.remove();

  // ── 5. Reports: recorded values reach both formats ──
  const recent = new Date(); recent.setDate(recent.getDate() - 5);
  const old = new Date();    old.setDate(old.getDate() - 200);
  appData.children = [mkChild({
    drugAllergies: 'Penicillin & codeine — hives',   // & checks export stays raw
    baselineHemoglobin: 8.5,
    lastTransfusionDate: '2026-06-15',
    lastTransfusionUnits: 2,
    painLog: [
      { startTime: recent.toISOString(), level: 4, location: 'legs', helped: [], requiredER: true },
      { startTime: recent.toISOString(), level: 3, location: 'arms', helped: [], requiredER: true },
      { startTime: recent.toISOString(), level: 2, location: 'back', helped: [], requiredER: false },
      { startTime: old.toISOString(),    level: 5, location: 'chest', helped: [], requiredER: true } // outside 90d
    ]
  })];
  appData.currentChildId = 'c1';

  showDoctorReport();
  const drModal = document.querySelector('.modal.active');
  r.drText = drModal ? drModal.textContent.replace(/\s+/g, ' ') : '';
  drModal?.remove();

  showSchoolCareSheet();
  const scModal = document.querySelector('.modal.active');
  r.scText = scModal ? scModal.textContent.replace(/\s+/g, ' ') : '';
  scModal?.remove();

  // Capture the .txt downloads
  const realBlob = window.Blob; let captured = '';
  window.Blob = function (parts, opts) { captured = (parts || []).join(''); return new realBlob(parts, opts); };
  const rc = URL.createObjectURL; URL.createObjectURL = () => 'blob:stub';
  const rr = URL.revokeObjectURL; URL.revokeObjectURL = () => {};
  downloadDoctorReport();      r.drTxt = captured; captured = '';
  downloadSchoolCareSheet();   r.scTxt = captured;
  window.Blob = realBlob; URL.createObjectURL = rc; URL.revokeObjectURL = rr;

  // ── 6. Reports with NOTHING recorded must still say "Not recorded" ──
  appData.children = [mkChild()];
  appData.currentChildId = 'c1';
  captured = '';
  window.Blob = function (parts, opts) { captured = (parts || []).join(''); return new realBlob(parts, opts); };
  URL.createObjectURL = () => 'blob:stub'; URL.revokeObjectURL = () => {};
  downloadDoctorReport(); r.drTxtEmpty = captured;
  window.Blob = realBlob; URL.createObjectURL = rc; URL.revokeObjectURL = rr;

  showDoctorReport();
  const m2 = document.querySelector('.modal.active');
  r.drTextEmpty = m2 ? m2.textContent.replace(/\s+/g, ' ') : '';
  m2?.remove();

  // ── 7. XSS: hostile allergy text must not become a live node ──
  window.__xss = 0;
  appData.children = [mkChild({ drugAllergies: '<img src=x onerror="window.__xss++">' })];
  appData.currentChildId = 'c1';
  renderEmergencyInfoCard();
  showDoctorReport();
  const m3 = document.querySelector('.modal.active');
  await new Promise(res => setTimeout(res, 200));
  r.xssFired = window.__xss;
  r.liveImgs = [...document.querySelectorAll('img')].filter(i => (i.getAttribute('onerror') || '').includes('__xss')).length;
  m3?.remove();

  return r;
});

// ── Empty state ──
check('empty card shows "Not recorded" for all three rows',
  out.emptyNotRecordedCount === 3, out.emptyCardText);
check('empty card shows no 0 masquerading as data', out.emptyHasZero === false);
check('empty card shows no undefined/null/NaN', out.emptyHasUndefined === false);

// ── Save path ──
check('modal save stores all four values',
  out.saved.allergies === 'Penicillin — hives' && out.saved.hgb === 8.5
  && out.saved.date === '2026-06-15' && out.saved.units === 2, JSON.stringify(out.saved));
check('modal closes after save', out.modalClosed === true);
check('card renders the saved values',
  out.filledCardText.includes('Penicillin') && out.filledCardText.includes('8.5 g/dL')
  && out.filledCardText.includes('2 units'), out.filledCardText);

// ── Validation ──
check('out-of-range hemoglobin is rejected, previous value kept',
  out.hgbAfterBadInput === 8.5, `got ${out.hgbAfterBadInput}`);
check('blank fields clear to null, not 0', out.clearedToNull === true);

// ── Doctor report ──
check('doctor report modal shows allergies, Hgb and transfusion',
  out.drText.includes('Penicillin') && out.drText.includes('8.5 g/dL') && out.drText.includes('2 units'));
check('doctor report modal counts only in-window ER visits (2, not 3)',
  /Crisis Admissions \(ER \/ hospital\)\s*2/.test(out.drText),
  (out.drText.match(/Crisis Admissions[^A-Z]{0,30}/) || [''])[0]);
check('doctor report .txt carries all three fields',
  out.drTxt.includes('Drug Allergies: Penicillin') && out.drTxt.includes('Baseline Hgb:  8.5 g/dL')
  && out.drTxt.includes('Last Transfusion:'));
check('doctor report .txt counts ER visits',
  /Crisis Admissions \(ER\/hospital\): 2/.test(out.drTxt));
check('doctor report .txt keeps the ampersand RAW (not &amp;)',
  out.drTxt.includes('Penicillin & codeine') && !out.drTxt.includes('&amp;'));

// ── School care sheet: allergies only, deliberately ──
check('school sheet shows drug allergies', out.scText.includes('Penicillin'));
check('school sheet omits hemoglobin and transfusion',
  !out.scText.includes('8.5 g/dL') && !/Transfusion/i.test(out.scText));
check('school sheet .txt shows allergies raw, omits Hgb/transfusion',
  out.scTxt.includes('Drug Allergies: Penicillin & codeine') && !out.scTxt.includes('&amp;')
  && !/Baseline Hgb|Last Transfusion/.test(out.scTxt));

// ── Nothing recorded ──
check('doctor report modal says "Not recorded" when nothing is set',
  (out.drTextEmpty.match(/Not recorded/g) || []).length >= 3);
check('doctor report .txt says "Not recorded" when nothing is set',
  out.drTxtEmpty.includes('Drug Allergies: Not recorded')
  && out.drTxtEmpty.includes('Baseline Hgb:  Not recorded')
  && out.drTxtEmpty.includes('Last Transfusion: Not recorded'));
check('empty report shows 0 crisis admissions, not blank',
  /Crisis Admissions \(ER\/hospital\): 0/.test(out.drTxtEmpty));

// ── XSS ──
check('hostile allergy text never fires', out.xssFired === 0, `__xss=${out.xssFired}`);
check('hostile allergy text never becomes a live node', out.liveImgs === 0);

check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
