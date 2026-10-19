// Offline-sync suite for SickleStrong.
//
// The failure this pins: a pain crisis logged with no signal was sent once,
// fire-and-forget; the send failed, nothing retried it, and the next time the
// app opened online syncAllFromCloud rebuilt the phone from the cloud alone, so
// the entry vanished from both places. Photos (which never upload) and today's
// water/doses were wiped by the same rebuild.
//
// The real index.html runs against an in-memory fake of the cloud kept in
// sessionStorage (so it survives reloads), whose network can be 'up', 'down',
// or 'ack-lost' (the write lands but the reply never arrives).
//
// Run: node tests/offline-sync.test.mjs

import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_URL = pathToFileURL(resolve(HERE, '..', 'index.html')).href;
const CHROMIUM = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';

const CHILD = '0b9c7a52-1111-4222-8333-444455556666';
const AUTH = 'a0000000-0000-4000-8000-000000000001';
const FAM = 'f0000000-0000-4000-8000-000000000001';

const STUB = `
(() => {
  const load = () => JSON.parse(sessionStorage.getItem('__cloud') || '{}');
  const store = (db) => sessionStorage.setItem('__cloud', JSON.stringify(db));
  const net = () => sessionStorage.getItem('__net') || 'up';
  const down = { data: null, error: { message: 'TypeError: Failed to fetch' } };
  function q(table) {
    const filters = []; let lim = null, op = 'select', payload = null, single = false;
    const run = () => {
      const db = load(); db[table] = db[table] || [];
      if (op === 'insert' || op === 'upsert') {
        if (net() === 'down') return down;
        for (const r of (Array.isArray(payload) ? payload : [payload])) {
          const row = { ...r }; if (!row.id) row.id = crypto.randomUUID();
          const i = db[table].findIndex(x => x.id === row.id);
          if (i >= 0 && op === 'insert') return { data: null, error: { code: '23505', message: 'duplicate key value' } };
          if (i >= 0) db[table][i] = { ...db[table][i], ...row }; else db[table].push(row);
        }
        store(db);
        return net() === 'ack-lost' ? down : { data: null, error: null };
      }
      if (op === 'noop') return { data: null, error: null };
      if (net() === 'down') return down;
      let rows = db[table].filter(r => filters.every(f => f(r)));
      if (lim) rows = rows.slice(0, lim);
      return single ? { data: rows[0] || null, error: null } : { data: rows, error: null };
    };
    const b = {
      select() { return b; }, order() { return b; }, neq() { return b; }, is() { return b; }, gte() { return b; }, lte() { return b; },
      eq(c, v) { filters.push(r => r[c] === v); return b; },
      in(c, vs) { filters.push(r => vs.includes(r[c])); return b; },
      limit(n) { lim = n; return b; },
      insert(p) { op = 'insert'; payload = p; return b; },
      upsert(p) { op = 'upsert'; payload = p; return b; },
      update() { op = 'noop'; return b; }, delete() { op = 'noop'; return b; },
      single() { single = true; return Promise.resolve(run()); },
      maybeSingle() { single = true; return Promise.resolve(run()); },
      then(res, rej) { return Promise.resolve(run()).then(res, rej); }
    };
    return b;
  }
  const user = () => sessionStorage.getItem('__signedIn') ? { id: '${AUTH}', email: 'p@example.com', user_metadata: {} } : null;
  window.supabase = { createClient: () => ({
    auth: {
      getSession: async () => ({ data: { session: user() ? { user: user() } : null } }),
      getUser: async () => ({ data: { user: user() } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: async () => ({ error: null }), signInWithPassword: async () => ({ data: null, error: { message: 'stub' } }),
      signUp: async () => ({ data: null, error: { message: 'stub' } })
    },
    from: q,
    rpc: async (name) => name === 'provision_current_user'
      ? { data: [{ out_family_id: '${FAM}', out_full_name: 'Parent', out_role: 'parent', out_is_primary: true }], error: null }
      : { data: [], error: null }
  }) };
})();`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const browser = await chromium.launch({ executablePath: CHROMIUM });
const pageErrors = [];

