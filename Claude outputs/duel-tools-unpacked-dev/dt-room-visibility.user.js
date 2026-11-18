// ==UserScript==
// @name         Duel Tools — Room Visibility
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Reorders and/or hides the Duel Lobby's format/pool panels (Ranked, Advanced Unrated, Genesys, Goat, Edison, Custom Cards, Speed Duels, Rush Duels, Unlimited, Traditional) per the order saved in Settings → Lobby Customization → Room Visibility — independently for Duel mode and Watch mode (DuelingBook's own Mode: Duel/Watch picker), since the same 10 panels show different content in each and a user may want a different arrangement for each.
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// ── How DuelingBook actually lays these 10 panels out ────────────────────
// Confirmed live, on the real Duel Lobby page: the 10 panels —
//   ar = Ranked (DuelingBook's own internal label is "Duelist Pool",
//        the matchmaking box), au = Advanced (Unrated), yu = Genesys
//        Format, gu = Goat Format, eu = Edison Format, cu = Custom Cards
//        (Unrated), su = Speed Duels, ru = Rush Duels, uu = Unlimited
//        (Unrated), tu = Traditional (Unrated)
// are NOT ordered by where they sit in the HTML. They're nested under
// three wrapper divs (#pools1/#pools2/#pools3) that turned out to be
// zero-sized, order-irrelevant grouping artifacts — e.g. #pools2's DOM
// order is cu, gu, eu, but cu/gu/eu render in the order gu, eu, cu because
// each panel is independently `position:absolute` with its OWN per-id
// `left` pixel offset, set by a plain (non-!important) rule in
// DuelingBook's own main.css: #ar{left:5px} #au{left:345px} #yu{left:685px}
// #gu{left:1029px} #eu{left:1369px} #cu{left:1709px} #su{left:2053px}
// #ru{left:2393px} #uu{left:2733px} #tu{left:3073px} — evenly spaced
// ~340px slots, in exactly that order (which is also DuelingBook's own
// default/canonical order, and matches this feature's default order
// below).
//
// Since that CSS rule has no !important, a plain inline
// `element.style.left = '...px'` beats it for free — confirmed live by
// swapping #au and #yu's inline `left` values and watching Genesys
// Format and Advanced (Unrated) swap screen positions instantly, with
// nothing on DuelingBook's side reverting it afterward. Hiding is just as
// simple: `element.style.display = 'none'` removes a panel cleanly (it's
// absolutely positioned, so it never occupies layout space other panels
// would need to reflow into anyway).
//
// So reordering means reassigning which panel's element sits at which
// slot offset, and hiding means display:none on that panel's own element
// — no need to touch DOM order, no need to fight any DuelingBook JS (we
// found none that re-asserts these positions after initial load; a
// dispatched `resize` event didn't change anything either). Slot offsets
// themselves are read LIVE per page load via getComputedStyle, before this
// script changes anything, rather than hardcoded — so a future
// DuelingBook CSS update (different spacing, a redesigned lobby at a
// different viewport width) is picked up automatically instead of silently
// going stale.
(function () {
  'use strict';

  const ENABLED_KEY = 'dt_room_visibility_enabled';
  const ORDER_KEY = 'dt_room_visibility_order';
  const HIDDEN_KEY = 'dt_room_visibility_hidden';
  const WATCH_ORDER_KEY = 'dt_room_visibility_watch_order';
  const WATCH_HIDDEN_KEY = 'dt_room_visibility_watch_hidden';
  const POOL_IDS = ['ar', 'au', 'yu', 'gu', 'eu', 'cu', 'su', 'ru', 'uu', 'tu'];
  const DEFAULT_ORDER = POOL_IDS.slice();

  function isOnDuelLobby() {
    const el = document.getElementById('duel_room');
    return !!(el && el.offsetParent !== null);
  }

  // Confirmed live: DuelingBook's own Mode picker is two plain radios,
  // `.duel_rb`/`.watch_rb` (name="mode"), and switching between them
  // reuses the EXACT SAME #ar/#au/.../#tu elements this whole feature
  // already positions — #ar still shows the Ranked/"Advanced (Rated)"
  // format either way, just swapping its own inner content between the
  // join/host UI and a list of that format's ongoing watchable duels.
  // So the only thing that needs to change between modes is WHICH saved
  // order/hidden pair gets applied to those same elements.
  function isWatchMode() {
    const el = document.querySelector('.watch_rb');
    return !!(el && el.checked);
  }

  // BUG FIX (confirmed live, reported by the user): clicking "Host Duel"
  // and landing in the "waiting for an opponent" state (confirmed live:
  // DuelingBook shows a `#hosting` block then, with the "Accept User /
  // Reject User / Cancel Duel" controls) makes DuelingBook itself jump
  // the format-panel carousel forward by exactly one full page
  // (confirmed live: the carousel's real scrollable element, the
  // `.os_viewport` ancestor of #ar, jumps from scrollLeft 0 to exactly
  // 1024 — its own clientWidth, i.e. "page 2" in DuelingBook's own fixed
  // 3-panels-per-page pagination). That jump is driven by raw pixel
  // geometry, not panel identity — it has no idea we've reassigned which
  // panel sits at which pixel slot — so after our reordering it reveals
  // whatever 3 panels happen to occupy DuelingBook's own NATIVE page-2
  // slots, which is essentially arbitrary relative to the user's actual
  // configured order. The user's own account of what they want ("the
  // ranked pool disappears correctly, it should just ignore it in my
  // panel order and go to the next one") is: once Duelist Pool (#ar) is
  // contextually moot while hosting, our own slot assignment should skip
  // over it entirely (so slot 1 = the user's 2nd-ranked panel, etc.) AND
  // the view should land back on slot 1, not wherever DuelingBook's own
  // page-2 jump happens to land. Confirmed live: `#hosting`'s own
  // offsetParent is non-null only while actually in this waiting state,
  // making it a clean, reliable signal — and it is absent/not visible
  // the rest of the time, so this never affects the normal Duelist Pool
  // view.
  function isHostingWait() {
    const el = document.getElementById('hosting');
    return !!(el && el.offsetParent !== null);
  }

  // Cached lazily the same way slotOffsets is — the real scrollable
  // element is the `.os_viewport` ancestor of the panels themselves
  // (confirmed live by walking up from #ar), not #formats itself (which
  // is `overflow-x: hidden` and never the one that actually scrolls).
  let scrollViewportEl = null;
  function findScrollViewport() {
    if (scrollViewportEl && scrollViewportEl.isConnected) return scrollViewportEl;
    let node = document.getElementById('ar');
    while (node) {
      if (node.classList && node.classList.contains('os_viewport')) { scrollViewportEl = node; return node; }
      node = node.parentElement;
    }
    return null;
  }

  function getSettings(cb) {
    chrome.storage.local.get(
      {
        [ENABLED_KEY]: false,
        [ORDER_KEY]: DEFAULT_ORDER,
        [HIDDEN_KEY]: [],
        [WATCH_ORDER_KEY]: DEFAULT_ORDER,
        [WATCH_HIDDEN_KEY]: []
      },
      (s) => {
        const watch = isWatchMode();
        const orderRaw = watch ? s[WATCH_ORDER_KEY] : s[ORDER_KEY];
        const hiddenRaw = watch ? s[WATCH_HIDDEN_KEY] : s[HIDDEN_KEY];
        const order = Array.isArray(orderRaw) && orderRaw.length ? orderRaw : DEFAULT_ORDER;
        cb({
          enabled: !!s[ENABLED_KEY],
          order: order,
          hidden: Array.isArray(hiddenRaw) ? hiddenRaw : []
        });
      }
    );
  }

  // Captured once per page load (lazily, the first time we're actually
  // about to apply a custom layout) — see the header comment above for why
  // this is read live instead of hardcoded. Reset to null (forcing a fresh
  // capture) whenever we fully restore DuelingBook's own default layout,
  // so we never accidentally "capture" our own prior override as if it
  // were DuelingBook's default.
  let slotOffsets = null;
  let appliedOnce = false;

  // DuelingBook's own `.format` class carries `transition: all` (confirmed
  // live via getComputedStyle) — it's how the panels fade/slide into place
  // when the lobby first opens. That's a real bug risk for us on TWO
  // fronts, both confirmed live:
  //   1) If our very first capture (below) happens to run while that
  //      opening fade/slide is still mid-flight, getComputedStyle reads an
  //      INTERPOLATED, bogus `left` value (we caught one frozen at 568px —
  //      not any of the 10 real slot offsets) instead of the true resting
  //      position, and since slotOffsets is cached for the rest of the
  //      page's life, that one bad reading corrupts every panel's position
  //      from then on.
  //   2) Even with a correct capture, writing a new `left` onto a panel
  //      that still has this transition active makes it visibly SLIDE
  //      there instead of snapping instantly — the "doesn't look seamless"
  //      symptom.
  // Fixing both: force `transition: none` (inline, so it beats the
  // stylesheet rule) on every panel the moment we touch it, and validate a
  // freshly captured slot-offset array before trusting it — real slots are
  // evenly spaced ~334-345px apart, so anything that doesn't fit that shape
  // gets thrown away and retried on a later tick instead of cached.
  function killTransition(el) {
    if (el.style.transition !== 'none') el.style.transition = 'none';
  }

  function isPlausibleSlotSpacing(sorted) {
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i] - sorted[i - 1];
      if (gap < 300 || gap > 400) return false;
    }
    return true;
  }

  function captureDefaultSlotOffsets() {
    const entries = [];
    for (let i = 0; i < POOL_IDS.length; i++) {
      const el = document.getElementById(POOL_IDS[i]);
      if (!el) return null; // not all panels in the DOM yet — retry next tick
      killTransition(el);
      const left = parseFloat(getComputedStyle(el).left);
      if (!isFinite(left)) return null;
      entries.push(left);
    }
    entries.sort((a, b) => a - b);
    // Real DuelingBook slots are evenly spaced ~334-345px apart. A capture
    // that doesn't fit that shape means we almost certainly caught a panel
    // mid-transition (see header) — discard it and let the next tick,
    // hopefully after things have settled, try again instead of baking in
    // a bad value for the rest of the page's life.
    if (!isPlausibleSlotSpacing(entries)) return null;
    return entries;
  }

  function applyLayout(order, hidden) {
    if (!slotOffsets) {
      slotOffsets = captureDefaultSlotOffsets();
      if (!slotOffsets) return;
    }
    const hiddenSet = {};
    for (let i = 0; i < hidden.length; i++) hiddenSet[hidden[i]] = true;
    // See isHostingWait()'s comment above: while actually hosting and
    // waiting for an opponent, Duelist Pool is contextually moot — skip
    // it from slot assignment the same way an explicitly-hidden panel
    // would be (this never touches the user's own saved hidden list).
    if (isHostingWait()) hiddenSet['ar'] = true;

    let slot = 0;
    for (let i = 0; i < order.length; i++) {
      const id = order[i];
      const el = document.getElementById(id);
      if (!el) continue;
      killTransition(el);
      if (hiddenSet[id]) {
        if (el.style.display !== 'none') el.style.display = 'none';
        continue;
      }
      if (el.style.display === 'none') el.style.display = '';
      const offset = slotOffsets[Math.min(slot, slotOffsets.length - 1)];
      const px = offset + 'px';
      if (el.style.left !== px) el.style.left = px;
      slot++;
    }
    appliedOnce = true;
  }

  function restoreDefaultLayout() {
    if (!appliedOnce) return;
    for (let i = 0; i < POOL_IDS.length; i++) {
      const el = document.getElementById(POOL_IDS[i]);
      if (!el) continue;
      el.style.left = '';
      el.style.display = '';
      el.style.transition = '';
    }
    appliedOnce = false;
    slotOffsets = null; // recapture fresh from DuelingBook's real defaults next time
  }

  // A window resize can change DuelingBook's own per-id `left` values (if a
  // future layout becomes responsive) — restore to defaults first so the
  // next capture reads DuelingBook's genuine post-resize values, not our
  // own stale override, then let the next tick reapply on top of that.
  window.addEventListener('resize', () => {
    restoreDefaultLayout();
  });

  // Triggered on the hosting-wait transition, not reasserted forever —
  // DuelingBook's own page-2 jump (see isHostingWait() comment) is a
  // one-time action around when the hosting-wait state begins/ends, not
  // something it continuously re-applies. A short correction window
  // (rather than a single reset on the exact tick the transition is
  // first observed) absorbs any timing gap between `#hosting` becoming
  // visible and DuelingBook's own jump actually firing, without
  // permanently fighting the user's later use of the ◀/▶ carousel arrows.
  let wasHostingWait = false;
  let scrollCorrectionTicksLeft = 0;
  function correctScrollOnHostingTransition() {
    const hostingWait = isHostingWait();
    if (hostingWait !== wasHostingWait) {
      wasHostingWait = hostingWait;
      scrollCorrectionTicksLeft = 6; // ~3s at the 500ms tick rate below
    }
    if (scrollCorrectionTicksLeft > 0) {
      scrollCorrectionTicksLeft--;
      const viewport = findScrollViewport();
      if (viewport && viewport.scrollLeft !== 0) viewport.scrollLeft = 0;
    }
  }

  function tick() {
    if (!isOnDuelLobby()) return;
    getSettings(({ enabled, order, hidden }) => {
      if (!enabled) {
        restoreDefaultLayout();
        return;
      }
      correctScrollOnHostingTransition();
      // Guard against a saved order that's stale/short (missing a pool id)
      // — append anything missing at the end so nothing silently vanishes.
      const have = {};
      for (let i = 0; i < order.length; i++) have[order[i]] = true;
      const fullOrder = order.concat(POOL_IDS.filter((id) => !have[id]));
      applyLayout(fullOrder, hidden);
    });
  }

  setInterval(tick, 500);
  tick();
})();
