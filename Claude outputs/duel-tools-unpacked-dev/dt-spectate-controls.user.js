// ==UserScript==
// @name         Duel Tools — Spectate Controls
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  "Enable Replays While Spectating": while watching a LIVE duel (not a saved replay), adds Play/Pause/Prev/Next/«/», bookmarks, and a "View Live" button that lets you rewind into the match's own history and jump back to real time.
// @match        https://www.duelingbook.com/*
// @grant        GM_getValue
// @run-at       document-idle
// ==/UserScript==
(function () {
  'use strict';

  // Never on /replay* — that's dt-replay-controls.user.js's job (a saved,
  // already-complete replay). This file is strictly for a LIVE duel being
  // watched as it happens, driven by dt-spectate-engine.js (MAIN world,
  // background.js-injected on the regular duelingbook.com root).
  if (/^\/replay\b/.test(window.location.pathname)) return;

  const FAST_STEP = 10; // how many engine steps « and » move per click, same convention as Advanced Replay Controls
  const STATUS_POLL_MS = 600; // keepalive query in case a DT_SPECTATE_STATE push was missed (tab backgrounded, etc.)
  const BUILD_RETRY_MS = 1000;

  function log(msg) { try { console.log('[Duel Tools Spectate]', msg); } catch (e) {} }
  function warn(msg) { try { console.warn('[Duel Tools Spectate]', msg); } catch (e) {} }

  function getSetting(key, def) {
    try { return typeof GM_getValue === 'function' ? GM_getValue(key, def) : def; } catch (e) { return def; }
  }

  // Master toggle — "Enable Replays While Spectating", OFF by default per
  // spec (this is new, unproven-in-the-wild behavior touching a live
  // match's own rendering, unlike Advanced Replay Controls which only ever
  // runs on an already-finished /replay* page).
  if (!getSetting('dt_spectate_replay_enabled', false)) {
    log('Replays While Spectating disabled via Kerem Duel Tools settings.');
    return;
  }

  // ── Bridge to dt-spectate-engine.js ─────────────────────────────────────
  // Unlike dt-replay-engine.js's request/response-by-reqId bridge, this one
  // mirrors what's actually implemented engine-side: the engine PUSHES a
  // fresh DT_SPECTATE_STATE after every command on its own, so this file
  // just keeps a passively-updated local copy and sends DT_SPECTATE_QUERY
  // as a keepalive/catch-up poll rather than correlating a reply to every
  // single request. Simpler, and matches the engine file as written.
  let lastState = { total: 0, cur: -1, isLive: true, game: 1, games: [], bookmarks: [], spectating: false, duelEnded: false, corrupted: false, playing: false, followLive: true };
  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.origin !== window.location.origin) return;
    const d = ev.data;
    if (!d || d.source !== 'dt-spectate-engine' || d.type !== 'DT_SPECTATE_STATE') return;
    lastState = d;
    render();
  });
  function send(cmd, data) {
    window.postMessage({ source: 'dt-spectate-controls', type: 'DT_SPECTATE_CMD', cmd: cmd, data: data }, window.location.origin);
  }
  function queryNow() {
    window.postMessage({ source: 'dt-spectate-controls', type: 'DT_SPECTATE_QUERY' }, window.location.origin);
  }

  let busy = false;
  async function runGuarded(label, fn) {
    if (busy) { warn(label + ' ignored — already seeking.'); return; }
    busy = true;
    try { await fn(); } finally { busy = false; }
  }
  function waitMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function stepPrev() { return runGuarded('prev', async () => { send('prev'); await waitMs(120); }); }
  function stepNext() { return runGuarded('next', async () => { send('next'); await waitMs(120); }); }
  async function fastRewind() {
    return runGuarded('fast-rewind', async () => {
      for (let i = 0; i < FAST_STEP; i++) {
        const before = lastState.cur;
        send('prev');
        await waitMs(120);
        if (lastState.cur === before) break; // hit the start of this game — stop early
      }
    });
  }
  async function fastForward() {
    return runGuarded('fast-forward', async () => {
      for (let i = 0; i < FAST_STEP; i++) {
        const before = lastState.cur;
        send('next');
        await waitMs(120);
        if (lastState.cur === before) break; // already back at live — stop early
      }
    });
  }
  function goLive() { return runGuarded('view-live', async () => { send('latest'); await waitMs(120); }); }
  function goEarliest() { return runGuarded('earliest', async () => { send('earliest'); await waitMs(120); }); }
  // Two separate buttons, not one toggle — matches the real "Dueling Book
  // Enhancer" layout (its #dbx-spectator-controls has distinct Play and
  // Pause buttons side by side, confirmed directly against it), and is
  // what the user's own original spec described too. An earlier version of
  // this file combined them into a single relabeling toggle button, which
  // the user flagged live as "there is not a pause button" — correct: a
  // button that only ever displays "Play" when idle never visibly offers
  // Pause at all. doPlay()/doPause() are disabled via render() below
  // instead (Play disabled while already playing, Pause disabled while
  // not), so it's clear which one is live at a glance.
  function doPlay() { send('play'); }
  function doPause() { send('pause'); }

  // ── Bookmark ("BM") modal ────────────────────────────────────────────
  // Mirrors the shape of the real "Dueling Book Enhancer" BM modal the
  // user walked through live (title "Game N", a one-line note that only
  // the recorded portion of the game is available, Earliest/Latest Move
  // buttons, then the saved bookmarks for that game) — confirmed directly
  // against that extension rather than guessed. Our own bookmark list
  // isn't capped at a fixed slot count the way that one's "Custom 1/2"
  // looked; any number can be saved, since the engine's RB.bookmarks is a
  // plain in-memory list. Bookmarks are per-session only (not persisted to
  // localStorage) — a live spectated match isn't a durable id the way a
  // finished /replay* one is, and the engine's own RB resets on reload
  // anyway, so a saved bookmark can never outlive the duel it was made in.
  function closeBmModal() {
    const el = document.getElementById('dt-spec-bm-modal');
    if (el) el.remove();
  }
  function openBmModal() {
    closeBmModal();
    const overlay = document.createElement('div');
    overlay.id = 'dt-spec-bm-modal';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483100;background:rgba(0,0,0,.6);' +
      'display:flex;align-items:center;justify-content:center;font-family:monospace';
    const box = document.createElement('div');
    box.style.cssText = 'background:#12222c;color:#eee;border:1px solid #2a4a5a;border-radius:10px;' +
      'padding:20px;width:360px;max-width:90vw;max-height:80vh;overflow:auto;box-shadow:0 10px 40px rgba(0,0,0,.6)';
    box.innerHTML =
      '<div style="font-size:16px;font-weight:bold;margin-bottom:4px">Game ' + lastState.game + '</div>' +
      '<div style="font-size:11px;color:#8ab;margin-bottom:16px">Only the recorded portion of this game is available.</div>' +
      '<div style="display:flex;gap:6px;margin-bottom:14px">' +
        '<button id="dt-spec-bm-earliest" class="dt-spec-tile" style="flex:1">Earliest Move</button>' +
        '<button id="dt-spec-bm-latest" class="dt-spec-tile" style="flex:1">Latest Move</button>' +
      '</div>' +
      '<div id="dt-spec-bm-list" style="display:flex;flex-direction:column;gap:6px;margin-bottom:14px"></div>' +
      '<button id="dt-spec-bm-add" class="dt-spec-tile" style="width:100%;margin-bottom:10px">+ Bookmark This Moment</button>' +
      '<div style="text-align:right">' +
        '<button id="dt-spec-bm-close" class="dt-spec-tile" style="flex:none;padding:6px 16px">Close</button>' +
      '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const listEl = box.querySelector('#dt-spec-bm-list');
    function renderList() {
      const bms = lastState.bookmarks || [];
      listEl.innerHTML = bms.length
        ? bms.map((b, i) =>
            '<div style="display:flex;gap:6px">' +
              '<button class="dt-spec-tile dt-spec-bm-jump" data-i="' + i + '" style="flex:1;text-align:left">' + b.label + '</button>' +
              '<button class="dt-spec-tile dt-spec-bm-del" data-i="' + i + '" style="flex:0 0 32px">🗑</button>' +
            '</div>'
          ).join('')
        : '<div style="color:#567;font-size:11px">No bookmarks yet this match.</div>';
      listEl.querySelectorAll('.dt-spec-bm-jump').forEach((btn) => {
        btn.addEventListener('click', () => { send('jumpToBookmark', { i: parseInt(btn.dataset.i, 10) }); closeBmModal(); });
      });
      listEl.querySelectorAll('.dt-spec-bm-del').forEach((btn) => {
        btn.addEventListener('click', () => {
          const i = parseInt(btn.dataset.i, 10);
          lastState.bookmarks = (lastState.bookmarks || []).filter((_, idx) => idx !== i);
          send('deleteBookmark', { i });
          renderList();
        });
      });
    }
    renderList();

    box.querySelector('#dt-spec-bm-earliest').addEventListener('click', () => { goEarliest(); closeBmModal(); });
    box.querySelector('#dt-spec-bm-latest').addEventListener('click', () => { goLive(); closeBmModal(); });
    box.querySelector('#dt-spec-bm-add').addEventListener('click', () => {
      send('addBookmark', { label: 'Bookmark ' + ((lastState.bookmarks || []).length + 1) });
      setTimeout(renderList, 80);
    });
    box.querySelector('#dt-spec-bm-close').addEventListener('click', closeBmModal);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeBmModal(); });
    function onEsc(e) { if (e.key === 'Escape') { closeBmModal(); window.removeEventListener('keydown', onEsc); } }
    window.addEventListener('keydown', onEsc);
  }

  function ensureTileStyles() {
    if (document.getElementById('dt-spec-tile-styles')) return;
    const style = document.createElement('style');
    style.id = 'dt-spec-tile-styles';
    // Same native-browser-chrome look Advanced Replay Controls settled on
    // after confirming it directly against DuelingBook's own unstyled
    // Play/Pause/Next/Fast Forward row — kept consistent across both panels.
    style.textContent =
      '.dt-spec-tile{background:#f0f0f0;color:#000;border:2px outset #000;border-radius:0;' +
        'padding:4px 5px;cursor:pointer;font-family:Arial,sans-serif;font-size:11px}' +
      '.dt-spec-tile:hover:not(:disabled){background:#e8e8e8}' +
      '.dt-spec-tile:active:not(:disabled){border-style:inset}' +
      '.dt-spec-tile:disabled{color:#808080;cursor:not-allowed;background:#f0f0f0}';
    document.head.appendChild(style);
  }

  let panel = null;
  function render() {
    if (!panel) return;
    // Belt-and-suspenders, same discipline as every other Duel Tools panel
    // in this project: the engine's own state is the ground truth for
    // whether a real spectator (never a player) is actually watching a
    // live duel's page at all — hide immediately the moment that stops
    // being true, same existence-vs-visibility trap this project keeps
    // running into. duelEnded is deliberately NOT part of this check —
    // confirmed live: it goes true for an ordinary reason (DuelingBook's
    // own card arrays briefly empty between games, or after the match
    // ends) that has nothing to do with whether you're still watching, and
    // the user flagged exactly this live (the whole panel vanished right
    // as a real between-games/post-match moment happened to coincide with
    // testing the BM button — not caused by the click itself). The panel
    // itself must never disappear just because the match-level state
    // changed; only the buttons that would actually fail get disabled.
    const shouldShow = !!lastState.spectating;
    panel.style.display = shouldShow ? 'block' : 'none';
    if (!shouldShow) return;

    // restore() refuses outright once duelEnded is true (no live card
    // state to restore into — see dt-spectate-engine.js) — every one of
    // these drives restore() sooner or later, so they're disabled rather
    // than left clickable-but-silently-failing. BM stays enabled: viewing/
    // adding bookmark LABELS doesn't touch restore() at all, only jumping
    // to one does, and that's covered by jumpToBookmark's own restore()
    // call failing the same safe way everything else here does.
    const restoreDisabled = !!lastState.duelEnded;
    // followLive (from the engine) is the real "are we watching it happen
    // in real time right now" signal — NOT lastState.isLive, which only
    // means "cur happens to equal the newest recorded snapshot" and stays
    // true for a brief moment even right after Pause, until the next real
    // action creates a new snapshot the view doesn't follow. Gating these
    // three buttons on followLive instead is what actually fixes "Pause
    // only worked for a moment / Play should be greyed out while live":
    // Pause is the live, normal-watching state's button (freeze it);
    // Play and View Live only make sense once you're actually frozen.
    const following = !!lastState.followLive;
    const playing = !!lastState.playing;
    const playBtn = panel.querySelector('#dt-spec-play');
    const pauseBtn = panel.querySelector('#dt-spec-pause');
    playBtn.disabled = following || playing || restoreDisabled;
    pauseBtn.disabled = (!following && !playing) || restoreDisabled;
    const liveBtn = panel.querySelector('#dt-spec-live');
    liveBtn.textContent = following ? '● Live' : '⤴ View Live';
    liveBtn.disabled = following || restoreDisabled;
    // Rewind/Prev stay enabled while following live on purpose — the
    // engine's 'prev'/'earliest' handlers already force followLive=false
    // themselves, so clicking either one IS "pause, then rewind" in one
    // click, same as the user described. Next/Forward are the opposite:
    // while following live there's nothing ahead of you to step into
    // (every new action auto-advances the view already), so those two
    // specifically grey out whenever `following` is true, not just when
    // restore is unavailable.
    panel.querySelector('#dt-spec-rewind').disabled = restoreDisabled || lastState.cur <= 0;
    panel.querySelector('#dt-spec-prev').disabled = restoreDisabled || lastState.cur <= 0;
    panel.querySelector('#dt-spec-next').disabled = restoreDisabled || following || lastState.cur >= lastState.total - 1;
    panel.querySelector('#dt-spec-forward').disabled = restoreDisabled || following || lastState.cur >= lastState.total - 1;
    const bmBtn = panel.querySelector('#dt-spec-bm');
    bmBtn.textContent = 'BM (' + ((lastState.bookmarks || []).length) + ')';
    const jumpSel = panel.querySelector('#dt-spec-jump');
    jumpSel.disabled = restoreDisabled;
    const games = lastState.games || [];
    const wantOptions = ['<option value="">Jump to game…</option>'].concat(
      games.map((g) => '<option value="' + g + '">Game ' + g + (g === lastState.game ? ' (current)' : '') + '</option>')
    ).join('');
    if (jumpSel.dataset.rendered !== wantOptions) { jumpSel.innerHTML = wantOptions; jumpSel.dataset.rendered = wantOptions; }
    const statusEl = panel.querySelector('#dt-spec-status');
    // 'corrupted' and plain 'duelEnded' look identical from the buttons
    // alone (both disable rewind) but mean very different things: ended/
    // between-games is normal and will clear itself once the next game's
    // RPS starts; corrupted means this engine's own rewinding broke
    // DuelingBook's live object for real and only a page reload fixes it.
    // Saying so plainly beats leaving the user guessing why it's stuck —
    // and thanks to persist()/tryResume() above, that reload no longer
    // costs the recorded history or bookmarks either.
    statusEl.textContent = lastState.corrupted
      ? '⚠ spectator view corrupted — refresh the page (your history & bookmarks will resume)'
      : restoreDisabled
        ? 'duel ended or between games — rewind unavailable, bookmarks kept'
        : lastState.total
          ? 'moment ' + (lastState.cur + 1) + '/' + lastState.total + ' · Game ' + lastState.game + (following ? ' · LIVE' : playing ? ' · playing…' : ' · paused')
          : 'watching for the first play…';
    statusEl.style.color = lastState.corrupted ? '#e8a33d' : '#666';

    if (document.getElementById('dt-spec-bm-modal')) {
      const title = document.querySelector('#dt-spec-bm-modal > div');
      if (title) title.firstElementChild.textContent = 'Game ' + lastState.game;
    }
  }

  function buildPanel() {
    if (document.getElementById('dt-spectate-controls')) return;
    ensureTileStyles();

    // Bottom-left, same corner the real "Dueling Book Enhancer" uses for
    // its own #dbx-spectator-controls row (confirmed directly against it
    // live) — and this project's Advanced Replay Controls panel never runs
    // on the same page as this one (that's /replay*-only, this is the live
    // root), so there's no corner conflict to resolve either.
    panel = document.createElement('div');
    panel.id = 'dt-spectate-controls';
    panel.style.cssText = [
      'position:fixed', 'left:4px', 'bottom:4px', 'z-index:2147483000', 'display:none',
      'background:#111', 'color:#eee', 'border:1px solid #333', 'border-radius:8px',
      'font-family:monospace', 'font-size:11px', 'padding:8px', 'width:200px',
      'box-shadow:0 6px 24px rgba(0,0,0,.5)'
    ].join(';');
    panel.innerHTML =
      '<div style="color:#666;margin-bottom:6px">Kerem Duel Tools - Spectate</div>' +
      '<div style="display:flex;gap:4px;margin-bottom:4px">' +
        '<button id="dt-spec-rewind" class="dt-spec-tile" style="flex:1" title="Fast Rewind (' + FAST_STEP + ' moments back)">«</button>' +
        '<button id="dt-spec-prev" class="dt-spec-tile" style="flex:1" title="Prev moment">⏮</button>' +
        // Pause (not Play) is the enabled one by default — you start out
        // following the live duel in real time, same initial state as
        // RB.followLive:true engine-side, so Play (only meaningful once
        // actually paused/rewound) starts disabled instead.
        '<button id="dt-spec-play" class="dt-spec-tile" style="flex:1" title="Play" disabled>▶ Play</button>' +
        '<button id="dt-spec-pause" class="dt-spec-tile" style="flex:1" title="Pause">⏸ Pause</button>' +
        '<button id="dt-spec-next" class="dt-spec-tile" style="flex:1" title="Next moment">⏭</button>' +
        '<button id="dt-spec-forward" class="dt-spec-tile" style="flex:1" title="Fast Forward (' + FAST_STEP + ' moments ahead)">»</button>' +
      '</div>' +
      '<div style="display:flex;gap:4px;margin-bottom:4px">' +
        '<button id="dt-spec-bm" class="dt-spec-tile" style="flex:1" title="Bookmarks">BM (0)</button>' +
        '<button id="dt-spec-live" class="dt-spec-tile" style="flex:2" title="Jump back to the real-time duel">● Live</button>' +
      '</div>' +
      // Separate "Jump" dropdown, matching the real "Dueling Book
      // Enhancer"'s own #dbx-spectator-games select next to its control
      // row (confirmed live) — lists each game the engine has actually
      // recorded so far (RB's own games array), not a fixed G1/G2/G3 row,
      // since a spectator who just joined may not even have Game 1 on
      // record yet.
      '<select id="dt-spec-jump" style="width:100%;margin-bottom:6px;background:#1a1a1a;color:#ccc;' +
        'border:1px solid #333;border-radius:4px;font-family:monospace;font-size:11px;padding:3px">' +
        '<option value="">Jump to game…</option>' +
      '</select>' +
      '<div id="dt-spec-status" style="color:#666;font-size:10px">watching for the first play…</div>';
    document.body.appendChild(panel);

    panel.querySelector('#dt-spec-prev').addEventListener('click', stepPrev);
    panel.querySelector('#dt-spec-next').addEventListener('click', stepNext);
    panel.querySelector('#dt-spec-rewind').addEventListener('click', fastRewind);
    panel.querySelector('#dt-spec-forward').addEventListener('click', fastForward);
    panel.querySelector('#dt-spec-play').addEventListener('click', doPlay);
    panel.querySelector('#dt-spec-pause').addEventListener('click', doPause);
    panel.querySelector('#dt-spec-live').addEventListener('click', goLive);
    panel.querySelector('#dt-spec-bm').addEventListener('click', openBmModal);
    panel.querySelector('#dt-spec-jump').addEventListener('change', (e) => {
      const g = e.target.value;
      e.target.value = '';
      if (g !== '') runGuarded('jump', async () => { send('jumpToGame', { game: parseInt(g, 10) }); await waitMs(120); });
    });

    queryNow();
    setInterval(queryNow, STATUS_POLL_MS);
    log('spectate controls UI ready — waiting on dt-spectate-engine.js.');
  }

  // dt-spectate-engine.js installs asynchronously (polls for endAction/
  // saveGamestate/initDuel to exist) — this just needs document.body, same
  // retry pattern the other Duel Tools panels in this project already use.
  function tryBuild() {
    if (!document.body) { setTimeout(tryBuild, BUILD_RETRY_MS); return; }
    buildPanel();
  }
  tryBuild();

  // Exposed for tests — lets a synthetic fixture drive this file directly
  // without a real dt-spectate-engine.js relay in place.
  window.__dtSpectateControlsTestHooks = {
    get lastState() { return lastState; },
    set lastState(v) { lastState = v; render(); },
    render, stepPrev, stepNext, fastRewind, fastForward, goLive, goEarliest, doPlay, doPause,
    openBmModal, closeBmModal
  };
})();
