// ==UserScript==
// @name         Duel Tools — Download JSON Replay
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  On a replay page, adds a button that downloads that duel's own raw replay JSON to your computer — see Settings → Replays → Download JSON Replay.
// @grant        none
// @run-at       document-idle
// ==/UserScript==
//
// Isolated world — owns the setting read + button + file download; the raw
// replay payload itself only exists in MAIN world (see dt-download-json-
// replay-engine.js's own header for why), so this asks that file for it
// over postMessage rather than reading it directly.
(function () {
  'use strict';

  if (!/^\/replay\b/.test(window.location.pathname)) return;

  function log(msg) { try { console.log('[Duel Tools] Download JSON Replay:', msg); } catch (e) {} }

  chrome.storage.local.get({ dt_download_json_replay_enabled: false }, (s) => {
    if (!s.dt_download_json_replay_enabled) {
      log('disabled via Settings — nothing to do.');
      return;
    }
    init();
  });

  function replayIdFromUrl() {
    try { return new URLSearchParams(window.location.search).get('id'); } catch (e) { return null; }
  }

  // Keeps a filename readable without risking characters a filesystem
  // would reject (DuelingBook usernames can contain spaces/punctuation).
  function sanitizeForFilename(s) {
    return (s || '').replace(/[\\/:*?"<>|]+/g, '').trim();
  }

  function filenameFor(meta, id) {
    const p1 = sanitizeForFilename(meta && meta.player1);
    const p2 = sanitizeForFilename(meta && meta.player2);
    const players = (p1 && p2) ? (p1 + '-vs-' + p2 + '-') : '';
    return 'duelingbook-replay-' + players + (id || 'unknown') + '.json';
  }

  function triggerDownload(filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Revoking immediately is safe — the download has already been handed
    // off to the browser by the time click() returns synchronously.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function queryEngine() {
    return new Promise((resolve) => {
      function onMsg(ev) {
        if (ev.source !== window || ev.origin !== window.location.origin) return;
        const d = ev.data;
        if (!d || d.source !== 'dt-download-json-replay-engine' || d.type !== 'DT_DOWNLOAD_REPLAY_DATA') return;
        window.removeEventListener('message', onMsg);
        resolve(d);
      }
      window.addEventListener('message', onMsg);
      window.postMessage({ source: 'dt-download-json-replay', type: 'DT_DOWNLOAD_REPLAY_QUERY' }, window.location.origin);
      // The engine only ever has data once DuelingBook's own
      // loadReplayComplete has actually run — if this button is clicked
      // before that (shouldn't normally happen; the replay UI itself isn't
      // usable yet either at that point), don't hang forever waiting.
      setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null); }, 4000);
    });
  }

  function ensureStyles() {
    if (document.getElementById('dt-download-replay-styles')) return;
    const style = document.createElement('style');
    style.id = 'dt-download-replay-styles';
    // Top-left, left:4px;top:4px — the exact spot dt-live-tracker.user.js's
    // own panel used to anchor at on a /replay* page. That panel no longer
    // shows there at all (see its own updatePanelPageVisibility() header:
    // hidden on /replay* per a later instruction, specifically because it
    // was competing for this same corner), so this button now owns that
    // spot outright. Previously this was top-right instead, moved here
    // after confirming live that top-right ALSO worked (clear of
    // DuelingBook's own UI) but wasn't where the user wanted it.
    style.textContent =
      '#dt-download-replay-btn{position:fixed;left:4px;top:4px;z-index:2147483000;' +
        'background:#111;color:#eee;border:1px solid #333;border-radius:8px;' +
        'font-family:monospace;font-size:11px;padding:7px 10px;cursor:pointer;' +
        'box-shadow:0 6px 24px rgba(0,0,0,.5)}' +
      '#dt-download-replay-btn:hover:not(:disabled){background:#1a1a1a}' +
      '#dt-download-replay-btn:active:not(:disabled){background:#000}' +
      '#dt-download-replay-btn:disabled{color:#808080;cursor:default}';
    document.head.appendChild(style);
  }

  function buildButton() {
    if (document.getElementById('dt-download-replay-btn')) return;
    ensureStyles();
    const btn = document.createElement('button');
    btn.id = 'dt-download-replay-btn';
    btn.type = 'button';
    btn.textContent = '⬇ Download Replay JSON';
    btn.title = 'Download this duel\'s raw replay data as a .json file';
    document.body.appendChild(btn);
    btn.addEventListener('click', async () => {
      const orig = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Preparing…';
      const data = await queryEngine();
      if (!data || !data.raw) {
        btn.textContent = '⚠ Not ready yet';
        setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1500);
        log('no replay data available yet — loadReplayComplete may not have fired.');
        return;
      }
      triggerDownload(filenameFor(data.meta, replayIdFromUrl()), data.raw);
      btn.textContent = 'Downloaded!';
      setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 1200);
      log('downloaded replay JSON.');
    });
  }

  function init() {
    buildButton();
    log('ready — waiting on dt-download-json-replay-engine.js.');
  }
})();
