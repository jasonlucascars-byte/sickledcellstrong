/* demo.js — makes the in-page product demo INTERACTIVE, using only
   synthetic data. No sign-up, no network, nothing is stored.

   This is progressive enhancement: it upgrades the static demo markup in
   place and injects the "try it" controls only when JavaScript runs, so
   the demo remains fully readable with JS disabled. Each profile panel
   keeps its own state, and a Reset restores the original sample. */
(function () {
  "use strict";

  var track = window.ssTrack || function () {};
  var FEVER_THRESHOLD = 101.3; // °F — matches the app's care-plan reminder
  var CHECK =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
  var WARN_ICON =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.3 3.6 2.5 17a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.6a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>';

  var panels = [].slice.call(document.querySelectorAll("#demo .tabpanel"));
  if (!panels.length) return;

  var original = {}; // panel id -> pristine innerHTML (for Reset)
  panels.forEach(function (panel) {
    original[panel.id] = panel.innerHTML;
    enhance(panel);
  });

  function keyOf(panel) { return panel.id.replace("panel-", ""); }
  function esc(s) { var d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

  function enhance(panel) {
    enhanceMeds(panel);
    enhanceHydration(panel);
    injectControls(panel, keyOf(panel));
  }

  /* ---- medications: tap to toggle "taken" ---- */
  function updateMedsCount(panel) {
    var span = panel.querySelector(".meds-count");
    if (!span) return;
    var meds = panel.querySelectorAll(".meds .med");
    var done = 0;
    meds.forEach(function (m) { if (m.classList.contains("done")) done++; });
    span.textContent = " · " + done + " of " + meds.length + " taken";
  }

  function enhanceMeds(panel) {
    var h4 = panel.querySelector(".demo-block h4"); // meds/hydration block heading
    if (h4 && !h4.querySelector(".meds-count")) {
      var c = document.createElement("span");
      c.className = "meds-count";
      c.setAttribute("aria-live", "polite");
      h4.appendChild(c);
    }
    [].slice.call(panel.querySelectorAll(".meds .med")).forEach(function (med) {
      if (med.dataset.enhanced) return;
      med.dataset.enhanced = "1";
      med.classList.add("med-toggle");
      med.setAttribute("role", "button");
      med.setAttribute("tabindex", "0");
      med.setAttribute("aria-pressed", med.classList.contains("done") ? "true" : "false");
      var nameEl = med.querySelector(".name");
      med.setAttribute("aria-label", "Mark " + (nameEl ? nameEl.textContent : "medication") + " as taken");
      var toggle = function () {
        var done = med.classList.toggle("done");
        med.setAttribute("aria-pressed", done ? "true" : "false");
        var box = med.querySelector(".box");
        if (box) box.innerHTML = done ? CHECK : "";
        updateMedsCount(panel);
        track("demo_interact", { action: "toggle_med" });
      };
      med.addEventListener("click", toggle);
      med.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") { e.preventDefault(); toggle(); }
      });
    });
    updateMedsCount(panel);
  }

  /* ---- find the temp / hydration tiles ---- */
  function tiles(panel) {
    var out = { temp: null, hyd: null };
    [].slice.call(panel.querySelectorAll(".card-row .mini")).forEach(function (m) {
      var label = (m.querySelector(".k") || {}).textContent || "";
      if (/temp/i.test(label)) out.temp = m;
      else if (/hydr/i.test(label)) out.hyd = m;
    });
    return out;
  }

  /* ---- hydration: add a cup ---- */
  function enhanceHydration(panel) {
    var m = tiles(panel).hyd;
    if (!m || m.dataset.enhanced) return;
    m.dataset.enhanced = "1";
    var v = m.querySelector(".v");
    var chip = m.querySelector(".chip");

    function read() {
      var t = v.textContent; // e.g. "5 / 8"
      var cups = parseInt(t, 10) || 0;
      var gm = t.match(/\/\s*(\d+)/);
      return { cups: cups, goal: gm ? parseInt(gm[1], 10) : 8 };
    }
    function render(cups, goal) {
      v.innerHTML = cups + "<small> / " + goal + "</small>";
      if (chip) {
        if (cups >= goal) { chip.className = "chip good"; chip.textContent = "Goal met!"; }
        else { chip.className = "chip info"; chip.textContent = "On track"; }
      }
    }
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cup-btn";
    btn.textContent = "+ Add a cup";
    btn.setAttribute("aria-label", "Add a cup of water");
    btn.addEventListener("click", function () {
      var s = read();
      if (s.cups < s.goal) render(s.cups + 1, s.goal);
      track("demo_interact", { action: "add_cup" });
    });
    m.appendChild(btn);
  }

  /* ---- fever reminder banner ---- */
  function feverBanner(panel, show) {
    var existing = panel.querySelector(".demo-fever");
    if (!show) { if (existing) existing.remove(); return; }
    if (existing) return;
    var row = panel.querySelector(".card-row");
    var el = document.createElement("div");
    el.className = "demo-fever";
    el.setAttribute("role", "status");
    el.innerHTML = WARN_ICON +
      "<span>A logged temperature of 101.3&#176;F or higher triggers a reminder to follow your care team's instructions and seek urgent evaluation.</span>";
    if (row) row.insertAdjacentElement("afterend", el);
  }

  /* ---- injected "try it" controls ---- */
  function injectControls(panel, k) {
    if (panel.querySelector(".demo-try")) return;
    var note = panel.querySelector(".demo-note");
    var wrap = document.createElement("div");
    wrap.className = "demo-try";
    wrap.setAttribute("role", "group");
    wrap.setAttribute("aria-label", "Try logging sample data");
    wrap.innerHTML =
      '<h4>Try logging something <span class="demo-try-tag">sample</span></h4>' +
      '<div class="try-row">' +
        '<label for="temp-' + k + '">Temperature (&#176;F)</label>' +
        '<span class="try-inline">' +
          '<input type="number" id="temp-' + k + '" inputmode="decimal" step="0.1" min="90" max="110" placeholder="e.g. 100.4" />' +
          '<button type="button" class="btn btn-secondary try-btn" data-act="temp">Log temp</button>' +
        '</span>' +
      '</div>' +
      '<div class="try-row">' +
        '<label for="pain-loc-' + k + '">Log a pain entry</label>' +
        '<span class="try-inline">' +
          '<input type="text" id="pain-loc-' + k + '" maxlength="40" placeholder="Location, e.g. knees" />' +
          '<label class="sr-only" for="pain-sev-' + k + '">Severity</label>' +
          '<select id="pain-sev-' + k + '"><option value="low">Mild</option><option value="mid">Moderate</option><option value="high">Severe</option></select>' +
          '<button type="button" class="btn btn-secondary try-btn" data-act="pain">Add entry</button>' +
        '</span>' +
      '</div>' +
      '<button type="button" class="demo-reset" data-act="reset">&#8634; Reset demo</button>';
    if (note) panel.insertBefore(wrap, note); else panel.appendChild(wrap);

    wrap.addEventListener("click", function (e) {
      var b = e.target.closest("[data-act]");
      if (!b) return;
      var act = b.getAttribute("data-act");
      if (act === "temp") logTemp(panel, k);
      else if (act === "pain") logPain(panel, k);
      else if (act === "reset") resetPanel(panel);
    });
  }

  function logTemp(panel, k) {
    var input = document.getElementById("temp-" + k);
    var val = parseFloat(input && input.value);
    if (isNaN(val)) { if (input) input.focus(); return; }
    val = Math.round(val * 10) / 10;
    var m = tiles(panel).temp;
    if (m) {
      var v = m.querySelector(".v");
      var chip = m.querySelector(".chip");
      if (v) v.innerHTML = val + "<small>&#176;F</small>";
      var fever = val >= FEVER_THRESHOLD;
      if (chip) {
        chip.className = "chip " + (fever ? "warn" : "good");
        chip.textContent = fever ? "Seek care" : "Normal";
      }
      feverBanner(panel, fever);
    }
    if (input) input.value = "";
    track("demo_interact", { action: "log_temp" });
  }

  function logPain(panel, k) {
    var loc = document.getElementById("pain-loc-" + k);
    var sev = document.getElementById("pain-sev-" + k);
    var locv = (loc && loc.value.trim()) || "";
    if (!locv) { if (loc) loc.focus(); return; }
    var sv = sev ? sev.value : "low";
    var label = sv === "high" ? "Severe" : sv === "mid" ? "Moderate" : "Mild";
    var hist = panel.querySelector(".history");
    if (hist) {
      var row = document.createElement("div");
      row.className = "hrow";
      row.innerHTML =
        '<span class="when">Today</span><span>' + esc(locv) + "</span>" +
        '<span class="sev ' + sv + '">' + label + "</span>";
      hist.insertBefore(row, hist.firstChild);
    }
    if (loc) loc.value = "";
    track("demo_interact", { action: "log_pain" });
  }

  function resetPanel(panel) {
    panel.innerHTML = original[panel.id];
    enhance(panel);
    track("demo_interact", { action: "reset" });
  }
})();
