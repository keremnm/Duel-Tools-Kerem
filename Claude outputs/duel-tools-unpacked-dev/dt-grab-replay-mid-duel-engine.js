// Duel Tools — Grab Replay Mid Duel engine (MAIN world)
//
// Needs MAIN world because the one thing this feature actually depends on —
// window.duelId — is a real page global, not something exposed anywhere in
// the DOM; same reason dt-skip-cinematic-engine.js and the RPS/shuffle
// engines all need MAIN world too.
//
// Confirmed live, on a real duel: DuelingBook's own "View Replay" button
// (shown only once a duel/match concludes) just calls a page function,
// window.viewReplayE():
//   function viewReplayE(){
//     window.open(URL_START+'replay?id='+(duelist?userId+'-':'')+duelId);
//   }
// Calling that directly, mid-duel, while duelist=true (i.e. you're a real
// participant, not a spectator), opens a working replay link well before
// the duel ends — so for a participant, the data is there the whole time;
// only the button's visibility is what's gated on the duel being over.
//
// For a SPECTATOR (duelist=false), the same function builds just the bare
// duelId with no userId prefix: 'replay?id=<duelId>'. Confirmed live two
// different ways:
//   1. Calling viewReplayE() while actually spectating a live, unconcluded
//      duel opens exactly that bare-id link — and loading it at that point
//      just times out (no replay data exists yet; the duel isn't over).
//   2. The SAME bare-id format, pointed at a duel that HAD already
//      concluded, loaded correctly (DuelingBook's own Advanced Replay
//      viewer came up showing the real game) — so the bare duelId alone is
//      a complete, correct, future-valid link. It just won't have anything
//      to show until the duel it points to is actually over.
// That's exactly the tradeoff the user asked for: grab the (already fully
// determined) link now, while spectating, to go back to once the duel
// concludes — not to watch it live through this link.
//
// "Am I actually spectating a live duel right now" reuses the exact
// detection dt-spectate-engine.js already proved out live (not
// reinvented): #duel itself visible, AND none of the player-only controls
// (Admit Defeat / Begin Siding / Offer Draw / Call Judge) are. A spectator
// is never a player, confirmed live the same way there.
(function () {
  'use strict';

  const POLL_MS = 800;

  function findByExactText(label) {
    const all = document.querySelectorAll('div, span, button, input');
    for (const el of all) {
      if ((el.textContent || '').trim() !== label) continue;
      let isLeaf = true;
      for (const child of el.children) {
        if ((child.textContent || '').trim() === label) { isLeaf = false; break; }
      }
      if (isLeaf) return el;
    }
    return null;
  }
  const PLAYER_ONLY_LABELS = ['Admit Defeat', 'Begin Siding', 'Offer Draw', 'Call Judge'];
  function isSpectatingNow() {
    const duelEl = document.querySelector('#duel');
    const duelVisible = !!duelEl && getComputedStyle(duelEl).display !== 'none';
    if (!duelVisible) return false;
    for (const label of PLAYER_ONLY_LABELS) {
      const el = findByExactText(label);
      if (el && el.offsetParent !== null) return false; // a player-only control visible means a real player, never a spectator
    }
    return true;
  }

  function getDuelId() {
    try {
      const id = window.duelId;
      return (typeof id === 'number' && isFinite(id)) ? id : null;
    } catch (e) {
      return null;
    }
  }

  function currentState() {
    return { spectating: isSpectatingNow(), duelId: getDuelId() };
  }
  function push(state) {
    window.postMessage({ source: 'dt-grab-replay-mid-duel-engine', type: 'DT_GRAB_REPLAY_STATE', state: state }, window.location.origin);
  }

  let lastSent = null; // dedupe so the 800ms tick isn't flooding postMessage for nothing
  function tick() {
    const state = currentState();
    const key = state.spectating + '|' + state.duelId;
    if (key === lastSent) return;
    lastSent = key;
    push(state);
  }

  // The isolated-world button (dt-grab-replay-mid-duel.user.js) may attach
  // its listener AFTER this engine's first tick already fired and deduped
  // away — same "late listener misses the push" gap dt-spectate-controls.
  // user.js / dt-spectate-engine.js solved with their own query/push pair.
  // Mirrored here: answer a query immediately, bypassing the dedupe, so a
  // late-attaching button always gets the real current state on request.
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== window.location.origin) return;
    const d = ev.data;
    if (!d || d.source !== 'dt-grab-replay-mid-duel' || d.type !== 'DT_GRAB_REPLAY_QUERY') return;
    push(currentState());
  });

  setInterval(tick, POLL_MS);
  tick();
})();
