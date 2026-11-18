// ==UserScript==
// @name         Duel Tools — Custom Colors: Deck Constructor
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Recolors the Deck Constructor page — the DECK/SIDE/EXTRA labels (each independently), each section's background tint, the per-card grid-cell outlines, every native dropdown, and the Search panel — per Settings → Appearance Customization → Add Custom Images/Themes/Colors/Emotes → Custom Colors → Deck Constructor.
// @match        https://www.duelingbook.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// ── v1.3 — label color split per section ─────────────────────────────────────
// deckLabels (one shared color for "DECK"/"SIDE"/"EXTRA") split into
// mainDeckLabel/sideDeckLabel/extraDeckLabel, by request, to match the
// mainDeckSection/sideDeckSection/extraDeckSection split below — each
// vertical label now colors independently of the other two.
//
// ── v1.2 — section background split out as its own control ──────────────────
// v1.1 fixed the grid-line color (see below) but that exposed a second,
// separate thing: `.deck_bg`/`.side_bg`/`.extra_bg` (588×466 / 578×79 /
// 578×79) are themselves real elements with their own native translucent
// fill — confirmed live, no inline style, no extension involved:
// `.deck_bg` → rgba(153,0,204,.6) (purple), `.side_bg` → rgba(0,204,255,.75)
// (cyan), `.extra_bg` → rgba(255,121,0,.85) (orange). v1.0 had been setting
// THIS element's backgroundColor under the mainDeckGrid/etc. rows (the
// wrong row for it, since those rows were meant for the grid lines) to
// whatever color the user had tried there — which is what was masking this
// native tint the whole time. Once v1.1 stopped touching `.deck_bg` at all,
// that native tint reappeared undisguised, which read as "reset to
// default" even though nothing was reverted — it just hadn't been
// deliberately covered before. Per the user's own request, this is now its
// own control: mainDeckSection/sideDeckSection/extraDeckSection, applied as
// `backgroundColor` on `.deck_bg`/`.side_bg`/`.extra_bg`, fully independent
// of the grid-line rows below.
//
// ── v1.1 — grid-line fix, confirmed against the live page ───────────────────
// What actually draws the lines, confirmed live: every individual card slot
// is its own element — `.deck_slot` (55×77, `border: 1px solid
// rgb(134,1,179)` = #8601b3, with a `.content` child carrying a second,
// half-opacity purple border `rgba(153,0,204,.5)`), `.side_slot` (`border:
// 1px solid rgb(0,153,255)` = #0099ff), `.extra_slot` (`border: 1px solid
// rgb(255,117,0)` = #ff7500) — one real bordered DIV per cell, ~10×6 of them
// for Main Deck, 15 for Side, 60 for Extra. Fixed by setting `borderColor`
// (not backgroundColor) on `.deck_slot`/`.side_slot`/`.extra_slot` and
// their `.content` children, so a chosen color recolors every cell's
// outline directly — unaffected by, and independent of, the section
// background rows above.
//
// ── Still confirmed live from v1.0, unchanged ────────────────────────────────
//   - The vertical "DECK"/"SIDE"/"EXTRA" text is <span class="deck_lbl">/
//     "side_lbl"/"extra_lbl">.
//   - Every Search-panel filter (Card/Type/Attrib/Limit/Order) plus the
//     deck-name and deck-folder pickers near the bottom-left buttons are
//     genuine native <select> elements (confirmed: real white
//     background, not a decorative overlay div the way some of
//     DuelingBook's OTHER dropdowns work — see dt-custom-colors-main.
//     user.js's header for a case where that distinction mattered).
//     deckDropdownBg targets every one of these at once via a single
//     `#deck_constructor select` selector.
//   - The SEARCH panel's own fill lives on a `.search_bg` sibling div
//     (native rgba(195,255,0,.75)), same "real fill is a sibling div"
//     convention documented in dt-custom-colors-main.user.js's header.
(function () {
  'use strict';

  function hexToRgb(hex) {
    const h = (hex || '#000000').replace('#', '');
    return {
      r: parseInt(h.substring(0, 2), 16) || 0,
      g: parseInt(h.substring(2, 4), 16) || 0,
      b: parseInt(h.substring(4, 6), 16) || 0
    };
  }
  function rgba(hex, alphaPct) {
    const { r, g, b } = hexToRgb(hex);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + (Math.max(0, Math.min(100, alphaPct)) / 100) + ')';
  }
  function applySimple(selectors, enabled, color, opacityPct, scopeEl, prop) {
    const root = scopeEl || document;
    const cssProp = prop || 'color';
    selectors.forEach((sel) => {
      root.querySelectorAll(sel).forEach((el) => {
        el.style[cssProp] = enabled && color ? rgba(color, opacityPct) : '';
      });
    });
  }

  const ROW_DEFAULTS = {
    mainDeckLabel: { color: '#000000', opacity: 100 },
    sideDeckLabel: { color: '#000000', opacity: 100 },
    extraDeckLabel: { color: '#000000', opacity: 100 },
    deckDropdownBg: { color: '#efefef', opacity: 100 },
    mainDeckSection: { color: '#9900cc', opacity: 60 },
    sideDeckSection: { color: '#00ccff', opacity: 75 },
    extraDeckSection: { color: '#ff7900', opacity: 85 },
    mainDeckGrid: { color: '#8601b3', opacity: 100 },
    sideDeckGrid: { color: '#0099ff', opacity: 100 },
    extraDeckGrid: { color: '#ff7500', opacity: 100 },
    searchPanelBg: { color: '#c3ff00', opacity: 75 }
  };
  const ROW_IDS = Object.keys(ROW_DEFAULTS);

  function readAndApply() {
    const keys = { dt_custom_colors_enabled: false };
    ROW_IDS.forEach((id) => {
      keys['dt_cc_' + id + '_color'] = ROW_DEFAULTS[id].color;
      keys['dt_cc_' + id + '_opacity'] = ROW_DEFAULTS[id].opacity;
    });

    chrome.storage.local.get(keys, (s) => {
      const enabled = !!s.dt_custom_colors_enabled;
      const deckConstructor = document.getElementById('deck_constructor');
      if (!deckConstructor) return; // not built yet — the poll/observer below will retry

      applySimple(['.deck_lbl'], enabled, s.dt_cc_mainDeckLabel_color, s.dt_cc_mainDeckLabel_opacity, deckConstructor, 'color');
      applySimple(['.side_lbl'], enabled, s.dt_cc_sideDeckLabel_color, s.dt_cc_sideDeckLabel_opacity, deckConstructor, 'color');
      applySimple(['.extra_lbl'], enabled, s.dt_cc_extraDeckLabel_color, s.dt_cc_extraDeckLabel_opacity, deckConstructor, 'color');
      applySimple(['select'], enabled, s.dt_cc_deckDropdownBg_color, s.dt_cc_deckDropdownBg_opacity, deckConstructor, 'backgroundColor');
      applySimple(['.deck_bg'], enabled, s.dt_cc_mainDeckSection_color, s.dt_cc_mainDeckSection_opacity, deckConstructor, 'backgroundColor');
      applySimple(['.side_bg'], enabled, s.dt_cc_sideDeckSection_color, s.dt_cc_sideDeckSection_opacity, deckConstructor, 'backgroundColor');
      applySimple(['.extra_bg'], enabled, s.dt_cc_extraDeckSection_color, s.dt_cc_extraDeckSection_opacity, deckConstructor, 'backgroundColor');
      applySimple(['.deck_slot', '.deck_slot .content'], enabled, s.dt_cc_mainDeckGrid_color, s.dt_cc_mainDeckGrid_opacity, deckConstructor, 'borderColor');
      applySimple(['.side_slot', '.side_slot .content'], enabled, s.dt_cc_sideDeckGrid_color, s.dt_cc_sideDeckGrid_opacity, deckConstructor, 'borderColor');
      applySimple(['.extra_slot', '.extra_slot .content'], enabled, s.dt_cc_extraDeckGrid_color, s.dt_cc_extraDeckGrid_opacity, deckConstructor, 'borderColor');
      applySimple(['.search_bg'], enabled, s.dt_cc_searchPanelBg_color, s.dt_cc_searchPanelBg_opacity, deckConstructor, 'backgroundColor');
    });
  }

  readAndApply();
  // Same convention as every other Custom Colors content script in this
  // extension: poll (cheap, robust against a full page rebuild — e.g.
  // switching Format, which reloads the Search panel's own controls)
  // plus a debounced MutationObserver for near-instant re-apply.
  setInterval(readAndApply, 1500);

  let mutationDebounce = null;
  function onMutation() {
    if (mutationDebounce) return;
    mutationDebounce = setTimeout(() => { mutationDebounce = null; readAndApply(); }, 80);
  }
  function observe() {
    const frames = document.getElementById('frames');
    if (!frames) { setTimeout(observe, 1000); return; }
    new MutationObserver(onMutation).observe(frames, { childList: true, subtree: true });
  }
  observe();

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const relevant = Object.keys(changes).some((k) => k === 'dt_custom_colors_enabled' || ROW_IDS.some((id) => k === 'dt_cc_' + id + '_color' || k === 'dt_cc_' + id + '_opacity'));
      if (relevant) readAndApply();
    });
  }

  console.log('[Duel Tools] Custom Colors: Deck Constructor ready');
})();
