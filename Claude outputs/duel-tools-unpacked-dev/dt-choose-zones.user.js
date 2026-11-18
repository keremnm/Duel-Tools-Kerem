// ==UserScript==
// @name         Duel Tools — Choose Zones
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Sets DuelingBook's own "Choose Zones" checkbox to match your saved Duel Tools preference at the start of each duel, so you don't have to click it yourself every time. Off by default.
// @match        https://www.duelingbook.com/*
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==
//
// DuelingBook's own "Choose Zones" control is a real native checkbox,
// confirmed live against the actual duel page: <input id="choose_zones_cb"
// type="checkbox"> with a <span id="choose_zones_lbl">Choose Zones</span>
// label, both inside <div id="choose_zones">, which lives directly under
// #duel_content — the same player-action-row area as Admit Defeat / Offer
// Draw / Call Judge / Quit (confirmed via a screenshot with "Choose Zones"
// circled right next to Quit).
//
// This script adds no UI of its own — it just drives that real checkbox
// with a genuine .click() (so DuelingBook's own change handler actually
// fires, same as a real player clicking it, not just a visual flip).
//
// Two settings, per spec:
//  - dt_choose_zones_enabled: master switch — whether Duel Tools touches
//    this checkbox at all. Off by default, and when off this script never
//    touches the checkbox, full stop.
//  - dt_choose_zones_default_state: which state (On/Off) to force the
//    checkbox to once the master is on. Off by default.
//
// Sync timing: once per duel's checkbox element, not on every poll tick.
// DuelingBook tears down and recreates #choose_zones_cb between duels, so
// a freshly-seen element (no dt-synced marker on it yet) means "a new duel
// just started, apply my preference" — that naturally resets itself with
// no duel-id bookkeeping needed. If dt_choose_zones_default_state changes
// while a duel's checkbox is already synced (the player edits Settings
// mid-duel), or the master gets flipped back on mid-duel, that re-applies
// immediately too. Otherwise, a manual click by the player during that
// same duel is left alone — this only sets the INITIAL state per duel, it
// doesn't fight the player afterward.
(function () {
  'use strict';

  if (window.location.pathname.indexOf('/replay') === 0) return; // live duels only, not replays

  function getSetting(key, def) {
    try { return typeof GM_getValue === 'function' ? GM_getValue(key, def) : def; } catch (e) { return def; }
  }

  var lastEnabled = null;
  var lastDesired = null;

  function sync() {
    var enabled = !!getSetting('dt_choose_zones_enabled', false);
    var desired = !!getSetting('dt_choose_zones_default_state', false);
    var cb = document.getElementById('choose_zones_cb');
    if (!cb || cb.offsetParent === null) return; // not in a duel right now, or control not visible

    var enabledChanged = (lastEnabled !== null && lastEnabled !== enabled);
    var desiredChanged = (lastDesired !== null && lastDesired !== desired);
    lastEnabled = enabled;
    lastDesired = desired;

    if (!enabled) return; // master off: never touch the checkbox

    var alreadySynced = cb.dataset.dtSynced === '1';
    if (alreadySynced && !desiredChanged && !enabledChanged) return; // this duel's checkbox already matches our preference

    if (cb.checked !== desired) {
      cb.click(); // a real click, so DuelingBook's own handler actually changes behavior, not just the checkbox's look
    }
    cb.dataset.dtSynced = '1';
  }

  setInterval(sync, 500);
  sync();
  console.log('[Duel Tools] Choose Zones sync ready');
})();