const baseChild = (extra = {}) => ({
  id: CHILD, name: 'Jaxxon', diseaseType: 'HbSS', hydrationGoal: 48, waterIntake: 0,
  medications: [], painLog: [], temperatureLog: [], symptoms: [], weightHistory: [], notes: [], ...extra
});
const baseCloud = (extra = {}) => ({
  users: [{ id: 'u1', auth_id: AUTH, family_id: FAM, full_name: 'Parent', role: 'parent', is_primary: true }],
  families: [{ id: FAM, family_code: 'TEST-1' }],
  children: [{ id: CHILD, name: 'Jaxxon', family_id: FAM, disease_type: 'HbSS', is_active: true }],
  ...extra
});

// Opens a fresh tab with a phone state, a cloud state, and a network state.
async function scenario({ phone, cloud, net = 'up', signedIn = true }) {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.route('**/*', (route) => {
    const u = route.request().url();
    if (u.startsWith('file://')) return route.continue();
    if (u.includes('@supabase')) return route.fulfill({ contentType: 'application/javascript', body: STUB });
    return route.abort();
  });
  await page.addInitScript(({ phone, cloud, net, signedIn }) => {
    if (sessionStorage.getItem('__seeded')) return;
    sessionStorage.setItem('__seeded', '1');
    sessionStorage.setItem('__cloud', JSON.stringify(cloud));
    sessionStorage.setItem('__net', net);
    if (signedIn) {
      sessionStorage.setItem('__signedIn', '1');
      localStorage.setItem('sb-test-auth-token', '{}');
    }
    localStorage.setItem('ss_auth_dismissed', 'true');
    localStorage.setItem('sickleStrongData', JSON.stringify(phone));
  }, { phone, cloud, net, signedIn });
  const open = async () => {
    await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => typeof flushOutbox === 'function');
    await page.waitForTimeout(400);
    // Let boot finish any sync/flush in flight.
    await page.evaluate(async () => { try { await flushOutbox(); } catch (e) {} });
    await page.waitForTimeout(100);
  };
  await open();
  const state = () => page.evaluate(() => ({
    phone: JSON.parse(localStorage.getItem('sickleStrongData') || 'null'),
    cloud: JSON.parse(sessionStorage.getItem('__cloud') || '{}'),
    outbox: JSON.parse(localStorage.getItem('ss_outbox') || '[]')
  }));
  const setNet = (n) => page.evaluate((n) => sessionStorage.setItem('__net', n), n);
  return { page, context, open, state, setNet };
}

const phoneWith = (child, extra = {}) => ({ setupComplete: true, currentChildId: CHILD, contacts: [], parentName: 'Parent', children: [child], ...extra });

// ── 1. The reported failure, end to end through the real pain form ──
{
  const s = await scenario({ phone: phoneWith(baseChild()), cloud: baseCloud() });
  await s.setNet('down');
  await s.page.evaluate(() => {
    const m = document.createElement('div'); m.className = 'modal'; document.body.appendChild(m);
    selectPainLevel('Chest', '😣', 5);
    document.getElementById('painNotes').value = 'OFFLINE CRISIS';
    document.getElementById('painRequiredER').checked = true;
    savePainEntry();
  });
  await s.page.waitForTimeout(150);
  let st = await s.state();
  const entry = st.phone.children[0].painLog.find(p => p.notes === 'OFFLINE CRISIS');
  check('Offline pain entry is saved on the phone with a permanent id', !!entry && /^[0-9a-f-]{36}$/.test(entry.cloudId || ''));
  check('Offline pain entry waits in the outbox', st.outbox.length === 1 && st.outbox[0].id === entry?.cloudId);
  check('Nothing reached the cloud while down', (st.cloud.pain_logs || []).length === 0);

  await s.open();                                     // reopen, still no signal
  st = await s.state();
  check('Reopening with no signal keeps the entry', st.phone.children[0].painLog.some(p => p.notes === 'OFFLINE CRISIS'));

  await s.setNet('up');
  await s.open();                                     // reopen with signal
  st = await s.state();
  const cloudRows = st.cloud.pain_logs || [];
  const phoneRows = st.phone.children[0].painLog.filter(p => p.notes === 'OFFLINE CRISIS');
  check('Back online: the entry is uploaded, using its own id', cloudRows.length === 1 && cloudRows[0].id === entry.cloudId);
  check('Back online: the ER visit flag went up with it', cloudRows[0]?.required_er_visit === true);
  check('Back online: exactly one copy on the phone', phoneRows.length === 1);
  check('Back online: outbox is empty', st.outbox.length === 0);

  await s.open();                                     // and once more
  st = await s.state();
  check('Another reopen creates no duplicates anywhere',
    (st.cloud.pain_logs || []).length === 1 && st.phone.children[0].painLog.filter(p => p.notes === 'OFFLINE CRISIS').length === 1);
  await s.context.close();
}

