// Duel Tools — Auto Hand Shuffling engine (MAIN world)
//
// Why this needs MAIN world at all: the actual "shuffle my hand" action is
// DuelingBook's own window.shuffleHandE() (confirmed live — it just sends
// {action:'Duel', play:'Shuffle hand'} over the duel socket, the exact same
// thing clicking the real #shuffle_btn does), and "whose turn is it right
// now" is window.turn_player.username === window.username (also confirmed
// live) — both are page globals that only exist in the MAIN world, invisible
// to dt-auto-hand-shuffle.user.js's isolated world. So, same pattern as
// dt-rps-engine.js/dt-transparent-facedowns-engine.js: the isolated-world
// file owns every setting read and all the "when should this fire" DOM/log
// watching, and just posts a bare "please shuffle" request over here —
// this file is only ever the one thing that actually calls shuffleHandE().
(function () {
  'use strict';

  function isMyTurnNow() {
    try {
      return !!(window.turn_player && window.username && window.turn_player.username === window.username);
    } catch (e) {
      return false; // never block a shuffle request by throwing — just treat as "can't confirm, skip"
    }
  }

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return; // same-tab only, never a cross-frame/opponent message
    const data = ev.data;
    if (!data || data.source !== 'dt-auto-hand-shuffle' || data.type !== 'DT_SHUFFLE_REQUEST') return;
    if (data.requireOwnTurn && !isMyTurnNow()) return;
    try {
      if (typeof window.shuffleHandE === 'function') window.shuffleHandE();
    } catch (e) {
      console.log('[Duel Tools] Auto Hand Shuffling engine: shuffleHandE() call failed:', e);
    }
  });

  console.log('[Duel Tools] Auto Hand Shuffling engine (MAIN world) ready');
})();
