// ==UserScript==
// @name         Duel Tools — Historical Card Text
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  When "Use Historical Card Text" is on, swaps a card's displayed effect text for its Goat Format (pre-errata) wording, wherever DuelingBook renders that card.
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';

  // Confirmed live (deck constructor, 2026-11-14, via a user console paste)
  // that every rendered card — deck constructor grid tile, search result,
  // and (per the shared `.cardfront_content` component naming) presumably
  // the same on the duel board and in replays — is a
  // `<div class="cardfront_content">` holding, among other spans,
  // `<span class="name_txt">` and `<span class="effect_txt">`. This file
  // doesn't yet have independent live confirmation that a LIVE DUEL or a
  // REPLAY page uses the exact same class names (only the deck constructor
  // was actually inspected) — if a user report ever says this isn't
  // swapping text on one of those two, that's the first thing to re-check,
  // not a sign the whole approach is wrong.
  const NAME_SEL = '.name_txt';
  const EFFECT_SEL = '.effect_txt';
  const CONTAINER_SEL = '.cardfront_content';

  // Confirmed live (deck constructor, 2026-11-14, directly in the browser)
  // that the deck constructor's large "selected card" preview — the big
  // card art + text box on the left when you click a card — is a SEPARATE,
  // one-of-a-kind structure from the small grid tiles above: `#preview`
  // (`div.cardfront`, holding a `.name_txt` span with the card's name) and
  // `#preview_txt` (`div.textarea.scrollpane.selectable`, a SIBLING of
  // #preview, not a child of it, holding the effect text as plain
  // textContent — no `.effect_txt` class at all). This is why grid tiles
  // were already swapping correctly while this preview box kept showing
  // DuelingBook's current/errata'd wording: applyTo()/CONTAINER_SEL never
  // matched it at all. Scoped to these two ids specifically rather than a
  // broader selector, since #preview_txt's un-namespaced class names
  // ("textarea", "scrollpane") are generic enough to risk matching
  // something unrelated elsewhere on the page.
  const PREVIEW_NAME_SEL = '#preview .name_txt';
  const PREVIEW_TEXT_SEL = '#preview_txt';

  function getSetting(key, def) {
    try { return typeof GM_getValue === 'function' ? GM_getValue(key, def) : def; } catch (e) { return def; }
  }

  // dt-goat-errata-data.js is injected right before this file, into the
  // same isolated world, so its unprefixed `window.DT_GOAT_ERRATA_TEXT`
  // assignment is already visible here by the time this runs. This check
  // stays a hard, one-time, top-level gate (unlike the enabled-setting
  // check below) because a missing data file is a load-order bug, not
  // something that can change while the page sits open.
  const DATA = window.DT_GOAT_ERRATA_TEXT || {};
  if (!Object.keys(DATA).length) {
    console.warn('[Duel Tools] Historical Card Text: dt-goat-errata-data.js didn\'t load — nothing to swap.');
    return;
  }

  // The enabled check is deliberately NOT a one-time top-level gate (that
  // was the likely real cause of "it's not doing anything anywhere, even
  // right after I turned it on") — this script is injected once per full
  // page navigation, but DuelingBook can stay on the same tab across the
  // lobby, a duel, and the deck constructor without ever re-navigating, so
  // a one-time check made at injection time could easily run before the
  // setting was ever turned on and then never get re-evaluated again for
  // the rest of that tab's life. Checking live, on every card scanned,
  // means flipping the toggle in Settings takes effect on this page
  // immediately, with no reload needed.
  function isEnabled() { return getSetting('dt_historical_card_text_enabled', false); }

  // Idempotent by design (re-checks and no-ops if already correct) rather
  // than tracking "did I already touch this node" — DuelingBook appears to
  // reuse/recycle these tile elements for different cards as you scroll or
  // search (same element, new content), so the safe thing is to always
  // re-derive "what should this tile show right now" from its current
  // name, not trust a one-time flag on the element.
  function applyTo(container) {
    if (!isEnabled()) return;
    const nameEl = container.querySelector(NAME_SEL);
    const effectEl = container.querySelector(EFFECT_SEL);
    if (!nameEl || !effectEl) return;
    const name = (nameEl.textContent || '').trim();
    const historical = DATA[name];
    if (!historical || effectEl.textContent === historical) return;
    effectEl.textContent = historical;
  }

  // Singleton lookup each time (not a tree walk), so calling this
  // unconditionally on every scan/mutation batch is cheap — simpler and
  // safer than trying to detect exactly which mutation touched it.
  function applyToPreview() {
    if (!isEnabled()) return;
    const nameEl = document.querySelector(PREVIEW_NAME_SEL);
    const textEl = document.querySelector(PREVIEW_TEXT_SEL);
    if (!nameEl || !textEl) return;
    const name = (nameEl.textContent || '').trim();
    const historical = DATA[name];
    if (!historical || textEl.textContent === historical) return;
    textEl.textContent = historical;
  }

  function scan(root) {
    if (!root || root.nodeType !== 1) return; // skip text nodes etc. — including ones this script's own writes produce
    if (root.matches && root.matches(CONTAINER_SEL)) applyTo(root);
    if (root.querySelectorAll) Array.from(root.querySelectorAll(CONTAINER_SEL)).forEach(applyTo);
    applyToPreview();
  }

  scan(document.body);

  new MutationObserver(function (mutations) {
    for (const m of mutations) {
      for (const node of m.addedNodes) scan(node);
      // Covers DuelingBook updating an EXISTING tile's text in place
      // (textContent-style swaps replace a span's child text node, which
      // fires as a childList mutation on the span itself, not on
      // .cardfront_content) — walk up from whatever changed to the
      // nearest card tile and re-check it.
      if (m.target && m.target.nodeType === 1) {
        const container = m.target.closest ? m.target.closest(CONTAINER_SEL) : null;
        if (container) applyTo(container);
      } else if (m.target && m.target.parentElement) {
        const container = m.target.parentElement.closest(CONTAINER_SEL);
        if (container) applyTo(container);
      }
    }
    // Once per batch (not once per mutation) is enough — #preview_txt is a
    // single element, and clicking a different card to preview fires a
    // batch of mutations together, not one at a time.
    applyToPreview();
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  // Closes the remaining gap the per-card isEnabled() check above doesn't:
  // a tile that was already on screen (rendered, settled, no further
  // mutations coming) BEFORE the toggle was flipped on never gets a fresh
  // mutation to react to. Re-running a full scan the instant the setting
  // itself changes catches those too, with no reload needed.
  if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local' && changes.dt_historical_card_text_enabled) scan(document.body);
    });
  }

  console.log('[Duel Tools] Historical Card Text script loaded — watching for card tiles (active once enabled in Settings).');
})();
