// ==UserScript==
// @name         Duel Tools — Save Prompt
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Right when a DuelingBook match ends, offers to send the replay straight into Duel Tools' existing import flow.
// @author       Kerem's Duel Tools
// @match        https://www.duelingbook.com/*
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
  // This script does the absolute minimum on top of that: notice a match
  // just ended, get the replay ID, ask for a player name + optional event
  // label, and open the website with those pre-filled — the website's own
  // code (see `captureDtImportParams` / `checkPendingDtImport` in
  // index.html) picks them up and completes the save automatically.
  //
  // v2 change: a live duel on DuelingBook stays on the site's ROOT url the
  // whole time — there's no `?id=` to key off until you already have a
  // replay link. But once a match ends, the "Admit Defeat" button is
  // replaced by a "View Replay" button, and THAT is what actually reveals
  // the replay id (it opens a new window to /replay?id=...). So this script
  // now does two different things depending on where it finds itself:
  //   - On an actual /replay?id=... page (e.g. you clicked an old replay
  //     link, or the fallback below had to let one open for real): show the
  //     prompt immediately, same as v1.
  //   - Everywhere else (importantly, the live duel page itself): wait for
  //     "View Replay" to appear, read the id straight off of it WITHOUT
  //     actually opening a second window, and show the prompt right there
  //     on the live page the instant the match is over.

  const SITE = GM_getValue('duel_tools_site', 'https://duel-tools-kerem-production.up.railway.app');
  const ID_RE = /([0-9]{4,9}-[0-9]{5,10})/;

  function buildUI(id) {
    const seenKey = 'dt_prompted_' + id;
    if (GM_getValue(seenKey, false)) return;
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
      // so a fresh tab is the safe default.
      window.open(url.toString(), '_blank');
    };

    playerInp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') box.querySelector('#dt-sp-save').click();
    });
  }

  // ── Path A: already on a real replay page ─────────────────────────────
  const urlId = new URLSearchParams(window.location.search).get('id');
  if (window.location.pathname.indexOf('/replay') === 0 && urlId) {
    setTimeout(function () { buildUI(urlId); }, 1200);
    return;
  }

  // ── Path B: the live duel page — watch for "View Replay" to appear ─────
  // Kept off of every other page (lobby, profile, deck builder, ...) by
  // only ever arming once a #duel element actually exists, so this has
  // effectively zero cost unless you're in a match.
  const handledEls = new WeakSet();

  function findViewReplayEl(root) {
    const all = root.querySelectorAll('*');
    for (const el of all) {
      if (handledEls.has(el)) continue;
      const txt = (el.textContent || '').trim();
      if (txt !== 'View Replay') continue;
      // Prefer the innermost element carrying this exact text, not a large
      // container that merely contains it alongside other UI.
      let isLeaf = true;
      for (const child of el.children) {
        if ((child.textContent || '').trim() === 'View Replay') { isLeaf = false; break; }
      }
      if (isLeaf && el.offsetParent !== null) return el;
    }
    return null;
  }

  function extractIdFromElement(el) {
    const a = el.closest('a[href]') || el.querySelector('a[href]');
    if (a) {
      const m = ID_RE.exec(a.getAttribute('href') || '');
      if (m) return m[1];
    }
    let node = el;
    for (let i = 0; i < 5 && node; i++, node = node.parentElement) {
      const oc = node.getAttribute && node.getAttribute('onclick');
      if (oc) {
        const m = ID_RE.exec(oc);
        if (m) return m[1];
      }
    }
    return null;
  }

  // Last resort: briefly intercept window.open to see what URL this button
  // actually opens, without letting a real second window appear.
  function tryClickCapture(el) {
    return new Promise(function (resolve) {
      const origOpen = window.open;
      let captured = null;
      window.open = function (url) { captured = url; return { close: function(){}, closed: true, focus: function(){} }; };
      try { el.click(); } catch (e) {}
      setTimeout(function () {
        window.open = origOpen;
        const m = captured ? ID_RE.exec(captured) : null;
        resolve(m ? m[1] : null);
      }, 150);
    });
  }

  function handleFound(el) {
    handledEls.add(el);
    let id = extractIdFromElement(el);
    (id ? Promise.resolve(id) : tryClickCapture(el)).then(function (foundId) {
      if (foundId) {
        buildUI(foundId);
      } else {
        // Couldn't read the id any other way — fall back to letting the
        // real button do its thing. The popup it opens lands on
        // /replay?id=..., which Path A above handles the same as always.
        console.warn('[Duel Tools] Found "View Replay" but could not read a replay id from it — letting the real button open the replay instead.');
        el.click();
      }
    });
  }

  function armWatcher(duelEl) {
    let pending = false;
    function scan() {
      if (pending) return;
      const el = findViewReplayEl(duelEl);
      if (el) handleFound(el);
    }
    function scheduleScan() {
      if (pending) return;
      pending = true;
      setTimeout(function () { pending = false; scan(); }, 400); // debounce bursts of DOM churn during play
    }
    new MutationObserver(scheduleScan).observe(duelEl, { childList: true, subtree: true });
    scan();
  }

  (function waitForDuel() {
    const existing = document.getElementById('duel');
    if (existing) { armWatcher(existing); return; }
    const obs = new MutationObserver(function () {
      const el = document.getElementById('duel');
      if (el) { obs.disconnect(); armWatcher(el); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  })();
})();
