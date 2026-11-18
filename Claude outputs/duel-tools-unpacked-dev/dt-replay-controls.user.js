// ==UserScript==
// @name         Duel Tools — Replay Controls
// @namespace    http://tampermonkey.net/
// @version      5.0
// @description  Advanced Replay Controls: Play/Checkpoint/Prev/Next/Fast Rewind/Fast Forward, a Checkpoints dropdown, and the G1/G2/G3 game-jump buttons, replacing DuelingBook's own replay control row.
// @match        https://www.duelingbook.com/replay*
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';

  // ── v5: driven by dt-replay-engine.js, not self-tracked stepping ───────
  // v4 of this file relayed two DuelingBook-native primitives
  // (window.stepBackwardE for backward, window.updateDuelLog for forward)
  // through page-bridge.js and kept its OWN running step/game count, since
  // neither primitive told it where it actually was. That worked, but
  // stepBackwardE never updated the Duel Log panel's visible text — a real,
  // confirmed gap in DuelingBook's own "unfinished" stepBackward (see this
  // project's shared reference script's own comment, which independently
  // describes the exact same thing). dt-replay-engine.js (MAIN world,
  // injected by background.js on /replay* pages) replaces that primitive
  // entirely with a full snapshot/window.initDuel-based engine that fixes
  // the log-sync gap and tracks ground-truth position/game/known-games
  // itself — this file is now UI only. It drives the engine over
  // postMessage (DT_ENGINE_* request/DONE pairs, source: 'dt-content-shim'
  // out / 'dt-replay-engine' back — the same cross-world bridge pattern
  // page-bridge.js already used for the old DT_REPLAY_STEP relay, which no
  // longer exists) and polls DT_ENGINE_STATUS_REQUEST for pos/game/
  // canGoBack/playing/games instead of maintaining its own approximation.
  //
  // Net effect for the buttons below: Prev/« now jump by whatever snapshot
  // the engine has nearest at hand (usually several native plays in one
  // go, not one laborious step at a time) and the Duel Log panel is
  // provably in sync afterward (confirmed live, before this was wired in:
  // stepping forward again after a rewind reproduced the exact pre-rewind
  // board state AND exact pre-rewind log length/text). Game jumps
  // (G1/G2/G3, and the dropdown's "Game N") reconstruct that game's own
  // deal-out via the engine's jumpTo(), not a step-by-step walk. Play/Pause
  // now drive DuelingBook's own native pacing directly (DT_ENGINE_PLAY/
  // DT_ENGINE_PAUSE) instead of this script's own setInterval loop.

  const idMatch = /([0-9]{4,9}-[0-9]{5,10})/.exec(window.location.search + window.location.pathname);
  const REPLAY_ID = idMatch ? idMatch[1] : 'unknown';
  const CHECKPOINTS_KEY = 'dt_checkpoints_' + REPLAY_ID;
  const FAST_STEP = 10; // how many engine steps « and » move per click
  const STATUS_POLL_MS = 500; // how often the status line / button states refresh from the engine
  const REQUEST_TIMEOUT_MS = 8000; // a single DT_ENGINE_* round trip should never take this long — guards a missing/dead engine

  function log(msg) { console.log('[Duel Tools Replay]', msg); }
  function warn(msg) { console.warn('[Duel Tools Replay]', msg); }

  function getSetting(key, def) {
    try { return typeof GM_getValue === 'function' ? GM_getValue(key, def) : def; } catch (e) { return def; }
  }

  // Master toggle — "Enable advance Replay controls", on by default per
  // spec. Off means: leave DuelingBook's native replay controls completely
  // alone, don't build or hide anything, don't talk to the engine at all.
  if (!getSetting('dt_replay_controls_enabled', true)) {
    log('Advanced Replay Controls disabled via Kerem Duel Tools settings — leaving native controls as-is.');
    return;
  }

  // Checkpoints persist in localStorage (not GM_setValue/chrome.storage —
  // that's isolated-world-only and this data never needs to leave the
  // page), keyed per replay id so different replays don't collide. Each
  // entry is {id, label, step, game} where `step` is the engine's own
  // position index (pos()) — ground truth from dt-replay-engine.js, not a
  // number this file invents.
  function loadCheckpoints() {
    try { const raw = localStorage.getItem(CHECKPOINTS_KEY); return raw ? JSON.parse(raw) : []; } catch (e) { return []; }
  }
  function saveCheckpoints(list) {
    try { localStorage.setItem(CHECKPOINTS_KEY, JSON.stringify(list)); } catch (e) {}
  }
  const MAX_CUSTOM_PER_GAME = 3; // matches the real "Dueling Book Enhancer" Share UI's own Custom 1/2/3 slots
  function checkpointsForGame(n) {
    return loadCheckpoints().filter((c) => c.game === n); // already in save order
  }

  function findByExactText(text) {
    const all = document.querySelectorAll('body *');
    for (const el of all) {
      const t = (el.textContent || '').trim();
      if (t !== text) continue;
      let isLeaf = true;
      for (const c of el.children) {
        if ((c.textContent || '').trim() === text) { isLeaf = false; break; }
      }
      if (isLeaf && el.offsetParent !== null) return el;
    }
    return null;
  }

  // ── Bridge to dt-replay-engine.js ───────────────────────────────────────
  // One request → one DONE/STATUS reply, correlated by reqId, with a
  // timeout so a missing or not-yet-ready engine (e.g. this file somehow
  // ran on a non-replay page, or injection order got disturbed) fails
  // loudly in the console instead of hanging a button forever.
  const pending = new Map();
  window.addEventListener('message', (ev) => {
    if (!ev.data || ev.data.source !== 'dt-replay-engine') return;
    const reqId = ev.data.reqId;
    const entry = pending.get(reqId);
    if (!entry) return;
    pending.delete(reqId);
    clearTimeout(entry.timer);
    entry.resolve(ev.data);
  });
  function engineRequest(type, extra) {
    return new Promise((resolve) => {
      const reqId = Math.random().toString(36).slice(2);
      const timer = setTimeout(() => {
        if (!pending.has(reqId)) return;
        pending.delete(reqId);
        warn(type + ' timed out waiting on dt-replay-engine.js.');
        resolve({ ok: false, timedOut: true });
      }, REQUEST_TIMEOUT_MS);
      pending.set(reqId, { resolve, timer });
      window.postMessage(Object.assign({ source: 'dt-content-shim', type: type, reqId: reqId }, extra || {}), window.location.origin);
    });
  }
  function getStatus() { return engineRequest('DT_ENGINE_STATUS_REQUEST'); }

  // ── Local cache of the engine's last-known status — refreshed by the
  // poll loop in buildBar(), read by button handlers/UI so every click
  // doesn't need its own round trip just to decide what's clickable.
  let lastStatus = { ready: false, pos: 0, game: 1, canGoBack: false, jumping: false, waiting: false, playing: false, totalPlays: null, games: [] };

  function knownGames() { return lastStatus.games.map((g) => g.game); }
  function gameRange(n) {
    const g = lastStatus.games.find((x) => x.game === n);
    return g ? { start: g.start, end: g.end } : null;
  }

  let busy = false;
  async function runGuarded(label, fn) {
    if (busy) { warn(label + ' ignored — already seeking.'); return; }
    busy = true;
    try { await fn(); } finally { busy = false; }
  }

  function stepPrev() { return runGuarded('prev', () => engineRequest('DT_ENGINE_BACK', { turn: false })); }
  function stepNext() { return runGuarded('next', () => engineRequest('DT_ENGINE_NEXT')); }
  async function fastRewind() {
    return runGuarded('fast-rewind', async () => {
      for (let i = 0; i < FAST_STEP; i++) {
        const r = await engineRequest('DT_ENGINE_BACK', { turn: false });
        if (!r.ok) break; // hit the start of this game (or an unavailable engine) — stop early, don't spam failed requests
      }
    });
  }
  async function fastForward() {
    return runGuarded('fast-forward', async () => {
      for (let i = 0; i < FAST_STEP; i++) {
        const r = await engineRequest('DT_ENGINE_NEXT');
        if (!r.ok) break; // end of the replay, or the engine's genuinely stuck — stop early
      }
    });
  }
  function seekToStep(target) {
    return runGuarded('seekToStep', () => engineRequest('DT_ENGINE_SEEK', { step: target }));
  }
  function seekToGame(n) {
    return runGuarded('seekToGame', () => engineRequest('DT_ENGINE_JUMP_GAME', { game: n }));
  }

  function addCheckpoint() {
    const g = lastStatus.game;
    const forThisGame = checkpointsForGame(g);
    if (forThisGame.length >= MAX_CUSTOM_PER_GAME) {
      warn('Game ' + g + ' already has ' + MAX_CUSTOM_PER_GAME + ' custom checkpoints (the max) — delete one first.');
      return loadCheckpoints();
    }
    const list = loadCheckpoints();
    list.push({
      id: Date.now() + '-' + Math.random().toString(36).slice(2),
      label: 'Checkpoint ' + (list.length + 1),
      step: lastStatus.pos,
      game: g
    });
    saveCheckpoints(list);
    return list;
  }

  // ── "Share a replay moment" / "Jump to a replay moment" modal ──────────
  // Matches the real "Dueling Book Enhancer" Share UI's own shape (a
  // titled modal, one row per game, 6 tiles per row: Start/Middle/End on
  // top, Custom 1/2/3 below, greyed out when not yet known/saved) for TWO
  // different jobs, picked via `mode`:
  //  - 'share': every known game gets its own row; clicking an available
  //    tile copies a link to the clipboard instead of jumping.
  //  - 'goto': only `gameFilter`'s row is shown; clicking an available tile
  //    jumps this replay there directly and closes the modal.
  //
  // IMPORTANT, and worth being upfront about: the link "Share" copies is a
  // Duel Tools–specific link (#dt-replay-step=N on the current replay URL),
  // not a real "Dueling Book Enhancer" link — that extension's own links
  // encode a dbe-state/dbe-fingerprint pair this script has no way to
  // reproduce (there's no public spec for how those are derived, and
  // nothing on window exposes the function that builds them). A Duel
  // Tools link only resolves correctly for someone who ALSO has Duel Tools
  // installed with Advanced Replay Controls enabled — opening it without
  // the extension just loads the plain replay. That tradeoff is called out
  // directly in the modal's own subtitle text, not hidden.
  function copyToClipboard(text) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    } catch (e) {}
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    } catch (e) { warn('could not copy link to clipboard: ' + e); }
    return Promise.resolve();
  }
  function shareLinkFor(step) {
    return location.origin + location.pathname + location.search + '#dt-replay-step=' + step;
  }

  function closeMomentModal() {
    const el = document.getElementById('dt-moment-modal');
    if (el) el.remove();
  }

  // v5.3: restyled AGAIN, this time to actually match — v5.2's dark
  // green-neon "hacker tile" look was a guess at what "DB's tile buttons"
  // meant and turned out wrong. Confirmed directly from the live DOM
  // (getComputedStyle on #play_btn/#pause_replay_btn/#next_btn/#fast_btn)
  // AND from the user's own reference screenshot of them: DuelingBook's
  // real Play/Pause/Next Play/Fast Forward row is nothing but the
  // UNSTYLED browser-default <input type=submit> look — light gray face,
  // a classic 2px outset bevel, black Arial text, square corners. That IS
  // "DB's tile buttons" — DB never themes them at all. This reproduces
  // that exact native chrome (same border-color/style trick browsers use
  // to paint the light/dark bevel edges from one outset border) instead of
  // inventing a look DB doesn't actually have.
  function ensureTileStyles() {
    if (document.getElementById('dt-rc-tile-styles')) return;
    const style = document.createElement('style');
    style.id = 'dt-rc-tile-styles';
    style.textContent =
      '.dt-rc-tile{background:#f0f0f0;color:#000;border:2px outset #000;border-radius:0;' +
        'padding:3px 4px;cursor:pointer;font-family:Arial,sans-serif;font-size:11px;flex:1}' +
      '.dt-rc-tile:hover:not(:disabled){background:#e8e8e8}' +
      '.dt-rc-tile:active:not(:disabled){border-style:inset}' +
      '.dt-rc-tile:disabled{color:#808080;cursor:not-allowed;background:#f0f0f0}';
    document.head.appendChild(style);
  }

  function btnStyle(extra) {
    return 'flex:1' + (extra ? ';' + extra : '');
  }

  function momentTileHtml(key, label, available) {
    return '<button class="dt-moment-tile" data-key="' + key + '" ' + (available ? '' : 'disabled') + ' style="' +
      'padding:10px 6px;border-radius:6px;font-family:monospace;font-size:12px;cursor:' + (available ? 'pointer' : 'not-allowed') + ';' +
      'border:1px solid #345;background:' + (available ? '#1b3a4a' : '#1a1a1a') + ';color:' + (available ? '#cde' : '#555') + ';">' +
      label + '</button>';
  }

  function buildGameRow(game, mode) {
    const range = gameRange(game);
    const customs = checkpointsForGame(game);
    const tiles = [
      { key: 'start', label: 'Start', available: !!range },
      { key: 'middle', label: 'Middle', available: !!(range && range.end !== undefined) },
      { key: 'end', label: 'End', available: !!(range && range.end !== undefined) }
    ];
    for (let i = 0; i < MAX_CUSTOM_PER_GAME; i++) {
      tiles.push({ key: 'custom' + i, label: 'Custom ' + (i + 1), available: !!customs[i] });
    }
    const row = document.createElement('div');
    row.style.cssText = 'margin-bottom:14px';
    row.innerHTML =
      '<div style="color:#8ac;font-weight:bold;margin-bottom:6px">Game ' + game + '</div>' +
      '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">' +
        tiles.map((t) => momentTileHtml(t.key, t.label, t.available)).join('') +
      '</div>';
    row.querySelectorAll('.dt-moment-tile:not([disabled])').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const key = btn.dataset.key;
        let step;
        if (key === 'start') step = range.start;
        else if (key === 'end') step = range.end;
        else if (key === 'middle') step = Math.round((range.start + range.end) / 2);
        else step = customs[parseInt(key.replace('custom', ''), 10)].step;
        if (step === undefined) return;
        if (mode === 'share') {
          await copyToClipboard(shareLinkFor(step));
          const orig = btn.textContent;
          btn.textContent = 'Copied!';
          setTimeout(() => { btn.textContent = orig; }, 1200);
        } else {
          closeMomentModal();
          // "Start" reuses the same reliable deal-out jump the standalone
          // G1/G2/G3 buttons use; Middle/End/Custom are arbitrary
          // mid-game positions, so those go through the engine's
          // composite seekToStep instead.
          if (key === 'start') seekToGame(game);
          else seekToStep(step);
        }
      });
    });
    return row;
  }

  function openMomentModal(mode, gameFilter) {
    closeMomentModal();
    const overlay = document.createElement('div');
    overlay.id = 'dt-moment-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483100;background:rgba(0,0,0,.6);' +
      'display:flex;align-items:center;justify-content:center;font-family:monospace';
    const box = document.createElement('div');
    box.style.cssText = 'background:#12222c;color:#eee;border:1px solid #2a4a5a;border-radius:10px;' +
      'padding:20px;width:420px;max-width:90vw;max-height:80vh;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,.6)';
    const title = mode === 'share' ? 'Share a replay moment' : 'Jump to a replay moment';
    const subtitle = mode === 'share'
      ? 'Click an available checkpoint to copy a Duel Tools link that opens this replay at that moment. (Needs Duel Tools with Advanced Replay Controls on the other end — this isn\'t a Dueling Book Enhancer link.)'
      : 'Click an available checkpoint to jump there.';
    box.innerHTML =
      '<div style="font-size:16px;font-weight:bold;margin-bottom:4px">' + title + '</div>' +
      '<div style="font-size:11px;color:#8ab;margin-bottom:16px">' + subtitle + '</div>' +
      '<div id="dt-moment-rows"></div>' +
      '<div style="text-align:right;margin-top:6px">' +
        '<button id="dt-moment-close" style="' + btnStyle('flex:none;padding:6px 16px') + '">Close</button>' +
      '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const rowsEl = box.querySelector('#dt-moment-rows');
    const games = mode === 'share' ? knownGames() : [gameFilter];
    games.forEach((g) => rowsEl.appendChild(buildGameRow(g, mode)));

    box.querySelector('#dt-moment-close').addEventListener('click', closeMomentModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeMomentModal(); });
    function onEsc(e) { if (e.key === 'Escape') { closeMomentModal(); window.removeEventListener('keydown', onEsc); } }
    window.addEventListener('keydown', onEsc);
  }

  // Opening a Duel Tools share link (#dt-replay-step=N) auto-jumps there
  // once the bar is up and the engine has reported ready at least once.
  function resumeFromShareLink() {
    const m = /dt-replay-step=(\d+)/.exec(location.hash);
    if (!m) return;
    const target = parseInt(m[1], 10);
    log('opened from a Duel Tools share link — jumping to step ' + target + '...');
    seekToStep(target);
  }
  let resumedFromShareLink = false;

  function buildBar() {
    if (document.getElementById('dt-replay-controls')) return;
    const anchorBtn = findByExactText('Pause') || findByExactText('Play') || findByExactText('Fast Forward');
    if (!anchorBtn) { setTimeout(buildBar, 500); return; } // retry until DuelingBook's own controls exist
    // Per explicit instruction: DuelingBook's own native Play/Pause/Next
    // Play/Fast Forward row is NEVER hidden — this panel is a separate,
    // additional module (Advanced Replay Controls), not a replacement for
    // them, so the native row stays visible and usable like normal
    // alongside it. (An earlier version of this file called a
    // hideNativeControls() here that display:none'd those buttons by exact
    // text match — removed entirely, not just unused, so there's no path
    // left that can hide them again.)
    ensureTileStyles();

    // v5.5: reverted back to the fixed bottom-left corner — v5.4's anchor
    // beside DuelingBook's "Hide Hands / Show Hand / Show Both" controls
    // was confirmed live as too cramped there (the panel ran into the
    // GOAT World Championship badge / card thumbnails just past them), so
    // per the user's own call this panel goes back to owning its own
    // corner like the other three Duel Tools panels, rather than sharing
    // a tight slice of space with native controls.
    const panel = document.createElement('div');
    panel.id = 'dt-replay-controls';
    panel.style.cssText = [
      'position:fixed', 'left:20px', 'bottom:20px', 'z-index:2147483000',
      'background:#111', 'color:#eee', 'border:1px solid #333', 'border-radius:8px',
      'font-family:monospace', 'font-size:11px', 'padding:8px', 'width:190px',
      'box-shadow:0 6px 24px rgba(0,0,0,.5)'
    ].join(';');
    panel.innerHTML =
      '<div style="color:#666;margin-bottom:6px">Kerem Duel Tools - Adv. Replay</div>' +
      '<div style="display:flex;gap:4px;margin-bottom:4px">' +
        '<button id="dt-r-rewind" class="dt-rc-tile" style="' + btnStyle() + '" title="Fast Rewind (' + FAST_STEP + ' steps back)">«</button>' +
        '<button id="dt-r-prev" class="dt-rc-tile" style="' + btnStyle() + '" title="Prev (one step back)">⏮</button>' +
        '<button id="dt-r-playpause" class="dt-rc-tile" style="' + btnStyle('flex:2') + '" title="Play / Pause">▶ Play</button>' +
        '<button id="dt-r-next" class="dt-rc-tile" style="' + btnStyle() + '" title="Next (one step forward)">⏭</button>' +
        '<button id="dt-r-forward" class="dt-rc-tile" style="' + btnStyle() + '" title="Fast Forward (' + FAST_STEP + ' steps ahead)">»</button>' +
      '</div>' +
      '<div style="display:flex;gap:4px;margin-bottom:4px;position:relative">' +
        '<button id="dt-r-checkpoint" class="dt-rc-tile" style="' + btnStyle('flex:2') + '" title="Save a checkpoint here">★ Checkpoint</button>' +
        '<button id="dt-r-cp-del" class="dt-rc-tile" style="' + btnStyle('flex:0 0 28px') + '" title="Delete the selected checkpoint">🗑</button>' +
        '<button id="dt-r-moment-caret" class="dt-rc-tile" style="' + btnStyle('flex:0 0 24px') + '" title="Share or jump to a moment">▾</button>' +
        '<div id="dt-r-moment-menu" style="display:none;position:absolute;top:100%;right:0;z-index:10;' +
          'background:#1a1a1a;border:1px solid #345;border-radius:6px;padding:4px;min-width:110px"></div>' +
      '</div>' +
      '<select id="dt-r-cp-list" style="width:100%;margin-bottom:6px;background:#15241c;color:#bfe8cf;border:1px solid #2f6b45;border-radius:7px;font-family:monospace;font-size:11px;padding:4px"></select>' +
      '<div style="display:flex;gap:4px">' +
        '<button data-dt-game="1" class="dt-rc-tile" style="' + btnStyle() + '" title="Jump to Game 1">G1</button>' +
        '<button data-dt-game="2" class="dt-rc-tile" style="' + btnStyle() + '" title="Jump to Game 2">G2</button>' +
        '<button data-dt-game="3" class="dt-rc-tile" style="' + btnStyle() + '" title="Jump to Game 3">G3</button>' +
      '</div>' +
      '<div id="dt-r-status" style="margin-top:6px;color:#666;font-size:10px">waiting for engine…</div>';
    document.body.appendChild(panel);

    const cpSelect = panel.querySelector('#dt-r-cp-list');
    function renderCheckpointList() {
      const list = loadCheckpoints();
      cpSelect.innerHTML = list.length
        ? list.map((c) => '<option value="' + c.id + '">' + c.label + ' (step ' + c.step + ', Game ' + c.game + ')</option>').join('')
        : '<option value="">No checkpoints yet</option>';
    }
    renderCheckpointList();

    const playPauseBtn = panel.querySelector('#dt-r-playpause');
    const statusEl = panel.querySelector('#dt-r-status');
    function render() {
      playPauseBtn.textContent = lastStatus.playing ? '⏸ Pause' : '▶ Play';
      if (!lastStatus.ready) {
        statusEl.textContent = 'waiting for engine…';
      } else {
        statusEl.textContent = 'step ' + lastStatus.pos + (lastStatus.totalPlays != null ? '/' + lastStatus.totalPlays : '') +
          ' · Game ' + lastStatus.game + (lastStatus.jumping ? ' · jumping…' : lastStatus.waiting ? ' · …' : '');
      }
    }

    // Poll the engine's own ground-truth status rather than maintaining a
    // local approximation — this is also what notices the engine becoming
    // ready (loadReplayComplete having fired) so the one-time share-link
    // resume and the initial "ready" log line fire at the right moment,
    // not optimistically on script start.
    async function pollStatus() {
      const s = await getStatus();
      if (s && typeof s.ready === 'boolean') {
        const justBecameReady = s.ready && !lastStatus.ready;
        lastStatus = s;
        render();
        if (justBecameReady) {
          log('engine ready (Game ' + s.game + ' right now, step ' + s.pos + ', ' + s.games.length + ' known game(s)).');
          if (!resumedFromShareLink) { resumedFromShareLink = true; resumeFromShareLink(); }
        }
      }
    }
    pollStatus();
    setInterval(pollStatus, STATUS_POLL_MS);

    panel.querySelector('#dt-r-checkpoint').addEventListener('click', () => { addCheckpoint(); renderCheckpointList(); });
    panel.querySelector('#dt-r-cp-del').addEventListener('click', () => {
      const id = cpSelect.value;
      if (!id) return;
      saveCheckpoints(loadCheckpoints().filter((c) => c.id !== id));
      renderCheckpointList();
    });
    cpSelect.addEventListener('change', () => {
      const id = cpSelect.value;
      const cp = loadCheckpoints().find((c) => c.id === id);
      if (cp) seekToStep(cp.step);
    });

    const momentMenu = panel.querySelector('#dt-r-moment-menu');
    function renderMomentMenu() {
      const items = ['Share'].concat(knownGames().map((g) => 'Game ' + g));
      momentMenu.innerHTML = items.map((label) =>
        '<div class="dt-moment-menu-item" style="padding:5px 8px;cursor:pointer;white-space:nowrap;font-size:11px;color:#9ac" data-label="' + label + '">' + label + '</div>'
      ).join('');
      momentMenu.querySelectorAll('.dt-moment-menu-item').forEach((item) => {
        item.addEventListener('mouseenter', () => { item.style.background = '#234'; });
        item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
        item.addEventListener('click', () => {
          momentMenu.style.display = 'none';
          const label = item.dataset.label;
          if (label === 'Share') openMomentModal('share', null);
          else openMomentModal('goto', parseInt(label.replace('Game ', ''), 10));
        });
      });
    }
    panel.querySelector('#dt-r-moment-caret').addEventListener('click', (e) => {
      e.stopPropagation();
      const opening = momentMenu.style.display === 'none';
      if (opening) renderMomentMenu();
      momentMenu.style.display = opening ? 'block' : 'none';
    });
    document.addEventListener('click', () => { momentMenu.style.display = 'none'; });

    panel.querySelector('#dt-r-prev').addEventListener('click', stepPrev);
    panel.querySelector('#dt-r-next').addEventListener('click', stepNext);
    panel.querySelector('#dt-r-rewind').addEventListener('click', fastRewind);
    panel.querySelector('#dt-r-forward').addEventListener('click', fastForward);

    // Play/Pause now drive DuelingBook's own native autoplay pacing
    // directly through the engine (DT_ENGINE_PLAY/DT_ENGINE_PAUSE →
    // window.playE()/window.pauseE()) instead of this script running its
    // own setInterval auto-advance loop — the status poll above picks up
    // the resulting `playing` state and relabels the button either way,
    // including when native autoplay reaches the end on its own.
    playPauseBtn.addEventListener('click', () => {
      if (lastStatus.playing) engineRequest('DT_ENGINE_PAUSE');
      else engineRequest('DT_ENGINE_PLAY');
    });

    panel.querySelectorAll('button[data-dt-game]').forEach((btn) => {
      btn.addEventListener('click', () => seekToGame(parseInt(btn.dataset.dtGame, 10)));
    });

    log('advanced replay controls UI ready — waiting on dt-replay-engine.js.');
  }
  buildBar();

  // Exposed for tests — a synthetic fixture can call these directly rather
  // than needing a real dt-replay-engine.js relay in place.
  window.__dtReplayTestHooks = {
    findByExactText,
    engineRequest, getStatus,
    get lastStatus() { return lastStatus; },
    set lastStatus(v) { lastStatus = v; },
    knownGames, gameRange,
    stepNext, stepPrev, fastForward, fastRewind, seekToStep, seekToGame,
    loadCheckpoints, saveCheckpoints, addCheckpoint, checkpointsForGame,
    shareLinkFor, openMomentModal, closeMomentModal, buildGameRow, resumeFromShareLink
  };
})();
