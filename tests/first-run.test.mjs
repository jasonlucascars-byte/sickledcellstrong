// First-run polish suite for SickleStrong.
//
// What a new family sees in the first two minutes, on a phone:
//   - "Add myself" (a teen or adult tracking their own care) must never be
//     shown "your child" headings — they used to be computed once at page load
//   - the avatar picker and bottom menu must fit the screen (both overflowed)
//   - the pain-free card is computed from the log, not a stored 0
//   - no claims the app can't back up ("the only app", 15-minute reminders)
//
// Run: node tests/first-run.test.mjs

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
const pageErrors = [];

async function phone(width) {
  const ctx = await browser.newContext({ viewport: { width, height: 800 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => pageErrors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.route('**/*', (r) => {
    const u = r.request().url();
    if (u.startsWith('file://')) return r.continue();
    if (u.includes('@supabase')) return r.fulfill({ contentType: 'application/javascript', body: STUB });
    return r.abort();
  });
  await page.goto(INDEX_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => typeof renderWizard === 'function');
  return { ctx, page };
}

// Walks the wizard as "Add myself", collecting every heading shown.
async function walkSelf(page) {
  return page.evaluate(() => {
    const seen = [];
    selectProfileMode('self');
    const fill = () => {
      const c = document.getElementById('wizardContent');
      c.querySelectorAll('input[type=text],input:not([type])').forEach(el => { if (!el.value) el.value = 'Maya'; });
      c.querySelectorAll('input[type=email]').forEach(el => { if (!el.value) el.value = 'mom@example.com'; });
      c.querySelectorAll('input[type=tel]').forEach(el => { if (!el.value) el.value = '3345551212'; });
      c.querySelectorAll('input[type=number]').forEach(el => { if (!el.value) el.value = '110'; });
      c.querySelectorAll('input[type=date]').forEach(el => { if (!el.value) el.value = '2010-03-14'; });
      if (c.querySelector('.disease-option')) selectDiseaseType('HbSS');
    };
    for (let i = 0; i < 8; i++) {
      seen.push({
        title: document.querySelector('.wizard-title')?.textContent || '',
        subtitle: document.querySelector('.wizard-subtitle')?.textContent || '',
        body: document.getElementById('wizardContent')?.innerText || ''
      });
      if (i === 7) break;
      fill();
      nextWizardStep();
    }
    return seen;
  });
}

for (const width of [390, 360]) {
  const { ctx, page } = await phone(width);

  if (width === 390) {
    const welcome = await page.evaluate(() => document.getElementById('wizardContent').closest('.setup-wizard, body').innerText);
    check('Welcome screen makes no "only app" claim', !/the only app/i.test(welcome));
  }

  const steps = await walkSelf(page);
  // Step 0 is the chooser itself, which rightly mentions both.
  const childWords = steps.slice(1).filter(s => /your child|child profile|parent\/caregiver/i.test(s.title + ' ' + s.subtitle));
  check(`[${width}px] "Add myself" never shows child/parent headings`, childWords.length === 0,
    childWords.map(s => s.title + ' / ' + s.subtitle).join(' | '));
  const done = steps[steps.length - 1];
  check(`[${width}px] "Add myself" finish screen talks about your care, not your child's`,
    /your care/i.test(done.body) && !/your child's care/i.test(done.body));
  const notif = steps.find(s => /Notifications/.test(s.title));
  // Dose reminders are real now (server push), but only with an account —
  // the step has to say so rather than imply they just start.
  check(`[${width}px] Notification step is honest: reminders need an account`,
    !!notif && /account/i.test(notif.body) && !/never miss/i.test(notif.title + notif.subtitle + notif.body));

  // Avatar picker fits the card.
  const overflow = await page.evaluate(() => {
    wizardStep = 2; renderWizard();
    const card = document.getElementById('wizardContent').getBoundingClientRect();
    return [...document.querySelectorAll('#wizardContent button')]
      .filter(b => b.getAttribute('onclick')?.startsWith('selectEmoji'))
      .some(b => b.getBoundingClientRect().right > card.right + 1);
  });
  check(`[${width}px] Avatar picker stays inside the card`, !overflow);

  // Finish setup and look at the dashboard.
  await page.evaluate(() => { wizardStep = wizardSteps.length - 1; renderWizard(); completeSetup(); });
  await page.waitForTimeout(400);
  const nav = await page.evaluate(() => {
    const bar = document.querySelector('.nav-tabs');
    const tabs = [...bar.querySelectorAll('.nav-tab')];
    return { fits: bar.scrollWidth <= bar.clientWidth + 1, allVisible: tabs.every(t => t.getBoundingClientRect().right <= window.innerWidth + 1) };
  });
  check(`[${width}px] All bottom-menu tabs fit on screen`, nav.fits && nav.allVisible);

  const stats = await page.evaluate(() => {
    const cards = [...document.querySelectorAll('.quick-stats .stat-card')].map(c => c.getBoundingClientRect().top);
    return { oneRow: new Set(cards.map(Math.round)).size === 1, value: document.getElementById('daysPainFree').textContent,
             label: document.getElementById('daysPainFreeLabel').textContent };
  });
  check(`[${width}px] The three stat cards sit in one row`, stats.oneRow);
  if (width === 390) {
    check('New profile: pain card is positive, not a flat 0', stats.value !== '0' && /no pain logged/i.test(stats.label), `${stats.value} ${stats.label}`);

    const computed = await page.evaluate(() => {
      const child = getCurrentChild();
      const d = new Date(); d.setDate(d.getDate() - 3);
      child.painLog = [{ id: 1, level: 3, startTime: d.toISOString() }];
      renderPainFreeStat(child);
      const three = document.getElementById('daysPainFree').textContent + '|' + document.getElementById('daysPainFreeLabel').textContent;
      child.painLog.push({ id: 2, level: 2, startTime: new Date().toISOString() });
      renderPainFreeStat(child);
      const today = document.getElementById('daysPainFree').textContent;
      return { three, today };
    });
    check('Pain-free days are counted from the last pain entry', computed.three === '3|Days Pain-Free', computed.three);
    check('Pain logged today resets the count to 0', computed.today === '0');

    const community = await page.evaluate(() => { renderCommunityPosts(); return document.getElementById('community').innerText; });
    check('Community shows no invented posts or like counts',
      !/Kim|Beta Family Member|days? ago|week ago|❤️/.test(community) && /Jason, SickleStrong Founder/.test(community));
    check('Community has no expired event to register for', !/World Sickle Cell Day 2026/.test(community));

    const settings = await page.evaluate(() => { showSettings(); const t = document.querySelector('.modal').innerText; document.querySelector('.modal').remove(); return t; });
    check('Settings no longer says "Testing Phase"', !/testing phase/i.test(settings));
  }
  await ctx.close();
}

check('No uncaught page errors', pageErrors.length === 0, [...new Set(pageErrors)].join(' | '));
await browser.close();
const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
