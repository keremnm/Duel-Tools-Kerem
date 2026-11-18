// ==UserScript==
// @name         Duel Tools — Transparent Facedowns (settings relay)
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Relays the Transparent Facedowns settings (two toggles + an opacity slider) from isolated-world storage into the MAIN-world engine that actually applies the effect. No on-page UI of its own.
// @match        https://www.duelingbook.com/*
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==
//
// Why a separate tiny file instead of folding this into the engine: the
// MAIN-world engine (dt-transparent-facedowns-engine.js) needs direct
// access to the page's own `player1`/`player2` globals, so it has to run
// in the MAIN world — but MAIN-world page scripts can't reach chrome.*
// APIs (no GM_getValue) at all. This isolated-world file can read settings
// the normal way and relays them in over postMessage, the same bridge
// pattern page-bridge.js already uses for deck/side data.
(function () {
  'use strict';

  if (window.location.pathname.indexOf('/replay') === 0) return;

  function getSetting(key, def) {
    try { return typeof GM_getValue === 'function' ? GM_getValue(key, def) : def; } catch (e) { return def; }
  }

  var lastSent = null;
  function relay() {
    var ownEnabled = !!getSetting('dt_transparent_own_enabled', false);
    var oppEnabled = !!getSetting('dt_transparent_opp_enabled', false);
    var opacityPct = getSetting('dt_transparent_opacity', 60);
    var opacity = Math.max(0, Math.min(100, Number(opacityPct) || 60)) / 100;
    var key = ownEnabled + '|' + oppEnabled + '|' + opacity;
    if (key === lastSent) return; // avoid spamming postMessage every tick when nothing changed
    lastSent = key;
    window.postMessage({ source: 'dt-transparent-facedowns-settings', ownEnabled: ownEnabled, oppEnabled: oppEnabled, opacity: opacity }, window.location.origin);
  }

  setInterval(relay, 500);
  relay();
  console.log('[Duel Tools] Transparent Facedowns settings relay ready');
})();
