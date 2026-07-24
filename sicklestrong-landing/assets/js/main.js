/* main.js — progressive enhancement for the whole site.
   Everything here is an ENHANCEMENT: the page is fully readable and the
   core links work with JavaScript disabled. */
(function () {
  "use strict";
  var root = document.documentElement;
  root.classList.add("js");
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var track = window.ssTrack || function () {};

  /* ---------- theme toggle ---------- */
  var toggle = document.querySelector(".theme-toggle");
  if (toggle) {
    var currentTheme = function () {
      var attr = root.getAttribute("data-theme");
      if (attr) return attr;
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    };
    var syncLabel = function () {
      var t = currentTheme();
      toggle.setAttribute("aria-pressed", String(t === "dark"));
      toggle.setAttribute("aria-label", t === "dark" ? "Switch to light theme" : "Switch to dark theme");
    };
    syncLabel();
    toggle.addEventListener("click", function () {
      var next = currentTheme() === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("ss-theme", next); } catch (e) {}
      syncLabel();
    });
  }

  /* ---------- scroll reveal ---------- */
  var revealables = [].slice.call(document.querySelectorAll(".reveal"));
  if (reduce || !("IntersectionObserver" in window)) {
    revealables.forEach(function (el) { el.classList.add("in"); });
  } else {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
      });
    }, { threshold: 0.12, rootMargin: "0px 0px -40px 0px" });
    revealables.forEach(function (el) { io.observe(el); });
  }

  /* ---------- header shadow + sticky mobile CTA ---------- */
  var header = document.querySelector("header.site");
  var hero = document.getElementById("hero");
  var join = document.getElementById("join");
  var mobileCta = document.getElementById("mobileCta");
  var onScroll = function () {
    if (header) header.classList.toggle("scrolled", window.scrollY > 8);
    if (hero && mobileCta) {
      var past = window.scrollY > (hero.offsetTop + hero.offsetHeight - 120);
      var beforeJoin = join ? (window.scrollY + window.innerHeight < join.offsetTop + 80) : true;
      var show = past && beforeJoin;
      mobileCta.classList.toggle("show", show);
      mobileCta.setAttribute("aria-hidden", show ? "false" : "true");
    }
  };
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /* ---------- FAQ accordion (collapses once JS is present) ---------- */
  [].slice.call(document.querySelectorAll(".faq-trigger")).forEach(function (btn, i) {
    var panel = document.getElementById(btn.getAttribute("aria-controls"));
    var open = i === 0;
    btn.setAttribute("aria-expanded", String(open));
    if (panel) panel.hidden = !open;
    btn.addEventListener("click", function () {
      var isOpen = btn.getAttribute("aria-expanded") === "true";
      btn.setAttribute("aria-expanded", String(!isOpen));
      if (panel) panel.hidden = isOpen;
    });
  });

  /* ---------- demo tabs (Amir / Jordan) ---------- */
  var tablist = document.querySelector(".tablist[role='tablist']");
  if (tablist) {
    var tabs = [].slice.call(tablist.querySelectorAll("[role='tab']"));
    var select = function (tab, focus) {
      tabs.forEach(function (t) {
        var selected = t === tab;
        t.setAttribute("aria-selected", String(selected));
        t.tabIndex = selected ? 0 : -1;
        var panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !selected;
      });
      if (focus && tab.focus) tab.focus();
    };
    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () { select(tab); });
      tab.addEventListener("keydown", function (e) {
        var idx = i;
        if (e.key === "ArrowRight" || e.key === "ArrowDown") { idx = (i + 1) % tabs.length; }
        else if (e.key === "ArrowLeft" || e.key === "ArrowUp") { idx = (i - 1 + tabs.length) % tabs.length; }
        else if (e.key === "Home") { idx = 0; }
        else if (e.key === "End") { idx = tabs.length - 1; }
        else { return; }
        e.preventDefault();
        select(tabs[idx], true);
      });
    });
    // With JS on, show only the initially-selected profile. (Without JS,
    // both panels stay visible so the content is still fully readable.)
    var initialTab = tablist.querySelector("[role='tab'][aria-selected='true']") || tabs[0];
    if (initialTab) select(initialTab, false);
    // Fire demo_open once, when the demo first becomes visible.
    var demoSection = document.getElementById("demo");
    if (demoSection && "IntersectionObserver" in window) {
      var seen = false;
      var dio = new IntersectionObserver(function (entries) {
        entries.forEach(function (e) { if (e.isIntersecting && !seen) { seen = true; track("demo_open", { via: "scroll" }); dio.disconnect(); } });
      }, { threshold: 0.4 });
      dio.observe(demoSection);
    }
  }

  /* ---------- analytics: delegated clicks via data-ev ---------- */
  document.addEventListener("click", function (e) {
    var el = e.target.closest("[data-ev]");
    if (!el) return;
    var name = el.getAttribute("data-ev");
    if (name) track(name, { href: el.getAttribute("href") || null, label: (el.textContent || "").trim().slice(0, 60) });
  });
})();
