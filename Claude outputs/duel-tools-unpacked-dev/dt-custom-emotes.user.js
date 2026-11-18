// ==UserScript==
// @name         Duel Tools — Custom Emotes
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Replaces DuelingBook's own "Thinking" and "Signaled OK" avatar overlays with images, per Settings → Appearance Customization → Custom Emotes.
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// ── What this replaces ───────────────────────────────────────────────────
// Confirmed live against a real duel: each of the 4 avatar boxes
// (div.duel_avatar, id="avatar1".."avatar4") contains, among others, two
// plain <img> elements DuelingBook itself only ever toggles via
// opacity/transform/display on the SAME persistent element (never
// recreates either one), so swapping `src` once is enough for both:
//   • <img class="think" src=".../think.webp">        — "Thinking"
//   • <img (no class) src=".../svg/like_btn_up.svg">  — "Signaled OK",
//     wrapped in its own <div class="all_good"> (confirmed live), sized
//     via ITS OWN CSS (width:105px!important; height:97px) rather than the
//     img's — the img itself has no size constraint, which is why a custom
//     photo needs an explicit inline width/height/object-fit forced onto
//     it below (DuelingBook's own svg just happens to already fit).
//
// ── Image library model ──────────────────────────────────────────────────
// Per spec: this extension SHIPS with one built-in default image per slot
// (emotes/default-thinking.png, emotes/default-ok.png — bundled files, see
// manifest.json's web_accessible_resources) that's used automatically the
// instant the feature is turned on, with NOTHING else chosen yet. Those
// two bundled files can never be deleted. Anything the user themselves
// uploads is kept in a small per-slot "library" array (dt_custom_emote_
// thinking_library / dt_custom_emote_ok_library, each entry {id, dataUrl})
// instead of being overwritten on every new upload, so earlier uploads
// stay pickable later — dt_custom_emote_thinking_selected / _ok_selected
// holds either 'default' (use the bundled file) or one library entry's id.
// A selected id that no longer exists in the library (the user deleted it)
// silently falls back to 'default', same as it would on a fresh install.
(function () {
  'use strict';

  const ENABLED_KEY = 'dt_custom_emotes_enabled';
  const DEFAULT_THINK_SRC = 'https://images.duelingbook.com/think.webp';
  const DEFAULT_OK_SRC = 'https://images.duelingbook.com/svg/like_btn_up.svg';
  const BUILTIN_THINK_SRC = chrome.runtime.getURL('emotes/default-thinking.png');
  const BUILTIN_OK_SRC = chrome.runtime.getURL('emotes/default-ok.png');

  function resolveSlotSrc(selected, library, builtinSrc) {
    if (selected && selected !== 'default') {
      const entry = library.find((e) => e.id === selected);
      if (entry) return entry.dataUrl;
    }
    return builtinSrc;
  }

  function getSettings(cb) {
    chrome.storage.local.get(
      {
        [ENABLED_KEY]: false,
        dt_custom_emote_thinking_library: [],
        dt_custom_emote_thinking_selected: 'default',
        dt_custom_emote_ok_library: [],
        dt_custom_emote_ok_selected: 'default'
      },
      (s) => cb({
        enabled: !!s[ENABLED_KEY],
        thinkSrc: resolveSlotSrc(s.dt_custom_emote_thinking_selected, s.dt_custom_emote_thinking_library || [], BUILTIN_THINK_SRC),
        okSrc: resolveSlotSrc(s.dt_custom_emote_ok_selected, s.dt_custom_emote_ok_library || [], BUILTIN_OK_SRC)
      })
    );
  }

  function applyThink(enabled, thinkSrc) {
    const want = enabled ? thinkSrc : DEFAULT_THINK_SRC;
    document.querySelectorAll('img.think').forEach((img) => {
      if (img.getAttribute('src') !== want) img.setAttribute('src', want);
    });
  }

  function applyOk(enabled, okSrc) {
    const want = enabled ? okSrc : DEFAULT_OK_SRC;
    document.querySelectorAll('.duel_avatar .all_good img').forEach((img) => {
      if (img.getAttribute('src') !== want) img.setAttribute('src', want);
      if (enabled) {
        img.style.width = '105px';
        img.style.height = '97px';
        img.style.objectFit = 'contain';
      } else {
        img.style.removeProperty('width');
        img.style.removeProperty('height');
        img.style.removeProperty('object-fit');
      }
    });
  }

  function cleanupLegacyOkOverlay() {
    // Leftover from an earlier version of this script that misidentified a
    // different, unrelated element (.bubbles/svg) as "Signaled OK".
    document.querySelectorAll('img.dt-custom-ok-img').forEach((el) => el.remove());
    document.querySelectorAll('.duel_avatar .bubbles.dt-custom-ok').forEach((el) => el.classList.remove('dt-custom-ok'));
  }

  let current = { enabled: false, thinkSrc: BUILTIN_THINK_SRC, okSrc: BUILTIN_OK_SRC };

  function applyAll() {
    cleanupLegacyOkOverlay();
    applyThink(current.enabled, current.thinkSrc);
    applyOk(current.enabled, current.okSrc);
  }

  function refreshSettings() {
    getSettings((s) => { current = s; applyAll(); });
  }

  refreshSettings();

  // Fallback poll — covers avatar boxes that don't exist yet at script
  // start (e.g. this tab was already open and just joined/started a duel).
  setInterval(applyAll, 1000);

  // Live-applies the instant Settings writes a change, no page reload
  // needed.
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    const keys = [
      ENABLED_KEY,
      'dt_custom_emote_thinking_library', 'dt_custom_emote_thinking_selected',
      'dt_custom_emote_ok_library', 'dt_custom_emote_ok_selected'
    ];
    if (keys.some((k) => k in changes)) refreshSettings();
  });
})();
