// Duel Tools — Download JSON Replay engine (MAIN world, /replay* only)
//
// Needs MAIN world for the same reason dt-replay-engine.js does: the raw
// replay payload only ever exists as the argument DuelingBook's OWN
// loadReplayComplete(jsonString) function is called with — nothing in the
// DOM carries it, and an isolated-world content script's `window` is a
// separate global scope from the real page's, so it can't see that
// function or its argument directly.
//
// Deliberately its OWN wrap of loadReplayComplete, not a reuse of dt-
// replay-engine.js's RB.pristine — that file's whole engine is gated behind
// the "Advanced Replay Controls" master toggle (dt_replay_controls_enabled)
// and this feature has to work independently of that toggle, same reasoning
// as dt-grab-replay-mid-duel-engine.js being independent of "Enable Replays
// While Spectating". Wrapping the same function twice is safe: each wrap
// calls the previous layer's original, so this composes with dt-replay-
// engine.js's own wrap (and with DuelingBook's real function) regardless of
// which one background.js happens to inject first.
(function () {
  'use strict';
  if (!/^\/replay\b/.test(window.location.pathname) || window.__dtDownloadReplayEngineInstalled) return;
  window.__dtDownloadReplayEngineInstalled = true;

  function warn(...a) { try { console.warn('[Duel Tools Download Replay]', ...a); } catch (e) {} }

  // rawJSON is kept as the ORIGINAL string DuelingBook sent, not a re-
  // JSON.stringify of a parsed copy — byte-identical to what a real
  // duelingbook.com replay actually is, so a downloaded file is exactly
  // what the server produced, not this extension's own re-serialization of
  // it (which could silently reorder keys or drop something JSON.parse
  // doesn't round-trip perfectly).
  let rawJSON = null;
  let meta = null;

  function wrap(name, make) {
    const orig = window[name];
    if (typeof orig !== 'function') { warn('missing', name); return false; }
    window[name] = make(orig);
    return true;
  }

  function extractMeta(raw) {
    try {
      const d = JSON.parse(raw);
      // d.player1.username / d.player2.username at the TOP level is only
      // ever inferred (from jumpTo()'s clone(src.player1) pattern in dt-
      // replay-engine.js), never directly confirmed against a real raw
      // replay string — so try it first, but always fall back to the
      // first two distinct play.username values in d.plays, which ARE
      // confirmed-accurate (sampled live against real replay data).
      let p1 = (d.player1 && d.player1.username) || null;
      let p2 = (d.player2 && d.player2.username) || null;
      if ((!p1 || !p2) && Array.isArray(d.plays)) {
        const seen = [];
        for (let i = 0; i < d.plays.length && seen.length < 2; i++) {
          const u = d.plays[i] && d.plays[i].username;
          if (u && seen.indexOf(u) === -1) seen.push(u);
        }
        p1 = p1 || seen[0] || null;
        p2 = p2 || seen[1] || null;
      }
      return { player1: p1, player2: p2 };
    } catch (e) {
      return null;
    }
  }

  function install() {
    if (typeof window.loadReplayComplete !== 'function') { setTimeout(install, 300); return; }
    wrap('loadReplayComplete', (orig) => function () {
      try {
        rawJSON = arguments[0];
        meta = extractMeta(rawJSON);
      } catch (e) {
        warn('failed to capture replay payload', e);
      }
      return orig.apply(this, arguments);
    });
  }
  install();

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== window.location.origin) return;
    const d = ev.data;
    if (!d || d.source !== 'dt-download-json-replay' || d.type !== 'DT_DOWNLOAD_REPLAY_QUERY') return;
    window.postMessage({
      source: 'dt-download-json-replay-engine',
      type: 'DT_DOWNLOAD_REPLAY_DATA',
      raw: rawJSON,
      meta: meta
    }, window.location.origin);
  });
})();
