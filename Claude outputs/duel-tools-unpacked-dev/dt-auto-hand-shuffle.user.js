// ==UserScript==
// @name         Duel Tools — Auto Hand Shuffling
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Automatically shuffles your hand's visual card order the instant YOUR OWN turn reaches Standby Phase, Main Phase 1, and/or Main Phase 2, per Settings → Playing → Auto Hand Shuffling.
// @match        https://www.duelingbook.com/*
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==
//
// Scope: "Playing" category — duelingbook.com only, NEVER /replay* pages
// (enforced below, as a second safety net — see background.js's injectAll()
// for the actual gating). This is a LIVE DUEL feature.
//
// ── Mechanic ──────────────────────────────────────────────────────────────
// This file only ever DECIDES when to shuffle and reads every setting (both
// need chrome.storage/GM_getValue, isolated-world-only) — the actual
// shuffle call (window.shuffleHandE()) and the "whose turn is it" check both
// need page globals that live ONLY in the MAIN world, so those happen in
// dt-hand-shuffle-engine.js instead; this file just posts a bare request
// over to it. See that file's own header for what's confirmed live there.
//
// v1.1: dropped the original "Add Card to Hand" trigger per the user's own
// correction — DuelingBook already has a native "Auto-Shuffle" checkbox
// (#auto_shuffle_cb, confirmed live, checked by default) that covers that
// case itself, so this extension doesn't need to duplicate it. M2 Shuffle
// added in its place, identical mechanic to SP/M1.
//
// SP / M1 / M2 Shuffle are all edge-triggered off the SAME phase-bar
// elements/heuristic dt-hotkeys.user.js's Previous/Next Phase already uses
// (dp/sp/m1/bp/m2/ep, "whichever one has the longest className"). Per the
// user's explicit call, these only fire on the player's OWN turn reaching
// that phase — never the opponent's — which is why every request here sets
// requireOwnTurn:true for the engine to check.
(function () {
  'use strict';

  if (window.location.pathname.indexOf('/replay') === 0) return; // belt-and-suspenders — see background.js

  function getSetting(key, def) {
    try { return GM_getValue(key, def); } catch (e) { return def; }
  }

  function requestShuffle() {
    window.postMessage({ source: 'dt-auto-hand-shuffle', type: 'DT_SHUFFLE_REQUEST', requireOwnTurn: true }, '*');
  }

  // Copied from dt-hotkeys.user.js's own phaseBarElements()/
  // currentPhaseIndex(), not imported, same self-contained-per-userscript
  // convention as the rest of this extension.
  const PHASE_ORDER = ['dp', 'sp', 'm1', 'bp', 'm2', 'ep'];
  // index -> which setting key gates a shuffle on arriving at that phase.
  const PHASE_SETTING_KEY = { 1: 'dt_auto_hand_shuffle_sp', 2: 'dt_auto_hand_shuffle_m1', 4: 'dt_auto_hand_shuffle_m2' };

  function phaseBarElements() {
    return PHASE_ORDER.map((id) => document.getElementById(id)).filter(Boolean);
  }
  function currentPhaseIndex(elements) {
    if (!elements.length) return -1;
    let best = 0;
    for (let i = 1; i < elements.length; i++) {
      if ((elements[i].className || '').split(/\s+/).length > (elements[best].className || '').split(/\s+/).length) best = i;
    }
    return best;
  }

  let lastPhaseIndex = -1;
  function pollPhase() {
    const els = phaseBarElements();
    if (els.length !== PHASE_ORDER.length) return; // phase bar not on screen right now — nothing to detect
    const cur = currentPhaseIndex(els);
    if (cur === lastPhaseIndex) return;
    lastPhaseIndex = cur;
    const settingKey = PHASE_SETTING_KEY[cur];
    if (!settingKey) return; // DP/BP/EP — no trigger for those
    if (!getSetting('dt_auto_hand_shuffle_enabled', false)) return;
    if (!getSetting(settingKey, true)) return;
    requestShuffle();
  }
  setInterval(pollPhase, 300);

  console.log('[Duel Tools] Auto Hand Shuffling ready');
})();
