// ==UserScript==
// @name         Duel Tools — Card Text Size
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Overrides every card's rules/effect text to one font size you pick in Settings → Appearance Customization → Card Text Size, everywhere on the site (hand, field hover-zoom, deck constructor, siding, replays).
// @match        https://www.duelingbook.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// Confirmed live: a card's rules/effect text is plain HTML, not baked into
// the card art — DuelingBook renders it as a <span class="effect_txt"> (a
// normal monster/spell/trap's single text box) or, for a Pendulum monster,
// an ADDITIONAL <span class="card_pendulum_effect_txt"> for the lower
// Pendulum Effect box (its own upper monster-effect text still uses plain
// .effect_txt). Both appear inside every .cardfront_content — confirmed
// present in the hand-view/siding/deck-constructor card preview template,
// and by construction the exact same classes DuelingBook reuses for every
// other place a card renders (in hand, on the field's hover-zoom, replays)
// since it's all one shared card-rendering component, not a per-context
// reimplementation.
//
// Why a single injected <style> rule instead of walking/observing elements:
// cards constantly appear and disappear across every context this needs to
// cover (drawn into hand, summoned to field, hovered, a new replay's board
// state) — a MutationObserver watching for new .effect_txt nodes everywhere
// on the page would be both far more code AND strictly redundant, since a
// plain CSS class-selector rule already applies itself automatically to
// every current AND future element with that class, with no JS needed per
// element at all.
(function () {
  'use strict';

  const DEFAULTS = {
    dt_card_text_size_enabled: false,
    dt_card_text_size_px: 12
  };

  let styleEl = null;
  function ensureStyleEl() {
    if (styleEl && styleEl.isConnected) return styleEl;
    styleEl = document.getElementById('dt-card-text-size-style');
    if (styleEl) return styleEl;
    styleEl = document.createElement('style');
    styleEl.id = 'dt-card-text-size-style';
    (document.head || document.documentElement).appendChild(styleEl);
    return styleEl;
  }

  function apply() {
    chrome.storage.local.get(DEFAULTS, (s) => {
      const el = ensureStyleEl();
      if (!s.dt_card_text_size_enabled) { el.textContent = ''; return; }
      const px = typeof s.dt_card_text_size_px === 'number' ? s.dt_card_text_size_px : 12;
      // !important: DuelingBook's own card-size-tier classes (e.g.
      // "size24" on .name_txt — not touched by this feature at all, just
      // the evidence that these are already class-based, specific-enough
      // rules that a plain same-specificity override here would lose to)
      // set font-size directly on these same elements, so a bare rule
      // without !important would do nothing.
      el.textContent =
        '.effect_txt, .card_pendulum_effect_txt { font-size: ' + px + 'px !important; }';
    });
  }

  apply();

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.dt_card_text_size_enabled || changes.dt_card_text_size_px) apply();
    });
  }

  console.log('[Duel Tools] Card Text Size ready');
})();
