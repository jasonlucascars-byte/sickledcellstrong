// XSS render-escaping suite for SickleStrong.
//
// The threat model that makes this matter: per-child sharing means one
// person's records render in another person's browser after cloud sync. A
// report-tier caregiver (least-trusted role) can write pain notes/helped/
// locations; a full-access member can write child.name and much else. Every
// such value must arrive at an HTML render site escaped.
//
// Three deliverables, mirroring the brief:
//   1. Hostile values in user fields render inert (raw < / " never survive).
//   2. The plain-text exports stay RAW readable (no &amp;/&#39; corruption).
//   3. A live-DOM guard: the payloads, inserted into document.body, never fire.
//
// Run: node tests/xss-escaping.test.mjs
// Requires Playwright with a Chromium build. In this project's web sessions
// Chromium is at /opt/pw-browsers/chromium (PW_CHROMIUM env overrides it).
// Loads ../index.html over file:// and stubs the Supabase CDN, so it needs no
// server and touches no network.

import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_URL = pathToFileURL(resolve(HERE, '..', 'index.html')).href;
const CHROMIUM = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';

const SUPABASE_STUB = `
(function () {
  const result = { data: null, error: null };
  function chain() {
    const p = new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'then') return (res) => Promise.resolve(result).then(res);
        if (prop === 'catch') return () => p;
        return chain();
      },
      apply() { return chain(); }
    });
    return p;
  }
  window.supabase = { createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: null } }),
      getUser: async () => ({ data: { user: null } }),
      signInWithPassword: async () => ({ data: null, error: { message: 'stub' } }),
      signUp: async () => ({ data: null, error: { message: 'stub' } }),
      signOut: async () => ({}),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } })
    },
    from: () => chain(), rpc: async () => ({ data: null, error: null }),
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel() {}
  }) };
})();
`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROMIUM });
const page = await browser.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(e.message));

await page.route('**/*', (route) => {
  const url = route.request().url();
  if (url.startsWith('file://')) return route.continue();
  if (url.includes('cdn.jsdelivr.net/npm/@supabase'))
    return route.fulfill({ contentType: 'application/javascript', body: SUPABASE_STUB });
  return route.abort();   // fonts, service worker, everything else offline
});

await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => typeof renderSymptomHistory === 'function');
await page.waitForTimeout(300);

