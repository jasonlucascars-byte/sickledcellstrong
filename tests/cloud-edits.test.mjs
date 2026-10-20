// Edits and deletes reach the cloud, and their buttons work on synced records.
//
// Records pulled from the cloud carry uuid ids. Buttons were written as
// onclick="editMedication(${med.id})", which for a uuid is a JS syntax error,
// so Edit, Take, and contact Edit/Delete silently did nothing on every synced
// record. Separately, medication edits/deletes and contact deletes never left
// the phone, so the next sync undid them — and server-sent reminders would
// keep firing for a deleted medicine.
//
// Run: node tests/cloud-edits.test.mjs

import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_URL = pathToFileURL(resolve(HERE, '..', 'index.html')).href;
const CHROMIUM = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
// Records every write as [table, op, payload, filter].
const STUB = `window.__w=[];window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:{id:'u1'}}}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},
from:(t)=>({
  update:(row)=>({eq:async(c,v)=>{__w.push([t,'update',row,v]);return{error:null}}}),
  delete:()=>({eq:async(c,v)=>{__w.push([t,'delete',null,v]);return{error:null}}}),
  upsert:async(row)=>{__w.push([t,'upsert',row]);return{error:null}},
  insert:async(row)=>{__w.push([t,'insert',row]);return{error:null}},
  select:()=>({eq:()=>({single:async()=>({data:{family_id:'f1'}})})})}),
rpc:async()=>({data:null,error:null})})};`;

const MED = '1f2e3d4c-0000-4000-8000-00000000aaaa';
const CON = '9a8b7c6d-0000-4000-8000-00000000bbbb';

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
await page.route('**/*', (r) => {
  const u = r.request().url();
  if (u.startsWith('file://')) return r.continue();
  if (u.includes('@supabase')) return r.fulfill({ contentType: 'application/javascript', body: STUB });
  return r.abort();
});
await page.addInitScript(({ MED, CON }) => {
  localStorage.setItem('ss_auth_dismissed', 'true');
  localStorage.setItem('ss_install_dismissed', 'true');
  localStorage.setItem('sb-x-auth-token', '{}'); // an account lives on this phone
  localStorage.setItem('sickleStrongData', JSON.stringify({
    setupComplete: true, currentChildId: 'c1',
    children: [{ id: 'c1', name: 'Jaxxon', diseaseType: 'HbSS', painLog: [], temperatureLog: [], symptoms: [], notes: [], weightHistory: [],
      medications: [{ id: MED, name: 'Hydroxyurea', dose: '500 mg', times: ['08:00'], type: 'daily' }] }],
    contacts: [{ id: CON, type: 'Hematologist', name: 'Dr. Smith', phone: '334-555-0100' }] }));
}, { MED, CON });
await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof editMedication === 'function');
await page.waitForTimeout(400);
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

// ── Medication: Edit button on a synced (uuid) medication ──
const editOpened = await page.evaluate(() => {
  updateUI();
  const btn = [...document.querySelectorAll('button[onclick^="editMedication"]')][0];
  btn.click();
  return !!document.getElementById('editMedName');
});
check('Edit opens for a medication synced from the cloud', editOpened);

await page.evaluate(() => {
  document.getElementById('editMedDose').value = '1000 mg';
  document.querySelector('button[onclick^="saveEditedMedication"]').click();
});
await page.evaluate(tick);
const medUpdate = await page.evaluate((MED) => __w.find((w) => w[0] === 'medications' && w[1] === 'update' && w[3] === MED), MED);
check('Saving an edit updates the cloud row', !!medUpdate && medUpdate[2].dose === '1000 mg' && Array.isArray(medUpdate[2].times), JSON.stringify(medUpdate));

const took = await page.evaluate(() => {
  updateUI();
  const b = document.querySelector('[onclick^="takeMedication"]');
  if (!b) return 'no button';
  b.click();
  return (getCurrentChild().medications[0].takenToday || []).length;
});
check('Take works on a synced medication', took === 1, String(took));

await page.evaluate(() => {
  document.querySelectorAll('.modal').forEach((m) => m.remove());
  editMedication(getCurrentChild().medications[0].id);
  document.querySelector('button[onclick^="deleteMedication"]').click();
});
await page.evaluate(tick);
await page.evaluate(() => document.querySelectorAll('#ssConfirm button')[1].click());
await page.evaluate(tick);
const medDelete = await page.evaluate((MED) => ({
  w: __w.find((w) => w[0] === 'medications' && w[1] === 'update' && w[3] === MED && w[2].is_active === false),
  left: getCurrentChild().medications.length,
}), MED);
check('Deleting a medication turns it off in the cloud (stops reminders, no comeback on sync)', !!medDelete.w && medDelete.left === 0);

// ── Contacts ──
const contactEdit = await page.evaluate(() => {
  document.querySelectorAll('.modal').forEach((m) => m.remove());
  updateUI();
  const b = document.querySelector('[onclick^="showAddContact(\'"]');
  if (!b) return 'no button';
  b.click();
  return document.getElementById('contactName')?.value;
});
check('Edit opens for a contact synced from the cloud', contactEdit === 'Dr. Smith', String(contactEdit));

await page.evaluate(() => document.querySelector('[onclick^="deleteContact"]').click());
await page.evaluate(tick);
await page.evaluate(() => document.querySelectorAll('#ssConfirm button')[1].click());
await page.evaluate(tick);
const conDelete = await page.evaluate((CON) => ({ w: __w.find((w) => w[0] === 'contacts' && w[1] === 'delete' && w[3] === CON), left: appData.contacts.length }), CON);
check('Deleting a contact deletes it in the cloud too', !!conDelete.w && conDelete.left === 0);

// A new contact keeps one cloud id across edits (it used to insert a copy per edit)
const ids = await page.evaluate(async () => {
  const fill = () => {
    document.querySelector('input[name="contactType"]').checked = true;
    document.getElementById('contactName').value = 'Nurse Ann';
    document.getElementById('contactPhone').value = '334-555-0199';
  };
  document.querySelectorAll('.modal').forEach((m) => m.remove());
  showAddContact(); fill(); saveNewContact();
  await new Promise((r) => setTimeout(r, 80));
  const id = appData.contacts[0].id;
  showAddContact(id); fill(); document.getElementById('contactName').value = 'Nurse Ann R.'; saveNewContact(id);
  await new Promise((r) => setTimeout(r, 80));
  return { local: appData.contacts.length, ups: __w.filter((w) => w[0] === 'contacts' && w[1] === 'upsert').map((w) => w[2].id) };
});
check('A new contact keeps the same cloud id when edited', ids.local === 1 && ids.ups.length === 2 && ids.ups[0] && ids.ups[0] === ids.ups[1], JSON.stringify(ids));

check('No uncaught page errors', pageErrors.length === 0, [...new Set(pageErrors)].join(' | '));
await browser.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
