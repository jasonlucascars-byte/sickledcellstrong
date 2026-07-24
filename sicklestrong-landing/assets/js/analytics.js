/* analytics.js — one clean analytics layer with NO fake configuration.
   ------------------------------------------------------------------
   Nothing is sent unless YOU connect a real provider below. Until then
   events are collected in window.ssAnalytics.queue for inspection in the
   console — they are NOT reported anywhere, and this file never pretends
   otherwise.

   Event names used by the page:
     beta_cta_click, demo_open, beta_form_start,
     beta_form_submit_success, beta_form_submit_error,
     app_open, facebook_group_click, privacy_page_click

   A signup conversion (beta_form_submit_success) is fired by signup.js
   ONLY after the backend confirms the record was saved.

   To enable a provider, pick ONE option:

   1) Plausible (privacy-friendly, recommended for a health audience)
      - Add to each page <head>:
          <script defer data-domain="YOUR-DOMAIN"
                  src="https://plausible.io/js/script.js"></script>
      - Add plausible.io to connect-src/script-src in netlify.toml CSP.
      - This layer will auto-detect window.plausible and forward events.

   2) GA4
      - Add the gtag.js snippet with your real Measurement ID (never a
        placeholder like G-XXXXXXXXXX).
      - Add the Google endpoints to the CSP.
      - This layer auto-detects window.gtag and forwards events.

   3) Your own endpoint
      - Set window.ssAnalytics.report = function (name, props) { ... }
        before this script runs, or edit forward() below.
*/
(function () {
  var api = {
    enabled: false,          // becomes true only when a provider is detected/set
    queue: [],               // events captured while no provider is connected
    debug: false,            // set true to console.log every event locally
    report: null             // optional custom reporter: function(name, props)
  };

  function forward(name, props) {
    // 1) custom reporter takes priority
    if (typeof api.report === "function") { api.report(name, props); return true; }
    // 2) Plausible
    if (typeof window.plausible === "function") { window.plausible(name, { props: props }); return true; }
    // 3) GA4
    if (typeof window.gtag === "function") { window.gtag("event", name, props || {}); return true; }
    return false;
  }

  api.track = function (name, props) {
    if (!name) return;
    props = props || {};
    if (api.debug) { try { console.log("[analytics]", name, props); } catch (e) {} }
    var delivered = forward(name, props);
    api.enabled = delivered;
    if (!delivered) {
      // No provider connected — keep a local record WITHOUT claiming it was sent.
      api.queue.push({ name: name, props: props, at: Date.now(), sent: false });
    }
  };

  window.ssAnalytics = api;
  // Convenience global used throughout the page.
  window.ssTrack = function (name, props) { api.track(name, props); };
})();
