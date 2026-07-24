/* signup.js — production beta-signup + founding-family counter.
   Talks to Netlify Functions, which hold the ONLY secret (the Supabase
   service-role key). No secret ever appears in this browser code.

   Flow:
     1. On load, fetch the aggregate counter and update copy + CTAs.
     2. Validate in the browser, then POST to the function (which
        validates again on the server) and waits for confirmation.
     3. Only after the backend confirms a saved record do we show
        success and fire the beta_form_submit_success conversion. */
(function () {
  "use strict";

  var SIGNUP_ENDPOINT = "/.netlify/functions/beta-signup";
  var COUNT_ENDPOINT  = "/.netlify/functions/beta-count";
  var APP_URL = "https://sicklestrong-v2.netlify.app/";
  var FB_URL  = "https://www.facebook.com/groups/1343740994540360";
  var FOUNDING_LIMIT = 50;

  var track = window.ssTrack || function () {};
  var form = document.getElementById("beta-form");
  var success = document.getElementById("beta-success");
  var alertBox = document.getElementById("form-alert");
  var submitBtn = document.getElementById("beta-submit");
  var scarcity = document.getElementById("scarcity");

  /* ---------------- counter ---------------- */
  function setScarcity(text) { if (scarcity) scarcity.querySelector(".txt").textContent = text; }

  function setWaitlistMode(on) {
    document.querySelectorAll("[data-cta-beta]").forEach(function (el) {
      el.textContent = on ? "Join the Waitlist" : (el.getAttribute("data-label-default") || el.textContent);
    });
    if (submitBtn) submitBtn.textContent = on ? "Join the Waitlist" : "Join the Founding Beta";
  }

  function loadCount() {
    if (!("fetch" in window)) return;
    fetch(COUNT_ENDPOINT, { headers: { Accept: "application/json" } })
      .then(function (r) { if (!r.ok) throw new Error("count " + r.status); return r.json(); })
      .then(function (d) {
        if (!d || d.ok !== true) throw new Error("count payload");
        var limit = d.founding_limit || FOUNDING_LIMIT;
        var remaining = typeof d.spots_remaining === "number" ? d.spots_remaining : Math.max(0, limit - (d.founding_count || 0));
        if (d.waitlist || remaining <= 0) {
          setWaitlistMode(true);
          setScarcity("All " + limit + " founding-family spots are full — join the waitlist to be next in line.");
        } else {
          setWaitlistMode(false);
          setScarcity(remaining + " of " + limit + " founding-family spots remaining.");
        }
      })
      .catch(function () {
        /* Endpoint unavailable (e.g. before deploy) — keep the honest fallback. */
        setScarcity("A limited number of founding-family spots are available.");
      });
  }
  loadCount();

  if (!form) return;

  /* ---------------- helpers ---------------- */
  function setErr(id, msg) {
    var input = document.getElementById(id);
    var err = document.getElementById("err-" + id);
    if (err) err.textContent = msg || "";
    if (input) { if (msg) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid"); }
  }
  function clearErrors() {
    ["firstName", "email", "careRole"].forEach(function (id) { setErr(id, ""); });
    var c = document.getElementById("err-consent"); if (c) c.textContent = "";
    if (alertBox) { alertBox.className = "form-alert"; alertBox.textContent = ""; }
  }
  function showAlert(kind, msg) {
    if (!alertBox) return;
    alertBox.className = "form-alert show " + kind;
    alertBox.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M12 8v5M12 16h.01"/></svg><span></span>';
    alertBox.querySelector("span").textContent = msg;
  }
  function emailOk(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254; }
  function getUTM() {
    var p = new URLSearchParams(window.location.search);
    return { source: p.get("utm_source"), medium: p.get("utm_medium"), campaign: p.get("utm_campaign") };
  }

  /* beta_form_start — fire once on first real interaction */
  var started = false;
  form.addEventListener("input", function () {
    if (!started) { started = true; track("beta_form_start", {}); }
  }, { once: false });

  function showSuccess(duplicate, founding, status) {
    form.hidden = true;
    if (!success) return;
    var h = success.querySelector("h3");
    var p = success.querySelector("p.msg");
    var badge = success.querySelector(".badge");

    // Waitlisted when the backend says so (status) or the record isn't a
    // founding family. Messaging always reflects the stored status, including
    // for duplicates.
    var waitlisted = status === "waitlisted" || founding === false;
    var heading, body;

    if (waitlisted) {
      heading = duplicate ? "You're already on the SickleStrong waitlist." : "You're on the SickleStrong waitlist.";
      body = "We saved your information and will contact you when another beta spot becomes available.";
    } else {
      heading = duplicate ? "You're already a SickleStrong founding family." : "You're officially a SickleStrong founding family.";
      body = "Your signup has been saved. You can open SickleStrong now or join the private beta community.";
    }

    if (h) h.textContent = heading;
    if (p) p.textContent = body;
    if (badge) badge.hidden = waitlisted; // founding badge only for founding families
    success.classList.add("show");
    if (success.focus) success.focus();
  }

  /* ---------------- submit ---------------- */
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    clearErrors();

    var firstName = document.getElementById("firstName").value.trim();
    var email = document.getElementById("email").value.trim().toLowerCase();
    var careRole = document.getElementById("careRole").value;
    var referral = document.getElementById("referral").value.trim();
    var consent = document.getElementById("consent").checked;
    var honey = (document.getElementById("company") || {}).value || "";

    var firstInvalid = null;
    if (!firstName || firstName.length > 80) { setErr("firstName", "Please enter your first name (up to 80 characters)."); firstInvalid = firstInvalid || "firstName"; }
    if (!email) { setErr("email", "Please enter your email address."); firstInvalid = firstInvalid || "email"; }
    else if (!emailOk(email)) { setErr("email", "Please enter a valid email address."); firstInvalid = firstInvalid || "email"; }
    if (!careRole) { setErr("careRole", "Please choose who you're managing care for."); firstInvalid = firstInvalid || "careRole"; }
    if (!consent) { var ce = document.getElementById("err-consent"); if (ce) ce.textContent = "Please agree before joining the beta."; firstInvalid = firstInvalid || "consent"; }

    if (firstInvalid) {
      var el = document.getElementById(firstInvalid);
      if (el && el.focus) el.focus();
      track("beta_form_submit_error", { reason: "client_validation" });
      return;
    }

    var payload = {
      first_name: firstName,
      email: email,
      care_role: careRole,
      referral_source: referral || null,
      consent: true,
      utm: getUTM(),
      company: honey /* honeypot */
    };

    if (submitBtn) { submitBtn.setAttribute("aria-busy", "true"); submitBtn.dataset.label = submitBtn.textContent; submitBtn.textContent = "Saving…"; }

    fetch(SIGNUP_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(payload)
    })
      .then(function (r) { return r.json().then(function (body) { return { status: r.status, body: body }; }); })
      .then(function (res) {
        var b = res.body || {};
        if (res.status === 200 && b.ok) {
          // Backend confirmed the record is saved — NOW fire the conversion.
          track("beta_form_submit_success", { duplicate: !!b.duplicate, founding_family: !!b.founding_family, status: b.status || null });
          showSuccess(!!b.duplicate, !!b.founding_family, b.status);
          loadCount();
          return;
        }
        if (res.status === 400 && b.error === "validation" && b.errors) {
          if (b.errors.first_name) setErr("firstName", b.errors.first_name);
          if (b.errors.email) setErr("email", b.errors.email);
          if (b.errors.care_role) setErr("careRole", b.errors.care_role);
          if (b.errors.consent) { var c2 = document.getElementById("err-consent"); if (c2) c2.textContent = b.errors.consent; }
          showAlert("error", "Please fix the highlighted fields and try again.");
          track("beta_form_submit_error", { reason: "server_validation" });
          return;
        }
        if (b.error === "not_configured") {
          showAlert("info", "The signup service isn't connected yet on this environment. See the README to finish setup, then try again.");
          track("beta_form_submit_error", { reason: "not_configured" });
          return;
        }
        showAlert("error", (b && b.message) || "Something went wrong saving your signup. Please try again in a moment.");
        track("beta_form_submit_error", { reason: "server_error", status: res.status });
      })
      .catch(function () {
        showAlert("error", "We couldn't reach the signup service. Please check your connection and try again.");
        track("beta_form_submit_error", { reason: "network" });
      })
      .then(function () {
        if (submitBtn) { submitBtn.removeAttribute("aria-busy"); submitBtn.textContent = submitBtn.dataset.label || "Join the Founding Beta"; }
      });
  });
})();
