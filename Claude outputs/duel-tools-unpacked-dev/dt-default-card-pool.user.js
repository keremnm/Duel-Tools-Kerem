// ==UserScript==
// @name         Duel Tools — Default Card Pool
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  When "Enable Default Card Pool" is on, auto-selects your saved Cardpool choice in the deck constructor's own dropdown.
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';

  // Confirmed live (deck constructor, 2026-11-14, via a user console paste
  // of every <select> on the page) that the real Cardpool dropdown is
  // `<select class="custom_cb">`, with option TEXT (not confirmed `value`
  // attributes, so matched by visible text below) including at least
  // "Official Cards Only", "Goat Format Cards", and "Edison Format Cards" —
  // the three choices this setting offers, in that same order. This is
  // simpler than what Deck Building's settings page note originally
  // described: not a second dropdown Duel Tools builds itself, just
  // DuelingBook's own existing one, pre-selected — per the user's own
  // correction once they saw the real page.
  const SELECT_SEL = 'select.custom_cb';
  const LABELS = { official: 'Official Cards Only', goat: 'Goat Format Cards', edison: 'Edison Format Cards' };

  function getSetting(key, def) {
    try { return typeof GM_getValue === 'function' ? GM_getValue(key, def) : def; } catch (e) { return def; }
  }

  function norm(s) { return (s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

  function findOption(select, wantLabel) {
    const want = norm(wantLabel);
    const opts = Array.from(select.options);
    // Exact (case/whitespace-insensitive) match first, then a loose
    // "starts with" fallback — covers DuelingBook appending something to
    // the label (a count, a flag) that an exact match would miss, without
    // risking a wrong match among the 9 real options, which don't prefix
    // one another.
    return opts.find((o) => norm(o.textContent) === want) ||
      opts.find((o) => norm(o.textContent).indexOf(want) === 0);
  }

  // The enabled/selected checks are deliberately read fresh every time
  // this runs (never cached into a one-time top-level gate) — likely real
  // cause of "I set it to Goat Format but it's not doing anything": this
  // script is injected once per full page navigation, but DuelingBook can
  // sit on one tab across the lobby, a duel, and the deck constructor
  // without ever re-navigating, so a value read once at injection time
  // could reflect whatever Settings said BEFORE you actually changed it,
  // for the rest of that tab's life. Reading live means a change in
  // Settings takes effect on this page immediately, no reload needed.
  function applyNow(select) {
    if (!getSetting('dt_card_pool_enabled', false)) return;
    const wantLabel = LABELS[getSetting('dt_card_pool_selected', 'official')] || LABELS.official;
    const opt = findOption(select, wantLabel);
    if (!opt) {
      console.warn('[Duel Tools] Default Card Pool: couldn\'t find "' + wantLabel + '" among this dropdown\'s options — DuelingBook may have renamed it. Options seen: ' +
        JSON.stringify(Array.from(select.options).map((o) => o.textContent.trim())));
      return;
    }
    if (select.value === opt.value) {
      console.log('[Duel Tools] Default Card Pool: already on "' + wantLabel + '" — nothing to change.');
      return;
    }
    select.value = opt.value;
    // A plain .value set doesn't run DuelingBook's own filter logic — this
    // mirrors how a real user picking it from the dropdown fires 'change',
    // which is what actually re-filters the card list. Dispatched (not a
    // real user action), so its isTrusted is false — see attachOnce below,
    // which uses exactly that to tell our own writes apart from the
    // user's.
    select.dispatchEvent(new Event('change', { bubbles: true }));
    console.log('[Duel Tools] Default Card Pool: selected "' + wantLabel + '".');
  }

  // A real pick the user makes themselves in the dropdown afterward is
  // always respected — `event.isTrusted` is the browser's own, reliable
  // way to tell a genuine user-driven 'change' apart from the synthetic
  // one applyNow() dispatches above (isTrusted is always false for a
  // script-dispatched event), so this never needs to guess.
  function attachOnce(select) {
    if (select.dataset.dtPoolWatcherAttached) return;
    select.dataset.dtPoolWatcherAttached = '1';
    select.addEventListener('change', function (e) {
      if (e.isTrusted) select.dataset.dtUserOverride = '1';
    });
  }

  function maybeApply(select) {
    if (!select) return;
    attachOnce(select);
    if (select.dataset.dtUserOverride) return; // the user already picked one themselves — never fight that
    applyNow(select);
  }

  // Confirmed live that the real Cardpool dropdown can exist in the DOM
  // before its <option>s are actually populated (an async render step that
  // finishes after the element itself is mounted) — waiting for real
  // options, not just the element's existence, is what fixed the "found no
  // matching option, warned once, and never got another chance" failure
  // mode a bare existence check had.
  function waitForPopulated(selector, cb) {
    function ready() {
      const el = document.querySelector(selector);
      return (el && el.options && el.options.length > 0) ? el : null;
    }
    const existing = ready();
    if (existing) { cb(existing); return; }
    let done = false;
    function finish(el) {
      if (done) return;
      done = true;
      obs.disconnect();
      clearInterval(poll);
      cb(el);
    }
    const obs = new MutationObserver(function () {
      const el = ready();
      if (el) finish(el);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    let tries = 0;
    const poll = setInterval(function () {
      tries++;
      const el = ready();
      if (el || tries > 40) { // ~20s cap
        clearInterval(poll);
        if (el) finish(el);
      }
    }, 500);
  }

  waitForPopulated(SELECT_SEL, maybeApply);

  // Closes the same gap as dt-historical-text.user.js's own
  // chrome.storage.onChanged hook: if the dropdown is already on screen
  // and populated BEFORE you turn this setting on (or change which pool),
  // there's no further DOM mutation for anything here to react to — so
  // react to the setting itself changing instead, with no reload needed.
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local') return;
      if (!changes.dt_card_pool_enabled && !changes.dt_card_pool_selected) return;
      maybeApply(document.querySelector(SELECT_SEL));
    });
  }

  // Confirmed live: the dropdown can revert to "Official Cards Only" on
  // its own after it was already set correctly — e.g. toggling the
  // SEARCH panel's "more options" open/closed again. No childList
  // mutation fires for this (DuelingBook sets the element's own
  // value/selectedIndex directly, it doesn't remove/recreate the <select>
  // or its <option>s), so the MutationObserver-based paths above never see
  // it happen. Rather than chase the exact trigger, enforce the choice
  // continuously: cheap (one value comparison) each tick, and
  // maybeApply()'s own isTrusted-based override check still means a real
  // pick you make yourself is never fought.
  setInterval(function () {
    const select = document.querySelector(SELECT_SEL);
    if (select) maybeApply(select);
  }, 1500);
})();
