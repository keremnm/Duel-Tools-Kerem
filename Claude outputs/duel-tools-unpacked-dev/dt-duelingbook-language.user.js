// ==UserScript==
// @name         Duel Tools — DuelingBook Language
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Translates DuelingBook's own site text — menus, buttons, chat, modals, settings labels, everywhere except card rules text — into the language picked in Settings → Language Appearance → DuelingBook Language. English is the default (no-op, untouched native site text).
// @match        https://www.duelingbook.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// ── Scope — the opposite half of Card Language ──────────────────────────────
// Card Language (dt-card-language.user.js) translates a card's OWN rules
// text, matched by passcode, and deliberately leaves a card's name/type
// alone because other features (Card Tracking, Hotkeys, Deck Tools) match
// cards by their English name. This feature is the rest of the site: menus,
// buttons, chat messages, modal dialogs, labels in the duel room chrome,
// Lobby/Main Menu text, Settings-page-adjacent site text, etc. It therefore
// deliberately EXCLUDES, via `isExcluded()` below:
//   - Anything inside a `.cardfront_content` (a card's own name/type/rules —
//     entirely Card Language's job, never this feature's).
//   - Anything inside this extension's own injected UI — every element this
//     extension adds uses a `dt-` prefixed id or class (confirmed by this
//     file's own sibling scripts throughout this codebase), so excluding any
//     ancestor whose id or class starts with "dt-" keeps this feature from
//     ever touching the Settings overlay, the Live Tracker overlay, or any
//     other on-page UI this extension itself renders.
//   - <script>/<style>/<noscript> (never real visible text) and anything
//     inside a contentEditable region or an <input>/<textarea> (so a chat
//     box a person is actively typing into is never rewritten out from
//     under them — their own composed text is never a translation target
//     here; only rendered site TEXT NODES are).
//
// ── Why everything here is machine-translated ───────────────────────────────
// Card Language has an "official" tier because Yu-Gi-Oh! card text has real
// Konami-published translations to pull from (db.ygoprodeck.com). DuelingBook
// the SITE has never published itself in any language but English — there is
// no official source to pull from for "New Duel" or a chat message, full
// stop. So every language offered here goes through the same
// translate.googleapis.com endpoint Card Language already uses for its own
// unofficial tier (already a host_permission, already proven reachable from
// a duelingbook.com page with no key needed) — just applied to arbitrary UI
// text instead of a fixed set of known card-rules fields.
//
// ── Mechanism ────────────────────────────────────────────────────────────
// Walks visible text nodes under <body> with a TreeWalker, skipping excluded
// subtrees and whitespace/non-letter-only text (numbers, punctuation-only
// nodes, etc. — nothing to translate, and skipping them cuts API calls a
// lot since a huge fraction of DuelingBook's DOM text nodes are just stray
// whitespace between tags).
//
// Per text node, two WeakMaps track state across polls:
//   - originalMap: Text node -> last known ENGLISH (untranslated) string.
//   - appliedMap:  Text node -> the translated string currently showing,
//                  if this feature is the one that wrote it.
// On every tick, a node's CURRENT nodeValue is compared against what's in
// appliedMap: if they match, this feature's own translation is still
// showing and the tracked "original" is trusted as-is. If they don't match,
// the underlying text changed since last tick (DuelingBook re-used/updated
// the node — confirmed elsewhere in this codebase, e.g. recycled
// .cardfront elements) so the current value is treated as a FRESH English
// original and re-tracked. This mirrors how dt-card-language.user.js treats
// a reused card slot's passcode as fresh truth every tick rather than
// trusting stale state.
//
// Translation requests are deduplicated by (lang, text) through an
// in-memory Map plus a chrome.storage.local cache (so a phrase translated
// once, like a menu label every player sees, never needs a second network
// round-trip for any OTHER node showing that same text, this session or a
// future one), and capped at a small concurrency limit so a page full of
// fresh text (e.g. right after enabling the feature) doesn't fire off
// hundreds of simultaneous requests at once.
(function () {
  'use strict';

  const LANG_DEFAULT = 'en';
  const DEFAULTS = { dt_duelingbook_language_enabled: false, dt_duelingbook_language: LANG_DEFAULT };

  let featureEnabled = false;
  let currentLang = LANG_DEFAULT;

  const originalMap = new WeakMap(); // Text node -> english original
  const appliedMap = new WeakMap(); // Text node -> translated string we wrote

  const translationCache = new Map(); // "lang\u0001text" -> translated string | null (null = failed, don't retry this session)
  const inFlight = new Set(); // same key, currently being fetched
  const MAX_CONCURRENT = 4;
  let activeCount = 0;
  const queue = [];

  function cacheKey(lang, text) { return lang + '\u0001' + text; }

  // Short, stable hash for a chrome.storage.local key — text itself can be
  // long (a chat line, a modal paragraph) and storage keys should stay
  // reasonably short.
  function hashText(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function storageKey(lang, text) { return 'dt_dbl_' + lang + '_' + hashText(text); }

  function hasLetters(s) { return /[A-Za-zÀ-ɏͰ-῿Ⰰ-�]/.test(s); }

  function isExcluded(el) {
    return !!el.closest('.cardfront_content, script, style, noscript, textarea, input, [contenteditable], [contenteditable="true"], [id^="dt-"], [class^="dt-"], [id*=" dt-"]') ||
      !!el.closest('[id], [class]') && elementOrAncestorHasDtPrefix(el);
  }
  // closest() can't do a "any class token starts with dt-" match on its own
  // (CSS attribute selectors only match the whole attribute value or a
  // dash-prefixed token for [class|="dt"], not an arbitrary token prefix),
  // so multi-class elements like "dt-feature dt-subfeature" need an actual
  // walk. This is the real exclusion check; the closest() call above is a
  // fast-path for the common single-purpose dt- containers.
  function elementOrAncestorHasDtPrefix(el) {
    let node = el;
    while (node && node.nodeType === 1) {
      if (node.id && /^dt-/.test(node.id)) return true;
      if (node.classList) {
        for (let i = 0; i < node.classList.length; i++) {
          if (/^dt-/.test(node.classList[i])) return true;
        }
      }
      node = node.parentElement;
    }
    return false;
  }

  function collectTextNodes() {
    const out = [];
    const body = document.body;
    if (!body) return out;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node.nodeValue;
        if (!text || !text.trim() || !hasLetters(text)) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (isExcluded(parent)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let n;
    while ((n = walker.nextNode())) out.push(n);
    return out;
  }

  async function googleTranslate(text, targetLang) {
    if (!text) return '';
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=' +
      encodeURIComponent(targetLang) + '&dt=t&q=' + encodeURIComponent(text);
    const r = await fetch(url);
    if (!r.ok) throw new Error('translate http ' + r.status);
    const j = await r.json();
    if (!j || !j[0]) return text;
    return j[0].map((seg) => seg[0]).join('');
  }

  function pump() {
    while (activeCount < MAX_CONCURRENT && queue.length) {
      const job = queue.shift();
      activeCount++;
      job().finally(() => { activeCount--; pump(); });
    }
  }

  function requestTranslation(text, lang) {
    const key = cacheKey(lang, text);
    if (translationCache.has(key) || inFlight.has(key)) return;
    inFlight.add(key);
    const sKey = storageKey(lang, text);
    queue.push(() =>
      new Promise((resolve) => {
        chrome.storage.local.get([sKey], (s) => {
          if (s[sKey]) {
            translationCache.set(key, s[sKey]);
            inFlight.delete(key);
            resolve();
            return;
          }
          googleTranslate(text, lang).then((translated) => {
            translationCache.set(key, translated);
            inFlight.delete(key);
            const toStore = {};
            toStore[sKey] = translated;
            chrome.storage.local.set(toStore);
            resolve();
          }).catch(() => {
            translationCache.set(key, null);
            inFlight.delete(key);
            resolve();
          });
        });
      })
    );
    pump();
  }

  function setNodeValue(node, value) {
    if (node.nodeValue !== value) node.nodeValue = value;
  }

  function processNode(node) {
    const cur = node.nodeValue;

    if (!featureEnabled || currentLang === LANG_DEFAULT) {
      // Restore native English if this feature is the one currently showing
      // a translation; otherwise leave it alone (nothing of ours to undo).
      if (appliedMap.has(node) && cur === appliedMap.get(node)) {
        setNodeValue(node, originalMap.get(node));
        appliedMap.delete(node);
      }
      return;
    }

    let original;
    if (appliedMap.has(node) && cur === appliedMap.get(node)) {
      original = originalMap.get(node); // our own translation is still showing, trust the tracked original
    } else {
      original = cur; // fresh/changed text — this IS the new english original
      originalMap.set(node, original);
      appliedMap.delete(node);
    }

    if (!original || !original.trim() || !hasLetters(original)) return;

    const key = cacheKey(currentLang, original);
    if (translationCache.has(key)) {
      const translated = translationCache.get(key);
      if (translated != null && translated !== original) {
        setNodeValue(node, translated);
        appliedMap.set(node, translated);
      }
      return;
    }
    requestTranslation(original, currentLang);
  }

  function readAndApply() {
    chrome.storage.local.get(DEFAULTS, (s) => {
      featureEnabled = !!s.dt_duelingbook_language_enabled;
      const lang = s.dt_duelingbook_language || LANG_DEFAULT;
      if (lang !== currentLang) currentLang = lang; // per-node caches (originalMap/appliedMap) stay valid across a lang change — processNode re-evaluates each node fresh either way
      collectTextNodes().forEach(processNode);
    });
  }

  readAndApply();
  // Same convention as every other content script here: cheap poll (also
  // what actually drives the async translation apply once a queued fetch
  // resolves) plus a debounced MutationObserver for near-instant re-apply
  // when the page's text changes.
  setInterval(readAndApply, 1500);

  let mutationDebounce = null;
  function onMutation() {
    if (mutationDebounce) return;
    mutationDebounce = setTimeout(() => { mutationDebounce = null; readAndApply(); }, 150);
  }
  new MutationObserver(onMutation).observe(document.body, { childList: true, subtree: true, characterData: true });

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return;
      if (changes.dt_duelingbook_language || changes.dt_duelingbook_language_enabled) readAndApply();
    });
  }

  console.log('[Duel Tools] DuelingBook Language ready');
})();