const out = await page.evaluate(async () => {
  const r = { renders: {}, reportRaw: {}, unit: {} };
  window.__xss = 0;                       // bumped ONLY by an onerror that fires
  window.__alerts = 0;                    // app dialogs — expected, not a breakout
  window.alert = () => { window.__alerts++; };
  window.confirm = () => false;
  window.prompt = () => null;

  // ── unit-level: the two helpers behave as the brief requires ──
  r.unit.escapeHtml = escapeHtml(`<img src=x onerror="alert(1)">`);
  r.unit.jsArgQuote = jsArg(`'); alert(1); //`);   // must contain no raw ' or (
  r.unit.jsArgPhone = jsArg('+1 (555) 123-4567');  // round-trips to the number

  // Distinct payloads so a leak names its own vector.
  const P = (tag) => `<img src=x onerror="window.__xss++" data-x="${tag}">`;
  const ATTR = 'x" onerror="window.__xss++';        // attribute breakout attempt
  const JSB = `'); window.__xss++; ('`;             // js-string breakout attempt

  const child = {
    id: 'CHILD-XSS', name: P('name'), emoji: P('emoji'),
    diseaseType: 'HbSS', weight: 42, birthDate: '2015-01-01', displayAge: '10',
    photo: '', currentChildId: undefined,
    painLog: [
      { startTime: new Date().toISOString(), level: 5, location: P('painloc'),
        emoji: P('painemoji'), helped: [P('painhelped')], notes: P('painnotes'),
        temperature: 102, photoUri: ATTR },
      { startTime: new Date(Date.now()-1e6).toISOString(), level: 4, location: 'arm',
        helped: [], notes: '' },
      { startTime: new Date(Date.now()-2e6).toISOString(), level: 3, location: 'leg',
        helped: [], notes: '' }
    ],
    temperatureLog: [
      { timestamp: new Date().toISOString(), temperature: 103, notes: P('tempnotes') }
    ],
    symptoms: [
      { timestamp: new Date().toISOString(), symptoms: [P('symname')], severity: 4,
        duration: P('symdur'), helped: [P('symhelped')], notes: P('symnotes'), photo: ATTR }
    ],
    medications: [
      { id: 1, name: P('medname'), dose: P('meddose'), instructions: P('medinstr'),
        doctor: P('meddoctor'), pharmacy: P('medpharm'), times: ['08:00'], type: 'daily',
        critical: false }
    ],
    weightHistory: [
      { date: '2026-08-01', weight: 42, notes: P('wtnotes'), timestamp: new Date().toISOString() }
    ],
    notes: [
      { date: new Date().toISOString(), mood: P('notemood'), text: P('notetext') }
    ]
  };

  window.appData = window.appData || {};
  appData.children = [child];
  appData.currentChildId = 'CHILD-XSS';
  appData.contacts = [
    { id: 'c1', name: P('cname'), type: 'doctor', phone: JSB, email: JSB,
      address: P('caddr'), notes: P('cnotes'), isPrimary: true }
  ];
  appData.parentName = P('parent');
  appData.parentRelation = P('relation');

  const run = (label, fn) => {
    try { fn(); r.renders[label] = 'ok'; }
    catch (e) { r.renders[label] = 'ERR: ' + e.message; }
  };
  run('renderSymptomHistory', () => renderSymptomHistory());
  run('renderMedications',    () => renderMedications());
  run('renderContacts',       () => renderContacts());
  run('renderWeightHistory',  () => renderWeightHistory());
  run('renderNotes',          () => renderNotes());
  run('renderChildDropdown',  () => renderChildDropdown());
  run('updateUI',             () => updateUI());
  run('showPainPatterns',     () => showPainPatterns());
  run('showDoctorReport',     () => showDoctorReport());
  run('showSchoolCareSheet',  () => showSchoolCareSheet());
  run('changeChildIcon',      () => changeChildIcon());
  run('showAddContact',       () => showAddContact('c1'));
  run('editMedication',       () => editMedication(1));
  run('showLogTemperature',   () => showLogTemperature());

  // The real test of a breakout: did any payload PARSE into a live element?
  // A correctly-escaped payload stays inert text (&lt;img …); an unescaped one
  // becomes a real <img onerror> node in the DOM. Collect any that carry our
  // marker, and record which field (data-x) each came from.
  r.liveNodes = [...document.querySelectorAll('img,script,svg')]
    .filter(n => ((n.getAttribute('onerror') || '') + (n.getAttribute('onload') || '')).includes('__xss')
              || (n.dataset && n.dataset.x))
    .map(n => n.dataset && n.dataset.x ? n.dataset.x : n.tagName.toLowerCase());
  // Positive control: confirm the fields were actually exercised, in escaped
  // form — the escaped payload text (&lt;img … data-x=&quot;TAG&quot;) must be
  // present in the body markup for the vectors we claim to cover.
  // In TEXT content the serializer escapes < > & but NOT " (quotes only matter
  // inside attributes), so a correctly-escaped payload reads back as:
  //   &lt;img src=x onerror="window.__xss++" data-x="TAG"&gt;
  r.escapedSeen = {};
  const body = document.body.innerHTML;
  for (const tag of ['name','painnotes','painhelped','painloc','symnotes','medname','cnotes','notetext']) {
    r.escapedSeen[tag] = body.includes(`&lt;img src=x onerror="window.__xss++" data-x="${tag}"&gt;`);
  }

  // ── Export inverse guard: raw readable text, no entity corruption ──
  const realBlob = window.Blob;
  let captured = '';
  window.Blob = function (parts, opts) { captured = (parts || []).join(''); return new realBlob(parts, opts); };
  const realCOU = URL.createObjectURL; URL.createObjectURL = () => 'blob:stub';
  const realROU = URL.revokeObjectURL; URL.revokeObjectURL = () => {};
  // Give the exports human names with an ampersand and an apostrophe.
  child.name = `Sarah O'Brien & Sons`;
  child.medications[0].name = `Tylenol & Codeine`;
  child.medications[0].dose = `5mg "as needed"`;
  appData.contacts[0].name = `Dr. O'Neil & Associates`;
  appData.contacts[0].phone = '555-1234';

  try { downloadDoctorReport(); r.reportRaw.doctor = captured; } catch (e) { r.reportRaw.doctorErr = e.message; }
  captured = '';
  try { downloadSchoolCareSheet(); r.reportRaw.school = captured; } catch (e) { r.reportRaw.schoolErr = e.message; }
  captured = '';
  // exportAllData serializes appData wholesale rather than interpolating by
  // hand, so this is really a guard on the storage invariant: escaping must
  // happen at the render site, never at the sync boundary. If anyone ever
  // escapes on the way *into* appData, the raw values below stop matching.
  try { exportAllData(); r.reportRaw.allData = captured; } catch (e) { r.reportRaw.allDataErr = e.message; }

  window.Blob = realBlob; URL.createObjectURL = realCOU; URL.revokeObjectURL = realROU;

  // exportNotes builds a mailto: URL and assigns window.location.href. That
  // assignment cannot be observed from a test — Location is [Unforgeable], so
  // the href setter can't be stubbed, and an unhandled mailto: navigation
  // fires no event. So this one is guarded statically instead: the regression
  // it must not have is a well-meaning escapeHtml()/jsArg() wrapped around a
  // field, which would send a clinician "Sarah O&#39;Brien". Combined with the
  // exportAllData check above (appData holds raw values), a builder that calls
  // no escaper produces raw output by construction.
  r.notesSource = typeof exportNotes === 'function' ? exportNotes.toString() : '';

  // Let any onerror handlers on inserted <img> nodes get a chance to fire.
  await new Promise(res => setTimeout(res, 250));
  r.xssFired = window.__xss;
  r.alertCount = window.__alerts;
  return r;
});

