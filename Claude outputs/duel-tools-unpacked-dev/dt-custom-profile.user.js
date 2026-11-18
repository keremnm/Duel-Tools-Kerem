// ==UserScript==
// @name         Duel Tools — Custom Profile (Profile Picture + Card Sleeve)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Locally replaces YOUR OWN profile picture (the bottom player's avatar, in both live duels and replays) and YOUR OWN card sleeve (every face-down card of yours — deck, hand, field) with up to 5 uploaded images each, one active at a time. Your opponent's avatar and card backs are never touched. Per Settings → Appearance Customization → Add Custom Images/Themes/Colors/Emotes → Custom Profile. LOCAL ONLY — see header for why.
// @match        https://www.duelingbook.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// ── Confirmed live before writing a line of swap logic ───────────────────────
// Avatar: every player panel in a live duel AND a replay is a `.duel_avatar`
// DIV containing `img.image` (the actual photo — itself just a reference to
// one of DuelingBook's own card low-res images, e.g.
// images.duelingbook.com/low-res/9512.jpg; DuelingBook's own avatar picker
// works the same way, confirmed on the Profile page: `#my_profile .avatar
// .image`). Confirmed live with a real replay (2 real `.duel_avatar`
// instances rendered, out of 4 that exist in the DOM before a duel actually
// loads — the other 2 sit at 0×0 and are ignored here, same self-filtering
// every other feature in this extension already does): whichever one sits
// in the near/bottom half of #duel is the "bottom player" — same
// near-half-is-you convention already confirmed and used throughout this
// extension (the duel zone grid, Custom Token Images' per-side counting,
// etc.), re-verified here by checking both real `.duel_avatar` rects
// against #duel's own vertical midpoint. This holds in a replay too — the
// bottom slot is positional, not "whichever account is logged in" (a
// replay viewer isn't a player in it at all), which is exactly what the
// user asked for: swap whichever avatar renders at the bottom, live duel or
// replay alike.
//
// Card sleeve: DuelingBook renders every face-down card's back — the
// Deck/Extra Deck zone stacks, cards in a hand that isn't yours to see,
// Set monsters and Set Spells/Traps — from the same kind of image,
// `images.duelingbook.com/sleeves/<n>.jpg` (confirmed live: the same
// `#sleeve .image` element the user's own Profile page preview uses, same
// URL shape, same asset host). These are plain `<img>` elements scattered
// directly in the DOM near each pile — NOT nested inside the `#*_hidden`
// pile spans (confirmed live: those spans have zero `<img>` children of
// their own) — and DuelingBook draws a visible "stack" by layering several
// of them a few pixels apart per pile, so there can be a dozen or more
// real `<img src=".../sleeves/N.jpg">` elements on screen at once for one
// deck. Classified "mine" vs "opponent's" the same way as the avatar above:
// by comparing each sleeve image's own vertical center against #duel's
// midpoint — confirmed live against a real board (every sleeve image near
// the bottom half matched the near/mine piles, every one in the top half
// matched the opponent's).
//
// Per the user's own explicit choice when asked: the sleeve swap is
// "mine only" — your opponent's card backs are left exactly as
// DuelingBook renders them, matching the same scope as the avatar swap,
// not the "both sides" approach Custom Token Images uses. DuelingBook's
// own hover-preview panel (`#preview`, fixed near the top-left of the
// screen — see Custom Token Images' own header for how that panel was
// characterized) sits in what this script's near/far test always reads as
// "opponent's" territory regardless of whose card is actually being
// previewed, so hovering one of your own Set cards shows DuelingBook's own
// native sleeve in that preview popup rather than your uploaded one — a
// minor, deliberate gap rather than risking a wrong guess there.
//
// LOCAL ONLY, same reasoning as Custom Token Images: both the avatar photo
// and the sleeve art are just asset references DuelingBook's own client
// renders from account data it already has (a card id for the avatar, a
// sleeve number for the card back) — there is no field in DuelingBook's
// actual network traffic for an arbitrary uploaded image, so a swap that
// only lives in this browser's local extension storage can never reach
// your opponent's screen, a spectator's screen, or even this same account
// on a different device. Disabling either toggle, or removing the active
// image, restores DuelingBook's own original avatar/sleeve immediately.
(function () {
  'use strict';

  const DEFAULTS = {
    dt_custom_profile_enabled: false,
    dt_custom_profile_library: [], // [{id, dataUrl}], cap 5 (enforced in the settings UI)
    dt_custom_profile_active_id: null,
    dt_custom_sleeve_enabled: false,
    dt_custom_sleeve_library: [], // [{id, dataUrl}], cap 5
    dt_custom_sleeve_active_id: null
  };
  const RELEVANT_KEYS = Object.keys(DEFAULTS);

  function dataUrlFor(library, id) {
    if (!id) return null;
    const entry = (library || []).find((e) => e.id === id);
    return entry ? entry.dataUrl : null;
  }

  // Near/bottom half of #duel = the viewer's own row — same convention
  // already confirmed live and used throughout this extension (duel zone
  // grid, Custom Token Images). Re-confirmed live for both the avatar and
  // the sleeve images specifically, see this file's own header.
  function isMine(el, fieldMidY) {
    const r = el.getBoundingClientRect();
    return (r.top + r.height / 2) > fieldMidY;
  }

  function applyAvatar(duelEl, fieldMidY, s) {
    const enabled = !!s.dt_custom_profile_enabled;
    const desiredDataUrl = enabled ? dataUrlFor(s.dt_custom_profile_library, s.dt_custom_profile_active_id) : null;

    Array.from(duelEl.querySelectorAll('.duel_avatar')).forEach((av) => {
      const r = av.getBoundingClientRect();
      if (r.width < 10) return; // one of the dormant pre-duel instances — not actually on screen
      if (!isMine(av, fieldMidY)) return; // opponent's avatar — never touched

      const img = av.querySelector('img.image');
      if (!img) return;
      const looksPlaceholder = img.src.indexOf('blank.png') !== -1;
      if (!img.dataset.dtOriginalSrc && !looksPlaceholder) img.dataset.dtOriginalSrc = img.src;
      if (!img.dataset.dtOriginalSrc) return; // still waiting on the real avatar to load in

      const desiredSrc = desiredDataUrl || img.dataset.dtOriginalSrc;
      if (img.src !== desiredSrc) img.src = desiredSrc;
    });
  }

  function applySleeve(fieldMidY, s) {
    const enabled = !!s.dt_custom_sleeve_enabled;
    const desiredDataUrl = enabled ? dataUrlFor(s.dt_custom_sleeve_library, s.dt_custom_sleeve_active_id) : null;

    // Queried document-wide, not scoped under #duel — DuelingBook draws the
    // stacked sleeve images as plain siblings positioned near each pile,
    // not nested inside it (confirmed live, see header).
    Array.from(document.querySelectorAll('img[src*="/sleeves/"]')).forEach((img) => {
      const r = img.getBoundingClientRect();
      if (r.width < 5) return; // not actually on screen
      if (!isMine(img, fieldMidY)) return; // opponent's card backs — left alone, per the user's own choice

      const isNativeSleeve = /\/sleeves\/\d+\.(jpg|jpeg|png|webp)(\?|$)/i.test(img.src);
      if (!img.dataset.dtOriginalSrc && isNativeSleeve) img.dataset.dtOriginalSrc = img.src;
      if (!img.dataset.dtOriginalSrc) return; // not a plain native sleeve image (e.g. already something else) — leave it alone

      const desiredSrc = desiredDataUrl || img.dataset.dtOriginalSrc;
      if (img.src !== desiredSrc) img.src = desiredSrc;
    });
  }

  function readAndApply() {
    chrome.storage.local.get(DEFAULTS, (s) => {
      const duelEl = document.getElementById('duel');
      if (!duelEl) return; // not in a duel or replay right now
      const fieldRect = duelEl.getBoundingClientRect();
      if (fieldRect.height < 10) return; // board not actually laid out yet
      const fieldMidY = fieldRect.top + fieldRect.height / 2;

      applyAvatar(duelEl, fieldMidY, s);
      applySleeve(fieldMidY, s);
    });
  }

  readAndApply();
  // Same convention as every other content script in this extension: poll
  // (robust against a full field rebuild) plus a debounced MutationObserver
  // for near-instant re-apply right as the sleeve stack or avatar changes.
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
      const relevant = Object.keys(changes).some((k) => RELEVANT_KEYS.indexOf(k) !== -1);
      if (relevant) readAndApply();
    });
  }

  console.log('[Duel Tools] Custom Profile ready');
})();
