// ==UserScript==
// @name         Duel Tools — Hot Keys
// @namespace    http://tampermonkey.net/
// @version      0.1
// @description  Keyboard shortcuts for Thinking / Thumbs Up / Previous Phase / Next Phase / End Turn, configured from the Kerem Duel Tools settings page.
// @match        https://www.duelingbook.com/*
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==
//
// Scope: "Playing" category — duelingbook.com only, NEVER /replay* pages
// (enforced below, not just by manifest injection, as a second safety net —
// see background.js's injectAll() for the actual gating). This is a LIVE
// DUEL feature: it clicks the actual buttons a real player would click, so
// it must never fire while just watching a replay.
//
// STATUS — all 5 actions CONFIRMED against a real live duel:
// - Thinking: real element is #think_btn (icon-only, no text — the old
//   findByExactText('Thinking') matched nothing). A plain .click() does
//   NOT work; confirmed live that it needs a full mousedown->mouseup->click
//   MouseEvent dispatch at the element's real center coordinates (same
//   idiom as dt-rps-engine.js's realClick() elsewhere in this project).
//   Confirmed via the Duel Log itself logging "Thinking" as a real action.
// - Thumbs Up / "OK" (the in-duel log literally calls it "Signaled OK"):
//   real element is #good_btn (class "like_btn"). Same deal as Thinking —
//   needs the full dispatch, plain .click() does nothing. Confirmed via
//   the Duel Log logging "Signaled OK".
// - Previous/Next Phase: dp/sp/m1/bp/m2/ep phase-bar element ids are
//   correct, and the "most classes = active" heuristic below is confirmed
//   correct (active phase carries class "phase active", others just
//   "phase"). Unlike Thinking/Thumbs Up, a PLAIN .click() IS sufficient
//   here — earlier live tests that looked like failures were just read too
//   soon: a phase click has a real server round-trip before the class
//   updates (~1-2s observed), so checking immediately after the click sees
//   the old state. Don't mistake that delay for the click not having
//   worked. (Separately, real game rules can also block a phase change —
//   e.g. the first-turn player cannot enter Battle Phase at all — which is
//   not a bug either.)
// - End Turn: findByExactText('End Turn') + plain .click() was already
//   correct and is unchanged.
(function () {
  'use strict';

  if (window.location.pathname.indexOf('/replay') === 0) return; // belt-and-suspenders — see background.js

  function getSetting(key, def) {
    try { return GM_getValue(key, def); } catch (e) { return def; }
  }

  // Must stay byte-for-byte in sync with SCHEME_DEFAULTS in dt-settings.js —
  // see that file's own comment for why these specific keys (corrected
  // against the user's reference screenshot of the target Hot Keys panel).
  const SCHEME_DEFAULTS = {
    wasd:   { thinking: 'W', prevPhase: 'A', nextPhase: 'D', thumbsUp: 'Space', endTurn: 'S' },
    arrows: { thinking: 'ArrowUp', prevPhase: 'ArrowLeft', nextPhase: 'ArrowRight', thumbsUp: 'Space', endTurn: 'ArrowDown' }
  };

  function findByExactText(text) {
    const all = document.querySelectorAll('body *');
    for (const el of all) {
      if (el.offsetParent === null) continue;
      const t = (el.textContent || '').trim();
      if (t !== text) continue;
      if (el.children.length && Array.from(el.children).some((c) => (c.textContent || '').trim() === text)) continue;
      return el;
    }
    return null;
  }

  // Confirmed real selector: #good_btn (class "like_btn") — the in-duel log
  // calls this action "Signaled OK". See the realClick() comment above
  // clickThinking/clickThumbsUp below for why this needs a full dispatch.
  function findThumbsUpButton() {
    return document.getElementById('good_btn');
  }

  // DuelingBook's own custom click handlers for these two icon buttons
  // don't respond to a plain .click() — confirmed live (no visible/logged
  // effect). They need a real mousedown->mouseup->click MouseEvent sequence
  // with real clientX/clientY at the element's center, same idiom as
  // dt-rps-engine.js's realClick() elsewhere in this project.
  function realClick(el) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const opts = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  const PHASE_ORDER = ['dp', 'sp', 'm1', 'bp', 'm2', 'ep'];
  let warnedPhase = false;
  function phaseBarElements() {
    return PHASE_ORDER.map((id) => document.getElementById(id)).filter(Boolean);
  }
  // Best-effort "which one is current": DuelingBook visually distinguishes
  // the active phase (seen live as a larger/brighter red circle) — without
  // a confirmed class name, this picks the element whose own class list is
  // the LONGEST among the phase bar (an active/highlighted state almost
  // always adds at least one extra class versus its idle siblings). Flags
  // a console warning rather than guessing silently wrong if that heuristic
  // ever ties or the bar isn't found at all.
  function currentPhaseIndex(elements) {
    if (!elements.length) return -1;
    let best = 0;
    for (let i = 1; i < elements.length; i++) {
      if ((elements[i].className || '').split(/\s+/).length > (elements[best].className || '').split(/\s+/).length) best = i;
    }
    return best;
  }
  function clickPhase(direction) {
    const els = phaseBarElements();
    if (els.length !== PHASE_ORDER.length) {
      if (!warnedPhase) { warnedPhase = true; console.warn('[Duel Tools Hotkeys] phase bar elements (dp/sp/m1/bp/m2/ep) not all found — Previous/Next Phase can\'t run on this page.'); }
      return;
    }
    const cur = currentPhaseIndex(els);
    const target = cur + direction;
    if (target < 0 || target >= els.length) return; // no phase to move to
    // Plain .click() is confirmed sufficient here (unlike Thinking/Thumbs
    // Up below) — see the STATUS comment at the top of this file. The
    // class update can lag ~1-2s behind a real server round-trip, which is
    // normal and not a sign the click failed.
    els[target].click();
  }

  // Thinking and Thumbs Up are icon-only buttons whose click handlers need
  // the full realClick() dispatch — a plain .click() is confirmed to do
  // nothing for either. See the STATUS comment at the top of this file.
  function clickThinking() { realClick(document.getElementById('think_btn')); }
  function clickEndTurn() { const el = findByExactText('End Turn'); if (el) el.click(); }
  function clickThumbsUp() { realClick(findThumbsUpButton()); }

  const ACTIONS = {
    thinking: clickThinking,
    thumbsUp: clickThumbsUp,
    endTurn: clickEndTurn,
    prevPhase: () => clickPhase(-1),
    nextPhase: () => clickPhase(1)
  };

  function isTypingTarget(el) {
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
  }

  function eventKey(e) { return e.code === 'Space' ? 'Space' : e.key; }

  // CONFIRMED LIVE BUG (user: "arrow keys work but wasd does not"): e.key
  // for an unshifted letter keypress is lowercase ("w"), but SCHEME_DEFAULTS
  // above stores uppercase ("W") to match the keycap display, and arrow
  // keys/Space have no case variant at all — so Arrows/Space "accidentally"
  // matched while every WASD letter silently never did. Normalizing single-
  // character keys to uppercase on BOTH sides of the comparison fixes this
  // for the defaults above AND for any key already saved from before this
  // fix (which could be stored in either case), with no migration needed.
  function normalizeKey(k) {
    if (!k) return k;
    return k.length === 1 ? k.toUpperCase() : k;
  }

  document.addEventListener('keydown', function (e) {
    if (isTypingTarget(e.target)) return; // never interferes with chat/typing — per spec
    if (!getSetting('dt_hotkeys_enabled', true)) return;

    const scheme = getSetting('dt_hotkeys_scheme', 'wasd');
    const keys = getSetting('dt_hotkeys_keys', SCHEME_DEFAULTS[scheme] || SCHEME_DEFAULTS.wasd);
    const enabled = getSetting('dt_hotkeys_action_enabled', { thinking: true, prevPhase: false, nextPhase: false, thumbsUp: true, endTurn: false });

    const pressed = normalizeKey(eventKey(e));
    for (const actionId of Object.keys(ACTIONS)) {
      if (!enabled[actionId]) continue;
      if (!keys[actionId] || normalizeKey(keys[actionId]) !== pressed) continue; // cleared/unbound key never matches
      e.preventDefault();
      ACTIONS[actionId]();
      return;
    }
  }, true);

  console.log('[Duel Tools Hotkeys] ready');
})();
