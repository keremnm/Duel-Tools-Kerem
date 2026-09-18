// ==UserScript==
// @name         Duel Tools — Save Prompt
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  After a DuelingBook replay is up, offers to send it straight into Duel Tools' existing import flow.
// @author       Kerem's Duel Tools
// @match        https://www.duelingbook.com/replay*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';

  // ── How this works ──────────────────────────────────────────────────────
  // Duel Tools already has a fully correct import pipeline on the website
  // itself (the "▶ Analyze" flow): given a player name + a replay ID it
  // looks up whether a batch for that player already exists (and merges
  // into it) or creates a new one, then fetches/parses/saves the replay.
  // Rather than re-implement any of that logic here — which would drift out
  // of sync with the real thing over time — this script does the absolute
  // minimum: detect that a replay is available (same reliable `?id=`
  // detection the old relay script used), ask for a player name + optional
  // event label, and open the website with those pre-filled as URL params.
  // The website's own code (see `captureDtImportParams` /
  // `checkPendingDtImport` in index.html) picks them up, opens the New
  // Batch panel, fills it in, and leaves the ▶ Analyze click to you — so
  // you always see exactly what's about to be saved before it happens.

  const id = new URLSearchParams(window.location.search).get('id');
  if (!id) return;

  // Don't nag twice for the same replay in this browser.
  const seenKey = 'dt_prompted_' + id;
  if (GM_getValue(seenKey, false)) return;

  // Change this once if your Railway URL ever changes.
  const SITE = GM_getValue('duel_tools_site', 'https://duel-tools-kerem-production.up.railway.app');

  function buildUI() {
    if (document.getElementById('dt-save-prompt-box')) return;

    const box = document.createElement('div');
    box.id = 'dt-save-prompt-box';
    box.style.cssText = [
      'position:fixed', 'bottom:20px', 'right:20px', 'z-index:2147483647',
      'background:#111', 'color:#eee', 'border:1px solid #333', 'border-radius:8px',
      'font-family:monospace', 'font-size:13px', 'width:280px', 'padding:14px',
      'box-shadow:0 6px 24px rgba(0,0,0,.5)'
    ].join(';');

    box.innerHTML =
      '<div style="font-weight:bold;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">' +
        '<span>💾 Save to Duel Tools?</span>' +
        '<span id="dt-sp-close" style="cursor:pointer;color:#888">✕</span>' +
      '</div>' +
      '<label style="display:block;font-size:11px;color:#999;margin-bottom:2px">Player name (yours)</label>' +
      '<input id="dt-sp-player" type="text" style="width:100%;box-sizing:border-box;margin-bottom:8px;background:#1a1a1a;color:#eee;border:1px solid #333;border-radius:4px;padding:5px;font-family:monospace"/>' +
      '<label style="display:block;font-size:11px;color:#999;margin-bottom:2px">Event ID (optional)</label>' +
      '<input id="dt-sp-event" type="text" placeholder="e.g. FLC40, PWCQ87, S8: WK 3" style="width:100%;box-sizing:border-box;margin-bottom:10px;background:#1a1a1a;color:#eee;border:1px solid #333;border-radius:4px;padding:5px;font-family:monospace;text-transform:uppercase"/>' +
      '<div style="display:flex;gap:8px">' +
        '<button id="dt-sp-save" style="flex:1;background:#00e596;color:#050508;border:none;border-radius:5px;padding:7px;font-weight:bold;cursor:pointer;font-family:monospace">Save</button>' +
        '<button id="dt-sp-skip" style="flex:1;background:transparent;color:#888;border:1px solid #333;border-radius:5px;padding:7px;cursor:pointer;font-family:monospace">Not now</button>' +
      '</div>';

    document.body.appendChild(box);

    const playerInp = box.querySelector('#dt-sp-player');
    const eventInp  = box.querySelector('#dt-sp-event');
    playerInp.value = GM_getValue('dt_last_player', '');

    function dismiss(markSeen) {
      if (markSeen) GM_setValue(seenKey, true);
      box.remove();
    }

    box.querySelector('#dt-sp-close').onclick = function () { dismiss(false); };
    box.querySelector('#dt-sp-skip').onclick  = function () { dismiss(true); };
    box.querySelector('#dt-sp-save').onclick  = function () {
      const player = playerInp.value.trim();
      const event  = eventInp.value.trim();
      if (!player) { playerInp.style.borderColor = '#e04444'; playerInp.focus(); return; }
      GM_setValue('dt_last_player', player);
      dismiss(true);

      const url = new URL(SITE + '/');
      url.searchParams.set('dt_import', '1');
      url.searchParams.set('player', player);
      url.searchParams.set('replay', id);
      if (event) url.searchParams.set('event', event);
      // Opens a new tab rather than trying to find/focus an existing one —
      // tab-reuse across origins is unreliable across browsers/extensions,
      // so a fresh tab is the safe default. If you're usually logged in
      // and want it to land in an existing tab instead, say so and this
      // can be swapped for a GM_openInTab({ active:true }) call with a
      // fixed tab id.
      window.open(url.toString(), '_blank');
    };

    playerInp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') box.querySelector('#dt-sp-save').click();
    });
  }

  // Give DuelingBook's own replay page a moment to finish rendering so this
  // box doesn't fight it or get hidden behind other elements at load.
  setTimeout(buildUI, 1200);
})();
