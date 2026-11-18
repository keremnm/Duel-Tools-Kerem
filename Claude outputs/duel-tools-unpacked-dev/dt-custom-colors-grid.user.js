// ==UserScript==
// @name         Duel Tools — Show Background Grid Lines
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Toggles DuelingBook's own green grid-line background overlay, per Settings → Appearance Customization → Add Custom Images/Themes/Colors/Emotes → Custom Colors → Show Background Grid Lines.
// @match        https://www.duelingbook.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// Confirmed live: DuelingBook's background (visible on the front page, Main
// Menu, Duel Room lobby, etc.) is built from two separate, independently
// toggleable layers that both sit inside the persistent #content container
// (so neither gets destroyed/recreated by the app's own page-to-page
// navigation, which only hides/shows #frames' children):
//   - #circuit_board (<img src=".../circuit_board_small.webp">) — the dim
//     "circuit board" photo texture (opacity 0.5). This is what the
//     Custom Colors "Circuit-pattern dark tint" row (separately wired, not
//     this feature) recolors/tints.
//   - #greenlines1 / #greenlines2 (two <img src=".../svg/greenlines.svg">
//     wrapper divs) — the bright green grid-line pattern drawn OVER the
//     circuit board texture. This is the "grid" this toggle controls.
// Verified by hiding each independently and screenshotting: hiding only
// greenlines1/2 removes just the green grid lines and leaves the circuit
// board texture untouched, which is the exact "turn the grid off, leave
// everything else" behavior asked for. This feature is pure isolated-world
// DOM/CSS — no page-global function call needed, so (unlike skip-intro or
// hand-shuffling) there's no MAIN-world engine companion file for this one.
(function () {
  'use strict';

  function apply(showGrid) {
    const g1 = document.getElementById('greenlines1');
    const g2 = document.getElementById('greenlines2');
    const display = showGrid ? '' : 'none';
    if (g1) g1.style.display = display;
    if (g2) g2.style.display = display;
  }

  function readAndApply() {
    chrome.storage.local.get({ dt_custom_colors_grid_lines: true }, (s) => {
      apply(!!s.dt_custom_colors_grid_lines);
    });
  }

  readAndApply();
  // Light polling fallback (same convention as dt-custom-emotes.user.js) in
  // case these elements ever do get rebuilt by a future DuelingBook change;
  // harmless no-op otherwise since apply() is idempotent.
  setInterval(readAndApply, 1500);

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.dt_custom_colors_grid_lines) return;
      apply(!!changes.dt_custom_colors_grid_lines.newValue);
    });
  }

  console.log('[Duel Tools] Show Background Grid Lines ready');
})();
