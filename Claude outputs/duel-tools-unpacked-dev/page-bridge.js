// Duel Tools — MAIN-world page bridge.
//
// Runs in the REAL page's own JS context (injected with world:"MAIN" from
// background.js) — unlike the extension's isolated-world content scripts,
// this is the only place that can actually see DuelingBook's own page
// globals (currentLabel, deck_filled_arr, side_filled_arr,
// initializeDeckCards) the way Tampermonkey's `@grant unsafeWindow` used
// to. It never touches chrome.* APIs (this world can't see them) — its
// only job is watching those page globals and relaying plain, serializable
// snapshots to the isolated-world shim (gm-shim, installed via
// background.js's installShim) over postMessage, the one channel that
// actually crosses the isolated/main world boundary.
(function () {
  if (window.__dtBridgeInstalled) return; // survives re-injection without double-wrapping
  window.__dtBridgeInstalled = true;

  // Mirrors jqCardMeta() in dt-live-tracker.user.js exactly — those are the
  // only 4 .data() keys the tracker ever reads off a CardFront element.
  function cardMeta(el) {
    try {
      if (!el || typeof el.data !== 'function') return null;
      const name = el.data('name');
      if (!name) return null;
      return {
        name: name,
        alt_passcode: el.data('alt_passcode') || null,
        serial_number: el.data('serial_number') || null,
        card_type: el.data('card_type') || ''
      };
    } catch (e) { return null; }
  }

  function snapshot() {
    return {
      currentLabel: window.currentLabel,
      deckArr: Array.isArray(window.deck_filled_arr) ? window.deck_filled_arr.map(cardMeta).filter(Boolean) : null,
      sideArr: Array.isArray(window.side_filled_arr) ? window.side_filled_arr.map(cardMeta).filter(Boolean) : null
    };
  }

  function post(type, extra) {
    window.postMessage(Object.assign({ source: 'dt-page-bridge', type: type }, extra || {}), window.location.origin);
  }

  // Wrap the page's own initializeDeckCards exactly once, via a PAGE-GLOBAL
  // flag (not a closure-local one) so it survives this bridge script being
  // re-injected (e.g. by a second extension reload) — same reasoning the
  // tracker script itself already uses for its own one-time wrap (see
  // sidingHookHandlerClaimed / __dtTrackerInitDeckCardsWrapped there).
  // Every real call gets a synchronous snapshot taken and relayed together
  // with the "it just fired" signal, so the isolated-world shim sees FRESH
  // array data at the exact moment it needs to react — not stale data from
  // the last periodic poll.
  function tryWrap() {
    if (window.__dtBridgeWrapped) return true;
    if (typeof window.initializeDeckCards !== 'function') return false;
    const orig = window.initializeDeckCards;
    window.__dtBridgeWrapped = true;
    window.initializeDeckCards = function () {
      const ret = orig.apply(this, arguments);
      try { post('DT_BRIDGE_SIDING_CHANGED', snapshot()); } catch (e) {}
      return ret;
    };
    return true;
  }

  // DuelingBook's own scripts may not be loaded yet when this runs — retry
  // at the same 200ms cadence the original userscript polled at.
  const readyTimer = setInterval(function () { if (tryWrap()) clearInterval(readyTimer); }, 200);

  // On-demand snapshot requests from the isolated-world shim — covers reads
  // that need to happen independent of initializeDeckCards actually firing
  // (e.g. noticing the siding screen is open at all).
  window.addEventListener('message', function (ev) {
    if (!ev.data || ev.data.source !== 'dt-content-shim') return;
    // NOTE: replay stepping (DT_REPLAY_STEP) used to be relayed from here,
    // calling DuelingBook's own stepBackwardE()/updateDuelLog() directly.
    // That approach genuinely moved the board but never updated the Duel
    // Log panel's visible text (a real, confirmed gap in DuelingBook's own
    // "unfinished" stepBackward) — dt-replay-engine.js replaced it with a
    // full snapshot/initDuel-based engine that fixes that, and it talks to
    // dt-replay-controls.user.js directly over its own postMessage bridge
    // (source: 'dt-replay-engine', DT_ENGINE_* message types), since it
    // already runs in this same MAIN world and doesn't need this file as a
    // relay. Nothing sends DT_REPLAY_STEP anymore.
    if (ev.data.type === 'DT_BRIDGE_REQUEST') post('DT_BRIDGE_SNAPSHOT', snapshot());
  });
})();