// ── 2. Real temperature form, offline, then the 'online' event delivers it ──
{
  const s = await scenario({ phone: phoneWith(baseChild()), cloud: baseCloud() });
  await s.setNet('down');
  await s.page.evaluate(() => {
    showLogTemperature();
    window.tempHasFever = true;
    document.getElementById('tempValue').value = '102.4';
    saveTemperature();
    document.querySelectorAll('.modal').forEach(m => m.remove());
  });
  await s.page.waitForTimeout(150);
  let st = await s.state();
  check('Offline fever reading is queued', st.outbox.length === 1 && (st.cloud.temperature_logs || []).length === 0);
  await s.setNet('up');
  await s.page.evaluate(() => window.dispatchEvent(new Event('online')));
  await s.page.waitForTimeout(300);
  st = await s.state();
  check('Signal returning ("online") delivers it without a reopen',
    (st.cloud.temperature_logs || []).length === 1 && Number(st.cloud.temperature_logs[0].temperature_f) === 102.4 && st.outbox.length === 0);
  await s.context.close();
}

// ── 3. Write lands but the reply is lost: the retry must not duplicate ──
{
  const s = await scenario({ phone: phoneWith(baseChild()), cloud: baseCloud() });
  await s.setNet('ack-lost');
  await s.page.evaluate(() => {
    const child = getCurrentChild();
    const e = { id: Date.now(), weight: 61, timestamp: new Date().toISOString(), notes: 'w' };
    child.weightHistory.push(e); queueCloudInsert('weight', e); saveData();
  });
  await s.page.waitForTimeout(200);
  let st = await s.state();
  check('Lost reply: entry stays queued even though the cloud has it',
    st.outbox.length === 1 && (st.cloud.weight_logs || []).length === 1);
  await s.setNet('up');
  await s.page.evaluate(() => flushOutbox());
  await s.page.waitForTimeout(150);
  st = await s.state();
  check('Lost reply: retry is recognized as already saved (no duplicate)',
    st.outbox.length === 0 && (st.cloud.weight_logs || []).length === 1);
  await s.context.close();
}

// ── 4. Device-only data survives a sync ──
{
  const synced = '9a9a9a9a-0000-4000-8000-000000000001';
  const s = await scenario({
    phone: phoneWith(baseChild({
      photo: 'data:image/jpeg;base64,PROFILE',
      waterIntake: 24,
      medications: [{ id: 'm-local', cloudId: 'aaaaaaaa-0000-4000-8000-0000000000aa', synced: true, name: 'Hydroxyurea', times: ['08:00'], takenToday: ['08:00'] }],
      painLog: [{ id: synced, level: 3, notes: 'synced earlier', startTime: '2026-10-10T10:00:00.000Z', photo: 'data:image/jpeg;base64,PAINPHOTO', resolved: true }]
    })),
    cloud: baseCloud({
      pain_logs: [{ id: synced, child_id: CHILD, severity: 3, notes: 'synced earlier', what_helped: '["Water", "Rest"]', logged_at: '2026-10-10T10:00:00' }],
      medications: [{ id: 'aaaaaaaa-0000-4000-8000-0000000000aa', child_id: CHILD, name: 'Hydroxyurea', times: ['08:00'], is_active: true }]
    })
  });
  const st = await s.state();
  const c = st.phone.children[0];
  const p = c.painLog.find(x => x.id === synced);
  check('Sync keeps the photo on a pain entry', p?.photo === 'data:image/jpeg;base64,PAINPHOTO');
  check('Sync keeps "resolved" set on the phone', p?.resolved === true);
  check('Sync keeps the profile photo', c.photo === 'data:image/jpeg;base64,PROFILE');
  check("Sync keeps today's water", c.waterIntake === 24);
  check("Sync keeps today's doses checked off", JSON.stringify(c.medications[0]?.takenToday) === '["08:00"]');
  check('"What helped" comes back as a list, not text', Array.isArray(p?.helped) && p.helped.join('|') === 'Water|Rest');
  check('Cloud times are read as UTC (no hours-off shift)', Date.parse(p?.startTime) === Date.parse('2026-10-10T10:00:00Z'));
  await s.context.close();
}

