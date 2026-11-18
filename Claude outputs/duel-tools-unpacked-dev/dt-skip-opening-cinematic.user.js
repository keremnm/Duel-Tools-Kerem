// ==UserScript==
// @name         Duel Tools — Automatically Skip Opening Cinematic
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Calls DuelingBook's own "Skip Intro" action automatically on page load, per Settings → Appearance Customization → Automatically Skip Opening Cinematic.
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// Isolated world, same pattern as dt-custom-emotes.user.js (plain
// chrome.storage.local, @grant none — no GM shim needed): reads the
// setting once per page load and, if on, hands off to
// dt-skip-cinematic-engine.js (MAIN world) to actually call
// window.skipIntro() — see that file's own header for why that part needs
// MAIN world. Injection order (background.js's injectAll()) guarantees the
// engine is already listening by the time this runs, so a single
// postMessage is enough — no retry loop needed.
(function () {
  'use strict';

  chrome.storage.local.get({ dt_skip_opening_cinematic_enabled: false }, (s) => {
    if (!s.dt_skip_opening_cinematic_enabled) return;
    window.postMessage({ source: 'dt-skip-opening-cinematic', type: 'DT_SKIP_INTRO_REQUEST' }, '*');
  });
})();
