/* theme.js — runs synchronously in <head> BEFORE first paint so the
   correct theme is applied with no flash. Keep this file tiny and
   free of dependencies. The toggle button is wired up in main.js. */
(function () {
  try {
    var stored = localStorage.getItem("ss-theme");
    if (stored === "light" || stored === "dark") {
      document.documentElement.setAttribute("data-theme", stored);
    }
    /* If nothing stored, we intentionally leave it to the CSS
       prefers-color-scheme media query (no attribute set). */
  } catch (e) { /* private mode / storage blocked — fall back to OS theme */ }
})();