// ── 5. Entries logged before this fix (no cloudId) ──
{
  const t1 = '2026-10-15T08:00:00.000Z', t2 = '2026-10-16T09:30:00.000Z';
  const s = await scenario({
    phone: phoneWith(baseChild({
      temperatureLog: [
        { id: 1760000000001, temperature: 101.8, timestamp: t1 },    // already in the cloud under a random id
        { id: 1760000000002, temperature: 99.1, timestamp: t2 }      // never made it
      ]
    })),
    cloud: baseCloud({ temperature_logs: [{ id: 'cccccccc-0000-4000-8000-000000000001', child_id: CHILD, temperature_f: 101.8, logged_at: '2026-10-15T08:00:00' }] })
  });
  await s.page.waitForTimeout(200);
  const st = await s.state();
  const temps = st.phone.children[0].temperatureLog;
  check('Old entry already in the cloud is recognized, not duplicated',
    temps.filter(t => Date.parse(t.timestamp) === Date.parse(t1)).length === 1);
  check('Old entry that never reached the cloud is kept and uploaded',
    temps.some(t => Date.parse(t.timestamp) === Date.parse(t2)) && (st.cloud.temperature_logs || []).length === 2);
  await s.context.close();
}

// ── 6. Removed in the cloud by another parent stays removed ──
{
  const gone = 'dddddddd-0000-4000-8000-000000000001';
  const s = await scenario({
    phone: phoneWith(baseChild({ notes: [{ id: gone, text: 'deleted by co-parent', date: '2026-10-01T00:00:00Z' }] })),
    cloud: baseCloud()
  });
  const st = await s.state();
  check('An entry deleted in the cloud is not resurrected', !st.phone.children[0].notes.some(n => n.id === gone));
  await s.context.close();
}

// ── 7. A child created on this phone that never reached the cloud ──
{
  const local = baseChild({ id: 1760000000999, name: 'Local Kid' });
  const s = await scenario({ phone: { ...phoneWith(baseChild()), children: [baseChild(), local] }, cloud: baseCloud() });
  const st = await s.state();
  check('A local-only child is not wiped by sync', st.phone.children.some(c => c.name === 'Local Kid'));
  await s.context.close();
}

// ── 8. No account on the phone: nothing is queued ──
{
  const s = await scenario({ phone: phoneWith(baseChild({ id: 1760000000555 }), { currentChildId: 1760000000555 }), cloud: {}, signedIn: false });
  await s.page.evaluate(() => {
    const child = getCurrentChild();
    const e = { id: Date.now(), level: 2, startTime: new Date().toISOString() };
    child.painLog.push(e); queueCloudInsert('pain', e); saveData();
  });
  const st = await s.state();
  check('Without an account, entries are kept but nothing is queued', st.outbox.length === 0 && st.phone.children[0].painLog.length === 1);
  await s.context.close();
}

// ── 9. Sign out refuses to silently erase queued entries ──
{
  const s = await scenario({ phone: phoneWith(baseChild()), cloud: baseCloud() });
  await s.setNet('down');
  await s.page.evaluate(() => {
    const child = getCurrentChild();
    const e = { id: Date.now(), level: 4, startTime: new Date().toISOString(), notes: 'pending' };
    child.painLog.push(e); queueCloudInsert('pain', e); saveData();
  });
  await s.page.evaluate(() => showSignOut());
  await s.page.waitForTimeout(300);
  const warned = await s.page.evaluate(() => /may not have reached/.test(document.getElementById('signOutWarning')?.textContent || ''));
  check('Sign out warns while entries are still waiting to upload', warned);
  await s.context.close();
}

check('No uncaught page errors', pageErrors.length === 0, [...new Set(pageErrors)].join(' | '));

await browser.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
