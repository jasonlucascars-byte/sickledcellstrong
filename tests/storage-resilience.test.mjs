// Storage-resilience suite for SickleStrong.
//
// Two failures used to compound into silent data loss:
//
//   1. Photos were stored as raw base64 (`readAsDataURL`, no downscale). A
//      phone photo is 3-8 MB; localStorage caps out around 5 MB. Two photos
//      filled it.
//   2. `saveData()` had no try/catch, so once full it threw. Callers save
//      locally and fire the cloud write on the *next* line, so the throw meant
//      the cloud write never ran either — the entry was lost in both places,
//      with nothing shown to the parent.
//
// For a sickle cell tracker the lost entry is a pain crisis, which is the one
// record a family cannot afford to lose. This suite pins both fixes.
//
// Run: node tests/storage-resilience.test.mjs

import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_URL = pathToFileURL(resolve(HERE, '..', 'index.html')).href;
const CHROMIUM = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';

const STUB = `window.supabase={createClient:()=>({auth:{getSession:async()=>({data:{session:null}}),getUser:async()=>({data:{user:null}}),signUp:async()=>({data:null,error:{message:'stub'}}),signInWithPassword:async()=>({data:null,error:{message:'stub'}}),resetPasswordForEmail:async()=>({data:{},error:null}),updateUser:async()=>({data:{},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})},from:()=>({select:()=>({eq:()=>({single:async()=>({data:null})})})}),rpc:async()=>({data:null,error:null})})};`;

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
await page.waitForFunction(() => typeof saveData === 'function' && typeof compressImageFile === 'function');

const out = await page.evaluate(async () => {
  const r = {};

  // ── 1. Compression: a realistic camera-sized image must shrink a lot ──
  // Build a genuine JPEG-encodable image rather than random bytes, so the
  // measurement reflects what a real photo does.
  const big = document.createElement('canvas');
  big.width = 3024; big.height = 4032;              // ~12 MP, a normal phone photo
  const bctx = big.getContext('2d');
  const grad = bctx.createLinearGradient(0, 0, big.width, big.height);
  grad.addColorStop(0, '#c33'); grad.addColorStop(0.5, '#3c3'); grad.addColorStop(1, '#33c');
  bctx.fillStyle = grad; bctx.fillRect(0, 0, big.width, big.height);
  for (let i = 0; i < 400; i++) {                    // detail, so it can't over-compress
    bctx.fillStyle = `hsl(${(i * 37) % 360},70%,50%)`;
    bctx.fillRect((i * 137) % big.width, (i * 219) % big.height, 90, 90);
  }
  const originalDataUrl = big.toDataURL('image/jpeg', 0.95);
  const blob = await (await fetch(originalDataUrl)).blob();
  const file = new File([blob], 'photo.jpg', { type: 'image/jpeg' });

  r.originalKB = Math.round(originalDataUrl.length / 1024);
  const compressed = await compressImageFile(file);
  r.compressedKB = Math.round(compressed.length / 1024);
  r.stillAnImage = /^data:image\//.test(compressed);

  // Decodes back to a sane size (not a blank or broken image).
  const probe = new Image();
  await new Promise((res) => { probe.onload = res; probe.onerror = res; probe.src = compressed; });
  r.decodedW = probe.width; r.decodedH = probe.height;

  // ── 2. A full device must not throw, and must not block the cloud write ──
  appData.children = [{ id: 'c1', name: 'Test', painLog: [], temperatureLog: [],
                        symptoms: [], medications: [], weightHistory: [], notes: [] }];
  appData.currentChildId = 'c1';

  // Fill storage from a *different* key so appData itself stays small — this
  // isolates "device is full" from "this record is huge".
  let filler = 'x'.repeat(512 * 1024);
  r.fillerChunks = 0;
  try {
    for (let i = 0; i < 40; i++) { localStorage.setItem('__fill_' + i, filler); r.fillerChunks++; }
  } catch (e) { /* full — that's the point */ }

  appData.children[0].painLog.push({ startTime: new Date().toISOString(), level: 5,
                                     location: 'chest', notes: 'CRISIS-MARKER' });

  // Chunked filling leaves sub-chunk headroom, and appData is small, so a
  // real save may still squeak in — correct behavior, but it doesn't exercise
  // the failure path. Force the exact condition instead: make the write itself
  // raise QuotaExceededError, which is what a genuinely full device does.
  const realSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function (k) {
    if (k === 'sickleStrongData') {
      const err = new Error('quota'); err.name = 'QuotaExceededError'; throw err;
    }
    return realSetItem.apply(this, arguments);
  };

  let threw = false, reachedNextLine = false;
  try {
    const ok = saveData();
    r.saveReturned = ok;
    reachedNextLine = true;      // stands in for the cloudSync(...) call site
  } catch (e) {
    threw = true; r.saveThrew = e.name;
  }
  Storage.prototype.setItem = realSetItem;

  r.threw = threw;
  r.cloudWriteWouldStillRun = reachedNextLine;

  // Clean up the filler so the assertion below measures the real state.
  for (let i = 0; i < r.fillerChunks; i++) localStorage.removeItem('__fill_' + i);

  // With space free again, the same save must succeed and persist the crisis.
  const okAfter = saveData();
  r.saveOkAfterSpaceFreed = okAfter;
  r.crisisPersisted = (localStorage.getItem('sickleStrongData') || '').includes('CRISIS-MARKER');

  return r;
});

check('compressImageFile returns an image data URL', out.stillAnImage);
check('compressed photo is under 400 KB',
  out.compressedKB < 400, `${out.originalKB} KB → ${out.compressedKB} KB`);
check('compression achieves at least a 5x reduction',
  out.originalKB / out.compressedKB >= 5,
  `${(out.originalKB / out.compressedKB).toFixed(1)}x`);
check('compressed image still decodes, long edge capped at 1024',
  out.decodedW > 0 && Math.max(out.decodedW, out.decodedH) <= 1024,
  `${out.decodedW}x${out.decodedH}`);

check('storage was actually filled for the test', out.fillerChunks > 0, `${out.fillerChunks} chunks`);
check('saveData does NOT throw when storage is full', out.threw === false, out.saveThrew || '');
check('saveData reports failure via return value', out.saveReturned === false);
check('code after saveData still runs (the cloud write is not skipped)',
  out.cloudWriteWouldStillRun === true);
check('save succeeds again once space is freed', out.saveOkAfterSpaceFreed === true);
check('the pain crisis persists locally after recovery', out.crisisPersisted === true);
check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
