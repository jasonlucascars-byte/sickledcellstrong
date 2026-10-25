// Printable partner card (two per Letter page) for someone who hands
// SickleStrong to families, such as a school nurse. The QR code is drawn by
// the app's own encoder and points at the landing page with the partner's
// code, so sign-ups through the card are counted. Add the code to
// public.referral_codes (label, no account) before printing.
//
//   node tools/partner-card.mjs NURSE-LEXI "Passed along by your school nurse" out/
//   then print out/card.html to PDF (any browser, or Playwright's page.pdf).
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [,, code, footer, outDir = '.'] = process.argv;
if (!/^[A-Z]{2,8}-[A-Z0-9]{4,12}$/.test(code || '')) throw new Error('Usage: partner-card.mjs CODE "footer text" [outDir]');
const appIndex = resolve(ROOT, 'index.html');
const src = readFileSync(appIndex, 'utf8');
const start = src.indexOf('        const QR_EC_PER_BLOCK');
const end = src.indexOf('        function inviteLinkFor(code) {');
const qr = new Function(src.slice(start, end) + '; return qrSvg;')();
const link = `https://sicklestrong-landing-v2.netlify.app/?ref=${code}#join`;
const icon = 'data:image/png;base64,' + readFileSync(resolve(ROOT, 'icon-192.png')).toString('base64');
const card = `
<section class="card">
  <header><img src="${icon}" alt=""><div><div class="brand">SickleStrong</div><div class="tag">For families living with sickle cell disease</div></div></header>
  <h1>Pain, fevers, and medicines,<br>all in one place.</h1>
  <div class="row">
    <ul>
      <li>Log a pain episode or a fever in seconds</li>
      <li>Keep track of medicines and fluids</li>
      <li>Bring a clear report to the doctor or school</li>
      <li>Share care with family and babysitters</li>
    </ul>
    <figure>${qr(link)}<figcaption>Scan with your<br>phone's camera</figcaption></figure>
  </div>
  <p class="how">Opens in your phone's browser. Nothing to install.</p>
  <footer><span>${footer}</span><span>sicklestrong-landing-v2.netlify.app</span></footer>
</section>`;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page { size: Letter; margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; font-family: "Helvetica Neue", Arial, sans-serif; color: #1d2433; }
.sheet { width: 8.5in; height: 11in; padding: 0.35in 0.5in; display: flex; flex-direction: column; justify-content: space-between; }
.card { height: 4.95in; border: 2px solid #0ea89a; border-radius: 18px; padding: 0.3in 0.35in; display: flex; flex-direction: column; }
.cut { text-align: center; color: #9aa3b2; font-size: 10pt; border-top: 1px dashed #b8c0cc; line-height: 0; margin: 0 -0.2in; }
.cut span { background: #fff; padding: 0 8px; }
header { display: flex; align-items: center; gap: 12px; }
header img { width: 52px; height: 52px; border-radius: 12px; }
.brand { font-size: 24pt; font-weight: 800; color: #0a7a70; letter-spacing: -0.5px; }
.tag { font-size: 12pt; color: #5b6475; }
h1 { font-size: 21pt; line-height: 1.2; margin: 0.18in 0 0.12in; }
.row { display: flex; gap: 0.3in; align-items: center; flex: 1; }
ul { margin: 0; padding-left: 20px; font-size: 13.5pt; line-height: 1.55; flex: 1; }
li::marker { color: #e8305a; }
figure { margin: 0; text-align: center; width: 1.9in; }
figure svg { width: 1.9in; height: 1.9in; display: block; }
figcaption { font-size: 11pt; color: #5b6475; margin-top: 2px; }
.how { font-size: 12pt; color: #0a7a70; font-weight: 600; margin: 0.08in 0; }
footer { display: flex; justify-content: space-between; font-size: 10.5pt; color: #5b6475; border-top: 1px solid #e3e7ee; padding-top: 8px; }
</style></head><body><div class="sheet">${card}<div class="cut"><span>✂ cut here</span></div>${card}</div></body></html>`;
writeFileSync(outDir + '/card.html', html);
console.log(link);
