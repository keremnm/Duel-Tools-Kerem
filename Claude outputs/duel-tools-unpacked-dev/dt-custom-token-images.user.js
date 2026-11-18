// ==UserScript==
// @name         Duel Tools — Custom Token Images
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  Locally reskins every "Token" monster's art on the field — yours AND your opponent's — with your uploaded images, stepping through up to 5 assigned slots, counted separately per controller. Mirrors the right swapped art into DuelingBook's own hover-preview panel too. Per Settings → Appearance Customization → Add Custom Images/Themes/Colors/Emotes → Custom Token Images. LOCAL ONLY — see header for why.
// @match        https://www.duelingbook.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// ── v2.0 — rebuilt against 5 real Tokens in a live duel ──────────────────────
// v1 assumed (from reading duel.js/main.js's summonToken, without having
// live Token cards to check against) that the on-field <img> would carry a
// plain images.duelingbook.com/card-tokens/… or /tokens/… src, so it matched
// on that URL pattern. Watched live with the user mid-duel (5 real Tokens
// already on their field) and that was wrong: by the time a Token card is
// actually in the DOM, its artwork has already been converted to a
// data:image/… URI by DuelingBook's own card-recycling/caching layer — the
// src-pattern selector matched 0 of the 5 real cards. What actually holds
// the artwork, confirmed live: every rendered card is a `.cardfront_content`
// (same structural class used everywhere else in this extension — Card
// Language, Card Text Size, etc.) with a `.name_txt` span (confirmed
// literally "Token" for a Token monster, matching summonToken's own
// `name: 'Token'`) and a `.pic` <img> child holding the actual artwork —
// confirmed live by swapping one real Token's `.pic.src` and watching the
// card's picture change on screen. This version targets `.pic` inside a
// `.name_txt === 'Token'` card directly, which needs no URL-shape
// assumptions at all and isn't racing DuelingBook's own caching.
//
// ── Per-controller slot counting, per the user's own follow-up ──────────────
// Both the user's own Tokens and their opponent's get reskinned (neither
// side of this touches the real summon or the network either way — see
// below), but the 1st/2nd/3rd… counting runs SEPARATELY per side: your 3rd
// Token always gets slot 3 regardless of how many your opponent has out,
// and vice versa — the two counts don't share or consume from each other.
// Side is read the same confirmed way as the duel zone grid work: the
// viewer's own row renders in the near/bottom half of #duel, the opponent's
// in the far/top half; classified here by comparing each Token's own
// vertical center against #duel's vertical midpoint — reconfirmed live this
// same session (5 real Tokens, all in the near/bottom half, all on the
// user's own side).
//
// ── v2.1 — fixed the hover-preview panel always showing slot 1 ──────────────
// User reported: DuelingBook's own top-left card-preview panel (the one that
// pops up on hover with a big copy of the card) never updated per-token — it
// always showed whatever the 1st slot's art was, no matter which of the 5
// on-field Tokens was actually hovered. Root cause, found live: DuelingBook's
// `#preview` panel is itself built from the exact same `.cardfront_content`/
// `.name_txt`/`.pic` structure as a real on-field card, AND it lives INSIDE
// `#duel` — so v2.0's field query (`duelEl.querySelectorAll('.cardfront_content')`
// filtered to name "Token") was matching it as a phantom 6th Token sitting
// near the top of `#duel`, permanently counting it into the opponent bucket
// at a fixed position and overwriting its `.pic.src` every cycle — which is
// exactly why it always looked frozen on one slot's art (confirmed live by
// byte-length-matching `#preview .pic.src` against each real field card's
// src: it was identical to the 1st on-field card's, regardless of which
// card was actually being hovered). Fixed two ways: (1) `#preview`'s own
// subtree is now explicitly excluded from the field-token query, so it can
// no longer be miscounted as a real card; (2) a dedicated mouseover/mouseout
// listener on `#duel` now directly mirrors whichever real on-field Token is
// actually hovered into `#preview .pic.src`, reasserted for a short burst
// after hover starts (DuelingBook's own preview-paint logic briefly flashes
// a loading placeholder before settling, confirmed live via a MutationObserver
// log — so a single one-shot copy on mouseover can lose that race) and
// stopped on mouseout. Only runs while the feature is enabled.
//
// ── Confirmed by reading DuelingBook's own code ──────────────────────────────
// Fetched and read static.duelingbook.com/duel.js and /main.js directly.
// When a Token is summoned, the only thing that ever crosses the network is
// a plain number (an id into DuelingBook's own built-in or per-account
// custom-token art, images.duelingbook.com/card-tokens/… or /tokens/…) —
// never an image. The receiving client (opponent, spectators) always
// rebuilds the picture itself from that number against DuelingBook's own
// server. There is no field anywhere in this flow for an arbitrary image or
// URL, so an image that only lives in THIS extension's local storage can
// never reach anyone else's screen — not the opponent, not a spectator, not
// even this same account on a different device/browser. The user was told
// this plainly and explicitly chose to build it anyway as a personal,
// local-only reskin: DuelingBook finishes summoning each Token completely
// normally first — so the real summon, and what the opponent/spectators see
// on THEIR screens, are both entirely untouched — then this swaps that
// card's `.pic` src on screen, for this browser only. Disabling the
// feature, or clearing a slot, restores DuelingBook's own original image
// for every affected card.
(function () {
  'use strict';

  const DEFAULTS = {
    dt_custom_tokens_enabled: false,
    dt_custom_tokens_library: [],
    dt_custom_tokens_slot1: null,
    dt_custom_tokens_slot2: null,
    dt_custom_tokens_slot3: null,
    dt_custom_tokens_slot4: null,
    dt_custom_tokens_slot5: null,
    dt_custom_tokens_use_slot1_for_all: false
  };
  const SLOT_KEYS = ['dt_custom_tokens_slot1', 'dt_custom_tokens_slot2', 'dt_custom_tokens_slot3', 'dt_custom_tokens_slot4', 'dt_custom_tokens_slot5'];

  // Set by readAndApply() every cycle; read by the hover-preview mirror
  // below so it stays a no-op while the feature is off.
  let featureEnabled = false;

  function dataUrlFor(library, id) {
    if (!id) return null;
    const entry = library.find((e) => e.id === id);
    return entry ? entry.dataUrl : null;
  }

  // Near/bottom half of #duel = the viewer's own row — confirmed live
  // against 5 real Tokens this same session (see header), same convention
  // already confirmed for the duel zone grid.
  function sideOf(pic, fieldMidY) {
    const r = pic.getBoundingClientRect();
    return (r.top + r.height / 2) > fieldMidY ? 'mine' : 'opponent';
  }

  function readAndApply() {
    chrome.storage.local.get(DEFAULTS, (s) => {
      const duelEl = document.getElementById('duel');
      if (!duelEl) return; // not in a duel right now

      const enabled = !!s.dt_custom_tokens_enabled;
      featureEnabled = enabled;
      const library = s.dt_custom_tokens_library || [];
      const slots = SLOT_KEYS.map((k) => s[k]);
      const useAll = !!s.dt_custom_tokens_use_slot1_for_all;
      const fieldRect = duelEl.getBoundingClientRect();
      const fieldMidY = fieldRect.top + fieldRect.height / 2;

      const tokenPics = Array.from(duelEl.querySelectorAll('.cardfront_content'))
        .filter((card) => !card.closest('#preview')) // the hover-preview panel uses this same structure — not a real field card, see v2.1 header note
        .filter((card) => {
          const nameEl = card.querySelector('.name_txt');
          return nameEl && nameEl.textContent.trim() === 'Token';
        })
        .map((card) => card.querySelector('.pic'))
        .filter((pic) => {
          if (!pic) return false;
          const r = pic.getBoundingClientRect();
          return r.width > 0; // only actually-on-field cards, not the hidden recycled pool
        });

      // Recomputed from the current DOM every tick (not a persisted
      // counter), so it self-corrects if a Token leaves the field and a
      // later one should shift down a slot — tracked separately per side.
      const counts = { mine: 0, opponent: 0 };
      tokenPics.forEach((pic) => {
        const side = sideOf(pic, fieldMidY);
        counts[side] += 1;
        const count = counts[side];

        // Don't capture DuelingBook's own generic placeholder as "original"
        // — defer one tick until the real art has actually loaded in.
        const looksPlaceholder = pic.src.indexOf('blank.webp') !== -1;
        if (!pic.dataset.dtOriginalSrc && !looksPlaceholder) pic.dataset.dtOriginalSrc = pic.src;
        if (!pic.dataset.dtOriginalSrc) return; // still waiting on the real image to load

        let desiredSrc = pic.dataset.dtOriginalSrc;
        if (enabled) {
          const slotIndex = Math.min(count, 5) - 1;
          const effectiveId = (slotIndex > 0 && useAll) ? slots[0] : slots[slotIndex];
          const dataUrl = dataUrlFor(library, effectiveId);
          if (dataUrl) desiredSrc = dataUrl;
        }
        if (pic.src !== desiredSrc) pic.src = desiredSrc;
      });
    });
  }

  readAndApply();
  // Same convention as every other content script in this extension: poll
  // (robust against a full field rebuild) plus a debounced MutationObserver
  // for near-instant re-apply right as a Token is summoned/removed.
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

  // ── Hover-preview mirror (v2.1) ────────────────────────────────────────
  // Directly drives DuelingBook's own `#preview` panel to match whichever
  // real on-field Token is currently hovered, since the panel doesn't do
  // this correctly on its own once a card's `.pic` has been swapped (see
  // the v2.1 header note for how this was diagnosed live). `#preview` is
  // never matched by readAndApply's own field query, so nothing but this
  // listener ever touches it.
  let previewMirrorTimer = null;
  function stopPreviewMirror() {
    if (previewMirrorTimer) { clearInterval(previewMirrorTimer); previewMirrorTimer = null; }
  }
  function mirrorPreviewOnce(fieldCard) {
    const previewPic = document.querySelector('#preview .pic');
    const fieldPic = fieldCard.querySelector('.pic');
    if (!previewPic || !fieldPic) return;
    if (previewPic.src !== fieldPic.src) previewPic.src = fieldPic.src;
  }
  function setupPreviewMirror() {
    const duelEl = document.getElementById('duel');
    if (!duelEl) { setTimeout(setupPreviewMirror, 1000); return; }

    duelEl.addEventListener('mouseover', (e) => {
      if (!featureEnabled) return;
      const cardEl = e.target.closest('.cardfront_content');
      if (!cardEl || cardEl.closest('#preview')) return;
      const nameEl = cardEl.querySelector('.name_txt');
      if (!nameEl || nameEl.textContent.trim() !== 'Token') return;

      stopPreviewMirror();
      mirrorPreviewOnce(cardEl);
      // DuelingBook's own preview-paint briefly flashes a loading
      // placeholder before settling (confirmed live) — a single one-shot
      // copy can lose that race, so keep re-asserting for a short burst.
      let ticks = 0;
      previewMirrorTimer = setInterval(() => {
        mirrorPreviewOnce(cardEl);
        ticks += 1;
        if (ticks > 10) stopPreviewMirror(); // ~600ms safety cap
      }, 60);
    }, true);

    duelEl.addEventListener('mouseout', (e) => {
      const cardEl = e.target.closest('.cardfront_content');
      if (cardEl && !cardEl.closest('#preview')) stopPreviewMirror();
    }, true);
  }
  setupPreviewMirror();

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      const relevant = Object.keys(changes).some((k) =>
        k === 'dt_custom_tokens_enabled' ||
        k === 'dt_custom_tokens_library' ||
        k === 'dt_custom_tokens_use_slot1_for_all' ||
        SLOT_KEYS.indexOf(k) !== -1
      );
      if (relevant) readAndApply();
    });
  }

  console.log('[Duel Tools] Custom Token Images ready');
})();
