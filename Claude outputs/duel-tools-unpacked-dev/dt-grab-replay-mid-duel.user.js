// ==UserScript==
// @name         Duel Tools — Grab Replay Mid Duel
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  While spectating a LIVE duel, adds a small button that copies that duel's duelingbook.com/replay link to your clipboard right away — see Settings → Replays → Grab Replay Mid Duel.
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// Isolated world — reads the setting (chrome.storage) and owns the small
// floating button + clipboard write; the one thing it can't do itself is
// read window.duelId (a real page global), so dt-grab-replay-mid-
// duel-engine.js (MAIN world) is the one reporting spectating/duelId state
// over postMessage. Same split as dt-skip-opening-cinematic.user.js /
// dt-skip-cinematic-engine.js, for the same reason.
//
// Never on /replay* — that's an already-finished, already-saved replay
// page (dt-replay-controls.user.js's own territory); this is strictly for
// watching a live, still-in-progress duel.
(function () {
  'use strict';

  if (/^\/replay\b/.test(window.location.pathname)) return;

  function log(msg) { try { console.log('[Duel Tools] Grab Replay Mid Duel:', msg); } catch (e) {} }

  chrome.storage.local.get({ dt_grab_replay_mid_duel_enabled: false }, (s) => {
    if (!s.dt_grab_replay_mid_duel_enabled) {
      log('disabled via Settings — nothing to do.');
      return;
    }
    init();
  });

  function copyToClipboard(text) {
    // Same fallback chain as dt-replay-controls.user.js's own
    // copyToClipboard — kept identical rather than re-derived.
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    } catch (e) { /* fall through to the execCommand fallback below */ }
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { log('could not copy link to clipboard: ' + e); }
    return Promise.resolve();
  }

  function replayLinkFor(duelId) {
    return window.location.origin + '/replay?id=' + duelId;
  }

  let lastState = { spectating: false, duelId: null };
  let btn = null;

  function ensureStyles() {
    if (document.getElementById('dt-grab-replay-styles')) return;
    const style = document.createElement('style');
    style.id = 'dt-grab-replay-styles';
    // top-right, NOT bottom-right: confirmed live that dt-save-prompt.
    // user.js's own "Save to Duel Tools?" box sits at right:16px;bottom:20px
    // with z-index:2147483647 (max int32 — higher than this button's own
    // 2147483000) and is wide/tall enough (190x264px) to fully cover a
    // bottom-right button underneath it. That box runs on every
    // duelingbook.com page (TRACKER_FILES, unconditional), not just replay
    // pages, so it's a real collision here too, not just on /replay — this
    // was root-caused live after the user reported "I don't see the
    // button" for both this file and dt-download-json-replay.user.js.
    // Top-right is confirmed clear of native DuelingBook UI (camera/avatar
    // icons sit further left, around x:1605-1640 at 1920px width).
    style.textContent =
      '#dt-grab-replay-btn{position:fixed;right:6px;top:6px;z-index:2147483000;' +
        'background:#111;color:#eee;border:1px solid #333;border-radius:8px;' +
        'font-family:monospace;font-size:11px;padding:7px 10px;cursor:pointer;' +
        'box-shadow:0 6px 24px rgba(0,0,0,.5);display:none}' +
      '#dt-grab-replay-btn:hover{background:#1a1a1a}' +
      '#dt-grab-replay-btn:active{background:#000}';
    document.head.appendChild(style);
  }

  function buildButton() {
    if (document.getElementById('dt-grab-replay-btn')) { btn = document.getElementById('dt-grab-replay-btn'); return; }
    ensureStyles();
    btn = document.createElement('button');
    btn.id = 'dt-grab-replay-btn';
    btn.type = 'button';
    btn.textContent = '📋 Copy Replay Link';
    btn.title = 'Copy this duel\'s replay link — it won\'t have anything to show until the duel ends, but the link is ready now.';
    document.body.appendChild(btn);
    btn.addEventListener('click', () => {
      if (lastState.duelId == null) return; // button shouldn't be visible/clickable without a duelId, but don't trust visibility alone
      const link = replayLinkFor(lastState.duelId);
      copyToClipboard(link);
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      btn.disabled = true;
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1200);
      log('copied ' + link);
    });
  }

  function render() {
    if (!btn) return;
    const shouldShow = !!lastState.spectating && lastState.duelId != null;
    btn.style.display = shouldShow ? 'block' : 'none';
  }

  function init() {
    buildButton();
    window.addEventListener('message', (ev) => {
      if (ev.source !== window || ev.origin !== window.location.origin) return;
      const d = ev.data;
      if (!d || d.source !== 'dt-grab-replay-mid-duel-engine' || d.type !== 'DT_GRAB_REPLAY_STATE') return;
      lastState = d.state || { spectating: false, duelId: null };
      render();
    });
    // Ask immediately in case the engine's own first tick already fired
    // and deduped away before this listener was attached.
    window.postMessage({ source: 'dt-grab-replay-mid-duel', type: 'DT_GRAB_REPLAY_QUERY' }, window.location.origin);
    log('ready — waiting on dt-grab-replay-mid-duel-engine.js.');
  }
})();