// ── Assertions ──────────────────────────────────────────────────────────
check('escapeHtml neutralizes a script payload',
  out.unit.escapeHtml === '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;', out.unit.escapeHtml);
check('jsArg leaves no raw quote or paren',
  !/['()]/.test(out.unit.jsArgQuote), JSON.stringify(out.unit.jsArgQuote));
check('jsArg escapes to hex (no HTML/JS-special chars survive)',
  /^[\x20-\x7e]*$/.test(out.unit.jsArgPhone) && !/[<>"'`&]/.test(out.unit.jsArgPhone),
  JSON.stringify(out.unit.jsArgPhone));

const renderErrs = Object.entries(out.renders).filter(([, v]) => v !== 'ok');
check('all render entry points ran without throwing',
  renderErrs.length === 0, renderErrs.map(([k, v]) => `${k}:${v}`).join(' | '));

check('no payload parsed into a live DOM node',
  out.liveNodes.length === 0, 'leaked via: ' + out.liveNodes.join(', '));
check('no injected onerror handler ever fired (window.__xss stayed 0)',
  out.xssFired === 0, `__xss=${out.xssFired} (app alert()s: ${out.alertCount})`);

// Confirmed live vectors called out by the brief: each must appear in ESCAPED
// form in the markup (proves the field rendered and was neutralized), and must
// NOT appear among the live breakout nodes.
for (const tag of ['name', 'painnotes', 'painhelped', 'painloc']) {
  check(`vector "${tag}" rendered escaped, not as a live node`,
    out.escapedSeen[tag] === true && !out.liveNodes.includes(tag),
    `escapedSeen=${out.escapedSeen[tag]} live=${out.liveNodes.includes(tag)}`);
}

// Export inverse guard.
const d = out.reportRaw.doctor || '';
check('doctor report contains raw ampersand (not &amp;)',
  d.includes("Sarah O'Brien & Sons") && !d.includes('&amp;'),
  out.reportRaw.doctorErr || JSON.stringify(d.split('\n').find(l => l.includes('Sarah')) || ''));
check('doctor report keeps med "&" and \'"\' raw',
  d.includes('Tylenol & Codeine') && d.includes('5mg "as needed"') && !d.includes('&amp;') && !d.includes('&quot;'));
const s = out.reportRaw.school || '';
check('school care sheet contains raw ampersand + apostrophe',
  s.includes("Dr. O'Neil & Associates") && !s.includes('&amp;') && !s.includes('&#39;'),
  out.reportRaw.schoolErr || JSON.stringify(s.split('\n').find(l => l.includes("O'Neil")) || ''));

// exportAllData: parse it back rather than substring-matching, because JSON
// escaping (\" for a quote) is not HTML escaping and would confuse a raw
// text search. The values must come back byte-identical to what was stored.
let parsedAll = null, parseErr = '';
try { parsedAll = JSON.parse(out.reportRaw.allData || ''); } catch (e) { parseErr = e.message; }
check('exportAllData produced parseable JSON',
  parsedAll !== null, out.reportRaw.allDataErr || parseErr);
const exportedChild = parsedAll && (parsedAll.children || []).find(c => /Sarah/.test(c.name || ''));
const exportedMed = exportedChild && (exportedChild.medications || [])[0];
check('exportAllData keeps the child name raw (not entity-encoded)',
  !!exportedChild && exportedChild.name === "Sarah O'Brien & Sons",
  exportedChild ? JSON.stringify(exportedChild.name) : 'child not found in export');
check('exportAllData keeps medication name and dose raw',
  !!exportedMed && exportedMed.name === 'Tylenol & Codeine' && exportedMed.dose === '5mg "as needed"',
  exportedMed ? JSON.stringify([exportedMed.name, exportedMed.dose]) : 'medication not found');
check('exportAllData contains no HTML entities anywhere',
  !/&(amp|quot|#39|lt|gt);/.test(out.reportRaw.allData || ''),
  (out.reportRaw.allData || '').match(/&(amp|quot|#39|lt|gt);/g)?.slice(0, 5).join(' ') || '');

// exportNotes: static guard — see the comment at the capture site for why this
// one cannot be exercised behaviorally.
check('exportNotes calls no escaper (stays raw for the recipient)',
  out.notesSource.length > 0
    && !/\bescapeHtml\s*\(/.test(out.notesSource)
    && !/\bjsArg\s*\(/.test(out.notesSource),
  out.notesSource.length === 0
    ? 'exportNotes not found on the page'
    : (out.notesSource.match(/\b(escapeHtml|jsArg)\s*\(/g) || []).join(' '));

check('no uncaught page errors during the run',
  pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
