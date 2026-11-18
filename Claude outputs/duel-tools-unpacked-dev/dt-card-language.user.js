// ==UserScript==
// @name         Duel Tools — Card Language
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Translates every card's name AND rules/effect text — on the field, in hand, in the hover/selected preview, deck constructor, siding, replays — into the language picked in Settings → Language Appearance → Card Language. Off by default (dt_card_language_enabled=false forces English/no-op regardless of the stored language choice, so a user who picked a language earlier doesn't see it silently re-enable).
// @match        https://www.duelingbook.com/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// ── How card identity works (confirmed live) ────────────────────────────────
// Every rendered card — on the field, in a hand, in the big top-left/hover
// #preview panel, in the deck constructor — is a `.cardfront_content` with a
// `.passcode_txt` sibling holding the card's real numeric passcode (confirmed
// live: Gravekeeper's Spy → "24317029", matches its real passcode). The
// passcode is NEVER translated by the site and is always plain digits, so
// it's used as the only identity key here — never the card's name or the
// element's current (possibly already-translated) text. This also means a
// recycled DOM node (DuelingBook reuses `.cardfront` elements between
// different cards — confirmed via the page's own `recycled_cardfronts_arr`/
// `recycleCardFronts` globals) just works: whichever passcode is in the slot
// *right now* is what gets looked up, every poll tick.
//
// Rules/effect text lives in `.effect_txt` (every normal monster/spell/trap,
// and a Pendulum monster's own upper monster-effect line) and, for Pendulum
// monsters specifically, an additional `.card_pendulum_effect_txt` for the
// lower Pendulum Effect box — same two classes already confirmed live and
// used by dt-card-text-size.user.js. These are translated by a direct
// textContent rewrite, same as v1.0/v1.1 — nothing else in this extension
// matches a card by its rules text, so that's always been safe.
//
// The card's NAME (`.name_txt`) is translated too as of v1.2, but NOT via a
// textContent rewrite — see the big comment above applyNameTranslation()
// further down for exactly why (short version: other features match cards
// by their English name, so the real `.name_txt` node is left alone forever
// and a visual overlay is drawn on top of it instead). Still deliberately
// NOT touched: the type line (`.monster_line`/`.type_txt`) — out of scope,
// matches what the user's own reference screenshot circled (name + effect-
// text specifically).
//
// ── Where the translations come from — two honest tiers ─────────────────────
// Confirmed LIVE this session, by actually calling the API from a
// duelingbook.com page (https://db.ygoprodeck.com is already in this
// extension's host_permissions) with a real passcode (Gravekeeper's Spy,
// 24317029) and reading back real results:
//   - OFFICIAL tier — English, French, German, Italian, Portuguese. These
//     come back from https://db.ygoprodeck.com/api/v7/cardinfo.php as genuine
//     Konami-published card text (confirmed: ?language=fr for 24317029 came
//     back "Espion des Protecteurs du Tombeau" / a real French ruling, not a
//     stub). Spanish, Japanese and Korean also return real text from this
//     API, but Spanish isn't one of the 12 the user asked for as "official"-
//     feeling (see below) and Japanese/Korean weren't asked for at all, so
//     neither is exposed as a language choice here.
//   - MACHINE tier — Spanish, Arabic, Turkish, Croatian, Russian, Serbian,
//     Greek. Confirmed LIVE: YGOPRODeck's API returns HTTP 400 for every one
//     of these language codes (es/ar/tr/hr/ru/sr/el) — Yu-Gi-Oh has never
//     been officially printed in any of them, so there is no Konami-sourced
//     text to show, full stop. Rather than silently falling back to English
//     for 7 of the user's 12 requested languages, or — far worse — inventing
//     plausible-sounding but unverified rules text myself, this translates
//     the real English ruling on the fly via Google Translate's public
//     endpoint (confirmed reachable from a duelingbook.com page with no key
//     needed; translate.googleapis.com is a new host_permission added for
//     exactly this). These are clearly labelled "(machine-translated)" in
//     the language picker and in a note under it, because they are NOT
//     Konami text and CAN contain mistakes in exact rules wording — treat
//     them as a convenience for reading along, not a ruling source.
// Even within the official tier, per-card data can have real gaps (confirmed
// live: Odd-Eyes Pendulum Dragon's French `pend_desc` came back still in
// English while its `monster_desc` was properly translated — an actual hole
// in YGOPRODeck's own community-sourced French data, not a bug here). When a
// field comes back empty or untranslated, this just shows whatever the API
// actually returned — never papering over it with an invented translation.
//
// Pendulum split: YGOPRODeck gives Pendulum monsters two separate fields,
// `pend_desc` and `monster_desc`, matching DuelingBook's own two separate
// elements 1:1 — no fragile text-splitting needed. Non-Pendulum cards only
// ever populate `desc`, which maps straight onto `.effect_txt`.
(function () {
  'use strict';

  const LANG_DEFAULT = 'en';
  const OFFICIAL_LANGS = ['fr', 'de', 'it', 'pt'];
  const MACHINE_LANGS = ['es', 'ar', 'tr', 'hr', 'ru', 'sr', 'el'];

  const DEFAULTS = { dt_card_language_enabled: false, dt_card_language: LANG_DEFAULT };

  // In-memory cache, mirrors chrome.storage.local so the 1.5s poll never has
  // to round-trip to storage for a card it's already resolved this session.
  // Keyed 'passcode' -> { desc, pend_desc, monster_desc } for the CURRENT lang
  // only (cleared whenever the selected language changes).
  let currentLang = LANG_DEFAULT;
  const resolved = new Map(); // passcode -> { desc, pend_desc, monster_desc } | null (null = fetch failed, don't retry this tick)
  const inFlight = new Set(); // passcodes currently being fetched, avoid duplicate requests
  const englishCache = new Map(); // passcode -> english { desc, pend_desc, monster_desc }, needed as machine-translation input

  function storageKey(lang, passcode) { return 'dt_cl_' + lang + '_' + passcode; }

  function readCacheThenMaybeFetch(passcode) {
    if (resolved.has(passcode) || inFlight.has(passcode)) return;
    inFlight.add(passcode);
    const key = storageKey(currentLang, passcode);
    chrome.storage.local.get([key], (s) => {
      const cached = s[key];
      if (cached) {
        resolved.set(passcode, cached);
        inFlight.delete(passcode);
        return;
      }
      fetchTranslation(passcode, currentLang).then((data) => {
        resolved.set(passcode, data);
        inFlight.delete(passcode);
        if (data) {
          const toStore = {};
          toStore[key] = data;
          chrome.storage.local.set(toStore);
        }
      }).catch(() => {
        resolved.set(passcode, null);
        inFlight.delete(passcode);
      });
    });
  }

  async function fetchOfficialEnglish(passcode) {
    if (englishCache.has(passcode)) return englishCache.get(passcode);
    try {
      const r = await fetch('https://db.ygoprodeck.com/api/v7/cardinfo.php?id=' + encodeURIComponent(passcode));
      if (!r.ok) { englishCache.set(passcode, null); return null; }
      const j = await r.json();
      const d = j && j.data && j.data[0];
      const out = d ? { name: d.name || '', desc: d.desc || '', pend_desc: d.pend_desc || '', monster_desc: d.monster_desc || '' } : null;
      englishCache.set(passcode, out);
      return out;
    } catch (e) {
      englishCache.set(passcode, null);
      return null;
    }
  }

  async function fetchOfficial(passcode, lang) {
    try {
      const r = await fetch('https://db.ygoprodeck.com/api/v7/cardinfo.php?id=' + encodeURIComponent(passcode) + '&language=' + encodeURIComponent(lang));
      if (!r.ok) return null;
      const j = await r.json();
      const d = j && j.data && j.data[0];
      if (!d) return null;
      return { name: d.name || '', desc: d.desc || '', pend_desc: d.pend_desc || '', monster_desc: d.monster_desc || '' };
    } catch (e) {
      return null;
    }
  }

  async function googleTranslate(text, targetLang) {
    if (!text) return '';
    try {
      const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=' +
        encodeURIComponent(targetLang) + '&dt=t&q=' + encodeURIComponent(text);
      const r = await fetch(url);
      if (!r.ok) return text;
      const j = await r.json();
      if (!j || !j[0]) return text;
      return j[0].map((seg) => seg[0]).join('');
    } catch (e) {
      return text;
    }
  }

  async function fetchMachine(passcode, targetLang) {
    const en = await fetchOfficialEnglish(passcode);
    if (!en) return null;
    const [name, desc, pend_desc, monster_desc] = await Promise.all([
      googleTranslate(en.name, targetLang),
      googleTranslate(en.desc, targetLang),
      googleTranslate(en.pend_desc, targetLang),
      googleTranslate(en.monster_desc, targetLang)
    ]);
    return { name, desc, pend_desc, monster_desc };
  }

  function fetchTranslation(passcode, lang) {
    if (lang === LANG_DEFAULT) return fetchOfficialEnglish(passcode); // restores true native text if a card was previously translated
    if (OFFICIAL_LANGS.indexOf(lang) !== -1) return fetchOfficial(passcode, lang);
    if (MACHINE_LANGS.indexOf(lang) !== -1) return fetchMachine(passcode, lang);
    return Promise.resolve(null);
  }

  function setText(el, text) {
    if (!el) return;
    const next = text == null ? '' : text;
    if (el.textContent !== next) el.textContent = next;
  }

  // ── Card NAME translation — an overlay, never a textContent rewrite ────────
  // Deliberately different from the rules-text handling above. Several OTHER
  // features in this extension (Card Tracking, Live Tracker, RPS engine/
  // automation) identify a card by reading `.name_txt`'s own textContent and
  // matching it against English names (a decklist, an online name search for
  // card art/YDK export, "Rock"/"Paper"/"Scissors" detection) — confirmed via
  // grep across dt-card-tracking.user.js, dt-live-tracker.user.js,
  // dt-rps-engine.js and dt-rps-automation.user.js, all of which read
  // `.name_txt` directly and would silently break (wrong/no art, failed YDK
  // passcode resolution, wrong RPS pick) if that text ever actually became a
  // translated string. Rather than hunt down and rewrite every one of those
  // (a much bigger, riskier change the user didn't ask for), the real
  // `.name_txt` node's textContent is NEVER touched here — it is always,
  // permanently, DuelingBook's own native English text, so every other
  // feature keeps working exactly as before, translated or not.
  //
  // Instead, a sibling `<span>` is positioned exactly on top of it (confirmed
  // live: `.name_txt` is already `position: absolute` with its own inline
  // `left`/`top`/`color`/`transform: scaleX(…)` — DuelingBook itself renders
  // every name at one fixed large design font-size, 80.4px of
  // "MatrixRegularSmallCaps", then horizontally squeezes it with that
  // scaleX so a long name still fits its frame's name box) showing the
  // translated text, while the real node underneath is hidden with
  // `visibility: hidden` (confirmed live: this keeps its layout box, and
  // therefore its real textContent, completely intact for any other script
  // that reads it — only painting is suppressed). Confirmed live on both an
  // on-field card and the #preview panel (`#preview .cardfront_content`
  // uses this exact same markup, see dt-custom-token-images.user.js's own
  // v2.1 notes for that structural fact) — so translating here automatically
  // covers "on the card" and "in the preview panel" at once, no special-
  // casing #preview needed.
  //
  // The overlay's own scaleX is recomputed from scratch for the translated
  // text, not just copied from the original: DuelingBook only ever
  // calculates that scaleX once, for the ORIGINAL English name, so reusing
  // it verbatim for a differently-sized translated string would under- or
  // over-squeeze it. Confirmed-live math: this card's own current scaleX
  // times the ENGLISH name's natural (unsqueezed) width equals the fixed
  // pixel width DuelingBook decided this name box should be — that width is
  // then divided by the TRANSLATED name's own natural width to get a new
  // scaleX that fits the translated text into that exact same box (capped
  // at 1 so a short translation is never stretched past its own natural
  // size — DuelingBook's own scaleX is never seen going above 1 either).
  let measurerEl = null;
  function getMeasurer() {
    if (measurerEl && measurerEl.isConnected) return measurerEl;
    measurerEl = document.createElement('span');
    measurerEl.style.position = 'fixed';
    measurerEl.style.visibility = 'hidden';
    measurerEl.style.left = '-99999px';
    measurerEl.style.top = '0';
    measurerEl.style.whiteSpace = 'nowrap';
    measurerEl.style.pointerEvents = 'none';
    document.documentElement.appendChild(measurerEl);
    return measurerEl;
  }

  // CONFIRMED LIVE (a real duel — v1.2's `visibility: hidden` worked
  // perfectly in the Deck Constructor's static preview, then immediately
  // garbled into overlapping English+translated glyphs the instant it was
  // tried against a card in an actual LIVE duel's preview): DuelingBook
  // periodically rewrites `.name_txt`'s entire `style` ATTRIBUTE wholesale
  // during a live duel (confirmed: our `visibility: hidden` was gone,
  // completely absent from the attribute string, within a couple of
  // seconds, even though nothing about the card itself had changed) — the
  // same "self-healing" class of bug already hit and fixed once this
  // session for dt-custom-colors-duel.user.js's signature cache. A plain
  // poll-and-reapply (every 1.5s) isn't fast enough to win that race
  // reliably, so instead a dedicated MutationObserver watches THIS ONE
  // node's `style` attribute specifically and re-asserts `visibility:
  // hidden` the instant DuelingBook's own rewrite clears it — confirmed
  // live to hold cleanly for 4+ seconds straight under this fix, vs.
  // reverting within ~1-2s without it.
  function ensureNameVisibilityObserver(nameEl) {
    if (nameEl.__dtVisObserver) return;
    const obs = new MutationObserver(() => {
      if (nameEl.__dtWantHidden && nameEl.style.visibility !== 'hidden') {
        nameEl.style.visibility = 'hidden';
      }
    });
    obs.observe(nameEl, { attributes: true, attributeFilter: ['style'] });
    nameEl.__dtVisObserver = obs;
  }

  function clearNameOverlay(nameEl) {
    if (nameEl.__dtOverlay) nameEl.__dtOverlay.style.display = 'none';
    nameEl.__dtWantHidden = false;
    nameEl.style.visibility = '';
  }

  function applyNameTranslation(front, passcode, data) {
    const nameEl = front.querySelector('.name_txt');
    if (!nameEl) return;
    ensureNameVisibilityObserver(nameEl);

    if (nameEl.__dtOverlayPasscode !== passcode) {
      // This slot now shows a different card than whichever one the
      // overlay (if any) was last drawn for — e.g. a recycled DOM node
      // DuelingBook just reused for a new card. Clear immediately,
      // regardless of whether the NEW card's translation has resolved
      // yet, so a stale translated name from the OLD card can never cover
      // the freshly-swapped-in real English name underneath.
      clearNameOverlay(nameEl);
      nameEl.__dtOverlayPasscode = passcode;
    }

    const englishName = nameEl.textContent; // always real, untouched, native — see header note above
    const translatedName = data && data.name;
    if (!translatedName || translatedName === englishName) {
      clearNameOverlay(nameEl);
      return;
    }

    let overlay = nameEl.__dtOverlay;
    if (!overlay) {
      overlay = document.createElement('span');
      overlay.setAttribute('aria-hidden', 'true');
      overlay.style.position = 'absolute';
      overlay.style.whiteSpace = 'nowrap';
      overlay.style.pointerEvents = 'none';
      overlay.style.transformOrigin = 'left top';
      nameEl.insertAdjacentElement('afterend', overlay);
      nameEl.__dtOverlay = overlay;
    }

    const cs = getComputedStyle(nameEl);
    overlay.style.left = nameEl.style.left || cs.left;
    overlay.style.top = nameEl.style.top || cs.top;
    overlay.style.color = nameEl.style.color || cs.color;
    overlay.style.fontFamily = cs.fontFamily;
    overlay.style.fontSize = cs.fontSize;
    overlay.style.fontWeight = cs.fontWeight;
    overlay.style.lineHeight = cs.lineHeight;
    overlay.style.letterSpacing = cs.letterSpacing;

    const measurer = getMeasurer();
    measurer.style.fontFamily = cs.fontFamily;
    measurer.style.fontSize = cs.fontSize;
    measurer.style.fontWeight = cs.fontWeight;
    measurer.style.letterSpacing = cs.letterSpacing;

    const scaleMatch = /scaleX\(([-\d.]+)\)/.exec(nameEl.style.transform || '');
    const currentScaleX = scaleMatch ? parseFloat(scaleMatch[1]) : 1;

    measurer.textContent = englishName;
    const naturalEnglishWidth = measurer.getBoundingClientRect().width || 1;
    const availableBoxWidth = currentScaleX * naturalEnglishWidth;

    measurer.textContent = translatedName;
    const naturalTranslatedWidth = measurer.getBoundingClientRect().width || 1;
    const newScaleX = Math.min(1, availableBoxWidth / naturalTranslatedWidth);

    if (overlay.textContent !== translatedName) overlay.textContent = translatedName;
    overlay.style.transform = 'scaleX(' + newScaleX + ')';
    overlay.style.display = 'block';
    nameEl.__dtWantHidden = true;
    nameEl.style.visibility = 'hidden';
    nameEl.__dtOverlayPasscode = passcode;
  }

  function applyToCard(front) {
    const passcodeEl = front.querySelector('.passcode_txt');
    const passcode = passcodeEl ? passcodeEl.textContent.trim() : '';
    if (!/^\d+$/.test(passcode)) return; // no real card in this slot (empty zone, template, etc.)

    const effectEl = front.querySelector('.effect_txt');
    const pendEl = front.querySelector('.card_pendulum_effect_txt');

    readCacheThenMaybeFetch(passcode);
    const data = resolved.get(passcode); // undefined = still fetching, null = fetch failed, object = resolved

    applyNameTranslation(front, passcode, data);

    if (!data) return; // still fetching (or fetch failed) — leave native English rules text showing until it resolves

    if (pendEl && pendEl.textContent.trim()) {
      // Pendulum monster: two separate boxes, two separate fields.
      setText(pendEl, data.pend_desc || pendEl.textContent);
      setText(effectEl, data.monster_desc || (effectEl ? effectEl.textContent : ''));
    } else if (effectEl) {
      setText(effectEl, data.desc || effectEl.textContent);
    }
  }

  // ── #preview_txt — a SEPARATE readable-text box, not part of the card ──
  // Confirmed live (a real duel, Tsukuyomi/Torrential Tribute both on
  // screen): DuelingBook's left-side preview area is actually TWO sibling
  // elements under a shared `.preview` wrapper, not one — `#preview`
  // itself (the `.cardfront_content` card-art rendering everything above
  // already handles) AND a separate `#preview_txt` (class "textarea
  // scrollpane selectable"), a box holding a plain, unsquished `<span>`
  // with the SAME ruling text again, meant to be actually readable (the
  // on-card `.effect_txt` is tiny, squished-to-fit text baked onto the
  // card graphic itself). `#preview_txt` has no `.passcode_txt` of its
  // own and is a single global element (not one per card), so it's
  // handled once per poll, keyed off whichever passcode `#preview`'s OWN
  // `.cardfront_content` is currently showing — the two are always shown
  // in lockstep, confirmed live.
  //
  // v1.3 targeted the span via `#preview_txt .os_viewport span` — WRONG,
  // confirmed live the hard way (two different real cards, Emporkömmling
  // Goblin/"Draw 2 cards." and an earlier "Draw 1 card, then your
  // opponent gains 1000 LP.", both silently matched ZERO elements and so
  // never translated at all). `.os_viewport` is an OverlayScrollbars
  // wrapper div that DuelingBook's own scrollbar library only inserts
  // once the text is actually long enough to need scrolling — for short
  // effect text (the common case) the `<span>` sits directly inside
  // `#preview_txt` with no `.os_viewport` in between at all. Fixed by
  // dropping that requirement entirely and just finding the span anywhere
  // under `#preview_txt`, which matches it correctly either way (the
  // scrollbar track/handle elements OverlayScrollbars adds alongside
  // `.os_viewport` when it IS present are plain `<div>`s, never a
  // `<span>`, so this stays unambiguous in both structural variants).
  //
  // Confirmed live for a non-Pendulum monster/spell/trap: this box's
  // native English text is byte-identical to that card's own `desc`
  // field, so the fix there is a straight swap. Pendulum cards were NOT
  // available to check live in this same session — DuelingBook's own
  // native formatting for a Pendulum card's `#preview_txt` (does it
  // label the two halves? what separates them?) is unconfirmed, so that
  // branch below is a plain best-effort join of the two translated
  // fields rather than a guess at matching native formatting exactly.
  function applyPreviewTxtTranslation(previewPasscode, data, hasPendulum) {
    const span = document.querySelector('#preview_txt span');
    if (!span || !/^\d+$/.test(previewPasscode)) return;

    if (span.__dtPreviewPasscode !== previewPasscode) {
      // #preview just switched to a different card (or this is the first
      // time this element's been seen) — capture ITS fresh native English
      // text as the restore/fallback baseline before anything translates it.
      span.__dtPreviewEnglish = span.textContent;
      span.__dtPreviewPasscode = previewPasscode;
    }
    if (!data) return; // still fetching (or fetch failed) — leave native English baseline showing

    const translated = hasPendulum
      ? [data.pend_desc, data.monster_desc].filter(Boolean).join('\n\n')
      : data.desc;
    const next = translated || span.__dtPreviewEnglish;
    if (span.textContent !== next) span.textContent = next;
  }

  function readAndApply() {
    chrome.storage.local.get(DEFAULTS, (s) => {
      const lang = s.dt_card_language_enabled ? (s.dt_card_language || LANG_DEFAULT) : LANG_DEFAULT;
      if (lang !== currentLang) {
        currentLang = lang;
        resolved.clear();
        inFlight.clear();
      }
      document.querySelectorAll('.cardfront_content').forEach((front) => {
        if (front.offsetParent === null && front.getClientRects().length === 0) return; // skip fully-detached/hidden templates
        applyToCard(front);
      });

      // #preview_txt isn't a `.cardfront_content` itself, so the loop above
      // never reaches it — see applyPreviewTxtTranslation's own header note.
      const previewFront = document.querySelector('#preview .cardfront_content');
      if (previewFront) {
        const previewPasscodeEl = previewFront.querySelector('.passcode_txt');
        const previewPasscode = previewPasscodeEl ? previewPasscodeEl.textContent.trim() : '';
        if (/^\d+$/.test(previewPasscode)) {
          readCacheThenMaybeFetch(previewPasscode); // cheap no-op if the loop above already kicked this off for the same passcode this tick
          const pendEl = previewFront.querySelector('.card_pendulum_effect_txt');
          applyPreviewTxtTranslation(previewPasscode, resolved.get(previewPasscode), !!(pendEl && pendEl.textContent.trim()));
        }
      }
    });
  }

  readAndApply();
  // Same convention as every other content script here: cheap poll (also
  // what actually drives the async translation fetch/apply once a Promise
  // resolves, since nothing else would re-trigger a DOM write) plus a
  // debounced MutationObserver for near-instant re-apply when cards change.
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
      if (changes.dt_card_language || changes.dt_card_language_enabled) readAndApply();
    });
  }

  console.log('[Duel Tools] Card Language ready');
})();
