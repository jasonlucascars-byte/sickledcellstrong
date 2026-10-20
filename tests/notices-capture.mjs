// Shared by the suites: the app no longer uses alert()/confirm(), so a
// Playwright 'dialog' listener sees nothing. This init script records every
// toast and notice card the app shows into window.__notices (in order) and
// taps OK on notice cards so queued ones keep coming, the way the old
// `page.on('dialog', d => d.accept())` did. Confirm cards are left alone —
// a test that needs one answers it itself.
//
//   await page.addInitScript(CAPTURE_NOTICES);
//   const seen = await page.evaluate(() => window.__notices);

export const CAPTURE_NOTICES = () => {
  window.__notices = [];
  const seen = new WeakSet();
  const grab = (el) => {
    if (!el || seen.has(el)) return;
    seen.add(el);
    window.__notices.push(el.innerText || el.textContent || '');
    if (el.id === 'ssNotice') setTimeout(() => el.querySelector('button')?.click(), 0);
  };
  new MutationObserver(() => {
    grab(document.getElementById('ssToast'));
    grab(document.getElementById('ssNotice'));
  }).observe(document, { childList: true, subtree: true });
};
